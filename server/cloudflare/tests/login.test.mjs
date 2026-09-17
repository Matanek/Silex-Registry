import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

const origin = process.env.LOGIN_FIXTURE_ORIGIN;
const ticket = () => randomBytes(32).toString('hex');
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
