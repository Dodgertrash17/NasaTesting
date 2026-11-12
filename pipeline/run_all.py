"""Run pipeline steps 2-6 for many targets, a few at a time, then step 7 once for all of them.

Each target runs in its own process: download (S3) -> clean -> align+stack -> compare -> identify.
Raw cutouts are deleted after cleaning (the clean frames hold everything later steps need), which keeps
the cache at ~140 MB per target. Targets that already have out/identify/<id>.json are skipped, so the
run can be stopped and restarted.

Usage:  python run_all.py [--parallel 3] [--skip barnard,wise0855] [--site path/to/public/data]
Logs:   out/run_all/<id>.log  and  out/run_all/summary.json
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))
STEPS = [("download", "step2_download.py", []), ("clean", "step3_clean.py", []),
         ("stack", "step4_align_stack.py", []), ("compare", "step5_compare.py", []),
         ("identify", "step6_identify.py", ["--workers", "3"])]


def run_target(tid):
    log_dir = os.path.join(OUT, "run_all")
    os.makedirs(log_dir, exist_ok=True)
    rec = dict(id=tid, steps={}, ok=False)
    t0 = time.time()
    with open(os.path.join(log_dir, tid + ".log"), "w") as log:
        for name, script, extra in STEPS:
            s0 = time.time()
            p = subprocess.run([sys.executable, os.path.join(HERE, script), "--only", tid, *extra],
                               stdout=log, stderr=subprocess.STDOUT, cwd=os.path.expanduser("~"))
            rec["steps"][name] = dict(rc=p.returncode, seconds=round(time.time() - s0))
            log.flush()
            if p.returncode != 0:
                rec["failed_at"] = name
                break
            if name == "clean":       # raw cutouts are no longer needed
                d = os.path.join(CACHE, tid)
                for f in os.listdir(d):
                    if f.endswith(".fits"):
                        os.remove(os.path.join(d, f))
        else:
            rec["ok"] = True
    rec["seconds"] = round(time.time() - t0)
    print(f"{tid}: {'ok' if rec['ok'] else 'FAILED at ' + rec['failed_at']} in {rec['seconds']} s", flush=True)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--skip", default="")
    ap.add_argument("--only")
    ap.add_argument("--site")
    a = ap.parse_args()
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    ids = [t["id"] for t in targets]
    if a.only:
        ids = [i for i in ids if i in a.only.split(",")]
    skip = set(filter(None, a.skip.split(",")))
    todo = [i for i in ids if i not in skip and not os.path.exists(os.path.join(OUT, "identify", i + ".json"))]
    print(f"{len(todo)} targets to run, {a.parallel} at a time", flush=True)
    with ThreadPoolExecutor(a.parallel) as ex:
        recs = list(ex.map(run_target, todo))
    json.dump(recs, open(os.path.join(OUT, "run_all", "summary.json"), "w"), indent=1)
    done = [i for i in ids if os.path.exists(os.path.join(OUT, "identify", i + ".json"))]
    print(f"steps 2-6 finished for {len(done)} of {len(ids)} targets; running step 7 for them", flush=True)
    cmd = [sys.executable, os.path.join(HERE, "step7_export.py"), "--only", ",".join(done)]
    if a.site:
        cmd += ["--site", a.site]
    subprocess.run(cmd, cwd=os.path.expanduser("~"))


if __name__ == "__main__":
    main()
