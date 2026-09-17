import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonical, descriptor } from '../src/worker.mjs';
import { verifySourceArchive } from '../src/archive.mjs';

const execute = promisify(execFile);
const cloudflare = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(cloudflare, 'node_modules/.bin/wrangler');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validDestination = name => /^[A-Za-z0-9_-]+$/.test(name);

export async function exportStore({ database, bucket, config, storage, destination, persistTo,
  progress = console.log }) {
  if (!validDestination(database) || !validDestination(bucket) || !['local', 'remote'].includes(storage))
    throw new Error('invalid source');
  const flags = [`--${storage}`, '--config', resolve(config),
    ...(persistTo && storage === 'local' ? ['--persist-to', resolve(persistTo)] : [])];
  async function command(args) {
    const { stdout } = await execute(wrangler, args, { cwd: cloudflare, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }
  async function query(sql) {
    const result = JSON.parse(await command(['d1', 'execute', database, ...flags, '--command', sql, '--json']));
    if (result.some(batch => !batch.success)) throw new Error('D1 query failed');
    return result.flatMap(batch => batch.results ?? []);
  }
  async function metadata() {
    const owners = await query('SELECT name,github_id FROM probe_names ORDER BY name');
    const versions = await query('SELECT name,version,digest,descriptor FROM probe_versions ORDER BY name,version');
    return { owners, versions };
  }
  const before = await metadata();
  const ownerNames = new Set(before.owners.map(row => row.name.toLowerCase()));
  if (ownerNames.size !== before.owners.length) throw new Error('duplicate case-folded owners');
  const objects = new Map();
  for (const row of before.versions) {
    const value = JSON.parse(row.descriptor);
    const { manifest } = descriptor(value);
    if (manifest.name !== row.name || manifest.version !== row.version ||
      sha(row.descriptor) !== row.digest || canonical(value) !== row.descriptor ||
      !ownerNames.has(row.name.toLowerCase())) throw new Error(`invalid stored version ${row.name}@${row.version}`);
    for (const blob of [value.source, ...value.artifacts]) {
      const prior = objects.get(blob.sha256);
      if (prior !== undefined && prior !== blob.size) throw new Error(`object size conflict ${blob.sha256}`);
      objects.set(blob.sha256, blob.size);
    }
  }
  const target = resolve(destination);
  const work = await mkdtemp(join(dirname(target), `${basename(target)}.partial-`));
  try {
    await mkdir(join(work, 'objects', 'sha256'), { recursive: true });
    let index = 0;
    for (const [digest, size] of objects) {
      const path = join(work, 'objects', 'sha256', digest);
      await command(['r2', 'object', 'get', `${bucket}/probe/objects/sha256/${digest}`, ...flags, '--file', path]);
      if ((await stat(path)).size !== size) throw new Error(`object size mismatch ${digest}`);
      const checksum = createHash('sha256');
      for await (const chunk of createReadStream(path)) checksum.update(chunk);
      if (checksum.digest('hex') !== digest) throw new Error(`object digest mismatch ${digest}`);
      index++;
      if (index % 10 === 0 || index === objects.size)
        progress(JSON.stringify({ phase: 'objects', done: index, total: objects.size }));
    }
    for (const row of before.versions) {
      const value = JSON.parse(row.descriptor);
      const source = await readFile(join(work, 'objects', 'sha256', value.source.sha256));
      await verifySourceArchive(source, value, async bytes => sha(bytes));
    }
    const after = await metadata();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('D1 changed during export');
    const manifest = { schema: 1, exported_at: new Date().toISOString(), owners: before.owners,
      versions: before.versions, objects: [...objects].map(([sha256, size]) => ({ sha256, size })) };
    await writeFile(join(work, 'metadata.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(work, target);
    const receipt = { versions: before.versions.length, names: before.owners.length, objects: objects.size,
      destination: target };
    progress(JSON.stringify({ phase: 'complete', ...receipt }));
    return receipt;
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [storageFlag, database, bucket, config, destination, persistTo] = process.argv.slice(2);
  if (!['--local', '--remote'].includes(storageFlag) || !database || !bucket || !config || !destination)
    throw new Error('usage: export-store --local|--remote DATABASE BUCKET CONFIG DESTINATION [PERSIST_TO]');
  await exportStore({ storage: storageFlag.slice(2), database, bucket, config, destination, persistTo });
}
