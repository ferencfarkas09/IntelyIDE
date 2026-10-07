/** Throwaway catalog trees for the i18n gate tests (`ui/src/i18n/catalogs.test.ts`); the ui package has no node typings. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `files[lang][namespace]` is the JSON content of `<dir>/<lang>/<namespace>.json`. Returns the directory and its cleanup. */
export function makeCatalogFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "intely-i18n-"));
  for (const [lang, spaces] of Object.entries(files)) {
    mkdirSync(join(dir, lang));
    for (const [ns, content] of Object.entries(spaces)) writeFileSync(join(dir, lang, `${ns}.json`), JSON.stringify(content));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
