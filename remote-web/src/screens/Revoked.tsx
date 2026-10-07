import { Button } from "@ui/ui-kit/Button";
import { Icon } from "@ui/ui-kit/Icon";
import { Unplug } from "@ui/ui-kit/icons";
import { startOver, state } from "../core/app";

/** S9: removed mid-session. No data, no actions: keys, queue and cache are already gone. */
export default function Revoked() {
  return (
    <main class="screen center-screen" data-testid="revoked">
      <Icon icon={Unplug} size={24} />
      <h1>This device was removed from the Mac</h1>
      <p class="muted">{state.revokedReason || "Pair it again to see your runs."}</p>
      <Button size="lg" variant="primary" onClick={startOver} data-testid="re-pair">
        Pair again
      </Button>
    </main>
  );
}
