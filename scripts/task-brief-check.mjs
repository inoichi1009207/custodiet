#!/usr/bin/env node
// task-brief-check.mjs —— 委派单/裁决单的**结构槽位**检查(纯机械,不看内容)
//
// 立此件的理由(2026-08-20,用户逼出来的两问):
//   「我担心的是再出现二选一的选择题这样的形式,但是一直搞下去会无限递归」
//   「技术单呈给 codex/grill 之前能不能先来个 subagent 先看看?」
//
// **为什么是脚本不是 subagent** —— 递归的终止条件是「检查者比被检查者笨一个量级」:
//   · 用 subagent 检查我的任务单 ⇒ **会递归**。同一个模型、同样的框架偏置;
//     本仓 memory `same-model-review-is-not-cross-validation` 已登记这条。
//   · 用 codex(跨模型)⇒ 不递归,但**治不了这个**:它拿到的是我**已化简过**的问题。
//     2026-08-20 实撞:我给它「按批 / 按 commit / 第三种」,它忠实地在二选一里选「按批」;
//     正确答案(分类讨论:按批 + 按改动量重新武装)是**用户**想到的,
//     因为他手上是原始需求、没被我的框架污染。
//   · 用**一个数格子的脚本** ⇒ 不递归。它没有「框架」,所以不会框架错。
//
// 它查什么(四条,全部是「格子在不在」,不判内容对不对):
//   1. 有没有写**两类错误的代价不对称**(全局规范五明文要求,当日我没写)
//   2. 有没有写**拿不准时的默认动作**
//   3. 有没有「**我问错了吗 / 这是不是「选一个」的问题**」那一栏
//   4. 若出现强制二选一,有没有一个**明写的逃生口**(「第三种/第四种,写明」)
//
// ⚠️ CEILING —— 它**治不了**的那一半必须说清楚:
//   「你的选项集不完整」这种判断需要领域知识,而那恰恰是我化简时**已经用过**的那份知识,
//   所以我自己查不出来,任何同模型的检查者也查不出来。
//   本件只堵**机械遗漏**:没有逃生口、没写代价不对称、没留「我问错了吗」。
//   当日翻的正是这种机械遗漏——给 codex 那份写了「第三种(写明)」但埋在两栏表底下,
//   给用户那份**一个逃生口都没有**。选项集完整性只能靠把选项摊给用户 + 明写
//   「这可能不是选一个的问题」。CALIBRATED=false。
//
// 用法:
//   node --no-warnings scripts/task-brief-check.mjs <任务单文件>
//   node --no-warnings scripts/task-brief-check.mjs --text "<直接给正文>"
//   node --no-warnings scripts/task-brief-check.mjs --self-test
// 退出码: 0=四格齐  1=本件出错  2=有缺格  3=用法错
//
// 工具面已扫(2026-08-20,三层):① docs/tool-register.md 无「任务单/委派单检查」类(0 命中);
//   ② 五个已启用插件无此能力;③ 本项目 7 个命令 + 39 个脚本里最近的是 `codex-run.mjs`
//   (委派运行器,不检查单子)与 `report-gate.mjs`(检查报告,不检查委派单);
//   ④ `nlpm:vague-scanner` 形状最像(对自然语言做确定性文本检查)但清单不同(它数模糊量词)。

import fs from "node:fs";

/** 四条槽位。每条:名字 / 判据 / 缺了会怎样。 */
export const SLOTS = [
  {
    name: "代价不对称",
    test: (t) => /代价不对称|误拦.{0,12}漏放|漏放.{0,12}误拦|拿不准就.{0,8},因为/.test(t),
    why: "全局规范五:「只写『要准确』没用;写『拿不准就删,因为删错代价是 X 而留错代价是 Y』才有用」",
  },
  {
    name: "拿不准时的默认动作",
    test: (t) => /拿不准.{0,20}(就|则|一律|默认)|默认动作|fail-?closed|宁可(误拦|漏|多)/.test(t),
    why: "受托方撞到边界时会停下等裁,而委派方常常不在场",
  },
  {
    name: "「我问错了吗」一栏",
    test: (t) => /我问错了吗|问题的正确形态|是不是[「『]?选一个|选项集(是否)?完整|这个问题问对了吗/.test(t),
    why: "「你没问到的重要事实」管内容,不管**问题的形状**。2026-08-20 实撞:codex 忠实回答了我问错的那道选择题",
  },
  {
    name: "强制二选一时的逃生口",
    // 只在**检出强制二选一**时才要求;不是二选一的单子这条不适用。
    test: (t) => {
      const forced = /二选一|必须(二)?选(一|其一)|甲方说|乙方说|A 还是 B|不要(写|给)「?各有(利弊|道理)/.test(t);
      if (!forced) return "n/a";
      return /第三种|第四种|以上都不|写明另一种|若两个都错|正确的第三种/.test(t);
    },
    why: "强制二选一提高判别力,但**默认了选项集已完整**;选项集错了,判别力越强错得越干脆",
  },
];

