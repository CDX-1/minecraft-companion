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
}

const SYSTEM_PYTHON = process.env.VENV_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// Per-project virtualenv. Lives at <repo>/.pybuild and is created on first build
// for every dev. Keeps mcschematic out of system site-packages so we never fight
// with locked .exe shims or admin-owned Python installs.
const VENV_DIR = path.resolve(process.cwd(), '.pybuild');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');

const SYSTEM_INSTRUCTION = `Output a runnable Python script using \`mcschematic\` that builds the requested structure (min corner at 0,0,0) and saves it via .save(sys.argv[1], sys.argv[2], mcschematic.Version.JE_1_20_1). Python only, no markdown fences.`;

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in environment');
  return key;
}

type GeminiTurn = { role: 'user' | 'model'; text: string };

async function callGemini(turns: GeminiTurn[]): Promise<string> {
  const apiKey = getApiKey();
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: turns.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 24576,
      thinkingConfig: { thinkingBudget: 2000 },
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

export async function buildFromPrompt(userPrompt: string, log: (msg: string) => void): Promise<GeneratedBuild> {
  await ensureMcschematic(log);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-build-'));
  const scriptPath = path.join(tmpDir, 'build.py');
  const schemName = 'out';
  const schemPath = path.join(tmpDir, `${schemName}.schem`);

  log('[gemini-build] asking Gemini for build script...');
  const turns: GeminiTurn[] = [{ role: 'user', text: userPrompt }];
  let script = await callGemini(turns);

  // Syntax-check loop: Gemini occasionally truncates or emits bad Python.
  // Compile-check first; on failure, hand the error back and ask for a fix.
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
    script = await callGemini(turns);
  }

  log('[gemini-build] running generated script...');
  const run = await runChild(VENV_PYTHON, [scriptPath, tmpDir, schemName], log);
  if (run.code !== 0) {
    throw new Error(`Build script failed (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
  }
  try { await fs.access(schemPath); }
  catch { throw new Error(`Build script ran but no .schem produced at ${schemPath}`); }

  const result = await parseSchem(schemPath);
  result.description = userPrompt.slice(0, 60);
  log(`[gemini-build] parsed schem: ${result.blocks.length} blocks, ${result.width}×${result.height}×${result.length}`);

  // best-effort cleanup
  fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  return result;
}
