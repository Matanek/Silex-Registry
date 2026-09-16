import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const group = dirname(repository);
const php = process.argv[2];
const silex = process.argv[3];
const packagePath = process.argv[4];
assert(php?.startsWith('/') && silex?.startsWith('/') && packagePath?.startsWith('/'),
  'Pass absolute paths to PHP, the candidate Silex executable and the package.');
assert.equal(process.cwd(), group, 'Run from the Spec Worktree group.');
await access(silex);
await assert.rejects(access(resolve(packagePath, '.git')));

const parent = resolve(group, 'TestState/server-publish');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(`${parent}/run-`);
const home = resolve(root, 'home');
const limits = { reserve: 1048576, capacity: 8388608, chunk: 4096, sessions: 100, grace: 1 };
const token = randomBytes(32).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let server;

function fixture(action, values = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(php, [`${repository}/server/tests/fixture.php`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`Fixture failed (${code}): ${errors}`));
      try { resolveResult(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ root, limits, action, ...values }));
  });
}

async function freePort() {
  const socket = createServer();
  await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes); });
  const number = socket.address().port;
  await new Promise(yes => socket.close(yes));
  return number;
}

async function runCandidate(base, args, extraEnvironment = {}, workingDirectory = group) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(silex, args, {
      cwd: workingDirectory,
      env: { ...process.env, HOME: home, SILEX_REGISTRY_TEST_URL: base, SILEX_REGISTRY_TEST_ROOT: root, ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveResult(output) : reject(new Error(`Silex ${args.join(' ')} failed (${code}): ${output}`)));
  });
}

