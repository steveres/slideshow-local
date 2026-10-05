/* Folder slideshow: images + videos, cross-fade, optional location map.
 * Sections: types/constants, settings, folder access, GPS readers, map, player, UI wiring. */

// ───────────────────────── Types & constants ─────────────────────────

type MediaKind = 'image' | 'video';
interface MediaItem { name: string; kind: MediaKind; getFile(): Promise<File>; taken?: string; } // taken: "yyyy-MM-dd HH:mm:ss" from slideshow.json
interface LatLon { lat: number; lon: number; }
interface Settings { duration: number; showMap: boolean; muted: boolean; }
interface Track { name: string; getFile(): Promise<File>; }
interface FolderContents { items: MediaItem[]; tracks: Track[]; }

// Minimal File System Access API typings (Chromium only; not in every lib.dom).
interface FsFileHandle { kind: 'file'; name: string; getFile(): Promise<File>; }
interface FsDirHandle {
  kind: 'directory'; name: string;
  values(): AsyncIterable<FsFileHandle | FsDirHandle>;
  queryPermission(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' }): Promise<PermissionState>;
}
interface PickerWindow { showDirectoryPicker?(o?: { mode: 'read' }): Promise<FsDirHandle>; }

/** Paste your Google Maps API key here (Maps JavaScript API must be enabled for it). */
const GOOGLE_MAPS_API_KEY = 'YOUR_API_KEY_HERE';

const FADE_MS = 1000;        // cross-fade length
const MAP_ZOOM_MS = 800;     // zoom/pan to the new framing
const MAP_SEGMENT_MS = 600;  // draw the line to the new stop and move the marker along it
const FIRST_ZOOM = 10;       // zoom while the route is a single place
const MAP_SPAN = 1.5;        // view is 1.5x the size of the route's bounding box
const MIN_ZOOM = 1, MAX_ZOOM = 17;
const MAX_DURATION = 5;       // seconds per image: 1..5 (speed slider and settings field)
const MAX_PHOTO_ZOOM = 8;     // wheel zoom limit on the photo
const TIMELINE_LABELS = 10;   // date labels along the timeline
const TILE = 256;            // Web Mercator world size in px at zoom 0

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const isMusic = (name: string) => name.toLowerCase().endsWith('.mp3');

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function kindOf(name: string): MediaKind | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
}

// ───────────────────────── Persistent settings ─────────────────────────

const SETTINGS_KEY = 'slideshow.settings.v2'; // bumped so the new default duration applies
const DEFAULTS: Settings = { duration: 2, showMap: true, muted: false };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

// The folder handle can't go in localStorage; IndexedDB can store it.
function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('slideshow', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = op(open.result.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}
const saveDir = (h: FsDirHandle) => idb('readwrite', s => s.put(h, 'dir')).then(() => undefined, () => undefined);
const loadDir = () => idb<FsDirHandle | undefined>('readonly', s => s.get('dir')).catch(() => undefined);

// ───────────────────────── Folder access ─────────────────────────

const byName = (a: MediaItem, b: MediaItem) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Optional file written by prepare.bat: lists the media in date-taken order. */
const CONFIG_NAME = 'slideshow.json';
interface OrderConfig { files?: { name?: unknown; taken?: unknown }[]; }

/** Orders items as listed in slideshow.json; anything unlisted (or no config) goes by filename. */
function applyOrder(items: MediaItem[], configText: string | null): MediaItem[] {
  items.sort(byName);
  if (configText === null) return items;
  try {
    const config = JSON.parse(configText.replace(/^\uFEFF/, '')) as OrderConfig;
    const rank = new Map<string, number>();
    const taken = new Map<string, string>();
    (config.files ?? []).forEach((f, i) => {
      if (typeof f.name !== 'string') return;
      rank.set(f.name, i);
      if (typeof f.taken === 'string') taken.set(f.name, f.taken);
    });
    for (const item of items) item.taken = taken.get(item.name);
    const at = (m: MediaItem) => rank.get(m.name) ?? Infinity;
    return items.sort((a, b) => (at(a) - at(b)) || byName(a, b)); // both unlisted -> NaN -> byName
  } catch (err) {
    console.warn(`Ignoring unreadable ${CONFIG_NAME}:`, err);
    return items;
  }
}

async function itemsFromDir(dir: FsDirHandle): Promise<FolderContents> {
  const items: MediaItem[] = [], tracks: Track[] = [];
  let configText: string | null = null;
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue;
    if (entry.name === CONFIG_NAME) { configText = await (await entry.getFile()).text(); continue; }
    if (isMusic(entry.name)) { tracks.push({ name: entry.name, getFile: () => entry.getFile() }); continue; }
    const kind = kindOf(entry.name);
    if (kind) items.push({ name: entry.name, kind, getFile: () => entry.getFile() });
  }
  return { items: applyOrder(items, configText), tracks };
}

/** Fallback for browsers without a folder picker (Safari, Firefox, mobile). */
async function itemsFromFiles(files: FileList): Promise<FolderContents> {
  const items: MediaItem[] = [], tracks: Track[] = [];
  let configText: string | null = null;
  for (const file of Array.from(files)) {
    const depth = file.webkitRelativePath ? file.webkitRelativePath.split('/').length : 2;
    if (depth !== 2) continue; // top level only
    if (file.name === CONFIG_NAME) { configText = await file.text(); continue; }
    if (isMusic(file.name)) { tracks.push({ name: file.name, getFile: () => Promise.resolve(file) }); continue; }
    const kind = kindOf(file.name);
    if (kind) items.push({ name: file.name, kind, getFile: () => Promise.resolve(file) });
  }
  return { items: applyOrder(items, configText), tracks };
}

