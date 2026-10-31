# Walker 🚶

A simple GPS walk tracker for **Android**, with accounts, cloud backup, friends and shareable routes.

- **Start / End walk**: press Start when you set off and End when you finish.
- **Tracks with the screen off**: lock your phone and put it in your pocket. GPS and the step counter keep running, and a "Walker is recording your walk" notification shows while they do.
- **Live map**: your route is drawn as a line from start to finish on an OpenStreetMap map.
- **Stats**: time, distance (from GPS), average speed in km/h, and steps (from the phone's step sensor).
- **History**: every walk is saved with its map and stats, plus running totals.
- **Accounts and backup**: sign in and your history is backed up and synced. Sign in on a new phone and your walks are there. Renames and deletes sync too.
- **Friends**: add friends by username. When you share a route with friends, it appears in their **Routes** tab.
- **Follow a route**: follow any past walk or a friend's route. A direction arrow shows which way to head, along with the distance left, % complete and an off-route warning.
- **Share links**: send any route as a link. It opens the route in the Walker app, or on the web if the person doesn't have the app. GPX import and export are also supported.

---

## One-time setup (about 15 minutes)

Do these in order. Everything is done on github.com and supabase.com, and works from a phone browser.

### 1. Add the app signing key (so updates install over the old version)

In this repo: **Settings → Secrets and variables → Actions → Secrets tab → New repository secret**. Add two secrets:

| Name | Value |
|---|---|
| `WALKER_KEYSTORE_BASE64` | the long text from the `WALKER_KEYSTORE_BASE64.txt` file you were given |
| `WALKER_KEYSTORE_PASSWORD` | the text from `WALKER_KEYSTORE_PASSWORD.txt` |

Keep a copy of both somewhere safe, such as a password manager. Every version of the app has to be signed with this same key: if it's lost, the next update can only be installed by uninstalling the app first. Your walks are safe in your account either way.

> To make your own key instead:
> `keytool -genkeypair -keystore walker.keystore -alias walker -keyalg RSA -keysize 2048 -validity 10000`, then `base64 -w0 walker.keystore`.

### 2. Create the accounts backend (Supabase, free)

1. Sign up at [supabase.com](https://supabase.com) and create a **New project**. Any name and region will do, and the free plan is plenty.
2. Open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and press **Run**. This creates the tables and the security rules that keep each person's walks private.
3. Go to **Authentication → URL Configuration** and set **Site URL** to `https://kaddakaman.github.io/Walker/`. Email confirmation links then land on the Walker web page.
   - *Optional:* to skip the "confirm your email" step, turn off **Confirm email** under **Authentication → Sign In / Providers → Email**.
4. Go to **Project Settings → API Keys** and copy your **Project URL** and **publishable key** (shown as the `anon` `public` key on older projects).
5. Back in this GitHub repo: **Settings → Secrets and variables → Actions → Variables tab → New repository variable**. Add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | the Project URL, e.g. `https://abcdxyz.supabase.co` |
| `SUPABASE_ANON_KEY` | the publishable / anon key |

The publishable key is designed to sit inside apps. The database rules decide what each signed-in person can see.

### 3. Turn on the web page that share links open

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

### 4. Build

**Actions → Android app → Run workflow**, then **Actions → Web app → Run workflow**. After that, every push rebuilds both.

---

## Installing on your phone

1. On your Android phone, open this repo's **Releases** and pick **Latest Android build** (or go to `https://github.com/kaddakaman/Walker/releases/tag/android-latest`). Tap **Walker.apk**.
2. Android will ask to allow installs from your browser. Allow it, then tap **Install**.
3. Open Walker and allow:
   - **Location → While using the app**: needed for GPS.
   - **Notifications → Allow**: this shows the "recording your walk" notification, which is what keeps tracking going with the screen off.
   - **Physical activity → Allow**: needed for the step counter.
4. **Recommended:** go to **Settings → Apps → Walker → Battery** and choose **Unrestricted** (sometimes called "Don't optimise"). Some phones, especially Samsung, Xiaomi, OnePlus and Huawei, otherwise stop background apps after a while.

To update, install the newer `Walker.apk` from the same page. Your walks stay on the phone.

## Using it

- **Walk tab**: tap **Start walk**. You can lock the phone. Tap **End walk** when you're done.
- **History**: tap a walk to see its map, **Follow this route**, **Share**, **Export GPX**, rename it (✎) or delete it.
- **Share**: choose **Share with my friends** (it appears in their Routes tab) or **Send a link** (works for anyone). **Stop sharing** removes it again.
- **Routes**: "From friends" lists your friends' shared routes. "Saved routes" holds routes you've saved from links or GPX files. **Add from link** accepts a pasted link.
- **Me**: sign in or create an account, back up now, add friends by username and accept requests, and set your stride length (only used when a phone has no step sensor).

Accounts are optional: without signing in, everything works on the phone alone, and share links carry the route inside the link itself.

---

## How it works

| Part | Where | Notes |
|---|---|---|
| Android app | `android/`, `capacitor.config.json` | [Capacitor](https://capacitorjs.com) wraps the web app in a native Android app. |
| Background GPS | `src/js/platform.js` | [`@capacitor-community/background-geolocation`](https://github.com/capacitor-community/background-geolocation) runs a foreground location service, so tracking continues with the screen off. |
| Steps | `android/.../WalkerSensorsPlugin.java`, `src/js/steps.js` | A small native plugin reads Android's hardware step counter, which also counts with the screen off. In a browser it falls back to the accelerometer, then to distance ÷ stride. |
| GPS filtering | `src/js/tracker.js` | Ignores fixes worse than ±35 m, jitter smaller than the GPS error, and jumps faster than ~32 km/h. |
| Distance / speed / route following | `src/js/geo.js` | Haversine distance. Route following snaps you to the nearest route segment, looking ahead first so out-and-back routes work. |
| Accounts, friends, shared routes | `src/js/cloud.js`, `supabase/schema.sql` | Supabase (Postgres + Auth). Row-level security: only you can read your walks; a route is visible to friends only if you shared it with friends; a link opens exactly one route. |
| Sync | `src/js/sync.js` | The phone keeps working offline. Syncing merges by "most recently changed wins", and deletions are synced too. |
| Share links | `src/js/share.js` | `https://kaddakaman.github.io/Walker/#route=<id>`. On Android the web page offers **Open in the Walker app** (`walker://route/<id>`). |
| Web version | `.github/workflows/pages.yml` | The same app on GitHub Pages. It works in any browser, but there it only tracks with the screen on. |
| APK builds | `.github/workflows/android.yml` | Runs the tests, builds and signs the APK, and publishes it to the `android-latest` release. |

## Developing

```bash
npm install
npm test                 # unit tests
npm start                # build + serve the web version on http://localhost:8080
npm run android:apk      # build an APK locally (needs the Android SDK and JDK 21)
```

To build with accounts locally, create a `.env` file (it's git-ignored):

```
SUPABASE_URL=https://abcdxyz.supabase.co
SUPABASE_ANON_KEY=your-publishable-key
```

## Limitations

- Android only. An iPhone version would need a Mac with Xcode and an Apple Developer account.
- Some phone makers' battery savers can still stop background tracking. Set Walker's battery usage to **Unrestricted** (see above).
- Map tiles come from OpenStreetMap's free servers, which are fine for personal use. For heavy use, switch `TILE_URL` in `src/js/app.js` to a commercial tile provider.
