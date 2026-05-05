// Trend page — show how headline workloads have moved across the
// chronological sequence of leanSig / leanMultisig SHA pairs ("combos") on a
// chosen target machine.
//
// Two views fed from the same data:
//   - log-scaled multi-line chart (one line per workload, x = combo)
//   - exact-numbers table linkable to the per-combo index view

if (document.body.dataset.page === "trend") renderTrendPage();

const TREND_HEADLINES = [
  { name: "xmss.sign",                 col: "xmss.sign" },
  { name: "aggregate.flat_500_r2",     col: "flat_500" },
  { name: "aggregate.tree_2x500_r2",   col: "tree_2x500" },
  { name: "aggregate.tree_4x500_r2",   col: "tree_4x500" },
  { name: "aggregate.tree_8x500_r2",   col: "tree_8x500" },
];

// Aggregate-only subset for the proof-size charts (xmss.sign doesn't produce
// a published recursion proof, so it's omitted from the proof view).
const TREND_PROOF_HEADLINES = TREND_HEADLINES.filter(
  (h) => h.name.startsWith("aggregate.")
);

let trendIndexData = null;
let trendCharts = []; // one per workload — destroyed/rebuilt on machine change
let trendProofCharts = []; // independent of machine — only rebuilt on initial load

async function renderTrendPage() {
  try {
    trendIndexData = await fetch("results/index.json").then((r) => r.json());
  } catch (e) {
    document.querySelector("#trend-chart-section").innerHTML =
      "<p>No results yet — run a sweep first.</p>";
    return;
  }
  const combos = trendIndexData.combos || [];
  if (combos.length < 2) {
    document.querySelector("#trend-chart-section").innerHTML =
      "<p>Only one combo in the index — nothing to compare across yet.</p>";
    document.querySelector("#trend-table-section").style.display = "none";
    return;
  }

  // Populate the machine dropdown — sort by logical_cores desc so the fastest
  // box is the default. Only include machines that have ≥2 combos worth of
  // data (otherwise there's nothing to chart).
  const machines = [...(trendIndexData.machines || [])].sort((a, b) =>
    (b.logical_cores || 0) - (a.logical_cores || 0));
  const eligible = machines.filter((m) => {
    const seen = new Set();
    for (const r of m.runs || []) {
      seen.add(`${r.git_shas.leansig_sha}|${r.git_shas.leanmultisig_sha}`);
    }
    return seen.size >= 2;
  });
  if (!eligible.length) {
    document.querySelector("#trend-chart-section").innerHTML =
      "<p>No machine has data on more than one combo yet.</p>";
    document.querySelector("#trend-table-section").style.display = "none";
    return;
  }

  const select = document.querySelector("#trend-machine");
  for (const m of eligible) {
    select.appendChild(el("option", { value: m.fingerprint }, m.label || m.fingerprint));
  }
  select.value = eligible[0].fingerprint;
  select.addEventListener("change", () => recomputeTrend(eligible, combos));
  recomputeTrend(eligible, combos);

  // Proof sizes are deterministic per topology so the chart doesn't depend
  // on the chosen machine — render once on load using whatever machine has
  // the data for each combo.
  renderProofCharts(machines, combos);
}

function recomputeTrend(machines, combos) {
  const select = document.querySelector("#trend-machine");
  const machine = machines.find((m) => m.fingerprint === select.value) || machines[0];

  // Combos arrive sorted descending by latest_run_ts (newest first). For
  // chart x-axis we want chronological → reverse to oldest-first; for the
  // table we keep newest-first (top row = latest).
  const chronological = [...combos].reverse();

  // For each (combo, workload), find best (smallest) mean on this machine.
  const best = (combo, workloadName) => {
    const runs = (machine.runs || []).filter((r) =>
      r.git_shas.leansig_sha === combo.leansig_sha
      && r.git_shas.leanmultisig_sha === combo.leanmultisig_sha);
    let m = null;
    for (const r of runs) {
      const w = (r.workloads || []).find((x) => x.name === workloadName);
      if (w?.mean_ns != null && (m == null || w.mean_ns < m)) m = w.mean_ns;
    }
    return m == null ? null : m / 1e6;
  };

  renderTrendChart(machine, chronological, best);
  renderTrendTable(machine, combos, best);
}

