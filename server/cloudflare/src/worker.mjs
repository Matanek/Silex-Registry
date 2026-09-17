import { loginFetch } from './login.mjs';
import { inspectProvenance, ProvenanceFailure } from './provenance.mjs';
import { ArchiveFailure, maxExpanded, verifySourceArchive } from './archive.mjs';

const encoder = new TextEncoder();
const sha = /^[a-f0-9]{64}$/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const targets = new Set(['macos-arm64', 'macos-x64', 'linux-arm64', 'linux-x64', 'windows-arm64', 'windows-x64']);
const maxMetadata = 262144;
const maxChunk = 65536;
const maxSourceObject = 32 * 1024 * 1024;
const maxArtifactObject = 64 * 1024 * 1024; // Historical SDL requires 51,047,580 bytes.
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const sessionPruneAge = 8 * 24 * 60 * 60 * 1000;

class Rejection extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function insist(condition, code, status = 422) {
  if (!condition) throw new Rejection(status, code);
}
export function canonical(value) {
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
function parseVersion(text) {
  const match = typeof text === 'string' ? versionPattern.exec(text) : null;
  if (!match || match.slice(1).some(part => part.length > 10 || Number(part) > 4294967295)) return null;
  return match.slice(1).map(Number);
}
function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function validName(name) {
  return typeof name === 'string' && name.length <= 128 && namePattern.test(name) &&
    !['Package', 'Module'].includes(name.split('.')[0]);
}
function validModuleName(name) { return typeof name === 'string' && namePattern.test(name); }
function safePath(path) {
  if (typeof path !== 'string' || !path || encoder.encode(path).byteLength > 240 || path.normalize('NFC') !== path ||
    /[\x00-\x1f\x7f\\:<>"|?*]/u.test(path)) return false;
  for (const scalar of path) {
    const code = scalar.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return path.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !['.git', '.silex'].includes(part.toLowerCase()) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}
function noPathCollision(paths) {
  const keys = new Set();
  for (const path of paths) {
    const key = path.toLowerCase();
    insist(!keys.has(key), 'path_collision');
    keys.add(key);
  }
  for (const key of keys) {
    for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
      insist(!keys.has(key.slice(0, slash)), 'path_collision');
    }
  }
}
function metadataLine(value) {
  return typeof value === 'string' && value.length > 0 &&
    !/^[ \t\r\n]|[ \t\r\n]$|[\r\n]/.test(value);
}
function validateEditorialMetadata(manifest) {
  if (manifest.description !== undefined) {
    const description = manifest.description;
    if (typeof description === 'string') insist(metadataLine(description), 'invalid_description');
    else {
      insist(description && typeof description === 'object' && !Array.isArray(description) &&
        Object.keys(description).length > 0, 'invalid_description');
      const languages = new Set();
      for (const [language, text] of Object.entries(description)) {
        const folded = language.toLowerCase();
        insist(language.length <= 35 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language) &&
          !languages.has(folded) && metadataLine(text), 'invalid_description');
        languages.add(folded);
      }
      insist(languages.has('en'), 'invalid_description');
    }
  }
  if (manifest.authors !== undefined) {
    insist(Array.isArray(manifest.authors) && manifest.authors.length > 0 &&
      manifest.authors.every(metadataLine) && new Set(manifest.authors).size === manifest.authors.length,
    'invalid_authors');
  }
  if (manifest.extensions !== undefined) {
    const grants = manifest.extensions;
    insist((Array.isArray(grants) && grants.length === 0) ||
      (grants && typeof grants === 'object' && !Array.isArray(grants)), 'invalid_extensions');
    for (const [grant, permissions] of Object.entries(grants)) {
      const child = grant.startsWith(`${manifest.name}.`) ? grant.slice(manifest.name.length + 1) : '';
      insist(child === '*' || (validModuleName(child) && !child.includes('.')), 'invalid_extensions');
      insist(permissions && typeof permissions === 'object' && !Array.isArray(permissions) &&
        Object.entries(permissions).every(([key, enabled]) =>
          ['friend', 'suite', 'merge'].includes(key) && typeof enabled === 'boolean'), 'invalid_extensions');
      insist(child !== '*' || (!permissions.suite && !permissions.merge), 'invalid_extensions');
    }
  }
  if (manifest.catalogs !== undefined) {
    insist(Array.isArray(manifest.catalogs) && manifest.catalogs.every(catalog =>
      validModuleName(catalog) && (catalog === manifest.name || catalog.startsWith(`${manifest.name}.`))) &&
      new Set(manifest.catalogs).size === manifest.catalogs.length, 'invalid_catalogs');
  }
}
function validateBoundary(boundary) {
  if (boundary === undefined) return;
  insist(boundary && typeof boundary === 'object' && !Array.isArray(boundary), 'invalid_boundary');
  for (const [target, declaration] of Object.entries(boundary)) {
    insist(targets.has(target) && exactKeys(declaration, ['providers']) &&
      declaration.providers && typeof declaration.providers === 'object' &&
      !Array.isArray(declaration.providers), 'invalid_boundary');
    for (const [name, provider] of Object.entries(declaration.providers)) {
      insist(validModuleName(name) && !name.includes('.') && provider && typeof provider === 'object' &&
        !Array.isArray(provider) && Object.keys(provider).length > 0 &&
        Object.keys(provider).every(key => ['archive', 'frameworks', 'libraries', 'requires'].includes(key)),
      'invalid_boundary');
      if (provider.archive !== undefined) insist(safePath(provider.archive), 'invalid_boundary');
      if (provider.frameworks !== undefined) {
        insist(Array.isArray(provider.frameworks) && provider.frameworks.every(item =>
          validModuleName(item) && !item.includes('.')) &&
          new Set(provider.frameworks).size === provider.frameworks.length &&
          (target.startsWith('macos-') || provider.frameworks.length === 0), 'invalid_boundary');
      }
      if (provider.libraries !== undefined) {
        insist(Array.isArray(provider.libraries) && provider.libraries.every(item =>
          typeof item === 'string' && /^[A-Za-z0-9_.+-]+$/.test(item)) &&
          new Set(provider.libraries).size === provider.libraries.length, 'invalid_boundary');
      }
      if (provider.requires !== undefined) {
        insist(Array.isArray(provider.requires) && provider.requires.every(item => {
          if (!validModuleName(item)) return false;
          const separator = item.lastIndexOf('.');
          return separator > 0 && !item.slice(separator + 1).includes('.');
        }) && new Set(provider.requires).size === provider.requires.length, 'invalid_boundary');
      }
      insist(provider.archive !== undefined || provider.frameworks?.length ||
        provider.libraries?.length || provider.requires?.length, 'invalid_boundary');
    }
  }
}
function validateManifest(manifest) {
  const fields = new Set(['name', 'version', 'repository', 'sources', 'description', 'authors', 'extensions',
    'friends', 'catalogs', 'requires', 'dependencies', 'devDependencies', 'boundary', 'artifacts']);
  insist(manifest && typeof manifest === 'object' && !Array.isArray(manifest) &&
    Object.keys(manifest).every(field => fields.has(field)), 'invalid_manifest');
  insist(manifest.friends === undefined, 'invalid_friends');
  insist(validName(manifest?.name) && parseVersion(manifest?.version), 'invalid_identity');
  validateEditorialMetadata(manifest);
  validateBoundary(manifest.boundary);
  if (manifest.repository !== undefined) insist(typeof manifest.repository === 'string' &&
    manifest.repository.length <= 200 && /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(manifest.repository) &&
    !['.', '..'].includes(manifest.repository.split('/').at(-1)), 'invalid_repository');
  insist(exactKeys(manifest.requires, ['silex']) && typeof manifest.requires.silex === 'string', 'invalid_requirement');
  const clauses = manifest.requires.silex.split(' ');
  const minimum = clauses[0].startsWith('>=') ? parseVersion(clauses[0].slice(2)) : null;
  const maximum = clauses.length === 2 && clauses[1].startsWith('<') ? parseVersion(clauses[1].slice(1)) : null;
  insist(clauses.length <= 2 && minimum && (clauses.length === 1 || (maximum && compareVersions(maximum, minimum) > 0)),
    'invalid_requirement');
  if (manifest.sources !== undefined) insist(manifest.sources === '.' || safePath(manifest.sources), 'invalid_sources');
  for (const key of ['dependencies', 'devDependencies']) {
    const dependencies = manifest[key];
    if (dependencies === undefined) continue;
    insist(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies), 'invalid_dependencies');
    for (const [name, constraint] of Object.entries(dependencies)) {
      insist(validName(name) && name !== manifest.name && typeof constraint === 'string' &&
        ['=', '^'].includes(constraint[0]) && parseVersion(constraint.slice(1)) &&
        (key !== 'devDependencies' || !Object.hasOwn(manifest.dependencies ?? {}, name)), 'invalid_dependency');
    }
  }
  if (manifest.artifacts !== undefined) {
    insist(manifest.artifacts && typeof manifest.artifacts === 'object' && !Array.isArray(manifest.artifacts),
      'invalid_artifacts');
    for (const [target, named] of Object.entries(manifest.artifacts)) {
      insist(targets.has(target) && named && typeof named === 'object' && !Array.isArray(named) &&
        Object.keys(named).length > 0, 'invalid_artifacts');
    }
  }
}
function validatePaths(files, artifacts) {
  const source = files.map(file => file.path);
  noPathCollision(source);
  for (const target of targets) noPathCollision([...source, ...artifacts.filter(item => item.target === target).map(item => item.path)]);
}
export function acceptsDependency(constraint, candidate) {
  const minimum = parseVersion(constraint.slice(1));
  const found = parseVersion(candidate);
  if (!minimum || !found) return false;
  return constraint[0] === '=' ? compareVersions(found, minimum) === 0 :
    constraint[0] === '^' && found[0] === minimum[0] && compareVersions(found, minimum) >= 0;
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
async function boundedBody(request, limit, code) {
  const declared = request.headers.get('content-length');
  if (declared !== null) insist(/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= limit, code, 413);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Rejection(413, code);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function jsonBody(request) {
  const bytes = await boundedBody(request, maxMetadata, 'metadata_limit');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Rejection(422, 'invalid_json'); }
}
export function descriptor(value) {
  insist(value && typeof value === 'object' && !Array.isArray(value) && value.schema === 1, 'unsupported_descriptor');
  insist(exactKeys(value, value.provenance === undefined ?
    ['artifacts', 'files', 'manifest', 'schema', 'source'] :
    ['artifacts', 'files', 'manifest', 'provenance', 'schema', 'source']), 'invalid_descriptor');
  inspectProvenance(value.provenance);
  insist(typeof value.manifest === 'string' && value.manifest.length <= maxMetadata, 'invalid_manifest');
  let manifest;
  try { manifest = JSON.parse(value.manifest); } catch { throw new Rejection(422, 'invalid_manifest'); }
  validateManifest(manifest);
  insist(exactKeys(value.source, ['sha256', 'size']) && sha.test(value.source.sha256 ?? '') && Number.isSafeInteger(value.source.size) &&
    value.source.size > 0 && value.source.size <= maxSourceObject, 'invalid_source');
  insist(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 4096, 'invalid_files');
  let expanded = 0;
  for (const file of value.files) {
    insist(exactKeys(file, ['path', 'sha256', 'size']) && safePath(file.path) &&
      sha.test(file.sha256 ?? '') && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 16 * 1024 * 1024, 'invalid_file');
    expanded += file.size;
    insist(expanded <= maxExpanded, 'expanded_limit', 413);
  }
  const manifestFile = value.files.find(file => file.path === 'Package.json');
  insist(manifestFile, 'missing_manifest');
  insist(manifestFile.size === encoder.encode(value.manifest).byteLength, 'manifest_mismatch');
  const objects = new Map([[value.source.sha256, value.source.size]]);
  insist(Array.isArray(value.artifacts) && value.artifacts.length <= 256, 'invalid_artifacts');
  const entries = new Set();
  for (const item of value.artifacts) {
    insist(exactKeys(item, ['name', 'path', 'sha256', 'size', 'target']) && targets.has(item.target) && validName(item.name) &&
      safePath(item.path) &&
      sha.test(item.sha256 ?? '') && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= maxArtifactObject,
    'invalid_artifact');
    insist(!entries.has(`${item.target}/${item.name}`), 'duplicate_artifact');
    entries.add(`${item.target}/${item.name}`);
    const declared = manifest.artifacts?.[item.target]?.[item.name];
    insist(declared?.path === item.path && declared?.sha256 === item.sha256, 'artifact_mismatch');
    insist(!objects.has(item.sha256) || objects.get(item.sha256) === item.size, 'object_size_conflict');
    objects.set(item.sha256, item.size);
  }
  for (const [target, named] of Object.entries(manifest.artifacts ?? {})) {
    for (const name of Object.keys(named)) insist(entries.has(`${target}/${name}`), 'missing_target_artifact');
  }
  const sourcePaths = new Set(value.files.map(file => file.path));
  for (const [target, boundary] of Object.entries(manifest.boundary ?? {})) {
    for (const provider of Object.values(boundary.providers)) {
      if (provider.archive !== undefined) insist(sourcePaths.has(provider.archive) ||
        value.artifacts.some(item => item.target === target && item.path === provider.archive),
      'missing_boundary_archive');
    }
  }
  validatePaths(value.files, value.artifacts);
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
  if (row.created_at <= Date.now() - sessionLifetime) {
    const published = await env.DB.prepare('SELECT digest FROM probe_versions WHERE name=? AND version=?')
      .bind(row.name, row.version).first();
    insist(published?.digest === row.digest, 'session_expired', 410);
  }
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
async function create(request, env, githubId) {
  const value = await jsonBody(request);
  const { manifest } = descriptor(value);
  insist(value.provenance === undefined, 'unsupported_provenance');
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
  if (row.created_at <= Date.now() - sessionLifetime) {
    const published = await env.DB.prepare('SELECT digest FROM probe_versions WHERE name=? AND version=?')
      .bind(manifest.name, manifest.version).first();
    insist(published?.digest === publication, 'session_expired', 410);
  }
  return status(env, row);
}
async function authenticateMaintenance(request, env) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  insist(match, 'unauthorized', 401);
  const expected = env.MAINTENANCE_TOKEN_SHA256 ?? env.STAGING_TOKEN_SHA256;
  insist(sha.test(expected ?? '') && await digest(encoder.encode(match[1])) === expected, 'forbidden', 403);
}
async function maintenance(request, env, id) {
  await authenticateMaintenance(request, env);
  const row = await env.DB.prepare('SELECT created_at FROM probe_sessions WHERE id=?').bind(id).first();
  insist(row && row.created_at <= Date.now() - sessionPruneAge, 'session_not_expired', 409);
  const page = await env.OBJECTS.list({ prefix: `probe/uploads/${id}/`, limit: 1000 });
  return Response.json({ keys: page.objects.map(item => item.key) },
    { headers: { 'cache-control': 'no-store' } });
}
async function administrativeObject(request, env, object) {
  await authenticateMaintenance(request, env);
  const path = key(object);
  if (request.method === 'HEAD') {
    const stored = await env.OBJECTS.head(path);
    insist(stored && objectValid(stored, stored.size, object), 'stored_object_missing', 404);
    return new Response(null, { headers: { 'content-length': String(stored.size), 'cache-control': 'no-store' } });
  }
  insist(request.method === 'PUT', 'method_not_allowed', 405);
  const size = Number(request.headers.get('content-length'));
  insist(Number.isSafeInteger(size) && size > 0 && size <= maxArtifactObject && request.body,
    'object_limit', 413);
  try {
    await env.OBJECTS.put(path, request.body, { sha256: object });
  } catch (error) {
    if (/\(10037\)$/.test(String(error?.message ?? ''))) throw new Rejection(422, 'digest_mismatch');
    throw error;
  }
  insist(objectValid(await env.OBJECTS.head(path), size, object), 'object_store_unavailable', 503);
  return Response.json({ sha256: object, size }, { headers: { 'cache-control': 'no-store' } });
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
  const bytes = await boundedBody(request, maxChunk, 'chunk_limit');
  insist(bytes.byteLength > 0 && offset + bytes.byteLength <= size, 'chunk_limit', 413);
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
  } catch (error) {
    await writer.abort().catch(() => {});
    await producer.catch(() => {});
    if (/\(10037\)$/.test(String(error?.message ?? ''))) throw new Rejection(422, 'digest_mismatch');
    throw new Rejection(503, 'object_store_unavailable');
  }
  insist(objectValid(await env.OBJECTS.head(key(object)), size, object), 'object_store_unavailable', 503);
  probeFault(request, env, 'after_object');
}
async function finalize(request, env, row) {
  const value = JSON.parse(row.descriptor);
  const { objects, manifest } = descriptor(value);
  await owner(env, row.name, row.credential);
  const existing = await env.DB.prepare('SELECT digest FROM probe_versions WHERE name=? AND version=?').bind(row.name, row.version).first();
  insist(!existing || existing.digest === row.digest, 'version_conflict', 409);
  if (!existing) {
    for (const [object, size] of objects) await persistObject(request, env, row, object, size);
    const source = await env.OBJECTS.get(key(value.source.sha256));
    insist(objectValid(source, value.source.size, value.source.sha256), 'stored_object_missing', 503);
    try {
      await verifySourceArchive(await source.arrayBuffer(), value, digest);
    } catch (error) {
      if (error instanceof ArchiveFailure) throw new Rejection(error.code === 'expanded_limit' ? 413 : 422, error.code);
      throw error;
    }
    for (const [name, constraint] of Object.entries(manifest.dependencies ?? {})) {
      const versions = await env.DB.prepare('SELECT version FROM probe_versions WHERE name=?').bind(name).all();
      insist(versions.results.some(found => acceptsDependency(String(constraint), found.version)),
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
    return Response.json({ name, versions: rows.results.sort((a, b) =>
      compareVersions(parseVersion(b.version), parseVersion(a.version))) },
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
export async function workerFetch(request, env) {
    try {
      const url = new URL(request.url);
      insist(!url.search && !url.hash && !url.pathname.includes('%') && url.pathname.length <= 512, 'invalid_route', 400);
      const route = url.pathname;
      const login = await loginFetch(request, env, route);
      if (login) return login;
      if (route === '/__probe/inventory' && request.method === 'GET') {
        insist(await authenticate(request, env) === '__probe__', 'forbidden', 403);
        return Response.json({ objects: await inventory(env, 'probe/objects/sha256/'),
          uploads: await inventory(env, 'probe/uploads/') });
      }
      const admin = /^\/v2\/admin\/uploads\/([a-f0-9]{32})$/.exec(route);
      if (admin && request.method === 'GET') return await maintenance(request, env, admin[1]);
      const administrativeBlob = /^\/v2\/admin\/objects\/([a-f0-9]{64})$/.exec(route);
      if (administrativeBlob) return await administrativeObject(request, env, administrativeBlob[1]);
      if (route === '/v2/publications' && request.method === 'POST') {
        return Response.json(await create(request, env, await authenticate(request, env)));
      }
      let match = /^\/v2\/publications\/([a-f0-9]{32})(?:\/(finalize|objects\/([a-f0-9]{64})))?$/.exec(route);
      if (match) {
        const credential = await authenticate(request, env);
        const row = await session(env, match[1], credential);
        if (!match[2] && request.method === 'GET') return Response.json(await status(env, row));
        if (match[2] === 'finalize' && request.method === 'POST') return Response.json(await finalize(request, env, row));
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
