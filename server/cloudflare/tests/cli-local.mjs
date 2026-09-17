import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const group = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cli = resolve(group, 'Silex/Toolchain/zig-out/bin/silex');
const origin = process.env.PROBE_ORIGIN ?? 'http://127.0.0.1:8791';
const token = process.env.PROBE_TOKEN ?? 'a'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await mkdtemp(resolve(group, 'TestState/cloudflare-cli-'));
const producer = process.env.PROBE_AUTHOR_ROOT ?? resolve(root, 'producer');
const consumer = resolve(root, 'consumer');
const repository = process.env.PROBE_REPOSITORY ?? 'https://github.com/Silex-Test/Fixture';
const stamp = process.env.PROBE_RUN_ID ?? Date.now().toString(36);
const name = `CloudflareCli_${stamp}`;
const artifact = Buffer.from(`shared artifact ${stamp}\n`);
const artifactDigest = hash(artifact);

async function run(localRoot, args) {
  const { stdout, stderr } = await execute(cli, args, { cwd: group, timeout: 120000,
    env: { ...process.env, SILEX_DATA_ROOT: resolve(localRoot, 'silex-data'),
      SILEX_REGISTRY_TEST_ROOT: localRoot, SILEX_REGISTRY_TEST_URL: origin,
      SILEX_REGISTRY_V2: 'test' } });
  return stdout + stderr;
}

try {
  if (!process.env.PROBE_AUTHOR_ROOT) {
    await mkdir(resolve(producer, 'auth'), { recursive: true, mode: 0o700 });
    await writeFile(resolve(producer, 'auth/registry.json'), JSON.stringify({ token, github_id: '1001',
      login: 'probe-author', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });
  }
  assert.equal((await stat(resolve(producer, 'auth/registry.json'))).mode & 0o777, 0o600);
  await mkdir(consumer, { recursive: true, mode: 0o700 });
  for (const version of ['1.0.0', '1.0.1']) {
    const packageRoot = resolve(root, version, name);
    await mkdir(resolve(packageRoot, 'Module'), { recursive: true });
    await mkdir(resolve(packageRoot, 'Boundary/macos-arm64'), { recursive: true });
    await writeFile(resolve(packageRoot, 'Package.json'), JSON.stringify({ name, version, sources: 'Module',
      ...(version === '1.0.1' ? { repository } : {}),
      requires: { silex: '>=0.44.0' }, artifacts: { 'macos-arm64': { Shared: {
        path: 'Boundary/macos-arm64/libShared.a', sha256: artifactDigest } } } }));
    await writeFile(resolve(packageRoot, 'Module/Value.sx'), `public func answer() int { return ${version === '1.0.0' ? 41 : 40} }\n`);
    await writeFile(resolve(packageRoot, 'Boundary/macos-arm64/libShared.a'), artifact);
    if (version === '1.0.1') await mkdir(resolve(packageRoot, '.git'));
    if (version === '1.0.1') await writeFile(resolve(packageRoot, 'Module/Value.sx'), 'public func answer() int { return 42 }\n');
    const preview = await run(producer, ['publish', packageRoot, '--dry-run']);
    const previewDigest = /publication sha256 ([a-f0-9]{64})/.exec(preview)?.[1];
    assert.match(preview, /dry run for .* \(nothing uploaded\)/);
    assert.match(preview, /would publish this local snapshot: source files 2, separate artifacts 1/);
    assert.match(preview, /source files:[\s\S]*\+ Module\/Value\.sx/);
    assert.match(preview, /source files:[\s\S]*\+ Package\.json/);
    assert.match(preview, /separate artifacts:[\s\S]*\+ macos-arm64\/Shared <- Boundary\/macos-arm64\/libShared\.a/);
    if (version === '1.0.1') {
      assert.match(preview, /excluded:[\s\S]*- \.git\//);
      assert.match(preview, /development repository \(author-provided link\): https:\/\/github\.com\//);
    } else assert.doesNotMatch(preview, /development repository/);
    assert.match(preview, /no authentication, network request or publication was performed/);
    const published = await run(producer, ['publish', packageRoot]);
    assert.match(published, new RegExp(`published ${name}@${version.replaceAll('.', '\\.')}`));
    assert.equal(/sha256 ([a-f0-9]{64})\)/.exec(published)?.[1], previewDigest);
    const metadata = await fetch(`${origin}/v2/packages/${name}/versions/${version}`);
    assert.equal(metadata.status, 200);
    const publishedDescriptor = (await metadata.json()).descriptor;
    assert.equal(publishedDescriptor.provenance, undefined);
    assert.equal(JSON.parse(publishedDescriptor.manifest).repository,
      version === '1.0.1' ? repository : undefined);
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
  const inventory = await fetch(`${origin}/__probe/inventory`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(inventory.status, 200);
  const listed = await inventory.json();
  assert.equal(listed.objects.filter(object => object.key === `probe/objects/sha256/${artifactDigest}`).length, 1);
  console.log(JSON.stringify({ outcome: 'passed', cli, name, versions: ['1.0.0', '1.0.1'],
    artifact_sha256: artifactDigest, canonical_objects: 1, origin, consumer,
    consumer_execution: '42', repository: 'first package without Git; second with author-provided development link',
    author: process.env.PROBE_AUTHOR_ROOT ? 'real GitHub login' : 'probe token' }));
} finally {
  if (process.env.PROBE_KEEP_STATE !== '1') await rm(root, { recursive: true, force: true });
}
