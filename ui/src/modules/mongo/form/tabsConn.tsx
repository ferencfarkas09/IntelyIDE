import { Index, Show, type JSX } from "solid-js";
import { t } from "../../../i18n";
import type { AuthMechanism, ReadPrefMode, TlsMode } from "../../../bindings/mongo";
import { Button, Checkbox, CircleAlert, Input, Lock, Plus, SegmentedControl, ShieldCheck, Switch, Trash2, TriangleAlert } from "../../../ui-kit";
import { UriPanel } from "../UriField";
import { useForm, type FormController } from "./controller";
import { Field, SecretField, SelectField, TextField, useProblems } from "./fields";
import { isLoopback, looksLikeUri, newProxyTunnel, newSshTunnel, relaxAllowed, withScheme } from "./model";

export const num = (v: string): number | null => {
  const d = v.replace(/\D/g, "");
  return d ? Number(d) : null;
};

export const mechLabel = (m: AuthMechanism): string => t(`mongoForm.mech.${m}`);

/** What a secret will be sent to: the hosts (through the tunnel when there is one), the sign-in method and the TLS state. */
export function destinationLine(f: FormController): string {
  const sp = f.spec();
  const hosts = (sp.hosts ?? []).map((h) => (h.port ? `${h.host}:${h.port}` : h.host)).filter(Boolean).join(", ") || t("mongoForm.dest.noHost");
  const via = sp.tunnel?.kind === "ssh" ? t("mongoForm.dest.viaSsh", { host: sp.tunnel.host || "?" }) : sp.tunnel?.kind === "socks5" ? t("mongoForm.dest.viaProxy", { host: sp.tunnel.host || "?" }) : "";
  const tls = sp.tls?.mode === "off" ? t("mongoForm.tls.state.off") : sp.tls?.mode === "on" || sp.scheme === "srv" ? t("mongoForm.tls.state.on") : t("mongoForm.tls.state.auto");
  const mechanism = mechLabel(sp.auth?.mechanism ?? "default");
  return via ? t("mongoForm.dest.lineVia", { hosts, via, mechanism, tls }) : t("mongoForm.dest.line", { hosts, mechanism, tls });
}

/** The banner of a profile saved as one string: convert it to fields before anything else can change. */
export function LegacyLock(props: { children: JSX.Element }) {
  const f = useForm();
  return (
    <Show when={f.legacy()} fallback={props.children}>
      <div class="mgf-banner" data-tone="warn" role="status">
        <TriangleAlert size={16} aria-hidden="true" />
        <div>
          <strong>{t("mongoForm.legacy.title")}</strong>
          <p>{t("mongoForm.legacy.body", { host: f.old?.host ?? "" })}</p>
          <Button size="sm" variant="secondary" onClick={() => void f.convertLegacy()}>{t("mongoForm.legacy.convert")}</Button>
        </div>
      </div>
    </Show>
  );
}

// --- Connection -------------------------------------------------------------------------------------------------------------

