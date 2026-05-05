// Topology explorer — enumerate balanced-tree aggregation topologies for a
// target signature count, score each by leaf wall + recursion wall + machine
// count + root proof size against a per-machine cost model fit live from the
// index data, and rank them.
//
// Cost model (per machine, derived from the active combo's measurements):
//   flat(M)        ≈ a + b·M    — leaf cost, linear in raw_xmss per leaf
//   recursion(N)   ≈ a' + b'·N  — recursion-only cost, linear in fan-in
//   proof_size(N)  ≈ a'' + b''·N — root proof size, linear in fan-in
//
// Reuses helpers (`el`, `colorFor`, `shortSha`, `fmtRelative`) from app.js
// which loads first.

if (document.body.dataset.page === "topology") renderTopologyPage();

let topoIndexData = null;
let topoActiveCombo = null;
let topoMachines = []; // filtered to active combo

async function renderTopologyPage() {
  try {
    topoIndexData = await fetch("results/index.json").then((r) => r.json());
  } catch (e) {
    document.querySelector("#topology-results").innerHTML =
      "<p>No results yet — run a sweep first.</p>";
    return;
  }

  const combos = topoIndexData.combos || [];
  const params = new URLSearchParams(location.search);
  const ls = params.get("leansig");
  const lm = params.get("leanmultisig");
  topoActiveCombo = (ls && lm
    ? combos.find((c) => c.leansig_sha.startsWith(ls) && c.leanmultisig_sha.startsWith(lm))
    : null) || combos[0];

  if (!topoActiveCombo) {
    document.querySelector("#topology-results").innerHTML =
      "<p>No combos in the index.</p>";
    return;
  }

  setupComboFilter(combos);
  setupInputHandlers();
  applyActiveCombo();
}

// Filter machines to those with aggregate-workload data on the active combo.
function deriveMachinesForCombo(combo) {
  return (topoIndexData.machines || [])
    .map((m) => ({
      ...m,
      runs: (m.runs || []).filter((r) =>
        r.git_shas?.leansig_sha === combo.leansig_sha
        && r.git_shas?.leanmultisig_sha === combo.leanmultisig_sha
        && (r.workloads || []).some((w) => w.name.startsWith("aggregate."))),
    }))
    .filter((m) => m.runs.length > 0)
    .sort((a, b) =>
      (b.logical_cores || 0) - (a.logical_cores || 0)
      || (a.label || "").localeCompare(b.label || ""));
}

// Render the combo-filter dropdown using the same details/menu pattern as
// the index page. Picking a combo refits the cost model + repopulates the
// machine dropdown without reloading the page.
function setupComboFilter(combos) {
  const details = document.querySelector("#combo-filter");
  const label   = details.querySelector(".combo-label");
  const menu    = document.querySelector("#combo-menu");

  document.addEventListener("click", (e) => {
    if (details.open && !details.contains(e.target)) details.open = false;
  });

  if (!combos.length) {
    label.textContent = "no runs yet";
    details.style.pointerEvents = "none";
    return;
  }

  const updateLabel = () => {
    label.textContent = comboShortLabel(topoActiveCombo);
    details.title = `leansig ${topoActiveCombo.leansig_sha} · leanmultisig ${topoActiveCombo.leanmultisig_sha}`;
  };
  updateLabel();

  for (const c of combos) {
    const active = c.leansig_sha === topoActiveCombo.leansig_sha
                && c.leanmultisig_sha === topoActiveCombo.leanmultisig_sha;
    const opt = el("div", {
      class: `combo-option${active ? " active" : ""}`,
      title: `leansig ${c.leansig_sha}\nleanmultisig ${c.leanmultisig_sha}`,
    },
      el("div", { class: "combo-option-shas",
        text: `leansig ${shortSha(c.leansig_sha)} · leanmultisig ${shortSha(c.leanmultisig_sha)}` }),
      el("div", { class: "combo-option-meta",
        text: `${fmtRelative(c.latest_run_ts)} · ${c.run_count} run${c.run_count === 1 ? "" : "s"}` }),
    );
    opt.addEventListener("click", () => {
      topoActiveCombo = c;
      details.open = false;
      updateLabel();
      for (const o of menu.querySelectorAll(".combo-option")) o.classList.remove("active");
      opt.classList.add("active");
      // Persist the selection in the URL so refresh keeps the same combo.
      const params = new URLSearchParams(location.search);
      params.set("leansig", shortSha(c.leansig_sha));
      params.set("leanmultisig", shortSha(c.leanmultisig_sha));
      history.replaceState(null, "", location.pathname + "?" + params.toString());
      applyActiveCombo();
    });
    menu.appendChild(opt);
  }
}

