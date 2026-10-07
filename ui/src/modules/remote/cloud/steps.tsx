import { createSignal, For, Match, Show, Switch as SwitchEl, createUniqueId, type JSX } from "solid-js";
import { fmt, t } from "../../../i18n";
import { Badge, Button, Checkbox, CircleAlert, CircleCheck, CircleX, Copy, Input, KeyRound, Minus, Spinner, Switch, TriangleAlert } from "../../../ui-kit";
import { cloudApi } from "./api";
import { copyText, ErrorSummary, Fingerprint, LogPane, ReasonButton, StatusBadge, TrustNote, CostsNotice } from "./common";
import { bytesText, failedStep, hostPreview, isGuessableName, NAME_PROBLEM_KEY, overwritePhrase, needsOverwritePhrase, RETRYABLE, STEP_KEY, VERDICT_KEY, verdictAllowsApply, verdictTone, whenText } from "./logic";
import { followRun, refreshCloud } from "./store";
import { DEPLOY_STEPS, type CloudRun, type DeployResource } from "./types";
import type { Wizard } from "./wizardState";

const Row = (p: { ok: boolean; label: string; hint?: JSX.Element | string | null }) => (
  <li class="cloud-check" data-ok={p.ok ? "" : undefined}>
    <Badge tone={p.ok ? "ok" : "warn"} icon={p.ok ? CircleCheck : TriangleAlert}>
      {p.ok ? t("remote.cloud.ok") : t("remote.cloud.warn")}
    </Badge>
    <span class="cloud-check__label">{p.label}</span>
    <Show when={p.hint}>
      <span class="cloud-note">{p.hint}</span>
    </Show>
  </li>
);

/** Step 1: prerequisites. v1 works from a source checkout only (decision D10). */
export function PrereqStep(p: { w: Wizard }) {
  const v = () => p.w.view();
  const k = () => v().kit;
  const prepare = () =>
    p.w.guarded(async () => {
      const h = followRun(() => cloudApi().prepare());
      await h.started;
      const r = await h.done;
      if (r.error) p.w.setProblem({ code: r.error.code, detail: null });
    });
  // The tools and the phone app are looked at again (nothing is spawned): after installing node or pnpm, or running Prepare in a terminal.
  const recheck = () => p.w.guarded(async () => void (await refreshCloud()));
  return (
    <div class="cloud-stack">
      <Show
        when={k().found}
        fallback={
          <p class="cloud-callout" role="alert" data-testid="kit-missing">
            <CircleAlert size={14} /> {t("remote.cloud.prereq.kitMissing")}
          </p>
        }
      >
        <ul class="cloud-checks">
          <Row ok={v().secretStoreDurable} label={t("remote.cloud.prereq.secrets")} hint={v().secretStoreDurable ? null : t("remote.cloud.err.secretStoreVolatile")} />
          <Row
            ok
            label={t("remote.cloud.prereq.kit")}
            hint={k().dirtyFiles > 0 ? t("remote.cloud.prereq.dirty", { n: k().dirtyFiles }) : null}
          />
          <Row ok={k().wranglerOk} label={t("remote.cloud.prereq.wrangler", { pinned: k().wranglerPinned })} hint={k().wranglerOk ? k().wranglerVersion : t("remote.cloud.prereq.wranglerBad", { found: k().wranglerVersion ?? "-" })} />
          <Row ok={k().nodeOk && k().pnpmOk} label={t("remote.cloud.prereq.tools")} hint={k().nodeOk && k().pnpmOk ? null : t("remote.cloud.prereq.toolsMissing", { tools: [k().nodeOk ? "" : "node", k().pnpmOk ? "" : "pnpm"].filter(Boolean).join(", ") })} />
          <Row ok={k().distBuilt} label={t("remote.cloud.prereq.dist")} hint={k().distBuilt && k().distBuiltAt ? t("remote.cloud.prereq.built", { when: whenText(k().distBuiltAt!) }) : t("remote.cloud.prereq.notBuilt")} />
        </ul>
        <Show when={!p.w.prereqOk()}>
          <div class="cloud-actions">
            <Button variant="secondary" loading={p.w.busy()} disabled={v().jail === "readOnly"} onClick={() => void prepare()} data-testid="prepare">
              {t("remote.cloud.prereq.prepare")}
            </Button>
            <Button variant="ghost" disabled={p.w.busy()} onClick={() => void recheck()} data-testid="recheck">
              {t("remote.cloud.prereq.recheck")}
            </Button>
            <span class="cloud-note">{t("remote.cloud.prereq.disclosure")}</span>
          </div>
        </Show>
        <Show when={p.w.run()?.op === "prepare"}>
          <LogPane lines={p.w.log().lines} label={t("remote.cloud.log.label")} />
        </Show>
      </Show>
    </div>
  );
}

