// Sharing routes between people, without needing a server:
//  * Share link — the route is compressed into the URL itself.
//  * GPX file — the standard format used by Strava, Garmin, Google Earth, etc.

import { encodePolyline, decodePolyline, simplify } from './geo.js';

const MAX_LINK_POINTS = 1500;

/** Build a link that opens this app with the route ready to import. */
export function buildShareLink(name, points, baseUrl) {
  let pts = simplify(points, 3);
  // Very long walks: loosen the simplification until the link stays a sensible size.
  for (let tol = 6; pts.length > MAX_LINK_POINTS; tol *= 2) pts = simplify(points, tol);
  const params = new URLSearchParams({ name: name || 'Shared route', r: encodePolyline(pts) });
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = `share?${params.toString()}`;
  return url.toString();
}

/** Parse a share link's hash. Returns { name, points } or null. */
export function parseShareHash(hash) {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith('share?')) return null;
  const params = new URLSearchParams(h.slice('share?'.length));
  const r = params.get('r');
  if (!r) return null;
  const points = decodePolyline(r);
  if (points.length < 2) return null;
  return { name: params.get('name') || 'Shared route', points };
}

/** Share via the phone's share sheet, falling back to copying the link. */
export async function shareRoute(name, points) {
  const url = buildShareLink(name, points, location.href);
  const text = `Walk this route with me: ${name}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: name, text, url });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    window.prompt('Copy this link to share the route:', url);
    return 'prompted';
  }
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

export function downloadFile(filename, text, type = 'application/gpx+xml') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
