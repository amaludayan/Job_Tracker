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
};

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2400);
}

/* ---------- Theme ---------- */
function initTheme() {
  const saved = localStorage.getItem('waypoint-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}
el.themeToggle.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('waypoint-theme', next);
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

/* Long press detection (mouse + touch) that opens the form pre-filled with the tapped point */
function attachLongPress(mapInstance) {
  let pressTimer = null;
  let startLatLng = null;
  const THRESHOLD_MS = 550;
  const MOVE_TOLERANCE_PX = 12;
  let startPoint = null;

  function begin(e) {
    startLatLng = e.latlng;
    startPoint = e.containerPoint;
    pressTimer = setTimeout(() => {
      handleLongPress(startLatLng);
      pressTimer = null;
    }, THRESHOLD_MS);
  }
  function cancel() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }
  function move(e) {
    if (!pressTimer || !startPoint) return;
    const dx = e.containerPoint.x - startPoint.x;
    const dy = e.containerPoint.y - startPoint.y;
    if (Math.sqrt(dx * dx + dy * dy) > MOVE_TOLERANCE_PX) cancel();
  }

  mapInstance.on('mousedown', begin);
  mapInstance.on('mouseup', cancel);
  mapInstance.on('mousemove', move);
  mapInstance.on('dragstart', cancel);
  mapInstance.on('touchstart', begin);
  mapInstance.on('touchend', cancel);
  mapInstance.on('touchmove', move);
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
  showOverlay(el.overlayDetail);
  map.flyTo([wp.lat, wp.lng], Math.max(map.getZoom(), 14), { duration: 0.8 });
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
