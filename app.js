/* ===================== Waypoint — app.js ===================== */

/* ---------- Tiny IndexedDB wrapper ---------- */
const DB_NAME = 'waypoint-db';
const DB_VERSION = 1;
const STORE = 'waypoints';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('kind', 'kind', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- State ---------- */
let map, markersById = new Map();
let waypoints = [];
let pickMode = null;      // 'form' | null  — waiting for a map tap to fill coords
let editingId = null;     // id currently being edited, or null for a new entry
let pendingKind = null;   // 'home' | 'interview' chosen in step 1
let activeDetailId = null;
let userMarker = null;
let userAccuracyCircle = null;
let watchId = null;
let locateActive = false;
let firstFixHandled = false;
let currentRouteLine = null;
let currentRouteEndpoint = null;

/* Real-time navigation (heading-pointing arrow, auto-follow) */
let navMode = false;
let orientationHandler = null;
let usingAbsoluteOrientation = false;
let orientationRAF = null;
let appliedHeading = 0;      // unwrapped (not mod 360) so rotation always takes the shortest path
let lastNavLatLng = null;    // for GPS-course heading fallback when no compass is available

const $ = (sel) => document.querySelector(sel);
const el = {
  splash: $('#splash'),
  map: $('#map'),
  emptyHint: $('#emptyHint'),
  pickBanner: $('#pickBanner'),
  fab: $('#fabAdd'),
  themeToggle: $('#themeToggle'),
  manageBtn: $('#manageBtn'),
  settingsBtn: $('#settingsBtn'),

  overlayChoice: $('#overlayChoice'),
  cancelChoice: $('#cancelChoice'),

  overlayForm: $('#overlayForm'),
  formTitle: $('#formTitle'),
  formHint: $('#formHint'),
  fName: $('#fName'),
  fLat: $('#fLat'),
  fLng: $('#fLng'),
  fNote: $('#fNote'),
  pickOnMap: $('#pickOnMap'),
  pickBtnLabel: $('#pickBtnLabel'),
  cancelForm: $('#cancelForm'),
  saveForm: $('#saveForm'),

  overlayDetail: $('#overlayDetail'),
  detailKind: $('#detailKind'),
  detailName: $('#detailName'),
  detailCoords: $('#detailCoords'),
  detailNote: $('#detailNote'),
  editDetailBtn: $('#editDetailBtn'),
  closeDetail: $('#closeDetail'),
  deleteDetail: $('#deleteDetail'),
  directionsBtn: $('#directionsBtn'),
  directionsBtnLabel: $('#directionsBtnLabel'),

  overlayManage: $('#overlayManage'),
  manageList: $('#manageList'),
  closeManage: $('#closeManage'),

  overlaySettings: $('#overlaySettings'),
  exportBtn: $('#exportBtn'),
  importBtn: $('#importBtn'),
  importFile: $('#importFile'),
  clearCacheBtn: $('#clearCacheBtn'),
  cacheDesc: $('#cacheDesc'),
  deleteAllBtn: $('#deleteAllBtn'),
  closeSettings: $('#closeSettings'),

  toast: $('#toast'),
  locateBtn: $('#locateBtn'),
  navigateBtn: $('#navigateBtn'),
  cancelRouteBtn: $('#cancelRouteBtn'),
};

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2400);
}

/* ---------- Theme (auto by device time, unless user overrides) ---------- */
const THEME_KEY = 'waypoint-theme';         // manual override, once user taps the toggle
const DAY_START_HOUR = 6;                    // 06:00 -> light
const DAY_END_HOUR = 18;                     // 18:00 -> dark
let themeAutoTimer = null;

function timeBasedTheme() {
  const h = new Date().getHours();
  return (h >= DAY_START_HOUR && h < DAY_END_HOUR) ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0B1220' : '#F6F1E4');
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved);
    return; // user has explicitly chosen — device time no longer drives it
  }
  applyTheme(timeBasedTheme());
  // Re-check every minute so the map flips light/dark right at sunrise/sunset
  // hours without needing a reload, as long as the user hasn't overridden it.
  if (themeAutoTimer) clearInterval(themeAutoTimer);
  themeAutoTimer = setInterval(() => {
    if (localStorage.getItem(THEME_KEY)) { clearInterval(themeAutoTimer); return; }
    applyTheme(timeBasedTheme());
  }, 60000);
}
el.themeToggle.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
  if (themeAutoTimer) { clearInterval(themeAutoTimer); themeAutoTimer = null; }
});

