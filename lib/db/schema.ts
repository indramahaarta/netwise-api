import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of the NetWise v2 schema.
 *
 * IMPORTANT: the SQL migrations are the source of truth, not this file. The
 * schema was applied as six reviewed migrations (001_foundation through
 * 006_rls_policies) carrying RLS policies, partial indexes, a generated column
 * and a security_invoker view — none of which round-trip cleanly through an ORM
 * introspection. This file exists so queries are typed, not so drizzle-kit can
 * own the schema. Do not run `drizzle-kit push` against this project.
 *
 * Every money and quantity column is `numeric`, and the driver is configured to
 * return NUMERIC as a string (see client.ts). Treat these as decimal strings and
 * do arithmetic in Decimal, never in JS floats.
 */

// ---------------------------------------------------------------------------
// Enum raw values. FROZEN — these strings are persisted in every existing
// user's backup file, so they are a wire contract, not an implementation
// detail. Mirrors NetWise/Models/Enums.swift.
// ---------------------------------------------------------------------------

export const WALLET_TX_TYPES = [
  'INCOME',
  'EXPENSE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'PORTFOLIO_DEPOSIT',
  'PORTFOLIO_WITHDRAWAL',
  'INITIAL_BALANCE',
] as const;
export type WalletTxType = (typeof WALLET_TX_TYPES)[number];

export const PORTFOLIO_TX_TYPES = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'FEE',
  'DEPOSIT',
  'WITHDRAWAL',
  'IMPORT_HOLDING',
  'REALIZED_ADJUSTMENT',
] as const;
export type PortfolioTxType = (typeof PORTFOLIO_TX_TYPES)[number];

export const BUDGET_PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const CAPTURE_SOURCES = ['email', 'scan'] as const;
export const CAPTURE_STATUSES = ['captured', 'needsAttention'] as const;

// ---------------------------------------------------------------------------
// Shared column shapes
// ---------------------------------------------------------------------------

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const userId = () => uuid('user_id').notNull();
const updatedAt = () => tz('updated_at').notNull().defaultNow();

/**
 * created_at is NULLABLE on the v1.4-derived entities, on purpose. The app uses
 * Date.distantPast and nil as sentinels meaning "seeded default, exempt from
 * premium locking", and LimitChecker ranks rows by it to decide which fall past
 * the free-tier ceiling. Defaulting it would re-rank migrated users' data.
 */
const legacyCreatedAt = () => tz('created_at');

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey(),
  mainCurrency: text('main_currency').notNull().default('IDR'),
  /** Every period boundary and daily snapshot is a local-calendar concept. */
  timezone: text('timezone').notNull().default('Asia/Jakarta'),
  periodStartDay: smallint('period_start_day').notNull().default(1),
  weekStartDay: smallint('week_start_day').notNull().default(1),
  hideSensitiveData: boolean('hide_sensitive_data').notNull().default(false),
  netWorthTargetAmount: numeric('net_worth_target_amount'),
  netWorthTargetCurrency: text('net_worth_target_currency'),
  aiCaptureConsentAt: tz('ai_capture_consent_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: updatedAt(),
});

