// node --test scripts/release/generic-users.test.mjs
// verify-public-tree and the publish scanner must accept the same generic example users: one shared list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GENERIC_USERS } from "../licenses/publish-scan.mjs";

test("the shared generic-user list holds the documented example users", () => {
  for (const u of ["anna", "demo", "jdoe", "bob", "example", "you", "me", "x"]) assert.ok(GENERIC_USERS.includes(u), u);
});

test("verify-public-tree builds its generic-user pattern from the scanner's list", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "verify-public-tree.mjs"), "utf8");
  assert.match(src, /import \{ GENERIC_USERS \} from "\.\.\/licenses\/publish-scan\.mjs"/);
  assert.match(src, /GENERIC_USERS\.join\("\|"\)/);
});
