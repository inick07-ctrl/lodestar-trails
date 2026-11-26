# ✦ Lodestar — off-grid trail maps

A mobile-first, installable PWA for hiking and offroad (GX) trips that keeps working with no signal.
No accounts, no tracking, no backend — everything is stored on your device (IndexedDB + Cache API).

## Features
- **Map styles:** Lodestar vector map (OpenFreeMap / OpenMapTiles, OSM data) with hillshade from AWS Terrain Tiles, USGS Topo, USGS satellite imagery (all cacheable offline), plus OpenTopoMap (online only).
- **Hike / GX Offroad modes:** hiking highlights footpaths and trails colored by `sac_scale`; offroad highlights `highway=track`, unpaved roads and `4wd_only` routes colored by `tracktype` / `smoothness` / surface.
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

## Data & credits
Map data © OpenStreetMap contributors (ODbL). Vector tiles: OpenFreeMap / OpenMapTiles. USGS The National Map (public domain). AWS Terrain Tiles. OpenTopoMap (CC-BY-SA). Nominatim search. MapLibre GL JS (BSD-3).
Not affiliated with AllTrails or onX.
