import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportStore } from './export-store.mjs';
import { pruneSessions } from './prune-sessions.mjs';

const prefix = 'cloudflare-auto-';

export function retentionPlan(names) {
  const snapshots = names.filter(name => /^cloudflare-auto-\d{8}T\d{9}Z$/.test(name)).sort().reverse();
  const keep = new Set(snapshots.slice(0, 30));
  const months = new Set();
  for (const name of snapshots) {
    const month = name.slice(prefix.length, prefix.length + 6);
    if (!months.has(month) && months.size < 12) {
      months.add(month);
      keep.add(name);
    }
  }
  return { keep: snapshots.filter(name => keep.has(name)), remove: snapshots.filter(name => !keep.has(name)) };
}

export async function runMaintenance({ database, bucket, config, origin, token, backupRoot,
  storage = 'remote', persistTo, applyRetention = false, progress = console.log }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('maintenance token required');
  const root = resolve(backupRoot);
  await mkdir(root, { recursive: true });
  const date = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18) + 'Z';
  const destination = join(root, prefix + date);
  const backup = await exportStore({ database, bucket, config, storage, destination, persistTo, progress });
  await writeFile(join(destination, '.maintenance.json'), JSON.stringify({ schema: 1, completed_at: new Date().toISOString(),
    versions: backup.versions, names: backup.names, objects: backup.objects }) + '\n');
  const prune = await pruneSessions({ origin, token, database, bucket, config, storage,
    persistTo, apply: true, progress });
  const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() &&
    entry.name.startsWith(prefix));
  const owned = [];
  for (const entry of entries) {
    try {
      const marker = JSON.parse(await readFile(join(root, entry.name, '.maintenance.json'), 'utf8'));
      if (marker.schema === 1) owned.push(entry.name);
    } catch { /* Never prune an unknown or incomplete backup. */ }
  }
  const retention = retentionPlan(owned);
  progress(JSON.stringify({ phase: 'retention-plan', keep: retention.keep.length,
    remove: retention.remove, apply: applyRetention }));
  if (applyRetention) for (const name of retention.remove) {
    await rm(join(root, name), { recursive: true });
    progress(JSON.stringify({ phase: 'retention-removed', name }));
  }
  const result = { backup, prunedSessions: prune.sessions, retention };
  progress(JSON.stringify({ phase: 'maintenance-complete', backup: destination,
    prunedSessions: prune.sessions }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [storageFlag, database, bucket, config, origin, backupRoot, mode, persistTo] = process.argv.slice(2);
  if (!['--local', '--remote'].includes(storageFlag) || !database || !bucket || !config || !origin ||
    !backupRoot || !['--plan-retention', '--apply-retention'].includes(mode)) throw new Error(
    'usage: run-maintenance --local|--remote DATABASE BUCKET CONFIG ORIGIN BACKUP_ROOT --plan-retention|--apply-retention [PERSIST_TO]');
  await runMaintenance({ storage: storageFlag.slice(2), database, bucket, config, origin,
    backupRoot, applyRetention: mode === '--apply-retention', persistTo,
    token: process.env.REGISTRY_MAINTENANCE_TOKEN });
}
