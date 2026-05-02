import blessed from 'blessed';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { shouldIgnoreChatSender } from './chatFilter';
import { parseChatCommand } from './commands';
import { BotConfig } from './config';
import { MinecraftAgent } from './agent';
import type { Personality } from './agent/types';

const PERSONALITIES: Personality[] = ['friendly', 'flirty', 'tsundere', 'arrogant'];
import { classifyDamageMoodDelta, createMoodTracker, type MoodTracker } from './botMood';
import { GlobalPushToTalk, startGlobalPushToTalk } from './globalPushToTalk';
import { createLedStatusController, LedStatusController } from './ledStatus';
import { createFiniteEntityStateRepair } from './movementRecovery';
import { createElevenLabsSpeaker, ElevenLabsSpeaker } from './services/elevenLabs';
import { BuildStatus } from './services/builder';
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
      ` {bold}${config.companionName ? config.companionName.toUpperCase() : 'MC COMPANION'}{/bold}` +
      `  {gray-fg}target{/gray-fg} ${config.host}:${config.port}` +
      `  {gray-fg}callsign{/gray-fg} ${config.username}` +
      `  {yellow-fg}connecting{/yellow-fg}\n` +
      ` {gray-fg}${config.personality} · ${config.autonomyLevel} autonomy · chat monitor · pathfinder · agent{/gray-fg}`,
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
  let ledStatus: LedStatusController | null = null;
  let moodTracker: MoodTracker | null = null;
  let agent: MinecraftAgent | null = null;

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();

  screen.key(['C-c'], () => {
    moodTracker?.dispose();
    ledStatus?.setStatus('red', 'companion shutting down');
    ledStatus?.close();
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

  ledStatus = createLedStatusController({
    log: logSystem,
    warn: logWarning,
  });
  moodTracker = createMoodTracker({
    log: logSystem,
    onScoreChange: (score) => ledStatus?.setMood(score),
  });

  ledStatus.setStatus('yellow', 'companion starting');

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
        minHealth: 6,
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

  function botSayVoiceOnly(message: string) {
    void voiceSpeaker?.speak(message);
  }

  function followPlayer(username: string) {
    const target = bot.players[username]?.entity;

    if (!target) {
      botSay("I can't see you.");
      logWarning(`Could not see ${username} to follow.`);
      ledStatus?.setStatus('yellow', 'follow target not visible');
      return;
    }

    botSay('Following you.');
    logSystem(`Following ${username}.`);

    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  }

  function formatVec3(value: { x: number; y: number; z: number } | undefined): string {
    if (!value) return 'n/a';
    return `${value.x.toFixed(3)},${value.y.toFixed(3)},${value.z.toFixed(3)}`;
  }

  function logMovementDebug(event: string, extra = '') {
    const entity = bot.entity;
    const controls = (bot as any).controlState;
    const controlText = controls
      ? `ctrl=f:${Number(Boolean(controls.forward))} b:${Number(Boolean(controls.back))} l:${Number(Boolean(controls.left))} r:${Number(Boolean(controls.right))} j:${Number(Boolean(controls.jump))} s:${Number(Boolean(controls.sprint))}`
      : 'ctrl=n/a';
    const mode = bot.game?.gameMode ?? 'unknown';
    const physics = String((bot as any).physicsEnabled);
    const autoEat = (bot as any).autoEat?.isEating ? ' eating' : '';
    const position = formatVec3(entity?.position);
    const velocity = formatVec3(entity?.velocity);
    logSystem(`[move-debug] ${event} mode=${mode} physics=${physics}${autoEat} pos=${position} vel=${velocity} ${controlText}${extra ? ` ${extra}` : ''}`);
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
            ledStatus?.setStatus('yellow', 'voice command before spawn');
            return;
          }

          if (agent) {
            const sender = config.ownerUsername ?? 'voice';
            agent
              .handleMessage(text, sender)
              .then((response) => { if (response) botSay(response); })
              .catch((err: Error) => {
                logError(`agent voice error: ${err.message}`);
                ledStatus?.setStatus('red', 'agent voice error');
              });
          } else {
            const command = parseChatCommand(text, bot.username);

            if (command === 'greet') {
              botSay('hello');
            } else if (command === 'follow') {
              if (config.ownerUsername) followPlayer(config.ownerUsername);
            } else {
              logWarning('No matching voice command.');
              ledStatus?.setStatus('yellow', 'unknown voice command');
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
        ledStatus?.setStatus('yellow', 'push-to-talk unavailable');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to start voice server: ${message}`);
      ledStatus?.setStatus('red', 'voice server failed');
    }
  }

  function buildStatusBlock(s: BuildStatus): string {
    if (s.phase === 'idle') return '';
    const phaseColor =
      s.phase === 'building' ? 'magenta-fg' :
      s.phase === 'done' ? 'green-fg' :
      s.phase === 'cancelled' ? 'gray-fg' :
      s.phase === 'error' ? 'red-fg' : 'white-fg';
    const pct = s.total ? Math.floor((s.placed / s.total) * 100) : 0;
    const barWidth = 14;
    const filled = Math.floor((pct / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const o = s.origin;
    const mat = s.material ? s.material.replace(/^minecraft:/, '') : '';
    const lines = [
      `\n{bold}Build{/bold}`,
      ` {${phaseColor}}${s.phase}{/${phaseColor}}` + (s.type ? ` · ${s.type}` : ''),
      mat ? ` ${mat}` : '',
      o ? ` @ (${o.x},${o.y},${o.z})` : '',
      ` [${bar}] ${pct}%`,
      ` ${s.placed}/${s.total} blocks`,
    ];
    return lines.filter(Boolean).join('\n');
  }

  function moodTelemetryBlock(score: number): string {
    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    const barWidth = 14;
    const filled = Math.round((clamped / 100) * barWidth);
    const empty = Math.max(0, barWidth - filled);
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const tierLabel =
      clamped >= 82 ? '{green-fg}great{/green-fg}'
      : clamped >= 65 ? '{green-fg}good{/green-fg}'
      : clamped >= 48 ? '{yellow-fg}mixed{/yellow-fg}'
      : clamped >= 28 ? '{blue-fg}low{/blue-fg}'
      : '{red-fg}bad{/red-fg}';
    return `\n{bold}Mood{/bold}\n ${tierLabel}  ${clamped}/100\n [${bar}]`;
  }

  function renderInfo() {
    if (!bot?.entity) return;
    const hp = (bot.health ?? 0).toFixed(1);
    const food = bot.food ?? 0;
    const pos = bot.entity.position;
    const buildStatus = agent?.getBuildStatus();
    const moodScore = moodTracker?.getScore() ?? 50;
    if ((bot.health ?? 20) <= 6) {
      ledStatus?.setStatus('red', 'low health');
    } else if ((bot.food ?? 20) <= 8 || !agent) {
      ledStatus?.setStatus('yellow', !agent ? 'agent unavailable' : 'low food');
    } else {
      /** GREEN clears RED/YELLOW health overlay — underlying mood LEDs stay driven by gameplay. */
      ledStatus?.setStatus('green', 'online');
    }
    infoPanel.setContent(
      `{bold}Link{/bold}\n {green-fg}online{/green-fg} ${config.host}:${config.port}\n\n` +
      `{bold}Callsign{/bold}\n ${bot.username}\n\n` +
      `{bold}Vitals{/bold}\n {red-fg}HP ${hp}/20{/red-fg}\n {green-fg}Food ${food}/20{/green-fg}` +
      `${moodTelemetryBlock(moodScore)}\n\n` +
      `{bold}Coordinates{/bold}\n X ${pos.x.toFixed(1)}\n Y ${pos.y.toFixed(1)}\n Z ${pos.z.toFixed(1)}\n\n` +
      `{bold}Agent{/bold}\n ${agent ? '{green-fg}online{/green-fg}' : '{yellow-fg}basic commands{/yellow-fg}'}\n\n` +
      `{bold}Voice{/bold}\n ${voiceServer ? '{magenta-fg}listening page live{/magenta-fg}' : config.voiceEnabled ? '{yellow-fg}starting{/yellow-fg}' : '{gray-fg}disabled{/gray-fg}'}` +
      (buildStatus ? buildStatusBlock(buildStatus) : '')
    );
    screen.render();
  }

  function connect() {
    let prevHealth = 20;

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

    const repairEntityState = createFiniteEntityStateRepair(bot, logSystem);

    bot.on('entityHurt', (entity) => {
      if (bot.entity && entity === bot.entity) {
        repairEntityState('entityHurt');
        logMovementDebug('entityHurt');
      }
    });

    bot.on('health', () => {
      repairEntityState('health');
      logMovementDebug('health', `hp=${(bot.health ?? 0).toFixed(1)} food=${bot.food ?? 0}`);
    });

    (bot as any)._client?.on?.('entity_velocity', (packet: any) => {
      if (!bot.entity || packet.entityId !== bot.entity.id) return;
      const raw = packet.velocity
        ? `${packet.velocity.x},${packet.velocity.y},${packet.velocity.z}`
        : `${packet.velocityX},${packet.velocityY},${packet.velocityZ}`;
      repairEntityState('entity_velocity');
      logMovementDebug('entity_velocity', `raw=${raw}`);
    });

    bot.on('forcedMove', () => {
      repairEntityState('forcedMove');
      logMovementDebug('forcedMove');
    });

    bot.on('physicsTick', () => {
      repairEntityState('physicsTick');
    });

    bot.on('path_update', (results: any) => {
      repairEntityState('path_update');
      logMovementDebug('path_update', `status=${results?.status ?? 'unknown'} len=${results?.path?.length ?? 'n/a'}`);
    });

    bot.on('spawn', () => {
      prevHealth = bot.health ?? prevHealth;
    });

    bot.on('death', () => {
      moodTracker?.bump(-26, 'death');
    });

    bot.on('health', () => {
      const h = bot.health ?? 0;
      if (h > 0 && prevHealth > h) {
        moodTracker?.bump(
          classifyDamageMoodDelta(prevHealth - h, 20),
          `-${(prevHealth - h).toFixed(1)} HP`,
        );
      }
      prevHealth = h;
    });

    bot.on('playerCollect', (collector, collected) => {
      if (!bot.entity || collector.id !== bot.entity.id) return;

      /** Skip XP arrows etc. (`getDroppedItem` only works for loose item-stack entities). */
      const dropped = typeof collected.getDroppedItem === 'function' ? collected.getDroppedItem() : null;

      moodTracker?.onCollectedItemId(dropped?.name);
    });

    bot.once('spawn', () => {
      statusBar.setContent(
        ` {bold}${config.companionName ? config.companionName.toUpperCase() : 'MC COMPANION'}{/bold}` +
        `  {gray-fg}target{/gray-fg} ${config.host}:${config.port}` +
        `  {gray-fg}callsign{/gray-fg} ${bot.username}` +
        `  {green-fg}online{/green-fg}\n` +
        ` {gray-fg}${config.personality} · ${config.autonomyLevel} autonomy · chat monitor · pathfinder · agent{/gray-fg}`
      );
      statusBar.style.bg = 'green';
      logSystem(`Spawned as ${bot.username}.`);
      ledStatus?.setStatus('yellow', 'spawned, checking systems');
      ledStatus?.setMood(moodTracker?.getScore() ?? 50, 'spawn');
      infoTimer = setInterval(renderInfo, 1000);
      void loadAutoEatSafely();
      void (bot as any).armorManager?.equipAll?.().catch?.(() => undefined);

      if (config.skinUsername) {
        const cmd = `/skin set ${config.skinUsername}`;
        bot.chat(cmd);
        logSystem(`Skin command sent: ${cmd}`);
      }

      if (openaiApiKey) {
        agent = new MinecraftAgent(
          bot,
          {
            provider: 'openai',
            apiKey: openaiApiKey,
            personality: config.personality,
            companionName: config.companionName,
            companionBio: config.companionBio,
            autonomyLevel: config.autonomyLevel,
            buildCrew: {
              enabled: config.buildCrewEnabled,
              host: config.host,
              port: config.port,
              auth: config.auth,
              mainUsername: config.username,
              size: config.buildCrewSize,
            },
          },
          (msg) => {
            logAgent(msg);
          },
          (msg) => {
            chatLog.log(`{yellow-fg}[auto]{/yellow-fg} ${msg}`);
            botSayVoiceOnly(msg);
            screen.render();
          },
          (status) => {
            if (status.phase === 'building' && status.placed === 0) {
              chatLog.log(`{magenta-fg}[build] ${status.description} — ${status.total} block changes{/magenta-fg}`);
            } else if (status.phase === 'done') {
              chatLog.log(`{green-fg}[build] ✓ ${status.description}{/green-fg}`);
            } else if (status.phase === 'cancelled') {
              chatLog.log(`{gray-fg}[build] cancelled at ${status.placed}/${status.total}{/gray-fg}`);
            } else if (status.phase === 'error') {
              chatLog.log(`{red-fg}[build] error: ${status.message}{/red-fg}`);
            }
            renderInfo();
          },
        );
        logAgent('GPT-4o-mini ready.');
        ledStatus?.setStatus('green', 'agent ready');
      } else {
        logWarning('No OPENAI_API_KEY; using basic commands only.');
        ledStatus?.setStatus('yellow', 'no llm api key');
      }

      screen.render();
    });

    bot.on('chat', (username, message) => {
      if (shouldIgnoreChatSender(username, bot.username, config.ignoredUsernames, config.ownerUsername)) {
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

      const trimmed = message.trim().toLowerCase() as Personality;
      const isOwner = config.ownerUsername
        ? username.trim().toLowerCase() === config.ownerUsername.trim().toLowerCase()
        : true;
      chatLog.log(`{gray-fg}[personality-dbg] sender=${username} isOwner=${isOwner} msg="${trimmed}" valid=${PERSONALITIES.includes(trimmed)}{/gray-fg}`);
      screen.render();
      if (isOwner && PERSONALITIES.includes(trimmed)) {
        agent.setPersonality(trimmed);
        chatLog.log(`{green-fg}[personality]{/green-fg} switched to ${trimmed}`);
        screen.render();
        botSay(`switched to ${trimmed} mode`);
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
          ledStatus?.setStatus('red', 'agent error');
        });
    });

    bot.on('error', (err) => {
      logError(err.message);
      ledStatus?.setStatus('red', 'bot error');
      statusBar.setContent(`  Error: ${err.message}`);
      statusBar.style.bg = 'red';
      screen.render();
    });

    bot.on('end', (reason) => {
      if (infoTimer) clearInterval(infoTimer);
      moodTracker?.dispose();
      moodTracker = null;

      ledStatus?.setStatus('red', 'bot disconnected');
      globalPushToTalk?.close();
      globalPushToTalk = null;
      voiceServer?.close();
      ledStatus?.close();
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
