-- Defence in depth for client writes.
--
-- Found by the RLS isolation proof: `authenticated` holds INSERT/UPDATE/DELETE
-- privileges on every public table, because Supabase grants those by default.
-- Writes are currently blocked anyway — RLS denies by default when no
-- INSERT/UPDATE/DELETE policy exists, and all three were verified blocked:
--
--   INSERT -> "new row violates row-level security policy for table wallets"
--   UPDATE -> no rows matched under RLS
--   DELETE -> no rows matched under RLS
--
-- So this is not a live hole. It is a fragile one: the ONLY thing standing
-- between a client and a write is the absence of a policy. The moment anyone
-- adds a permissive policy to let clients update one harmless column, the
-- standing grant opens that table to writes far beyond what was intended.
--
-- The v2.0 design is that ALL writes go through Vercel functions using
-- service_role, because the ledger's invariants live in application code —
-- TransactionValidator's insufficient-cash and insufficient-holdings checks,
-- both-sides-of-a-transfer pairing, the pair-cascade on delete, and snapshot
-- job enqueueing. A direct client write bypasses every one of them and can
-- leave the ledger internally inconsistent in ways no constraint would catch.
--
-- So: remove the grant as well as relying on the policy. Two independent
-- barriers, not one.

revoke insert, update, delete, truncate, references
  on all tables in schema public
  from authenticated, anon;

-- Global market data is not per-user and has no policies at all. Clients have
-- no business reading it directly either — it reaches them only as part of a
-- computed payload.
revoke all on public.price_quotes  from authenticated, anon;
revoke all on public.price_history from authenticated, anon;
revoke all on public.fx_rates      from authenticated, anon;
revoke all on public.fx_history    from authenticated, anon;

-- The raw migration payload is a full copy of a user's ledger. Never client-readable.
revoke all on public.migration_jobs from authenticated, anon;

-- Future tables must not silently re-acquire write grants. Without this, the
-- next migration that adds a table reopens exactly the gap this one closes.
alter default privileges in schema public
  revoke insert, update, delete, truncate, references on tables
  from authenticated, anon;

comment on schema public is
  'Client roles are SELECT-only and RLS-scoped. All writes go through Vercel functions as service_role, because ledger invariants are enforced in application code, not constraints.';;
