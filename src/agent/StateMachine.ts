import type { Bot } from 'mineflayer';
import { MemoryManager } from './MemoryManager';

export class StateMachine {
  private tickInterval: NodeJS.Timeout | null = null;
  private lastHealthWarn = 0;
  private isThinking = false;
  private tickCount = 0;

  constructor(
    private bot: Bot,
    private memoryManager: MemoryManager,
    private log: (msg: string) => void,
    private executeTool: (name: string, args: Record<string, unknown>) => Promise<string>
  ) {}

  public start(): void {
    if (this.tickInterval) return;
    this.log('[state-machine] Starting autonomous heartbeat (2000ms)');
    this.tickInterval = setInterval(() => this.tick(), 2000);
  }

  public stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      this.log('[state-machine] Stopped autonomous heartbeat');
    }
  }

  private async tick(): Promise<void> {
    if (this.isThinking || !this.bot.entity) return;
    this.isThinking = true;
    this.tickCount++;

    try {
      await this.runSurvivalChecks();
    } catch (err) {
      this.log(`[state-machine] Tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isThinking = false;
    }
  }

  private async runSurvivalChecks(): Promise<void> {
    const health = this.bot.health ?? 20;
    const food = this.bot.food ?? 20;

    // 1. Check hunger
    if (food <= 16) {
      // Find food in inventory
      const foodItems = this.bot.inventory.items().filter(i => i.name.includes('apple') || i.name.includes('bread') || i.name.includes('cooked') || i.name.includes('beef') || i.name.includes('porkchop') || i.name.includes('mutton') || i.name.includes('chicken'));
      if (foodItems.length > 0) {
        this.log(`[state-machine] Hunger low (${food}/20), auto-eating`);
        // We can execute the existing 'eat' tool logic if it exists, or handle it directly
        // For now, we will call a fast-path executeTool
        await this.executeTool('eat', {}); 
      }
    }

    // 2. Check health and danger
    if (health < 10) {
      const now = Date.now();
      if (now - this.lastHealthWarn > 5000) {
        this.log(`[state-machine] Health critical (${health}/20)`);
        this.lastHealthWarn = now;
        
        // Escape danger logic (hardcoded fast-path)
        await this.executeTool('escape_danger', {});
      }
    }
  }
}
