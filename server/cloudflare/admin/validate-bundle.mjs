import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { acceptsDependency, canonical, descriptor } from '../src/worker.mjs';
import { verifySourceArchive } from '../src/archive.mjs';

const hex = /^[a-f0-9]{64}$/;
const identity = /^[A-Za-z_][A-Za-z0-9_.]*@[0-9]+\.[0-9]+\.[0-9]+$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValid = (condition, message) => { if (!condition) throw new Error(message); };

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function verifyObject(root, digest, size) {
  requireValid(hex.test(digest) && Number.isSafeInteger(size) && size >= 0, `invalid object declaration ${digest}`);
  const path = join(root, 'objects', digest);
  requireValid((await stat(path)).size === size, `object size mismatch ${digest}`);
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(path)) checksum.update(chunk);
  requireValid(checksum.digest('hex') === digest, `object digest mismatch ${digest}`);
  return path;
}

export async function validateBundle(bundleRoot, planPath, ownersPath) {
  bundleRoot = resolve(bundleRoot);
  const plan = await readJson(planPath);
  const ownersFile = await readJson(ownersPath);
  requireValid(plan.schema === 1 && Array.isArray(plan.ordered) && Array.isArray(plan.blocked) &&
    plan.blocked.length === 0 && plan.ordered.length > 0, 'invalid migration plan');
  requireValid(ownersFile.schema === 1 && Array.isArray(ownersFile.owners), 'invalid owner file');
  const owners = new Map();
  for (const owner of ownersFile.owners) {
    requireValid(typeof owner.name === 'string' && !owners.has(owner.name) &&
      /^[0-9]+$/.test(owner.github_id) && hex.test(owner.registration_sha256 ?? ''),
    `invalid owner ${owner.name}`);
    owners.set(owner.name, owner);
  }
  const records = [];
  const objects = new Map();
  const available = new Map();
  const seen = new Set();
  for (const id of plan.ordered) {
    requireValid(identity.test(id) && !seen.has(id), `invalid planned version ${id}`);
    seen.add(id);
    const item = await readJson(join(bundleRoot, `${id}.json`));
    const { manifest } = descriptor(item.descriptor);
    requireValid(`${manifest.name}@${manifest.version}` === id, `manifest identity mismatch ${id}`);
    const owner = owners.get(manifest.name);
    requireValid(owner && item.provenance?.registration?.name === manifest.name &&
      item.provenance.registration_sha256 === owner.registration_sha256 &&
      item.provenance.manifest_sha256 === hash(item.descriptor.manifest) &&
      /^[a-f0-9]{40}$/.test(item.provenance.commit ?? ''), `owner or provenance mismatch ${id}`);
    for (const [name, constraint] of Object.entries(manifest.dependencies ?? {})) {
      requireValid((available.get(name) ?? []).some(version => acceptsDependency(constraint, version)),
        `dependency not yet available ${id}: ${name}${constraint}`);
    }
    for (const blob of [item.descriptor.source, ...item.descriptor.artifacts]) {
      const prior = objects.get(blob.sha256);
      requireValid(!prior || prior.size === blob.size, `object size conflict ${blob.sha256}`);
      if (!prior) objects.set(blob.sha256, { size: blob.size,
        path: await verifyObject(bundleRoot, blob.sha256, blob.size) });
    }
    const source = await readFile(objects.get(item.descriptor.source.sha256).path);
    await verifySourceArchive(source, item.descriptor, async bytes => hash(bytes));
    const encoded = canonical(item.descriptor);
    records.push({ id, name: manifest.name, version: manifest.version, githubId: owner.github_id,
      digest: hash(encoded), descriptor: encoded, provenance: item.provenance });
    available.set(manifest.name, [...(available.get(manifest.name) ?? []), manifest.version]);
  }
  const unexpected = (await readdir(bundleRoot)).filter(name => name.endsWith('.json') &&
    name !== 'preparation-report.json' && !seen.has(basename(name, '.json')));
  requireValid(unexpected.length === 0, `unplanned descriptors: ${unexpected.join(', ')}`);
  requireValid([...new Set(records.map(record => record.name))].every(name => owners.has(name)),
    'version has no owner');
  return { records, objects, owners };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [bundleRoot, planPath, ownersPath] = process.argv.slice(2);
  requireValid(bundleRoot && planPath && ownersPath, 'usage: validate-bundle BUNDLE PLAN OWNERS');
  const checked = await validateBundle(bundleRoot, planPath, ownersPath);
  console.log(JSON.stringify({ versions: checked.records.length, names: checked.owners.size,
    objects: checked.objects.size, bytes: [...checked.objects.values()].reduce((total, item) => total + item.size, 0) }));
}
