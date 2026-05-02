import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface VoiceServerOptions {
  port: number;
  onTranscript: (text: string) => void;
}

const TRANSCRIPT_COOLDOWN_MS = 3000;
const PUSH_TO_TALK_RELEASE_GRACE_MS = 1500;

export interface VoiceServer {
  url: string;
  setPushToTalkActive: (active: boolean) => void;
  close: () => void;
}

type PttClient = http.ServerResponse;

export function startVoiceServer(options: VoiceServerOptions): Promise<VoiceServer> {
  let lastTranscript = '';
  let lastTranscriptAt = 0;
  let pushToTalkActive = false;
  let pushToTalkStoppedAt = 0;
  const pttClients = new Set<PttClient>();

  function sendPushToTalkEvent(active: boolean) {
    pushToTalkActive = active;
    if (!active) pushToTalkStoppedAt = Date.now();
    const event = active ? 'start' : 'stop';
    for (const client of pttClients) {
      client.write(`event: ptt\n`);
      client.write(`data: ${JSON.stringify({ active, event })}\n\n`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderVoicePage());
      return;
    }

    if (req.method === 'GET' && req.url === '/ptt-events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('\n');
      res.write(`event: ptt\n`);
      res.write(`data: ${JSON.stringify({ active: pushToTalkActive, event: pushToTalkActive ? 'start' : 'stop' })}\n\n`);
      pttClients.add(res);
      req.on('close', () => {
        pttClients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && (req.url === '/ptt/start' || req.url === '/ptt/stop')) {
      sendPushToTalkEvent(req.url === '/ptt/start');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/transcript') {
      let body = '';

      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body) as { text?: unknown };
          const now = Date.now();
          const withinReleaseGrace = !pushToTalkActive && now - pushToTalkStoppedAt <= PUSH_TO_TALK_RELEASE_GRACE_MS;
          if (
            (pushToTalkActive || withinReleaseGrace) &&
            typeof payload.text === 'string' &&
            shouldAcceptTranscript(payload.text, lastTranscript, lastTranscriptAt, now)
          ) {
            lastTranscript = normalizeTranscript(payload.text);
            lastTranscriptAt = now;
            options.onTranscript(payload.text.trim());
          }
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Invalid JSON');
        }
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        setPushToTalkActive: sendPushToTalkEvent,
        close: () => {
          for (const client of pttClients) client.end();
          pttClients.clear();
          server.close();
        },
      });
    });
  });
}

