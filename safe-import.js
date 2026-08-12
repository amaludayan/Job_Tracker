/* ===================== Waypoint — safe-import.js =====================
 * Defensive validator/sanitizer for waypoint data coming from OUTSIDE the
 * app: file import, paste, QR code, share-target, etc.
 *
 * Nothing in the current app calls this yet (there is no import button).
 * It exists so that WHEN an import feature is added, untrusted data is
 * forced through here first — never handed straight to dbPut() or innerHTML.
 *
 * Design rules:
 *  - Whitelist, don't blacklist. Unknown fields are dropped, not "cleaned".
 *  - Every value is type-checked, range-checked, and length-capped.
 *  - Strings are stripped of control chars and HTML-escaped for storage.
 *  - No field is ever eval'd, parsed as HTML, or used to build a URL.
 *  - Batch size and total payload size are capped to stop DoS-by-import.
 * ======================================================================= */

const SafeImport = (() => {
  const MAX_ITEMS = 500;           // one absurdly large "waypoints file" shouldn't hang IndexedDB
  const MAX_NAME_LEN = 80;
  const MAX_NOTE_LEN = 500;
  const MAX_JSON_BYTES = 2 * 1024 * 1024; // 2MB raw text cap before we even JSON.parse

  function stripControlChars(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  function escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function cleanString(value, maxLen) {
    if (typeof value !== 'string') return '';
    let s = stripControlChars(value).trim().slice(0, maxLen);
    // Reject anything that looks like it's trying to be markup or a script/URI handler.
    // We don't "sanitize" tags out (that's a losing game) — we just refuse the field.
    if (/<[^>]*>|javascript:|data:text\/html|on\w+\s*=/i.test(s)) {
      return '';
    }
    return escapeHTML(s);
  }

  function cleanNumber(value, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return n;
  }

  function cleanKind(value) {
    return value === 'home' ? 'home' : 'company'; // only two kinds exist in this app
  }

  /**
   * Validate + sanitize a single raw waypoint-like object.
   * Returns a clean object, or null if it fails validation (caller should skip it).
   */
  function sanitizeWaypoint(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const lat = cleanNumber(raw.lat, -90, 90);
    const lng = cleanNumber(raw.lng, -180, 180);
    if (lat === null || lng === null) return null;

    const name = cleanString(raw.name, MAX_NAME_LEN);
    if (!name) return null; // require a real name, don't silently store blank/rejected input

    return {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
      kind: cleanKind(raw.kind),
      name,
      lat,
      lng,
      note: cleanString(raw.note || '', MAX_NOTE_LEN),
    };
  }

  /**
   * Entry point for importing a raw JSON string from a file/paste/QR payload.
   * Never throws on malformed input — always resolves to { items, errors }.
   */
  function parseImportPayload(text) {
    const errors = [];

    if (typeof text !== 'string') {
      return { items: [], errors: ['Import payload was not text.'] };
    }
    if (new Blob([text]).size > MAX_JSON_BYTES) {
      return { items: [], errors: ['Import file is too large.'] };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { items: [], errors: ['Import file is not valid JSON.'] };
    }

    const list = Array.isArray(data) ? data : (Array.isArray(data && data.waypoints) ? data.waypoints : null);
    if (!list) {
      return { items: [], errors: ['Expected a JSON array of waypoints (or {"waypoints":[...]}).'] };
    }
    if (list.length > MAX_ITEMS) {
      errors.push(`Only the first ${MAX_ITEMS} items were processed.`);
    }

    const items = [];
    list.slice(0, MAX_ITEMS).forEach((raw, i) => {
      const clean = sanitizeWaypoint(raw);
      if (clean) items.push(clean);
      else errors.push(`Item ${i + 1} was skipped (missing/invalid name or coordinates).`);
    });

    return { items, errors };
  }

  return { parseImportPayload, sanitizeWaypoint, escapeHTML };
})();
