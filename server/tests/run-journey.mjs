// Qualification locale uniquement ; aucun service ou compte de production.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const group = dirname(repository);
const [php, cli, mode = 'offline', clientId] = process.argv.slice(2);
assert(php?.startsWith('/') && cli?.startsWith('/'), 'Pass absolute PHP and candidate CLI paths.');
assert.equal(process.cwd(), group, 'Run from the Spec Worktree group.');
assert(mode === 'offline' || (mode === 'live' && /^[A-Za-z0-9]{10,64}$/.test(clientId ?? '')),
  'Usage: run-journey.mjs <php> <silex> [offline | live <public-client-id>]');
assert.equal(process.platform, 'darwin', 'This host journey is qualified on macOS ARM64 only.');
assert.equal(process.arch, 'arm64');
process.umask(0o077);
const parent = resolve(group, 'TestState/journey');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(`${parent}/run-`);
const producer = resolve(root, 'producer'), consumer = resolve(root, 'consumer');
const data = resolve(root, 'server'), restored = resolve(root, 'restored');
for (const path of [producer, consumer, data]) await mkdir(path, { mode: 0o700 });
const children = new Set();
let server, base, credential, proxy, output = '';
let checks = 0;
const pass = label => console.log(`ok ${++checks} - ${label}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = path => assert.rejects(access(path), { code: 'ENOENT' });
const phpCommand = args => execFileSync(php, args, { encoding: 'utf8', timeout: 30000 });
function fixture(action, values = {}) {
  return JSON.parse(execFileSync(php, [`${repository}/server/tests/login-fixture.php`], {
    input: JSON.stringify({ root: data, action, ...values }), encoding: 'utf8', timeout: 10000,
  }));
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(yes => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); yes(); });
    child.kill('SIGTERM');
  });
}
async function start(store, provider) {
  const socket = createSocket();
  await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes); });
  const port = socket.address().port;
  await new Promise(yes => socket.close(yes));
  const env = { ...process.env, SILEX_REGISTRY_DATA: store };
  delete env.SILEX_GITHUB_CLIENT_ID;
  if (provider === 'live') env.SILEX_GITHUB_CLIENT_ID = clientId;
  const router = provider === 'offline' ? 'tests/login-router.php' : 'public/index.php';
  server = spawn(php, ['-d', 'memory_limit=128M', '-S', `127.0.0.1:${port}`,
    '-t', `${repository}/server/public`, `${repository}/server/${router}`],
  { env, stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(server);
  server.on('error', () => {});
  base = `http://127.0.0.1:${port}`;
  for (let retry = 0; retry < 100; retry++) {
    if (server.exitCode !== null) throw new Error('Qualification HTTP server exited.');
    try { await fetch(base, { signal: AbortSignal.timeout(1000) }); return; }
    catch { await new Promise(yes => setTimeout(yes, 30)); }
  }
  throw new Error('Qualification HTTP server did not start.');
}
function command(localRoot, args, extra = {}, onData) {
  return new Promise((yes, no) => {
    const child = spawn(cli, args, { cwd: group, env: { ...process.env,
      HOME: localRoot, SILEX_DATA_ROOT: `${localRoot}/silex-data`,
      SILEX_REGISTRY_TEST_ROOT: localRoot, SILEX_REGISTRY_TEST_URL: base,
      SILEX_REGISTRY_V2: 'test', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let text = '';
    const timeout = mode === 'live' && args[0] === 'login' ? 960000 : 120000;
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('Journey command timed out.')); }, timeout);
    function receive(bytes) {
      text += bytes; output += bytes;
      try { onData?.(text); } catch (error) { child.kill(); no(error); }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', error => { clearTimeout(timer); children.delete(child); no(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer); children.delete(child);
      if (code === 0) yes(text);
      else no(new Error(`Journey ${args[0]} failed (${code ?? signal}): ${text}`));
    });
  });
}

