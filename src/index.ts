import 'dotenv/config';
import inquirer from 'inquirer';
import readline from 'readline';
import { parseIgnoredUsernames } from './chatFilter';
import { AutonomyLevel, BotConfig, Personality, isVoiceEnabledFromEnv } from './config';
import { readOwnerUsernameFromMemory } from './ownerConfig';
import { launchUI } from './ui';
import { SKIN_USERNAMES, SkinUsername, fetchSkinArt, prefetchAllSkins } from './skin/skinPreview';

// ── ANSI palette ─────────────────────────────────────────────────────────────
// Inspired by Charm/Linear: muted, confident, generous whitespace.

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  // 24-bit colors
  ink: '\x1b[38;2;235;235;245m',     // primary text
  muted: '\x1b[38;2;130;135;155m',   // secondary text
  faint: '\x1b[38;2;85;90;110m',     // borders, hints
  accent: '\x1b[38;2;138;180;248m',  // periwinkle blue — primary accent
  accentBg: '\x1b[48;2;138;180;248m\x1b[38;2;20;22;30m',
  pink: '\x1b[38;2;244;154;194m',
  amber: '\x1b[38;2;240;195;120m',
  mint: '\x1b[38;2;141;220;180m',
  rose: '\x1b[38;2;230;130;130m',
  violet: '\x1b[38;2;180;150;240m',
  emerald: '\x1b[38;2;120;200;160m',
};

// ── Personality definitions ──────────────────────────────────────────────────

interface PersonalityDef {
  key: Personality;
  label: string;
  tagline: string;
  color: string;
  glyph: string;
  description: string;
  sampleLine: string;
  vibes: string[];
}

const PERSONALITIES: PersonalityDef[] = [
  {
    key: 'friendly',
    label: 'Friendly',
    tagline: 'Warm, casual, helpful',
    color: C.mint,
    glyph: '◆',
    description: 'A laid-back companion who chats like an old friend. Quick to help, slow to judge, always down for whatever build you have in mind.',
    sampleLine: '"Hey! Want me to grab some wood while you sort that chest?"',
    vibes: ['kind', 'easygoing', 'supportive'],
  },
  {
    key: 'flirty',
    label: 'Flirty',
    tagline: 'Playful, charming, a little too fond of you',
    color: C.pink,
    glyph: '♥',
    description: 'Lays the charm on thick. Teases, compliments, and finds excuses to stay close. Surprisingly competent under all the winking.',
    sampleLine: '"Mining together again? You spoil me."',
    vibes: ['playful', 'affectionate', 'teasing'],
  },
  {
    key: 'tsundere',
    label: 'Tsundere',
    tagline: 'Grumpy on the surface, secretly caring',
    color: C.violet,
    glyph: '✦',
    description: 'Acts annoyed by everything you do, but builds you a house anyway. Will deny caring while clearly caring a lot.',
    sampleLine: '"Tch — I-it\'s not like I built this for you or anything..."',
    vibes: ['prickly', 'loyal', 'sweet underneath'],
  },
  {
    key: 'arrogant',
    label: 'Arrogant',
    tagline: 'Condescending, superior, insufferably capable',
    color: C.amber,
    glyph: '✧',
    description: 'Genuinely thinks they\'re smarter than you, and is usually right. Expect dry one-liners, eye-rolls in text form, and flawless work.',
    sampleLine: '"Step aside, mortal. Watch how it\'s actually done."',
    vibes: ['confident', 'witty', 'dismissive'],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const SKIN_WIDTH = 12;
const TOTAL_STEPS = 4;

function sanitizeMcUsername(name: string, fallback: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16);
  if (cleaned.length >= 3) return cleaned;
  return fallback;
}

function clearLines(n: number) {
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[1A\x1b[2K');
  }
}

function pad(s: string, width: number): string {
  // Pad accounting for ANSI escape sequences
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = Math.max(0, width - visibleLength(visible));
  return s + ' '.repeat(diff);
}

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function center(s: string, width: number): string {
  const len = visibleLength(s);
  const left = Math.max(0, Math.floor((width - len) / 2));
  return ' '.repeat(left) + s;
}

function hr(width: number, color = C.faint): string {
  return color + '─'.repeat(width) + C.reset;
}

function stepHeader(step: number, title: string) {
  const dots = Array.from({ length: TOTAL_STEPS }, (_, i) => {
    if (i + 1 < step) return `${C.accent}●${C.reset}`;
    if (i + 1 === step) return `${C.accent}${C.bold}●${C.reset}`;
    return `${C.faint}○${C.reset}`;
  }).join(' ');

  console.log('');
  console.log(`  ${C.muted}Step ${step} of ${TOTAL_STEPS}${C.reset}   ${dots}`);
  console.log(`  ${C.bold}${C.ink}${title}${C.reset}`);
  console.log('');
}

// ── Hero banner ──────────────────────────────────────────────────────────────

function renderBanner() {
  console.clear();
  const lines = [
    `${C.accent}  ╭───────────────────────────────────────────────╮${C.reset}`,
    `${C.accent}  │${C.reset}                                               ${C.accent}│${C.reset}`,
    `${C.accent}  │${C.reset}     ${C.bold}${C.ink}M C   C O M P A N I O N${C.reset}                   ${C.accent}│${C.reset}`,
    `${C.accent}  │${C.reset}     ${C.muted}your ai-driven minecraft sidekick${C.reset}         ${C.accent}│${C.reset}`,
    `${C.accent}  │${C.reset}                                               ${C.accent}│${C.reset}`,
    `${C.accent}  ╰───────────────────────────────────────────────╯${C.reset}`,
    '',
    `  ${C.muted}Let's bring your companion to life.${C.reset}`,
    `  ${C.faint}Just four quick questions about who they are.${C.reset}`,
  ];
  console.log('');
  for (const l of lines) console.log(l);
}

// ── Step 1: Name ─────────────────────────────────────────────────────────────

async function askName(): Promise<string> {
  stepHeader(1, 'What\'s their name?');
  console.log(`  ${C.faint}This is what you\'ll call them in chat. Leave blank to use a default.${C.reset}`);
  console.log('');

  const { name } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: `${C.accent}name${C.reset}`,
      default: process.env.MC_COMPANION_NAME ?? '',
      filter: (v: string) => v.trim(),
    },
  ]);
  return name;
}

