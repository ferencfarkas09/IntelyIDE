import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const [colors, setColors] = createSignal<Record<string, string>>({});
let started = false;

/** Role name -> colour, from the roles namespace. Loaded once; a backend without roles just leaves the dots neutral. */
export const roleColor = (name: string): string | undefined => colors()[name];

export function loadRoleColors(): void {
  if (started) return;
  started = true;
  ipc.roles
    .list()
    .then((roles) => setColors(Object.fromEntries(roles.filter((r) => r.color).map((r) => [r.name, r.color!]))))
    .catch(() => {
      started = false;
    });
}
