import { SerialPort } from 'serialport';
import { existsSync, readdirSync } from 'node:fs';

export type LedStatus = 'green' | 'yellow' | 'red';

export interface LedStatusController {
  setStatus: (status: LedStatus, reason?: string) => void;
  close: () => void;
}

export interface LedStatusOptions {
  portPath?: string;
  baudRate?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
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
  let isOpen = false;
  const pending: Array<{ status: LedStatus; reason?: string }> = [];

  const port = new SerialPort({
    path: portPath,
    baudRate,
    autoOpen: false,
  });

  port.on('open', () => {
    isOpen = true;
    options.log?.(`ESP32 LED status connected on ${portPath} @ ${baudRate}`);
    flushPending();
  });

  port.on('error', (err) => {
    options.warn?.(`ESP32 LED serial error: ${err.message}`);
  });

  port.on('close', () => {
    isOpen = false;
  });

  port.open((err) => {
    if (err) options.warn?.(`ESP32 LED serial unavailable on ${portPath}: ${err.message}`);
  });

  function writeStatus(status: LedStatus, reason?: string) {
    const command = `${STATUS_COMMANDS[status]}\n`;
    port.write(command, (err) => {
      if (err) {
        options.warn?.(`ESP32 LED write failed: ${err.message}`);
        return;
      }
      options.log?.(`LED ${status}${reason ? `: ${reason}` : ''}`);
    });
  }

  function flushPending() {
    const last = pending.pop();
    pending.length = 0;
    if (last) writeStatus(last.status, last.reason);
  }

  return {
    setStatus: (status, reason) => {
      if (status === currentStatus) return;
      currentStatus = status;
      if (!isOpen) {
        pending.push({ status, reason });
        return;
      }
      writeStatus(status, reason);
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
    close: () => undefined,
  };
}
