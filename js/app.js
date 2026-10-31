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
import { Tracker, currentPosition } from './tracker.js';
import { StepCounter } from './steps.js';
import * as store from './storage.js';
import { shareRoute, parseShareHash, toGPX, parseGPX, downloadFile } from './share.js';

const $ = (sel) => document.querySelector(sel);
const OFF_ROUTE_M = 30;
const ARRIVED_M = 25;

// ---------------------------------------------------------------- map setup

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

// ---------------------------------------------------------------- state

const settings = store.getSettings();
const steps = new StepCounter();
let walk = null; // { id, start, points, distance, guideId, guideName }
let guide = null; // { id, kind, name, points, cum, segIdx, arrived }
let timer = null;
let wakeLock = null;
let lastFix = null;

const tracker = new Tracker({
  onPosition: (p) => {
    lastFix = p;
    showMe(p);
    updateGpsStatus(p);
    if (guide) updateGuide(p);
  },
  onPoint: (p, distance) => {
    if (!walk) return;
    walk.points.push(p);
    walk.distance = distance;
    layers.track.addLatLng([p.lat, p.lng]);
    if (walk.points.length === 1) setStartMarker(p);
    updateStats();
    store.saveActive({ ...walk, steps: steps.steps });
  },
  onError: (err) => {
    const msg =
      err.code === 1
        ? 'Location permission denied. Allow location access to track walks.'
        : err.code === 3
          ? 'Still searching for GPS signal…'
          : err.message || 'Location unavailable.';
    $('#gps-status').textContent = msg;
    if (err.code === 1) toast(msg);
  },
});

function showMe(p) {
  const ll = [p.lat, p.lng];
  if (!layers.me) {
    layers.accuracy = L.circle(ll, { radius: p.acc || 10, color: '#2563eb', weight: 1, fillOpacity: 0.1 }).addTo(map);
    layers.me = L.marker(ll, { icon: meIcon, zIndexOffset: 1000 }).addTo(map);
    map.setView(ll, 17);
  } else {
    layers.me.setLatLng(ll);
    layers.accuracy.setLatLng(ll).setRadius(p.acc || 10);
    if (followMe) map.panTo(ll, { animate: true });
  }
}

function updateGpsStatus(p) {
  const el = $('#gps-status');
  if (p.acc <= 15) el.textContent = `GPS good (±${p.acc} m)`;
  else if (p.acc <= 35) el.textContent = `GPS OK (±${p.acc} m)`;
  else el.textContent = `Weak GPS (±${p.acc} m) — move into the open`;
}

function setStartMarker(p) {
  layers.start?.remove();
  layers.start = L.marker([p.lat, p.lng], { icon: pinIcon('start') }).addTo(map).bindTooltip('Start');
}

// ---------------------------------------------------------------- walking

async function startWalk() {
  walk = { id: store.uid(), start: Date.now(), points: [], distance: 0 };
  if (guide) Object.assign(walk, { guideId: guide.id, guideName: guide.name });
  layers.track.setLatLngs([]);
  layers.start?.remove();
  layers.start = null;
  followMe = true;

  await steps.start(); // asks for motion permission on iOS
  tracker.start();
  beginWalkingUi();
  store.saveActive({ ...walk, steps: 0 });
}

function beginWalkingUi() {
  const btn = $('#btn-toggle');
  btn.textContent = 'End walk';
  btn.className = 'big-btn end';
  clearInterval(timer);
  timer = setInterval(updateStats, 1000);
  updateStats();
  keepAwake(true);
}

async function endWalk() {
  const ok = await confirmDialog('End walk?', 'Your walk will be saved to History.', 'End walk');
  if (!ok) return;
  tracker.stop();
  steps.stop();
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

  if (record.points.length < 2) {
    toast('Walk too short to save — no GPS movement recorded.');
    resetStats();
    return;
  }
  store.saveWalk(record);
  renderHistory();
  toast(`Saved: ${formatDistance(record.distance)} in ${formatDuration(record.duration)}`);
  resetStats();
  layers.track.setLatLngs([]);
  layers.start?.remove();
  openDetail('walk', record.id);
}

