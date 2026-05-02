import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nbt = require('prismarine-nbt') as {
  parse: (buf: Buffer) => Promise<{ parsed: NbtNode; type: string }>;
};

type NbtNode = { type: string; value: unknown; name?: string };

export interface GeneratedBlock { x: number; y: number; z: number; block: string }
export interface GeneratedBuild {
  blocks: GeneratedBlock[];
  width: number;
  height: number;
  length: number;
  description: string;
  /** Set on persisted builds; lets the caller key edits to a stored build. */
  buildId?: string;
  /** The Python script that produced this build, kept for future edit passes. */
  script?: string;
}

export interface StoredBuildMeta {
  id: string;
  description: string;
  origin: { x: number; y: number; z: number; rotation: 0 | 90 | 180 | 270 };
  width: number;
  height: number;
  length: number;
  createdAt: number;
  updatedAt: number;
  history: { prompt: string; ts: number; kind: 'create' | 'edit' }[];
}

const BUILDS_DIR = path.resolve(process.cwd(), '.minecraft-companion-builds');
const BUILDS_INDEX = path.join(BUILDS_DIR, 'index.json');

const SYSTEM_PYTHON = process.env.VENV_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// Per-project virtualenv. Lives at <repo>/.pybuild and is created on first build
// for every dev. Keeps mcschematic out of system site-packages so we never fight
// with locked .exe shims or admin-owned Python installs.
const VENV_DIR = path.resolve(process.cwd(), '.pybuild');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');

const SYSTEM_INSTRUCTION = `Output a runnable Python script using the \`mcschematic\` library that builds the requested structure with min corner at (0,0,0). Python only, no markdown fences.

EXACT mcschematic API — use these calls and ONLY these calls:
  import sys, mcschematic
  schem = mcschematic.MCSchematic()                       # create empty schematic
  schem.setBlock((x, y, z), "minecraft:stone")            # place one block (tuple coord, namespaced id, optional [state])
  schem.save(sys.argv[1], sys.argv[2], mcschematic.Version.JE_1_20_1)  # write <argv1>/<argv2>.schem

Do NOT invent methods. There is no create_structure, no set_block, no Schematic(), no Version.JE_1_20_1.create_structure(). The constructor is mcschematic.MCSchematic() with no args. The block setter is .setBlock((x,y,z), id) — camelCase, tuple coord.`;

const FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || 'gemini-3-flash-preview';
const PRO_MODEL = process.env.GEMINI_PRO_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

