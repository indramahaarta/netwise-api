#!/usr/bin/env bash
# Build the Supabase TRANSACTION-pooler connection string and push it to Vercel.
#
# You only supply the database password. Every other component is already known:
#
#   user  postgres.itkyospywqydgtahohhq   (postgres.<project-ref>)
#   host  aws-0-ap-southeast-1.pooler.supabase.com
#   port  6543                            (transaction mode — for serverless.
#                                          5432 is session mode; the CLI's
#                                          `link` caches that one, which is why
#                                          it must not be copied blindly.)
#   db    postgres
#
# The password is read with `read -s`, so it is never echoed, never written to
# shell history, and never appears in any log. It is URL-encoded before being
# embedded, because Supabase-generated passwords routinely contain characters
# that would otherwise corrupt the URI.
#
# Get a password from:
#   Supabase dashboard -> Project Settings -> Database -> Reset database password
#
# Usage: bash scripts/set-database-url.sh

set -euo pipefail

PROJECT_REF="itkyospywqydgtahohhq"
POOLER_HOST="aws-0-ap-southeast-1.pooler.supabase.com"
POOLER_PORT="6543"

printf 'Supabase database password (input hidden): '
read -rs DB_PASSWORD
printf '\n'

if [ -z "${DB_PASSWORD}" ]; then
  echo "No password entered. Aborting." >&2
  exit 1
fi

# Percent-encode everything that is not unreserved, so '@', ':', '/', '#', '?'
# and friends cannot break the URI.
ENCODED=$(DB_PASSWORD="${DB_PASSWORD}" python3 -c \
  'import os,urllib.parse;print(urllib.parse.quote(os.environ["DB_PASSWORD"], safe=""))')

DATABASE_URL="postgresql://postgres.${PROJECT_REF}:${ENCODED}@${POOLER_HOST}:${POOLER_PORT}/postgres"

# Sanity-check the URL parses and carries a password, before shipping it anywhere.
DATABASE_URL="${DATABASE_URL}" python3 - <<'PY'
import os, sys
from urllib.parse import urlsplit
p = urlsplit(os.environ["DATABASE_URL"])
problems = []
if not p.password:
    problems.append("no password present")
if p.port != 6543:
    problems.append(f"port is {p.port}, expected 6543 (transaction mode)")
if not p.hostname or "pooler.supabase.com" not in p.hostname:
    problems.append(f"host looks wrong: {p.hostname}")
if problems:
    print("Refusing to continue: " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"OK  user={p.username}  host={p.hostname}  port={p.port}  password={len(p.password)} chars")
PY

# Cache it for scripts/dump-migrations.mjs, which reads this file. Gitignored.
mkdir -p supabase/.temp
printf '%s' "${DATABASE_URL}" > supabase/.temp/pooler-url
chmod 600 supabase/.temp/pooler-url
echo "wrote supabase/.temp/pooler-url (0600, gitignored)"

# Verify it actually connects before putting it in Vercel — a bad value in the
# env is much harder to notice than a failure here.
echo "testing connection..."
DATABASE_URL="${DATABASE_URL}" node -e '
const pg = require("pg");
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
c.connect()
  .then(() => c.query("select current_user, inet_server_port() as port"))
  .then((r) => { console.log("  connected:", r.rows[0]); return c.end(); })
  .catch((e) => { console.error("  FAILED:", e.message); process.exit(1); });
'

for ENV in preview production; do
  echo "setting DATABASE_URL for ${ENV}..."
  npx vercel env rm DATABASE_URL "${ENV}" --yes >/dev/null 2>&1 || true
  printf '%s' "${DATABASE_URL}" | npx vercel env add DATABASE_URL "${ENV}"
done

echo
echo "Done. Next: npm run db:dump   (writes the six migrations into supabase/migrations/)"
