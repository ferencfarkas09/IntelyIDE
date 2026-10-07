#!/usr/bin/env python3
"""Samples resident memory while an e2e scenario runs: the agent sidecar (a child of the app) and the process tree under it
(the Claude CLI and what it spawned), once a second until the app exits. Usage: rss-probe.py <app pid> <out.json>"""
import json
import subprocess
import sys
import time

app, out = int(sys.argv[1]), sys.argv[2]
seen = set()
sidecar_pids = set()
best = {"sidecarMb": 0.0, "agentTreeMb": 0.0, "agentProcs": 0, "samples": 0, "sidecarMbBeforeAgent": None}


def snapshot():
    rows = {}
    for line in subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,command="], capture_output=True, text=True).stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            rows[int(parts[0])] = (int(parts[1]), int(parts[2]), parts[3])
    return rows


while True:
    try:
        import os
        os.kill(app, 0)
    except OSError:
        break
    rows = snapshot()
    sidecars = [pid for pid, (ppid, _, cmd) in rows.items() if ppid == app and "sidecar/dist/index.js" in cmd]
    if sidecars:
        sc = sidecars[0]
        sidecar_pids.update(sidecars)
        mb = rows[sc][1] / 1024
        tree = []
        frontier = [sc]
        while frontier:
            kids = [pid for pid, (ppid, _, _) in rows.items() if ppid in frontier and pid not in tree and pid != sc]
            tree += kids
            frontier = kids
        seen.update(tree)
        seen.add(sc)
        tree_mb = sum(rows[p][1] for p in tree) / 1024
        best["samples"] += 1
        best["sidecarMb"] = max(best["sidecarMb"], round(mb, 1))
        if not tree and best["sidecarMbBeforeAgent"] is None:
            best["sidecarMbBeforeAgent"] = round(mb, 1)
        if tree_mb > best["agentTreeMb"]:
            best["agentTreeMb"] = round(tree_mb, 1)
            best["agentProcs"] = len(tree)
    time.sleep(1)
best["pidsSeen"] = sorted(seen)
best["sidecarPids"] = sorted(sidecar_pids)
with open(out, "w") as f:
    json.dump(best, f)
