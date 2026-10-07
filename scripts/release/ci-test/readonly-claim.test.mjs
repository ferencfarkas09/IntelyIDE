// Tests of scripts/release/gates/readonly-claim.mjs (G18): the read-only start claim about the packaged app.
import assert from "node:assert/strict";
import test from "node:test";

import { findClaims } from "../gates/readonly-claim.mjs";

const flagged = (s) => findClaims(s).length > 0;

test("claims about the packaged app are flagged", () => {
  assert.ok(flagged("The installed app starts read-only."));
  assert.ok(flagged("The DMG opens read-only until you unlock it."));
  assert.ok(flagged("The release build defaults to read-only mode."));
});

test("a claim without a subject word is flagged (verifier finding)", () => {
  assert.ok(flagged("IntelyIDE starts read-only until you unlock it."));
});

test("a negation far from the claim does not excuse it", () => {
  assert.ok(flagged("There is no telemetry and no account needed, and the installed app starts read-only after every launch."));
});

test("the true statements pass", () => {
  assert.ok(!flagged("The installed app does not start read-only; it starts writable with an alpha notice."));
  assert.ok(!flagged("Read-only is only for pnpm dev:app and INTELY_READONLY from a terminal."));
  assert.ok(!flagged("The development build starts read-only."));
  assert.ok(!flagged("The installed app starts writable."));
  assert.ok(!flagged("A DMG build is not started by that script, so it has no read-only start."));
  assert.ok(!flagged("The default token is read-only; Open workspace X to continue."));
  assert.ok(!flagged("The launcher starts the app read-only."));
});
