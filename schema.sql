-- ===================== Waypoint — schema.sql =====================
-- Run this once in your Supabase project's SQL Editor (Database → SQL Editor).
-- Creates the waypoints table and locks it down so each user can ONLY ever
-- see or modify their own rows, enforced by the database itself (Row Level
-- Security) — not by app code, so it holds even if the client is compromised.
-- ===================================================================

create table if not exists public.waypoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('home', 'company')),
  name text not null check (char_length(name) between 1 and 80),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  note text default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists waypoints_user_id_idx on public.waypoints(user_id);

alter table public.waypoints enable row level security;

-- Each policy is scoped to auth.uid() = user_id, so a logged-in user's
-- queries can only ever touch their own rows — Postgres enforces this on
-- every select/insert/update/delete, regardless of what the client sends.

create policy "select own waypoints"
  on public.waypoints for select
  using (auth.uid() = user_id);

create policy "insert own waypoints"
  on public.waypoints for insert
  with check (auth.uid() = user_id);

create policy "update own waypoints"
  on public.waypoints for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "delete own waypoints"
  on public.waypoints for delete
  using (auth.uid() = user_id);

-- Keep updated_at accurate on every edit.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_waypoints_updated_at on public.waypoints;
create trigger trg_waypoints_updated_at
  before update on public.waypoints
  for each row execute function public.set_updated_at();
