import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { workerFetch } from '../src/worker.mjs';

const token = 'a'.repeat(64);
const tokenHash = createHash('sha256').update(token).digest('hex');
const id = 'b'.repeat(32);
const old = Date.now() - 9 * 24 * 60 * 60 * 1000;
const recent = Date.now() - 60 * 60 * 1000;

function environment(createdAt) {
  const row = { id, credential: '__probe__', created_at: createdAt, name: 'Old', version: '1.0.0',
    digest: 'c'.repeat(64), descriptor: '{}' };
  return { STAGING_TOKEN_SHA256: tokenHash,
    DB: { prepare(sql) { return { bind() { return { async first() {
      if (sql.startsWith('SELECT * FROM probe_sessions')) return row;
      if (sql.startsWith('SELECT created_at FROM probe_sessions')) return row;
      if (sql.startsWith('SELECT digest FROM probe_versions')) return null;
      throw new Error(`unexpected SQL ${sql}`);
    } }; } }; } },
    OBJECTS: { async list({ prefix }) { return { objects: [{ key: `${prefix}part`, size: 1 }], truncated: false }; } } };
}
async function call(path, env, credential = token) {
  return workerFetch(new Request(`https://registry.example${path}`, {
    headers: { authorization: `Bearer ${credential}` },
  }), env);
}

test('administrative object upload records the SHA-256 required by public reads', async () => {
  const bytes = Buffer.from('historical object');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const env = environment(recent);
  let stored;
  env.OBJECTS.head = async () => stored;
  env.OBJECTS.put = async (_, body, options) => {
    const actual = createHash('sha256').update(Buffer.from(await new Response(body).arrayBuffer())).digest('hex');
    if (actual !== options.sha256) throw new Error('checksum mismatch (10037)');
    stored = { size: bytes.length, checksums: { sha256: Buffer.from(actual, 'hex') } };
  };
  const path = `/v2/admin/objects/${digest}`;
  const head = credential => workerFetch(new Request(`https://registry.example${path}`, {
    method: 'HEAD', headers: { authorization: `Bearer ${credential}` },
  }), env);
  assert.equal((await head(token)).status, 404);
  const uploaded = await workerFetch(new Request(`https://registry.example${path}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-length': String(bytes.length) }, body: bytes,
  }), env);
  assert.equal(uploaded.status, 200);
  assert.equal((await head(token)).status, 200);
  assert.equal((await head('d'.repeat(64))).status, 403);
});

test('expired uploads stop before storage and maintenance only lists old sessions', async () => {
  const stale = environment(old);
  assert.equal((await call(`/v2/publications/${id}`, stale)).status, 410);
  const keys = await call(`/v2/admin/uploads/${id}`, stale);
  assert.equal(keys.status, 200);
  assert.deepEqual((await keys.json()).keys, [`probe/uploads/${id}/part`]);
  assert.equal((await call(`/v2/admin/uploads/${id}`, stale, 'd'.repeat(64))).status, 403);
  assert.equal((await call(`/v2/admin/uploads/${id}`, environment(recent))).status, 409);
});
