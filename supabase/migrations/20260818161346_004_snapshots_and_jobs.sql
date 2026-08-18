-- Daily snapshots, plus the job queues that take snapshot replay off the write
-- path entirely.
--
-- In v1.4 every transaction save and delete fires SnapshotService.replay*, which
-- loops day-by-day from an arbitrary past date to yesterday issuing a Yahoo
-- historical fetch per symbol per day. Editing one old transaction can mean
-- hundreds of days of replay and N network calls, on the phone, blocking. Here
-- a write enqueues a job and returns.
--
-- `date` (not timestamptz) because a snapshot is a local-calendar day in the
-- user's timezone, not an instant.

create table public.wallet_snapshots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  wallet_id   uuid not null references public.wallets(id) on delete cascade,
  date        date    not null,
  balance     numeric not null,
  balance_usd numeric not null,
  created_at  timestamptz not null default now(),
  constraint wallet_snapshots_one_per_day unique (wallet_id, date)
);

create table public.portfolio_snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  portfolio_id   uuid not null references public.portfolios(id) on delete cascade,
  date           date    not null,
  total_equity   numeric not null,
  total_invested numeric not null,
  cash_balance   numeric not null,
  unrealized     numeric not null,
  realized       numeric not null,
  currency       text    not null,
  created_at     timestamptz not null default now(),
  constraint portfolio_snapshots_one_per_day unique (portfolio_id, date)
);

-- Chart reads are always "this user, this window, ascending".
create index wallet_snapshots_user_date_idx    on public.wallet_snapshots    (user_id, date);
create index portfolio_snapshots_user_date_idx on public.portfolio_snapshots (user_id, date);

-- Replay queue. A write enqueues (scope, target, from_date); a cron drains.
create table public.snapshot_jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  scope       text not null check (scope in ('wallet','portfolio')),
  target_id   uuid not null,
  from_date   date not null,
  status      text not null default 'pending'
                check (status in ('pending','running','done','failed')),
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- Coalescing key: many edits to the same target collapse into one pending job,
-- and the earliest from_date wins. Without this a busy user queues hundreds of
-- overlapping replays of the same wallet.
create unique index snapshot_jobs_pending_target_idx
  on public.snapshot_jobs (scope, target_id)
  where status = 'pending';

-- The drain query: oldest pending first.
create index snapshot_jobs_pending_idx
  on public.snapshot_jobs (created_at)
  where status = 'pending';

create index snapshot_jobs_user_idx on public.snapshot_jobs (user_id);

-- v1.4 -> cloud ingest. Deliberately asynchronous: a five-thousand-transaction
-- ledger with three years of snapshot replay will not finish inside a function's
-- maxDuration, so /api/v2/migrate stores the payload, enqueues, and returns a
-- job id the client polls.
create table public.migration_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'pending'
                  check (status in ('pending','importing','replaying','done','failed')),
  backup_version text,
  -- Raw BackupService v5 document. jsonb is fine at Phase 1 scale; if real
  -- payloads push past a few MB, move this to Supabase Storage and keep only
  -- the object path here.
  payload       jsonb,
  -- Chunked-processing bookmark so a timed-out run resumes instead of restarting.
  cursor        jsonb,
  -- Side-by-side counts the user confirms on the verification screen before the
  -- local store is released.
  expected      jsonb,
  imported      jsonb,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index migration_jobs_user_idx on public.migration_jobs (user_id);
create index migration_jobs_active_idx
  on public.migration_jobs (created_at)
  where status in ('pending','importing','replaying');

create trigger migration_jobs_set_updated_at
  before update on public.migration_jobs
  for each row execute function public.set_updated_at();

comment on table public.snapshot_jobs
  is 'Replaces v1.4 on-save SnapshotService replay. Coalesced per target while pending.';
comment on table public.migration_jobs
  is 'Async ingest of a BackupService v5 export during the v2.0 first-launch wizard.';;
