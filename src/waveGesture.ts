export interface DistanceHoldDetectorOptions {
  threshold: number;
  holdMs: number;
  onHold: (distance: number) => void;
}

export interface DistanceHoldDetector {
  acceptLine: (line: string, now?: number) => void;
  acceptDistance: (distance: number, now?: number) => void;
}

export interface SerialLineAccumulator {
  acceptChunk: (chunk: Buffer | string) => void;
}

export function parseDistanceReading(line: string): number | null {
  const match = line.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function createDistanceHoldDetector(options: DistanceHoldDetectorOptions): DistanceHoldDetector {
  let belowSince: number | null = null;
  let armed = true;

  function acceptDistance(distance: number, now = Date.now()): void {
    if (!Number.isFinite(distance)) return;

    if (distance >= options.threshold) {
      belowSince = null;
      armed = true;
      return;
    }

    belowSince ??= now;
    if (armed && now - belowSince >= options.holdMs) {
      armed = false;
      options.onHold(distance);
    }
  }

  return {
    acceptLine: (line, now = Date.now()) => {
      const distance = parseDistanceReading(line);
      if (distance === null) return;
      acceptDistance(distance, now);
    },
    acceptDistance,
  };
}

export function createSerialLineAccumulator(onLine: (line: string) => void): SerialLineAccumulator {
  let buffer = '';

  return {
    acceptChunk: (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (line) onLine(line);
      }
    },
  };
}
