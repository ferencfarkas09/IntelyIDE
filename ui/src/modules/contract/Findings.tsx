import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { fmt, t, type MessageKey } from "../../i18n";
import { repos } from "../../store/workspace";
import { Badge, CircleAlert, EmptyState, ExternalLink, FileJson, Icon, IconButton, Info, Input, Search, SegmentedControl, Select, TriangleAlert, Check, type Tone } from "../../ui-kit";
import { openHit } from "../search/openHit";
import { countBy, filterFindings, KINDS, where } from "./logic";
import type { Confidence, Finding, Kind, Report, Severity } from "./types";

const KIND_LABEL = {
  missing: "contract.kind.missing",
  renamed: "contract.kind.renamed",
  method: "contract.kind.method",
  tagMismatch: "contract.kind.tagMismatch",
  requiredParam: "contract.kind.requiredParam",
  responseField: "contract.kind.responseField",
  deprecated: "contract.kind.deprecated",
} as const satisfies Record<Kind, MessageKey>;
const SEV_LABEL = { error: "contract.sev.error", warn: "contract.sev.warn", info: "contract.sev.info" } as const satisfies Record<Severity, MessageKey>;
const CONF_LABEL = { high: "contract.conf.high", medium: "contract.conf.medium", low: "contract.conf.low" } as const satisfies Record<Confidence, MessageKey>;
const SEV_TONE: Record<Severity, Tone> = { error: "danger", warn: "warn", info: "info" };
const SEV_ICON = { error: CircleAlert, warn: TriangleAlert, info: Info };
const CONF_TONE: Record<Confidence, Tone> = { high: "ok", medium: "neutral", low: "warn" };

export const repoName = (id: string): string => repos().find((r) => r.id === id)?.name ?? id;

export function messageOf(f: Finding): string {
  const names = f.names.join(", ");
  switch (f.kind) {
    case "missing":
      return t("contract.msg.missing", { target: f.target });
    case "renamed":
      return t("contract.msg.renamed", { target: f.target });
    case "method":
      return t("contract.msg.method", { target: f.target, allowed: f.allowed.join(", ") });
    case "tagMismatch":
      return t("contract.msg.tagMismatch", { target: f.target, tags: names });
    case "requiredParam":
      return t("contract.msg.requiredParam", { target: f.target, count: f.names.length, names });
    case "responseField":
      return t("contract.msg.responseField", { target: f.target, count: f.names.length, names });
    case "deprecated":
      return t("contract.msg.deprecated", { target: f.target });
  }
}

function FindingRow(props: { f: Finding; specRepoId: string }): JSX.Element {
  const f = () => props.f;
  const swagger = () => f().swagger ?? f().suggestion?.source ?? null;
  return (
    <li class="contract__finding" data-severity={f().severity} data-testid="contract-finding">
      <span class="contract__sev" data-severity={f().severity} role="img" aria-label={t(SEV_LABEL[f().severity])}>
        <Icon icon={SEV_ICON[f().severity]} size={16} />
      </span>
      <div class="contract__fmain">
        <div class="contract__ftop">
          <Badge size="sm" tone={SEV_TONE[f().severity]}>
            {t(KIND_LABEL[f().kind])}
          </Badge>
          <code class="contract__target">{f().target}</code>
          <Badge size="sm" tone={CONF_TONE[f().confidence]} title={t("contract.heuristicTip")}>
            {t(CONF_LABEL[f().confidence])}
          </Badge>
          <Show when={f().heuristic}>
            <Badge size="sm" variant="outline" tone="neutral" title={t("contract.heuristicTip")}>
              {t("contract.heuristicTag")}
            </Badge>
          </Show>
        </div>
        <p class="contract__msg">{messageOf(f())}</p>
        <Show when={f().suggestion && f().kind === "renamed"}>
          <p class="contract__suggest">
            {t("contract.suggest", { endpoint: `${f().suggestion!.method} ${f().suggestion!.path}`, similarity: f().suggestion!.similarity })}
          </p>
        </Show>
        <div class="contract__where">
          <span class="contract__repo">{repoName(f().repoId)}</span>
          <code>{where(f())}</code>
        </div>
        <Show when={f().site.snippet}>
          <code class="contract__snippet">{f().site.snippet}</code>
        </Show>
      </div>
      <div class="contract__acts">
        <IconButton icon={ExternalLink} size="sm" label={t("contract.openCall")} onClick={() => openHit(f().site.repoId, f().site.file, f().site.line, f().site.col)} />
        <Show when={swagger()}>
          <IconButton icon={FileJson} size="sm" label={f().swagger ? t("contract.openSwagger") : t("contract.openSuggestion")} onClick={() => openHit(props.specRepoId, swagger()!.file, swagger()!.line, 1)} />
        </Show>
      </div>
    </li>
  );
}

