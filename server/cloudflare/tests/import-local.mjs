import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { importBundle } from '../admin/import-bundle.mjs';

const execute = promisify(execFile);
const cloudflare = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const group = resolve(cloudflare, '../../..');
const historical = join(group, 'TestState/migration-bundle-20260916');
const owners = resolve(group, '../Memory/Artifacts/Migration-all-owners-20260916.json');
const config = join(cloudflare, 'wrangler.toml');
const wrangler = join(cloudflare, 'node_modules/.bin/wrangler');
const scratch = await mkdtemp(join(tmpdir(), 'silex-cloudflare-local-import-'));
process.env.WRANGLER_LOG_PATH = join(scratch, 'wrangler.log');
const persistTo = join(scratch, 'state');
const plan = join(scratch, 'plan.json');
const bundle = join(scratch, 'bundle');
try {
  await mkdir(bundle);
  await copyFile(join(historical, 'STD@0.16.0.json'), join(bundle, 'STD@0.16.0.json'));
  await symlink(join(historical, 'objects'), join(bundle, 'objects'));
  await writeFile(plan, JSON.stringify({ schema: 1, ordered: ['STD@0.16.0'], blocked: [] }));
  await execute(wrangler, ['d1', 'migrations', 'apply', 'silex-registry-staging', '--local',
    '--config', config, '--persist-to', persistTo], { cwd: cloudflare });
  const options = { bundle, plan, owners, database: 'silex-registry-staging',
    bucket: 'silex-registry-staging', config, storage: 'local', persistTo, progress() {} };
  const first = await importBundle(options);
  assert.equal(first.insertedVersions, 1);
  const second = await importBundle(options);
  assert.equal(second.insertedVersions, 0);
  const { descriptor } = JSON.parse(await readFile(join(bundle, 'STD@0.16.0.json'), 'utf8'));
  const objectPath = `silex-registry-staging/probe/objects/sha256/${descriptor.source.sha256}`;
  const corrupt = join(scratch, 'corrupt');
  await writeFile(corrupt, 'wrong bytes');
  await execute(wrangler, ['r2', 'object', 'put', objectPath, '--local', '--config', config,
    '--persist-to', persistTo, '--file', corrupt, '--force'], { cwd: cloudflare });
  await assert.rejects(importBundle(options), /stored object conflict/);
  const { stdout } = await execute(wrangler, ['d1', 'execute', 'silex-registry-staging', '--local',
    '--config', config, '--persist-to', persistTo, '--command',
    "SELECT (SELECT count(*) FROM probe_names) AS names, (SELECT count(*) FROM probe_versions) AS versions", '--json'],
  { cwd: cloudflare });
  const rows = JSON.parse(stdout)[0].results;
  assert.deepEqual([rows[0].names, rows[0].versions], [30, 1]);
  console.log(JSON.stringify({ localImport: 'passed', names: 30, versions: 1,
    attempts: 2, corruptedObjectRejected: true }));
} finally { await rm(scratch, { recursive: true, force: true }); }