/** Server-side subscription truth. Never trust a client-asserted premium flag. */
export const userEntitlements = pgTable('user_entitlements', {
  userId: uuid('user_id').primaryKey(),
  isPremium: boolean('is_premium').notNull().default(false),
  productId: text('product_id'),
  originalTransactionId: text('original_transaction_id'),
  expiresAt: tz('expires_at'),
  environment: text('environment').$type<'Sandbox' | 'Production'>(),
  lastNotificationAt: tz('last_notification_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Wallet domain
// ---------------------------------------------------------------------------

export const walletGroups = pgTable(
  'wallet_groups',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    name: text('name').notNull(),
    colorHex: text('color_hex').notNull().default('007AFF'),
    icon: text('icon').notNull().default('📁'),
    createdAt: legacyCreatedAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('wallet_groups_user_idx').on(t.userId)],
);

export const walletCategories = pgTable(
  'wallet_categories',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    isIncome: boolean('is_income').notNull().default(false),
    icon: text('icon').notNull().default('🏷️'),
    createdAt: legacyCreatedAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('wallet_categories_user_idx').on(t.userId)],
);

export const walletTags = pgTable(
  'wallet_tags',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    name: text('name').notNull(),
    colorHex: text('color_hex').notNull().default('007AFF'),
    createdAt: legacyCreatedAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('wallet_tags_user_idx').on(t.userId)],
);

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    name: text('name').notNull(),
    currency: text('currency').notNull().default('IDR'),
    groupId: uuid('group_id').references(() => walletGroups.id, { onDelete: 'set null' }),
    isFavorite: boolean('is_favorite').notNull().default(false),
    favoritedAt: tz('favorited_at'),
    isMain: boolean('is_main').notNull().default(false),
    createdAt: legacyCreatedAt(),
    deletedAt: tz('deleted_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('wallets_user_idx').on(t.userId),
    index('wallets_group_idx').on(t.groupId),
    // "Exactly one live main wallet" is a database guarantee here, replacing
    // WalletMainService's launch-time drift repair.
    uniqueIndex('wallets_one_main_per_user_idx')
      .on(t.userId)
      .where(sql`is_main and deleted_at is null`),
  ],
);

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => walletCategories.id, {
      onDelete: 'set null',
    }),
    type: text('type').$type<WalletTxType>().notNull(),
    /**
     * SIGNED. v1.4 encodes direction in the sign — expense, transferOut and
     * portfolioDeposit are stored negative — and every balance is a plain sum
     * over this column. Do not normalise it.
     */
    amount: numeric('amount').notNull(),
    date: tz('date').notNull(),
    note: text('note').notNull().default(''),
    relatedWalletId: uuid('related_wallet_id'),
    relatedPortfolioId: uuid('related_portfolio_id'),
    /** Other half of a transfer or portfolio-deposit pair. No FK: self-referential. */
    pairedTransactionId: uuid('paired_transaction_id'),
    brokerRate: numeric('broker_rate'),
    relatedCurrency: text('related_currency'),
    captureSource: text('capture_source').$type<'email' | 'scan'>(),
    captureStatus: text('capture_status').$type<'captured' | 'needsAttention'>(),
    sourceEmailHash: text('source_email_hash'),
    rawCaptureText: text('raw_capture_text'),
    createdAt: legacyCreatedAt(),
    deletedAt: tz('deleted_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('wallet_transactions_user_idx').on(t.userId),
    index('wallet_transactions_category_idx').on(t.categoryId),
    index('wallet_transactions_wallet_date_idx')
      .on(t.walletId, t.date.desc())
      .where(sql`deleted_at is null`),
    index('wallet_transactions_user_date_idx')
      .on(t.userId, t.date.desc())
      .where(sql`deleted_at is null`),
    index('wallet_transactions_paired_idx')
      .on(t.pairedTransactionId)
      .where(sql`paired_transaction_id is not null`),
  ],
);

export const walletTransactionTags = pgTable(
  'wallet_transaction_tags',
  {
    walletTransactionId: uuid('wallet_transaction_id')
      .notNull()
      .references(() => walletTransactions.id, { onDelete: 'cascade' }),
    walletTagId: uuid('wallet_tag_id')
      .notNull()
      .references(() => walletTags.id, { onDelete: 'cascade' }),
    /** Denormalised so the RLS policy is a column compare, not a subquery. */
    userId: userId(),
  },
  (t) => [
    primaryKey({ columns: [t.walletTransactionId, t.walletTagId] }),
    index('wtt_tag_idx').on(t.walletTagId),
    index('wtt_user_idx').on(t.userId),
  ],
);

export const walletCategoryBudgets = pgTable(
  'wallet_category_budgets',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => walletCategories.id, { onDelete: 'cascade' }),
    period: text('period').$type<BudgetPeriod>().notNull(),
    amount: numeric('amount').notNull(),
    currencyCode: text('currency_code').notNull(),
    lastNotifiedThreshold: integer('last_notified_threshold'),
    lastNotifiedPeriodStart: tz('last_notified_period_start'),
    createdAt: tz('created_at').notNull().defaultNow(),
    deletedAt: tz('deleted_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('wallet_category_budgets_user_idx').on(t.userId),
    index('wallet_category_budgets_cat_idx').on(t.categoryId),
  ],
);