export function checkBrief(text) {
  const t = String(text);
  return SLOTS.map((s) => ({ name: s.name, why: s.why, result: s.test(t) }));
}

function selfTest() {
  const t = [];
  const chk = (n, got, want) => { const ok = got === want; t.push([ok, n, `实得 ${got}`]); };

  // 一份**四格齐**的单子
  const good = `
    请裁决:按批 / 按 commit / **第三种(写明)**。
    两类错误的代价不对称:误拦=多跑一轮;漏放=无据断言进报告且此后无人再查。
    拿不准就按 fail-closed 处理,默认动作=当阻断。
    另出一节:**我问错了吗?这个问题的正确形态是不是「选一个」?**
    必须二选一,不要写「各有利弊」。`;
  const r1 = checkBrief(good);
  chk("四格齐的单子全过", r1.every((x) => x.result === true || x.result === "n/a"), true);

  // 缺「我问错了吗」
  const missing = `
    请裁决:按批 / 按 commit。必须二选一,不要写「各有道理」。
    代价不对称:误拦=多跑一轮;漏放=闸失效。拿不准就按 fail-closed。`;
  const r2 = checkBrief(missing);
  chk("缺「我问错了吗」被逮住", r2.find((x) => x.name === "「我问错了吗」一栏").result, false);
  // ⚠️ 反向:同一份单子里**其他格**不许跟着变红,否则这条用例证不了它逮的是哪一格
  chk("同单里代价不对称仍判过(防「一律报缺」)",
    r2.find((x) => x.name === "代价不对称").result, true);
  // 它是强制二选一且**没有逃生口** ⇒ 第四格应当红
  chk("强制二选一但无逃生口 ⇒ 逮住", r2.find((x) => x.name === "强制二选一时的逃生口").result, false);

  // 不是二选一的单子:第四格应当 n/a 而不是红
  const open = `请调查这个现象的成因。代价不对称:误报=多查一轮;漏报=真因永远查不到。
    拿不准就写「查不到」,不要拿记忆顶替。另出一节:我问错了吗?`;
  chk("非二选一的单子:逃生口那格判 n/a",
    checkBrief(open).find((x) => x.name === "强制二选一时的逃生口").result, "n/a");

  let pass = 0;
  for (const [ok, n, extra] of t) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  ← " + extra}`); if (ok) pass++; }
  console.log(`\n委派单自测 ${pass}/${t.length}`);
  return pass === t.length;
}

const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

  const ti = argv.indexOf("--text");
  let text = null;
  if (ti >= 0) text = argv[ti + 1];
  else if (argv[0]) { try { text = fs.readFileSync(argv[0], "utf8"); } catch (e) { console.error("读不到:" + e.message); process.exit(1); } }
  if (!text) { console.error('用法: <任务单文件> | --text "<正文>" | --self-test'); process.exit(3); }

  const rows = checkBrief(text);
  let missing = 0;
  for (const r of rows) {
    if (r.result === "n/a") { console.log(`  n/a   ${r.name}(本单不是强制二选一)`); continue; }
    if (r.result) { console.log(`  齐    ${r.name}`); continue; }
    console.log(`  **缺** ${r.name}\n         ${r.why}`);
    missing++;
  }
  console.log(`\n${missing ? `缺 ${missing} 格 —— 发出去之前补上` : "四格齐"}` +
    `(⚠️ 只查格子在不在,**判不出选项集是否完整**——那要靠把选项摊给用户)`);
  process.exit(missing ? 2 : 0);
}
