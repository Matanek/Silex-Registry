import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { archive } from './tar-fixture.mjs';

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
  const manifest = JSON.stringify({ name, version, requires: { silex: '>=0.44.0' },
    artifacts: { 'macos-arm64': { Shared: { path: 'Boundary/macos-arm64/libShared.a', sha256: sharedDigest } } } });
  const module = Buffer.from(`public func answer() int { return 42 } // ${suffix}\n`);
  const source = archive([['Package.json', manifest], ['Module/Value.sx', module]]);
  return { source, module, descriptor: { schema: 1, manifest,
    source: { size: source.length, sha256: sha(source) },
    files: [{ path: 'Package.json', size: Buffer.byteLength(manifest), sha256: sha(manifest) },
      { path: 'Module/Value.sx', size: module.length, sha256: sha(module) }],
    artifacts: [{ target: 'macos-arm64', name: 'Shared', path: 'Boundary/macos-arm64/libShared.a',
      size: shared.length, sha256: sharedDigest }] } };
}
function reviseManifest(item, change) {
  const manifest = JSON.parse(item.descriptor.manifest);
  change(manifest);
  item.descriptor.manifest = JSON.stringify(manifest);
  item.descriptor.files[0] = { path: 'Package.json', size: Buffer.byteLength(item.descriptor.manifest),
    sha256: sha(item.descriptor.manifest) };
  item.source = archive([['Package.json', item.descriptor.manifest], ['Module/Value.sx', item.module]]);
  item.descriptor.source = { size: item.source.length, sha256: sha(item.source) };
  return item;
}
async function begin(value) {
  return call('POST', '/v2/publications', JSON.stringify(value.descriptor));
}
async function upload(id, hash, bytes, from = 0, chunkSize = Number(process.env.PROBE_UPLOAD_CHUNK_SIZE ?? 7)) {
  const path = `/v2/publications/${id}/objects/${hash}`;
  for (let offset = from; offset < bytes.length; offset += chunkSize) {
    const result = await call('PATCH', path, bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)), true, offset);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.offset, Math.min(offset + chunkSize, bytes.length));
  }
}

test('staging probe: hash, resume, immutable versions and shared artifact', { skip: !origin }, async () => {
  const capabilities = await call('GET', '/v2/capabilities', undefined, false);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.json, { protocol: 'silex-registry-v2' });
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
  const mismatch = fixture(`${name}_Mismatch`, '1.0.0', shared);
  mismatch.source = archive([['Package.json', mismatch.descriptor.manifest],
    ['Module/Value.sx', 'public func answer() int { return 41 } // \n']]);
  mismatch.descriptor.source = { size: mismatch.source.length, sha256: sha(mismatch.source) };
  const mismatchStart = await begin(mismatch);
  assert.equal(mismatchStart.status, 200, JSON.stringify(mismatchStart.json));
  await upload(mismatchStart.json.id, mismatch.descriptor.source.sha256, mismatch.source);
  const mismatchResult = await call('POST', `/v2/publications/${mismatchStart.json.id}/finalize`, '');
  assert.equal(mismatchResult.status, 422, JSON.stringify(mismatchResult.json));
  assert.equal(mismatchResult.json.error, 'file_digest_mismatch');
  assert.equal((await call('GET', `/v2/packages/${name}_Mismatch`, undefined, false)).status, 404);
  const missing = fixture(`${name}_Missing`, '1.0.0', shared);
  missing.descriptor.artifacts = [];
  assert.equal((await begin(missing)).status, 422);
  const unsafe = fixture(`${name}_Unsafe`, '1.0.0', shared);
  unsafe.descriptor.files[1].path = 'Module/CON.txt';
  const refused = await begin(unsafe);
  assert.equal(refused.status, 422, JSON.stringify(refused.json));
  assert.equal(refused.json.error, 'invalid_file');
  assert.equal((await call('GET', `/v2/packages/${name}_Unsafe`, undefined, false)).status, 404);
});

test('staging probe: public version listing follows numeric order',
  { skip: !origin || process.env.PROBE_TEST_NUMERIC_LISTING !== '1' }, async () => {
    const name = `CloudflareOrder_${process.env.PROBE_RUN_ID ?? Date.now().toString(36)}`;
    const shared = Buffer.from(`numeric listing artifact ${name}\n`);
    for (const version of ['1.2.0', '1.10.0', '2.0.0']) {
      const item = fixture(name, version, shared);
      const started = await begin(item);
      assert.equal(started.status, 200, JSON.stringify(started.json));
      await upload(started.json.id, item.descriptor.source.sha256, item.source, 0, 65536);
      if (!started.json.objects.find(object => object.sha256 === sha(shared)).available) {
        await upload(started.json.id, sha(shared), shared, 0, 65536);
      }
      const finalized = await call('POST', `/v2/publications/${started.json.id}/finalize`, '');
      assert.equal(finalized.status, 200, JSON.stringify(finalized.json));
    }
    const listing = await call('GET', `/v2/packages/${name}`, undefined, false);
    assert.equal(listing.status, 200, JSON.stringify(listing.json));
    assert.deepEqual(listing.json.versions.map(item => item.version), ['2.0.0', '1.10.0', '1.2.0']);
  });