/** Step 2: sign in with Cloudflare (OAuth) or an API token; then pick the account. */
export function SignInStep(p: { w: Wizard }) {
  const radioName = createUniqueId();
  const last = () => p.w.view().auth.last;
  const login = () =>
    p.w.guarded(async () => {
      const h = followRun(() => cloudApi().login(p.w.device()));
      await h.started;
      const r = await h.done;
      if (r.status === "failed" && r.error) return p.w.setProblem({ code: r.error.code, detail: null });
      if (r.status === "ok") await check();
    });
  const check = async () => {
    await cloudApi().whoami();
    await refreshCloud();
  };
  const saveToken = () =>
    p.w.guarded(async () => {
      const value = p.w.token();
      p.w.setToken(""); // cleared at once, the value only lives in the Keychain from here
      await cloudApi().tokenSet(value);
      await check();
    });
  const chooseManual = () =>
    p.w.guarded(async () => {
      await cloudApi().chooseAccount(p.w.manualAccount().trim());
      await refreshCloud();
    });
  const choose = (id: string) =>
    p.w.guarded(async () => {
      await cloudApi().chooseAccount(id);
      await refreshCloud();
    });
  const running = () => p.w.run()?.op === "login" && p.w.run()?.status === "running";
  return (
    <div class="cloud-stack">
      <Show when={last()?.loggedIn}>
        <p class="cloud-callout cloud-callout--ok" data-testid="signed-in">
          <CircleCheck size={14} />
          <span>
            {t("remote.cloud.signin.signedIn", { how: last()!.authType === "token" ? t("remote.cloud.signin.viaToken") : t("remote.cloud.signin.viaOauth") })}
            <Show when={last()!.emailHint}> {t("remote.cloud.signin.email", { email: last()!.emailHint! })}</Show>
          </span>
        </p>
      </Show>
      <fieldset class="cloud-radios">
        <legend class="cloud-label">{t("remote.cloud.signin.how")}</legend>
        <label class="cloud-radio">
          <input type="radio" name={radioName} checked={p.w.authChoice() === "oauth"} onChange={() => p.w.setAuthChoice("oauth")} />
          <span>{t("remote.cloud.signin.oauth")}</span>
        </label>
        <label class="cloud-radio">
          <input type="radio" name={radioName} checked={p.w.authChoice() === "token"} onChange={() => p.w.setAuthChoice("token")} />
          <span>{t("remote.cloud.signin.token")}</span>
        </label>
      </fieldset>

      <Show
        when={p.w.authChoice() === "oauth"}
        fallback={
          <div class="cloud-stack">
            <label class="cloud-label" for="cloud-token">
              {t("remote.cloud.signin.tokenLabel")}
            </label>
            <div class="cloud-row">
              <Input id="cloud-token" size="sm" type="password" autocomplete="off" spellcheck={false} wrapperClass="cloud-grow" value={p.w.token()} onInput={(e) => p.w.setToken(e.currentTarget.value)} data-testid="token-input" />
              <Button size="sm" icon={KeyRound} disabled={!p.w.token().trim() || p.w.busy()} onClick={() => void saveToken()} data-testid="token-save">
                {t("remote.cloud.signin.tokenSave")}
              </Button>
            </div>
            <p class="cloud-note">{t("remote.cloud.signin.tokenHelp")}</p>
            <label class="cloud-label" for="cloud-account-id">
              {t("remote.cloud.signin.accountId")}
            </label>
            <div class="cloud-row">
              <Input id="cloud-account-id" size="sm" wrapperClass="cloud-grow" value={p.w.manualAccount()} spellcheck={false} autocomplete="off" onInput={(e) => p.w.setManualAccount(e.currentTarget.value)} />
              <Button size="sm" variant="secondary" disabled={!p.w.manualAccount().trim() || p.w.busy()} onClick={() => void chooseManual()}>
                {t("remote.cloud.signin.useAccount")}
              </Button>
            </div>
          </div>
        }
      >
        <div class="cloud-stack">
          <Checkbox checked={p.w.device()} onChange={p.w.setDevice} label={t("remote.cloud.signin.device")} />
          <div class="cloud-actions">
            <Button variant="primary" loading={running()} disabled={p.w.busy() && !running()} onClick={() => void login()} data-testid="login">
              {t("remote.cloud.signin.open")}
            </Button>
            <Show when={running()}>
              <Button variant="ghost" onClick={() => void cloudApi().stop(p.w.run()!.runId)} data-testid="login-cancel">
                {t("remote.cloud.cancel")}
              </Button>
            </Show>
          </div>
          <Show when={p.w.loginUrl()}>
            <div class="cloud-stack">
              <span class="cloud-label">{t("remote.cloud.signin.url")}</span>
              <code class="cloud-url" dir="ltr" data-testid="login-url">{p.w.loginUrl()}</code>
              <p class="cloud-note">{t("remote.cloud.signin.urlHint")}</p>
            </div>
          </Show>
          <Show when={p.w.run()?.op === "login"}>
            <LogPane lines={p.w.log().lines} label={t("remote.cloud.log.label")} />
          </Show>
          <p class="cloud-note">{t("remote.cloud.signin.scopes")}</p>
          <Checkbox checked={p.w.signOutAfter()} onChange={p.w.setSignOutAfter} label={t("remote.cloud.signin.signOutAfter")} />
        </div>
      </Show>

      <div class="cloud-actions">
        <Button size="sm" variant="secondary" disabled={p.w.busy()} onClick={() => void p.w.guarded(check)} data-testid="whoami">
          {t("remote.cloud.signin.check")}
        </Button>
      </div>

      <Show when={last()?.loggedIn && last()!.accounts.length > 1}>
        <fieldset class="cloud-radios">
          <legend class="cloud-label">{t("remote.cloud.signin.chooseAccount")}</legend>
          <For each={last()!.accounts}>
            {(a) => (
              <label class="cloud-radio">
                <input type="radio" name={`${radioName}-acc`} checked={last()!.chosenAccountId === a.id} onChange={() => void choose(a.id)} />
                <span>
                  {a.name} <span class="cloud-note cloud-mono">…{a.id.slice(-4)}</span>
                </span>
              </label>
            )}
          </For>
        </fieldset>
      </Show>
      <Show when={last()?.loggedIn && !last()!.chosenAccountId && last()!.accounts.length <= 1}>
        <p class="cloud-note">{t("remote.cloud.err.needsAccount")}</p>
      </Show>
    </div>
  );
}

