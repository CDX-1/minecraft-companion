import type { Bot } from 'mineflayer';
// vec3's default export is a factory function; we use it to satisfy mineflayer's Vec3 param type.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const makeVec3 = require('vec3') as (x: number, y: number, z: number) => unknown;

export interface BlockPlacement {
  x: number;
  y: number;
  z: number;
  block: string;
}

export interface Origin {
  x: number;
  y: number;
  z: number;
}

export interface Bounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface PlacedBuild {
  blocks: BlockPlacement[];
  bounds: Bounds;
  origin: Origin;
  description: string;
  material: string | null;
}

export interface PlayerContext {
  position?: { x: number; y: number; z: number };
  yaw?: number;
}

export type BuildPhase = 'idle' | 'building' | 'done' | 'cancelled' | 'error';

export interface BuildStatus {
  phase: BuildPhase;
  description: string;
  total: number;
  placed: number;
  origin: Origin | null;
  bounds: Bounds | null;
  material: string | null;
  type: string | null;
  message?: string;
}

export interface BuildSessionOptions {
  frameDelayMs?: number;
  blocksPerFrame?: number;
  flyAlong?: boolean;
  maxFoundationDrop?: number;
}

export class BuildSession {
  private current: PlacedBuild | null = null;
  private status: BuildStatus = emptyStatus();
  private buildAbort = false;
  private buildInFlight: Promise<BuildStatus> | null = null;
  private readonly opts: Required<BuildSessionOptions>;

  constructor(
    private bot: Bot,
    _log: (msg: string) => void,
    opts: BuildSessionOptions = {}
  ) {
    void _log;
    this.opts = {
      frameDelayMs: opts.frameDelayMs ?? 80,
      blocksPerFrame: opts.blocksPerFrame ?? 1,
      flyAlong: opts.flyAlong ?? true,
      maxFoundationDrop: opts.maxFoundationDrop ?? 24,
    };
    this.activeFrameDelayMs = this.opts.frameDelayMs;
  }
  private activeFrameDelayMs: number;

  getStatus(): BuildStatus { return { ...this.status }; }
  hasActive(): boolean { return this.current !== null; }
  /** Resolves once any in-flight build/transition has settled. */
  async awaitIdle(): Promise<void> {
    if (this.buildInFlight) { try { await this.buildInFlight; } catch { /* ignore */ } }
  }
  /** Adjust per-frame delay mid-render. Used to stretch pass 1 if pass 2 is slow. */
  setFrameDelay(ms: number): void {
    this.activeFrameDelayMs = Math.max(0, ms);
  }

  defaultOrigin(player?: PlayerContext): Origin {
    const p = player?.position ?? this.bot.entity?.position;
    const yaw = player?.yaw ?? this.bot.entity?.yaw ?? 0;
    if (!p) return { x: 0, y: 64, z: 0 };
    const dx = -Math.sin(yaw) * 8;
    const dz = -Math.cos(yaw) * 8;
    let originX = Math.round(p.x + dx);
    let originZ = Math.round(p.z + dz);
    let originY = Math.round(p.y);
    const surface = this.surfaceY(originX, originZ, originY);
    if (surface !== null) originY = surface + 1;
    return { x: originX, y: originY, z: originZ };
  }

  private surfaceY(x: number, z: number, startY: number): number | null {
    for (let y = startY + 8; y >= startY - 30; y--) {
      const block = this.bot.blockAt(makeVec3(x, y, z) as Parameters<Bot['blockAt']>[0]);
      if (!block) continue;
      if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air' || block.name.includes('water') || block.name.includes('lava')) continue;
      if ((block as { boundingBox?: string }).boundingBox === 'empty') continue;
      return y;
    }
    return null;
  }