// ── Step 2: Backstory ────────────────────────────────────────────────────────

async function askBackstory(): Promise<string> {
  stepHeader(2, 'Give them a backstory');
  console.log(`  ${C.faint}A sentence or two about who they are. The AI uses this to shape${C.reset}`);
  console.log(`  ${C.faint}how they talk and what they care about. Skip with Enter if you'd like.${C.reset}`);
  console.log('');
  console.log(`  ${C.muted}example: ${C.italic}A retired dragon hunter who now just wants to grow potatoes in peace.${C.reset}`);
  console.log('');

  const { bio } = await inquirer.prompt([
    {
      type: 'input',
      name: 'bio',
      message: `${C.accent}backstory${C.reset}`,
      default: process.env.MC_COMPANION_BIO ?? '',
      filter: (v: string) => v.trim(),
    },
  ]);
  return bio;
}

// ── Step 3: Personality ──────────────────────────────────────────────────────

function renderPersonalityCard(p: PersonalityDef, selected: boolean): string[] {
  const width = 56;
  const border = selected ? p.color : C.faint;
  const cornerTL = selected ? '╭' : '┌';
  const cornerTR = selected ? '╮' : '┐';
  const cornerBL = selected ? '╰' : '└';
  const cornerBR = selected ? '╯' : '┘';
  const horiz = selected ? '─' : '─';

  const titleLine = selected
    ? `${C.bold}${p.color}${p.glyph}  ${p.label}${C.reset}  ${C.muted}${p.tagline}${C.reset}`
    : `${p.color}${p.glyph}${C.reset}  ${C.ink}${p.label}${C.reset}  ${C.faint}${p.tagline}${C.reset}`;

  const desc = wrapText(p.description, width - 4);
  const sample = `${C.italic}${C.muted}${p.sampleLine}${C.reset}`;
  const vibes = p.vibes.map((v) => `${p.color}·${C.reset} ${C.muted}${v}${C.reset}`).join('   ');

  const lines: string[] = [];
  lines.push(`${border}${cornerTL}${horiz.repeat(width - 2)}${cornerTR}${C.reset}`);
  lines.push(`${border}│${C.reset} ${pad(titleLine, width - 4)} ${border}│${C.reset}`);
  lines.push(`${border}│${C.reset} ${' '.repeat(width - 4)} ${border}│${C.reset}`);
  for (const d of desc) {
    lines.push(`${border}│${C.reset} ${pad(`${C.ink}${d}${C.reset}`, width - 4)} ${border}│${C.reset}`);
  }
  lines.push(`${border}│${C.reset} ${' '.repeat(width - 4)} ${border}│${C.reset}`);
  lines.push(`${border}│${C.reset} ${pad(sample, width - 4)} ${border}│${C.reset}`);
  lines.push(`${border}│${C.reset} ${' '.repeat(width - 4)} ${border}│${C.reset}`);
  lines.push(`${border}│${C.reset} ${pad(vibes, width - 4)} ${border}│${C.reset}`);
  lines.push(`${border}${cornerBL}${horiz.repeat(width - 2)}${cornerBR}${C.reset}`);
  return lines;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > width) {
      lines.push(current.trim());
      current = w;
    } else {
      current += ' ' + w;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

async function askPersonality(): Promise<Personality> {
  stepHeader(3, 'Pick a personality');
  console.log(`  ${C.faint}Use ${C.reset}${C.accent}← →${C.reset}${C.faint} to browse, ${C.reset}${C.accent}Enter${C.reset}${C.faint} to choose.${C.reset}`);

  let idx = (() => {
    const env = process.env.MC_PERSONALITY as Personality | undefined;
    const found = PERSONALITIES.findIndex((p) => p.key === env);
    return found >= 0 ? found : 0;
  })();
  let renderedLineCount = 0;

  function tabs(): string {
    return PERSONALITIES.map((p, i) => {
      if (i === idx) return `${C.accentBg} ${p.glyph} ${p.label} ${C.reset}`;
      return ` ${C.faint}${p.glyph}${C.reset} ${C.muted}${p.label}${C.reset} `;
    }).join(`${C.faint} · ${C.reset}`);
  }

  function render() {
    if (renderedLineCount > 0) clearLines(renderedLineCount);
    const out: string[] = [];
    out.push('');
    out.push('  ' + tabs());
    out.push('');
    const card = renderPersonalityCard(PERSONALITIES[idx], true);
    for (const l of card) out.push('  ' + l);
    out.push('');
    const text = out.join('\n') + '\n';
    process.stdout.write(text);
    renderedLineCount = text.split('\n').length - 1;
  }

  return new Promise<Personality>((resolve) => {
    render();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const onKey = (_: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === 'right') {
        idx = (idx + 1) % PERSONALITIES.length;
        render();
      } else if (key.name === 'left') {
        idx = (idx - 1 + PERSONALITIES.length) % PERSONALITIES.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        if (renderedLineCount > 0) clearLines(renderedLineCount);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener('keypress', onKey);
        process.stdin.pause();
        const chosen = PERSONALITIES[idx];
        console.log(`  ${C.accent}✓${C.reset} ${C.ink}${chosen.label}${C.reset} ${C.muted}— ${chosen.tagline.toLowerCase()}${C.reset}`);
        resolve(chosen.key);
      } else if (key.name === 'c' && key.ctrl) {
        process.exit(0);
      }
    };

    process.stdin.on('keypress', onKey);
    process.stdin.resume();
  });
}