/* ---------- Map setup ---------- */
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    tap: true,
    fadeAnimation: true,
    zoomAnimation: true,
    markerZoomAnimation: true,
    worldCopyJump: true,
  }).setView([20.5937, 78.9629], 5); // default: India-wide view

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    crossOrigin: true,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Try to center on the user if we have no waypoints yet
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (waypoints.length === 0) {
          map.flyTo([pos.coords.latitude, pos.coords.longitude], 13, { duration: 1.4 });
        }
      },
      () => {}, // silently ignore denial
      { timeout: 6000 }
    );
  }

  // Long-press-to-pick on the map
  attachLongPress(map);
}

/* Long-press detection that opens the form pre-filled with the tapped point.
   Uses native Pointer Events directly on the map container instead of Leaflet's
   synthesized mouse events — Leaflet normalizes touch into 'mousedown'/'mouseup'
   map events but never actually fires 'touchstart'/'touchmove'/'touchend' as map
   events, so those listeners silently never ran on real touchscreens. Pointer
   Events give one consistent code path for mouse, touch, and stylus alike. */
function attachLongPress(mapInstance) {
  const container = mapInstance.getContainer();
  const THRESHOLD_MS = 550;
  const MOVE_TOLERANCE_PX = 12;

  let pressTimer = null;
  let startPoint = null;
  let startLatLng = null;
  let activePointerId = null;

  function containerPoint(e) {
    const rect = container.getBoundingClientRect();
    return L.point(e.clientX - rect.left, e.clientY - rect.top);
  }

  function begin(e) {
    if (activePointerId !== null) return;          // one press at a time
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left-click only
    activePointerId = e.pointerId;
    startPoint = containerPoint(e);
    startLatLng = mapInstance.containerPointToLatLng(startPoint);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      handleLongPress(startLatLng);
      reset();
    }, THRESHOLD_MS);
  }

  function reset() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    activePointerId = null;
    startPoint = null;
  }

  function onPointerUpOrCancel(e) {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    reset();
  }

  function onPointerMove(e) {
    if (pressTimer === null || activePointerId === null || e.pointerId !== activePointerId) return;
    const pt = containerPoint(e);
    const dx = pt.x - startPoint.x;
    const dy = pt.y - startPoint.y;
    if (Math.sqrt(dx * dx + dy * dy) > MOVE_TOLERANCE_PX) reset();
  }

  container.addEventListener('pointerdown', begin, { passive: true });
  container.addEventListener('pointerup', onPointerUpOrCancel, { passive: true });
  container.addEventListener('pointercancel', onPointerUpOrCancel, { passive: true });
  container.addEventListener('pointerleave', onPointerUpOrCancel, { passive: true });
  container.addEventListener('pointermove', onPointerMove, { passive: true });

  // Panning or zooming mid-press means the user was navigating the map, not
  // holding still to place a pin — cancel the pending long-press either way.
  mapInstance.on('dragstart zoomstart', reset);

  // Prevent the OS's own long-press context menu / text-selection callout
  // from popping up and swallowing the gesture on Android and iOS.
  container.addEventListener('contextmenu', (e) => e.preventDefault());
}

function handleLongPress(latlng) {
  if (navigator.vibrate) navigator.vibrate(12);
  if (pickMode === 'form') {
    // We're inside the form already waiting to place a point
    fillCoords(latlng);
    exitPickMode();
    openForm({ keepOpen: true });
    return;
  }
  // Otherwise: long-press on the free map starts a brand-new waypoint here
  pendingKind = null;
  openChoiceSheet(latlng);
}

