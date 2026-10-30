import { createMemo, createResource, For, Show } from "solid-js";
import { t } from "../../../i18n";
import type { WidgetProps } from "../../../platform/widgets";
import { repos } from "../../../store/workspace";
import { Badge, Button, Sparkles } from "../../../ui-kit";
import { pickTips, readRepoStack, STACK_LABEL, STACK_ORDER, startStarter, type StackTag } from "../stack";
import { CardEmpty, CardLoading } from "../parts";

/** At most this many repositories are looked at (one folder listing and one small file each). */
const MAX_REPOS = 6;

/** Stack tips: the stack the workspace is built with and three starter prompts that fit it, each one click from the New run dialog. */
export default function StackTips(props: WidgetProps) {
  const ids = createMemo(() => repos().slice(0, MAX_REPOS).map((r) => r.id).join("\u0000"));
  const [stacks] = createResource(
    () => [ids(), props.refreshTick()] as const,
    async ([key]) => (key ? Promise.all(key.split("\u0000").map(readRepoStack)) : []),
  );
  const tags = createMemo((): StackTag[] => {
    const all = new Set((stacks.latest ?? []).flatMap((s) => s.tags));
    return STACK_ORDER.filter((x) => all.has(x));
  });
  const tips = createMemo(() => pickTips(tags(), props.size === "l" ? 5 : 3));
  /** A tip goes to the repositories whose stack it is about; general tips leave the scope to the dialog. */
  const reposFor = (): string[] => (stacks.latest ?? []).filter((s) => s.tags.length > 0).map((s) => s.repoId);
  return (
    <Show when={stacks.state !== "unresolved" && stacks.state !== "pending"} fallback={<CardLoading />}>
      <Show when={repos().length > 0} fallback={<CardEmpty icon={Sparkles} title={t("dash.tips.noRepos")} why={t("dash.tips.noReposWhy")} />}>
        <div class="dash-chips" aria-label={t("dash.tips.detected")}>
          <Show when={tags().length > 0} fallback={<span class="dash-hint">{t("dash.tips.unknown")}</span>}>
            <For each={tags()}>{(tag) => <Badge size="sm" tone="accent">{STACK_LABEL[tag]}</Badge>}</For>
          </Show>
        </div>
        <ul class="dash-tips">
          <For each={tips()}>
            {(tip) => (
              <li class="dash-tip">
                <span class="dash-tip__title">{t(tip.title)}</span>
                <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => void startStarter(t(tip.prompt), reposFor())} aria-label={t("dash.tips.startAria", { title: t(tip.title) })}>
                  {t("dash.tips.start")}
                </Button>
              </li>
            )}
          </For>
        </ul>
        <p class="dash-hint">{t("dash.tips.why")}</p>
      </Show>
    </Show>
  );
}