export function normalizeTranscript(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function shouldAcceptTranscript(
  text: string,
  lastText: string,
  lastAcceptedAt: number,
  now: number
): boolean {
  const normalized = normalizeTranscript(text);
  if (!normalized) return false;
  return normalized !== lastText || now - lastAcceptedAt >= TRANSCRIPT_COOLDOWN_MS;
}

export function renderVoicePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Minecraft Companion Voice</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at top, #244d37, #0c1511 65%);
      color: #f1f5e9;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(720px, calc(100vw - 32px));
      padding: 32px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 24px;
      background: rgba(5, 12, 9, 0.74);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
    }
    h1 { margin: 0 0 8px; font-size: clamp(32px, 7vw, 64px); line-height: 0.95; }
    p { color: #cbd8c4; line-height: 1.6; }
    .hotkey {
      display: inline-grid;
      place-items: center;
      min-width: 44px;
      height: 36px;
      margin: 0 4px;
      border-radius: 10px;
      background: rgba(183, 255, 90, 0.14);
      border: 1px solid rgba(183, 255, 90, 0.48);
      color: #d9ff9b;
      font-weight: 900;
      letter-spacing: 0.08em;
    }
    button {
      margin: 20px 0;
      padding: 14px 20px;
      border: 0;
      border-radius: 999px;
      background: #b7ff5a;
      color: #11210d;
      font-size: 16px;
      font-weight: 800;
      cursor: pointer;
    }
    #status, #last {
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.08);
      overflow-wrap: anywhere;
    }
    code { color: #b7ff5a; }
  </style>
</head>
<body>
  <main>
    <h1>Voice Commands</h1>
    <p>Click the button once to allow microphone access. After that, hold <span class="hotkey">V</span> in Minecraft to talk and release it to stop.</p>
    <p>Say a full command while holding V. Companion sends everything heard as one command after you release V.</p>
    <button id="start">Hold to Talk</button>
    <p id="status">Idle</p>
    <p id="last">Last transcript: none</p>
  </main>
  <script>
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const startButton = document.querySelector('#start');
    const statusEl = document.querySelector('#status');
    const lastEl = document.querySelector('#last');

    if (!SpeechRecognition) {
      statusEl.textContent = 'Speech recognition is not supported here. Use Chrome or Edge.';
      startButton.disabled = true;
    } else {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = 'en-US';
      let shouldListen = false;
      let isListening = false;
      let allowTranscript = false;
      let activeSource = '';
      let speechBuffer = [];
      let releaseTimer = null;

      async function sendTranscript(text, { requireActive = true } = {}) {
        if (requireActive && (!allowTranscript || !shouldListen)) return;
        if (!text.trim()) return;
        lastEl.textContent = 'Last transcript: ' + text.trim();

        await fetch('/transcript', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim() }),
        });
      }

      function appendTranscript(text) {
        const clean = text.trim();
        if (!clean) return;
        speechBuffer.push(clean);
        lastEl.textContent = 'Hearing: ' + speechBuffer.join(' ');
      }

      function flushBufferedTranscript() {
        const combined = speechBuffer.join(' ').replace(/\\s+/g, ' ').trim();
        speechBuffer = [];
        if (!combined) {
          statusEl.textContent = 'Idle';
          return;
        }
        sendTranscript(combined, { requireActive: false }).finally(() => {
          statusEl.textContent = 'Sent command';
        });
      }

      function startListening(source) {
        if (isListening || shouldListen) return;
        if (releaseTimer) {
          clearTimeout(releaseTimer);
          releaseTimer = null;
        }
        speechBuffer = [];
        shouldListen = true;
        allowTranscript = true;
        activeSource = source;
        statusEl.textContent = source === 'button'
          ? 'Listening while button is held...'
          : 'Listening while V is held...';
        if (source !== 'global') {
          fetch('/ptt/start', { method: 'POST' }).catch(() => {});
        }
        try {
          recognition.start();
        } catch {
          shouldListen = false;
          allowTranscript = false;
          activeSource = '';
        }
      }

      function stopListening() {
        if (!shouldListen && !isListening) return;
        const source = activeSource;
        shouldListen = false;
        activeSource = '';
        statusEl.textContent = 'Processing...';
        if (source && source !== 'global') {
          fetch('/ptt/stop', { method: 'POST' }).catch(() => {});
        }
        try {
          recognition.stop();
        } catch {
          statusEl.textContent = 'Idle';
        }
        releaseTimer = setTimeout(() => {
          allowTranscript = false;
          flushBufferedTranscript();
          releaseTimer = null;
        }, 450);
      }

      recognition.onstart = () => {
        isListening = true;
        startButton.textContent = 'Listening';
        startButton.classList.add('active');
      };

      recognition.onresult = async (event) => {
        if (!allowTranscript) return;
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result.isFinal) continue;
          const text = result[0].transcript.trim();
          appendTranscript(text);
        }
      };

      recognition.onerror = (event) => {
        statusEl.textContent = 'Speech error: ' + event.error;
        shouldListen = false;
        allowTranscript = false;
        speechBuffer = [];
        isListening = false;
        startButton.textContent = 'Hold to Talk';
        startButton.classList.remove('active');
      };

      recognition.onend = () => {
        isListening = false;
        startButton.textContent = 'Hold to Talk';
        startButton.classList.remove('active');
        if (shouldListen) {
          recognition.start();
        } else if (!statusEl.textContent.startsWith('Speech error:')) {
          statusEl.textContent = 'Idle';
        }
      };

      startButton.addEventListener('pointerdown', () => startListening('button'));
      startButton.addEventListener('pointerup', stopListening);
      startButton.addEventListener('pointerleave', stopListening);
      startButton.addEventListener('touchcancel', stopListening);

      const pttEvents = new EventSource('/ptt-events');
      pttEvents.addEventListener('ptt', (event) => {
        const payload = JSON.parse(event.data);
        if (payload.active) startListening('global');
        else stopListening();
      });
      pttEvents.onerror = () => {
        statusEl.textContent = 'Voice bridge disconnected. Refresh this page.';
      };
    }
  </script>
</body>
</html>`;
}
