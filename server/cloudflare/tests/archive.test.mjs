import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
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
