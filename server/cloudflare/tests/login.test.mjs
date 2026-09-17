import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { archive } from './tar-fixture.mjs';

const origin = process.env.LOGIN_FIXTURE_ORIGIN;
const ticket = () => randomBytes(32).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function call(method, route, authorization, body) {
  const response = await fetch(`${origin}${route}`, { method,
    headers: authorization ? { authorization } : {}, body });
  return { status: response.status, value: await response.json() };
}
async function waitUntil(epoch) {
  const remaining = epoch * 1000 - Date.now();
  if (remaining >= 0) await new Promise(resolve => setTimeout(resolve, remaining + 100));
}
async function start(secret) {
  const auth = `Login ${secret}`;
  const result = await call('POST', '/v2/logins', auth);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.state, 'pending');
  return { auth, ...result.value };
}

test('login: ticket isolation, pending, identity, replay and revocation', { skip: !origin }, async () => {
  await call('POST', '/__test/mode', undefined, 'pending');
  const first = await start(ticket());
  const repeated = await call('POST', '/v2/logins', first.auth);
  assert.equal(repeated.value.id, first.id);
  assert.equal(repeated.value.user_code, first.user_code);
  const wrong = await call('POST', `/v2/logins/${first.id}`, `Login ${ticket()}`);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.value.error, 'wrong_login_ticket');
  await waitUntil(first.expires_at - 899);
  let pending = await call('POST', `/v2/logins/${first.id}`, first.auth);
  assert.equal(pending.value.state, 'pending');
  assert.ok(pending.value.retry_after >= 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const approved = await call('POST', `/v2/logins/${first.id}`, first.auth);
  assert.equal(approved.status, 200, JSON.stringify(approved.value));
  assert.equal(approved.value.state, 'authorized');
  assert.match(approved.value.token, /^[a-f0-9]{64}$/);
  const replay = await call('POST', `/v2/logins/${first.id}`, first.auth);
  assert.equal(replay.value.state, 'consumed');
  assert.equal(replay.value.token, undefined);
  const bearer = `Bearer ${approved.value.token}`;
  const session = await call('GET', '/v2/session', bearer);
  assert.equal(session.value.github_id, '123456789');
  assert.equal(session.value.login, 'fixture-user');
  assert.equal((await call('DELETE', '/v2/session', bearer)).value.revoked, true);
  assert.equal((await call('GET', '/v2/session', bearer)).status, 401);
});

test('login: refusal and invalid request body', { skip: !origin }, async () => {
  await call('POST', '/__test/mode', undefined, 'denied');
  const first = await start(ticket());
  await new Promise(resolve => setTimeout(resolve, 1100));
  const denied = await call('POST', `/v2/logins/${first.id}`, first.auth);
  assert.equal(denied.value.state, 'denied');
  assert.equal(denied.value.token, undefined);
  assert.equal((await call('POST', '/v2/logins', `Login ${ticket()}`, 'unexpected')).status, 422);
});

test('login: concurrent poll cannot issue two credentials; expiry blocks authorization', { skip: !origin }, async () => {
  await call('POST', '/__test/mode', undefined, 'authorized');
  const first = await start(ticket());
  await new Promise(resolve => setTimeout(resolve, 1100));
  const results = await Promise.all(Array.from({ length: 3 }, () => call('POST', `/v2/logins/${first.id}`, first.auth)));
  assert.equal(results.filter(item => item.value.state === 'authorized').length, 1, JSON.stringify(results));
  assert.equal(new Set(results.filter(item => item.value.token).map(item => item.value.token)).size, 1);
  const second = await start(ticket());
  await call('POST', `/__test/expire/${second.id}`);
  const expired = await call('POST', `/v2/logins/${second.id}`, second.auth);
  assert.equal(expired.value.state, 'expired');
  assert.equal(expired.value.token, undefined);
});

test('publication: GitHub identity owns a name and revoked access cannot publish', { skip: !origin }, async () => {
  await call('POST', '/__test/mode', undefined, 'authorized');
  const first = await start(ticket());
  await new Promise(resolve => setTimeout(resolve, 1100));
  const approved = await call('POST', `/v2/logins/${first.id}`, first.auth);
  assert.equal(approved.value.state, 'authorized');
  const bearer = `Bearer ${approved.value.token}`;
  const name = `CloudflareOwner_${randomBytes(4).toString('hex')}`;
  const manifest = JSON.stringify({ name, version: '1.0.0', requires: { silex: '>=0.44.0' } });
  const source = archive([['Package.json', manifest]]);
  const descriptor = { schema: 1, manifest, source: { sha256: sha(source), size: source.length },
    files: [{ path: 'Package.json', sha256: sha(manifest), size: Buffer.byteLength(manifest) }], artifacts: [],
    provenance: { repository: 'https://github.com/Matanek/Silex-Registry.git', commit: 'a'.repeat(40) } };
  const unrecognized = await call('POST', '/v2/publications', bearer, JSON.stringify({ ...descriptor, ignored: true }));
  assert.equal(unrecognized.status, 422);
  assert.equal(unrecognized.value.error, 'invalid_descriptor');
  const created = await call('POST', '/v2/publications', bearer, JSON.stringify(descriptor));
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const object = await fetch(`${origin}/v2/publications/${created.value.id}/objects/${sha(source)}`, {
    method: 'PATCH', headers: { authorization: bearer, 'upload-offset': '0' }, body: source,
  });
  assert.equal(object.status, 200, await object.text());
  const finalized = await call('POST', `/v2/publications/${created.value.id}/finalize`, bearer);
  assert.equal(finalized.value.state, 'published', JSON.stringify(finalized));
  assert.equal((await call('DELETE', '/v2/session', bearer)).status, 200);
  assert.equal((await call('POST', '/v2/publications', bearer, JSON.stringify(descriptor))).status, 401);
  await call('POST', '/__test/mode', undefined, 'other');
  const second = await start(ticket());
  await new Promise(resolve => setTimeout(resolve, 1100));
  const other = await call('POST', `/v2/logins/${second.id}`, second.auth);
  assert.equal(other.value.state, 'authorized');
  const rejected = await call('POST', '/v2/publications', `Bearer ${other.value.token}`, JSON.stringify(descriptor));
  assert.equal(rejected.status, 403);
  assert.equal(rejected.value.error, 'name_unavailable');
});
