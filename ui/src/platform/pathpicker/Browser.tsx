import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { EngineError } from "../../bindings";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { DirEntry, DirListing, Picked, PickKind, PickPurpose, ProtectedFolder, StartInfo } from "../../ipc/picker";
import { ArrowLeft, ArrowRight, ArrowUp, Button, Checkbox, ChevronRight, File, Folder, FolderGit2, IconButton, Input, Laptop, Server, Skeleton } from "../../ui-kit";
import { asEngineError, errorText } from "./errors";
import { PermissionCard } from "./permission";

export interface BrowserProps {
  kind: PickKind;
  purpose: PickPurpose;
  extensions?: string[];
  allowGoTo: boolean;
  onPicked(items: Picked[]): void;
  onCancel(): void;
}

const dirname = (p: string) => (p.split("/").filter(Boolean).slice(0, -1).reduce((a, s) => `${a}/${s}`, "") || "/");
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const isDir = (e: DirEntry) => e.kind === "dir" || e.kind === "symlinkDir";
const isFile = (e: DirEntry) => e.kind === "file" || e.kind === "symlinkFile";
const PAGE = 10;

/** A short name for the guarded folder, shown in the "macOS may ask for permission" bar. */
const placeName = (p: ProtectedFolder | null, fallback: string) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : fallback);

