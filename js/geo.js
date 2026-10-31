// Pure geographic helpers. No DOM access, so they can be unit-tested in Node.
// Points are { lat, lng } objects (extra fields such as t / acc are ignored).

const R = 6371008.8; // mean Earth radius in metres
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance between two points in metres. */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total length of a path in metres. */
export function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

/** Cumulative distance (metres) at every vertex of a path. */
export function cumulativeDistances(points) {
  const out = new Array(points.length);
  let d = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) d += haversine(points[i - 1], points[i]);
    out[i] = d;
  }
  return out;
}

/** Initial compass bearing from a to b, degrees 0..360 (0 = north). */
export function bearing(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassName(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

// Local flat projection (metres) around a reference latitude — accurate enough
// for the few-hundred-metre spans used in segment maths.
function project(p, refLat) {
  const k = Math.cos(toRad(refLat));
  return { x: toRad(p.lng) * R * k, y: toRad(p.lat) * R };
}

/**
 * Closest point on segment a→b to p.
 * Returns { dist (m), t (0..1 along segment) }.
 */
export function pointToSegment(p, a, b) {
  const P = project(p, p.lat);
  const A = project(a, p.lat);
  const B = project(b, p.lat);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = A.x + t * dx;
  const cy = A.y + t * dy;
  return { dist: Math.hypot(P.x - cx, P.y - cy), t };
}

/** Linear interpolation between two lat/lng points. */
export function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Point located `dist` metres along the route (clamped to the ends). */
export function pointAtDistance(route, cum, dist) {
  if (dist <= 0) return route[0];
  const total = cum[cum.length - 1];
  if (dist >= total) return route[route.length - 1];
  let i = 1;
  while (i < cum.length && cum[i] < dist) i++;
  const segLen = cum[i] - cum[i - 1];
  const t = segLen === 0 ? 0 : (dist - cum[i - 1]) / segLen;
  return lerp(route[i - 1], route[i], t);
}

/**
 * Locate the walker on a guide route.
 *
 * Routes can loop back on themselves, so we first look a short way ahead of the
 * last known segment (hintIdx); only if that fails do we search the whole route.
 *
 * Returns { segIdx, offRoute (m), along (m from start), remaining (m), progress (0..1) }.
 */
export function locateOnRoute(route, cum, p, hintIdx = 0, windowSegs = 40, snapDist = 40) {
  const total = cum[cum.length - 1] || 0;
  if (route.length < 2) {
    const d = route.length ? haversine(p, route[0]) : Infinity;
    return { segIdx: 0, offRoute: d, along: 0, remaining: 0, progress: 1 };
  }
  const search = (from, to) => {
    let best = { dist: Infinity, i: from, t: 0 };
    for (let i = Math.max(0, from); i < Math.min(route.length - 1, to); i++) {
      const r = pointToSegment(p, route[i], route[i + 1]);
      if (r.dist < best.dist) best = { dist: r.dist, i, t: r.t };
    }
    return best;
  };
  let best = search(hintIdx - 2, hintIdx + windowSegs);
  if (best.dist > snapDist) {
    const global = search(0, route.length - 1);
    if (global.dist < best.dist) best = global;
  }
  const along = cum[best.i] + (cum[best.i + 1] - cum[best.i]) * best.t;
  return {
    segIdx: best.i,
    offRoute: best.dist,
    along,
    remaining: Math.max(0, total - along),
    progress: total ? along / total : 1,
  };
}

/** Douglas–Peucker simplification with a tolerance in metres. Keeps endpoints. */
export function simplify(points, tolerance = 3) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointToSegment(points[i], points[s], points[e]).dist;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// ---- Google encoded-polyline format (compact text form for share links) ----

function encodeValue(v) {
  v = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const p of points) {
    const lat = Math.round(p.lat * f);
    const lng = Math.round(p.lng * f);
    out += encodeValue(lat - lastLat) + encodeValue(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}

export function decodePolyline(str, precision = 5) {
  const f = 10 ** precision;
  const points = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (i >= str.length) throw new Error('Invalid polyline');
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / f, lng: lng / f });
  }
  return points;
}

// ---- Formatting ----

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Average speed in km/h from metres and milliseconds. */
export function avgSpeedKmh(metres, ms) {
  if (ms <= 0) return 0;
  return metres / 1000 / (ms / 3600000);
}