export function ConnectionTab() {
  const f = useForm();
  const srv = () => f.s.spec.scheme === "srv";
  const pref = () => f.s.spec.topology.readPreference ?? "auto";
  const stalenessApplies = () => pref() === "secondary" || pref() === "secondaryPreferred" || pref() === "nearest";
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!looksLikeUri(text)) return;
    e.preventDefault();
    void f.applyUri(text);
  };
  const prefs = (): { value: ReadPrefMode; label: string }[] => (["auto", "primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"] as const).map((v) => ({ value: v, label: t(`mongoForm.readPref.${v}`) }));
  const direct = () => (f.s.spec.topology.directConnection == null ? "auto" : f.s.spec.topology.directConnection ? "yes" : "no");

  return (
    <LegacyLock>
      <div class="mgf-stack">
        <SegmentedControl
          aria-label={t("mongoForm.mode.label")}
          size="sm"
          value={f.mode()}
          onChange={f.setMode}
          options={[{ value: "fields", label: t("mongoForm.mode.fields") }, { value: "string", label: t("mongoForm.mode.string") }]}
        />
        <Show when={f.mode() === "string"}>
          <UriPanel />
        </Show>
        <Show when={f.mode() === "fields"}>
          <Show when={f.dropped().length}>
            <div class="mgf-banner" data-tone="info" role="status">
              <CircleAlert size={16} aria-hidden="true" />
              <div>
                <strong>{t("mongoForm.legacy.converted")}</strong>
                <p>{t("mongoForm.legacy.dropped", { count: f.dropped().length })}</p>
              </div>
            </div>
          </Show>
          <Field label={t("mongoForm.scheme.label")}>
            {() => (
              <SegmentedControl
                aria-label={t("mongoForm.scheme.label")}
                size="sm"
                value={f.s.spec.scheme ?? "standard"}
                onChange={(v) => f.setS("spec", (sp) => withScheme(sp, v))}
                options={[{ value: "standard", label: t("mongoForm.scheme.standard") }, { value: "srv", label: t("mongoForm.scheme.srv") }]}
              />
            )}
          </Field>
          <section class="mgf-hosts" aria-label={t("mongoForm.hosts.label")}>
            <Index each={f.s.spec.hosts}>
              {(h, i) => (
                <div class="mgf-hostrow">
                  <TextField
                    path={`hosts.${i}.host`}
                    label={i === 0 ? t("mongoForm.hosts.host") : t("mongoForm.hosts.hostN", { n: i + 1 })}
                    code
                    value={h().host}
                    placeholder={srv() ? "cluster0.abcde.mongodb.net" : "db.example.com"}
                    onInput={(v) => f.setS("spec", "hosts", i, "host", v)}
                    onPaste={onPaste}
                  />
                  <Show when={!srv()}>
                    <TextField path={`hosts.${i}.port`} label={t("mongoForm.hosts.port")} code inputmode="numeric" value={h().port != null ? String(h().port) : ""} placeholder="27017" onInput={(v) => f.setS("spec", "hosts", i, "port", num(v))} />
                  </Show>
                  <Show when={f.s.spec.hosts.length > 1}>
                    <Button class="mgf-hostrow__rm" size="sm" variant="ghost" icon={Trash2} aria-label={t("mongoForm.hosts.remove", { n: i + 1 })} onClick={() => f.setS("spec", "hosts", (hs) => hs.filter((_, j) => j !== i))} />
                  </Show>
                </div>
              )}
            </Index>
            <Show when={!srv()}>
              <Button size="sm" variant="secondary" icon={Plus} disabled={f.s.spec.hosts.length >= 16} onClick={() => f.setS("spec", "hosts", (hs) => [...hs, { host: "", port: 27017 }])}>{t("mongoForm.hosts.add")}</Button>
            </Show>
            <Show when={srv()}><p class="mgf-field__hint">{t("mongoForm.hosts.srvHint")}</p></Show>
          </section>
          <TextField path="database" label={t("mongoForm.database.label")} hint={t("mongoForm.database.hint")} code value={f.s.spec.database ?? ""} onInput={(v) => f.setS("spec", "database", v)} />
          <div class="mgf-grid2">
            <TextField path="topology.replicaSet" label={t("mongoForm.replicaSet.label")} code value={f.s.spec.topology.replicaSet ?? ""} onInput={(v) => f.setS("spec", "topology", "replicaSet", v)} />
            <SelectField
              path="topology.directConnection"
              label={t("mongoForm.direct.label")}
              value={direct()}
              disabled={srv()}
              onChange={(v) => f.setS("spec", "topology", "directConnection", v === "auto" ? null : v === "yes")}
              options={[{ value: "auto", label: t("mongoForm.direct.auto") }, { value: "yes", label: t("mongoForm.direct.yes") }, { value: "no", label: t("mongoForm.direct.no") }]}
            />
          </div>
          <div class="mgf-grid2">
            <SelectField path="topology.readPreference" label={t("mongoForm.readPref.label")} hint={t("mongoForm.readPref.hint")} value={pref()} options={prefs()} onChange={(v) => f.setS("spec", "topology", "readPreference", v)} />
            <Show when={stalenessApplies()}>
              <TextField path="topology.maxStalenessS" label={t("mongoForm.staleness.label")} hint={t("mongoForm.staleness.hint")} inputmode="numeric" value={f.s.spec.topology.maxStalenessS != null ? String(f.s.spec.topology.maxStalenessS) : ""} onInput={(v) => f.setS("spec", "topology", "maxStalenessS", num(v))} />
            </Show>
          </div>
        </Show>
      </div>
    </LegacyLock>
  );
}

// --- Authentication ---------------------------------------------------------------------------------------------------------

