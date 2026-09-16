import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { gzipSync } from 'node:zlib';

const [target, base, certificate] = process.argv.slice(2);
assert.match(target ?? '', /^[a-zA-Z0-9_.@-]+$/);
assert.equal(new URL(base).protocol, 'https:');
assert.equal(new URL(base).hostname, '127.0.0.1');
const ca = await readFile(certificate);
const nonce = randomBytes(6).toString('hex');
const token = randomBytes(32).toString('hex'), other = randomBytes(32).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const name = `Stage_${nonce}`;
let checks = 0;
function pass(label) { console.log(`ok ${++checks} - ${label}`); }
function remote(command, input = '') {
  return new Promise((yes, no) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, command]);
    let output = '', errors = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
    child.on('error', no);
    child.on('exit', code => code === 0 ? yes(output) : no(new Error(`Private staging command failed (${code}): ${errors}`)));
    child.stdin.end(input);
  });
}
const fixture = (action, values = {}) => remote('sudo -n /usr/local/libexec/silex-registry-stage-fixture',
  JSON.stringify({ root: '/data', limits: {}, action, ...values }));
function request(path, { method = 'GET', credential, body, offset, status = 200 } = {}) {
  return new Promise((yes, no) => {
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (credential) headers.Authorization = `Bearer ${credential}`;
    if (offset !== undefined) headers['Upload-Offset'] = String(offset);
    if (bytes) headers['Content-Length'] = bytes.length;
    const call = httpsRequest(new URL(path, base), { method, ca, headers, timeout: 15000 }, response => {
      const chunks = [];
      response.on('data', b => chunks.push(b)); response.on('error', no);
      response.on('end', () => {
        try {
          const data = Buffer.concat(chunks);
          assert.equal(response.statusCode, status, `${method} ${path}: ${data.toString()}`);
          yes({ headers: response.headers, bytes: data,
            value: data.length && response.headers['content-type']?.includes('json') ? JSON.parse(data) : null });
        } catch (error) { no(error); }
      });
    });
    call.on('error', no); call.on('timeout', () => call.destroy(new Error('HTTPS request timed out')));
    call.end(bytes);
  });
}
function tar(entries) {
  const blocks = [];
  for (const { path, bytes, type = '0', link = '' } of entries) {
    const header = Buffer.alloc(512); header.write(path, 0, 100);
    for (const [offset, size, value] of [[100, 8, 420], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]])
      header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size);
    header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100);
    header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function publication(packageName, transform = entries => entries) {
  const manifest = JSON.stringify({ name: packageName, version: '1.0.0', requires: { silex: '>=0.1.0' } });
  const entries = [{ path: 'Package.json', bytes: Buffer.from(manifest) },
    { path: 'Module/Canary.php', bytes: Buffer.from(`<?php file_put_contents('/data/php-canary-${nonce}', 'executed'); ?>`) }];
  const source = gzipSync(tar(transform(entries)));
  return { source, descriptor: { schema: 1, manifest, source: { size: source.length, sha256: sha(source) },
    files: entries.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha(bytes) })), artifacts: [] } };
}
async function upload(p, session) {
  for (let offset = 0; offset < p.source.length; offset += 4096)
    await request(`/v2/publications/${session.id}/objects/${sha(p.source)}`, {
      method: 'PATCH', credential: token, offset, body: p.source.subarray(offset, offset + 4096) });
}
try {
  await fixture('identity', { id: '900000001', login: 'staging-fixture', token });
  await fixture('identity', { id: '900000002', login: 'staging-other', token: other });
  const p = publication(name);
  await request('/v2/publications', { method: 'POST', body: p.descriptor, status: 401 });
  const session = (await request('/v2/publications', { method: 'POST', credential: token, body: p.descriptor })).value;
  await request(`/v2/publications/${session.id}`, { credential: other, status: 403 });
  await request(`/v2/packages/${name}`, { status: 404 });
  await upload(p, session);
  await request(`/v2/publications/${session.id}/finalize`, { method: 'POST', credential: token });
  const served = await request(`/v2/packages/${name}/versions/1.0.0/source`);
  assert.deepEqual(served.bytes, p.source);
  assert.equal(served.headers['content-type'], 'application/octet-stream');
  assert.match(served.headers['content-disposition'], /^attachment;/);
  await remote(`sudo -n test ! -e /var/lib/silex-registry-stage/data/php-canary-${nonce}`);
  pass('real HTTPS/FPM publication, private upload and inert anonymous source delivery');
  for (const [suffix, transform, status] of [
    ['Link', entries => [...entries, { path: 'link', bytes: Buffer.alloc(0), type: '2', link: '/etc/passwd' }], 422],
    ['Expand', entries => [...entries, { path: 'extra', bytes: Buffer.alloc(262144) }], 413],
  ]) {
    const bad = publication(name + suffix, transform);
    const pending = (await request('/v2/publications', { method: 'POST', credential: token, body: bad.descriptor })).value;
    await upload(bad, pending);
    await request(`/v2/publications/${pending.id}/finalize`, { method: 'POST', credential: token, status });
    await request(`/v2/packages/${name + suffix}`, { status: 404 });
  }
  pass('hostile archives rejected by deployed FPM without public versions');
  await request('/server/tests/fixture.php', { status: 404 });
  await request('/v2/session', { method: 'DELETE', credential: token });
  await request('/v2/session', { credential: token, status: 401 });
  await request(`/v2/packages/${name}`);
  pass('no fixture HTTP route; revoked author access does not affect anonymous reads');
  await remote('sudo -n systemctl kill --kill-who=main --signal=SIGKILL silex-registry-stage.service');
  let recovered = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const restored = await request(`/v2/packages/${name}/versions/1.0.0/source`);
      assert.deepEqual(restored.bytes, p.source);
      recovered = true; break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  assert(recovered, 'published source survives forced FPM termination and automatic restart');
  await remote('sudo -n systemctl is-active --quiet silex-registry-stage.service silex-registry-stage-web.service');
  pass('forced FPM termination cleans its runtime and recovers the immutable publication');
  console.log(`PASS ${checks} staging groups; retained package ${name}; provider identity injected by private administrator`);
} finally {
  await fixture('revoke', { token });
  await fixture('revoke', { token: other });
}
