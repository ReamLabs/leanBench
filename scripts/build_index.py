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
            "workloads": r["workloads"],
        })
    for m in machines.values():
        m.pop("_latest_ts", None)
        m["runs"].sort(key=lambda x: x["timestamp"], reverse=True)

    return {
        "generated_at": _now(),
        "run_count": len(runs),
        "machines": sorted(machines.values(), key=lambda m: m["label"].lower()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", type=Path, default=Path("results"))
    ap.add_argument("--out", type=Path, default=Path("results/index.json"))
    args = ap.parse_args()

    index = build_index(args.results)
    args.out.write_text(json.dumps(index, indent=2) + "\n")
    print(f"wrote {args.out} ({index['run_count']} runs, {len(index['machines'])} machines)")


def _summarize(rec: dict, filename: str) -> dict:
    workloads = [
        {"name": w.get("name"),
         "mean_ns": (w.get("timing") or {}).get("mean_ns"),
         "p95_ns": (w.get("timing") or {}).get("p95_ns")}
        for w in rec.get("workloads", [])
    ]
    return {
        "schema_version": rec.get("schema_version"),
        "run_id": rec.get("run_id"),
        "timestamp": rec.get("timestamp"),
        "file": filename,
        "machine": rec.get("machine", {}),
        "workloads": workloads,
    }


def _now() -> str:
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc).isoformat()


if __name__ == "__main__":
    main()
