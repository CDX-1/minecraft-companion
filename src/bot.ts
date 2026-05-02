import 'dotenv/config';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { parseChatCommand } from './commands';

const bot: Bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? 'localhost',
  port: Number(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME ?? 'companion',
  // auth: 'microsoft', // uncomment for online-mode servers
});

bot.loadPlugin(pathfinder);

const FOLLOW_RANGE = 2;

function followPlayer(username: string): void {
  const target = bot.players[username]?.entity;

  if (!target) {
    bot.chat("I can't see you.");
    return;
  }

  bot.chat('Following you.');
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true);
}

bot.once('spawn', () => {
  console.log(`[bot] spawned as ${bot.username}`);
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  console.log(`[chat] <${username}> ${message}`);

  const command = parseChatCommand(message, bot.username);

  if (command === 'greet') {
    bot.chat('hello');
  }

  if (command === 'follow') {
    followPlayer(username);
  }
});

bot.on('error', (err) => {
  console.error('[bot] error:', err);
});

bot.on('end', (reason) => {
  console.log('[bot] disconnected:', reason);
});
