#!/usr/bin/env bash
# sync-mirrors.sh — regenerate the GENERATED website projection (hivv.org)
# from canonical hivv.
#
#   origin (htmlfarmer/hivv)   = THE canonical repo — all development lands here
#   hivv-org (htmlfarmer/hivv.org) = WEBSITE projection: public_html/ becomes
#                                the repo root, plus a README that says
#                                "generated — edit hivv instead"
#
# History: hivvz was canonical for a few hours (MOVES.md, 2026-11-25) and is
# now ARCHIVED — two identical full copies is exactly the redundancy a mirror
# was meant to avoid. This script's full-mirror half went with it; only the
# website projection remains.
#
# NEVER push to hivv.org by hand — this script owns it. Safe to run anytime:
# committed refs only + an isolated GIT_INDEX_FILE (never disturbs a dirty
# tree or somebody's staged index).
#
# Usage: scripts/sync-mirrors.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "sync-mirrors: unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

# ── rail: only the canonical repo may generate the projection ───────────────
# The '.git' suffix keeps a stale hivvz origin AND the hivv.org URL out.
origin_url=$(git remote get-url origin 2>/dev/null || true)
case "$origin_url" in
  *htmlfarmer/hivv.git*) ;;
  *)
    echo "sync-mirrors: REFUSED — origin is '$origin_url', not htmlfarmer/hivv.git." >&2
    echo "  The projection must be generated from the canonical repo. Fix:" >&2
    echo "    git remote set-url origin git@github.com:htmlfarmer/hivv.git" >&2
    exit 1 ;;
esac

# fresh clones won't have the projection remote yet
git remote get-url hivv-org >/dev/null 2>&1 || {
  git remote add hivv-org git@github.com:htmlfarmer/hivv.org.git
  echo "sync-mirrors: added remote 'hivv-org'"; }

echo "==> fetching hivv..."
git fetch origin --prune
git rev-parse --verify -q refs/remotes/origin/main >/dev/null || {
  echo "sync-mirrors: no origin/main after fetch — refusing to project nothing." >&2
  exit 1; }

# ── hivv-org = website projection (public_html at the repo root) ────────────
echo "==> hivv-org ← public_html of origin/main"
split=$(git subtree split --prefix=public_html origin/main)

# Build the projection tree with an ISOLATED index: GIT_INDEX_FILE points at
# a temp file, so the shared worktree/index (other sessions' staged work!)
# is never touched. Tree = website contents + a README that says "generated"
# + the LICENSE (GPL requires it to travel with the code).
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
readme_sha=$(printf '%s\n' \
'# hivv.org website — GENERATED MIRROR' \
'' \
'This repository is **generated** from the `public_html/` directory of' \
'[htmlfarmer/hivv](https://github.com/htmlfarmer/hivv) — the canonical repo.' \
'' \
'**Do not edit anything here.** Direct changes are overwritten by the next' \
'`scripts/sync-mirrors.sh` run.' \
'' \
'- Edit the website in hivv → `public_html/`' \
'- Why this repo exists: see `MOVES.md` in hivv' \
'- Regenerate: `scripts/sync-mirrors.sh`' | git hash-object -w --stdin)
lic_sha=$(git hash-object -w LICENSE)
GIT_INDEX_FILE="$idx" git read-tree "$split"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$readme_sha,README.md"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$lic_sha,LICENSE"
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
rm -f "$idx"; trap - EXIT

git fetch hivv-org
remote_tree=$(git rev-parse 'hivv-org/main^{tree}' 2>/dev/null || echo none)

if [ "$remote_tree" = "$tree" ]; then
  echo "    already in sync."
else
  # Warn (don't hide) when the projection tip is neither ours nor GitHub's
  # placeholder — i.e. somebody hand-committed to a generated repo.
  tip_msg=$(git log -1 --format=%s hivv-org/main 2>/dev/null || true)
  case "$tip_msg" in
    ''|'Initial commit'|'website mirror:'*) ;;
    *) echo "    WARNING: hivv.org has hand-made commits (overwriting — it is generated):" >&2
       git log --oneline -3 hivv-org/main | sed 's/^/      /' >&2 ;;
  esac

  commit=$(git commit-tree "$tree" -p "$split" \
    -m "website mirror: public_html @ $(git rev-parse --short origin/main)")

  if [ "$DRY" = 1 ]; then
    git push --dry-run --force-with-lease hivv-org "$commit:main"
    echo "    would push website snapshot $(git rev-parse --short "$commit")."
  else
    if git show-ref --verify --quiet refs/remotes/hivv-org/main; then
      git push --force-with-lease hivv-org "$commit:main"
    else
      # first ever projection: no remote main to lease against; a plain push
      # still refuses to clobber anything unexpected (non-ff fails loudly)
      git push hivv-org "$commit:main"
    fi
    echo "    pushed website snapshot (public_html @ $(git rev-parse --short origin/main))."
  fi
fi

echo "sync-mirrors: done."
