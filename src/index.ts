import 'dotenv/config';
import inquirer from 'inquirer';
import { parseIgnoredUsernames } from './chatFilter';
import { BotConfig } from './config';
import { launchUI } from './ui';

async function main() {
  console.clear();
  console.log('');
  console.log('  ███╗   ███╗ ██████╗     COMPANION');
  console.log('  ████╗ ████║██╔════╝     Minecraft field console');
  console.log('  ██╔████╔██║██║          Chat · voice · pathfinding · agent');
  console.log('  ██║╚██╔╝██║██║          ');
  console.log('  ██║ ╚═╝ ██║╚██████╗     Configure link below');
  console.log('  ╚═╝     ╚═╝ ╚═════╝\n');

  const envElevenLabsEnabled = process.env.ELEVENLABS_ENABLED === 'true';
  const envElevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const envElevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const envElevenLabsModelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_turbo_v2_5';
  const envElevenLabsStability = Number(process.env.ELEVENLABS_STABILITY) || 0.4;
  const envElevenLabsSimilarityBoost = Number(process.env.ELEVENLABS_SIMILARITY_BOOST) || 0.75;
  const envElevenLabsStreaming = process.env.ELEVENLABS_STREAMING
    ? process.env.ELEVENLABS_STREAMING === 'true'
    : true;
  const envElevenLabsLatency = Math.max(0, Math.min(4, Number(process.env.ELEVENLABS_LATENCY) || 4));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'host',
      message: 'Server host:',
      default: process.env.MC_HOST ?? 'localhost',
    },
    {
      type: 'number',
      name: 'port',
      message: 'Server port:',
      default: Number(process.env.MC_PORT) || 25565,
    },
    {
      type: 'input',
      name: 'username',
      message: 'Username:',
      default: process.env.MC_USERNAME ?? 'companion',
    },
    {
      type: 'input',
      name: 'ignoredUsernames',
      message: 'Other bot usernames to ignore (comma-separated):',
      default: process.env.MC_IGNORED_USERNAMES ?? '',
      filter: parseIgnoredUsernames,
    },
    {
      type: 'list',
      name: 'auth',
      message: 'Authentication:',
      choices: [
        { name: 'Offline (cracked/local)', value: 'offline' },
        { name: 'Microsoft (premium)', value: 'microsoft' },
      ],
      default: 'offline',
    },
    {
      type: 'confirm',
      name: 'voiceEnabled',
      message: 'Enable browser voice commands?',
      default: process.env.VOICE_ENABLED === 'true',
    },
    {
      type: 'input',
      name: 'ownerUsername',
      message: 'Minecraft username for voice commands like "follow me":',
      default: process.env.MC_OWNER_USERNAME ?? '',
      when: (answers) => answers.voiceEnabled,
      filter: (value: string) => value.trim() || undefined,
    },
    {
      type: 'number',
      name: 'voicePort',
      message: 'Voice command web page port:',
      default: Number(process.env.VOICE_PORT) || 3333,
      when: (answers) => answers.voiceEnabled,
    },
    {
      type: 'confirm',
      name: 'elevenLabsEnabled',
      message: 'Enable ElevenLabs voice synthesis?',
      default: envElevenLabsEnabled,
      when: () => !envElevenLabsEnabled,
    },
    {
      type: 'password',
      name: 'elevenLabsApiKey',
      message: 'ElevenLabs API key:',
      default: envElevenLabsApiKey ?? '',
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || undefined,
      validate: (value: string) => (value.trim().length ? true : 'API key is required'),
    },
    {
      type: 'input',
      name: 'elevenLabsVoiceId',
      message: 'ElevenLabs voice ID:',
      default: envElevenLabsVoiceId ?? '',
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || undefined,
      validate: (value: string) => (value.trim().length ? true : 'Voice ID is required'),
    },
    {
      type: 'input',
      name: 'elevenLabsModelId',
      message: 'ElevenLabs model ID:',
      default: envElevenLabsModelId,
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || envElevenLabsModelId,
    },
    {
      type: 'number',
      name: 'elevenLabsStability',
      message: 'ElevenLabs stability (0.0 - 1.0):',
      default: envElevenLabsStability,
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
    },
    {
      type: 'number',
      name: 'elevenLabsSimilarityBoost',
      message: 'ElevenLabs similarity boost (0.0 - 1.0):',
      default: envElevenLabsSimilarityBoost,
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
    },
  ]);

  const config: BotConfig = {
    ...answers,
    elevenLabsEnabled: envElevenLabsEnabled ? true : answers.elevenLabsEnabled ?? false,
    elevenLabsApiKey: envElevenLabsApiKey ?? answers.elevenLabsApiKey,
    elevenLabsVoiceId: envElevenLabsVoiceId ?? answers.elevenLabsVoiceId,
    elevenLabsModelId: envElevenLabsModelId ?? answers.elevenLabsModelId,
    elevenLabsStability: envElevenLabsStability ?? answers.elevenLabsStability,
    elevenLabsSimilarityBoost: envElevenLabsSimilarityBoost ?? answers.elevenLabsSimilarityBoost,
    elevenLabsStreaming: envElevenLabsStreaming,
    elevenLabsLatency: envElevenLabsLatency,
  };

  launchUI(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
