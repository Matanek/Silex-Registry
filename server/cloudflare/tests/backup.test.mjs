import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { BackupFailure, backupFootprint, backupR2Object } from '../src/backup.mjs';
import { consumeBackupBatch, enqueuePublicationBackup } from '../src/maintenance.mjs';
import { validateB2Snapshot } from '../admin/restore-b2.mjs';
import { canonical } from '../src/worker.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function descriptor(source, artifacts = []) {
  return { source: { sha256: hash(source), size: source.length }, artifacts };
}

function baseEnvironment(extra = {}) {
  return { BACKUP_REQUIRED: '1', BACKUP_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
    BACKUP_BUCKET: 'silex-registry-backup-test', BACKUP_PREFIX: 'registry/test',
    BACKUP_LIMIT_BYTES: String(8 * 1024 * 1024 * 1024),
    BACKUP_RETENTION_DAYS: '90',
    BACKUP_ACCESS_KEY_ID: '00112233445566778899',
    BACKUP_SECRET_ACCESS_KEY: 'a'.repeat(40), ...extra };
}

function memoryB2() {
  const stored = new Map();
  const requests = [];
  return { stored, requests, async fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    requests.push({ url, method, headers: new Headers(init.headers) });
    if (method === 'HEAD') {
      const item = stored.get(url);
      return item ? new Response(null, { headers: { 'content-length': String(item.bytes.length),
        'x-amz-meta-sha256': item.sha256 } }) : new Response(null, { status: 404 });
    }
    assert.equal(method, 'PUT');
    const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
    const headers = new Headers(init.headers);
    stored.set(url, { bytes, sha256: headers.get('x-amz-meta-sha256') });
    return new Response(null, { status: 200 });
  } };
}

test('backup footprint deduplicates immutable objects and enforces the logical free-tier ceiling', async () => {
  const shared = Buffer.from('shared');
  const first = Buffer.from('first');
  const incoming = Buffer.from('incoming');
  const rows = [{ descriptor: JSON.stringify(descriptor(first,
    [{ sha256: hash(shared), size: shared.length }])) },
  { descriptor: JSON.stringify(descriptor(shared)) }];
  const DB = { prepare() { let offset = 0; return { bind(value) { offset = value; return this; },
    async all() { return { results: offset === 0 ? rows : [] }; } }; } };
  const env = baseEnvironment({ DB, BACKUP_LIMIT_BYTES: String(first.length + shared.length + incoming.length) });
  assert.deepEqual(await backupFootprint(env, descriptor(incoming)),
    { enabled: true, bytes: first.length + shared.length + incoming.length, objects: 3 });
  env.BACKUP_LIMIT_BYTES = String(first.length + shared.length + incoming.length - 1);
  await assert.rejects(backupFootprint(env, descriptor(incoming)),
    error => error instanceof BackupFailure && error.status === 507 && error.code === 'backup_capacity');
});

test('B2 copy is checksum-addressed, encrypted at rest and idempotent', async () => {
  const bytes = Buffer.from('immutable package object');
  const sha256 = hash(bytes);
  const b2 = memoryB2();
  const env = baseEnvironment({ BACKUP_FETCH: b2.fetch,
    OBJECTS: { async get(key) {
      assert.equal(key, `probe/objects/sha256/${sha256}`);
      return { size: bytes.length, checksums: { sha256: Buffer.from(sha256, 'hex') }, body: bytes };
    } } });
  assert.equal((await backupR2Object(env, sha256, bytes.length)).copied, true);
  assert.equal((await backupR2Object(env, sha256, bytes.length)).copied, false);
  assert.deepEqual(b2.requests.map(item => item.method), ['HEAD', 'PUT', 'HEAD', 'HEAD']);
  const upload = b2.requests.find(item => item.method === 'PUT');
  assert.equal(upload.headers.get('x-amz-server-side-encryption'), 'AES256');
  assert.equal(upload.headers.get('x-amz-meta-sha256'), sha256);
  assert.equal(upload.headers.get('x-amz-checksum-sha256'), createHash('sha256').update(bytes).digest('base64'));
  assert.equal(upload.headers.get('x-amz-object-lock-mode'), 'GOVERNANCE');
  const retention = Date.parse(upload.headers.get('x-amz-object-lock-retain-until-date'));
  assert(retention > Date.now() + 89 * 24 * 60 * 60 * 1000);
  assert.deepEqual([...b2.stored.values()][0].bytes, bytes);
});

