import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const group = dirname(repository), php = process.argv[2];
assert.equal(process.cwd(), group); assert(php?.startsWith('/'));
await mkdir(`${group}/TestState/login`, { recursive: true });
const root = await mkdtemp(`${group}/TestState/login/run-`);
const children = [];
const secret = () => randomBytes(32).toString('hex');
let checks = 0;
function pass(label) { console.log(`ok ${++checks} - ${label}`); }
function fixture(action, values = {}) {
  return new Promise((yes, no) => {
    const child = spawn(php, [`${repository}/server/tests/login-fixture.php`]);
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    child.on('error', no); child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' && values.crash) return yes({ killed: true });
      if (code !== 0) return no(new Error(`Fixture failed (${code}): ${errors}`));
      try { yes(JSON.parse(output)); } catch (error) { no(error); }
    });
    child.stdin.end(JSON.stringify({ root, action, ...values }));
  });
}
async function start(production = false) {
  const socket = createServer();
  await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes); });
  const port = socket.address().port; await new Promise(yes => socket.close(yes));
  const router = production ? 'public/index.php' : 'tests/login-router.php';
  const child = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', `${repository}/server/public`, `${repository}/server/${router}`],
    { env: { ...process.env, SILEX_REGISTRY_DATA: root, SILEX_GITHUB_CLIENT_ID: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child); let errors = ''; child.stderr.on('data', data => { errors += data; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(errors);
    try { await fetch(base); return base; } catch { await new Promise(yes => setTimeout(yes, 20)); }
  }
  throw new Error('Server not ready');
}
async function request(base, path, { method = 'POST', ticket, token, status = 200, body } = {}) {
  const headers = ticket ? { Authorization: `Login ${ticket}` } : token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(base + path, { method, headers, body });
  const value = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${value.error ?? value.state}`); return value;
}
let base;
const begin = ticket => request(base, '/v2/logins', { ticket });
const poll = (attempt, ticket, endpoint = base) => request(endpoint, `/v2/logins/${attempt.id}`, { ticket });
const configure = (attempt, state, values = {}) => fixture('configure', { user_code: attempt.user_code, state, ...values });
try {
  console.log(JSON.stringify({ repository, head: execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root, php, provider: 'offline injected GitHub; no network identity proof' }));
  await fixture('init'); base = await start(); const parallel = await start(); const production = await start(true);
  console.log(`HTTP instances: ${base}, ${parallel}; real bootstrap without GitHub config: ${production}`);
  const a = secret(), b = secret(); const first = await begin(a), second = await begin(b);
  assert.equal(first.state, 'pending'); assert.equal((await begin(a)).id, first.id);
  assert(!('device_code' in first) && !('ticket' in first));
  await request(base, '/v2/logins', { status: 401 });
  await request(base, '/v2/logins', { ticket: a, body: JSON.stringify({ github_id: '1001' }), status: 413 });
  await request(base, `/v2/logins/${first.id}`, { ticket: b, status: 403 });
  const before = (await fixture('inspect')).calls;
  await poll(first, a); assert.equal((await fixture('inspect')).calls, before);
  assert.equal((await stat(`${root}/login.key`)).mode & 0o777, 0o600);
  const database = await readFile(`${root}/registry.sqlite`);
  for (const code of Object.keys(JSON.parse(await readFile(`${root}/mock.json`)).devices)) assert(!database.includes(Buffer.from(code)));
  assert(!database.includes(Buffer.from(a)));
  pass('private encrypted device codes, hashed tickets, idempotent start, crossed attempts and early polling rejected');

  await configure(first, 'authorized', { id: 1001, login: 'author' });
  await configure(second, 'authorized', { id: 1002, login: 'second' });
  await fixture('tick', { seconds: 5 });
  const results = await Promise.all([poll(first, a), poll(first, a, parallel)]);
  assert.equal(results.filter(result => result.state === 'authorized').length, 1);
  const access = results.find(result => result.state === 'authorized');
  assert.equal((await poll(first, a)).state, 'consumed');
  const other = await poll(second, b);
  assert.notEqual(access.token, other.token);
  assert.equal((await request(production, '/v2/session', { method: 'GET', token: access.token })).github_id, '1001');
  assert.equal((await fixture('inspect')).identities.length, 2);
  await request(production, '/v2/logins', { ticket: secret(), status: 503 });
  pass('one atomic identity/credential issue across processes; real bootstrap accepts registry tokens without GitHub availability');

  await request(production, '/v2/session', { method: 'DELETE', token: access.token });
  await request(production, '/v2/session', { method: 'DELETE', token: access.token });
  await request(production, '/v2/session', { method: 'GET', token: access.token, status: 401 });
  await request(production, '/v2/session', { method: 'GET', token: other.token });
  await request(base, `/v2/logins/${first.id}`, { token: other.token, status: 401 });
  pass('logout is idempotent, revokes only its own credential and cannot become a login ticket');

  await fixture('tick', { seconds: 60 });
  for (const mode of ['denied', 'expired', 'network']) {
    const ticket = secret(), attempt = await begin(ticket);
    await configure(attempt, mode); await fixture('tick', { seconds: 5 });
    if (mode === 'network') {
      await request(base, `/v2/logins/${attempt.id}`, { ticket, status: 503 });
      assert.equal((await poll(attempt, ticket)).state, 'failed');
    } else assert.equal((await poll(attempt, ticket)).state, mode);
  }
  const slowTicket = secret(), slow = await begin(slowTicket);
  await configure(slow, 'slow_down'); await fixture('tick', { seconds: 5 });
  assert.equal((await poll(slow, slowTicket)).retry_after, 20);
  const expTicket = secret(), exp = await begin(expTicket);
  await fixture('tick', { seconds: 901 });
  assert.equal((await poll(exp, expTicket)).state, 'expired');
  pass('denial, provider/network failure, expiry and GitHub slow-down never issue a credential');

  for (const point of ['after_github', 'before_credential_commit', 'after_credential_commit']) {
    await fixture('tick', { seconds: 60 });
    const ticket = secret(), attempt = await begin(ticket);
    await configure(attempt, 'authorized'); await fixture('tick', { seconds: 5 });
    const count = (await fixture('inspect')).credentials.length;
    assert((await fixture('poll', { id: attempt.id, ticket, crash: point })).killed);
    await fixture('tick', { seconds: 31 });
    const state = await poll(attempt, ticket);
    assert.equal(state.state, point === 'after_credential_commit' ? 'consumed' : 'failed');
    assert.equal((await fixture('inspect')).credentials.length, count + (point === 'after_credential_commit' ? 1 : 0));
    assert(!('token' in state));
  }
  pass('SIGKILL around identity/credential commit cannot replay issuance or reveal the lost bearer');

  await fixture('tick', { seconds: 60 });
  const renameTicket = secret(), renamed = await begin(renameTicket);
  await configure(renamed, 'authorized', { id: 1001, login: 'renamed' });
  await fixture('tick', { seconds: 5 }); await poll(renamed, renameTicket);
  const identities = (await fixture('inspect')).identities;
  assert.equal(identities.length, 2); assert.equal(identities.find(i => i.github_id === '1001').login, 'renamed');
  await fixture('expire-access');
  await request(production, '/v2/session', { method: 'GET', token: other.token, status: 401 });
  await fixture('tick', { seconds: 86401 }); await fixture('collect');
  const collected = await fixture('inspect'); assert.equal(collected.attempts.length, 0); assert.equal(collected.credentials.length, 0);
  pass('stable ID survives rename; expired access is refused; transient attempt/credential retention is bounded by collection');

  for (let index = 0; index < 10; index++) await begin(secret());
  await request(base, '/v2/logins', { ticket: secret(), status: 429 });
  pass('login start-rate bound is enforced before contacting GitHub');
  console.log(`PASS ${checks} groups; retained test store: ${root}`);
} finally {
  await Promise.all(children.map(child => new Promise(yes => {
    if (child.exitCode !== null) return yes(); child.once('exit', yes); child.kill('SIGTERM');
  })));
}
