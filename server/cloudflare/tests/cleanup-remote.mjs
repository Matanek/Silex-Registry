import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const runId = process.argv[2];
const apply = process.argv[3] === '--apply';
const storage = process.env.PROBE_STORAGE === 'local' ? 'local' : 'remote';
assert.match(runId ?? '', /^[A-Za-z0-9]+$/);
assert.ok(process.argv[3] === undefined || apply);
const origin = process.env.PROBE_ORIGIN;
const token = process.env.PROBE_TOKEN;
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:[0-9]+$/);
assert.match(token ?? '', /^[a-f0-9]{64}$/);
const group = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const receipt = resolve(group, `TestState/cloudflare-${storage}-cleanup-${runId}.json`);
const names = [
  `CloudflareProbe_${runId}`, `CloudflareProbe_${runId}_Other`, `CloudflareProbe_${runId}_Bad`,
  `CloudflareProbe_${runId}_Missing`, `CloudflareProbe_${runId}_Mismatch`, `CloudflareConcurrent_${runId}_A`,
  `CloudflareConcurrent_${runId}_B`, `CloudflareCli_${runId}`,
  `CloudflareDependency_${runId}`, `CloudflareDependent_${runId}`, `CloudflareDependent_${runId}_Bad`,
  `CloudflareRace_${runId}`, `CloudflareRetention_${runId}`,
  `CloudflareOrder_${runId}`,
  ...['before_object', 'after_object', 'before_visibility', 'after_visibility']
    .map(point => `CloudflareFault_${runId}_${point}`),
];
const quoted = names.map(name => `'${name}'`).join(',');

async function query(sql) {
  const { stdout } = await execute('./node_modules/.bin/wrangler', ['d1', 'execute', 'silex-registry-staging',
    `--${storage}`, '--command', sql, '--json'], { maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result[0]?.success, true);
  return result[0].results;
}
async function inventory() {
  const response = await fetch(`${origin}/__probe/inventory`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return response.json();
}
function referenced(row) {
  const value = JSON.parse(row.descriptor);
  return [value.source.sha256, ...value.artifacts.map(item => item.sha256)];
}

async function snapshot() {
  const allSessions = await query('SELECT id,name,descriptor FROM probe_sessions');
  const allVersions = await query('SELECT name,version,descriptor FROM probe_versions');
  const allOwners = await query('SELECT name,github_id FROM probe_names');
  const sessions = allSessions.filter(row => names.includes(row.name));
  const versions = allVersions.filter(row => names.includes(row.name));
  const owners = allOwners.filter(row => names.includes(row.name));
  const otherReferences = new Set([...allSessions.filter(row => !names.includes(row.name)),
    ...allVersions.filter(row => !names.includes(row.name))].flatMap(referenced));
  return { sessions, versions, owners, otherReferences };
}
let plan;
try { plan = JSON.parse(await readFile(receipt, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!plan) {
  const { sessions, versions, owners, otherReferences } = await snapshot();
  const candidates = new Set([...sessions, ...versions].flatMap(referenced));
  const sessionIds = new Set(sessions.map(row => row.id));
  const listing = await inventory();
  const objectKeys = listing.objects.filter(item => candidates.has(item.key.replace('probe/objects/sha256/', '')) &&
    !otherReferences.has(item.key.replace('probe/objects/sha256/', ''))).map(item => item.key);
  const uploadKeys = listing.uploads.filter(item => [...sessionIds].some(id => item.key.startsWith(`probe/uploads/${id}/`))).map(item => item.key);
  plan = { runId, origin, storage, names: versions.map(row => `${row.name}@${row.version}`),
    owners: owners.map(row => ({ name: row.name, github_id: row.github_id })), sessions: [...sessionIds],
    objectKeys, uploadKeys, retainedSharedDigests: [...candidates].filter(sha => otherReferences.has(sha)), applied: false };
  await writeFile(receipt, JSON.stringify(plan, null, 2));
}
assert.equal(plan.runId, runId);
assert.equal(plan.origin, origin);
assert.equal(plan.storage, storage);
assert.equal(plan.applied, false, 'cleanup already applied');
for (const key of plan.objectKeys) assert.match(key, /^probe\/objects\/sha256\/[a-f0-9]{64}$/);
for (const key of plan.uploadKeys) assert.ok(plan.sessions.some(id => key.startsWith(`probe/uploads/${id}/`)));
console.log(JSON.stringify({ phase: apply ? 'applying' : 'planned', receipt, versions: plan.names.length,
  owners: plan.owners.length,
  sessions: plan.sessions.length, canonicalObjects: plan.objectKeys.length, uploadChunks: plan.uploadKeys.length }));
if (!apply) process.exit(0);

const { sessions, versions, owners, otherReferences } = await snapshot();
assert.ok(sessions.every(row => plan.sessions.includes(row.id)), 'run sessions changed after planning');
assert.ok(versions.every(row => plan.names.includes(`${row.name}@${row.version}`)), 'run versions changed after planning');
assert.ok(owners.every(row => plan.owners.some(saved => saved.name === row.name && saved.github_id === row.github_id)),
  'run ownership changed after planning');
const objectKeys = plan.objectKeys.filter(key => !otherReferences.has(key.slice('probe/objects/sha256/'.length)));
const uploadKeys = plan.uploadKeys;
await query(`DELETE FROM probe_versions WHERE name IN (${quoted})`);
if (sessions.length) {
  const ids = sessions.map(row => `'${row.id}'`).join(',');
  await query(`DELETE FROM probe_chunks WHERE session_id IN (${ids})`);
  await query(`DELETE FROM probe_sessions WHERE id IN (${ids})`);
}
await query(`DELETE FROM probe_names WHERE name IN (${quoted})`);
const beforeDeletion = await inventory();
const present = new Set([...beforeDeletion.uploads, ...beforeDeletion.objects].map(item => item.key));
const pending = [...uploadKeys, ...objectKeys].filter(key => present.has(key));
for (let start = 0; start < pending.length; start += 4) {
  await Promise.all(pending.slice(start, start + 4).map(key =>
    execute('./node_modules/.bin/wrangler', ['r2', 'object', 'delete', `silex-registry-staging/${key}`,
      `--${storage}`, '--force'], { maxBuffer: 1024 * 1024 })));
}
const remainingSessions = await query(`SELECT id FROM probe_sessions WHERE name IN (${quoted})`);
const remainingVersions = await query(`SELECT name FROM probe_versions WHERE name IN (${quoted})`);
const remainingOwners = await query(`SELECT name FROM probe_names WHERE name IN (${quoted})`);
assert.equal(remainingSessions.length, 0);
assert.equal(remainingVersions.length, 0);
assert.equal(remainingOwners.length, 0);
const after = await inventory();
for (const key of [...uploadKeys, ...objectKeys]) {
  assert.ok(![...after.uploads, ...after.objects].some(item => item.key === key), `remaining R2 object ${key}`);
}
await writeFile(receipt, JSON.stringify({ ...plan, applied: true,
  retainedSharedDigests: [...new Set([...plan.retainedSharedDigests,
    ...plan.objectKeys.filter(key => !objectKeys.includes(key)).map(key => key.slice('probe/objects/sha256/'.length))])] }, null, 2));
console.log(JSON.stringify({ phase: 'cleaned', receipt, versions: plan.names.length,
  owners: plan.owners.length,
  sessions: plan.sessions.length, canonicalObjects: objectKeys.length, uploadChunks: uploadKeys.length }));
