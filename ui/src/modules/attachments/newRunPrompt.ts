// The New Run dialog starts a run with a plain prompt string, so its attachments travel inside it: small text files as
// fenced blocks (with the file name), images / PDFs / other files as absolute paths under the read-only attachment
// directory (every run gets it as a context directory), folders as repository paths.
import { attachApi } from "./api";
import type { AttachmentStore } from "./store";

const fence = (name: string, body: string) => {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `File: ${name}\n${f}\n${body}\n${f}`;
};

export async function promptWithAttachments(text: string, store: AttachmentStore): Promise<string> {
  const ready = store.items().filter((a) => a.status === "ready");
  if (ready.length === 0) return text;
  const root = await attachApi().root();
  const inline: string[] = [];
  const paths: string[] = [];
  for (const a of ready) {
    if (a.kind === "folder") {
      paths.push(`- ${a.path} (folder, read it with your file tools)`);
    } else if (a.kind === "text" && a.inline) {
      inline.push(fence(a.name, await (await attachApi().read(store.draftId(), a.id)).text()));
    } else {
      paths.push(`- ${root}/${store.draftId()}/${a.id}/${a.name} (${a.name}, ${a.kind})`);
    }
  }
  return [text, ...inline, paths.length ? `Attached files (read-only, read them with your file tools):\n${paths.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

// Files dropped on the window with no composer open land here until the New Run dialog opens and adopts them.
import type { DropItem } from "../../platform/dropzone";
let pending: DropItem[] = [];
export const holdForNewRun = (items: DropItem[]): void => void (pending = [...pending, ...items]);
export const takePendingForNewRun = (): DropItem[] => {
  const out = pending;
  pending = [];
  return out;
};
