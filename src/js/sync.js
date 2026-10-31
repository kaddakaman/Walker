// Two-way sync of walk history between this phone and the cloud.
// Each walk is one row; the most recently changed copy wins. Deletions are
// synced as "deleted" markers so a walk removed on one phone goes everywhere.

import { supabase, currentUser } from './cloud.js';
import * as store from './storage.js';

const CHUNK = 25;
let running = null;

/** Plan which walks to pull, push and remove. Pure, so it can be unit-tested. */
export function planSync(local, remote, tombstones) {
  const localMap = new Map(local.map((w) => [w.id, w]));
  const remoteMap = new Map(remote.map((r) => [r.id, r]));
  const pull = [];
  const removeLocal = [];
  const push = [];
  const pushDeletes = [];

  for (const r of remote) {
    const l = localMap.get(r.id);
    if (r.deleted) {
      if (l && r.updated_at >= store.walkUpdatedAt(l)) removeLocal.push(r.id);
      continue;
    }
    if (tombstones[r.id] && tombstones[r.id] >= r.updated_at) continue; // we deleted it
    if (!l || r.updated_at > store.walkUpdatedAt(l)) pull.push(r.id);
  }
  for (const w of local) {
    const r = remoteMap.get(w.id);
    if (!r || (store.walkUpdatedAt(w) > r.updated_at && !(r.deleted && r.updated_at >= store.walkUpdatedAt(w)))) {
      push.push(w);
    }
  }
  for (const [id, t] of Object.entries(tombstones)) {
    const r = remoteMap.get(id);
    if (r && !r.deleted && t >= r.updated_at) pushDeletes.push({ id, t });
  }
  return { pull, removeLocal, push, pushDeletes };
}

/** Sync now. Resolves to { pulled, pushed, removed } or null when signed out. */
export function syncWalks() {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

async function doSync() {
  const user = supabase && (await currentUser());
  if (!user) return null;

  const { data: remote, error } = await supabase.from('walks').select('id, updated_at, deleted');
  if (error) throw new Error(error.message);

  const tombstones = store.getTombstones();
  const plan = planSync(store.getWalks(), remote, tombstones);

  // Download newer walks.
  const pulled = [];
  for (let i = 0; i < plan.pull.length; i += CHUNK) {
    const ids = plan.pull.slice(i, i + CHUNK);
    const { data, error: e } = await supabase.from('walks').select('id, data, updated_at').in('id', ids);
    if (e) throw new Error(e.message);
    pulled.push(...data.map((r) => ({ ...r.data, id: r.id, updatedAt: r.updated_at })));
  }

  // Upload newer walks and deletions.
  const rows = [
    ...plan.push.map((w) => ({ user_id: user.id, id: w.id, data: w, updated_at: store.walkUpdatedAt(w), deleted: false })),
    ...plan.pushDeletes.map(({ id, t }) => ({ user_id: user.id, id, data: {}, updated_at: t, deleted: true })),
  ];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: e } = await supabase.from('walks').upsert(rows.slice(i, i + CHUNK), { onConflict: 'user_id,id' });
    if (e) throw new Error(e.message);
  }

  // Apply to the phone (re-read in case a walk was saved meanwhile).
  const pulledIds = new Set(pulled.map((w) => w.id));
  const removed = new Set(plan.removeLocal);
  const merged = store.getWalks().filter((w) => !pulledIds.has(w.id) && !removed.has(w.id));
  store.replaceWalks([...merged, ...pulled]);
  store.clearTombstones(Object.keys(tombstones));
  store.setOwner(user.id);
  store.setLastSync(Date.now());
  return { pulled: pulled.length, pushed: rows.length, removed: removed.size };
}
