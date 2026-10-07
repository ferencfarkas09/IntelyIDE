// (wsh) The in-app folder picker (INTELY_PICKER=inapp): keyboard walk into a folder, hidden toggle, Git badge, "Go to" with a quoted path
// (it validates and picks that path), a denied folder (chmod 000 fixture, restored by run.sh), the jail refusal outside the fixture root,
// the trust card of a repository with a risky config key, and a non-repository offered `git init` after typing its name (only inside
// the fixture). The browser starts in the fixture root.
// Fixture: $FX/picker/{plain-dir, risky-repo (core.fsmonitor set), locked (chmod 000), .hidden-dir}.
await phase(0, async () => {
  step("open the picker");
  await waitShell();
  await chooseSwitcherItem("Open folder");
  const d = await waitDialog(/Choose a folder/);
  const rows = () => qa('[role="option"]', d).map((o) => text(o));
  const goTo = async (path) => {
    const input = await waitFor(() => q('input[aria-label="Go to path"]', d), { what: "the Go to field" });
    await typeInto(input, path);
    input.form.requestSubmit();
    await sleep(600);
  };
  const back = () => clickButton("Choose another folder", d);

  step("walk into the fixture folder");
  await waitFor(() => rows().some((r) => r.startsWith("picker")), { what: "the picker fixture folder in the listing" });
  const list = q('[role="listbox"]', d);
  const option = (name) => qa('[role="option"]', d).find((o) => text(o).startsWith(name));
  option("picker").click();
  await press("Enter", {}, list);
  await waitFor(() => rows().some((r) => r.startsWith("risky-repo")), { what: "the contents of the fixture folder" });
  check("hidden folders are off by default", !rows().some((r) => r.startsWith(".hidden-dir")), rows().join("|"));
  check("a repository carries the Git badge", /Git/.test(rows().find((r) => r.startsWith("risky-repo")) ?? ""), rows().join("|"));
  check("a plain folder has none", !/Git/.test(rows().find((r) => r.startsWith("plain-dir")) ?? "Git"), rows().join("|"));
  const hidden = qa('input[type="checkbox"]', d).find((c) => /hidden/i.test(text(c.closest("label"))));
  hidden.click();
  await waitFor(() => rows().some((r) => r.startsWith(".hidden-dir")), { what: "hidden folders to show" });
  check("Show hidden folders reveals dot folders", true);
  hidden.click();
  await waitFor(() => !rows().some((r) => r.startsWith(".hidden-dir")), { what: "hidden folders to hide again" });

  step("denied folder");
  await goTo(`${FX.root}/picker/locked`);
  await waitFor(() => /macOS blocked access to this folder/.test(text(d)), { what: "the permission explainer" });
  check("a folder macOS refuses shows the explainer", !!findButton("Open System Settings", d) && !!findButton("Try again", d), text(d).slice(0, 200));
  await window.__e2e.screenshot("denied");
  step("jail");
  await goTo("/etc");
  await waitFor(() => /Outside the test fixture folder/.test(text(d)), { what: "the jail refusal" });
  check("a path outside the fixture root is refused", true);

  step("trust card");
  await goTo(`${FX.root}/picker/risky-repo`);
  await waitFor(() => /can run programs/.test(text(d)), { what: "the trust card" });
  const use = () => findButton("Use this folder", d);
  check("the confirm button stays off until the trust box is ticked", !!use()?.disabled || use()?.getAttribute("aria-disabled") === "true");
  await window.__e2e.screenshot("trust-card");
  qa('input[type="checkbox"]', d).find((c) => /I trust this repository/.test(text(c.closest("label")))).click();
  await waitFor(() => use() && !use().disabled, { what: "the confirm button to enable" });
  check("ticking the trust box enables it", true);
  await back();

  step("not a repository: git init");
  await goTo(`'${FX.root}/picker/plain-dir'`);   // quotes are normalised away
  await waitFor(() => findButton("Initialize Git here...", d), { what: "the init offer" });
  check("Go to understood the quoted path", /plain-dir/.test(text(d)), text(d).slice(0, 200));
  await clickButton("Initialize Git here...", d);
  const input = await waitFor(() => qa("input", d).find((i) => /^pp-init-in-/.test(i.id)), { what: "the typed confirmation field" });
  check("git init needs the folder name typed (the button is off)", !!findButton("Initialize", d)?.disabled);
  await typeInto(input, "plain-dir");
  await clickButton("Initialize", d);
  await waitFor(() => !findButton("Initialize", d) && /Git repository/.test(text(d)) && !/Not a Git repository/.test(text(d)), { what: "the folder to turn into a repository" });
  check("the fixture folder was initialised only after the confirmation", true);
  await clickButton("Cancel", d);
  await dialogGone(d);
  await finish();
});
