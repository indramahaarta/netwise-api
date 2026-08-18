-- Wallet domain: direct port of WalletModels.swift, WalletGroupModel.swift and
-- WalletCategoryBudget.swift.
--
-- created_at is deliberately NULLABLE on wallets/categories/tags/transactions.
-- v1.4 treats it as an optional with magic sentinels: Date.distantPast means
-- "seeded default, exempt from premium locking", and LimitChecker ranks rows by
-- it to decide which are locked past the free-tier ceiling. Defaulting it to
-- now() here would silently re-rank every migrated user's data and lock rows
-- that are currently free. Preserve the nulls and the sentinels verbatim.

create table public.wallet_groups (
  id         uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  color_hex  text not null default '007AFF',
  icon       text not null default '📁',
  created_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.wallet_categories (
  id         uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text    not null,
  is_system  boolean not null default false,
  is_income  boolean not null default false,
  icon       text    not null default '🏷️',
  created_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.wallet_tags (
  id         uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  color_hex  text not null default '007AFF',
  created_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.wallets (
  id           uuid primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  currency     text not null default 'IDR',
  group_id     uuid references public.wallet_groups(id) on delete set null,
  is_favorite  boolean not null default false,
  favorited_at timestamptz,
  is_main      boolean not null default false,
  created_at   timestamptz,
  deleted_at   timestamptz,
  updated_at   timestamptz not null default now()
);

-- v1.4 enforces "exactly one live main wallet" at launch via WalletMainService,
-- repairing drift after the fact. Make the database guarantee it instead.
create unique index wallets_one_main_per_user_idx
  on public.wallets (user_id)
  where is_main and deleted_at is null;

create table public.wallet_transactions (
  id                    uuid primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  wallet_id             uuid not null references public.wallets(id) on delete cascade,
  category_id           uuid references public.wallet_categories(id) on delete set null,
  type                  text not null check (type in (
                          'INCOME','EXPENSE','TRANSFER_IN','TRANSFER_OUT',
                          'PORTFOLIO_DEPOSIT','PORTFOLIO_WITHDRAWAL','INITIAL_BALANCE')),
  -- SIGNED. v1.4 encodes direction in the sign: expense, transferOut and
  -- portfolioDeposit are stored negative. Every balance in the app is a plain
  -- sum over this column, so normalising the sign here would change results.
  amount                numeric not null,
  date                  timestamptz not null,
  note                  text not null default '',
  -- Pair and cross-reference links. Kept as bare uuids without foreign keys,
  -- exactly as v1.4 models them: paired_transaction_id is self-referential and
  -- both sides of a transfer are written in one unit of work, so an FK would
  -- impose an insert ordering that bulk migration import cannot satisfy.
  related_wallet_id     uuid,
  related_portfolio_id  uuid,
  paired_transaction_id uuid,
  broker_rate           numeric,
  related_currency      text,
  capture_source        text check (capture_source in ('email','scan')),
  capture_status        text check (capture_status in ('captured','needsAttention')),
  source_email_hash     text,
  raw_capture_text      text,
  created_at            timestamptz,
  deleted_at            timestamptz,
  updated_at            timestamptz not null default now()
);

-- Many-to-many tags. user_id is denormalised onto the join table so the RLS
-- policy is a column comparison rather than a per-row subquery into the parents.
create table public.wallet_transaction_tags (
  wallet_transaction_id uuid not null references public.wallet_transactions(id) on delete cascade,
  wallet_tag_id         uuid not null references public.wallet_tags(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  primary key (wallet_transaction_id, wallet_tag_id)
);

create table public.wallet_category_budgets (
  id                         uuid primary key,
  user_id                    uuid not null references auth.users(id) on delete cascade,
  category_id                uuid not null references public.wallet_categories(id) on delete cascade,
  period                     text not null check (period in ('DAILY','WEEKLY','MONTHLY')),
  amount                     numeric not null,
  currency_code              text not null,
  -- Notification de-dupe state, carried over from v1.4 where it lives on the
  -- domain row. Not present in the backup format, so it resets on migration.
  last_notified_threshold    integer,
  last_notified_period_start timestamptz,
  created_at                 timestamptz not null default now(),
  deleted_at                 timestamptz,
  updated_at                 timestamptz not null default now()
);

-- Foreign-key indexes: Postgres does not create these, and without them both
-- JOINs and ON DELETE CASCADE degrade to sequential scans.
create index wallet_groups_user_idx            on public.wallet_groups (user_id);
create index wallet_categories_user_idx        on public.wallet_categories (user_id);
create index wallet_tags_user_idx              on public.wallet_tags (user_id);
create index wallets_group_idx                 on public.wallets (group_id);
create index wallet_transactions_category_idx  on public.wallet_transactions (category_id);
create index wtt_tag_idx                       on public.wallet_transaction_tags (wallet_tag_id);
create index wtt_user_idx                      on public.wallet_transaction_tags (user_id);
create index wallet_category_budgets_cat_idx   on public.wallet_category_budgets (category_id);

-- Partial indexes matching the app's universal `deleted_at is null` filter.
create index wallets_live_idx
  on public.wallets (user_id) where deleted_at is null;
create index wallet_category_budgets_live_idx
  on public.wallet_category_budgets (user_id) where deleted_at is null;

-- The hot path. v1.4's WalletListView loads EVERY transaction ever via an
-- unbounded @Query and filters in Swift; server-side this is the index that
-- makes a windowed, per-wallet, newest-first read cheap.
create index wallet_transactions_wallet_date_idx
  on public.wallet_transactions (wallet_id, date desc)
  where deleted_at is null;

-- Dashboard aggregations scan a user's whole ledger over a date range.
create index wallet_transactions_user_date_idx
  on public.wallet_transactions (user_id, date desc)
  where deleted_at is null;

-- Pair cascade lookups when soft-deleting one half of a transfer.
create index wallet_transactions_paired_idx
  on public.wallet_transactions (paired_transaction_id)
  where paired_transaction_id is not null;

create trigger wallet_groups_set_updated_at           before update on public.wallet_groups           for each row execute function public.set_updated_at();
create trigger wallet_categories_set_updated_at       before update on public.wallet_categories       for each row execute function public.set_updated_at();
create trigger wallet_tags_set_updated_at             before update on public.wallet_tags             for each row execute function public.set_updated_at();
create trigger wallets_set_updated_at                 before update on public.wallets                 for each row execute function public.set_updated_at();
create trigger wallet_transactions_set_updated_at     before update on public.wallet_transactions     for each row execute function public.set_updated_at();
create trigger wallet_category_budgets_set_updated_at before update on public.wallet_category_budgets for each row execute function public.set_updated_at();;
