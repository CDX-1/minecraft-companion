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

export type BuildOperation = BlockPlacement;

export interface Origin {
  x: number;
  y: number;
  z: number;
  /** Cardinal rotation (0/90/180/270 deg, CCW around Y) applied to the schem's local axes. */
  rotation?: 0 | 90 | 180 | 270;
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

export type BuildOperationExecutor = (
  ops: BuildOperation[],
  onPlaced: (placed: number) => void,
  context: { origin?: { x: number; y: number; z: number } },
) => Promise<boolean>;

export interface BuildSessionOptions {
  frameDelayMs?: number;
  blocksPerFrame?: number;
  flyAlong?: boolean;
  maxFoundationDrop?: number;
  executor?: BuildOperationExecutor;
}

type ResolvedBuildSessionOptions = Required<Omit<BuildSessionOptions, 'executor'>> & {
  executor?: BuildOperationExecutor;
};

export function planBuildTransition(old: PlacedBuild | null, next: PlacedBuild | null): BuildOperation[] {
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
  return [...toClear, ...toPlace];
}

export class BuildSession {
  private current: PlacedBuild | null = null;
  private status: BuildStatus = emptyStatus();
  private buildAbort = false;
  private buildInFlight: Promise<BuildStatus> | null = null;
  private freshSessionActive = false;
  private placedById: Map<string, PlacedBuild> = new Map();
  private readonly opts: ResolvedBuildSessionOptions;

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
      executor: opts.executor,
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
    if (!p) return { x: 0, y: 64, z: 0, rotation: 0 };
    const dx = -Math.sin(yaw) * 8;
    const dz = -Math.cos(yaw) * 8;
    const originX = Math.round(p.x + dx);
    const originZ = Math.round(p.z + dz);
    let originY = Math.round(p.y);
    const surface = this.surfaceY(originX, originZ, originY);
    if (surface !== null) originY = surface + 1;
    return { x: originX, y: originY, z: originZ, rotation: yawToRotation(yaw) };
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

  /**
   * Like replay(), but starts a fresh build: ignores `this.current` so an
   * unrelated prior build at a different origin isn't torn down. Successive
   * calls (iterative passes) still diff against each other.
   */
  async replayFresh(
    blocks: BlockPlacement[],
    description: string,
    origin: Origin,
    onProgress?: (status: BuildStatus) => void,
  ): Promise<{ build: PlacedBuild; status: BuildStatus }> {
    if (!blocks.length) throw new Error('replayFresh called with no blocks');
    if (!this.freshSessionActive) {
      this.current = null;
      this.freshSessionActive = true;
    }
    const result = await this.replay(blocks, description, origin, onProgress);
    return result;
  }

  /** Mark the fresh-build session as ended; the next replayFresh starts clean. */
  endFreshSession(): void {
    this.freshSessionActive = false;
  }

  /**
   * Edit a previously placed build identified by `id`. Diffs against the
   * stored placement for that id (not `this.current`), so editing build A
   * while build B is also on the ground won't tear down B.
   */
  async replayInto(
    id: string,
    blocks: BlockPlacement[],
    description: string,
    origin: Origin,
    onProgress?: (status: BuildStatus) => void,
  ): Promise<{ build: PlacedBuild; status: BuildStatus }> {
    if (!blocks.length) throw new Error('replayInto called with no blocks');
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
    const prior = this.placedById.get(id) ?? null;
    const status = await this.applyTransition(prior, next, onProgress, { updateCurrent: false });
    this.placedById.set(id, next);
    return { build: next, status };
  }

  /** Register a placed build under an id so future edits diff against it. */
  registerPlaced(id: string, build: PlacedBuild): void {
    this.placedById.set(id, build);
  }

  forgetPlaced(id: string): void {
    this.placedById.delete(id);
  }

