/* ===================== Waypoint — supabase-config.js =====================
 * Fill these in with YOUR Supabase project's values (Project Settings → API).
 * The "anon" key is safe to ship in client code — it's public by design.
 * Row Level Security (set up by schema.sql) is what actually protects data,
 * NOT secrecy of this key.
 * =========================================================================== */
window.SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'YOUR-ANON-PUBLIC-KEY',
};

if (window.SUPABASE_CONFIG.url.includes('YOUR-PROJECT-REF')) {
  // Fails loudly instead of silently trying (and failing) to hit a fake URL.
  // See BACKEND-SETUP.md steps 1-3 to get your real values.
  document.addEventListener('DOMContentLoaded', () => {
    const hint = document.getElementById('authHint');
    if (hint) {
      hint.textContent = 'Backend not configured yet — see BACKEND-SETUP.md to add your Supabase URL and anon key.';
      hint.style.color = '#E5484D';
    }
    const submit = document.getElementById('authSubmit');
    if (submit) submit.disabled = true;
  });
}
