import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { sourceArchive } from '../migration/prepare.mjs';
import { sha256 } from '../migration/inventory.mjs';
import { copySnapshot } from '../migration/copy-snapshot.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const group = dirname(repository), php = process.argv[2];
assert(php?.startsWith('/')); assert.equal(process.cwd(), group);
await mkdir(resolve(group, 'TestState/migration-tests'), { recursive: true });
const work = await mkdtemp(resolve(group, 'TestState/migration-tests/run-'));
const root = resolve(work, 'data'), registrations = resolve(work, 'registrations'), bundle = resolve(work, 'bundle');
const ownership = resolve(work, 'owners.json');
for (const path of [root, registrations, bundle, resolve(bundle, 'objects')]) await mkdir(path);
let checks = 0;
const pass = label => console.log(`ok ${++checks} - ${label}`);
function fixture(action, values = {}) {
  return new Promise((done, fail) => {
    const p = spawn(php, [resolve(repository, 'server/tests/migration-fixture.php')]);
    let output = '', errors = '';
    p.stdout.on('data', b => { output += b; }); p.stderr.on('data', b => { errors += b; }); p.on('error', fail);
    p.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' && values.crash) return done({ killed: true });
      if (code !== 0) return fail(new Error(errors + output));
      try { done(JSON.parse(output)); } catch (e) { fail(e); }
    });
    p.stdin.end(JSON.stringify({ action, root, registrations, bundle, ownership, ...values }));
  });
}
const registration = JSON.stringify({ schema: 1, name: 'Historical', repository: 'https://github.com/example/historical.git' });
await writeFile(resolve(registrations, 'Historical.json'), registration);
const owner = { name: 'Historical', repository: JSON.parse(registration).repository, registration_sha256: sha256(registration),
  github_id: '123', login: 'Original', evidence: 'Synthetic identity proof for the offline qualification fixture only.' };
await writeFile(ownership, JSON.stringify({ schema: 1, owners: [owner] }));
const artifact = Buffer.from('shared native data; never executed');
await writeFile(resolve(bundle, 'objects', sha256(artifact)), artifact);
async function publication(version) {
  const manifest = JSON.stringify({ name: 'Historical', version, requires: { silex: '>=0.44.0' }, artifacts: {
    'linux-x64': { Native: { path: 'Boundary/linux/runtime.a', sha256: sha256(artifact) } },
    'macos-arm64': { Native: { path: 'Boundary/mac/runtime.a', sha256: sha256(artifact) } },
  } });
  const bytes = Buffer.from(manifest), source = sourceArchive([{ path: 'Package.json', bytes }]);
  await writeFile(resolve(bundle, 'objects', sha256(source)), source);
  const descriptor = { schema: 1, manifest, source: { size: source.length, sha256: sha256(source) },
    files: [{ path: 'Package.json', size: bytes.length, sha256: sha256(bytes) }],
    artifacts: [{ target: 'linux-x64', name: 'Native', path: 'Boundary/linux/runtime.a', size: artifact.length, sha256: sha256(artifact) },
      { target: 'macos-arm64', name: 'Native', path: 'Boundary/mac/runtime.a', size: artifact.length, sha256: sha256(artifact) }] };
  const provenance = { registration: JSON.parse(registration), registration_sha256: sha256(registration), tag: 'v' + version,
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), tag_object: 'c'.repeat(40), manifest_sha256: sha256(bytes) };
  await writeFile(resolve(bundle, 'Historical@' + version + '.json'), JSON.stringify({ descriptor, provenance }));
}
await publication('1.0.0'); await publication('1.0.1');
assert.deepEqual(await fixture('init'), {});
const objectPath = resolve(bundle, 'objects', sha256(artifact));
await rename(objectPath, objectPath + '.missing');
assert.equal((await fixture('import', { selections: ['Historical@1.0.0'] })).error, 'bundle_object_corrupt');
await rename(objectPath + '.missing', objectPath);
pass('missing foreign-target bytes reject the lot before ownership changes');

const selections = ['Historical@1.0.0', 'Historical@1.0.1'];
const first = await fixture('import', { selections }); assert.equal(first.length, 2);
assert.deepEqual(await fixture('import', { selections }), first);
let state = await fixture('inspect'); assert.equal(state.versions.length, 2); assert.equal(state.objects.length, 3);
assert.equal(state.live_credentials, 0);
pass('repeat import is immutable and two versions/targets share one physical artifact');

