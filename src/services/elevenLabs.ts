import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
}

export interface ElevenLabsSpeaker {
  speak: (text: string) => Promise<void>;
}

const SAMPLE_RATE = 16000;
const CHANNELS = 1;

export function createElevenLabsSpeaker(config: ElevenLabsConfig, logger?: (message: string) => void): ElevenLabsSpeaker {
  let queue = Promise.resolve();

  return {
    speak: async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      queue = queue
        .then(async () => {
          const wavBuffer = await synthesizeSpeech(trimmed, config);
          const tempPath = await writeTempWav(wavBuffer);
          try {
            await playWavFile(tempPath);
          } finally {
            await fs.unlink(tempPath).catch(() => undefined);
          }
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
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}`);
  url.searchParams.set('output_format', 'pcm_16000');

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

async function writeTempWav(wavBuffer: Buffer): Promise<string> {
  const fileName = `minecraft-companion-${Date.now()}-${Math.floor(Math.random() * 10000)}.wav`;
  const filePath = path.join(os.tmpdir(), fileName);
  await fs.writeFile(filePath, wavBuffer);
  return filePath;
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

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