export function AuthTab() {
  const f = useForm();
  const mech = () => f.s.spec.auth.mechanism ?? "default";
  const external = () => mech() === "x509" || mech() === "plain";
  const mechs = (): { value: AuthMechanism; label: string }[] => (["none", "default", "scramSha1", "scramSha256", "x509", "plain"] as const).map((v) => ({ value: v, label: mechLabel(v) }));
  const defaultSource = () => (f.s.spec.database?.trim() ? f.s.spec.database.trim() : "admin");
  return (
    <LegacyLock>
      <div class="mgf-stack">
        <SelectField path="auth.mechanism" label={t("mongoForm.auth.mechanism")} hint={t(`mongoForm.mechHint.${mech()}`)} value={mech()} options={mechs()} onChange={(v) => f.setS("spec", "auth", "mechanism", v)} />
        <Show when={mech() !== "none"}>
          <TextField path="auth.username" label={t("mongoForm.auth.username")} hint={mech() === "x509" ? t("mongoForm.auth.x509User") : undefined} code value={f.s.spec.auth.username ?? ""} onInput={(v) => f.setS("spec", "auth", "username", v)} />
        </Show>
        <Show when={mech() !== "none" && mech() !== "x509"}>
          <SecretField slot="password" path="auth.password" label={t("mongoForm.auth.password")} save={f.s.spec.auth.savePassword} onSave={(v) => f.setS("spec", "auth", "savePassword", v)} destination={destinationLine(f)} />
        </Show>
        <Show when={mech() === "plain"}><p class="mgf-banner" data-tone="warn" role="note"><TriangleAlert size={16} aria-hidden="true" /> <span>{t("mongoForm.auth.plainWarn")}</span></p></Show>
        <Show when={f.draftStale()}><p class="mgf-banner" data-tone="warn" role="status"><TriangleAlert size={16} aria-hidden="true" /> <span>{t("mongoForm.auth.draftStale")}</span></p></Show>
        <Show when={f.dropSaved()}><p class="mgf-banner" data-tone="warn" role="status"><TriangleAlert size={16} aria-hidden="true" /> <span>{t("mongoForm.auth.dropSaved")}</span></p></Show>
        <Show when={mech() !== "none"}>
          <TextField
            path="auth.source"
            label={t("mongoForm.auth.source")}
            hint={external() ? t("mongoForm.auth.sourceExternal") : t("mongoForm.auth.sourceHint", { db: defaultSource() })}
            code
            disabled={external()}
            value={external() ? "$external" : (f.s.spec.auth.source ?? "")}
            placeholder={defaultSource()}
            onInput={(v) => f.setS("spec", "auth", "source", v)}
          />
        </Show>
        <Show when={mech() === "x509"}><p class="mgf-field__hint">{t("mongoForm.auth.x509Needs")}</p></Show>
      </div>
    </LegacyLock>
  );
}

// --- TLS --------------------------------------------------------------------------------------------------------------------

export function TlsTab() {
  const f = useForm();
  const modes = (): { value: TlsMode; label: string }[] => (["auto", "on", "off"] as const).map((v) => ({ value: v, label: t(`mongoForm.tls.mode.${v}`) }));
  const relaxOk = () => relaxAllowed(f.s, f.old);
  return (
    <LegacyLock>
      <div class="mgf-stack">
        <SelectField path="tls.mode" label={t("mongoForm.tls.mode.label")} hint={t("mongoForm.tls.mode.hint")} value={f.s.spec.tls.mode ?? "auto"} options={modes()} onChange={(v) => f.setS("spec", "tls", "mode", v)} />
        <TextField path="tls.caFile" browse={{ purpose: "file:caFile", extensions: ["pem", "crt", "cer", "key", "p12", "pfx"] }} label={t("mongoForm.tls.ca")} hint={t("mongoForm.tls.caHint")} code placeholder="/path/to/ca.pem" value={f.s.spec.tls.caFile ?? ""} onInput={(v) => f.setS("spec", "tls", "caFile", v)} />
        <TextField path="tls.clientCertFile" browse={{ purpose: "file:clientCert", extensions: ["pem", "crt", "cer", "key", "p12", "pfx"] }} label={t("mongoForm.tls.client")} hint={t("mongoForm.tls.clientHint")} code placeholder="/path/to/client.pem" value={f.s.spec.tls.clientCertFile ?? ""} onInput={(v) => f.setS("spec", "tls", "clientCertFile", v)} />
        <Show when={f.s.spec.tls.clientCertFile?.trim()}>
          <SecretField slot="keyPassword" path="tls.keyPassword" label={t("mongoForm.tls.keyPassword")} save={f.s.spec.tls.saveKeyPassword} onSave={(v) => f.setS("spec", "tls", "saveKeyPassword", v)} />
        </Show>
        <p class="mgf-field__hint">{t("mongoForm.tls.pemOnly")}</p>
        <section class="mgf-relax" data-on={f.s.tlsRelax === "certificates" ? "" : undefined}>
          <h4>{t("mongoForm.tls.relax.title")}</h4>
          <Show
            when={relaxOk() || f.s.tlsRelax === "certificates"}
            fallback={<p class="mgf-field__hint" role="status"><Lock size={12} aria-hidden="true" /> {t("mongoForm.tls.relax.refused")}</p>}
          >
            <Switch checked={f.s.tlsRelax === "certificates"} aria-label={t("mongoForm.tls.relax.switch")} label={t("mongoForm.tls.relax.switch")} onChange={(v) => f.setS("tlsRelax", v ? "certificates" : "none")} />
            <Show when={f.s.tlsRelax === "certificates"}>
              <p class="mgf-danger" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {t("mongoForm.tls.relax.warn")}</p>
            </Show>
            <p class="mgf-field__hint">{t("mongoForm.tls.relax.noHostname")}</p>
          </Show>
        </section>
      </div>
    </LegacyLock>
  );
}

