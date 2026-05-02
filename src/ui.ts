import blessed from 'blessed';
import mineflayer, { Bot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { shouldIgnoreChatSender } from './chatFilter';
import { parseChatCommand } from './commands';
import { BotConfig } from './config';
import { MinecraftAgent } from './agent';
import { FAST_PATH_RESPONSES, type Personality } from './agent/types';

const PERSONALITIES: Personality[] = ['friendly', 'flirty', 'tsundere', 'arrogant'];
import { classifyDamageMoodDelta, createMoodTracker, type MoodTracker } from './botMood';
import { GlobalPushToTalk, startGlobalPushToTalk } from './globalPushToTalk';
import { createLedStatusController, LedStatusController } from './ledStatus';
import { createFiniteEntityStateRepair } from './movementRecovery';
import { createElevenLabsSpeaker, ElevenLabsSpeaker } from './services/elevenLabs';
import { BuildStatus } from './services/builder';
import { startVoiceServer, VoiceServer } from './voiceServer';
import { createDistanceHoldDetector } from './waveGesture';

const armorManager = require('mineflayer-armor-manager');
const collectBlockPlugin = require('mineflayer-collectblock').plugin;
const pvpPlugin = require('mineflayer-pvp').plugin;
const toolPlugin = require('mineflayer-tool').plugin;

// ── Visual helpers ─────────────────────────────────────────────────────────
// Mission-control palette: muted background, accent-driven highlights, lots
// of breathing room. Blessed tags are inline; we precompute the common ones.

function ts(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function tag(label: string, color: string): string {
  return `{${color}-fg}{bold}${label}{/bold}{/${color}-fg}`;
}

function gauge(value: number, max: number, width = 10): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function fmtDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Animated thinking spinner frames — Linear/Charm style.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function launchUI(config: BotConfig): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'MC Companion · Mission Control',
    fullUnicode: true,
  });

  const displayName = config.companionName ? config.companionName.toUpperCase() : 'MC COMPANION';

  // ── HEADER BAR ────────────────────────────────────────────────────────
  const headerBar = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: {
      bg: 'black',
      fg: 'white',
      border: { fg: 'cyan' },
    },
    padding: { left: 1, right: 1 },
  });

  function renderHeader(state: { status: 'connecting' | 'online' | 'error'; reason?: string }) {
    const personaColorMap: Record<string, string> = {
      friendly: 'green',
      flirty: 'magenta',
      tsundere: 'blue',
      arrogant: 'yellow',
    };
    const personaColor = personaColorMap[config.personality ?? 'friendly'] ?? 'cyan';
    const dot = state.status === 'online'
      ? '{green-fg}●{/green-fg}'
      : state.status === 'error'
        ? '{red-fg}●{/red-fg}'
        : '{yellow-fg}◐{/yellow-fg}';
    const statusLabel = state.status === 'online'
      ? '{green-fg}ONLINE{/green-fg}'
      : state.status === 'error'
        ? `{red-fg}ERROR{/red-fg} {gray-fg}${state.reason ?? ''}{/gray-fg}`
        : '{yellow-fg}CONNECTING{/yellow-fg}';

    headerBar.style.border = { fg: personaColor };
    headerBar.setContent(
      ` {${personaColor}-fg}◆{/${personaColor}-fg} {bold}${displayName}{/bold}` +
      `   ${dot} ${statusLabel}` +
      `   {gray-fg}persona{/gray-fg} {${personaColor}-fg}${config.personality}{/${personaColor}-fg}`
    );
  }
  renderHeader({ status: 'connecting' });

  // ── TRANSMISSION LOG (left, ~60%) ─────────────────────────────────────
  const chatLog = blessed.log({
    top: 3,
    left: 0,
    width: '60%',
    bottom: 4,
    label: ' {bold}{cyan-fg}TRANSMISSION LOG{/cyan-fg}{/bold} ',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
    },
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    tags: true,
    padding: { left: 1, right: 1 },
    scrollbar: {
      ch: '│',
      style: { fg: 'cyan' },
    },
  });

  // ── TELEMETRY (right, ~40%) ───────────────────────────────────────────
  const telemetry = blessed.box({
    top: 3,
    right: 0,
    width: '40%',
    bottom: 4,
    label: ' {bold}{magenta-fg}TELEMETRY{/magenta-fg}{/bold} ',
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
    },
    tags: true,
    padding: { left: 1, right: 1 },
    scrollable: true,
    mouse: true,
  });

  // ── STATUS LINE (live, ticking) ───────────────────────────────────────
  const statusLine = blessed.box({
    bottom: 2,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { bg: 'black', fg: 'white' },
    padding: { left: 1, right: 1 },
  });

  // ── FOOTER (keybinds / hints) ─────────────────────────────────────────
  const footerBar = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 2,
    tags: true,
    border: { type: 'line' },
    style: {
      bg: 'black',
      fg: 'white',
      border: { fg: 'gray' },
    },
    padding: { left: 1, right: 1 },
    content:
      ` {cyan-fg}{bold}^C{/bold}{/cyan-fg} {gray-fg}quit{/gray-fg}` +
      `   {cyan-fg}{bold}chat{/bold}{/cyan-fg} {gray-fg}in Minecraft{/gray-fg}` +
      `   {magenta-fg}{bold}V{/bold}{/magenta-fg} {gray-fg}push-to-talk{/gray-fg}` +
      `   {yellow-fg}{bold}↑↓ / mouse{/bold}{/yellow-fg} {gray-fg}scroll log{/gray-fg}` +
      `   {gray-fg}ignored:{/gray-fg} ${config.ignoredUsernames.length ? config.ignoredUsernames.join(', ') : 'none'}`,
  });

  screen.append(headerBar);
  screen.append(chatLog);
  screen.append(telemetry);
  screen.append(statusLine);
  screen.append(footerBar);

  let voiceServer: VoiceServer | null = null;
  let voiceSpeaker: ElevenLabsSpeaker | null = null;
  let globalPushToTalk: GlobalPushToTalk | null = null;
  let ledStatus: LedStatusController | null = null;
  let moodTracker: MoodTracker | null = null;
  let agent: MinecraftAgent | null = null;

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();

  // ── Live state (drives telemetry + status line) ───────────────────────
  const procStartedAt = Date.now();
  let spinnerTick = 0;
  let agentBusy = false;
  let agentBusySince = 0;
  let agentLastLine = '';
  let agentLastReplyMs = 0;       // most recent round-trip duration
  let agentReplyCount = 0;        // total replies since launch
  let buildStartedAt = 0;
  let buildLastPlaced = 0;
  let buildLastSpeed = 0; // blocks/sec, smoothed
  let lastBuildPhase: BuildStatus['phase'] = 'idle';

  screen.key(['C-c'], () => {
    moodTracker?.dispose();
    ledStatus?.setStatus('red', 'companion shutting down');
    ledStatus?.close();
    globalPushToTalk?.close();
    voiceServer?.close();
    process.exit(0);
  });

  // ── Bot ───────────────────────────────────────────────────
  let bot: Bot;
  let infoTimer: NodeJS.Timeout | null = null;
  let waveGestureRunning = false;

  function logSystem(message: string) {
    chatLog.log(`{green-fg}[system]{/green-fg} ${message}`);
    screen.render();
  }
  function logSystem(message: string) { logLine(tag('SYS', 'green'), message); }
  function logAgent(message: string) {
    agentLastLine = message;
    logLine(tag('AGENT', 'cyan'), message);
  }
  function logVoice(message: string) { logLine(tag('VOICE', 'magenta'), message); }
  function logBuild(message: string) { logLine(tag('BUILD', 'magenta'), message); }
  function logWarning(message: string) { logLine(tag('WARN', 'yellow'), message); }
  function logError(message: string) { logLine(tag('ERROR', 'red'), message); }
  function logChat(username: string, message: string) {
    chatLog.log(`{gray-fg}${ts()}{/gray-fg} {cyan-fg}<${username}>{/cyan-fg} ${message}`);
    screen.render();
  }
  function logIgnoredChat(username: string, message: string) {
    chatLog.log(`{gray-fg}${ts()} {gray-fg}[ignored] <${username}> ${message}{/gray-fg}{/gray-fg}`);
    screen.render();
  }

  function logVoice(message: string) {
    chatLog.log(`{magenta-fg}[voice]{/magenta-fg} ${message}`);
    screen.render();
  }

    chatLog.log(`{yellow-fg}[warn]{/yellow-fg} ${message}`);
    screen.render();
  }

  function logError(message: string) {
    chatLog.log(`{red-fg}[error]{/red-fg} ${message}`);
    screen.render();
  }

  const waveDetector = createDistanceHoldDetector({
    threshold: 20,
    holdMs: 1000,
    onHold: (distance) => {
      logSystem(`Wave detected at ${distance.toFixed(1)}cm`);
      void performWaveThanks();
    },
  });

  ledStatus = createLedStatusController({
    log: logSystem,
    warn: logWarning,
    onSerialLine: (line) => waveDetector.acceptLine(line),
  });
  moodTracker = createMoodTracker({
    log: logSystem,
    onScoreChange: (score) => ledStatus?.setMood(score),
  function loadPluginSafely(name: string, plugin: Parameters<Bot['loadPlugin']>[0]) {
    try {
      bot.loadPlugin(plugin);
      logSystem(`plugin loaded: {white-fg}${name}{/white-fg}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarning(`plugin ${name} not loaded: ${message}`);
    }
  }

  async function performWaveThanks(): Promise<void> {
    if (waveGestureRunning) return;
    if (!bot?.entity) {
      logWarning('Wave detected before bot spawned.');
      return;
    }

    waveGestureRunning = true;
    try {
      const target = config.ownerUsername
        ? bot.players[config.ownerUsername]?.entity
        : Object.entries(bot.players).find(([username, player]) => username !== bot.username && player.entity)?.[1].entity;

      if (target) {
        await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.9, 0), true);
      }

      for (let i = 0; i < 2; i += 1) {
        bot.setControlState('sneak', true);
        await new Promise<void>(resolve => setTimeout(resolve, 250));
        bot.setControlState('sneak', false);
        await new Promise<void>(resolve => setTimeout(resolve, 200));
      }

      botSay(personalityGreeting());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarning(`Wave gesture failed: ${message}`);
    } finally {
      bot.setControlState('sneak', false);
      waveGestureRunning = false;
    }
  }

  async function loadAutoEatSafely() {
    try {
      const autoEat = await import('mineflayer-auto-eat');
      bot.loadPlugin(autoEat.loader);
      const botAny = bot as any;
      botAny.autoEat?.setOpts?.({ minHunger: 15, minHealth: 6, returnToLastItem: true });
      botAny.autoEat?.enableAuto?.();
      logSystem('plugin loaded: {white-fg}mineflayer-auto-eat{/white-fg}');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarning(`plugin mineflayer-auto-eat not loaded: ${message}`);
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
      (message) => { logError(message); }
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

  function personalityGreeting(): string {
    return FAST_PATH_RESPONSES.greet[config.personality] ?? 'hello';
  }

  function followPlayer(username: string) {
    const target = bot.players[username]?.entity;
    if (!target) {
      botSay("I can't see you.");
      logWarning(`could not see ${username} to follow`);
      ledStatus?.setStatus('yellow', 'follow target not visible');
      return;
    }
    botSay('Following you.');
    logSystem(`following {white-fg}${username}{/white-fg}`);
    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  }

  function formatVec3(value: { x: number; y: number; z: number } | undefined): string {
    if (!value) return 'n/a';
    return `${value.x.toFixed(3)},${value.y.toFixed(3)},${value.z.toFixed(3)}`;
  }

  function logMovementDebug(_event: string, _extra = '') {
    // Movement debug is noisy in the new dashboard; suppress unless we hit a
    // real issue. The old per-tick logs drowned out the chat & agent panes.
    void _event; void _extra;
  }

  async function startVoiceCommands() {
    if (!config.voiceEnabled) return;
    try {
      voiceServer = await startVoiceServer({
        port: config.voicePort,
        onTranscript: (text) => {
          logVoice(`heard: "${text}"`);
          if (!bot?.entity) {
            logWarning('bot not spawned; voice command ignored');
            ledStatus?.setStatus('yellow', 'voice command before spawn');
            return;
          }
          if (agent) {
            const sender = config.ownerUsername ?? 'voice';
            beginAgentRequest(`voice from ${sender}`);
            agent.handleMessage(text, sender)
              .then((response) => { endAgentRequest(); if (response) botSay(response); })
              .catch((err: Error) => {
                endAgentRequest();
                logError(`agent voice error: ${err.message}`);
                ledStatus?.setStatus('red', 'agent voice error');
              });
          } else {
            const command = parseChatCommand(text, bot.username);

            if (command === 'greet') {
              botSay(personalityGreeting());
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
      logVoice(`voice server live → {underline}${voiceServer.url}{/underline}`);
      try {
        globalPushToTalk = await startGlobalPushToTalk({
          key: 'V',
          onStart: () => { voiceServer?.setPushToTalkActive(true); logVoice('push-to-talk start'); },
          onStop: () => { voiceServer?.setPushToTalkActive(false); logVoice('push-to-talk stop'); },
          onStatus: logVoice,
          onError: (message) => {
            logWarning(`${message}. On macOS, grant Terminal/your editor Accessibility permission.`);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logWarning(`global push-to-talk unavailable: ${message}`);
        ledStatus?.setStatus('yellow', 'push-to-talk unavailable');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`failed to start voice server: ${message}`);
      ledStatus?.setStatus('red', 'voice server failed');
    }
  }

  // ── Agent activity tracking (round-trip latency, throughput) ─────────
  // No "thinking" framing — we surface speed: live latency while a request
  // is in flight, and the last reply duration once it lands.
  function beginAgentRequest(reason: string) {
    agentBusy = true;
    agentBusySince = Date.now();
    agentLastLine = reason;
  }
  function endAgentRequest() {
    if (agentBusy) {
      agentLastReplyMs = Date.now() - agentBusySince;
      agentReplyCount++;
    }
    agentBusy = false;
  }

  // ── Inventory snapshot ───────────────────────────────────────────────
  interface InvRow { name: string; count: number }
  function getInventoryTop(n: number): { items: InvRow[]; used: number; total: number } {
    if (!bot?.inventory) return { items: [], used: 0, total: 36 };
    const items = bot.inventory.items() as Array<{ name: string; count: number }>;
    const grouped = new Map<string, number>();
    for (const it of items) grouped.set(it.name, (grouped.get(it.name) ?? 0) + it.count);
    const rows: InvRow[] = [...grouped.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
    return { items: rows, used: items.length, total: 36 };
  }

  // ── Build-queue / progress block ─────────────────────────────────────
  function buildBlock(s: BuildStatus | undefined): string[] {
    if (!s || s.phase === 'idle') {
      return [
        `{cyan-fg}▸ BUILD{/cyan-fg}`,
        ` {gray-fg}idle — no build queued{/gray-fg}`,
      ];
    }
    const phaseColor =
      s.phase === 'building' ? 'magenta-fg' :
      s.phase === 'done' ? 'green-fg' :
      s.phase === 'cancelled' ? 'gray-fg' :
      s.phase === 'error' ? 'red-fg' : 'white-fg';
    const phaseLabel = s.phase.toUpperCase();
    const pct = s.total ? Math.floor((s.placed / s.total) * 100) : 0;
    const bar = gauge(s.placed, s.total || 1, 16);
    const mat = s.material ? s.material.replace(/^minecraft:/, '') : '—';
    const o = s.origin;

    // ETA + speed (smoothed)
    const elapsedSec = Math.max(0.001, (Date.now() - buildStartedAt) / 1000);
    const speed = s.placed > 0 ? s.placed / elapsedSec : 0;
    buildLastSpeed = buildLastSpeed > 0 ? buildLastSpeed * 0.7 + speed * 0.3 : speed;
    const remaining = Math.max(0, s.total - s.placed);
    const eta = buildLastSpeed > 0.1 ? remaining / buildLastSpeed : Infinity;

    return [
      `{cyan-fg}▸ BUILD{/cyan-fg}`,
      ` {${phaseColor}}{bold}${phaseLabel}{/bold}{/${phaseColor}} {white-fg}${s.description || '—'}{/white-fg}`,
      ` {gray-fg}material{/gray-fg} {white-fg}${mat}{/white-fg}` + (o ? `   {gray-fg}@{/gray-fg} {white-fg}${o.x},${o.y},${o.z}{/white-fg}` : ''),
      ` {magenta-fg}${bar}{/magenta-fg} {bold}${pct}%{/bold}  {gray-fg}${s.placed}/${s.total}{/gray-fg}`,
      ` {gray-fg}speed{/gray-fg} {white-fg}${buildLastSpeed.toFixed(1)} b/s{/white-fg}   {gray-fg}eta{/gray-fg} {white-fg}${fmtDuration(eta)}{/white-fg}`,
    ];
  }

  // ── Agent activity block (latency-focused, no "thinking" framing) ────
  function agentBlock(): string[] {
    if (!agent) {
      return [
        `{cyan-fg}▸ AGENT{/cyan-fg}`,
        ` {yellow-fg}● basic commands only{/yellow-fg}`,
        ` {gray-fg}no OPENAI_API_KEY detected{/gray-fg}`,
      ];
    }
    const lastMs = agentLastReplyMs > 0 ? `${agentLastReplyMs}ms` : '—';
    const replies = agentReplyCount;
    if (!agentBusy) {
      return [
        `{cyan-fg}▸ AGENT{/cyan-fg}`,
        ` {green-fg}● ready{/green-fg}   {gray-fg}gpt-4.1-mini{/gray-fg}`,
        ` {gray-fg}last reply{/gray-fg} {white-fg}${lastMs}{/white-fg}   {gray-fg}served{/gray-fg} {cyan-fg}${replies}{/cyan-fg}`,
      ];
    }
    const elapsedMs = Date.now() - agentBusySince;
    const spin = SPINNER[spinnerTick % SPINNER.length];
    return [
      `{cyan-fg}▸ AGENT{/cyan-fg}`,
      ` {magenta-fg}{bold}${spin}{/bold}{/magenta-fg} {magenta-fg}working{/magenta-fg}   {gray-fg}${elapsedMs}ms{/gray-fg}`,
      agentLastLine
        ? ` {gray-fg}on{/gray-fg} {white-fg}${truncate(stripTags(agentLastLine), 36)}{/white-fg}`
        : ` {gray-fg}—{/gray-fg}`,
    ];
  }

  function inventoryBlock(): string[] {
    const inv = getInventoryTop(6);
    if (!inv.items.length) {
      return [
        `{cyan-fg}▸ INVENTORY{/cyan-fg}`,
        ` {gray-fg}empty · ${inv.used}/${inv.total} slots{/gray-fg}`,
      ];
    }
    const slotBar = gauge(inv.used, inv.total, 14);
    const slotColor = inv.used >= 32 ? 'red-fg' : inv.used >= 24 ? 'yellow-fg' : 'green-fg';
    const lines = [
      `{cyan-fg}▸ INVENTORY{/cyan-fg}`,
      ` {${slotColor}}${slotBar}{/${slotColor}} {bold}${inv.used}/${inv.total}{/bold} {gray-fg}slots{/gray-fg}`,
    ];
    const nameWidth = 16;
    for (const row of inv.items) {
      const name = row.name.length > nameWidth ? row.name.slice(0, nameWidth - 1) + '…' : row.name.padEnd(nameWidth);
      lines.push(` {white-fg}${name}{/white-fg}  {cyan-fg}${row.count}{/cyan-fg}`);
    }
    return lines;
  }

  function vitalsBlock(): string[] {
    if (!bot?.entity) {
      return [
        `{cyan-fg}▸ VITALS{/cyan-fg}`,
        ` {gray-fg}awaiting spawn…{/gray-fg}`,
      ];
    }
    const hp = bot.health ?? 0;
    const food = bot.food ?? 0;
    const moodScore = Math.max(0, Math.min(100, Math.round(moodTracker?.getScore() ?? 50)));
    const hpColor = hp <= 6 ? 'red-fg' : hp <= 12 ? 'yellow-fg' : 'green-fg';
    const foodColor = food <= 6 ? 'red-fg' : food <= 12 ? 'yellow-fg' : 'green-fg';
    const moodColor = moodScore >= 65 ? 'green-fg' : moodScore >= 40 ? 'yellow-fg' : 'red-fg';
    const moodLabel =
      moodScore >= 82 ? 'great' :
      moodScore >= 65 ? 'good' :
      moodScore >= 48 ? 'mixed' :
      moodScore >= 28 ? 'low' : 'bad';
    return [
      `{cyan-fg}▸ VITALS{/cyan-fg}`,
      ` {${hpColor}}${gauge(hp, 20, 12)}{/${hpColor}} {bold}HP{/bold} ${hp.toFixed(1)}/20`,
      ` {${foodColor}}${gauge(food, 20, 12)}{/${foodColor}} {bold}FOOD{/bold} ${food}/20`,
      ` {${moodColor}}${gauge(moodScore, 100, 12)}{/${moodColor}} {bold}MOOD{/bold} ${moodScore}/100 {gray-fg}${moodLabel}{/gray-fg}`,
    ];
  }

  function positionBlock(): string[] {
    if (!bot?.entity) return [];
    const p = bot.entity.position;
    const dim = bot.game?.dimension ?? '—';
    return [
      `{cyan-fg}▸ POSITION{/cyan-fg}`,
      ` {gray-fg}X{/gray-fg} {white-fg}${p.x.toFixed(1).padStart(8)}{/white-fg}` +
      `   {gray-fg}Y{/gray-fg} {white-fg}${p.y.toFixed(1).padStart(6)}{/white-fg}` +
      `   {gray-fg}Z{/gray-fg} {white-fg}${p.z.toFixed(1).padStart(8)}{/white-fg}`,
      ` {gray-fg}dimension{/gray-fg} {white-fg}${dim}{/white-fg}`,
    ];
  }

  function linkBlock(): string[] {
    const online = !!bot?.entity;
    return [
      `{cyan-fg}▸ LINK{/cyan-fg}`,
      ` ${online ? '{green-fg}● online{/green-fg}' : '{yellow-fg}◐ connecting{/yellow-fg}'}` +
      `   {white-fg}${config.host}:${config.port}{/white-fg}`,
      ` {gray-fg}callsign{/gray-fg} {white-fg}${bot?.username ?? config.username}{/white-fg}`,
    ];
  }

  function voiceBlock(): string[] {
    const voice = voiceServer
      ? '{magenta-fg}● live{/magenta-fg}'
      : config.voiceEnabled
        ? '{yellow-fg}◐ starting{/yellow-fg}'
        : '{gray-fg}○ disabled{/gray-fg}';
    const tts = voiceSpeaker
      ? '{magenta-fg}● ready{/magenta-fg}'
      : '{gray-fg}○ disabled{/gray-fg}';
    return [
      `{cyan-fg}▸ VOICE{/cyan-fg}`,
      ` {gray-fg}listen{/gray-fg} ${voice}   {gray-fg}speak{/gray-fg} ${tts}`,
    ];
  }

  // ── Render telemetry panel ───────────────────────────────────────────
  function renderTelemetry() {
    const blocks: string[][] = [
      linkBlock(),
      vitalsBlock(),
      positionBlock(),
      agentBlock(),
      buildBlock(agent?.getBuildStatus()),
      inventoryBlock(),
      voiceBlock(),
    ];
    const out = blocks
      .filter((b) => b.length > 0)
      .map((b) => b.join('\n'))
      .join('\n\n');
    telemetry.setContent(out);
  }

  // ── Render bottom status line (ticks every 250ms) ────────────────────
  function renderStatusLine() {
    const uptimeSec = Math.floor((Date.now() - procStartedAt) / 1000);
    const uptimeStr = fmtDuration(uptimeSec);
    const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const buildStatus = agent?.getBuildStatus();
    const agentStr = agent
      ? (agentBusy
          ? `{magenta-fg}agent ◐ ${Date.now() - agentBusySince}ms{/magenta-fg}`
          : `{green-fg}agent ● ${agentLastReplyMs > 0 ? agentLastReplyMs + 'ms' : 'ready'}{/green-fg}`)
      : '{yellow-fg}agent ○ basic{/yellow-fg}';

    // Keep the status line minimal and focused: companion, agent, uptime, mem
    statusLine.setContent(
      ` {cyan-fg}{bold}${displayName.toLowerCase()}{/bold}{/cyan-fg} {gray-fg}·{/gray-fg} ` +
      `${agentStr} {gray-fg}·{/gray-fg} {gray-fg}up {white-fg}${uptimeStr}{/white-fg}{/gray-fg} {gray-fg}·{/gray-fg} ` +
      `{gray-fg}mem {white-fg}${memMb}MB{/white-fg}{/gray-fg}`
    );
  }

  // 250ms tick: spinner, status line, telemetry refresh.
  const fastTick = setInterval(() => {
    spinnerTick++;
    renderStatusLine();
    renderTelemetry();
    screen.render();
  }, 250);

  function renderInfo() {
    if (!bot?.entity) return;
    if ((bot.health ?? 20) <= 6) ledStatus?.setStatus('red', 'low health');
    else if ((bot.food ?? 20) <= 8 || !agent) ledStatus?.setStatus('yellow', !agent ? 'agent unavailable' : 'low food');
    else ledStatus?.setStatus('green', 'online');
    renderTelemetry();
    screen.render();
  }

  screen.render();

  // ── Bot connection ────────────────────────────────────────────────────
  let bot: Bot;
  let infoTimer: NodeJS.Timeout | null = null;

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
      if (bot.entity && entity === bot.entity) { repairEntityState('entityHurt'); logMovementDebug('entityHurt'); }
    });
    bot.on('health', () => { repairEntityState('health'); logMovementDebug('health', `hp=${(bot.health ?? 0).toFixed(1)} food=${bot.food ?? 0}`); });
    (bot as any)._client?.on?.('entity_velocity', (packet: any) => {
      if (!bot.entity || packet.entityId !== bot.entity.id) return;
      const raw = packet.velocity ? `${packet.velocity.x},${packet.velocity.y},${packet.velocity.z}` : `${packet.velocityX},${packet.velocityY},${packet.velocityZ}`;
      repairEntityState('entity_velocity'); logMovementDebug('entity_velocity', `raw=${raw}`);
    });
    bot.on('forcedMove', () => { repairEntityState('forcedMove'); logMovementDebug('forcedMove'); });
    bot.on('physicsTick', () => { repairEntityState('physicsTick'); });
    bot.on('path_update', (results: any) => { repairEntityState('path_update'); logMovementDebug('path_update', `status=${results?.status ?? 'unknown'} len=${results?.path?.length ?? 'n/a'}`); });

    bot.on('spawn', () => { prevHealth = bot.health ?? prevHealth; });
    bot.on('death', () => { moodTracker?.bump(-26, 'death'); });
    bot.on('health', () => {
      const h = bot.health ?? 0;
      if (h > 0 && prevHealth > h) {
        moodTracker?.bump(classifyDamageMoodDelta(prevHealth - h, 20), `-${(prevHealth - h).toFixed(1)} HP`);
      }
      prevHealth = h;
    });
    bot.on('playerCollect', (collector, collected) => {
      if (!bot.entity || collector.id !== bot.entity.id) return;
      const dropped = typeof collected.getDroppedItem === 'function' ? collected.getDroppedItem() : null;
      moodTracker?.onCollectedItemId(dropped?.name);
    });

    bot.once('spawn', () => {
      renderHeader({ status: 'online' });
      logSystem(`spawned as {white-fg}${bot.username}{/white-fg}`);
      ledStatus?.setStatus('yellow', 'spawned, checking systems');
      ledStatus?.setMood(moodTracker?.getScore() ?? 50, 'spawn');
      infoTimer = setInterval(renderInfo, 1000);
      void loadAutoEatSafely();
      void (bot as any).armorManager?.equipAll?.().catch?.(() => undefined);

      if (config.skinUsername) {
        const cmd = `/skin set ${config.skinUsername}`;
        bot.chat(cmd);
        logSystem(`skin command sent: {white-fg}${cmd}{/white-fg}`);
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
          (msg) => { logAgent(msg); },
          (msg) => {
            chatLog.log(`{gray-fg}${ts()}{/gray-fg} ${tag('AUTO', 'yellow')} ${msg}`);
            botSayVoiceOnly(msg);
            screen.render();
          },
          (status) => {
            // Build-state milestones → structured log entries.
            if (status.phase === 'building' && lastBuildPhase !== 'building') {
              buildStartedAt = Date.now();
              buildLastPlaced = 0;
              buildLastSpeed = 0;
              logBuild(`▸ {white-fg}${status.description}{/white-fg} — {cyan-fg}${status.total}{/cyan-fg} block changes queued`);
            } else if (status.phase === 'done' && lastBuildPhase === 'building') {
              const took = ((Date.now() - buildStartedAt) / 1000).toFixed(1);
              logBuild(`{green-fg}✓{/green-fg} {white-fg}${status.description}{/white-fg} — {gray-fg}done in ${took}s{/gray-fg}`);
            } else if (status.phase === 'cancelled' && lastBuildPhase === 'building') {
              logBuild(`{gray-fg}⨯ cancelled at ${status.placed}/${status.total}{/gray-fg}`);
            } else if (status.phase === 'error') {
              logError(`build error: ${status.message}`);
            }
            lastBuildPhase = status.phase;
            buildLastPlaced = status.placed;
            renderInfo();
          },
        );
        logAgent(`{green-fg}● ready{/green-fg} — gpt-4.1-mini`);
        ledStatus?.setStatus('green', 'agent ready');
      } else {
        logWarning('no OPENAI_API_KEY; using basic commands only');
        ledStatus?.setStatus('yellow', 'no llm api key');
      }

      renderTelemetry();
      screen.render();
    });

    bot.on('chat', (username, message) => {
      if (shouldIgnoreChatSender(username, bot.username, config.ignoredUsernames, config.ownerUsername)) {
        logIgnoredChat(username, message);
        return;
      }
      logChat(username, message);

      if (!agent) {
        const command = parseChatCommand(message, bot.username);

        if (command === 'greet') {
          botSay(personalityGreeting());
        } else if (command === 'follow') {
          followPlayer(username);
        }
        return;
      }

      const trimmed = message.trim().toLowerCase() as Personality;
      const isOwner = config.ownerUsername
        ? username.trim().toLowerCase() === config.ownerUsername.trim().toLowerCase()
        : true;
      if (isOwner && PERSONALITIES.includes(trimmed)) {
        agent.setPersonality(trimmed);
        logSystem(`personality switched to {magenta-fg}${trimmed}{/magenta-fg}`);
        botSay(`switched to ${trimmed} mode`);
        return;
      }

      beginAgentRequest(`<${username}> ${message}`);
      logAgent(`{magenta-fg}◐{/magenta-fg} handling <${username}>: "${truncate(message, 60)}"`);

      agent.handleMessage(message, username)
        .then((response) => {
          endAgentRequest();
          logAgent(`{green-fg}✓{/green-fg} replied in {white-fg}${agentLastReplyMs}ms{/white-fg}`);
          if (response) botSay(response);
        })
        .catch((err: Error) => {
          endAgentRequest();
          logError(`agent error: ${err.message}`);
          ledStatus?.setStatus('red', 'agent error');
        });
    });

    bot.on('error', (err) => {
      logError(err.message);
      ledStatus?.setStatus('red', 'bot error');
      renderHeader({ status: 'error', reason: err.message });
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
      logWarning(`disconnected: ${reason}`);
      renderHeader({ status: 'error', reason });
      screen.render();
    });
  }

  void startVoiceCommands();
  setupElevenLabs();
  connect();

  // Cleanup on exit
  screen.on('destroy', () => clearInterval(fastTick));
}

// ── Small string utils (top-level so render fns can share) ─────────────
function stripTags(s: string): string {
  return s.replace(/\{[^}]+\}/g, '');
}
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
