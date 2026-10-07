import { createMemo, createSignal, For, Show } from "solid-js";
import { Button, Check, FormGroup, FormRow, Input, Monitor, Moon, SegmentedControl, Select, Sun, resolvedTheme, themePreference, setThemePreference, type ThemePreference } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { ACCENTS, CUSTOM_ACCENT, customFamily, accentTokens, normalizeHex, swatchColor, tokensFor } from "../../theme/accents";
import { applyAppearance, saveMirror } from "./appearance";
import { FONT_LIMITS, normalizeAppearance, NS, type AppearanceSettings, type Density } from "./model";
import { useNamespace } from "./namespace";
import "./settings-core.css";
import "./appearance.css";

const range = ({ min, max }: { min: number; max: number }) => Array.from({ length: max - min + 1 }, (_, i) => String(min + i));

const ids = [...ACCENTS.map((a) => a.id), CUSTOM_ACCENT];

/** Sample card: it reads the same variables as the rest of the UI, so it always shows what the accent really looks like. */
function AccentSample() {
  return (
    <div class="sc-sample" role="group" aria-label={t("accent.sampleLabel")}>
      <strong class="sc-sample__title">{t("accent.sampleTitle")}</strong>
      <p class="sc-sample__text">{t("accent.sampleText")}</p>
      <div class="sc-sample__row">
        <Button size="sm" variant="primary" tabIndex={-1}>{t("accent.sampleButton")}</Button>
        <span class="sc-sample__link">{t("accent.sampleLink")}</span>
        <span class="sc-sample__chip">{t("accent.sampleChip")}</span>
        <span class="sc-sample__ring" aria-hidden="true">Aa</span>
      </div>
      <div class="sc-sample__selected">{t("accent.sampleSelected")}</div>
    </div>
  );
}

