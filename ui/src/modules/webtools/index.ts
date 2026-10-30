// Web and Node tools: design tokens and unused styles of CSS/SCSS, heuristic React checks, a bundle size report, a route map of
// Node backends, a `.env` comparison and an opt-in dependency check, in one tab where each tool shows only when its files exist.
// A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { Globe } from "../../ui-kit";
import type { Section } from "./types";
import { webtoolsEnabled } from "./toggle";

let live: (() => void)[] = [];

const COMMANDS: { id: string; section?: Section; title: MessageKey; keywords: string[] }[] = [
  { id: "webtools.open", title: "webtools.cmd.open", keywords: ["web", "node", "css", "scss", "react", "express", "tools"] },
  { id: "webtools.tokens", section: "tokens", title: "webtools.cmd.tokens", keywords: ["design tokens", "css variables", "custom properties", "scss variables", "colors", "colours", "swatch"] },
  { id: "webtools.styles", section: "styles", title: "webtools.cmd.styles", keywords: ["unused css", "unused styles", "dead css", "class"] },
  { id: "webtools.react", section: "react", title: "webtools.cmd.react", keywords: ["react", "accessibility", "alt", "label", "key", "large component", "a11y"] },
  { id: "webtools.bundle", section: "bundle", title: "webtools.cmd.bundle", keywords: ["bundle", "size", "dist", "build output", "weight"] },
  { id: "webtools.routes", section: "routes", title: "webtools.cmd.routes", keywords: ["routes", "api", "express", "fastify", "nest", "next", "endpoint", "try it"] },
  { id: "webtools.env", section: "env", title: "webtools.cmd.env", keywords: ["env", "environment", "dotenv", "gitignore", "secrets"] },
  { id: "webtools.deps", section: "deps", title: "webtools.cmd.deps", keywords: ["npm", "outdated", "audit", "dependencies", "upgrade"] },
];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "webtools", get title() { return t("webtools.name"); }, icon: Globe, component: lazy(() => import("./WebtoolsTab")), canClose: true }),
    ...COMMANDS.map((c) =>
      registerCommand({
        id: c.id,
        get title() { return t(c.title); },
        get group() { return t("webtools.name"); },
        keywords: c.keywords,
        run: () => void openTab({ type: "webtools", id: "webtools", title: t("webtools.name"), params: { section: c.section ?? null } }),
      }),
    ),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "webtools", get title() { return t("webtools.section.name"); }, order: 124, icon: Globe, searchTerms: ["web", "node", "css", "scss", "react", "express", "env", "npm"], component: lazy(() => import("./WebtoolsSection")) });
  createRoot(() => createEffect(() => (webtoolsEnabled() ? activate() : deactivate())));
}
