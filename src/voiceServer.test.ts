import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { renderVoicePage, shouldAcceptTranscript, startVoiceServer } from './voiceServer';

test('voice page waits for final recognition results to avoid duplicate commands', () => {
  const page = renderVoicePage();

  assert.match(page, /recognition\.interimResults = false/);
  assert.doesNotMatch(page, /maybeSendTranscript/);
});

test('voice page uses server push-to-talk events instead of browser keydown', () => {
  const page = renderVoicePage();

  assert.doesNotMatch(page, /PUSH_TO_TALK_KEY/);
  assert.doesNotMatch(page, /document\.addEventListener\('keydown'/);
  assert.doesNotMatch(page, /document\.addEventListener\('keyup'/);
  assert.match(page, /stopListening\(\)/);
});

test('voice page accepts global push-to-talk events from companion', () => {
  const page = renderVoicePage();

  assert.match(page, /new EventSource\('\/ptt-events'\)/);
  assert.match(page, /startListening\('global'\)/);
});

test('voice page buffers speech and sends one transcript after release', () => {
  const page = renderVoicePage();

  assert.match(page, /let speechBuffer = \[\]/);
  assert.match(page, /appendTranscript\(text\)/);
  assert.match(page, /flushBufferedTranscript\(\)/);
  assert.match(page, /setTimeout\(\(\) => \{/);
  assert.doesNotMatch(page, /await sendTranscript\(text\)/);
});

test('voice server suppresses duplicate transcripts inside cooldown window', () => {
  assert.equal(shouldAcceptTranscript('follow me', '', 0, 1000), true);
  assert.equal(shouldAcceptTranscript(' Follow   Me ', 'follow me', 1000, 2000), false);
  assert.equal(shouldAcceptTranscript('follow me', 'follow me', 1000, 5000), true);
});

test('voice server ignores blank transcripts', () => {
  assert.equal(shouldAcceptTranscript('   ', '', 0, 1000), false);
});

test('voice server only accepts transcripts while push-to-talk is active', async () => {
  const transcripts: string[] = [];
  const server = await startVoiceServer({
    port: 0,
    onTranscript: (text) => transcripts.push(text),
  });

  try {
    await post(`${server.url}/transcript`, { text: 'not holding v' });
    assert.deepEqual(transcripts, []);

    await post(`${server.url}/ptt/start`);
    await post(`${server.url}/transcript`, { text: 'holding v' });
    assert.deepEqual(transcripts, ['holding v']);

    await post(`${server.url}/ptt/stop`);
    await post(`${server.url}/transcript`, { text: 'released v' });
    assert.deepEqual(transcripts, ['holding v', 'released v']);

    await new Promise((resolve) => setTimeout(resolve, 1600));
    await post(`${server.url}/transcript`, { text: 'too late' });
    assert.deepEqual(transcripts, ['holding v', 'released v']);
  } finally {
    server.close();
  }
});

function post(url: string, payload?: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = http.request(url, {
      method: 'POST',
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      } : undefined,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end(body);
  });
}
