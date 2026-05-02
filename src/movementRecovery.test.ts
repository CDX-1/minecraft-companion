import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { createFiniteEntityStateRepair } from './movementRecovery';

test('repairs NaN entity position from the last finite position', () => {
  const calls: string[] = [];
  const bot = new EventEmitter() as any;
  bot.entity = {
    position: new Vec3(-262.671, 66, -417.819),
    velocity: new Vec3(0.07, -0.078, -0.065),
  };
  bot.clearControlStates = () => calls.push('clearControlStates');

  const repair = createFiniteEntityStateRepair(bot, () => {});
  repair('sample');

  bot.entity.position = new Vec3(Number.NaN, 66, Number.NaN);
  bot.entity.velocity = new Vec3(Number.NaN, -0.078, Number.NaN);

  assert.equal(repair('damage'), true);
  assert.deepEqual(
    [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z],
    [-262.671, 66, -417.819],
  );
  assert.deepEqual(
    [bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z],
    [0, 0, 0],
  );
  assert.deepEqual(calls, ['clearControlStates']);
});