export function Browser(props: BrowserProps) {
  const multi = () => props.kind === "folders" || props.kind === "files";
  const wantsFiles = () => props.kind === "file" || props.kind === "files";
  const [start, setStart] = createSignal<StartInfo | null>(null);
  const [listing, setListing] = createSignal<DirListing | null>(null);
  const [path, setPath] = createSignal<string | null>(null);
  const [error, setError] = createSignal<EngineError | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [slow, setSlow] = createSignal(false);
  const [prompt, setPrompt] = createSignal<string | null>(null);
  const [gone, setGone] = createSignal(false);
  const [hidden, setHidden] = createSignal(false);
  const [back, setBack] = createSignal<string[]>([]);
  const [fwd, setFwd] = createSignal<string[]>([]);
  const [active, setActive] = createSignal(-1);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [goTo, setGoTo] = createSignal("");
  const [goError, setGoError] = createSignal<EngineError | null>(null);
  const [pickError, setPickError] = createSignal<EngineError | null>(null);
  const [working, setWorking] = createSignal(false);
  let seq = 0;
  let typed = "";
  let typedTimer: ReturnType<typeof setTimeout> | undefined;
  let goInput: HTMLInputElement | undefined;
  let listEl: HTMLUListElement | undefined;
  onCleanup(() => clearTimeout(typedTimer));

  const entries = () => listing()?.entries ?? [];
  const idOf = (i: number) => `pp-opt-${i}`;

  async function load(target: string, opts: { push?: boolean; hint?: string } = {}): Promise<void> {
    const mine = ++seq;
    setLoading(true);
    setSlow(false);
    setError(null);
    setGone(false);
    setPickError(null);
    setPrompt(opts.hint ?? null);
    typed = "";
    const timer = setTimeout(() => mine === seq && setSlow(true), 400);
    try {
      let l: DirListing;
      let climbed = false;
      let at = target;
      for (let i = 0; ; i++) {
        try {
          l = await ipc.picker.list(at, { hidden: hidden(), files: wantsFiles(), extensions: props.extensions });
          break;
        } catch (e) {
          const er = asEngineError(e);
          // The folder is gone: show the nearest ancestor that still exists.
          if ((er.code === "notFound" || er.code === "notADirectory") && at !== "/" && i < 40) {
            at = dirname(at);
            climbed = true;
            continue;
          }
          throw e;
        }
      }
      if (mine !== seq) return;
      const prev = path();
      if (opts.push !== false && prev && prev !== l.path) {
        setBack([...back(), prev]);
        setFwd([]);
      }
      setPath(l.path);
      setListing(l);
      setActive(-1);
      setSelected(new Set<string>());
      setGone(climbed);
    } catch (e) {
      if (mine !== seq) return;
      setListing(null);
      setPath(target);
      setError(asEngineError(e));
    } finally {
      clearTimeout(timer);
      if (mine === seq) {
        setLoading(false);
        setSlow(false);
        setPrompt(null);
      }
    }
  }

  onMount(async () => {
    const info = await ipc.picker.start().catch(() => null);
    setStart(info);
    void load(info?.startPath ?? "/");
  });

  const open = (e: DirEntry) => {
    const l = listing();
    if (l && isDir(e) && e.kind !== "other") void load(join(l.path, e.name), { hint: e.protectedFolder ? placeName(e.protectedFolder, e.label) : undefined });
  };
  const up = () => {
    const l = listing();
    if (l?.parent) void load(l.parent);
    else if (!l && path() && path() !== "/") void load(dirname(path()!));
  };
  const goBack = () => {
    const b = back();
    const here = path();
    if (!b.length || !here) return;
    setBack(b.slice(0, -1));
    setFwd([here, ...fwd()]);
    void load(b[b.length - 1], { push: false });
  };
  const goFwd = () => {
    const f = fwd();
    const here = path();
    if (!f.length || !here) return;
    setFwd(f.slice(1));
    setBack([...back(), here]);
    void load(f[0], { push: false });
  };
  const home = () => void load(start()?.home ?? "/");

  const select = (i: number, extend = false) => {
    const list = entries();
    if (!list.length) return;
    const idx = Math.max(0, Math.min(list.length - 1, i));
    const from = active() < 0 ? idx : active();
    setActive(idx);
    const eligible = (e: DirEntry) => (wantsFiles() ? isFile(e) : isDir(e));
    if (multi()) {
      if (extend) {
        const next = new Set(selected());
        for (let k = Math.min(from, idx); k <= Math.max(from, idx); k++) if (eligible(list[k])) next.add(list[k].name);
        setSelected(next);
      }
    } else {
      setSelected(new Set([list[idx].name]));
    }
    document.getElementById(idOf(idx))?.scrollIntoView?.({ block: "nearest" });
  };

  const toggle = (i: number) => {
    const e = entries()[i];
    if (!e) return;
    const ok = wantsFiles() ? isFile(e) : isDir(e);
    if (!ok) return;
    const next = new Set(selected());
    if (next.has(e.name)) next.delete(e.name);
    else next.add(e.name);
    setSelected(next);
  };

  /** What "Choose" acts on. */
  const chosen = createMemo<string[]>(() => {
    const l = listing();
    if (!l) return [];
    const picks = entries().filter((e) => selected().has(e.name) && (wantsFiles() ? isFile(e) : isDir(e)));
    if (picks.length) return picks.map((e) => join(l.path, e.name));
    return wantsFiles() ? [] : [l.path];
  });
  const selectedEntry = () => entries().find((e) => selected().has(e.name));
  const statusText = () => {
    if (multi() && selected().size > 0) return t("picker.selected", { count: selected().size });
    const e = selectedEntry();
    return e ? t("picker.selectedName", { name: e.label }) : "";
  };

  async function choose(paths = chosen()): Promise<void> {
    if (!paths.length || working()) return;
    setWorking(true);
    setPickError(null);
    try {
      const items = await Promise.all(paths.map((p) => ipc.picker.pick(p, props.purpose)));
      props.onPicked(items);
    } catch (e) {
      setPickError(asEngineError(e));
    } finally {
      setWorking(false);
    }
  }

  async function submitGoTo(): Promise<void> {
    const value = goTo().trim();
    if (!value) return;
    setGoError(null);
    try {
      props.onPicked([await ipc.picker.pick(value, props.purpose)]);
    } catch (e) {
      const er = asEngineError(e);
      if (er.code === "permissionDenied") setPickError(er);
      else setGoError(er);
    }
  }

  const activate = (e: DirEntry) => {
    if (isDir(e)) open(e);
    else if (isFile(e) && wantsFiles() && listing()) void choose([join(listing()!.path, e.name)]);
  };

  function onListKey(ev: KeyboardEvent): void {
    const meta = ev.metaKey || ev.ctrlKey;
    const list = entries();
    const cur = active();
    const key = ev.key;
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    if (meta && key === "Enter") return handled(), void choose();
    if (meta && key === "ArrowUp") return handled(), up();
    if (meta || ev.altKey) return;
    switch (key) {
      case "ArrowDown":
        return handled(), select(cur < 0 ? 0 : cur + 1, ev.shiftKey);
      case "ArrowUp":
        return handled(), select(cur < 0 ? list.length - 1 : cur - 1, ev.shiftKey);
      case "Home":
        return handled(), select(0, ev.shiftKey);
      case "End":
        return handled(), select(list.length - 1, ev.shiftKey);
      case "PageDown":
        return handled(), select(cur + PAGE, ev.shiftKey);
      case "PageUp":
        return handled(), select(Math.max(0, cur - PAGE), ev.shiftKey);
      case "ArrowRight":
      case "Enter":
        if (cur >= 0 && list[cur]) return handled(), activate(list[cur]);
        return;
      case "ArrowLeft":
      case "Backspace":
        return handled(), up();
      case " ":
        if (multi()) return handled(), toggle(cur);
        return;
      default:
        if (key.length === 1 && !ev.ctrlKey) {
          typed += key.toLowerCase();
          clearTimeout(typedTimer);
          typedTimer = setTimeout(() => (typed = ""), 700);
          const hit = list.findIndex((e) => e.label.toLowerCase().startsWith(typed));
          if (hit >= 0) select(hit);
          handled();
        }
    }
  }

  function onRootKey(ev: KeyboardEvent): void {
    const meta = ev.metaKey || ev.ctrlKey;
    if (!meta || !ev.shiftKey) return;
    const k = ev.key.toLowerCase();
    if (k === "g" && props.allowGoTo) {
      ev.preventDefault();
      goInput?.focus();
    } else if (k === "h") {
      ev.preventDefault();
      home();
    } else if (k === "." || k === ">") {
      ev.preventDefault();
      toggleHidden();
    }
  }

  const toggleHidden = () => {
    setHidden(!hidden());
    if (path()) void load(path()!, { push: false });
  };

  const crumbs = createMemo(() => {
    const parts = (path() ?? "").split("/").filter(Boolean);
    return [{ label: "/", path: "/" }, ...parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join("/")}` }))];
  });

  const placeButtons = createMemo(() => {
    const s = start();
    if (!s) return [];
    return s.places.map((p) => ({ ...p, hint: p.id === "home" ? undefined : p.label }));
  });

  const primaryLabel = () => {
    if (multi() && selected().size > 0) return `${t("picker.choose")} (${selected().size})`;
    return wantsFiles() ? t("picker.choose") : t("picker.chooseThis");
  };

  return (
    <div class="pp-browser" onKeyDown={onRootKey}>
      <div class="pp-toolbar">
        <IconButton icon={ArrowLeft} label={t("picker.back")} size="sm" disabled={back().length === 0} onClick={goBack} />
        <IconButton icon={ArrowRight} label={t("picker.forward")} size="sm" disabled={fwd().length === 0} onClick={goFwd} />
        <IconButton icon={ArrowUp} label={t("picker.up")} shortcut={["⌘", "↑"]} size="sm" disabled={!listing()?.parent && !(error() && path() !== "/")} onClick={up} />
        <nav class="pp-crumbs" aria-label={t("picker.breadcrumbs")}>
          <ol>
            <For each={crumbs()}>
              {(c, i) => (
                <li>
                  <Show when={i() > 0}>
                    <ChevronRight size={12} aria-hidden="true" />
                  </Show>
                  <Show when={i() < crumbs().length - 1} fallback={<span aria-current="page" class="pp-crumb pp-crumb--here">{c.label}</span>}>
                    <button type="button" class="pp-crumb" onClick={() => void load(c.path)}>
                      {c.label}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </nav>
      </div>

      <Show when={props.allowGoTo}>
        <form
          class="pp-goto"
          onSubmit={(e) => {
            e.preventDefault();
            void submitGoTo();
          }}
        >
          <Input
            ref={goInput}
            size="sm"
            value={goTo()}
            onInput={(e) => {
              setGoTo(e.currentTarget.value);
              setGoError(null);
            }}
            placeholder={t("picker.goToPlaceholder")}
            aria-label={t("picker.goTo")}
            aria-describedby="pp-goto-hint"
            invalid={!!goError()}
            spellcheck={false}
            autocomplete="off"
          />
          <Button type="submit" size="sm" disabled={!goTo().trim()}>
            {t("picker.goTo")}
          </Button>
          <p id="pp-goto-hint" class="pp-hint">
            {goError() ? <span role="alert">{errorText(goError()!)}</span> : t("picker.goToHint")}
          </p>
        </form>
      </Show>

      <div class="pp-body">
        <aside class="pp-places" aria-label={t("picker.places")}>
          <For each={placeButtons()}>
            {(p) => (
              <button
                type="button"
                class="pp-place"
                aria-current={path() === p.path ? "true" : undefined}
                onClick={() => void load(p.path, { hint: p.id === "home" ? undefined : p.label })}
              >
                <Show when={p.id === "home"} fallback={<Folder size={14} />}>
                  <Laptop size={14} />
                </Show>
                <span>{p.id === "home" ? t("picker.home") : p.label}</span>
              </button>
            )}
          </For>
          <Show when={(start()?.volumes.length ?? 0) > 0}>
            <h3 class="pp-places__title">{t("picker.volumes")}</h3>
            <For each={start()?.volumes}>
              {(v) => (
                <button type="button" class="pp-place" aria-current={path()?.startsWith(v.path) ? "true" : undefined} onClick={() => void load(v.path, { hint: v.name })}>
                  <Server size={14} />
                  <span>{v.name}</span>
                </button>
              )}
            </For>
          </Show>
        </aside>

        <section class="pp-list" aria-busy={loading()}>
          <Show when={prompt()}>
            <p class="pp-info" role="status">
              {t("picker.macPrompt", { folder: prompt()! })}
            </p>
          </Show>
          <Show when={slow()}>
            <p class="pp-info" role="status">
              {t("picker.slow")}
            </p>
          </Show>
          <Show when={gone() && !loading()}>
            <p class="pp-info pp-info--warn" role="status">
              {t("picker.err.gone")}
            </p>
          </Show>
          <Show when={error()?.code === "permissionDenied" || pickError()?.code === "permissionDenied"}>
            <PermissionCard
              folder={pickError()?.code === "permissionDenied" && goTo().trim() ? basenameOf(goTo().trim()) : placeName(listing()?.protectedFolder ?? null, basenameOf(path()))}
              onOpenSettings={() => void ipc.picker.openPrivacySettings()}
              onRetry={() => (pickError() ? void choose() : void load(path() ?? "/", { push: false }))}
              onOther={() => {
                setPickError(null);
                void load(start()?.home ?? "/");
              }}
            />
          </Show>
          <Show when={error() && error()!.code !== "permissionDenied"}>
            <div class="pp-error" role="alert">
              {errorText(error()!)}
            </div>
          </Show>
          <Show when={pickError() && pickError()!.code !== "permissionDenied"}>
            <div class="pp-error" role="alert">
              {errorText(pickError()!)}
            </div>
          </Show>
          <Show when={loading() && !listing()}>
            <div class="pp-skeleton" aria-hidden="true">
              <Skeleton height={20} />
              <Skeleton height={20} />
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          </Show>
          <Show when={listing() && !error() && pickError()?.code !== "permissionDenied"}>
            <Show
              when={entries().length > 0}
              fallback={
                <p class="pp-empty">{wantsFiles() ? t("picker.empty") : t("picker.noDirs")}</p>
              }
            >
              <ul
                ref={listEl}
                class="pp-rows"
                role="listbox"
                tabIndex={0}
                aria-label={path() ?? t("picker.breadcrumbs")}
                aria-multiselectable={multi() ? "true" : undefined}
                aria-activedescendant={active() >= 0 ? idOf(active()) : undefined}
                onKeyDown={onListKey}
              >
                <For each={entries()}>
                  {(e, i) => (
                    <li
                      id={idOf(i())}
                      class="pp-row"
                      role="option"
                      aria-selected={selected().has(e.name)}
                      data-active={active() === i() ? "" : undefined}
                      data-hidden={e.hidden ? "" : undefined}
                      data-package={e.package ? "" : undefined}
                      data-dim={isFile(e) && !wantsFiles() ? "" : undefined}
                      onClick={(ev) => {
                        listEl?.focus();
                        if (multi() && (ev.metaKey || ev.ctrlKey)) {
                          setActive(i());
                          toggle(i());
                        } else select(i(), ev.shiftKey);
                      }}
                      onDblClick={() => activate(e)}
                    >
                      <span class="pp-row__icon" aria-hidden="true">
                        {isDir(e) ? e.isRepo ? <FolderGit2 size={15} /> : <Folder size={15} /> : <File size={15} />}
                      </span>
                      <span class="pp-row__name" dir="auto">
                        {e.label}
                      </span>
                      <Show when={e.kind === "symlinkDir" || e.kind === "symlinkFile"}>
                        <span class="pp-chip">{t("picker.symlink")}</span>
                      </Show>
                      <Show when={e.isRepo}>
                        <span class="pp-chip pp-chip--git">{t("picker.gitBadge")}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </section>
      </div>

      <div class="pp-status">
        <Checkbox checked={hidden()} onChange={toggleHidden} label={t("picker.hidden")} size="sm" />
        <Show when={listing()?.truncated}>
          <span class="pp-note">{t("picker.truncated", { count: entries().length })}</span>
        </Show>
        <span class="pp-note pp-status__sel" aria-live="polite">
          {statusText()}
        </span>
      </div>

      <div class="pp-actions">
        <Button variant="ghost" onClick={props.onCancel}>
          {t("picker.cancel")}
        </Button>
        <Button variant="primary" disabled={chosen().length === 0} loading={working()} onClick={() => void choose()}>
          {primaryLabel()}
        </Button>
      </div>
    </div>
  );
}

function basenameOf(p: string | null): string {
  return (p ?? "").split("/").filter(Boolean).at(-1) ?? "/";
}