function resetStats() {
  $('#s-time').textContent = '00:00';
  $('#s-dist').textContent = '0 m';
  $('#s-speed').textContent = '0.0';
  $('#s-steps').textContent = '0';
}

function updateStats() {
  if (!walk) return;
  const elapsed = Date.now() - walk.start;
  $('#s-time').textContent = formatDuration(elapsed);
  $('#s-dist').textContent = formatDistance(walk.distance);
  $('#s-speed').textContent = avgSpeedKmh(walk.distance, elapsed).toFixed(1);
  const s = steps.result(walk.distance, settings.strideM);
  $('#s-steps').textContent = (s.estimated && s.steps ? '≈' : '') + s.steps.toLocaleString();
}

function defaultWalkName(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const part = h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
  return `${part} walk`;
}

/** Resume a walk that was in progress if the page was reloaded or closed. */
function resumeActiveWalk() {
  const a = store.getActive();
  if (!a) return;
  walk = { id: a.id, start: a.start, points: a.points || [], distance: a.distance || 0, guideId: a.guideId, guideName: a.guideName };
  tracker.start();
  tracker.points = walk.points.slice();
  tracker.distance = walk.distance;
  steps.steps = a.steps || 0;
  steps.start(); // may not get permission on iOS without a tap; falls back to estimate
  layers.track.setLatLngs(toLL(walk.points));
  if (walk.points[0]) setStartMarker(walk.points[0]);
  beginWalkingUi();
  toast('Resumed your walk in progress');
}

// Keep the screen on while walking — browsers pause GPS when the screen is off.
async function keepAwake(on) {
  try {
    if (on && settings.keepAwake && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not supported / denied — fine */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && walk) keepAwake(true);
});

$('#btn-toggle').addEventListener('click', () => (walk ? endWalk() : startWalk()));
$('#btn-recenter').addEventListener('click', () => {
  followMe = true;
  if (lastFix) map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom(), 16));
});

// ---------------------------------------------------------------- following a route

function followRoute(kind, id) {
  const src = kind === 'walk' ? store.getWalk(id) : store.getRoute(id);
  if (!src) return;
  const points = src.points.map((p) => ({ lat: p.lat, lng: p.lng }));
  guide = { id, kind, name: src.name, points, cum: cumulativeDistances(points), segIdx: 0, arrived: false };
  if (walk) Object.assign(walk, { guideId: id, guideName: src.name });

  layers.guide.setLatLngs(toLL(points));
  layers.guideStart?.remove();
  layers.guideEnd?.remove();
  layers.guideStart = L.marker(toLL([points[0]])[0], { icon: pinIcon('start') }).addTo(map).bindTooltip('Route start');
  layers.guideEnd = L.marker(toLL([points.at(-1)])[0], { icon: pinIcon('end') }).addTo(map).bindTooltip('Route finish');

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

  // Not started yet and still away from the route: direct them to the start.
  const toStart = haversine(p, guide.points[0]);
  const loc = locateOnRoute(guide.points, guide.cum, p, guide.segIdx);

  if (!walk && loc.offRoute > OFF_ROUTE_M) {
    box.className = 'guide';
    main.textContent = `Head ${pointArrow(guide.points[0])} to the start`;
    sub.textContent = `${formatDistance(toStart)} to start · route ${formatDistance(total)}`;
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
    // Point them back to the nearest place on the route.
    const back = pointAtDistance(guide.points, guide.cum, loc.along);
    box.className = 'guide off';
    main.textContent = `Off route — head ${pointArrow(back)}`;
    sub.textContent = `${formatDistance(loc.offRoute)} from the route`;
    return;
  }

  // On route: aim at a point ~35 m further along it.
  const ahead = pointAtDistance(guide.points, guide.cum, loc.along + 35);
  box.className = 'guide';
  main.textContent = `Head ${pointArrow(ahead)}`;
  sub.textContent = `${formatDistance(loc.remaining)} to go · ${Math.round(loc.progress * 100)}% done`;
}

$('#btn-stop-guide').addEventListener('click', stopFollowing);

// ---------------------------------------------------------------- history & routes lists

