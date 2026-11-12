import { createSignal } from "solid-js";
import { NO_FILTER, type SessionFilter } from "./sessionsLogic";

/** What the middle of the Agent workspace shows: the selected run's transcript or the Needs-you inbox. */
export const [centreView, setCentreView] = createSignal<"run" | "inbox">("run");
export const [sessionFilter, setSessionFilter] = createSignal<SessionFilter>(NO_FILTER);
/** The filter pills on top of the runs list: every run, only the runs that wait for the person, or only the finished runs not looked at yet. */
export type SessionStatusFilter = "all" | "needsYou" | "review";
export const [sessionStatus, setSessionStatus] = createSignal<SessionStatusFilter>("all");

/** The New run dialog; opened by the `runs.new` command from either mode. */
export const [newRunOpen, setNewRunOpen] = createSignal(false);
