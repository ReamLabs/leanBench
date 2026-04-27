"""Run a benchmark on a fresh remote VM and pull the result file back.

End-to-end: create VM → install rust + uv → clone repo → run `uv run bench`
→ scp result JSON into local `results/` → destroy VM.

VM is destroyed in a `try/finally`, including on Ctrl-C, so leaks should
require an actively crashed Python interpreter (in which case the orphan
is tagged `lean-bench=true` for cleanup).

Usage:
    uv run remote-bench \\
        --credentials gcp-credentials.json \\
        --machine-type n2-standard-8 \\
        --image-family ubuntu-2404-lts

`--project` defaults to the `project_id` field in the credentials JSON.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import signal
import subprocess
import sys
from pathlib import Path

from scripts.provisioners import InstanceSpec
from scripts.provisioners.gcp import GCPProvisioner


# Bash run on the VM after SSH is up. Idempotent; designed to survive a
# re-run on the same VM during debugging.
SETUP_AND_RUN = r"""
set -euo pipefail

# Wait out cloud-init before touching apt — avoids dpkg-lock contention
# during the first ~60s after boot.
echo '==> [remote] waiting for cloud-init...'
sudo cloud-init status --wait >/dev/null 2>&1 || true

echo '==> [remote] installing build prerequisites...'
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    build-essential git curl ca-certificates pkg-config

if ! command -v cargo >/dev/null 2>&1; then
    echo '==> [remote] installing rustup...'
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --profile minimal
fi
. "$HOME/.cargo/env"

if ! command -v uv >/dev/null 2>&1; then
    echo '==> [remote] installing uv...'
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

if [ ! -d lean-bench ]; then
    echo "==> [remote] cloning {repo_url}"
    git clone --depth 1 --branch {branch} {repo_url} lean-bench
fi
cd lean-bench
git fetch origin {branch} --quiet
git checkout --quiet {branch}
git reset --hard --quiet origin/{branch}

echo '==> [remote] running benchmark...'
uv run bench {bench_args}

