import 'dotenv/config';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, goals } from 'mineflayer-pathfinder';
import { shouldIgnoreChatSender } from './chatFilter';
import { parseChatCommand } from './commands';
import { readOwnerUsernameFromMemory } from './ownerConfig';
import { createServerSafeMovements } from './pathfinderMovements';

const bot: Bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? 'localhost',
  port: Number(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME ?? 'companion',
  // auth: 'microsoft', // uncomment for online-mode servers
});

bot.loadPlugin(pathfinder);

const FOLLOW_RANGE = 2;
const ownerUsername = process.env.MC_OWNER_USERNAME?.trim() || readOwnerUsernameFromMemory();

function followPlayer(username: string): void {
  const target = bot.players[username]?.entity;

  if (!target) {
    bot.chat("I can't see you.");
    return;
  }

  bot.chat('Following you.');
  bot.pathfinder.setMovements(createServerSafeMovements(bot));
  bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true);
}

bot.once('spawn', () => {
  console.log(`[bot] spawned as ${bot.username}`);
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  if (ownerUsername && shouldIgnoreChatSender(username, bot.username, [], ownerUsername)) return;
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