/* ---------- Marker rendering ---------- */
function pinSVG(kind) {
  const color = kind === 'home' ? '#E5484D' : '#3B82F6';
  const inner = kind === 'home'
    ? '<path d="M5 12l7-6 7 6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 11v6h10v-6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<rect x="8" y="8" width="8" height="9" rx="0.6" stroke="#fff" stroke-width="1.5" fill="none"/><path d="M10 11h1M13 11h1M10 14h1M13 14h1" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>';
  return `
  <svg viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 8.5 12 18 12 18s12-9.5 12-18C24 5.4 18.6 0 12 0z" fill="${color}"/>
    <circle cx="12" cy="12" r="8.4" fill="${color}" opacity="0.001"/>
    ${inner}
  </svg>`;
}

function makeIcon(kind) {
  return L.divIcon({
    className: '',
    html: `<div class="pin">${pinSVG(kind)}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

function addMarkerToMap(wp) {
  const marker = L.marker([wp.lat, wp.lng], { icon: makeIcon(wp.kind), riseOnHover: true });
  marker.on('click', () => openDetail(wp.id));
  marker.addTo(map);
  markersById.set(wp.id, marker);
}

function removeMarkerFromMap(id) {
  const m = markersById.get(id);
  if (m) { map.removeLayer(m); markersById.delete(id); }
}

function refreshMarker(wp) {
  removeMarkerFromMap(wp.id);
  addMarkerToMap(wp);
}

function updateEmptyHint() {
  el.emptyHint.style.display = waypoints.length === 0 ? 'block' : 'none';
}

/* ---------- Load / persist ---------- */
async function loadAll() {
  waypoints = await dbAll();
  markersById.forEach((m) => map.removeLayer(m));
  markersById.clear();
  waypoints.forEach(addMarkerToMap);
  updateEmptyHint();
  fitToAllIfNeeded();
}

function fitToAllIfNeeded() {
  if (waypoints.length === 0) return;
  const bounds = L.latLngBounds(waypoints.map((w) => [w.lat, w.lng]));
  map.fitBounds(bounds, { padding: [60, 90], maxZoom: 15, animate: true });
}

/* ---------- Overlays ---------- */
function showOverlay(overlay) { overlay.classList.add('show'); }
function hideOverlay(overlay) { overlay.classList.remove('show'); }

function closeAllOverlays() {
  [el.overlayChoice, el.overlayForm, el.overlayDetail, el.overlayManage, el.overlaySettings]
    .forEach(hideOverlay);
}

/* Clicking the dim backdrop closes the topmost sheet */
document.querySelectorAll('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) hideOverlay(ov); });
});

/* ---------- FAB -> choice sheet ---------- */
el.fab.addEventListener('click', () => {
  el.fab.classList.toggle('open');
  openChoiceSheet(null);
});

function openChoiceSheet(latlng) {
  pendingKind = null;
  el.overlayChoice._latlng = latlng || null;
  showOverlay(el.overlayChoice);
}
el.cancelChoice.addEventListener('click', () => { hideOverlay(el.overlayChoice); el.fab.classList.remove('open'); });

document.querySelectorAll('.choice-card').forEach((card) => {
  card.addEventListener('click', () => {
    pendingKind = card.dataset.kind;
    const latlng = el.overlayChoice._latlng;
    hideOverlay(el.overlayChoice);
    el.fab.classList.remove('open');
    editingId = null;
    openForm({ latlng });
  });
});

/* ---------- Form sheet (add / edit) ---------- */
function openForm({ latlng = null, keepOpen = false } = {}) {
  if (!keepOpen) {
    el.fName.value = '';
    el.fLat.value = latlng ? latlng.lat.toFixed(6) : '';
    el.fLng.value = latlng ? latlng.lng.toFixed(6) : '';
    el.fNote.value = '';
  }
  el.formTitle.textContent = editingId
    ? (pendingKind === 'home' ? 'Edit home' : 'Edit waypoint')
    : (pendingKind === 'home' ? 'Add your home' : 'Add interview / company');
  el.formHint.textContent = editingId
    ? 'Update the details below.'
    : 'Fill in the details, or long-press the map to drop the pin exactly where you need it.';
  showOverlay(el.overlayForm);
}

function fillCoords(latlng) {
  el.fLat.value = latlng.lat.toFixed(6);
  el.fLng.value = latlng.lng.toFixed(6);
}

el.pickOnMap.addEventListener('click', () => {
  if (pickMode === 'form') { exitPickMode(); return; }
  pickMode = 'form';
  el.pickOnMap.classList.add('armed');
  el.pickBtnLabel.textContent = 'Waiting for tap… (tap here to cancel)';
  hideOverlay(el.overlayForm);
  el.pickBanner.classList.add('show');
});

function exitPickMode() {
  pickMode = null;
  el.pickOnMap.classList.remove('armed');
  el.pickBtnLabel.textContent = "Long-press the map to pick this point";
  el.pickBanner.classList.remove('show');
}

// If the user taps the map while in pick mode via a normal (short) click too
function bindMapClickForPickMode() {
  map.on('click', (e) => {
    if (pickMode === 'form') {
      fillCoords(e.latlng);
      exitPickMode();
      openForm({ keepOpen: true });
    }
  });
}

el.cancelForm.addEventListener('click', () => {
  exitPickMode();
  hideOverlay(el.overlayForm);
  editingId = null;
});

el.saveForm.addEventListener('click', async () => {
  const name = el.fName.value.trim();
  const lat = parseFloat(el.fLat.value);
  const lng = parseFloat(el.fLng.value);
  const note = el.fNote.value.trim();

  if (!name) { toast('Please add a name.'); el.fName.focus(); return; }
  if (Number.isNaN(lat) || lat < -90 || lat > 90) { toast('Latitude must be between -90 and 90.'); el.fLat.focus(); return; }
  if (Number.isNaN(lng) || lng < -180 || lng > 180) { toast('Longitude must be between -180 and 180.'); el.fLng.focus(); return; }

  const kind = pendingKind || (editingId ? waypoints.find(w => w.id === editingId)?.kind : 'interview') || 'interview';

  const record = {
    id: editingId || `wp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind, name, lat, lng, note,
    createdAt: editingId ? (waypoints.find(w => w.id === editingId)?.createdAt || Date.now()) : Date.now(),
    updatedAt: Date.now(),
  };

  await dbPut(record);
  const idx = waypoints.findIndex((w) => w.id === record.id);
  if (idx >= 0) waypoints[idx] = record; else waypoints.push(record);
  refreshMarker(record);
  updateEmptyHint();

  const marker = markersById.get(record.id);
  if (marker) marker._icon?.querySelector('.pin')?.classList.add('pulse');

  hideOverlay(el.overlayForm);
  editingId = null;
  toast(idx >= 0 ? 'Waypoint updated' : 'Waypoint added');
  map.flyTo([record.lat, record.lng], Math.max(map.getZoom(), 13), { duration: 1 });
});

