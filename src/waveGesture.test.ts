import assert from 'node:assert/strict';
import test from 'node:test';
import { createDistanceHoldDetector, createSerialLineAccumulator, parseDistanceReading } from './waveGesture';

test('parses numeric distance readings from serial lines', () => {
  assert.equal(parseDistanceReading('17'), 17);
  assert.equal(parseDistanceReading('distance: 19.5 cm'), 19.5);
  assert.equal(parseDistanceReading('no reading'), null);
});

test('fires after distance stays below threshold for the hold duration', () => {
  const events: number[] = [];
  const detector = createDistanceHoldDetector({
    threshold: 20,
    holdMs: 1000,
    onHold: (distance) => events.push(distance),
  });

  detector.acceptDistance(19, 0);
  detector.acceptDistance(18, 999);
  assert.deepEqual(events, []);

  detector.acceptDistance(17, 1000);
  assert.deepEqual(events, [17]);
});

test('rearms only after distance rises back to or above threshold', () => {
  const events: number[] = [];
  const detector = createDistanceHoldDetector({
    threshold: 20,
    holdMs: 1000,
    onHold: (distance) => events.push(distance),
  });

  detector.acceptDistance(10, 0);
  detector.acceptDistance(10, 1000);
  detector.acceptDistance(10, 2500);
  assert.deepEqual(events, [10]);

  detector.acceptDistance(21, 2600);
  detector.acceptDistance(19, 3000);
  detector.acceptDistance(18, 4000);
  assert.deepEqual(events, [10, 18]);
});

test('serial line accumulator emits complete trimmed lines from chunks', () => {
  const lines: string[] = [];
  const accumulator = createSerialLineAccumulator((line) => lines.push(line));

  accumulator.acceptChunk('dist');
  accumulator.acceptChunk('ance: 19\r\n18\npartial');
  accumulator.acceptChunk(' 17\n');

  assert.deepEqual(lines, ['distance: 19', '18', 'partial 17']);
});