# Echo a parseable marker so the orchestrator knows where the result
# landed (independent of bench.py's free-form output).
echo "RESULT_FILE=$(ls -t results/*.json 2>/dev/null | grep -v 'results/index.json' | head -1)"
"""


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=["gcp"], default="gcp")
    ap.add_argument("--credentials", type=Path, required=True,
                    help="Path to GCP service-account JSON key")
    ap.add_argument("--project", default=None,
                    help="GCP project ID. Defaults to the `project_id` field "
                         "in the credentials JSON.")
    ap.add_argument("--zone", default="us-central1-a")
    ap.add_argument("--machine-type", default="n2-standard-8")
    ap.add_argument("--image-family", default="ubuntu-2404-lts-amd64",
                    help="GCP image family. Ubuntu 24.04 is published under "
                         "arch-suffixed families: `ubuntu-2404-lts-amd64` "
                         "(x86_64) or `ubuntu-2404-lts-arm64` (e.g. for "
                         "T2A / Axion machine types).")
    ap.add_argument("--image-project", default="ubuntu-os-cloud",
                    help="Image source project (e.g. ubuntu-os-cloud, debian-cloud)")
    ap.add_argument("--repo-url", default=None,
                    help="Where the VM should clone lean-bench from. "
                         "Defaults to `git remote get-url origin` of the local checkout.")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--bench-args", default="",
                    help="Extra args passed to `uv run bench` on the remote "
                         "(e.g. \"--include-keygen --samples 50\")")
    ap.add_argument("--keep-on-failure", action="store_true",
                    help="Don't destroy the VM if the bench fails — useful for debugging")
    ap.add_argument("--out-dir", type=Path, default=Path("results"))
    ap.add_argument("--ssh-timeout-s", type=int, default=300)
    args = ap.parse_args()

    if not args.credentials.is_file():
        sys.exit(f"credentials file not found: {args.credentials}")

    # Hard-fail early on missing CLI prerequisites — easier to debug than a
    # subprocess `FileNotFoundError` deep in the provisioner stack.
    if args.provider == "gcp" and shutil.which("gcloud") is None:
        sys.exit(
            "gcloud CLI not found on PATH. Install it first:\n"
            "  macOS:  brew install --cask google-cloud-sdk\n"
            "  other:  https://cloud.google.com/sdk/docs/install"
        )

    if args.repo_url is None:
        args.repo_url = _detect_repo_url()
        if not args.repo_url:
            sys.exit("could not auto-detect --repo-url; pass it explicitly")

    # Default --project to the SA key's project_id field — one less flag in
    # the common case where you bench in the project that owns the SA.
    if args.project is None:
        try:
            args.project = json.loads(args.credentials.read_text()).get("project_id")
        except (OSError, ValueError) as e:
            sys.exit(f"could not read project_id from {args.credentials}: {e}")
        if not args.project:
            sys.exit("--project not given and credentials JSON has no project_id field")

    # ---- pick + initialise provisioner ----------------------------------
    if args.provider == "gcp":
        prov = GCPProvisioner(
            project=args.project,
            zone=args.zone,
            credentials_path=args.credentials.resolve(),
        )
    else:
        sys.exit(f"unknown provider: {args.provider}")

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    vm_name = f"lean-bench-{timestamp}"
    spec = InstanceSpec(
        name=vm_name,
        machine_type=args.machine_type,
        image_family=args.image_family,
        extras={"image_project": args.image_project},
        # Stable label so orphan instances are easy to clean up.
        labels={"lean-bench": "true", "lean-bench-ephemeral": "true"},
    )

    inst = None
    summary: dict | None = None
    try:
        print(f"==> creating {vm_name}")
        print(f"    {args.machine_type} · {args.image_family} · {args.zone}")
        inst = prov.create(spec)

        # Install signal handlers AFTER the VM exists — so Ctrl-C destroys it.
        def cleanup_signal(sig, _frame):
            print("\n==> caught signal; destroying instance...")
            if inst is not None:
                try:
                    prov.destroy(inst)
                except Exception as e:  # noqa: BLE001
                    print(f"    error destroying: {e}")
            prov.close()
            sys.exit(130)

        signal.signal(signal.SIGINT, cleanup_signal)
        signal.signal(signal.SIGTERM, cleanup_signal)

        print(f"==> waiting for SSH (timeout {args.ssh_timeout_s}s)")
        prov.wait_ssh_ready(inst, timeout_s=args.ssh_timeout_s)

        print("==> running setup + bench (live output below)")
        print("─" * 64)
        # Tag the result with the machine type so cross-run comparisons by
        # label are meaningful (vs. the GCE-assigned hostname). User-supplied
        # `--bench-args` can override since argparse takes the last `--label`.
        bench_args = f"--label {args.machine_type} {args.bench_args}".strip()
        cmd = SETUP_AND_RUN.format(
            repo_url=args.repo_url,
            branch=args.branch,
            bench_args=bench_args,
        )
        rc = prov.ssh_exec(inst, cmd)
        print("─" * 64)
        if rc != 0:
            raise RuntimeError(f"benchmark exited with code {rc}")

        # ---- discover the result file ----------------------------------
        # Re-run the same `ls -t` so we don't rely on parsing streamed stdout.
        marker = prov.ssh_capture(
            inst,
            "cd lean-bench && ls -t results/*.json 2>/dev/null "
            "| grep -v 'results/index.json' | head -1",
        )
        if not marker:
            raise RuntimeError("bench finished but no result JSON found on remote")
        remote_path = f"lean-bench/{marker}"

        # ---- pull it back ---------------------------------------------
        args.out_dir.mkdir(parents=True, exist_ok=True)
        local_path = args.out_dir / Path(marker).name
        print(f"==> pulling result back → {local_path}")
        prov.scp_back(inst, remote_path, local_path)

        summary = _summary(local_path)

    except Exception as e:  # noqa: BLE001
        print(f"\nerror: {e}", file=sys.stderr)
        if args.keep_on_failure and inst is not None:
            print(
                f"\nVM {inst.name} retained for debugging. "
                f"When done:\n  gcloud compute instances delete {inst.name} "
                f"--zone={args.zone} --quiet",
                file=sys.stderr,
            )
            inst = None  # skip the destroy in finally
        raise
    finally:
        if inst is not None:
            print(f"==> destroying {inst.name}")
            try:
                prov.destroy(inst)
            except Exception as e:  # noqa: BLE001
                print(f"    error destroying (cleanup manually!): {e}", file=sys.stderr)
        prov.close()

    if summary:
        _print_summary(summary)


def _detect_repo_url() -> str | None:
    """Pick a remote to clone on the VM. Prefer the current branch's
    upstream, fall back to `origin`, fall back to the first remote."""
    def _git(*args: str) -> str | None:
        r = subprocess.run(["git", *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None

    remote = None
    branch = _git("branch", "--show-current")
    if branch:
        remote = _git("config", "--get", f"branch.{branch}.remote")
    if not remote:
        remotes = (_git("remote") or "").splitlines()
        if "origin" in remotes:
            remote = "origin"
        elif remotes:
            remote = remotes[0]
    if not remote:
        return None
    return _git("remote", "get-url", remote)


def _summary(local_path: Path) -> dict:
    """Reduce a fresh result file to the headline numbers for stdout."""
    rec = json.loads(local_path.read_text())
    return {
        "label": rec.get("machine", {}).get("label"),
        "cpu":   rec.get("machine", {}).get("cpu_model"),
        "cores": (rec.get("machine", {}).get("physical_cores"),
                  rec.get("machine", {}).get("logical_cores")),
        "memory_gb": rec.get("machine", {}).get("memory_gb"),
        "workloads": [
            {"name":    w.get("name"),
             "mean_ms": (w.get("timing") or {}).get("mean_ns", 0) / 1e6,
             "p95_ms":  ((w.get("timing") or {}).get("p95_ns") or 0) / 1e6,
             "n":       (w.get("timing") or {}).get("n")}
            for w in rec.get("workloads", [])
        ],
        "file": str(local_path),
    }


def _print_summary(s: dict) -> None:
    print()
    print(f"  {s['label']}  —  {s['cpu']}")
    print(f"  {s['cores'][0]}p / {s['cores'][1]}l cores · {s['memory_gb']} GB RAM")
    print()
    print(f"  {'workload':<32} {'mean':>10} {'p95':>10}   n")
    for w in s["workloads"]:
        print(f"  {w['name']:<32} {w['mean_ms']:>9.3f}ms {w['p95_ms']:>9.3f}ms  {w['n']}")
    print()
    print(f"  saved → {s['file']}")


if __name__ == "__main__":
    main()
