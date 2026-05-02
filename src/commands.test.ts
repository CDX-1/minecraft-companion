import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatCommand } from './commands';

test('parses greeting commands', () => {
  assert.equal(parseChatCommand('hi'), 'greet');
  assert.equal(parseChatCommand('hello'), 'greet');
  assert.equal(parseChatCommand(' HI '), 'greet');
});

test('parses follow command', () => {
  assert.equal(parseChatCommand('follow me'), 'follow');
  assert.equal(parseChatCommand(' Follow Me '), 'follow');
});

test('ignores unknown chat messages', () => {
  assert.equal(parseChatCommand('follow'), null);
  assert.equal(parseChatCommand('what is up'), null);
});
