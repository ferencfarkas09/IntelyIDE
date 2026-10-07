#!/usr/bin/env bash
# Resource measurement for the whole app process tree (app + WKWebView helper processes).
# Usage: scripts/measure.sh --bin <path> --label <name> --warmup 30 --samples 6 --interval 10 [--env KEY=VAL]...
# Prints ONE JSON object on stdout. Always kills the app on exit.
# The app runs with INTELY_PERF=1: it logs startup marks to $TMPDIR/intely-perf.log and prints an INTELY_READY line on
# stderr when the UI is up (real app: every repo shown; spike modes: first paint). The warmup starts at that line
# (waiting at most --ready-timeout seconds), so it no longer counts time the app was still starting.
#
# Helper discovery: WebKit XPC helpers (com.apple.WebKit.{WebContent,GPU,Networking}) are not children of
# the app (ppid 1). macOS tracks them through the "responsible pid"
# (libSystem responsibility_get_pid_responsible_for_pid, what Activity Monitor uses). A helper belongs to the
# app when its responsible pid equals the app's responsible pid and it started no earlier than the app.
# Memory: `footprint -j` over the whole set (de-duplicated "total footprint", the physical footprint metric),
# with the summed `ps` RSS reported next to it. CPU: delta of cumulative `ps` cputime over wall time.
set -u

