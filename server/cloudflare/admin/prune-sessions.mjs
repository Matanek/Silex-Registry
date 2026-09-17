import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cloudflare = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = join(cloudflare, 'node_modules/.bin/wrangler');
const age = 8 * 24 * 60 * 60 * 1000;

export async function pruneSessions({ origin, token, database, bucket, config, storage, persistTo,
  apply = false, progress = console.log }) {
  if (!/^https:\/\//.test(origin) && !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin))
    throw new Error('invalid Worker origin');
  if (!/^[a-f0-9]{64}$/.test(token) || !/^[A-Za-z0-9_-]+$/.test(database) ||
    !/^[A-Za-z0-9_-]+$/.test(bucket) || !['local', 'remote'].includes(storage))
    throw new Error('invalid maintenance configuration');
  const flags = [`--${storage}`, '--config', resolve(config),
    ...(persistTo && storage === 'local' ? ['--persist-to', resolve(persistTo)] : [])];
  async function command(args) {
    const { stdout } = await execute(wrangler, args, { cwd: cloudflare, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }
  async function query(sql) {
    const result = JSON.parse(await command(['d1', 'execute', database, ...flags, '--command', sql, '--json']));
    if (result.some(batch => !batch.success)) throw new Error('D1 query failed');
    return result.flatMap(batch => batch.results ?? []);
  }
  const cutoff = Date.now() - age;
  const sessions = await query(`SELECT id,created_at FROM probe_sessions WHERE created_at<=${cutoff} ORDER BY created_at LIMIT 100`);
  progress(JSON.stringify({ phase: apply ? 'applying' : 'planned', sessions: sessions.length }));
  if (!apply) return { sessions: sessions.length };
  let deleted = 0;
  for (const row of sessions) {
    if (!/^[a-f0-9]{32}$/.test(row.id)) throw new Error('invalid stored session id');
    let objects = 0;
    for (;;) {
      const response = await fetch(`${origin}/v2/admin/uploads/${row.id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) throw new Error(`maintenance inventory failed: ${response.status}`);
      const result = await response.json();
      if (!Array.isArray(result.keys) || result.keys.some(key =>
        typeof key !== 'string' || !key.startsWith(`probe/uploads/${row.id}/`)))
        throw new Error('invalid maintenance inventory');
      if (!result.keys.length) break;
      for (let index = 0; index < result.keys.length; index += 4) {
        await Promise.all(result.keys.slice(index, index + 4).map(key =>
          command(['r2', 'object', 'delete', `${bucket}/${key}`, ...flags, '--force'])));
      }
      objects += result.keys.length;
      progress(JSON.stringify({ phase: 'upload-objects', session: row.id, deleted: objects }));
    }
    await query(`DELETE FROM probe_chunks WHERE session_id='${row.id}'`);
    await query(`DELETE FROM probe_sessions WHERE id='${row.id}' AND created_at<=${cutoff}`);
    if ((await query(`SELECT id FROM probe_sessions WHERE id='${row.id}'`)).length)
      throw new Error(`session was not removed ${row.id}`);
    deleted++;
  }
  progress(JSON.stringify({ phase: 'complete', sessions: deleted }));
  return { sessions: deleted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [origin, storageFlag, database, bucket, config, mode, persistTo] = process.argv.slice(2);
  if (!origin || !['--local', '--remote'].includes(storageFlag) || !database || !bucket || !config ||
    !['--plan', '--apply'].includes(mode)) throw new Error(
    'usage: prune-sessions ORIGIN --local|--remote DATABASE BUCKET CONFIG --plan|--apply [PERSIST_TO]');
  await pruneSessions({ origin, token: process.env.REGISTRY_MAINTENANCE_TOKEN,
    storage: storageFlag.slice(2), database, bucket, config, apply: mode === '--apply', persistTo });
}