// Two-pass: dead-simple massing (flash, no thinking) so the player sees
// SOMETHING almost immediately, then a full design pass (pro w/ thinking) that
// iterates on the massing script while the bot is mid-render.
const PASS_PROMPTS: { label: string; instruction: string; model: string; thinkingBudget: number }[] = [
  {
    label: 'massing',
    model: FLASH_MODEL,
    thinkingBudget: 0,
    instruction: [
      'PASS 1 — ROUGH MASSING. Output the simplest possible blocky placeholder for the requested structure.',
      'Pick ONE primary block that fits the theme. You may use up to one secondary block for the roof if obvious.',
      'Just get the footprint, walls, floors, and a flat or simple pitched roof down. Rooms can be hollow.',
      'Do NOT add windows, trim, decorations, overhangs, or interior detail.',
      'Keep the script short and obviously correct — this is a placeholder that will be refined.',
    ].join(' '),
  },
  {
    label: 'design',
    model: PRO_MODEL,
    thinkingBudget: 4096,
    instruction: [
      'PASS 2 — DETAIL ON TOP OF EXISTING MASS. The previous script defines the load-bearing geometry of this build. You MUST preserve it.',
      '',
      'HARD RULES — read carefully, these are not suggestions:',
      '1. EVERY block placed by pass 1 must remain in the same position with the same block type, with these narrow exceptions:',
      '   (a) you may carve out window/door openings (set to air) — at most ~10% of wall blocks total.',
      '   (b) you may swap individual blocks to a contrasting accent block for trim/banding — at most ~10% of pass-1 blocks total.',
      '2. You MUST NOT change the primary block type of pass 1 to a different material across the board. If pass 1 used cobblestone walls, the walls stay cobblestone. Pick accents that COMPLEMENT the existing palette.',
      '3. You MUST NOT shrink, expand, or move the footprint or wall lines of pass 1.',
      '',
      'WHAT YOU SHOULD ADD (this is where the design comes from — by extension, not replacement):',
      '   - Roof overhangs that extend OUTWARD past pass 1\'s walls (1 block on all sides).',
      '   - A base course / plinth that extends OUTWARD past the walls at ground level (slabs or a complementary block).',
      '   - Trim bands, pilasters, or corner quoins ATTACHED to the outside of pass 1\'s walls.',
      '   - A more interesting roof BUILT ABOVE pass 1\'s roof (pitched, stepped, or layered) — keep pass 1\'s roof blocks underneath as structure, or replace them only if pass 1\'s roof was a flat slab.',
      '   - Window/door FRAMES around the openings you carve.',
      '   - Decorations placed AROUND or ON TOP OF the structure: lanterns on walls, a few flower pots or oak-leaf bushes at the base, a barrel, a hanging sign, sparingly. Not a ring of foliage around the whole building.',
      '   - Interior lighting (lanterns, sea lanterns) placed inside the existing volume.',
      '',
      'THINK OF PASS 1 AS A SCULPTURE THAT IS ALREADY CARVED. Your job is to dress it — add the roof tiles, the molding, the lanterns, the planter boxes — not to re-carve it.',
      '',
      'OUTPUT: the COMPLETE updated Python script. It must re-place all pass-1 blocks (so the script is self-contained) AND add your additions. This is the final pass.',
    ].join('\n'),
  },
];

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in environment');
  return key;
}

type GeminiTurn = { role: 'user' | 'model'; text: string };

async function callGemini(turns: GeminiTurn[], opts: { model?: string; thinkingBudget?: number } = {}): Promise<string> {
  const apiKey = getApiKey();
  const model = opts.model || PRO_MODEL;
  const thinkingBudget = opts.thinkingBudget ?? 200;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: turns.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 24576,
      thinkingConfig: { thinkingBudget },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new Error('Gemini returned empty response');
  return stripFences(text);
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:python)?\s*\n?/i, '');
    t = t.replace(/```\s*$/i, '');
  }
  return t.trim();
}

function runChild(cmd: string, args: string[], log: (msg: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (stderr.trim()) log(`[gemini-build] ${cmd} stderr: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function venvExists(): Promise<boolean> {
  try { await fs.access(VENV_PYTHON); return true; } catch { return false; }
}

async function createVenv(log: (msg: string) => void): Promise<void> {
  log(`[gemini-build] creating project venv at ${VENV_DIR} (one-time setup)...`);
  const create = await runChild(SYSTEM_PYTHON, ['-m', 'venv', VENV_DIR], log);
  if (create.code !== 0) {
    throw new Error(
      `Failed to create venv with "${SYSTEM_PYTHON}". ` +
      `Make sure Python 3 is installed and on PATH (or set PYTHON_CMD env var). ` +
      `Error: ${create.stderr.slice(0, 200)}`,
    );
  }
}

let mcschematicReady = false;
async function ensureMcschematic(log: (msg: string) => void): Promise<void> {
  if (mcschematicReady) return;

  if (!(await venvExists())) {
    await createVenv(log);
  }

  const probe = await runChild(VENV_PYTHON, ['-c', 'import mcschematic'], log);
  if (probe.code === 0) { mcschematicReady = true; return; }

  log('[gemini-build] installing mcschematic into project venv...');
  const install = await runChild(
    VENV_PYTHON,
    ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'mcschematic'],
    log,
  );
  if (install.code !== 0) {
    throw new Error(`pip install mcschematic failed: ${install.stderr.slice(0, 300) || install.stdout.slice(0, 300)}`);
  }
  mcschematicReady = true;
}