BIN="" LABEL="run" WARMUP=30 SAMPLES=6 INTERVAL=10 READY_TIMEOUT=60 ENVS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --warmup) WARMUP="$2"; shift 2 ;;
    --samples) SAMPLES="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="$2"; shift 2 ;;
    --env) ENVS+=("$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -x "$BIN" ] || { echo "binary not executable: $BIN" >&2; exit 2; }

WORK="$(mktemp -d)"
STDERR_FILE="$WORK/stderr.txt"
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  sleep 1
  [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null
  # Any helper that outlived the app is killed too.
  python3 "$WORK/proc.py" helpers "$APP_PID" 2>/dev/null | xargs -r kill 2>/dev/null
  cp "$STDERR_FILE" "${TMPDIR:-/tmp}/intely-measure-$LABEL.stderr" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/proc.py" <<'PY'
import ctypes, json, subprocess, sys, time

libc = ctypes.CDLL(None)
_resp = libc.responsibility_get_pid_responsible_for_pid
_resp.argtypes = [ctypes.c_int]
_resp.restype = ctypes.c_int
HELPERS = ("com.apple.WebKit.WebContent", "com.apple.WebKit.GPU", "com.apple.WebKit.Networking")

def ps_table():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,time=,lstart=,comm="], capture_output=True, text=True).stdout
    rows = {}
    for line in out.splitlines():
        f = line.split(None, 9)
        if len(f) < 10:
            continue
        pid, ppid, rss, cpu = int(f[0]), int(f[1]), int(f[2]), f[3]
        start = time.mktime(time.strptime(" ".join(f[4:9]), "%a %b %d %H:%M:%S %Y"))
        rows[pid] = dict(pid=pid, ppid=ppid, rss_kb=rss, cpu_s=cpu_seconds(cpu), start=start, comm=f[9])
    return rows

def cpu_seconds(t):  # [[dd-]hh:]mm:ss.cc
    days = 0
    if "-" in t:
        d, t = t.split("-"); days = int(d)
    parts = [float(x) for x in t.split(":")]
    s = 0.0
    for p in parts:
        s = s * 60 + p
    return s + days * 86400

def members(app_pid, rows):
    if app_pid not in rows:
        return []
    app = rows[app_pid]
    app_resp = _resp(app_pid)
    out = [app_pid]
    for pid, r in rows.items():
        if pid != app_pid and r["comm"].endswith(HELPERS) and r["start"] >= app["start"] - 1 and _resp(pid) == app_resp:
            out.append(pid)
    return out

def footprint(pids):
    path = "/tmp/intely-fp-%d.json" % pids[0]
    subprocess.run(["footprint", "-j", path] + [str(p) for p in pids], capture_output=True)
    d = json.load(open(path))
    per = {p["pid"]: p["footprint"] / 1048576 for p in d["processes"]}
    return d["total footprint"] / 1048576, per

if __name__ == "__main__":
    cmd, app_pid = sys.argv[1], int(sys.argv[2] or 0)
    rows = ps_table()
    if cmd == "helpers":
        print("\n".join(str(p) for p in members(app_pid, rows)[1:]))
    elif cmd == "sample":
        pids = members(app_pid, rows)
        total, per = footprint(pids)
        print(json.dumps(dict(
            t=time.time(), pids=pids,
            names={p: rows[p]["comm"].rsplit("/", 1)[-1] for p in pids if p in rows},
            footprint_mb=round(total, 1), per_pid_mb={str(k): round(v, 1) for k, v in per.items()},
            rss_mb=round(sum(rows[p]["rss_kb"] for p in pids) / 1024, 1),
            cpu_s=round(sum(rows[p]["cpu_s"] for p in pids), 2))))
PY

PERF_LOG="${TMPDIR:-/tmp}/intely-perf.log"
rm -f "$PERF_LOG"
T0=$(python3 -c 'import time;print(time.time())')
env INTELY_PERF=1 ${ENVS[@]+"${ENVS[@]}"} "$BIN" >"$STDERR_FILE" 2>&1 &
APP_PID=$!
# Keep the display awake so a sleeping display cannot pause requestAnimationFrame; exits with the app.
caffeinate -di -w "$APP_PID" >/dev/null 2>&1 &

for ((i = 0; i < READY_TIMEOUT * 10; i++)); do
  grep -q '^INTELY_READY' "$STDERR_FILE" 2>/dev/null && break
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.1
done
grep -q '^INTELY_READY' "$STDERR_FILE" 2>/dev/null || echo "warning: no INTELY_READY line within ${READY_TIMEOUT}s" >&2
sleep "$WARMUP"
kill -0 "$APP_PID" 2>/dev/null || { echo "{\"label\":\"$LABEL\",\"error\":\"app exited during warmup\"}"; exit 1; }

: > "$WORK/samples.jsonl"
for ((i = 0; i < SAMPLES; i++)); do
  python3 "$WORK/proc.py" sample "$APP_PID" >> "$WORK/samples.jsonl"
  [ $i -lt $((SAMPLES - 1)) ] && sleep "$INTERVAL"
done

python3 - "$WORK/samples.jsonl" "$LABEL" "$T0" "$BIN" "$STDERR_FILE" "$PERF_LOG" <<'PY'
import json, os, re, sys
samples_f, label, t0, binp, stderr_f, log_f = sys.argv[1:7]
t0 = float(t0)
S = [json.loads(l) for l in open(samples_f) if l.strip()]
fp = [s["footprint_mb"] for s in S]
first, last = S[0], S[-1]
cpu = (last["cpu_s"] - first["cpu_s"]) / max(last["t"] - first["t"], 1e-9) * 100 if len(S) > 1 else None
res = dict(
    label=label,
    process_count=len(last["pids"]), processes=last["names"],
    footprint_mb=dict(mean=round(sum(fp) / len(fp), 1), min=min(fp), max=max(fp)),
    app_pid_only_mb=last["per_pid_mb"][str(last["pids"][0])],
    ps_rss_sum_mb=round(sum(s["rss_mb"] for s in S) / len(S), 1),
    cpu_pct_avg=None if cpu is None else round(cpu, 2),
    binary_size_mb=round(os.path.getsize(binp) / 1048576, 2),
    series=[dict(t_s=round(s["t"] - t0), mb=s["footprint_mb"], rss_mb=s["rss_mb"], n=len(s["pids"])) for s in S],
)
if os.path.exists(log_f):
    # Lines: "<wall ms> t=<ms since run() started>ms <mark> <detail>". Startup times are wall time since launch.
    gaps, fps, since, stalls = [], [], [], 0
    for line in open(log_f):
        m = re.match(r"(\d+) t=(\d+)ms (\S+) ?(.*)", line)
        if not m:
            continue
        wall, t_ms, name, rest = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4)
        launch_ms = round(wall - t0 * 1000)
        if name in ("process_start", "setup_start", "engine_created", "window_building", "window_built", "setup_done", "page_Started", "page_Finished",
                    "first_paint", "first_snapshot", "ready"):
            res.setdefault("marks_ms_since_launch", {}).setdefault(name, launch_ms)
        if name == "first_paint":
            res.setdefault("startup_to_first_paint_ms", launch_ms)
            pm = re.search(r"fcp=([\d.]+)", rest)
            if pm: res["first_paint_page_relative_ms"] = float(pm.group(1))
        if name == "first_snapshot":
            res.setdefault("startup_to_first_snapshot_ms", launch_ms)
        if name == "ready":
            res.setdefault("startup_to_ready_ms", launch_ms)
            res.setdefault("ready_detail", rest.strip())
        hb = re.match(r"frames=(\d+) intervalMs=(\d+) maxGapMs=(\d+) sinceFrameMs=(\d+)", rest) if name == "heartbeat" else None
        if hb:
            frames, interval, gap, stale = map(int, hb.groups())
            fps.append(frames * 1000 / max(interval, 1)); gaps.append(gap); since.append(stale)
            if stale > 1000: stalls += 1
    # maxGapMs is the whole-run maximum; sinceFrameMs catches a frame loop that is stalled right now.
    res["raf"] = dict(heartbeats=len(gaps), max_gap_ms=max(gaps + since) if gaps else None, stalled_heartbeats_over_1s=stalls,
                      min_frames_per_s=round(min(fps[1:]), 1) if len(fps) > 1 else None,
                      mean_frames_per_s=round(sum(fps) / len(fps), 1) if fps else None)
err = open(stderr_f, errors="replace").read().splitlines()
res["stderr_lines"] = len(err)
res["stderr_warnings"] = [l[:200] for l in err if re.search(r"webkit|wkwebview|warn|error|stale", l, re.I)][:10]
print(json.dumps(res))
PY