// ───────────────────────── GPS readers ─────────────────────────

async function readLocation(file: File, kind: MediaKind): Promise<LatLon | null> {
  try { return kind === 'image' ? await exifGps(file) : await videoGps(file); }
  catch { return null; } // malformed metadata: treat as "no location"
}

/** Reads GPS from a JPEG's EXIF block. Only the file head is read. */
async function exifGps(file: File): Promise<LatLon | null> {
  const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  for (let off = 2; off + 4 <= view.byteLength;) {
    const marker = view.getUint16(off);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    if (marker === 0xffe1 && view.getUint32(off + 4) === 0x45786966 /* "Exif" */) return tiffGps(view, off + 10);
    off += 2 + view.getUint16(off + 2);
  }
  return null;
}

function tiffGps(view: DataView, tiff: number): LatLon | null {
  const le = view.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => view.getUint16(tiff + o, le);
  const u32 = (o: number) => view.getUint32(tiff + o, le);
  const findTag = (ifd: number, tag: number): number | null => {
    for (let i = 0, n = u16(ifd); i < n; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === tag) return entry;
    }
    return null;
  };
  const gpsPtr = findTag(u32(4), 0x8825);
  if (gpsPtr === null) return null;
  const gps = u32(gpsPtr + 8);

  const coord = (refTag: number, valTag: number, negativeRef: string): number | null => {
    const ref = findTag(gps, refTag), val = findTag(gps, valTag);
    if (ref === null || val === null) return null;
    const p = u32(val + 8);
    let deg = 0; // degrees, minutes, seconds as three rationals
    for (let i = 0; i < 3; i++) {
      const den = u32(p + i * 8 + 4);
      if (den) deg += u32(p + i * 8) / den / 60 ** i;
    }
    return String.fromCharCode(view.getUint8(tiff + ref + 8)) === negativeRef ? -deg : deg;
  };
  const lat = coord(1, 2, 'S'), lon = coord(3, 4, 'W');
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** Best effort: phones store an ISO 6709 string like "+37.7749-122.4194" in MP4/MOV metadata. */
async function videoGps(file: File): Promise<LatLon | null> {
  const CHUNK = 1 << 20;
  const parts = [file.slice(0, CHUNK)];
  if (file.size > CHUNK) parts.push(file.slice(Math.max(CHUNK, file.size - CHUNK)));
  const iso6709 = /([+-]\d{2}\.\d{2,})([+-]\d{3}\.\d{2,})/;
  for (const part of parts) {
    const m = iso6709.exec(new TextDecoder('latin1').decode(await part.arrayBuffer()));
    if (m) return { lat: Number(m[1]), lon: Number(m[2]) };
  }
  return null;
}

// ───────────────────────── Map (Google Maps JavaScript API) ─────────────────────────

// Minimal typings for the parts of the Google Maps API used here.
interface GLatLng { lat(): number; lng(): number; }
interface GMapView { center: { lat: number; lng: number }; zoom: number; }
interface GMap {
  moveCamera(o: GMapView): void; // immediate, no built-in animation
  getZoom(): number | undefined;
  getCenter(): GLatLng | undefined;
}
interface GMaps {
  Map: new (el: HTMLElement, opts: GMapView & Record<string, unknown>) => GMap;
  event: { addListener(map: GMap, event: string, fn: () => void): unknown };
  MapTypeControlStyle?: { DROPDOWN_MENU: number };
}
interface GoogleWindow { google?: { maps: GMaps }; __mapsReady?: () => void; gm_authFailure?: () => void; }
const gWindow = window as unknown as GoogleWindow;

let mapsApi: Promise<GMaps> | null = null;

