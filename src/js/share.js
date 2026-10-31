// Share links and GPX files.
//
// Two kinds of share link:
//  * Online  — `<web>/#route=<uuid>`: the route is stored in the cloud (needs an account).
//  * Offline — `<web>/#share?name=…&r=<polyline>`: the route is packed into the link itself.
// The app can also be opened with `walker://route/<uuid>`.

import { encodePolyline, decodePolyline, simplify } from './geo.js';

const MAX_LINK_POINTS = 1500;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Simplify a route enough to store or send compactly (~3 m accuracy). */
export function compactPoints(points, maxPoints = MAX_LINK_POINTS) {
  let pts = simplify(points, 3);
  for (let tol = 6; pts.length > maxPoints; tol *= 2) pts = simplify(points, tol);
  return pts;
}

/** Offline link with the route encoded inside it. */
export function buildShareLink(name, points, baseUrl) {
  const params = new URLSearchParams({ name: name || 'Shared route', r: encodePolyline(compactPoints(points)) });
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = `share?${params.toString()}`;
  return url.toString();
}

/** Online link to a route stored in the cloud. */
export function buildOnlineLink(routeId, baseUrl) {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = `route=${routeId}`;
  return url.toString();
}

/** Android "intent:" link that opens the installed app from a web page. */
export const appIntentUrl = (routeId) =>
  `intent://route/${routeId}#Intent;scheme=walker;package=com.kaddakaman.walker;end`;

/**
 * Understand any share link or hash a user might give us.
 * Returns { type: 'online', id } | { type: 'inline', name, points } | null.
 */
export function parseShareUrl(text) {
  if (!text) return null;
  text = String(text).trim();
  if (/^walker:\/\//i.test(text)) {
    const m = text.match(UUID);
    return m ? { type: 'online', id: m[0].toLowerCase() } : null;
  }
  const hashIdx = text.indexOf('#');
  const hash = hashIdx >= 0 ? text.slice(hashIdx + 1) : text;
  if (hash.startsWith('route=')) {
    const m = hash.match(UUID);
    return m ? { type: 'online', id: m[0].toLowerCase() } : null;
  }
  if (hash.startsWith('share?')) {
    const params = new URLSearchParams(hash.slice('share?'.length));
    const r = params.get('r');
    if (!r) return null;
    const points = decodePolyline(r);
    if (points.length < 2) return null;
    return { type: 'inline', name: params.get('name') || 'Shared route', points };
  }
  return null;
}

/** Back-compatible helper: parse an offline share hash. */
export function parseShareHash(hash) {
  const r = parseShareUrl(hash.startsWith('#') ? hash : `#${hash}`);
  return r && r.type === 'inline' ? { name: r.name, points: r.points } : null;
}

const esc = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function toGPX(name, points) {
  const pts = points
    .map((p) => {
      const time = p.t ? `<time>${new Date(p.t).toISOString()}</time>` : '';
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${time}</trkpt>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Walker" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Parse GPX text (tracks, routes or waypoints). Returns { name, points }. */
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file is not valid GPX.');
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('wpt')];
  const points = nodes
    .map((n) => ({ lat: parseFloat(n.getAttribute('lat')), lng: parseFloat(n.getAttribute('lon')) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (points.length < 2) throw new Error('No route found in that GPX file.');
  const nameEl = doc.querySelector('trk > name, rte > name, metadata > name');
  return { name: nameEl?.textContent?.trim() || 'Imported route', points };
}
