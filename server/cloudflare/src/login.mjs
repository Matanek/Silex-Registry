const encoder = new TextEncoder();
const ticketPattern = /^Login ([a-f0-9]{64})$/;
const bearerPattern = /^Bearer ([a-f0-9]{64})$/;
const codePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const loginPattern = /^[A-Za-z0-9-]{1,39}$/;
const clientPattern = /^[A-Za-z0-9_]{16,64}$/;
const devicePattern = /^[a-f0-9]{40}$/;

class LoginFailure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function insist(value, code, status = 422) {
  if (!value) throw new LoginFailure(status, code);
}
function hex(bytes) { return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
function randomHex(size) { return hex(crypto.getRandomValues(new Uint8Array(size))); }
function now() { return Math.floor(Date.now() / 1000); }
function bytesFromBase64(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
async function key(env) {
  insist(typeof env.LOGIN_KEY_B64 === 'string', 'login_not_initialized', 503);
  let bytes;
  try { bytes = bytesFromBase64(env.LOGIN_KEY_B64); } catch { throw new LoginFailure(503, 'invalid_login_key'); }
  insist(bytes.length === 32, 'invalid_login_key', 503);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, id, value) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: encoder.encode(id) }, await key(env), encoder.encode(value)));
  return base64(new Uint8Array([...nonce, ...encrypted]));
}
async function open(env, id, value) {
  try {
    const bytes = bytesFromBase64(value);
    insist(bytes.length > 28, 'invalid_login_state', 503);
    return new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM',
      iv: bytes.subarray(0, 12), additionalData: encoder.encode(id) }, await key(env), bytes.subarray(12)));
  } catch { throw new LoginFailure(503, 'invalid_login_state'); }
}
async function emptyBody(request) {
  insist(Number(request.headers.get('content-length') ?? 0) === 0, 'unexpected_body');
  if (!request.body) return;
  const reader = request.body.getReader();
  const first = await reader.read();
  await reader.cancel();
  insist(first.done || first.value.byteLength === 0, 'unexpected_body');
}
function ticket(request) {
  const match = ticketPattern.exec(request.headers.get('authorization') ?? '');
  insist(match, 'invalid_login_ticket', 401);
  return match[1];
}
function bearer(request) {
  const match = bearerPattern.exec(request.headers.get('authorization') ?? '');
  insist(match, 'unauthorized', 401);
  return match[1];
}
function view(row, timestamp) {
  const value = { id: row.id, state: row.state, expires_at: row.expires_at };
  if (row.state === 'pending') Object.assign(value, { user_code: row.user_code,
    verification_uri: 'https://github.com/login/device', interval: row.interval_seconds });
  if (['starting', 'pending', 'polling'].includes(row.state)) value.retry_after = Math.max(1, row.next_poll - timestamp);
  return value;
}
async function expire(db, timestamp) {
  await db.prepare("UPDATE probe_login_attempts SET state='expired',encrypted_device=NULL,user_code=NULL WHERE state IN ('starting','pending','polling') AND expires_at<=?").bind(timestamp).run();
  await db.prepare("UPDATE probe_login_attempts SET state='failed',encrypted_device=NULL,user_code=NULL WHERE state IN ('starting','polling') AND lease_until<=?").bind(timestamp).run();
}
async function row(db, id) {
  const result = await db.prepare('SELECT * FROM probe_login_attempts WHERE id=?').bind(id).first();
  insist(result, 'login_not_found', 404);
  return result;
}
async function githubCall(method, url, values, accessToken) {
  const headers = { accept: 'application/json', 'user-agent': 'Silex-Registry',
    'x-github-api-version': '2022-11-28' };
  if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let response;
  try { response = await fetch(url, { method, headers, redirect: 'manual',
    body: method === 'POST' ? new URLSearchParams(values) : undefined,
    signal: AbortSignal.timeout(10000) }); }
  catch { throw new LoginFailure(503, 'github_unavailable'); }
  insist(response.status === 200, 'github_unavailable', 503);
  insist(Number(response.headers.get('content-length') ?? 0) <= 32768, 'invalid_github_response', 503);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      insist(size <= 32768, 'invalid_github_response', 503);
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new LoginFailure(503, 'invalid_github_response'); }
}
async function githubBegin(env) {
  insist(clientPattern.test(env.GITHUB_CLIENT_ID ?? ''), 'invalid_github_application', 503);
  const value = await githubCall('POST', 'https://github.com/login/device/code',
    { client_id: env.GITHUB_CLIENT_ID, scope: '' });
  insist(!value.error, 'github_device_unavailable', 503);
  insist(devicePattern.test(value.device_code ?? '') && codePattern.test(value.user_code ?? '') &&
    value.verification_uri === 'https://github.com/login/device' &&
    Number.isSafeInteger(value.expires_in) && value.expires_in > 0 && value.expires_in <= 900 &&
    Number.isSafeInteger(value.interval) && value.interval > 0 && value.interval <= value.expires_in,
  'invalid_github_response', 503);
  return value;
}
async function githubPoll(env, device) {
  insist(clientPattern.test(env.GITHUB_CLIENT_ID ?? '') && devicePattern.test(device), 'invalid_github_application', 503);
  const result = await githubCall('POST', 'https://github.com/login/oauth/access_token', {
    client_id: env.GITHUB_CLIENT_ID, device_code: device,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (result.error) {
    if (result.error === 'slow_down') {
      insist(result.interval === undefined || Number.isSafeInteger(result.interval) && result.interval > 0 && result.interval <= 900,
        'invalid_github_response', 503);
      return { state: 'slow_down', interval: result.interval };
    }
    if (result.error === 'authorization_pending') return { state: 'pending' };
    if (result.error === 'access_denied') return { state: 'denied' };
    if (['expired_token', 'token_expired', 'incorrect_device_code'].includes(result.error)) return { state: 'expired' };
    throw new LoginFailure(503, 'github_authorization_unavailable');
  }
  insist(result.scope === '', 'github_excess_permissions', 403);
  insist(result.token_type === 'bearer' &&
    typeof result.access_token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(result.access_token),
  'invalid_github_response', 503);
  const user = await githubCall('GET', 'https://api.github.com/user', {}, result.access_token);
  insist(Number.isSafeInteger(user.id) && user.id > 0 && user.type === 'User' &&
    loginPattern.test(user.login ?? ''), 'invalid_github_identity', 503);
  return { state: 'authorized', github_id: String(user.id), login: user.login };
}
async function fail(db, id) {
  await db.prepare("UPDATE probe_login_attempts SET state='failed',encrypted_device=NULL,user_code=NULL WHERE id=? AND state IN ('starting','polling')").bind(id).run();
}
async function begin(request, env, github) {
  await emptyBody(request);
  const credential = ticket(request);
  const ticketDigest = await digest(`silex-login-ticket:${credential}`);
  const timestamp = now();
  await expire(env.DB, timestamp);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM probe_credentials WHERE expires_at<=?').bind(timestamp),
    env.DB.prepare('DELETE FROM probe_login_attempts WHERE created_at<? AND state NOT IN (\'starting\',\'pending\',\'polling\')').bind(timestamp - 86400),
    env.DB.prepare('DELETE FROM probe_login_rate WHERE minute<?').bind(Math.floor(timestamp / 60)),
  ]);
  const existing = await env.DB.prepare('SELECT * FROM probe_login_attempts WHERE ticket_digest=?').bind(ticketDigest).first();
  if (existing) return view(existing, timestamp);
  const count = await env.DB.prepare("SELECT count(*) AS total FROM probe_login_attempts WHERE state IN ('starting','pending','polling')").first();
  insist(count.total < 32, 'login_capacity', 429);
  const rate = await env.DB.prepare('INSERT INTO probe_login_rate(minute,starts) VALUES (?,1) ON CONFLICT(minute) DO UPDATE SET starts=starts+1 WHERE starts<10')
    .bind(Math.floor(timestamp / 60)).run();
  insist(rate.meta.changes === 1, 'login_rate_limit', 429);
  const id = randomHex(16);
  const created = await env.DB.prepare("INSERT OR IGNORE INTO probe_login_attempts(id,ticket_digest,state,created_at,expires_at,lease_until) VALUES (?,?,'starting',?,?,?)")
    .bind(id, ticketDigest, timestamp, timestamp + 900, timestamp + 30).run();
  if (created.meta.changes !== 1) {
    return view(await env.DB.prepare('SELECT * FROM probe_login_attempts WHERE ticket_digest=?').bind(ticketDigest).first(), now());
  }
  try {
    const device = await github.begin(env);
    const next = now();
    await env.DB.prepare("UPDATE probe_login_attempts SET state='pending',expires_at=?,interval_seconds=?,next_poll=?,encrypted_device=?,user_code=? WHERE id=? AND state='starting' AND lease_until>?")
      .bind(Math.min(timestamp + 900, next + device.expires_in), device.interval, next + device.interval,
        await seal(env, id, device.device_code), device.user_code, id, next).run();
    return view(await row(env.DB, id), next);
  } catch (error) { await fail(env.DB, id); throw error; }
}
async function poll(request, env, id, github) {
  await emptyBody(request);
  const credential = ticket(request);
  const ticketDigest = await digest(`silex-login-ticket:${credential}`);
  let current = await row(env.DB, id);
  insist(current.ticket_digest === ticketDigest, 'wrong_login_ticket', 403);
  const timestamp = now();
  await expire(env.DB, timestamp);
  current = await row(env.DB, id);
  if (current.state !== 'pending' || timestamp < current.next_poll) return view(current, timestamp);
  const claimed = await env.DB.prepare("UPDATE probe_login_attempts SET state='polling',lease_until=? WHERE id=? AND state='pending' AND next_poll<=? AND expires_at>?")
    .bind(timestamp + 30, id, timestamp, timestamp).run();
  if (claimed.meta.changes !== 1) return view(await row(env.DB, id), now());
  try {
    const result = await github.poll(env, await open(env, id, current.encrypted_device));
    const next = now();
    if (['pending', 'slow_down'].includes(result.state)) {
      const interval = Math.max(current.interval_seconds + (result.state === 'slow_down' ? 5 : 0), result.interval ?? 0);
      await env.DB.prepare("UPDATE probe_login_attempts SET state='pending',interval_seconds=?,next_poll=?,lease_until=0 WHERE id=? AND state='polling' AND lease_until>?")
        .bind(interval, next + interval, id, next).run();
      return view(await row(env.DB, id), next);
    }
    insist(['authorized', 'denied', 'expired'].includes(result.state), 'invalid_login_result', 503);
    if (result.state !== 'authorized') {
      await env.DB.prepare("UPDATE probe_login_attempts SET state=?,encrypted_device=NULL,user_code=NULL,lease_until=0 WHERE id=? AND state='polling'")
        .bind(result.state, id).run();
      return view(await row(env.DB, id), next);
    }
    const access = randomHex(32);
    const accessDigest = await digest(access);
    const expires = next + 86400;
    const outcome = await env.DB.batch([
      env.DB.prepare("UPDATE probe_login_attempts SET state='consumed',encrypted_device=NULL,user_code=NULL,lease_until=0 WHERE id=? AND state='polling' AND lease_until>?").bind(id, next),
      env.DB.prepare('INSERT INTO probe_identities(github_id,login) VALUES (?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login').bind(result.github_id, result.login),
      env.DB.prepare("INSERT OR IGNORE INTO probe_credentials(digest,github_id,expires_at,attempt_id) SELECT ?,?,?,id FROM probe_login_attempts WHERE id=? AND state='consumed'")
        .bind(accessDigest, result.github_id, expires, id),
    ]);
    if (outcome[0].meta.changes !== 1 || outcome[2].meta.changes !== 1) return view(await row(env.DB, id), next);
    return { id, state: 'authorized', token: access, expires_at: expires,
      github_id: result.github_id, login: result.login };
  } catch (error) { await fail(env.DB, id); throw error; }
}
async function session(request, env) {
  await emptyBody(request);
  const access = bearer(request);
  const accessDigest = await digest(access);
  if (request.method === 'DELETE') {
    await env.DB.prepare('UPDATE probe_credentials SET revoked=1 WHERE digest=?').bind(accessDigest).run();
    return { revoked: true };
  }
  const current = await env.DB.prepare('SELECT c.github_id,i.login,c.expires_at FROM probe_credentials c JOIN probe_identities i ON i.github_id=c.github_id WHERE c.digest=? AND c.revoked=0 AND c.expires_at>?')
    .bind(accessDigest, now()).first();
  insist(current, 'unauthorized', 401);
  return current;
}
export async function loginFetch(request, env, route, github = { begin: githubBegin, poll: githubPoll }) {
  const match = /^\/v2\/logins\/([a-f0-9]{32})$/.exec(route);
  if (!(route === '/v2/logins' && request.method === 'POST') &&
      !(match && request.method === 'POST') &&
      !(route === '/v2/session' && ['GET', 'DELETE'].includes(request.method))) return null;
  try {
    let value;
    if (route === '/v2/logins') value = await begin(request, env, github);
    else if (match) value = await poll(request, env, match[1], github);
    else value = await session(request, env);
    return Response.json(value, { headers: { 'cache-control': 'no-store',
      'content-encoding': 'identity', 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    const status = error instanceof LoginFailure ? error.status : 503;
    const code = error instanceof LoginFailure ? error.code : 'login_unavailable';
    return Response.json({ error: code, message: code.replaceAll('_', ' '),
      retryable: [429, 503].includes(status) }, { status, headers: { 'cache-control': 'no-store',
      'content-encoding': 'identity', 'x-content-type-options': 'nosniff' } });
  }
}