function thumbnail(points) {
  const pts = simplify(points, 15);
  if (pts.length < 2) return '';
  const k = Math.cos((pts[0].lat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 6, size = 56 - pad * 2;
  const ox = (size - ((maxX - minX) / span) * size) / 2;
  const oy = (size - ((maxY - minY) / span) * size) / 2;
  const d = xs
    .map((x, i) => `${(pad + ox + ((x - minX) / span) * size).toFixed(1)},${(pad + oy + ((ys[i] - minY) / span) * size).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 56 56"><rect width="56" height="56" rx="10" fill="rgba(22,163,74,.1)"/><polyline points="${d}" fill="none" stroke="#16a34a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function renderHistory() {
  const walks = store.getWalks();
  const list = $('#history-list');
  $('#history-empty').hidden = walks.length > 0;
  const totalDist = walks.reduce((s, w) => s + w.distance, 0);
  const totalSteps = walks.reduce((s, w) => s + (w.steps || 0), 0);
  $('#history-summary').innerHTML = walks.length
    ? `<div class="stat"><span class="v">${walks.length}</span><span class="l">Walks</span></div>
       <div class="stat"><span class="v">${(totalDist / 1000).toFixed(1)}</span><span class="l">Total km</span></div>
       <div class="stat"><span class="v">${totalSteps.toLocaleString()}</span><span class="l">Steps</span></div>`
    : '';
  list.innerHTML = walks
    .map(
      (w) => `<li data-id="${w.id}">
        <div class="thumb">${thumbnail(w.points)}</div>
        <div class="info">
          <div class="name">${escapeHtml(w.name)}</div>
          <div class="meta">${dateFmt.format(w.start)} · ${timeFmt.format(w.start)}</div>
          <div class="meta">${formatDistance(w.distance)} · ${formatDuration(w.duration)} · ${w.avgSpeed.toFixed(1)} km/h</div>
        </div>
        <span class="chev">›</span>
      </li>`
    )
    .join('');
}

function renderRoutes() {
  const routes = store.getRoutes();
  $('#routes-empty').hidden = routes.length > 0;
  $('#routes-list').innerHTML = routes
    .map(
      (r) => `<li data-id="${r.id}">
        <div class="thumb">${thumbnail(r.points)}</div>
        <div class="info">
          <div class="name">${escapeHtml(r.name)}</div>
          <div class="meta">${formatDistance(r.distance)} · added ${dateFmt.format(r.added)}</div>
        </div>
        <span class="chev">›</span>
      </li>`
    )
    .join('');
}

$('#history-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openDetail('walk', li.dataset.id);
});
$('#routes-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openDetail('route', li.dataset.id);
});

// ---------------------------------------------------------------- detail screen

let detailMap = null;
let detailLayer = null;
let detailItem = null; // { kind, id }

function openDetail(kind, id) {
  const item = kind === 'walk' ? store.getWalk(id) : store.getRoute(id);
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
      <div class="stat"><span class="v">${item.avgSpeed.toFixed(1)}</span><span class="l">Avg km/h</span></div>
      <div class="stat"><span class="v">${item.stepsEstimated ? '≈' : ''}${item.steps.toLocaleString()}</span><span class="l">Steps</span></div>`;
  } else {
    $('#detail-date').textContent = `Shared route · added ${dateFmt.format(item.added)}`;
    $('#detail-stats').innerHTML = `
      <div class="stat" style="grid-column: span 2"><span class="v">${formatDistance(item.distance)}</span><span class="l">Distance</span></div>
      <div class="stat" style="grid-column: span 2"><span class="v">${formatDuration((item.distance / 5000) * 3600000)}</span><span class="l">Approx. time at 5 km/h</span></div>`;
  }

  if (!detailMap) {
    detailMap = L.map('detail-map', { zoomControl: false });
    L.tileLayer(TILE_URL, TILE_OPTS).addTo(detailMap);
    detailLayer = L.layerGroup().addTo(detailMap);
  }
  detailLayer.clearLayers();
  const ll = toLL(item.points);
  const line = L.polyline(ll, { color: kind === 'walk' ? '#16a34a' : '#2563eb', weight: 6 }).addTo(detailLayer);
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

const currentDetail = () =>
  detailItem && (detailItem.kind === 'walk' ? store.getWalk(detailItem.id) : store.getRoute(detailItem.id));

$('#btn-detail-back').addEventListener('click', closeDetail);

$('#btn-follow').addEventListener('click', () => {
  if (detailItem) followRoute(detailItem.kind, detailItem.id);
});

$('#btn-share').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item) return;
  const res = await shareRoute(item.name, item.points);
  if (res === 'copied') toast('Share link copied — send it to a friend');
});

