import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const origin = process.env.PROBE_ORIGIN;
const token = process.env.PROBE_TOKEN ?? 'a'.repeat(64); // Local .dev.vars default; remote tests set a random value.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function call(method, path, body, authorized = true, offset, fault) {
  const headers = {};
  if (authorized) headers.authorization = `Bearer ${token}`;
  if (offset !== undefined) headers['upload-offset'] = String(offset);
  if (fault) headers['x-probe-fault'] = fault;
  if (body !== undefined) headers['content-type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
  const response = await fetch(`${origin}${path}`, { method, headers, body });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json;
  try { json = JSON.parse(bytes.toString()); } catch { json = null; }
  return { status: response.status, json, bytes };
}
function fixture(name, version, shared, suffix = '') {
  const sharedDigest = sha(shared);
  const source = Buffer.from(`source for ${name}@${version} ${suffix}\n`);
  const manifest = JSON.stringify({ name, version, requires: { silex: '>=0.44.0' },
    artifacts: { 'macos-arm64': { Shared: { path: 'Boundary/macos-arm64/libShared.a', sha256: sharedDigest } } } });
  return { source, descriptor: { schema: 1, manifest,
    source: { size: source.length, sha256: sha(source) },
    files: [{ path: 'Package.json', size: Buffer.byteLength(manifest), sha256: sha(manifest) }],
    artifacts: [{ target: 'macos-arm64', name: 'Shared', path: 'Boundary/macos-arm64/libShared.a',
      size: shared.length, sha256: sharedDigest }] } };
}
async function begin(value) {
  return call('POST', '/v2/publications', JSON.stringify(value.descriptor));
}
async function upload(id, hash, bytes, from = 0, chunkSize = 7) {
  const path = `/v2/publications/${id}/objects/${hash}`;
  for (let offset = from; offset < bytes.length; offset += chunkSize) {
    const result = await call('PATCH', path, bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)), true, offset);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.offset, Math.min(offset + chunkSize, bytes.length));
  }
}

test('staging probe: hash, resume, immutable versions and shared artifact', { skip: !origin }, async () => {
  const stamp = process.env.PROBE_RUN_ID ?? Date.now().toString(36);
  const name = `CloudflareProbe_${stamp}`;
  const shared = Buffer.from(`small shared native boundary ${stamp}\n`);
  const sharedDigest = sha(shared);
  const first = fixture(name, '1.0.0', shared);
  const second = fixture(name, '1.0.1', shared);
  const other = fixture(`${name}_Other`, '1.0.0', shared);
  const unauthorized = await call('POST', '/v2/publications', JSON.stringify(first.descriptor), false);
  assert.equal(unauthorized.status, 401);
  for (const item of [first, second, other]) {
    const started = await begin(item);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.id;
    assert.match(id, /^[a-f0-9]{32}$/);
    const expected = item.descriptor.source.sha256;
    if (item === first) {
      const missing = await call('POST', `/v2/publications/${id}/finalize`, '');
      assert.equal(missing.status, 409);
      const path = `/v2/publications/${id}/objects/${expected}`;
      const firstChunk = await call('PATCH', path, item.source.subarray(0, 7), true, 0);
      assert.equal(firstChunk.status, 200);
      const resumed = await begin(item);
      assert.equal(resumed.json.id, id);
      assert.equal(resumed.json.objects.find(object => object.sha256 === expected).offset, 7);
      await upload(id, expected, item.source, 7);
      await upload(id, sharedDigest, shared);
    } else {
      assert.equal(started.json.objects.find(object => object.sha256 === sharedDigest).available, true);
      await upload(id, expected, item.source);
    }
    const finalized = await call('POST', `/v2/publications/${id}/finalize`, '');
    assert.equal(finalized.status, 200, JSON.stringify(finalized.json));
    assert.equal(finalized.json.state, 'published');
    const again = await call('POST', `/v2/publications/${id}/finalize`, '');
    assert.equal(again.status, 200);
    const source = await call('GET', `/v2/packages/${item.descriptor.manifest && JSON.parse(item.descriptor.manifest).name}/versions/${JSON.parse(item.descriptor.manifest).version}/source`, undefined, false);
    assert.equal(source.status, 200);
    assert.deepEqual(source.bytes, item.source);
  }
  const listing = await call('GET', `/v2/packages/${name}`, undefined, false);
  assert.equal(listing.status, 200);
  assert.equal(listing.json.versions.length, 2);
  const inventory = await call('GET', '/__probe/inventory');
  assert.equal(inventory.status, 200);
  assert.deepEqual(inventory.json.objects.filter(object => object.key === `probe/objects/sha256/${sharedDigest}`),
    [{ key: `probe/objects/sha256/${sharedDigest}`, size: shared.length }]);
  const artifact = await call('GET', `/v2/packages/${name}/versions/1.0.1/artifacts/macos-arm64/Shared`, undefined, false);
  assert.equal(artifact.status, 200);
  assert.deepEqual(artifact.bytes, shared);
  const conflict = await begin(fixture(name, '1.0.0', shared, 'changed'));
  assert.equal(conflict.status, 409);
  const bad = fixture(`${name}_Bad`, '1.0.0', shared);
  const started = await begin(bad);
  assert.equal(started.status, 200);
  await upload(started.json.id, bad.descriptor.source.sha256, Buffer.from('x'.repeat(bad.source.length)));
  const rejected = await call('POST', `/v2/publications/${started.json.id}/finalize`, '');
  assert.equal(rejected.status, 422, JSON.stringify(rejected.json));
  const hidden = await call('GET', `/v2/packages/${name}_Bad`, undefined, false);
  assert.equal(hidden.status, 404);
  const missing = fixture(`${name}_Missing`, '1.0.0', shared);
  missing.descriptor.artifacts = [];
  assert.equal((await begin(missing)).status, 422);
});