function setupInputHandlers() {
  const machineSelect   = document.querySelector("#topo-machine");
  const totalSigsInput  = document.querySelector("#topo-total-sigs");
  const leafBudgetInput = document.querySelector("#topo-leaf-budget");
  const maxFanInSelect  = document.querySelector("#topo-max-fanin");
  const sortSelect      = document.querySelector("#topo-sort");
  for (const input of [machineSelect, totalSigsInput, leafBudgetInput, maxFanInSelect, sortSelect]) {
    input.addEventListener("change", recompute);
    input.addEventListener("input", recompute);
  }
}

// Re-derive machines for the active combo, repopulate the machine dropdown
// (preserving the previous selection if the same machine still has data),
// and trigger a recompute. Called both on initial load and on combo change.
function applyActiveCombo() {
  topoMachines = deriveMachinesForCombo(topoActiveCombo);
  const machineSelect = document.querySelector("#topo-machine");
  const prev = machineSelect.value;
  machineSelect.innerHTML = "";
  if (!topoMachines.length) {
    document.querySelector("#topology-results").innerHTML =
      `<p>No aggregate-workload data in this combo (leansig ${shortSha(topoActiveCombo.leansig_sha)} · leanmultisig ${shortSha(topoActiveCombo.leanmultisig_sha)}).</p>`;
    document.querySelector("#topo-cost-grid").innerHTML = "";
    return;
  }
  for (const m of topoMachines) {
    machineSelect.appendChild(el("option", { value: m.fingerprint }, m.label || m.fingerprint));
  }
  if (prev && topoMachines.find((m) => m.fingerprint === prev)) {
    machineSelect.value = prev;
  } else {
    machineSelect.value = topoMachines[0].fingerprint;
  }
  recompute();
}

function recompute() {
  const machine = topoMachines.find((m) => m.fingerprint
    === document.querySelector("#topo-machine").value) || topoMachines[0];
  if (!machine) return;
  const totalSigs    = parseInt(document.querySelector("#topo-total-sigs").value, 10);
  const leafBudgetMs = parseFloat(document.querySelector("#topo-leaf-budget").value);
  const maxFanIn     = parseInt(document.querySelector("#topo-max-fanin").value, 10);
  const sortBy       = document.querySelector("#topo-sort").value;
  if (!Number.isFinite(totalSigs) || totalSigs < 2) return;

  const model = fitCostModel(machine);
  renderCostModel(model);
  const candidates = enumerateTopologies(totalSigs, maxFanIn);
  const evaluated = candidates
    .map((t) => evaluateTopology(t, model))
    .filter((r) => r.leafWall <= leafBudgetMs);
  evaluated.sort((a, b) => (a[sortBy] - b[sortBy]) || (a.machines - b.machines));
  renderResults(evaluated, model, totalSigs, leafBudgetMs);
}

// ---------- cost model -----------------------------------------------------

// Pull the latest run's aggregate workloads for a machine, fit linear models
// for flat(M), r(N), proof(N). Each model returns a { predict, a, b, r2,
// xMin, xMax, sample } object so the UI can show the fit + flag
// extrapolation.
function fitCostModel(machine) {
  const latest = pickLatestRun(machine);
  const flatPoints = []; // { M, ns }
  const recPoints = [];  // { N, ns } — averages across leaf sizes per N
  const proofPoints = []; // { N, kib }
  const recByFanIn = new Map();
  const proofByFanIn = new Map();

  for (const w of latest.workloads || []) {
    let m = /^aggregate\.flat_(\d+)_r2$/.exec(w.name);
    if (m && w.mean_ns != null) {
      flatPoints.push({ x: parseInt(m[1], 10), y: w.mean_ns / 1e6 });
    }
    m = /^aggregate\.tree_(\d+)x(\d+)_r2$/.exec(w.name);
    if (m) {
      const N = parseInt(m[1], 10);
      if (w.time_ns_root != null) {
        if (!recByFanIn.has(N)) recByFanIn.set(N, []);
        recByFanIn.get(N).push(w.time_ns_root / 1e6);
      }
      if (w.proof_kib_root != null) {
        if (!proofByFanIn.has(N)) proofByFanIn.set(N, []);
        proofByFanIn.get(N).push(w.proof_kib_root);
      }
    }
  }
  for (const [N, vs] of recByFanIn) recPoints.push({ x: N, y: mean(vs) });
  for (const [N, vs] of proofByFanIn) proofPoints.push({ x: N, y: mean(vs) });

  return {
    machine,
    flat:  linearFit(flatPoints,  "ms",  "M", "raw_xmss per leaf"),
    rec:   linearFit(recPoints,   "ms",  "N", "fan-in"),
    proof: linearFit(proofPoints, "KiB", "N", "fan-in"),
  };
}

