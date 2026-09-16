import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, utimes } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// No Silex compiler or client participates in this protocol/storage proof.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const group = dirname(repository);
const php = process.argv[2];
assert(php?.startsWith('/'), 'Pass the absolute PHP executable path.');
assert.equal(process.cwd(), group, 'Run from the Spec Worktree group.');
const parent = resolve(group, 'TestState/server');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(`${parent}/run-`);
const limits = { reserve: 1048576, capacity: 8388608, chunk: 4096, sessions: 100, grace: 1,
  expanded: 65536, files: 32 };
const token = randomBytes(32).toString('hex');
const other = randomBytes(32).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const servers = [];
let checks = 0;
function pass(label) { checks++; console.log(`ok ${checks} - ${label}`); }
function fixture(action, values = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(php, [`${repository}/server/tests/fixture.php`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' && values.crash) return resolveResult({ killed: true });
      if (code !== 0) return reject(new Error(`Fixture failed (${code}): ${errors}`));
      try { resolveResult(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ root, limits, action, ...values }));
  });
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function tar(entries) {
  const blocks = [];
  for (const { path, bytes, type = '0', link = '' } of entries) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    for (const [offset, size, number] of [[100, 8, 420], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]])
      header.write(number.toString(8).padStart(size - 1, '0') + '\0', offset, size);
    header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100);
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((a, b) => a + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const shared = Buffer.from('native artifact fixture; never executed\n');
function publication(name, version = '1.0.0', options = {}) {
  const second = options.second ?? shared;
  const manifest = JSON.stringify({ name, version, requires: { silex: '>=0.1.0' },
    artifacts: { 'macos-arm64': { Native: { path: 'Native/a.bin', sha256: sha(shared) } },
      'linux-x64': { Native: { path: 'Native/b.bin', sha256: sha(second) } } }, ...options.manifest });
  const entries = [{ path: 'Package.json', bytes: Buffer.from(manifest) },
    { path: options.sourcePath ?? 'Module/Content.txt', bytes: Buffer.from(options.text ?? '<?php throw new Exception("must not execute"); ?>') }];
  const source = options.source ?? gzipSync(tar(options.entries ? options.entries(entries) : entries));
  const descriptor = { schema: 1, manifest, source: { size: source.length, sha256: sha(source) },
    files: entries.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha(bytes) })),
    artifacts: ['macos-arm64', 'linux-x64'].map((target, index) => ({ target, name: 'Native', path: `Native/${index ? 'b' : 'a'}.bin`, size: (index ? second : shared).length, sha256: sha(index ? second : shared) })) };
  return { descriptor, blobs: new Map([[sha(source), source], [sha(shared), shared], [sha(second), second]]) };
}
async function port() {
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const number = server.address().port;
  await new Promise(yes => server.close(yes)); return number;
}
async function start() {
  const number = await port();
  const child = spawn(php, ['-d', 'memory_limit=128M', '-S', `127.0.0.1:${number}`, '-t', `${repository}/server/public`, `${repository}/server/public/index.php`],
    { env: { ...process.env, SILEX_REGISTRY_DATA: root }, stdio: ['ignore', 'ignore', 'pipe'] });
  servers.push(child);
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  const base = `http://127.0.0.1:${number}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server failed: ${errors}`);
    try { await fetch(base); return base; } catch { await new Promise(yes => setTimeout(yes, 20)); }
  }
  throw new Error(`Server not ready: ${errors}`);
}
async function request(base, path, { method = 'GET', credential, body, offset, status = 200 } = {}) {
  const headers = {};
  if (credential) headers.Authorization = `Bearer ${credential}`;
  if (offset !== undefined) headers['Upload-Offset'] = String(offset);
  const response = await fetch(base + path, { method, headers, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${path}: ${bytes.toString()}`);
  return { response, bytes, value: bytes.length && response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes) : null };
}
let base;
async function create(p, credential = token) {
  return (await request(base, '/v2/publications', { method: 'POST', credential, body: p.descriptor })).value;
}
async function upload(p, session, credential = token) {
  for (const object of session.objects) {
    if (object.available) continue;
    const bytes = p.blobs.get(object.sha256);
    for (let offset = object.offset; offset < bytes.length || (bytes.length === 0 && offset === 0);) {
      const chunk = bytes.subarray(offset, offset + limits.chunk);
      await request(base, `/v2/publications/${session.id}/objects/${object.sha256}`, { method: 'PATCH', credential, offset, body: chunk });
      offset += chunk.length;
      if (bytes.length === 0) break;
    }
  }
}
const finish = (session, credential = token, status = 200, endpoint = base) => request(endpoint, `/v2/publications/${session.id}/finalize`, { method: 'POST', credential, status });
try {
  console.log(JSON.stringify({ repository, head: execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root,
    php, version: execFileSync(php, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }), limits }));
  await fixture('init');
  await fixture('identity', { id: '1001', login: 'author', token });
  await fixture('identity', { id: '1002', login: 'other', token: other });
  base = await start(); const parallel = await start();
  console.log(`HTTP instances: ${base}, ${parallel}; same SQLite store, separate PHP processes`);
  const p = publication('Fixture'); const s = await create(p);
  assert.equal(s.publication_sha256, sha(canonical(p.descriptor)));
  assert.equal((await create(p)).id, s.id);
  await request(base, '/v2/publications', { method: 'POST', body: p.descriptor, status: 401 });
  await request(base, '/v2/publications', { method: 'POST', credential: token, body: { ...p.descriptor, github_id: '1002' }, status: 422 });
  await request(base, `/v2/publications/${s.id}`, { credential: other, status: 403 });
  await request(base, '/v2/packages/Fixture', { status: 404 });
  await finish(s, token, 409);
  pass('idempotent creation, server digest, authentication and private staging');

  const source = p.descriptor.source;
  const objectURL = `/v2/publications/${s.id}/objects/${source.sha256}`;
  await request(base, objectURL, { method: 'PATCH', credential: other, offset: 0, body: Buffer.from('x'), status: 403 });
  const prefix = p.blobs.get(source.sha256).subarray(0, 30);
  await request(base, objectURL, { method: 'PATCH', credential: token, offset: 0, body: prefix });
  await request(base, objectURL, { method: 'PATCH', credential: token, offset: 0, body: prefix, status: 409 });
  const head = await request(base, objectURL, { method: 'HEAD', credential: token });
  assert.equal(head.response.headers.get('upload-offset'), '30');
  await upload(p, (await request(base, `/v2/publications/${s.id}`, { credential: token })).value);
  const divergent = publication('Fixture', '1.0.0', { text: 'different' });
  const conflict = await create(divergent); await upload(divergent, conflict);
  const concurrent = await Promise.all([finish(s), finish(s, token, 200, parallel)]);
  assert(concurrent.every(result => result.value.state === 'published'));
  await finish(conflict, token, 409);
  await finish(s);
  pass('offset recovery and two concurrent finalizations expose one immutable version');

  const p2 = publication('Fixture', '1.0.1'); const s2 = await create(p2);
  assert(s2.objects.find(o => o.sha256 === sha(shared)).available);
  await upload(p2, s2); await finish(s2);
  const publicBlob = await request(base, '/v2/packages/Fixture/versions/1.0.1/artifacts/linux-x64/Native');
  assert.deepEqual(publicBlob.bytes, shared);
  const publicSource = await request(base, '/v2/packages/Fixture/versions/1.0.0/source');
  assert.deepEqual(publicSource.bytes, p.blobs.get(source.sha256));
  const inspection = await fixture('inspect');
  assert.equal(inspection.objects.filter(digest => digest === sha(shared)).length, 1);
  assert.equal(inspection.versions.length, 2);
  assert(!JSON.stringify(inspection).includes(token));
  pass('two versions and targets share one object; anonymous exact-byte reads');

  const targets = publication('Targets', '1.0.0', { second: Buffer.from('distinct linux object') });
  const targetSession = await create(targets);
  await upload(targets, { ...targetSession, objects: targetSession.objects.filter(object => object.sha256 !== targets.descriptor.artifacts[1].sha256) });
  await finish(targetSession, token, 409);
  await request(base, '/v2/packages/Targets', { status: 404 });
  await upload(targets, (await request(base, `/v2/publications/${targetSession.id}`, { credential: token })).value);
  await finish(targetSession);
  const competing = [publication('Race'), publication('Race', '1.0.0', { text: 'competitor' })];
  const competingSessions = [];
  for (const trial of competing) { const session = await create(trial); await upload(trial, session); competingSessions.push(session); }
  const race = await Promise.all(competingSessions.map(session => fixture('finalize', { token, id: session.id })));
  assert.equal(race.filter(result => result.state === 'published').length, 1);
  assert.equal(race.filter(result => result.status === 409).length, 1);
  pass('missing foreign-target artifact prevents visibility; divergent concurrent processes have one winner');

  await fixture('identity', { id: '1001', login: 'renamed', token });
  await fixture('identity', { id: '1002', login: 'author', token: other });
  const p3 = publication('Fixture', '1.0.2');
  await request(base, '/v2/publications', { method: 'POST', credential: other, body: p3.descriptor, status: 403 });
  const s3 = await create(p3); await upload(p3, s3);
  await fixture('revoke', { token });
  await finish(s3, token, 401);
  await request(base, '/v2/packages/Fixture');
  await fixture('identity', { id: '1001', login: 'renamed', token, duration: -1 });
  await finish(s3, token, 401);
  await fixture('identity', { id: '1001', login: 'renamed', token });
  await finish(s3);
  await request(base, '/v2/publications', { method: 'POST', credential: token, body: publication('STD').descriptor, status: 403 });
  pass('GitHub ID owns rights across rename; reused login, revoked/expired access and reserved name denied');

  for (const point of ['before_commit', 'after_commit']) {
    const trial = publication(point === 'before_commit' ? 'Before' : 'After');
    const session = await create(trial); await upload(trial, session);
    assert((await fixture('finalize', { token, id: session.id, crash: point })).killed);
    await request(base, `/v2/packages/${JSON.parse(trial.descriptor.manifest).name}`, { status: point === 'before_commit' ? 404 : 200 });
    await finish(session);
  }
  pass('SIGKILL before commit hides version; after commit retry recovers committed result');

  for (const point of ['after_bytes', 'after_object']) {
    const trial = publication(point === 'after_bytes' ? 'Bytes' : 'Object');
    const session = await create(trial); const blob = trial.descriptor.source;
    assert((await fixture('append', { token, id: session.id, digest: blob.sha256, offset: 0,
      bytes: trial.blobs.get(blob.sha256).toString('base64'), crash: point })).killed);
    const resumed = (await request(base, `/v2/publications/${session.id}`, { credential: token })).value;
    const state = resumed.objects.find(object => object.sha256 === blob.sha256);
    assert.equal(state.offset, point === 'after_bytes' ? 0 : blob.size);
    await upload(trial, resumed); await finish(session);
  }
  pass('SIGKILL after bytes or CAS rename reconciles offsets without corrupting published data');

  const bad = publication('BadHash'); const badSession = await create(bad);
  const corrupt = Buffer.from(bad.blobs.get(bad.descriptor.source.sha256)); corrupt[0] ^= 1;
  await request(base, `/v2/publications/${badSession.id}/objects/${bad.descriptor.source.sha256}`, { method: 'PATCH', credential: token, offset: 0, body: corrupt, status: 422 });
  await upload(bad, badSession); await finish(badSession);
  const cases = [
    ['Symlink', entries => [...entries, { path: 'link', bytes: Buffer.alloc(0), type: '2', link: '/etc/passwd' }]],
    ['Traversal', entries => [...entries, { path: '../outside', bytes: Buffer.alloc(0) }]],
    ['Duplicate', entries => [...entries, entries[0]]],
    ['Missing', entries => entries.slice(1)],
  ];
  for (const [name, entries] of cases) {
    const trial = publication(name, '1.0.0', { entries }); const session = await create(trial);
    await upload(trial, session); await finish(session, token, 422);
    await request(base, `/v2/packages/${name}`, { status: 404 });
  }
  const invalid = publication('Gzip', '1.0.0', { source: Buffer.from('invalid gzip') });
  const invalidSession = await create(invalid); await upload(invalid, invalidSession); await finish(invalidSession, token, 422);
  pass('hash retry works; links, traversal, duplicate/missing files and invalid gzip never publish');

  const inflated = publication('Inflated', '1.0.0', { entries: entries => [...entries,
    { path: 'Module/Filler.txt', bytes: Buffer.alloc(262144) }] });
  const inflatedSession = await create(inflated);
  await upload(inflated, inflatedSession);
  const inflateFailure = await finish(inflatedSession, token, 413);
  assert.equal(inflateFailure.value.error, 'expanded_limit');
  await request(base, '/v2/packages/Inflated', { status: 404 });
  const canary = `${root}-php-canary`;
  const executable = publication('ExecutableData', '1.0.0', { sourcePath: 'Module/Canary.php',
    text: `<?php file_put_contents(${JSON.stringify(canary)}, 'executed'); ?>` });
  const executableSession = await create(executable);
  await upload(executable, executableSession); await finish(executableSession);
  const served = await request(base, '/v2/packages/ExecutableData/versions/1.0.0/source');
  assert.deepEqual(served.bytes, executable.blobs.get(executable.descriptor.source.sha256));
  assert.equal(served.response.headers.get('content-type'), 'application/octet-stream');
  assert.match(served.response.headers.get('content-disposition'), /^attachment;/);
  await request(base, '/v2/packages/ExecutableData/versions/1.0.0/Module/Canary.php', { status: 404 });
  await assert.rejects(access(canary), { code: 'ENOENT' });
  pass('over-expanded gzip stays private; PHP payload remains inert data when published and served');

  for (const path of ['../escape', '/absolute', 'C:/file', 'a\\b', 'a/.git/config', 'NUL.txt', 'bad.']) {
    const unsafe = publication('Paths'); unsafe.descriptor.files[1].path = path;
    await request(base, '/v2/publications', { method: 'POST', credential: token, body: unsafe.descriptor, status: 422 });
  }
  const collision = publication('Collision');
  collision.descriptor.files.push({ ...collision.descriptor.files[1], path: 'module/content.TXT' });
  await request(base, '/v2/publications', { method: 'POST', credential: token, body: collision.descriptor, status: 422 });
  const unicode = publication('Unicode', '1.0.0', { manifest: { description: '\u2028\u2029 café' } });
  assert.equal((await create(unicode)).publication_sha256, sha(canonical(unicode.descriptor)));
  pass('portable path admission rejects traversal, device names and case collision; Unicode canonical digest agrees');

  const size = publication('Limits');
  size.descriptor.source.size = 16777217;
  await request(base, '/v2/publications', { method: 'POST', credential: token, body: size.descriptor, status: 413 });
  await request(base, objectURL, { method: 'PATCH', credential: token, offset: 0, body: Buffer.alloc(limits.chunk + 1), status: 413 });
  const quota = publication('Quota'); quota.descriptor.artifacts.forEach(artifact => { artifact.size = limits.capacity; });
  await request(base, '/v2/publications', { method: 'POST', credential: token, body: quota.descriptor, status: 429 });
  const missing = publication('Dependency', '1.0.0', { manifest: { dependencies: { Unknown: '=1.0.0' } } });
  const missingSession = await create(missing); await upload(missing, missingSession); await finish(missingSession, token, 409);
  pass('source/chunk/quota limits and unavailable runtime dependency rejected');

  const live = publication('Live'); const liveSession = await create(live); await upload(live, liveSession);
  const orphan = publication('Orphan'); const orphanSession = await create(orphan); await upload(orphan, orphanSession);
  await fixture('expire', { id: orphanSession.id });
  for (const digest of await readdir(`${root}/objects`)) await utimes(`${root}/objects/${digest}`, 1, 1);
  await Promise.all([fixture('collect'), finish(liveSession)]);
  assert(!(await readdir(`${root}/objects`)).includes(orphan.descriptor.source.sha256));
  await request(base, '/v2/packages/Live/versions/1.0.0/source');
  await request(base, '/v2/packages/Fixture/versions/1.0.0/source');
  await request(base, `/v2/publications/${orphanSession.id}`, { credential: token, status: 410 });
  const renewed = await create(orphan);
  assert.notEqual(renewed.id, orphanSession.id);
  await upload(orphan, renewed); await finish(renewed);
  assert(!(await readFile(`${root}/registry.sqlite`)).includes(Buffer.from(token)));
  pass('GC preserves live/published references; expired attempts restart safely; no plaintext token');
  const scriptBefore = sha(await readFile(`${root}/registry.sqlite`));
  const staticOutput = resolve(parent, `${root.split('/').at(-1)}-static/v1`);
  console.log(execFileSync(process.execPath, ['scripts/build-registry.mjs', staticOutput], { cwd: repository, encoding: 'utf8' }).trim());
  assert.equal(sha(await readFile(`${root}/registry.sqlite`)), scriptBefore);
  const index = JSON.parse(await readFile(`${staticOutput}/index.json`));
  assert.equal(index.schema, 2);
  assert.equal(index.packages.length, (await readdir(`${repository}/registry/v1/packages`)).length);
  pass('existing static v1 build stays independent of durable state');
  console.log(`PASS ${checks} groups; retained evidence store: ${root}`);
} finally {
  await Promise.all(servers.map(child => new Promise(resolveExit => {
    if (child.exitCode !== null) return resolveExit();
    child.once('exit', resolveExit); child.kill('SIGTERM');
  })));
}
