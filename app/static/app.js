"use strict";

/* 编织行指令审校前端：编辑 -> 防抖调用 /api/analyze -> 渲染逐行结果 */

const STORAGE_KEY = "knit-review-plan-v1";
const BASELINE_KEY = "knit-review-baseline-v1";
const DEBOUNCE_MS = 250;

const EXAMPLE = {
  name: "示例方案",
  start_stitches: 20,
  rows: [
    "[k2 inc1]*4 k8",
    "[k3 dec2]*4",
    "k16",
    "[k3 inc2]*4",
    "[k2]*~4 k4",
  ],
};

const els = {
  start: document.getElementById("start-stitches"),
  editor: document.getElementById("rows-editor"),
  add: document.getElementById("btn-add-row"),
  results: document.getElementById("results"),
  summary: document.getElementById("summary"),
  sync: document.getElementById("sync-state"),
  btnExample: document.getElementById("btn-example"),
  btnImport: document.getElementById("btn-import"),
  btnExport: document.getElementById("btn-export"),
  file: document.getElementById("file-import"),
  btnSaveBaseline: document.getElementById("btn-save-baseline"),
  btnClearBaseline: document.getElementById("btn-clear-baseline"),
  baselineInfo: document.getElementById("baseline-info"),
  comparePanel: document.getElementById("compare-panel"),
  compareSummary: document.getElementById("compare-summary"),
  compareBanner: document.getElementById("compare-banner"),
  compareTable: document.getElementById("compare-table"),
};

let state = load() || { start_stitches: 20, rows: [...EXAMPLE.rows] };
let debounceTimer = null;
let reqSeq = 0;

// 方案对照：基线快照（起始针数 + 行文本）存于浏览器 localStorage；
// 基线审校结果缓存于 baselineRows，基线内容变化时失效重取。
let baseline = loadBaseline();
let baselineRows = null;
let baselineFetchError = null;
let baselineFetchPromise = null;
let currentRows = null; // 最近一次当前方案的审校结果（请求失败时为 null）
let currentFetchError = null;

// ---------------------------------------------------------------- 初始化
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj.start_stitches !== "number" || !Array.isArray(obj.rows)) return null;
    return { start_stitches: obj.start_stitches, rows: obj.rows.map(String) };
  } catch {
    return null;
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------- 基线快照
function loadBaseline() {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj.start_stitches !== "number" || !Array.isArray(obj.rows)) return null;
    return {
      start_stitches: obj.start_stitches,
      rows: obj.rows.map(String),
      saved_at: typeof obj.saved_at === "string" ? obj.saved_at : null,
    };
  } catch {
    return null;
  }
}

function persistBaseline() {
  if (baseline) localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
  else localStorage.removeItem(BASELINE_KEY);
}

function updateBaselineBar() {
  els.btnClearBaseline.hidden = !baseline;
  els.btnSaveBaseline.textContent = baseline ? "☆ 更新基线" : "☆ 存为基线";
  if (!baseline) {
    els.baselineInfo.textContent = "尚未保存基线";
    return;
  }
  let when = "";
  if (baseline.saved_at) {
    const t = new Date(baseline.saved_at);
    if (!Number.isNaN(t.getTime())) when = ` · 存于 ${t.toLocaleString()}`;
  }
  els.baselineInfo.textContent =
    `基线：起始 ${baseline.start_stitches} 针 · ${baseline.rows.length} 行${when}（对照见下方）`;
}