test('staging probe: native object larger than the original staging bound',
  { skip: !origin || process.env.PROBE_TEST_LARGE_OBJECT !== '1' }, async () => {
    const name = `CloudflareLarge_${process.env.PROBE_RUN_ID ?? Date.now().toString(36)}`;
    const artifact = Buffer.alloc(22995244, 0x53);
    artifact.write(name);
    const item = fixture(name, '1.0.0', artifact);
    const started = await begin(item);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    await upload(started.json.id, item.descriptor.source.sha256, item.source, 0, 65536);
    await upload(started.json.id, sha(artifact), artifact, 0, 65536);
    const finalized = await call('POST', `/v2/publications/${started.json.id}/finalize`, '');
    assert.equal(finalized.status, 200, JSON.stringify(finalized.json));
    assert.equal(finalized.json.state, 'published');
    const response = await fetch(`${origin}/v2/packages/${name}/versions/1.0.0/artifacts/macos-arm64/Shared`);
    assert.equal(response.status, 200);
    const actual = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) { actual.update(chunk); size += chunk.byteLength; }
    assert.equal(size, artifact.length);
    assert.equal(actual.digest('hex'), sha(artifact));
  });

test('staging probe: historical SDL object above thirty-two MiB',
  { skip: !origin || !process.env.PROBE_HISTORICAL_ARTIFACT_FILE }, async () => {
    const name = `CloudflareHistorical_${process.env.PROBE_RUN_ID ?? Date.now().toString(36)}`;
    const artifact = await readFile(process.env.PROBE_HISTORICAL_ARTIFACT_FILE);
    assert.equal(artifact.length, 51_047_580);
    assert.equal(sha(artifact), '9c6a0ce402ed4232d644ac9966da5baad937773bb2765d41a4a068f9970618cd');
    const item = fixture(name, '1.0.0', artifact);
    const started = await begin(item);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    await upload(started.json.id, item.descriptor.source.sha256, item.source, 0, 65536);
    await upload(started.json.id, sha(artifact), artifact, 0, 65536);
    const finalized = await call('POST', `/v2/publications/${started.json.id}/finalize`, '');
    assert.equal(finalized.status, 200, JSON.stringify(finalized.json));
    const response = await fetch(`${origin}/v2/packages/${name}/versions/1.0.0/artifacts/macos-arm64/Shared`);
    assert.equal(response.status, 200);
    const actual = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) { actual.update(chunk); size += chunk.byteLength; }
    assert.equal(size, artifact.length);
    assert.equal(actual.digest('hex'), sha(artifact));
  });

test('staging probe: source snapshot larger than the original expanded bound',
  { skip: !origin || process.env.PROBE_TEST_LARGE_SOURCE !== '1' }, async () => {
    const name = `CloudflareLargeSource_${process.env.PROBE_RUN_ID ?? Date.now().toString(36)}`;
    const module = Buffer.alloc(36_806_264);
    for (let offset = 0; offset < module.length; offset += 48 * 1024) {
      const fragment = randomBytes(16 * 1024);
      for (let repetition = 0; repetition < 3; repetition++) {
        const start = offset + repetition * fragment.length;
        if (start < module.length) fragment.copy(module, start, 0, Math.min(fragment.length, module.length - start));
      }
    }
    const shared = Buffer.from(`large source artifact ${name}\n`);
    const item = fixture(name, '1.0.0', shared);
    const sourceFiles = Array.from({ length: 4 }, (_, index) => {
      const bytes = module.subarray(index * 9_201_566, (index + 1) * 9_201_566);
      return [`Module/Part${index}.sx`, bytes];
    });
    item.descriptor.files = [item.descriptor.files[0],
      ...sourceFiles.map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) }))];
    item.source = archive([['Package.json', item.descriptor.manifest], ...sourceFiles]);
    item.descriptor.source = { size: item.source.length, sha256: sha(item.source) };
    assert.ok(item.source.length > 8 * 1024 * 1024 && item.source.length < 32 * 1024 * 1024);
    const started = await begin(item);
    assert.equal(started.status, 200, JSON.stringify(started.json));
    await upload(started.json.id, item.descriptor.source.sha256, item.source, 0, 65536);
    await upload(started.json.id, sha(shared), shared, 0, 65536);
    const finalized = await call('POST', `/v2/publications/${started.json.id}/finalize`, '');
    assert.equal(finalized.status, 200, JSON.stringify(finalized.json));
    const response = await fetch(`${origin}/v2/packages/${name}/versions/1.0.0/source`);
    assert.equal(response.status, 200);
    const actual = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) { actual.update(chunk); size += chunk.byteLength; }
    assert.equal(size, item.source.length);
    assert.equal(actual.digest('hex'), item.descriptor.source.sha256);
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