test('publication queues only bounded identifiers before public visibility', async () => {
  const source = Buffer.from('source');
  const value = descriptor(source);
  const descriptorText = 'x'.repeat(200_000);
  const batches = [];
  const queued = [];
  const DB = { prepare(sql) { let values = []; return { sql, values,
    bind(...next) { values = next; this.values = values; return this; },
    async all() { return { results: [] }; } }; },
  async batch(statements) { batches.push(...statements); } };
  const env = baseEnvironment({ DB, BACKUP_QUEUE: { async sendBatch(messages) { queued.push(...messages); } } });
  const result = await enqueuePublicationBackup(env,
    { digest: 'd'.repeat(64), descriptor: descriptorText }, value);
  assert.equal(result.queued, 2);
  assert.equal(batches.length, 2);
  assert.equal(queued.length, 2);
  assert(queued.every(message => JSON.stringify(message).length < 1000));
  assert(!JSON.stringify(queued).includes(descriptorText.slice(0, 100)));
  assert.deepEqual(queued.map(message => message.body.kind), ['object', 'publication']);
});

test('queue consumer reconstructs publication metadata from D1 and acknowledges only verified B2 data', async () => {
  const b2 = memoryB2();
  const digest = 'd'.repeat(64);
  const row = { name: 'BackupFixture', version: '1.0.0', digest,
    descriptor: JSON.stringify({ schema: 1 }), credential: '12345' };
  const updates = [];
  const DB = { prepare(sql) { let values = []; return { bind(...next) { values = next; return this; },
    async first() { return sql.includes('FROM probe_versions v') ? row : null; },
    async run() { updates.push({ sql, values }); } }; } };
  let acknowledged = 0;
  const message = { body: { kind: 'publication', item: digest, size: row.descriptor.length },
    ack() { acknowledged++; }, retry() { assert.fail('verified metadata must not retry'); } };
  await consumeBackupBatch({ messages: [message] }, baseEnvironment({ DB, BACKUP_FETCH: b2.fetch }));
  assert.equal(acknowledged, 1);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /state='complete'/);
  const saved = JSON.parse([...b2.stored.values()][0].bytes.toString());
  assert.deepEqual(saved, { schema: 1, name: row.name, version: row.version,
    github_id: row.credential, publication_sha256: digest, descriptor: row.descriptor });
});

test('restore snapshot rejects altered metadata before downloading package bytes', async () => {
  const manifest = JSON.stringify({ name: 'BackupFixture', version: '1.0.0',
    requires: { silex: '>=0.44.0' } });
  const value = { schema: 1, manifest, source: { sha256: 'a'.repeat(64), size: 1 },
    files: [{ path: 'Package.json', size: Buffer.byteLength(manifest), sha256: hash(manifest) },
      { path: 'Module/Value.sx', size: 1, sha256: hash('x') }], artifacts: [] };
  const encoded = canonical(value);
  const snapshot = { schema: 2, owners: [{ name: 'BackupFixture', github_id: '12345' }],
    versions: [{ name: 'BackupFixture', version: '1.0.0', digest: hash(encoded), descriptor: encoded }] };
  const checked = await validateB2Snapshot(snapshot);
  assert.equal(checked.records.length, 1);
  assert.equal(checked.objects.size, 1);
  const altered = structuredClone(snapshot);
  altered.versions[0].digest = 'f'.repeat(64);
  await assert.rejects(validateB2Snapshot(altered), /invalid B2 version BackupFixture@1\.0\.0/);
});
