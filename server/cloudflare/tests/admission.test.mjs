import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { acceptsDependency, descriptor } from '../src/worker.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const manifest = JSON.stringify({ name: 'AdmissionFixture', version: '1.0.0', sources: 'Module',
    requires: { silex: '>=0.44.0 <1.0.0' }, dependencies: { Core: '^1.2.0' },
    artifacts: { 'macos-arm64': { Shared: { path: 'Boundary/libShared.a', sha256: 'b'.repeat(64) } } } });
  return { schema: 1, manifest, source: { sha256: 'a'.repeat(64), size: 100 },
    files: [{ path: 'Package.json', size: Buffer.byteLength(manifest), sha256: sha(manifest) },
      { path: 'Module/Value.sx', size: 1, sha256: sha('x') }],
    artifacts: [{ target: 'macos-arm64', name: 'Shared', path: 'Boundary/libShared.a', size: 1,
      sha256: 'b'.repeat(64) }] };
}
function withManifest(value, change) {
  const updated = structuredClone(value);
  const manifest = JSON.parse(updated.manifest);
  change(manifest);
  updated.manifest = JSON.stringify(manifest);
  updated.files[0].size = Buffer.byteLength(updated.manifest);
  updated.files[0].sha256 = sha(updated.manifest);
  return updated;
}
function rejected(value, code) {
  assert.throws(() => descriptor(value), error => error.code === code);
}

test('admit a valid descriptor and reject unsafe or colliding source paths', () => {
  descriptor(fixture());
  for (const path of ['Module/CON.txt', 'Module/Value.', '.git/config', 'Module/..',
    'Module/Re\u0301sume\u0301.sx', 'Module/Name\\x.sx']) {
    const value = fixture();
    value.files[1].path = path;
    rejected(value, 'invalid_file');
  }
  const duplicate = fixture();
  duplicate.files[1].path = 'package.json';
  rejected(duplicate, 'path_collision');
  const ancestor = fixture();
  ancestor.files.push({ path: 'Module', size: 1, sha256: sha('x') });
  rejected(ancestor, 'path_collision');
  const unicode = fixture();
  unicode.files[1].path = 'Module/École.sx';
  unicode.files.push({ path: 'module/école.sx', size: 1, sha256: sha('x') });
  rejected(unicode, 'path_collision');
  const artifact = withManifest(fixture(), manifest => {
    manifest.artifacts['macos-arm64'].Shared.path = 'module/value.sx';
  });
  artifact.artifacts[0].path = 'module/value.sx';
  rejected(artifact, 'path_collision');
});

test('reject malformed requirements and dependency declarations before upload', () => {
  rejected(withManifest(fixture(), manifest => { manifest.version = '01.0.0'; }), 'invalid_identity');
  rejected(withManifest(fixture(), manifest => { manifest.requires.silex = '>=1.0.0 <0.44.0'; }), 'invalid_requirement');
  rejected(withManifest(fixture(), manifest => { manifest.dependencies.Core = '~1.2.0'; }), 'invalid_dependency');
  rejected(withManifest(fixture(), manifest => { manifest.dependencies.AdmissionFixture = '=1.0.0'; }), 'invalid_dependency');
  rejected(withManifest(fixture(), manifest => { manifest.devDependencies = { Core: '=1.2.0' }; }), 'invalid_dependency');
  rejected(withManifest(fixture(), manifest => { manifest.sources = '../outside'; }), 'invalid_sources');
  rejected(withManifest(fixture(), manifest => { manifest.artifacts = []; }), 'invalid_artifacts');
  rejected(withManifest(fixture(), manifest => { manifest.artifacts['macos-arm64'] = {}; }), 'invalid_artifacts');
  descriptor(withManifest(fixture(), manifest => { manifest.repository = 'https://github.com/Silex-Test/Fixture'; }));
  rejected(withManifest(fixture(), manifest => { manifest.repository = 'https://github.com/Silex-Test/Fixture/issues'; }), 'invalid_repository');
  rejected(withManifest(fixture(), manifest => { manifest.repository = 'https://example.com/Silex-Test/Fixture'; }), 'invalid_repository');
});

test('resolve caret dependencies with numeric version order', () => {
  assert.equal(acceptsDependency('^1.2.0', '1.10.0'), true);
  assert.equal(acceptsDependency('^1.2.0', '1.1.9'), false);
  assert.equal(acceptsDependency('^1.2.0', '2.0.0'), false);
  assert.equal(acceptsDependency('=1.10.0', '1.10.0'), true);
  assert.equal(acceptsDependency('=1.10.0', '1.2.0'), false);
});
