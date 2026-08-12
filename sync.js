/* ===================== Waypoint — sync.js =====================
 * Keeps the local IndexedDB cache (used by app.js via dbAll/dbPut/dbDelete)
 * in sync with the Supabase 'waypoints' table for the signed-in user.
 *
 * Strategy: offline-first, last-write-wins by updated_at.
 *  - pullAndMerge(): on sign-in, fetch remote rows, merge into local DB.
 *  - push(record): upsert one record to remote (fire-and-forget-ish, but
 *    surfaces failures so the UI can warn the user they're offline).
 *  - remove(id): delete one record from remote.
 *
 * app.js calls these at its existing dbPut/dbDelete/dbClear/loadAll call
 * sites — see the hooks added there. This file does not touch the DOM.
 * ================================================================= */

window.WaypointSync = (function () {
  let currentUserId = null;

  function toRemoteRow(local) {
    return {
      id: local.id,
      user_id: currentUserId,
      kind: local.kind === 'home' ? 'home' : 'company',
      name: local.name,
      lat: local.lat,
      lng: local.lng,
      note: local.note || '',
    };
  }

  function toLocalRecord(remote) {
    return {
      id: remote.id,
      kind: remote.kind,
      name: remote.name,
      lat: remote.lat,
      lng: remote.lng,
      note: remote.note || '',
      createdAt: new Date(remote.created_at).getTime(),
      updatedAt: new Date(remote.updated_at).getTime(),
    };
  }

  async function push(record) {
    if (!currentUserId) return; // not signed in yet — local save still succeeded
    try {
      const { error } = await window.supabaseClient
        .from('waypoints')
        .upsert(toRemoteRow(record), { onConflict: 'id' });
      if (error) console.warn('Waypoint sync (push) failed, will retry on next pull:', error.message);
    } catch (err) {
      console.warn('Waypoint sync (push) network error:', err.message);
    }
  }

  async function remove(id) {
    if (!currentUserId) return;
    try {
      const { error } = await window.supabaseClient.from('waypoints').delete().eq('id', id);
      if (error) console.warn('Waypoint sync (delete) failed:', error.message);
    } catch (err) {
      console.warn('Waypoint sync (delete) network error:', err.message);
    }
  }

  /**
   * Pull all remote rows for the current user and merge with local IndexedDB.
   * - Remote-only rows are written locally.
   * - Local-only rows are pushed up.
   * - Rows present in both keep whichever has the newer updatedAt.
   * Returns nothing; caller should re-read via dbAll() after this resolves.
   */
  async function pullAndMerge() {
    if (!currentUserId) return;
    const { data, error } = await window.supabaseClient
      .from('waypoints')
      .select('*')
      .eq('user_id', currentUserId);

    if (error) { console.warn('Waypoint sync (pull) failed:', error.message); return; }

    const remoteById = new Map((data || []).map((r) => [r.id, r]));
    const local = await dbAll();
    const localById = new Map(local.map((r) => [r.id, r]));

    // Remote rows: write locally if missing or newer than local copy.
    for (const [id, remote] of remoteById) {
      const localRec = localById.get(id);
      if (!localRec || (remote.updated_at && new Date(remote.updated_at).getTime() > (localRec.updatedAt || 0))) {
        await dbPut(toLocalRecord(remote));
      }
    }

    // Local rows not present remotely (or newer than remote): push up.
    for (const [id, localRec] of localById) {
      const remote = remoteById.get(id);
      if (!remote || (localRec.updatedAt || 0) > new Date(remote.updated_at || 0).getTime()) {
        await push(localRec);
      }
    }
  }

  window.addEventListener('waypoint:authed', (e) => {
    currentUserId = e.detail.userId;
  });
  window.addEventListener('waypoint:signedout', () => {
    currentUserId = null;
  });

  return { push, remove, pullAndMerge };
})();
