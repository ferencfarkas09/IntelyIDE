import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { McpImportEntry, McpImportIssue, McpImportPreview, McpImportResult } from "../../ipc/mcp";
import { openPathPicker } from "../../platform/pathpicker";
import { Badge, Button, Checkbox, Dialog, Globe, Input, Lock, Spinner, SquareTerminal as Terminal, TriangleAlert, Upload } from "../../ui-kit";
import { errorInfo, nameProblem, type ErrorInfo } from "./logic";

export interface ImportDialogProps {
  open: boolean;
  /** Names of the servers that exist now: a picked name that is among them needs "Replace". */
  existingNames: readonly string[];
  onClose: () => void;
  onDone: (result: McpImportResult) => void;
}

interface Choice {
  picked: boolean;
  name: string;
  replace: boolean;
}

const ISSUE_KEY: Record<McpImportIssue, MessageKey> = {
  unsupportedTransport: "mcp.import.issue.unsupportedTransport",
  badName: "mcp.import.issue.badName",
  nameTaken: "mcp.import.issue.nameTaken",
  secretInArgs: "mcp.import.issue.secretInArgs",
  secretInUrl: "mcp.import.issue.secretInUrl",
  unresolvedRef: "mcp.import.issue.unresolvedRef",
  badCommand: "mcp.import.issue.badCommand",
  badVar: "mcp.import.issue.badVar",
  badChars: "mcp.import.issue.badChars",
  relativePath: "mcp.import.issue.relativePath",
  tooMany: "mcp.import.issue.tooMany",
};

/** Issues the user can live with (the entry stays importable): everything else is a reason to add the server by hand. */
const SOFT: ReadonlySet<McpImportIssue> = new Set(["badName", "nameTaken", "unresolvedRef"]);

function failureText(e: ErrorInfo): string {
  switch (e.code) {
    case "mcpImportExpired":
      return t("mcp.import.expired");
    case "mcpImportInvalid":
      return t("mcp.import.invalid");
    case "readOnly":
      return t("mcp.err.readOnly");
    default:
      return e.message || t("mcp.err.generic", { message: e.code });
  }
}

/**
 * Import from Claude Code ((design notes: mcp-management-spec) 7.8, 3.3): choose a file with the path picker, read the PREVIEW (names only, never
 * a value), pick what to bring in, apply. Everything arrives switched off and unconfirmed; secrets go from Rust straight into the Keychain
 * and are never shown. The preview lives five minutes.
 */