/** Loads Google's script once, on first use. */
function loadGoogleMaps(): Promise<GMaps> {
  mapsApi ??= new Promise<GMaps>((resolve, reject) => {
    if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === 'YOUR_API_KEY_HERE') {
      reject(new Error('No Google Maps API key set. Add it to GOOGLE_MAPS_API_KEY.'));
      return;
    }
    gWindow.__mapsReady = () => {
      const maps = gWindow.google?.maps;
      if (maps) resolve(maps); else reject(new Error('Google Maps did not start.'));
    };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&loading=async&callback=__mapsReady`;
    script.onerror = () => {
      script.remove();
      mapsApi = null; // allow a retry next time a map is due
      reject(new Error('Google Maps could not be loaded. Check the internet connection.'));
    };
    document.head.append(script);
  });
  return mapsApi;
}

interface Point { x: number; y: number; }

/** Lat/lon -> Web Mercator world coordinates in 0..1 (same projection Google uses). */
function project(p: LatLon): Point {
  const rad = clamp(p.lat, -85, 85) * Math.PI / 180;
  return { x: (p.lon + 180) / 360, y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 };
}
function unproject(p: Point): LatLon {
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * p.y))) * 180 / Math.PI, lon: p.x * 360 - 180 };
}

interface Camera { centre: Point; zoom: number; }
/** What the overlay shows: dots on the first `dotCount` stops; line and marker positions as
 *  (fractional) indexes along the route. */
interface OverlayState { dotCount: number; lineTo: number; markerAt: number; }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

/** The always-visible map panel: route so far (dots + line) with a marker on the current photo. */
class MapView {
  private canvas = $<HTMLElement>('#map .gmap');
  private marker = $<HTMLElement>('#map .pin.next');
  private notice = $<HTMLElement>('#map .notice');
  private overlay = document.querySelector<SVGSVGElement>('#map .path')!;
  private line = document.querySelector<SVGPolylineElement>('#map .path polyline')!;
  private dots = document.querySelector<SVGGElement>('#map .path .dots')!;
  private gmap: GMap | null = null;
  private authFailed = false;
  private renderId = 0;                     // bumping this cancels any running animation
  private animating = false;
  private applying = false;                 // inside our own moveCamera call
  private pts: Point[] = [];                // route currently drawn (world coordinates)
  private cam: Camera | null = null;        // camera the overlay is drawn for
  private state: OverlayState | null = null;
  private userZoom: number | null = null;   // set once the user zooms (buttons or wheel)
  private w = 0;
  private h = 0;

  constructor(readonly root: HTMLElement) {
    // Google calls this global when the key is invalid, restricted or unbilled.
    gWindow.gm_authFailure = () => {
      this.authFailed = true;
      this.unavailable('Google rejected the API key. Check the key, its restrictions and billing.');
    };
  }

  /**
   * Shows the route; its last entry is the photo now on screen.
   * The camera glides from where it is to the new framing. With `grow` (a step forward onto a
   * located photo) the line is then drawn to the new stop with the marker travelling along it.
   */
  async update(path: readonly LatLon[], grow: boolean): Promise<void> {
    if (!path.length) { this.clearOverlay(); return; }
    const pts = path.map(project), last = pts.length - 1;
    const hadRoute = this.pts.length > 0;
    this.pts = pts;
    if (!this.measure()) return;
    const id = ++this.renderId;
    const live = () => id === this.renderId;

    try {
      const maps = await loadGoogleMaps();
      if (this.authFailed || !live()) return;
      const final = this.target(pts);
      const from = this.cam;
      this.ensureMap(maps, final);
      this.notice.hidden = true;
      this.canvas.hidden = false;
      this.overlay.toggleAttribute('hidden', false);

      if (!from || !hadRoute) { // nothing to animate from
        this.animating = false;
        this.setCamera(final);
        this.draw(pts, last, last, last);
        return;
      }

      this.animating = true;
      const growing = grow && last > 0;
      const held = growing ? last - 1 : last; // while the camera moves, the marker stays on this stop
      this.draw(pts, held, held, held);

      const moved = Math.abs(from.zoom - final.zoom) > 0.01 || Math.hypot(from.centre.x - final.centre.x, from.centre.y - final.centre.y) * TILE * 2 ** final.zoom > 1;
      if (moved) {
        await this.tween(MAP_ZOOM_MS, live, t => {
          const e = ease(t);
          this.setCamera({
            centre: { x: lerp(from.centre.x, final.centre.x, e), y: lerp(from.centre.y, final.centre.y, e) },
            zoom: lerp(from.zoom, final.zoom, e),
          });
          this.draw(pts, held, held, held);
        });
        if (!live()) return;
      }
      if (growing) {
        // The marker rides the tip of the line and leaves a dot behind.
        await this.tween(MAP_SEGMENT_MS, live, t => {
          const head = last - 1 + ease(t);
          this.draw(pts, last, head, head);
        });
        if (!live()) return;
      }
      this.draw(pts, last, last, last);
      this.animating = false;
    } catch (err) {
      this.unavailable((err as Error).message);
    }
  }

  /** Redraws the current route in its finished state (after a resize or the panel reappearing). */
  refresh(): void {
    if (!this.gmap || !this.pts.length || !this.measure()) return;
    this.renderId++;
    this.animating = false;
    const last = this.pts.length - 1;
    this.setCamera(this.target(this.pts));
    this.draw(this.pts, last, last, last);
  }

  /** Empties the route and returns to automatic zoom (restart or new folder). */
  reset(): void {
    this.clearOverlay();
    this.userZoom = null;
  }

  /** Message shown in place of the map when Google Maps can't be used. */
  unavailable(reason: string): void {
    this.renderId++;
    this.animating = false;
    this.canvas.hidden = true;
    this.marker.hidden = true;
    this.overlay.toggleAttribute('hidden', true);
    this.notice.textContent = reason;
    this.notice.hidden = false;
  }

  private clearOverlay(): void {
    this.renderId++;
    this.animating = false;
    this.pts = [];
    this.state = null;
    this.line.setAttribute('points', '');
    this.dots.replaceChildren();
    this.marker.hidden = true;
  }

  private ensureMap(maps: GMaps, initial: Camera): void {
    if (this.gmap) return;
    this.cam = initial;
    const c = unproject(initial.centre);
    const gmap = this.gmap = new maps.Map(this.canvas, {
      center: { lat: c.lat, lng: c.lon }, zoom: initial.zoom, isFractionalZoomEnabled: true,
      disableDefaultUI: true, zoomControl: true,
      // Layers control: a dropdown, since the panel is narrow
      mapTypeControl: true,
      mapTypeControlOptions: {
        mapTypeIds: ['roadmap', 'terrain', 'satellite', 'hybrid'],
        style: maps.MapTypeControlStyle?.DROPDOWN_MENU ?? 2,
      },
      gestureHandling: 'greedy', // drag to pan, wheel or buttons to zoom
      keyboardShortcuts: false, clickableIcons: false,
    });
    maps.event.addListener(gmap, 'zoom_changed', () => this.onGoogleCamera());
    maps.event.addListener(gmap, 'center_changed', () => this.onGoogleCamera());
  }

  /** Google's camera changed. If it wasn't us (zoom buttons, wheel, dragging), follow it; a user zoom locks the zoom level. */
  private onGoogleCamera(): void {
    if (this.animating || !this.gmap || !this.cam) return;
    const gc = this.gmap.getCenter(), gz = this.gmap.getZoom();
    if (!gc || gz === undefined) return;
    const centre = project({ lat: gc.lat(), lon: gc.lng() });
    const dz = Math.abs(gz - this.cam.zoom);
    const dpx = Math.hypot(centre.x - this.cam.centre.x, centre.y - this.cam.centre.y) * TILE * 2 ** gz;
    if (dz < 1e-6 && dpx < 0.5) return;   // echo of our own setCamera
    if (!this.applying && dz > 1e-6) this.userZoom = gz; // changed by the user (buttons or wheel): lock it
    this.cam = { centre, zoom: gz };
    if (this.state) this.draw(this.pts, this.state.dotCount, this.state.lineTo, this.state.markerAt);
  }

  /** Where the camera should end up: fit the route, or (after a user zoom) their zoom centred on the current photo. */
  private target(pts: Point[]): Camera {
    return this.userZoom !== null ? { centre: pts[pts.length - 1], zoom: this.userZoom } : this.frame(pts);
  }

  /** Records the panel size; false if the panel is hidden. */
  private measure(): boolean {
    this.w = this.root.clientWidth;
    this.h = this.root.clientHeight;
    return this.w > 0 && this.h > 0;
  }

  /** Camera that fits all points with MAP_SPAN breathing room; a single place gets the fixed zoom. */
  private frame(pts: Point[]): Camera {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    if (maxX - minX < 1e-9 && maxY - minY < 1e-9) return { centre, zoom: FIRST_ZOOM };
    const zoom = Math.min(Math.log2(this.w / (TILE * MAP_SPAN * (maxX - minX))), Math.log2(this.h / (TILE * MAP_SPAN * (maxY - minY))));
    return { centre, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) };
  }

  private setCamera(cam: Camera): void {
    this.cam = cam; // set first so the change event is recognised as ours
    const c = unproject(cam.centre);
    this.applying = true;
    try { this.gmap?.moveCamera({ center: { lat: c.lat, lng: c.lon }, zoom: cam.zoom }); }
    finally { this.applying = false; }
  }

  /** Draws the overlay for the current camera. */
  private draw(pts: Point[], dotCount: number, lineTo: number, markerAt: number): void {
    const cam = this.cam;
    if (!cam) return;
    this.state = { dotCount, lineTo, markerAt };
    const scale = TILE * 2 ** cam.zoom;
    const screen = pts.map(p => ({ x: this.w / 2 + (p.x - cam.centre.x) * scale, y: this.h / 2 + (p.y - cam.centre.y) * scale }));
    const along = (pos: number): Point => {
      const i = Math.min(Math.floor(pos), screen.length - 1), j = Math.min(i + 1, screen.length - 1), f = pos - i;
      return { x: lerp(screen[i].x, screen[j].x, f), y: lerp(screen[i].y, screen[j].y, f) };
    };

    const linePts = screen.slice(0, Math.floor(lineTo) + 1);
    if (lineTo > Math.floor(lineTo)) linePts.push(along(lineTo));
    this.line.setAttribute('points', linePts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));

    while (this.dots.childElementCount < dotCount) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '5');
      this.dots.append(dot);
    }
    while (this.dots.childElementCount > dotCount) this.dots.lastElementChild?.remove();
    Array.from(this.dots.children).forEach((dot, i) => {
      dot.setAttribute('cx', screen[i].x.toFixed(1));
      dot.setAttribute('cy', screen[i].y.toFixed(1));
    });

    const m = along(markerAt);
    this.marker.style.left = `${m.x}px`;
    this.marker.style.top = `${m.y}px`;
    this.marker.hidden = false;
  }

  /** Calls step(t) every frame with t going 0..1 over `ms`; stops early if cancelled. */
  private tween(ms: number, live: () => boolean, step: (t: number) => void): Promise<void> {
    return new Promise(resolve => {
      const start = performance.now();
      const frame = (now: number) => {
        if (!live()) { resolve(); return; }
        const t = clamp((now - start) / ms, 0, 1);
        step(t);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
  }
}

// ───────────────────────── Player ─────────────────────────

class Slideshow {
  /** Called whenever play/pause state changes, so the UI can update its button. */
  onState: (playing: boolean) => void = () => {};
  /** Called when a new item has been put on screen. */
  onShow: () => void = () => {};
  /** Called when the current position changes. */
  onIndex: (index: number) => void = () => {};

  private items: MediaItem[] = [];
  private locs: (LatLon | null | undefined)[] = []; // per item; undefined = not read yet
  private index = 0;
  private generation = 0;            // bumping this abandons any navigation still loading
  private playing = true;
  private scrubbing = false;         // timeline is being dragged: no map updates, no auto-advance
  private timer: number | undefined; // pending auto-advance
  private shownAt = 0;               // when the current image's display time started
  private video: HTMLVideoElement | null = null; // current item, if it is a video
  private front = 0;                 // which layer is currently visible
  private urls: (string | null)[] = [null, null];

  constructor(private layers: HTMLElement[], private map: MapView, private settings: Settings) {}

  start(items: MediaItem[]): void {
    this.items = items;
    this.locs = [];
    this.setPlaying(true);
    this.restart();
  }

  restart(): void {
    this.scrubbing = false;
    this.map.reset();
    void this.go(0, true);
  }

  stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.scrubbing = false;
    this.items = [];
    this.video = null;
    this.map.reset();
    this.layers.forEach((layer, i) => { layer.classList.remove('visible'); this.clearLayer(i); });
  }

  next(): void { if (this.items.length) void this.go((this.index + 1) % this.items.length, true); }
  previous(): void { if (this.index > 0) void this.go(this.index - 1, false); }
  toggle(): void { this.setPlaying(!this.playing); }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.onState(playing);
    if (playing) {
      this.shownAt = performance.now();
      this.schedule();
    } else {
      clearTimeout(this.timer);
      this.video?.pause();
    }
  }

  /** The image or video element currently on screen. */
  currentMedia(): HTMLElement | null { return this.layers[this.front].firstElementChild as HTMLElement | null; }

  /** Timeline drag: flip straight to item i, leaving the map alone until the drag ends. */
  scrubTo(i: number): void {
    this.scrubbing = true;
    if (i !== this.index && i >= 0 && i < this.items.length) void this.go(i, false);
  }

  /** Timeline released: bring the map up to date and carry on from here. */
  async endScrub(): Promise<void> {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    const gen = this.generation, upTo = this.index;
    // The route needs the location of every item up to here, including ones jumped over.
    const missing = Array.from({ length: upTo + 1 }, (_, i) => i).filter(i => this.locs[i] === undefined);
    for (let k = 0; k < missing.length; k += 8) {
      await Promise.all(missing.slice(k, k + 8).map(async i => {
        const item = this.items[i];
        try { this.locs[i] = await readLocation(await item.getFile(), item.kind); } catch { this.locs[i] = null; }
      }));
      if (gen !== this.generation || this.scrubbing) return; // moved on meanwhile
    }
    this.updateMap(false);
    this.shownAt = performance.now();
    this.schedule();
  }

  /** Re-arms the auto-advance after the duration setting changed. */
  retime(): void { this.schedule(); }

  /** Brings the map in line with the current item (e.g. after the panel was switched on). */
  syncMap(): void { this.updateMap(false); }

  /** Shows item i. `forward` is false when stepping back. */
  private async go(i: number, forward: boolean): Promise<void> {
    const gen = ++this.generation;
    const live = () => gen === this.generation;
    clearTimeout(this.timer);
    this.index = i;
    this.onIndex(i);
    const item = this.items[i];
    try {
      const file = await item.getFile();
      if (this.locs[i] === undefined) this.locs[i] = await readLocation(file, item.kind);
      if (!live() || !(await this.present(file, item.kind, live))) return;
      if (this.scrubbing) return; // endScrub() takes it from here
      this.updateMap(forward && !!this.locs[i]);
      this.shownAt = performance.now();
      this.schedule();
    } catch (err) {
      console.warn(`Skipping ${item.name}:`, err);
      if (!live()) return;
      // Step over the unplayable file in the direction of travel (delay avoids a hot loop).
      this.timer = window.setTimeout(() => (forward ? this.next() : this.previous()), 250);
    }
  }

  /** The route is the located items from the first up to the current one. */
  private updateMap(grow: boolean): void {
    if (!this.settings.showMap || !this.items.length) return;
    const path = this.locs.slice(0, this.index + 1).filter((l): l is LatLon => !!l);
    void this.map.update(path, grow);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.playing || this.scrubbing || !this.items.length) return;
    if (this.video) { void this.video.play().catch(() => undefined); return; } // advances when it ends
    const remaining = Math.max(0, this.settings.duration * 1000 - (performance.now() - this.shownAt));
    this.timer = window.setTimeout(() => this.next(), remaining);
  }

  /** Loads the file into the hidden layer, then cross-fades to it. False if superseded meanwhile. */
  private async present(file: File, kind: MediaKind, live: () => boolean): Promise<boolean> {
    const url = URL.createObjectURL(file);
    let el: HTMLElement;
    let video: HTMLVideoElement | null = null;
    try {
      if (kind === 'image') {
        const img = new Image();
        img.alt = '';
        img.src = url;
        await img.decode();
        el = img;
      } else {
        video = document.createElement('video');
        const v = video;
        v.muted = true;           // required for autoplay
        v.playsInline = true;
        v.src = url;
        await new Promise<void>((resolve, reject) => {
          v.onloadeddata = () => resolve();
          v.onerror = () => reject(new Error('unsupported video'));
        });
        v.onended = v.onerror = () => { if (this.video === v && this.playing) this.next(); };
        el = v;
      }
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    if (!live()) { URL.revokeObjectURL(url); return false; }

    const backIdx = 1 - this.front, oldIdx = this.front;
    this.clearLayer(backIdx);
    this.layers[backIdx].replaceChildren(el);
    this.urls[backIdx] = url;
    this.layers[backIdx].classList.add('visible');
    this.layers[oldIdx].classList.remove('visible');
    this.front = backIdx;
    this.video = video; // schedule() starts playback if we're playing
    this.onShow();

    // Free the outgoing media once it has faded, unless the layer was reused meanwhile.
    const oldUrl = this.urls[oldIdx];
    setTimeout(() => { if (this.urls[oldIdx] === oldUrl && this.front !== oldIdx) this.clearLayer(oldIdx); }, FADE_MS);
    return true;
  }

  private clearLayer(i: number): void {
    this.layers[i].querySelector('video')?.pause();
    this.layers[i].replaceChildren();
    const url = this.urls[i];
    if (url) URL.revokeObjectURL(url);
    this.urls[i] = null;
  }
}

// ───────────────────────── Photo zoom ─────────────────────────

/** Wheel-zoom (towards the cursor) and drag-pan for the photo currently on screen. */
class PhotoZoom {
  private scale = 1;
  private tx = 0;   // translation in px; screen = t + scale * point
  private ty = 0;
  private drag: { x: number; y: number } | null = null;

  constructor(private frame: HTMLElement, private media: () => HTMLElement | null, private onZoomIn: () => void) {
    frame.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    frame.addEventListener('dblclick', e => { if (!this.onControls(e)) this.reset(); });
    frame.addEventListener('pointerdown', e => {
      if (this.scale === 1 || e.button !== 0 || this.onControls(e)) return;
      e.preventDefault(); // stop the browser's own image drag
      this.drag = { x: e.clientX - this.tx, y: e.clientY - this.ty };
      frame.setPointerCapture(e.pointerId);
    });
    frame.addEventListener('pointermove', e => {
      if (!this.drag) return;
      this.tx = e.clientX - this.drag.x;
      this.ty = e.clientY - this.drag.y;
      this.apply();
    });
    const endDrag = () => { this.drag = null; };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);
  }

  reset(): void {
    this.scale = 1;
    this.tx = this.ty = 0;
    this.drag = null;
    this.apply();
  }

  private onControls(e: Event): boolean {
    return e.target instanceof Element && e.target.closest('#controls, #timeline') !== null;
  }

  private onWheel(e: WheelEvent): void {
    if (this.onControls(e)) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // some browsers report lines, not pixels
    const next = clamp(this.scale * Math.exp(-delta * 0.0015), 1, MAX_PHOTO_ZOOM);
    if (next === this.scale) return;
    if (this.scale === 1) this.onZoomIn();
    // Keep the point under the cursor fixed while the scale changes.
    const rect = this.frame.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    this.tx = cx - (cx - this.tx) * next / this.scale;
    this.ty = cy - (cy - this.ty) * next / this.scale;
    this.scale = next;
    this.apply();
  }

  private apply(): void {
    const w = this.frame.clientWidth, h = this.frame.clientHeight;
    this.tx = clamp(this.tx, w - w * this.scale, 0); // never pull the frame's edge into view
    this.ty = clamp(this.ty, h - h * this.scale, 0);
    const el = this.media();
    if (el) {
      el.style.transformOrigin = '0 0';
      el.style.transform = this.scale === 1 ? '' : `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    }
    this.frame.classList.toggle('zoomed', this.scale > 1);
  }
}

