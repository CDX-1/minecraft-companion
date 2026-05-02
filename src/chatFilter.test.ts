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

test('ignores every other player when an owner username is configured', () => {
  assert.equal(shouldIgnoreChatSender('Alex', 'companion', [], 'Steve'), true);
});

test('allows only the configured owner when owner filtering is enabled', () => {
  assert.equal(shouldIgnoreChatSender('Steve', 'companion', ['helperbot'], 'Steve'), false);
});

test('does not ignore regular players', () => {
  assert.equal(shouldIgnoreChatSender('Steve', 'companion', ['helperbot']), false);
});