function pickLatestRun(machine) {
  return [...machine.runs].sort((a, b) =>
    (b.timestamp || "").localeCompare(a.timestamp || ""))[0];
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

// Ordinary least squares y = a + b·x, returns predictor + R² + range.
// `xVar` is the short variable name shown in the rendered formula
// (e.g. "M", "N"); `xLabel` is the longer human-readable description
// kept around for tooltips / future use.
function linearFit(points, yUnit, xVar, xLabel) {
  const sample = points.length;
  if (sample < 2) {
    return { predict: () => null, a: null, b: null, r2: null, sample, yUnit, xVar, xLabel,
             xMin: null, xMax: null, points };
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const meanY = sumY / n;
  const denom = n * sumXX - sumX * sumX;
  const b = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;
  const ssTot = ys.reduce((acc, y) => acc + (y - meanY) ** 2, 0);
  const ssRes = ys.reduce((acc, y, i) => acc + (y - (a + b * xs[i])) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  return {
    predict: (x) => a + b * x,
    a, b, r2, sample, yUnit, xVar, xLabel, xMin, xMax, points,
  };
}

function fmtFit(fit) {
  if (fit.sample < 2) return "(insufficient data)";
  const a = fit.a;
  const b = fit.b;
  const sign = b >= 0 ? " + " : " − ";
  return `${a.toFixed(1)}${sign}${Math.abs(b).toFixed(2)} × ${fit.xVar}  ${fit.yUnit}`;
}

// ---------- topology enumeration -------------------------------------------

const ALLOWED_FANINS_ALL = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 32, 40];
const MAX_TIERS = 5;
const MIN_LEAF_SIZE = 50;
const MAX_LEAF_SIZE = 5000;

// Yield all balanced-tree topologies that aggregate `totalSigs` raw signatures
// using fan-ins ≤ maxFanIn at each tier.
function enumerateTopologies(totalSigs, maxFanIn) {
  const fanins = ALLOWED_FANINS_ALL.filter((n) => n <= maxFanIn);
  const out = [];
  const recurse = (tiers, productSoFar) => {
    if (tiers.length >= 1) {
      const leafSize = totalSigs / productSoFar;
      if (Number.isInteger(leafSize)
          && leafSize >= MIN_LEAF_SIZE
          && leafSize <= MAX_LEAF_SIZE) {
        out.push({ tiers: [...tiers], leafSize });
      }
    }
    if (tiers.length >= MAX_TIERS) return;
    for (const f of fanins) {
      const next = productSoFar * f;
      if (next > totalSigs) continue;
      tiers.push(f);
      recurse(tiers, next);
      tiers.pop();
    }
  };
  recurse([], 1);
  return out;
}

function evaluateTopology(t, model) {
  const leafWall = model.flat.predict(t.leafSize);
  const recPerTier = t.tiers.map((n) => model.rec.predict(n) ?? 0);
  const recWall = recPerTier.reduce((acc, ms) => acc + ms, 0);
  const totalWall = leafWall + recWall;
  const machines = t.tiers.reduce((acc, n) => acc * n, 1);
  const rootProof = t.tiers.length ? model.proof.predict(t.tiers[0]) : null;
  const extrapolatesRec = t.tiers.some((n) => n > model.rec.xMax);
  const extrapolatesFlat = t.leafSize > model.flat.xMax;
  return {
    tiers: t.tiers,
    leafSize: t.leafSize,
    leafWall, recWall, recPerTier, totalWall, machines, rootProof,
    extrapolatesRec, extrapolatesFlat,
    label: `${t.tiers.join("×")}×${t.leafSize}`,
  };
}

// ---------- rendering ------------------------------------------------------

function renderCostModel(model) {
  const grid = document.querySelector("#topo-cost-grid");
  grid.innerHTML = "";
  const rows = [
    { label: "flat(M)",        fit: model.flat,  unit: "ms" },
    { label: "recursion(N)",   fit: model.rec,   unit: "ms" },
    { label: "proof_size(N)",  fit: model.proof, unit: "KiB" },
  ];
  const table = el("table", { class: "topo-cost-table" });
  const head = el("thead");
  head.appendChild(el("tr", {},
    el("th", { text: "metric" }),
    el("th", { text: "calculation" }),
    el("th", { text: "R²" }),
    el("th", { text: "benched range" }),
    el("th", { text: "samples" }),
  ));
  table.appendChild(head);
  const body = el("tbody");
  for (const r of rows) {
    body.appendChild(el("tr", {},
      el("td", { class: "topo-cost-name",
        title: `${r.fit.xVar} = ${r.fit.xLabel}`, text: r.label }),
      el("td", { text: fmtFit(r.fit) }),
      el("td", { text: r.fit.r2 == null ? "—" : r.fit.r2.toFixed(3) }),
      el("td", { text: r.fit.xMin == null ? "—" : `${r.fit.xMin}…${r.fit.xMax}` }),
      el("td", { text: String(r.fit.sample) }),
    ));
  }
  table.appendChild(body);
  grid.appendChild(table);
}

function renderResults(rows, model, totalSigs, leafBudgetMs) {
  const wrap = document.querySelector("#topo-table-wrap");
  wrap.innerHTML = "";
  if (!rows.length) {
    wrap.appendChild(el("p", {},
      `No topologies fit within leaf-wall budget ${leafBudgetMs} ms for ${totalSigs} signatures. Try a larger budget or smaller total.`));
    return;
  }
  const table = el("table", { class: "topo-results-table" });
  const head = el("thead");
  head.appendChild(el("tr", {},
    el("th", { text: "topology" }),
    el("th", { text: "leaf wall" }),
    el("th", { text: "rec wall" }),
    el("th", { text: "total wall" }),
    el("th", { text: "machines" }),
    el("th", { text: "root proof" }),
    el("th", { text: "notes" }),
  ));
  table.appendChild(head);
  const body = el("tbody");
  for (const r of rows.slice(0, 50)) {
    const notes = [];
    if (r.extrapolatesRec) notes.push("rec extrapolated");
    if (r.extrapolatesFlat) notes.push("leaf extrapolated");
    // Per-tier breakdown of recursion wall — root tier first to match the
    // topology label (which reads root → leaves left-to-right).
    const recCell = el("td", {},
      el("div", { class: "topo-rec-total", text: fmtMs(r.recWall) }),
      r.recPerTier.length > 1
        ? el("div", { class: "topo-rec-break",
            text: r.recPerTier.map((ms) => fmtMsCompact(ms)).join(" + ") })
        : null,
    );
    body.appendChild(el("tr", { class: notes.length ? "topo-extrapolated" : "" },
      el("td", { class: "topo-name", text: r.label }),
      el("td", { text: fmtMs(r.leafWall) }),
      recCell,
      el("td", { class: "topo-total", text: fmtMs(r.totalWall) }),
      el("td", { text: String(r.machines) }),
      el("td", { text: r.rootProof != null ? `${Math.round(r.rootProof)} KiB` : "—" }),
      el("td", { class: "topo-notes", text: notes.join(", ") }),
    ));
  }
  table.appendChild(body);
  wrap.appendChild(table);

  if (rows.length > 50) {
    wrap.appendChild(el("p", { class: "section-note",
      text: `Showing top 50 of ${rows.length} candidates.` }));
  }
}

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// Compact form for inside-cell breakdowns: drops the unit on intermediate
// terms so "0.92 + 0.92 + 0.92 s" doesn't repeat itself, and uses fewer
// decimals when the tier count is high so wide trees stay readable.
function fmtMsCompact(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
