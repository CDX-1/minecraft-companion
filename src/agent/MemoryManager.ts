import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentMemory, StoredPosition } from './types';

export class MemoryManager {
  private readonly memoryPath = path.join(process.cwd(), '.minecraft-companion-memory.json');
  public memory: AgentMemory;
  public homePosition: { x: number; y: number; z: number } | null = null;
  public notes = new Map<string, string>();

  constructor(private log: (msg: string) => void) {
    this.memory = this.createEmptyMemory();
    this.loadMemory();
  }

  private createEmptyMemory(): AgentMemory {
    return {
      version: 1,
      knownChests: [],
      knownResources: [],
      avoidAreas: [],
      notes: {},
    };
  }

  public loadMemory(): void {
    try {
      if (!fs.existsSync(this.memoryPath)) {
        this.memory = this.createEmptyMemory();
        return;
      }

      const raw = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8')) as Partial<AgentMemory>;
      this.memory = {
        ...this.createEmptyMemory(),
        ...raw,
        version: 1,
        knownChests: Array.isArray(raw.knownChests) ? raw.knownChests : [],
        knownResources: Array.isArray(raw.knownResources) ? raw.knownResources : [],
        avoidAreas: Array.isArray(raw.avoidAreas) ? raw.avoidAreas : [],
        notes: raw.notes && typeof raw.notes === 'object' ? raw.notes : {},
      };
      if (this.memory.home) {
        this.homePosition = { x: this.memory.home.x, y: this.memory.home.y, z: this.memory.home.z };
      }
      this.notes = new Map(Object.entries(this.memory.notes));
    } catch (err) {
      this.log(`[memory] load failed: ${err instanceof Error ? err.message : String(err)}`);
      this.memory = this.createEmptyMemory();
    }
  }

  public saveMemory(): void {
    try {
      this.memory.notes = Object.fromEntries(this.notes.entries());
      fs.writeFileSync(this.memoryPath, JSON.stringify(this.memory, null, 2));
    } catch (err) {
      this.log(`[memory] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public addNote(label: string, content: string): void {
    this.notes.set(label, content);
    this.saveMemory();
  }

  public getNote(label: string): string | undefined {
    return this.notes.get(label);
  }

  public getAllNotes(): Record<string, string> {
    return Object.fromEntries(this.notes.entries());
  }
}