/** The Findings view: per repo and severity filters over everything the detector reported. */
export default function Findings(props: { report: Report }) {
  const [repo, setRepo] = createSignal("");
  const [sev, setSev] = createSignal<"" | Severity>("");
  const [kind, setKind] = createSignal<"" | Kind>("");
  const [text, setText] = createSignal("");
  const rows = createMemo(() => filterFindings(props.report, { repoId: repo() || undefined, severity: sev() || undefined, kind: kind() || undefined, text: text() }));
  const everything = createMemo(() => filterFindings(props.report, {}));
  const sums = createMemo(() => countBy(rows()));
  const SHOWN = 400;
  return (
    <div class="contract__findings">
      <div class="contract__filters">
        <SegmentedControl size="sm" aria-label={t("contract.filter.repo")} value={repo()} onChange={setRepo} options={[{ value: "", label: t("contract.filter.all") }, ...props.report.clients.map((c) => ({ value: c.repoId, label: repoName(c.repoId) }))]} />
        <SegmentedControl
          size="sm"
          aria-label={t("contract.filter.severity")}
          value={sev()}
          onChange={setSev}
          options={[
            { value: "", label: t("contract.filter.all") },
            { value: "error", label: t("contract.filter.errors") },
            { value: "warn", label: t("contract.filter.warnings") },
            { value: "info", label: t("contract.filter.infos") },
          ]}
        />
        <Select size="sm" aria-label={t("contract.filter.kind")} value={kind()} onChange={setKind} options={[{ value: "", label: t("contract.filter.kindAll") }, ...KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))]} />
        <Input size="sm" wrapperClass="contract__search" aria-label={t("contract.filter.search")} placeholder={t("contract.filter.search")} leading={<Search size={14} aria-hidden="true" />} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      </div>
      <div class="contract__sums">
        <Badge tone={sums().error ? "danger" : "ok"} numeric>
          {t("contract.sumErrors", { n: sums().error })}
        </Badge>
        <Badge tone={sums().warn ? "warn" : "ok"} numeric>
          {t("contract.sumWarnings", { n: sums().warn })}
        </Badge>
        <Badge tone="neutral" numeric>
          {t("contract.sumInfos", { n: sums().info })}
        </Badge>
        <span class="contract__hint">{t("contract.findingsCount", { shown: fmt.number(Math.min(SHOWN, rows().length)), total: rows().length })}</span>
      </div>
      <Show
        when={rows().length}
        fallback={everything().length ? <EmptyState icon={Search} size="sm" title={t("contract.nothingFiltered")} description={t("contract.nothingFilteredDesc")} /> : <EmptyState icon={Check} size="sm" title={t("contract.nothing")} description={t("contract.nothingDesc")} />}
      >
        <ul class="contract__list" aria-label={t("contract.view.findings")}>
          <For each={rows().slice(0, SHOWN)}>{(f) => <FindingRow f={f} specRepoId={props.report.spec.repoId} />}</For>
        </ul>
      </Show>
    </div>
  );
}
