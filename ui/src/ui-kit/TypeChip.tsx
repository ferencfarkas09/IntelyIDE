import { t, type MessageKey } from "../i18n";
import { Laptop, ShieldAlert, Wrench } from "./icons";
import { Badge } from "./Badge";
import "./data.css";

export type TypeTone = "accent" | "info" | "ok" | "warn" | "neutral";

/** Tone of a data type name; unknown types are neutral. */
export function typeToneOf(type: string): TypeTone {
  switch (type) {
    case "ObjectId": case "UUID": return "accent";
    case "Date": case "Timestamp": return "info";
    case "Int32": case "Int64": case "Double": case "Decimal128": case "int": case "long": case "double": case "decimal": case "number": return "ok";
    case "Boolean": case "bool": return "warn";
    default: return "neutral";
  }
}

export interface TypeChipProps {
  type: string;
  /** Share of documents (0..100) shown after the name. */
  pct?: number;
  title?: string;
}

/** A tiny monospace chip naming a data type (ObjectId, Date, String...), tinted by family. */
export function TypeChip(props: TypeChipProps) {
  return (
    <span class="ui-typechip" data-tone={typeToneOf(props.type)} title={props.title}>
      {props.type}
      {props.pct !== undefined ? <span class="ui-typechip__pct ui-tnum">{props.pct}%</span> : null}
    </span>
  );
}

export type EnvName = "local" | "sandbox" | "production";

const ENV = {
  local: { label: "kit.env.local", tone: "neutral", icon: Laptop },
  sandbox: { label: "kit.env.sandbox", tone: "warn", icon: Wrench },
  production: { label: "kit.env.production", tone: "danger", icon: ShieldAlert },
} as const satisfies Record<EnvName, { label: MessageKey; tone: string; icon: unknown }>;

/** The environment of a connection: text plus icon plus colour, never colour alone. Production is a solid danger badge. */
export function EnvPill(props: { env: EnvName; size?: "sm" | "md" }) {
  const e = () => ENV[props.env];
  return (
    <Badge tone={e().tone} variant={props.env === "production" ? "solid" : "subtle"} icon={e().icon} size={props.size ?? "md"}>
      {t(e().label)}
    </Badge>
  );
}