// ---------------------------------------------------------------------------
// Portfolio domain
// ---------------------------------------------------------------------------

export const portfolios = pgTable(
  'portfolios',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    /**
     * Raw market code, or null on v1/v2-era rows. Intentionally unconstrained:
     * an old build stamped everything 'US' regardless of currency, so real data
     * contradicts itself. PortfolioMarket.resolve treats currency as truth.
     *
     * Note there is NO `cash` column — see portfolioCash below.
     */
    market: text('market'),
    createdAt: legacyCreatedAt(),
    deletedAt: tz('deleted_at'),
    updatedAt: updatedAt(),
  },
  (t) => [index('portfolios_user_idx').on(t.userId)],
);

export const portfolioTransactions = pgTable(
  'portfolio_transactions',
  {
    id: uuid('id').primaryKey(),
    userId: userId(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    type: text('type').$type<PortfolioTxType>().notNull(),
    symbol: text('symbol'),
    qty: numeric('qty'),
    /** Overloads as the cash amount for DEPOSIT / WITHDRAWAL / DIVIDEND. */
    price: numeric('price'),
    fee: numeric('fee').notNull().default('0'),
    date: tz('date').notNull(),
    note: text('note').notNull().default(''),
    brokerRate: numeric('broker_rate'),
    walletCurrency: text('wallet_currency'),
    captureSource: text('capture_source').$type<'email' | 'scan'>(),
    sourceCaptureText: text('source_capture_text'),
    createdAt: legacyCreatedAt(),
    deletedAt: tz('deleted_at'),
    updatedAt: updatedAt(),
    /**
     * GENERATED, read-only. Transcribed from PortfolioModels.swift:54-65 and
     * verified against all eight types plus null and fractional operands.
     * Never write to this column.
     */
    cashEffect: numeric('cash_effect').generatedAlwaysAs(
      sql`case type
            when 'BUY'        then -(coalesce(qty, 0) * coalesce(price, 0) + coalesce(fee, 0))
            when 'SELL'       then  (coalesce(qty, 0) * coalesce(price, 0) - coalesce(fee, 0))
            when 'DIVIDEND'   then  coalesce(price, 0)
            when 'FEE'        then -coalesce(fee, 0)
            when 'DEPOSIT'    then  coalesce(price, 0)
            when 'WITHDRAWAL' then -coalesce(price, 0)
            else 0
          end`,
    ),
  },
  (t) => [
    index('portfolio_transactions_user_idx').on(t.userId),
    index('portfolio_transactions_portfolio_date_idx')
      .on(t.portfolioId, t.date.desc())
      .where(sql`deleted_at is null`),
    index('portfolio_transactions_user_date_idx')
      .on(t.userId, t.date.desc())
      .where(sql`deleted_at is null`),
    index('portfolio_transactions_symbol_idx')
      .on(t.portfolioId, t.symbol)
      .where(sql`deleted_at is null and symbol is not null`),
  ],
);

/**
 * Replaces v1.4's denormalised Portfolio.cash, which was mutated from eight-plus
 * call sites and could drift from the ledger with no way to tell which was right.
 */
export const portfolioCash = pgView('portfolio_cash', {
  portfolioId: uuid('portfolio_id'),
  userId: uuid('user_id'),
  cash: numeric('cash'),
}).existing();

// ---------------------------------------------------------------------------
// Snapshots. `date` not timestamptz — a snapshot is a local-calendar day.
// ---------------------------------------------------------------------------

export const walletSnapshots = pgTable(
  'wallet_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    balance: numeric('balance').notNull(),
    balanceUsd: numeric('balance_usd').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_snapshots_one_per_day').on(t.walletId, t.date),
    index('wallet_snapshots_user_date_idx').on(t.userId, t.date),
  ],
);

