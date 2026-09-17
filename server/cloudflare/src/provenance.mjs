const repoPattern = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\.git$/;
const commitPattern = /^[a-f0-9]{40}$/;

export class ProvenanceFailure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function inspectProvenance(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'commit,repository' ||
      typeof value.repository !== 'string' || typeof value.commit !== 'string') {
    throw new ProvenanceFailure(422, 'invalid_provenance');
  }
  const match = repoPattern.exec(value.repository);
  if (!match || !commitPattern.test(value.commit) || match[2] === '.' || match[2] === '..' ||
      match[2].endsWith('.git')) throw new ProvenanceFailure(422, 'invalid_provenance');
  return { owner: match[1], repo: match[2], commit: value.commit };
}
