import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, open, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sha256 } from './inventory.mjs';

const execute = promisify(execFile);
function remoteCommand(root, path) {
  assert(/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(root), 'invalid_remote_snapshot_path');
  return `sudo -n cat -- '${root}/${path}'`;
}
async function sync(path) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }

// Source is an immutable operator snapshot, never the live SQLite file. This
// transport keeps the known manifest digest separate and never extracts a tar.
export async function copySnapshot(source, destination, digest, host = null) {
  assert(/^[a-f0-9]{64}$/.test(digest), 'invalid_snapshot_digest');
  if (host !== null) assert(/^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+$/.test(host), 'invalid_ssh_target');
  const manifestBytes = host === null ? await readFile(resolve(source, 'snapshot.json')) :
    (await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, remoteCommand(source, 'snapshot.json')],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 30000 })).stdout;
  assert.equal(sha256(manifestBytes), digest, 'snapshot_manifest_mismatch');
  const manifest = JSON.parse(manifestBytes);
  assert(manifest.schema === 1 && manifest.files && !Array.isArray(manifest.files) && manifest.files['registry.sqlite'], 'invalid_snapshot');
  for (const [path, file] of Object.entries(manifest.files)) {
    assert(/^(registry\.sqlite|limits\.json|login\.key|objects\/[a-f0-9]{64}|uploads\/[a-f0-9]{32}-[a-f0-9]{64})$/.test(path), 'unsafe_snapshot_path');
    assert(Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), 'invalid_snapshot_file');
  }
  destination = resolve(destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  assert.equal(await realpath(dirname(destination)), dirname(destination), 'symlink_destination_parent');
  await mkdir(destination, { mode: 0o700 }); // Never overwrite a retained backup.
  for (const dir of ['objects', 'uploads']) await mkdir(resolve(destination, dir), { mode: 0o700 });
  for (const [path, file] of Object.entries(manifest.files)) {
    let input, child;
    let exited = Promise.resolve();
    if (host === null) {
      assert((await lstat(resolve(source, path))).isFile(), 'unsafe_snapshot_file');
      assert.equal(await realpath(resolve(source, path)), resolve(source, path), 'symlink_source_path');
      input = createReadStream(resolve(source, path));
    } else {
      child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, remoteCommand(source, path)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
      input = child.stdout;
      exited = new Promise((yes, no) => {
        child.stderr.resume(); // Never log backup bytes, keys or connection details.
        child.once('error', no); child.once('exit', code => code === 0 ? yes() : no(new Error('snapshot_transport_failed')));
      });
    }
    let count = 0; const hash = createHash('sha256');
    const verify = new Transform({ transform(bytes, _, done) {
      count += bytes.length;
      if (count > file.size) { done(new Error('snapshot_size_mismatch')); return; }
      hash.update(bytes); done(null, bytes);
    } });
    try {
      await Promise.all([pipeline(input, verify, createWriteStream(resolve(destination, path), { flags: 'wx', mode: 0o600 })), exited]);
      assert.equal(count, file.size, 'snapshot_size_mismatch');
      assert.equal(hash.digest('hex'), file.sha256, 'snapshot_file_corrupt');
      await sync(resolve(destination, path));
    } finally { if (child && child.exitCode === null) child.kill('SIGTERM'); }
  }
  for (const dir of ['objects', 'uploads']) await sync(resolve(destination, dir));
  const fd = await open(resolve(destination, 'snapshot.json'), 'wx', 0o600);
  try { await fd.writeFile(manifestBytes); await fd.sync(); } finally { await fd.close(); }
  await sync(destination); await sync(dirname(destination));
  return { files: Object.keys(manifest.files).length, bytes: Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0), manifest_sha256: digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 5 || process.argv.length > 6) throw new Error('Usage: node copy-snapshot.mjs <source-snapshot> <new-local-backup> <manifest-sha256> [user@ssh-host]');
  console.log(JSON.stringify(await copySnapshot(process.argv[2], process.argv[3], process.argv[4], process.argv[5] ?? null)));
}
