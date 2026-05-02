# Builder Crew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the solo hover-build animation with a temporary LAN helper-bot crew that builds near the structure using reliable `/setblock` placement.

**Architecture:** Keep the existing generated block list and diffing behavior in `BuildSession`. Add a `BuilderCrewSession` that can execute the already-computed block operations with short-lived helper Mineflayer bots, and make `BuildSession` choose crew mode when configured. If helpers fail to connect, fall back to the current main-bot replay path.

**Tech Stack:** TypeScript, Mineflayer, Node test runner, existing `BuildSession`/`MinecraftAgent` flow.

---

## Files

- Create `src/services/builderCrew.ts`: owns helper bot lifecycle, work splitting, helper choreography, `/setblock` execution, cancellation, cleanup.
- Create `src/services/builderCrew.test.ts`: unit tests for operation partitioning, username generation, fallback/cancel-safe cleanup behavior with fake bots.
- Modify `src/services/builder.ts`: expose transition operations to a pluggable executor and call `BuilderCrewSession` when enabled.
- Modify `src/config.ts`: add optional build crew config fields.
- Modify `src/index.ts`: read build crew options from env/prompt defaults.
- Modify `src/ui.ts`: pass connection config into `BuildSession` and log crew status.
- Modify `src/agent.ts`: construct `BuildSession` with crew options.

---

### Task 1: Extract Build Operation Planning

**Files:**
- Modify: `src/services/builder.ts`
- Test: `src/services/builder.test.ts`

- [ ] **Step 1: Write failing tests for operation planning**

Add `src/services/builder.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { planBuildTransition, type PlacedBuild } from './builder';

function build(blocks: PlacedBuild['blocks']): PlacedBuild {
  return {
    blocks,
    bounds: { min: { x: 0, y: 64, z: 0 }, max: { x: 2, y: 65, z: 2 } },
    origin: { x: 0, y: 64, z: 0, rotation: 0 },
    description: 'test',
    material: 'minecraft:stone',
  };
}

test('plans clears before places and skips unchanged blocks', () => {
  const oldBuild = build([
    { x: 0, y: 64, z: 0, block: 'minecraft:stone' },
    { x: 1, y: 64, z: 0, block: 'minecraft:dirt' },
  ]);
  const nextBuild = build([
    { x: 0, y: 64, z: 0, block: 'minecraft:stone' },
    { x: 2, y: 64, z: 0, block: 'minecraft:glass' },
  ]);

  assert.deepEqual(planBuildTransition(oldBuild, nextBuild), [
    { x: 1, y: 64, z: 0, block: 'minecraft:air' },
    { x: 2, y: 64, z: 0, block: 'minecraft:glass' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/builder.test.ts`

Expected: FAIL because `planBuildTransition` is not exported.

- [ ] **Step 3: Extract planner from `applyTransition`**

In `src/services/builder.ts`, add:

```ts
export type BuildOperation = BlockPlacement;

export function planBuildTransition(old: PlacedBuild | null, next: PlacedBuild | null): BuildOperation[] {
  const oldMap = new Map<string, BlockPlacement>();
  if (old) for (const b of old.blocks) oldMap.set(key(b), b);
  const nextMap = new Map<string, BlockPlacement>();
  if (next) for (const b of next.blocks) nextMap.set(key(b), b);

  const toClear: BlockPlacement[] = [];
  for (const [k, b] of oldMap) {
    const nb = nextMap.get(k);
    if (!nb || nb.block !== b.block) {
      if (!b.block.includes('air')) toClear.push({ x: b.x, y: b.y, z: b.z, block: 'minecraft:air' });
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
```

Replace the duplicated map/diff logic inside `applyTransition` with:

```ts
const ops = planBuildTransition(old, next);
```

- [ ] **Step 4: Verify**

Run: `npm test -- src/services/builder.test.ts`

Expected: PASS.

---

### Task 2: Add Crew Work Splitting

**Files:**
- Create: `src/services/builderCrew.ts`
- Test: `src/services/builderCrew.test.ts`

- [ ] **Step 1: Write failing tests for worker assignment**