// ---------------------------------------------------------------- 编辑器
function renderEditor(focusIndex = -1) {
  els.start.value = state.start_stitches;
  els.editor.innerHTML = "";
  state.rows.forEach((text, i) => {
    const wrap = document.createElement("div");
    wrap.className = "row-edit";

    const no = document.createElement("span");
    no.className = "row-no";
    no.textContent = `第 ${i + 1} 行`;

    const input = document.createElement("input");
    input.type = "text";
    input.value = text;
    input.placeholder = "如 k4 [k2 inc1]*3 dec2 或 [k2]*~6 k6";
    input.setAttribute("aria-label", `第 ${i + 1} 行指令`);
    input.addEventListener("input", () => {
      state.rows[i] = input.value;
      scheduleAnalyze();
    });

    const ops = document.createElement("div");
    ops.className = "row-ops";
    const up = miniBtn("↑", "上移", () => moveRow(i, -1));
    const down = miniBtn("↓", "下移", () => moveRow(i, 1));
    const del = miniBtn("删除", "删除本行", () => removeRow(i));
    del.classList.add("danger");
    ops.append(up, down, del);

    wrap.append(no, input, ops);
    els.editor.appendChild(wrap);
    if (i === focusIndex) input.focus();
  });
}

function miniBtn(text, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-mini";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function moveRow(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.rows.length) return;
  [state.rows[i], state.rows[j]] = [state.rows[j], state.rows[i]];
  renderEditor(j);
  persist();
  scheduleAnalyze();
}

function removeRow(i) {
  state.rows.splice(i, 1);
  renderEditor();
  persist();
  scheduleAnalyze();
}

els.start.addEventListener("input", () => {
  const v = Number(els.start.value);
  state.start_stitches = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  scheduleAnalyze();
});

els.add.addEventListener("click", () => {
  state.rows.push("");
  renderEditor(state.rows.length - 1);
  persist();
});

// ---------------------------------------------------------------- 分析
function scheduleAnalyze() {
  persist();
  clearTimeout(debounceTimer);
  els.sync.textContent = "计算中…";
  els.sync.className = "sync-state pending";
  debounceTimer = setTimeout(analyze, DEBOUNCE_MS);
}

async function analyze() {
  const seq = ++reqSeq;
  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_stitches: state.start_stitches, rows: state.rows }),
    });
    if (!resp.ok) throw new Error(`服务返回 ${resp.status}`);
    const data = await resp.json();
    if (seq === reqSeq) {
      currentRows = data.rows;
      currentFetchError = null;
      renderResults(data.rows);
      els.sync.textContent = "已同步";
      els.sync.className = "sync-state";
    }
  } catch (err) {
    if (seq === reqSeq) {
      currentRows = null;
      currentFetchError = err.message;
      els.sync.textContent = "分析失败：" + err.message;
      els.sync.className = "sync-state error";
    }
  }
  if (seq === reqSeq) await updateCompare(seq);
}

