-- Global market data. NOT per-user, and that is the entire point.
--
-- In v1.4 PriceCache and ForexRateCache are per-device SwiftData tables, so ten
-- thousand users holding AAPL produce ten thousand independent Yahoo fetches.
-- Here one fetch serves everyone.
--
-- Measured 2026-08-18 from Vercel iad1 egress: Yahoo returns 61/61 at 122
-- concurrent requests when the User-Agent is the literal string 'Mozilla/5.0'
-- (what PriceService.swift:16 ships), and rate-limits 56/61 with a full Chrome
-- UA. Tolerating that load is not a reason to generate it.

-- Live quotes. expires_at is written by the caller, not assumed to be a fixed
-- TTL: during market hours it is fetched_at + 15 minutes (matching PriceStore's
-- existing client-side TTL, so user-visible freshness is unchanged), and when
-- the exchange is closed it extends to the next open, because a closed market's
-- price cannot move. Crypto trades continuously and stays on the flat 15.
create table public.price_quotes (
  symbol     text primary key,
  price      numeric not null,
  currency   text    not null,
  source     text    not null default 'yahoo',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index price_quotes_expires_at_idx on public.price_quotes (expires_at);

-- Daily closes. A closed day's close never changes, so these rows are written
-- once and read forever - no TTL, no invalidation. This is the bigger win than
-- quote caching: snapshot replay walks day-by-day across every symbol, and that
-- is precisely the workload that made the on-device version slow.
create table public.price_history (
  symbol   text    not null,
  date     date    not null,
  close    numeric not null,
  currency text    not null,
  source   text    not null default 'yahoo',
  fetched_at timestamptz not null default now(),
  primary key (symbol, date)
);

-- Live FX. 1 hour TTL, matching ForexService today.
-- `pair` uses v1.4's existing 'IDR_USD' key format.
create table public.fx_rates (
  pair          text primary key,
  from_currency text not null,
  to_currency   text not null,
  rate          numeric not null,
  source        text not null default 'open.er-api.com',
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

create index fx_rates_expires_at_idx on public.fx_rates (expires_at);

-- Historical daily FX, needed because snapshot replay converts each past day at
-- that day's rate rather than today's. Immutable, same as price_history.
create table public.fx_history (
  pair       text not null,
  date       date not null,
  rate       numeric not null,
  source     text not null default 'open.er-api.com',
  fetched_at timestamptz not null default now(),
  primary key (pair, date)
);

-- These are server-owned infrastructure, never read directly by a client.
-- Enabling RLS with no policies denies anon and authenticated outright, while
-- service_role (used by the API functions) bypasses RLS as normal.
alter table public.price_quotes  enable row level security;
alter table public.price_history enable row level security;
alter table public.fx_rates      enable row level security;
alter table public.fx_history    enable row level security;

comment on table public.price_quotes
  is 'Shared live quote cache. expires_at is market-hours aware, set by the writer.';
comment on table public.price_history
  is 'Immutable daily closes shared by all users. Written once per (symbol, date), read forever.';
comment on table public.fx_history
  is 'Immutable daily FX rates; snapshot replay converts each past day at that day''s rate.';;
