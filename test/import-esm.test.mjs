import { startTelemetry, createExpressInstrumentationMiddleware } from '../dist/index.js';
import assert from 'node:assert';
import { test } from 'node:test';

test('ESM import works', () => {
  assert.strictEqual(typeof startTelemetry, 'function', 'startTelemetry should be a function');
  assert.strictEqual(typeof createExpressInstrumentationMiddleware, 'function', 'middleware should be a function');
  console.log('✓ ESM import works correctly');
});
