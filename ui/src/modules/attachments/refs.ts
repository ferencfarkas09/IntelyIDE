import type { AttachmentRef } from "@intely/protocol";
import { attachApi } from "./api";
import type { FileSelection } from "./types";

/** Metadata of a draft selection as `user.message.attachments` (the mock provider and tests; the sidecar does this for real runs). */
export async function attachmentRefs(sel: FileSelection): Promise<AttachmentRef[]> {
  const metas = await attachApi().list(sel.draftId);
  return sel.ids.flatMap((id) => {
    const m = metas.find((x) => x.id === id);
    return m ? [{ id: m.id, name: m.name, mime: m.mime, size: m.size, kind: m.kind, sha256: m.sha256 }] : [];
  });
}
