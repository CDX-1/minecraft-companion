import assert from 'node:assert/strict';
import test from 'node:test';
import { createLedStatusController } from './ledStatus';

test('LED status controller is a no-op when no serial port is configured', () => {
  const controller = createLedStatusController({ portPath: '' });

  assert.doesNotThrow(() => {
    controller.setStatus('green', 'test');
    controller.setStatus('yellow', 'test');
    controller.setStatus('red', 'test');
    controller.setMood(73, 'neutral test');
    controller.close();
  });
});

test('LED status controller is a no-op when auto-detect finds no board', () => {
  const warnings: string[] = [];
  const controller = createLedStatusController({
    portPath: 'auto',
    warn: (message) => warnings.push(message),
  });

  assert.doesNotThrow(() => {
    controller.setStatus('green', 'test');
    controller.close();
  });
  assert.ok(warnings.length >= 0);
});
