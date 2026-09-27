"use strict";

/* 方案对照纯逻辑（app/static/compare.js）的 Node 单元测试。
 * 运行：node tests/test_compare.js
 */

const assert = require("node:assert/strict");
const { alignRows, rowEndStitches, findFirstDivergence } = require("../app/static/compare.js");

// 简化断言辅助：把对照条目压缩为易读形式
const sig = (items) => items.map((it) => `${it.type[0].toUpperCase()}${it.baseIdx ?? "-"}>${it.curIdx ?? "-"}`);

// ---------------------------------------------------------------- LCS 对齐
// 完全一致
assert.deepEqual(
  sig(alignRows(["k2", "k3"], ["k2", "k3"])),
  ["U0>0", "U1>1"],
);

// 重复文本取最靠前的可行配对：基线侧重复，应删第二份
assert.deepEqual(
  sig(alignRows(["A", "A", "B"], ["A", "B"])),
  ["U0>0", "D1>-", "U2>1"],
);

// 重复文本取最靠前的可行配对：当前侧重复，应新增第二份
assert.deepEqual(
  sig(alignRows(["A", "B"], ["A", "A", "B"])),
  ["U0>0", "A->1", "U1>2"],
);

// 未配对区段两侧等长：按顺序成对标记修改
assert.deepEqual(
  sig(alignRows(["A", "X", "Y", "B"], ["A", "P", "Q", "B"])),
  ["U0>0", "M1>1", "M2>2", "U3>3"],
);

// 未配对区段当前侧更长：成对修改后，剩余标记新增
assert.deepEqual(
  sig(alignRows(["A", "X", "B"], ["A", "P", "Q", "B"])),
  ["U0>0", "M1>1", "A->2", "U2>3"],
);

// 未配对区段基线侧更长：成对修改后，剩余标记删除
assert.deepEqual(
  sig(alignRows(["A", "X", "Y", "B"], ["A", "P", "B"])),
  ["U0>0", "M1>1", "D2>-", "U3>2"],
);

// 行移动：X 从开头移到中间。平局时优先跳过基线行，LCS 取 A,Y（长度 2 最优），
// 结果确定且稳定：X 记为删除 + 新增。
assert.deepEqual(
  sig(alignRows(["X", "A", "Y"], ["A", "X", "Y"])),
  ["D0>-", "U1>0", "A->1", "U2>2"],
);

// 空侧
assert.deepEqual(sig(alignRows([], ["k1", "k2"])), ["A->0", "A->1"]);
assert.deepEqual(sig(alignRows(["k1"], [])), ["D0>-"]);
assert.deepEqual(sig(alignRows([], [])), []);

// 完全无公共行：全部成对修改 / 剩余增删
assert.deepEqual(
  sig(alignRows(["a", "b"], ["c", "d", "e"])),
  ["M0>0", "M1>1", "A->2"],
);

// ---------------------------------------------------------------- 行末针数
assert.equal(rowEndStitches({ status: "ok", remaining: 16 }), 16);
assert.equal(rowEndStitches({ status: "unconsumed", remaining: 20 }), 20);
assert.equal(rowEndStitches({ status: "shortage", remaining: 0 }), null);
assert.equal(rowEndStitches({ status: "error", remaining: 0 }), null);
assert.equal(rowEndStitches({ status: "blocked", remaining: 0 }), null);
assert.equal(rowEndStitches(null), null);

// ---------------------------------------------------------------- 首个分歧
const ok = (remaining) => ({ status: "ok", remaining });

// 状态不同 -> 首个分歧
{
  const items = alignRows(["k1", "k2"], ["k1", "k2"]);
  const idx = findFirstDivergence(items, [ok(1), ok(2)], [ok(1), { status: "shortage", remaining: 0 }]);
  assert.equal(idx, 1);
}

// 行末针数不同 -> 首个分歧
{
  const items = alignRows(["k1", "k2"], ["k1", "k2"]);
  const idx = findFirstDivergence(items, [ok(1), ok(2)], [ok(1), ok(5)]);
  assert.equal(idx, 1);
}

// 完全一致 -> 无分歧
{
  const items = alignRows(["k1", "k2"], ["k1", "k2"]);
  assert.equal(findFirstDivergence(items, [ok(1), ok(2)], [ok(1), ok(2)]), -1);
}

// 缺席行不参与判定：新增/删除行即使“状态不同”也不触发；
// 首个分歧落在其后第一个共有且不同的行对上
{
  const items = alignRows(["k1", "k2", "k3"], ["k1", "kX", "k2", "k3"]);
  // 条目：U(k1) A(kX) U(k2) U(k3)
  const idx = findFirstDivergence(
    items,
    [ok(1), ok(2), ok(3)],
    [ok(1), ok(9), ok(2), ok(4)], // 新增行 kX 不参与；k3 行末针数 3 vs 4
  );
  assert.equal(idx, 3);
}

// 修改行对（双方都有行）参与判定
{
  const items = alignRows(["k1", "k2"], ["k1", "k9"]);
  // 条目：U(k1) M(k2 -> k9)
  const idx = findFirstDivergence(items, [ok(1), ok(2)], [ok(1), ok(9)]);
  assert.equal(idx, 1);
}

// 两侧同为阻断（无行末针数）且状态相同 -> 不算分歧
{
  const items = alignRows(["k1"], ["k1"]);
  const blocked = { status: "blocked", remaining: 0 };
  assert.equal(findFirstDivergence(items, [blocked], [blocked]), -1);
}

// 一侧分析结果缺失 -> 无法判定
{
  const items = alignRows(["k1"], ["k1"]);
  assert.equal(findFirstDivergence(items, null, [ok(1)]), -1);
  assert.equal(findFirstDivergence(items, [ok(1)], null), -1);
}

console.log("compare.js 全部用例通过");