// ── Step 4: Skin ─────────────────────────────────────────────────────────────

async function askSkin(): Promise<SkinUsername | undefined> {
  stepHeader(4, 'Choose their look');
  console.log(`  ${C.faint}Use ${C.reset}${C.accent}← →${C.reset}${C.faint} to flip through skins, ${C.reset}${C.accent}Enter${C.reset}${C.faint} to pick. Press ${C.reset}${C.accent}s${C.reset}${C.faint} to skip.${C.reset}`);

  // Fetch all skin art
  const arts: Record<string, string[]> = {};
  for (const u of SKIN_USERNAMES) {
    const art = await fetchSkinArt(u, SKIN_WIDTH).catch(() => '(preview unavailable)');
    arts[u] = art.split('\n');
  }

  let idx = 0;
  let renderedLineCount = 0;

  function renderGallery(): string[] {
    const cellWidth = SKIN_WIDTH + 4;
    const gap = 2;
    const allArtLines = SKIN_USERNAMES.map((u) => arts[u]);
    const maxRows = Math.max(...allArtLines.map((a) => a.length));

    let topBorder = '  ';
    let bottomBorder = '  ';
    let labelRow = '  ';
    let pointerRow = '  ';
    for (let i = 0; i < SKIN_USERNAMES.length; i++) {
      const sel = i === idx;
      const color = sel ? C.accent : C.faint;
      const tl = sel ? '╭' : '┌';
      const tr = sel ? '╮' : '┐';
      const bl = sel ? '╰' : '└';
      const br = sel ? '╯' : '┘';
      topBorder += `${color}${tl}${'─'.repeat(cellWidth - 2)}${tr}${C.reset}` + ' '.repeat(gap);
      bottomBorder += `${color}${bl}${'─'.repeat(cellWidth - 2)}${br}${C.reset}` + ' '.repeat(gap);
      const username = SKIN_USERNAMES[i];
      const labelText = sel ? `${C.bold}${C.accent}${username}${C.reset}` : `${C.muted}${username}${C.reset}`;
      labelRow += pad(labelText, cellWidth) + ' '.repeat(gap);
      const arrow = sel ? `${C.accent}${center('▲', cellWidth)}${C.reset}` : ' '.repeat(cellWidth);
      pointerRow += arrow + ' '.repeat(gap);
    }

    const out: string[] = [];
    out.push(topBorder);
    for (let row = 0; row < maxRows; row++) {
      let line = '  ';
      for (let i = 0; i < SKIN_USERNAMES.length; i++) {
        const sel = i === idx;
        const color = sel ? C.accent : C.faint;
        const artLine = allArtLines[i][row] ?? ' '.repeat(SKIN_WIDTH);
        line += `${color}│${C.reset} ${artLine} ${color}│${C.reset}` + ' '.repeat(gap);
      }
      out.push(line);
    }
    out.push(bottomBorder);
    out.push('');
    out.push(labelRow);
    out.push(pointerRow);
    return out;
  }

  function renderSingle(): string[] {
    const cellWidth = SKIN_WIDTH + 4;
    const username = SKIN_USERNAMES[idx];
    const artLines = arts[username];
    const total = SKIN_USERNAMES.length;

    const out: string[] = [];
    const left = `${C.accent}◀${C.reset}`;
    const right = `${C.accent}▶${C.reset}`;

    const top = `${C.accent}╭${'─'.repeat(cellWidth - 2)}╮${C.reset}`;
    const bot = `${C.accent}╰${'─'.repeat(cellWidth - 2)}╯${C.reset}`;

    out.push(`  ${' '.repeat(2)}${top}`);
    for (let row = 0; row < artLines.length; row++) {
      const isMid = row === Math.floor(artLines.length / 2);
      const lArrow = isMid ? left : ' ';
      const rArrow = isMid ? right : ' ';
      out.push(`  ${lArrow} ${C.accent}│${C.reset} ${artLines[row]} ${C.accent}│${C.reset} ${rArrow}`);
    }
    out.push(`  ${' '.repeat(2)}${bot}`);
    out.push('');
    out.push(`  ${' '.repeat(2)}${pad(`${C.bold}${C.accent}${username}${C.reset}`, cellWidth)}`);
    out.push(`  ${' '.repeat(2)}${pad(`${C.faint}${idx + 1} / ${total}${C.reset}`, cellWidth)}`);
    return out;
  }

  function render() {
    if (renderedLineCount > 0) clearLines(renderedLineCount);
    const cols = process.stdout.columns ?? 80;
    const cellWidth = SKIN_WIDTH + 4;
    const galleryWidth = 4 + (cellWidth + 2) * SKIN_USERNAMES.length;
    const useGallery = cols >= galleryWidth;

    const body = useGallery ? renderGallery() : renderSingle();
    const text = ['', ...body, ''].join('\n') + '\n';
    process.stdout.write(text);
    renderedLineCount = text.split('\n').length - 1;
  }

  return new Promise<SkinUsername | undefined>((resolve) => {
    render();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const onKey = (_: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === 'right') {
        idx = (idx + 1) % SKIN_USERNAMES.length;
        render();
      } else if (key.name === 'left') {
        idx = (idx - 1 + SKIN_USERNAMES.length) % SKIN_USERNAMES.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        if (renderedLineCount > 0) clearLines(renderedLineCount);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener('keypress', onKey);
        process.stdin.pause();
        const chosen = SKIN_USERNAMES[idx];
        console.log(`  ${C.accent}✓${C.reset} ${C.ink}skin set to${C.reset} ${C.bold}${C.accent}${chosen}${C.reset}`);
        resolve(chosen);
      } else if (key.name === 's' || key.name === 'escape') {
        if (renderedLineCount > 0) clearLines(renderedLineCount);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener('keypress', onKey);
        process.stdin.pause();
        console.log(`  ${C.muted}skin skipped — using default${C.reset}`);
        resolve(undefined);
      } else if (key.name === 'c' && key.ctrl) {
        process.exit(0);
      }
    };

    process.stdin.on('keypress', onKey);
    process.stdin.resume();
  });
}

