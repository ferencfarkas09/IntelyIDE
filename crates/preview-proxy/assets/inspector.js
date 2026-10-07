/* IntelySwitchIDE click-to-source inspector. Injected into the dev-server's HTML by crates/preview-proxy, dev only.
 * Alt/Cmd+click (or the IDE's Inspect toggle) maps the clicked element to its React source and posts ONE message to
 * the parent window: { intely: "inspect/1", file, line, col, componentName }. Nothing else leaves the page: no DOM,
 * props, state, storage, cookies or network data. The IDE treats the message as an untrusted hint and validates it.
 * Ladder: fiber._debugSource (React <= 18 with a jsx-source plugin) -> fiber._debugStack (React 19, source-mapped when
 * the bundle has a map) -> data-loc attribute -> component name only (file ""). */
(function (root) {
  "use strict";

  var CHANNEL = "inspect/1";
  var MODE_MSG = "inspect.mode/1";

  /* ---------- pure helpers (unit-tested from node through module.exports) ---------- */

  /** Turns the many file spellings bundlers produce into a path (absolute or repo-relative) or "". */
  function normalizeFile(raw) {
    if (typeof raw !== "string" || !raw) return "";
    var f = raw.trim();
    var q = f.search(/[?#]/);
    if (q >= 0) f = f.slice(0, q);
    f = f.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, "");
    f = f.replace(/^webpack:\/\/[^/]*\//, "");
    f = f.replace(/^rsc:\/\/React\/[^/]*\//, "");
    if (/^file:\/\//.test(f)) {
      try { f = decodeURIComponent(f.replace(/^file:\/\//, "")); } catch (e) { return ""; }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(f)) {
      // http(s) bundle URLs are not source files; a vite-style /@fs/<abs> is.
      var m = /^[a-z]+:\/\/[^/]+(\/@fs\/.*)$/i.exec(f);
      if (!m) return "";
      f = m[1];
    }
    f = f.replace(/^\/@fs\//, "/");
    f = f.replace(/^\(([^)]*)\)\//, "");
    f = f.replace(/^(\.\.?\/)+/, ""); // esbuild/vite maps are relative to the output folder: "../src/x.js" -> "src/x.js"
    f = f.replace(/\/\.\//g, "/");
    return f === "/" ? "" : f;
  }

  function isThirdParty(file) {
    return /(^|\/)node_modules\//.test(file) || /(^|\/)\.pnpm\//.test(file);
  }

  /** "src/a.js:12:5" -> {file,line,col}; the file may contain colons (windows drive) so match from the right. */
  function parseDataLoc(value) {
    if (typeof value !== "string") return null;
    var m = /^(.*?):(\d+)(?::(\d+))?$/.exec(value.trim());
    if (!m) return null;
    var file = normalizeFile(m[1]);
    var line = parseInt(m[2], 10);
    if (!file || !(line > 0)) return null;
    return { file: file, line: line, col: m[3] ? parseInt(m[3], 10) : 1 };
  }

  /** Frames of a V8 or JavaScriptCore/Firefox stack: [{fn, url, line, col}] in stack order. */
  function parseStack(stack) {
    var out = [];
    if (typeof stack !== "string") return out;
    var lines = stack.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      var m = /^at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/.exec(l); // V8
      if (m) { out.push({ fn: m[1] || "", url: m[2], line: +m[3], col: +m[4] }); continue; }
      m = /^(.*?)@(.*?):(\d+):(\d+)$/.exec(l); // JSC, Firefox
      if (m) out.push({ fn: m[1] || "", url: m[2], line: +m[3], col: +m[4] });
    }
    return out;
  }

  var REACT_INTERNAL = /(react-jsx-dev-runtime|react-jsx-runtime|jsx-dev-runtime|\/react\/cjs\/|\/react-dom\/|react\.development|react-dom\.development|react-dom-client|react-stack-top-frame|\/node_modules\/react\/)/;

  /** The first frame of a React 19 `_debugStack` that is not React's own jsxDEV machinery. */
  function callerFrame(stack) {
    var frames = parseStack(stack);
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (/^(exports\.)?(jsxDEV|jsx|jsxs|react-stack-top-frame|Object\.react_stack_bottom_frame)/.test(f.fn)) continue;
      if (REACT_INTERNAL.test(f.url) || REACT_INTERNAL.test(f.fn)) continue;
      return f;
    }
    return null;
  }

  function componentNameOf(fiber) {
    var t = fiber && fiber.type;
    if (!t) return "";
    if (typeof t === "function") return t.displayName || t.name || "";
    if (typeof t === "object") {
      if (t.displayName) return t.displayName;
      if (typeof t.render === "function") return t.render.displayName || t.render.name || "";
      if (t.type) return componentNameOf({ type: t.type });
    }
    return "";
  }

  function isComponentFiber(fiber) {
    var t = fiber && fiber.type;
    return !!t && typeof t !== "string";
  }

  /** Nearest named component: the host fiber's owner chain first (who rendered it), then its parents. */
  function nearestComponentName(fiber) {
    var seen = 0;
    var f = fiber;
    while (f && seen++ < 200) {
      if (isComponentFiber(f)) { var n = componentNameOf(f); if (n) return n; }
      f = f._debugOwner || null;
    }
    f = fiber;
    seen = 0;
    while (f && seen++ < 400) {
      if (isComponentFiber(f)) { var n2 = componentNameOf(f); if (n2) return n2; }
      f = f.return || null;
    }
    return "";
  }

  function fiberKeyOf(node) {
    for (var k in node) {
      if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) return k;
    }
    return null;
  }

  /* ---------- tiny source map reader (React 19 stacks point into the bundle) ---------- */

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function decodeMappings(mappings) {
    var lines = [];
    var cur = [];
    var gen = 0, src = 0, sl = 0, sc = 0;
    var vals = [], shift = 0, acc = 0;
    function flushSeg() {
      if (vals.length >= 4) {
        gen += vals[0]; src += vals[1]; sl += vals[2]; sc += vals[3];
        cur.push([gen, src, sl, sc]);
      } else if (vals.length >= 1) gen += vals[0];
      vals = [];
    }
    for (var i = 0; i < mappings.length; i++) {
      var c = mappings.charAt(i);
      if (c === ";") { flushSeg(); lines.push(cur); cur = []; gen = 0; continue; }
      if (c === ",") { flushSeg(); continue; }
      var d = B64.indexOf(c);
      if (d < 0) continue;
      acc += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        vals.push(acc & 1 ? -(acc >> 1) : acc >> 1);
        acc = 0; shift = 0;
      }
    }
    flushSeg();
    lines.push(cur);
    return lines;
  }

  /** 1-based generated position -> {source, line, col} (1-based) or null. */
  function originalPosition(map, line, col) {
    if (!map || typeof map.mappings !== "string" || !Array.isArray(map.sources)) return null;
    var lines = map.__decoded || (map.__decoded = decodeMappings(map.mappings));
    var segs = lines[line - 1];
    if (!segs) return null;
    var best = null;
    for (var i = 0; i < segs.length; i++) {
      if (segs[i][0] <= col - 1) best = segs[i]; else break;
    }
    if (!best) return null;
    var source = map.sources[best[1]];
    if (typeof source !== "string") return null;
    if (map.sourceRoot && !/^[a-z]+:\/\//i.test(source) && source.charAt(0) !== "/") source = map.sourceRoot.replace(/\/?$/, "/") + source;
    return { source: source, line: best[2] + 1, col: best[3] + 1 };
  }

  /* ---------- fiber -> source ---------- */

  var mapCache = {};
  function loadMap(bundleUrl) {
    if (mapCache[bundleUrl]) return mapCache[bundleUrl];
    var p = fetch(bundleUrl, { credentials: "omit" })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var m = /\/\/[#@] sourceMappingURL=([^\s]+)\s*$/m.exec(text);
        if (!m) return null;
        var ref = m[1];
        if (ref.indexOf("data:") === 0) {
          var b64 = ref.slice(ref.indexOf("base64,") + 7);
          return JSON.parse(atob(b64));
        }
        return fetch(new URL(ref, bundleUrl).href, { credentials: "omit" }).then(function (r) { return r.json(); });
      })
      .catch(function () { return null; });
    mapCache[bundleUrl] = p;
    return p;
  }

  /** One candidate source for a fiber, or null. Async because of source maps. */
  function sourceOf(fiber) {
    var ds = fiber && fiber._debugSource;
    if (ds && typeof ds.fileName === "string") {
      var file = normalizeFile(ds.fileName);
      if (file && ds.lineNumber > 0) return Promise.resolve({ file: file, line: ds.lineNumber | 0, col: (ds.columnNumber | 0) || 1 });
    }
    var stack = fiber && fiber._debugStack;
    var text = stack && typeof stack === "object" ? stack.stack : stack;
    var frame = typeof text === "string" ? callerFrame(text) : null;
    if (!frame) return Promise.resolve(null);
    var direct = normalizeFile(frame.url);
    if (direct && !/^[a-z]+:\/\//i.test(frame.url)) return Promise.resolve({ file: direct, line: frame.line, col: frame.col });
    if (!/^https?:\/\//i.test(frame.url)) return Promise.resolve(null);
    return loadMap(frame.url.replace(/[?#].*$/, "")).then(function (map) {
      var pos = originalPosition(map, frame.line, frame.col);
      var f = pos && normalizeFile(pos.source);
      return f ? { file: f, line: pos.line, col: pos.col } : null;
    });
  }

  /** Resolve a fiber: its own source, then the sources of its owner chain (call sites); first user-code hit wins. */
  function resolveFiber(fiber) {
    var chain = [];
    var f = fiber, n = 0;
    while (f && n++ < 30) { chain.push(f); f = f._debugOwner || null; }
    var name = nearestComponentName(fiber);
    var firstAny = null;
    var i = 0;
    function next() {
      if (i >= chain.length) return Promise.resolve(firstAny ? withName(firstAny) : null);
      return sourceOf(chain[i++]).then(function (s) {
        if (s) {
          if (!isThirdParty(s.file)) return withName(s);
          if (!firstAny) firstAny = s;
        }
        return next();
      });
    }
    function withName(s) { return { file: s.file, line: s.line, col: s.col, componentName: name }; }
    return next().then(function (r) { return r || (name ? { file: "", line: 0, col: 0, componentName: name } : null); });
  }

  /** Walks up the DOM until something resolves. data-loc beats a bare component name but not a real source. */
  function resolveElement(el) {
    var node = el;
    var nameOnly = null;
    function step() {
      if (!node || node.nodeType !== 1) return Promise.resolve(nameOnly);
      var current = node;
      node = node.parentElement;
      var key = fiberKeyOf(current);
      var p = key ? resolveFiber(current[key]) : Promise.resolve(null);
      return p.then(function (r) {
        if (r && r.file) return r;
        var loc = parseDataLoc(current.getAttribute && current.getAttribute("data-loc"));
        if (loc) return { file: loc.file, line: loc.line, col: loc.col, componentName: (r && r.componentName) || "" };
        if (r && !nameOnly) nameOnly = r;
        return step();
      });
    }
    return step();
  }

  var api = {
    CHANNEL: CHANNEL, MODE_MSG: MODE_MSG, normalizeFile: normalizeFile, isThirdParty: isThirdParty, parseDataLoc: parseDataLoc,
    parseStack: parseStack, callerFrame: callerFrame, componentNameOf: componentNameOf, nearestComponentName: nearestComponentName,
    decodeMappings: decodeMappings, originalPosition: originalPosition, resolveFiber: resolveFiber, resolveElement: resolveElement,
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  if (!root || !root.document || root.__INTELY_INSPECT__) return;

  /* ---------- browser side ---------- */

  var doc = root.document;
  var inspecting = false;
  var overlay = null, label = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = doc.createElement("div");
    overlay.setAttribute("data-intely-overlay", "");
    overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #5b8def;background:rgba(91,141,239,.14);border-radius:2px;display:none;left:0;top:0;width:0;height:0";
    label = doc.createElement("div");
    label.style.cssText = "position:absolute;left:-2px;top:-22px;max-width:60vw;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px/18px ui-monospace,Menlo,monospace;color:#fff;background:#3b6fd4;padding:0 6px;border-radius:3px";
    overlay.appendChild(label);
    (doc.body || doc.documentElement).appendChild(overlay);
  }

  function hide() { if (overlay) overlay.style.display = "none"; }

  function highlight(el) {
    ensureOverlay();
    var r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = r.left + "px"; overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px"; overlay.style.height = r.height + "px";
    var key = fiberKeyOf(el);
    label.textContent = (key && nearestComponentName(el[key])) || el.tagName.toLowerCase();
    label.style.top = r.top < 24 ? (r.height + 4) + "px" : "-22px";
  }

  function active(e) { return inspecting || e.altKey || e.metaKey; }

  function send(r) {
    if (!r || root.parent === root) return;
    root.parent.postMessage({ intely: CHANNEL, file: r.file, line: r.line, col: r.col, componentName: r.componentName }, "*");
  }

  doc.addEventListener("mousemove", function (e) {
    if (!active(e)) return hide();
    var t = e.target;
    if (t && t.nodeType === 1 && !t.hasAttribute("data-intely-overlay")) highlight(t); else hide();
  }, true);

  doc.addEventListener("click", function (e) {
    if (!active(e)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    var t = e.target;
    hide();
    if (t && t.nodeType === 1) resolveElement(t).then(send, function () {});
  }, true);

  // Block the page's own handlers for the press that starts the gesture too (links, buttons that act on mousedown).
  ["mousedown", "mouseup", "pointerdown", "pointerup"].forEach(function (type) {
    doc.addEventListener(type, function (e) { if (active(e)) { e.stopPropagation(); } }, true);
  });

  root.addEventListener("keyup", function (e) { if (!inspecting && (e.key === "Alt" || e.key === "Meta")) hide(); }, true);

  root.addEventListener("message", function (e) {
    if (e.source !== root.parent) return;
    var d = e.data;
    if (!d || d.intely !== MODE_MSG || typeof d.on !== "boolean") return;
    inspecting = d.on;
    doc.documentElement.style.cursor = inspecting ? "crosshair" : "";
    if (!inspecting) hide();
  });

  root.__INTELY_INSPECT__ = { resolve: resolveElement, version: 1 };
})(typeof window !== "undefined" ? window : this);
