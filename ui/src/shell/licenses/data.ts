import type { LicenseIndex, LicenseTexts } from "./types";

export class LicenseDataError extends Error {
  constructor(readonly kind: "schema" | "missing" | "load", message?: string) {
    super(message ?? kind);
    this.name = "LicenseDataError";
  }
}

// Lazy like the i18n catalogs: nothing is fetched before the view opens, and a build without the generated files still works.
const files = import.meta.glob<{ default: unknown }>("./data/*.json");

let indexP: Promise<LicenseIndex> | undefined;
let textsP: Promise<LicenseTexts> | undefined;

async function read(name: string): Promise<unknown> {
  const load = files[`./data/${name}.json`];
  if (!load) throw new LicenseDataError("missing", `${name}.json is not part of this build`);
  try {
    return (await load()).default;
  } catch (e) {
    throw new LicenseDataError("load", e instanceof Error ? e.message : String(e));
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function checkIndex(v: unknown): LicenseIndex {
  if (!isObj(v) || v.schema !== 1 || !isObj(v.project) || !Array.isArray(v.components) || !Array.isArray(v.groups)) throw new LicenseDataError("schema");
  return v as unknown as LicenseIndex;
}

export function checkTexts(v: unknown): LicenseTexts {
  if (!isObj(v) || v.schema !== 1 || !isObj(v.texts)) throw new LicenseDataError("schema");
  return v as unknown as LicenseTexts;
}

/** Memoized; a failed load is dropped so Retry works. */
export function loadIndex(): Promise<LicenseIndex> {
  if (!indexP) {
    const p = read("index").then(checkIndex);
    p.catch(() => {
      if (indexP === p) indexP = undefined;
    });
    indexP = p;
  }
  return indexP;
}

export function loadTexts(): Promise<LicenseTexts> {
  if (!textsP) {
    const p = read("texts").then(checkTexts);
    p.catch(() => {
      if (textsP === p) textsP = undefined;
    });
    textsP = p;
  }
  return textsP;
}

/** Tests only. */
export function resetLicensesCache(): void {
  indexP = undefined;
  textsP = undefined;
}
