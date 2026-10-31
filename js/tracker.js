// GPS tracking: wraps navigator.geolocation.watchPosition and filters out
// noisy fixes so jitter while standing still doesn't inflate the distance.

import { haversine } from './geo.js';

const MAX_ACCURACY_M = 35; // ignore fixes less accurate than this
const MIN_STEP_M = 4; // ignore movement smaller than this (GPS jitter)
const MAX_SPEED_MS = 9; // ~32 km/h — anything faster is a GPS jump

export class Tracker {
  constructor({ onPoint, onPosition, onError }) {
    this.onPoint = onPoint; // called with each accepted track point
    this.onPosition = onPosition; // called with every raw fix (for the "you are here" dot)
    this.onError = onError;
    this.watchId = null;
    this.points = [];
    this.distance = 0;
  }

  get active() {
    return this.watchId !== null;
  }

  start() {
    if (!('geolocation' in navigator)) {
      this.onError?.(new Error('This device does not support GPS location.'));
      return;
    }
    this.points = [];
    this.distance = 0;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.#handle(pos),
      (err) => this.onError?.(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  #handle(pos) {
    const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
    const p = { lat, lng, t: pos.timestamp, acc: Math.round(accuracy) };
    this.onPosition?.(p, { heading, speed });

    if (accuracy > MAX_ACCURACY_M) return;
    const last = this.points[this.points.length - 1];
    if (last) {
      const d = haversine(last, p);
      const dt = (p.t - last.t) / 1000;
      if (d < Math.max(MIN_STEP_M, accuracy * 0.5)) return;
      if (dt > 0 && d / dt > MAX_SPEED_MS) return;
      this.distance += d;
    }
    this.points.push(p);
    this.onPoint?.(p, this.distance);
  }
}

/** One-off current position, used to centre the map before a walk. */
export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('No GPS'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}