/** Step 3: worker name and the push switch. */
export function NameStep(p: { w: Wizard }) {
  const sub = () => p.w.view().workersSubdomain;
  return (
    <div class="cloud-stack">
      <label class="cloud-label" for="cloud-worker-name">
        {t("remote.cloud.name.label")}
      </label>
      <Input id="cloud-worker-name" size="sm" value={p.w.name()} spellcheck={false} autocomplete="off" autocapitalize="off" invalid={!!p.w.nameErr()} aria-describedby="cloud-name-msg" onInput={(e) => p.w.setName(e.currentTarget.value.trim())} data-testid="worker-name" dir="ltr" />
      <p id="cloud-name-msg" class="cloud-note" classList={{ "cloud-warn": !!p.w.nameErr() }}>
        <Show when={p.w.nameErr()} fallback={isGuessableName(p.w.name()) ? t("remote.cloud.name.guessable") : t("remote.cloud.name.rule")}>
          {(e) => t(NAME_PROBLEM_KEY[e()])}
        </Show>
      </p>
      <div class="cloud-row cloud-row--between">
        <div class="cloud-stack cloud-stack--tight">
          <span class="cloud-label">{t("remote.cloud.name.push")}</span>
          <span class="cloud-note">{t("remote.cloud.name.pushHint")}</span>
        </div>
        <Switch checked={p.w.push()} onChange={p.w.setPush} aria-label={t("remote.cloud.name.push")} />
      </div>
      <p class="cloud-note">
        {t("remote.cloud.name.address")} <code class="cloud-mono" dir="ltr">https://{hostPreview(p.w.name(), sub())}</code>
      </p>
      <Show when={!sub()}>
        <p class="cloud-callout" role="note" data-testid="no-subdomain">
          <TriangleAlert size={14} /> {t("remote.cloud.name.noSubdomain")}
        </p>
      </Show>
    </div>
  );
}