  async demolish(onProgress?: (status: BuildStatus) => void): Promise<BuildStatus> {
    if (!this.current) {
      this.status = { ...emptyStatus(), phase: 'done', message: 'Nothing to demolish' };
      return this.status;
    }
    const status = await this.applyTransition(this.current, null, onProgress);
    this.current = null;
    this.freshSessionActive = false;
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
    opts?: { updateCurrent?: boolean },
  ): Promise<BuildStatus> {
    const updateCurrent = opts?.updateCurrent ?? true;
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

    const terrainClear: BlockPlacement[] = [];
    for (const b of toPlace) {
      if (b.block.includes('air')) continue;
      const k = key(b);
      if (oldMap.has(k)) continue; // already handled by toClear
      const existing = this.bot.blockAt(makeVec3(b.x, b.y, b.z) as Parameters<Bot['blockAt']>[0]);
      if (!existing) continue;
      const name = existing.name;
      if (name === 'air' || name === 'cave_air' || name === 'void_air') continue;
      if ((existing as { boundingBox?: string }).boundingBox === 'empty') continue;
      terrainClear.push({ x: b.x, y: b.y, z: b.z, block: 'minecraft:air' });
    }

    toClear.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
    terrainClear.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
    toPlace.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    const ops: BlockPlacement[] = [...toClear, ...terrainClear, ...toPlace];

    if (updateCurrent) this.current = next;
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
        if (this.opts.executor) {
          const handled = await this.opts.executor(
            ops,
            placed => {
              this.status.placed = Math.max(0, Math.min(ops.length, placed));
              onProgress?.(this.getStatus());
            },
            { origin: this.bot.entity?.position },
          );
          if (handled) {
            this.status.placed = ops.length;
            this.status.phase = 'done';
            this.status.message = next ? `Built ${next.description}` : 'Demolished';
            onProgress?.(this.getStatus());
            return this.getStatus();
          }
        }

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

/**
 * Snap a yaw (radians) to the nearest cardinal rotation (CCW around Y) so the
 * schem's local +Z ("front") points back toward the bot. Bot yaw=0 looks south
 * (+Z), so the origin sits at -Z relative to the bot — to make the schem's
 * +Z face the bot, the schem must be rotated 180°. Each 90° of bot yaw
 * subtracts 90° from that.
 */
function yawToRotation(yaw: number): 0 | 90 | 180 | 270 {
  const deg = ((yaw * 180 / Math.PI) % 360 + 360) % 360;
  const quad = Math.round(deg / 90) % 4;
  return ([180, 90, 0, 270] as const)[quad];
}

// CCW around +Y, matching the (x,z)→(-z,x) coord transform in agent.ts.
// One step of +90° maps a unit vector east(+X) → south(+Z), so cardinal
// facings cycle N → E → S → W → N per +90°.
const FACING_CYCLE = ['north', 'east', 'south', 'west'] as const;
const AXIS_SWAP: Record<string, string> = { x: 'z', z: 'x' };

/**
 * Rewrite a block string's directional state properties to match a CCW
 * rotation of `rot` degrees (0/90/180/270) around the Y axis.
 *
 * Handles: facing= (cardinal only — up/down untouched), axis= (x↔z when
 * rotation is odd quarter-turn), rotation= (0..15, each unit = 22.5°).
 *
 * Why: schem palette strings bake facings (e.g. oak_stairs[facing=north]).
 * If we rotate the build's coordinates without rewriting these, stairs and
 * doors point the wrong way.
 */
export function rotateBlockState(blockId: string, rot: 0 | 90 | 180 | 270): string {
  if (rot === 0) return blockId;
  const open = blockId.indexOf('[');
  if (open === -1) return blockId;
  const close = blockId.lastIndexOf(']');
  if (close === -1) return blockId;
  const head = blockId.slice(0, open);
  const inside = blockId.slice(open + 1, close);
  const steps = (rot / 90) | 0;

  const parts = inside.split(',').map(seg => {
    const eq = seg.indexOf('=');
    if (eq === -1) return seg;
    const key = seg.slice(0, eq).trim();
    const val = seg.slice(eq + 1).trim();
    if (key === 'facing') {
      const idx = FACING_CYCLE.indexOf(val as typeof FACING_CYCLE[number]);
      if (idx === -1) return seg; // up/down or unknown — leave alone
      return `${key}=${FACING_CYCLE[(idx + steps) % 4]}`;
    }
    if (key === 'axis' && (rot === 90 || rot === 270)) {
      const swapped = AXIS_SWAP[val];
      return swapped ? `${key}=${swapped}` : seg;
    }
    if (key === 'rotation') {
      const n = Number(val);
      if (!Number.isFinite(n)) return seg;
      // 16-step rotation: each cardinal step (90°) = 4 units.
      const next = (((n + steps * 4) % 16) + 16) % 16;
      return `${key}=${next}`;
    }
    return seg;
  });

  return `${head}[${parts.join(',')}]`;
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
