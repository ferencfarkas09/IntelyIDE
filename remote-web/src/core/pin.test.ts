import { describe, expect, it } from "vitest";
import { fakeIndexedDB } from "./fakeIdb";
import { deletePinDb, pinKv, raiseMaxSeq, readPin, writePin } from "./pin";

const A = "gj6A3eugEbxUyaO8e6yHoLj6NIDe32uzYu6xHpTDwOA";
const B = "B".repeat(43);

describe("pin storage", () => {
  it("is empty until a pin is written, then returns it with maxSeq 0", async () => {
    const kv = pinKv(fakeIndexedDB());
    expect(await readPin(kv)).toBeNull();
    expect(await writePin(A, "relay.example", kv)).toEqual({ changed: true, replacedKey: false });
    expect(await readPin(kv)).toEqual({ bundlePub: A, maxSeq: 0, relayHost: "relay.example" });
  });

  it("writing the same pin again changes nothing", async () => {
    const kv = pinKv(fakeIndexedDB());
    await writePin(A, "h", kv);
    expect(await writePin(A, "h", kv)).toEqual({ changed: false, replacedKey: false });
  });

  it("maxSeq only goes up", async () => {
    const kv = pinKv(fakeIndexedDB());
    await writePin(A, "h", kv);
    await raiseMaxSeq(10, kv);
    await raiseMaxSeq(5, kv);
    expect((await readPin(kv))?.maxSeq).toBe(10);
  });

  it("a replaced key starts a fresh sequence history", async () => {
    const kv = pinKv(fakeIndexedDB());
    await writePin(A, "h", kv);
    await raiseMaxSeq(1_790_000_000, kv);
    expect(await writePin(B, "h", kv)).toEqual({ changed: true, replacedKey: true });
    expect((await readPin(kv))?.maxSeq).toBe(0);
  });

  it("deleting the database removes the pin", async () => {
    const f = fakeIndexedDB();
    await writePin(A, "h", pinKv(f));
    await deletePinDb(f);
    expect(await readPin(pinKv(f))).toBeNull();
  });

  it("without indexedDB reading gives null and never throws", async () => {
    expect(await readPin(pinKv(undefined))).toBeNull();
    await expect(deletePinDb(undefined)).resolves.toBeUndefined();
  });
});