test('staging probe: same-version race and cross-run object retention',
  { skip: !origin || process.env.PROBE_TEST_RACE_RETENTION !== '1' }, async () => {
    const stamp = process.env.PROBE_RUN_ID ?? Date.now().toString(36);
    const holdStamp = process.env.PROBE_HOLD_RUN_ID ?? `Hold${stamp}`;
    const raceName = `CloudflareRace_${stamp}`;
    const raceArtifact = Buffer.from(`race artifact ${stamp}\n`);
    const rivals = [fixture(raceName, '1.0.0', raceArtifact, 'first'),
      fixture(raceName, '1.0.0', raceArtifact, 'second')];
    const rivalsStarted = await Promise.all(rivals.map(begin));
    for (const result of rivalsStarted) assert.equal(result.status, 200, JSON.stringify(result.json));
    await Promise.all(rivals.flatMap((item, index) => [
      upload(rivalsStarted[index].json.id, item.descriptor.source.sha256, item.source),
      upload(rivalsStarted[index].json.id, sha(raceArtifact), raceArtifact),
    ]));
    const outcomes = await Promise.all(rivalsStarted.map(result =>
      call('POST', `/v2/publications/${result.json.id}/finalize`, '')));
    assert.deepEqual(outcomes.map(item => item.status).sort(), [200, 409]);
    const winner = outcomes.findIndex(item => item.status === 200);
    const loser = 1 - winner;
    const visible = await call('GET', `/v2/packages/${raceName}/versions/1.0.0`, undefined, false);
    assert.equal(visible.status, 200);
    assert.equal(visible.json.descriptor.source.sha256, rivals[winner].descriptor.source.sha256);
    assert.equal((await call('POST', `/v2/publications/${rivalsStarted[winner].json.id}/finalize`, '')).status, 200);
    assert.equal((await call('POST', `/v2/publications/${rivalsStarted[loser].json.id}/finalize`, '')).status, 409);

    const shared = Buffer.from(`retained artifact ${stamp}\n`);
    const target = fixture(`CloudflareRetention_${stamp}`, '1.0.0', shared);
    const hold = fixture(`CloudflareRetention_${holdStamp}`, '1.0.0', shared);
    for (const item of [target, hold]) {
      const started = await begin(item);
      assert.equal(started.status, 200, JSON.stringify(started.json));
      await upload(started.json.id, item.descriptor.source.sha256, item.source);
      if (!started.json.objects.find(object => object.sha256 === sha(shared)).available) {
        await upload(started.json.id, sha(shared), shared);
      }
      const finalized = await call('POST', `/v2/publications/${started.json.id}/finalize`, '');
      assert.equal(finalized.status, 200, JSON.stringify(finalized.json));
    }
    const inventory = await call('GET', '/__probe/inventory');
    assert.equal(inventory.status, 200);
    assert.equal(inventory.json.objects.filter(object => object.key === `probe/objects/sha256/${sha(shared)}`).length, 1);
    console.log(JSON.stringify({ runId: stamp, holdRunId: holdStamp, retainedDigest: sha(shared) }));
});

test('staging probe: dependency versions use numeric order before visibility',
  { skip: !origin || process.env.PROBE_TEST_DEPENDENCIES !== '1' }, async () => {
    const stamp = process.env.PROBE_RUN_ID ?? Date.now().toString(36);
    const shared = Buffer.from(`dependency artifact ${stamp}\n`);
    const dependencyName = `CloudflareDependency_${stamp}`;
    const dependentName = `CloudflareDependent_${stamp}`;
    const items = [fixture(dependencyName, '1.10.0', shared),
      reviseManifest(fixture(dependentName, '1.0.0', shared), manifest => {
        manifest.dependencies = { [dependencyName]: '^1.2.0' };
      }),
      reviseManifest(fixture(`${dependentName}_Bad`, '1.0.0', shared), manifest => {
        manifest.dependencies = { [dependencyName]: '^2.0.0' };
      })];
    for (const [index, item] of items.entries()) {
      const started = await begin(item);
      assert.equal(started.status, 200, JSON.stringify(started.json));
      for (const object of started.json.objects) {
        if (object.available) continue;
        await upload(started.json.id, object.sha256,
          object.sha256 === item.descriptor.source.sha256 ? item.source : shared);
      }
      const finalized = await call('POST', `/v2/publications/${started.json.id}/finalize`, '');
      assert.equal(finalized.status, index === 2 ? 409 : 200, JSON.stringify(finalized.json));
      if (index === 2) assert.equal(finalized.json.error, 'missing_dependency');
    }
    assert.equal((await call('GET', `/v2/packages/${dependentName}/versions/1.0.0`, undefined, false)).status, 200);
    assert.equal((await call('GET', `/v2/packages/${dependentName}_Bad/versions/1.0.0`, undefined, false)).status, 404);
  });
