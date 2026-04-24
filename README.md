# lean-bench

**Performance benchmarks for leanSig and leanMultisig across hardware.**

Run one command on a target machine → get a JSON file with sign / verify /
aggregate timings plus CPU and memory usage, committed back to this repo →
GitHub Pages renders it with charts grouped by machine.

Live site: _configure once Pages is enabled; see [deploy](#deploy) below._

## Three workload groups

1. **leanSig** (the research crate at `leanEthereum/leanSig`, variant
   `SIGTargetSumLifetime20W4NoOff`) — keygen / sign / verify
2. **xmss** (the XMSS inside `leanEthereum/leanMultisig`, which is what
   leanSpec actually consumes) — keygen / sign / verify at crate defaults
3. **leanMultisig aggregation** at `LOG_INV_RATE_PROD=2` — one flat
   1000-sig leaf aggregation + one 2-to-1 recursion over two 500-sig leaves

Key-generation is opt-in (`--include-keygen`) because lifetime-2^20 keygen
is slow and rarely tells you something interesting about a machine.

## Running on a target machine

Dependencies: **rustc** (rustup) and **uv**. That's it — uv manages the
Python side (psutil); cargo fetches everything the runner binary needs.

```bash
# Once per machine:
curl -LsSf https://astral.sh/uv/install.sh | sh          # uv
curl https://sh.rustup.rs -sSf | sh                      # rustc

git clone <this-repo> lean-bench
cd lean-bench

# Run (default workloads, ~5-10 min on a modern machine).
# --label is optional; defaults to this host's name, or a CPU-derived slug.
uv run bench

# Commit & push — the site rebuilds on deploy
git add results/
git commit -m "benchmark"
git push
```

`uv run` resolves deps from `pyproject.toml` + `uv.lock` on first invocation
and caches the venv under `.venv/`. No `pip install`, no activate step.

### Preview locally before pushing

```bash
uv run serve         # http://localhost:8000
uv run serve --port 4000 --no-browser
```

Serves `site/` and `results/` **live** from their source locations —
edit `site/app.js`, drop a new run JSON into `results/`, just refresh the
browser. `/results/index.json` is regenerated on every request so it always
reflects what's on disk.

Flags worth knowing:
- `--label "nickname"` — override the auto-detected hostname label
- `--include-keygen` — also run leansig.keygen (slow) and xmss.keygen
- `--only <workload-name>` — run just one; repeatable
- `--samples N` (default 30) — samples per workload after `--warmup 3` warm-ups
- `--notes "quiet machine, no other load"` — free-form note attached to the record

Output lands at `results/<YYYY-MM-DDTHH-MM-SSZ>__<fingerprint>.json`. The
fingerprint is a 10-char hash of (CPU model, physical cores, memory GB, OS
family) — stable across runs on the same machine so the site groups them.

## Layout

```
lean-bench/
├─ pyproject.toml                primary project; uv commands live here
├─ uv.lock
├─ runner/                       Python orchestrator (entry: `uv run bench`)
│  ├─ bench.py                   invokes binary, samples resources, writes JSON
│  ├─ sysinfo.py                 CPU / RAM / OS detection + fingerprint
│  └─ sampler.py                 psutil-based CPU/memory polling
├─ runner-rust/                  Rust workload binary
│  ├─ Cargo.toml                 pins leanSig + leanMultisig SHAs
│  └─ crates/lean-bench-runner/  one subcommand per workload → JSON stdout
├─ scripts/
│  ├─ build_index.py             scans results/*.json → results/index.json (CI)
│  └─ dev_server.py              live-reload preview (uv run serve)
├─ results/                      committed JSON, one file per run
├─ schema/v1.json                JSON Schema for current record shape
├─ site/                         static site (vanilla JS + Chart.js via CDN)
│  ├─ index.html                 list of machines; cross-machine comparison
│  ├─ run.html                   per-run detail with per-workload charts
│  ├─ app.js
│  └─ style.css
└─ .github/workflows/
   └─ deploy-pages.yml           on push: rebuild index + deploy site to Pages
```

## Schema evolution

`schema_version: 1` in every record. **Additive-only** evolution: new
versions may add fields but must never remove or repurpose existing ones.
The site branches on `schema_version` where necessary so old records always
render.

If a field is no longer meaningful in v2+, stop writing it — don't repurpose
the key.

## Deploy

1. Enable GitHub Pages: Settings → Pages → Source: *GitHub Actions*.
2. Push to `main` — the `deploy-pages.yml` workflow rebuilds
   `results/index.json`, stages `site/` + `results/`, and deploys.

No `gh-pages` branch; no manual steps after initial setup.

## Reproducibility notes

- SHAs of leanSig and leanMultisig are pinned in `Cargo.toml` and baked
  into the runner binary by `build.rs` — the output JSON records them.
- Runner uses deterministic seeds (`--seed`, default `0xC0FFEE`).
- The fingerprint is coarse by design — OS release and kernel changes
  don't break machine grouping. The full OS/kernel string is still in the
  record for diagnosis.

## Known caveats

- Aggregation benchmark returns total wall-clock including upstream
  one-time setup (DFT twiddles, bytecode init) on the first call. We use
  a per-workload warmup to amortize it; first process launch on a cold
  signer cache still regenerates 10k XMSS keys (~minutes on first run
  ever, cached thereafter).
- CPU percentage is summed across logical cores — a fully-utilized 16-core
  machine reports 1600%, not 100%.
- No turbo / governor pinning baked in. For mainnet-grade numbers, set
  the CPU governor to `performance` and disable turbo before running.
