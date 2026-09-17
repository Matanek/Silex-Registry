import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const group = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cli = resolve(group, 'Silex/Toolchain/zig-out/bin/silex');
const origin = process.env.PROBE_ORIGIN ?? 'http://127.0.0.1:8791';
const token = process.env.PROBE_TOKEN ?? 'a'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await mkdtemp(resolve(group, 'TestState/cloudflare-cli-'));
const producer = resolve(root, 'producer');
const consumer = resolve(root, 'consumer');
const stamp = process.env.PROBE_RUN_ID ?? Date.now().toString(36);
const name = `CloudflareCli_${stamp}`;
const artifact = Buffer.from(`shared artifact ${stamp}\n`);
const artifactDigest = hash(artifact);
const gitMarker = resolve(root, 'unexpected-git-call');
const sentinel = resolve(root, 'bin');

async function run(localRoot, args) {
  const { stdout, stderr } = await execute(cli, args, { cwd: group, timeout: 120000,
    env: { ...process.env, SILEX_DATA_ROOT: resolve(localRoot, 'silex-data'),
      SILEX_REGISTRY_TEST_ROOT: localRoot, SILEX_REGISTRY_TEST_URL: origin,
      SILEX_REGISTRY_V2: 'test',
      PATH: `${sentinel}${delimiter}${process.env.PATH ?? ''}` } });
  return stdout + stderr;
}

try {
  await mkdir(sentinel, { recursive: true });
  await writeFile(resolve(sentinel, 'git'), `#!/bin/sh\nprintf 'called' > '${gitMarker}'\nexit 93\n`, { mode: 0o700 });
  await mkdir(resolve(producer, 'auth'), { recursive: true, mode: 0o700 });
  await writeFile(resolve(producer, 'auth/registry.json'), JSON.stringify({ token, github_id: '1001',
    login: 'probe-author', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });
  assert.equal((await stat(resolve(producer, 'auth/registry.json'))).mode & 0o777, 0o600);
  await mkdir(consumer, { recursive: true, mode: 0o700 });
  for (const version of ['1.0.0', '1.0.1']) {
    const packageRoot = resolve(root, version, name);
    await mkdir(resolve(packageRoot, 'Module'), { recursive: true });
    await mkdir(resolve(packageRoot, 'Boundary/macos-arm64'), { recursive: true });
    await writeFile(resolve(packageRoot, 'Package.json'), JSON.stringify({ name, version, sources: 'Module',
      requires: { silex: '>=0.44.0' }, artifacts: { 'macos-arm64': { Shared: {
        path: 'Boundary/macos-arm64/libShared.a', sha256: artifactDigest } } } }));
    await writeFile(resolve(packageRoot, 'Module/Value.sx'), `public func answer() int { return ${version === '1.0.0' ? 41 : 42} }\n`);
    await writeFile(resolve(packageRoot, 'Boundary/macos-arm64/libShared.a'), artifact);
    const published = await run(producer, ['publish', packageRoot]);
    assert.match(published, new RegExp(`published ${name}@${version.replaceAll('.', '\\.')}`));
    const installed = await run(consumer, ['install', `${name}@${version}`]);
    assert.match(installed, new RegExp(`installed ${name}@${version.replaceAll('.', '\\.')}`));
    assert.deepEqual(await readFile(resolve(consumer, `silex-data/packages/${name}@${version}/Boundary/macos-arm64/libShared.a`)), artifact);
  }
  const app = resolve(root, 'App');
  await mkdir(app);
  await writeFile(resolve(app, 'Package.json'), JSON.stringify({ sources: '.', dependencies: { [name]: '=1.0.1' } }));
  await writeFile(resolve(app, 'Main.sx'), `use ${name}.Value\nfunc main() { print(Value.answer()) }\n`);
  const output = await run(consumer, ['run', resolve(app, 'Main.sx'), '--backend', 'native', '--nocache']);
  assert.match(output, /(?:^|\n)42\r?\n/);
  await assert.rejects(stat(gitMarker), { code: 'ENOENT' });
  const inventory = await fetch(`${origin}/__probe/inventory`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(inventory.status, 200);
  const listed = await inventory.json();
  assert.equal(listed.objects.filter(object => object.key === `probe/objects/sha256/${artifactDigest}`).length, 1);
  console.log(JSON.stringify({ outcome: 'passed', cli, name, versions: ['1.0.0', '1.0.1'],
    artifact_sha256: artifactDigest, canonical_objects: 1, origin, consumer,
    consumer_execution: '42', git_calls: 0 }));
} finally {
  if (process.env.PROBE_KEEP_STATE !== '1') await rm(root, { recursive: true, force: true });
}
