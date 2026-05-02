import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryManager } from './MemoryManager';

test('stores and retrieves relevant lessons learned', () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-memory-'));
  process.chdir(tempDir);
  try {
    const manager = new MemoryManager(() => undefined);

    manager.addLesson('digging', 'Never dig straight down near lava.');
    manager.addLesson('crafting', 'Check dependency_plan before crafting from scratch.');

    assert.deepEqual(manager.getRelevantLessons('craft a pickaxe from scratch'), [
      'Check dependency_plan before crafting from scratch.',
    ]);
    assert.deepEqual(manager.getRelevantLessons('lava mining', 1), [
      'Never dig straight down near lava.',
    ]);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
