// The cards this module brings. Each is a lazy chunk; `when` makes a card absent while its source is not there (the PR extra is
// off, Sentry is not set up, team chat is not connected, the night queue is off).
import { lazy } from "solid-js";
import { t } from "../../i18n";
import type { Disposer } from "../../platform/registry";
import { registerWidget } from "../../platform/widgets";
import { Bot, Bug, FolderGit2, Gauge, GitPullRequestArrow, MessageSquare, Server, Sparkles, Sun } from "../../ui-kit";
import { nightQueueEnabled } from "../brief/toggle";
import { chatLive } from "../happy-chat/state";
import { prEnabled } from "../pr/toggle";
import { status as sentryStatus } from "../sentry/store";

const MINUTE = 60_000;

export function registerBuiltinWidgets(): Disposer[] {
  return [
    registerWidget({ id: "pulse", get title() { return t("dash.pulse.title"); }, get description() { return t("dash.pulse.desc"); }, icon: Bot, category: "agents", order: 10, defaultSize: "m", component: lazy(() => import("./cards/RunPulse")) }),
    registerWidget({ id: "burn", get title() { return t("dash.burn.title"); }, get description() { return t("dash.burn.desc"); }, icon: Gauge, category: "usage", order: 20, defaultSize: "m", component: lazy(() => import("./cards/BurnDown")), refresh: { everyMs: 2 * MINUTE } }),
    registerWidget({ id: "repos", get title() { return t("dash.repos.title"); }, get description() { return t("dash.repos.desc"); }, icon: FolderGit2, category: "repos", order: 30, defaultSize: "m", component: lazy(() => import("./cards/RepoHeartbeat")) }),
    registerWidget({ id: "tips", get title() { return t("dash.tips.title"); }, get description() { return t("dash.tips.desc"); }, icon: Sparkles, category: "tips", order: 40, defaultSize: "m", component: lazy(() => import("./cards/StackTips")) }),
    registerWidget({ id: "servers", get title() { return t("dash.servers.title"); }, get description() { return t("dash.servers.desc"); }, icon: Server, category: "servers", order: 50, defaultSize: "s", component: lazy(() => import("./cards/DevServers")) }),
    registerWidget({ id: "prs", get title() { return t("dash.prs.title"); }, get description() { return t("dash.prs.desc"); }, icon: GitPullRequestArrow, category: "quality", order: 60, defaultSize: "m", when: prEnabled, component: lazy(() => import("./cards/PullRequests")), refresh: { everyMs: 10 * MINUTE } }),
    registerWidget({ id: "sentry", get title() { return t("dash.sentry.title"); }, get description() { return t("dash.sentry.desc"); }, icon: Bug, category: "quality", order: 70, defaultSize: "m", when: () => !!sentryStatus()?.configured, component: lazy(() => import("./cards/SentryTriage")), refresh: { everyMs: 10 * MINUTE } }),
    registerWidget({ id: "chat", get title() { return t("dash.chat.title"); }, get description() { return t("dash.chat.desc"); }, icon: MessageSquare, category: "team", order: 80, defaultSize: "s", when: chatLive, component: lazy(() => import("./cards/ChatPulse")) }),
    registerWidget({ id: "brief", get title() { return t("dash.brief.title"); }, get description() { return t("dash.brief.desc"); }, icon: Sun, category: "agents", order: 90, defaultSize: "s", when: nightQueueEnabled, component: lazy(() => import("./cards/MorningBrief")), refresh: { everyMs: 15 * MINUTE } }),
  ];
}
