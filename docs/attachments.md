# Attachments: drag-and-drop, paste and picker

Files and images can be dragged into the window, pasted with Cmd+V or picked with the (+) button and become attachments of the open prompt, chat or agent composer. This file is the design, the limits, the privacy rules and the manual test.

## Where things are
| What | Where |
|---|---|
| Drop router (registry, overlay state, sources) | `ui/src/platform/dropzone.ts` |
| Store, chips, image pipeline, lightbox, overlay, composer glue | `ui/src/modules/attachments/**` |
| Copy-in store, guards, limits, cleanup (Tauri-free) | `crates/attachments` (`intely-attachments`) |
| Tauri commands `attachment_*` | `src-tauri/src/modules/attachments.rs` |
| `user.message.attachments`, `ProviderCaps.attachments` | `crates/agent_core` -> `packages/protocol` |
| SDK content mapping | `sidecar/src/adapters/claude-sdk/attachments.ts` |
| Browser test | `scripts/e2e/attachments-drop.mjs` |

## Drop sources: the Tauri decision
`tauri.conf.json` keeps the default `dragDropEnabled: true`. Read from the sources of tauri 2.12.1 / wry 0.57 (not from a live drag, see "Manual check"):
- With it **on**, wry's WKWebView drag handler reads `NSFilenamesPboardType`, so **Finder files, Desktop screenshots and anything with a file path arrive as real absolute paths** (`onDragDropEvent`: `enter`/`over`/`drop`/`leave`, with the position). The webview's own HTML5 `drop` does not fire for external drags.
- With it **off**, HTML5 `dataTransfer` works but WKWebView exposes `File` objects without paths (no way to copy a 2 GB folder reference, no Finder path for the terminal).
- Images dragged out of a **browser** carry no file path (URL or image data only). Under the native handler they arrive as an event with **no paths**, so the router has nothing to attach. This is the limit of the native route: **for browser images use Copy image, then Cmd+V in the composer** (the paste handler reads `clipboardData.files`).
- In the browser/mock UI (Vite, Playwright) there is no native layer: the router uses the HTML5 `dragenter/over/drop` events with real `File` objects, and the same code path for paste and the (+) picker.

Both sources feed one `DropRouter`; a native drop within 500 ms suppresses the HTML5 duplicate, and if the config ever flips to `dragDropEnabled: false` the HTML5 route keeps working (files without paths are imported as bytes). The (+) button uses `<input type=file>` (no dialog plugin dependency); in the app the picked `File` goes through `attachment_import_bytes`.

## Targets
Registered with `registerDropTarget({ id, priority, label, title?, accepts, isActive, onDrop, element?, ignores?, hint?, refusal? })`. Choice: a target whose `element()` rect contains the pointer beats priority; otherwise the highest `priority` among active, accepting targets. While dragging, a full-window overlay says "Drop to attach to" followed by the label (or `title`) and outlines the target, or states why nothing accepts.

| Target | Priority | Behaviour |
|---|---|---|
| New Run prompt box (dialog open) | 95 (+50 focused) | chips + paste + (+) in the dialog; the files go into the first prompt |
| Agent composer | 50 (+50 when it has focus) | chips, sent as `files` with `agent_send` |
| Terminal | 30 | shell-escaped absolute paths, space separated, like Terminal.app (paths only) |
| Editor area | 30 | a file inside a registered repo opens in an editor tab (`editor.openFile`); outside repos: a toast, **read-only open is not implemented** |
| "Start a new run with these attachments" | 10 | fallback when no composer is visible: opens the New Run dialog with the files |
| Commit message box, Changes tree | ignore | "Files are not used in commit messages" hint, nothing happens |

A future Mongo Studio AI bar registers itself the same way, e.g. `registerDropTarget({ id: "mongo.aiBar", priority: 60, label: "the AI bar", accepts: (items) => items.every((i) => i.mime === "application/json" || i.name.endsWith(".json")), isActive: () => visible(), onDrop: (items) => ... })`; `DropItem.blob`/`path` carry the sample. Text and URL drags are normalised to `kind: "text" | "url"` for such targets; composers ignore them.

Folders: a folder inside a registered repo becomes a **path reference chip** (sent as an `@path` mention, the agent reads it with its tools). A folder outside the registered repos is refused with a chip error (offering it as a read-only context directory after confirmation is not built, see "Not done").

Providers: `ProviderCaps.attachments` is `none | images | imagesPdf | files`. A composer refuses a drop/paste that the provider cannot take, with a message from the caps ("the provider accepts images only", with its name); the (+) button is disabled for `none`.

