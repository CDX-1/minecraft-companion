import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { MinecraftAgent } from './agent';

function createAgentHarness() {
  const calls: string[] = [];
  const bot = new EventEmitter() as any;
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'overworld' };
  bot.players = {
    Steve: { entity: { position: new Vec3(10, 64, 0) } },
  };
  bot.pathfinder = {
    setMovements: () => calls.push('setMovements'),
    setGoal: () => calls.push('setGoal'),
    stop: () => calls.push('stop'),
  };
  bot.clearControlStates = () => calls.push('clearControlStates');

  const agent = new MinecraftAgent(
    bot,
    { provider: 'gemini', apiKey: 'test' },
    () => {},
    () => {},
  );
  (agent as any).movements = {};

  return { agent: agent as any, calls };
}

test('damage recovery clears stale movement controls before resuming follow', () => {
  const { agent, calls } = createAgentHarness();
  agent.activeFollowGoal = { username: 'Steve', range: 2 };

  agent.recoverMovementAfterDamage();

  assert.deepEqual(calls, ['clearControlStates', 'setMovements', 'setGoal']);
});

test('follow command can recover movement while agent is busy', async () => {
  const { agent, calls } = createAgentHarness();
  agent.isThinking = true;

  const response = await agent.handleMessage('follow me', 'Steve');

  assert.equal(response, 'Following you!');
  assert.deepEqual(calls, ['setMovements', 'setGoal']);
});

test('stop command can interrupt movement while agent is busy', async () => {
  const { agent, calls } = createAgentHarness();
  agent.isThinking = true;
  agent.activeNavigationGoal = { id: 1, x: 10, y: 64, z: 0, range: 2 };

  const response = await agent.handleMessage('stop', 'Steve');

  assert.equal(response, 'Stopped.');
  assert.equal(agent.activeNavigationGoal, null);
  assert.deepEqual(calls, ['stop', 'clearControlStates']);
});
