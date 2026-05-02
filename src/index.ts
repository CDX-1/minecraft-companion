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
  ]);

  launchUI(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
