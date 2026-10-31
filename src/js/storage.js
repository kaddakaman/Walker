// Local, on-device storage (localStorage). The phone is the source of truth
// while walking; when signed in, sync.js copies walks to and from the cloud.

const WALKS_KEY = 'walker.walks.v1';
const ROUTES_KEY = 'walker.routes.v1';
const FRIEND_ROUTES_KEY = 'walker.friendRoutes.v1';
const TOMBSTONES_KEY = 'walker.deleted.v1';
const OWNER_KEY = 'walker.owner.v1';
const SYNC_KEY = 'walker.lastSync.v1';
const SETTINGS_KEY = 'walker.settings.v1';
const ACTIVE_KEY = 'walker.active.v1';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('Could not save', key, e);
    return false;
  }
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** When a walk was last changed (used to resolve sync conflicts). */
export const walkUpdatedAt = (w) => w.updatedAt || w.end || w.start || 0;

// ---- Walks (history) ----
export const getWalks = () => read(WALKS_KEY, []);
export const getWalk = (id) => getWalks().find((w) => w.id === id);
export function replaceWalks(walks) {
  walks.sort((a, b) => b.start - a.start);
  return write(WALKS_KEY, walks);
}
export function saveWalk(walk) {
  return replaceWalks([walk, ...getWalks().filter((w) => w.id !== walk.id)]);
}
export function updateWalk(id, changes) {
  replaceWalks(getWalks().map((w) => (w.id === id ? { ...w, ...changes, updatedAt: Date.now() } : w)));
}
export function deleteWalk(id) {
  replaceWalks(getWalks().filter((w) => w.id !== id));
  write(TOMBSTONES_KEY, { ...getTombstones(), [id]: Date.now() });
}
export const getTombstones = () => read(TOMBSTONES_KEY, {});
export const clearTombstones = (ids) => {
  const t = getTombstones();
  ids.forEach((id) => delete t[id]);
  write(TOMBSTONES_KEY, t);
};

// ---- Saved routes (from share links / GPX files) ----
export const getRoutes = () => read(ROUTES_KEY, []);
export const getRoute = (id) => getRoutes().find((r) => r.id === id);
export function saveRoute(route) {
  return write(ROUTES_KEY, [route, ...getRoutes().filter((r) => r.id !== route.id)]);
}
export function deleteRoute(id) {
  write(ROUTES_KEY, getRoutes().filter((r) => r.id !== id));
}

// ---- Routes friends shared (cached copy of the server list, for offline) ----
export const getFriendRoutes = () => read(FRIEND_ROUTES_KEY, []);
export const getFriendRoute = (id) => getFriendRoutes().find((r) => r.id === id);
export const setFriendRoutes = (routes) => write(FRIEND_ROUTES_KEY, routes);

// ---- Account bookkeeping ----
/** Which account the walks on this phone belong to (null = not signed in yet). */
export const getOwner = () => read(OWNER_KEY, null);
export const setOwner = (id) => write(OWNER_KEY, id);
export const getLastSync = () => read(SYNC_KEY, 0);
export const setLastSync = (t) => write(SYNC_KEY, t);

/** Remove one account's synced data from this phone (on sign-out / account switch). */
export function clearAccountData() {
  [WALKS_KEY, TOMBSTONES_KEY, FRIEND_ROUTES_KEY, OWNER_KEY, SYNC_KEY].forEach((k) => localStorage.removeItem(k));
}

// ---- Settings ----
export const getSettings = () => ({ strideM: 0.75, keepAwake: true, ...read(SETTINGS_KEY, {}) });
export const saveSettings = (s) => write(SETTINGS_KEY, s);

// ---- In-progress walk (survives the app being closed or killed) ----
export const getActive = () => read(ACTIVE_KEY, null);
export const saveActive = (a) => write(ACTIVE_KEY, a);
export const clearActive = () => localStorage.removeItem(ACTIVE_KEY);
