// Private staging qualification. The local HTTP adapter verifies the staging
// certificate and exists only because the candidate CLI's test origin is loopback.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const group = dirname(repository);
const [cli, caPath, mode = 'probe'] = process.argv.slice(2);
assert(cli?.startsWith('/') && caPath?.startsWith('/'), 'Pass absolute CLI and staging certificate paths.');
assert(['probe', 'live'].includes(mode), 'Usage: run-staging-journey.mjs <silex> <ca-cert> [probe|live]');
assert.equal(process.cwd(), group, 'Run from the Spec Worktree group.');
process.umask(0o077);
const ca = await readFile(caPath);
const parent = resolve(group, 'TestState/staging-journey');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(`${parent}/run-`);
const producer = resolve(root, 'producer');
const consumer = resolve(root, 'consumer');
await mkdir(producer, { mode: 0o700 });
await mkdir(consumer, { mode: 0o700 });
const children = new Set();
let bridge, blocker, credential, output = '';
let groups = 0;
const pass = label => console.log(`ok ${++groups} - ${label}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = path => assert.rejects(access(path), { code: 'ENOENT' });

function command(localRoot, args, extra = {}, onData) {
  return new Promise((yes, no) => {
    const child = spawn(cli, args, { cwd: group, env: { ...process.env,
      HOME: localRoot, SILEX_DATA_ROOT: `${localRoot}/silex-data`,
      SILEX_REGISTRY_TEST_ROOT: localRoot, SILEX_REGISTRY_TEST_URL: `http://127.0.0.1:${bridge.address().port}`,
      SILEX_REGISTRY_V2: 'test', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let text = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('Staging command timed out.')); },
      args[0] === 'login' ? 960000 : 120000);
    const receive = bytes => {
      text += bytes; output += bytes;
      try { onData?.(text); } catch (error) { child.kill(); no(error); }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', error => { clearTimeout(timer); children.delete(child); no(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer); children.delete(child);
      if (code === 0) yes(text);
      else no(new Error(`Staging ${args[0]} failed (${code ?? signal}): ${text}`));
    });
  });
}

