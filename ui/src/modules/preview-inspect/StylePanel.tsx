import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { execute } from "../../platform/commands";
import { requestNewRun } from "../../platform/newRun";
import { errorText } from "../../store/snapshots";
import { Button, IconButton, Search, Sparkles, toast, X } from "../../ui-kit";
import { webtoolsApi } from "../webtools/api";
import type { RuleMatch } from "../webtools/types";
import { webtoolsEnabled } from "../webtools/toggle";
import { describe, restylePrompt, SHOWN } from "./styleLogic";
import { setStyleInfo, styleInfo } from "./state";

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9a-z.,%/ -]{1,50}\))$/i;
const isTransparent = (v: string) => /^rgba\(0,\s*0,\s*0,\s*0\)$/.test(v) || v === "transparent";

/** The small panel under an Alt-click: key computed styles, "Find the CSS rule" and "Ask agent to restyle this". */
export default function StylePanel() {
  const [matches, setMatches] = createSignal<RuleMatch[]>();
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string>();

  const close = () => (setStyleInfo(undefined), setMatches(undefined), setNote(undefined));

  async function open(m: RuleMatch, repoId: string) {
    const ok = await execute("editor.openFile", { repoId, path: m.file, line: m.line, column: 1 });
    if (!ok) toast.warn(t("pvi.editorNA"));
  }

  async function find() {
    const info = styleInfo();
    if (!info?.repoId) return setNote(t("webtools.inspect.noRepo"));
    setBusy(true);
    setNote(undefined);
    try {
      const found = await webtoolsApi().findRule(info.repoId, { tag: info.hint.tag, id: info.hint.id, classes: info.hint.classes });
      setMatches(found);
      if (found.length === 0) setNote(t("webtools.inspect.noRule"));
      else await open(found[0]!, info.repoId);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function restyle() {
    const info = styleInfo();
    if (!info) return;
    const ok = await requestNewRun({ prompt: restylePrompt(info.hint), repoIds: info.repoId ? [info.repoId] : [] });
    if (!ok) toast.warn(t("webtools.ask.unavailable"));
  }

  return (
    <Show when={webtoolsEnabled() && styleInfo()}>
      {(info) => (
        <aside class="pi__style" role="dialog" aria-label={t("webtools.inspect.title")} data-testid="pi-style">
          <header class="pi__shead">
            <code class="pi__sel" title={describe(info().hint)}>{describe(info().hint)}</code>
            <span class="pi__size">{info().hint.width}×{info().hint.height}</span>
            <IconButton icon={X} label={t("webtools.inspect.close")} size="sm" onClick={close} />
          </header>
          <dl class="pi__styles">
            <For each={SHOWN.filter((s) => info().hint.styles[s.key])}>
              {(s) => (
                <>
                  <dt>{s.label}</dt>
                  <dd>
                    <Show when={(s.key === "color" || s.key === "background-color") && SAFE_COLOR.test(info().hint.styles[s.key]!) && !isTransparent(info().hint.styles[s.key]!)}>
                      <span class="pi__sw" style={{ background: info().hint.styles[s.key] }} aria-hidden="true" />
                    </Show>
                    {info().hint.styles[s.key]}
                  </dd>
                </>
              )}
            </For>
          </dl>
          <div class="pi__acts">
            <Button size="sm" variant="secondary" icon={Search} loading={busy()} onClick={() => void find()}>
              {t("webtools.inspect.find")}
            </Button>
            <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => void restyle()}>
              {t("webtools.inspect.restyle")}
            </Button>
          </div>
          <Show when={note()}>
            <p class="pi__note">{note()}</p>
          </Show>
          <Show when={(matches()?.length ?? 0) > 1 && info().repoId}>
            <ul class="pi__matches" aria-label={t("webtools.inspect.matches")}>
              <For each={matches()!.slice(0, 6)}>
                {(m) => (
                  <li>
                    <button type="button" class="pi__match" onClick={() => void open(m, info().repoId!)}>
                      <code>{m.selector}</code>
                      <span>{m.file}:{m.line}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <p class="pi__fine">{t("webtools.inspect.noShot")}</p>
        </aside>
      )}
    </Show>
  );
}