export function ImportDialog(props: ImportDialogProps) {
  const [preview, setPreview] = createSignal<McpImportPreview | null>(null);
  const [picks, setPicks] = createStore<Record<string, Choice>>({});
  const [busy, setBusy] = createSignal<"reading" | "applying" | null>(null);
  const [error, setError] = createSignal<ErrorInfo | null>(null);
  const [expired, setExpired] = createSignal(false);
  let expiry: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(expiry));

  const reset = () => {
    clearTimeout(expiry);
    setPreview(null);
    setPicks(produce((p) => Object.keys(p).forEach((k) => delete p[k])));
    setBusy(null);
    setError(null);
    setExpired(false);
  };
  createEffect(on(() => props.open, (open) => open && reset()));

  async function chooseFile() {
    setError(null);
    setExpired(false);
    try {
      const picked = await openPathPicker({ kind: "file", purpose: "file:mcpImport", extensions: ["json"], title: t("mcp.import.title") });
      const token = picked?.[0]?.token;
      if (!token) return;
      setBusy("reading");
      const p = await ipc.mcp.importPreview(token);
      reset();
      setPreview(p);
      p.entries.forEach((e) => setPicks(e.key, { picked: e.importable && !e.conflict, name: e.suggestedName, replace: false }));
      expiry = setTimeout(() => setExpired(true), Math.max(0, p.expiresAt - Date.now()));
    } catch (e) {
      setError(errorInfo(e));
    } finally {
      setBusy(null);
    }
  }

  const entries = () => preview()?.entries ?? [];
  const nameOf = (e: McpImportEntry) => picks[e.key]?.name ?? e.suggestedName;
  const taken = (name: string) => props.existingNames.includes(name);
  /** What stops a picked entry: a bad name, or a taken one without Replace. */
  const entryProblem = (e: McpImportEntry): "mcpBadName" | "mcpNameTaken" | null => {
    const name = nameOf(e).trim();
    if (nameProblem(name) === "mcpBadName") return "mcpBadName";
    return taken(name) && !picks[e.key]?.replace ? "mcpNameTaken" : null;
  };
  const selected = createMemo(() => entries().filter((e) => e.importable && picks[e.key]?.picked));
  const blocked = () => selected().some((e) => entryProblem(e) !== null);

  async function apply() {
    const p = preview();
    if (!p || busy() || expired() || blocked() || selected().length === 0) return;
    setBusy("applying");
    try {
      const result = await ipc.mcp.importApply(p.importId, selected().map((e) => ({ key: e.key, name: nameOf(e).trim(), replace: !!picks[e.key]?.replace && taken(nameOf(e).trim()) })));
      props.onDone(result);
      props.onClose();
    } catch (e) {
      const info = errorInfo(e);
      if (info.code === "mcpImportExpired") setExpired(true);
      setError(info);
    } finally {
      setBusy(null);
    }
  }

  const issueTone = (i: McpImportIssue) => (SOFT.has(i) ? "warn" : "danger");
  const transportBadge = (e: McpImportEntry) =>
    e.transport === "unknown" ? (
      <Badge size="sm">{t("mcp.import.transportUnknown")}</Badge>
    ) : (
      <Badge size="sm" icon={e.transport === "stdio" ? Terminal : Globe}>{e.transport === "stdio" ? t("mcp.row.stdio") : t("mcp.row.http")}</Badge>
    );

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="lg"
      title={t("mcp.import.title")}
      footer={
        <>
          <Show when={preview()} fallback={<Button variant="secondary" onClick={props.onClose}>{t("mcp.cancel")}</Button>}>
            <Button variant="secondary" onClick={reset}>{t("mcp.back")}</Button>
            <Button variant="primary" loading={busy() === "applying"} disabled={selected().length === 0 || blocked() || expired()} onClick={() => void apply()}>
              {t("mcp.import.apply", { count: selected().length })}
            </Button>
          </Show>
        </>
      }
    >
      <div class="mcp-import">
        <Show when={error()}>
          {(e) => (
            <div class="mcp-note" data-tone="danger" role="alert"><TriangleAlert size={14} aria-hidden="true" /><span>{failureText(e())}</span></div>
          )}
        </Show>
        <Show
          when={preview()}
          fallback={
            <div class="mcp-import__choose">
              <p>{t("mcp.import.intro")}</p>
              <p class="mcp-import__note">{t("mcp.import.projectNote")}</p>
              <div>
                <Button variant="secondary" icon={Upload} loading={busy() === "reading"} onClick={() => void chooseFile()}>{t("mcp.import.choose")}</Button>
              </div>
              <Show when={busy() === "reading"}>
                <p class="mcp-import__note" role="status"><Spinner size={12} /> {t("mcp.import.reading")}</p>
              </Show>
            </div>
          }
        >
          {(p) => (
            <>
              <p class="mcp-import__note">{t("mcp.import.pickIntro")} <span class="mcp-import__file">{t("mcp.import.file", { name: p().fileName })}</span></p>
              <Show when={expired()}>
                <div class="mcp-note" data-tone="warn" role="status">
                  <TriangleAlert size={14} aria-hidden="true" />
                  <span class="mcp-note__text">{t("mcp.import.expired")}</span>
                  <Button size="sm" variant="secondary" onClick={reset}>{t("mcp.import.again")}</Button>
                </div>
              </Show>
              <Show when={p().skippedKeys > 0}>
                <p class="mcp-import__note">{t("mcp.import.skippedKeys", { count: p().skippedKeys })}</p>
              </Show>
              <Show when={entries().length > 0} fallback={<p class="mcp-import__note">{t("mcp.import.none")}</p>}>
                <ul class="mcp-import__list" role="list">
                  <For each={entries()}>
                    {(e) => (
                      <li class="mcp-import__row" data-importable={e.importable ? "" : undefined}>
                        <Checkbox
                          aria-label={t("mcp.import.pickOf", { key: e.key })}
                          checked={!!picks[e.key]?.picked && e.importable}
                          disabled={!e.importable}
                          onChange={(next) => setPicks(e.key, "picked", next)}
                        />
                        <div class="mcp-import__main">
                          <div class="mcp-import__head">
                            <Input
                              size="sm"
                              class="mcp-mono"
                              aria-label={t("mcp.import.nameFor", { key: e.key })}
                              autocomplete="off"
                              spellcheck={false}
                              autocapitalize="off"
                              disabled={!e.importable}
                              invalid={e.importable && !!picks[e.key]?.picked && entryProblem(e) === "mcpBadName"}
                              value={nameOf(e)}
                              onInput={(ev) => setPicks(e.key, "name", ev.currentTarget.value)}
                            />
                            {transportBadge(e)}
                          </div>
                          <Show when={e.commandLine ?? e.urlHost}>
                            {(line) => <code class="mcp-import__line" title={line()}>{line()}</code>}
                          </Show>
                          <Show when={e.env.length + e.headers.length > 0}>
                            <ul class="mcp-import__vars" aria-label={t("mcp.confirm.vars")}>
                              <For each={[...e.env, ...e.headers]}>
                                {(v) => (
                                  <li>
                                    <code class="mcp-code-inline">{v.name}</code>
                                    <Show when={v.secret}><Lock size={12} aria-label={t("mcp.confirm.secretTag")} /></Show>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                          <Show when={e.issues.length > 0}>
                            <div class="mcp-import__issues">
                              <For each={e.issues}>{(i) => <Badge size="sm" tone={issueTone(i)}>{t(ISSUE_KEY[i])}</Badge>}</For>
                            </div>
                          </Show>
                          <Show when={e.importable && taken(nameOf(e).trim())}>
                            <Checkbox size="sm" label={t("mcp.import.replace", { name: nameOf(e).trim() })} checked={!!picks[e.key]?.replace} onChange={(next) => setPicks(e.key, "replace", next)} />
                          </Show>
                          <Show when={e.importable && picks[e.key]?.picked && entryProblem(e)}>
                            {(code) => <p class="mcp-field-error" role="alert">{code() === "mcpBadName" ? t("mcp.err.mcpBadName") : t("mcp.err.mcpNameTaken")}</p>}
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
                <p class="mcp-import__note"><Lock size={12} aria-hidden="true" /> {t("mcp.import.secretNote")}</p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  );
}
