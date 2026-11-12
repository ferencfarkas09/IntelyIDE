import { t } from "../../i18n";
import { openVisibleTab } from "../../platform/mode";
import type { Section } from "./types";

/** The one Web & Node tools tab on a section: in the middle of the Agent workspace in Agent mode, otherwise in the editor area. */
export const openWebtools = (section?: Section): string => openVisibleTab({ type: "webtools", id: "webtools", title: t("webtools.name"), params: { section: section ?? null } });
