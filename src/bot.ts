import 'dotenv/config';
import mineflayer, { Bot } from 'mineflayer';

const bot: Bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? 'localhost',
  port: Number(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME ?? 'companion',
  // auth: 'microsoft', // uncomment for online-mode servers
});

bot.once('spawn', () => {
  console.log(`[bot] spawned as ${bot.username}`);
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  console.log(`[chat] <${username}> ${message}`);

  if (message === 'hello') {
    bot.chat('Hello!');
  }
});

bot.on('error', (err) => {
  console.error('[bot] error:', err);
});

bot.on('end', (reason) => {
  console.log('[bot] disconnected:', reason);
});
