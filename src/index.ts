import 'dotenv/config';
import inquirer from 'inquirer';
import readline from 'readline';
import { parseIgnoredUsernames } from './chatFilter';
import { AutonomyLevel, BotConfig } from './config';
import { readOwnerUsernameFromMemory } from './ownerConfig';
import { launchUI } from './ui';
import { SKIN_USERNAMES, SkinUsername, fetchSkinArt, prefetchAllSkins } from './skin/skinPreview';

// ── Skin chooser ─────────────────────────────────────────────────────────────

const SKIN_WIDTH = 22;

function clearLines(n: number) {
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[1A\x1b[2K');
  }
}

async function chooseSkin(): Promise<SkinUsername | undefined> {
  // Ask whether to pick a skin first
  const { wantSkin } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'wantSkin',
      message: 'Choose a companion skin?',
      default: true,
    },
  ]);
  if (!wantSkin) return undefined;

  // Fetch all skin art up-front (already cached from prefetch)
  const arts: Record<string, string> = {};
  for (const u of SKIN_USERNAMES) {
    arts[u] = await fetchSkinArt(u, SKIN_WIDTH).catch(() => '(preview unavailable)');
  }

  let idx = 0;
  let renderedLineCount = 0;

  function renderPicker() {
    if (renderedLineCount > 0) clearLines(renderedLineCount);

    const username = SKIN_USERNAMES[idx];
    const art = arts[username];
    const artLines = art.split('\n');
    const total = SKIN_USERNAMES.length;

    const header = `  Skin ${idx + 1}/${total}: \x1b[1;36m${username}\x1b[0m  (← → to cycle, Enter to confirm)`;
    const divider = '  ' + '─'.repeat(SKIN_WIDTH + 2);
    const framedArt = artLines.map((l) => `  │ ${l} │`).join('\n');
    const footer = `  └${'─'.repeat(SKIN_WIDTH + 2)}┘`;

    const output = `${header}\n  ┌${'─'.repeat(SKIN_WIDTH + 2)}┐\n${framedArt}\n${footer}\n`;
    process.stdout.write(output);
    renderedLineCount = output.split('\n').length;
  }

  return new Promise<SkinUsername>((resolve) => {
    renderPicker();

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const onKey = (_: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === 'right' || key.name === 'l') {
        idx = (idx + 1) % SKIN_USERNAMES.length;
        renderPicker();
      } else if (key.name === 'left' || key.name === 'h') {
        idx = (idx - 1 + SKIN_USERNAMES.length) % SKIN_USERNAMES.length;
        renderPicker();
      } else if (key.name === 'return' || key.name === 'enter') {
        if (renderedLineCount > 0) clearLines(renderedLineCount);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener('keypress', onKey);
        process.stdin.pause();
        const chosen = SKIN_USERNAMES[idx];
        console.log(`  \x1b[32m✔\x1b[0m Skin selected: \x1b[1;36m${chosen}\x1b[0m`);
        resolve(chosen);
      } else if (key.name === 'c' && key.ctrl) {
        process.exit(0);
      }
    };

    process.stdin.on('keypress', onKey);
    process.stdin.resume();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  console.log('');
  console.log('  ███╗   ███╗ ██████╗     COMPANION');
  console.log('  ████╗ ████║██╔════╝     Minecraft field console');
  console.log('  ██╔████╔██║██║          Chat · voice · pathfinding · agent');
  console.log('  ██║╚██╔╝██║██║          ');
  console.log('  ██║ ╚═╝ ██║╚██████╗     Configure link below');
  console.log('  ╚═╝     ╚═╝ ╚═════╝\n');

  // Pre-fetch all skin images in background so they're ready when needed
  void prefetchAllSkins(SKIN_WIDTH);

  const envElevenLabsEnabled = process.env.ELEVENLABS_ENABLED === 'true';
  const envElevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const envElevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const envElevenLabsModelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_turbo_v2_5';
  const envElevenLabsStability = Number(process.env.ELEVENLABS_STABILITY) || 0.4;
  const envElevenLabsSimilarityBoost = Number(process.env.ELEVENLABS_SIMILARITY_BOOST) || 0.75;
  const envElevenLabsStreaming = process.env.ELEVENLABS_STREAMING
    ? process.env.ELEVENLABS_STREAMING === 'true'
    : true;
  const envElevenLabsLatency = Math.max(0, Math.min(4, Number(process.env.ELEVENLABS_LATENCY) || 4));
  const memoryOwnerUsername = readOwnerUsernameFromMemory();
  const envBuildCrewEnabled = process.env.BUILD_CREW_ENABLED
    ? process.env.BUILD_CREW_ENABLED === 'true'
    : true;
  const envBuildCrewSize = Math.max(1, Math.min(8, Number(process.env.BUILD_CREW_SIZE) || 4));

  const answers = await inquirer.prompt([
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
      type: 'input',
      name: 'ownerUsername',
      message: 'Your Minecraft username (owner-only chat filter):',
      default: process.env.MC_OWNER_USERNAME ?? memoryOwnerUsername ?? '',
      filter: (value: string) => value.trim() || undefined,
    },
    {
      type: 'list',
      name: 'personality',
      message: 'Companion personality:',
      choices: [
        { name: 'Friendly  — warm, casual, helpful', value: 'friendly' },
        { name: 'Flirty    — playful, charming, a little too fond of you', value: 'flirty' },
        { name: 'Tsundere  — grumpy on the surface, secretly caring', value: 'tsundere' },
        { name: 'Arrogant  — condescending, superior, insufferably capable', value: 'arrogant' },
      ],
      default: process.env.MC_PERSONALITY ?? 'friendly',
    },
    {
      type: 'input',
      name: 'companionName',
      message: 'Companion name (leave blank to use username):',
      default: process.env.MC_COMPANION_NAME ?? '',
      filter: (value: string) => value.trim() || undefined,
    },
    {
      type: 'input',
      name: 'companionBio',
      message: 'Companion backstory / bio (optional, press enter to skip):',
      default: process.env.MC_COMPANION_BIO ?? '',
      filter: (value: string) => value.trim() || undefined,
    },
    {
      type: 'list',
      name: 'autonomyLevel',
      message: 'Companion autonomy:',
      choices: [
        { name: 'Passive   — only acts when directly asked', value: 'passive' },
        { name: 'Balanced  — default behaviour (recommended)', value: 'balanced' },
        { name: 'Proactive — monitors danger, hunger, and inventory on its own', value: 'proactive' },
      ],
      default: (process.env.MC_AUTONOMY_LEVEL as AutonomyLevel | undefined) ?? 'balanced',
    },
    {
      type: 'input',
      name: 'ignoredUsernames',
      message: 'Other bot usernames to ignore (comma-separated):',
      default: process.env.MC_IGNORED_USERNAMES ?? '',
      filter: parseIgnoredUsernames,
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
    {
      type: 'confirm',
      name: 'buildCrewEnabled',
      message: 'Use temporary helper bots for builds?',
      default: envBuildCrewEnabled,
    },
    {
      type: 'number',
      name: 'buildCrewSize',
      message: 'Build helper bot count:',
      default: envBuildCrewSize,
      when: (answers) => answers.buildCrewEnabled,
    },
    {
      type: 'confirm',
      name: 'voiceEnabled',
      message: 'Enable browser voice commands?',
      default: process.env.VOICE_ENABLED === 'true',
    },
    {
      type: 'number',
      name: 'voicePort',
      message: 'Voice command web page port:',
      default: Number(process.env.VOICE_PORT) || 3333,
      when: (answers) => answers.voiceEnabled,
    },
    {
      type: 'confirm',
      name: 'elevenLabsEnabled',
      message: 'Enable ElevenLabs voice synthesis?',
      default: envElevenLabsEnabled,
      when: () => !envElevenLabsEnabled,
    },
    {
      type: 'password',
      name: 'elevenLabsApiKey',
      message: 'ElevenLabs API key:',
      default: envElevenLabsApiKey ?? '',
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || undefined,
      validate: (value: string) => (value.trim().length ? true : 'API key is required'),
    },
    {
      type: 'input',
      name: 'elevenLabsVoiceId',
      message: 'ElevenLabs voice ID:',
      default: envElevenLabsVoiceId ?? '',
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || undefined,
      validate: (value: string) => (value.trim().length ? true : 'Voice ID is required'),
    },
    {
      type: 'input',
      name: 'elevenLabsModelId',
      message: 'ElevenLabs model ID:',
      default: envElevenLabsModelId,
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
      filter: (value: string) => value.trim() || envElevenLabsModelId,
    },
    {
      type: 'number',
      name: 'elevenLabsStability',
      message: 'ElevenLabs stability (0.0 - 1.0):',
      default: envElevenLabsStability,
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
    },
    {
      type: 'number',
      name: 'elevenLabsSimilarityBoost',
      message: 'ElevenLabs similarity boost (0.0 - 1.0):',
      default: envElevenLabsSimilarityBoost,
      when: (answers) => !envElevenLabsEnabled && answers.elevenLabsEnabled,
    },
  ]);

  const skinUsername = await chooseSkin();

  const config: BotConfig = {
    ...answers,
    ownerUsername: process.env.MC_OWNER_USERNAME?.trim() || memoryOwnerUsername || answers.ownerUsername,
    elevenLabsEnabled: envElevenLabsEnabled ? true : answers.elevenLabsEnabled ?? false,
    elevenLabsApiKey: envElevenLabsApiKey ?? answers.elevenLabsApiKey,
    elevenLabsVoiceId: envElevenLabsVoiceId ?? answers.elevenLabsVoiceId,
    elevenLabsModelId: envElevenLabsModelId ?? answers.elevenLabsModelId,
    elevenLabsStability: envElevenLabsStability ?? answers.elevenLabsStability,
    elevenLabsSimilarityBoost: envElevenLabsSimilarityBoost ?? answers.elevenLabsSimilarityBoost,
    elevenLabsStreaming: envElevenLabsStreaming,
    elevenLabsLatency: envElevenLabsLatency,
    buildCrewEnabled: answers.buildCrewEnabled ?? envBuildCrewEnabled,
    buildCrewSize: Math.max(1, Math.min(8, Number(answers.buildCrewSize) || envBuildCrewSize)),
    skinUsername,
  };

  launchUI(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
