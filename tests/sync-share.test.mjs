import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShareUrl, buildOnlineLink, buildShareLink, appIntentUrl } from '../src/js/share.js';
import { planSync } from '../src/js/sync.js';
import { acceptFix } from '../src/js/tracker.js';

const ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

test('online share links are recognised in every form', () => {
  const link = buildOnlineLink(ID, 'https://kaddakaman.github.io/Walker/');
  assert.equal(link, `https://kaddakaman.github.io/Walker/#route=${ID}`);
  assert.deepEqual(parseShareUrl(link), { type: 'online', id: ID });
  assert.deepEqual(parseShareUrl(`#route=${ID}`), { type: 'online', id: ID });
  assert.deepEqual(parseShareUrl(`walker://route/${ID}`), { type: 'online', id: ID });
  assert.deepEqual(parseShareUrl(`  Walk this with me: ${link}  `.trim().split(' ').at(-1)), { type: 'online', id: ID });
  assert.equal(parseShareUrl('#route=not-a-uuid'), null);
  assert.equal(parseShareUrl('https://example.com/'), null);
  assert.equal(parseShareUrl(''), null);
  assert.match(appIntentUrl(ID), /^intent:\/\/route\/.+scheme=walker;package=com\.kaddakaman\.walker;end$/);
});

test('offline links still work', () => {
  const pts = [
    { lat: 51.5, lng: -0.1 },
    { lat: 51.51, lng: -0.1 },
  ];
  const parsed = parseShareUrl(buildShareLink('Loop', pts, 'https://kaddakaman.github.io/Walker/'));
  assert.equal(parsed.type, 'inline');
  assert.equal(parsed.name, 'Loop');
  assert.equal(parsed.points.length, 2);
});

test('planSync: pulls newer remote walks, pushes newer local ones', () => {
  const local = [
    { id: 'a', updatedAt: 100 }, // same on both
    { id: 'b', updatedAt: 300 }, // edited locally
    { id: 'c', updatedAt: 100 }, // only local
    { id: 'd', updatedAt: 100 }, // edited remotely
  ];
  const remote = [
    { id: 'a', updated_at: 100, deleted: false },
    { id: 'b', updated_at: 200, deleted: false },
    { id: 'd', updated_at: 250, deleted: false },
    { id: 'e', updated_at: 100, deleted: false }, // only remote
  ];
  const plan = planSync(local, remote, {});
  assert.deepEqual(plan.pull.sort(), ['d', 'e']);
  assert.deepEqual(plan.push.map((w) => w.id).sort(), ['b', 'c']);
  assert.deepEqual(plan.removeLocal, []);
  assert.deepEqual(plan.pushDeletes, []);
});

test('planSync: deletions travel both ways', () => {
  const local = [{ id: 'x', updatedAt: 100 }];
  const remote = [
    { id: 'x', updated_at: 150, deleted: true }, // deleted on another phone
    { id: 'y', updated_at: 100, deleted: false }, // deleted here (tombstone)
  ];
  const plan = planSync(local, remote, { y: 200 });
  assert.deepEqual(plan.removeLocal, ['x']);
  assert.deepEqual(plan.pull, []);
  assert.deepEqual(plan.push, []);
  assert.deepEqual(plan.pushDeletes, [{ id: 'y', t: 200 }]);
});

test('planSync: an edit made after a remote delete wins', () => {
  const plan = planSync([{ id: 'x', updatedAt: 500 }], [{ id: 'x', updated_at: 150, deleted: true }], {});
  assert.deepEqual(plan.removeLocal, []);
  assert.deepEqual(plan.push.map((w) => w.id), ['x']);
});

test('GPS filter: rejects inaccurate fixes, jitter and jumps', () => {
  const a = { lat: 51.5, lng: -0.1, t: 0, acc: 5 };
  const step = (dLat, dt, acc = 5) => ({ lat: a.lat + dLat, lng: a.lng, t: a.t + dt, acc });
  assert.equal(acceptFix(null, a), 0); // first fix
  assert.equal(acceptFix(null, { ...a, acc: 80 }), -1); // too inaccurate
  assert.equal(acceptFix(a, step(0.00002, 1000)), -1); // ~2 m: jitter
  assert.ok(Math.abs(acceptFix(a, step(0.0001, 10000)) - 11.1) < 0.2); // 11 m in 10 s: walking
  assert.equal(acceptFix(a, step(0.002, 5000)), -1); // 222 m in 5 s: GPS jump
});
