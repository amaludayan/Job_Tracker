# Waypoint — Supabase backend setup (free, ~10 minutes)

This adds email+password login and cross-device sync, at $0/month for
personal-scale usage (Supabase free tier: 50k monthly active users,
500MB database, unlimited API requests).

## 1. Create a Supabase project
1. Go to https://supabase.com → sign up (free) → "New project".
2. Pick a name/region, set a database password (save it somewhere — you
   won't need it for this app, but you'll want it if you ever touch the DB
   directly).
3. Wait ~2 min for the project to spin up.

## 2. Run the schema
1. In your project, open **SQL Editor** (left sidebar).
2. Paste in the contents of `schema.sql` from this folder.
3. Run it. This creates the `waypoints` table and locks it down with Row
   Level Security so each user can only ever see their own rows —
   enforced by the database itself, not by app code.

## 3. Get your API keys
1. Project **Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
   (The anon key is meant to be public/shipped in client code — it's not a
   secret. RLS from step 2 is what actually protects the data.)
3. Paste both into `supabase-config.js` in this folder:
   ```js
   window.SUPABASE_CONFIG = {
     url: 'https://your-project-ref.supabase.co',
     anonKey: 'your-anon-public-key',
   };
   ```

## 4. Turn on email confirmation (it's on by default)
1. **Authentication → Providers → Email**.
2. Confirm "Confirm email" is enabled (it is by default) — new users must
   click a link in their email before they can sign in.
3. **Authentication → URL Configuration**: set **Site URL** to wherever
   you'll host the app (e.g. `https://yourname.github.io/waypoint`). This
   is the link users land on after confirming their email or resetting
   their password.

## 5. (Optional but recommended) Customize the email templates
**Authentication → Email Templates** — the defaults work fine, but you
may want to change "Confirm signup" and "Reset password" subject lines
to say "Waypoint" instead of the generic Supabase wording.

## 6. Verify the Supabase JS SRI hash
`index.html` pins `@supabase/supabase-js@2.45.4` from unpkg with an
`integrity` attribute placeholder. Before you deploy, generate the real
hash for whatever version you use:
```bash
curl -s https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.js | \
  openssl dgst -sha256 -binary | openssl base64
```
and put `sha256-<result>` into the `integrity="..."` attribute in
`index.html`. (I couldn't fetch this myself to verify it for you — my
sandbox can't reach unpkg.com.)

## 7. Deploy as a static site (still free)
Any static host works — GitHub Pages, Netlify, Vercel, Cloudflare Pages,
all have free tiers that cover this comfortably. Just upload the folder
as-is; there's no build step and no server process.

## What this does and doesn't change
- **Auth**: real email+password accounts via Supabase Auth, with email
  verification and password reset built in.
- **Storage**: waypoints now live in Postgres (`waypoints` table), scoped
  per-user by Row Level Security, in addition to the local IndexedDB
  cache — so the app still works offline and syncs when back online.
- **Cost**: $0 at personal/small-group scale. You'd only hit paid tiers
  at real scale (way beyond a personal job-hunt map), and Supabase will
  tell you clearly before that happens.
- **Not changed**: the CSP/SRI hardening and the import sanitizer
  (`safe-import.js`) from before — those still apply, and now the import
  flow also pushes sanitized data to your account via `sync.js`.
