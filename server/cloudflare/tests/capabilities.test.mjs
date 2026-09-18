import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerFetch } from '../src/worker.mjs';

test('public protocol discovery requires no author identity', async () => {
  const response = await workerFetch(new Request('https://registry.example/v2/capabilities'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { protocol: 'silex-registry-v2' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