try {
  bridge = createServer((request, reply) => {
    const upstream = httpsRequest(`https://127.0.0.1:18765${request.url}`, {
      method: request.method, ca, headers: { ...request.headers, host: '127.0.0.1:18765' },
    }, response => { reply.writeHead(response.statusCode, response.headers); response.pipe(reply); });
    upstream.on('error', () => { reply.writeHead(502); reply.end(); });
    request.pipe(upstream);
  });
  await new Promise((yes, no) => { bridge.once('error', no); bridge.listen(0, '127.0.0.1', yes); });
  const base = `http://127.0.0.1:${bridge.address().port}`;
  console.log(JSON.stringify({ root, mode, registryHead: execFileSync('git',
    ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cli }));
  const probe = await fetch(`${base}/v2/session`);
  assert.equal(probe.status, 401);
  pass('verified TLS bridge reaches private staging; anonymous session is refused');
  if (mode === 'probe') console.log(`PASS ${groups} probe group; no GitHub consent requested; ${root}`);
  else {
    let announced = false;
    await command(producer, ['login', '--no-browser'], {}, text => {
      if (announced) return;
      const code = text.match(/enter ([A-Z0-9]+-[A-Z0-9]+)/);
      if (!code) return;
      announced = true;
      console.log(`ACTION: https://github.com/login/device — ${code[1]}`);
    });
    const credentialPath = `${producer}/auth/registry.json`;
    credential = JSON.parse(await readFile(credentialPath, 'utf8'));
    assert.match(credential.github_id, /^[1-9][0-9]*$/);
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    pass('real GitHub identity became a registry-only private access');

    const name = `StageJourney_${randomBytes(4).toString('hex')}`;
    const packageRoot = resolve(root, name);
    await mkdir(`${packageRoot}/Module`, { recursive: true });
    const manifest = JSON.stringify({ name, version: '1.0.0', requires: { silex: '>=0.44.0' } });
    const source = 'public func answer() int { return 42 }\n';
    await writeFile(`${packageRoot}/Package.json`, manifest);
    await writeFile(`${packageRoot}/Module/Value.sx`, source);
    await missing(`${packageRoot}/.git`);
    assert.match(await command(producer, ['publish', packageRoot]), new RegExp(`published ${name}@1\\.0\\.0`));
    const route = `/v2/packages/${name}/versions/1.0.0`;
    const versionResponse = await fetch(base + route);
    assert.equal(versionResponse.status, 200);
    const version = await versionResponse.json();
    assert.equal(version.descriptor.manifest, manifest);
    assert.equal(version.descriptor.files.find(file => file.path === 'Module/Value.sx').sha256, sha(source));
    pass('local package without Git published and read from staging');

    await command(producer, ['logout']);
    await missing(credentialPath);
    const session = await fetch(`${base}/v2/session`, { headers: { Authorization: `Bearer ${credential.token}` } });
    assert.equal(session.status, 401);
    await rename(packageRoot, resolve(root, 'retained-unavailable-origin'));
    pass('logout revoked the registry access without removing the published version');

    let outbound = 0;
    blocker = createServer((request, reply) => { outbound++; reply.writeHead(502); reply.end(); });
    blocker.on('connect', (request, socket) => { outbound++; socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    await new Promise((yes, no) => { blocker.once('error', no); blocker.listen(0, '127.0.0.1', yes); });
    const blocked = `http://127.0.0.1:${blocker.address().port}`;
    const sentinel = resolve(root, 'no-git');
    await mkdir(sentinel);
    await writeFile(`${sentinel}/git`, '#!/bin/sh\nprintf invoked > "$SILEX_JOURNEY_GIT_MARKER"\nexit 91\n');
    await chmod(`${sentinel}/git`, 0o700);
    const gitMarker = resolve(root, 'git-invoked');
    const anonymous = { PATH: `${sentinel}:${process.env.PATH}`, SILEX_JOURNEY_GIT_MARKER: gitMarker,
      SILEX_REGISTRY: 'https://github.invalid/v1/index.json',
      HTTP_PROXY: blocked, HTTPS_PROXY: blocked, ALL_PROXY: blocked,
      http_proxy: blocked, https_proxy: blocked, all_proxy: blocked };
    await missing(`${consumer}/silex-data`);
    await missing(`${consumer}/auth`);
    assert.match(await command(consumer, ['install', `${name}@1.0.0`], anonymous),
      new RegExp(`installed ${name}@1\\.0\\.0`));
    const installed = `${consumer}/silex-data/packages/${name}@1.0.0`;
    assert.equal(await readFile(`${installed}/Package.json`, 'utf8'), manifest);
    assert.equal(await readFile(`${installed}/Module/Value.sx`, 'utf8'), source);
    const app = resolve(root, 'App');
    await mkdir(app);
    await writeFile(`${app}/Package.json`, JSON.stringify({ sources: '.', dependencies: { [name]: '=1.0.0' } }));
    await writeFile(`${app}/Main.sx`, `use ${name}.Value\nfunc main() { print(Value.answer()) }\n`);
    assert.match(await command(consumer, ['run', `${app}/Main.sx`, '--backend', 'native', '--nocache'], anonymous),
      /(?:^|\n)42\r?\n/);
    await missing(gitMarker);
    await missing(`${consumer}/auth`);
    assert.equal(outbound, 0);
    assert(!output.includes(credential.token));
    pass('empty anonymous store installed and executed 42 without Git or origin access');
    await writeFile(`${root}/result.json`, JSON.stringify({ groups, github_id: credential.github_id,
      name, publication_sha256: version.publication_sha256, native_output: '42', outbound_requests: outbound }, null, 2));
    console.log(`PASS ${groups} groups; real GitHub consent on private staging; ${root}`);
  }
} catch (error) {
  const message = String(error?.message ?? error);
  console.error(credential?.token ? message.replaceAll(credential.token, '[redacted]') : message);
  process.exitCode = 1;
} finally {
  if (credential) {
    try { await command(producer, ['logout']); }
    catch { console.error('Cleanup: registry access may remain until its expiry.'); }
  }
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  if (blocker) { blocker.closeAllConnections(); await new Promise(yes => blocker.close(yes)); }
  if (bridge) { bridge.closeAllConnections(); await new Promise(yes => bridge.close(yes)); }
}