await publication('1.0.2');
assert.deepEqual(await fixture('import', { selections: ['Historical@1.0.2'], crash: 'after_bytes' }), { killed: true });
assert.equal((await fixture('inspect')).versions.length, 2);
assert.equal((await fixture('import', { selections: ['Historical@1.0.2'] })).length, 1);
assert.equal((await fixture('inspect')).versions.length, 3);
pass('SIGKILL after a durable upload write resumes without partial visibility or duplication');

await fixture('rename');
await writeFile(ownership, JSON.stringify({ schema: 1, owners: [{ ...owner, github_id: '456' }] }));
assert.equal((await fixture('import', { selections })).error, 'ownership_conflict');
await writeFile(ownership, JSON.stringify({ schema: 1, owners: [owner] }));
assert.equal((await fixture('import', { selections })).length, 2);
pass('same login with a different stable GitHub ID cannot take a historical name');

const recordPath = resolve(bundle, 'Historical@1.0.0.json'); const recordBytes = await readFile(recordPath);
const modified = JSON.parse(recordBytes); modified.provenance.commit = 'd'.repeat(40);
await writeFile(recordPath, JSON.stringify(modified));
assert.equal((await fixture('import', { selections })).error, 'migration_provenance_conflict');
await writeFile(recordPath, recordBytes);
pass('historical provenance cannot be silently replaced');

const token = randomBytes(32).toString('hex'); await fixture('credential', { token });
const snapshot = resolve(work, 'snapshot'), restored = resolve(work, 'restored');
const backup = await fixture('snapshot', { destination: snapshot }); assert(backup.manifest_sha256);
assert.equal((await fixture('verify', { snapshot, digest: backup.manifest_sha256 })).verified, true);
const copied = resolve(work, 'copied');
assert.equal((await copySnapshot(snapshot, copied, backup.manifest_sha256)).files, backup.files);
assert.equal((await fixture('verify', { snapshot: copied, digest: backup.manifest_sha256 })).verified, true);
await assert.rejects(copySnapshot(snapshot, copied, backup.manifest_sha256));
await assert.rejects(copySnapshot(snapshot, resolve(work, 'wrong-digest'), '0'.repeat(64)), /snapshot_manifest_mismatch/);
assert.equal((await fixture('restore', { snapshot, destination: restored, digest: backup.manifest_sha256 })).restored_files, backup.files);
const before = await fixture('inspect'), after = await fixture('inspect', { root: restored });
for (const key of ['names', 'versions', 'owners', 'provenance', 'objects']) assert.deepEqual(after[key], before[key]);
assert.equal(after.live_credentials, 0);
assert.equal((await fixture('access', { root: restored, token })).error, 'unauthorized');
assert.equal((await fixture('import', { root: restored, selections })).length, 2);
assert.equal((await fixture('restore', { snapshot, destination: restored, digest: backup.manifest_sha256 })).error, 'destination_exists');
pass('restoration preserves exact versions/rights, revokes old sessions and never overwrites an instance');

const badObject = resolve(snapshot, 'objects', sha256(artifact)); await writeFile(badObject, Buffer.from('corrupt'));
assert.equal((await fixture('restore', { snapshot, destination: resolve(work, 'refused'), digest: backup.manifest_sha256 })).error, 'snapshot_file_corrupt');
assert(!(await readdir(work)).includes('refused'));
assert.equal((await fixture('verify', { snapshot, digest: '0'.repeat(64) })).error, 'snapshot_manifest_mismatch');
pass('corrupt object or wrong snapshot digest refuses restoration before creating a destination');
const corruptCopy = resolve(work, 'corrupt-copy');
await assert.rejects(copySnapshot(snapshot, corruptCopy, backup.manifest_sha256), /snapshot_size_mismatch|snapshot_file_corrupt/);
await assert.rejects(readFile(resolve(corruptCopy, 'snapshot.json')));
pass('private snapshot transport verifies each byte, refuses overwrite and never seals a corrupt copy');
console.log(`${checks} migration/snapshot groups passed. Evidence: ${work}`);
