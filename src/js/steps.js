// Step counting.
//  * Android app: the phone's hardware step counter, which keeps counting
//    with the screen off.
//  * Browser: accelerometer peak detection (DeviceMotion), screen on only.
//  * Neither available: estimated from distance and stride length.

import { isNative, nativeSteps } from './platform.js';

export const DEFAULT_STRIDE_M = 0.75;

export class StepCounter {
  constructor() {
    this.steps = 0;
    this.offset = 0; // steps carried over from before an app restart
    this.sensorWorking = false;
    this._filtered = 9.81;
    this._baseline = 9.81;
    this._lastStep = 0;
    this._rising = false;
    this._handler = (e) => this.#onMotion(e);
  }

  /** Call from a user gesture (iOS browsers ask for motion permission). */
  async start(offset = 0) {
    this.offset = offset;
    this.steps = offset;
    this.sensorWorking = false;
    if (isNative) {
      this.sensorWorking = await nativeSteps.start();
      return this.sensorWorking;
    }
    if (typeof DeviceMotionEvent === 'undefined') return false;
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch {
      return false;
    }
    window.addEventListener('devicemotion', this._handler);
    return true;
  }

  /** Refresh `steps` from the native sensor (no-op in the browser). */
  async poll() {
    if (isNative && this.sensorWorking) this.steps = this.offset + (await nativeSteps.read());
    return this.steps;
  }

  async stop() {
    if (isNative) {
      if (this.sensorWorking) this.steps = this.offset + (await nativeSteps.stop());
      else await nativeSteps.stop();
    } else {
      window.removeEventListener('devicemotion', this._handler);
    }
    return this.steps;
  }

  #onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    this.sensorWorking = true;
    const mag = Math.hypot(a.x, a.y, a.z);
    // Low-pass filter to smooth sensor noise, and a slow baseline to track gravity.
    this._filtered = this._filtered * 0.75 + mag * 0.25;
    this._baseline = this._baseline * 0.98 + mag * 0.02;
    const delta = this._filtered - this._baseline;
    const now = performance.now();
    if (!this._rising && delta > 1.2) {
      this._rising = true;
      // People don't take more than ~3.5 steps a second.
      if (now - this._lastStep > 280) {
        this.steps++;
        this._lastStep = now;
      }
    } else if (this._rising && delta < 0.3) {
      this._rising = false;
    }
  }

  /** Final step count: sensor count if it worked, otherwise an estimate. */
  result(distanceM, strideM = DEFAULT_STRIDE_M) {
    if (this.sensorWorking && this.steps > 0) return { steps: this.steps, estimated: false };
    return { steps: Math.round(distanceM / strideM), estimated: true };
  }
}
