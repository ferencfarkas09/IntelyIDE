#!/usr/bin/env bash
# Builds four throwaway fixture repos (mirroring the real ones) with bare remotes and a workspace.json.
#
# Usage: scripts/make-fixture-workspace.sh [--dir <empty-or-new-dir>] [--variant default|failures]
# Prints the fixture root on stdout (last line); the app is pointed at it with
#   INTELY_WORKSPACE=<root>/workspace.json
#
#   <root>/remotes/*.git         bare remotes (file transport)
#   <root>/repos/<name>          the work trees: shop-backend, admin, shop-mobile, shop-pos
#   <root>/other/admin           second clone of the admin remote (variant failures: used to make it diverge)
#   <root>/workspace.json
#
# Variants:
#   default   hooks pass; every push is a fast-forward.
#   failures  shop-backend's pre-commit hook fails on its FIRST run only (a retry succeeds), and the admin
#             remote branch `sandbox` has a commit the local clone does not know (push is non-fast-forward).
#
# Nothing here touches the user's real repos or global git config.
set -euo pipefail

ROOT="" VARIANT="default"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) ROOT="$2"; shift 2 ;;
    --variant) VARIANT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$VARIANT" in default | failures) ;; *) echo "unknown variant: $VARIANT" >&2; exit 2 ;; esac
