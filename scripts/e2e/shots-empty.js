// Shot tour on a workspace without repositories: the empty state.
await window.__e2e.resize(1440, 900);
await waitFor(() => /No repositories/.test(document.body.innerText), { what: "empty state", timeout: 20000 });
await sleep(400);
notes.shots = await both("empty");
await finish();