export default function AppearanceSection() {
  const appearance = useNamespace(NS.appearance, normalizeAppearance, (next: AppearanceSettings, raw) => {
    applyAppearance(next);
    saveMirror(next);
    if (raw.theme !== undefined && themePreference() !== next.theme) setThemePreference(next.theme);
  });
  const set = (patch: Partial<AppearanceSettings>) => void appearance.update(patch);
  const sizeOptions = (limits: { min: number; max: number }) => range(limits).map((v) => ({ value: v, label: t("appearance.px", { value: Number(v) }) }));

  const accent = () => appearance.value().accent;
  const custom = () => appearance.value().customAccent;
  const [draft, setDraft] = createSignal<string | null>(null);
  const hexText = () => draft() ?? custom();
  const hexInvalid = () => draft() !== null && !normalizeHex(draft()!);
  /** What the custom colour really becomes in this theme once the lightness is solved for contrast. */
  const adjusted = createMemo(() => {
    const fam = customFamily(custom());
    return fam ? accentTokens(fam, resolvedTheme())["--accent"] : custom();
  });
  const inkFor = (id: string) => tokensFor(id, custom(), resolvedTheme())["--text-on-accent"] ?? "#ffffff";
  const accentName = (id: string) => t(`accent.${id}` as MessageKey);

  /** Live (DOM only) while dragging in the picker or typing; stored when the choice is committed. */
  const previewCustom = (hex: string) => applyAppearance({ ...appearance.value(), accent: CUSTOM_ACCENT, customAccent: hex });
  const commitCustom = (raw: string) => {
    const hex = normalizeHex(raw);
    if (hex) (setDraft(null), set({ accent: CUSTOM_ACCENT, customAccent: hex }));
  };

  let grid: HTMLDivElement | undefined;
  const onGridKey = (e: KeyboardEvent) => {
    const rtl = getComputedStyle(grid!).direction === "rtl";
    const forward = e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight");
    const backward = e.key === "ArrowUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft");
    const at = ids.indexOf(accent());
    const next = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : forward ? (at + 1) % ids.length : backward ? (at - 1 + ids.length) % ids.length : -1;
    if (next < 0) return;
    e.preventDefault();
    set({ accent: ids[next] });
    queueMicrotask(() => grid?.querySelector<HTMLElement>(`[data-accent="${ids[next]}"]`)?.focus());
  };

  return (
    <div class="sc-section">
      <FormGroup>
        <FormRow label={t("appearance.theme")} description={t("appearance.themeDesc")}>
          <SegmentedControl<ThemePreference>
            size="sm"
            aria-label={t("appearance.theme")}
            value={themePreference()}
            onChange={(theme) => set({ theme })}
            options={[
              { value: "system", label: t("theme.system"), icon: Monitor },
              { value: "dark", label: t("theme.dark"), icon: Moon },
              { value: "light", label: t("theme.light"), icon: Sun },
            ]}
          />
        </FormRow>
        <FormRow label={t("appearance.accent")} description={t("appearance.accentDesc")} stacked>
          <div class="sc-accentpick">
            <div class="sc-swatches" role="radiogroup" aria-label={t("appearance.accent")} ref={grid} onKeyDown={onGridKey}>
              <For each={ids}>
                {(id) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={accent() === id}
                    tabIndex={accent() === id ? 0 : -1}
                    class="sc-swatch"
                    data-accent={id}
                    data-custom={id === CUSTOM_ACCENT ? "" : undefined}
                    style={id === CUSTOM_ACCENT ? { "--sw": swatchColor(id, custom(), resolvedTheme()), "--sw-ink": inkFor(id) } : { "--sw": swatchColor(id, undefined, resolvedTheme()), "--sw-ink": inkFor(id) }}
                    onClick={() => set({ accent: id })}
                  >
                    <span class="sc-swatch__dot">{accent() === id && <Check size={14} strokeWidth={2.6} />}</span>
                    <span class="sc-swatch__name ui-truncate">{accentName(id)}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={accent() === CUSTOM_ACCENT}>
              <div class="sc-custom">
                <input
                  type="color"
                  class="sc-custom__picker"
                  aria-label={t("accent.customPicker")}
                  value={custom()}
                  onInput={(e) => previewCustom(e.currentTarget.value)}
                  onChange={(e) => commitCustom(e.currentTarget.value)}
                />
                <Input
                  size="sm"
                  class="sc-custom__hex"
                  aria-label={t("accent.hexLabel")}
                  dir="ltr"
                  spellcheck={false}
                  autocomplete="off"
                  maxLength={7}
                  invalid={hexInvalid()}
                  value={hexText()}
                  onInput={(e) => {
                    setDraft(e.currentTarget.value);
                    const hex = normalizeHex(e.currentTarget.value);
                    if (hex) previewCustom(hex);
                  }}
                  onChange={(e) => (normalizeHex(e.currentTarget.value) ? commitCustom(e.currentTarget.value) : setDraft(null))}
                />
                <Show when={hexInvalid()}>
                  <p class="repolist__problem" role="alert">{t("accent.invalid")}</p>
                </Show>
                <Show when={!hexInvalid() && adjusted() !== custom()}>
                  <p class="sc-muted sc-custom__note">{t("accent.adjusted", { color: adjusted() })}</p>
                </Show>
              </div>
            </Show>
            <AccentSample />
          </div>
        </FormRow>
        <FormRow label={t("appearance.density")} description={t("appearance.densityDesc")}>
          <SegmentedControl<Density>
            size="sm"
            aria-label={t("appearance.density")}
            value={appearance.value().density}
            onChange={(density) => set({ density })}
            options={[
              { value: "comfortable", label: t("appearance.comfortable") },
              { value: "compact", label: t("appearance.compact") },
            ]}
          />
        </FormRow>
      </FormGroup>
      <FormGroup title={t("appearance.text")}>
        <FormRow label={t("appearance.uiSize")} description={t("appearance.uiSizeDesc")}>
          <Select size="sm" aria-label={t("appearance.uiSize")} options={sizeOptions(FONT_LIMITS.ui)} value={String(appearance.value().uiFontSize)} onChange={(v) => set({ uiFontSize: Number(v) })} />
        </FormRow>
        <FormRow label={t("appearance.codeSize")} description={t("appearance.codeSizeDesc")}>
          <Select size="sm" aria-label={t("appearance.codeSize")} options={sizeOptions(FONT_LIMITS.code)} value={String(appearance.value().codeFontSize)} onChange={(v) => set({ codeFontSize: Number(v) })} />
        </FormRow>
        <FormRow label={t("appearance.preview")} stacked>
          <pre class="sc-preview" dir="ltr" aria-label={t("appearance.previewAria")}>{"const total = items.reduce((sum, i) => sum + i.price, 0);\n// Árvíztűrő tükörfúrógép"}</pre>
        </FormRow>
      </FormGroup>
    </div>
  );
}
