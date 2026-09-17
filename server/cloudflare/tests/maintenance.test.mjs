import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retentionPlan } from '../admin/run-maintenance.mjs';

test('maintenance retains the last thirty copies and twelve monthly anchors', () => {
  const names = [];
  for (let month = 1; month <= 12; month++)
    for (let day = 1; day <= 4; day++)
      names.push(`cloudflare-auto-2025${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}T010203004Z`);
  names.push('cloudflare-staging-20260917T2230Z', 'cloudflare-auto-partial');
  const plan = retentionPlan(names);
  assert.equal(plan.keep.length, 34);
  assert.equal(plan.remove.length, 14);
  assert(plan.keep.includes('cloudflare-auto-20250104T010203004Z'));
  assert(!plan.remove.includes('cloudflare-staging-20260917T2230Z'));
  assert(!plan.remove.includes('cloudflare-auto-partial'));
});
