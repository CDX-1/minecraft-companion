import http from 'node:http';

interface VoiceServerOptions {
  port: number;
  onTranscript: (text: string) => void;
}

const TRANSCRIPT_COOLDOWN_MS = 3000;

export interface VoiceServer {
  url: string;
  close: () => void;
}

export function startVoiceServer(options: VoiceServerOptions): Promise<VoiceServer> {
  let lastTranscript = '';
  let lastTranscriptAt = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderVoicePage());
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
          if (
            typeof payload.text === 'string' &&
            shouldAcceptTranscript(payload.text, lastTranscript, lastTranscriptAt, Date.now())
          ) {
            lastTranscript = normalizeTranscript(payload.text);
            lastTranscriptAt = Date.now();
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
      resolve({
        url: `http://127.0.0.1:${options.port}`,
        close: () => server.close(),
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
    <p>Click start, allow microphone access, then say commands like <code>hey companion</code> or <code>follow me</code>.</p>
    <button id="start">Start Listening</button>
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

      async function sendTranscript(text) {
        if (!text.trim()) return;
        lastEl.textContent = 'Last transcript: ' + text;

        await fetch('/transcript', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      }

      recognition.onstart = () => {
        statusEl.textContent = 'Listening...';
        startButton.textContent = 'Listening';
        startButton.disabled = true;
      };

      recognition.onresult = async (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result.isFinal) continue;
          const text = result[0].transcript.trim();
          await sendTranscript(text);
        }
      };

      recognition.onerror = (event) => {
        statusEl.textContent = 'Speech error: ' + event.error;
      };

      recognition.onend = () => {
        if (startButton.disabled) recognition.start();
      };

      startButton.addEventListener('click', () => recognition.start());
    }
  </script>
</body>
</html>`;
}