Create `src/services/builderCrew.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { assignCrewWork, makeCrewUsername } from './builderCrew';
import type { BuildOperation } from './builder';

test('generates short stable LAN helper usernames', () => {
  assert.equal(makeCrewUsername('companion', 0), 'companion_b1');
  assert.equal(makeCrewUsername('very_long_companion_name', 2), 'very_long_b3');
});

test('assigns nearby operations to each worker by x/z columns', () => {
  const ops: BuildOperation[] = [
    { x: 0, y: 64, z: 0, block: 'minecraft:stone' },
    { x: 1, y: 64, z: 0, block: 'minecraft:stone' },
    { x: 20, y: 64, z: 0, block: 'minecraft:glass' },
    { x: 21, y: 64, z: 0, block: 'minecraft:glass' },
  ];

  const assignments = assignCrewWork(ops, 2);

  assert.equal(assignments.length, 2);
  assert.deepEqual(assignments[0].map(op => op.x), [0, 1]);
  assert.deepEqual(assignments[1].map(op => op.x), [20, 21]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/builderCrew.test.ts`

Expected: FAIL because `builderCrew.ts` does not exist.

- [ ] **Step 3: Implement pure helper functions**

Create `src/services/builderCrew.ts`:

```ts
import type { BuildOperation } from './builder';

export function makeCrewUsername(baseUsername: string, index: number): string {
  const safeBase = baseUsername.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 9) || 'builder';
  return `${safeBase}_b${index + 1}`.slice(0, 16);
}

export function assignCrewWork(ops: BuildOperation[], crewSize: number): BuildOperation[][] {
  const workers = Math.max(1, Math.floor(crewSize));
  const sorted = [...ops].sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
  const assignments = Array.from({ length: workers }, () => [] as BuildOperation[]);
  if (!sorted.length) return assignments;

  const chunkSize = Math.ceil(sorted.length / workers);
  for (let i = 0; i < sorted.length; i++) {
    assignments[Math.floor(i / chunkSize)]?.push(sorted[i]);
  }
  return assignments.filter(group => group.length > 0);
}
```

- [ ] **Step 4: Verify**

Run: `npm test -- src/services/builderCrew.test.ts`

Expected: PASS.

---

### Task 3: Implement BuilderCrewSession

**Files:**
- Modify: `src/services/builderCrew.ts`
- Test: `src/services/builderCrew.test.ts`

- [ ] **Step 1: Add tests for helper lifecycle with fake bot factory**

Append to `src/services/builderCrew.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { BuilderCrewSession } from './builderCrew';

test('crew session places assigned blocks and quits helpers', async () => {
  const chats: string[] = [];
  const quits: string[] = [];
  const fakeBots: EventEmitter[] = [];

  const session = new BuilderCrewSession({
    host: 'localhost',
    port: 25565,
    auth: 'offline',
    mainUsername: 'companion',
    crewSize: 2,
    createBot: (options) => {
      const bot = new EventEmitter() as any;
      bot.username = options.username;
      bot.chat = (msg: string) => chats.push(`${options.username}:${msg}`);
      bot.quit = () => quits.push(options.username);
      fakeBots.push(bot);
      queueMicrotask(() => bot.emit('spawn'));
      return bot;
    },
  });

  await session.run([
    { x: 0, y: 64, z: 0, block: 'minecraft:stone' },
    { x: 8, y: 64, z: 0, block: 'minecraft:glass' },
  ], () => {});

  assert.ok(chats.some(line => line.includes('/setblock 0 64 0 minecraft:stone')));
  assert.ok(chats.some(line => line.includes('/setblock 8 64 0 minecraft:glass')));
  assert.deepEqual(quits.sort(), ['companion_b1', 'companion_b2']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/builderCrew.test.ts`

Expected: FAIL because `BuilderCrewSession` is missing.

- [ ] **Step 3: Implement minimal crew session**

Extend `src/services/builderCrew.ts` with:

```ts
import { once } from 'node:events';
import mineflayer, { Bot } from 'mineflayer';

export interface BuilderCrewStatus {
  total: number;
  placed: number;
  helpers: string[];
}

export interface BuilderCrewOptions {
  host: string;
  port: number;
  auth: 'offline' | 'microsoft';
  mainUsername: string;
  crewSize: number;
  frameDelayMs?: number;
  createBot?: (options: { host: string; port: number; username: string; auth: 'offline' | 'microsoft' }) => Bot;
}

export class BuilderCrewSession {
  private cancelled = false;
  private helpers: Bot[] = [];

  constructor(private readonly opts: BuilderCrewOptions) {}

  cancel(): void {
    this.cancelled = true;
    for (const bot of this.helpers) bot.quit();
    this.helpers = [];
  }

  async run(ops: BuildOperation[], onProgress: (status: BuilderCrewStatus) => void): Promise<void> {
    this.cancelled = false;
    const createBot = this.opts.createBot ?? mineflayer.createBot;
    const assignments = assignCrewWork(ops, this.opts.crewSize);
    this.helpers = assignments.map((_, index) => createBot({
      host: this.opts.host,
      port: this.opts.port,
      username: makeCrewUsername(this.opts.mainUsername, index),
      auth: this.opts.auth,
    }));

    await Promise.all(this.helpers.map(bot => once(bot, 'spawn')));
    let placed = 0;
    onProgress({ total: ops.length, placed, helpers: this.helpers.map(bot => bot.username) });

    await Promise.all(assignments.map(async (group, index) => {
      const bot = this.helpers[index];
      if (!bot) return;
      bot.chat(`/gamemode creative ${bot.username}`);
      await wait(50);
      for (const op of group) {
        if (this.cancelled) return;
        bot.chat(`/tp ${bot.username} ${op.x} ${op.y + 3} ${op.z}`);
        bot.chat(`/setblock ${op.x} ${op.y} ${op.z} ${op.block}`);
        placed += 1;
        onProgress({ total: ops.length, placed, helpers: this.helpers.map(helper => helper.username) });
        await wait(this.opts.frameDelayMs ?? 35);
      }
    }));

    for (const bot of this.helpers) bot.quit();
    this.helpers = [];
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Verify**

Run: `npm test -- src/services/builderCrew.test.ts`

Expected: PASS.

---

### Task 4: Wire Crew Executor Into BuildSession

**Files:**
- Modify: `src/services/builder.ts`
- Test: `src/services/builder.test.ts`

- [ ] **Step 1: Write test that BuildSession uses an injected executor**

Append to `src/services/builder.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { BuildSession } from './builder';

