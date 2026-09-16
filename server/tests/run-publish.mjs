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

async function runCandidate(base, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(silex, args, {
      cwd: group,
      env: { ...process.env, HOME: home, SILEX_REGISTRY_TEST_URL: base, SILEX_REGISTRY_TEST_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveResult(output) : reject(new Error(`Silex failed (${code}): ${output}`)));
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
  console.log(JSON.stringify({ root, base, packagePath, publication: version.publication_sha256 }));
  console.log('ok - candidate resumes after a committed chunk loses its response and publishes a modified no-Git package idempotently');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolveExit => server.once('exit', resolveExit));
  }
}
