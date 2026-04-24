"""Build results/index.json by scanning results/*.json.

The index is a *lean* summary keyed for fast list-view rendering: schema
version, machine identity, timestamp, per-workload mean only. The detail
page fetches the full per-run file.

Run this in CI before deploying the static site.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def build_index(results_dir: Path) -> dict:
    """Scan `results_dir/*.json` and return the index dict. Pure function;
    used by both the CLI and the local dev server."""
    runs = []
    for f in sorted(results_dir.glob("*.json")):
        if f.name == "index.json":
            continue
        try:
            rec = json.loads(f.read_text())
        except json.JSONDecodeError as e:
            print(f"skip {f}: {e}")
            continue
        runs.append(_summarize(rec, f.name))

    machines: dict[str, dict] = {}
    for r in runs:
        fp = r["machine"]["fingerprint"]
        m = machines.setdefault(fp, {
            "fingerprint": fp,
            "label": r["machine"].get("label", fp),
            "cpu_model": r["machine"].get("cpu_model", ""),
            "physical_cores": r["machine"].get("physical_cores"),
            "logical_cores": r["machine"].get("logical_cores"),
            "memory_gb": r["machine"].get("memory_gb"),
            "os": r["machine"].get("os"),
            "runs": [],
        })
        if r["timestamp"] >= m.get("_latest_ts", ""):
            m["label"] = r["machine"].get("label", m["label"])
            m["_latest_ts"] = r["timestamp"]
        m["runs"].append({
            "run_id": r["run_id"],
            "timestamp": r["timestamp"],
            "file": r["file"],
            "schema_version": r["schema_version"],
            "git_shas": r["git_shas"],
            "workloads": r["workloads"],
        })
    for m in machines.values():
        m.pop("_latest_ts", None)
        m["runs"].sort(key=lambda x: x["timestamp"], reverse=True)

    return {
        "generated_at": _now(),
        "run_count": len(runs),
        "combos": _combos(runs),
        "machines": sorted(machines.values(), key=lambda m: m["label"].lower()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, default=Path("results"))
    ap.add_argument("--out", type=Path, default=Path("results/index.json"))
    args = ap.parse_args()

    index = build_index(args.results)
    args.out.write_text(json.dumps(index, indent=2) + "\n")
    print(
        f"wrote {args.out} "
        f"({index['run_count']} runs, {len(index['machines'])} machines, "
        f"{len(index['combos'])} combos)"
    )


def _summarize(rec: dict, filename: str) -> dict:
    workloads = [
        {"name": w.get("name"),
         "mean_ns": (w.get("timing") or {}).get("mean_ns"),
         "p95_ns": (w.get("timing") or {}).get("p95_ns")}
        for w in rec.get("workloads", [])
    ]
    shas = (rec.get("toolchain") or {}).get("git_shas") or {}
    return {
        "schema_version": rec.get("schema_version"),
        "run_id": rec.get("run_id"),
        "timestamp": rec.get("timestamp"),
        "file": filename,
        "machine": rec.get("machine", {}),
        "git_shas": {
            "leansig_sha":      shas.get("leansig_sha", "unknown"),
            "leanmultisig_sha": shas.get("leanmultisig_sha", "unknown"),
        },
        "workloads": workloads,
    }


def _combos(runs: list[dict]) -> list[dict]:
    """Unique (leansig, leanmultisig) SHA pairs seen across runs, sorted
    descending by the most-recent run that used each pair. `latest_run_ts`
    is what the frontend uses for ordering — SHAs themselves aren't orderable.
    """
    buckets: dict[tuple[str, str], dict] = {}
    for r in runs:
        key = (r["git_shas"]["leansig_sha"], r["git_shas"]["leanmultisig_sha"])
        b = buckets.setdefault(key, {
            "leansig_sha":      key[0],
            "leanmultisig_sha": key[1],
            "latest_run_ts":    r["timestamp"],
            "run_count":        0,
            "_machines":        set(),
        })
        b["run_count"] += 1
        b["_machines"].add(r["machine"].get("fingerprint"))
        if r["timestamp"] > b["latest_run_ts"]:
            b["latest_run_ts"] = r["timestamp"]

    out = []
    for b in buckets.values():
        out.append({
            "leansig_sha":      b["leansig_sha"],
            "leanmultisig_sha": b["leanmultisig_sha"],
            "latest_run_ts":    b["latest_run_ts"],
            "run_count":        b["run_count"],
            "machine_count":    len(b["_machines"]),
        })
    out.sort(key=lambda c: c["latest_run_ts"], reverse=True)
    return out


def _now() -> str:
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc).isoformat()


if __name__ == "__main__":
    main()
