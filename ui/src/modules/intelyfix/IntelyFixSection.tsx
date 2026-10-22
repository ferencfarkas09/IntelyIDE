import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { agentRoles } from "../../store/agents";
import { repos } from "../../store/workspace";
import { Button, Checkbox, FormGroup, FormRow, SegmentedControl, Select, TextArea } from "../../ui-kit";
import { assignees, loadAssignees, loadProjects, loadStatus, projects, status } from "../sentry/store";
import type { SentryDetail } from "../sentry/types";
import "./intelyfix.css";
import { fixPrefs, loadFixPrefs, saveFixPrefs, type FixAssignee } from "./prefs";
import { buildPrompt, DEFAULT_TEMPLATE, isDefaultTemplate, PLACEHOLDERS, renderTemplate } from "./prompt";

/** A made-up issue for the preview of the prompt. Sample data, not UI text. */
const SAMPLE: SentryDetail = { // i18n-ignore
  issue: { id: "0", shortId: "SHOP-1A", title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: "src/api/orders.js in loadOrder", level: "error", status: "unresolved", count: 412, userCount: 63, firstSeen: "2026-10-01T10:00:00Z", lastSeen: "2026-10-07T20:00:00Z", permalink: "https://sentry.io/organizations/acme/issues/0/", project: { id: "5", slug: "shop-backend", name: "Shop Backend" }, assignedTo: null, errorType: "TypeError", errorValue: null, isUnhandled: true, priority: "high", substatus: "escalating" },
  event: { eventId: "e0", dateCreated: "2026-10-07T20:00:00Z", platform: "node", release: "shop@2026.10.3", environment: "production", message: "", tags: [{ key: "browser", value: "Safari 18" }], requestUrl: "https://shop.example.invalid/api/orders/7", breadcrumbs: [{ timestamp: "", category: "http", message: "GET /api/orders/7", level: "info" }], exceptions: [{ kind: "TypeError", value: "Cannot read properties of undefined (reading 'id')", frames: [{ filename: "src/api/orders.js", function: "loadOrder", line: 42, inApp: true, context: [{ line: 41, code: "const order = await db.orders.findOne({ _id: id });" }, { line: 42, code: "return order.id;" }] }] }] },
};

/** The value of the "give the issue to" select for a preference, and back. */
const assigneeValue = (a: FixAssignee): string => (a.mode === "pick" ? `${a.kind}:${a.id}` : a.mode);

