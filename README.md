# ✦ Lodestar — off-grid trail maps

A mobile-first, installable PWA for hiking and overland/offroad driving trips that keeps working with no signal.
Sign-in is required. Favorites, tracks, waypoints, planned routes, notes and your vehicle sync privately to your account
(Neon Postgres + Vercel serverless functions in `/api`) and are cached on-device (IndexedDB + Cache API) so the app works offline
after you've signed in once. Signing out erases the device copy. There is no email-based password reset: at sign-up (and whenever you reset or regenerate) you get a one-time recovery code, shown once. No analytics, no tracking. Photos stay on the device.

Local dev: `vercel env pull .env.local` (gitignored), then `node tests/dev-server.mjs` and `node tests/test-accounts.mjs`.

## Features
- **Map styles:** Lodestar vector map (OpenFreeMap / OpenMapTiles, OSM data) with hillshade from AWS Terrain Tiles, USGS Topo, USGS satellite imagery (all cacheable offline), plus OpenTopoMap (online only).
- **Hike / Drive modes:** hiking highlights footpaths and trails colored by `sac_scale`; offroad highlights `highway=track`, unpaved roads and `4wd_only` routes colored by `tracktype` / `smoothness` / surface.
- **Discover trails** from OpenStreetMap (Overpass): activity (hike / walk / run / bike / offroad), difficulty, length, and dog / kid / stroller / wheelchair filters where OSM tags allow.
- **Trail pages:** length, elevation profile, estimated time, surface breakdown, nearby POIs (waterfalls, viewpoints, historic sites, water, campsites, shelters, trailheads), directions to the trailhead, favorites, private notes, ratings, conditions, and photos.
- **Offline areas:** pick or draw a box, choose detail, see a tile/size estimate, and download map tiles, terrain and trail data. You can update or delete areas later.
- **GPS:** live position with compass heading, follow mode, and heading-up mode.
- **Record activities:** distance, moving and elapsed time, speed or pace, and elevation gain. Supports pause/resume and crash recovery.
- **Navigate:** follow a trail, a saved route or an activity, with off-route alerts (vibration and voice) and turn cues. You can also plan your own route that snaps to the trail network offline.
- **Waypoints** (camp, water, vehicle, hazard and more). Import and export GPX. Share through the native share sheet as GPX, an image or text. Back up and restore data as JSON.

## Develop
Static site, no build step. Serve `public/`:
```
cd public && python3 -m http.server 8765
```
Tests (Playwright + Chrome): `node tests/test-e2e.mjs online`, then stop the server and run `node tests/test-e2e.mjs offline`.

When you change app files, bump `VERSION` in `public/sw.js` so installed copies update.

## Community trails
- **Create a trail**: Explore › *Create trail* (draw by tapping the map, optional snap-to-paths) or turn any GPS recording into a trail (Record tab or an activity's *Create a trail from this recording*).
- Name, *best for* (Hiking, Biking, Off-road 4WD, Overlanding, ATV/UTV, Horseback, Snowmobile, Trail running, Walking), difficulty, notes, and a vehicle requirement used by Drive mode's *Fits my vehicle*.
- **Private** (only you) or **Shared with the Lodestar community** (every signed-in user). Authors are shown by display name only.
- Only the creator can edit or delete a trail (enforced server-side). Others can follow, save to favorites (kept offline), export GPX, or **Report** it.
- API: `POST /api/trails` (`list`, `get`, `mine`, `create`, `update`, `delete`, `report`). Schema: `db/migrations/003_community_trails.sql` (applied automatically). Deleting an account deletes its trails.
- Moderation (no admin UI yet): reports are stored in `trail_reports`; a trail with 5+ distinct reports is hidden from other users automatically. See the SQL note in the migration file.
- Tests: `node tests/test-trails.mjs` (API) and `node tests/test-trails-ui.mjs` (UI + screenshots) against `tests/dev-server.mjs`.

## Data & credits
Map data © OpenStreetMap contributors (ODbL). Vector tiles: OpenFreeMap / OpenMapTiles. USGS The National Map (public domain). AWS Terrain Tiles. OpenTopoMap (CC-BY-SA). Nominatim search. MapLibre GL JS (BSD-3).
Not affiliated with AllTrails or onX.
