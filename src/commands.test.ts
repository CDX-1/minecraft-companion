import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatCommand } from './commands';

test('parses greeting commands', () => {
  assert.equal(parseChatCommand('hi'), 'greet');
  assert.equal(parseChatCommand('hello'), 'greet');
  assert.equal(parseChatCommand(' HI '), 'greet');
});

test('parses hey plus character name as a greeting command', () => {
  assert.equal(parseChatCommand('hey companion', 'companion'), 'greet');
  assert.equal(parseChatCommand(' Hey Companion ', 'companion'), 'greet');
});

test('parses follow command', () => {
  assert.equal(parseChatCommand('follow me'), 'follow');
  assert.equal(parseChatCommand(' Follow Me '), 'follow');
});

test('ignores unknown chat messages', () => {
  assert.equal(parseChatCommand('follow'), null);
  assert.equal(parseChatCommand('what is up'), null);
  assert.equal(parseChatCommand('hey can you do this', 'companion'), null);
  assert.equal(parseChatCommand('this is high priority', 'companion'), null);
});
