import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerSafeMovements } from './pathfinderMovements';

test('server-safe movements disable parkour and sprinting for reliable remote pathing', () => {
  const movements = createServerSafeMovements({
    registry: require('minecraft-data')('1.20.4'),
  } as any);

  assert.equal(movements.allowParkour, false);
  assert.equal(movements.allowSprinting, false);
});
