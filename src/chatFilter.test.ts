import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIgnoredUsernames, shouldIgnoreChatSender } from './chatFilter';

test('parses comma-separated ignored usernames', () => {
  assert.deepEqual(parseIgnoredUsernames('botA, botB,, botC '), ['botA', 'botB', 'botC']);
});

test('ignores self username', () => {
  assert.equal(shouldIgnoreChatSender('Companion', 'companion'), true);
});

test('ignores configured bot usernames case-insensitively', () => {
  assert.equal(shouldIgnoreChatSender('HelperBot', 'companion', ['helperbot']), true);
});

test('does not ignore regular players', () => {
  assert.equal(shouldIgnoreChatSender('Steve', 'companion', ['helperbot']), false);
});