  /** Place a precomputed list of blocks at the given origin and animate it. */
  async replay(
    blocks: BlockPlacement[],
    description: string,
    origin: Origin,
    onProgress?: (status: BuildStatus) => void,
  ): Promise<{ build: PlacedBuild; status: BuildStatus }> {
    if (!blocks.length) throw new Error('replay called with no blocks');
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of blocks) {
      if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y; if (b.z < minZ) minZ = b.z;
      if (b.x > maxX) maxX = b.x; if (b.y > maxY) maxY = b.y; if (b.z > maxZ) maxZ = b.z;
    }
    const built: PlacedBuild = {
      blocks,
      bounds: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
      origin,
      description,
      material: blocks[0]?.block ?? null,
    };
    const next = this.withTerrainFoundation(built);
    const status = await this.applyTransition(this.current, next, onProgress);
    return { build: next, status };
  }

  async demolish(onProgress?: (status: BuildStatus) => void): Promise<BuildStatus> {
    if (!this.current) {
      this.status = { ...emptyStatus(), phase: 'done', message: 'Nothing to demolish' };
      return this.status;
    }
    const status = await this.applyTransition(this.current, null, onProgress);
    this.current = null;
    return status;
  }

  cancelBuild(): void { this.buildAbort = true; }

  async setBlockAt(x: number, y: number, z: number, blockName: string): Promise<void> {
    this.bot.chat(`/setblock ${x} ${y} ${z} ${normalize(blockName)}`);
  }

  async fillRegion(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    blockName: string,
    hollow: boolean,
  ): Promise<number> {
    const block = normalize(blockName);
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (volume <= 32000) {
      const mode = hollow ? ' hollow' : '';
      this.bot.chat(`/fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} ${block}${mode}`);
      return volume;
    }
    let count = 0;
    const STEP = 16;
    for (let bx = minX; bx <= maxX; bx += STEP) {
      for (let by = minY; by <= maxY; by += STEP) {
        for (let bz = minZ; bz <= maxZ; bz += STEP) {
          const ex = Math.min(bx + STEP - 1, maxX);
          const ey = Math.min(by + STEP - 1, maxY);
          const ez = Math.min(bz + STEP - 1, maxZ);
          this.bot.chat(`/fill ${bx} ${by} ${bz} ${ex} ${ey} ${ez} ${block}`);
          count += (ex - bx + 1) * (ey - by + 1) * (ez - bz + 1);
          await wait(15);
        }
      }
    }
    return count;
  }

  async clearRegion(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): Promise<number> {
    return this.fillRegion(x1, y1, z1, x2, y2, z2, 'air', false);
  }

  private async applyTransition(
    old: PlacedBuild | null,
    next: PlacedBuild | null,
    onProgress?: (status: BuildStatus) => void,
  ): Promise<BuildStatus> {
    if (this.buildInFlight) {
      this.buildAbort = true;
      try { await this.buildInFlight; } catch { /* ignore */ }
    }

    const oldMap = new Map<string, BlockPlacement>();
    if (old) for (const b of old.blocks) oldMap.set(key(b), b);
    const nextMap = new Map<string, BlockPlacement>();
    if (next) for (const b of next.blocks) nextMap.set(key(b), b);

    const toClear: BlockPlacement[] = [];
    for (const [k, b] of oldMap) {
      const nb = nextMap.get(k);
      if (!nb || nb.block !== b.block) {
        if (!b.block.includes('air')) {
          toClear.push({ x: b.x, y: b.y, z: b.z, block: 'minecraft:air' });
        }
      }
    }
    const toPlace: BlockPlacement[] = [];
    for (const [k, b] of nextMap) {
      const ob = oldMap.get(k);
      if (!ob || ob.block !== b.block) toPlace.push(b);
    }

    toClear.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
    toPlace.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    const ops: BlockPlacement[] = [...toClear, ...toPlace];

    this.current = next;
    this.status = {
      phase: 'building',
      description: next?.description ?? (old ? `tearing down ${old.description}` : 'idle'),
      total: ops.length,
      placed: 0,
      origin: next?.origin ?? old?.origin ?? null,
      bounds: next?.bounds ?? old?.bounds ?? null,
      material: next?.material ?? null,
      type: null,
    };
    this.buildAbort = false;
    onProgress?.(this.getStatus());

    if (!ops.length) {
      this.status.phase = 'done';
      this.status.message = next ? 'No changes' : 'Cleared';
      onProgress?.(this.getStatus());
      return this.getStatus();
    }

    this.activeFrameDelayMs = this.opts.frameDelayMs;
    const run = (async (): Promise<BuildStatus> => {
      try {
        const { blocksPerFrame } = this.opts;
        const hoverY = (next?.bounds?.max.y ?? old?.bounds?.max.y ?? 64) + 4;
        let executed = 0;
        for (let i = 0; i < ops.length; i += blocksPerFrame) {
          if (this.buildAbort) {
            this.current = partialAfter(old, ops, executed, next);
            this.status.phase = 'cancelled';
            this.status.message = `Cancelled at ${executed}/${ops.length}`;
            onProgress?.(this.getStatus());
            return this.getStatus();
          }
          const end = Math.min(i + blocksPerFrame, ops.length);
          const frame = ops.slice(i, end);
          this.flyToFrame(frame, hoverY);
          for (const op of frame) {
            this.bot.chat(`/setblock ${op.x} ${op.y} ${op.z} ${op.block}`);
          }
          executed = end;
          this.status.placed = end;
          onProgress?.(this.getStatus());
          if (this.activeFrameDelayMs > 0 && end < ops.length) await wait(this.activeFrameDelayMs);
        }
        this.status.phase = 'done';
        this.status.message = next ? `Built ${next.description}` : 'Demolished';
        onProgress?.(this.getStatus());
        return this.getStatus();
      } catch (err) {
        this.status.phase = 'error';
        this.status.message = err instanceof Error ? err.message : String(err);
        onProgress?.(this.getStatus());
        return this.getStatus();
      } finally {
        this.buildInFlight = null;
      }
    })();

    this.buildInFlight = run;
    return run;
  }

  private withTerrainFoundation(bp: PlacedBuild): PlacedBuild {
    const colMin = new Map<string, number>();
    for (const b of bp.blocks) {
      if (b.block.includes('air')) continue;
      const k = `${b.x},${b.z}`;
      const cur = colMin.get(k);
      if (cur === undefined || b.y < cur) colMin.set(k, b.y);
    }

    const extras: BlockPlacement[] = [];
    const fill = bp.material ?? 'minecraft:stone';
    const cap = this.opts.maxFoundationDrop;

    for (const [k, y] of colMin) {
      const [xs, zs] = k.split(',');
      const x = +xs;
      const z = +zs;
      for (let dy = 1; dy <= cap; dy++) {
        const probeY = y - dy;
        const block = this.bot.blockAt(makeVec3(x, probeY, z) as Parameters<Bot['blockAt']>[0]);
        if (!block) break;
        const name = block.name;
        const empty =
          name === 'air' || name === 'cave_air' || name === 'void_air' ||
          name.includes('water') || name.includes('lava') ||
          name.includes('grass') || name.includes('flower') ||
          name.includes('snow') || name.includes('vine') ||
          (block as { boundingBox?: string }).boundingBox === 'empty';
        if (empty) extras.push({ x, y: probeY, z, block: fill });
        else break;
      }
    }

    if (!extras.length) return bp;
    const merged: BlockPlacement[] = [...bp.blocks, ...extras];
    const map = new Map<string, BlockPlacement>();
    for (const b of merged) map.set(`${b.x},${b.y},${b.z}`, b);
    return { ...bp, blocks: [...map.values()] };
  }

  private flyToFrame(frame: BlockPlacement[], hoverY: number): void {
    if (!this.opts.flyAlong || !frame.length) return;
    let sx = 0, sz = 0;
    for (const b of frame) { sx += b.x; sz += b.z; }
    const cx = sx / frame.length;
    const cz = sz / frame.length;
    const yaw = Math.atan2(-(cx - (this.bot.entity?.position.x ?? cx)), -(cz - (this.bot.entity?.position.z ?? cz))) * 180 / Math.PI;
    this.bot.chat(`/tp @s ${cx.toFixed(2)} ${hoverY} ${cz.toFixed(2)} ${yaw.toFixed(0)} 60`);
  }
}

