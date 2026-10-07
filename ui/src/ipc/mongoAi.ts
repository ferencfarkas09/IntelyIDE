import { call } from "./rpc";

// The AI half of MongoDB Studio ((design notes: mongo-studio-plan) 2). It is a separate namespace from `ipc.mongo` (the gateway:
// profiles, connections, reads) so the two can be built apart; the Rust side is `crates/mongo/src/ai/pipeline.rs`
// (`prepare` = steps 1 to 4 without a model call, `generate` = steps 5 to 9). Nothing here executes a query: the result is a
// validated, explained draft that the user reviews and runs through `ipc.mongo.run`. Nothing returns documents or secrets.
// Absent optional fields arrive as null from Rust. Rejections: `mongoDisabled`, `mongoNotConnected`, `mongoAiOff` (P0), `mongoNoProvider`, `mongoNoConsent`, `mongoModelBusy` (the model did not finish: retry), `mongoCancelled`.

export interface AiAsk {
  /** The studio tab, so a repair or a Cancel can be tied to it. */
  tab: string;
  connection: string;
  db: string;
  collection: string;
  question: string;
  /** What the user has in the editors (refinement and Fix); passed through the same literal filter in Rust. */
  editor?: { filter: string; projection: string; sort: string; limit?: number; returned?: number };
  thinkHarder?: boolean;
  refreshSchema?: boolean;
  /** The caller's UTC offset (minutes east) and IANA zone name: the Generic preset words relative dates in them (D24). */
  utcOffsetMin?: number;
  tzName?: string;
}

/** The exact bytes that would leave the machine, after the PII filter. Equal to what `generate` sends. */
export interface AiPayload {
  /** `schemaEnums` adds the filtered value sets of low-cardinality fields (explicit consent). */
  mode: "schemaOnly" | "schemaEnums";
  text: string;
  bytes: number;
  tokensEstimate: number;
  /** Names the model will see; the user can add them to a deny list. */
  keptNames: string[];
  replacedNames: number;
  excludedFields: number;
  maskedLiterals: number;
  /** UI notes such as "I only generate read queries". */
  notes: string[];
}

export interface AiPlan {
  collscan: boolean;
  indexNames: string[];
  estimatedDocs?: number | null;
}

export interface AiDraft {
  /** The collection the draft is for; differs from the tab's when the question is about another one. */
  collection: string;
  filter: string;
  projection: string;
  sort: string;
  limit?: number | null;
  /** Generated from the validated query, in the language of the question. */
  explanation: string;
  /** The model's own words: untrusted plain text. */
  modelNote: string;
  assumptions: string[];
  warnings: string[];
  plan?: AiPlan | null;
  /** Copyable text, never run by the IDE. */
  indexSuggestion?: string | null;
  /** Editor fields that differ from what the user had. */
  changedFields: ("filter" | "projection" | "sort" | "limit")[];
  /** COLLSCAN on a big collection: the Run click needs one extra confirmation. */
  extraConfirm: boolean;
}

export interface AiResult {
  status: "ready" | "needsClarification" | "failed";
  draft?: AiDraft | null;
  clarification?: string | null;
  message: string;
  problems: string[];
  repairs: number;
  notes: string[];
  model: string;
  tookMs: number;
}

export interface AiIpc {
  /** Builds the payload preview without calling a model (the "What is sent?" dialog and the first-send check). */
  payload(req: AiAsk): Promise<AiPayload>;
  generate(req: AiAsk): Promise<AiResult>;
  /** Plain-language explanation of the query in the editors and its plan (values stripped, same payload dialog). */
  explain(req: AiAsk & { plan?: string[] }): Promise<{ text: string }>;
  /** Stops the tab's model call in flight (the generate call then rejects with `mongoCancelled`). Resolves true when a call was running. */
  cancel(tab: string): Promise<boolean>;
}

export function createTauriMongoAi(): AiIpc {
  return {
    payload: (req) => call("mongo_ai_payload", { req }),
    generate: (req) => call("mongo_ai_generate", { req }),
    explain: (req) => call("mongo_ai_explain", { req }),
    cancel: (tab) => call("mongo_ai_cancel", { tab }),
  };
}
