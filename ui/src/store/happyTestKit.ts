import { vi } from "vitest";
import { ipc } from "../ipc";
import { startHappyWatch } from "./happy";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Switches the (mock) integrations on, saves a token and starts the watcher: the state the app is in after setup. */
export async function connectHappyForTest(): Promise<() => void> {
  const on = { enabled: true, showInStatusBar: true, allowActions: true };
  await ipc.happy.setConfig({ master: true, timer: on, meet: on });
  await ipc.happy.saveToken(TOKEN);
  vi.spyOn(ipc.settings, "get").mockResolvedValue({ master: true, timer: on, meet: on });
  const stop = startHappyWatch();
  await flush();
  await flush();
  return stop;
}

export async function disconnectHappyForTest(): Promise<void> {
  await ipc.happy.disconnect();
  await ipc.happy.setConfig({ master: false, timer: { enabled: false }, meet: { enabled: false } });
}