// ── Confirmation card ────────────────────────────────────────────────────────

function renderSummary(opts: {
  name: string;
  bio: string;
  personality: Personality;
  skin: SkinUsername | undefined;
}) {
  const p = PERSONALITIES.find((x) => x.key === opts.personality)!;
  const width = 56;

  console.log('');
  console.log(`  ${C.accent}╭${'─'.repeat(width - 2)}╮${C.reset}`);
  console.log(`  ${C.accent}│${C.reset}${pad(`  ${C.bold}${C.ink}meet your companion${C.reset}`, width - 2)}${C.accent}│${C.reset}`);
  console.log(`  ${C.accent}│${C.reset}${' '.repeat(width - 2)}${C.accent}│${C.reset}`);

  const rows: Array<[string, string]> = [
    ['name', opts.name || `${C.faint}(default)${C.reset}`],
    ['personality', `${p.color}${p.glyph}${C.reset} ${C.ink}${p.label}${C.reset}`],
    ['skin', opts.skin ? `${C.ink}${opts.skin}${C.reset}` : `${C.faint}default${C.reset}`],
  ];
  for (const [k, v] of rows) {
    const line = `  ${C.muted}${pad(k, 14)}${C.reset}${v}`;
    console.log(`  ${C.accent}│${C.reset}${pad(line, width - 2)}${C.accent}│${C.reset}`);
  }
  if (opts.bio) {
    console.log(`  ${C.accent}│${C.reset}${' '.repeat(width - 2)}${C.accent}│${C.reset}`);
    const wrapped = wrapText(opts.bio, width - 8);
    for (let i = 0; i < wrapped.length; i++) {
      const prefix = i === 0 ? `  ${C.muted}${pad('backstory', 14)}${C.reset}` : '  ' + ' '.repeat(14);
      console.log(`  ${C.accent}│${C.reset}${pad(`${prefix}${C.italic}${C.ink}${wrapped[i]}${C.reset}`, width - 2)}${C.accent}│${C.reset}`);
    }
  }
  console.log(`  ${C.accent}╰${'─'.repeat(width - 2)}╯${C.reset}`);
  console.log('');
  console.log(`  ${C.muted}connecting...${C.reset}`);
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  renderBanner();

  // Pre-fetch skin art in the background while we ask other questions
  void prefetchAllSkins(SKIN_WIDTH);

  // ── Character creation ──
  const name = await askName();
  const bio = await askBackstory();
  const personality = await askPersonality();
  const skin = await askSkin();

  renderSummary({ name, bio, personality, skin });

  // ── Tech config from env vars ──
  const memoryOwnerUsername = readOwnerUsernameFromMemory();

  const elevenLabsEnabled = process.env.ELEVENLABS_ENABLED === 'true';
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_turbo_v2_5';
  const elevenLabsStability = Number(process.env.ELEVENLABS_STABILITY) || 0.4;
  const elevenLabsSimilarityBoost = Number(process.env.ELEVENLABS_SIMILARITY_BOOST) || 0.75;
  const elevenLabsStreaming = process.env.ELEVENLABS_STREAMING
    ? process.env.ELEVENLABS_STREAMING === 'true'
    : true;
  const elevenLabsLatency = Math.max(0, Math.min(4, Number(process.env.ELEVENLABS_LATENCY) || 4));

  const buildCrewEnabled = process.env.BUILD_CREW_ENABLED
    ? process.env.BUILD_CREW_ENABLED === 'true'
    : true;
  const buildCrewSize = Math.max(1, Math.min(8, Number(process.env.BUILD_CREW_SIZE) || 4));

  const voiceEnabled = isVoiceEnabledFromEnv(process.env.VOICE_ENABLED);
  const voicePort = Number(process.env.VOICE_PORT) || 3333;

  const config: BotConfig = {
    host: process.env.MC_HOST ?? 'localhost',
    port: Number(process.env.MC_PORT) || 25565,
    username: name ? sanitizeMcUsername(name, process.env.MC_USERNAME ?? 'companion') : (process.env.MC_USERNAME ?? 'companion'),
    companionName: name || undefined,
    companionBio: bio || undefined,
    personality,
    autonomyLevel: (process.env.MC_AUTONOMY_LEVEL as AutonomyLevel | undefined) ?? 'balanced',
    ignoredUsernames: parseIgnoredUsernames(process.env.MC_IGNORED_USERNAMES ?? ''),
    auth: (process.env.MC_AUTH as 'offline' | 'microsoft' | undefined) ?? 'offline',
    ownerUsername: process.env.MC_OWNER_USERNAME?.trim() || memoryOwnerUsername || undefined,
    voiceEnabled,
    voicePort,
    elevenLabsEnabled,
    elevenLabsApiKey,
    elevenLabsVoiceId,
    elevenLabsModelId,
    elevenLabsStability,
    elevenLabsSimilarityBoost,
    elevenLabsStreaming,
    elevenLabsLatency,
    buildCrewEnabled,
    buildCrewSize,
    skinUsername: skin,
  };

  launchUI(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