// --- Tunnel -----------------------------------------------------------------------------------------------------------------

const unixLike = () => typeof navigator === "undefined" || !/Win/i.test(navigator.platform || "");

export function TunnelTab() {
  const f = useForm();
  const kind = () => f.s.spec.tunnel.kind;
  const ssh = () => (f.s.spec.tunnel.kind === "ssh" ? f.s.spec.tunnel : undefined);
  const proxy = () => (f.s.spec.tunnel.kind === "socks5" ? f.s.spec.tunnel : undefined);
  const setKind = (k: "none" | "ssh" | "socks5") => {
    if (k === kind()) return;
    f.setS("spec", "tunnel", k === "ssh" ? newSshTunnel() : k === "socks5" ? newProxyTunnel() : { kind: "none" });
    f.setS("allowed", []);
  };
  const authOpts = () => (["agent", "keyFile", "password"] as const).map((v) => ({ value: v, label: t(`mongoForm.tunnel.auth.${v}`) }));
  // The tunnel is a union; the fields below only render for their own kind, so the loose setter is safe.
  const set = (key: string, v: unknown) => f.setS("spec", "tunnel", key as never, v as never);
  return (
    <LegacyLock>
      <div class="mgf-stack">
        <SegmentedControl
          aria-label={t("mongoForm.tunnel.kind")}
          size="sm"
          value={kind()}
          onChange={setKind}
          options={[
            { value: "none", label: t("mongoForm.tunnel.none") },
            { value: "ssh", label: t("mongoForm.tunnel.ssh"), disabled: !unixLike() },
            { value: "socks5", label: t("mongoForm.tunnel.socks5") },
          ]}
        />
        <Show when={!unixLike()}><p class="mgf-field__hint">{t("mongoForm.tunnel.unavailable")}</p></Show>
        <Show when={kind() !== "none"}><p class="mgf-banner" data-tone="info" role="note"><CircleAlert size={16} aria-hidden="true" /> <span>{t("mongoForm.tunnel.production")}</span></p></Show>
        <Show when={ssh()}>
          {(sx) => (
            <>
              <div class="mgf-grid2">
                <TextField path="tunnel.host" label={t("mongoForm.tunnel.host")} hint={t("mongoForm.tunnel.hostHint")} code value={sx().host} onInput={(v) => set("host", v)} />
                <TextField path="tunnel.port" label={t("mongoForm.tunnel.port")} code inputmode="numeric" placeholder="22" value={sx().port != null ? String(sx().port) : ""} onInput={(v) => set("port", num(v))} />
              </div>
              <TextField path="tunnel.user" label={t("mongoForm.tunnel.user")} code value={sx().user} onInput={(v) => set("user", v)} />
              <SelectField path="tunnel.auth" label={t("mongoForm.tunnel.auth.label")} value={sx().auth ?? "agent"} options={authOpts()} onChange={(v) => set("auth", v)} />
              <Show when={sx().auth === "keyFile"}>
                <TextField path="tunnel.keyFile" browse={{ purpose: "file:sshKey" }} label={t("mongoForm.tunnel.keyFile")} hint={t("mongoForm.tunnel.keyFileHint")} code placeholder="/Users/me/.ssh/id_ed25519" value={sx().keyFile ?? ""} onInput={(v) => set("keyFile", v)} />
              </Show>
              <Show when={sx().auth !== "agent"}>
                <SecretField
                  slot="sshSecret"
                  path="tunnel.secret"
                  label={sx().auth === "password" ? t("mongoForm.tunnel.password") : t("mongoForm.tunnel.passphrase")}
                  save={sx().saveSecret}
                  onSave={(v) => set("saveSecret", v)}
                  destination={t("mongoForm.tunnel.secretDest", { host: sx().host || "?" })}
                />
              </Show>
              <Checkbox size="sm" checked={sx().useSshConfig !== false} onChange={(v) => set("useSshConfig", v)} label={t("mongoForm.tunnel.useConfig")} />
              <p class="mgf-field__hint">{t("mongoForm.tunnel.noJump")}</p>
              <AllowedHosts />
              <div class="mgf-row">
                <Button size="sm" variant="secondary" icon={ShieldCheck} onClick={() => void f.checkHostKey()}>{t("mongoForm.tunnel.checkKey")}</Button>
              </div>
              <p class="mgf-field__hint">{t("mongoForm.tunnel.srvNote")}</p>
            </>
          )}
        </Show>
        <Show when={proxy()}>
          {(px) => (
            <>
              <div class="mgf-grid2">
                <TextField path="tunnel.host" label={t("mongoForm.proxy.host")} code value={px().host} onInput={(v) => set("host", v)} />
                <TextField path="tunnel.port" label={t("mongoForm.proxy.port")} code inputmode="numeric" placeholder="1080" value={String(px().port ?? "")} onInput={(v) => set("port", num(v) ?? 0)} />
              </div>
              <TextField path="tunnel.username" label={t("mongoForm.proxy.user")} code value={px().username ?? ""} onInput={(v) => set("username", v)} />
              <Show when={px().username?.trim()}>
                <SecretField slot="proxyPassword" path="tunnel.proxyPassword" label={t("mongoForm.proxy.password")} save={px().savePassword} onSave={(v) => set("savePassword", v)} />
              </Show>
              <Show when={!isLoopback(px().host) && px().host.trim() && f.s.spec.tls.mode !== "on"}>
                <p class="mgf-banner" data-tone="warn" role="status"><TriangleAlert size={16} aria-hidden="true" /> <span>{t("mongoForm.proxy.plainWarn")}</span></p>
              </Show>
              <p class="mgf-field__hint">{t("mongoForm.proxy.note")}</p>
            </>
          )}
        </Show>
      </div>
    </LegacyLock>
  );
}

