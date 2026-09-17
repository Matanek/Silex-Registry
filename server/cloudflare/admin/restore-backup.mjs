import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptsDependency, canonical, descriptor } from '../src/worker.mjs';
import { verifySourceArchive } from '../src/archive.mjs';
import { importValidatedStore } from './import-bundle.mjs';

const hex = /^[a-f0-9]{64}$/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValid = (condition, message) => { if (!condition) throw new Error(message); };

export async function validateBackup(root) {
  const backup = JSON.parse(await readFile(join(root, 'metadata.json'), 'utf8'));
  requireValid(backup.schema === 1 && Array.isArray(backup.owners) &&
    Array.isArray(backup.versions) && Array.isArray(backup.objects), 'invalid backup metadata');
  const owners = new Map();
  const folded = new Set();
  for (const owner of backup.owners) {
    requireValid(namePattern.test(owner.name) && owner.name.length <= 128 &&
      !folded.has(owner.name.toLowerCase()) && /^[0-9]+$/.test(owner.github_id), 'invalid backup owner');
    owners.set(owner.name, owner);
    folded.add(owner.name.toLowerCase());
  }
  const objects = new Map();
  for (const item of backup.objects) {
    requireValid(hex.test(item.sha256) && Number.isSafeInteger(item.size) && item.size > 0 &&
      !objects.has(item.sha256), 'invalid backup object declaration');
    const path = join(root, 'objects', 'sha256', item.sha256);
    requireValid((await stat(path)).size === item.size, `backup object size mismatch ${item.sha256}`);
    const checksum = createHash('sha256');
    for await (const chunk of createReadStream(path)) checksum.update(chunk);
    requireValid(checksum.digest('hex') === item.sha256, `backup object digest mismatch ${item.sha256}`);
    objects.set(item.sha256, { size: item.size, path });
  }
  const files = await readdir(join(root, 'objects', 'sha256'));
  requireValid(files.length === objects.size && files.every(file => objects.has(file)), 'unlisted backup object');
  const records = [];
  const available = new Map();
  const seen = new Set();
  const referenced = new Set();
  for (const row of backup.versions) {
    const value = JSON.parse(row.descriptor);
    const { manifest } = descriptor(value);
    const id = `${manifest.name}@${manifest.version}`;
    requireValid(row.name === manifest.name && row.version === manifest.version &&
      owners.has(row.name) && !seen.has(id) && row.digest === hash(row.descriptor) &&
      row.descriptor === canonical(value), `invalid backup version ${id}`);
    seen.add(id);
    available.set(row.name, [...(available.get(row.name) ?? []), row.version]);
    for (const blob of [value.source, ...value.artifacts]) {
      requireValid(objects.get(blob.sha256)?.size === blob.size, `missing backup object ${blob.sha256}`);
      referenced.add(blob.sha256);
    }
    const source = await readFile(objects.get(value.source.sha256).path);
    await verifySourceArchive(source, value, async bytes => hash(bytes));
    records.push({ id, name: row.name, version: row.version, githubId: owners.get(row.name).github_id,
      digest: row.digest, descriptor: row.descriptor });
  }
  requireValid(referenced.size === objects.size, 'unreferenced backup object');
  for (const row of backup.versions) {
    const manifest = JSON.parse(JSON.parse(row.descriptor).manifest);
    for (const [name, constraint] of Object.entries(manifest.dependencies ?? {})) {
      requireValid((available.get(name) ?? []).some(version => acceptsDependency(constraint, version)),
        `missing backup dependency ${row.name}@${row.version}: ${name}${constraint}`);
    }
  }
  return { records, owners, objects };
}

export async function restoreBackup({ backup, database, bucket, config, storage, persistTo,
  progress = console.log }) {
  const checked = await validateBackup(backup);
  return importValidatedStore({ checked, database, bucket, config, storage, persistTo,
    requireEmpty: true, progress });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [backup, storageFlag, database, bucket, config, persistTo] = process.argv.slice(2);
  if (!backup || !['--local', '--remote'].includes(storageFlag) || !database || !bucket || !config)
    throw new Error('usage: restore-backup BACKUP --local|--remote DATABASE BUCKET CONFIG [PERSIST_TO]');
  await restoreBackup({ backup, storage: storageFlag.slice(2), database, bucket, config, persistTo });
}
