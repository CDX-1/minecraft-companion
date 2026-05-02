import assert from 'node:assert/strict';
import test from 'node:test';
import { handleVoiceTranscript } from './voiceCommands';

test('runs greeting command from voice transcript', () => {
  const events: string[] = [];

  const handled = handleVoiceTranscript('hey companion', {
    characterName: 'companion',
    ownerUsername: 'Steve',
    sayHello: () => events.push('hello'),
    follow: (username) => events.push(`follow:${username}`),
  });

  assert.equal(handled, true);
  assert.deepEqual(events, ['hello']);
});

test('runs follow command against configured owner from voice transcript', () => {
  const events: string[] = [];

  const handled = handleVoiceTranscript('follow me', {
    characterName: 'companion',
    ownerUsername: 'Steve',
    sayHello: () => events.push('hello'),
    follow: (username) => events.push(`follow:${username}`),
  });

  assert.equal(handled, true);
  assert.deepEqual(events, ['follow:Steve']);
});

test('does not run follow command without an owner username', () => {
  const events: string[] = [];

  const handled = handleVoiceTranscript('follow me', {
    characterName: 'companion',
    sayHello: () => events.push('hello'),
    follow: (username) => events.push(`follow:${username}`),
  });

  assert.equal(handled, false);
  assert.deepEqual(events, []);
});