function renderTrendChart(machine, chronologicalCombos, best) {
  // Render one card-with-chart per headline workload, each with its own
  // linear y-axis so small per-combo differences on small workloads
  // (xmss.sign, ~220 ms) stay readable instead of being squashed by a
  // shared scale that has to fit tree_8x500 (~13 s) on the same axis.
  const grid = document.querySelector("#trend-charts-grid");
  for (const c of trendCharts) c.destroy();
  trendCharts = [];
  grid.innerHTML = "";

  const labels = chronologicalCombos.map((c) =>
    `${shortSha(c.leansig_sha)}·${shortSha(c.leanmultisig_sha)}`);

  let added = 0;
  for (const [i, h] of TREND_HEADLINES.entries()) {
    const data = chronologicalCombos.map((c) => best(c, h.name));
    if (!data.some((v) => v != null)) continue;
    added++;

    const card = el("div", { class: "compare-card" });
    card.appendChild(el("h3", { text: h.col }));
    const wrap = el("div", { class: "compare-card-chart" });
    const canvas = el("canvas");
    wrap.appendChild(canvas);
    card.appendChild(wrap);
    grid.appendChild(card);

    queueMicrotask(() => {
      const chart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: h.col,
            data,
            borderColor: colorFor(i),
            backgroundColor: colorFor(i) + "22",
            tension: 0.15,
            fill: false,
            pointRadius: 4,
            pointHoverRadius: 6,
            spanGaps: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => `combo ${labels[items[0].dataIndex]}`,
                label: (ctx) => {
                  const ms = ctx.parsed.y;
                  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
                },
              },
            },
          },
          scales: {
            x: { title: { display: true, text: "combo (oldest → newest)" } },
            y: { title: { display: true, text: "ms (mean)" }, beginAtZero: true },
          },
        },
      });
      trendCharts.push(chart);
    });
  }
  if (!added) {
    grid.innerHTML = "<p>No headline-workload data on this machine across combos.</p>";
  }
}

// One small line chart per aggregate workload showing the published
// proof size (KiB) over chronological combos. Proof size is deterministic
// per topology so we pull it from whichever machine in the index recorded
// it for that combo.
function renderProofCharts(machines, combos) {
  const grid = document.querySelector("#trend-proof-grid");
  if (!grid) return;
  for (const c of trendProofCharts) c.destroy();
  trendProofCharts = [];
  grid.innerHTML = "";

  const chronological = [...combos].reverse();
  const labels = chronological.map((c) =>
    `${shortSha(c.leansig_sha)}·${shortSha(c.leanmultisig_sha)}`);

  // For (combo, workload) → smallest proof_kib_root recorded by any
  // machine on that combo (smallest is a defensive choice; in practice
  // they should all match since proof size is deterministic per topology).
  const proofKib = (combo, workloadName) => {
    let best = null;
    for (const m of machines) {
      for (const r of m.runs || []) {
        if (r.git_shas?.leansig_sha !== combo.leansig_sha) continue;
        if (r.git_shas?.leanmultisig_sha !== combo.leanmultisig_sha) continue;
        const w = (r.workloads || []).find((x) => x.name === workloadName);
        if (w?.proof_kib_root != null && (best == null || w.proof_kib_root < best)) {
          best = w.proof_kib_root;
        }
      }
    }
    return best;
  };

  let added = 0;
  for (const [i, h] of TREND_PROOF_HEADLINES.entries()) {
    const data = chronological.map((c) => proofKib(c, h.name));
    if (!data.some((v) => v != null)) continue;
    added++;

    const card = el("div", { class: "compare-card" });
    card.appendChild(el("h3", { text: h.col }));
    const wrap = el("div", { class: "compare-card-chart" });
    const canvas = el("canvas");
    wrap.appendChild(canvas);
    card.appendChild(wrap);
    grid.appendChild(card);

    queueMicrotask(() => {
      const chart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: h.col,
            data,
            borderColor: colorFor(i),
            backgroundColor: colorFor(i) + "22",
            tension: 0.15,
            fill: false,
            pointRadius: 4,
            pointHoverRadius: 6,
            spanGaps: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => `combo ${labels[items[0].dataIndex]}`,
                label: (ctx) => `${ctx.parsed.y} KiB`,
              },
            },
          },
          scales: {
            x: { title: { display: true, text: "combo (oldest → newest)" } },
            y: { title: { display: true, text: "root proof (KiB)" }, beginAtZero: true },
          },
        },
      });
      trendProofCharts.push(chart);
    });
  }
  if (!added) {
    grid.innerHTML = "<p>No combos have recorded proof_kib_root yet.</p>";
  }
}

function renderTrendTable(machine, newestFirstCombos, best) {
  const wrap = document.querySelector("#trend-table-wrap");
  wrap.innerHTML = "";

  const fmtMs = (ms) => {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  };

  const table = el("table", { class: "trend-table" });
  const thead = el("thead");
  thead.appendChild(el("tr", {},
    el("th", { text: "combo" }),
    el("th", { text: "last tested" }),
    ...TREND_HEADLINES.map((h) => el("th", { text: h.col })),
  ));
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const c of newestFirstCombos) {
    const link = `index.html?leansig=${shortSha(c.leansig_sha)}&leanmultisig=${shortSha(c.leanmultisig_sha)}`;
    tbody.appendChild(el("tr", {},
      el("td", { class: "trend-name" },
        el("a", {
          href: link,
          title: `leansig ${c.leansig_sha}\nleanmultisig ${c.leanmultisig_sha}`,
        }, `${shortSha(c.leansig_sha)} · ${shortSha(c.leanmultisig_sha)}`)),
      el("td", { class: "trend-ts", text: fmtRelative(c.latest_run_ts) }),
      ...TREND_HEADLINES.map((h) => el("td", { text: fmtMs(best(c, h.name)) })),
    ));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}
