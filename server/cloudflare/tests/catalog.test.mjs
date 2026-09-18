import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerFetch } from '../src/worker.mjs';

test('catalog lists published snapshots without requiring source repositories', async () => {
  const rows = [
    { name: 'Example', version: '1.2.0', descriptor: JSON.stringify({ manifest: JSON.stringify({
      name: 'Example', description: { en: 'Earlier', fr: 'Ancien' },
    }) }) },
    { name: 'Example', version: '1.10.0', descriptor: JSON.stringify({ manifest: JSON.stringify({
      name: 'Example', description: { en: 'Current', fr: 'Actuel' }, repository: 'https://github.com/example/removed',
    }) }) },
    { name: 'LocalOnly', version: '0.1.0', descriptor: JSON.stringify({ manifest: JSON.stringify({
      name: 'LocalOnly', description: 'Published from a local directory',
    }) }) },
  ];
  const env = { DB: { prepare(sql) {
    assert.match(sql, /FROM probe_versions/);
    return { bind(offset) { return { async all() { return { results: rows.slice(offset, offset + 500) }; } }; } };
  } } };
  const response = await workerFetch(new Request('https://registry.example/v2/catalog'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(await response.json(), { schema: 1, packages: [
    { name: 'Example', description: { en: 'Current', fr: 'Actuel' }, repository: 'https://github.com/example/removed' },
    { name: 'LocalOnly', description: 'Published from a local directory' },
  ] });
});