/* ---------- Detail sheet ---------- */
function openDetail(id) {
  const wp = waypoints.find((w) => w.id === id);
  if (!wp) return;
  activeDetailId = id;
  el.detailKind.textContent = wp.kind === 'home' ? 'Home' : 'Interview / Company';
  el.detailName.textContent = wp.name;
  el.detailCoords.textContent = `${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`;
  if (wp.note) {
    el.detailNote.textContent = wp.note;
    el.detailNote.classList.remove('empty');
  } else {
    el.detailNote.textContent = 'No note added.';
    el.detailNote.classList.add('empty');
  }
  configureDirectionsButton(wp);
  showOverlay(el.overlayDetail);
  map.flyTo([wp.lat, wp.lng], Math.max(map.getZoom(), 14), { duration: 0.8 });
}

function configureDirectionsButton(wp) {
  const home = waypoints.find((w) => w.kind === 'home');
  if (wp.kind === 'home') {
    el.directionsBtn.style.display = 'none';
  } else {
    el.directionsBtn.style.display = 'flex';
    el.directionsBtn.disabled = false;
    el.directionsBtnLabel.textContent = home ? 'Directions from Home' : 'Set a home location first';
  }
}

el.closeDetail.addEventListener('click', () => hideOverlay(el.overlayDetail));

