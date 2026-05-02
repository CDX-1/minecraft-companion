import 'dotenv/config';
import inquirer from 'inquirer';
import { BotConfig } from './config';
import { launchUI } from './ui';

async function main() {
  console.clear();
  console.log('╔══════════════════════════════╗');
  console.log('║    Minecraft Companion TUI   ║');
  console.log('╚══════════════════════════════╝\n');

  const config: BotConfig = await inquirer.prompt([
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
      default: process.env.ELEVENLABS_ENABLED === 'true',
    },
    {
      type: 'password',
      name: 'elevenLabsApiKey',
      message: 'ElevenLabs API key:',
      default: process.env.ELEVENLABS_API_KEY ?? '',
      when: (answers) => answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || undefined,
      validate: (value: string) => (value.trim().length ? true : 'API key is required'),
    },
    {
      type: 'input',
      name: 'elevenLabsVoiceId',
      message: 'ElevenLabs voice ID:',
      default: process.env.ELEVENLABS_VOICE_ID ?? '',
      when: (answers) => answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || undefined,
      validate: (value: string) => (value.trim().length ? true : 'Voice ID is required'),
    },
    {
      type: 'input',
      name: 'elevenLabsModelId',
      message: 'ElevenLabs model ID:',
      default: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5',
      when: (answers) => answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || 'eleven_turbo_v2_5',
    },
    {
      type: 'number',
      name: 'elevenLabsStability',
      message: 'ElevenLabs stability (0.0 - 1.0):',
      default: Number(process.env.ELEVENLABS_STABILITY) || 0.4,
      when: (answers) => answers.elevenLabsEnabled,
    },
    {
      type: 'number',
      name: 'elevenLabsSimilarityBoost',
      message: 'ElevenLabs similarity boost (0.0 - 1.0):',
      default: Number(process.env.ELEVENLABS_SIMILARITY_BOOST) || 0.75,
      when: (answers) => answers.elevenLabsEnabled,
    },
  ]);

  launchUI(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
