import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { assignCrewWork, BuilderCrewSession, makeCrewUsername } from './builderCrew';
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

test('crew session places assigned blocks and quits helpers', async () => {
  const helperChats: string[] = [];
  const commandChats: string[] = [];
  const quits: string[] = [];

  const session = new BuilderCrewSession({
    host: 'localhost',
    port: 25565,
    auth: 'offline',
    mainUsername: 'companion',
    crewSize: 2,
    frameDelayMs: 0,
    splitDelayMs: 0,
    mergeDelayMs: 0,
    commandBot: {
      chat: (msg: string) => commandChats.push(`main:${msg}`),
    },
    createBot: (options) => {
      const bot = new EventEmitter() as any;
      bot.username = options.username;
      bot.chat = (msg: string) => helperChats.push(`${options.username}:${msg}`);
      bot.quit = () => quits.push(options.username);
      queueMicrotask(() => bot.emit('spawn'));
      return bot;
    },
  });

  await session.run([
    { x: 0, y: 64, z: 0, block: 'minecraft:stone' },
    { x: 8, y: 64, z: 0, block: 'minecraft:glass' },
  ], () => {}, { x: 100, y: 65, z: 100 });

  assert.deepEqual(helperChats, []);
  assert.ok(commandChats.includes('main:/tp companion_b1 100.00 65.00 100.00'));
  assert.ok(commandChats.includes('main:/tp companion_b2 100.00 65.00 100.00'));
  assert.ok(commandChats.includes('main:/tp companion_b1 102.50 65.00 100.00'));
  assert.ok(commandChats.includes('main:/tp companion_b2 97.50 65.00 100.00'));
  assert.ok(commandChats.some(line => line.includes('/setblock 0 64 0 minecraft:stone')));
  assert.ok(commandChats.some(line => line.includes('/setblock 8 64 0 minecraft:glass')));
  assert.equal(commandChats.filter(line => line.endsWith('/tp companion_b1 100.00 65.00 100.00')).length, 2);
  assert.equal(commandChats.filter(line => line.endsWith('/tp companion_b2 100.00 65.00 100.00')).length, 2);
  assert.deepEqual(quits.sort(), ['companion_b1', 'companion_b2']);
});
