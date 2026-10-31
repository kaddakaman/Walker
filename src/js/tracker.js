// GPS tracking for a walk. Filters out noisy fixes so jitter while standing
// still doesn't inflate the distance.

import { haversine } from './geo.js';
import { watchLocation } from './platform.js';

const MAX_ACCURACY_M = 35; // ignore fixes less accurate than this
const MIN_STEP_M = 4; // ignore movement smaller than this (GPS jitter)
const MAX_SPEED_MS = 9; // ~32 km/h: anything faster is a GPS jump

/**
 * Decide whether a new fix should be added to the track.
 * Returns the distance to add (m), or -1 to drop the fix.
 */
export function acceptFix(last, p) {
  if (p.acc > MAX_ACCURACY_M) return -1;
  if (!last) return 0;
  const d = haversine(last, p);
  const dt = (p.t - last.t) / 1000;
  if (d < Math.max(MIN_STEP_M, p.acc * 0.5)) return -1;
  if (dt > 0 && d / dt > MAX_SPEED_MS) return -1;
  return d;
}

export class Tracker {
  constructor({ onPoint, onPosition, onError }) {
    this.onPoint = onPoint; // each accepted track point
    this.onPosition = onPosition; // every raw fix (for the "you are here" dot)
    this.onError = onError;
    this.stopFn = null;
    this.points = [];
    this.distance = 0;
  }

  get active() {
    return this.stopFn !== null;
  }

  /** Start tracking, optionally continuing an existing track (resumed walk). */
  async start(points = [], distance = 0) {
    this.points = points.slice();
    this.distance = distance;
    this.stopFn = () => {}; // mark active immediately
    try {
      this.stopFn = await watchLocation(
        (p) => this.#handle(p),
        (e) => this.onError?.(e),
        { background: true }
      );
    } catch (e) {
      this.stopFn = null;
      this.onError?.(e);
    }
  }

  stop() {
    this.stopFn?.();
    this.stopFn = null;
  }

  #handle(p) {
    this.onPosition?.(p);
    const add = acceptFix(this.points.at(-1), p);
    if (add < 0) return;
    this.distance += add;
    const point = { lat: p.lat, lng: p.lng, t: p.t, acc: p.acc };
    this.points.push(point);
    this.onPoint?.(point, this.distance);
  }
}
