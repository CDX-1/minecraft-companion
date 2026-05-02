import mineflayer, { Bot } from 'mineflayer';
import type { BuildOperation } from './builder';

export interface BuilderCrewStatus {
  total: number;
  placed: number;
  helpers: string[];
}

export interface CrewPosition {
  x: number;
  y: number;
  z: number;
}

export interface BuilderCrewCreateBotOptions {
  host: string;
  port: number;
  username: string;
  auth: 'offline' | 'microsoft';
}

export interface BuilderCrewOptions {
  host: string;
  port: number;
  auth: 'offline' | 'microsoft';
  mainUsername: string;
  crewSize: number;
  version?: string;
  frameDelayMs?: number;
  splitDelayMs?: number;
  mergeDelayMs?: number;
  splitRadius?: number;
  spawnTimeoutMs?: number;
  log?: (message: string) => void;
  commandBot?: Pick<Bot, 'chat'>;
  createBot?: (options: BuilderCrewCreateBotOptions & { version?: string }) => Bot;
}

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

export function separateOpsPhases(ops: BuildOperation[]): { clears: BuildOperation[]; places: BuildOperation[] } {
  const clears = ops.filter(op => op.block === 'minecraft:air' || op.block.includes('air'));
  const places = ops.filter(op => !op.block.includes('air'));
  return { clears, places };
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

  async run(
    ops: BuildOperation[],
    onProgress: (status: BuilderCrewStatus) => void,
    origin?: CrewPosition,
  ): Promise<void> {
    this.cancelled = false;
    const createBot = this.opts.createBot ?? mineflayer.createBot;
    
    // Separate into two phases: clears first, then places
    const { clears, places } = separateOpsPhases(ops);
    const allPhases = [clears, places].filter(phase => phase.length > 0);
    
    const usernames = Array.from({ length: this.opts.crewSize }, (_, index) => 
      makeCrewUsername(this.opts.mainUsername, index)
    );
    this.helpers = usernames.map(username => createBot({
      host: this.opts.host,
      port: this.opts.port,
      username,
      auth: this.opts.auth,
      version: this.opts.version,
    }));

    try {
      await Promise.all(this.helpers.map((bot, index) => this.waitForSpawn(bot, usernames[index])));
      let totalProcessed = 0;
      this.opts.log?.(`[build-crew] helpers online: ${this.helpers.map(bot => bot.username).join(', ')}`);
      if (origin) await this.splitFromOrigin(origin);
      onProgress({ total: ops.length, placed: 0, helpers: this.helpers.map(bot => bot.username) });

      // Execute each phase sequentially to maintain order invariant
      for (const phase of allPhases) {
        const assignments = assignCrewWork(phase, this.opts.crewSize);
        let phaseProcessed = 0;

        await Promise.all(assignments.map(async (group, index) => {
          const bot = this.helpers[index];
          if (!bot) return;
          this.command(`/gamemode creative ${bot.username}`);
          await wait(50);
          for (const op of group) {
            if (this.cancelled) return;
            this.command(`/tp ${bot.username} ${formatCoord(op.x)} ${formatCoord(op.y + 3)} ${formatCoord(op.z)}`);
            this.command(`/setblock ${op.x} ${op.y} ${op.z} ${op.block}`);
            phaseProcessed += 1;
            onProgress({ 
              total: ops.length, 
              placed: totalProcessed + phaseProcessed, 
              helpers: this.helpers.map(helper => helper.username) 
            });
            await wait(this.opts.frameDelayMs ?? 35);
          }
        }));

        totalProcessed += phaseProcessed;
      }
    } finally {
      if (origin) await this.mergeToOrigin(origin);
      for (const bot of this.helpers) bot.quit();
      this.helpers = [];
    }
  }

  private async splitFromOrigin(origin: CrewPosition): Promise<void> {
    for (const bot of this.helpers) {
      this.command(`/tp ${bot.username} ${formatPosition(origin)}`);
    }
    await wait(this.opts.splitDelayMs ?? 250);

    const radius = this.opts.splitRadius ?? 2.5;
    this.helpers.forEach((bot, index) => {
      const split = splitPosition(origin, index, this.helpers.length, radius);
      this.command(`/tp ${bot.username} ${formatPosition(split)}`);
    });
    await wait(this.opts.splitDelayMs ?? 250);
  }

  private async mergeToOrigin(origin: CrewPosition): Promise<void> {
    for (const bot of this.helpers) {
      this.command(`/tp ${bot.username} ${formatPosition(origin)}`);
    }
    await wait(this.opts.mergeDelayMs ?? 300);
  }

  private command(message: string): void {
    this.opts.commandBot?.chat(message);
  }

  private async waitForSpawn(bot: Bot, expectedUsername: string): Promise<void> {
    const timeoutMs = this.opts.spawnTimeoutMs ?? 30000;
    const emitter = bot as unknown as NodeJS.EventEmitter;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        emitter.removeListener('spawn', onSpawn);
        emitter.removeListener('error', onError);
        emitter.removeListener('kicked', onKicked);
        emitter.removeListener('end', onEnd);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onKicked = (reason: string) => {
        cleanup();
        reject(new Error(`Helper ${expectedUsername} kicked: ${reason}`));
      };
      const onEnd = (reason: string) => {
        cleanup();
        reject(new Error(`Helper ${expectedUsername} ended: ${reason}`));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Helper ${expectedUsername} did not spawn within ${timeoutMs}ms`));
      }, timeoutMs);

      emitter.once('spawn', onSpawn);
      emitter.once('error', onError);
      emitter.once('kicked', onKicked);
      emitter.once('end', onEnd);
    });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitPosition(origin: CrewPosition, index: number, total: number, radius: number): CrewPosition {
  const angle = total <= 1 ? 0 : (Math.PI * 2 * index) / total;
  return {
    x: origin.x + Math.cos(angle) * radius,
    y: origin.y,
    z: origin.z + Math.sin(angle) * radius,
  };
}

function formatPosition(pos: CrewPosition): string {
  return `${formatCoord(pos.x)} ${formatCoord(pos.y)} ${formatCoord(pos.z)}`;
}

function formatCoord(value: number): string {
  return value.toFixed(2);
}
