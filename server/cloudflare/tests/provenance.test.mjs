import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectProvenance, verifyRepository } from '../src/provenance.mjs';

const value = { repository: 'https://github.com/Matanek/Silex-Registry.git',
  commit: 'a'.repeat(40) };
const repo = { id: 42, full_name: 'Matanek/Silex-Registry', private: false,
  owner: { id: 123456789 } };
function provider(body, status = 200) {
  return async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/Matanek/Silex-Registry');
    assert.equal(options.redirect, 'manual');
    return Response.json(body, { status });
  };
}

test('provenance records the local commit while verifying public repository ownership', async () => {
  const provenance = inspectProvenance(value, true);
  await verifyRepository(provenance, '123456789', provider(repo));
  await assert.rejects(verifyRepository(provenance, '987654321', provider(repo)),
    { code: 'repository_not_owned', status: 403 });
  await assert.rejects(verifyRepository(provenance, '123456789', provider({ ...repo, private: true })),
    { code: 'repository_not_public', status: 422 });
});

test('provenance rejects malformed URLs and untrusted GitHub responses', async () => {
  assert.throws(() => inspectProvenance({ ...value, repository: 'https://example.com/a/b.git' }, true),
    { code: 'invalid_provenance', status: 422 });
  assert.throws(() => inspectProvenance({ ...value, commit: 'a'.repeat(39) }, true),
    { code: 'invalid_provenance', status: 422 });
  assert.throws(() => inspectProvenance(null, true), { code: 'invalid_provenance', status: 422 });
  await assert.rejects(verifyRepository(inspectProvenance(value, true), '123456789', provider({ ...repo, owner: { id: '123456789' } })),
    { code: 'invalid_github_response', status: 503 });
});
