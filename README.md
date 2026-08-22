# 🧭 Waypoint — Job Hunt Map

**Version:** 1.1.1
**License:** MIT
**Status:** Personal / hobby project
**Live app:** [job-tracker-azure-five.vercel.app](https://job-tracker-azure-five.vercel.app/)

Waypoint is an offline-first, map-based tracker for your job hunt. Instead of a
spreadsheet, you drop pins for your **Home** and every **interview / company**
you're dealing with, see them all laid out on a real map, and get quick
directions and distance/time estimates between them — all stored privately on
your own device.

It's built as an installable web app (PWA), so it works like a native app on
your phone or laptop, works offline once loaded, and needs no account by
default.

---

## Table of contents

- [Try it live](#try-it-live)
- [Features](#features)
- [Getting started](#getting-started)
- [Using the app](#using-the-app)
- [Searching for places](#searching-for-places)
- [Data & privacy](#data--privacy)
- [Optional: cloud sync backend](#optional-cloud-sync-backend)
- [Project structure](#project-structure)
- [Tech stack](#tech-stack)
- [Versioning](#versioning)
- [Roadmap ideas](#roadmap-ideas)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Try it live

No installation needed — you can use Waypoint straight from your browser here:

👉 **[job-tracker-azure-five.vercel.app](https://job-tracker-azure-five.vercel.app/)**

From there you can also install it as a PWA (look for "Install app" / "Add to
Home Screen" in your browser's menu) so it behaves like a native app.

---

## Features

- 📍 **Home + unlimited interview/company pins** — every waypoint is either your
  "Home" base or an "Interview / Company" pin, with a name, coordinates, and a
  free-text note (recruiter contact, salary discussed, parking info, etc.).
- 🔍 **Place search** — search for any address, city, or landmark by name from
  the home screen, or while adding/editing a waypoint, instead of hunting for
  it on the map or typing raw coordinates.
- 🗺️ **Interactive map** — powered by Leaflet, with long-press-to-drop-a-pin
  support and offline tile caching so previously viewed areas keep working
  without a connection.
- 🧭 **Directions & live navigation** — one tap for distance/duration from Home
  to any waypoint, plus a live "walking compass" style navigation mode that
  tracks your position and heading in real time.
- ✈️ **Live flight overlay** *(optional, off by default)* — toggle a live
  aircraft layer powered by the free airplanes.live API, ported from a
  companion project called Skylight.
- 💾 **Local-first storage** — everything is saved in the browser's IndexedDB
  on your device. No account, no server required to use the core app.
- 📤 **Backup & restore** — export all your waypoints to a `.json` file at any
  time, and import/merge a backup back in.
- 🌗 **Light/dark theme**, with automatic time-of-day switching.
- 📱 **Installable PWA** — add it to your home screen and it behaves like a
  native app, including offline support via a service worker.
- ☁️ **Optional cloud sync** — an opt-in Supabase backend (email/password auth
  + Postgres) can be configured for cross-device sync. Fully optional; see
  [Optional: cloud sync backend](#optional-cloud-sync-backend).

---

## Getting started

Waypoint is a static site — there's no build step required to run it locally.

1. **Clone or download** this repository.
2. **Serve the folder** with any static file server (opening `index.html`
   directly via `file://` will work for basic use, but a local server is
   recommended so the service worker and map tiles behave correctly), e.g.:
   ```bash
   npx serve .
   # or
   python3 -m http.server 8080
   ```
3. Open the served URL in your browser (e.g. `http://localhost:8080`).
4. Optional: use your browser's "Install app" / "Add to Home Screen" option to
   install it as a PWA.

No API keys or accounts are required for the core (offline, on-device)
experience. Cloud sync is opt-in — see below.

---

## Using the app

1. Tap the **+** button to add a waypoint.
2. Choose whether it's your **Home** or an **Interview / Company** pin.
3. Fill in a name, and set the location by either:
   - **Searching for the place by name** (see [Searching for places](#searching-for-places)), or
   - Long-pressing the map to drop a pin, or
   - Typing latitude/longitude directly.
4. Add an optional note, then save.
5. Tap any pin to view its details, get directions from Home, edit it, or
   delete it.
6. Use the **manage** (pencil) icon in the top bar to see and edit all your
   waypoints in a list.
7. Use the **settings** (gear) icon to export/import a backup, clear the
   offline tile cache, or delete everything.

---

## Searching for places

Version 1.1.0 adds a search button so you don't have to eyeball the map or
type coordinates by hand:

- **Home screen search** — tap the magnifying-glass icon in the top bar, type
  a place name (address, city, landmark, company name, etc.), and tap a
  result to jump the map straight there.
- **Search while adding a waypoint** — inside the "Add a waypoint" form,
  there's a search field above the coordinate inputs. Search for a place and
  tap a result to auto-fill the latitude/longitude (and the name field, if
  you haven't typed one yet).

Search results come from the free [Nominatim](https://nominatim.org/)
geocoding API (OpenStreetMap data) and require an internet connection. This
is the only feature in the app that needs to be online — everything else
works offline once the map tiles for an area have been viewed.

---

## Data & privacy

- By default, **all data lives only in your browser's IndexedDB**, on your
  device. There is no server, no account, and nothing is transmitted, unless
  you explicitly set up the optional Supabase sync backend.
- **Place search** sends your search text to the OpenStreetMap Nominatim API
  to look up coordinates. Nothing else about your waypoints is sent anywhere
  by default.
- **Directions/routing** sends the two coordinates being routed between to a
  routing service (OSRM) to compute the path, distance, and duration.
- **Live flight overlay**, if enabled, polls the public airplanes.live API on
  a timer; it does not send any of your data, only requests aircraft near
  your current map view.
- Use **Export** in Settings to keep your own backups; there is no
  automatic cloud backup unless you configure sync.

---

## Optional: cloud sync backend

If you want your waypoints to sync across multiple devices, Waypoint supports
an opt-in [Supabase](https://supabase.com) backend (free tier is generally
sufficient for personal use):

- `supabase-config.js` — where your Supabase project URL and public anon key
  are configured.
- `schema.sql` — the database schema, including Row Level Security so each
  signed-in user can only ever see their own data.
- `auth.js` — email + password authentication gate.
- `sync.js` — syncs local IndexedDB waypoints with the remote database.
- `safe-import.js` — validates backup files before merging them in, so a
  corrupted or malformed `.json` import can't wipe or corrupt existing data.

Full step-by-step setup instructions are in
[`BACKEND-SETUP.md`](./BACKEND-SETUP.md). This is entirely optional — the app
is fully usable, offline and private, without ever touching this.

---

## Project structure

```
.
├── index.html            # App shell, all screens/overlays (markup only)
├── styles.css             # All styling, themes, layout
├── app.js                  # Core app logic: map, waypoints, IndexedDB, search, UI wiring
├── flights.js              # Optional live aircraft overlay (airplanes.live)
├── auth.js                 # Optional Supabase email/password auth gate
├── sync.js                 # Optional cross-device sync with Supabase
├── supabase-config.js      # Optional Supabase project URL/key config
├── safe-import.js          # Validates backup files before importing
├── schema.sql               # Supabase/Postgres schema for optional sync
├── BACKEND-SETUP.md         # Step-by-step guide for the optional sync backend
├── manifest.json            # PWA manifest (name, icons, version)
├── sw.js                     # Service worker for offline support
├── CHANGELOG.md              # Version history
└── LICENSE                    # MIT license
```

---

## Tech stack

- Vanilla JavaScript (no framework, no build step)
- [Leaflet.js](https://leafletjs.com/) for the interactive map
- [OpenStreetMap](https://www.openstreetmap.org/) tiles
- [Nominatim](https://nominatim.org/) for place search (geocoding)
- [OSRM](http://project-osrm.org/) for turn-by-turn distance/duration
- [airplanes.live](https://airplanes.live/) public API for the optional flight overlay
- Browser **IndexedDB** for local storage
- **Service Worker** + Web App Manifest for offline/PWA support
- Optional: [Supabase](https://supabase.com) (Postgres + Auth) for cross-device sync

---

## Versioning

Waypoint follows [Semantic Versioning](https://semver.org/)
(`MAJOR.MINOR.PATCH`). The current version is shown at the bottom of the
**Backup & storage** settings screen inside the app, and is tracked in:

- `app.js` — the `APP_VERSION` constant
- `manifest.json` — the `version` field
- [`CHANGELOG.md`](./CHANGELOG.md) — full history of what changed in each release

When you make changes, please bump the version in both `app.js` and
`manifest.json`, and add an entry to `CHANGELOG.md`.

---

## Roadmap ideas

- [ ] Filter/search within your own saved waypoints, not just external places
- [ ] Tagging/status per waypoint (e.g. "Applied", "Interviewing", "Offer")
- [ ] Reminders/notifications for upcoming interviews
- [ ] Multiple "home" bases (e.g. for relocation job hunts)

Contributions and suggestions are welcome — feel free to open an issue or PR.

---

## Disclaimer

Waypoint is an independent, personal/hobby project provided **"as is"**,
without warranty of any kind, express or implied. By using this app you
acknowledge and agree that:

- **Map, geocoding, routing, and flight data are provided by third-party
  services** (OpenStreetMap, Nominatim, OSRM, airplanes.live) and may be
  inaccurate, incomplete, delayed, or temporarily unavailable. This project
  is not affiliated with or endorsed by any of those services.
- **Distances, durations, and directions are estimates only.** Always verify
  addresses, routes, and travel times yourself before relying on them —
  especially when timing matters, such as getting to an interview.
- **You are responsible for your own data.** While Waypoint stores data
  locally on your device (and, optionally, in a sync backend you configure
  yourself), you are responsible for keeping your own backups via the
  Export feature. The maintainers are not responsible for data loss.
- **No professional advice.** Nothing in this app constitutes travel, legal,
  employment, or safety advice.
- To the fullest extent permitted by law, the author(s) and contributors of
  this project are **not liable** for any direct, indirect, incidental, or
  consequential damages, missed appointments, or losses arising from the use
  or inability to use this application.

If you enable the optional cloud sync backend, you are also responsible for
securing your own Supabase project and complying with its terms of service.

---

## License

Released under the [MIT License](./LICENSE).
