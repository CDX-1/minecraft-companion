import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryManager } from './MemoryManager';
import { StateMachine } from './StateMachine';

test('survival interruption records progress on active task', async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-'));
  process.chdir(tempDir);
  try {
    const memory = new MemoryManager(() => undefined);
    memory.memory.activeTask = {
      goal: 'craft pickaxe',
      plan: ['gather logs', 'craft pickaxe'],
      progress: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const calls: string[] = [];
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      health: 6,
      food: 20,
      inventory: { items: () => [] },
    };
    const machine = new StateMachine(bot as any, memory, () => undefined, async (name) => {
      calls.push(name);
      return 'escaped';
    });

    await (machine as any).runSurvivalChecks();

    assert.deepEqual(calls, ['escape_danger']);
    assert.match(memory.memory.activeTask.progress.join(' | '), /Interrupted by survival check/);
    assert.match(memory.memory.activeTask.progress.join(' | '), /resume previous goal/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
