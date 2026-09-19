import { AwsClient } from 'aws4fetch';

const encoder = new TextEncoder();
const shaPattern = /^[a-f0-9]{64}$/;
const bucketPattern = /^(?!b2-)[a-z0-9](?:[a-z0-9-]{4,61}[a-z0-9])$/;
const prefixPattern = /^[a-z0-9][a-z0-9/-]{0,127}$/;
const defaultLimit = 8 * 1024 * 1024 * 1024;
const clients = new WeakMap();
const active = new Map();

export class BackupFailure extends Error {
  constructor(status, code, details = {}) {
    super(code);
    this.status = status;
    this.code = code;
    Object.assign(this, details);
  }
}

function reject(condition, status, code) {
  if (!condition) throw new BackupFailure(status, code);
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function checksumHeader(value) {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 2)
    binary += String.fromCharCode(Number.parseInt(value.slice(offset, offset + 2), 16));
  return btoa(binary);
}

async function digest(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

function configuration(env) {
  if (env.BACKUP_REQUIRED !== '1') return null;
  const endpoint = String(env.BACKUP_ENDPOINT ?? '').replace(/\/$/, '');
  const bucket = String(env.BACKUP_BUCKET ?? '');
  const prefix = String(env.BACKUP_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const limit = Number(env.BACKUP_LIMIT_BYTES ?? defaultLimit);
  const retentionDays = Number(env.BACKUP_RETENTION_DAYS ?? 90);
  reject(/^https:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(endpoint) &&
    bucketPattern.test(bucket) && prefixPattern.test(prefix) &&
    typeof env.BACKUP_ACCESS_KEY_ID === 'string' && env.BACKUP_ACCESS_KEY_ID.length >= 10 &&
    typeof env.BACKUP_SECRET_ACCESS_KEY === 'string' && env.BACKUP_SECRET_ACCESS_KEY.length >= 20 &&
    Number.isSafeInteger(limit) && limit > 0 && limit <= 9_000_000_000 &&
    Number.isSafeInteger(retentionDays) && retentionDays >= 30 && retentionDays <= 365,
  503, 'backup_configuration');
  return { endpoint, bucket, prefix, limit, retentionDays };
}

function client(env) {
  if (typeof env.BACKUP_FETCH === 'function') return { fetch: env.BACKUP_FETCH };
  let value = clients.get(env);
  if (!value) {
    value = new AwsClient({ accessKeyId: env.BACKUP_ACCESS_KEY_ID,
      secretAccessKey: env.BACKUP_SECRET_ACCESS_KEY, service: 's3', retries: 0 });
    clients.set(env, value);
  }
  return value;
}

function objectUrl(config, key) {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${config.endpoint}/${config.bucket}/${encoded}`;
}

async function request(env, config, key, init) {
  try {
    return await client(env).fetch(objectUrl(config, key), init);
  } catch (error) {
    throw new BackupFailure(503, 'backup_unavailable', {
      operation: init.method, upstreamError: error?.name ?? 'Error' });
  }
}

async function upstreamDetails(response) {
  try {
    const text = await response.text();
    const code = /<Code>([^<]{1,80})<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]{1,160})<\/Message>/.exec(text)?.[1];
    return { ...(code ? { upstreamCode: code } : {}),
      ...(message ? { upstreamMessage: message } : {}) };
  } catch { return {}; }
}

async function head(env, config, key) {
  const response = await request(env, config, key, { method: 'HEAD' });
  if (response.status === 404) return null;
  if (!response.ok) throw new BackupFailure(503, 'backup_unavailable', {
    operation: 'HEAD', upstreamStatus: response.status });
  const size = Number(response.headers.get('content-length'));
  const sha256 = response.headers.get('x-amz-meta-sha256');
  reject(Number.isSafeInteger(size) && size >= 0 && shaPattern.test(sha256 ?? ''),
    503, 'backup_invalid');
  return { size, sha256 };
}

function fixedBody(body, size) {
  if (!body || typeof body.getReader !== 'function' || typeof FixedLengthStream === 'undefined')
    return { body, completed: Promise.resolve() };
  const stream = new FixedLengthStream(size);
  return { body: stream.readable, completed: body.pipeTo(stream.writable) };
}

async function put(env, config, key, bytes, size, sha256) {
  const fixed = fixedBody(bytes, size);
  const retainedUntil = new Date(Date.now() + config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const upload = request(env, config, key, { method: 'PUT', body: fixed.body, headers: {
    'content-type': 'application/octet-stream', 'content-length': String(size),
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-meta-sha256': sha256,
    'x-amz-checksum-sha256': checksumHeader(sha256),
    'x-amz-server-side-encryption': 'AES256',
    'x-amz-object-lock-mode': 'GOVERNANCE',
    'x-amz-object-lock-retain-until-date': retainedUntil,
  } });
  let response;
  try { [response] = await Promise.all([upload, fixed.completed]); }
  catch { throw new BackupFailure(503, 'backup_unavailable'); }
  if (!response.ok) throw new BackupFailure(503, 'backup_unavailable', {
    operation: 'PUT', upstreamStatus: response.status, ...await upstreamDetails(response) });
}

async function ensureObject(env, config, logicalKey, size, sha256, source) {
  reject(Number.isSafeInteger(size) && size >= 0 && shaPattern.test(sha256), 503, 'backup_invalid');
  const key = `${config.prefix}/${logicalKey}`;
  const identity = `${config.endpoint}/${config.bucket}/${key}`;
  if (active.has(identity)) return active.get(identity);
  const operation = (async () => {
    const present = await head(env, config, key);
    if (present) {
      reject(present.size === size && present.sha256 === sha256, 503, 'backup_conflict');
      return { copied: false, key };
    }
    const body = await source();
    reject(body, 503, 'backup_source_missing');
    await put(env, config, key, body, size, sha256);
    const stored = await head(env, config, key);
    reject(stored?.size === size && stored.sha256 === sha256, 503, 'backup_unavailable');
    return { copied: true, key };
  })();
  active.set(identity, operation);
  try { return await operation; }
  finally { active.delete(identity); }
}

function addObjects(target, value) {
  for (const item of [value?.source, ...(Array.isArray(value?.artifacts) ? value.artifacts : [])]) {
    reject(item && shaPattern.test(item.sha256 ?? '') && Number.isSafeInteger(item.size) && item.size > 0,
      503, 'backup_metadata_invalid');
    const previous = target.get(item.sha256);
    reject(previous === undefined || previous === item.size, 503, 'backup_metadata_invalid');
    target.set(item.sha256, item.size);
  }
}

async function storedObjects(env) {
  const objects = new Map();
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(
      'SELECT descriptor FROM probe_versions ORDER BY name,version LIMIT 500 OFFSET ?').bind(offset).all();
    for (const row of results) {
      let value;
      try { value = JSON.parse(row.descriptor); }
      catch { throw new BackupFailure(503, 'backup_metadata_invalid'); }
      addObjects(objects, value);
    }
    if (results.length < 500) break;
    offset += results.length;
  }
  return objects;
}

export async function backupFootprint(env, value = null) {
  const config = configuration(env);
  if (!config) return { enabled: false, bytes: 0, objects: 0 };
  const objects = await storedObjects(env);
  if (value) addObjects(objects, value);
  const bytes = [...objects.values()].reduce((sum, size) => sum + size, 0);
  reject(bytes <= config.limit, 507, 'backup_capacity');
  return { enabled: true, bytes, objects: objects.size };
}

function r2ObjectValid(object, size, expected) {
  return object?.size === size && object.checksums?.sha256 && hex(object.checksums.sha256) === expected;
}

async function jsonObject(env, config, logicalKey, value) {
  const bytes = encoder.encode(JSON.stringify(value));
  const sha256 = await digest(bytes);
  return ensureObject(env, config, logicalKey, bytes.byteLength, sha256, async () => bytes);
}

export async function backupR2Object(env, sha256, size) {
  const config = configuration(env);
  if (!config) return { enabled: false };
  return ensureObject(env, config, `objects/sha256/${sha256}`, size, sha256, async () => {
    const object = await env.OBJECTS.get(`probe/objects/sha256/${sha256}`);
    reject(r2ObjectValid(object, size, sha256), 503, 'backup_source_missing');
    return object.body;
  });
}

export async function backupPublicationRecord(env, row) {
  const config = configuration(env);
  if (!config) return { enabled: false };
  const publication = { schema: 1, name: row.name, version: row.version,
    github_id: row.credential, publication_sha256: row.digest, descriptor: row.descriptor };
  return jsonObject(env, config, `publications/${row.digest}.json`, publication);
}

async function allRows(env, sql) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { results } = await env.DB.prepare(`${sql} LIMIT 500 OFFSET ?`).bind(offset).all();
    rows.push(...results);
    if (results.length < 500) break;
    offset += results.length;
  }
  return rows;
}

export async function backupMetadataSnapshot(env) {
  const config = configuration(env);
  if (!config) return { enabled: false };
  const owners = await allRows(env, 'SELECT name,github_id FROM probe_names ORDER BY name');
  const versions = await allRows(env,
    'SELECT name,version,digest,descriptor FROM probe_versions ORDER BY name,version');
  const snapshot = { schema: 2, owners, versions };
  const bytes = encoder.encode(JSON.stringify(snapshot));
  const sha256 = await digest(bytes);
  const name = `metadata/v${String(versions.length).padStart(10, '0')}-n${String(owners.length).padStart(10, '0')}-${sha256}.json`;
  const result = await ensureObject(env, config, name, bytes.byteLength, sha256, async () => bytes);
  return { enabled: true, copied: result.copied, sha256, owners: owners.length,
    versions: versions.length, bytes: bytes.byteLength, key: result.key };
}
