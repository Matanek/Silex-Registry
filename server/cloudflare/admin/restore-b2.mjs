import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';
import { acceptsDependency, canonical, descriptor } from '../src/worker.mjs';
import { verifySourceArchive } from '../src/archive.mjs';
import { importValidatedStore } from './import-bundle.mjs';

const shaPattern = /^[a-f0-9]{64}$/;
const bucketPattern = /^(?!b2-)[a-z0-9](?:[a-z0-9-]{4,61}[a-z0-9])$/;
const prefixPattern = /^[a-z0-9][a-z0-9/-]{0,127}$/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const parser = new XMLParser();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValid = (condition, message) => { if (!condition) throw new Error(message); };

function configuration(values = process.env) {
  const endpoint = String(values.B2_ENDPOINT ?? '').replace(/\/$/, '');
  const bucket = String(values.B2_BUCKET ?? '');
  const prefix = String(values.B2_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const accessKeyId = String(values.B2_APPLICATION_KEY_ID ?? '');
  const secretAccessKey = String(values.B2_APPLICATION_KEY ?? '');
  requireValid(/^https:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(endpoint) &&
    bucketPattern.test(bucket) && prefixPattern.test(prefix) && accessKeyId.length >= 10 &&
    secretAccessKey.length >= 20, 'invalid B2 restore configuration');
  return { endpoint, bucket, prefix,
    client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', retries: 3 }) };
}

function objectUrl(config, key) {
  return `${config.endpoint}/${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function checkedFetch(config, url, init = {}) {
  const response = await config.client.fetch(url, init);
  if (!response.ok) throw new Error(`B2 request failed: ${response.status}`);
  return response;
}

function array(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

async function snapshotKeys(config) {
  const keys = [];
  let continuation;
  do {
    const url = new URL(`${config.endpoint}/${config.bucket}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', `${config.prefix}/metadata/`);
    if (continuation) url.searchParams.set('continuation-token', continuation);
    const response = await checkedFetch(config, url);
    const listing = parser.parse(await response.text()).ListBucketResult;
    requireValid(listing && typeof listing === 'object', 'invalid B2 listing');
    for (const item of array(listing.Contents)) {
      if (typeof item?.Key === 'string' &&
        /^.+\/metadata\/v[0-9]{10}-n[0-9]{10}-[a-f0-9]{64}\.json$/.test(item.Key)) keys.push(item.Key);
    }
    const truncated = listing.IsTruncated === true || listing.IsTruncated === 'true';
    continuation = truncated ? listing.NextContinuationToken : undefined;
    requireValid(!truncated || typeof continuation === 'string', 'invalid B2 continuation');
  } while (continuation);
  requireValid(keys.length > 0, 'no B2 metadata snapshot');
  return keys.sort();
}

async function latestSnapshot(config) {
  const keys = await snapshotKeys(config);
  const key = keys.at(-1);
  const expected = /-([a-f0-9]{64})\.json$/.exec(key)?.[1];
  requireValid(expected, 'invalid B2 snapshot name');
  const response = await checkedFetch(config, objectUrl(config, key));
  const bytes = Buffer.from(await response.arrayBuffer());
  requireValid(bytes.length <= 16 * 1024 * 1024 && hash(bytes) === expected,
    'B2 metadata snapshot digest mismatch');
  const value = JSON.parse(bytes);
  requireValid(value.schema === 2 && Array.isArray(value.owners) && Array.isArray(value.versions),
    'invalid B2 metadata snapshot');
  return { key, value };
}

export async function validateB2Snapshot(value) {
  const owners = new Map();
  const folded = new Set();
  for (const owner of value.owners) {
    requireValid(namePattern.test(owner.name ?? '') && owner.name.length <= 128 &&
      !folded.has(owner.name.toLowerCase()) && /^[0-9]+$/.test(owner.github_id ?? ''),
    'invalid B2 owner');
    owners.set(owner.name, owner);
    folded.add(owner.name.toLowerCase());
  }
  const records = [];
  const objects = new Map();
  const versions = new Map();
  const identities = new Set();
  for (const row of value.versions) {
    requireValid(typeof row.descriptor === 'string' && shaPattern.test(row.digest ?? ''),
      'invalid B2 version');
    const decoded = JSON.parse(row.descriptor);
    const { manifest } = descriptor(decoded);
    const id = `${manifest.name}@${manifest.version}`;
    requireValid(row.name === manifest.name && row.version === manifest.version && owners.has(row.name) &&
      !identities.has(id) && row.digest === hash(row.descriptor) && row.descriptor === canonical(decoded),
    `invalid B2 version ${id}`);
    identities.add(id);
    versions.set(row.name, [...(versions.get(row.name) ?? []), row.version]);
    for (const blob of [decoded.source, ...(decoded.artifacts ?? [])]) {
      const prior = objects.get(blob.sha256);
      requireValid(!prior || prior.size === blob.size, `B2 object size conflict ${blob.sha256}`);
      if (!prior) objects.set(blob.sha256, { size: blob.size });
    }
    records.push({ id, name: row.name, version: row.version, githubId: owners.get(row.name).github_id,
      digest: row.digest, descriptor: row.descriptor });
  }
  for (const row of value.versions) {
    const manifest = JSON.parse(JSON.parse(row.descriptor).manifest);
    for (const [name, constraint] of Object.entries(manifest.dependencies ?? {})) {
      requireValid((versions.get(name) ?? []).some(version => acceptsDependency(constraint, version)),
        `missing B2 dependency ${row.name}@${row.version}: ${name}${constraint}`);
    }
  }
  return { owners, records, objects };
}

async function downloadObject(config, digest, item, root) {
  const path = join(root, 'objects', digest);
  await mkdir(dirname(path), { recursive: true });
  const response = await checkedFetch(config,
    objectUrl(config, `${config.prefix}/objects/sha256/${digest}`));
  requireValid(response.body, `empty B2 object ${digest}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: 'wx' }));
  requireValid((await stat(path)).size === item.size, `B2 object size mismatch ${digest}`);
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(path)) checksum.update(chunk);
  requireValid(checksum.digest('hex') === digest, `B2 object digest mismatch ${digest}`);
  item.path = path;
}

export async function restoreB2({ database, bucket, config, storage, persistTo, origin, token,
  values = process.env, progress = console.log }) {
  const source = configuration(values);
  const snapshot = await latestSnapshot(source);
  const checked = await validateB2Snapshot(snapshot.value);
  const scratch = await mkdtemp(join(tmpdir(), 'silex-b2-restore-'));
  try {
    let done = 0;
    for (const [digest, item] of checked.objects) {
      await downloadObject(source, digest, item, scratch);
      done++;
      if (done % 10 === 0 || done === checked.objects.size)
        progress(JSON.stringify({ phase: 'download', done, total: checked.objects.size }));
    }
    for (const record of checked.records) {
      const value = JSON.parse(record.descriptor);
      const sourceObject = checked.objects.get(value.source.sha256);
      await verifySourceArchive(await readFile(sourceObject.path), value, async bytes => hash(bytes));
    }
    progress(JSON.stringify({ phase: 'verified', snapshot: snapshot.key,
      versions: checked.records.length, names: checked.owners.size, objects: checked.objects.size }));
    return await importValidatedStore({ checked, database, bucket, config, storage, persistTo,
      origin, token, requireEmpty: true, progress });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [storageFlag, database, bucket, config, persistTo] = process.argv.slice(2);
  if (!['--local', '--remote'].includes(storageFlag) || !database || !bucket || !config)
    throw new Error('usage: restore-b2 --local|--remote DATABASE BUCKET CONFIG [PERSIST_TO]');
  await restoreB2({ storage: storageFlag.slice(2), database, bucket, config, persistTo });
}
