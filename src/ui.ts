import blessed from 'blessed';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { shouldIgnoreChatSender } from './chatFilter';
import { parseChatCommand } from './commands';
import { BotConfig } from './config';
import { MinecraftAgent } from './agent';
import { createElevenLabsSpeaker, ElevenLabsSpeaker } from './services/elevenLabs';
import { startVoiceServer, VoiceServer } from './voiceServer';

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

  let voiceServer: VoiceServer | null = null;
  let voiceSpeaker: ElevenLabsSpeaker | null = null;
  let agent: MinecraftAgent | null = null;

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();

  screen.key(['C-c'], () => {
    voiceServer?.close();
    process.exit(0);
  });
  screen.render();

  // ── Bot ───────────────────────────────────────────────────
  let bot: Bot;
  let infoTimer: NodeJS.Timeout | null = null;

  function setupElevenLabs() {
    if (!config.elevenLabsEnabled) return;

    if (!config.elevenLabsApiKey || !config.elevenLabsVoiceId) {
      chatLog.log('{yellow-fg}[voice] ElevenLabs is enabled, but API key or voice ID is missing.{/yellow-fg}');
      screen.render();
      return;
    }

    voiceSpeaker = createElevenLabsSpeaker(
      {
        apiKey: config.elevenLabsApiKey,
        voiceId: config.elevenLabsVoiceId,
        modelId: config.elevenLabsModelId ?? 'eleven_turbo_v2_5',
        stability: config.elevenLabsStability,
        similarityBoost: config.elevenLabsSimilarityBoost,
        streaming: config.elevenLabsStreaming,
        latency: config.elevenLabsLatency,
      },
      (message) => {
        chatLog.log(`{red-fg}${message}{/red-fg}`);
        screen.render();
      }
    );

    const mode = config.elevenLabsStreaming ? 'streaming' : 'buffered';
    chatLog.log(`{magenta-fg}[voice] ElevenLabs voice synthesis enabled (${mode}).{/magenta-fg}`);
    screen.render();
  }

  function botSay(message: string) {
    bot.chat(message);
    void voiceSpeaker?.speak(message);
  }

  function followPlayer(username: string) {
    const target = bot.players[username]?.entity;

    if (!target) {
      botSay("I can't see you.");
      chatLog.log(`{yellow-fg}[bot] Could not see ${username} to follow.{/yellow-fg}`);
      screen.render();
      return;
    }

    botSay('Following you.');
    chatLog.log(`{green-fg}[bot] Following ${username}.{/green-fg}`);
    screen.render();

    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  }

  async function startVoiceCommands() {
    if (!config.voiceEnabled) return;

    try {
      voiceServer = await startVoiceServer({
        port: config.voicePort,
        onTranscript: (text) => {
          chatLog.log(`{magenta-fg}[voice]{/magenta-fg} ${text}`);

          if (!bot?.entity) {
            chatLog.log('{yellow-fg}[voice] Bot not spawned; command ignored.{/yellow-fg}');
            screen.render();
            return;
          }

          if (agent) {
            const sender = config.ownerUsername ?? 'voice';
            agent
              .handleMessage(text, sender)
              .then((response) => { if (response) botSay(response); })
              .catch((err: Error) => {
                chatLog.log(`{red-fg}[agent] voice error: ${err.message}{/red-fg}`);
                screen.render();
              });
          } else {
            const command = parseChatCommand(text, bot.username);

            if (command === 'greet') {
              botSay('hello');
            } else if (command === 'follow') {
              if (config.ownerUsername) followPlayer(config.ownerUsername);
            } else {
              chatLog.log('{yellow-fg}[voice] No matching command.{/yellow-fg}');
            }
          }

          screen.render();
        },
      });

      chatLog.log(`{magenta-fg}[voice] Open ${voiceServer.url} in Chrome or Edge and allow microphone access.{/magenta-fg}`);
      screen.render();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      chatLog.log(`{red-fg}[voice] Failed to start voice server: ${message}{/red-fg}`);
      screen.render();
    }
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

      if (openaiApiKey) {
        agent = new MinecraftAgent(bot, openaiApiKey, (msg) => {
          chatLog.log(`{gray-fg}${msg}{/gray-fg}`);
          screen.render();
        });
        chatLog.log(`{green-fg}[agent] GPT-4o-mini agent ready{/green-fg}`);
      } else {
        chatLog.log(`{yellow-fg}[agent] No OPENAI_API_KEY — using basic commands only{/yellow-fg}`);
      }

      screen.render();
    });

    bot.on('chat', (username, message) => {
      if (shouldIgnoreChatSender(username, bot.username, config.ignoredUsernames)) {
        chatLog.log(`{gray-fg}[ignored] <${username}> ${message}{/gray-fg}`);
        screen.render();
        return;
      }

      chatLog.log(`{cyan-fg}<${username}>{/cyan-fg} ${message}`);
      screen.render();

      if (!agent) {
        const command = parseChatCommand(message, bot.username);

        if (command === 'greet') {
          botSay('hello');
        } else if (command === 'follow') {
          followPlayer(username);
        }
        return;
      }

      chatLog.log(`{gray-fg}[agent] thinking…{/gray-fg}`);
      screen.render();

      agent
        .handleMessage(message, username)
        .then((response) => {
          if (response) botSay(response);
        })
        .catch((err: Error) => {
          chatLog.log(`{red-fg}[agent] error: ${err.message}{/red-fg}`);
          screen.render();
        });
    });

    bot.on('error', (err) => {
      chatLog.log(`{red-fg}[error] ${err.message}{/red-fg}`);
      statusBar.setContent(`  Error: ${err.message}`);
      statusBar.style.bg = 'red';
      screen.render();
    });

    bot.on('end', (reason) => {
      if (infoTimer) clearInterval(infoTimer);
      voiceServer?.close();
      chatLog.log(`{yellow-fg}[system] Disconnected: ${reason}{/yellow-fg}`);
      statusBar.setContent(`  Disconnected: ${reason}`);
      statusBar.style.bg = 'red';
      screen.render();
    });
  }

  void startVoiceCommands();
  setupElevenLabs();
  connect();
}
