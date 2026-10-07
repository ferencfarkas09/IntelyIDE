import { vi } from "vitest";
import { ipc } from "../ipc";
import type { MockNtSim } from "../ipc/mock/happyNt";
import { startHappyWatch } from "./happy";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const flush = () => new Promise((r) => setTimeout(r, 0));
const on = { enabled: true, showInStatusBar: true, allowActions: true };

/** The mock world's controls: a new notification arrives, the task list changes. */
export const ntSim = (): MockNtSim => (globalThis as { __mockHappyNt?: MockNtSim }).__mockHappyNt!;

/**
 * Switches the (mock) Notifications, Tasks and Time Tracer providers on, saves a token and starts the watcher: the state the
 * app is in after setup. `settings.get` answers per namespace, so the Tasks preferences read as "not set".
 */
export async function connectNtForTest(config: { notifications?: object; tasks?: object; timer?: object } = {}): Promise<() => void> {
  const cfg = { master: true, timer: { ...on, ...config.timer }, notifications: { ...on, ...config.notifications }, tasks: { ...on, ...config.tasks } };
  await ipc.happy.setConfig(cfg);
  await ipc.happy.saveToken(TOKEN);
  vi.spyOn(ipc.settings, "get").mockImplementation(async (ns) => (ns === "happy" ? cfg : {}));
  const stop = startHappyWatch();
  await flush();
  await flush();
  return stop;
}

export async function disconnectNtForTest(): Promise<void> {
  await ipc.happy.disconnect();
  const off = { enabled: false };
  await ipc.happy.setConfig({ master: false, timer: off, meet: off, notifications: { ...off, allowActions: true }, tasks: off });
  ntSim().reset();
}