try {
  console.log(JSON.stringify({ root, mode, cli, registryHead: execFileSync('git',
    ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }));
  if (mode === 'offline') fixture('init');
  else {
    phpCommand([`${repository}/server/bin/storage.php`, 'init', data]);
    phpCommand([`${repository}/server/bin/storage.php`, 'login-init', data]);
  }
  await start(data, mode);
  let announced = false;
  await command(producer, ['login', '--no-browser'], {}, text => {
    if (announced) return;
    if (mode === 'offline') {
      const code = text.match(/enter (TEST-\d{4})/);
      if (!code) return;
      announced = true;
      fixture('configure', { user_code: code[1], state: 'authorized' });
      fixture('tick', { seconds: 5 });
    } else {
      const code = text.match(/enter ([A-Z0-9]+-[A-Z0-9]+)/);
      if (!code) return;
      announced = true;
      console.log(`ACTION: https://github.com/login/device — ${code[1]}`);
    }
  });
  const credentialPath = `${producer}/auth/registry.json`;
  credential = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.match(credential.github_id, /^[1-9][0-9]*$/);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  if (mode === 'offline') assert.equal(credential.github_id, '1001');
  pass(`CLI identity established (${mode}); registry-only private access`);

  const packageRoot = resolve(root, 'JourneyExample');
  await mkdir(`${packageRoot}/Module`, { recursive: true });
  const manifest = JSON.stringify({ name: 'JourneyExample', version: '1.0.0', requires: { silex: '>=0.44.0' } });
  const source = 'public func answer() int { return 42 }\n';
  await writeFile(`${packageRoot}/Package.json`, manifest);
  await writeFile(`${packageRoot}/Module/Value.sx`, source);
  await missing(`${packageRoot}/.git`);
  assert.match(await command(producer, ['publish', packageRoot]), /published JourneyExample@1\.0\.0/);
  const route = '/v2/packages/JourneyExample/versions/1.0.0';
  const response = await fetch(base + route);
  assert.equal(response.status, 200);
  const version = await response.json();
  assert.equal(version.descriptor.manifest, manifest);
  const sourceFile = version.descriptor.files.find(file => file.path === 'Module/Value.sx');
  assert.equal(sourceFile.sha256, sha(source));
  pass('local package without Git published through the authenticated CLI');

  const snapshot = resolve(root, 'snapshot');
  const saved = JSON.parse(phpCommand([`${repository}/server/bin/snapshot.php`, 'create', data, snapshot]));
  await command(producer, ['logout']);
  await missing(credentialPath);
  const session = () => fetch(`${base}/v2/session`, {
    headers: { Authorization: `Bearer ${credential.token}` },
  });
  assert.equal((await session()).status, 401);
  await stop(server);
  phpCommand([`${repository}/server/bin/snapshot.php`, 'restore', snapshot, restored, saved.manifest_sha256]);
  await start(restored, 'disabled');
  assert.equal((await session()).status, 401);
  assert.deepEqual(await (await fetch(base + route)).json(), version);
  // The original local directory cannot satisfy consumer resolution anymore.
  await rename(packageRoot, resolve(root, 'retained-unavailable-origin'));
  pass('snapshot restored with identical publication; revoked access cannot revive');

  let outbound = 0;
  proxy = createServer((request, reply) => { outbound++; reply.writeHead(502); reply.end(); });
  proxy.on('connect', (request, socket) => { outbound++; socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise((yes, no) => { proxy.once('error', no); proxy.listen(0, '127.0.0.1', yes); });
  const blocked = `http://127.0.0.1:${proxy.address().port}`;
  const sentinel = resolve(root, 'no-git');
  await mkdir(sentinel);
  await writeFile(`${sentinel}/git`, '#!/bin/sh\nprintf invoked > "$SILEX_JOURNEY_GIT_MARKER"\nexit 91\n');
  await chmod(`${sentinel}/git`, 0o700);
  const gitMarker = resolve(root, 'git-invoked');
  const anonymous = { PATH: `${sentinel}:${process.env.PATH}`, SILEX_JOURNEY_GIT_MARKER: gitMarker,
    SILEX_REGISTRY: 'https://github.invalid/v1/index.json',
    HTTP_PROXY: blocked, HTTPS_PROXY: blocked, ALL_PROXY: blocked,
    http_proxy: blocked, https_proxy: blocked, all_proxy: blocked,
    NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  await missing(`${consumer}/silex-data`);
  await missing(`${consumer}/auth`);
  assert.match(await command(consumer, ['install', 'JourneyExample@1.0.0'], anonymous),
    /installed JourneyExample@1\.0\.0/);
  const installed = `${consumer}/silex-data/packages/JourneyExample@1.0.0`;
  assert.equal(await readFile(`${installed}/Package.json`, 'utf8'), manifest);
  assert.equal(await readFile(`${installed}/Module/Value.sx`, 'utf8'), source);
  const app = resolve(root, 'App');
  await mkdir(app);
  await writeFile(`${app}/Package.json`, JSON.stringify({ sources: '.', dependencies: { JourneyExample: '=1.0.0' } }));
  await writeFile(`${app}/Main.sx`, 'use JourneyExample.Value\nfunc main() { print(Value.answer()) }\n');
  const result = await command(consumer, ['run', `${app}/Main.sx`, '--backend', 'native', '--nocache'], anonymous);
  assert.match(result, /(?:^|\n)42\r?\n/);
  await missing(gitMarker);
  await missing(`${consumer}/auth`);
  assert.equal(outbound, 0, 'No origin request is necessary to install or compile.');
  assert(!output.includes(credential.token));
  pass('empty anonymous store installs exact bytes and executes 42 without Git or origin requests');
  await writeFile(`${root}/result.json`, JSON.stringify({ mode, checks, github_id: credential.github_id,
    publication_sha256: version.publication_sha256, snapshot_sha256: saved.manifest_sha256,
    target: 'macos-arm64', native_output: '42', outbound_requests: outbound }, null, 2));
  console.log(`PASS ${checks} groups; ${mode === 'live' ? 'real GitHub consent' : 'simulated GitHub only'}; ${root}`);
} catch (error) {
  const message = String(error?.message ?? error);
  console.error(credential?.token ? message.replaceAll(credential.token, '[redacted]') : message);
  process.exitCode = 1;
} finally {
  // On any failure, remove/revoke an issued access through the CLI if possible.
  if (credential) {
    try { await command(producer, ['logout']); } catch { console.error('Cleanup: access may remain in the private test store until expiry.'); }
  }
  await Promise.all([...children].map(stop));
  if (proxy) { proxy.closeAllConnections(); await new Promise(yes => proxy.close(yes)); }
}
