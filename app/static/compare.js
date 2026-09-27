"use strict";

/* 方案对照纯逻辑：按原始行文本做稳定的最长公共子序列（LCS）对齐，
 * 并定位首个双方都有行且状态或行末针数不同的位置。
 * 本文件不依赖 DOM，既被前端页面引用，也可在 Node 中直接 require 做单元测试。
 *
 * 对齐规则：
 * - 以基线行文本与当前行文本的精确相等作为可配对条件，求 LCS；
 * - 回溯时两侧行文本相等即立即配对 —— 重复文本因此总是取最靠前的可行配对；
 * - 未配对区段（相邻两对匹配行之间的间隙）内，基线侧删除行与当前侧新增行
 *   按顺序成对标记为「修改」，剩余的分别标记为「删除」/「新增」。
 */

/**
 * 对齐两版行文本。
 * @param {string[]} baseRows 基线行文本
 * @param {string[]} curRows 当前行文本
 * @returns {Array<{type: "unchanged"|"modified"|"added"|"deleted",
 *                  baseIdx: number|null, curIdx: number|null}>}
 *   对照条目序列；baseIdx / curIdx 为对应侧的行号（0 基），缺席侧为 null。
 */
function alignRows(baseRows, curRows) {
  const m = baseRows.length;
  const n = curRows.length;

  // dp[i][j] = baseRows[i:] 与 curRows[j:] 的 LCS 长度
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = baseRows[i] === curRows[j]
        ? dp[i + 1][j] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯：文本相等即配对（最靠前的可行配对）；否则朝 LCS 更长的方向走，
  // 两个方向等长时优先跳过基线行（保持配对尽量靠前）。
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (baseRows[i] === curRows[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // 由配对序列生成对照条目：逐段处理间隙，间隙内两侧未配对行按顺序成对。
  const items = [];
  let bi = 0;
  let ci = 0;
  const emitGap = (bTo, cTo) => {
    const dels = [];
    for (let b = bi; b < bTo; b++) dels.push(b);
    const adds = [];
    for (let c = ci; c < cTo; c++) adds.push(c);
    const paired = Math.min(dels.length, adds.length);
    for (let t = 0; t < paired; t++) {
      items.push({ type: "modified", baseIdx: dels[t], curIdx: adds[t] });
    }
    for (let t = paired; t < dels.length; t++) {
      items.push({ type: "deleted", baseIdx: dels[t], curIdx: null });
    }
    for (let t = paired; t < adds.length; t++) {
      items.push({ type: "added", baseIdx: null, curIdx: adds[t] });
    }
  };
  for (const [pb, pc] of pairs) {
    emitGap(pb, pc);
    items.push({ type: "unchanged", baseIdx: pb, curIdx: pc });
    bi = pb + 1;
    ci = pc + 1;
  }
  emitGap(m, n);
  return items;
}

/**
 * 行末针数：仅「通过 / 未全部消耗」的行有确定产出（remaining），
 * 短缺 / 语法错误 / 已阻断的行没有行末针数，返回 null。
 */
function rowEndStitches(row) {
  if (!row) return null;
  return (row.status === "ok" || row.status === "unconsumed") ? row.remaining : null;
}

/**
 * 首个双方都有行且状态或行末针数不同的对照条目下标（0 基）；没有则返回 -1。
 * 缺席行（added / deleted，一侧没有对应行）不参与该判定；
 * 任一侧分析结果缺失时无法判定，返回 -1。
 */
function findFirstDivergence(items, baseResults, curResults) {
  if (!Array.isArray(baseResults) || !Array.isArray(curResults)) return -1;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.type !== "unchanged" && it.type !== "modified") continue;
    const b = baseResults[it.baseIdx];
    const c = curResults[it.curIdx];
    if (!b || !c) continue;
    if (b.status !== c.status) return k;
    if (rowEndStitches(b) !== rowEndStitches(c)) return k;
  }
  return -1;
}

// Node 环境下导出，便于单元测试；浏览器中作为全局函数使用。
if (typeof module !== "undefined" && module.exports) {
  module.exports = { alignRows, rowEndStitches, findFirstDivergence };
}
