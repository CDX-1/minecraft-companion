import 'dotenv/config';
import mineflayer, { Bot } from 'mineflayer';
import { parseChatCommand } from './commands';

const bot: Bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? 'localhost',
  port: Number(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME ?? 'companion',
  // auth: 'microsoft', // uncomment for online-mode servers
});

let followTimer: NodeJS.Timeout | null = null;

function stopFollowing(): void {
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }

  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
}

function followPlayer(username: string): void {
  const target = bot.players[username]?.entity;

  if (!target) {
    bot.chat("I can't see you.");
    return;
  }

  stopFollowing();
  bot.chat('Following you.');

  followTimer = setInterval(() => {
    const currentTarget = bot.players[username]?.entity;

    if (!currentTarget) {
      stopFollowing();
      return;
    }

    const distance = bot.entity.position.distanceTo(currentTarget.position);
    bot.lookAt(currentTarget.position.offset(0, currentTarget.height, 0), true).catch(() => undefined);
    bot.setControlState('forward', distance > 2);
    bot.setControlState('sprint', distance > 4);
  }, 250);
}

bot.once('spawn', () => {
  console.log(`[bot] spawned as ${bot.username}`);
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  console.log(`[chat] <${username}> ${message}`);

  const command = parseChatCommand(message);

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
  stopFollowing();
  console.log('[bot] disconnected:', reason);
});
