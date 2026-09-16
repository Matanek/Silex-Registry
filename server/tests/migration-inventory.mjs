import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { git, tagsFromRefs, treeEntries, inventoryRegistration, sha256 } from '../migration/inventory.mjs';
import { prepareVersion, sourceArchive } from '../migration/prepare.mjs';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { plan, satisfies } from '../migration/plan.mjs';

const root = await mkdtemp(resolve(tmpdir(), 'silex-inventory-'));
const repository = resolve(root, 'origin'), cache = resolve(root, 'git');
await mkdir(repository); await mkdir(cache);
await git(repository, 'init', '--quiet');
await git(repository, 'config', 'user.email', 'fixture@example.invalid');
await git(repository, 'config', 'user.name', 'Fixture');
const manifest = '{"name":"Example","version":"1.0.0","requires":{"silex":">=0.44.0"}}\n';
await writeFile(resolve(repository, 'Package.json'), manifest);
await writeFile(resolve(repository, '.gitattributes'), 'Retained.txt export-ignore\n');
await writeFile(resolve(repository, 'Retained.txt'), 'exact historical bytes\n');
await git(repository, 'add', 'Package.json', '.gitattributes', 'Retained.txt'); await git(repository, 'commit', '-qm', 'published');
await git(repository, 'tag', '-am', 'published', 'v1.0.0');
await git(repository, 'tag', 'asset-release');
await writeFile(resolve(repository, 'Package.json'), manifest.replace('1.0.0', '2.0.0'));
await git(repository, 'add', 'Package.json'); await git(repository, 'commit', '-qm', 'unpublished');
await git(repository, 'tag', 'v2.0.1'); // A real mismatch must remain reported.
const report = await inventoryRegistration({ name: 'Example', schema: 1, repository: 'https://github.com/example/package.git' }, cache, 'file://' + repository);
assert.equal(report.versions.length, 2);
assert.equal(report.versions[0].manifest, manifest);
assert.equal(report.versions[0].manifest_sha256, sha256(manifest));
assert.notEqual(report.versions[0].object, report.versions[0].commit);
assert.deepEqual(report.versions[0].issues, []);
assert.deepEqual(report.versions[1].issues, ['manifest_identity_mismatch']);
assert.equal(report.ignored_tags[0].tag, 'asset-release');
assert.throws(() => tagsFromRefs(Buffer.from('not a ref')));
assert.equal(treeEntries(Buffer.from('160000 commit ' + 'a'.repeat(40) + '       -\tSubmodule\0'))[0].type, 'commit');
assert.throws(() => treeEntries(Buffer.from([0xff])));
await writeFile(resolve(root, 'Example.json'), JSON.stringify({ ...report, registration_sha256: sha256(JSON.stringify(report.registration)) }));
const bundle = resolve(root, 'bundle'); await mkdir(bundle);
await prepareVersion(root, 'Example', '1.0.0', bundle);
const first = await readFile(resolve(bundle, 'Example@1.0.0.json'));
await prepareVersion(root, 'Example', '1.0.0', bundle);
assert.deepEqual(await readFile(resolve(bundle, 'Example@1.0.0.json')), first);
const descriptor = JSON.parse(first).descriptor;
assert(descriptor.files.some(f => f.path === 'Retained.txt'));
assert.equal(descriptor.manifest, manifest);
assert(gunzipSync(await readFile(resolve(bundle, 'objects', descriptor.source.sha256))).includes(Buffer.from('exact historical bytes')));
const longPath = 'long/'.repeat(30) + 'file.txt';
assert.equal(gunzipSync(sourceArchive([{ path: longPath, bytes: Buffer.from('x') }])).subarray(345, 494).toString().replace(/\0+$/, ''), longPath.slice(0, longPath.lastIndexOf('/')));
console.log('PASS inventory: annotated/lightweight tags, exact historical manifest, mismatch, ignored asset tags, unsafe entries');
console.log('PASS preparation: deterministic USTAR, long names, exact bytes including export-ignore files, no current checkout substitution');
assert(satisfies('0.22.0', '^0.16.5')); assert(!satisfies('1.0.0', '^0.16.5'));
assert(!satisfies('0.16.4', '^0.16.5')); assert(!satisfies('0.22.0', '=0.16.5'));
const route = plan([
  { name: 'A', version: '1.0.0', dependencies: { B: '=1.0.0' } },
  { name: 'B', version: '1.0.0' },
  { name: 'C', version: '1.0.0', dependencies: { D: '^1.0.0' } },
  { name: 'D', version: '1.0.0', dependencies: { C: '^1.0.0' } },
  { name: 'E', version: '1.0.0', dependencies: { Missing: '=1.0.0' } },
]);
assert.deepEqual(route.ordered, ['B@1.0.0', 'A@1.0.0']); assert.equal(route.blocked.length, 3);
console.log('PASS import plan: dependency-first order, exact/caret constraints, missing and cyclic closure reported');
