// The state machine behind the connection form: editable state, secrets (write-only signals that never leave this object except
// inside one ipc call), the pasted-string draft, the staged test and the save. UI files only read and call it.
import { batch, createContext, createEffect, createMemo, createSignal, onCleanup, untrack, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import type { AiCapabilities, ConnectionView, HostKeyView, Note, ProfileView, SecretKind, SecretsStatus, SshSpec, TestReport, TestStep } from "../../../ipc/mongo";
import { toast } from "../../../ui-kit";
import { connIdentity, levelOfSpec } from "../logic";
import { codeOf, closeDialogSecrets, messageOf, needsOf, upsertProfile } from "../store";
import {
  applyParsed,
  blocking,
  cleanSpec,
  confirmed,
  effectiveLevelOf,
  fieldId,
  groupNotes,
  initialState,
  loweringReasons,
  looksLikeUri,
  NO_SECRETS,
  normalizeSpec,
  overrideHostOf,
  overrideState,
  parseAllowed,
  problemsOf,
  secretsWillBeDropped,
  slotsInUse,
  toInput,
  wantsPassword,
  allowedToRows,
  type FormOptions,
  type FormState,
  type FormTab,
  type NoteGroups,
  type Problem,
  type SecretSlot,
  type SecretValues,
} from "./model";

export interface FormControllerOptions extends FormOptions {
  onClose: () => void;
  onSaved?: (p: ProfileView) => void;
  /** Opens with this tab (the wizard asks for the connection tab, the error summary for the tab of a problem). */
  tab?: FormTab;
}

export type UriMode = "fields" | "string";

const SLOT_TAB: Record<SecretSlot, FormTab> = { password: "auth", keyPassword: "tls", sshSecret: "tunnel", proxyPassword: "tunnel" };
const SLOT_PATH: Record<SecretSlot, string> = { password: "auth.password", keyPassword: "tls.keyPassword", sshSecret: "tunnel.secret", proxyPassword: "tunnel.proxyPassword" };
export const secretFieldId = (slot: SecretSlot): string => fieldId(SLOT_PATH[slot]);

let dialogSeq = 0;

export function createFormController(o: FormControllerOptions) {
  const old = o.profile;
  const dialogId = `form-${++dialogSeq}`;
  const [s, setS] = createStore<FormState>(initialState(o));
  const [secrets, setSecrets] = createStore<SecretValues>({ ...NO_SECRETS });
  const [cleared, setCleared] = createSignal<SecretSlot[]>([]);
  const [draft, setDraft] = createSignal<{ token: string; identity: string; hasPassword: boolean; hasKeyPassword: boolean } | null>(null);
  const [tab, setTab] = createSignal<FormTab>(o.tab ?? "connection");
  const [mode, setModeSig] = createSignal<UriMode>("fields");
  const [pasted, setPasted] = createSignal("");
  const [parsing, setParsing] = createSignal(false);
  const [parseError, setParseError] = createSignal<string>();
  const [notes, setNotes] = createSignal<NoteGroups>({ info: [], warnings: [], unsupported: [] });
  const [dropped, setDropped] = createSignal<Note[]>([]);
  const [converted, setConverted] = createSignal(false);
  const [showErrors, setShowErrors] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string>();
  const [secretStatus, setSecretStatus] = createSignal<SecretsStatus>();
  const [ai, setAi] = createSignal<AiCapabilities>();
  const [masked, setMasked] = createSignal("");
  const [focusRequest, setFocusRequest] = createSignal<{ id: string; n: number }>();

  // --- derived ---------------------------------------------------------------------------------------------------------
  const legacy = () => !!old?.legacyUri && !converted();
  const spec = createMemo(() => cleanSpec(s));
  const identity = createMemo(() => connIdentity(spec()));
  const identityOld = old?.spec ? connIdentity(old.spec) : undefined;
  const slots = createMemo(() => slotsInUse(spec()));
  const rule = createMemo(() => levelOfSpec(spec()));
  const level = createMemo(() => effectiveLevelOf(s, old));
  const override = createMemo(() => overrideState(s, old));
  const overrideHost = createMemo(() => overrideHostOf(s));
  const lowering = createMemo(() => loweringReasons(s, old));
  const isConfirmed = createMemo(() => confirmed(s, old));
  const problems = createMemo<Problem[]>(() => problemsOf(s, { needsConnection: !legacy() }));
  const errors = createMemo(() => blocking(problems()));
  const dropSaved = createMemo(() => secretsWillBeDropped(identity(), identityOld, old));
  const keychain = () => secretStatus()?.store === "keychain";
  const draftUsable = () => {
    const d = draft();
    return !!d && d.identity === identity();
  };
  const draftStale = () => !!draft() && !draftUsable();

  /** What the password field says about the secret: typed now, from the pasted string, saved, or nothing. */
  const secretState = (slot: SecretSlot): "typed" | "pasted" | "saved" | "none" => {
    if (secrets[slot]) return "typed";
    if (cleared().includes(slot)) return "none";
    const d = draft();
    if (d && draftUsable() && ((slot === "password" && d.hasPassword) || (slot === "keyPassword" && d.hasKeyPassword))) return "pasted";
    const has = slot === "password" ? old?.hasPassword : slot === "keyPassword" ? old?.hasKeyPassword : slot === "sshSecret" ? old?.hasSshSecret : old?.hasProxyPassword;
    return has && !dropSaved() ? "saved" : "none";
  };

  const requestFocus = (id: string) => setFocusRequest({ id, n: (untrack(focusRequest)?.n ?? 0) + 1 });
  createEffect(() => {
    const r = focusRequest();
    if (!r) return;
    // Wait for the panel to become visible, then focus; the field may live on another tab.
    queueMicrotask(() => setTimeout(() => document.getElementById(r.id)?.focus(), 0));
  });
  const goto = (to: FormTab, id?: string) => {
    setTab(to);
    if (id) requestFocus(id);
  };

  // Secrets are never kept in the DOM after the form ends.
  const wipe = () => {
    setSecrets({ ...NO_SECRETS });
    setPasted("");
  };
  onCleanup(() => {
    wipe();
    closeDialogSecrets({ dialogId, draft: untrack(draft)?.token });
  });

  void ipc.mongo
    .secretsStatus(old?.id)
    .then(setSecretStatus)
    .catch(() => setSecretStatus({ store: "unavailable", hasPassword: false, hasKeyPassword: false, hasSshSecret: false, hasProxyPassword: false, identityMatches: false }));
  void ipc.mongo.aiCapabilities().then(setAi).catch(() => undefined);

  // The masked rendering (`user:***@`) is the only URI the form ever shows or copies.
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let renderSeq = 0;
  createEffect(() => {
    const sp = spec();
    const id = old?.id;
    const dr = draftUsable() ? draft()?.token : undefined;
    clearTimeout(renderTimer);
    if (legacy()) {
      setMasked(old?.uriMasked ?? "");
      return;
    }
    if (!sp.hosts?.some((h) => h.host)) {
      renderSeq++;
      setMasked("");
      return;
    }
    const n = ++renderSeq;
    renderTimer = setTimeout(() => {
      void ipc.mongo
        .uriRender(sp, id, dr)
        .then((m) => n === renderSeq && setMasked(m))
        .catch(() => n === renderSeq && setMasked(""));
    }, 200);
  });
  onCleanup(() => clearTimeout(renderTimer));

  // --- mutations -------------------------------------------------------------------------------------------------------
  const setMode = (m: UriMode) => setModeSig(m);

  function setEnvironment(e: FormState["environment"]) {
    batch(() => {
      setS("environment", e);
      setS("envTouched", true);
    });
  }

  /** Follow the host rule for the tag until the user picks one by hand. */
  createEffect(() => {
    const auto = rule().level === "local" ? "local" : "production";
    if (!untrack(() => s.envTouched) && !old) setS("environment", auto);
  });

  function clearSecret(slot: SecretSlot) {
    batch(() => {
      setSecrets(slot, "");
      setCleared((c) => (c.includes(slot) ? c : [...c, slot]));
    });
  }
  function typeSecret(slot: SecretSlot, v: string) {
    batch(() => {
      setSecrets(slot, v);
      if (v) setCleared((c) => c.filter((x) => x !== slot));
    });
  }

  async function dropDraft() {
    const d = untrack(draft);
    setDraft(null);
    if (d) await ipc.mongo.draftDiscard(d.token).catch(() => undefined);
  }

  /** Parses a pasted connection string in Rust; the form fills, the password stays in the draft vault, the text is cleared. */
  async function applyUri(text: string) {
    const raw = text.trim();
    setParseError(undefined);
    if (!raw) return;
    if (!looksLikeUri(raw)) {
      setParseError("scheme");
      return;
    }
    setParsing(true);
    try {
      const p = await ipc.mongo.uriParse(raw);
      await dropDraft();
      batch(() => {
        const next = applyParsed(untrack(() => ({ ...s, spec: s.spec, allowed: s.allowed }) as FormState), p);
        setS({ spec: next.spec, allowed: next.allowed, environment: next.environment });
        setSecrets({ ...NO_SECRETS });
        setCleared([]);
        const sp = cleanSpec({ spec: next.spec, allowed: next.allowed });
        setDraft(p.draft ? { token: p.draft, identity: connIdentity(sp), hasPassword: p.hasPassword, hasKeyPassword: p.hasKeyPassword } : null);
        setNotes(groupNotes(p));
        setPasted("");
      });
      if (wantsPassword(p)) goto("auth", secretFieldId("password"));
    } catch (e) {
      setParseError(messageOf(e) || codeOf(e));
      setPasted("");
    } finally {
      setParsing(false);
    }
  }

  /** A legacy one-string profile as fields. Nothing is saved until Save. */
  async function convertLegacy() {
    if (!old) return;
    try {
      const d = await ipc.mongo.profileConvert(old.id);
      await dropDraft();
      const sp = normalizeSpec(d.input.spec);
      batch(() => {
        setS({ spec: sp, allowed: sp.tunnel.kind === "ssh" ? allowedToRows(sp.tunnel.allowedHosts) : [] });
        setDraft(d.draft ? { token: d.draft, identity: connIdentity(cleanSpec({ spec: sp, allowed: [] })), hasPassword: !!old.hasPassword, hasKeyPassword: false } : null);
        setDropped(d.dropped);
        setConverted(true);
      });
    } catch (e) {
      setSaveError(messageOf(e));
    }
  }

  // --- the staged test -------------------------------------------------------------------------------------------------
  const [testing, setTesting] = createSignal(false);
  const [steps, setSteps] = createSignal<TestStep[]>([]);
  const [report, setReport] = createSignal<TestReport>();
  const [testError, setTestError] = createSignal<string>();
  const [cancelled, setCancelled] = createSignal(false);
  let currentTest: string | undefined;

  const inputNow = (extra: { draftOk?: boolean } = {}) =>
    toInput({ state: s, old, secrets, cleared: cleared(), draft: extra.draftOk === false || !draftUsable() ? null : draft()?.token, legacyKept: legacy() });

  const testBlocked = () => (s.tlsRelax === "certificates" && !isConfirmed()) || testing();

  async function runTest() {
    if (testing()) return;
    if (errors().length) {
      setShowErrors(true);
      const first = errors()[0];
      goto(first.tab === "header" ? tab() : first.tab, fieldId(first.path));
      return;
    }
    const testId = `t${Math.random().toString(36).slice(2, 10)}`;
    currentTest = testId;
    batch(() => {
      setTesting(true);
      setSteps([]);
      setReport(undefined);
      setTestError(undefined);
      setCancelled(false);
    });
    const off = ipc.mongo.onTest((ev) => {
      if (ev.testId !== testId) return;
      const incoming = ev.steps ?? (ev.step ? [ev.step] : []);
      setSteps((cur) => [...cur.filter((x) => !incoming.some((n) => n.id === x.id)), ...incoming]);
    });
    try {
      const input = inputNow();
      input.name = input.name || t("mongoForm.draftName");
      const r = await ipc.mongo.test(input, testId);
      if (currentTest === testId) {
        batch(() => {
          setReport(r);
          if (r.steps?.length) setSteps(r.steps);
        });
      }
    } catch (e) {
      const code = codeOf(e);
      if (code === "mongoNeedSecret") {
        const need = needsOf(e)[0] as SecretKind | undefined;
        const slot = (need ?? "password") as SecretSlot;
        setTestError(t("mongoForm.test.needSecret"));
        goto(SLOT_TAB[slot], secretFieldId(slot));
      } else if (code === "mongoBusy") setTestError(t("mongoForm.test.busy"));
      else if (code === "mongoNeedsReview") setTestError(t("mongoForm.test.needsReview"));
      else setTestError(messageOf(e));
    } finally {
      off();
      if (currentTest === testId) currentTest = undefined;
      setTesting(false);
    }
  }
  async function cancelTest() {
    const id = currentTest;
    if (!id) return;
    setCancelled(true);
    await ipc.mongo.testCancel(id).catch(() => false);
  }

  // --- host key and allow-list -----------------------------------------------------------------------------------------
  const [hostKey, setHostKey] = createSignal<{ view?: HostKeyView; unscannable?: boolean; host?: string; expected?: string }>();
  const sshSpecNow = (): SshSpec | undefined => {
    const tun = spec().tunnel;
    return tun?.kind === "ssh" ? tun : undefined;
  };
  async function checkHostKey(): Promise<void> {
    const ssh = sshSpecNow();
    if (!ssh) return;
    const bad = problems().filter((p) => p.path === "tunnel.host" || p.path === "tunnel.user");
    if (bad.length) {
      setShowErrors(true);
      goto("tunnel", fieldId(bad[0].path));
      return;
    }
    try {
      const view = await ipc.mongo.sshHostkey(ssh);
      setHostKey({ view, host: ssh.host, expected: undefined });
    } catch (e) {
      if (/Unscannable/i.test(messageOf(e)) || codeOf(e) === "mongoHostKey") setHostKey({ unscannable: true, host: ssh.host });
      else toast.error(messageOf(e));
    }
  }
  async function trustHostKey(view: HostKeyView): Promise<void> {
    await ipc.mongo.sshTrust(view.host, view.port, view.fingerprint);
    setHostKey(undefined);
    toast.success(t("mongoForm.hostKey.trusted", { host: view.host }));
    if (report() && !report()!.ok) void runTest();
  }
  async function forgetHostKey(typed: string): Promise<void> {
    const hk = hostKey()?.view;
    if (!hk) return;
    await ipc.mongo.sshForget(hk.host, hk.port, typed);
    setHostKey(undefined);
    toast.info(t("mongoForm.hostKey.forgotten", { host: hk.host }));
    await checkHostKey();
  }

  function allowHosts(hosts: readonly string[]) {
    const have = new Set(s.allowed.map((r) => r.trim().toLowerCase()));
    const add = hosts.filter((h) => parseAllowed(h) && !have.has(h.trim().toLowerCase()));
    if (add.length) setS("allowed", (cur) => [...cur, ...add]);
  }
  /** Members the server announced that the relay would refuse: not a seed host and not in the allow-list. */
  const unallowedMembers = createMemo(() => {
    const r = report();
    if (!r?.ok || spec().tunnel?.kind !== "ssh") return [] as string[];
    const known = new Set([...(spec().hosts ?? []).map((h) => `${h.host}:${h.port ?? 27017}`), ...s.allowed.map((a) => a.trim())].map((x) => x.toLowerCase()));
    return (r.members ?? []).filter((m) => !known.has(m.toLowerCase()));
  });

  // --- save ------------------------------------------------------------------------------------------------------------
  async function save(): Promise<void> {
    if (saving()) return;
    if (errors().length) {
      setShowErrors(true);
      const first = errors()[0];
      goto(first.tab === "header" ? tab() : first.tab, fieldId(first.path));
      return;
    }
    if (!isConfirmed()) {
      goto("safety", "mgf-confirm");
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    try {
      const saved = await ipc.mongo.profileSave(inputNow());
      wipe();
      setDraft(null);
      upsertProfile(saved);
      toast.success(t("mongoForm.saved", { name: saved.name }));
      o.onSaved?.(saved);
      o.onClose();
    } catch (e) {
      const code = codeOf(e);
      const msg = messageOf(e);
      setSaveError(code === "mongoConfirm" ? t("mongoForm.save.confirm") : code === "mongoInvalid" && /tlsRelaxRefused/.test(msg) ? t("mongoForm.save.relaxRefused") : code === "mongoNeedSecret" ? t("mongoForm.save.needSecret") : msg);
    } finally {
      setSaving(false);
    }
  }

  return {
    old,
    dialogId,
    s,
    setS,
    secrets,
    cleared,
    tab,
    setTab,
    mode,
    setMode,
    pasted,
    setPasted,
    parsing,
    parseError,
    notes,
    dropped,
    converted,
    legacy,
    showErrors,
    setShowErrors,
    saving,
    saveError,
    secretStatus,
    keychain,
    ai,
    masked,
    spec,
    identity,
    slots,
    rule,
    level,
    override,
    overrideHost,
    lowering,
    isConfirmed,
    problems,
    errors,
    dropSaved,
    draft,
    draftStale,
    secretState,
    typeSecret,
    clearSecret,
    setEnvironment,
    applyUri,
    convertLegacy,
    dropDraft,
    testing,
    steps,
    report,
    testError,
    cancelled,
    testBlocked,
    runTest,
    cancelTest,
    hostKey,
    setHostKey,
    checkHostKey,
    trustHostKey,
    forgetHostKey,
    allowHosts,
    unallowedMembers,
    save,
    goto,
    requestFocus,
    onClose: o.onClose,
    connection: (): ConnectionView | undefined => report()?.connection ?? undefined,
  };
}

export type FormController = ReturnType<typeof createFormController>;

export const FormContext = createContext<FormController>();
export function useForm(): FormController {
  const c = useContext(FormContext);
  if (!c) throw new Error("useForm outside ConnectionForm");
  return c;
}
