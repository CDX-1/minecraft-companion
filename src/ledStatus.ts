import { SerialPort } from 'serialport';
import { existsSync, readdirSync } from 'node:fs';
import { createSerialLineAccumulator } from './waveGesture';

export type LedStatus = 'green' | 'yellow' | 'red';

export interface LedStatusController {
  /** Health overlay: GREEN clears alert strip (shows mood-only); yellow/red overlays. */
  setStatus: (status: LedStatus, reason?: string) => void;
  /** Emotional baseline 0 (upset) — 100 (delighted); only visible while alert is GREEN/off. */
  setMood: (score01To100: number, reason?: string) => void;
  close: () => void;
}

export interface LedStatusOptions {
  portPath?: string;
  baudRate?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  onSerialLine?: (line: string) => void;
}

const STATUS_COMMANDS: Record<LedStatus, string> = {
  green: 'GREEN',
  yellow: 'YELLOW',
  red: 'RED',
};

export function createLedStatusController(options: LedStatusOptions = {}): LedStatusController {
  const requestedPortPath = options.portPath ?? process.env.LED_SERIAL_PORT?.trim();
  const portPath = resolveLedPortPath(requestedPortPath, options.warn);
  const baudRate = options.baudRate ?? (Number(process.env.LED_SERIAL_BAUD) || 115200);

  if (!portPath) {
    return noopController();
  }

  let currentStatus: LedStatus | null = null;
  let currentMood: number | null = null;
  let isOpen = false;

  let pendingOperational: { status: LedStatus; reason?: string } | null = null;
  let pendingMood: number | null = null;

  const port = new SerialPort({
    path: portPath,
    baudRate,
    autoOpen: false,
  });
  const serialLines = createSerialLineAccumulator((line) => options.onSerialLine?.(line));

  port.on('open', () => {
    isOpen = true;
    options.log?.(`ESP32 LED status connected on ${portPath} @ ${baudRate}`);
    flushOperationalPending();
    flushMoodPending();
  });

  port.on('error', (err) => {
    options.warn?.(`ESP32 LED serial error: ${err.message}`);
  });

  port.on('close', () => {
    isOpen = false;
  });

  port.on('data', (chunk: Buffer | string) => {
    serialLines.acceptChunk(chunk);
  });

  port.open((err) => {
    if (err) options.warn?.(`ESP32 LED serial unavailable on ${portPath}: ${err.message}`);
  });

  function writeOperational(status: LedStatus, reason?: string) {
    const command = `${STATUS_COMMANDS[status]}\n`;
    port.write(command, (err) => {
      if (err) {
        options.warn?.(`ESP32 LED write failed: ${err.message}`);
        return;
      }
      options.log?.(`LED ${status}${reason ? `: ${reason}` : ''}`);
    });
  }

  function writeMood(score: number, reason?: string) {
    const line = `MOOD ${score}\n`;
    port.write(line, (err) => {
      if (err) {
        options.warn?.(`ESP32 LED mood write failed: ${err.message}`);
        return;
      }
      options.log?.(`LED mood ${score}${reason ? `: ${reason}` : ''}`);
    });
  }

  function flushOperationalPending() {
    if (!pendingOperational) return;
    const last = pendingOperational;
    pendingOperational = null;
    writeOperational(last.status, last.reason);
  }

  function flushMoodPending() {
    if (pendingMood === null) return;
    const s = pendingMood;
    pendingMood = null;
    writeMood(s);
  }

  function clampMood(score: number): number {
    if (!Number.isFinite(score)) return 50;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  return {
    setStatus: (status, reason) => {
      if (status === currentStatus) return;
      currentStatus = status;
      if (!isOpen) {
        pendingOperational = { status, reason };
        return;
      }
      writeOperational(status, reason);
    },

    setMood: (score01To100, reason) => {
      const score = clampMood(score01To100);
      if (score === currentMood) return;
      currentMood = score;
      if (!isOpen) {
        pendingMood = score;
        return;
      }
      writeMood(score, reason);
    },

    close: () => {
      if (port.isOpen) port.close();
    },
  };
}

function resolveLedPortPath(requestedPortPath?: string, warn?: (message: string) => void): string | undefined {
  if (!requestedPortPath) return undefined;

  if (requestedPortPath.toLowerCase() === 'auto') {
    const detected = detectSerialPort();
    if (!detected) warn?.('ESP32 LED serial auto-detect found no USB serial device.');
    return detected;
  }

  if (existsSync(requestedPortPath)) return requestedPortPath;

  const detected = detectSerialPort();
  if (detected) {
    warn?.(`Configured LED serial port ${requestedPortPath} was not found; using detected port ${detected}.`);
    return detected;
  }

  warn?.(`Configured LED serial port ${requestedPortPath} was not found. Set LED_SERIAL_PORT=auto or reconnect the ESP32.`);
  return undefined;
}

function detectSerialPort(): string | undefined {
  if (process.platform === 'win32') return undefined;

  const preferredPatterns = [
    /^cu\.usbserial/i,
    /^cu\.wchusbserial/i,
    /^cu\.SLAB_USBtoUART/i,
    /^cu\.usbmodem/i,
    /esp32/i,
  ];

  try {
    const candidates = readdirSync('/dev')
      .filter(name => name.startsWith('cu.'))
      .filter(name => !/bluetooth|debug-console/i.test(name))
      .map(name => `/dev/${name}`);

    return candidates.find(candidate => {
      const deviceName = candidate.split('/').pop() ?? candidate;
      return preferredPatterns.some(pattern => pattern.test(deviceName));
    });
  } catch {
    return undefined;
  }
}

function noopController(): LedStatusController {
  return {
    setStatus: () => undefined,
    setMood: () => undefined,
    close: () => undefined,
  };
}
