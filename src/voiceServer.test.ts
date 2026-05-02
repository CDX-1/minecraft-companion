import assert from 'node:assert/strict';
import test from 'node:test';
import { renderVoicePage, shouldAcceptTranscript } from './voiceServer';

test('voice page waits for final recognition results to avoid duplicate commands', () => {
  const page = renderVoicePage();

  assert.match(page, /recognition\.interimResults = false/);
  assert.doesNotMatch(page, /maybeSendTranscript/);
});

test('voice server suppresses duplicate transcripts inside cooldown window', () => {
  assert.equal(shouldAcceptTranscript('follow me', '', 0, 1000), true);
  assert.equal(shouldAcceptTranscript(' Follow   Me ', 'follow me', 1000, 2000), false);
  assert.equal(shouldAcceptTranscript('follow me', 'follow me', 1000, 5000), true);
});

test('voice server ignores blank transcripts', () => {
  assert.equal(shouldAcceptTranscript('   ', '', 0, 1000), false);
});
