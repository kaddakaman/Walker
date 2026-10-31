// Everything that differs between the Android app and the plain web version.
// In the Android app we use native plugins (background GPS, hardware step
// counter, share sheet); in a browser we fall back to web APIs.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

export const isNative = Capacitor.isNativePlatform();
export const isAndroidBrowser = !isNative && /Android/i.test(navigator.userAgent);

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');
// Our own small native plugin: android/app/src/main/java/.../WalkerSensorsPlugin.java
const WalkerSensors = registerPlugin('WalkerSensors');

// ---------------------------------------------------------------- location

/**
 * Start receiving location fixes. Returns a function that stops them.
 * With `background: true` the Android app keeps tracking with the screen off
 * (a "Walker is recording your walk" notification is shown while it does).
 */
export async function watchLocation(onFix, onError, { background = false } = {}) {
  if (isNative) {
    const options = { requestPermissions: true, stale: false, distanceFilter: 0 };
    if (background) {
      options.backgroundTitle = 'Walker is recording your walk';
      options.backgroundMessage = 'GPS keeps tracking with the screen off. Tap to open.';
    }
    const id = await BackgroundGeolocation.addWatcher(options, (loc, err) => {
      if (err) {
        onError?.(
          err.code === 'NOT_AUTHORIZED'
            ? { code: 1, message: 'Location permission denied. Allow location access in Settings.' }
            : { code: 2, message: err.message || 'Location unavailable.' }
        );
        return;
      }
      if (!loc) return;
      onFix({
        lat: loc.latitude,
        lng: loc.longitude,
        acc: Math.round(loc.accuracy ?? 99),
        t: loc.time || Date.now(),
        heading: loc.bearing,
        speed: loc.speed,
      });
    });
    return () => BackgroundGeolocation.removeWatcher({ id });
  }

  if (!('geolocation' in navigator)) {
    onError?.({ code: 2, message: 'This device does not support GPS location.' });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      onFix({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        acc: Math.round(pos.coords.accuracy),
        t: pos.timestamp,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
      }),
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

export function openAppSettings() {
  if (isNative) BackgroundGeolocation.openSettings();
}

// ---------------------------------------------------------------- permissions & steps

/** Ask for step-counter and notification permissions (Android). Never throws. */
export async function requestWalkPermissions() {
  if (!isNative) return;
  try {
    await WalkerSensors.requestPermissions({ permissions: ['activity', 'notifications'] });
  } catch {
    /* user can still walk without them */
  }
}

export const nativeSteps = {
  async start() {
    try {
      const r = await WalkerSensors.startSteps();
      return Boolean(r.available);
    } catch {
      return false;
    }
  },
  async read() {
    try {
      return (await WalkerSensors.getSteps()).steps || 0;
    } catch {
      return 0;
    }
  },
  async stop() {
    try {
      return (await WalkerSensors.stopSteps()).steps || 0;
    } catch {
      return 0;
    }
  },
};

// ---------------------------------------------------------------- sharing & files

/** Open the share sheet with a link. Returns 'shared' | 'copied' | 'cancelled' | 'prompted'. */
export async function shareLink({ title, text, url }) {
  if (isNative) {
    try {
      await Share.share({ title, text, url, dialogTitle: 'Share route' });
      return 'shared';
    } catch {
      return 'cancelled';
    }
  }
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
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

/** Save/share a text file (GPX). In the app this opens the share sheet. */
export async function saveTextFile(filename, text, type = 'application/gpx+xml') {
  if (isNative) {
    const { uri } = await Filesystem.writeFile({
      path: filename,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: filename, files: [uri], dialogTitle: 'Save or send GPX file' }).catch(() => {});
    return;
  }
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- app lifecycle

/** Called with the URL when the app is opened from a walker:// or share link. */
export async function onOpenUrl(handler) {
  if (!isNative) return;
  App.addListener('appUrlOpen', ({ url }) => handler(url));
  const launch = await App.getLaunchUrl().catch(() => null);
  if (launch?.url) handler(launch.url);
}

/** Android back button. Handler returns true if it handled the press. */
export function onBackButton(handler) {
  if (!isNative) return;
  App.addListener('backButton', () => {
    if (!handler()) App.minimizeApp(); // never quit mid-walk; just go to the background
  });
}
