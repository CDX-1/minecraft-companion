import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  streaming: boolean;
  latency: number;
}

export interface ElevenLabsSpeaker {
  speak: (text: string) => Promise<void>;
}

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const MAX_CACHE = 24;

export function createElevenLabsSpeaker(config: ElevenLabsConfig, logger?: (message: string) => void): ElevenLabsSpeaker {
  let queue = Promise.resolve();
  const cache = new Map<string, Buffer>();

  return {
    speak: async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      queue = queue
        .then(async () => {
          const cached = cache.get(trimmed);

          if (cached) {
            await playWavBuffer(cached);
            return;
          }

          if (config.streaming) {
            const streamed = await streamSpeech(trimmed, config, logger);
            if (streamed) return;
          }

          const wavBuffer = await synthesizeSpeech(trimmed, config);
          cacheSet(cache, trimmed, wavBuffer);
          await playWavBuffer(wavBuffer);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger?.(`[voice] ElevenLabs error: ${message}`);
        });

      await queue;
    },
  };
}

async function synthesizeSpeech(text: string, config: ElevenLabsConfig): Promise<Buffer> {
  const stability = clamp01(config.stability);
  const similarityBoost = clamp01(config.similarityBoost);
  const latency = clampLatency(config.latency);
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}`);
  url.searchParams.set('output_format', 'pcm_16000');
  url.searchParams.set('optimize_streaming_latency', String(latency));

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'xi-api-key': config.apiKey,
      accept: 'audio/pcm',
    },
    body: JSON.stringify({
      text,
      model_id: config.modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`ElevenLabs request failed (${response.status}): ${errorBody || response.statusText}`);
  }

  const pcm = Buffer.from(await response.arrayBuffer());
  return pcmToWav(pcm, SAMPLE_RATE, CHANNELS);
}

async function streamSpeech(text: string, config: ElevenLabsConfig, logger?: (message: string) => void): Promise<boolean> {
  const stability = clamp01(config.stability);
  const similarityBoost = clamp01(config.similarityBoost);
  const latency = clampLatency(config.latency);
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/stream`);
  url.searchParams.set('output_format', 'pcm_16000');
  url.searchParams.set('optimize_streaming_latency', String(latency));

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'xi-api-key': config.apiKey,
      accept: 'audio/pcm',
    },
    body: JSON.stringify({
      text,
      model_id: config.modelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`ElevenLabs stream failed (${response.status}): ${errorBody || response.statusText}`);
  }

  if (!response.body) {
    logger?.('[voice] ElevenLabs streaming unavailable; falling back to buffered playback.');
    return false;
  }

  try {
    await playPcmStream(response.body);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.(`[voice] Streaming playback failed: ${message}`);
    return false;
  }
}

async function writeTempWav(wavBuffer: Buffer): Promise<string> {
  const fileName = `minecraft-companion-${Date.now()}-${Math.floor(Math.random() * 10000)}.wav`;
  const filePath = path.join(os.tmpdir(), fileName);
  await fs.writeFile(filePath, wavBuffer);
  return filePath;
}

async function playWavBuffer(wavBuffer: Buffer): Promise<void> {
  const tempPath = await writeTempWav(wavBuffer);
  try {
    await playWavFile(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

async function playPcmStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const { default: Speaker } = await import('speaker');
  const nodeStream = Readable.fromWeb(stream) as Readable;
  const speaker = new Speaker({
    channels: CHANNELS,
    bitDepth: 16,
    sampleRate: SAMPLE_RATE,
  });

  await new Promise<void>((resolve, reject) => {
    nodeStream.on('error', reject);
    speaker.on('error', reject);
    speaker.on('close', resolve);
    nodeStream.pipe(speaker);
  });
}

function playWavFile(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return runProcess('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Media; ` +
        `$player = New-Object System.Media.SoundPlayer '${filePath.replace(/'/g, "''")}'; ` +
        '$player.PlaySync();',
    ]);
  }

  if (process.platform === 'darwin') {
    return runProcess('afplay', [filePath]);
  }

  return runProcess('aplay', [filePath]).catch(() => runProcess('paplay', [filePath]));
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);

  return buffer;
}

function cacheSet(cache: Map<string, Buffer>, key: string, value: Buffer) {
  cache.set(key, value);
  if (cache.size <= MAX_CACHE) return;
  const [firstKey] = cache.keys();
  if (firstKey) cache.delete(firstKey);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampLatency(value: number): number {
  if (Number.isNaN(value)) return 4;
  if (value < 0) return 0;
  if (value > 4) return 4;
  return Math.round(value);
}
