# Changelog

All notable changes to Waypoint are documented in this file.
This project follows [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH).

## [1.1.1] — 2026-08-22
### Added
- 📍 Searched locations now drop a distinct **gold "search pin"** marker on the
  map (with a popup showing the place name), instead of only flying the map
  to that spot with no visual marker.
- Live app link added to `README.md`.

## [1.1.0] — 2026-08-22
### Added
- 🔍 **Place search on the home screen** — a new search button in the top bar opens a
  search sheet. Type any address, city, or landmark and tap a result to fly the map there.
- 🔍 **Place search inside "Add / Edit waypoint"** — search for a place while adding a
  waypoint and its coordinates (and name, if left blank) are filled in automatically,
  instead of having to long-press the map or type latitude/longitude by hand.
- App version number, now shown at the bottom of **Backup & storage** settings.
- In-app disclaimer covering data accuracy and third-party map/routing services.
- `CHANGELOG.md` to track releases going forward.

### Notes
- Search uses the free [Nominatim](https://nominatim.org/) (OpenStreetMap) geocoding API
  and requires an internet connection; it is not part of the offline map cache.

## [1.0.0] — Initial release
- Offline-first map for pinning "Home" and unlimited "Interview / Company" waypoints.
- Local storage via IndexedDB — no account, no server, fully on-device.
- Export / import waypoints as a `.json` backup file.
- Light/dark theme, offline tile caching, "find my location", and directions
  (distance/duration) from Home to any waypoint.
- Optional live flight-tracking overlay.
- Installable as a Progressive Web App (PWA).
