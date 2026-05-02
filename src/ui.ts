import blessed from 'blessed';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { parseChatCommand } from './commands';
import { BotConfig } from './config';

export function launchUI(config: BotConfig): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Minecraft Companion',
    fullUnicode: true,
  });

  // ── Status bar (top, 1 line) ──────────────────────────────
  const statusBar = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: `  Connecting to ${config.host}:${config.port} as ${config.username}…`,
    style: { bg: 'blue', fg: 'white', bold: true },
  });

  // ── Chat log (left panel) ─────────────────────────────────
  const chatLog = blessed.log({
    top: 1,
    left: 0,
    width: '70%',
    bottom: 0,
    label: ' Chat ',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    tags: true,
    padding: { left: 1, right: 1 },
  });

  // ── Info panel (right panel) ──────────────────────────────
  const infoPanel = blessed.box({
    top: 1,
    right: 0,
    width: '30%',
    bottom: 0,
    label: ' Info ',
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
    tags: true,
    padding: { left: 1 },
    content: '{gray-fg}Waiting for spawn…{/gray-fg}',
  });

  screen.append(statusBar);
  screen.append(chatLog);
  screen.append(infoPanel);

  screen.key(['C-c'], () => process.exit(0));
  screen.render();

  // ── Bot ───────────────────────────────────────────────────
  let bot: Bot;
  let infoTimer: NodeJS.Timeout | null = null;

  const FOLLOW_RANGE = 2;

  function followPlayer(username: string) {
    const target = bot.players[username]?.entity;

    if (!target) {
      bot.chat("I can't see you.");
      chatLog.log(`{yellow-fg}[bot] Could not see ${username} to follow.{/yellow-fg}`);
      screen.render();
      return;
    }

    bot.chat('Following you.');
    chatLog.log(`{green-fg}[bot] Following ${username}.{/green-fg}`);
    screen.render();

    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE), true);
  }

  function renderInfo() {
    if (!bot?.entity) return;
    const hp = (bot.health ?? 0).toFixed(1);
    const food = bot.food ?? 0;
    const pos = bot.entity.position;
    infoPanel.setContent(
      `{bold}Server{/bold}\n ${config.host}:${config.port}\n\n` +
      `{bold}Player{/bold}\n ${bot.username}\n\n` +
      `{bold}Health{/bold}\n {red-fg}♥ ${hp}/20{/red-fg}\n\n` +
      `{bold}Food{/bold}\n {green-fg}${food}/20{/green-fg}\n\n` +
      `{bold}Position{/bold}\n X ${pos.x.toFixed(1)}\n Y ${pos.y.toFixed(1)}\n Z ${pos.z.toFixed(1)}`
    );
    screen.render();
  }

  function connect() {
    bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
    });

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
      statusBar.setContent(`  Connected · ${bot.username} @ ${config.host}:${config.port}`);
      statusBar.style.bg = 'green';
      chatLog.log(`{green-fg}[system] Spawned as ${bot.username}{/green-fg}`);
      infoTimer = setInterval(renderInfo, 1000);
      screen.render();
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      chatLog.log(`{cyan-fg}<${username}>{/cyan-fg} ${message}`);
      screen.render();

      const command = parseChatCommand(message);

      if (command === 'greet') {
        bot.chat('hello');
      }

      if (command === 'follow') {
        followPlayer(username);
      }
    });

    bot.on('error', (err) => {
      chatLog.log(`{red-fg}[error] ${err.message}{/red-fg}`);
      statusBar.setContent(`  Error: ${err.message}`);
      statusBar.style.bg = 'red';
      screen.render();
    });

    bot.on('end', (reason) => {
      if (infoTimer) clearInterval(infoTimer);
      chatLog.log(`{yellow-fg}[system] Disconnected: ${reason}{/yellow-fg}`);
      statusBar.setContent(`  Disconnected: ${reason}`);
      statusBar.style.bg = 'red';
      screen.render();
    });
  }

  connect();
}