/** Read .schem (Sponge V2/V3) file and extract blocks. */
async function parseSchem(filePath: string): Promise<GeneratedBuild> {
  const raw = await fs.readFile(filePath);
  const buf: Buffer = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  const { parsed } = await nbt.parse(buf);
  const root = unwrap(parsed) as Record<string, unknown>;

  // V3 nests under "Schematic"
  const schem = (root.Schematic ? unwrap(root.Schematic as NbtNode) : root) as Record<string, unknown>;

  const width = Number(unwrap(schem.Width as NbtNode) ?? 0);
  const height = Number(unwrap(schem.Height as NbtNode) ?? 0);
  const length = Number(unwrap(schem.Length as NbtNode) ?? 0);
  if (!width || !height || !length) {
    const rootKeys = Object.keys(root);
    const schemKeys = Object.keys(schem);
    throw new Error(
      `Schematic missing dimensions. root keys: [${rootKeys.join(', ')}], ` +
      `schem keys: [${schemKeys.join(', ')}], W=${schem.Width} H=${schem.Height} L=${schem.Length}`,
    );
  }

  // V3: blocks live under Blocks { Palette, Data }
  // V2: top-level Palette + BlockData
  let paletteRaw: Record<string, unknown> | undefined;
  let dataRaw: number[] | Buffer | undefined;
  if (schem.Blocks) {
    const b = unwrap(schem.Blocks as NbtNode) as Record<string, unknown>;
    paletteRaw = unwrap(b.Palette as NbtNode) as Record<string, unknown>;
    dataRaw = unwrap(b.Data as NbtNode) as number[] | Buffer;
  } else {
    paletteRaw = unwrap(schem.Palette as NbtNode) as Record<string, unknown>;
    dataRaw = unwrap(schem.BlockData as NbtNode) as number[] | Buffer;
  }
  if (!paletteRaw || !dataRaw) throw new Error('Schematic missing palette or block data');

  const palette: string[] = [];
  for (const [name, idxNode] of Object.entries(paletteRaw)) {
    const idx = Number(unwrap(idxNode as NbtNode) ?? idxNode);
    if (!Number.isFinite(idx)) continue;
    palette[idx] = name;
  }

  const bytes: number[] = Array.isArray(dataRaw) ? dataRaw : Array.from(dataRaw as Buffer);
  // varint decode
  const indices: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
      if (i >= bytes.length) break;
      byte = bytes[i++] & 0xff;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0);
    indices.push(value);
  }

  const blocks: GeneratedBlock[] = [];
  // Sponge order: index = x + z*W + y*W*L
  for (let n = 0; n < indices.length; n++) {
    const id = palette[indices[n]];
    if (!id || id === 'minecraft:air' || id.startsWith('minecraft:air[')) continue;
    const y = Math.floor(n / (width * length));
    const rem = n - y * width * length;
    const z = Math.floor(rem / width);
    const x = rem - z * width;
    blocks.push({ x, y, z, block: id });
  }

  return { blocks, width, height, length, description: '' };
}

function unwrap(node: NbtNode | undefined): unknown {
  if (!node) return undefined;
  return (node as { value: unknown }).value;
}

async function ensureBuildsDir(): Promise<void> {
  await fs.mkdir(BUILDS_DIR, { recursive: true });
}

