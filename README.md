# Walker 🚶

A simple GPS walk tracker that runs in your phone's browser and can be installed to your home screen like an app.

- **Start / End walk**: press Start when you set off and End when you finish.
- **Live map**: your route is drawn as a green line from start to finish on an OpenStreetMap map.
- **Stats**: time, distance (from GPS), average speed in km/h, and step count.
- **History**: every walk is saved with its map, stats and date, plus running totals.
- **Follow a route**: pick any past walk (or a route a friend shared) and the app guides you along it, with a direction arrow, the distance left, % complete and an off-route warning.
- **Share routes**: send a link that opens the route in a friend's Walker app, ready to follow. You can also export and import **GPX** files, which work with Strava, Garmin, Komoot, Google Earth and others.

No account, server or API key is needed. Your data stays on your device.

## Using it

1. Open the app and allow location access (and motion access on iPhone, for the step counter).
2. Press **Start walk**. Keep the app open while walking (see the notes below).
3. Press **End walk**. The walk is saved and opens with its full route and stats.
4. In **History**, tap a walk to **Follow this route**, **Share**, **Export GPX**, rename it (✎) or delete it.
5. Routes that friends send you appear in **Routes**. Opening a share link asks whether to save and follow the route. You can also **Import GPX file** there.

When you follow a route, a dashed blue line shows it on the map. Before you start, the banner points you to the route's start. While walking, it shows which way to head, how far is left and how far through you are, and turns orange if you stray more than 30 m from the route.

## Running it

It's a static web app (HTML/CSS/JavaScript, no build step). Browsers only allow GPS on **HTTPS** pages (or `localhost`), so host it somewhere with HTTPS. The easiest option is **GitHub Pages**: repo **Settings → Pages → Deploy from a branch**, then pick the branch and the `/ (root)` folder. Open the URL on your phone and use **Add to Home Screen**.

Locally:

```bash
npm start      # serves on http://localhost:8080
npm test       # unit tests for distance, route-following and share-link logic
```

## How it works

| Part | File | Notes |
|---|---|---|
| GPS tracking | `js/tracker.js` | `watchPosition` with high accuracy. It ignores fixes worse than ±35 m, moves smaller than GPS jitter, and jumps faster than ~32 km/h, so standing still doesn't add distance. |
| Distance / speed | `js/geo.js` | Haversine distance between accepted points. Average speed = distance ÷ (end − start). |
| Steps | `js/steps.js` | Counts footfall peaks from the accelerometer. If the device has no motion sensor (e.g. a desktop), steps are estimated from distance ÷ 0.75 m stride and shown with `≈`. |
| Route guidance | `js/geo.js` `locateOnRoute` | Snaps you to the nearest route segment, looking ahead first so out-and-back or looping routes work, and points you at a spot ~35 m further along. |
| Sharing | `js/share.js` | The route is simplified and packed into the link as an encoded polyline, so no server is needed. GPX import and export are included. |
| Storage | `js/storage.js` | `localStorage` on the device. An unfinished walk is restored if the page is reloaded. |
| Offline | `sw.js` | Caches the app and recently viewed map tiles. |

## Limitations to know about

- **Keep the screen on.** Web apps can't track GPS in the background, so the app keeps the screen awake during a walk where the browser supports it. If you lock the phone, tracking pauses until you return, and you'll get a straight line across that gap.
- History is stored per device and per browser. Clearing site data deletes it, so export GPX files for walks you want to keep.
- Map tiles come from OpenStreetMap's free tile servers, which are fine for personal use. For heavy use, switch `TILE_URL` in `js/app.js` to a commercial tile provider.
