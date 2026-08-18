#!/usr/bin/env node
/**
 * Dump the migrations Supabase has already applied into supabase/migrations/.
 *
 * Why this exists instead of `supabase db pull`:
 *
 *   `db pull` introspects the live schema and GENERATES SQL from it. That
 *   round-trip discards every comment, and in this project the comments are the
 *   point — they record why created_at is nullable (v1.4's premium-gating
 *   sentinels), why wallet_transactions.amount stays signed, why
 *   portfolios.market is unconstrained, and where cash_effect was transcribed
 *   from. Losing that turns a reviewed schema into an inscrutable one.
 *
 *   Supabase stores the exact statements it executed in
 *   supabase_migrations.schema_migrations, comments included. Read those.
 *
 * Also requires no `supabase login` — it connects with the pooler URL the CLI's
 * `link` step already cached, so it works in a non-interactive shell.
 *
 * Usage: npm run db:dump
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import pg from 'pg';

const POOLER_FILE = 'supabase/.temp/pooler-url';
const OUT_DIR = 'supabase/migrations';

if (!existsSync(POOLER_FILE)) {
  console.error(
    `Missing ${POOLER_FILE}. Run:\n  npx supabase link --project-ref <ref>\nfirst.`,
  );
  process.exit(1);
}

// Rewrite 5432 -> 6543. `link` caches the SESSION pooler; we want TRANSACTION
// mode, which is what Supabase assigns to serverless clients.
const connectionString = readFileSync(POOLER_FILE, 'utf8').trim().replace(':5432/', ':6543/');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
} catch (e) {
  console.error(`Could not connect: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const { rows } = await client.query(
  `select version, name, statements
     from supabase_migrations.schema_migrations
    order by version`,
);

if (!rows.length) {
  console.error('No migrations found in supabase_migrations.schema_migrations.');
  await client.end();
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const row of rows) {
  const statements = row.statements ?? [];
  // Supabase strips the trailing semicolon from each statement when it records
  // them, so put it back rather than emitting a file that will not replay.
  const body = statements.map((s) => `${s.trim()};`).join('\n\n') + '\n';
  const file = `${OUT_DIR}/${row.version}_${row.name ?? 'migration'}.sql`;
  writeFileSync(file, body);
  console.log(`${file}  (${(body.length / 1024).toFixed(1)} KB, ${statements.length} statements)`);
}

console.log(`\n${rows.length} migration(s) written to ${OUT_DIR}/`);
await client.end();
