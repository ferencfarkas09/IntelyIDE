import { describe, expect, it } from "vitest";
import { cliPromptHint, isRoleRule, refusalHeadline, refusalOf } from "./refusal";

const HOOK = "PreToolUse:Bash hook error: INTELY-HARDSTOP:";

describe("refusalOf", () => {
  it("splits the reason from the hook framing and the (decided by, rule) tag", () => {
    expect(refusalOf(`${HOOK} ../../Router.js is outside the run's folders; Automatic works only inside them. The run's folders are: /w/a, /w/b (roleDeny, exec.auto.outside-jail)`)).toEqual({
      reason: "../../Router.js is outside the run's folders; Automatic works only inside them. The run's folders are: /w/a, /w/b",
      rule: "exec.auto.outside-jail",
    });
    expect(refusalOf(`${HOOK} git add with a glob pathspec can stage unintended files (commit, push and stage-all are done by the human in the IDE) (hardStop, git.add-glob)`)).toEqual({
      reason: "git add with a glob pathspec can stage unintended files (commit, push and stage-all are done by the human in the IDE)",
      rule: "git.add-glob",
    });
  });
  it("reads the CLI-prompt refusal, which has no hook framing", () => {
    const r = refusalOf("INTELY-HARDSTOP: The Claude CLI raised its own safety prompt (Redirect has multiple targets); the IDE does not answer those in Automatic on its own. (hardStop, cli.prompt-denied)");
    expect(r?.rule).toBe("cli.prompt-denied");
    expect(r?.reason).toMatch(/^The Claude CLI raised its own safety prompt/);
  });
  it("keeps the reason when there is no tag, and ignores output that is not a refusal", () => {
    expect(refusalOf(`${HOOK} nothing to say here`)).toEqual({ reason: "nothing to say here" });
    expect(refusalOf("Error: ENOENT")).toBeUndefined();
    expect(refusalOf(undefined)).toBeUndefined();
    expect(refusalOf(`${HOOK}   `)).toBeUndefined();
  });
});

describe("refusalHeadline", () => {
  it("names the common rules in a line", () => {
    expect(refusalHeadline({ reason: "x", rule: "exec.auto.outside-jail" })).toMatch(/Outside the run's folders/);
    expect(refusalHeadline({ reason: "x", rule: "exec.auto.unjudgeable" })).toMatch(/Cannot be checked ahead of time/);
    expect(refusalHeadline({ reason: "x", rule: "git.commit" })).toMatch(/Only you commit/);
    expect(refusalHeadline({ reason: "x", rule: "role.read-only" })).toMatch(/cannot change anything/);
    expect(refusalHeadline({ reason: "x", rule: "cli.prompt-denied" })).toMatch(/Claude CLI asked for approval/);
  });
  it("falls back to the first sentence of the reason, cut to a line", () => {
    expect(refusalHeadline({ reason: "Something odd happened; look at it. And more text." })).toBe("Something odd happened;");
    expect(refusalHeadline({ reason: "word ".repeat(80), rule: "other.rule" }).length).toBeLessThanOrEqual(160);
  });
  it("tells a role rule from a rule of the run", () => {
    expect(isRoleRule("role.deny-list") && isRoleRule("delegate.read-only") && isRoleRule("mcp.not-in-set")).toBe(true);
    expect(isRoleRule("exec.auto.outside-jail") || isRoleRule("git.commit") || isRoleRule(undefined)).toBe(false);
  });
});

describe("cliPromptHint", () => {
  it("rewrites the model-facing message as a sentence for the person", () => {
    const msg = "The Claude CLI raised its own safety prompt (Redirect has multiple targets); the IDE does not answer those in Automatic on its own. Automatic stays inside the run's folders: use Bypass.";
    expect(cliPromptHint(msg)).toBe("The Claude CLI asked for approval itself (Redirect has multiple targets), and a run in Automatic mode cannot answer it. Change files with the Edit or Write tool, keep shell commands simple, or switch the run to Ask.");
  });
  it("leaves any other policy message alone", () => {
    expect(cliPromptHint("The policy asked in an unattended mode (internal error)")).toBeUndefined();
  });
});