function emptyStatus(): BuildStatus {
  return { phase: 'idle', description: '', total: 0, placed: 0, origin: null, bounds: null, material: null, type: null };
}
function key(b: { x: number; y: number; z: number }): string { return `${b.x},${b.y},${b.z}`; }
/**
 * Reconstruct the PlacedBuild state after only the first `executed` ops of a
 * cancelled transition have run. Starting from `old`, applies each executed op
 * (air = removal, anything else = set/replace). Result is what's actually on the
 * ground, so the NEXT transition diffs against reality, not the aborted target.
 */
function partialAfter(
  old: PlacedBuild | null,
  ops: BlockPlacement[],
  executed: number,
  next: PlacedBuild | null,
): PlacedBuild | null {
  const map = new Map<string, BlockPlacement>();
  if (old) for (const b of old.blocks) map.set(key(b), b);
  for (let i = 0; i < executed && i < ops.length; i++) {
    const op = ops[i];
    const k = key(op);
    if (op.block.includes('air')) map.delete(k);
    else map.set(k, op);
  }
  const blocks = [...map.values()];
  if (!blocks.length) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of blocks) {
    if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y; if (b.z < minZ) minZ = b.z;
    if (b.x > maxX) maxX = b.x; if (b.y > maxY) maxY = b.y; if (b.z > maxZ) maxZ = b.z;
  }
  const ref = next ?? old!;
  return {
    blocks,
    bounds: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
    origin: ref.origin,
    description: ref.description,
    material: ref.material,
  };
}
function wait(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function normalize(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.startsWith('minecraft:')) return trimmed;
  return `minecraft:${trimmed}`;
}
