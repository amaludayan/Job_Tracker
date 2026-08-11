/* ===================== Waypoint — flights.js =====================
 * Live aircraft overlay, ported from the "Skylight" project.
 *
 * Skylight normally runs its own Node server (talking to a local ADS-B
 * radio and/or the airplanes.live API) and streams snapshots to a canvas
 * renderer. Waypoint has no server, so this module talks to the free,
 * keyless airplanes.live public API directly from the browser, and reuses
 * Skylight's type-aware glowing aircraft glyphs (widebody / quadjet /
 * turboprop / light / helicopter, with spinning props & rotors).
 *
 * Perf choices made specifically so this never introduces jank/lag on
 * phones or laptops:
 *  - One <canvas> overlay, not one DOM marker per aircraft.
 *  - Polls the API on a slow timer (default 15s), not per animation frame.
 *  - Between polls, positions are dead-reckoned from speed/heading (cheap
 *    trig) so motion still looks smooth without extra network traffic.
 *  - The redraw loop is capped to ~15fps and fully stops when the layer is
 *    off, the tab is hidden, or the map is mid zoom-drag.
 *  - Aircraft count is capped; far/low-value contacts are dropped first.
 *  - The canvas has pointer-events:none — it can never swallow map drags,
 *    long-presses, or existing tap targets. Aircraft taps are handled via
 *    a lightweight hit-test on the map's own 'click' event instead.
 * =================================================================== */

