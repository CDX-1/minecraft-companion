import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BuildSession, planBuildTransition, type PlacedBuild } from './builder';

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

test('BuildSession can execute transition ops through an injected executor', async () => {
  const bot = new EventEmitter() as any;
  bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 };
  bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' });
  bot.chat = () => {};

  const executed: string[] = [];
  const session = new BuildSession(bot, () => {}, {
    executor: async (ops, onPlaced) => {
      executed.push(...ops.map(op => `${op.x},${op.y},${op.z}:${op.block}`));
      onPlaced(ops.length);
      return true;
    },
  });

  await session.replay([
    { x: 0, y: 64, z: 0, block: 'minecraft:stone' },
  ], 'test build', { x: 0, y: 64, z: 0, rotation: 0 });

  assert.deepEqual(executed, ['0,64,0:minecraft:stone']);
});