[ -n "$ROOT" ] || ROOT="$(mktemp -d "${TMPDIR:-/tmp}/intely-fixture.XXXXXX")"
mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd -P)"
[ -z "$(ls -A "$ROOT")" ] || { echo "fixture dir is not empty: $ROOT" >&2; exit 2; }
# Safety (docs/safety.md): a fixture lives under the temp dir, never anywhere else (least of all in a real repo).
in_temp() { # <canonical dir>
  local t
  for t in "$(cd "${TMPDIR:-/tmp}" && pwd -P)" /private/tmp /private/var/folders; do
    case "$1" in "$t"/*) return 0 ;; esac
  done
  return 1
}
in_temp "$ROOT" || { rmdir "$ROOT/remotes" "$ROOT/repos" "$ROOT/other" "$ROOT" 2>/dev/null; echo "refusing: fixture root $ROOT is not under the temp dir" >&2; exit 2; }
export INTELY_E2E=1 INTELY_FIXTURE_ROOT="$ROOT"
mkdir -p "$ROOT/remotes" "$ROOT/repos" "$ROOT/other"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME="Fixture User" GIT_AUTHOR_EMAIL="fixture@example.invalid"
export GIT_COMMITTER_NAME="Fixture User" GIT_COMMITTER_EMAIL="fixture@example.invalid"
GIT="$(command -v git)"
git() { "$GIT" "$@"; }

# w <file> <text...>: writes the text (plus newline) to the file, creating directories.
w() { local f="$1"; shift; mkdir -p "$(dirname "$f")"; printf '%s\n' "$*" > "$f"; }
# a <file> <text...>: appends a line.
a() { local f="$1"; shift; printf '%s\n' "$*" >> "$f"; }

# init_repo <name> <remote-name> <branch>: repo + bare remote, base commit on <branch>, upstream set.
init_repo() {
  local name="$1" remote="$2" branch="$3" dir="$ROOT/repos/$1"
  mkdir -p "$dir"
  git init -q -b "$branch" "$dir"
  git -C "$dir" config user.name "Fixture User"
  git -C "$dir" config user.email "fixture@example.invalid"
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config core.ignorecase false
  git init -q --bare -b "$branch" "$ROOT/remotes/$remote.git"
  git -C "$dir" remote add origin "$ROOT/remotes/$remote.git"
}

publish_base() { # <dir> <branch>: first push with upstream
  git -C "$1" add -A
  git -C "$1" commit -q -m "chore: initial import"
  git -C "$1" push -q -u origin "$2" 2>/dev/null
}

commit_all() { git -C "$1" add -A; git -C "$1" commit -q -m "$2"; }

# ---------------------------------------------------------------- shop-backend (sandbox, +1 ahead)
B="$ROOT/repos/shop-backend"
init_repo shop-backend backend sandbox
w "$B/package.json" '{"name":"shop-backend","version":"1.0.0"}'
w "$B/.gitignore" 'node_modules/'
for f in src/api/orders.js src/api/users.js src/api/menu.js src/api/loyalty.js src/lib/db.js src/lib/mail.js \
         src/lib/logger.js src/config/index.js test/orders.test.js docs/api.md; do
  w "$B/$f" "// $f" "module.exports = {};"
done
w "$B/src/api/legacy.js" "// legacy" "module.exports = null;"
w "$B/src/lib/old-name.js" "// renamed soon" "module.exports = {};"
publish_base "$B" sandbox
w "$B/src/api/menu.js" "// src/api/menu.js" "module.exports = { v: 2 };"
commit_all "$B" "feat: menu versioning"   # the one ahead commit
# working-tree changes
a "$B/src/api/orders.js" "exports.cancel = () => true;"
a "$B/src/api/users.js" "exports.disable = () => true;"
a "$B/src/lib/db.js" "exports.pool = 8;"
a "$B/src/lib/mail.js" "exports.retry = 3;"
a "$B/test/orders.test.js" "test('cancel', () => {});"
rm "$B/src/api/legacy.js"
git -C "$B" mv src/lib/old-name.js src/lib/new-name.js           # staged rename
w "$B/src/api/coupons.js" "// coupons" "module.exports = {};"      # staged add
git -C "$B" add src/api/coupons.js
a "$B/src/lib/logger.js" "exports.level = 'info';"                 # partially staged: stage, then edit again
git -C "$B" add src/lib/logger.js
a "$B/src/lib/logger.js" "exports.json = true;"
w "$B/src/api/receipts.js" "// receipts" "module.exports = {};"    # untracked
w "$B/.env" "DATABASE_URL=postgres://fixture:fixture@localhost/fixture"  # untracked, guarded as a secret
w "$B/docs/árvíztűrő-tükörfúrógép.md" "# Árvíztűrő tükörfúrógép"  # untracked, non-ASCII name
w "$B/dump_2026-09-30/orders.json" '[]'                              # untracked never-add directory (collapsed)
w "$B/dump_2026-09-30/users.json" '[]'

# hooks: pre-commit passes, or (variant failures) fails on its first run only
cat > "$B/.git/hooks/pre-commit" <<'HOOK'
#!/bin/sh
marker="$(git rev-parse --absolute-git-dir)/intely-hook-failed-once"
if [ -f "$(git rev-parse --absolute-git-dir)/intely-fail-once" ] && [ ! -f "$marker" ]; then
  : > "$marker"
  echo "pre-commit: eslint found 2 errors in src/api/orders.js" >&2
  exit 1
fi
echo "pre-commit: lint ok"
HOOK
chmod +x "$B/.git/hooks/pre-commit"
[ "$VARIANT" = failures ] && : > "$B/.git/intely-fail-once"

# ---------------------------------------------------------------- admin (feature-light-design, +1 ahead, push target origin/sandbox)
A="$ROOT/repos/admin"
init_repo admin admin feature-light-design
w "$A/package.json" '{"name":"admin","version":"1.0.0"}'
w "$A/.gitignore" 'node_modules/'
for f in src/index.tsx src/App.tsx src/theme/colors.ts src/theme/spacing.ts src/components/Button.tsx src/components/Table.tsx \
         src/components/pages/dashboard/Dashboard.tsx src/components/pages/orders/Orders.tsx \
         src/localization/modules/orders/hu.json src/localization/modules/orders/en.json \
         src/localization/modules/menu/hu.json src/localization/modules/menu/en.json docs/readme.md; do
  w "$A/$f" "// $f"
done
publish_base "$A" feature-light-design
git -C "$A" push -q origin feature-light-design:sandbox 2>/dev/null     # a differently named remote branch
git -C "$A" fetch -q origin
w "$A/src/theme/colors.ts" "// src/theme/colors.ts" "export const bg = '#101114';"
commit_all "$A" "feat(theme): dark surface colours"                      # the one ahead commit
for f in src/index.tsx src/App.tsx src/theme/spacing.ts src/components/Button.tsx src/components/Table.tsx \
         src/components/pages/dashboard/Dashboard.tsx src/components/pages/orders/Orders.tsx \
         src/localization/modules/orders/hu.json src/localization/modules/menu/hu.json; do
  a "$A/$f" "// edited"
done
rm "$A/docs/readme.md"
w "$A/src/components/Card.tsx" "// Card"; git -C "$A" add src/components/Card.tsx   # staged add
# 26 untracked files: two collapsed directories plus plain files
for i in $(seq -w 1 12); do w "$A/src/localization/modules/loyalty/key-$i.json" "{}"; done
for i in $(seq -w 1 10); do w "$A/src/components/pages/loyalty/Part$i.tsx" "// part $i"; done
w "$A/docs/light-design.md" "# Light design"
w "$A/src/theme/tokens.ts" "export const tokens = {};"
w "$A/src/theme/gradients.ts" "export const g = [];"
w "$A/src/theme/shadows.ts" "export const s = [];"
if [ "$VARIANT" = failures ]; then
  git clone -q "$ROOT/remotes/admin.git" "$ROOT/other/admin"
  git -C "$ROOT/other/admin" config user.name "Other Dev"
  git -C "$ROOT/other/admin" config user.email "other@example.invalid"
  git -C "$ROOT/other/admin" checkout -q sandbox
  w "$ROOT/other/admin/docs/changelog.md" "# someone else pushed first"
  commit_all "$ROOT/other/admin" "docs: changelog"
  git -C "$ROOT/other/admin" push -q origin sandbox 2>/dev/null
fi

# ---------------------------------------------------------------- shop-mobile (main, in sync)
S="$ROOT/repos/shop-mobile"
init_repo shop-mobile services main
w "$S/package.json" '{"name":"shop-mobile","version":"1.0.0"}'
w "$S/.gitignore" 'node_modules/'
for f in app/index.tsx app/screens/Home.tsx app/screens/Profile.tsx app/components/Card.tsx app/lib/api.ts; do w "$S/$f" "// $f"; done
w "$S/app/screens/[id].tsx" "// dynamic route"      # glob-looking name
publish_base "$S" main
for f in app/index.tsx app/screens/Home.tsx app/lib/api.ts "app/screens/[id].tsx"; do a "$S/$f" "// edited"; done
w "$S/app/screens/Settings.tsx" "// Settings"; git -C "$S" add app/screens/Settings.tsx
w "$S/app/components/Badge.tsx" "// Badge"

# ---------------------------------------------------------------- shop-pos (SHOP-260, in sync)
P="$ROOT/repos/shop-pos"
init_repo shop-pos pos SHOP-260
w "$P/package.json" '{"name":"shop-pos","version":"1.0.0"}'
w "$P/.gitignore" 'node_modules/'
for f in src/main.js src/pos/receipt.js src/pos/cart.js src/pos/payment.js src/lib/printer.js; do w "$P/$f" "// $f"; done
publish_base "$P" SHOP-260
for f in src/main.js src/pos/receipt.js src/pos/cart.js src/pos/payment.js; do a "$P/$f" "// edited"; done
rm "$P/src/lib/printer.js"
w "$P/src/pos/receipt.test.js" "// receipt test"

# ---------------------------------------------------------------- workspace.json
cat > "$ROOT/workspace.json" <<JSON
{
  "version": 1,
  "repos": [
    { "id": "shop-backend", "path": "$B", "name": "shop-backend", "color": "#4caf7d", "badge": "SB", "order": 0, "pushTargets": {} },
    { "id": "admin", "path": "$A", "name": "admin", "color": "#8b6cf0", "badge": "AD", "order": 1,
      "pushTargets": { "feature-light-design": { "remote": "origin", "branch": "sandbox" } } },
    { "id": "shop-mobile", "path": "$S", "name": "shop-mobile", "color": "#f0a23a", "badge": "SM", "order": 2, "pushTargets": {} },
    { "id": "shop-pos", "path": "$P", "name": "shop-pos", "color": "#3b9ae8", "badge": "SP", "order": 3, "pushTargets": {} }
  ],
  "protectedBranches": ["main", "master", "production", "release/*"],
  "settings": { "messageMode": "shared", "untrackedChecked": false }
}
JSON

echo "$ROOT"
