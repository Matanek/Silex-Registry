import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function git(directory, ...args) {
  const { stdout } = await execute('git', ['-C', directory, ...args], {
    encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 180000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}
export function tagsFromRefs(bytes) {
  const refs = new Map(bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => {
    const match = /^([a-f0-9]{40})\s+(refs\/tags\/\S+)$/.exec(line);
    if (!match) throw new Error('invalid_remote_ref');
    return [match[2], match[1]];
  }));
  const versions = [], ignored = [];
  for (const [ref, object] of refs) {
    if (ref.endsWith('^{}')) continue;
    const tag = ref.slice(10);
    if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) {
      ignored.push({ tag, object }); continue;
    }
    versions.push({ tag, version: tag.slice(1), object, commit: refs.get(ref + '^{}') ?? object });
  }
  return { versions: versions.sort((a, b) => a.tag.localeCompare(b.tag, 'en')), ignored };
}
export function treeEntries(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('invalid_tree_entry');
    return { mode: match[1], type: match[2], object: match[3], size: match[4] === '-' ? null : Number(match[4]), path: match[5] };
  });
}

// A bare, task-owned cache is the only repository this tool mutates. Source
// checkouts, remote refs and manifests are never changed or checked out.
export async function inventoryRegistration(registration, cache, remote = registration.repository) {
  const refs = await git(cache, 'ls-remote', '--tags', remote);
  const { versions, ignored } = tagsFromRefs(refs);
  const repository = resolve(cache, registration.name + '.git');
  await mkdir(repository, { recursive: true });
  await git(repository, 'init', '--bare', '--quiet');
  const result = { registration, observed_at: new Date().toISOString(), refs: refs.toString('utf8'), ignored_tags: ignored, versions: [] };
  if (versions.length) await git(repository, 'fetch', '--quiet', '--no-tags', '--depth=1', remote, ...versions.map(v => v.object));
  for (const tag of versions) {
    const version = { ...tag, issues: [] };
    try {
      const commit = (await git(repository, 'rev-parse', tag.object + '^{commit}')).toString().trim();
      if (commit !== tag.commit) throw new Error('tag_commit_mismatch');
      version.tree = (await git(repository, 'rev-parse', commit + '^{tree}')).toString().trim();
      version.files = treeEntries(await git(repository, 'ls-tree', '-rlz', commit));
      for (const file of version.files) {
        if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) version.issues.push('unsupported_git_entry:' + file.path);
      }
      const manifest = version.files.find(file => file.path === 'Package.json');
      if (!manifest || manifest.type !== 'blob' || manifest.size > 262144) throw new Error('missing_or_oversized_manifest');
      const bytes = await git(repository, 'cat-file', 'blob', manifest.object);
      version.manifest = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      version.manifest_sha256 = sha256(bytes);
      const value = JSON.parse(version.manifest);
      if (value.name !== registration.name || value.version !== tag.version) version.issues.push('manifest_identity_mismatch');
      version.dependencies = value.dependencies ?? {};
      version.artifacts = Object.entries(value.artifacts ?? {}).flatMap(([target, entries]) =>
        Object.entries(entries).map(([name, entry]) => ({ target, name, ...entry })));
      version.expanded_bytes = version.files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    } catch (error) { version.issues.push(error.message); }
    result.versions.push(version);
  }
  return result;
}

export async function inventory(registrations, output) {
  // Refuse to overwrite an earlier observation: a moved/deleted remote tag is
  // a new inventory, not permission to replace evidence of a published version.
  await mkdir(output, { recursive: false });
  const cache = resolve(output, 'git'); await mkdir(cache);
  const report = { schema: 1, observed_at: new Date().toISOString(), packages: [] };
  for (const filename of (await readdir(registrations)).filter(n => n.endsWith('.json')).sort()) {
    const bytes = await readFile(resolve(registrations, filename));
    const registration = JSON.parse(bytes);
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(registration.name) ||
        filename !== registration.name + '.json' || registration.schema !== 1 ||
        !/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(registration.repository)) throw new Error('invalid_registration');
    let result;
    try { result = await inventoryRegistration(registration, cache); }
    catch (error) { result = { registration, error: error.message, versions: [] }; }
    result.registration_sha256 = sha256(bytes);
    await writeFile(resolve(output, filename), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    const entry = { name: registration.name, versions: result.versions.length,
      issues: result.versions.filter(v => v.issues.length).map(v => ({ tag: v.tag, issues: v.issues })),
      ...(result.error ? { error: result.error } : {}) };
    report.packages.push(entry);
    console.log(JSON.stringify(entry));
  }
  await writeFile(resolve(output, 'inventory.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node inventory.mjs <registrations-directory> <new-output-directory>');
  const report = await inventory(resolve(process.argv[2]), resolve(process.argv[3]));
  if (report.packages.some(p => p.error || p.issues.length)) process.exitCode = 1;
}