// ---------------------------------------------------------------- 结果渲染
const STATUS_TEXT = {
  ok: "通过",
  unconsumed: "未全部消耗",
  shortage: "针数短缺",
  error: "语法错误",
  blocked: "已阻断",
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderSource(row, locate) {
  const src = row.source;
  // 收集需要插入源文本的标记：短缺高亮（区间替换）、语法错误 ▲、
  // 自适应块后面的“实际重复 M 次”徽标（纯插入）、针数变化来源定位高亮。
  const marks = [];
  if (row.status === "shortage" && row.failing_start != null) {
    const [a, b] = [row.failing_start, row.failing_end];
    marks.push({
      start: a, end: b,
      html: `<span class="fail-hl" title="第一个无法执行的指令">${escapeHtml(src.slice(a, b))}</span>`,
    });
  }
  if (row.status === "error" && row.error_pos != null) {
    const p = Math.max(0, Math.min(row.error_pos, src.length));
    marks.push({ start: p, end: p, html: `<span class="caret" title="出错位置">▲</span>` });
  }
  (row.adaptive_blocks || []).forEach((b) => {
    marks.push({
      start: b.end, end: b.end,
      html: `<span class="adaptive-tag" title="自适应重复 *~${b.target_remaining}：`
        + `执行后为后续指令保留 ${b.target_remaining} 针，每轮消耗 ${b.per_pass_consumed} 针、`
        + `产出 ${b.per_pass_produced} 针">实际重复 ${b.actual_repeats} 次</span>`,
    });
  });
  if (locate && locate.start != null) {
    const [a, b] = [locate.start, locate.end];
    marks.push({
      start: a, end: b,
      html: `<span class="locate-hl" title="针数变化来源">${escapeHtml(src.slice(a, b))}</span>`,
    });
  }
  if (marks.length === 0) return escapeHtml(src);
  // 按起点排序后顺序重建；标记区间互不重叠（短缺叶子在另一节点内，
  // 自适应徽标挂在块末尾，▲ 在出错运算符处）。
  marks.sort((a, b) => a.start - b.start || a.end - b.end);
  let html = "";
  let cursor = 0;
  marks.forEach((m) => {
    if (m.start > cursor) html += escapeHtml(src.slice(cursor, m.start));
    html += m.html;
    cursor = Math.max(cursor, m.end);
  });
  if (cursor < src.length) html += escapeHtml(src.slice(cursor));
  return html;
}

function renderResults(rows) {
  els.results.innerHTML = "";
  renderSummary(rows);
  if (rows.length === 0) {
    const d = document.createElement("div");
    d.className = "empty-hint";
    d.textContent = "还没有任何行，点击“添加一行”或“载入示例”开始。";
    els.results.appendChild(d);
    return;
  }

  rows.forEach((row, i) => {
    if (i > 0) {
      const arrow = document.createElement("div");
      arrow.className = "flow-arrow";
      const prev = rows[i - 1];
      const carried = (prev.status === "ok" || prev.status === "unconsumed")
        ? prev.remaining : "—";
      arrow.innerHTML = `↓ 上一行产出 <b>${carried}</b> 针作为本行可用针数`;
      els.results.appendChild(arrow);
    }
    els.results.appendChild(renderCard(row, i));
  });
}

function renderSummary(rows) {
  const counts = { ok: 0, unconsumed: 0, shortage: 0, error: 0, blocked: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const last = rows[rows.length - 1];
  const finalStitches = last && (last.status === "ok" || last.status === "unconsumed")
    ? last.remaining : null;

  const badges = [];
  badges.push(`行数 <b>${rows.length}</b>`);
  badges.push(`起始 <b>${state.start_stitches}</b> 针`);
  badges.push(`✅ 通过 <b>${counts.ok}</b>`);
  if (counts.unconsumed) badges.push(`⚠️ 未耗尽 <b>${counts.unconsumed}</b>`);
  if (counts.shortage) badges.push(`❌ 短缺 <b>${counts.shortage}</b>`);
  if (counts.error) badges.push(`❌ 语法错误 <b>${counts.error}</b>`);
  if (counts.blocked) badges.push(`🚫 阻断 <b>${counts.blocked}</b>`);
  badges.push(`最终针数 <b>${finalStitches == null ? "—" : finalStitches}</b>`);

  els.summary.innerHTML = badges.map((b) => `<span class="badge">${b}</span>`).join("");
}

function fmtNet(n) {
  return (n > 0 ? "+" : "") + n;
}

// 针数变化来源清单：仅 ok / unconsumed 行生成（stitch_net 不为 null）。
// 点击条目在源文本中高亮对应指令区间，再次点击取消。
function renderStitchChanges(row, sourceEl) {
  const det = document.createElement("details");
  det.className = "stitch-changes";
  det.open = true;

  const expected = row.produced - row.consumed;
  const match = row.stitch_net === expected;
  const sum = document.createElement("summary");
  sum.innerHTML =
    `针数变化来源 · 净变化合计 <b class="${row.stitch_net >= 0 ? "net-pos" : "net-neg"}">`
    + `${fmtNet(row.stitch_net)}</b> `
    + (match
      ? `<span class="sc-check ok-check">✓ 与 产出 ${row.produced} − 消耗 ${row.consumed} 相符</span>`
      : `<span class="sc-check bad-check">✗ 产出 − 消耗 为 ${fmtNet(expected)}，不一致</span>`);
  det.appendChild(sum);

  const entries = row.stitch_changes || [];
  if (entries.length === 0) {
    const note = document.createElement("div");
    note.className = "sc-empty";
    note.textContent = "本行没有加针 / 减针指令，针数无净变化。";
    det.appendChild(note);
    return det;
  }

  const table = document.createElement("table");
  table.className = "sc-table";
  table.innerHTML =
    "<thead><tr><th>指令</th><th>执行次数</th><th>消耗针数</th><th>产出针数</th><th>净变化</th></tr></thead>";
  const tbody = document.createElement("tbody");

  let activeTr = null;
  entries.forEach((e) => {
    const tr = document.createElement("tr");
    tr.className = "sc-entry";
    tr.title = `源文本第 ${e.start + 1}–${e.end} 列，点击定位原文`;
    tr.innerHTML =
      `<td><code class="sc-inst">${escapeHtml(e.instruction)}</code></td>` +
      `<td>${e.executions}</td>` +
      `<td>${e.consumed}</td>` +
      `<td>${e.produced}</td>` +
      `<td class="${e.net >= 0 ? "net-pos" : "net-neg"}">${fmtNet(e.net)}</td>`;
    tr.addEventListener("click", () => {
      if (activeTr === tr) {
        activeTr = null;
        tr.classList.remove("active");
        sourceEl.innerHTML = renderSource(row);
        return;
      }
      if (activeTr) activeTr.classList.remove("active");
      activeTr = tr;
      tr.classList.add("active");
      sourceEl.innerHTML = renderSource(row, { start: e.start, end: e.end });
      sourceEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const sumExec = entries.reduce((a, e) => a + e.executions, 0);
  const sumCon = entries.reduce((a, e) => a + e.consumed, 0);
  const sumPro = entries.reduce((a, e) => a + e.produced, 0);
  tfoot.innerHTML =
    `<tr><td>合计</td><td>${sumExec}</td><td>${sumCon}</td><td>${sumPro}</td>`
    + `<td class="${row.stitch_net >= 0 ? "net-pos" : "net-neg"}">${fmtNet(row.stitch_net)}</td></tr>`;
  table.appendChild(tfoot);

  det.appendChild(table);
  return det;
}

function renderCard(row, i) {
  const card = document.createElement("div");
  card.className = `row-card ${row.status}`;

  const head = document.createElement("div");
  head.className = "row-card-head";
  head.innerHTML =
    `<span class="idx">第 ${i + 1} 行</span>` +
    `<span class="status-tag">${STATUS_TEXT[row.status] || row.status}</span>`;
  card.appendChild(head);

  const source = document.createElement("div");
  source.className = "row-source";
  source.innerHTML = renderSource(row) || "<span style='opacity:.5'>（空行）</span>";
  card.appendChild(source);

  if (row.status !== "blocked") {
    const m = document.createElement("div");
    m.className = "metrics";
    const parts = ["<span>可用 <b>" + row.available + "</b></span>"];
    if (row.status === "shortage") {
      parts.push(`<span class="metric-consumed">已消耗 <b>${row.consumed}</b></span>`);
      parts.push(`<span class="metric-short">短缺 <b>${row.shortage}</b></span>`);
    } else if (row.status !== "error") {
      parts.push(`<span class="metric-consumed">消耗 <b>${row.consumed}</b></span>`);
      parts.push(`<span class="metric-produced">产出 <b>${row.produced}</b></span>`);
      parts.push(`<span class="metric-remaining">剩余 <b>${row.remaining}</b></span>`);
      if (row.unconsumed) {
        parts.push(`<span class="metric-unused">未消耗 <b>${row.unconsumed}</b></span>`);
      }
    }
    m.innerHTML = parts.join("");
    card.appendChild(m);
  }

  if (row.stitch_net != null) {
    card.appendChild(renderStitchChanges(row, source));
  }

  if (row.error) {
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = row.error;
    card.appendChild(msg);
  }

  if (row.expanded_count > 0) {
    const det = document.createElement("details");
    det.className = "expanded";
    det.innerHTML = `<summary>展开指令（共 ${row.expanded_count} 条）</summary>`;
    const list = document.createElement("div");
    list.className = "token-list";
    list.innerHTML = row.expanded_preview
      .map((t) => `<span class="tok">${escapeHtml(t)}</span>`).join("");
    det.appendChild(list);
    if (row.expanded_truncated) {
      const note = document.createElement("div");
      note.className = "trunc-note";
      note.textContent = `仅预览前 ${row.expanded_preview.length} 条，共 ${row.expanded_count} 条。`;
      det.appendChild(note);
    }
    card.appendChild(det);
  }

  return card;
}

// ---------------------------------------------------------------- 方案对照
// 基线与当前两版分别调用 /api/analyze 独立审校；对齐只依据原始行文本，
// 因此一侧出现语法错误 / 阻断时，另一侧后续行的结果仍正常展示。
const DIFF_TYPE_TEXT = { same: "相同", modified: "修改", added: "新增", deleted: "删除" };

function alignRows(a, b) {
  /* 稳定的最长公共子序列（LCS）对齐，按原始行文本精确比较。
     - 文本相等即配对：重复文本取最靠前的可行配对（两侧同时最早）；
     - 文本不同且 LCS 长度平局时优先跳过基线行；
     - 相邻配对之间的未配对区段，两侧按顺序成对标记「修改」，
       多出的行分别标记「删除」（仅基线有）或「新增」（仅当前有）。
     返回条目列表：{ type: same|modified|added|deleted, a: 基线下标|null, b: 当前下标|null }。*/
  const n = a.length, m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const entries = [];
  const flush = (ai, bi, aj, bj) => {
    // 未配对区段 a[ai..bi) ↔ b[aj..bj)：按顺序成对为「修改」，剩余为「删除/新增」
    const la = bi - ai, lb = bj - aj;
    const pairs = Math.min(la, lb);
    for (let k = 0; k < pairs; k++) entries.push({ type: "modified", a: ai + k, b: aj + k });
    for (let k = pairs; k < la; k++) entries.push({ type: "deleted", a: ai + k, b: null });
    for (let k = pairs; k < lb; k++) entries.push({ type: "added", a: null, b: aj + k });
  };
  let i = 0, j = 0, segA = 0, segB = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush(segA, i, segB, j);
      entries.push({ type: "same", a: i, b: j });
      i++; j++;
      segA = i; segB = j;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  flush(segA, n, segB, m);
  return entries;
}

function endStitchesOf(row) {
  // 行末针数：仅通过 / 未全部消耗的行有确定产出；错误 / 短缺 / 阻断行为 null（显示 —）
  return row && (row.status === "ok" || row.status === "unconsumed") ? row.remaining : null;
}

function fmtEndStitches(row) {
  const v = endStitchesOf(row);
  return v === null ? "—" : String(v);
}

function findFirstDivergence(entries, baseRows, currRows) {
  // 首个双方都有行且状态或行末针数不同的对照条目下标；
  // 缺席行（新增 / 删除）不参与该判定。无分歧返回 -1。
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (e.a === null || e.b === null) continue;
    const ra = baseRows[e.a];
    const rb = currRows[e.b];
    if (!ra || !rb) continue;
    if (ra.status !== rb.status || endStitchesOf(ra) !== endStitchesOf(rb)) return k;
  }
  return -1;
}

function ensureBaselineAnalysis() {
  // 基线内容不变时复用缓存；请求失败记录错误，下个分析周期自动重试。
  if (baselineRows !== null) return Promise.resolve();
  if (baselineFetchPromise) return baselineFetchPromise;
  baselineFetchPromise = (async () => {
    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_stitches: baseline.start_stitches, rows: baseline.rows }),
      });
      if (!resp.ok) throw new Error(`服务返回 ${resp.status}`);
      const data = await resp.json();
      baselineRows = data.rows;
      baselineFetchError = null;
    } catch (err) {
      baselineFetchError = err.message;
    } finally {
      baselineFetchPromise = null;
    }
  })();
  return baselineFetchPromise;
}

