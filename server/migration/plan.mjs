import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function satisfies(version, constraint) {
  if (!/^[=^](0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(constraint)) return false;
  if (constraint[0] === '=') return version === constraint.slice(1);
  // Match the current Silex/registry major-compatible caret contract, including
  // major zero. Do not substitute npm's different pre-1.0 caret interpretation.
  const actual = version.split('.').map(Number), minimum = constraint.slice(1).split('.').map(Number);
  return actual[0] === minimum[0] && (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2]));
}
export function plan(manifests) {
  const pending = [...manifests].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  const available = new Map(), ordered = [];
  const missing = manifest => Object.entries(manifest.dependencies ?? {}).filter(([name, constraint]) =>
    !(available.get(name) ?? []).some(version => satisfies(version, constraint)));
  while (pending.length) {
    const index = pending.findIndex(manifest => missing(manifest).length === 0);
    if (index === -1) break;
    const [manifest] = pending.splice(index, 1);
    ordered.push(`${manifest.name}@${manifest.version}`);
    available.set(manifest.name, [...(available.get(manifest.name) ?? []), manifest.version]);
  }
  return { schema: 1, ordered, blocked: pending.map(m => ({ selection: `${m.name}@${m.version}`, missing: Object.fromEntries(missing(m)) })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node plan.mjs <verified-bundle> <new-plan.json>');
  const manifests = [];
  for (const file of (await readdir(process.argv[2])).filter(f => /^[A-Za-z_][A-Za-z0-9_.]*@\d+\.\d+\.\d+\.json$/.test(f))) {
    const record = JSON.parse(await readFile(resolve(process.argv[2], file)));
    manifests.push(JSON.parse(record.descriptor.manifest));
  }
  const result = plan(manifests);
  await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ready: result.ordered.length, blocked: result.blocked }));
  if (result.blocked.length) process.exitCode = 1;
}
