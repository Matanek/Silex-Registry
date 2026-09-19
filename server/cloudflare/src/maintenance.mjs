import { BackupFailure, backupFootprint, backupMetadataSnapshot,
  backupPublicationRecord, backupR2Object } from './backup.mjs';

const sessionPruneAge = 8 * 24 * 60 * 60 * 1000;
const shaPattern = /^[a-f0-9]{64}$/;

function fail(condition, code = 'backup_configuration') {
  if (!condition) throw new BackupFailure(503, code);
}

function publicationMessages(row, value) {
  const objects = new Map();
  for (const item of [value.source, ...(value.artifacts ?? [])]) {
    const previous = objects.get(item.sha256);
    fail(previous === undefined || previous === item.size, 'backup_metadata_invalid');
    objects.set(item.sha256, item.size);
  }
  return [...objects].map(([sha256, size]) => ({ kind: 'object', item: sha256, size }))
    .concat({ kind: 'publication', item: row.digest,
      size: new TextEncoder().encode(row.descriptor).byteLength });
}

async function register(env, messages) {
  const now = Date.now();
  for (let offset = 0; offset < messages.length; offset += 50) {
    await env.DB.batch(messages.slice(offset, offset + 50).map(message => env.DB.prepare(
      `INSERT INTO probe_backup_items(kind,item,size,state,attempts,updated_at)
       VALUES (?,?,?,'pending',0,?)
       ON CONFLICT(kind,item) DO UPDATE SET size=excluded.size,state='pending',updated_at=excluded.updated_at`)
      .bind(message.kind, message.item, message.size, now)));
  }
}

async function enqueue(env, messages) {
  if (env.BACKUP_REQUIRED !== '1') return { enabled: false, queued: 0 };
  fail(env.BACKUP_QUEUE && typeof env.BACKUP_QUEUE.sendBatch === 'function');
  await register(env, messages);
  for (let offset = 0; offset < messages.length; offset += 100) {
    await env.BACKUP_QUEUE.sendBatch(messages.slice(offset, offset + 100).map(body => ({ body })));
  }
  return { enabled: true, queued: messages.length };
}

export async function enqueuePublicationBackup(env, row, value) {
  const footprint = await backupFootprint(env, value);
  if (!footprint.enabled) return footprint;
  const result = await enqueue(env, publicationMessages(row, value));
  return { ...result, bytes: footprint.bytes, objects: footprint.objects };
}

async function rows(env, sql) {
  const found = [];
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(`${sql} LIMIT 500 OFFSET ?`).bind(offset).all();
    found.push(...results);
    if (results.length < 500) break;
    offset += results.length;
  }
  return found;
}

export async function seedExternalBackup(env) {
  if (env.BACKUP_REQUIRED !== '1') return { enabled: false, queued: 0 };
  const versions = await rows(env,
    'SELECT name,version,digest,descriptor FROM probe_versions ORDER BY name,version');
  const objects = new Map();
  const messages = [];
  for (const row of versions) {
    let value;
    try { value = JSON.parse(row.descriptor); }
    catch { throw new BackupFailure(503, 'backup_metadata_invalid'); }
    for (const message of publicationMessages(row, value)) {
      if (message.kind === 'object') objects.set(message.item, message);
      else messages.push(message);
    }
  }
  await backupFootprint(env);
  const result = await enqueue(env, [...objects.values(), ...messages,
    { kind: 'snapshot', item: 'latest', size: 0 }]);
  return { ...result, objects: objects.size, publications: messages.length };
}

async function complete(env, kind, item) {
  await env.DB.prepare(
    'UPDATE probe_backup_items SET state=\'complete\',updated_at=? WHERE kind=? AND item=?')
    .bind(Date.now(), kind, item).run();
}

async function retry(env, kind, item) {
  await env.DB.prepare(
    'UPDATE probe_backup_items SET state=\'pending\',attempts=attempts+1,updated_at=? WHERE kind=? AND item=?')
    .bind(Date.now(), kind, item).run();
}

async function consume(env, value) {
  fail(value && typeof value === 'object' && ['object', 'publication', 'snapshot'].includes(value.kind));
  if (value.kind === 'object') {
    fail(shaPattern.test(value.item ?? '') && Number.isSafeInteger(value.size) && value.size > 0,
      'backup_metadata_invalid');
    return backupR2Object(env, value.item, value.size);
  }
  if (value.kind === 'publication') {
    fail(shaPattern.test(value.item ?? ''), 'backup_metadata_invalid');
    const row = await env.DB.prepare(
      `SELECT v.name,v.version,v.digest,v.descriptor,n.github_id AS credential
       FROM probe_versions v JOIN probe_names n ON n.name=v.name WHERE v.digest=?`).bind(value.item).first();
    fail(row && /^[0-9]+$/.test(row.credential ?? ''), 'backup_publication_pending');
    return backupPublicationRecord(env, row);
  }
  return backupMetadataSnapshot(env);
}

export async function consumeBackupBatch(batch, env) {
  for (const message of batch.messages) {
    const value = message.body;
    try {
      await consume(env, value);
      await complete(env, value.kind, value.item);
      message.ack();
    } catch (error) {
      await retry(env, value?.kind ?? 'invalid', value?.item ?? 'invalid').catch(() => {});
      message.retry();
      console.error(JSON.stringify({ event: 'backup-retry', kind: value?.kind ?? 'invalid',
        item: value?.item ?? 'invalid', code: error?.code ?? 'backup_unavailable',
        ...(error?.operation ? { operation: error.operation } : {}),
        ...(error?.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
        ...(error?.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
        ...(error?.upstreamMessage ? { upstreamMessage: error.upstreamMessage } : {}),
        ...(error?.upstreamError ? { upstreamError: error.upstreamError } : {}) }));
    }
  }
}

export async function backupStatus(env) {
  const { results } = await env.DB.prepare(
    'SELECT kind,state,COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes,MIN(updated_at) AS oldest FROM probe_backup_items GROUP BY kind,state ORDER BY kind,state').all();
  return { schema: 1, items: results };
}

export async function pruneExpiredSessions(env, now = Date.now()) {
  const cutoff = now - sessionPruneAge;
  const { results } = await env.DB.prepare(
    'SELECT id FROM probe_sessions WHERE created_at<=? ORDER BY created_at LIMIT 100').bind(cutoff).all();
  let objects = 0;
  for (const row of results) {
    fail(/^[a-f0-9]{32}$/.test(row.id), 'maintenance_invalid');
    while (true) {
      const page = await env.OBJECTS.list({ prefix: `probe/uploads/${row.id}/`, limit: 1000 });
      if (!page.objects.length) break;
      await env.OBJECTS.delete(page.objects.map(item => item.key));
      objects += page.objects.length;
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM probe_chunks WHERE session_id=?').bind(row.id),
      env.DB.prepare('DELETE FROM probe_sessions WHERE id=? AND created_at<=?').bind(row.id, cutoff),
    ]);
  }
  return { sessions: results.length, objects };
}

export async function runScheduledMaintenance(env) {
  const snapshot = await enqueue(env, [{ kind: 'snapshot', item: 'latest', size: 0 }]);
  const prune = await pruneExpiredSessions(env);
  console.log(JSON.stringify({ event: 'registry-maintenance', snapshot, prune }));
  return { snapshot, prune };
}
