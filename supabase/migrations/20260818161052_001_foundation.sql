-- NetWise v2 Phase 1: foundation.
--
-- Conventions used across every migration in this series:
--   * ids are uuid, NOT bigint identity. The v1.4 iOS app owns the UUIDs and
--     BackupService v5 preserves them on export/import, so the migration path
--     requires we accept client-supplied ids verbatim.
--   * money and quantities are unconstrained `numeric`. Exact decimal, arbitrary
--     precision, and no overflow error can reject a real user's historical row.
--     Never float. The wire format keeps these as strings, matching
--     BackupService's existing "\(decimal)" discipline.
--   * timestamps are timestamptz. Per-day buckets are `date`, because snapshots
--     and budget periods are local-calendar concepts, not instants.
--   * soft delete via deleted_at; live rows are indexed with partial indexes.

create extension if not exists pgcrypto;

-- Shared updated_at trigger. The v1 backup format has no per-record updatedAt,
-- which is exactly why it can never be a sync format. Fix that here.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- One row per user. Replaces the App Group UserDefaults bag that today holds
-- mainCurrency, periodStartDay, weekStartDay, hideSensitiveData and the
-- net-worth target.
create table public.user_settings (
  user_id                    uuid primary key references auth.users(id) on delete cascade,
  main_currency              text        not null default 'IDR',
  -- Every period boundary, budget window and daily snapshot is a local-calendar
  -- concept. Without this, a Jakarta user's month would roll over at the wrong
  -- moment. The capture endpoint already proves the pattern by taking a
  -- client-local `now`.
  timezone                   text        not null default 'Asia/Jakarta',
  period_start_day           smallint    not null default 1  check (period_start_day between 1 and 28),
  week_start_day             smallint    not null default 1  check (week_start_day   between 1 and 7),
  hide_sensitive_data        boolean     not null default false,
  net_worth_target_amount    numeric,
  net_worth_target_currency  text,
  ai_capture_consent_at      timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- Entitlement stops being client-asserted. Today the capture endpoint trusts an
-- `X-NetWise-Premium: true` header sent by the app; once premium gates server
-- compute that is untenable. This table is the authority, fed by App Store
-- Server Notifications V2; StoreKit on-device remains the fast path only.
create table public.user_entitlements (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  is_premium             boolean     not null default false,
  product_id             text,
  original_transaction_id text,
  expires_at             timestamptz,
  environment            text        check (environment in ('Sandbox','Production')),
  last_notification_at   timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger user_entitlements_set_updated_at
  before update on public.user_entitlements
  for each row execute function public.set_updated_at();

-- Premium expiry sweeps scan this; partial index keeps it to live subscriptions.
create index user_entitlements_expires_at_idx
  on public.user_entitlements (expires_at)
  where is_premium;

comment on table public.user_settings     is 'Per-user preferences; replaces App Group UserDefaults in v1.4.';
comment on table public.user_entitlements is 'Server-side subscription truth, fed by App Store Server Notifications V2.';;