/** Settings > IntelyFIX: how Fix starts, who gets the issue, which repositories a Sentry project belongs to, and the prompt. */
export default function IntelyFixSection() {
  onMount(() => {
    void loadFixPrefs();
    // the Sentry tab may never have been opened in this session: the connection is asked for here too
    void (status()?.configured ? Promise.resolve(status()) : loadStatus()).then((s) => {
      if (!s?.configured) return;
      void loadProjects();
      void loadAssignees();
    });
  });
  const prefs = fixPrefs;
  const [draft, setDraft] = createSignal(prefs().template || DEFAULT_TEMPLATE);
  createEffect(on(() => prefs().template, (v) => setDraft(v || DEFAULT_TEMPLATE)));
  const commitTemplate = () => void saveFixPrefs({ template: isDefaultTemplate(draft()) ? "" : draft() });
  const unknown = createMemo(() => renderTemplate(draft(), {}).unknown);
  const preview = createMemo(() => buildPrompt({ detail: SAMPLE, template: draft(), repos: { primary: ["shop-backend"], related: [] }, branch: "main" }).text);

  const assigneeOptions = createMemo(() => {
    const picked = prefs().assignee;
    const known = assignees().map((a) => ({ value: `${a.kind}:${a.id}`, label: a.name }));
    const extra = picked.mode === "pick" && !known.some((o) => o.value === assigneeValue(picked)) ? [{ value: assigneeValue(picked), label: picked.name }] : [];
    return [{ value: "me", label: t("intelyfix.set.assignee.me") }, { value: "none", label: t("intelyfix.set.assignee.none") }, ...extra, ...known];
  });
  const chooseAssignee = (value: string) => {
    if (value === "me" || value === "none") return void saveFixPrefs({ assignee: { mode: value } });
    const found = assignees().find((a) => `${a.kind}:${a.id}` === value);
    if (found) void saveFixPrefs({ assignee: { mode: "pick", kind: found.kind, id: found.id, name: found.name } });
  };

  const roleOptions = createMemo(() => {
    const names = agentRoles().map((r) => r.name);
    if (!names.includes(prefs().role)) names.unshift(prefs().role);
    return names.map((n) => ({ value: n, label: n }));
  });

  const projectSlugs = createMemo(() => [...new Set([...projects().map((p) => p.slug), ...Object.keys(prefs().repoMap)])].sort((a, b) => a.localeCompare(b)));
  const workspaceRepos = () => repos().map((r) => r.name);
  const mapped = (slug: string): string[] => prefs().repoMap[slug] ?? [];
  const setMapped = (slug: string, names: string[]) => {
    const next = { ...prefs().repoMap };
    if (names.length) next[slug] = names;
    else delete next[slug];
    void saveFixPrefs({ repoMap: next });
  };
  const setPrimary = (slug: string, name: string) => setMapped(slug, name ? [name, ...mapped(slug).slice(1).filter((n) => n !== name)] : []);
  const toggleAlso = (slug: string, name: string, on: boolean) => {
    const [first, ...rest] = mapped(slug);
    if (!first) return;
    setMapped(slug, [first, ...(on ? [...new Set([...rest, name])] : rest.filter((n) => n !== name))]);
  };

  return (
    <div class="ifx">
      <p class="ifx__intro">{t("intelyfix.section.desc")}</p>
      <FormGroup title={t("intelyfix.set.how")} description={t("intelyfix.set.howDesc")}>
        <FormRow label={t("intelyfix.set.start")} description={t("intelyfix.set.startDesc")} stacked>
          <SegmentedControl
            size="sm"
            aria-label={t("intelyfix.set.start")}
            options={[{ value: "now", label: t("intelyfix.set.start.now") }, { value: "review", label: t("intelyfix.set.start.review") }]}
            value={prefs().start}
            onChange={(start) => void saveFixPrefs({ start })}
          />
        </FormRow>
        <FormRow label={t("intelyfix.set.assignee")} description={t("intelyfix.set.assigneeDesc")}>
          <Select size="sm" aria-label={t("intelyfix.set.assignee")} options={assigneeOptions()} value={assigneeValue(prefs().assignee)} onChange={chooseAssignee} />
        </FormRow>
        <FormRow label={t("intelyfix.set.role")} description={t("intelyfix.set.roleDesc")}>
          <Select size="sm" aria-label={t("intelyfix.set.role")} options={roleOptions()} value={prefs().role} onChange={(role) => void saveFixPrefs({ role })} />
        </FormRow>
        <FormRow label={t("intelyfix.set.permission")}>
          <Select
            size="sm"
            aria-label={t("intelyfix.set.permission")}
            options={[{ value: "edit", label: t("intelyfix.set.permission.edit") }, { value: "ask", label: t("intelyfix.set.permission.ask") }]}
            value={prefs().permission}
            onChange={(permission) => void saveFixPrefs({ permission })}
          />
        </FormRow>
      </FormGroup>
      <FormGroup title={t("intelyfix.set.repos")} description={t("intelyfix.set.reposDesc")}>
        <Show when={projectSlugs().length} fallback={<p class="ifx__note">{t("intelyfix.set.noProjects")}</p>}>
          <For each={projectSlugs()}>
            {(slug) => (
              <FormRow label={slug} stacked>
                <div class="ifx__map">
                  <Select
                    size="sm"
                    aria-label={t("intelyfix.set.workIn") + ": " + slug}
                    options={[{ value: "", label: t("intelyfix.set.auto") }, ...workspaceRepos().map((n) => ({ value: n, label: n }))]}
                    value={mapped(slug)[0] ?? ""}
                    onChange={(name) => setPrimary(slug, name)}
                  />
                  <Show when={mapped(slug)[0]}>
                    <div class="ifx__also" role="group" aria-label={t("intelyfix.set.alsoIn") + ": " + slug}>
                      <span class="ifx__alsoLabel">{t("intelyfix.set.alsoIn")}</span>
                      <For each={workspaceRepos().filter((n) => n !== mapped(slug)[0])}>
                        {(name) => <Checkbox size="sm" label={name} checked={mapped(slug).slice(1).includes(name)} onChange={(on) => toggleAlso(slug, name, on)} />}
                      </For>
                    </div>
                  </Show>
                </div>
              </FormRow>
            )}
          </For>
        </Show>
      </FormGroup>
      <FormGroup title={t("intelyfix.set.prompt")} description={t("intelyfix.set.promptDesc")}>
        <FormRow
          label={t("intelyfix.set.template")}
          labelFor="intelyfix-template"
          stacked
          description={
            <>
              <span class="ifx__tokens">{t("intelyfix.set.tokens", { tokens: PLACEHOLDERS.map((p) => `{{${p}}}`).join(" ") })}</span>
              <Show when={unknown().length}><span class="ifx__warn" role="status">{t("intelyfix.set.unknown", { names: unknown().join(", ") })}</span></Show>
            </>
          }
        >
          <TextArea id="intelyfix-template" class="ifx__template ui-mono" minRows={8} maxRows={22} spellcheck={false} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} onChange={commitTemplate} />
          <div class="ifx__row">
            <Button size="sm" variant="ghost" disabled={isDefaultTemplate(draft())} onClick={() => { setDraft(DEFAULT_TEMPLATE); commitTemplate(); }}>{t("intelyfix.set.reset")}</Button>
          </div>
        </FormRow>
        <details class="ifx__preview">
          <summary>{t("intelyfix.set.preview")}</summary>
          <pre class="ifx__previewText ui-mono">{preview()}</pre>
        </details>
      </FormGroup>
    </div>
  );
}
