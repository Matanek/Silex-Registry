import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectProvenance } from '../src/provenance.mjs';

const value = { repository: 'https://github.com/Matanek/Silex-Registry.git',
  commit: 'a'.repeat(40) };

test('legacy provenance is optional and structurally checked', () => {
  assert.equal(inspectProvenance(undefined), null);
  assert.deepEqual(inspectProvenance(value),
    { owner: 'Matanek', repo: 'Silex-Registry', commit: 'a'.repeat(40) });
  assert.throws(() => inspectProvenance({ ...value, repository: 'https://example.com/a/b.git' }),
    { code: 'invalid_provenance', status: 422 });
  assert.throws(() => inspectProvenance({ ...value, commit: 'a'.repeat(39) }),
    { code: 'invalid_provenance', status: 422 });
});