// ───────────────────────── Timeline ─────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-04 09:31:05" -> "Jul 04, 2026". Done by hand to avoid time-zone shifts. */
function formatDate(taken: string | undefined): string | null {
  const m = taken ? /^(\d{4})-(\d{2})-(\d{2})/.exec(taken) : null;
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${m[3]}, ${m[1]}` : null;
}

/** Vertical scrubber down the left of the photo frame: drag to move through the set. */
class Timeline {
  private rail = $<HTMLElement>('#timeline .rail');
  private thumb = $<HTMLElement>('#timeline .thumb');
  private labels = $<HTMLElement>('#timeline .labels');
  private items: MediaItem[] = [];
  private index = 0;
  private dragging = false;

  /** onScrub fires for each new position while dragging; onRelease once when the drag ends. */
  constructor(private root: HTMLElement, private onScrub: (index: number) => void, private onRelease: () => void) {
    const rail = this.rail;
    rail.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      rail.focus();
      rail.setPointerCapture(e.pointerId);
      this.dragging = true;
      root.classList.add('dragging');
      this.scrubAt(e.clientY);
    });
    rail.addEventListener('pointermove', e => { if (this.dragging) this.scrubAt(e.clientY); });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      root.classList.remove('dragging');
      this.onRelease();
    };
    rail.addEventListener('pointerup', end);
    rail.addEventListener('pointercancel', end);
    rail.addEventListener('keydown', e => {
      const last = this.items.length - 1;
      const to = e.key === 'ArrowUp' ? this.index - 1 : e.key === 'ArrowDown' ? this.index + 1
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
      if (to === null) return;
      e.preventDefault();
      this.scrub(clamp(to, 0, last));
      this.onRelease();
    });
  }

  setItems(items: MediaItem[]): void {
    this.items = items;
    this.root.hidden = items.length < 2;
    const last = items.length - 1;
    this.rail.setAttribute('aria-valuemin', '1');
    this.rail.setAttribute('aria-valuemax', String(items.length));
    // First and last items, plus the rest spread evenly between them.
    const count = Math.min(TIMELINE_LABELS, items.length);
    this.labels.replaceChildren(...Array.from({ length: count }, (_, k) => {
      const i = count > 1 ? Math.round(k * last / (count - 1)) : 0;
      const label = document.createElement('span');
      label.textContent = this.describe(i);
      label.style.top = `${count > 1 ? k / (count - 1) * 100 : 0}%`;
      return label;
    }));
    this.setIndex(0);
  }

  /** Moves the elevator to match the item on screen. */
  setIndex(i: number): void {
    this.index = i;
    const last = this.items.length - 1;
    this.thumb.style.top = `${last > 0 ? i / last * 100 : 0}%`;
    this.rail.setAttribute('aria-valuenow', String(i + 1));
    this.rail.setAttribute('aria-valuetext', this.describe(i));
  }

  private describe(i: number): string {
    return formatDate(this.items[i]?.taken) ?? `#${i + 1}`; // no date known: fall back to position
  }

  private scrubAt(clientY: number): void {
    const rect = this.rail.getBoundingClientRect();
    const frac = clamp((clientY - rect.top) / rect.height, 0, 1);
    this.scrub(Math.round(frac * (this.items.length - 1)));
  }

  private scrub(i: number): void {
    if (i === this.index) return;
    this.setIndex(i);
    this.onScrub(i);
  }
}