el.editDetailBtn.addEventListener('click', () => {
  const wp = waypoints.find((w) => w.id === activeDetailId);
  if (!wp) return;
  editingId = wp.id;
  pendingKind = wp.kind;
  el.fName.value = wp.name;
  el.fLat.value = wp.lat;
  el.fLng.value = wp.lng;
  el.fNote.value = wp.note || '';
  hideOverlay(el.overlayDetail);
  openForm({ keepOpen: true });
});

el.deleteDetail.addEventListener('click', async () => {
  if (!activeDetailId) return;
  if (!confirm('Delete this waypoint? This cannot be undone.')) return;
  await dbDelete(activeDetailId);
  waypoints = waypoints.filter((w) => w.id !== activeDetailId);
  removeMarkerFromMap(activeDetailId);
  updateEmptyHint();
  hideOverlay(el.overlayDetail);
  toast('Waypoint deleted');
  activeDetailId = null;
});

/* ---------- Directions from Home (accurate road route, drawn smoothly) ---------- */
el.directionsBtn.addEventListener('click', async () => {
  const wp = waypoints.find((w) => w.id === activeDetailId);
  if (!wp) return;
  const home = waypoints.find((w) => w.kind === 'home');
  if (!home) { toast('Add your home waypoint first, then try again.'); return; }
  if (home.id === wp.id) return;

  el.directionsBtn.disabled = true;
  const prevLabel = el.directionsBtnLabel.textContent;
  el.directionsBtnLabel.textContent = 'Finding route…';

  try {
    const route = await fetchRoute(home, wp);
    hideOverlay(el.overlayDetail);
    drawRoute(route, home, wp);
  } catch (err) {
    console.error(err);
    toast('Could not fetch directions. Check your connection.');
  } finally {
    el.directionsBtn.disabled = false;
    el.directionsBtnLabel.textContent = prevLabel;
  }
});

async function fetchRoute(from, to) {
  // OSRM's public, key-free routing API — real road-following directions.
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) throw new Error('No route found');
  return {
    latlngs: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance: route.distance,   // meters
    duration: route.duration,   // seconds
  };
}

function clearRoute() {
  if (currentRouteLine) { map.removeLayer(currentRouteLine); currentRouteLine = null; }
  if (currentRouteEndpoint) { map.removeLayer(currentRouteEndpoint); currentRouteEndpoint = null; }
  el.cancelRouteBtn.classList.remove('show');
}

el.cancelRouteBtn.addEventListener('click', () => {
  if (!currentRouteLine) return;
  clearRoute();
  toast('Directions cancelled');
});

// Dedicated SVG renderer with generous padding so the route doesn't get
// clipped at its edges when the user zooms or pans right after it's drawn.
const routeRenderer = L.svg({ padding: 2 });

function drawRoute(route, home, destination) {
  clearRoute();

  currentRouteLine = L.polyline(route.latlngs, {
    renderer: routeRenderer,
    color: '#4285F4',
    weight: 5,
    opacity: 0.92,
    lineJoin: 'round',
    lineCap: 'round',
    className: 'route-line',
  }).addTo(map);

  // Small marker at the destination end of the route so it reads like a Google-Maps pin drop.
  currentRouteEndpoint = L.circleMarker([destination.lat, destination.lng], {
    renderer: routeRenderer,
    radius: 7, color: '#fff', weight: 3, fillColor: '#4285F4', fillOpacity: 1,
  }).addTo(map);
  currentRouteLine.on('click', clearRoute);
  currentRouteEndpoint.on('click', clearRoute);

  // Smooth "drawing" animation using pathLength="1": normalizing the path's
  // length to 1 means the dash pattern stays correct no matter how the
  // underlying pixel length changes on zoom/pan redraws — a fixed pixel
  // dasharray would otherwise go stale and make the line look cut off.
  requestAnimationFrame(() => {
    const path = currentRouteLine.getElement ? currentRouteLine.getElement() : currentRouteLine._path;
    if (path) {
      path.setAttribute('pathLength', '1');
      path.style.transition = 'none';
      path.style.strokeDasharray = '1';
      path.style.strokeDashoffset = '1';
      // Force a reflow so the browser registers the starting state before we transition it.
      path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)';
      requestAnimationFrame(() => { path.style.strokeDashoffset = '0'; });
      // Once the draw-in finishes, drop the dash styling entirely so the
      // line is a plain solid stroke — nothing left that could mismatch
      // after further zoom/pan redraws.
      setTimeout(() => {
        path.style.transition = '';
        path.style.strokeDasharray = '';
        path.style.strokeDashoffset = '';
        path.removeAttribute('pathLength');
      }, 1300);
    }
  });

  map.flyToBounds(currentRouteLine.getBounds(), { padding: [70, 100], duration: 1.2, easeLinearity: 0.25 });
  el.cancelRouteBtn.classList.add('show');

  const km = (route.distance / 1000).toFixed(1);
  const mins = Math.round(route.duration / 60);
  const hrs = Math.floor(mins / 60);
  const timeLabel = hrs > 0 ? `${hrs} hr ${mins % 60} min` : `${mins} min`;
  toast(`${destination.name}: ${km} km · about ${timeLabel} from home`);
}

