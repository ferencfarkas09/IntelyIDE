import { describe, expect, it } from "vitest";
import type * as Rust from "../bindings/mongo";
import type { AiAsk, AiDraft, AiPayload, AiPlan, AiResult } from "./mongoAi";

// Compile-time guard: the UI's own AI interfaces (ipc/mongoAi.ts) must stay assignable to the types generated from the Rust
// structs (`pnpm bindings`). A field renamed or added in `crates/mongo/src/api.rs` makes `tsc` fail here instead of failing at
// run time in the real window.
const ask = (a: AiAsk): Rust.AiAsk => a;
const payload = (p: AiPayload): Rust.AiPayload => p;
const plan = (p: AiPlan): Rust.AiPlan => p;
const draft = (d: AiDraft): Rust.AiDraft => d;
const result = (r: AiResult): Rust.AiResult => r;

describe("ipc.mongoAi against the generated Rust types", () => {
  it("is checked by the compiler (see the assignments above)", () => {
    expect([ask, payload, plan, draft, result]).toHaveLength(5);
  });
});
