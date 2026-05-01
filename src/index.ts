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
  ]);

  launchUI(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