$('#btn-gpx').addEventListener('click', () => {
  const item = currentDetail();
  if (!item) return;
  const safe = item.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'walk';
  downloadFile(`${safe}.gpx`, toGPX(item.name, item.points));
});

$('#btn-rename').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item) return;
  const name = await promptDialog('Rename', item.name);
  if (!name) return;
  if (detailItem.kind === 'walk') store.updateWalk(item.id, { name });
  else store.saveRoute({ ...item, name });
  $('#detail-title').textContent = name;
  renderHistory();
  renderRoutes();
});

$('#btn-delete').addEventListener('click', async () => {
  const item = currentDetail();
  if (!item) return;
  const ok = await confirmDialog('Delete?', `“${item.name}” will be removed from this device.`, 'Delete');
  if (!ok) return;
  if (detailItem.kind === 'walk') store.deleteWalk(item.id);
  else store.deleteRoute(item.id);
  if (guide?.id === item.id) stopFollowing();
  closeDetail();
  renderHistory();
  renderRoutes();
});

// ---------------------------------------------------------------- importing shared routes

function addRoute(name, points) {
  const route = { id: store.uid(), name, points, distance: pathLength(points), added: Date.now() };
  store.saveRoute(route);
  renderRoutes();
  return route;
}

async function handleShareLink() {
  let shared;
  try {
    shared = parseShareHash(location.hash);
  } catch {
    toast('That share link looks broken.');
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (!shared) return;
  const dist = formatDistance(pathLength(shared.points));
  const ok = await openDialog({
    title: 'Route shared with you',
    text: `“${shared.name}” · ${dist}. Save it and start following?`,
    okLabel: 'Save & follow',
    cancelLabel: 'Just save',
  });
  const route = addRoute(shared.name, shared.points);
  if (ok) followRoute('route', route.id);
  else toast('Saved to Routes');
}

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

// ---------------------------------------------------------------- navigation, dialogs, toast

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('#title').textContent = { walk: 'Walker', history: 'History', routes: 'Routes' }[name];
  if (name === 'walk') setTimeout(() => map.invalidateSize(), 0);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function openDialog({ title, text = '', okLabel = 'OK', cancelLabel = 'Cancel', input = null }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = text;
  $('#dialog-text').hidden = !text;
  $('#dialog-ok').textContent = okLabel;
  $('#dialog-cancel').textContent = cancelLabel;
  const inp = $('#dialog-input');
  inp.hidden = input === null;
  inp.value = input ?? '';
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => resolve(dlg.returnValue === 'ok' ? (input === null ? true : inp.value.trim()) : null),
      { once: true }
    );
    dlg.returnValue = '';
    dlg.showModal();
    if (input !== null) inp.select();
  });
}
const confirmDialog = (title, text, okLabel) => openDialog({ title, text, okLabel }).then(Boolean);
const promptDialog = (title, value) => openDialog({ title, input: value, okLabel: 'Save' });

// ---------------------------------------------------------------- boot

renderHistory();
renderRoutes();
resumeActiveWalk();
if (!walk) {
  // Show the user's location on the map before they start.
  currentPosition().then((p) => !lastFix && showMe({ ...p, acc: 30 }), () => {});
  // A passive watch so the GPS is warmed up and the "you are here" dot moves.
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      (pos) => {
        if (tracker.active) return;
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
        lastFix = p;
        showMe(p);
        updateGpsStatus(p);
        if (guide) updateGuide(p);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }
}
handleShareLink();
window.addEventListener('hashchange', handleShareLink);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