test('staging probe: interruption around R2 persistence and D1 visibility',
  { skip: !origin || process.env.PROBE_TEST_FAULTS !== '1' }, async () => {
    const stamp = process.env.PROBE_RUN_ID ?? Date.now().toString(36);
    for (const point of ['before_object', 'after_object', 'before_visibility', 'after_visibility']) {
      const name = `CloudflareFault_${stamp}_${point}`;
      const shared = Buffer.from(`fault artifact ${stamp} ${point}\n`);
      const item = fixture(name, '1.0.0', shared);
      const started = await begin(item);
      assert.equal(started.status, 200, JSON.stringify(started.json));
      const id = started.json.id;
      await upload(id, item.descriptor.source.sha256, item.source);
      await upload(id, sha(shared), shared);
      const interrupted = await call('POST', `/v2/publications/${id}/finalize`, '', true, undefined, point);
      assert.equal(interrupted.status, 503, JSON.stringify(interrupted.json));
      const visible = await call('GET', `/v2/packages/${name}/versions/1.0.0`, undefined, false);
      assert.equal(visible.status, point === 'after_visibility' ? 200 : 404);
      const resumed = await call('POST', `/v2/publications/${id}/finalize`, '');
      assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
      assert.equal(resumed.json.state, 'published');
      const installed = await call('GET', `/v2/packages/${name}/versions/1.0.0/source`, undefined, false);
      assert.equal(installed.status, 200);
      assert.deepEqual(installed.bytes, item.source);
    }
  });

test('staging probe: concurrent finalization of segmented objects', { skip: !origin }, async () => {
  const stamp = process.env.PROBE_RUN_ID ?? Date.now().toString(36);
  const shared = Buffer.alloc(512 * 1024, 0x53);
  shared.write(stamp);
  const common = sha(shared);
  const candidates = [fixture(`CloudflareConcurrent_${stamp}_A`, '1.0.0', shared),
    fixture(`CloudflareConcurrent_${stamp}_B`, '1.0.0', shared)];
  for (const item of candidates) {
    item.source = Buffer.alloc(1024 * 1024, 0x41);
    item.source.write(JSON.parse(item.descriptor.manifest).name);
    item.descriptor.source = { size: item.source.length, sha256: sha(item.source) };
  }
  const sessions = await Promise.all(candidates.map(begin));
  for (const result of sessions) assert.equal(result.status, 200, JSON.stringify(result.json));
  await Promise.all(candidates.flatMap((item, index) => [
    upload(sessions[index].json.id, item.descriptor.source.sha256, item.source, 0, 65536),
    upload(sessions[index].json.id, common, shared, 0, 65536),
  ]));
  const finalized = await Promise.all(sessions.map(result => call('POST', `/v2/publications/${result.json.id}/finalize`, '')));
  for (const result of finalized) assert.equal(result.status, 200, JSON.stringify(result.json));
  const inventory = await call('GET', '/__probe/inventory');
  assert.equal(inventory.status, 200);
  assert.deepEqual(inventory.json.objects.filter(object => object.key === `probe/objects/sha256/${common}`),
    [{ key: `probe/objects/sha256/${common}`, size: shared.length }]);
});
