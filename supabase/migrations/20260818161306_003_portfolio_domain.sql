-- Portfolio domain: port of PortfolioModels.swift.
--
-- Deliberate divergence from v1.4: Portfolio.cash is GONE. In the app it is a
-- stored running balance mutated from eight-plus call sites (both transaction
-- form sheets, the pair-cascade delete, the import flow), which lets it drift
-- from the transaction ledger with no way to tell which is right. Here cash is
-- derived from the ledger and cannot drift.

create table public.portfolios (
  id         uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  currency   text not null,
  -- Raw market code: US/ID/SG/MY/TH/KR/JP/CRYPTO, or null on portfolios
  -- restored from v1/v2 backups. Intentionally UNCONSTRAINED: an old build
  -- stamped every portfolio 'US' regardless of currency, so real user data
  -- contains codes that contradict the currency. PortfolioMarket.resolve treats
  -- currency as ground truth and repairs the mismatch; a check constraint here
  -- would reject those rows at import instead.
  market     text,
  created_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.portfolio_transactions (
  id                  uuid primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  portfolio_id        uuid not null references public.portfolios(id) on delete cascade,
  type                text not null check (type in (
                        'BUY','SELL','DIVIDEND','FEE',
                        'DEPOSIT','WITHDRAWAL','IMPORT_HOLDING','REALIZED_ADJUSTMENT')),
  symbol              text,
  qty                 numeric,
  -- `price` overloads as the cash amount for DEPOSIT / WITHDRAWAL / DIVIDEND,
  -- where there is no per-share price. Carried over from v1.4 as-is.
  price               numeric,
  fee                 numeric not null default 0,
  date                timestamptz not null,
  note                text not null default '',
  broker_rate         numeric,
  wallet_currency     text,
  capture_source      text check (capture_source in ('email','scan')),
  source_capture_text text,
  created_at          timestamptz,
  deleted_at          timestamptz,
  updated_at          timestamptz not null default now(),

  -- Transcribed exactly from PortfolioTransaction.cashEffect
  -- (PortfolioModels.swift:54-65). Positive = cash increased.
  -- IMPORT_HOLDING and REALIZED_ADJUSTMENT are deliberately zero: they record an
  -- existing position and historical realised P&L, neither of which moves cash.
  cash_effect numeric generated always as (
    case type
      when 'BUY'        then -(coalesce(qty, 0) * coalesce(price, 0) + coalesce(fee, 0))
      when 'SELL'       then  (coalesce(qty, 0) * coalesce(price, 0) - coalesce(fee, 0))
      when 'DIVIDEND'   then  coalesce(price, 0)
      when 'FEE'        then -coalesce(fee, 0)
      when 'DEPOSIT'    then  coalesce(price, 0)
      when 'WITHDRAWAL' then -coalesce(price, 0)
      else 0
    end
  ) stored
);

-- Cash as a fact about the ledger rather than a field someone forgot to update.
-- security_invoker so the caller's RLS applies rather than the view owner's.
create view public.portfolio_cash
  with (security_invoker = true)
  as
select
  p.id      as portfolio_id,
  p.user_id,
  coalesce(sum(t.cash_effect), 0) as cash
from public.portfolios p
left join public.portfolio_transactions t
  on t.portfolio_id = p.id
 and t.deleted_at is null
group by p.id, p.user_id;

create index portfolio_transactions_portfolio_date_idx
  on public.portfolio_transactions (portfolio_id, date desc)
  where deleted_at is null;

create index portfolio_transactions_user_date_idx
  on public.portfolio_transactions (user_id, date desc)
  where deleted_at is null;

-- Holdings computation groups by symbol within a portfolio; realized-P&L and
-- price warming both need the distinct symbol set.
create index portfolio_transactions_symbol_idx
  on public.portfolio_transactions (portfolio_id, symbol)
  where deleted_at is null and symbol is not null;

create index portfolios_live_idx
  on public.portfolios (user_id) where deleted_at is null;

create trigger portfolios_set_updated_at
  before update on public.portfolios
  for each row execute function public.set_updated_at();
create trigger portfolio_transactions_set_updated_at
  before update on public.portfolio_transactions
  for each row execute function public.set_updated_at();

comment on column public.portfolio_transactions.cash_effect
  is 'Generated from PortfolioModels.swift:54-65. Sum over live rows = portfolio cash.';
comment on view public.portfolio_cash
  is 'Replaces the denormalised Portfolio.cash field from v1.4, which could drift.';;
