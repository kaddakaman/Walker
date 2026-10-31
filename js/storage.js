// Persists walks, saved routes and settings in localStorage (on the device).

const WALKS_KEY = 'walker.walks.v1';
const ROUTES_KEY = 'walker.routes.v1';
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

// ---- Walks (history) ----
export const getWalks = () => read(WALKS_KEY, []);
export const getWalk = (id) => getWalks().find((w) => w.id === id);
export function saveWalk(walk) {
  const walks = getWalks().filter((w) => w.id !== walk.id);
  walks.unshift(walk);
  walks.sort((a, b) => b.start - a.start);
  return write(WALKS_KEY, walks);
}
export function updateWalk(id, changes) {
  const walks = getWalks().map((w) => (w.id === id ? { ...w, ...changes } : w));
  write(WALKS_KEY, walks);
}
export function deleteWalk(id) {
  write(WALKS_KEY, getWalks().filter((w) => w.id !== id));
}

// ---- Routes (received from other people / imported) ----
export const getRoutes = () => read(ROUTES_KEY, []);
export const getRoute = (id) => getRoutes().find((r) => r.id === id);
export function saveRoute(route) {
  const routes = getRoutes().filter((r) => r.id !== route.id);
  routes.unshift(route);
  return write(ROUTES_KEY, routes);
}
export function deleteRoute(id) {
  write(ROUTES_KEY, getRoutes().filter((r) => r.id !== id));
}

// ---- Settings ----
export const getSettings = () => ({ strideM: 0.75, keepAwake: true, ...read(SETTINGS_KEY, {}) });
export const saveSettings = (s) => write(SETTINGS_KEY, s);

// ---- In-progress walk (survives an accidental reload) ----
export const getActive = () => read(ACTIVE_KEY, null);
export const saveActive = (a) => write(ACTIVE_KEY, a);
export const clearActive = () => localStorage.removeItem(ACTIVE_KEY);
