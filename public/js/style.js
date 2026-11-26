// Lodestar's own map style on OpenFreeMap vector tiles (OpenMapTiles schema, © OpenStreetMap contributors).
import { DEM_URL } from './geo.js';
export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];
export const GLYPH_RANGES = ['0-255', '256-511', '8192-8447'];
export const RASTERS = {
  topo: { name: 'USGS Topo', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', maxzoom: 16, offline: true, attr: 'USGS The National Map', bytes: 18000 },
  sat: { name: 'Satellite (USGS)', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', maxzoom: 16, offline: true, attr: 'USGS The National Map: Orthoimagery', bytes: 30000 },
  sathyb: { name: 'Satellite + labels', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}', maxzoom: 16, offline: true, attr: 'USGS The National Map', bytes: 32000 },
  otm: { name: 'OpenTopoMap', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', maxzoom: 17, offline: false, attr: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors', bytes: 30000 },
};

const P = {
  light: { bg: '#efece3', water: '#a8cde4', wood: '#cddfbd', grass: '#e1e9cf', wet: '#d3e3d6', farm: '#ece8d6', park: '#d4e6c1', res: '#e8e3d9', bld: '#ddd5c8', road: '#ffffff', roadCase: '#cbc3b5', major: '#fbe6b6', majorCase: '#d9b978', track: '#9c7a52', path: '#86765f', rail: '#a49d94', label: '#3a3833', halo: 'rgba(255,255,255,0.9)', waterLabel: '#4f7d9c', boundary: '#b7a7c3', shade: 0.35 },
  dark: { bg: '#1b1e1c', water: '#20394a', wood: '#22311f', grass: '#252c22', wet: '#213029', farm: '#23251f', park: '#223322', res: '#262623', bld: '#2f2f2b', road: '#45463f', roadCase: '#1b1c19', major: '#6a5b3a', majorCase: '#2a251a', track: '#a88a62', path: '#9a8b74', rail: '#5c5a55', label: '#e2ded5', halo: 'rgba(0,0,0,0.85)', waterLabel: '#86b2cf', boundary: '#6d607a', shade: 0.5 },
};

export function buildStyle({ dark = false, base = 'trail' } = {}) {
  const c = P[dark ? 'dark' : 'light'];
  const vis = v => ({ visibility: v ? 'visible' : 'none' });
  const vec = base === 'trail';
  const name = ['coalesce', ['get', 'name:en'], ['get', 'name']];
  const L = [];
  L.push({ id: 'bg', type: 'background', paint: { 'background-color': c.bg } });
  const v = (o) => { o.layout = { ...(o.layout || {}), ...vis(vec) }; o.metadata = { vec: true }; L.push(o); };
  v({ id: 'landcover-farm', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['farmland']]], paint: { 'fill-color': c.farm } });
  v({ id: 'landuse-res', type: 'fill', source: 'ofm', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial', 'retail']]], paint: { 'fill-color': c.res, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 13, 1] } });
  v({ id: 'landcover-grass', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'meadow', 'scrub']]], paint: { 'fill-color': c.grass } });
  v({ id: 'park', type: 'fill', source: 'ofm', 'source-layer': 'park', paint: { 'fill-color': c.park, 'fill-opacity': 0.6 } });
  v({ id: 'landcover-wood', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': c.wood } });
  v({ id: 'landcover-wet', type: 'fill', source: 'ofm', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wetland'], paint: { 'fill-color': c.wet } });
  v({ id: 'park-outline', type: 'line', source: 'ofm', 'source-layer': 'park', minzoom: 9, paint: { 'line-color': dark ? '#3f6a3a' : '#8cb376', 'line-width': 1, 'line-dasharray': [3, 2], 'line-opacity': 0.7 } });
  L.push({ id: 'hillshade', type: 'hillshade', source: 'dem', layout: vis(vec), metadata: { vec: true }, paint: { 'hillshade-exaggeration': c.shade, 'hillshade-shadow-color': dark ? '#000' : '#5a5040', 'hillshade-highlight-color': dark ? '#333' : '#fff', 'hillshade-accent-color': dark ? '#000' : '#5a5040' } });
  v({ id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway', paint: { 'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, ['match', ['get', 'class'], 'river', 4, 1.5]] } });
  v({ id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': c.water } });
  v({ id: 'building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': c.bld, 'fill-outline-color': c.roadCase } });
  v({ id: 'boundary', type: 'line', source: 'ofm', 'source-layer': 'boundary', filter: ['<=', ['get', 'admin_level'], 6], paint: { 'line-color': c.boundary, 'line-width': 1, 'line-dasharray': [4, 2] } });
  const roadW = (cls, a, b) => ['interpolate', ['exponential', 1.5], ['zoom'], 6, a, 18, b];
  const isMajor = ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]];
  const isMinor = ['in', ['get', 'class'], ['literal', ['tertiary', 'minor', 'service']]];
  v({ id: 'road-minor-case', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 12, filter: isMinor, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.roadCase, 'line-width': roadW(0, 0.5, 16) } });
  v({ id: 'road-major-case', type: 'line', source: 'ofm', 'source-layer': 'transportation', filter: isMajor, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.majorCase, 'line-width': roadW(0, 1, 24) } });
  v({ id: 'road-track', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 12, filter: ['==', ['get', 'class'], 'track'], paint: { 'line-color': c.track, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 17, 3], 'line-dasharray': [3, 1.5] } });
  v({ id: 'road-path', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 13, filter: ['==', ['get', 'class'], 'path'], paint: { 'line-color': c.path, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 17, 2], 'line-dasharray': [1.5, 1.5] } });
  v({ id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 10, filter: isMinor, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.road, 'line-width': roadW(0, 0.3, 13) } });
  v({ id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation', filter: isMajor, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.major, 'line-width': roadW(0, 0.6, 20) } });
  v({ id: 'rail', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 11, filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': c.rail, 'line-width': 1, 'line-dasharray': [4, 3] } });
  // raster bases
  for (const k of Object.keys(RASTERS)) L.push({ id: 'base-' + k, type: 'raster', source: k, layout: vis(base === k), paint: { 'raster-fade-duration': 150 } });
  const lbl = { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.4 };
  L.push({ id: 'water-name', type: 'symbol', source: 'ofm', 'source-layer': 'water_name', metadata: { vec: true }, layout: { ...vis(vec), 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 12 }, paint: { ...lbl, 'text-color': c.waterLabel } });
  L.push({ id: 'road-name', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 13, metadata: { vec: true }, layout: { ...vis(vec), 'symbol-placement': 'line', 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 11 }, paint: lbl });
  L.push({ id: 'peak', type: 'symbol', source: 'ofm', 'source-layer': 'mountain_peak', minzoom: 11, metadata: { vec: true }, layout: { ...vis(vec), 'text-field': ['concat', '▲ ', name], 'text-font': ['Noto Sans Regular'], 'text-size': 11 }, paint: lbl });
  L.push({ id: 'place', type: 'symbol', source: 'ofm', 'source-layer': 'place', metadata: { vec: true }, filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'hamlet']]], layout: { ...vis(vec), 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'city', 16, 'town', 14, 'village', 12, 11] }, paint: lbl });
  const sources = {
    ofm: { type: 'vector', url: OFM_TILEJSON, attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' },
    dem: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 12, attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">AWS Terrain Tiles</a>' },
  };
  for (const [k, r] of Object.entries(RASTERS)) sources[k] = { type: 'raster', tiles: [r.url], tileSize: 256, maxzoom: r.maxzoom, attribution: r.attr };
  return { version: 8, name: 'Lodestar', glyphs: GLYPHS, sources, layers: L };
}
