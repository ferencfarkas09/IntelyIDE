import { beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ world: undefined as undefined | import("../../ipc/mock/mongo").MockMongoWorld }));
vi.mock("../../ipc", async () => {
  const { createMockMongoWorld } = await import("../../ipc/mock/mongo");
  hold.world = createMockMongoWorld({ seeded: false, latencyMs: 0 });
  return { ipc: { mongo: hold.world.mongo, mongoAi: hold.world.ai } };
});

import { ipc } from "../../ipc";
import type { ConnSpec, ProfileInput } from "../../ipc/mongo";
import { applyStatus } from "./gate";
import { connIdentity } from "./logic";
import { closeDialogSecrets, connect, dialogScope, dropProfile, hasRemembered, profileById, recallSecrets, refreshProfiles, rememberSecrets, resetStore, upsertProfile, wipeSecrets } from "./store";

const CANARY = "pw-canary-9f3";
const spec = (host = "a.example.com", user = "reader"): ConnSpec => ({ scheme: "standard", hosts: [{ host, port: 27017 }], auth: { mechanism: "default", username: user, source: "admin", savePassword: false }, tls: { mode: "auto" }, tunnel: { kind: "none" } });
const input = (s: ConnSpec): ProfileInput => ({ name: "Acme", environment: "production", spec: s });

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  wipeSecrets();
  resetStore();
  await ipc.mongo.setEnabled(true);
  applyStatus(await ipc.mongo.status());
  for (const p of await ipc.mongo.profiles()) await ipc.mongo.profileDelete(p.id);
});

describe("session secrets", () => {
  it("are keyed by (profile, identity): another destination finds nothing and wipes the entry", () => {
    const a = connIdentity(spec());
    rememberSecrets("p1", a, { password: CANARY });
    expect(recallSecrets("p1", a)).toEqual({ password: CANARY });
    expect(recallSecrets("p1", connIdentity(spec("b.example.com")))).toBeUndefined();
    expect(hasRemembered("p1")).toBe(false);
    expect(recallSecrets("p1", a)).toBeUndefined();
  });

  it("are wiped on switch off, on delete, when the destination changes and when a dialog closes", async () => {
    const p = await ipc.mongo.profileSave(input(spec()));
    await refreshProfiles();
    const id = connIdentity(p.spec!);
    rememberSecrets(p.id, id, { password: CANARY });
    rememberSecrets(dialogScope("d1"), id, { password: CANARY });
    // an upsert with the same destination keeps them, one with another host drops them
    upsertProfile(p);
    expect(hasRemembered(p.id)).toBe(true);
    upsertProfile({ ...p, spec: spec("other.example.com") });
    expect(hasRemembered(p.id)).toBe(false);
    closeDialogSecrets({ dialogId: "d1" });
    expect(hasRemembered(dialogScope("d1"))).toBe(false);
    rememberSecrets(p.id, id, { password: CANARY });
    dropProfile(p.id);
    expect(hasRemembered(p.id)).toBe(false);
    rememberSecrets("p9", id, { password: CANARY });
    resetStore();
    expect(hasRemembered("p9")).toBe(false);
  });

  it("closing a dialog discards its draft-vault entry in Rust", async () => {
    const parsed = await ipc.mongo.uriParse("mongodb://u:pw@db.example.com/x");
    expect(hold.world!.engine.vaultSize()).toBe(1);
    closeDialogSecrets({ dialogId: "d2", draft: parsed.draft });
    await new Promise((r) => setTimeout(r, 5));
    expect(hold.world!.engine.vaultSize()).toBe(0);
  });
});

describe("connect with a password that is not saved", () => {
  it("surfaces the missing secret, remembers what was typed for this session and drops it when the server rejects it", async () => {
    const p = await ipc.mongo.profileSave(input(spec()));
    await refreshProfiles();
    expect(await connect(p.id)).toBe(false);
    const { stateOf } = await import("./store");
    expect(stateOf(p.id)).toMatchObject({ status: "idle", needs: ["password"] });
    expect(await connect(p.id, { secrets: { password: CANARY }, remember: true })).toBe(true);
    expect(hasRemembered(p.id)).toBe(true);
    await disconnectAndWait(p.id);
    expect(await connect(p.id)).toBe(true); // reused without a prompt
    await disconnectAndWait(p.id);
    // the same destination, but the server now says no: the remembered secret is dropped
    await ipc.mongo.profileDelete(p.id);
    dropProfile(p.id);
    const bad = await ipc.mongo.profileSave(input(spec("inject-auth-failed.example.com")));
    await refreshProfiles();
    expect(await connect(bad.id, { secrets: { password: CANARY }, remember: true })).toBe(false);
    expect(hasRemembered(bad.id)).toBe(false);
  });
});

async function disconnectAndWait(id: string) {
  const { disconnect } = await import("./store");
  await disconnect(id);
  applyStatus(await ipc.mongo.status());
}

describe("nothing sensitive reaches web storage, history or the URL", () => {
  it("keeps specs, hosts and passwords out of localStorage, sessionStorage, history.state and location", async () => {
    const parsed = await ipc.mongo.uriParse(`mongodb://reader:${CANARY}@secret-host.example.com:27017/shop`);
    const p = await ipc.mongo.profileSave(input(parsed.spec));
    await refreshProfiles();
    rememberSecrets(p.id, connIdentity(p.spec!), { password: CANARY });
    await connect(p.id, { secrets: { password: CANARY }, remember: true });
    await ipc.mongo.test({ ...input(parsed.spec), password: CANARY });
    const dump = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, history.state, location.href, document.title]);
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain("secret-host");
    expect(profileById(p.id)).toBeDefined();
  });
});
