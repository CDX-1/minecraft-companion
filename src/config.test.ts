import assert from 'node:assert/strict';
import test from 'node:test';
import { isVoiceEnabledFromEnv } from './config';

test('voice input is enabled by default and can be explicitly disabled', () => {
  assert.equal(isVoiceEnabledFromEnv(undefined), true);
  assert.equal(isVoiceEnabledFromEnv(''), true);
  assert.equal(isVoiceEnabledFromEnv('true'), true);
  assert.equal(isVoiceEnabledFromEnv('false'), false);
});
