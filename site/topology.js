// Topology explorer — enumerate balanced-tree aggregation topologies for a
// target signature count, score each by leaf wall + recursion wall + machine
// count + root proof size against a per-machine cost model fit live from the
// index data, and rank them.
//
// Cost model (per machine, derived from the active combo's measurements):
//   flat(M)     ≈ a + b·M       — leaf cost, linear in raw_xmss per leaf
//   r(N)        ≈ a' + b'·N     — recursion-only cost, linear in fan-in
//   proof(N)    ≈ a'' + b''·N   — root proof size, linear in fan-in
//
// Reuses helpers (`el`, `colorFor`, `shortSha`, `fmtRelative`) from app.js
// which loads first.

if (document.body.dataset.page === "topology") renderTopologyPage();

async function renderTopologyPage() {
  let indexData;
  try {
    indexData = await fetch("results/index.json").then((r) => r.json());
  } catch (e) {
    document.querySelector("#topology-results").innerHTML =
      "<p>No results yet — run a sweep first.</p>";
    return;
  }

  const combos = indexData.combos || [];
  const params = new URLSearchParams(location.search);
  const ls = params.get("leansig");
  const lm = params.get("leanmultisig");
  const activeCombo = (ls && lm
    ? combos.find((c) => c.leansig_sha.startsWith(ls) && c.leanmultisig_sha.startsWith(lm))
    : null) || combos[0];

  if (!activeCombo) {
    document.querySelector("#topology-results").innerHTML =
      "<p>No combos in the index.</p>";
    return;
  }

  // Filter to machines that have aggregate workload data on this combo.
  const machines = (indexData.machines || [])
    .map((m) => ({
      ...m,
      runs: (m.runs || []).filter((r) =>
        r.git_shas?.leansig_sha === activeCombo.leansig_sha
        && r.git_shas?.leanmultisig_sha === activeCombo.leanmultisig_sha
        && (r.workloads || []).some((w) => w.name.startsWith("aggregate."))),
    }))
    .filter((m) => m.runs.length > 0);

  if (!machines.length) {
    document.querySelector("#topology-results").innerHTML =
      `<p>No aggregate-workload data in the active combo (leansig ${shortSha(activeCombo.leansig_sha)} · leanmultisig ${shortSha(activeCombo.leanmultisig_sha)}).</p>`;
    return;
  }

  const machineSelect = document.querySelector("#topo-machine");
  // Default to the largest machine (most logical cores), since "what should I
  // provision" usually maps to "the fastest box I have". Fall back to first
  // by label if logical_cores is missing somewhere.
  const sorted = [...machines].sort((a, b) =>
    (b.logical_cores || 0) - (a.logical_cores || 0)
    || (a.label || "").localeCompare(b.label || ""));
  for (const m of sorted) {
    const opt = el("option", { value: m.fingerprint }, m.label || m.fingerprint);
    machineSelect.appendChild(opt);
  }

  const totalSigsInput = document.querySelector("#topo-total-sigs");
  const leafBudgetInput = document.querySelector("#topo-leaf-budget");
  const maxFanInSelect = document.querySelector("#topo-max-fanin");
  const sortSelect = document.querySelector("#topo-sort");

  // Show which combo we're modelling against (sub-heading on the form).
  const formSection = document.querySelector("#topology-form");
  formSection.insertBefore(el("p", { class: "section-note" },
    `Active combo: leansig ${shortSha(activeCombo.leansig_sha)} · leanmultisig ${shortSha(activeCombo.leanmultisig_sha)} · `,
    el("a", { href: `index.html?leansig=${shortSha(activeCombo.leansig_sha)}&leanmultisig=${shortSha(activeCombo.leanmultisig_sha)}` },
      "view raw measurements"),
  ), formSection.firstChild);

  const recompute = () => {
    const machine = machines.find((m) => m.fingerprint === machineSelect.value)
      || sorted[0];
    const totalSigs = parseInt(totalSigsInput.value, 10);
    const leafBudgetMs = parseFloat(leafBudgetInput.value);
    const maxFanIn = parseInt(maxFanInSelect.value, 10);
    const sortBy = sortSelect.value;
    if (!Number.isFinite(totalSigs) || totalSigs < 2) return;

    const model = fitCostModel(machine);
    renderCostModel(model);
    const candidates = enumerateTopologies(totalSigs, maxFanIn);
    const evaluated = candidates
      .map((t) => evaluateTopology(t, model))
      .filter((r) => r.leafWall <= leafBudgetMs);
    evaluated.sort((a, b) => (a[sortBy] - b[sortBy]) || (a.machines - b.machines));
    renderResults(evaluated, model, totalSigs, leafBudgetMs);
  };

  machineSelect.value = sorted[0].fingerprint;
  for (const input of [machineSelect, totalSigsInput, leafBudgetInput, maxFanInSelect, sortSelect]) {
    input.addEventListener("change", recompute);
    input.addEventListener("input", recompute);
  }
  recompute();
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
    flat: linearFit(flatPoints, "ms", "raw_xmss per leaf"),
    rec:  linearFit(recPoints, "ms", "fan-in"),
    proof: linearFit(proofPoints, "KiB", "fan-in"),
  };
}

