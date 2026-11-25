#!/usr/bin/env bash
# deploy.sh — bring the LIVE gateway tree (/var/www/vhosts/hivv.org) up to
# date from canonical hivv and restart safely.
#
# The only supported way to change production:
#   commit → push to hivv (from ANY machine) → run this on the gateway box.
# Never edit this tree by hand — see MOVES.md / CONTRIBUTING.md.
#
# Order: rails → fetch → merge --ff-only → new migrations → deps if changed →
#        pm2 restart → health poll → pytest gate. A red test gate or a dead
#        health check ROLLS BACK automatically (the tree was clean, so
#        reset --hard is exact). Migrations are forward-only and NOT reverted.
#
# Usage: scripts/deploy.sh [--dry-run] [--fast]
#   --dry-run  show incoming commits and the plan; change nothing
#   --fast     skip the pytest gate (health check still runs)
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0 FAST=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --fast) FAST=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "deploy: unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

# ── rail 1: only canonical hivv deploys here ────────────────────────────────
# The '.git' suffix keeps a stale hivvz origin AND the hivv.org URL out.
origin_url=$(git remote get-url origin 2>/dev/null || true)
case "$origin_url" in
  *htmlfarmer/hivv.git*) ;;
  *)
    echo "deploy: REFUSED — origin is '$origin_url', not htmlfarmer/hivv.git." >&2
    echo "  Production only deploys from the canonical repo. Fix:" >&2
    echo "    git remote set-url origin git@github.com:htmlfarmer/hivv.git" >&2
    exit 1 ;;
esac

# ── rail 2: deploy from main only ───────────────────────────────────────────
branch=$(git symbolic-ref --short -q HEAD || echo DETACHED)
if [ "$branch" != main ]; then
  echo "deploy: REFUSED — on '$branch', production deploys from 'main'." >&2
  echo "  Merge your work to main first (see CONTRIBUTING.md)." >&2
  exit 1
fi

# ── rail 3: never deploy a dirty tree ───────────────────────────────────────
# Uncommitted work (staged OR unstaged OR untracked) means somebody is still
# building something — deploying around it would run a state no clone has.
dirty=$(git status --porcelain || true)
if [ -n "$dirty" ]; then
  n=$(printf '%s\n' "$dirty" | wc -l)
  {
    echo "deploy: REFUSED — $n uncommitted file(s) in the production tree:"
    printf '%s\n' "$dirty" | head -15 | sed 's/^/    /'
    [ "$n" -gt 15 ] && echo "    ... and $((n - 15)) more"
    echo "  Work happens in clones/worktrees; the production tree stays clean."
    echo "  Commit here (git add -A && git commit) or move the work out first."
  } >&2
  exit 1
fi

echo "==> fetching hivv..."
git fetch origin --prune

ahead=$(git rev-list --count origin/main..HEAD)
if [ "$ahead" -gt 0 ]; then
  echo "deploy: REFUSED — local main has $ahead commit(s) not on hivv." >&2
  echo "  Push them first (git push origin main), or discard them" >&2
  echo "  (git reset --hard origin/main) — production runs published code only." >&2
  exit 1
fi

incoming=$(git rev-list --count HEAD..origin/main)
if [ "$incoming" -eq 0 ]; then
  echo "Already up to date with origin/main ($(git rev-parse --short HEAD))."
  echo "Mirrors refresh separately: scripts/sync-mirrors.sh"
  exit 0
fi

echo "==> $incoming new commit(s) incoming:"
git log --oneline HEAD..origin/main | sed 's/^/    /'

if [ "$DRY" = 1 ]; then
  echo "==> dry run — stopping before the merge."
  new_migs=$(git diff --name-only HEAD origin/main -- 'api/migrations/*.sql' || true)
  [ -n "$new_migs" ] && { echo "    new migrations would run:"; printf '%s\n' "$new_migs" | sed 's/^/      /'; }
  if git diff --name-only HEAD origin/main -- api/package.json api/package-lock.json | grep -q .; then
    echo "    dependency change detected → npm ci would run"
  fi
  echo "    then: pm2 restart → health poll → pytest gate (--fast skips)."
  exit 0
