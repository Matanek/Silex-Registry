import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pruneSessions } from '../admin/prune-sessions.mjs';

const execute = promisify(execFile);
const cloudflare = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(cloudflare, 'node_modules/.bin/wrangler');
const origin = process.env.PROBE_ORIGIN;
const token = process.env.PROBE_TOKEN;
const runId = process.env.PROBE_RUN_ID;
assert.match(origin ?? '', /^https:\/\/silex-registry-staging-probe\.silex-lang\.workers\.dev$/);
assert.match(token ?? '', /^[a-f0-9]{64}$/);
assert.match(runId ?? '', /^[A-Za-z0-9]+$/);
const hash = value => createHash('sha256').update(value).digest('hex');
const id = hash(`retention:${runId}`).slice(0, 32);
const content = Buffer.from(`retention fixture ${runId}`);
const object = hash(`object:${runId}`);
const chunk = hash(content);
const key = `probe/uploads/${id}/${object}/0-${chunk}`;
const config = join(cloudflare, 'wrangler.toml');
const scratch = await mkdtemp(join(tmpdir(), 'silex-cloudflare-retention-'));
process.env.WRANGLER_LOG_PATH = join(scratch, 'wrangler.log');
async function command(args) {
  const { stdout } = await execute(wrangler, args, { cwd: cloudflare, maxBuffer: 1024 * 1024 });
  return stdout;
}
async function query(sql) {
  const result = JSON.parse(await command(['d1', 'execute', 'silex-registry-staging', '--remote',
    '--config', config, '--command', sql, '--json']));
  assert.equal(result[0].success, true);
  return result[0].results;
}
try {
  const existing = await query(`SELECT id FROM probe_sessions WHERE id='${id}'`);
  if (!existing.length) await query(`INSERT INTO probe_sessions VALUES ('${id}','__probe__','${hash(runId)}',` +
    `'CloudflareRetention_${runId}','1.0.0','{}',${Date.now() - 9 * 24 * 60 * 60 * 1000})`);
  const file = join(scratch, 'chunk');
  await writeFile(file, content);
  await command(['r2', 'object', 'put', `silex-registry-staging/${key}`, '--remote',
    '--config', config, '--file', file, '--force']);
  const expired = await fetch(`${origin}/v2/publications/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(expired.status, 410);
  const options = { origin, token, database: 'silex-registry-staging', bucket: 'silex-registry-staging',
    config, storage: 'remote', progress() {} };
  assert.equal((await pruneSessions(options)).sessions, 1);
  assert.equal((await pruneSessions({ ...options, apply: true })).sessions, 1);
  assert.equal((await query(`SELECT id FROM probe_sessions WHERE id='${id}'`)).length, 0);
  const response = await fetch(`${origin}/__probe/inventory`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.ok(!inventory.uploads.some(item => item.key === key));
  console.log(JSON.stringify({ retention: 'passed', runId, session: id, expiredStatus: 410,
    deletedUploadObjects: 1, remainingSessionRows: 0 }));
} finally { await rm(scratch, { recursive: true, force: true }); }