export const portfolioSnapshots = pgTable(
  'portfolio_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    totalEquity: numeric('total_equity').notNull(),
    totalInvested: numeric('total_invested').notNull(),
    cashBalance: numeric('cash_balance').notNull(),
    unrealized: numeric('unrealized').notNull(),
    realized: numeric('realized').notNull(),
    currency: text('currency').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('portfolio_snapshots_one_per_day').on(t.portfolioId, t.date),
    index('portfolio_snapshots_user_date_idx').on(t.userId, t.date),
  ],
);

// ---------------------------------------------------------------------------
// Job queues. These take snapshot replay off the write path.
// ---------------------------------------------------------------------------

export const snapshotJobs = pgTable(
  'snapshot_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    scope: text('scope').$type<'wallet' | 'portfolio'>().notNull(),
    targetId: uuid('target_id').notNull(),
    fromDate: date('from_date').notNull(),
    status: text('status')
      .$type<'pending' | 'running' | 'done' | 'failed'>()
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: tz('created_at').notNull().defaultNow(),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
  },
  (t) => [
    index('snapshot_jobs_user_idx').on(t.userId),
    // Coalescing key: a burst of edits to one target collapses into one pending
    // job instead of hundreds of overlapping replays.
    uniqueIndex('snapshot_jobs_pending_target_idx')
      .on(t.scope, t.targetId)
      .where(sql`status = 'pending'`),
    index('snapshot_jobs_pending_idx').on(t.createdAt).where(sql`status = 'pending'`),
  ],
);

export const migrationJobs = pgTable(
  'migration_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userId(),
    status: text('status')
      .$type<'pending' | 'importing' | 'replaying' | 'done' | 'failed'>()
      .notNull()
      .default('pending'),
    backupVersion: text('backup_version'),
    /** Raw BackupService v5 document. SELECT is revoked from `authenticated`. */
    payload: jsonb('payload'),
    /** Bookmark so a timed-out chunked run resumes instead of restarting. */
    cursor: jsonb('cursor'),
    expected: jsonb('expected'),
    imported: jsonb('imported'),
    lastError: text('last_error'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
    finishedAt: tz('finished_at'),
  },
  (t) => [index('migration_jobs_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Global market data. NOT per-user — one fetch serves every user. RLS is
// enabled with no policies, so only service_role reaches these.
// ---------------------------------------------------------------------------

export const priceQuotes = pgTable('price_quotes', {
  symbol: text('symbol').primaryKey(),
  price: numeric('price').notNull(),
  currency: text('currency').notNull(),
  source: text('source').notNull().default('yahoo'),
  fetchedAt: tz('fetched_at').notNull().defaultNow(),
  /**
   * Written by the caller, not a fixed TTL: fetched_at + 15 minutes during
   * market hours (matching PriceStore's client TTL, so freshness is unchanged),
   * extended to the next exchange open when closed, because a closed market's
   * price cannot move. Crypto stays on the flat 15.
   */
  expiresAt: tz('expires_at').notNull(),
});

/** Immutable. A closed day's close never changes: written once, read forever. */
export const priceHistory = pgTable(
  'price_history',
  {
    symbol: text('symbol').notNull(),
    date: date('date').notNull(),
    close: numeric('close').notNull(),
    currency: text('currency').notNull(),
    source: text('source').notNull().default('yahoo'),
    fetchedAt: tz('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
);

export const fxRates = pgTable('fx_rates', {
  /** v1.4's existing key format, e.g. 'IDR_USD'. */
  pair: text('pair').primaryKey(),
  fromCurrency: text('from_currency').notNull(),
  toCurrency: text('to_currency').notNull(),
  rate: numeric('rate').notNull(),
  source: text('source').notNull().default('open.er-api.com'),
  fetchedAt: tz('fetched_at').notNull().defaultNow(),
  expiresAt: tz('expires_at').notNull(),
});

/** Snapshot replay converts each past day at that day's rate, not today's. */
export const fxHistory = pgTable(
  'fx_history',
  {
    pair: text('pair').notNull(),
    date: date('date').notNull(),
    rate: numeric('rate').notNull(),
    source: text('source').notNull().default('open.er-api.com'),
    fetchedAt: tz('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pair, t.date] })],
);
