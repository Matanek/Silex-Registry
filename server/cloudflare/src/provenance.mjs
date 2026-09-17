const repoPattern = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\.git$/;
const commitPattern = /^[a-f0-9]{40}$/;

export class ProvenanceFailure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function inspectProvenance(value, required) {
  if (!value && !required) return null;
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

export async function verifyRepository(provenance, githubId, fetcher = fetch) {
  if (!provenance) return;
  const url = `https://api.github.com/repos/${provenance.owner}/${provenance.repo}`;
  let response;
  try {
    response = await fetcher(url, { headers: { accept: 'application/vnd.github+json',
      'user-agent': 'Silex-Registry', 'x-github-api-version': '2022-11-28' },
    redirect: 'manual', signal: AbortSignal.timeout(10000) });
  } catch { throw new ProvenanceFailure(503, 'github_unavailable'); }
  if (response.status === 404) throw new ProvenanceFailure(422, 'repository_not_public');
  if (response.status !== 200) throw new ProvenanceFailure(503, 'github_unavailable');
  if (Number(response.headers.get('content-length') ?? 0) > 65536) {
    throw new ProvenanceFailure(503, 'invalid_github_response');
  }
  if (!response.body) throw new ProvenanceFailure(503, 'invalid_github_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) throw new ProvenanceFailure(503, 'invalid_github_response');
      chunks.push(part.value);
    }
  } catch { throw new ProvenanceFailure(503, 'invalid_github_response'); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let repo;
  try { repo = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ProvenanceFailure(503, 'invalid_github_response'); }
  if (!Number.isSafeInteger(repo.id) || repo.id <= 0 ||
      typeof repo.full_name !== 'string' ||
      repo.full_name.toLowerCase() !== `${provenance.owner}/${provenance.repo}`.toLowerCase() ||
      !Number.isSafeInteger(repo.owner?.id) || repo.owner.id <= 0 ||
      typeof repo.private !== 'boolean') throw new ProvenanceFailure(503, 'invalid_github_response');
  if (repo.private) throw new ProvenanceFailure(422, 'repository_not_public');
  if (String(repo.owner.id) !== githubId) throw new ProvenanceFailure(403, 'repository_not_owned');
}