fi

old_sha=$(git rev-parse HEAD)

echo "==> fast-forwarding to origin/main..."
git merge --ff-only origin/main

# ── new migrations (forward-only; applied like setup.sh applies them) ───────
new_migs=$(git diff --name-only "$old_sha" HEAD -- 'api/migrations/*.sql' || true)
if [ -n "$new_migs" ]; then
  echo "==> new migrations:"
  printf '%s\n' "$new_migs" | sed 's/^/    /'
  pw="${HIVV_DB_PASSWORD:-}"
  if [ -z "$pw" ] && [ -f .db-password ]; then pw=$(cat .db-password); fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "    psql not installed — skipping (local-first mode)." >&2
  elif [ -z "$pw" ]; then
    echo "    no DB password (${HIVV_DB_PASSWORD} / .db-password) — skipping." >&2
    echo "    If this box has a database, apply them by hand:" >&2
    printf '%s\n' "$new_migs" | sed 's/^/      psql -f /' >&2
  else
    while IFS= read -r mig; do
      [ -n "$mig" ] || continue
      mlog=$(mktemp)
      if PGPASSWORD="$pw" psql -h "${DB_HOST:-localhost}" -U "${DB_USER:-hivv}" \
           -d "${DB_NAME:-hivv}" -f "$mig" >"$mlog" 2>&1; then
        echo "    applied: $mig"
      else
        # setup.sh's stance: some items may already exist — warn, don't die
        echo "    WARNING: $mig had issues (some items may already exist):" >&2
        grep -i error "$mlog" | head -3 | sed 's/^/      /' >&2 || true
      fi
      rm -f "$mlog"
    done <<< "$new_migs"
  fi
fi

# ── deps ────────────────────────────────────────────────────────────────────
if git diff --name-only "$old_sha" HEAD -- api/package.json api/package-lock.json | grep -q .; then
  echo "==> dependencies changed → npm ci"
  (cd api && npm ci --silent --no-audit --no-fund || npm install --silent --no-audit --no-fund)
fi

rollback() {
  echo "deploy: rolling back to $old_sha..." >&2
  git reset --hard "$old_sha" >/dev/null
  pm2 restart hivv-ai-gateway >/dev/null 2>&1 || true
  sleep 2
  if curl -fsS -m 3 http://localhost:3011/api/health >/dev/null 2>&1; then
    echo "deploy: rolled back — gateway healthy on the previous code." >&2
  else
    echo "deploy: ROLLBACK DID NOT RESTORE HEALTH — see: pm2 logs hivv-ai-gateway" >&2
  fi
  echo "deploy: NOTE — migrations are forward-only and were NOT reverted:" >&2
  printf '%s\n' "$new_migs" | sed 's/^/    /' >&2 || true
  exit 1
}

echo "==> restarting gateway (pm2)..."
if ! pm2 restart hivv-ai-gateway >/dev/null 2>&1; then
  echo "deploy: pm2 restart FAILED — is pm2 running? Try: ./restart.sh" >&2
  pm2 logs hivv-ai-gateway --lines 30 --nostream >&2 || true
  exit 1
fi

echo "==> waiting for health on :3011..."
healthy=0
for _ in $(seq 1 15); do
  if curl -fsS -m 3 http://localhost:3011/api/health >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 2
done
if [ "$healthy" != 1 ]; then
  echo "deploy: HEALTH CHECK FAILED — gateway not answering after restart." >&2
  pm2 logs hivv-ai-gateway --lines 40 --nostream >&2 || true
  rollback
fi
echo "    healthy."

if [ "$FAST" = 1 ]; then
  echo "==> test gate SKIPPED (--fast)."
else
  echo "==> test gate: python3 -m pytest tests/ -q"
  if ! python3 -m pytest tests/ -q; then
    echo "deploy: TESTS FAILED on the new code." >&2
    rollback
  fi
fi

echo "deploy: OK — now at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))."
echo "Mirrors refresh separately: scripts/sync-mirrors.sh"
