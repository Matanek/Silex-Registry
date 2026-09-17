import { loginFetch } from './login.mjs';
import { inspectProvenance, ProvenanceFailure, verifyRepository } from './provenance.mjs';

const encoder = new TextEncoder();
const sha = /^[a-f0-9]{64}$/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const targets = new Set(['macos-arm64', 'macos-x64', 'linux-arm64', 'linux-x64', 'windows-arm64', 'windows-x64']);
const maxMetadata = 262144;
const maxChunk = 65536;
const maxObject = 8 * 1024 * 1024; // Task-09 probe bound; production limits are not established.

class Rejection extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function insist(condition, code, status = 422) {
  if (!condition) throw new Rejection(status, code);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  insist(value !== undefined && !Number.isNaN(value) && (typeof value !== 'number' || Number.isSafeInteger(value)), 'invalid_descriptor');
  return JSON.stringify(value);
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function hex(bytes) { return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function digest(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
function key(digest) { return `probe/objects/sha256/${digest}`; }
function chunkKey(session, object, offset, chunk) { return `probe/uploads/${session}/${object}/${offset}-${chunk}`; }
async function inventory(env, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await env.OBJECTS.list({ prefix, cursor });
    objects.push(...page.objects.map(item => ({ key: item.key, size: item.size })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
function objectValid(object, size, expected) {
  return object?.size === size && object.checksums?.sha256 && hex(object.checksums.sha256) === expected;
}
async function jsonBody(request) {
  insist(Number(request.headers.get('content-length') ?? 0) <= maxMetadata, 'metadata_limit', 413);
  const bytes = await request.arrayBuffer();
  insist(bytes.byteLength <= maxMetadata, 'metadata_limit', 413);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Rejection(422, 'invalid_json'); }
}
function descriptor(value) {
  insist(value && typeof value === 'object' && !Array.isArray(value) && value.schema === 1, 'unsupported_descriptor');
  insist(exactKeys(value, value.provenance === undefined ?
    ['artifacts', 'files', 'manifest', 'schema', 'source'] :
    ['artifacts', 'files', 'manifest', 'provenance', 'schema', 'source']), 'invalid_descriptor');
  inspectProvenance(value.provenance, false);
  insist(typeof value.manifest === 'string' && value.manifest.length <= maxMetadata, 'invalid_manifest');
  let manifest;
  try { manifest = JSON.parse(value.manifest); } catch { throw new Rejection(422, 'invalid_manifest'); }
  insist(namePattern.test(manifest?.name ?? '') && manifest.name.length <= 128 &&
    versionPattern.test(manifest?.version ?? ''), 'invalid_identity');
  insist(exactKeys(value.source, ['sha256', 'size']) && sha.test(value.source.sha256 ?? '') && Number.isSafeInteger(value.source.size) &&
    value.source.size > 0 && value.source.size <= maxObject, 'invalid_source');
  insist(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 4096, 'invalid_files');
  const files = new Set();
  for (const file of value.files) {
    insist(exactKeys(file, ['path', 'sha256', 'size']) && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 512 &&
      !file.path.startsWith('/') && !file.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) &&
      sha.test(file.sha256 ?? '') && Number.isSafeInteger(file.size) && file.size >= 0, 'invalid_file');
    insist(!files.has(file.path.toLowerCase()), 'path_collision');
    files.add(file.path.toLowerCase());
  }
  const manifestFile = value.files.find(file => file.path === 'Package.json');
  insist(manifestFile, 'missing_manifest');
  const objects = new Map([[value.source.sha256, value.source.size]]);
  insist(Array.isArray(value.artifacts) && value.artifacts.length <= 256, 'invalid_artifacts');
  const entries = new Set();
  for (const item of value.artifacts) {
    insist(exactKeys(item, ['name', 'path', 'sha256', 'size', 'target']) && targets.has(item.target) && namePattern.test(item.name ?? '') &&
      typeof item.path === 'string' && item.path.length > 0 && !item.path.startsWith('/') &&
      !item.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) &&
      sha.test(item.sha256 ?? '') && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= maxObject,
    'invalid_artifact');
    insist(!entries.has(`${item.target}/${item.name}`), 'duplicate_artifact');
    entries.add(`${item.target}/${item.name}`);
    const declared = manifest.artifacts?.[item.target]?.[item.name];
    insist(declared?.path === item.path && declared?.sha256 === item.sha256, 'artifact_mismatch');
    insist(!objects.has(item.sha256) || objects.get(item.sha256) === item.size, 'object_size_conflict');
    objects.set(item.sha256, item.size);
  }
  for (const [target, named] of Object.entries(manifest.artifacts ?? {})) {
    insist(targets.has(target) && named && typeof named === 'object', 'invalid_artifacts');
    for (const name of Object.keys(named)) insist(entries.has(`${target}/${name}`), 'missing_target_artifact');
  }
  return { manifest, objects };
}
async function authenticate(request, env) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  insist(match, 'unauthorized', 401);
  const credential = await digest(encoder.encode(match[1]));
  if (sha.test(env.STAGING_TOKEN_SHA256 ?? '') && credential === env.STAGING_TOKEN_SHA256) return '__probe__';
  const row = await env.DB.prepare('SELECT github_id FROM probe_credentials WHERE digest=? AND revoked=0 AND expires_at>?')
    .bind(credential, Math.floor(Date.now() / 1000)).first();
  insist(row, 'unauthorized', 401);
  return row.github_id;
}
async function session(env, id, githubId) {
  const row = await env.DB.prepare('SELECT * FROM probe_sessions WHERE id=?').bind(id).first();
  insist(row, 'publication_not_found', 404);
  insist(row.credential === githubId, 'forbidden', 403);
  return row;
}
async function owner(env, name, githubId) {
  const current = await env.DB.prepare('SELECT name,github_id FROM probe_names WHERE name=?').bind(name).first();
  insist(!current || (current.name === name && current.github_id === githubId), 'name_unavailable', 403);
  const components = name.split('.');
  components.pop();
  while (components.length) {
    const parent = components.join('.');
    const registered = await env.DB.prepare('SELECT name,github_id FROM probe_names WHERE name=?').bind(parent).first();
    insist(registered?.name === parent && registered.github_id === githubId, 'namespace_unavailable', 403);
    components.pop();
  }
}
async function parts(env, id, object) {
  const result = await env.DB.prepare('SELECT offset,size,chunk_digest FROM probe_chunks WHERE session_id=? AND object_digest=? ORDER BY offset').bind(id, object).all();
  return result.results;
}
async function progress(env, id, object, size) {
  let offset = 0;
  const rows = await parts(env, id, object);
  for (const row of rows) {
    if (row.offset !== offset) break;
    offset += row.size;
  }
  insist(offset <= size, 'upload_corrupt', 503);
  return { offset, rows };
}
async function status(env, row) {
  const { objects } = descriptor(JSON.parse(row.descriptor));
  const version = await env.DB.prepare('SELECT digest FROM probe_versions WHERE name=? AND version=?').bind(row.name, row.version).first();
  const listed = [];
  for (const [object, size] of objects) {
    const stored = await env.OBJECTS.head(key(object));
    const available = Boolean(objectValid(stored, size, object));
    listed.push({ sha256: object, size, offset: available ? size : (await progress(env, row.id, object, size)).offset, available });
  }
  return { id: row.id, state: version?.digest === row.digest ? 'published' : 'receiving', publication_sha256: row.digest,
    objects: listed.sort((a, b) => a.sha256.localeCompare(b.sha256)) };
}
async function create(request, env, githubId, verify) {
  const value = await jsonBody(request);
  const { manifest } = descriptor(value);
  const provenance = inspectProvenance(value.provenance, githubId !== '__probe__');
  if (githubId !== '__probe__') await verify(provenance, githubId);
  await owner(env, manifest.name, githubId);
  const manifestHash = await digest(encoder.encode(value.manifest));
  const manifestFile = value.files.find(file => file.path === 'Package.json');
  insist(manifestFile.size === encoder.encode(value.manifest).byteLength && manifestFile.sha256 === manifestHash, 'manifest_mismatch');
  const normalized = canonical(value);
  const publication = await digest(encoder.encode(normalized));
  const existing = await env.DB.prepare('SELECT digest FROM probe_versions WHERE name=? AND version=?').bind(manifest.name, manifest.version).first();
  insist(!existing || existing.digest === publication, 'version_conflict', 409);
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('INSERT OR IGNORE INTO probe_sessions VALUES (?,?,?,?,?,?,?)')
    .bind(id, githubId, publication, manifest.name, manifest.version, normalized, Date.now()).run();
  const row = await env.DB.prepare('SELECT * FROM probe_sessions WHERE credential=? AND digest=?').bind(githubId, publication).first();
  return status(env, row);
}
async function append(request, env, row, object, offset) {
  const value = JSON.parse(row.descriptor);
  const size = descriptor(value).objects.get(object);
  insist(size !== undefined, 'object_not_declared', 404);
  const current = await status(env, row);
  insist(current.state === 'receiving', 'already_published', 409);
  const item = current.objects.find(entry => entry.sha256 === object);
  if (item.available) return { offset: size };
  insist(offset === item.offset, 'offset_conflict', 409);
  insist(Number(request.headers.get('content-length') ?? 0) <= maxChunk, 'chunk_limit', 413);
  const bytes = await request.arrayBuffer();
  insist(bytes.byteLength > 0 && bytes.byteLength <= maxChunk && offset + bytes.byteLength <= size, 'chunk_limit', 413);
  const chunk = await digest(bytes);
  const stored = await env.OBJECTS.put(chunkKey(row.id, object, offset, chunk), bytes,
    { onlyIf: { etagDoesNotMatch: '*' }, sha256: chunk });
  if (!stored) {
    const previous = await env.OBJECTS.head(chunkKey(row.id, object, offset, chunk));
    insist(objectValid(previous, bytes.byteLength, chunk), 'chunk_collision', 503);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO probe_chunks VALUES (?,?,?,?,?)')
    .bind(row.id, object, offset, bytes.byteLength, chunk).run();
  const chosen = await env.DB.prepare('SELECT size,chunk_digest FROM probe_chunks WHERE session_id=? AND object_digest=? AND offset=?')
    .bind(row.id, object, offset).first();
  insist(chosen?.size === bytes.byteLength && chosen?.chunk_digest === chunk, 'chunk_conflict', 409);
  return { offset: offset + bytes.byteLength };
}
function probeFault(request, env, point) {
  if (env.PROBE_ALLOW_FAULTS === '1' && request.headers.get('x-probe-fault') === point) {
    throw new Rejection(503, `injected_${point}`);
  }
}
async function persistObject(request, env, row, object, size) {
  if (objectValid(await env.OBJECTS.head(key(object)), size, object)) return;
  const { offset, rows } = await progress(env, row.id, object, size);
  insist(offset === size, 'missing_object', 409);
  probeFault(request, env, 'before_object');
  const stream = new FixedLengthStream(size);
  const writer = stream.writable.getWriter();
  const producer = (async () => {
    for (const part of rows) {
      const value = await env.OBJECTS.get(chunkKey(row.id, object, part.offset, part.chunk_digest));
      if (!objectValid(value, part.size, part.chunk_digest)) throw new Error('missing_chunk');
      await writer.write(new Uint8Array(await value.arrayBuffer()));
    }
    await writer.close();
  })();
  try {
    const stored = await env.OBJECTS.put(key(object), stream.readable, { onlyIf: { etagDoesNotMatch: '*' }, sha256: object });
    if (!stored) await writer.abort().catch(() => {});
    await producer.catch(error => { if (stored) throw error; });
  } catch {
    await writer.abort().catch(() => {});
    await producer.catch(() => {});
    // Re-read only on failure: distinguish untrusted bytes from a transient R2 failure.
    const bytes = new Uint8Array(size);
    for (const part of rows) {
      const value = await env.OBJECTS.get(chunkKey(row.id, object, part.offset, part.chunk_digest));
      insist(objectValid(value, part.size, part.chunk_digest), 'missing_chunk', 503);
      bytes.set(new Uint8Array(await value.arrayBuffer()), part.offset);
    }
    insist(await digest(bytes) === object, 'digest_mismatch');
    throw new Rejection(503, 'object_store_unavailable');
  }
  insist(objectValid(await env.OBJECTS.head(key(object)), size, object), 'object_store_unavailable', 503);
  probeFault(request, env, 'after_object');
}
async function finalize(request, env, row, verify) {
  const value = JSON.parse(row.descriptor);
  const { objects, manifest } = descriptor(value);
  const provenance = inspectProvenance(value.provenance, row.credential !== '__probe__');
  if (row.credential !== '__probe__') await verify(provenance, row.credential);
  await owner(env, row.name, row.credential);
  const existing = await env.DB.prepare('SELECT digest FROM probe_versions WHERE name=? AND version=?').bind(row.name, row.version).first();
  insist(!existing || existing.digest === row.digest, 'version_conflict', 409);
  if (!existing) {
    for (const [object, size] of objects) await persistObject(request, env, row, object, size);
    for (const [name, constraint] of Object.entries(manifest.dependencies ?? {})) {
      const versions = await env.DB.prepare('SELECT version FROM probe_versions WHERE name=?').bind(name).all();
      const wanted = String(constraint).slice(1);
      insist(versions.results.some(found => constraint[0] === '=' ? found.version === wanted :
        constraint[0] === '^' && found.version.split('.')[0] === wanted.split('.')[0] && found.version >= wanted),
      'missing_dependency', 409);
    }
    probeFault(request, env, 'before_visibility');
    // The single row is the public visibility boundary. R2 has already confirmed every object.
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO probe_names(name,github_id) VALUES (?,?)').bind(row.name, row.credential),
      env.DB.prepare('INSERT OR IGNORE INTO probe_versions(name,version,digest,descriptor) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM probe_names WHERE name=? AND github_id=?)')
        .bind(row.name, row.version, row.digest, row.descriptor, row.name, row.credential),
    ]);
    probeFault(request, env, 'after_visibility');
  }
  await owner(env, row.name, row.credential);
  const winner = await env.DB.prepare('SELECT digest FROM probe_versions WHERE name=? AND version=?').bind(row.name, row.version).first();
  insist(winner?.digest === row.digest, 'version_conflict', 409);
  return status(env, row);
}
async function publicRead(request, env, name, version, target, artifact) {
  insist(namePattern.test(name) && (!version || versionPattern.test(version)), 'invalid_route', 404);
  if (!version) {
    const rows = await env.DB.prepare('SELECT version,digest FROM probe_versions WHERE name=?').bind(name).all();
    insist(rows.results.length, 'package_not_found', 404);
    return Response.json({ name, versions: rows.results.sort((a, b) => b.version.localeCompare(a.version)) },
      { headers: { 'content-encoding': 'identity', 'cache-control': 'no-transform' } });
  }
  const row = await env.DB.prepare('SELECT digest,descriptor FROM probe_versions WHERE name=? AND version=?').bind(name, version).first();
  insist(row, 'version_not_found', 404);
  if (!target) return Response.json({ publication_sha256: row.digest, descriptor: JSON.parse(row.descriptor) },
    { headers: { 'content-encoding': 'identity', 'cache-control': 'no-transform' } });
  const value = JSON.parse(row.descriptor);
  const blob = target === 'source' ? value.source : value.artifacts.find(item => item.target === target && item.name === artifact);
  insist(blob, 'artifact_not_found', 404);
  const stored = await env.OBJECTS.get(key(blob.sha256));
  insist(objectValid(stored, blob.size, blob.sha256), 'stored_object_missing', 503);
  return new Response(request.method === 'HEAD' ? null : stored.body, { headers: {
    'content-type': 'application/octet-stream', 'content-length': String(blob.size),
    'content-encoding': 'identity', 'cache-control': 'no-transform', etag: `"${blob.sha256}"`,
  } });
}
export async function workerFetch(request, env, verify = verifyRepository) {
    try {
      const url = new URL(request.url);
      insist(!url.search && !url.hash && !url.pathname.includes('%') && url.pathname.length <= 512, 'invalid_route', 400);
      const route = url.pathname;
      const login = await loginFetch(request, env, route);
      if (login) return login;
      if (route === '/__probe/inventory' && request.method === 'GET') {
        await authenticate(request, env);
        return Response.json({ objects: await inventory(env, 'probe/objects/sha256/'),
          uploads: await inventory(env, 'probe/uploads/') });
      }
      if (route === '/v2/publications' && request.method === 'POST') {
        return Response.json(await create(request, env, await authenticate(request, env), verify));
      }
      let match = /^\/v2\/publications\/([a-f0-9]{32})(?:\/(finalize|objects\/([a-f0-9]{64})))?$/.exec(route);
      if (match) {
        const credential = await authenticate(request, env);
        const row = await session(env, match[1], credential);
        if (!match[2] && request.method === 'GET') return Response.json(await status(env, row));
        if (match[2] === 'finalize' && request.method === 'POST') return Response.json(await finalize(request, env, row, verify));
        if (match[3] && request.method === 'PATCH') {
          const offset = Number(request.headers.get('upload-offset'));
          insist(Number.isSafeInteger(offset) && offset >= 0, 'invalid_offset', 400);
          return Response.json(await append(request, env, row, match[3], offset));
        }
        if (match[3] && request.method === 'HEAD') {
          const result = await status(env, row);
          const object = result.objects.find(item => item.sha256 === match[3]);
          insist(object, 'object_not_declared', 404);
          return new Response(null, { headers: { 'upload-offset': String(object.offset), 'upload-length': String(object.size) } });
        }
        throw new Rejection(405, 'method_not_allowed');
      }
      match = /^\/v2\/packages\/([A-Za-z0-9_.]+)(?:\/versions\/([0-9.]+)(?:\/(source|artifacts\/([a-z0-9-]+)\/([A-Za-z0-9_.]+)))?)?$/.exec(route);
      if (match && ['GET', 'HEAD'].includes(request.method)) {
        return await publicRead(request, env, match[1], match[2], match[3] === 'source' ? 'source' : match[4], match[5]);
      }
      throw new Rejection(404, 'route_not_found');
    } catch (error) {
      const status = error instanceof Rejection || error instanceof ProvenanceFailure ? error.status : 503;
      const code = error instanceof Rejection || error instanceof ProvenanceFailure ? error.code : 'storage_unavailable';
      return Response.json({ error: code, message: code.replaceAll('_', ' '), retryable: [429, 503, 507].includes(status) },
        { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
}
export default { fetch(request, env) { return workerFetch(request, env); } };
