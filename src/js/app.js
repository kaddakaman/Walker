import L from 'leaflet';
import {
  haversine,
  bearing,
  compassName,
  cumulativeDistances,
  locateOnRoute,
  pointAtDistance,
  pathLength,
  simplify,
  formatDistance,
  formatDuration,
  avgSpeedKmh,
} from './geo.js';
import { Tracker } from './tracker.js';
import { StepCounter } from './steps.js';
import * as store from './storage.js';
import { buildShareLink, buildOnlineLink, parseShareUrl, appIntentUrl, toGPX, parseGPX } from './share.js';
import {
  isNative,
  isAndroidBrowser,
  watchLocation,
  openAppSettings,
  requestWalkPermissions,
  shareLink,
  saveTextFile,
  onOpenUrl,
  onBackButton,
} from './platform.js';
import { config } from './config.js';
import * as cloud from './cloud.js';
import { syncWalks } from './sync.js';

const $ = (sel) => document.querySelector(sel);
const OFF_ROUTE_M = 30;
const ARRIVED_M = 25;
const webBase = () => (isNative ? config.WEB_URL : location.origin + location.pathname);

// ================================================================ map

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_OPTS = {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

const map = L.map('map', { zoomControl: false }).setView([51.505, -0.09], 15);
L.tileLayer(TILE_URL, TILE_OPTS).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

const pinIcon = (cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
const meIcon = L.divIcon({ className: '', html: '<div class="dot-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const toLL = (pts) => pts.map((p) => [p.lat, p.lng]);

const layers = {
  track: L.polyline([], { color: '#16a34a', weight: 6, opacity: 0.9 }).addTo(map),
  guide: L.polyline([], { color: '#2563eb', weight: 5, opacity: 0.6, dashArray: '8 10' }).addTo(map),
  guideStart: null,
  guideEnd: null,
  start: null,
  me: null,
  accuracy: null,
};

let followMe = true; // keep the map centred on the user until they pan away
map.on('dragstart', () => (followMe = false));

// ================================================================ state

const settings = store.getSettings();
const steps = new StepCounter();
let walk = null; // { id, start, points, distance, guideId, guideName }
let guide = null; // { id, kind, name, points, cum, segIdx, arrived }
let timer = null;
let wakeLock = null;
let lastFix = null;
let user = null; // signed-in Supabase user
let profile = null;
let friendsState = { friends: [], incoming: [], outgoing: [] };

// ================================================================ location

function onFix(p) {
  lastFix = p;
  showMe(p);
  updateGpsStatus(p);
  if (guide) updateGuide(p);
}

function onLocationError(err) {
  const msg =
    err.code === 1
      ? 'Location permission is off. Allow location access to track walks.'
      : err.code === 3
        ? 'Still searching for GPS signal…'
        : err.message || 'Location unavailable.';
  $('#gps-status').textContent = msg;
  if (err.code === 1 && isNative) {
    openDialog({ title: 'Location needed', text: msg, buttons: [btn('cancel', 'Not now'), btn('ok', 'Open settings', 'primary')] }).then(
      (v) => v === 'ok' && openAppSettings()
    );
  } else if (err.code === 1) toast(msg);
}

const tracker = new Tracker({
  onPosition: onFix,
  onPoint: (p, distance) => {
    if (!walk) return;
    walk.points.push(p);
    walk.distance = distance;
    layers.track.addLatLng([p.lat, p.lng]);
    if (walk.points.length === 1) setStartMarker(p);
    saveActiveWalk();
    if (document.visibilityState === 'visible') updateStats();
  },
  onError: onLocationError,
});

// A light "where am I" watch while not walking, paused when the app is hidden
// so it doesn't use battery in the background.
let stopPassive = null;
async function startPassive() {
  if (stopPassive || walk) return;
  stopPassive = () => {};
  stopPassive = await watchLocation(onFix, onLocationError, { background: false }).catch(() => () => {});
  if (walk) stopPassiveWatch(); // a walk started while we were waiting
}
function stopPassiveWatch() {
  stopPassive?.();
  stopPassive = null;
}

function showMe(p) {
  const ll = [p.lat, p.lng];
  if (!layers.me) {
    layers.accuracy = L.circle(ll, { radius: p.acc || 10, color: '#2563eb', weight: 1, fillOpacity: 0.1 }).addTo(map);
    layers.me = L.marker(ll, { icon: meIcon, zIndexOffset: 1000 }).addTo(map);
    if (!guide) map.setView(ll, 17);
  } else {
    layers.me.setLatLng(ll);
    layers.accuracy.setLatLng(ll).setRadius(p.acc || 10);
    if (followMe && document.visibilityState === 'visible') map.panTo(ll, { animate: true });
  }
}

function updateGpsStatus(p) {
  const el = $('#gps-status');
  const bg = walk && isNative ? ' · keeps tracking with screen off' : '';
  if (p.acc <= 15) el.textContent = `GPS good (±${p.acc} m)${bg}`;
  else if (p.acc <= 35) el.textContent = `GPS OK (±${p.acc} m)${bg}`;
  else el.textContent = `Weak GPS (±${p.acc} m), move into the open`;
}

function setStartMarker(p) {
  layers.start?.remove();
  layers.start = L.marker([p.lat, p.lng], { icon: pinIcon('start') }).addTo(map).bindTooltip('Start');
}

// ================================================================ walking

async function startWalk() {
  const btn = $('#btn-toggle');
  btn.disabled = true;
  try {
    await requestWalkPermissions(); // step counter + notification (Android)
    walk = { id: store.uid(), start: Date.now(), points: [], distance: 0 };
    if (guide) Object.assign(walk, { guideId: guide.id, guideName: guide.name });
    layers.track.setLatLngs([]);
    layers.start?.remove();
    layers.start = null;
    followMe = true;
    stopPassiveWatch();
    await steps.start();
    await tracker.start();
    beginWalkingUi();
    saveActiveWalk();
  } finally {
    btn.disabled = false;
  }
}

function saveActiveWalk() {
  if (walk) store.saveActive({ ...walk, steps: steps.steps });
}

function beginWalkingUi() {
  const btn = $('#btn-toggle');
  btn.textContent = 'End walk';
  btn.className = 'big-btn end';
  clearInterval(timer);
  timer = setInterval(updateStats, 1000);
  updateStats();
  keepAwake(true);
  if (isNative) $('#gps-status').textContent = 'Recording. You can lock your phone, tracking continues.';
}

async function endWalk() {
  const ok = await confirmDialog('End walk?', 'Your walk will be saved to History.', 'End walk');
  if (!ok || !walk) return;
  tracker.stop();
  await steps.stop();
  clearInterval(timer);
  keepAwake(false);

  const end = Date.now();
  const duration = end - walk.start;
  const stepResult = steps.result(walk.distance, settings.strideM);
  const record = {
    id: walk.id,
    name: defaultWalkName(walk.start),
    start: walk.start,
    end,
    updatedAt: end,
    duration,
    distance: walk.distance,
    avgSpeed: avgSpeedKmh(walk.distance, duration),
    steps: stepResult.steps,
    stepsEstimated: stepResult.estimated,
    points: walk.points,
    guideName: walk.guideName,
  };
  store.clearActive();
  walk = null;

  const btn = $('#btn-toggle');
  btn.textContent = 'Start walk';
  btn.className = 'big-btn start';
  resetStats();
  layers.track.setLatLngs([]);
  layers.start?.remove();
  startPassive();

  if (record.points.length < 2) {
    toast('Walk too short to save: no GPS movement was recorded.');
    return;
  }
  store.saveWalk(record);
  renderHistory();
  toast(`Saved: ${formatDistance(record.distance)} in ${formatDuration(record.duration)}`);
  openDetail('walk', record.id);
  scheduleSync();
}

function resetStats() {
  $('#s-time').textContent = '00:00';
  $('#s-dist').textContent = '0 m';
  $('#s-speed').textContent = '0.0';
  $('#s-steps').textContent = '0';
}

async function updateStats() {
  if (!walk) return;
  const elapsed = Date.now() - walk.start;
  $('#s-time').textContent = formatDuration(elapsed);
  $('#s-dist').textContent = formatDistance(walk.distance);
  $('#s-speed').textContent = avgSpeedKmh(walk.distance, elapsed).toFixed(1);
  await steps.poll();
  if (!walk) return;
  const s = steps.result(walk.distance, settings.strideM);
  $('#s-steps').textContent = (s.estimated && s.steps ? '≈' : '') + s.steps.toLocaleString();
}

function defaultWalkName(ts) {
  const h = new Date(ts).getHours();
  const part = h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
  return `${part} walk`;
}

/** Carry on a walk if the app was closed or killed mid-walk. */
async function resumeActiveWalk() {
  const a = store.getActive();
  if (!a) return false;
  walk = { id: a.id, start: a.start, points: a.points || [], distance: a.distance || 0, guideId: a.guideId, guideName: a.guideName };
  layers.track.setLatLngs(toLL(walk.points));
  if (walk.points[0]) setStartMarker(walk.points[0]);
  beginWalkingUi();
  await steps.start(a.steps || 0);
  await tracker.start(walk.points, walk.distance);
  toast('Resumed your walk in progress');
  return true;
}

// Browser version only: keep the screen on (browsers pause GPS when it's off).
async function keepAwake(on) {
  if (isNative) return;
  try {
    if (on && settings.keepAwake && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not supported */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (walk) {
      keepAwake(true);
      layers.track.setLatLngs(toLL(walk.points)); // catch up on points recorded while locked
      updateStats();
    } else startPassive();
    if (user && Date.now() - store.getLastSync() > 5 * 60_000) runSync();
  } else if (!walk) {
    stopPassiveWatch();
  }
});

$('#btn-toggle').addEventListener('click', () => (walk ? endWalk() : startWalk()));
$('#btn-recenter').addEventListener('click', () => {
  followMe = true;
  if (lastFix) map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom(), 16));
});

// ================================================================ following a route

function getItem(kind, id) {
  if (kind === 'walk') return store.getWalk(id);
  if (kind === 'route') return store.getRoute(id);
  if (kind === 'friend') return store.getFriendRoute(id);
  return null;
}

function followRoute(kind, id) {
  const src = getItem(kind, id);
  if (!src) return;
  const points = src.points.map((p) => ({ lat: p.lat, lng: p.lng }));
  guide = { id, kind, name: src.name, points, cum: cumulativeDistances(points), segIdx: 0, arrived: false };
  if (walk) Object.assign(walk, { guideId: id, guideName: src.name });

  layers.guide.setLatLngs(toLL(points));
  layers.guideStart?.remove();
  layers.guideEnd?.remove();
  layers.guideStart = L.marker([points[0].lat, points[0].lng], { icon: pinIcon('start') }).addTo(map).bindTooltip('Route start');
  layers.guideEnd = L.marker([points.at(-1).lat, points.at(-1).lng], { icon: pinIcon('end') }).addTo(map).bindTooltip('Route finish');

  $('#guide').hidden = false;
  $('#guide').className = 'guide';
  $('#guide-main').textContent = src.name;
  $('#guide-sub').textContent = 'Waiting for your location…';

  closeDetail();
  showView('walk');
  followMe = false;
  map.fitBounds(layers.guide.getBounds(), { padding: [30, 30] });
  if (lastFix) updateGuide(lastFix);
  setTimeout(() => (followMe = true), 4000);
}

function stopFollowing() {
  guide = null;
  layers.guide.setLatLngs([]);
  layers.guideStart?.remove();
  layers.guideEnd?.remove();
  $('#guide').hidden = true;
}

function updateGuide(p) {
  const box = $('#guide');
  const main = $('#guide-main');
  const sub = $('#guide-sub');
  const arrow = $('#guide-arrow');
  const total = guide.cum.at(-1);
  const pointArrow = (target) => {
    const deg = bearing(p, target);
    arrow.style.transform = `rotate(${deg}deg)`; // arrow points north by default
    return compassName(deg);
  };

  const loc = locateOnRoute(guide.points, guide.cum, p, guide.segIdx);

  // Not started yet and away from the route: direct them to the start.
  if (!walk && loc.offRoute > OFF_ROUTE_M) {
    box.className = 'guide';
    main.textContent = `Head ${pointArrow(guide.points[0])} to the start`;
    sub.textContent = `${formatDistance(haversine(p, guide.points[0]))} to start · route ${formatDistance(total)}`;
    return;
  }

  guide.segIdx = loc.segIdx;

  if (loc.remaining < ARRIVED_M && loc.progress > 0.9) {
    if (!guide.arrived) toast('You reached the end of the route 🎉');
    guide.arrived = true;
    box.className = 'guide done';
    arrow.style.transform = 'rotate(0deg)';
    main.textContent = 'Route complete!';
    sub.textContent = walk ? 'Press End walk to save it.' : guide.name;
    return;
  }

  if (loc.offRoute > OFF_ROUTE_M) {
    const back = pointAtDistance(guide.points, guide.cum, loc.along);
    box.className = 'guide off';
    main.textContent = `Off route: head ${pointArrow(back)}`;
    sub.textContent = `${formatDistance(loc.offRoute)} from the route`;
    return;
  }

  const ahead = pointAtDistance(guide.points, guide.cum, loc.along + 35);
  box.className = 'guide';
  main.textContent = `Head ${pointArrow(ahead)}`;
  sub.textContent = `${formatDistance(loc.remaining)} to go · ${Math.round(loc.progress * 100)}% done`;
}

$('#btn-stop-guide').addEventListener('click', stopFollowing);

// ================================================================ lists

function thumbnail(points, color = '#16a34a') {
  const pts = simplify(points, 15);
  if (pts.length < 2) return '';
  const k = Math.cos((pts[0].lat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 7, size = 56 - pad * 2;
  const ox = (size - ((maxX - minX) / span) * size) / 2;
  const oy = (size - ((maxY - minY) / span) * size) / 2;
  const d = xs
    .map((x, i) => `${(pad + ox + ((x - minX) / span) * size).toFixed(1)},${(pad + oy + ((ys[i] - minY) / span) * size).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 56 56"><rect width="56" height="56" rx="10" fill="${color}" fill-opacity=".1"/><polyline points="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function renderHistory() {
  const walks = store.getWalks();
  $('#history-empty').hidden = walks.length > 0;
  const totalDist = walks.reduce((s, w) => s + w.distance, 0);
  const totalSteps = walks.reduce((s, w) => s + (w.steps || 0), 0);
  $('#history-summary').innerHTML = walks.length
    ? `<div class="stat"><span class="v">${walks.length}</span><span class="l">Walks</span></div>
       <div class="stat"><span class="v">${(totalDist / 1000).toFixed(1)}</span><span class="l">Total km</span></div>
       <div class="stat"><span class="v">${totalSteps.toLocaleString()}</span><span class="l">Steps</span></div>`
    : '';
  $('#history-list').innerHTML = walks
    .map(
      (w) => `<li data-id="${escapeHtml(w.id)}">
        <div class="thumb">${thumbnail(w.points)}</div>
        <div class="info">
          <div class="name">${escapeHtml(w.name)}${w.sharedRouteId ? ' <small>🔗</small>' : ''}</div>
          <div class="meta">${dateFmt.format(w.start)} · ${timeFmt.format(w.start)}</div>
          <div class="meta">${formatDistance(w.distance)} · ${formatDuration(w.duration)} · ${(w.avgSpeed || 0).toFixed(1)} km/h</div>
        </div>
        <span class="chev">›</span>
      </li>`
    )
    .join('');
}

function routeItem(r, color, meta) {
  return `<li data-id="${escapeHtml(r.id)}">
    <div class="thumb">${thumbnail(r.points, color)}</div>
    <div class="info">
      <div class="name">${escapeHtml(r.name)}</div>
      <div class="meta">${meta}</div>
    </div>
    <span class="chev">›</span>
  </li>`;
}

function renderRoutes() {
  const routes = store.getRoutes();
  $('#routes-empty').hidden = routes.length > 0;
  $('#routes-list').innerHTML = routes
    .map((r) => routeItem(r, '#2563eb', `${formatDistance(r.distance)}${r.owner ? ` · from @${escapeHtml(r.owner)}` : ''} · added ${dateFmt.format(r.added)}`))
    .join('');

  const section = $('#friend-routes-section');
  section.hidden = !cloud.cloudEnabled;
  const fr = store.getFriendRoutes();
  $('#friend-routes-list').innerHTML = user
    ? fr.map((r) => routeItem(r, '#9333ea', `${formatDistance(r.distance)} · by @${escapeHtml(r.owner)} · ${dateFmt.format(r.added)}`)).join('')
    : '';
  const empty = $('#friend-routes-empty');
  empty.hidden = user && fr.length > 0;
  empty.innerHTML = !user
    ? 'Sign in on the <b>Me</b> tab to see routes your friends share.'
    : 'No routes from friends yet. When a friend taps <b>Share → Share with my friends</b>, their route appears here.';
}

$('#history-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openDetail('walk', li.dataset.id);
});
$('#routes-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openDetail('route', li.dataset.id);
});
$('#friend-routes-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openDetail('friend', li.dataset.id);
});

// ================================================================ detail screen

let detailMap = null;
let detailLayer = null;
let detailItem = null; // { kind, id }

function openDetail(kind, id) {
  const item = getItem(kind, id);
  if (!item) return;
  detailItem = { kind, id };
  $('#detail').hidden = false;
  $('#detail-title').textContent = item.name;

  if (kind === 'walk') {
    $('#detail-date').textContent =
      `${dateFmt.format(item.start)} · ${timeFmt.format(item.start)} – ${timeFmt.format(item.end)}` +
      (item.guideName ? ` · followed “${item.guideName}”` : '');
    $('#detail-stats').innerHTML = `
      <div class="stat"><span class="v">${formatDuration(item.duration)}</span><span class="l">Time</span></div>
      <div class="stat"><span class="v">${formatDistance(item.distance)}</span><span class="l">Distance</span></div>
      <div class="stat"><span class="v">${(item.avgSpeed || 0).toFixed(1)}</span><span class="l">Avg km/h</span></div>
      <div class="stat"><span class="v">${item.stepsEstimated ? '≈' : ''}${(item.steps || 0).toLocaleString()}</span><span class="l">Steps</span></div>`;
  } else {
    const who = item.owner ? `Shared by @${item.owner}` : kind === 'friend' ? 'Shared by a friend' : 'Saved route';
    $('#detail-date').textContent = `${who} · ${dateFmt.format(item.added)}`;
    $('#detail-stats').innerHTML = `
      <div class="stat" style="grid-column: span 2"><span class="v">${formatDistance(item.distance)}</span><span class="l">Distance</span></div>
      <div class="stat" style="grid-column: span 2"><span class="v">${formatDuration((item.distance / 5000) * 3600000)}</span><span class="l">Approx. time at 5 km/h</span></div>`;
  }

  const own = kind !== 'friend';
  $('#btn-rename').hidden = !own;
  $('#btn-delete').hidden = !own;
  $('#btn-save-route').hidden = own;
  $('#btn-unshare').hidden = !(own && item.sharedRouteId && user);
  const note = $('#detail-shared');
  note.hidden = !(own && item.sharedRouteId);
  note.textContent = item.sharedWithFriends ? '✓ Shared with your friends and by link' : '✓ Shared by link';

  if (!detailMap) {
    detailMap = L.map('detail-map', { zoomControl: false });
    L.tileLayer(TILE_URL, TILE_OPTS).addTo(detailMap);
    detailLayer = L.layerGroup().addTo(detailMap);
  }
  detailLayer.clearLayers();
  const ll = toLL(item.points);
  const color = kind === 'walk' ? '#16a34a' : kind === 'friend' ? '#9333ea' : '#2563eb';
  const line = L.polyline(ll, { color, weight: 6 }).addTo(detailLayer);
  L.marker(ll[0], { icon: pinIcon('start') }).addTo(detailLayer).bindTooltip('Start');
  L.marker(ll.at(-1), { icon: pinIcon('end') }).addTo(detailLayer).bindTooltip('Finish');
  requestAnimationFrame(() => {
    detailMap.invalidateSize();
    detailMap.fitBounds(line.getBounds(), { padding: [24, 24] });
  });
}

function closeDetail() {
  $('#detail').hidden = true;
  detailItem = null;
}

const currentDetail = () => detailItem && getItem(detailItem.kind, detailItem.id);

/** Save changes to the walk or saved route currently open. */
function updateCurrent(changes) {
  const { kind, id } = detailItem;
  if (kind === 'walk') store.updateWalk(id, changes);
  else if (kind === 'route') store.saveRoute({ ...store.getRoute(id), ...changes });
  if (kind === 'walk') scheduleSync();
  renderHistory();
  renderRoutes();
}

$('#btn-detail-back').addEventListener('click', closeDetail);

$('#btn-follow').addEventListener('click', () => {
  if (detailItem) followRoute(detailItem.kind, detailItem.id);
});

$('#btn-share').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item) return;
  const { kind } = detailItem;
  const send = async (url) => {
    const res = await shareLink({ title: item.name, text: `Walk this route with me: ${item.name}`, url });
    if (res === 'copied') toast('Link copied. Paste it to a friend.');
  };

  if (kind === 'friend') return send(buildOnlineLink(item.id, webBase()));
  if (!user) {
    if (cloud.cloudEnabled) toast('Tip: sign in to share with friends inside the app');
    return send(buildShareLink(item.name, item.points, webBase()));
  }

  const choice = await openDialog({
    title: 'Share route',
    text: `“${item.name}” · ${formatDistance(item.distance)}`,
    stacked: true,
    buttons: [
      btn('friends', '👥 Share with my friends', 'primary'),
      btn('link', '🔗 Send a link'),
      btn('cancel', 'Cancel', 'plain'),
    ],
  });
  if (choice !== 'friends' && choice !== 'link') return;
  try {
    const withFriends = choice === 'friends';
    const routeId = await cloud.publishRoute({
      name: item.name,
      points: item.points,
      distance: item.distance,
      withFriends,
      existingId: item.sharedRouteId,
    });
    updateCurrent({ sharedRouteId: routeId, sharedWithFriends: Boolean(item.sharedWithFriends || withFriends) });
    openDetail(detailItem.kind, detailItem.id);
    if (withFriends) {
      toast(friendsState.friends.length ? 'Shared! Your friends will see it in their Routes tab.' : 'Shared. Add friends on the Me tab so they can see it.');
    } else {
      await send(buildOnlineLink(routeId, webBase()));
    }
  } catch (e) {
    toast(e.message);
  }
});

$('#btn-unshare').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item?.sharedRouteId) return;
  const ok = await confirmDialog('Stop sharing?', 'Friends will no longer see this route and links to it will stop working.', 'Stop sharing');
  if (!ok) return;
  try {
    await cloud.unpublishRoute(item.sharedRouteId);
    updateCurrent({ sharedRouteId: null, sharedWithFriends: false });
    openDetail(detailItem.kind, detailItem.id);
    toast('No longer shared');
  } catch (e) {
    toast(e.message);
  }
});

$('#btn-save-route').addEventListener('click', () => {
  const item = currentDetail();
  if (!item) return;
  const existing = store.getRoutes().find((r) => r.remoteId === item.id);
  if (existing) return toast('Already in your saved routes');
  addRoute(item.name, item.points, { remoteId: item.id, owner: item.owner });
  toast('Saved. It stays even if your friend stops sharing it.');
});

$('#btn-gpx').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item) return;
  const safe = item.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'walk';
  try {
    await saveTextFile(`${safe}.gpx`, toGPX(item.name, item.points));
  } catch (e) {
    toast(`Could not export: ${e.message}`);
  }
});

$('#btn-rename').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item) return;
  const name = await promptDialog('Rename', item.name);
  if (!name) return;
  updateCurrent({ name });
  $('#detail-title').textContent = name;
});

$('#btn-delete').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item) return;
  const where = user && detailItem.kind === 'walk' ? 'this phone and your account' : 'this phone';
  const ok = await confirmDialog('Delete?', `“${item.name}” will be removed from ${where}.`, 'Delete');
  if (!ok) return;
  if (detailItem.kind === 'walk') {
    store.deleteWalk(item.id);
    scheduleSync();
  } else store.deleteRoute(item.id);
  if (guide?.id === item.id) stopFollowing();
  closeDetail();
  renderHistory();
  renderRoutes();
});

// ================================================================ receiving routes

function addRoute(name, points, extra = {}) {
  const route = { id: store.uid(), name, points, distance: pathLength(points), added: Date.now(), ...extra };
  store.saveRoute(route);
  renderRoutes();
  return route;
}

/** Handle a share link (web hash, https link or walker:// link). Returns false if it isn't one. */
async function handleIncoming(text) {
  let parsed;
  try {
    parsed = parseShareUrl(text);
  } catch {
    toast('That share link looks broken.');
    return true;
  }
  if (!parsed) return false;

  let route;
  if (parsed.type === 'online') {
    const existing = store.getRoutes().find((r) => r.remoteId === parsed.id);
    if (existing) {
      openDetail('route', existing.id);
      return true;
    }
    if (store.getFriendRoute(parsed.id)) {
      openDetail('friend', parsed.id);
      return true;
    }
    if (!cloud.cloudEnabled) {
      toast('This version of Walker can’t open online routes.');
      return true;
    }
    try {
      toast('Loading shared route…');
      route = await cloud.fetchSharedRoute(parsed.id);
    } catch (e) {
      toast(e.message);
      return true;
    }
  } else {
    route = { name: parsed.name, points: parsed.points, distance: pathLength(parsed.points) };
  }

  const buttons = [btn('follow', 'Save & follow', 'primary'), btn('save', 'Just save'), btn('cancel', 'Not now', 'plain')];
  if (isAndroidBrowser && parsed.type === 'online') buttons.unshift(btn('app', 'Open in the Walker app', 'primary'));
  const choice = await openDialog({
    title: 'Route shared with you',
    text: `“${route.name}” · ${formatDistance(route.distance)}${route.owner ? ` · from @${route.owner}` : ''}`,
    stacked: true,
    buttons,
  });
  if (choice === 'app') {
    location.href = appIntentUrl(parsed.id);
    return true;
  }
  if (choice !== 'follow' && choice !== 'save') return true;
  const saved = addRoute(route.name, route.points, parsed.type === 'online' ? { remoteId: route.id, owner: route.owner } : {});
  if (choice === 'follow') followRoute('route', saved.id);
  else toast('Saved to Routes');
  return true;
}

async function handleHash() {
  if (!location.hash) return;
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  await handleIncoming(hash);
}

$('#btn-add-link').addEventListener('click', async () => {
  const text = await promptDialog('Add route from link', '', 'Paste the share link here', 'Add');
  if (!text) return;
  if (!(await handleIncoming(text))) toast('That doesn’t look like a Walker share link.');
});

$('#gpx-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { name, points } = parseGPX(await file.text());
    const route = addRoute(name, points);
    openDetail('route', route.id);
  } catch (err) {
    toast(err.message);
  }
});

// ================================================================ account, sync & friends

let authMode = 'signin';
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.segmented button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#auth-username-row').hidden = mode !== 'signup';
  $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('#auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#auth-error').hidden = true;
}
document.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const err = $('#auth-error');
  const submit = $('#auth-submit');
  err.hidden = true;
  if (!email || !password) {
    err.textContent = 'Enter your email and password.';
    err.hidden = false;
    return;
  }
  submit.disabled = true;
  try {
    if (authMode === 'signup') {
      const { needsConfirmation } = await cloud.signUp(email, password, $('#auth-username').value);
      if (needsConfirmation) {
        setAuthMode('signin');
        await openDialog({
          title: 'Check your email',
          text: `We sent a confirmation link to ${email}. Tap it, then come back and sign in.`,
          buttons: [btn('ok', 'OK', 'primary')],
        });
      }
    } else {
      await cloud.signIn(email, password);
    }
    $('#auth-password').value = '';
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

$('#btn-signout').addEventListener('click', async () => {
  const ok = await confirmDialog('Sign out?', 'Your walks stay safe in your account. Sign in again any time to get them back.', 'Sign out');
  if (!ok) return;
  await runSync().catch(() => {});
  await cloud.signOut();
});

let lastUserId = null;
async function onUserChanged(u) {
  user = u;
  const id = u?.id ?? null;
  if (id === lastUserId) return;
  lastUserId = id;
  if (!u) {
    profile = null;
    friendsState = { friends: [], incoming: [], outgoing: [] };
    renderMe();
    renderRoutes();
    return;
  }
  // A different account signed in on this phone: drop the previous account's data.
  const owner = store.getOwner();
  if (owner && owner !== u.id) {
    store.clearAccountData();
    renderHistory();
  }
  renderMe();
  try {
    profile = await cloud.myProfile();
  } catch {
    profile = { username: null, email: u.email };
  }
  renderMe();
  runSync();
  loadFriends();
  loadFriendRoutes();
}

let syncTimer = null;
function scheduleSync() {
  if (!user) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 1500);
}

async function runSync() {
  if (!user) return;
  const status = $('#sync-status');
  const badge = $('#sync-badge');
  status.textContent = 'Syncing…';
  badge.textContent = 'Syncing…';
  badge.hidden = false;
  $('#btn-sync').disabled = true;
  try {
    const res = await syncWalks();
    if (res && (res.pulled || res.removed)) renderHistory();
    badge.hidden = true;
  } catch (e) {
    badge.textContent = 'Offline';
    status.textContent = `Sync failed: ${e.message}`;
    return;
  } finally {
    $('#btn-sync').disabled = false;
  }
  renderSyncStatus();
}

function renderSyncStatus() {
  const t = store.getLastSync();
  const n = store.getWalks().length;
  $('#sync-status').textContent = t
    ? `${n} walk${n === 1 ? '' : 's'} backed up · last synced ${timeAgo(t)}`
    : 'Not synced yet';
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return dateFmt.format(t);
}

async function loadFriends() {
  if (!user) return;
  try {
    friendsState = await cloud.listFriends();
  } catch (e) {
    toast(e.message);
  }
  renderFriends();
}

let friendRoutesLoadedAt = 0;
async function loadFriendRoutes(force = false) {
  if (!user || (!force && Date.now() - friendRoutesLoadedAt < 60_000)) return;
  friendRoutesLoadedAt = Date.now();
  try {
    const routes = await cloud.friendRoutes();
    store.setFriendRoutes(routes);
    const seen = Number(localStorage.getItem('walker.seenRoutes') || 0);
    $('#routes-dot').hidden = !routes.some((r) => r.added > seen) || isViewActive('routes');
    if (isViewActive('routes')) markRoutesSeen();
  } catch (e) {
    if (force) toast(e.message);
  }
  renderRoutes();
}

function markRoutesSeen() {
  localStorage.setItem('walker.seenRoutes', String(Date.now()));
  $('#routes-dot').hidden = true;
}

function renderMe() {
  const enabled = cloud.cloudEnabled;
  $('#cloud-off').hidden = enabled;
  $('#auth-form').hidden = !enabled || Boolean(user);
  $('#account').hidden = !user;
  $('#set-stride').value = Math.round(settings.strideM * 100);
  if (!user) return;
  const name = profile?.username;
  $('#me-username').textContent = name ? `@${name}` : 'Your account';
  $('#me-email').textContent = profile?.email || user.email || '';
  $('#me-avatar').textContent = (name || user.email || '?')[0];
  renderSyncStatus();
  renderFriends();
}

function renderFriends() {
  const { friends, incoming, outgoing } = friendsState;
  const person = (f, tag, actions) =>
    `<li data-id="${escapeHtml(f.id)}" data-name="${escapeHtml(f.username)}"><span class="who">@${escapeHtml(f.username)}${tag ? `<span class="tag">${tag}</span>` : ''}</span>${actions}</li>`;
  $('#friend-requests').innerHTML = [
    ...incoming.map((f) =>
      person(f, 'wants to be your friend', '<button class="btn primary" data-act="accept">Accept</button><button class="btn secondary" data-act="remove">Decline</button>')
    ),
    ...outgoing.map((f) => person(f, 'request sent', '<button class="btn secondary" data-act="remove">Cancel</button>')),
  ].join('');
  $('#friend-list').innerHTML = friends.map((f) => person(f, '', '<button class="btn secondary" data-act="unfriend">Remove</button>')).join('');
  $('#friends-empty').hidden = friends.length + incoming.length + outgoing.length > 0;
  $('#me-dot').hidden = incoming.length === 0;
}

async function friendAction(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const li = b.closest('li');
  const { id, name } = li.dataset;
  try {
    if (b.dataset.act === 'accept') {
      await cloud.acceptFriend(id);
      toast(`You're now friends with @${name}`);
      loadFriendRoutes(true);
    } else if (b.dataset.act === 'unfriend') {
      if (!(await confirmDialog(`Remove @${name}?`, 'You will stop seeing each other’s shared routes.', 'Remove'))) return;
      await cloud.removeFriend(id);
      loadFriendRoutes(true);
    } else {
      await cloud.removeFriend(id);
    }
  } catch (ex) {
    toast(ex.message);
  }
  loadFriends();
}
$('#friend-requests').addEventListener('click', friendAction);
$('#friend-list').addEventListener('click', friendAction);

$('#add-friend-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#friend-username');
  if (!input.value.trim()) return;
  try {
    toast(await cloud.addFriend(input.value));
    input.value = '';
    loadFriends();
    loadFriendRoutes(true);
  } catch (ex) {
    toast(ex.message);
  }
});

$('#btn-sync').addEventListener('click', runSync);
$('#btn-refresh-friends').addEventListener('click', () => {
  loadFriends();
  loadFriendRoutes(true);
});
$('#btn-refresh-routes').addEventListener('click', () => loadFriendRoutes(true));

$('#set-stride').addEventListener('change', (e) => {
  const cm = Math.min(150, Math.max(30, Number(e.target.value) || 75));
  settings.strideM = cm / 100;
  e.target.value = cm;
  store.saveSettings(settings);
  toast('Saved');
});

// ================================================================ navigation, dialogs, toast

const TITLES = { walk: 'Walker', history: 'History', routes: 'Routes', me: 'Me' };
const isViewActive = (name) => $(`#view-${name}`).classList.contains('active');

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('#title').textContent = TITLES[name];
  if (name === 'walk') setTimeout(() => map.invalidateSize(), 0);
  if (name === 'routes') {
    markRoutesSeen();
    loadFriendRoutes();
  }
  if (name === 'me') {
    renderMe();
    loadFriends();
  }
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

const btn = (value, label, cls = 'secondary') => ({ value, label, cls });

/** Show a dialog. Resolves to the value of the button pressed (or null). */
function openDialog({ title, text = '', input = null, placeholder = '', buttons, stacked = false }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = text;
  $('#dialog-text').hidden = !text;
  const inp = $('#dialog-input');
  inp.hidden = input === null;
  inp.value = input ?? '';
  inp.placeholder = placeholder;
  const menu = $('#dialog-buttons');
  menu.className = stacked ? 'stacked' : '';
  menu.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.value = b.value;
    el.textContent = b.label;
    el.className = `btn ${b.cls}`;
    menu.appendChild(el);
  }
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue || null), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    if (input !== null) inp.select();
  });
}
const confirmDialog = (title, text, okLabel) =>
  openDialog({ title, text, buttons: [btn('cancel', 'Cancel'), btn('ok', okLabel, 'primary')] }).then((v) => v === 'ok');
async function promptDialog(title, value, placeholder = '', okLabel = 'Save') {
  const v = await openDialog({ title, input: value, placeholder, buttons: [btn('cancel', 'Cancel'), btn('ok', okLabel, 'primary')] });
  return v === 'ok' ? $('#dialog-input').value.trim() : null;
}

onBackButton(() => {
  const dlg = $('#dialog');
  if (dlg.open) {
    dlg.close();
    return true;
  }
  if (!$('#detail').hidden) {
    closeDetail();
    return true;
  }
  if (!isViewActive('walk')) {
    showView('walk');
    return true;
  }
  return false;
});

// ================================================================ boot

renderHistory();
renderRoutes();
renderMe();
resumeActiveWalk().then((resumed) => {
  if (!resumed) startPassive();
});
cloud.onAuthChange((u) => setTimeout(() => onUserChanged(u), 0));
cloud.currentUser().then((u) => onUserChanged(u));
handleHash();
window.addEventListener('hashchange', handleHash);
onOpenUrl((url) => handleIncoming(url));

if (!isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
