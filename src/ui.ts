import blessed from 'blessed';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { shouldIgnoreChatSender } from './chatFilter';
import { parseChatCommand } from './commands';
import { BotConfig } from './config';
import { MinecraftAgent } from './agent';
import { GlobalPushToTalk, startGlobalPushToTalk } from './globalPushToTalk';
import { createElevenLabsSpeaker, ElevenLabsSpeaker } from './services/elevenLabs';
import { startVoiceServer, VoiceServer } from './voiceServer';

const armorManager = require('mineflayer-armor-manager');
const collectBlockPlugin = require('mineflayer-collectblock').plugin;
const pvpPlugin = require('mineflayer-pvp').plugin;
const toolPlugin = require('mineflayer-tool').plugin;

export function launchUI(config: BotConfig): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'MC Companion Command Deck',
    fullUnicode: true,
  });

  const statusBar = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    content:
      ` {bold}MC COMPANION{/bold}  {gray-fg}target{/gray-fg} ${config.host}:${config.port}` +
      `  {gray-fg}callsign{/gray-fg} ${config.username}` +
      `  {yellow-fg}connecting{/yellow-fg}\n` +
      ' {gray-fg}chat monitor · voice bridge · pathfinder · agent console{/gray-fg}',
    style: { bg: 'black', fg: 'white', bold: true },
  });

  const chatLog = blessed.log({
    top: 3,
    left: 0,
    width: '70%',
    bottom: 2,
    label: ' TRANSMISSION LOG ',
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      label: { fg: 'green', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    tags: true,
    padding: { left: 1, right: 1 },
  });

  const infoPanel = blessed.box({
    top: 3,
    right: 0,
    width: '30%',
    bottom: 2,
    label: ' TELEMETRY ',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
    },
    tags: true,
    padding: { left: 1, right: 1 },
    content:
      '{gray-fg}Awaiting spawn telemetry...{/gray-fg}\n\n' +
      `{bold}Agent{/bold}\n ${process.env.OPENAI_API_KEY?.trim() ? '{green-fg}armed{/green-fg}' : '{yellow-fg}basic commands{/yellow-fg}'}\n\n` +
      `{bold}Voice{/bold}\n ${config.voiceEnabled ? '{magenta-fg}bridge requested{/magenta-fg}' : '{gray-fg}disabled{/gray-fg}'}`,
  });

  const footerBar = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 2,
    tags: true,
    content:
      ' {green-fg}CTRL+C{/green-fg} quit' +
      '   {cyan-fg}chat{/cyan-fg} in Minecraft' +
      '   {magenta-fg}voice{/magenta-fg} use logged local URL' +
      '   {yellow-fg}ignored bots{/yellow-fg} ' + (config.ignoredUsernames.length ? config.ignoredUsernames.join(', ') : 'none'),
    style: { bg: 'black', fg: 'white' },
  });

  screen.append(statusBar);
  screen.append(chatLog);
  screen.append(infoPanel);
  screen.append(footerBar);

  let voiceServer: VoiceServer | null = null;
  let voiceSpeaker: ElevenLabsSpeaker | null = null;
  let globalPushToTalk: GlobalPushToTalk | null = null;
  let agent: MinecraftAgent | null = null;

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();

  screen.key(['C-c'], () => {
    globalPushToTalk?.close();
    voiceServer?.close();
    process.exit(0);
  });
  screen.render();

  // ── Bot ───────────────────────────────────────────────────
  let bot: Bot;
  let infoTimer: NodeJS.Timeout | null = null;

  function logSystem(message: string) {
    chatLog.log(`{green-fg}[system]{/green-fg} ${message}`);
    screen.render();
  }

  function logAgent(message: string) {
    chatLog.log(`{gray-fg}[agent]{/gray-fg} ${message}`);
    screen.render();
  }

  function logVoice(message: string) {
    chatLog.log(`{magenta-fg}[voice]{/magenta-fg} ${message}`);
    screen.render();
  }

  function logWarning(message: string) {
    chatLog.log(`{yellow-fg}[warn]{/yellow-fg} ${message}`);
    screen.render();
  }

  function logError(message: string) {
    chatLog.log(`{red-fg}[error]{/red-fg} ${message}`);
    screen.render();
  }

  function loadPluginSafely(name: string, plugin: Parameters<Bot['loadPlugin']>[0]) {
    try {
      bot.loadPlugin(plugin);
      logSystem(`Plugin loaded: ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarning(`Plugin ${name} not loaded: ${message}`);
    }
  }

  async function loadAutoEatSafely() {
    try {
      const autoEat = await import('mineflayer-auto-eat');
      bot.loadPlugin(autoEat.loader);
      const botAny = bot as any;
      botAny.autoEat?.setOpts?.({
        minHunger: 15,
        minHealth: 14,
        returnToLastItem: true,
      });
      botAny.autoEat?.enableAuto?.();
      logSystem('Plugin loaded: mineflayer-auto-eat');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarning(`Plugin mineflayer-auto-eat not loaded: ${message}`);
    }
  }

  function setupElevenLabs() {
    if (!config.elevenLabsEnabled) return;

    if (!config.elevenLabsApiKey || !config.elevenLabsVoiceId) {
      logWarning('ElevenLabs enabled, but API key or voice ID is missing.');
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
        logError(message);
      }
    );

    const mode = config.elevenLabsStreaming ? 'streaming' : 'buffered';
    logVoice(`ElevenLabs synthesis enabled (${mode}).`);
  }

  function botSay(message: string) {
    bot.chat(message);
    void voiceSpeaker?.speak(message);
  }

  function followPlayer(username: string) {
    const target = bot.players[username]?.entity;

    if (!target) {
      botSay("I can't see you.");
      logWarning(`Could not see ${username} to follow.`);
      return;
    }

    botSay('Following you.');
    logSystem(`Following ${username}.`);

    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  }

  async function startVoiceCommands() {
    if (!config.voiceEnabled) return;

    try {
      voiceServer = await startVoiceServer({
        port: config.voicePort,
        onTranscript: (text) => {
          logVoice(text);

          if (!bot?.entity) {
            logWarning('Bot not spawned; voice command ignored.');
            return;
          }

          if (agent) {
            const sender = config.ownerUsername ?? 'voice';
            agent
              .handleMessage(text, sender)
              .then((response) => { if (response) botSay(response); })
              .catch((err: Error) => {
                logError(`agent voice error: ${err.message}`);
              });
          } else {
            const command = parseChatCommand(text, bot.username);

            if (command === 'greet') {
              botSay('hello');
            } else if (command === 'follow') {
              if (config.ownerUsername) followPlayer(config.ownerUsername);
            } else {
              logWarning('No matching voice command.');
            }
          }

          screen.render();
        },
      });

      logVoice(`Manual launch only: ${voiceServer.url}`);
      try {
        globalPushToTalk = await startGlobalPushToTalk({
          key: 'V',
          onStart: () => {
            voiceServer?.setPushToTalkActive(true);
            logVoice('push-to-talk start');
          },
          onStop: () => {
            voiceServer?.setPushToTalkActive(false);
            logVoice('push-to-talk stop');
          },
          onStatus: logVoice,
          onError: (message) => {
            logWarning(`${message}. On macOS, grant Terminal/your editor Accessibility permission.`);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logWarning(`Global push-to-talk unavailable: ${message}`);
        logWarning('On macOS, grant Terminal/your editor Accessibility permission, then restart.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to start voice server: ${message}`);
    }
  }

  function renderInfo() {
    if (!bot?.entity) return;
    const hp = (bot.health ?? 0).toFixed(1);
    const food = bot.food ?? 0;
    const pos = bot.entity.position;
    infoPanel.setContent(
      `{bold}Link{/bold}\n {green-fg}online{/green-fg} ${config.host}:${config.port}\n\n` +
      `{bold}Callsign{/bold}\n ${bot.username}\n\n` +
      `{bold}Vitals{/bold}\n {red-fg}HP ${hp}/20{/red-fg}\n {green-fg}Food ${food}/20{/green-fg}\n\n` +
      `{bold}Coordinates{/bold}\n X ${pos.x.toFixed(1)}\n Y ${pos.y.toFixed(1)}\n Z ${pos.z.toFixed(1)}\n\n` +
      `{bold}Agent{/bold}\n ${agent ? '{green-fg}online{/green-fg}' : '{yellow-fg}basic commands{/yellow-fg}'}\n\n` +
      `{bold}Voice{/bold}\n ${voiceServer ? '{magenta-fg}listening page live{/magenta-fg}' : config.voiceEnabled ? '{yellow-fg}starting{/yellow-fg}' : '{gray-fg}disabled{/gray-fg}'}`
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

    loadPluginSafely('mineflayer-pathfinder', pathfinder);
    loadPluginSafely('mineflayer-tool', toolPlugin);
    loadPluginSafely('mineflayer-collectblock', collectBlockPlugin);
    loadPluginSafely('mineflayer-pvp', pvpPlugin);
    loadPluginSafely('mineflayer-armor-manager', armorManager);

    bot.once('spawn', () => {
      statusBar.setContent(
        ` {bold}MC COMPANION{/bold}  {gray-fg}target{/gray-fg} ${config.host}:${config.port}` +
        `  {gray-fg}callsign{/gray-fg} ${bot.username}` +
        `  {green-fg}online{/green-fg}\n` +
        ' {gray-fg}chat monitor · voice bridge · pathfinder · agent console{/gray-fg}'
      );
      statusBar.style.bg = 'green';
      logSystem(`Spawned as ${bot.username}.`);
      infoTimer = setInterval(renderInfo, 1000);
      void loadAutoEatSafely();
      void (bot as any).armorManager?.equipAll?.().catch?.(() => undefined);

      if (openaiApiKey) {
        agent = new MinecraftAgent(bot, openaiApiKey, (msg) => {
          logAgent(msg);
        }, (msg) => {
          chatLog.log(`{yellow-fg}[auto]{/yellow-fg} ${msg}`);
          botSay(msg);
          screen.render();
        });
        logAgent('GPT-4o-mini ready.');
      } else {
        logWarning('No OPENAI_API_KEY; using basic commands only.');
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

      logAgent('thinking...');

      agent
        .handleMessage(message, username)
        .then((response) => {
          if (response) botSay(response);
        })
        .catch((err: Error) => {
          logError(`agent error: ${err.message}`);
        });
    });

    bot.on('error', (err) => {
      logError(err.message);
      statusBar.setContent(`  Error: ${err.message}`);
      statusBar.style.bg = 'red';
      screen.render();
    });

    bot.on('end', (reason) => {
      if (infoTimer) clearInterval(infoTimer);
      globalPushToTalk?.close();
      globalPushToTalk = null;
      voiceServer?.close();
      logWarning(`Disconnected: ${reason}`);
      statusBar.setContent(`  Disconnected: ${reason}`);
      statusBar.style.bg = 'red';
      screen.render();
    });
  }

  void startVoiceCommands();
  setupElevenLabs();
  connect();
}
