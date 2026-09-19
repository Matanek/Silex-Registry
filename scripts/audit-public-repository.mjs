import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const forbiddenPaths = new Set([
  'server/cloudflare/wrangler.toml',
  'server/cloudflare/wrangler.production.toml',
  'server/cloudflare/wrangler.remote.toml',
  'server/cloudflare/wrangler.restore.toml',
]);

const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['credential in URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['Cloudflare resource identifier', /\b(?:account_id|database_id)\s*=\s*["'][0-9a-f-]{16,}["']/i],
  ['concrete OAuth client identifier', /\bOv23[A-Za-z0-9]{12,}\b/],
  ['concrete backup bucket', /\bsilex-registry-backup-[0-9]+\b/],
];

function publicIpv4(text) {
  const found = [];
  for (const match of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const bytes = match.slice(1).map(Number);
    if (bytes.some(value => value > 255)) continue;
    const [a, b] = bytes;
    const allowed = a === 0 || a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      bytes.join('.') === '1.1.1.1';
    if (!allowed) found.push(match.index);
  }
  return found;
}

const files = execFileSync('git', ['ls-files', '-z'])
  .toString('utf8').split('\0').filter(Boolean);
const failures = [];

for (const path of files) {
  if (forbiddenPaths.has(path)) {
    failures.push(`${path}: real Wrangler configuration must remain untracked`);
    continue;
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [name, pattern] of rules) {
    const match = pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      failures.push(`${path}:${line}: ${name}`);
    }
  }
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/ig;
  for (const match of text.matchAll(email)) {
    if (/@[0-9]+\.[0-9]+\.[0-9]+\.(?:json|installing)$/i.test(match[0])) continue;
    if (match[0].endsWith('@users.noreply.github.com') || match[0].endsWith('@example.invalid')) continue;
    const line = text.slice(0, match.index).split('\n').length;
    failures.push(`${path}:${line}: personal email address`);
  }
  for (const index of publicIpv4(text)) {
    const line = text.slice(0, index).split('\n').length;
    failures.push(`${path}:${line}: public IPv4 literal`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Audited ${files.length} tracked files: no sensitive literal detected.`);
