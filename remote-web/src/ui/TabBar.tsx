import { For, Show } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { Icon } from "@ui/ui-kit/Icon";

export interface Tab {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

/** Bottom tab bar: 56 px touch targets, safe-area padding, a count badge, and a clear current marker. */
export function TabBar(props: { tabs: Tab[]; current: string; onSelect: (id: string) => void }) {
  return (
    <nav class="tabbar" aria-label="Main">
      <For each={props.tabs}>
        {(t) => (
          <button type="button" class="tabbar__tab" aria-current={props.current === t.id ? "page" : undefined} onClick={() => props.onSelect(t.id)}>
            <span class="tabbar__icon">
              <Icon icon={t.icon} size={20} />
              <Show when={t.badge}>
                <span class="tabbar__badge" aria-label={`${t.badge} need you`}>
                  {t.badge}
                </span>
              </Show>
            </span>
            <span class="tabbar__label">{t.label}</span>
          </button>
        )}
      </For>
    </nav>
  );
}
