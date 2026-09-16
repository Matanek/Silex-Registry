import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest } from '../migration/prepare.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), group = dirname(repository);
const [php, silex, data, bundle] = process.argv.slice(2);
assert.equal(process.cwd(), group);
for (const path of [php, silex, data, bundle]) assert(path?.startsWith('/'));
await mkdir(resolve(group, 'TestState/migrated-install'), { recursive: true });
const work = await mkdtemp(resolve(group, 'TestState/migrated-install/run-'));
const sentinel = resolve(work, 'no-git'), marker = resolve(work, 'git-invoked');
await mkdir(sentinel);
await writeFile(resolve(sentinel, 'git'), `#!/bin/sh\nprintf invoked > '${marker}'\nexit 91\n`);
await chmod(resolve(sentinel, 'git'), 0o700);
const socket = createServer(); await new Promise(yes => socket.listen(0, '127.0.0.1', yes));
const port = socket.address().port; await new Promise(yes => socket.close(yes));
const base = `http://127.0.0.1:${port}`;
const server = spawn(php, ['-d', 'memory_limit=128M', '-S', `127.0.0.1:${port}`, '-t', resolve(repository, 'server/public'), resolve(repository, 'server/public/index.php')],
  { env: { ...process.env, SILEX_REGISTRY_DATA: data }, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = ''; server.stderr.on('data', b => { logs += b; });
async function install(selection, target, state) {
  return new Promise((done, fail) => {
    const p = spawn(silex, ['install', selection, '--target', target], {
      cwd: group, env: { ...process.env, HOME: resolve(state, 'home'), SILEX_DATA_ROOT: resolve(state, 'data'),
        SILEX_REGISTRY_V2: 'test', SILEX_REGISTRY_TEST_ROOT: state, SILEX_REGISTRY_TEST_URL: base,
        SILEX_REGISTRY: 'https://github.invalid/v1/index.json', PATH: `${sentinel}:${process.env.PATH}`,
        HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
        https_proxy: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', all_proxy: 'http://127.0.0.1:1',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; p.stdout.on('data', b => { output += b; }); p.stderr.on('data', b => { output += b; }); p.on('error', fail);
    p.on('exit', code => code === 0 ? done(output) : fail(new Error(output)));
  });
}
try {
  for (let i = 0; ; i++) {
    try { await fetch(base); break; } catch { if (i >= 100 || server.exitCode !== null) throw new Error(logs); await new Promise(yes => setTimeout(yes, 20)); }
  }
  for (const target of ['macos-arm64', 'macos-x64', 'linux-arm64', 'linux-x64', 'windows-arm64', 'windows-x64']) {
    const state = resolve(work, target); await mkdir(state); await mkdir(resolve(state, 'home'));
    await install('JSON@0.2.2', target, state); await install('GFX@0.40.0', target, state);
    for (const selection of ['STD@0.22.0', 'JSON@0.2.2', 'GFX@0.40.0']) {
      const record = JSON.parse(await readFile(resolve(bundle, selection + '.json')));
      const installed = resolve(state, 'data/packages', selection);
      for (const file of record.descriptor.files) assert.equal(await fileDigest(resolve(installed, file.path)), file.sha256);
      for (const artifact of record.descriptor.artifacts.filter(a => a.target === target)) assert.equal(await fileDigest(resolve(installed, artifact.path)), artifact.sha256);
      assert.equal(await readFile(resolve(installed, 'Package.json'), 'utf8'), record.descriptor.manifest);
    }
    console.log(`PASS anonymous restored installation ${target}: exact historical sources and artifacts; Git/origin downloads disabled`);
  }
  await assert.rejects(access(marker));
  console.log(`Evidence: ${work}`);
} finally {
  if (server.exitCode === null) { server.kill('SIGTERM'); await new Promise(yes => server.once('exit', yes)); }
}