const RESOURCE_KEY = {
  worker: "remote.cloud.res.worker",
  durableObject: "remote.cloud.res.durableObject",
  assets: "remote.cloud.res.assets",
  route: "remote.cloud.res.route",
  routeWorkersDev: "remote.cloud.res.routeWorkersDev",
  secret: "remote.cloud.res.secret",
} as const;
/** The review list in the UI language: Rust sends the kind and the bare values (a name, a domain, a migration tag), never a sentence. */
export const resourceText = (r: DeployResource): string => (r.kind in RESOURCE_KEY ? t(RESOURCE_KEY[r.kind as keyof typeof RESOURCE_KEY], { label: r.label, tag: r.detail ?? "" }) : r.label);

/** Step 4: everything that will happen, then the typed confirmation. */
export function ReviewStep(p: { w: Wizard }) {
  const reasonId = createUniqueId();
  const [showFiles, setShowFiles] = createSignal(false);
  const [showFull, setShowFull] = createSignal(false);
  const pv = () => p.w.preview();
  const nameCheckText = (c: string) => t(`remote.cloud.review.check.${c}` as never);
  const blockText = () => {
    const b = p.w.block();
    return b === "ack" ? t("remote.cloud.block.ack") : b === "unverified" ? t("remote.cloud.block.unverified") : b === "name" ? t("remote.cloud.block.typed", { text: pv()?.workerName ?? "" }) : b === "overwrite" ? t("remote.cloud.block.typed", { text: overwritePhrase(pv()?.workerName ?? "") }) : null;
  };
  // the command of the plan Rust holds for this review (the same argv the deploy is held to), not a client-side rebuild of it
  const cmd = () => p.w.plan()?.argv.join(" ") ?? "";
  return (
    <div class="cloud-stack">
      <Show when={pv()} fallback={<div class="cloud-center"><Spinner /> <span class="cloud-note">{t("remote.cloud.review.loading")}</span></div>}>
        {(d) => (
          <>
            <dl class="cloud-dl">
              <dt>{t("remote.cloud.review.account")}</dt>
              <dd>
                {d().account.name} <span class="cloud-note cloud-mono">…{d().account.idTail}</span>
              </dd>
              <dt>{t("remote.cloud.review.worker")}</dt>
              <dd>
                <span class="cloud-mono" dir="ltr">{d().workerName}</span>{" "}
                <Badge tone={d().nameCheck === "free" || d().nameCheck === "mine" ? "ok" : "warn"} icon={d().nameCheck === "free" || d().nameCheck === "mine" ? CircleCheck : TriangleAlert} data-testid="name-check">
                  {nameCheckText(d().nameCheck)}
                </Badge>
              </dd>
              <dt>{t("remote.cloud.review.host")}</dt>
              <dd class="cloud-mono" dir="ltr">https://{hostPreview(d().workerName, p.w.view().workersSubdomain)}</dd>
              <dt>{t("remote.cloud.review.bundle")}</dt>
              <dd>
                <button type="button" class="cloud-hash" dir="ltr" onClick={() => setShowFull(!showFull())} aria-expanded={showFull()} title={t("remote.cloud.review.showFull")}>
                  {d().bundle.hashShort}
                </button>
                <Show when={showFull()}>
                  <div class="cloud-mono cloud-break" dir="ltr">{d().bundle.hashFull}</div>
                </Show>
                <div class="cloud-note">
                  {t("remote.cloud.review.key")} <Fingerprint value={d().bundle.pubFingerprint} />
                </div>
              </dd>
            </dl>

            <div>
              <span class="cloud-label">{t("remote.cloud.review.resources")}</span>
              <ul class="cloud-list">
                <For each={d().resources}>{(r) => <li>{resourceText(r)}</li>}</For>
              </ul>
            </div>

            <div>
              <div class="cloud-row cloud-row--between">
                <span class="cloud-label">{t("remote.cloud.review.command")}</span>
                <Button size="sm" variant="ghost" icon={Copy} onClick={() => copyText(cmd())}>
                  {t("remote.cloud.copy")}
                </Button>
              </div>
              <pre class="cloud-cmd" dir="ltr" data-testid="review-cmd">{cmd()}</pre>
              <Show when={p.w.plan()}>
                {(pl) => (
                  <p class="cloud-note">
                    {t("remote.cloud.review.dir")} <span class="cloud-mono" dir="ltr" data-testid="review-dir">{pl().cwd}</span>
                  </p>
                )}
              </Show>
              <p class="cloud-note">
                {t("remote.cloud.review.env")} <span class="cloud-mono" dir="ltr">{d().envNames.join(", ")}</span>
              </p>
            </div>

            <div class="cloud-row">
              <Button size="sm" variant="ghost" aria-expanded={showFiles()} onClick={() => setShowFiles(!showFiles())}>
                {t("remote.cloud.review.showFiles", { n: d().files.count, size: bytesText(d().files.bytes) })}
              </Button>
            </div>
            <Show when={showFiles()}>
              <table class="cloud-table cloud-table--files" dir="ltr">
                <tbody>
                  <For each={d().fileList}>
                    {(f) => (
                      <tr>
                        <td>{f.path}</td>
                        <td class="cloud-num">{bytesText(f.size)}</td>
                        <td class="cloud-mono">{f.sha256.slice(0, 16)}…</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <Show when={d().needsUnverifiedAck}>
              <p class="cloud-callout" role="note" data-testid="modules-unverified">
                <TriangleAlert size={14} /> {t("remote.cloud.review.unverified")}
              </p>
            </Show>
            <Show when={d().signingKeyStaged || d().vapidKeyStaged}>
              <p class="cloud-note" data-testid="rotation-staged">{t("remote.cloud.review.rotation")}</p>
            </Show>
            <Show when={d().kitDirtyFiles > 0}>
              <p class="cloud-callout" role="note" data-testid="kit-dirty">
                <TriangleAlert size={14} /> {t("remote.cloud.review.dirty", { n: d().kitDirtyFiles })}
              </p>
            </Show>
            <TrustNote />
            <CostsNotice notice={p.w.view().limits} />

            <div class="cloud-stack cloud-confirm">
              <Checkbox checked={p.w.ack()} onChange={p.w.setAck} label={t("remote.cloud.review.ack")} />
              <Show when={d().needsUnverifiedAck}>
                <Checkbox checked={p.w.ackUnverified()} onChange={p.w.setAckUnverified} label={t("remote.cloud.review.unverifiedAck")} data-testid="ack-unverified" />
              </Show>
              <label class="cloud-label" for="cloud-type-name">
                {t("remote.cloud.typeToConfirm", { text: d().workerName })}
              </label>
              <Input id="cloud-type-name" size="sm" value={p.w.typed()} spellcheck={false} autocomplete="off" autocapitalize="off" onInput={(e) => p.w.setTyped(e.currentTarget.value)} data-testid="confirm-name" dir="ltr" />
              <Show when={needsOverwritePhrase(d().nameCheck, d().kitDirtyFiles)}>
                <label class="cloud-label" for="cloud-type-overwrite">
                  {t("remote.cloud.typeToConfirm", { text: overwritePhrase(d().workerName) })}
                </label>
                <Input id="cloud-type-overwrite" size="sm" value={p.w.typedOverwrite()} spellcheck={false} autocomplete="off" autocapitalize="off" onInput={(e) => p.w.setTypedOverwrite(e.currentTarget.value)} data-testid="confirm-overwrite" dir="ltr" />
              </Show>
              <div class="cloud-actions">
                <ReasonButton variant="primary" reason={blockText()} reasonId={reasonId} loading={p.w.busy()} onClick={() => void p.w.runDeploy()} data-testid="deploy">
                  {t("remote.cloud.review.deploy")}
                </ReasonButton>
              </div>
              <p id={reasonId} class="cloud-note" aria-live="polite" data-testid="deploy-reason">
                {blockText() ?? t("remote.cloud.block.ready")}
              </p>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

const StepIcon = (p: { status: string }) => (
  <SwitchEl fallback={<span class="cloud-dot" />}>
    <Match when={p.status === "running"}>
      <Spinner size={14} />
    </Match>
    <Match when={p.status === "ok"}>
      <CircleCheck size={14} class="cloud-ico-ok" />
    </Match>
    <Match when={p.status === "failed"}>
      <CircleX size={14} class="cloud-ico-bad" />
    </Match>
    <Match when={p.status === "skipped"}>
      <Minus size={14} />
    </Match>
  </SwitchEl>
);

/** Step 5: the deploy job. */
export function DeployStep(p: { w: Wizard; onBackToReview: () => void; onNext: () => void }) {
  const steps = (): CloudRun["steps"] => p.w.run()?.steps ?? DEPLOY_STEPS.map((s) => ({ step: s, status: "pending" as const }));
  const running = () => p.w.run()?.status === "running";
  const failed = () => failedStep(p.w.run());
  return (
    <div class="cloud-stack">
      <ol class="cloud-steps" aria-label={t("remote.cloud.deploy.steps")}>
        <For each={steps()}>
          {(s) => (
            <li data-status={s.status}>
              <StepIcon status={s.status} />
              <span>{t(STEP_KEY[s.step])}</span>
              <span class="ui-sr-only">{t(`remote.cloud.status.${s.status}` as never)}</span>
              <Show when={s.code}>
                <span class="cloud-note">{t(`remote.cloud.err.${s.code}` as never)}</span>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <LogPane lines={p.w.log().lines} label={t("remote.cloud.log.label")} />
      <div class="cloud-actions">
        <Show when={running()}>
          <Button variant="secondary" onClick={() => void cloudApi().stop(p.w.run()!.runId)} data-testid="stop">
            {t("remote.cloud.stop")}
          </Button>
        </Show>
        <Show when={p.w.run()?.status === "ok"}>
          <Button variant="primary" onClick={p.onNext} data-testid="deploy-continue">
            {t("remote.cloud.continue")}
          </Button>
        </Show>
      </div>
      <Show when={p.w.run()?.error}>
        <ErrorSummary code={p.w.run()!.error!.code} tail={p.w.run()!.error!.tail} />
        <div class="cloud-actions">
          <Show when={failed() && RETRYABLE.includes(failed()!)}>
            <Button variant="secondary" onClick={() => void p.w.retryDeploy()} data-testid="retry">
              {t("remote.cloud.deploy.retry")}
            </Button>
          </Show>
          <Button variant="ghost" onClick={p.onBackToReview}>
            {t("remote.cloud.deploy.backToReview")}
          </Button>
        </div>
      </Show>
      <Show when={p.w.run()?.status === "cancelled"}>
        <p class="cloud-note" role="status">{t("remote.cloud.deploy.cancelled")}</p>
        <Button variant="ghost" onClick={p.onBackToReview}>{t("remote.cloud.deploy.backToReview")}</Button>
      </Show>
    </div>
  );
}

/** Step 6: health and bundle verdict; "Use this relay now" is the only thing that applies the URL. */
export function VerifyStep(p: { w: Wizard; onUse: () => void; using: boolean; canUse: boolean }) {
  const c = () => p.w.check() ?? p.w.view().lastCheck;
  const recheck = () =>
    p.w.guarded(async () => {
      p.w.setCheck(await cloudApi().verify({ target: "deployed" }));
      await refreshCloud();
    });
  const yn = (b: boolean | null | undefined) => (b == null ? t("remote.cloud.unknown") : b ? t("remote.cloud.yes") : t("remote.cloud.no"));
  return (
    <div class="cloud-stack">
      <Show when={c()} fallback={<p class="cloud-note">{t("remote.cloud.verify.none")}</p>}>
        {(ch) => (
          <dl class="cloud-dl" data-testid="verify-result">
            <dt>{t("remote.cloud.status.reachable")}</dt>
            <dd>
              <StatusBadge tone={ch().reachable ? "ok" : "danger"}>{yn(ch().reachable)}</StatusBadge>
              <Show when={ch().latencyMs != null}> <span class="cloud-note">{t("remote.cloud.status.latency", { ms: ch().latencyMs! })}</span></Show>
            </dd>
            <dt>{t("remote.cloud.status.version")}</dt>
            <dd>{ch().relayVersion ?? "-"}</dd>
            <dt>{t("remote.cloud.status.do")}</dt>
            <dd>{yn(ch().doOk)}</dd>
            <dt>{t("remote.cloud.verify.push")}</dt>
            <dd>{yn(ch().pushConfigured)}</dd>
            <dt>{t("remote.cloud.verify.verdict")}</dt>
            <dd>
              <StatusBadge tone={verdictTone(ch().verdict)}>{t(VERDICT_KEY[ch().verdict])}</StatusBadge>
            </dd>
          </dl>
        )}
      </Show>
      <div class="cloud-actions">
        <Button variant="secondary" disabled={p.w.busy()} onClick={() => void recheck()} data-testid="recheck">
          {t("remote.cloud.checkAgain")}
        </Button>
        <ReasonButton variant="primary" reason={c() && verdictAllowsApply(c()!.verdict, false) ? null : t("remote.cloud.verify.blocked")} reasonId="cloud-use-reason" loading={p.using} onClick={p.onUse} data-testid="use-relay">
          {t("remote.cloud.useNow")}
        </ReasonButton>
      </div>
      <Show when={!(c() && verdictAllowsApply(c()!.verdict, false))}>
        <p id="cloud-use-reason" class="cloud-note">{t("remote.cloud.verify.blocked")}</p>
      </Show>
    </div>
  );
}

/** Step 7. */
export function DoneStep(p: { w: Wizard; onPair: () => void; remoteOn: boolean }) {
  const prof = () => p.w.view().profile;
  return (
    <div class="cloud-stack">
      <p class="cloud-callout cloud-callout--ok">
        <CircleCheck size={14} /> {p.w.applied() ? t("remote.cloud.done.applied") : t("remote.cloud.done.notApplied")}
      </p>
      <Show when={prof()}>
        {(pr) => (
          <dl class="cloud-dl">
            <dt>{t("remote.cloud.done.address")}</dt>
            <dd class="cloud-mono cloud-break" dir="ltr">{pr().url}</dd>
            <dt>{t("remote.cloud.review.account")}</dt>
            <dd>{pr().accountName} <span class="cloud-note cloud-mono">…{pr().accountIdTail}</span></dd>
            <Show when={p.w.view().bundle}>
              {(b) => (
                <>
                  <dt>{t("remote.cloud.review.bundle")}</dt>
                  <dd class="cloud-mono" dir="ltr">{b().hashShort}</dd>
                </>
              )}
            </Show>
          </dl>
        )}
      </Show>
      <div class="cloud-actions">
        <Button variant="primary" disabled={!p.remoteOn} onClick={p.onPair} data-testid="done-pair">
          {t("remote.pair")}
        </Button>
        <Show when={!p.remoteOn}>
          <span class="cloud-note">{t("remote.switchOnFirst")}</span>
        </Show>
      </div>
      <Show when={p.w.view().auth.authMode === "oauth" && p.w.view().auth.last?.loggedIn}>
        <Checkbox checked={p.w.signOutAfter()} onChange={p.w.setSignOutAfter} label={t("remote.cloud.signin.signOutAfter")} />
      </Show>
    </div>
  );
}
export { fmt };
