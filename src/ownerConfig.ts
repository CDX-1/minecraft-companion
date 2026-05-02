import * as fs from 'node:fs';
import * as path from 'node:path';

const OWNER_MEMORY_PATH = path.join(process.cwd(), '.minecraft-companion-memory.json');

export function readOwnerUsernameFromMemory(): string | undefined {
  try {
    if (!fs.existsSync(OWNER_MEMORY_PATH)) return undefined;

    const raw = JSON.parse(fs.readFileSync(OWNER_MEMORY_PATH, 'utf8')) as { owner?: unknown };
    if (typeof raw.owner !== 'string') return undefined;

    const owner = raw.owner.trim();
    return owner.length ? owner : undefined;
  } catch {
    return undefined;
  }
}