async function readIndex(): Promise<StoredBuildMeta[]> {
  try {
    const raw = await fs.readFile(BUILDS_INDEX, 'utf8');
    const arr = JSON.parse(raw) as StoredBuildMeta[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeIndex(entries: StoredBuildMeta[]): Promise<void> {
  await ensureBuildsDir();
  await fs.writeFile(BUILDS_INDEX, JSON.stringify(entries, null, 2), 'utf8');
}

export async function listStoredBuilds(): Promise<StoredBuildMeta[]> {
  return readIndex();
}

/** Returns the build whose bbox center is closest to the given position, or null if none exist. */
export async function findNearestBuild(
  pos: { x: number; y: number; z: number },
): Promise<StoredBuildMeta | null> {
  const all = await readIndex();
  let best: StoredBuildMeta | null = null;
  let bestDist = Infinity;
  for (const b of all) {
    const cx = b.origin.x;
    const cy = b.origin.y + b.height / 2;
    const cz = b.origin.z;
    const d = (cx - pos.x) ** 2 + (cy - pos.y) ** 2 + (cz - pos.z) ** 2;
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return best;
}

export async function loadBuildScript(buildId: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(BUILDS_DIR, buildId, 'latest.py'), 'utf8');
  } catch { return null; }
}

async function persistBuild(
  meta: StoredBuildMeta,
  script: string,
  schemSourcePath: string,
): Promise<void> {
  await ensureBuildsDir();
  const dir = path.join(BUILDS_DIR, meta.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'latest.py'), script, 'utf8');
  await fs.copyFile(schemSourcePath, path.join(dir, 'latest.schem'));
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const idx = await readIndex();
  const existing = idx.findIndex(e => e.id === meta.id);
  if (existing >= 0) idx[existing] = meta; else idx.push(meta);
  await writeIndex(idx);
}

export interface BuildPassEvent {
  pass: number;
  totalPasses: number;
  label: string;
  build: GeneratedBuild;
  isFinal: boolean;
}

export async function buildFromPrompt(
  userPrompt: string,
  log: (msg: string) => void,
  onPass?: (event: BuildPassEvent) => Promise<void> | void,
  persistAt?: { origin: { x: number; y: number; z: number; rotation: 0 | 90 | 180 | 270 } },
): Promise<GeneratedBuild> {
  await ensureMcschematic(log);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-build-'));
  const schemName = 'out';

  // Three-pass refinement: massing → depth → polish. Each pass compiles,
  // runs, and renders so the player sees the structure evolve. Low thinking
  // budget keeps each call fast — quality accrues across passes.
  const turns: GeminiTurn[] = [];
  let script = '';
  let finalBuild: GeneratedBuild | null = null;
  let finalScript = '';
  let finalSchemPath = '';
  const totalPasses = PASS_PROMPTS.length;

  for (let pass = 0; pass < totalPasses; pass++) {
    const { label, instruction, model, thinkingBudget } = PASS_PROMPTS[pass];
    const isFinal = pass === totalPasses - 1;
    log(`[gemini-build] pass ${pass + 1}/${totalPasses} (${label}) via ${model}...`);
    if (pass === 0) {
      turns.push({ role: 'user', text: `${instruction}\n\nUser request: ${userPrompt}` });
    } else {
      turns.push({ role: 'model', text: script });
      turns.push({ role: 'user', text: `${instruction}\n\nOriginal user request: ${userPrompt}\n\nOutput the COMPLETE updated script (Python only, no markdown fences). Do not truncate.` });
    }
    script = await callGemini(turns, { model, thinkingBudget });

    // Per-pass scratch dir so intermediate schems don't collide.
    const passDir = path.join(tmpDir, `pass${pass}`);
    await fs.mkdir(passDir, { recursive: true });
    const scriptPath = path.join(passDir, 'build.py');
    const schemPath = path.join(passDir, `${schemName}.schem`);

    // Intermediate passes: best-effort. If syntax/run fails, skip the render
    // and keep going — the demo doesn't stall on a flaky middle pass.
    // Final pass: must succeed, so it gets the syntax-fix retry loop.
    let build: GeneratedBuild | null = null;
    try {
      if (isFinal) {
        const MAX_FIX_ATTEMPTS = 2;
        for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
          await fs.writeFile(scriptPath, script, 'utf8');
          const check = await runChild(VENV_PYTHON, ['-m', 'py_compile', scriptPath], log);
          if (check.code === 0) break;
          if (attempt === MAX_FIX_ATTEMPTS) {
            throw new Error(`Generated script has syntax errors after ${MAX_FIX_ATTEMPTS} fix attempts: ${check.stderr.slice(0, 400)}`);
          }
          log(`[gemini-build] syntax error, asking Gemini to fix (attempt ${attempt + 1})...`);
          turns.push({ role: 'model', text: script });
          turns.push({ role: 'user', text: `Your script has a Python syntax error. Fix it and output the COMPLETE corrected script (no markdown fences, Python only). Make sure the script is not truncated.\n\nError:\n${check.stderr.slice(0, 800)}` });
          script = await callGemini(turns, { model, thinkingBudget });
        }
      } else {
        await fs.writeFile(scriptPath, script, 'utf8');
        const check = await runChild(VENV_PYTHON, ['-m', 'py_compile', scriptPath], log);
        if (check.code !== 0) {
          log(`[gemini-build] pass ${pass + 1} script has syntax errors, skipping render`);
          continue;
        }
      }

      const run = await runChild(VENV_PYTHON, [scriptPath, passDir, schemName], log);
      if (run.code !== 0) {
        if (isFinal) throw new Error(`Build script failed (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
        log(`[gemini-build] pass ${pass + 1} script failed at runtime, skipping render`);
        continue;
      }
      try { await fs.access(schemPath); } catch {
        if (isFinal) throw new Error(`Build script ran but no .schem produced at ${schemPath}`);
        continue;
      }

      build = await parseSchem(schemPath);
      build.description = userPrompt.slice(0, 60);
      log(`[gemini-build] pass ${pass + 1} parsed: ${build.blocks.length} blocks, ${build.width}×${build.height}×${build.height}`);
    } catch (err) {
      if (isFinal) throw err;
      log(`[gemini-build] pass ${pass + 1} errored, skipping render: ${(err as Error).message}`);
      continue;
    }

    if (build) {
      if (isFinal) {
        finalBuild = build;
        finalScript = script;
        finalSchemPath = schemPath;
      }
      if (onPass) {
        try { await onPass({ pass, totalPasses, label, build, isFinal }); }
        catch (err) { log(`[gemini-build] onPass handler threw: ${(err as Error).message}`); }
      }
    }
  }

  if (!finalBuild) throw new Error('All build passes failed');

  finalBuild.script = finalScript;

  if (persistAt) {
    const id = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const meta: StoredBuildMeta = {
      id,
      description: finalBuild.description,
      origin: persistAt.origin,
      width: finalBuild.width,
      height: finalBuild.height,
      length: finalBuild.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [{ prompt: userPrompt, ts: Date.now(), kind: 'create' }],
    };
    try {
      await persistBuild(meta, finalScript, finalSchemPath);
      finalBuild.buildId = id;
      log(`[gemini-build] persisted as ${id}`);
    } catch (err) {
      log(`[gemini-build] persist failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // best-effort cleanup
  fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  return finalBuild;
}

const EDIT_INSTRUCTION = [
  'EDIT PASS — modify the EXISTING build script below.',
  '',
  'HARD RULES:',
  '1. The previous script defines the existing structure. Preserve every block NOT implicated by the user\'s edit.',
  '2. Apply ONLY what the user asked for. Do not redesign, re-theme, or "improve" unrelated areas.',
  '3. Keep the same coordinate system: min corner at (0,0,0). Do not translate the build.',
  '4. If the edit adds something (e.g. "add a balcony"), extend the existing geometry — don\'t replace it.',
  '5. If the edit removes/swaps something, only touch the specific blocks implicated.',
  '',
  'OUTPUT: the COMPLETE updated Python script (self-contained, re-places the full build with the edit applied). Python only, no markdown fences, do not truncate.',
].join('\n');

/**
 * Edit a previously persisted build. Generates a new script via Gemini using
 * the prior script as context, runs it, parses the resulting .schem, and
 * updates the stored build in place.
 */
export async function editFromPrompt(
  buildId: string,
  editPrompt: string,
  log: (msg: string) => void,
  onResult?: (event: BuildPassEvent) => Promise<void> | void,
): Promise<GeneratedBuild> {
  await ensureMcschematic(log);

  const prevScript = await loadBuildScript(buildId);
  if (!prevScript) throw new Error(`No stored script for build ${buildId}`);
  const idx = await readIndex();
  const prevMeta = idx.find(e => e.id === buildId);
  if (!prevMeta) throw new Error(`No stored meta for build ${buildId}`);

  log(`[gemini-edit] editing ${buildId}: "${editPrompt}"`);

  const turns: GeminiTurn[] = [
    { role: 'user', text: `Original build description: ${prevMeta.description}\n\nHere is the current build script:` },
    { role: 'model', text: prevScript },
    { role: 'user', text: `${EDIT_INSTRUCTION}\n\nUser edit: ${editPrompt}` },
  ];

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-edit-'));
  const schemName = 'out';
  const scriptPath = path.join(tmpDir, 'build.py');
  const schemPath = path.join(tmpDir, `${schemName}.schem`);

  let script = await callGemini(turns, { model: PRO_MODEL, thinkingBudget: 2048 });

  const MAX_FIX_ATTEMPTS = 2;
  for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    await fs.writeFile(scriptPath, script, 'utf8');
    const check = await runChild(VENV_PYTHON, ['-m', 'py_compile', scriptPath], log);
    if (check.code === 0) break;
    if (attempt === MAX_FIX_ATTEMPTS) {
      throw new Error(`Edit script has syntax errors after ${MAX_FIX_ATTEMPTS} fix attempts: ${check.stderr.slice(0, 400)}`);
    }
    log(`[gemini-edit] syntax error, asking Gemini to fix (attempt ${attempt + 1})...`);
    turns.push({ role: 'model', text: script });
    turns.push({ role: 'user', text: `Your script has a Python syntax error. Fix it and output the COMPLETE corrected script (no markdown fences, Python only). Make sure the script is not truncated.\n\nError:\n${check.stderr.slice(0, 800)}` });
    script = await callGemini(turns, { model: PRO_MODEL, thinkingBudget: 2048 });
  }

  const run = await runChild(VENV_PYTHON, [scriptPath, tmpDir, schemName], log);
  if (run.code !== 0) throw new Error(`Edit script failed (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
  try { await fs.access(schemPath); } catch { throw new Error(`Edit script ran but no .schem produced at ${schemPath}`); }

  const build = await parseSchem(schemPath);
  build.description = prevMeta.description;
  build.script = script;
  build.buildId = buildId;
  log(`[gemini-edit] parsed: ${build.blocks.length} blocks, ${build.width}×${build.height}×${build.length}`);

  const updatedMeta: StoredBuildMeta = {
    ...prevMeta,
    width: build.width,
    height: build.height,
    length: build.length,
    updatedAt: Date.now(),
    history: [...prevMeta.history, { prompt: editPrompt, ts: Date.now(), kind: 'edit' }],
  };
  try {
    await persistBuild(updatedMeta, script, schemPath);
    log(`[gemini-edit] updated stored build ${buildId}`);
  } catch (err) {
    log(`[gemini-edit] persist failed (non-fatal): ${(err as Error).message}`);
  }

  if (onResult) {
    try { await onResult({ pass: 0, totalPasses: 1, label: 'edit', build, isFinal: true }); }
    catch (err) { log(`[gemini-edit] onResult handler threw: ${(err as Error).message}`); }
  }

  fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  return build;
}
