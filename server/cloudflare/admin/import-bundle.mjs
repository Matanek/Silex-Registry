import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateBundle } from './validate-bundle.mjs';

const execute = promisify(execFile);
const cloudflare = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(cloudflare, 'node_modules/.bin/wrangler');
const q = value => `'${String(value).replaceAll("'", "''")}'`;

export async function importBundle({ bundle, plan, owners, database, bucket, config, storage, persistTo,
  progress = console.log }) {
  const checked = await validateBundle(bundle, plan, owners);
  return importValidatedStore({ checked, database, bucket, config, storage, persistTo, progress });
}

export async function importValidatedStore({ checked, database, bucket, config, storage, persistTo,
  requireEmpty = false, progress = console.log }) {
  if (!['local', 'remote'].includes(storage) || !/^[A-Za-z0-9_-]+$/.test(database) ||
    !/^[A-Za-z0-9_-]+$/.test(bucket)) throw new Error('invalid destination');
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
  const currentOwners = new Map((await query('SELECT name,github_id FROM probe_names')).map(row =>
    [row.name.toLowerCase(), row]));
  const currentVersions = new Map((await query('SELECT name,version,digest,descriptor FROM probe_versions')).map(row =>
    [`${row.name.toLowerCase()}@${row.version}`, row]));
  if (requireEmpty && (currentOwners.size || currentVersions.size)) throw new Error('destination is not empty');
  for (const owner of checked.owners.values()) {
    const existing = currentOwners.get(owner.name.toLowerCase());
    if (existing && (existing.name !== owner.name || existing.github_id !== owner.github_id))
      throw new Error(`owner conflict ${owner.name}`);
  }
  for (const record of checked.records) {
    const existing = currentVersions.get(record.id.toLowerCase());
    if (existing && (existing.name !== record.name || existing.digest !== record.digest ||
      existing.descriptor !== record.descriptor)) throw new Error(`version conflict ${record.id}`);
  }
  progress(JSON.stringify({ phase: 'validated', versions: checked.records.length, names: checked.owners.size,
    objects: checked.objects.size }));
  const scratch = await mkdtemp(join(tmpdir(), 'silex-cloudflare-import-'));
  try {
    let index = 0;
    for (const [digest, blob] of checked.objects) {
      const objectPath = `${bucket}/probe/objects/sha256/${digest}`;
      const downloaded = join(scratch, digest);
      let found = false;
      try {
        await command(['r2', 'object', 'get', objectPath, ...flags, '--file', downloaded]);
        found = true;
      } catch (error) {
        if (!/not found|does not exist|404/i.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) throw error;
      }
      if (found) {
        const checksum = createHash('sha256');
        for await (const chunk of createReadStream(downloaded)) checksum.update(chunk);
        if (checksum.digest('hex') !== digest) throw new Error(`stored object conflict ${digest}`);
        await rm(downloaded);
      } else {
        await command(['r2', 'object', 'put', objectPath, ...flags, '--file', blob.path, '--force']);
      }
      index++;
      if (index % 10 === 0 || index === checked.objects.size)
        progress(JSON.stringify({ phase: 'objects', done: index, total: checked.objects.size }));
    }
    const sql = [
      ...[...checked.owners.values()].map(owner =>
        `INSERT OR IGNORE INTO probe_names(name,github_id) VALUES (${q(owner.name)},${q(owner.github_id)});`),
      ...checked.records.map(record =>
        `INSERT OR IGNORE INTO probe_versions(name,version,digest,descriptor) ` +
        `SELECT ${q(record.name)},${q(record.version)},${q(record.digest)},${q(record.descriptor)} ` +
        `WHERE EXISTS (SELECT 1 FROM probe_names WHERE name=${q(record.name)} AND github_id=${q(record.githubId)});`),
    ].join('\n');
    const sqlPath = join(scratch, 'import.sql');
    await writeFile(sqlPath, sql);
    await command(['d1', 'execute', database, ...flags, '--file', sqlPath, '--yes']);
    const finalOwners = new Map((await query('SELECT name,github_id FROM probe_names')).map(row => [row.name, row.github_id]));
    const finalVersions = new Map((await query('SELECT name,version,digest,descriptor FROM probe_versions')).map(row =>
      [`${row.name}@${row.version}`, row]));
    for (const owner of checked.owners.values()) {
      if (finalOwners.get(owner.name) !== owner.github_id) throw new Error(`owner insertion failed ${owner.name}`);
    }
    for (const record of checked.records) {
      const row = finalVersions.get(record.id);
      if (row?.digest !== record.digest || row.descriptor !== record.descriptor)
        throw new Error(`version insertion failed ${record.id}`);
    }
    const receipt = { versions: checked.records.length, names: checked.owners.size, objects: checked.objects.size,
      insertedVersions: checked.records.filter(record => !currentVersions.has(record.id.toLowerCase())).length };
    progress(JSON.stringify({ phase: 'complete', ...receipt }));
    return receipt;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [bundle, plan, owners, storageFlag, database, bucket, config, persistTo] = process.argv.slice(2);
  if (!bundle || !plan || !owners || !['--local', '--remote'].includes(storageFlag) ||
    !database || !bucket || !config) throw new Error(
    'usage: import-bundle BUNDLE PLAN OWNERS --local|--remote DATABASE BUCKET CONFIG');
  await importBundle({ bundle, plan, owners, storage: storageFlag.slice(2), database, bucket, config, persistTo });
}
