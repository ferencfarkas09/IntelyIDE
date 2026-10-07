import { For, Show } from "solid-js";
import { modelLabel, PERMISSION_LABEL } from "../../components/chat/format";
import { PERMISSION_TITLES } from "../roles/rolesLogic";
import { fmtTokens } from "../../components/chat/format";
import { t } from "../../i18n";
import type { PermissionMode } from "../../store/agent-types";
import { Badge, CircleAlert, EmptyState, Info, TriangleAlert, type Tone } from "../../ui-kit";
import type { CostRow, InitFacts, RoleRow } from "./model";

const MCP_TONE = (status: string): Tone => (status === "connected" ? "ok" : status === "failed" ? "danger" : "warn");

const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** The roles of the run (the delegate table joined with their calls), and what each model cost. */
function RolesTable(props: { roles: RoleRow[] }) {
  return (
    <section class="insp-roles" aria-label={t("inspector.roles.title")}>
      <h3 class="insp-roles__title">{t("inspector.roles.title")}</h3>
      <Show when={props.roles.length > 0} fallback={<p class="ui-text-3">{t("inspector.roles.none")}</p>}>
        <table class="insp-table">
          <thead>
            <tr>
              <th scope="col">{t("inspector.roles.col.role")}</th>
              <th scope="col">{t("inspector.roles.col.model")}</th>
              <th scope="col">{t("inspector.roles.col.permission")}</th>
              <th scope="col" class="insp-num">{t("inspector.roles.col.calls")}</th>
              <th scope="col" class="insp-num">{t("inspector.roles.col.denied")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.roles}>
              {(r) => (
                <tr>
                  <th scope="row">
                    <span class="insp-role">
                      <span class="insp-role__swatch" style={{ background: r.color ?? "var(--text-4)" }} aria-hidden="true" />
                      {r.name}
                    </span>
                  </th>
                  <td title={r.model}>
                    {r.model ? modelLabel(r.model) : t("inspector.roles.unknownModel")}
                    <Show when={r.actualModels.length > 0 && r.model && r.actualModels.some((m) => modelLabel(m) !== modelLabel(r.model!))}>
                      <span class="ui-text-3">{" "}→ {r.actualModels.map(modelLabel).join(", ")}</span>
                    </Show>
                  </td>
                  <td>{r.permission ? (PERMISSION_TITLES[r.permission as PermissionMode] ?? r.permission) : "–"}</td>
                  <td class="insp-num ui-tnum">{r.calls}</td>
                  <td class="insp-num ui-tnum">
                    <Show when={r.refused > 0} fallback={0}>
                      <Badge tone="danger" size="sm" numeric>{r.refused}</Badge>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <p class="insp-note ui-text-3">{t("inspector.roles.asOf")}</p>
      </Show>
    </section>
  );
}

function CostByModel(props: { rows: CostRow[] }) {
  return (
    <Show when={props.rows.length > 0}>
      <section class="insp-roles" aria-label={t("inspector.cost.byModel")}>
        <h3 class="insp-roles__title">{t("inspector.cost.byModel")}</h3>
        <table class="insp-table">
          <thead>
            <tr>
              <th scope="col">{t("inspector.roles.col.model")}</th>
              <th scope="col" class="insp-num">{t("inspector.cost.in")}</th>
              <th scope="col" class="insp-num">{t("inspector.cost.out")}</th>
              <th scope="col" class="insp-num">{t("inspector.cost.cost")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(r) => (
                <tr>
                  <th scope="row" title={r.model}>{modelLabel(r.model)}</th>
                  <td class="insp-num ui-tnum">{fmtTokens(r.inputTokens)}</td>
                  <td class="insp-num ui-tnum">{fmtTokens(r.outputTokens)}</td>
                  <td class="insp-num ui-tnum">{r.costUsd === undefined ? "–" : usd(r.costUsd)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <p class="insp-note ui-text-3">{t("inspector.cost.note")}</p>
      </section>
    </Show>
  );
}

export function FactsPane(props: { init: InitFacts | undefined; roles?: RoleRow[]; costByModel?: CostRow[] }) {
  return (
    <>
    <Show when={props.init} fallback={<EmptyState icon={Info} size="sm" title={t("inspector.facts.none")} description={t("inspector.facts.noneDesc")} />}>
      {(f) => (
        <dl class="insp-facts">
          <dt>{t("inspector.facts.model")}</dt>
          <dd title={f().model}>{modelLabel(f().model)}</dd>
          <dt>{t("inspector.facts.effort")}</dt>
          <dd>{f().effort ?? t("inspector.facts.effortNa")}</dd>
          <dt>{t("inspector.facts.permission")}</dt>
          <dd>{PERMISSION_LABEL[f().permission as PermissionMode] ?? f().permission}</dd>
          <Show when={f().sandbox}>
            <dt>{t("inspector.facts.sandbox")}</dt>
            <dd>{f().sandbox}</dd>
          </Show>
          <Show when={f().auth}>
            {(a) => (
              <>
                <dt>{t("inspector.facts.credential")}</dt>
                <dd>
                  {a().mode}
                  <span class="ui-text-3">{" "}{t("inspector.facts.source", { source: a().source })}</span>
                  <Show when={a().warning}>
                    <span class="insp-fact-warn">
                      <TriangleAlert size={12} /> {a().warning}
                    </span>
                  </Show>
                </dd>
              </>
            )}
          </Show>
          <dt>{t("inspector.facts.initCheck")}</dt>
          <dd>
            <Show when={f().assertions.length > 0} fallback={<Badge tone="ok" size="sm">{t("inspector.facts.matches")}</Badge>}>
              <ul class="insp-plain">
                <For each={f().assertions}>
                  {(a) => (
                    <li class="insp-fact-warn">
                      <CircleAlert size={12} /> {a}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </dd>
          <dt>{t("inspector.facts.mcp")}</dt>
          <dd>
            <Show when={f().mcp.length > 0} fallback={<span class="ui-text-3">{t("inspector.facts.none2")}</span>}>
              <span class="insp-chips">
                <For each={f().mcp}>{(m) => <Badge tone={MCP_TONE(m.status)}>{m.name} · {m.status}</Badge>}</For>
              </span>
            </Show>
          </dd>
          <dt>{t("inspector.facts.hooks")}</dt>
          <dd>
            <Show when={f().hooks.length > 0} fallback={<span class="ui-text-3">{t("inspector.facts.none2")}</span>}>
              <ul class="insp-plain">
                <For each={f().hooks}>{(h) => <li class="insp-mono">{h}</li>}</For>
              </ul>
            </Show>
          </dd>
          <Show when={f().nativeId}>
            <dt>{t("inspector.facts.sessionId")}</dt>
            <dd class="insp-mono">{f().nativeId}</dd>
          </Show>
        </dl>
      )}
    </Show>
    <Show when={props.init}>
      <RolesTable roles={props.roles ?? []} />
      <CostByModel rows={props.costByModel ?? []} />
    </Show>
    </>
  );
}