async function start(router, extraEnvironment = {}) {
  const number = await freePort();
  const base = `http://127.0.0.1:${number}`;
  const child = spawn(php, ['-d', 'memory_limit=128M', '-S', `127.0.0.1:${number}`, '-t', `${repository}/server/public`, router],
    { env: { ...process.env, SILEX_REGISTRY_DATA: root, ...extraEnvironment }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server failed: ${errors}`);
    try { await fetch(base); return { child, base }; } catch {
      if (attempt === 99) throw new Error(`Server not ready: ${errors}`);
      await new Promise(yes => setTimeout(yes, 20));
    }
  }
}

try {
  await fixture('init');
  await fixture('identity', { id: '1001', login: 'author', token });
  await mkdir(resolve(root, 'auth'), { mode: 0o700 });
  await chmod(resolve(root, 'auth'), 0o700);
  await writeFile(resolve(root, 'auth/registry.json'), JSON.stringify({ token, github_id: '1001', login: 'author', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });
  await chmod(resolve(root, 'auth/registry.json'), 0o600);
  await mkdir(home, { mode: 0o700 });

  const preview = await runCandidate('http://127.0.0.1:1', ['publish', packagePath, '--dry-run']);
  assert.match(preview, /exclude Boundary\/linux-x64\/libLocalRuntime\.a \(declared artifact sent as a separate object\)/);
  assert.match(preview, /artifact linux-x64\/LocalRuntime -> Boundary\/linux-x64\/libLocalRuntime\.a/);

  const counter = resolve(root, 'publish-crash-counter');
  const crashing = await start(`${repository}/server/tests/publish-router.php`, { SILEX_PUBLISH_CRASH_COUNTER: counter });
  server = crashing.child;
  await assert.rejects(runCandidate(crashing.base, ['publish', packagePath]), /cannot contact the package registry/);
  if (server.exitCode === null && server.signalCode === null) await new Promise(resolveExit => server.once('exit', resolveExit));
  assert(server.signalCode || server.exitCode !== 0);

  const normal = await start(`${repository}/server/public/index.php`);
  server = normal.child;
  const base = normal.base;
  const first = await runCandidate(base, ['publish', packagePath]);
  assert.match(first, /silex: published LocalDemo@1\.0\.0/);
  const versionResponse = await fetch(`${base}/v2/packages/LocalDemo/versions/1.0.0`);
  assert.equal(versionResponse.status, 200);
  const version = await versionResponse.json();
  const paths = version.descriptor.files.map(file => file.path);
  assert.deepEqual(paths, ['Module/Content.sx', 'Module/Message.txt', 'Package.json', 'README.md']);
  const expectedMessage = await readFile(resolve(packagePath, 'Module/Message.txt'));
  const message = version.descriptor.files.find(file => file.path === 'Module/Message.txt');
  assert.equal(message.sha256, sha(expectedMessage));
  const sourceResponse = await fetch(`${base}/v2/packages/LocalDemo/versions/1.0.0/source`);
  assert.equal(sourceResponse.status, 200);
  const source = Buffer.from(await sourceResponse.arrayBuffer());
  assert.equal(sha(source), version.descriptor.source.sha256);
  assert.deepEqual(version.descriptor.artifacts.map(({ target, name, path }) => ({ target, name, path })), [{
    target: 'linux-x64', name: 'LocalRuntime', path: 'Boundary/linux-x64/libLocalRuntime.a',
  }]);
  const expectedArtifact = await readFile(resolve(packagePath, 'Boundary/linux-x64/libLocalRuntime.a'));
  const artifactResponse = await fetch(`${base}/v2/packages/LocalDemo/versions/1.0.0/artifacts/linux-x64/LocalRuntime`);
  assert.equal(artifactResponse.status, 200);
  assert.deepEqual(Buffer.from(await artifactResponse.arrayBuffer()), expectedArtifact);

  const second = await runCandidate(base, ['publish', packagePath]);
  assert.match(second, /silex: already published LocalDemo@1\.0\.0/);
  assert.match(second, new RegExp(version.publication_sha256));
  await assert.rejects(access(resolve(home, '.silex')));
  const anonymousHome = resolve(root, 'anonymous-home');
  await mkdir(anonymousHome, { mode: 0o700 });
  const anonymousData = resolve(root, 'anonymous-data');
  const sentinelDir = resolve(root, 'no-git');
  const gitMarker = resolve(root, 'git-invoked');
  await mkdir(sentinelDir);
  await writeFile(resolve(sentinelDir, 'git'), `#!/bin/sh\nprintf invoked > '${gitMarker}'\nexit 91\n`);
  await chmod(resolve(sentinelDir, 'git'), 0o700);
  const anonymousEnv = {
    HOME: anonymousHome, SILEX_DATA_ROOT: anonymousData, SILEX_REGISTRY_V2: 'test',
    SILEX_REGISTRY: 'https://github.invalid/v1/index.json',
    PATH: `${sentinelDir}:${process.env.PATH}`,
  };
  const installation = await runCandidate(base, ['install', 'LocalDemo@1.0.0', '--target', 'linux-x64'],
    anonymousEnv);
  assert.match(installation, /silex: installed LocalDemo@1\.0\.0/);
  const installed = resolve(anonymousData, 'packages/LocalDemo@1.0.0');
  assert.deepEqual(await readFile(resolve(installed, 'Module/Message.txt')), expectedMessage);
  assert.deepEqual(await readFile(resolve(installed, 'Boundary/linux-x64/libLocalRuntime.a')), expectedArtifact);
  const receipt = JSON.parse(await readFile(resolve(installed, '.silex/source.json'), 'utf8'));
  assert.equal(receipt.schema, 4);
  assert.equal(receipt.publication_sha256, version.publication_sha256);
  assert.deepEqual(receipt.dependencies, []);
  assert.deepEqual(receipt.artifacts.map(({ target, name, sha256 }) => [target, name, sha256]),
    [['linux-x64', 'LocalRuntime', sha(expectedArtifact)]]);
  const repeated = await runCandidate(base, ['install', 'LocalDemo@1.0.0', '--target', 'linux-x64'],
    anonymousEnv);
  assert.match(repeated, /silex: already installed LocalDemo@1\.0\.0/);

  const corruptHome = resolve(root, 'corrupt-home');
  await mkdir(corruptHome, { mode: 0o700 });
  const corruptData = resolve(root, 'corrupt-data');
  const corruptEnv = { HOME: corruptHome, SILEX_DATA_ROOT: corruptData, SILEX_REGISTRY_V2: 'test' };
  const sourceObject = resolve(root, 'objects', version.descriptor.source.sha256);
  await writeFile(sourceObject, Buffer.alloc(source.length, 0x41));
  try {
    await assert.rejects(runCandidate(base, ['install', 'LocalDemo@1.0.0', '--target', 'linux-x64'],
      corruptEnv), /source does not match its descriptor|public package registry/);
    await assert.rejects(access(resolve(corruptData, 'packages/LocalDemo@1.0.0')));
  } finally { await writeFile(sourceObject, source); }

  const artifactObject = resolve(root, 'objects', sha(expectedArtifact));
  await writeFile(artifactObject, Buffer.alloc(expectedArtifact.length, 0x42));
  try {
    await assert.rejects(runCandidate(base, ['install', 'LocalDemo@1.0.0', '--target', 'linux-x64'],
      corruptEnv), /cannot download or verify registry artifact/);
    await assert.rejects(access(resolve(corruptData, 'packages/LocalDemo@1.0.0')));
  } finally { await writeFile(artifactObject, expectedArtifact); }

  const interruptedData = resolve(root, 'interrupted-data');
  const marker = resolve(interruptedData, 'packages/.LocalDemo@1.0.0.installing');
  await mkdir(marker, { recursive: true });
  await assert.rejects(runCandidate(base, ['install', 'LocalDemo@1.0.0', '--target', 'linux-x64'],
    { HOME: anonymousHome, SILEX_DATA_ROOT: interruptedData, SILEX_REGISTRY_V2: 'test' }),
  /incomplete installation exists/);
  await access(marker);
  await assert.rejects(access(resolve(interruptedData, 'packages/LocalDemo@1.0.0')));

  const basePackage = resolve(root, 'Base');
  const rootPackage = resolve(root, 'Root');
  const app = resolve(root, 'App');
  await mkdir(resolve(basePackage, 'Module'), { recursive: true });
  await writeFile(resolve(basePackage, 'Package.json'), JSON.stringify({
    name: 'Base', version: '1.0.0', requires: { silex: '>=0.44.0' },
  }));
  await writeFile(resolve(basePackage, 'Module/Value.sx'), 'public func answer() int { return 41 }\n');
  await runCandidate(base, ['publish', basePackage]);
  await runCandidate(base, ['install', 'Base@1.0.0'], { SILEX_REGISTRY_V2: 'test' });

  const targetArtifact = Buffer.from('registry target artifact');
  await mkdir(resolve(rootPackage, 'Module'), { recursive: true });
  await mkdir(resolve(rootPackage, 'Boundary/macos-arm64'), { recursive: true });
  await writeFile(resolve(rootPackage, 'Boundary/macos-arm64/runtime.a'), targetArtifact);
  await writeFile(resolve(rootPackage, 'Package.json'), JSON.stringify({
    name: 'Root', version: '1.0.0', requires: { silex: '>=0.44.0' },
    dependencies: { Base: '=1.0.0' },
    artifacts: { 'macos-arm64': { Runtime: {
      path: 'Boundary/macos-arm64/runtime.a', sha256: sha(targetArtifact),
    } } },
  }));
  await writeFile(resolve(rootPackage, 'Module/Core.sx'),
    'use Base.Value\npublic func result() int { return Value.answer() + 1 }\n');
  await runCandidate(base, ['publish', rootPackage]);
  await mkdir(app, { recursive: true });
  await writeFile(resolve(app, 'Package.json'), JSON.stringify({ sources: '.', dependencies: { Root: '^1.0.0' } }));
  await writeFile(resolve(app, 'Main.sx'), 'use Root.Core\nfunc main() { print(Core.result()) }\n');
  const transitive = await runCandidate(base, ['install', 'Root@1.0.0', '--target', 'macos-arm64'],
    anonymousEnv, app);
  assert.match(transitive, /silex: installed Root@1\.0\.0/);
  await access(resolve(anonymousData, 'packages/Base@1.0.0/Module/Value.sx'));
  assert.deepEqual(await readFile(resolve(anonymousData,
    'packages/Root@1.0.0/Boundary/macos-arm64/runtime.a')), targetArtifact);
  const rootReceipt = JSON.parse(await readFile(resolve(anonymousData,
    'packages/Root@1.0.0/.silex/source.json'), 'utf8'));
  assert.deepEqual(rootReceipt.dependencies, [{ name: 'Base', version: '1.0.0' }]);
  assert.deepEqual(rootReceipt.artifacts.map(({ target, name, sha256 }) => [target, name, sha256]),
    [['macos-arm64', 'Runtime', sha(targetArtifact)]]);
  const rootReceiptPath = resolve(anonymousData, 'packages/Root@1.0.0/.silex/source.json');
  const alteredReceipt = structuredClone(rootReceipt);
  alteredReceipt.dependencies[0].version = '1.0.1';
  await writeFile(rootReceiptPath, JSON.stringify(alteredReceipt));
  await assert.rejects(runCandidate(base, ['packages', 'resolve', resolve(app, 'Main.sx')],
    anonymousEnv), /inconsistent dependency proof/);
  await writeFile(rootReceiptPath, JSON.stringify(rootReceipt));
  await assert.rejects(runCandidate(base, ['install', 'Root@1.0.0', '--target', 'linux-x64'],
    anonymousEnv), /does not match its source proof/);
  const lock = JSON.parse(await readFile(resolve(app, 'Silex.lock.json'), 'utf8'));
  assert.equal(lock.schema, 1);
  assert.deepEqual(lock.packages.map(({ name, version }) => [name, version]),
    [['Root', '1.0.0'], ['Base', '1.0.0']]);
  const lockPath = resolve(app, 'Silex.lock.json');
  const modifiedLock = structuredClone(lock);
  modifiedLock.packages[0].source_sha256 = '0'.repeat(64);
  await writeFile(lockPath, JSON.stringify(modifiedLock));
  await assert.rejects(runCandidate(base, ['packages', 'resolve', resolve(app, 'Main.sx')], anonymousEnv),
    /does not match Silex.lock.json/);
  await writeFile(lockPath, JSON.stringify(lock));

  const updatedPackage = resolve(root, 'Updated/Root');
  await mkdir(resolve(updatedPackage, 'Module'), { recursive: true });
  await mkdir(resolve(updatedPackage, 'Boundary/macos-arm64'), { recursive: true });
  await writeFile(resolve(updatedPackage, 'Boundary/macos-arm64/runtime.a'), targetArtifact);
  await writeFile(resolve(updatedPackage, 'Package.json'), JSON.stringify({
    name: 'Root', version: '1.1.0', requires: { silex: '>=0.44.0' },
    dependencies: { Base: '=1.0.0' },
    artifacts: { 'macos-arm64': { Runtime: {
      path: 'Boundary/macos-arm64/runtime.a', sha256: sha(targetArtifact),
    } } },
  }));
  await writeFile(resolve(updatedPackage, 'Module/Core.sx'),
    'use Base.Value\npublic func result() int { return Value.answer() + 2 }\n');
  await runCandidate(base, ['publish', updatedPackage]);
  await runCandidate(base, ['install', 'Root@1.1.0', '--target', 'macos-arm64'], anonymousEnv);
  const resolution = await runCandidate(base, ['packages', 'resolve', resolve(app, 'Main.sx')], anonymousEnv);
  assert.match(resolution, /Root 1\.0\.0 installed/);

  const linkedBase = resolve(root, 'LinkedBase');
  await mkdir(resolve(linkedBase, 'Module'), { recursive: true });
  await writeFile(resolve(linkedBase, 'Package.json'), JSON.stringify({
    name: 'Base', version: '1.0.0', requires: { silex: '>=0.44.0' },
  }));
  await writeFile(resolve(linkedBase, 'Module/Value.sx'), 'public func answer() int { return 51 }\n');
  await runCandidate(base, ['link', linkedBase, '--workspace', app], anonymousEnv);
  const linked = await runCandidate(base, ['packages', 'resolve', resolve(app, 'Main.sx')], anonymousEnv);
  assert.match(linked, /Base 1\.0\.0 workspace-link/);
  const linkedOutput = await runCandidate(base, ['run', resolve(app, 'Main.sx'), '--backend', 'native'], anonymousEnv);
  assert.match(linkedOutput, /52/);
  await runCandidate(base, ['unlink', 'Base', '--workspace', app], anonymousEnv);
  assert.deepEqual(JSON.parse(await readFile(resolve(app, 'Silex.lock.json'), 'utf8')), lock);
  const output = await runCandidate(base, ['run', resolve(app, 'Main.sx'), '--backend', 'native'],
    anonymousEnv);
  assert.match(output, /42/);
  await runCandidate(base, ['install', 'Root@1.0.0', '--target', 'macos-arm64'], anonymousEnv, app);
  assert.deepEqual(JSON.parse(await readFile(resolve(app, 'Silex.lock.json'), 'utf8')), lock);
  await runCandidate(base, ['install', 'Root@1.1.0', '--target', 'macos-arm64'], anonymousEnv, app);
  const refreshedLock = JSON.parse(await readFile(resolve(app, 'Silex.lock.json'), 'utf8'));
  assert.equal(refreshedLock.packages[0].version, '1.1.0');
  const updatedOutput = await runCandidate(base, ['run', resolve(app, 'Main.sx'), '--backend', 'native'], anonymousEnv);
  assert.match(updatedOutput, /43/);

  const suiteParent = resolve(root, 'Suite');
  const suiteChild = resolve(root, 'Suite.Plugin');
  await mkdir(resolve(suiteParent, 'Module'), { recursive: true });
  await writeFile(resolve(suiteParent, 'Package.json'), JSON.stringify({
    name: 'Suite', version: '1.0.0', requires: { silex: '>=0.44.0' },
    extensions: { 'Suite.Plugin': { friend: true, suite: true } },
  }));
  await writeFile(resolve(suiteParent, 'Module/Core.sx'), 'public func value() int { return 7 }\n');
  await runCandidate(base, ['publish', suiteParent]);
  await runCandidate(base, ['install', 'Suite@1.0.0'], { SILEX_REGISTRY_V2: 'test' });
  await mkdir(resolve(suiteChild, 'Module'), { recursive: true });
  await writeFile(resolve(suiteChild, 'Package.json'), JSON.stringify({
    name: 'Suite.Plugin', version: '1.0.0', requires: { silex: '>=0.44.0' },
    dependencies: { Suite: '=1.0.0' },
  }));
  await writeFile(resolve(suiteChild, 'Module/Extra.sx'), 'public func value() int { return 8 }\n');
  await runCandidate(base, ['publish', suiteChild]);
  const suiteData = resolve(root, 'suite-data');
  await runCandidate(base, ['install', 'Suite@1.0.0', '--suite'],
    { HOME: anonymousHome, SILEX_DATA_ROOT: suiteData, SILEX_REGISTRY_V2: 'test' });
  await access(resolve(suiteData, 'packages/Suite.Plugin@1.0.0/Module/Extra.sx'));

  const localDev = resolve(root, 'LocalDev');
  await mkdir(resolve(localDev, 'Module'), { recursive: true });
  await writeFile(resolve(localDev, 'Package.json'), JSON.stringify({
    name: 'LocalDev', version: '1.0.0', requires: { silex: '>=0.44.0' },
    devDependencies: { Base: '=1.0.0' },
  }));
  await writeFile(resolve(localDev, 'Module/Main.sx'), 'public func value() int { return 1 }\n');
  const devData = resolve(root, 'dev-data');
  await runCandidate(base, ['install', localDev, '--dev'],
    { HOME: anonymousHome, SILEX_DATA_ROOT: devData, SILEX_REGISTRY_V2: 'test' });
  await access(resolve(devData, 'packages/Base@1.0.0/Module/Value.sx'));
  await assert.rejects(access(gitMarker));
  console.log(JSON.stringify({ root, base, packagePath, publication: version.publication_sha256 }));
  console.log('ok - candidate resumes publication and anonymously installs exact source and target artifact from v2');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolveExit => server.once('exit', resolveExit));
  }
}