(function () {
  'use strict';

  /* ---------- Config ---------- */
  var API_TEMPLATE = 'https://api.airplanes.live/v2/point/{lat}/{lon}/{r}';
  var ADSBDB_CALLSIGN = 'https://api.adsbdb.com/v0/callsign/';
  var POLL_MS = 15000;            // steady-state poll cadence
  var MOVE_REFETCH_DEBOUNCE = 900; // ms after map settles before refetching
  var MAX_RADIUS_NM = 250;         // airplanes.live hard cap
  var SKIP_RADIUS_NM = 400;        // beyond this we just don't fetch (too zoomed out)
  var MAX_AIRCRAFT = 180;          // hard cap on what we draw/track
  var STALE_MS = 90000;            // drop a contact if unseen this long
  var FRAME_MS = 66;               // ~15fps redraw cap
  var LABEL_MAX_COUNT = 40;        // only draw text labels if the sky isn't too busy
  var ENABLED_KEY = 'waypoint-flights-enabled';
  var NM_TO_M = 1852;

  /* ---------- Tiny state ---------- */
  var enabled = localStorage.getItem(ENABLED_KEY) === '1';
  var mapRef = null;
  var layer = null;
  var pollTimer = null;
  var refetchDebounce = null;
  var rafId = null;
  var lastFrameTs = 0;
  var lastFetchAt = 0;
  var inFlightAbort = null;
  var aircraft = new Map();   // hex -> record
  var routeCache = new Map(); // callsign -> {origin,destination} | null
  var btn = null, badge = null;
  var zoomedTooFar = false;

  function $(sel) { return document.querySelector(sel); }

  /* ---------- Aircraft glyphs (ported from Skylight's aircraftGlyph.ts) ---------- */
  var GLYPH_SCALE = { light: 0.62, turboprop: 0.86, airliner: 1.0, widebody: 1.3, quadjet: 1.46, helicopter: 0.82 };

  var HELI = new Set(['EC20','EC25','EC30','EC35','EC45','EC55','AS50','AS55','AS65','AS32','A109','A119','A139','A169','A189','B06','B06T','B407','B412','B427','B429','B430','B505','S76','S92','S61','S64','H60','H500','MD52','MD60','R22','R44','R66','EXEC','EXPL','GAZL','LYNX','NH90','PUMA','SCAV','UH1','B105','B212','B214','B222','H47','H64']);
  var QUAD = new Set(['B741','B742','B743','B744','B748','B74S','B74R','B74D','A388','A342','A343','A345','A346','A124','C5M','A225','IL96','B52','A140']);
  var WIDE = new Set(['A306','A30B','A310','A332','A333','A338','A339','A359','A35K','B762','B763','B764','B772','B77L','B773','B77W','B778','B779','B788','B789','B78X','MD11','IL86','DC10','L101','A337','B767','B777','B787']);
  var TPROP = new Set(['DH8A','DH8B','DH8C','DH8D','AT43','AT44','AT45','AT46','AT72','AT73','AT75','AT76','SF34','SB20','SW3','SW4','E110','E120','C208','C212','C408','PC12','B190','BE20','B350','B300','JS31','JS32','JS41','D228','D328','F50','F27','ATP','TBM7','TBM8','TBM9','TBM0','PC6','C441','C425','DHC6','DHC7','C130','AN12','AN26','AN32','SH36','CVLT','SAAB']);
  var LIGHT = new Set(['C150','C152','C162','C172','C72R','C175','C177','C180','C182','C185','C188','C206','C207','C210','C310','C337','SR20','SR22','S22T','PA18','PA24','PA28','P28A','P28B','P28R','PA32','P32R','PA34','PA38','PA44','PA46','DA20','DA40','DA42','DA62','BE33','BE35','BE36','BE58','BE76','BE19','BE23','BE24','M20P','M20T','AA1','AA5','GLAS','COL4','RV4','RV6','RV7','RV8','RV9','RV10','RV14','GA8','G115','BL8','CH7','SF50']);

  function classifyGlyph(ac) {
    var code = (ac.typeCode || '').toUpperCase();
    var cat = ac.category;
    if (cat === 'A7' || HELI.has(code)) return 'helicopter';
    if (QUAD.has(code)) return 'quadjet';
    if (WIDE.has(code) || cat === 'A5') return 'widebody';
    if (TPROP.has(code)) return 'turboprop';
    if (LIGHT.has(code) || cat === 'A1') return 'light';
    return 'airliner';
  }

  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }

  function jetBody(ctx, s, o) {
    var sweep = o.straight ? 0.18 : 0.54;
    ctx.beginPath();
    ctx.roundRect((-o.fw * s) / 2, o.nose * s, o.fw * s, (o.tail - o.nose) * s, (o.fw * s) / 2);
    ctx.moveTo(-0.09 * s, -0.02 * s);
    ctx.lineTo(-o.span * s, sweep * s);
    ctx.lineTo(-(o.span - 0.1) * s, (sweep + 0.06) * s);
    ctx.lineTo(-0.09 * s, 0.3 * s);
    ctx.lineTo(0.09 * s, 0.3 * s);
    ctx.lineTo((o.span - 0.1) * s, (sweep + 0.06) * s);
    ctx.lineTo(o.span * s, sweep * s);
    ctx.lineTo(0.09 * s, -0.02 * s);
    ctx.closePath();
    var ty = o.tail - 0.24;
    ctx.moveTo(-0.08 * s, ty * s);
    ctx.lineTo(-0.44 * s, (ty + 0.23) * s);
    ctx.lineTo(-0.37 * s, (ty + 0.27) * s);
    ctx.lineTo(-0.08 * s, (ty + 0.12) * s);
    ctx.lineTo(0.08 * s, (ty + 0.12) * s);
    ctx.lineTo(0.37 * s, (ty + 0.27) * s);
    ctx.lineTo(0.44 * s, (ty + 0.23) * s);
    ctx.lineTo(0.08 * s, ty * s);
    ctx.closePath();
  }
  function fillAndEngines(ctx, s, color, alpha, xs) {
    for (var i = 0; i < xs.length; i++) {
      var ex = xs[i];
      [-1, 1].forEach(function (sign) {
        ctx.moveTo(sign * ex * s + 0.07 * s, 0.24 * s);
        ctx.ellipse(sign * ex * s, 0.24 * s, 0.07 * s, 0.13 * s, 0, 0, Math.PI * 2);
      });
    }
    ctx.fillStyle = rgba(color, Math.min(1, alpha * 1.08));
    ctx.fill();
  }
  function lightBody(ctx, s) {
    ctx.beginPath();
    ctx.roundRect(-0.11 * s, -0.85 * s, 0.22 * s, 1.7 * s, 0.11 * s);
    ctx.moveTo(-0.1 * s, -0.34 * s); ctx.lineTo(-1.0 * s, -0.18 * s); ctx.lineTo(-1.0 * s, -0.02 * s);
    ctx.lineTo(-0.1 * s, -0.08 * s); ctx.lineTo(0.1 * s, -0.08 * s); ctx.lineTo(1.0 * s, -0.02 * s);
    ctx.lineTo(1.0 * s, -0.18 * s); ctx.lineTo(0.1 * s, -0.34 * s); ctx.closePath();
    ctx.moveTo(-0.09 * s, 0.6 * s); ctx.lineTo(-0.42 * s, 0.78 * s); ctx.lineTo(-0.42 * s, 0.88 * s);
    ctx.lineTo(-0.09 * s, 0.74 * s); ctx.lineTo(0.09 * s, 0.74 * s); ctx.lineTo(0.42 * s, 0.88 * s);
    ctx.lineTo(0.42 * s, 0.78 * s); ctx.lineTo(0.09 * s, 0.6 * s); ctx.closePath();
  }
  function heliBody(ctx, s) {
    ctx.beginPath();
    ctx.ellipse(0, -0.15 * s, 0.34 * s, 0.55 * s, 0, 0, Math.PI * 2);
    ctx.moveTo(-0.07 * s, 0.3 * s); ctx.lineTo(-0.05 * s, 1.12 * s); ctx.lineTo(0.05 * s, 1.12 * s); ctx.lineTo(0.07 * s, 0.3 * s); ctx.closePath();
    ctx.moveTo(-0.05 * s, 1.0 * s); ctx.lineTo(-0.22 * s, 1.22 * s); ctx.lineTo(-0.05 * s, 1.22 * s); ctx.closePath();
  }
  function propDisc(ctx, cx, cy, r, color, alpha, spin, hub, blades) {
    hub = hub !== false; blades = blades || 4;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgba(color, 0.14 * alpha);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(color, 0.7 * alpha);
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.lineCap = 'round';
    for (var i = 0; i < blades; i++) {
      var a = (i / blades) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); ctx.stroke();
    }
    if (hub) {
      ctx.fillStyle = rgba([255, 255, 255], 0.7 * alpha);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.12, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function mainRotor(ctx, s, color, alpha, spin) {
    var r = 1.15 * s;
    ctx.save();
    ctx.translate(0, -0.15 * s);
    ctx.rotate(spin);
    ctx.fillStyle = rgba(color, 0.08 * alpha);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(color, 0.55 * alpha);
    ctx.lineWidth = Math.max(1.2, r * 0.06);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
    ctx.fillStyle = rgba([255, 255, 255], 0.85 * alpha);
    ctx.beginPath(); ctx.arc(0, 0, s * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function core(ctx, s, alpha, r) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = rgba([255, 255, 255], 0.75 * alpha);
    ctx.beginPath(); ctx.arc(0, 0, s * r, 0, Math.PI * 2); ctx.fill();
  }

  function drawAircraftGlyph(ctx, kind, s, color, alpha, t, seed) {
    ctx.shadowColor = rgba(color, 0.85 * alpha);
    ctx.shadowBlur = s * 0.7;
    ctx.fillStyle = rgba(color, Math.min(1, alpha * 1.08));
    switch (kind) {
      case 'widebody':
        jetBody(ctx, s, { fw: 0.22, nose: -1.16, tail: 1.06, span: 1.16 });
        fillAndEngines(ctx, s, color, alpha, [0.42, 0.66]);
        core(ctx, s, alpha, 0.1);
        break;
      case 'quadjet':
        jetBody(ctx, s, { fw: 0.22, nose: -1.2, tail: 1.08, span: 1.2 });
        fillAndEngines(ctx, s, color, alpha, [0.34, 0.55, 0.74, 0.95].map(function (x) { return x * 0.95; }));
        core(ctx, s, alpha, 0.1);
        break;
      case 'turboprop':
        jetBody(ctx, s, { fw: 0.2, nose: -1.0, tail: 0.96, span: 1.04, straight: true });
        ctx.fill();
        ctx.shadowBlur = 0;
        propDisc(ctx, -0.5 * s, 0.18 * s, 0.26 * s, color, alpha, t * 9 + seed);
        propDisc(ctx, 0.5 * s, 0.18 * s, 0.26 * s, color, alpha, -t * 9 + seed, true);
        core(ctx, s, alpha, 0.09);
        break;
      case 'light':
        lightBody(ctx, s);
        ctx.fill();
        ctx.shadowBlur = 0;
        propDisc(ctx, 0, -0.95 * s, 0.34 * s, color, alpha, t * 11 + seed);
        break;
      case 'helicopter':
        heliBody(ctx, s);
        ctx.fill();
        ctx.shadowBlur = 0;
        propDisc(ctx, 0.04 * s, 1.18 * s, 0.22 * s, color, alpha, t * 16 + seed, false, 2);
        mainRotor(ctx, s, color, alpha, t * 6 + seed);
        break;
      case 'airliner':
      default:
        jetBody(ctx, s, { fw: 0.2, nose: -1.06, tail: 0.98, span: 1.05 });
        fillAndEngines(ctx, s, color, alpha, [0.46]);
        core(ctx, s, alpha, 0.1);
        break;
    }
  }

  /* ---------- Geo helpers ---------- */
  function nmBetween(lat1, lon1, lat2, lon2) {
    var R = 3440.065; // nm
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  /** Dead-reckon a lat/lon forward by (knots, true-track-degrees, seconds). */
  function projectPosition(lat, lon, knots, trackDeg, seconds) {
    if (!knots || seconds <= 0) return [lat, lon];
    var distNm = (knots * seconds) / 3600;
    var R = 3440.065;
    var brng = trackDeg * Math.PI / 180;
    var lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(distNm / R) + Math.cos(lat1) * Math.sin(distNm / R) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(distNm / R) * Math.cos(lat1), Math.cos(distNm / R) - Math.sin(lat1) * Math.sin(lat2));
    return [lat2 * 180 / Math.PI, ((lon2 * 180 / Math.PI) + 540) % 360 - 180];
  }

  /* ---------- Data fetch (airplanes.live public API) ---------- */
  function normalize(raw, ts) {
    if (!raw.hex) return null;
    var onGround = raw.alt_baro === 'ground';
    return {
      hex: raw.hex,
      flight: raw.flight ? raw.flight.trim() : undefined,
      lat: raw.lat, lon: raw.lon,
      altBaro: onGround ? null : (typeof raw.alt_baro === 'number' ? raw.alt_baro : null),
      gs: raw.gs, track: raw.track,
      baroRate: raw.baro_rate != null ? raw.baro_rate : null,
      category: raw.category,
      onGround: onGround,
      registration: raw.r, typeCode: raw.t,
      seen: raw.seen, ts: ts,
      fixLat: raw.lat, fixLon: raw.lon, fixTs: ts, // anchor for dead-reckoning
    };
  }

  function computeRadiusNm(map) {
    var b = map.getBounds();
    var c = b.getCenter();
    return nmBetween(c.lat, c.lng, b.getNorthEast().lat, b.getNorthEast().lng);
  }

  function fetchAircraft() {
    if (!enabled || !mapRef || document.hidden) return;
    var c = mapRef.getCenter();
    var radiusNm = Math.min(MAX_RADIUS_NM, Math.ceil(computeRadiusNm(mapRef)) + 2);
    var fullRadius = computeRadiusNm(mapRef);
    zoomedTooFar = fullRadius > SKIP_RADIUS_NM;
    updateBadge();
    if (zoomedTooFar) return; // too zoomed out — avoid a huge, laggy fetch

    if (inFlightAbort) inFlightAbort.abort();
    var ac = new AbortController();
    inFlightAbort = ac;
    var url = API_TEMPLATE
      .replace('{lat}', c.lat.toFixed(4))
      .replace('{lon}', c.lng.toFixed(4))
      .replace('{r}', String(radiusNm));

    var timeout = setTimeout(function () { ac.abort(); }, 8000);
    fetch(url, { signal: ac.signal })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) {
        clearTimeout(timeout);
        var now = Date.now();
        lastFetchAt = now;
        var list = json.ac || json.aircraft || [];
        var seenHex = new Set();
        for (var i = 0; i < list.length; i++) {
          var n = normalize(list[i], now);
          if (!n || typeof n.lat !== 'number' || typeof n.lon !== 'number') continue;
          seenHex.add(n.hex);
          var prev = aircraft.get(n.hex);
          if (prev) {
            // keep a short trail of identity but refresh the position anchor
            n.flight = n.flight || prev.flight;
            n.typeCode = n.typeCode || prev.typeCode;
            n.registration = n.registration || prev.registration;
          }
          aircraft.set(n.hex, n);
        }
        pruneStale(now);
        updateBadge();
      })
      .catch(function () { clearTimeout(timeout); /* keep last-known aircraft on screen */ });
  }

  function pruneStale(now) {
    aircraft.forEach(function (a, hex) {
      if (now - a.ts > STALE_MS) aircraft.delete(hex);
    });
  }

  function scheduleRefetch() {
    clearTimeout(refetchDebounce);
    refetchDebounce = setTimeout(fetchAircraft, MOVE_REFETCH_DEBOUNCE);
  }

  function startPolling() {
    stopPolling();
    fetchAircraft();
    pollTimer = setInterval(fetchAircraft, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    clearTimeout(refetchDebounce);
    if (inFlightAbort) { inFlightAbort.abort(); inFlightAbort = null; }
  }

  /* ---------- Canvas overlay layer (Leaflet.heat-style positioning) ---------- */
  var CanvasLayer = (window.L ? L.Layer : Object).extend({
    onAdd: function (map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'flights-canvas leaflet-zoom-animated');
      this._ctx = this._canvas.getContext('2d');
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('moveend zoomend resize', this._reset, this);
      map.on('move', this._reposition, this);
      if (map.options.zoomAnimation) map.on('zoomanim', this._animateZoom, this);
      map.on('click', onMapClick, this);
      this._reset();
    },
    onRemove: function (map) {
      L.DomUtil.remove(this._canvas);
      map.off('moveend zoomend resize', this._reset, this);
      map.off('move', this._reposition, this);
      map.off('zoomanim', this._animateZoom, this);
      map.off('click', onMapClick, this);
    },
    _reposition: function () {
      var topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
    },
    _reset: function () {
      var size = this._map.getSize();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      this._canvas.style.width = size.x + 'px';
      this._canvas.style.height = size.y + 'px';
      this._canvas.width = Math.round(size.x * dpr);
      this._canvas.height = Math.round(size.y * dpr);
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      L.DomUtil.setTransform(this._canvas, [0, 0], 1);
      this._reposition();
      this._hits = [];
      draw();
    },
    _animateZoom: function (e) {
      var scale = this._map.getZoomScale(e.zoom);
      var offset = this._map._latLngToNewLayerPoint(this._map.getBounds().getNorthWest(), e.zoom, e.center);
      L.DomUtil.setTransform(this._canvas, offset, scale);
    },
  });

  var lastHits = []; // [{x,y,r,ac}] in container-point space, refreshed each draw

  function altColor(ac) {
    // Climbing = warm gold, descending = cool blue-white, level = neutral white-gold,
    // matching Waypoint's own accent palette rather than inventing a new one.
    var vs = ac.baroRate || 0;
    if (vs > 250) return [231, 180, 90];   // climbing
    if (vs < -250) return [122, 178, 255]; // descending
    return [230, 230, 236];                // level / unknown
  }

  function draw() {
    if (!layer || !layer._map || !layer._ctx) return;
    var map = layer._map;
    var ctx = layer._ctx;
    var size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    lastHits = [];
    if (!enabled) return;

    if (zoomedTooFar) return;

    var now = Date.now();
    var t = now / 1000;
    var zoom = map.getZoom();
    var list = Array.from(aircraft.values());

    // Cap & prioritize by distance from viewport center so we never draw an
    // unbounded number of glyphs (keeps frame time flat regardless of traffic).
    var center = map.getCenter();
    list.forEach(function (a) { a._d = nmBetween(center.lat, center.lng, a.lat, a.lon); });
    list.sort(function (x, y) { return x._d - y._d; });
    if (list.length > MAX_AIRCRAFT) list = list.slice(0, MAX_AIRCRAFT);

    var drawLabels = list.length <= LABEL_MAX_COUNT && zoom >= 8;
    var baseSize = Math.max(9, Math.min(22, 8 + zoom * 1.1));

    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var elapsed = (now - a.fixTs) / 1000;
      var pos = a.onGround ? [a.lat, a.lon] : projectPosition(a.fixLat, a.fixLon, a.gs || 0, a.track || 0, elapsed);
      var pt = map.latLngToContainerPoint([pos[0], pos[1]]);
      if (pt.x < -40 || pt.y < -40 || pt.x > size.x + 40 || pt.y > size.y + 40) continue;

      var kind = classifyGlyph(a);
      var s = baseSize * (GLYPH_SCALE[kind] || 1);
      var color = altColor(a);
      var alpha = a.hex === selectedHex ? 1 : 0.88;
      var seed = hashSeed(a.hex);

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(((a.track || 0) * Math.PI) / 180);
      drawAircraftGlyph(ctx, kind, s, color, alpha, t, seed);
      ctx.restore();

      if (a.hex === selectedHex) {
        ctx.save();
        ctx.strokeStyle = rgba([230, 230, 236], 0.6);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, s * 1.9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (drawLabels) {
        var label = (a.flight || a.hex.toUpperCase());
        var altTxt = a.onGround ? 'grd' : (a.altBaro != null ? Math.round(a.altBaro / 100) : '');
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(20,20,24,0.55)';
        ctx.fillText(label + (altTxt !== '' ? '  ' + altTxt : ''), pt.x + s * 0.9 + 1, pt.y - s * 0.6 + 1);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillText(label + (altTxt !== '' ? '  ' + altTxt : ''), pt.x + s * 0.9, pt.y - s * 0.6);
        ctx.restore();
      }

      lastHits.push({ x: pt.x, y: pt.y, r: Math.max(16, s * 1.1), ac: a });
    }
  }

  function hashSeed(hex) {
    var h = 0;
    for (var i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) >>> 0;
    return (h % 1000) / 100;
  }

  /* ---------- Redraw loop (throttled, pauses when idle/hidden) ---------- */
  function tick(ts) {
    if (!enabled) { rafId = null; return; }
    if (!lastFrameTs || ts - lastFrameTs >= FRAME_MS) {
      lastFrameTs = ts;
      draw();
    }
    rafId = requestAnimationFrame(tick);
  }
  function startLoop() {
    if (rafId) return;
    lastFrameTs = 0;
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ---------- Tap-to-inspect ---------- */
  var selectedHex = null;
  function onMapClick(e) {
    var p = e.containerPoint;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < lastHits.length; i++) {
      var h = lastHits[i];
      var dx = h.x - p.x, dy = h.y - p.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d <= h.r && d < bestDist) { best = h; bestDist = d; }
    }
    if (!best) return;
    L.DomEvent.stop(e);
    selectedHex = best.ac.hex;
    showAircraftPopup(best.ac, e.latlng);
    draw();
  }

  function fmtSpeed(kts) { return kts != null ? Math.round(kts) + ' kt' : '—'; }
  function fmtAlt(ft, onGround) { if (onGround) return 'On ground'; return ft != null ? ft.toLocaleString() + ' ft' : '—'; }

  function showAircraftPopup(ac, latlng) {
    var body = document.createElement('div');
    body.className = 'flight-popup';
    var title = ac.flight || ac.hex.toUpperCase();
    body.innerHTML =
      '<div class="fp-title">' + escapeHTML(title) + '</div>' +
      '<div class="fp-row"><span>Altitude</span><b>' + fmtAlt(ac.altBaro, ac.onGround) + '</b></div>' +
      '<div class="fp-row"><span>Speed</span><b>' + fmtSpeed(ac.gs) + '</b></div>' +
      '<div class="fp-row"><span>Type</span><b>' + escapeHTML(ac.typeCode || '—') + '</b></div>' +
      '<div class="fp-row"><span>Reg</span><b>' + escapeHTML(ac.registration || '—') + '</b></div>' +
      '<div class="fp-route" id="fpRoute">Looking up route…</div>';

    var popup = L.popup({ className: 'flight-popup-wrap', closeButton: true, offset: [0, -4] })
      .setLatLng(latlng)
      .setContent(body)
      .openOn(mapRef);

    mapRef.once('popupclose', function (ev) {
      if (ev.popup === popup) { selectedHex = null; draw(); }
    });

    if (ac.flight) {
      resolveRoute(ac.flight, function (route) {
        var routeEl = body.querySelector('#fpRoute');
        if (!routeEl) return;
        if (route && (route.origin || route.destination)) {
          routeEl.textContent = (route.origin || '?') + '  →  ' + (route.destination || '?');
        } else {
          routeEl.textContent = 'Route unavailable';
        }
      });
    } else {
      var noCallsignEl = body.querySelector('#fpRoute');
      if (noCallsignEl) noCallsignEl.textContent = 'No callsign reported';
    }
  }

  function escapeHTML(str) {
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  /** Route lookup is on-demand only (one tap = one request), via adsbdb's free public API. */
  function resolveRoute(callsign, cb) {
    var key = callsign.trim().toUpperCase();
    if (routeCache.has(key)) { cb(routeCache.get(key)); return; }
    var ac2 = new AbortController();
    var timeout = setTimeout(function () { ac2.abort(); }, 6000);
    fetch(ADSBDB_CALLSIGN + encodeURIComponent(key), { signal: ac2.signal })
      .then(function (r) { if (!r.ok) throw new Error('no'); return r.json(); })
      .then(function (json) {
        clearTimeout(timeout);
        var fr = json && json.response && json.response.flightroute;
        var route = fr ? {
          origin: fr.origin && (fr.origin.iata_code || fr.origin.icao_code),
          destination: fr.destination && (fr.destination.iata_code || fr.destination.icao_code),
        } : null;
        routeCache.set(key, route);
        cb(route);
      })
      .catch(function () { clearTimeout(timeout); routeCache.set(key, null); cb(null); });
  }

  /* ---------- Toggle button + badge ---------- */
  function updateBadge() {
    if (!badge) return;
    if (!enabled) { badge.classList.remove('show'); return; }
    if (zoomedTooFar) { badge.textContent = '—'; badge.classList.add('show'); return; }
    badge.textContent = aircraft.size > 99 ? '99+' : String(aircraft.size);
    badge.classList.add('show');
  }

  function setEnabled(next) {
    enabled = next;
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
    if (btn) btn.classList.toggle('active', enabled);
    if (!enabled) selectedHex = null;
    updateBadge();
    if (enabled) {
      startPolling();
      startLoop();
    } else {
      stopPolling();
      stopLoop();
      draw(); // clears the canvas
    }
  }

  function onVisibilityChange() {
    if (!enabled) return;
    if (document.hidden) {
      stopPolling();
      stopLoop();
    } else {
      startPolling();
      startLoop();
    }
  }

  function buildButton() {
    if (document.getElementById('flightsBtn')) return; // already present in index.html
    var container = document.getElementById('app');
    if (!container) return;
    var b = document.createElement('button');
    b.className = 'flights-btn';
    b.id = 'flightsBtn';
    b.title = 'Show nearby air traffic';
    b.setAttribute('aria-label', 'Toggle live flight tracking');
    b.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M17.8 19.2 16 11l3.5-3.5c.6-.6.6-2.1 0-2.7-.6-.6-2.1-.6-2.7 0L13.3 8.3 5 6.5c-.4-.1-.9 0-1.2.3-.5.5-.5 1.2 0 1.7l4.2 3.6-2 2-2.6-.4-1 1 3.5 2 2 3.5 1-1-.4-2.6 2-2 3.6 4.2c.5.5 1.2.5 1.7 0 .3-.3.4-.8.3-1.2Z"/>' +
      '</svg>' +
      '<span class="flights-badge" id="flightsBadge"></span>';
    container.appendChild(b);
  }

  function wireButton() {
    btn = document.getElementById('flightsBtn');
    badge = document.getElementById('flightsBadge');
    if (!btn) return;
    btn.classList.toggle('active', enabled);
    btn.addEventListener('click', function () {
      setEnabled(!enabled);
      if (typeof toast === 'function') {
        toast(enabled ? 'Tracking nearby air traffic' : 'Flight tracking off');
      }
    });
    updateBadge();
  }

  /* ---------- Boot ---------- */
  function init(mapInstance) {
    if (!mapInstance || mapRef) return;
    mapRef = mapInstance;
    buildButton();
    wireButton();
    layer = new CanvasLayer();
    layer.addTo(mapRef);
    mapRef.on('moveend zoomend', scheduleRefetch);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (enabled) { startPolling(); startLoop(); }
  }

  // Preferred: app.js dispatches this once its Leaflet map exists.
  window.addEventListener('waypoint:map-ready', function (e) {
    init(e.detail && e.detail.map);
  });
  // Fallback, in case script order/timing changes later: pick up the
  // page's global `map` once it appears, without ever double-initializing.
  var fallbackTries = 0;
  var fallbackTimer = setInterval(function () {
    fallbackTries++;
    if (mapRef) { clearInterval(fallbackTimer); return; }
    if (typeof window.map !== 'undefined' && window.map && window.map instanceof L.Map) {
      clearInterval(fallbackTimer);
      init(window.map);
    } else if (fallbackTries > 100) {
      clearInterval(fallbackTimer);
    }
  }, 100);
})();
