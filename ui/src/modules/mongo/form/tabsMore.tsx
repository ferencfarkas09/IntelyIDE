import { createSignal, For, Index, Show } from "solid-js";
import { t } from "../../../i18n";
import type { AiMode, Compressor } from "../../../bindings/mongo";
import { Badge, Button, Copy, EnvPill, Input, Lock, Plus, ShieldCheck, Switch, toast, Trash2, X } from "../../../ui-kit";
import { levelLabel, readOnlyUserCommand, roleView } from "../logic";
import { useForm } from "./controller";
import { Field, SelectField, TextField } from "./fields";
import { EXTRA_DEFS, extraDef } from "./model";
import { LegacyLock, num } from "./tabsConn";

const KNOWN_NOTES = new Set(["ignoredReadOnly", "duplicate", "relativePath", "unsupportedInBuild", "tlsRelaxRequested", "placeholderPassword", "placeholderUsername", "unknownCompressor", "authMechanism", "authMechanismProperties", "gssapi", "proxy", "autoEncryption", "unknownOption"]);
export const noteText = (code: string): string => t(`mongoForm.note.${KNOWN_NOTES.has(code) ? code : "other"}` as never);

// --- Advanced ---------------------------------------------------------------------------------------------------------------

export function AdvancedTab() {
  const f = useForm();
  const comps: Compressor[] = ["zstd", "zlib", "snappy"];
  const has = (c: Compressor) => f.s.spec.compressors.includes(c);
  const toggle = (c: Compressor) => f.setS("spec", "compressors", (cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  const secs = (ms: number | null | undefined) => (ms != null ? String(Math.round(ms / 1000)) : "");
  const unusedKeys = () => EXTRA_DEFS.filter((d) => !f.s.spec.extra.some((e) => e.key.toLowerCase() === d.key.toLowerCase()));
  const notes = () => [
    ...f.notes().unsupported.map((n) => ({ n, kind: "unsupported" as const })),
    ...f.notes().warnings.map((n) => ({ n, kind: "warning" as const })),
    ...f.notes().info.map((n) => ({ n, kind: "info" as const })),
    ...f.dropped().map((n) => ({ n, kind: "dropped" as const })),
  ];
  const ms = (v: string) => (num(v) != null ? num(v)! * 1000 : null);
  return (
    <LegacyLock>
      <div class="mgf-stack">
        <Field label={t("mongoForm.adv.compression")}>
          {() => (
            <div class="mgf-chips" role="group" aria-label={t("mongoForm.adv.compression")}>
              <For each={comps}>{(c) => <button type="button" class="mgf-toggle" aria-pressed={has(c)} onClick={() => toggle(c)}>{c}</button>}</For>
            </div>
          )}
        </Field>
        <div class="mgf-grid2">
          <TextField path="timeouts.connectMs" label={t("mongoForm.adv.connectTimeout")} hint={t("mongoForm.adv.timeoutHint")} inputmode="numeric" placeholder="10" value={secs(f.s.spec.timeouts.connectMs)} onInput={(v) => f.setS("spec", "timeouts", "connectMs", ms(v))} trailing={<span class="ui-text-3">s</span>} />
          <TextField path="timeouts.serverSelectionMs" label={t("mongoForm.adv.selectionTimeout")} inputmode="numeric" placeholder="10" value={secs(f.s.spec.timeouts.serverSelectionMs)} onInput={(v) => f.setS("spec", "timeouts", "serverSelectionMs", ms(v))} trailing={<span class="ui-text-3">s</span>} />
        </div>
        <div class="mgf-grid2">
          <TextField path="maxTime" label={t("mongoForm.adv.queryLimit")} hint={t("mongoForm.adv.queryLimitHint")} inputmode="numeric" value={f.s.maxTimeS} onInput={(v) => f.setS("maxTimeS", v.replace(/\D/g, ""))} trailing={<span class="ui-text-3">s</span>} />
          <TextField path="appName" label={t("mongoForm.adv.appName")} hint={t("mongoForm.adv.appNameHint")} placeholder="IntelySwitchIDE" /* i18n-ignore */ value={f.s.spec.appName ?? ""} onInput={(v) => f.setS("spec", "appName", v)} />
        </div>
        <section class="mgf-extra" aria-label={t("mongoForm.adv.extra")}>
          <h4>{t("mongoForm.adv.extra")}</h4>
          <p class="mgf-field__hint">{t("mongoForm.adv.extraHint")}</p>
          <Index each={f.s.spec.extra}>
            {(e, i) => {
              const def = () => extraDef(e().key);
              return (
                <div class="mgf-extrarow">
                  <TextField path={`extra.${i}.key`} label={t("mongoForm.adv.optionKey")} code value={e().key} onInput={(v) => f.setS("spec", "extra", i, "key", v)} />
                  <TextField path={`extra.${i}.value`} label={t("mongoForm.adv.optionValue")} code value={e().value} onInput={(v) => f.setS("spec", "extra", i, "value", v)} hint={def() ? t(`mongoForm.extra.${def()!.key}` as never) : undefined} />
                  <Button class="mgf-hostrow__rm" size="sm" variant="ghost" icon={Trash2} aria-label={t("mongoForm.adv.optionRemove", { n: i + 1 })} onClick={() => f.setS("spec", "extra", (cur) => cur.filter((_, j) => j !== i))} />
                </div>
              );
            }}
          </Index>
          <Button size="sm" variant="secondary" icon={Plus} disabled={!unusedKeys().length} onClick={() => f.setS("spec", "extra", (cur) => [...cur, { key: unusedKeys()[0].key, value: "" }])}>{t("mongoForm.adv.optionAdd")}</Button>
        </section>
        <section class="mgf-ignored" aria-label={t("mongoForm.adv.ignored")}>
          <h4>{t("mongoForm.adv.ignored")}</h4>
          <Show when={notes().length} fallback={<p class="mgf-field__hint">{t("mongoForm.adv.ignoredNone")}</p>}>
            <ul>
              <For each={notes()}>{(x) => <li data-kind={x.kind}><code dir="ltr">{x.n.option ?? ""}</code> {noteText(x.n.code)}</li>}</For>
            </ul>
          </Show>
        </section>
      </div>
    </LegacyLock>
  );
}

// --- Safety -----------------------------------------------------------------------------------------------------------------

export function SafetyTab() {
  const f = useForm();
  const prodByRule = () => f.rule().level === "productionLevel";
  const role = () => (f.connection() ? roleView(f.connection()!.role) : undefined);
  const snippet = () => readOnlyUserCommand(f.spec().database ?? "");
  const reasonText = () => t(`mongoForm.safety.why.${f.rule().reason}`, { host: f.rule().host ?? "" });
  return (
    <div class="mgf-stack">
      <Field label={t("mongoForm.safety.readOnly")} hint={t("mongoForm.safety.readOnlyHint")}>
        {() => <Switch checked disabled aria-label={t("mongoForm.safety.readOnly")} label={<span class="mgf-lockline"><Lock size={12} aria-hidden="true" /> {t("mongoForm.safety.alwaysOn")}</span>} />}
      </Field>
      <Field label={t("mongoForm.safety.level")}>
        {() => (
          <div class="mgf-level" role="status">
            <EnvPill env={f.level() === "productionLevel" ? "production" : "local"} />
            <span>{levelLabel(f.level())}</span>
            <Show when={f.override().active}><Badge size="sm" tone="warn">{t("mongoForm.safety.lowered")}</Badge></Show>
          </div>
        )}
      </Field>
      <details class="mgf-why">
        <summary>{t("mongoForm.safety.whyTitle")}</summary>
        <p>{reasonText()}</p>
        <Show when={prodByRule()}><p>{t("mongoForm.safety.whyType", { host: f.overrideHost() || "?" })}</p></Show>
      </details>
      <Show when={prodByRule() && f.overrideHost()}>
        <section class="mgf-override">
          <Show
            when={f.old?.levelOverride && !f.s.overrideCleared}
            fallback={<TextField path="override.host" label={t("mongoForm.safety.override")} hint={t("mongoForm.safety.overrideHint", { host: f.overrideHost() })} code placeholder={f.overrideHost()} value={f.s.typedHost} onInput={(v) => f.setS("typedHost", v)} />}
          >
            <p class="mgf-field__hint">{t("mongoForm.safety.overrideOn")}</p>
            <Button size="sm" variant="secondary" onClick={() => f.setS("overrideCleared", true)}>{t("mongoForm.safety.overrideOff")}</Button>
          </Show>
        </section>
      </Show>
      <TextField path="tenant" label={t("mongoForm.safety.tenant")} hint={t("mongoForm.safety.tenantHint")} code placeholder="tenantId" value={f.s.tenant} onInput={(v) => f.setS("tenant", v)} />
      <Show when={role()}>
        {(r) => <p class="mgf-probe" data-tone={r().tone} role="status"><ShieldCheck size={14} aria-hidden="true" /> <strong>{r().label}.</strong> {r().detail}</p>}
      </Show>
      <section class="mgf-snippet">
        <h4>{t("mongoForm.safety.snippetTitle")}</h4>
        <p class="mgf-field__hint">{t("mongoForm.safety.snippetBody")}</p>
        <pre class="mgf-codeblock ui-selectable" dir="ltr">{snippet()}</pre>
        <Button size="sm" variant="secondary" icon={Copy} onClick={() => void navigator.clipboard?.writeText(snippet()).then(() => toast.info(t("mongoForm.copied")))}>{t("mongoForm.safety.snippetCopy")}</Button>
      </section>
    </div>
  );
}

// --- AI ---------------------------------------------------------------------------------------------------------------------

export function AiTab(props: { happyPreset?: boolean }) {
  const f = useForm();
  const modes = (): { v: AiMode; k: "p0" | "p1" | "p1plus" }[] => [{ v: "off", k: "p0" }, { v: "schemaOnly", k: "p1" }, { v: "schemaEnums", k: "p1plus" }];
  const [deny, setDeny] = createSignal("");
  const addDeny = () => {
    const v = deny().trim();
    if (v && !f.s.denyFields.includes(v)) f.setS("denyFields", (cur) => [...cur, v]);
    setDeny("");
  };
  const showHappy = () => props.happyPreset || f.s.domain === "happy";
  const cap = () => f.ai();
  return (
    <div class="mgf-stack">
      <Field label={t("mongoForm.ai.mode")} hint={t("mongoForm.ai.modeHint")}>
        {() => (
          <div class="mgf-modes" role="radiogroup" aria-label={t("mongoForm.ai.mode")}>
            <For each={modes()}>
              {(m) => (
                <button type="button" role="radio" class="mgf-mode" aria-checked={f.s.aiMode === m.v} aria-labelledby={`mgf-mode-${m.k}-t`} aria-describedby={`mgf-mode-${m.k}-d`} onClick={() => f.setS("aiMode", m.v)}>
                  <strong id={`mgf-mode-${m.k}-t`}>{t(`mongoForm.ai.${m.k}.title`)}</strong>
                  <span id={`mgf-mode-${m.k}-d`}>{t(`mongoForm.ai.${m.k}.body`)}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </Field>
      <p class="mgf-field__hint">{t("mongoForm.ai.productionNote")}</p>
      <Show when={showHappy()}>
        <SelectField label={t("mongoForm.ai.preset")} hint={t("mongoForm.ai.presetHint")} value={f.s.domain} options={[{ value: "generic", label: t("mongoForm.ai.preset.generic") }, { value: "happy", label: t("mongoForm.ai.preset.happy") }]} onChange={(v) => f.setS("domain", v)} />
      </Show>
      <section class="mgf-glossary" aria-label={t("mongoForm.ai.glossary")}>
        <h4>{t("mongoForm.ai.glossary")}</h4>
        <p class="mgf-field__hint">{t("mongoForm.ai.glossaryHint")}</p>
        <Index each={f.s.glossary}>
          {(g, i) => (
            <div class="mgf-extrarow">
              <TextField label={t("mongoForm.ai.glossaryFrom")} value={g().from} onInput={(v) => f.setS("glossary", i, "from", v.slice(0, 64))} />
              <TextField label={t("mongoForm.ai.glossaryTo")} code value={g().to} onInput={(v) => f.setS("glossary", i, "to", v.slice(0, 64))} />
              <Button class="mgf-hostrow__rm" size="sm" variant="ghost" icon={Trash2} aria-label={t("mongoForm.ai.glossaryRemove", { n: i + 1 })} onClick={() => f.setS("glossary", (cur) => cur.filter((_, j) => j !== i))} />
            </div>
          )}
        </Index>
        <Button size="sm" variant="secondary" icon={Plus} disabled={f.s.glossary.length >= 50} onClick={() => f.setS("glossary", (cur) => [...cur, { from: "", to: "" }])}>{t("mongoForm.ai.glossaryAdd")}</Button>
      </section>
      <section class="mgf-deny" aria-label={t("mongoForm.ai.deny")}>
        <h4>{t("mongoForm.ai.deny")}</h4>
        <p class="mgf-field__hint">{t("mongoForm.ai.denyHint")}</p>
        <ul class="mgf-chips" role="list">
          <For each={f.s.denyFields}>
            {(d) => (
              <li class="mgf-chip">
                <code dir="ltr">{d}</code>
                <button type="button" class="mgf-chip__x" aria-label={t("mongoForm.ai.denyRemove", { field: d })} onClick={() => f.setS("denyFields", (cur) => cur.filter((x) => x !== d))}><X size={12} aria-hidden="true" /></button>
              </li>
            )}
          </For>
        </ul>
        <div class="mgf-row">
          <Input aria-label={t("mongoForm.ai.denyAdd")} placeholder="ssn" dir="ltr" class="mgf-code" spellcheck={false} autocomplete="off" value={deny()} onInput={(e) => setDeny(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addDeny())} />
          <Button size="sm" variant="secondary" icon={Plus} onClick={addDeny}>{t("mongoForm.ai.denyAddButton")}</Button>
        </div>
      </section>
      <p class="mgf-capline" role="status" data-ok={cap() ? String(cap()!.node && cap()!.claudeCli) : undefined}>
        <Show when={cap()} fallback={t("mongoForm.ai.capChecking")}>
          {(c) => t("mongoForm.ai.cap", { node: c().node ? t("mongoForm.found") : t("mongoForm.notFound"), cli: c().claudeCli ? t("mongoForm.found") : t("mongoForm.notFound") })}
        </Show>
      </p>
    </div>
  );
}