## Limits and processing
| Kind | Limit | Handling |
|---|---|---|
| Image | longest side 1568 px, 5 MB after processing | decoded with `createImageBitmap` (HEIC where WKWebView decodes it, else a clear error), orientation applied, EXIF/GPS/XMP removed, compressed (JPEG quality 0.9 down to 0.55, then 80 % size steps); a JPEG/PNG that already fits is only stripped losslessly. A path-imported original may be up to 40 MB in the store until processed, then it is replaced by the processed copy |
| Text | 200 KB inlined | `File: name` + a fence longer than any backtick run in the file; bigger text files are referenced by path |
| PDF | 10 MB | sent as a document block |
| Other files | 25 MB | copied into the store, referenced by path under the read-only context directory |
| Draft | 100 MB total | |

Dedupe by SHA-256 within a draft ("already attached"). Names are sanitised to one path component; ids are `[A-Za-z0-9_-]{1,64}`.

## Guards and privacy
- Secret names (`.env`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `credentials.json`, ...; `intely_core::guard`), never-add directories (`dump_*`, `.history`, ...), the agents' never-read credential directories (`.ssh`, `.aws`, ...) and private-key contents produce a **blocking warning chip**: "May contain secrets (...); would be sent to the provider." It needs the explicit "Attach anyway" button. Send is disabled until then, **and the Rust side refuses to resolve an unconfirmed guarded file for `agent_send`** (fail closed), so a UI bug cannot leak it.
- A privacy line under the chips names the provider that receives the files (`Anthropic (Claude)`; the mock provider says nothing leaves the machine).
- Files are **copies**: `~/Library/Application Support/IntelyIDE/attachments/<draftId>/<id>/<name>` (+ `<id>.json`). No command reads an arbitrary path except `attachment_import_paths`, which copies exactly the dropped files. Drafts persist across restarts (the composer keeps its `draftId` in localStorage) and are removed 7 days after their newest attachment (sweep at startup and `attachment_cleanup`). After a send the composer starts a fresh draft; the sent message's files stay for the 7 days.
- The store is inside the state directory that agents may neither read nor write. It is exposed as **one read-only context directory**: `<state>/attachments` is added to every run's `add_dirs`, `Jail::never_read_reason` exempts that subtree from the state-dir read ban, and `protected_reason` still hard-stops every write. A secret-looking name inside it is still unreadable by tools (a confirmed secret file is only ever sent inline by the sidecar). Test: `bypass.rs::the_attachment_store_is_a_read_only_context_directory`.
- Transcripts store only metadata (`id, name, mime, size, kind, sha256`), never contents or paths.

## Agent integration
`session/prompt.attachments` (resolved records incl. the absolute store path) -> sidecar emits `user.message {text, attachments: AttachmentRef[]}` (no path) and calls `session.prompt({text, attachments})`. Claude adapter: PNG/JPEG/GIF/WebP -> base64 `image` blocks, PDF -> `document` block, text <= 200 KB -> inline fenced text block, everything else -> a text block listing absolute paths. The mock provider needs nothing: the user message carries the chips, and the transcript renders thumbnails (lightbox on click) and file chips. The New Run dialog starts a run with a plain prompt, so its attachments travel inside the prompt text (inlined text, paths for the rest); that first message has no chips.

## Manual check (2 minutes, needs a real drag)
OS-level drags cannot be automated. Verified without them: the router and the import with injected native payloads (`handleNativeDrag`, also exposed as `window.__intelyDrop.native({type:"drop",paths:[...],position:{x,y}})` for a Tauri e2e script), the HTML5 route with real `File` objects in headless Chrome, the Rust store on fixture paths. Please check once in `pnpm tauri dev`:
1. Open Agent mode, select a run that is not running. Drag a **Desktop screenshot** from Finder over the window: the overlay says "Drop to attach to the agent composer" and the composer is outlined. Drop: a chip with a thumbnail appears (resized note if larger than 1568 px).
2. Drag three files at once (an image, a `.md`, a `.pdf`): three chips. Drag a folder that is inside a registered repo: a folder chip; a folder outside: a red chip.
3. Drag a file named `.env`: a warning chip, Send disabled; "Attach anyway" enables it. Send: the message shows the thumbnails; click one for the lightbox (Esc closes).
4. With the terminal open, drag a file onto the terminal strip: its escaped path is typed at the prompt. Drag a file from a registered repo onto the editor: it opens in a tab.
5. In Safari/Chrome, Copy image, then Cmd+V in the composer: a chip. (Dragging that image straight from the browser is expected to do nothing, see above.)
6. Drag over the commit message box: the overlay says files are not used there.
If the drop lands on the wrong target the native coordinates need the other scale (see `cssPoint` in `dropzone.ts`).

## Not done
- Folders outside registered repos as a confirmed read-only context directory; opening a file outside the repos read-only in the editor.
- New Run attachments as chips on the first message; dragging browser images directly (paste is the route).
- Provider caps beyond Claude/mock (Codex, Gemini) set `attachments` at their adapters when those land.
- The sidecar must be rebuilt (`sidecar/dist`) before the real app sends attachments.