// ───────────────────────── Music ─────────────────────────

/** Plays the folder's MP3s back to back in random order, never the same one twice in a row. */
class MusicPlayer {
  private audio = new Audio();
  private tracks: Track[] = [];
  private current = -1;
  private url: string | null = null;
  private failures = 0;      // consecutive unplayable tracks
  private session = 0;       // bumping this abandons a track still loading
  private waitingForGesture = false;

  constructor() {
    this.audio.onended = () => void this.playRandom();
    this.audio.onerror = () => { if (this.url) void this.trackFailed(); };
  }

  start(tracks: Track[]): void {
    this.stop();
    this.tracks = tracks;
    this.failures = 0;
    if (tracks.length) void this.playRandom();
  }

  stop(): void {
    this.session++;
    this.audio.pause();
    this.release();
    this.tracks = [];
    this.current = -1;
  }

  setMuted(muted: boolean): void { this.audio.muted = muted; }

  private async playRandom(): Promise<void> {
    const session = ++this.session;
    const n = this.tracks.length;
    if (!n) return;
    // With more than one track, pick among the others.
    const pick = this.current < 0 ? Math.floor(Math.random() * n)
      : n === 1 ? 0 : (this.current + 1 + Math.floor(Math.random() * (n - 1))) % n;
    this.current = pick;
    try {
      const file = await this.tracks[pick].getFile();
      if (session !== this.session) return;
      this.release();
      this.url = URL.createObjectURL(file);
      this.audio.src = this.url;
      await this.audio.play();
      this.failures = 0;
    } catch (err) {
      if (session !== this.session) return;
      if ((err as DOMException).name === 'NotAllowedError') this.playOnGesture(); // browser wants a click first
      else void this.trackFailed();
    }
  }

