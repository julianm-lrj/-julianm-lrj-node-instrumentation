const { startTelemetry, createExpressInstrumentationMiddleware } = require('../dist/index.cjs');
const assert = require('node:assert');
const { test } = require('node:test');

test('CJS require works', () => {
  assert.strictEqual(typeof startTelemetry, 'function', 'startTelemetry should be a function');
  assert.strictEqual(typeof createExpressInstrumentationMiddleware, 'function', 'middleware should be a function');
  console.log('✓ CJS require works correctly');
});
