#!/usr/bin/env bash
# Cross-check of scripts/ci/lib/mini-yaml.mjs against Ruby's Psych ((design notes: release-ci-spec) 5.7).
# Loads every workflow (real ones under .github and the clean fixtures) with both parsers and compares the JSON.
# Prints SKIP and exits 0 when ruby is not installed. Known, deliberate difference: Psych reads the key `on` as
# boolean true (YAML 1.1); the mini parser follows YAML 1.2, so the Ruby side maps a `true` key back to "on".
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

if ! command -v ruby >/dev/null 2>&1; then
  echo "SKIP: ruby is not installed (psych cross-check not run)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

files=()
for f in "$ROOT"/.github/workflows/*.yml "$ROOT"/.github/dependabot.yml "$HERE"/fixtures/workflows/clean/*.yml; do
  [ -f "$f" ] && files+=("$f")
done

fail=0
n=0
for f in "${files[@]}"; do
  n=$((n + 1))
  ruby -ryaml -rjson -rdate -e '
    def norm(v)
      case v
      when Hash then v.each_with_object({}) { |(k, x), h| h[k == true ? "on" : k.to_s] = norm(x) }
      when Array then v.map { |x| norm(x) }
      when Date, Time then v.to_s
      else v
      end
    end
    src = File.read(ARGV[0])
    doc = begin
      YAML.safe_load(src, permitted_classes: [Date, Time])
    rescue ArgumentError
      YAML.safe_load(src, [Date, Time])
    end
    puts JSON.generate(norm(doc))
  ' "$f" >"$TMP/ruby.json"
  node --input-type=module - "$ROOT/scripts/ci/lib/mini-yaml.mjs" "$f" "$TMP/ruby.json" <<'JS' || { echo "FAIL: $f differs from Psych"; fail=1; }
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
const [lib, file, rubyJson] = process.argv.slice(2);
const { parse } = await import(pathToFileURL(lib).href);
const mine = JSON.parse(JSON.stringify(parse(readFileSync(file, "utf8"))));
const theirs = JSON.parse(readFileSync(rubyJson, "utf8"));
if (!isDeepStrictEqual(mine, theirs)) {
  console.error(JSON.stringify(mine).slice(0, 400));
  console.error(JSON.stringify(theirs).slice(0, 400));
  process.exit(1);
}
JS
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "PASS: mini-yaml matches Psych on $n file(s)"
