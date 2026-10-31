import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  pathLength,
  cumulativeDistances,
  bearing,
  compassName,
  locateOnRoute,
  pointAtDistance,
  simplify,
  encodePolyline,
  decodePolyline,
  formatDistance,
  formatDuration,
  avgSpeedKmh,
} from '../js/geo.js';
import { buildShareLink, parseShareHash } from '../js/share.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

// A straight 1 km line heading north (1° latitude ≈ 111.2 km).
const north = Array.from({ length: 11 }, (_, i) => ({ lat: 51.5 + i * 0.0008993, lng: -0.1 }));

test('haversine: London → Paris ≈ 344 km', () => {
  near(haversine({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 }) / 1000, 343.5, 1.5);
});

test('pathLength and cumulative distances', () => {
  near(pathLength(north), 1000, 2);
  const cum = cumulativeDistances(north);
  assert.equal(cum[0], 0);
  near(cum.at(-1), pathLength(north), 1e-9);
});

test('bearing and compass names', () => {
  near(bearing(north[0], north[1]), 0, 0.01);
  near(bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), 90, 0.01);
  assert.equal(compassName(0), 'N');
  assert.equal(compassName(130), 'SE');
  assert.equal(compassName(350), 'N');
});

test('locateOnRoute: walker halfway along, slightly off to the side', () => {
  const cum = cumulativeDistances(north);
  const p = { lat: 51.5 + 5 * 0.0008993, lng: -0.1 + 0.0001 }; // ~7 m east of the line
  const loc = locateOnRoute(north, cum, p);
  near(loc.along, 500, 3);
  near(loc.remaining, 500, 3);
  near(loc.progress, 0.5, 0.01);
  near(loc.offRoute, 7, 1);
});

test('locateOnRoute prefers the segment ahead on an out-and-back route', () => {
  const route = [...north, ...north.slice(0, -1).reverse()]; // there and back
  const cum = cumulativeDistances(route);
  const p = north[3];
  // Early in the walk we're on the "out" leg…
  near(locateOnRoute(route, cum, p, 0).along, 300, 3);
  // …but once we've passed the turnaround we should match the "back" leg.
  near(locateOnRoute(route, cum, p, 12).along, 1700, 3);
});

test('pointAtDistance interpolates and clamps', () => {
  const cum = cumulativeDistances(north);
  near(haversine(pointAtDistance(north, cum, 250), north[0]), 250, 1);
  assert.deepEqual(pointAtDistance(north, cum, -5), north[0]);
  assert.deepEqual(pointAtDistance(north, cum, 1e6), north.at(-1));
});

test('simplify removes collinear points and keeps corners', () => {
  const corner = [...north, { lat: north.at(-1).lat, lng: -0.09 }];
  const s = simplify(corner, 2);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], corner[0]);
  assert.deepEqual(s.at(-1), corner.at(-1));
});

test('polyline encoding round-trips (Google reference example)', () => {
  const pts = [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ];
  const enc = encodePolyline(pts);
  assert.equal(enc, '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  decodePolyline(enc).forEach((p, i) => {
    near(p.lat, pts[i].lat, 1e-5);
    near(p.lng, pts[i].lng, 1e-5);
  });
});

test('share link round-trips route name and shape', () => {
  const url = buildShareLink('Park loop & café', north, 'https://example.com/walker/index.html?x=1#old');
  const u = new URL(url);
  assert.equal(u.pathname, '/walker/index.html');
  assert.equal(u.search, '');
  const parsed = parseShareHash(u.hash);
  assert.equal(parsed.name, 'Park loop & café');
  near(pathLength(parsed.points), 1000, 3);
  assert.equal(parseShareHash('#something-else'), null);
});

test('formatting and speed', () => {
  assert.equal(formatDistance(532.4), '532 m');
  assert.equal(formatDistance(2345), '2.35 km');
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  near(avgSpeedKmh(5000, 3_600_000), 5, 1e-9);
  assert.equal(avgSpeedKmh(100, 0), 0);
});