/* ---------- Live user location (Google-Maps-style blue dot) ---------- */
function userDotIcon() {
  return L.divIcon({
    className: 'user-dot-icon',
    html: '<div class="user-dot"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function userNavIcon() {
  return L.divIcon({
    className: 'user-nav-icon',
    html: `<div class="user-nav-wrap"><svg class="user-nav-arrow" viewBox="0 0 24 24"><path d="M12 2L4 21l8-5 8 5z"/></svg></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function currentUserIcon() {
  return navMode ? userNavIcon() : userDotIcon();
}

function upsertUserLocation(pos, { fly = false } = {}) {
  const { latitude, longitude, accuracy } = pos.coords;
  const latlng = [latitude, longitude];

  if (!userMarker) {
    userMarker = L.marker(latlng, { icon: currentUserIcon(), zIndexOffset: 1000, interactive: false }).addTo(map);
  } else {
    // setLatLng triggers Leaflet's internal transform update; the CSS transition
    // on .user-dot-icon / .user-nav-icon animates that transform smoothly instead of jumping.
    userMarker.setLatLng(latlng);
  }

  if (!userAccuracyCircle) {
    userAccuracyCircle = L.circle(latlng, {
      radius: accuracy,
      className: 'user-accuracy-circle',
      color: '#4285F4',
      weight: 1,
      opacity: 0.35,
      fillColor: '#4285F4',
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(map);
  } else {
    userAccuracyCircle.setLatLng(latlng);
    userAccuracyCircle.setRadius(accuracy);
  }

  if (fly) {
    // Pick a sensible zoom: closer if GPS is precise, wider if accuracy is poor.
    const targetZoom = accuracy <= 30 ? 17 : accuracy <= 100 ? 15 : 13;
    map.flyTo(latlng, Math.max(map.getZoom(), targetZoom), { duration: 1.1, easeLinearity: 0.25 });
  }
}

/* Rotate the nav arrow to `targetDeg`, always turning the short way round
   (e.g. 350deg -> 5deg turns forward 15deg, not backward 345deg). */
function updateUserHeading(targetDeg) {
  if (!navMode || !userMarker) return;
  const arrow = userMarker.getElement()?.querySelector('.user-nav-arrow');
  if (!arrow) return;
  const target = ((targetDeg % 360) + 360) % 360;
  let diff = target - (appliedHeading % 360);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  appliedHeading += diff;
  arrow.style.transform = `rotate(${appliedHeading}deg)`;
}

function bearingBetween(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function handleOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === 'number') {
    heading = e.webkitCompassHeading; // iOS Safari: true compass heading, 0 = north
  } else if (usingAbsoluteOrientation && typeof e.alpha === 'number') {
    heading = (360 - e.alpha) % 360; // Android absolute orientation approximation
  }
  if (heading == null || Number.isNaN(heading)) return;
  // Throttle to one update per animation frame — orientation events can fire
  // far faster than the screen repaints.
  if (orientationRAF) return;
  orientationRAF = requestAnimationFrame(() => { updateUserHeading(heading); orientationRAF = null; });
}

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      return (await DeviceOrientationEvent.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return true; // no explicit permission gate on this platform
}

function attachOrientationListener() {
  usingAbsoluteOrientation = 'ondeviceorientationabsolute' in window;
  orientationHandler = handleOrientation;
  window.addEventListener('deviceorientationabsolute', orientationHandler, true);
  window.addEventListener('deviceorientation', orientationHandler, true);
}

function detachOrientationListener() {
  if (!orientationHandler) return;
  window.removeEventListener('deviceorientationabsolute', orientationHandler, true);
  window.removeEventListener('deviceorientation', orientationHandler, true);
  orientationHandler = null;
}

function stopLocating() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  locateActive = false;
  firstFixHandled = false;
  el.locateBtn.classList.remove('active', 'locating');
  stopNavigation();
  if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
  if (userAccuracyCircle) { map.removeLayer(userAccuracyCircle); userAccuracyCircle = null; }
}

function startLocating() {
  if (!navigator.geolocation) { toast('Geolocation isn\'t available on this device.'); return; }
  locateActive = true;
  firstFixHandled = false;
  el.locateBtn.classList.add('locating');

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const isFirstFix = !firstFixHandled;
      firstFixHandled = true;
      upsertUserLocation(pos, { fly: isFirstFix && !navMode });

      if (isFirstFix) {
        el.locateBtn.classList.remove('locating');
        el.locateBtn.classList.add('active');
      }

      if (navMode) {
        const { latitude, longitude, heading } = pos.coords;
        const targetZoom = Math.max(map.getZoom(), 17);
        map.setView([latitude, longitude], targetZoom, { animate: true, duration: 0.6, easeLinearity: 0.3 });
        if (typeof heading === 'number' && !Number.isNaN(heading)) {
          // GPS-reported course over ground — most accurate while actually moving.
          updateUserHeading(heading);
        } else if (lastNavLatLng) {
          // Stationary or no course data: fall back to bearing from the last fix.
          const bearing = bearingBetween(lastNavLatLng[0], lastNavLatLng[1], latitude, longitude);
          updateUserHeading(bearing);
        }
        lastNavLatLng = [latitude, longitude];
      }
    },
    (err) => {
      el.locateBtn.classList.remove('locating', 'active');
      locateActive = false;
      if (err.code === err.PERMISSION_DENIED) {
        toast('Location permission denied.');
      } else {
        toast('Could not get your location.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

el.locateBtn.addEventListener('click', () => {
  if (locateActive) {
    // Second tap while active: just re-center smoothly on the last known fix.
    if (userMarker) {
      map.flyTo(userMarker.getLatLng(), Math.max(map.getZoom(), 16), { duration: 0.9, easeLinearity: 0.25 });
    }
    return;
  }
  startLocating();
});

/* ---------- Real-time navigation toggle ---------- */
async function startNavigation() {
  el.navigateBtn.classList.add('locating');
  const orientationGranted = await requestOrientationPermission();
  navMode = true;
  lastNavLatLng = null;
  appliedHeading = 0;

  if (userMarker) userMarker.setIcon(currentUserIcon());
  if (orientationGranted) attachOrientationListener();

  if (!locateActive) {
    startLocating();
  } else if (userMarker) {
    map.flyTo(userMarker.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.9, easeLinearity: 0.25 });
  }

  el.navigateBtn.classList.remove('locating');
  el.navigateBtn.classList.add('active');
  toast(orientationGranted ? 'Navigation started' : 'Navigation started (compass unavailable — using GPS course)');
}

function stopNavigation() {
  if (!navMode) return;
  navMode = false;
  detachOrientationListener();
  el.navigateBtn.classList.remove('active', 'locating');
  if (userMarker) userMarker.setIcon(currentUserIcon());
}

el.navigateBtn.addEventListener('click', () => {
  if (navMode) {
    stopNavigation();
    toast('Navigation stopped');
  } else {
    startNavigation();
  }
});

/* ---------- Manage (edit list) sheet — top-left button ---------- */
el.manageBtn.addEventListener('click', () => {
  renderManageList();
  showOverlay(el.overlayManage);
});
el.closeManage.addEventListener('click', () => hideOverlay(el.overlayManage));

function renderManageList() {
  el.manageList.innerHTML = '';
  if (waypoints.length === 0) {
    el.manageList.innerHTML = `<li class="manage-empty">No waypoints yet. Add one with the + button.</li>`;
    return;
  }
  const sorted = [...waypoints].sort((a, b) => (a.kind === 'home' ? -1 : 1) - (b.kind === 'home' ? -1 : 1) || a.name.localeCompare(b.name));
  sorted.forEach((wp) => {
    const li = document.createElement('li');
    li.className = 'manage-item';
    li.innerHTML = `
      <span class="dot ${wp.kind}"></span>
      <span class="txt">
        <strong>${escapeHTML(wp.name)}</strong>
        <span>${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)}${wp.note ? ' · has note' : ''}</span>
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.5;flex-shrink:0;"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
    `;
    li.addEventListener('click', () => {
      hideOverlay(el.overlayManage);
      editingId = wp.id;
      pendingKind = wp.kind;
      el.fName.value = wp.name;
      el.fLat.value = wp.lat;
      el.fLng.value = wp.lng;
      el.fNote.value = wp.note || '';
      openForm({ keepOpen: true });
    });
    el.manageList.appendChild(li);
  });
}

function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ---------- Settings: backup / import / cache ---------- */
el.settingsBtn.addEventListener('click', () => {
  updateCacheDesc();
  showOverlay(el.overlaySettings);
});
el.closeSettings.addEventListener('click', () => hideOverlay(el.overlaySettings));

el.exportBtn.addEventListener('click', async () => {
  const data = {
    app: 'waypoint',
    version: 1,
    exportedAt: new Date().toISOString(),
    waypoints,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `waypoint-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Backup exported');
});

el.importBtn.addEventListener('click', () => el.importFile.click());
el.importFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : data.waypoints;
    if (!Array.isArray(items)) throw new Error('bad format');

    let imported = 0;
    for (const raw of items) {
      if (typeof raw.lat !== 'number' || typeof raw.lng !== 'number' || !raw.name) continue;
      const record = {
        id: raw.id || `wp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: raw.kind === 'home' ? 'home' : 'interview',
        name: String(raw.name),
        lat: raw.lat, lng: raw.lng,
        note: raw.note || '',
        createdAt: raw.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await dbPut(record);
      imported++;
    }
    await loadAll();
    toast(`Imported ${imported} waypoint${imported === 1 ? '' : 's'}`);
  } catch (err) {
    console.error(err);
    toast('Could not read that file.');
  } finally {
    el.importFile.value = '';
    hideOverlay(el.overlaySettings);
  }
});

el.clearCacheBtn.addEventListener('click', async () => {
  if (!confirm('Clear cached offline map tiles? Your saved waypoints are not affected.')) return;
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.includes('tiles')).map(k => caches.delete(k)));
  }
  updateCacheDesc();
  toast('Offline tile cache cleared');
});

el.deleteAllBtn.addEventListener('click', async () => {
  if (waypoints.length === 0) { toast('No waypoints to delete'); return; }
  if (!confirm(`Delete all ${waypoints.length} waypoint${waypoints.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  await dbClear();
  markersById.forEach((m) => map.removeLayer(m));
  markersById.clear();
  waypoints = [];
  updateEmptyHint();
  renderManageList();
  hideOverlay(el.overlaySettings);
  toast('All waypoints deleted');
});

async function updateCacheDesc() {
  if (!('caches' in window)) { el.cacheDesc.textContent = 'Offline caching not supported in this browser'; return; }
  try {
    const cache = await caches.open('waypoint-tiles-v1');
    const keys = await cache.keys();
    el.cacheDesc.textContent = `${keys.length} map tiles saved for offline use`;
  } catch {
    el.cacheDesc.textContent = "Tiles you've viewed are saved for offline use";
  }
}

/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}

/* ---------- Boot ---------- */
(async function boot() {
  initTheme();
  initMap();
  bindMapClickForPickMode();
  await loadAll();
  setTimeout(() => el.splash.classList.add('hide'), 350);
})();
