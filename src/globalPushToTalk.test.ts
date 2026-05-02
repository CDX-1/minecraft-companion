import assert from 'node:assert/strict';
import test from 'node:test';
import { isPushToTalkKey } from './globalPushToTalk';

test('detects V as push-to-talk key', () => {
  assert.equal(isPushToTalkKey({ name: 'V' }, 'V'), true);
  assert.equal(isPushToTalkKey({ name: 'A' }, 'V'), false);
});

test('detects raw V key names from global listener', () => {
  assert.equal(isPushToTalkKey({ rawKey: { _nameRaw: 'v', name: 'v' } }, 'V'), true);
});
