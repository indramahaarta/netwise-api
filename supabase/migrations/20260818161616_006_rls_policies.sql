-- Row Level Security.
--
-- The `authenticated` role gets SELECT ONLY on every table. This is not just
-- least-privilege tidiness, it is required for correctness: all the invariants
-- that make the ledger sound live in application code, not in constraints -
-- TransactionValidator's insufficient-cash and insufficient-holdings checks,
-- creating both halves of a transfer pair, the portfolio-deposit counterpart,
-- the cascade that soft-deletes a pair together. A client able to INSERT
-- directly would bypass every one of them and could create a wallet transaction
-- with no counterpart, or sell shares it does not hold.
--
-- Writes therefore go exclusively through the Vercel functions using
-- service_role, which bypasses RLS. These policies are the backstop that makes
-- a leaked anon key a read-only incident scoped to one user, not a write breach.
--
-- Every policy wraps auth.uid() in a scalar subselect. Without it Postgres
-- re-evaluates the function per row; on a ledger with tens of thousands of
-- transactions that is the difference between an index scan and a disaster.

-- RLS needs an index on the filtered column for every table it guards. Some are
-- already covered by partial `where deleted_at is null` indexes, but RLS also
-- applies to queries that touch soft-deleted rows, so add unconditional ones.
create index wallets_user_idx                on public.wallets (user_id);
create index wallet_transactions_user_idx    on public.wallet_transactions (user_id);
create index portfolios_user_idx             on public.portfolios (user_id);
create index portfolio_transactions_user_idx on public.portfolio_transactions (user_id);
create index wallet_category_budgets_user_idx on public.wallet_category_budgets (user_id);

alter table public.user_settings            enable row level security;
alter table public.user_entitlements        enable row level security;
alter table public.wallet_groups            enable row level security;
alter table public.wallet_categories        enable row level security;
alter table public.wallet_tags              enable row level security;
alter table public.wallets                  enable row level security;
alter table public.wallet_transactions      enable row level security;
alter table public.wallet_transaction_tags  enable row level security;
alter table public.wallet_category_budgets  enable row level security;
alter table public.portfolios               enable row level security;
alter table public.portfolio_transactions   enable row level security;
alter table public.wallet_snapshots         enable row level security;
alter table public.portfolio_snapshots      enable row level security;
alter table public.snapshot_jobs            enable row level security;
alter table public.migration_jobs           enable row level security;

create policy user_settings_select           on public.user_settings           for select to authenticated using ((select auth.uid()) = user_id);
create policy user_entitlements_select       on public.user_entitlements       for select to authenticated using ((select auth.uid()) = user_id);
create policy wallet_groups_select           on public.wallet_groups           for select to authenticated using ((select auth.uid()) = user_id);
create policy wallet_categories_select       on public.wallet_categories       for select to authenticated using ((select auth.uid()) = user_id);
create policy wallet_tags_select             on public.wallet_tags             for select to authenticated using ((select auth.uid()) = user_id);
create policy wallets_select                 on public.wallets                 for select to authenticated using ((select auth.uid()) = user_id);
create policy wallet_transactions_select     on public.wallet_transactions     for select to authenticated using ((select auth.uid()) = user_id);
create policy wallet_transaction_tags_select on public.wallet_transaction_tags for select to authenticated using ((select auth.uid()) = user_id);
create policy wallet_category_budgets_select on public.wallet_category_budgets for select to authenticated using ((select auth.uid()) = user_id);
create policy portfolios_select              on public.portfolios              for select to authenticated using ((select auth.uid()) = user_id);
create policy portfolio_transactions_select  on public.portfolio_transactions  for select to authenticated using ((select auth.uid()) = user_id);
create policy wallet_snapshots_select        on public.wallet_snapshots        for select to authenticated using ((select auth.uid()) = user_id);
create policy portfolio_snapshots_select     on public.portfolio_snapshots     for select to authenticated using ((select auth.uid()) = user_id);
create policy snapshot_jobs_select           on public.snapshot_jobs           for select to authenticated using ((select auth.uid()) = user_id);
create policy migration_jobs_select          on public.migration_jobs          for select to authenticated using ((select auth.uid()) = user_id);

-- migration_jobs.payload holds the user's entire ledger as raw JSON. Nothing
-- needs to read it back over the wire, and it is the single most sensitive
-- column in the database.
revoke select (payload) on public.migration_jobs from authenticated;;
