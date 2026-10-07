-- Owed: schema. Run in the Supabase SQL editor or via `node scripts/apply-sql.mjs`.
create extension if not exists pgcrypto;

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  monthly_spend numeric not null default 0,
  sla_url text,
  status_url text,
  sla_target numeric,                                -- e.g. 99.99 (monthly uptime %)
  -- Credit tiers, ordered from highest threshold to lowest. The credit is the LAST tier whose
  -- "below" threshold the measured uptime is under. e.g. uptime 98.5 with tiers
  -- [{below:99.99,credit_pct:10},{below:99.0,credit_pct:30},{below:95.0,credit_pct:100}] -> 30%.
  sla_tiers jsonb not null default '[]'::jsonb,
  terms_verified boolean not null default false,     -- false = show "demo terms" on screen
  created_at timestamptz not null default now()
);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id) on delete cascade,
  title text,
  started_at timestamptz,
  ended_at timestamptz,
  minutes integer,
  source_url text,
  created_at timestamptz not null default now()
);

create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('sla','unclaimed')),
  vendor_id uuid references vendors(id) on delete set null,
  period text,                                       -- e.g. '2026-09'
  amount_usd numeric not null default 0,
  evidence jsonb not null default '{}'::jsonb,       -- {uptime_pct, downtime_minutes, incident_ids, tier, spend}
  citation_url text,
  draft text,
  status text not null default 'found' check (status in ('found','approved','filed')),
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  found_usd numeric not null default 0,
  status text not null default 'running',            -- running | completed | failed
  log text
);

-- Hackathon: no RLS, the dashboard reads with the anon key.
alter table vendors disable row level security;
alter table incidents disable row level security;
alter table claims disable row level security;
alter table runs disable row level security;

-- Realtime for the dashboard (each in its own block so one failure doesn't stop the rest).
do $$ begin alter publication supabase_realtime add table claims; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table runs; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table incidents; exception when others then null; end $$;
