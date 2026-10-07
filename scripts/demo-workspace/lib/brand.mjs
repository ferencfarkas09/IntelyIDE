import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BRAND_FILE = join(HERE, "data", "brand.json");

export function loadBrand(file = BRAND_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Epoch seconds of an ISO instant. */
export const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);

/** Inclusive window [start 00:00:00Z, end 23:59:59Z] in ms. */
export function anchorWindow(brand) {
  return [Date.parse(`${brand.anchor.start}T00:00:00Z`), Date.parse(`${brand.anchor.end}T23:59:59Z`)];
}

export function originUrl(brand, id) {
  return `git@${brand.gitHost}:${brand.gitGroup}/${id}.git`;
}