function pickLatestRun(machine) {
  return [...machine.runs].sort((a, b) =>
    (b.timestamp || "").localeCompare(a.timestamp || ""))[0];
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

// Ordinary least squares y = a + b·x, returns predictor + R² + range.
function linearFit(points, yUnit, xLabel) {
  const sample = points.length;
  if (sample < 2) {
    return { predict: () => null, a: null, b: null, r2: null, sample, yUnit, xLabel,
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
    a, b, r2, sample, yUnit, xLabel, xMin, xMax, points,
  };
}

function fmtFit(fit) {
  if (fit.sample < 2) return "(insufficient data)";
  const a = fit.a;
  const b = fit.b;
  const sign = b >= 0 ? " + " : " − ";
  return `${a.toFixed(1)}${sign}${Math.abs(b).toFixed(2)} · x  ${fit.yUnit}`;
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
  const recWall = t.tiers.reduce((acc, n) => acc + (model.rec.predict(n) ?? 0), 0);
  const totalWall = leafWall + recWall;
  const machines = t.tiers.reduce((acc, n) => acc * n, 1);
  const rootProof = t.tiers.length ? model.proof.predict(t.tiers[0]) : null;
  const extrapolatesRec = t.tiers.some((n) => n > model.rec.xMax);
  const extrapolatesFlat = t.leafSize > model.flat.xMax;
  return {
    tiers: t.tiers,
    leafSize: t.leafSize,
    leafWall, recWall, totalWall, machines, rootProof,
    extrapolatesRec, extrapolatesFlat,
    label: `${t.tiers.join("×")}×${t.leafSize}`,
  };
}

// ---------- rendering ------------------------------------------------------

function renderCostModel(model) {
  const grid = document.querySelector("#topo-cost-grid");
  grid.innerHTML = "";
  const rows = [
    { label: "flat(M)",   fit: model.flat,  unit: "ms" },
    { label: "r(N)",      fit: model.rec,   unit: "ms" },
    { label: "proof(N)",  fit: model.proof, unit: "KiB" },
  ];
  const table = el("table", { class: "topo-cost-table" });
  const head = el("thead");
  head.appendChild(el("tr", {},
    el("th", { text: "metric" }),
    el("th", { text: "fit" }),
    el("th", { text: "R²" }),
    el("th", { text: "benched range" }),
    el("th", { text: "samples" }),
  ));
  table.appendChild(head);
  const body = el("tbody");
  for (const r of rows) {
    body.appendChild(el("tr", {},
      el("td", { class: "topo-cost-name", text: r.label }),
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
    body.appendChild(el("tr", { class: notes.length ? "topo-extrapolated" : "" },
      el("td", { class: "topo-name", text: r.label }),
      el("td", { text: fmtMs(r.leafWall) }),
      el("td", { text: fmtMs(r.recWall) }),
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