async function updateCompare(seq) {
  if (!baseline) { renderCompare(); return; }
  renderCompare(); // 先渲染（基线结果未就绪时显示“计算中”）
  await ensureBaselineAnalysis();
  if (seq === reqSeq) renderCompare();
}

function compareSideCells(present, no, text, row, statusDiff, endDiff) {
  if (!present) {
    return `<td class="cmp-empty">—</td><td class="cmp-empty">（缺席）</td>`
      + `<td class="cmp-empty">—</td><td class="cmp-empty">—</td>`;
  }
  const statusHtml = row
    ? `<span class="cmp-status st-${row.status}">${STATUS_TEXT[row.status] || row.status}</span>`
    : `<span class="cmp-empty">—</span>`;
  const endHtml = row ? fmtEndStitches(row) : "—";
  return `<td class="cmp-no">第 ${no} 行</td>`
    + `<td class="cmp-text">${escapeHtml(text) || "<span class='cmp-empty'>（空行）</span>"}</td>`
    + `<td class="${statusDiff ? "cmp-diff-cell" : ""}">${statusHtml}</td>`
    + `<td class="cmp-num ${endDiff ? "cmp-diff-cell" : ""}">${endHtml}</td>`;
}

function renderCompare() {
  if (!baseline) {
    els.comparePanel.hidden = true;
    return;
  }
  els.comparePanel.hidden = false;

  const entries = alignRows(baseline.rows, state.rows);
  const counts = { same: 0, modified: 0, added: 0, deleted: 0 };
  entries.forEach((e) => { counts[e.type] += 1; });

  const ready = baselineRows !== null && currentRows !== null;
  const firstDiv = ready ? findFirstDivergence(entries, baselineRows, currentRows) : -1;

  // 汇总徽标
  const badges = [];
  badges.push(`基线 · 起始 <b>${baseline.start_stitches}</b> 针 · <b>${baseline.rows.length}</b> 行`);
  badges.push(`当前 · 起始 <b>${state.start_stitches}</b> 针 · <b>${state.rows.length}</b> 行`);
  if (baseline.start_stitches !== state.start_stitches) {
    badges.push(`<span class="cmp-badge-warn">⚠️ 起始针数不同</span>`);
  }
  badges.push(`相同 <b>${counts.same}</b>`);
  badges.push(`修改 <b>${counts.modified}</b>`);
  badges.push(`新增 <b>${counts.added}</b>`);
  badges.push(`删除 <b>${counts.deleted}</b>`);
  els.compareSummary.innerHTML = badges.map((b) => `<span class="badge">${b}</span>`).join("");

  // 横幅：首个分歧 / 一致 / 异常
  let bannerClass = "same";
  let bannerText;
  if (baselineFetchError) {
    bannerClass = "err";
    bannerText = `基线分析失败：${baselineFetchError}（当前方案的逐行审校结果不受影响，见上方）`;
  } else if (currentFetchError) {
    bannerClass = "err";
    bannerText = `当前方案分析失败：${currentFetchError}（基线结果仍展示在下表）`;
  } else if (!ready) {
    bannerClass = "warn";
    bannerText = "审校计算中…";
  } else if (firstDiv >= 0) {
    const e = entries[firstDiv];
    const ra = baselineRows[e.a];
    const rb = currentRows[e.b];
    bannerClass = "div";
    bannerText = `⚑ 首个分歧：基线第 ${e.a + 1} 行 ↔ 当前第 ${e.b + 1} 行 —— `
      + `状态 ${STATUS_TEXT[ra.status] || ra.status} → ${STATUS_TEXT[rb.status] || rb.status}，`
      + `行末针数 ${fmtEndStitches(ra)} → ${fmtEndStitches(rb)}`;
  } else {
    bannerText = "两版在双方都有行的位置上，状态与行末针数一致。";
  }
  els.compareBanner.className = `compare-banner ${bannerClass}`;
  els.compareBanner.textContent = bannerText;

  // 对照表：双方行号、文本、状态、行末针数
  const table = els.compareTable;
  table.innerHTML = "";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr>"
    + "<th>基线行</th><th>基线文本</th><th>状态</th><th>行末针数</th>"
    + "<th>对照</th>"
    + "<th>当前行</th><th>当前文本</th><th>状态</th><th>行末针数</th>"
    + "</tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  if (entries.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="9" class="cmp-empty">两版都没有行。</td>`;
    tbody.appendChild(tr);
  }

  entries.forEach((e, k) => {
    const tr = document.createElement("tr");
    tr.className = `cmp-${e.type}`;
    if (k === firstDiv) tr.classList.add("cmp-first-div");

    const ra = e.a !== null && baselineRows ? baselineRows[e.a] : null;
    const rb = e.b !== null && currentRows ? currentRows[e.b] : null;
    const statusDiff = ready && ra && rb && ra.status !== rb.status;
    const endDiff = ready && ra && rb && endStitchesOf(ra) !== endStitchesOf(rb);

    tr.innerHTML =
      compareSideCells(e.a !== null, e.a !== null ? e.a + 1 : null,
        e.a !== null ? baseline.rows[e.a] : null, ra, statusDiff, endDiff)
      + `<td><span class="cmp-type ${e.type}">${DIFF_TYPE_TEXT[e.type]}`
      + `${k === firstDiv ? " ⚑" : ""}</span></td>`
      + compareSideCells(e.b !== null, e.b !== null ? e.b + 1 : null,
        e.b !== null ? state.rows[e.b] : null, rb, statusDiff, endDiff);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

els.btnSaveBaseline.addEventListener("click", () => {
  baseline = {
    start_stitches: state.start_stitches,
    rows: [...state.rows],
    saved_at: new Date().toISOString(),
  };
  persistBaseline();
  baselineRows = null;
  baselineFetchError = null;
  updateBaselineBar();
  scheduleAnalyze();
});

els.btnClearBaseline.addEventListener("click", () => {
  baseline = null;
  persistBaseline();
  baselineRows = null;
  baselineFetchError = null;
  updateBaselineBar();
  renderCompare();
});

// ---------------------------------------------------------------- 导入导出
els.btnExample.addEventListener("click", () => {
  state = { start_stitches: EXAMPLE.start_stitches, rows: [...EXAMPLE.rows] };
  renderEditor();
  persist();
  scheduleAnalyze();
});

els.btnExport.addEventListener("click", () => {
  const plan = {
    format: "knit-row-review/v1",
    name: "编织方案",
    start_stitches: state.start_stitches,
    rows: state.rows,
    exported_at: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `knit-plan-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

els.btnImport.addEventListener("click", () => els.file.click());

els.file.addEventListener("change", () => {
  const file = els.file.files && els.file.files[0];
  els.file.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(String(reader.result));
      if (typeof obj.start_stitches !== "number" || !Number.isInteger(obj.start_stitches)
          || obj.start_stitches < 0 || !Array.isArray(obj.rows)
          || !obj.rows.every((r) => typeof r === "string")) {
        throw new Error("缺少 start_stitches（非负整数）或 rows（字符串数组）");
      }
      state = { start_stitches: obj.start_stitches, rows: obj.rows };
      renderEditor();
      persist();
      scheduleAnalyze();
    } catch (err) {
      alert("导入失败：" + err.message);
    }
  };
  reader.readAsText(file);
});

// ---------------------------------------------------------------- 启动
renderEditor();
updateBaselineBar();
scheduleAnalyze();