test('BuildSession can execute transition ops through an injected executor', async () => {
  const bot = new EventEmitter() as any;
  bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 };
  bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' });
  bot.chat = () => {};

  const executed: string[] = [];
  const session = new BuildSession(bot, () => {}, {
    executor: async (ops) => {
      executed.push(...ops.map(op => `${op.x},${op.y},${op.z}:${op.block}`));
    },
  });

  await session.replay([
    { x: 0, y: 64, z: 0, block: 'minecraft:stone' },
  ], 'test build', { x: 0, y: 64, z: 0, rotation: 0 });

  assert.deepEqual(executed, ['0,64,0:minecraft:stone']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/builder.test.ts`

Expected: FAIL because `executor` is not accepted in `BuildSessionOptions`.

- [ ] **Step 3: Add executor hook**

In `src/services/builder.ts`, update `BuildSessionOptions`:

```ts
export type BuildOperationExecutor = (
  ops: BuildOperation[],
  onPlaced: (placed: number) => void,
) => Promise<void>;

export interface BuildSessionOptions {
  frameDelayMs?: number;
  blocksPerFrame?: number;
  flyAlong?: boolean;
  maxFoundationDrop?: number;
  executor?: BuildOperationExecutor;
}
```

In `applyTransition`, before the existing solo loop, branch:

```ts
if (this.opts.executor) {
  await this.opts.executor(ops, placed => {
    this.status.placed = placed;
    onProgress?.(this.getStatus());
  });
  this.status.phase = 'done';
  this.status.message = next ? `Built ${next.description}` : 'Demolished';
  onProgress?.(this.getStatus());
  return this.getStatus();
}
```

Make `opts` initialization preserve `executor`.

- [ ] **Step 4: Verify**

Run: `npm test -- src/services/builder.test.ts`

Expected: PASS.

---

### Task 5: Add Runtime Config and Fallback

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/ui.ts`
- Modify: `src/agent.ts`

- [ ] **Step 1: Add config fields**

In `src/config.ts`, add:

```ts
buildCrewEnabled: boolean;
buildCrewSize: number;
```

- [ ] **Step 2: Read env defaults**

In `src/index.ts`, add config values:

```ts
const envBuildCrewEnabled = process.env.BUILD_CREW_ENABLED
  ? process.env.BUILD_CREW_ENABLED === 'true'
  : true;
const envBuildCrewSize = Math.max(1, Math.min(8, Number(process.env.BUILD_CREW_SIZE) || 4));
```

Add prompts:

```ts
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
```

Normalize in `config`:

```ts
buildCrewEnabled: answers.buildCrewEnabled ?? envBuildCrewEnabled,
buildCrewSize: Math.max(1, Math.min(8, Number(answers.buildCrewSize) || envBuildCrewSize)),
```

- [ ] **Step 3: Pass crew executor into agent/build session**

Update `MinecraftAgentOptions` in `src/agent.ts`:

```ts
buildCrew?: {
  enabled: boolean;
  host: string;
  port: number;
  auth: 'offline' | 'microsoft';
  mainUsername: string;
  size: number;
};
```

When constructing `BuildSession`, if crew is enabled, create `BuilderCrewSession` and pass an executor:

```ts
const crew = resolvedOptions.buildCrew?.enabled
  ? new BuilderCrewSession({
      host: resolvedOptions.buildCrew.host,
      port: resolvedOptions.buildCrew.port,
      auth: resolvedOptions.buildCrew.auth,
      mainUsername: resolvedOptions.buildCrew.mainUsername,
      crewSize: resolvedOptions.buildCrew.size,
    })
  : null;

this.builder = new BuildSession(bot, log, crew ? {
  executor: async (ops, onPlaced) => {
    try {
      await crew.run(ops, status => onPlaced(status.placed));
    } catch (err) {
      log(`[build-crew] failed, falling back to solo builder: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  },
} : {});
```

If fallback must be automatic inside `BuildSession`, make the executor return `false` on failure and continue to solo loop. Prefer this behavior:

```ts
executor?: (...) => Promise<boolean>;
```

where `true` means handled and `false` means fallback.

- [ ] **Step 4: Pass UI config into agent**

In `src/ui.ts`, where `MinecraftAgent` is created, pass:

```ts
buildCrew: {
  enabled: config.buildCrewEnabled,
  host: config.host,
  port: config.port,
  auth: config.auth,
  mainUsername: config.username,
  size: config.buildCrewSize,
},
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test
npm run build
```

Expected: all tests pass and TypeScript compiles.

---

### Task 6: In-Game Acceptance Test

**Files:**
- No required source changes unless bugs are found.

- [ ] **Step 1: Start a LAN server with cheats enabled**

The main bot and helper bots need permission to use `/gamemode`, `/tp`, and `/setblock`. If the LAN world has cheats disabled, helper bots may join but placement will fail.

- [ ] **Step 2: Run the companion**

Run:

```bash
npm run dev
```

Choose:

```text
Use temporary helper bots for builds? yes
Build helper bot count: 4
Authentication: Offline
```

- [ ] **Step 3: Trigger a small build**

In Minecraft chat:

```text
build a 5 by 5 glass cube
```

Expected:
- helpers named like `companion_b1` join
- helpers teleport around the build area
- blocks appear from multiple nearby positions
- helpers quit after completion
- UI build status reaches `done`

- [ ] **Step 4: Test fallback**

Set `BUILD_CREW_SIZE=0` or run on a server that rejects duplicate helper logins.

Expected:
- UI logs the crew failure
- the existing solo builder still completes the structure

---

## Self-Review

- Spec coverage: covers temporary helpers, creative commands, nearby `/setblock`, cleanup, fallback, and tests.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `BuildOperation`, `BuildOperationExecutor`, `BuilderCrewSession`, and `BuilderCrewOptions` are consistently named across tasks.
