import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ArchiveFailure, verifySourceArchive } from '../src/archive.mjs';
import { archive } from './tar-fixture.mjs';

const digest = async bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.stringify({ name: 'ArchiveFixture', version: '1.0.0' });
const module = 'public func answer() int { return 42 }\n';
const files = [{ path: 'Package.json', size: Buffer.byteLength(manifest), sha256: await digest(manifest) },
  { path: 'Module/Value.sx', size: Buffer.byteLength(module), sha256: await digest(module) }];
const descriptor = { manifest, files };

test('admit the exact source snapshot and reject descriptor or archive substitution', async () => {
  await verifySourceArchive(archive([['Package.json', manifest], ['Module/Value.sx', module]]), descriptor, digest);
  const changed = archive([['Package.json', manifest], ['Module/Value.sx', module.replace('42', '41')]]);
  await assert.rejects(verifySourceArchive(changed, descriptor, digest),
    error => error instanceof ArchiveFailure && error.code === 'file_digest_mismatch');
  const foreign = archive([['Package.json', manifest], ['Module/Value.sx', module], ['Other.sx', 'x']]);
  await assert.rejects(verifySourceArchive(foreign, descriptor, digest),
    error => error instanceof ArchiveFailure && error.code === 'unexpected_tar_file');
  const alteredManifest = { ...descriptor, manifest: manifest.replace('1.0.0', '2.0.0') };
  await assert.rejects(verifySourceArchive(archive([['Package.json', manifest], ['Module/Value.sx', module]]),
    alteredManifest, digest), error => error instanceof ArchiveFailure && error.code === 'manifest_mismatch');
  await assert.rejects(verifySourceArchive(Buffer.from('not a gzip archive'), descriptor, digest),
    error => error instanceof ArchiveFailure && error.code === 'invalid_gzip');
});

test('admit standard USTAR checksums terminated by NUL and space', async () => {
  const tar = gunzipSync(archive([['Package.json', manifest], ['Module/Value.sx', module]]));
  for (const offset of [0, 1024]) {
    const checksum = Number.parseInt(tar.subarray(offset + 148, offset + 155).toString('ascii'), 8);
    tar.write(checksum.toString(8).padStart(6, '0'), offset + 148, 6, 'ascii');
    tar[offset + 154] = 0;
    tar[offset + 155] = 32;
  }
  await verifySourceArchive(gzipSync(tar, { mtime: 0 }), descriptor, digest);
  tar[155] = 33;
  await assert.rejects(verifySourceArchive(gzipSync(tar, { mtime: 0 }), descriptor, digest),
    error => error instanceof ArchiveFailure && error.code === 'invalid_tar_header');
});

test('admit a source snapshot above the former expanded staging bound', async () => {
  const modules = Array.from({ length: 4 }, (_, index) => [`Module/Part${index}.sx`, Buffer.alloc(9_201_566, 0x53)]);
  const item = { manifest, files: [files[0],
    ...await Promise.all(modules.map(async ([path, bytes]) => ({ path, size: bytes.length, sha256: await digest(bytes) })))] };
  await verifySourceArchive(archive([['Package.json', manifest], ...modules]), item, digest);
});