  private async trackFailed(): Promise<void> {
    console.warn(`Could not play ${this.tracks[this.current]?.name}`);
    if (++this.failures >= this.tracks.length) return; // nothing playable; give up quietly
    await sleep(250);
    void this.playRandom();
  }

  /** Browsers block sound until the user interacts with the page; start on the first click or key. */
  private playOnGesture(): void {
    if (this.waitingForGesture) return;
    this.waitingForGesture = true;
    const session = this.session;
    const resume = () => {
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      this.waitingForGesture = false;
      if (session === this.session) void this.audio.play().catch(() => undefined);
    };
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
  }

  private release(): void {
    if (this.url) {
      const url = this.url;
      this.url = null; // cleared first so the resulting error event isn't treated as a bad track
      this.audio.removeAttribute('src');
      this.audio.load();
      URL.revokeObjectURL(url);
    }
  }
}

// ───────────────────────── UI wiring ─────────────────────────

async function main(): Promise<void> {
  document.documentElement.style.setProperty('--fade', `${FADE_MS}ms`);

  const settings = loadSettings();
  const map = new MapView($('#map'));
  const show = new Slideshow(Array.from(document.querySelectorAll<HTMLElement>('.layer')), map, settings);
  const applyMapVisibility = () => { document.body.classList.toggle('no-map', !settings.showMap); show.syncMap(); };
  applyMapVisibility();
  const photoZoom = new PhotoZoom($('#photos'), () => show.currentMedia(), () => show.setPlaying(false)); // zooming in pauses
  show.onShow = () => photoZoom.reset();
  const photos = $('#photos');
  const timeline = new Timeline($('#timeline'),
    i => { photos.classList.add('scrubbing'); show.scrubTo(i); },      // flip without cross-fade
    () => { photos.classList.remove('scrubbing'); void show.endScrub(); });
  show.onIndex = i => timeline.setIndex(i);
  window.addEventListener('resize', () => { map.refresh(); photoZoom.reset(); });
  const picker = window as unknown as PickerWindow;

  const startEl = $('#start'), startMsg = $('#start-msg');
  const resumeBtn = $<HTMLButtonElement>('#resume'), pickBtn = $<HTMLButtonElement>('#pick');
  const fallback = $<HTMLInputElement>('#fallback');
  const gear = $<HTMLButtonElement>('#gear'), panel = $('#panel');
  const duration = $<HTMLInputElement>('#duration'), showMap = $<HTMLInputElement>('#show-map');
  const music = new MusicPlayer(), muteBtn = $<HTMLButtonElement>('#mute');
  const playBtn = $<HTMLButtonElement>('#play'), speed = $<HTMLInputElement>('#speed'), speedOut = $('#speed-out');

  // Start screen
  const begin = ({ items, tracks }: FolderContents) => {
    if (!items.length) {
      startMsg.textContent = 'No images or videos found in that folder. Choose another one.';
      startEl.hidden = false;
      return;
    }
    startEl.hidden = true;
    muteBtn.hidden = tracks.length === 0;
    music.start(tracks);
    timeline.setItems(items);
    show.start(items);
  };
  const openDir = async (dir: FsDirHandle) => begin(await itemsFromDir(dir));

  pickBtn.onclick = async () => {
    if (!picker.showDirectoryPicker) { fallback.click(); return; }
    try {
      const dir = await picker.showDirectoryPicker({ mode: 'read' });
      await saveDir(dir);
      await openDir(dir);
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') startMsg.textContent = `Could not open that folder: ${(err as Error).message}`;
    }
  };
  fallback.onchange = async () => { if (fallback.files) begin(await itemsFromFiles(fallback.files)); };

  // Settings panel
  showMap.checked = settings.showMap;

  // Duration has two controls (settings field and speed slider); keep them in step.
  const setDuration = (seconds: number) => {
    settings.duration = clamp(Math.round(seconds) || DEFAULTS.duration, 1, MAX_DURATION);
    duration.value = String(settings.duration);
    speed.value = String(MAX_DURATION + 1 - settings.duration); // right = faster
    speedOut.textContent = `${settings.duration}s`;
    saveSettings(settings);
    show.retime();
  };
  setDuration(settings.duration);
  duration.onchange = () => setDuration(Number(duration.value));
  speed.oninput = () => setDuration(MAX_DURATION + 1 - Number(speed.value));

  // Music
  let slideshowPlaying = true; // music is silent while the slideshow is paused, or when muted
  const applyMuted = () => {
    music.setMuted(settings.muted || !slideshowPlaying);
    muteBtn.setAttribute('aria-label', settings.muted ? 'Unmute music' : 'Mute music');
    muteBtn.querySelector('.icon-sound')?.toggleAttribute('hidden', settings.muted);
    muteBtn.querySelector('.icon-muted')?.toggleAttribute('hidden', !settings.muted);
  };
  applyMuted();
  muteBtn.onclick = () => { settings.muted = !settings.muted; saveSettings(settings); applyMuted(); };

  // Control bar
  show.onState = playing => {
    slideshowPlaying = playing;
    applyMuted();
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.querySelector('.icon-pause')?.toggleAttribute('hidden', !playing);
    playBtn.querySelector('.icon-play')?.toggleAttribute('hidden', playing);
  };
  playBtn.onclick = () => show.toggle();
  $('#prev').onclick = () => show.previous();
  $('#next').onclick = () => show.next();
  document.addEventListener('keydown', e => {
    if (!startEl.hidden || e.target instanceof HTMLInputElement) return;
    if (e.key === 'ArrowLeft') show.previous();
    else if (e.key === 'ArrowRight') show.next();
    else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); show.toggle(); }
  });

  const togglePanel = (open: boolean) => { panel.hidden = !open; gear.setAttribute('aria-expanded', String(open)); };
  gear.onclick = () => togglePanel(panel.hidden !== false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanel(false); });

  showMap.onchange = () => { settings.showMap = showMap.checked; saveSettings(settings); applyMapVisibility(); };

  $('#restart').onclick = () => { togglePanel(false); if (startEl.hidden) show.restart(); };
  $('#change').onclick = () => {
    togglePanel(false);
    show.stop();
    music.stop();
    resumeBtn.hidden = true;
    startMsg.textContent = 'Choose the folder that holds your photos and videos.';
    startEl.hidden = false;
  };

  // Remembered folder: start straight away if the browser still grants access,
  // otherwise one click re-grants it (browsers require a click for that).
  const saved = picker.showDirectoryPicker ? await loadDir() : undefined;
  if (!saved) return;
  if (await saved.queryPermission({ mode: 'read' }) === 'granted') { await openDir(saved); return; }
  resumeBtn.textContent = `Resume "${saved.name}"`;
  resumeBtn.hidden = false;
  pickBtn.classList.remove('primary');
  pickBtn.textContent = 'Choose a different folder';
  resumeBtn.onclick = async () => {
    if (await saved.requestPermission({ mode: 'read' }) === 'granted') await openDir(saved);
  };
}

void main();
