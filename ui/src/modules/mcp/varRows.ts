import type { McpVarInput, McpVarView } from "../../ipc/mcp";
import { isSecretName, varNameProblem } from "./logic";

/**
 * One row of the environment or header list of the editor. The typed secret (`secretValue`) lives here and nowhere else: it is
 * read once when the form is saved, cleared right after the call and dropped with the dialog ((design notes: mcp-management-spec) 7.3).
 */
export interface VarRow {
  key: number;
  name: string;
  secret: boolean;
  /** A plain value; never filled for a secret. */
  value: string;
  /** WRITE-ONLY text typed for a new or replaced secret. */
  secretValue: string;
  /** An item for this slot exists in the Keychain: the field shows a mask, not a value. */
  stored: boolean;
  /** The user is typing a replacement for the stored secret. */
  replacing: boolean;
  /** The row came from the saved record (its secret cannot be shown, so un-ticking it needs a typed plain value). */
  wasSecret: boolean;
  existing: boolean;
}

let nextKey = 1;

export function blankRow(): VarRow {
  return { key: nextKey++, name: "", secret: false, value: "", secretValue: "", stored: false, replacing: false, wasSecret: false, existing: false };
}

export function rowsFromViews(vars: readonly McpVarView[]): VarRow[] {
  return vars.map((v) => ({
    key: nextKey++,
    name: v.name,
    secret: v.secret,
    value: v.secret ? "" : (v.value ?? ""),
    secretValue: "",
    stored: v.secret && v.present,
    replacing: false,
    wasSecret: v.secret,
    existing: true,
  }));
}

/** Names like `GITHUB_TOKEN` are always stored as secrets: the box is ticked and locked (spec 7.3). */
export const lockedSecret = (row: Pick<VarRow, "name">): boolean => isSecretName(row.name);

/** The request body: a plain row carries its value, a secret row carries `secretValue` only when something was typed (else the slot is kept). */
export function rowsToInputs(rows: readonly VarRow[]): McpVarInput[] {
  return rows
    .filter((r) => r.name.trim() !== "")
    .map((r): McpVarInput => {
      const secret = r.secret || lockedSecret(r);
      if (!secret) return { name: r.name.trim(), secret: false, value: r.value };
      return { name: r.name.trim(), secret: true, ...(r.secretValue !== "" ? { secretValue: r.secretValue } : {}) };
    });
}

export type RowProblem = "mcpBadVar" | "mcpExecVar" | "requirePlain" | null;

/** What can be said about a row before anything is sent; Rust says the rest. Duplicate names are `mcpBadVar`. */
export function rowProblem(kind: "env" | "header", row: VarRow, rows: readonly VarRow[]): RowProblem {
  const name = row.name.trim();
  if (!name) return null;
  const shape = varNameProblem(kind, name);
  if (shape) return shape;
  const same = (other: VarRow) => (kind === "header" ? other.name.trim().toLowerCase() === name.toLowerCase() : other.name.trim() === name);
  if (rows.some((o) => o !== row && same(o))) return "mcpBadVar";
  // a stored secret cannot be shown, so turning it into a plain variable asks for the value again
  return row.wasSecret && !row.secret && !lockedSecret(row) && row.value === "" ? "requirePlain" : null;
}

/** The first problem of the list: what stops "Save". */
export const firstRowProblem = (kind: "env" | "header", rows: readonly VarRow[]): RowProblem => {
  for (const r of rows) {
    const p = rowProblem(kind, r, rows);
    if (p) return p;
  }
  return null;
};

/** The non-secret part of the rows, for the editor's "is it dirty" check: typed secrets are judged separately. */
export const rowsSnapshot = (rows: readonly VarRow[]): string => JSON.stringify(rows.map((r) => [r.name, r.secret, r.value, r.replacing]));
