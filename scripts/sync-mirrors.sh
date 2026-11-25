#!/usr/bin/env bash
# sync-mirrors.sh — regenerate the GENERATED mirrors from canonical hivvz.
#
#   origin (htmlfarmer/hivvz)  = THE canonical repo — all development lands here
#   hivv                       = generated FULL mirror (clone URLs, CI badge,
#                                issue links keep working)
#   hivv-org (htmlfarmer/hivv.org) = generated WEBSITE mirror: public_html/
#                                becomes the repo root, plus a README that says
#                                "generated — edit hivvz instead"
#
# NEVER push to hivv or hivv.org by hand — this script owns them (MOVES.md).
# A hand-push there is either overwritten by the next sync (website) or makes
# the sync FAIL LOUDLY (full mirror), never silently lost.
#
# Safe to run at any time: it works from committed refs only and uses an
# isolated GIT_INDEX_FILE, so it never disturbs a dirty tree or a staged index.
#
# Usage: scripts/sync-mirrors.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "sync-mirrors: unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

# ── rail: only the canonical repo may generate mirrors ──────────────────────
origin_url=$(git remote get-url origin 2>/dev/null || true)
case "$origin_url" in
  *htmlfarmer/hivvz*) ;;
  *)
    echo "sync-mirrors: REFUSED — origin is '$origin_url', not htmlfarmer/hivvz." >&2
    echo "  Mirrors must be generated from the canonical repo. Fix:" >&2
    echo "    git remote set-url origin git@github.com:htmlfarmer/hivvz.git" >&2
    exit 1 ;;
esac

# fresh clones won't have the mirror remotes yet — add them
git remote get-url hivv >/dev/null 2>&1 || {
  git remote add hivv git@github.com:htmlfarmer/hivv.git
  echo "sync-mirrors: added remote 'hivv'"; }
git remote get-url hivv-org >/dev/null 2>&1 || {
  git remote add hivv-org git@github.com:htmlfarmer/hivv.org.git
  echo "sync-mirrors: added remote 'hivv-org'"; }

echo "==> fetching hivvz..."
git fetch origin --prune
git rev-parse --verify -q refs/remotes/origin/main >/dev/null || {
  echo "sync-mirrors: no origin/main after fetch — refusing to mirror nothing." >&2; exit 1; }

# ── 1. hivv = exact full mirror of hivvz's branches ─────────────────────────
echo "==> hivv  ← full mirror of hivvz"
push_full() {
  if ! git push --prune hivv 'refs/remotes/origin/*:refs/heads/*'; then
    echo "sync-mirrors: hivv push FAILED — the mirror diverged from hivvz." >&2
    echo "  Someone pushed directly to hivv (never do that — it is generated)." >&2
    echo "  Investigate: git fetch hivv && git log --oneline hivv/main..origin/main" >&2
    echo "               git log --oneline origin/main..hivv/main   # stray commits" >&2
    exit 1
  fi
}
if [ "$DRY" = 1 ]; then
  git push --dry-run --prune hivv 'refs/remotes/origin/*:refs/heads/*'
else
  push_full
  if git tag | grep -q .; then git push hivv --tags; fi
  echo "    branches + tags in sync."
fi

# ── 2. hivv-org = website mirror (public_html at the repo root) ─────────────
echo "==> hivv-org ← public_html of origin/main"
split=$(git subtree split --prefix=public_html origin/main)

# Build the mirror tree with an ISOLATED index: GIT_INDEX_FILE points at a
# temp file, so the shared worktree/index (other sessions' staged work!) is
# never touched. Tree = website contents + a README that says "generated"
# + the LICENSE (GPL requires it to travel with the code).
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
readme_sha=$(printf '%s\n' '# hivv.org website — GENERATED MIRROR' '' 'This repository is **generated** from the `public_html/` directory of' '[htmlfarmer/hivvz](https://github.com/htmlfarmer/hivvz) — the canonical repo.' '' '**Do not edit anything here.** Direct changes are overwritten by the next' '`scripts/sync-mirrors.sh` run.' '' '- Edit the website in hivvz → `public_html/`' '- Why three repos exist: see `MOVES.md` in hivvz' '- Regenerate: `scripts/sync-mirrors.sh`' | git hash-object -w --stdin)
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
  # Warn (don't hide) when the mirror tip is neither ours nor GitHub's
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
      # first ever sync: remote has no main to lease against; a plain push
      # still refuses to clobber anything unexpected (non-ff fails loudly)
      git push hivv-org "$commit:main"
    fi
    echo "    pushed website snapshot (public_html @ $(git rev-parse --short origin/main))."
  fi
fi

echo "sync-mirrors: done."
