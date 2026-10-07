// (u) Terminal in the real window, on fixtures: the panel opens a shell per repo, a typed command runs, the shell lands in the repo
// root, a window resize reaches the pty (stty size), closing a tab kills its shell, and the jail refuses a terminal whose start
// directory is outside the fixture root. Typing goes through xterm's own textarea (a paste event, the path a user's paste takes).
// The focused terminal renders with WebGL, so there is no text in the DOM and the page cannot hijack the IPC channel: the commands
// write their results into files inside the repo, which the page reads back through the files API (and run.sh through the disk);
// the screenshots show the output itself.
await waitForTree();
fixRaf();
const [BE, AD] = FX.repoIds;
const bePath = await repoPath(BE);
const adPath = await repoPath(AD);
const tabs = () => qa('[role="tablist"][aria-label="Terminals"] [role="tab"]');
const tabTitles = () => tabs().map((t) => text(q(".term__title", t)));
const activeTab = () => tabs().find((t) => t.getAttribute("aria-selected") === "true");
const hostVisible = () => qa(".xterm", q(".term__body") ?? document.body).find((x) => x.offsetParent !== null);

async function typeCommand(cmd) {
  const ta = await waitFor(() => { const x = hostVisible(); return x && q("textarea.xterm-helper-textarea", x); }, { what: "the xterm input", timeout: 15000 });
  ta.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", cmd); // zsh turns on bracketed paste: a newline inside a paste would not run the line
  ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(150);
  ta.dispatchEvent(new InputEvent("input", { data: "\r", inputType: "insertText", bubbles: true }));
  await sleep(150);
}
/** Waits until the shell has written `rel` in the repo and returns its text. */
async function fileText(repoId, rel, what = rel, timeout = 20000) {
  return waitFor(async () => {
    const r = await invoke("files_read_file", { repoId, relPath: rel }).catch(() => null);
    return r && typeof r.text === "string" && r.text.endsWith("\n") ? r.text.trim() : null;
  }, { what: `the shell to write ${what}`, timeout, interval: 250 });
}

// ---- open: the panel starts a shell in the first repo ----------------------------------------------------------------------------------
await openRail("Terminal");
await waitFor(() => tabs().length === 1, { what: "the first terminal tab", timeout: 20000 });
check("opening the panel starts a terminal named after the first repo", tabTitles()[0] === BACKEND, tabTitles().join(","));
await waitFor(() => hostVisible(), { what: "the terminal view", timeout: 15000 });
await sleep(1000); // the shell's startup

// ---- type a command, it runs in the repo root ------------------------------------------------------------------------------------------
await typeCommand("echo hello-$((6*7))-e2e > term-out-1.txt; pwd >> term-out-1.txt; echo $$ >> term-out-1.txt");
const out1 = (await fileText(BE, "term-out-1.txt")).split("\n");
check("a typed command runs (the shell evaluated $((6*7)))", out1[0] === "hello-42-e2e", out1.join("|"));
check("the shell starts in the repo root", out1[1].replace(/^\/private/, "") === bePath.replace(/^\/private/, ""), `${out1[1]} vs ${bePath}`);
const pid1 = Number(out1[2]);
check("the shell reports its pid", pid1 > 1, out1[2]);
await typeCommand("echo hello-$((6*7))-e2e; ls");
{
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.left)},${Math.round(b.top)}`; };
  notes.termGeom = { body: r(q(".term__body")), xterm: r(hostVisible()), screen: r(q(".xterm-screen", hostVisible())), canvases: qa("canvas", q(".term__body")).map((c) => `${c.width}x${c.height} ${r(c)}`), rows: !!q(".xterm-rows", hostVisible()), hostHidden: qa(".xterm", q(".term__body")).map((x) => x.parentElement?.hidden) };
}
await sleep(500);
await snap("terminal-output");

// ---- resize: the window size reaches the pty -------------------------------------------------------------------------------------------
await typeCommand("stty size > term-size-1.txt");
const size1 = (await fileText(BE, "term-size-1.txt")).split(" ").map(Number);
const w0 = window.innerWidth;
await window.__e2e.resize(Math.max(1000, w0 - 400), 760);
await sleep(800);
await typeCommand("stty size > term-size-2.txt");
const size2 = (await fileText(BE, "term-size-2.txt")).split(" ").map(Number);
notes.sizes = JSON.stringify([size1, size2]);
check("Resize: the pty reports fewer columns after the window got narrower", size2[1] < size1[1], JSON.stringify([size1, size2]));
await window.__e2e.resize(w0, 900);

// ---- a terminal per repo --------------------------------------------------------------------------------------------------------------------
const menuBtn = await waitFor(() => qa("button").find((b) => b.getAttribute("aria-label") === "New terminal in repository"), { what: "the 'New terminal in repository' button" });
menuBtn.click();
const item = await waitFor(() => qa('[role="menuitem"]').find((i) => text(i).startsWith("admin")), { what: "admin in the repository menu" });
item.click();
await waitFor(() => tabs().length === 2 && tabTitles().includes("admin"), { what: "the admin terminal tab", timeout: 20000 });
check("New terminal in repository: a second tab named admin, active", text(q(".term__title", activeTab())) === "admin", tabTitles().join(","));
await sleep(1000);
await typeCommand(`pwd > term-pwd.txt; kill -0 ${pid1} && echo alive > term-alive-1.txt || echo dead > term-alive-1.txt`);
const pwd2 = await fileText(AD, "term-pwd.txt");
check("the admin shell starts in the admin root", pwd2.replace(/^\/private/, "") === adPath.replace(/^\/private/, ""), `${pwd2} vs ${adPath}`);
check("the first terminal's shell is alive while its tab is open", (await fileText(AD, "term-alive-1.txt")) === "alive");
await snap("terminal-two-tabs");

// ---- close leaves no process -------------------------------------------------------------------------------------------------------------------
qa("button").find((b) => b.getAttribute("aria-label") === `Close ${BACKEND}`).click();
await waitFor(() => tabs().length === 1, { what: "the first tab to go", timeout: 10000 });
await sleep(1500);
await typeCommand(`kill -0 ${pid1} 2>/dev/null && echo alive > term-alive-2.txt || echo dead > term-alive-2.txt`);
check("Close: the closed tab's shell process is gone", (await fileText(AD, "term-alive-2.txt")) === "dead");

// ---- the jail ---------------------------------------------------------------------------------------------------------------------------------------
const refused = await invoke("term_open", { opts: { cwd: "/tmp", cols: 80, rows: 24 }, onEvent: `__CHANNEL__:${window.__TAURI_INTERNALS__.transformCallback(() => {})}` }).then(() => null, (e) => e);
// /tmp is neither in a repository of the workspace nor below the home folder: the cwd constraint (T19) answers first, the jail (testJail) would otherwise
check("Jail: a terminal outside the fixture root and the workspace is refused", refused && ["pathNotValidated", "testJail"].includes(refused.code), JSON.stringify(refused));
await finish();
