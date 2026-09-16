import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { git, sha256, treeEntries } from './inventory.mjs';

const execute = promisify(execFile);
export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export function sourceArchive(entries) {
  const blocks = [];
  for (const { path, bytes, mode } of entries) {
    assert(!path.includes('\0'), 'invalid_path');
    let name = path, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = [...path.matchAll(/\//g)].map(m => m.index).reverse()
        .find(i => Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100);
      assert(split !== undefined, 'unrepresentable_ustar_path');
      prefix = path.slice(0, split); name = path.slice(split + 1);
    }
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write(prefix, 345, 155);
    for (const [offset, length, value] of [[100, 8, mode === '100755' ? 493 : 420], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]]) {
      const octal = value.toString(8); assert(octal.length < length, 'tar_size_overflow');
      header.write(octal.padStart(length - 1, '0') + '\0', offset, length);
    }
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

// Fetching historical URLs is an offline operator responsibility, not an HTTP
// capability of the registry. Only public GitHub release URLs are supported.
export async function downloadArtifact(artifact, objects) {
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256), 'invalid_artifact_digest');
  assert(/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^\s?#]+$/.test(artifact.url), 'unsupported_artifact_origin');
  const path = resolve(objects, artifact.sha256);
  try {
    await stat(path);
    assert.equal(await fileDigest(path), artifact.sha256, 'cached_object_corrupt');
    return (await stat(path)).size;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path + '.partial';
  await execute('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '15', '--max-time', '180', '--max-filesize', '1073741824', '--output', temporary, artifact.url], { timeout: 190000 });
  assert.equal(await fileDigest(temporary), artifact.sha256, 'download_digest_mismatch');
  await rename(temporary, path);
  return (await stat(path)).size;
}

export async function prepareVersion(inventory, name, version, output, fetchArtifact = downloadArtifact) {
  assert(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name) && /^\d+\.\d+\.\d+$/.test(version), 'invalid_selection');
  const record = JSON.parse(await readFile(resolve(inventory, name + '.json')));
  const pinned = record.versions.find(v => v.version === version);
  assert(pinned && pinned.issues.length === 0, 'version_not_recoverable');
  const repository = resolve(inventory, 'git', name + '.git');
  // Verify the retained inventory against the commit, not just a list supplied
  // in a JSON file. Git attributes/export-ignore never filter historical bytes.
  assert.deepEqual(treeEntries(await git(repository, 'ls-tree', '-rlz', pinned.commit)), pinned.files, 'inventory_tree_mismatch');
  assert.equal(sha256(pinned.manifest), pinned.manifest_sha256, 'inventory_manifest_mismatch');
  assert(pinned.expanded_bytes <= 67108864 && pinned.files.length <= 10000, 'source_limits');
  const manifest = JSON.parse(pinned.manifest);
  assert.equal(manifest.name, name); assert.equal(manifest.version, version);
  const declared = Object.entries(manifest.artifacts ?? {}).flatMap(([target, entries]) =>
    Object.entries(entries).map(([artifactName, entry]) => ({ target, name: artifactName, ...entry })));
  const entries = [], files = [], artifacts = [], objects = resolve(output, 'objects');
  await mkdir(objects, { recursive: true });
  for (const file of pinned.files) {
    assert(file.type === 'blob' && ['100644', '100755'].includes(file.mode), 'unsupported_git_entry');
    const bytes = await git(repository, 'cat-file', 'blob', file.object);
    assert.equal(bytes.length, file.size, 'git_blob_size_mismatch');
    if (file.path === 'Package.json') assert.equal(bytes.toString('utf8'), pinned.manifest, 'git_manifest_mismatch');
    const artifact = declared.find(a => a.path === file.path);
    if (artifact) {
      assert.equal(sha256(bytes), artifact.sha256, 'tracked_artifact_mismatch');
      continue; // The same exact bytes are represented as a separate CAS object.
    }
    entries.push({ path: file.path, mode: file.mode, bytes });
    files.push({ path: file.path, size: bytes.length, sha256: sha256(bytes) });
  }
  const source = sourceArchive(entries), sourceHash = sha256(source);
  await writeFile(resolve(objects, sourceHash), source);
  const missing = [];
  for (const artifact of declared) {
    try {
      const size = await fetchArtifact(artifact, objects);
      artifacts.push({ target: artifact.target, name: artifact.name, path: artifact.path, size, sha256: artifact.sha256 });
    } catch (error) { missing.push({ target: artifact.target, name: artifact.name, sha256: artifact.sha256, url: artifact.url, error: error.message }); }
  }
  if (missing.length) throw new Error('unavailable_artifacts: ' + JSON.stringify(missing));
  const descriptor = { schema: 1, manifest: pinned.manifest, source: { size: source.length, sha256: sourceHash }, files, artifacts };
  const provenance = { registration: record.registration, registration_sha256: record.registration_sha256,
    tag: pinned.tag, tag_object: pinned.object, commit: pinned.commit, tree: pinned.tree,
    manifest_sha256: pinned.manifest_sha256, artifacts: declared };
  const filename = name + '@' + version + '.json';
  const bytes = JSON.stringify({ descriptor, provenance }, null, 2) + '\n';
  try { await writeFile(resolve(output, filename), bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(await readFile(resolve(output, filename), 'utf8'), bytes, 'existing_bundle_conflict');
  }
  return { name, version, source_bytes: source.length, artifact_bytes: artifacts.reduce((s, a) => s + a.size, 0), artifacts: artifacts.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 5) throw new Error('Usage: node prepare.mjs <inventory> <bundle-directory> <name@version>...');
  const output = resolve(process.argv[3]); await mkdir(output, { recursive: true });
  const report = { prepared: [], missing: [] };
  let selections = process.argv.slice(4);
  if (selections.length === 1 && selections[0] === '--all') {
    const inventory = JSON.parse(await readFile(resolve(process.argv[2], 'inventory.json')));
    selections = [];
    for (const entry of inventory.packages) {
      const record = JSON.parse(await readFile(resolve(process.argv[2], entry.name + '.json')));
      if (record.error) report.missing.push({ selection: entry.name, error: record.error });
      for (const version of record.versions) selections.push(entry.name + '@' + version.version);
    }
  }
  for (const selection of selections) {
    let prepared = false;
    try { report.prepared.push(await prepareVersion(resolve(process.argv[2]), ...selection.split('@'), output)); prepared = true; }
    catch (error) { report.missing.push({ selection, error: error.message }); }
    console.log(JSON.stringify({ selection, prepared, missing: report.missing.filter(m => m.selection === selection) }));
  }
  // A report is an observation; it is never used as authority to publish.
  await writeFile(resolve(output, 'preparation-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.missing.length) process.exitCode = 1;
}