function AllowedHosts() {
  const f = useForm();
  const prefill = () => {
    const rows = (f.spec().hosts ?? []).filter((h) => h.host).map((h) => `${h.host}:${h.port ?? 27017}`);
    f.setS("allowed", (cur) => [...cur, ...rows.filter((r) => !cur.includes(r))]);
  };
  return (
    <section class="mgf-allowed" aria-label={t("mongoForm.allowed.label")}>
      <h4>{t("mongoForm.allowed.label")}</h4>
      <p class="mgf-field__hint">{t("mongoForm.allowed.hint")}</p>
      <Show when={f.s.spec.scheme === "srv"}><p class="mgf-field__hint">{t("mongoForm.allowed.srv")}</p></Show>
      <Index each={f.s.allowed}>
        {(row, i) => {
          const probs = useProblems(() => `tunnel.allowedHosts.${i}`);
          return (
            <div class="mgf-hostrow">
              <Field path={`tunnel.allowedHosts.${i}`} label={t("mongoForm.allowed.row", { n: i + 1 })}>
                {(a) => <Input id={a.id} aria-describedby={a.describedBy} invalid={probs().some((p) => !p.warning)} dir="ltr" class="mgf-code" spellcheck={false} autocomplete="off" placeholder="rs1.internal:27017" value={row()} onInput={(e) => f.setS("allowed", i, e.currentTarget.value)} />}
              </Field>
              <Button class="mgf-hostrow__rm" size="sm" variant="ghost" icon={Trash2} aria-label={t("mongoForm.allowed.remove", { n: i + 1 })} onClick={() => f.setS("allowed", (cur) => cur.filter((_, j) => j !== i))} />
            </div>
          );
        }}
      </Index>
      <div class="mgf-row">
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => f.setS("allowed", (cur) => [...cur, ""])}>{t("mongoForm.allowed.add")}</Button>
        <Button size="sm" variant="ghost" onClick={prefill}>{t("mongoForm.allowed.prefill")}</Button>
      </div>
    </section>
  );
}
