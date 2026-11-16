#!/usr/bin/env node
// report-gate.mjs —— 完成性断言闸
//
// 干什么:读一份批报告,找出「本批未覆盖」栏。若该栏非空,则
//   ① 拒绝报告首节里的裸完成性断言(「做完了」「全部完成」…);
//   ② **主动吐出**唯一合法的首行(带 已落账/总数 比值),供会话照抄进收尾消息。
//
// 为什么要「吐出」而不只是「拒绝」:2026-08-12 实撞——9/29 落账时首节标题写了
// 「做完了」,而同一份报告正文的未覆盖栏明写 20 条。禁令拦不住,因为犯错的地方
// 是会话消息不是文件;供给能拦住,因为会话会照抄现成的那一行。
//
// 用法:
//   node --no-warnings scripts/report-gate.mjs <报告路径> [--landed N --total M]
//   node --no-warnings scripts/report-gate.mjs --self-test
//
// 退出码: 0=通过  2=拒交(首节有裸完成断言 / 未覆盖栏非空但拿不出比值)  3=用法错

import fs from "node:fs";

const DONE_WORDS = [
  "做完了", "全部做完", "全部完成", "已全部落账", "全部落账", "悉数完成",
  "收尾完毕", "任务完成", "已完成全部", "都做完",
];

// 「未覆盖」栏的识别:标题里含这几个词之一
const UNCOVERED_HEAD = /^#{2,4}\s*.*(未覆盖|未做|停条|未落账)/;

export function parseReport(text) {
  const lines = text.split(/\r?\n/);

  // 首节 = 第一个 ## 之前的全部内容(含 H1 与首节表格)
  let firstSectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2}\s/.test(lines[i]) && i > 0) { firstSectionEnd = i; break; }
  }
  const head = lines.slice(0, firstSectionEnd).join("\n");

  // 未覆盖栏:从命中标题起到下一个同级或更高级标题止
  let uncovered = null;
  for (let i = 0; i < lines.length; i++) {
    if (!UNCOVERED_HEAD.test(lines[i])) continue;
    const level = (lines[i].match(/^#+/) || ["##"])[0].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const m = lines[j].match(/^(#+)\s/);
      if (m && m[1].length <= level) break;
    }
    uncovered = lines.slice(i + 1, j).join("\n");
    break;
  }

  // 非空判据:去掉空行、分隔行、以及「表头行」(后一行是分隔行的那一行)后仍有内容行
  // 只有表头没有数据行的表 = 空栏;若把表头算成内容,零未覆盖的批会被永远拒交。
  const isSep = (s) => /^\|?[\s:\-|]+\|?$/.test(s.trim()) && s.includes("-");
  const uncoveredNonEmpty = uncovered !== null && (() => {
    const ls = uncovered.split(/\r?\n/);
    for (let i = 0; i < ls.length; i++) {
      const t = ls[i].trim();
      if (!t) continue;
      if (isSep(ls[i])) continue;                             // 分隔行
      if (i + 1 < ls.length && isSep(ls[i + 1])) continue;    // 表头行
      return true;
    }
    return false;
  })();

  return { head, uncovered, uncoveredNonEmpty, hasUncoveredSection: uncovered !== null };
}

export function gate(text, { landed, total } = {}) {
  const r = parseReport(text);
  const problems = [];

  const hitWords = DONE_WORDS.filter((w) => r.head.includes(w));
  const hasRatio = /\b\d+\s*\/\s*\d+\b/.test(r.head);

  if (!r.hasUncoveredSection) {
    problems.push('报告没有「本批未覆盖」栏 —— 该栏是清单不是提案,缺席即视为未申报,不得判通过。');
  }

  if (r.uncoveredNonEmpty) {
    if (hitWords.length) {
      problems.push(`未覆盖栏非空,而首节出现裸完成性断言:${hitWords.join("、")}`);
    }
    if (!hasRatio && !(Number.isFinite(landed) && Number.isFinite(total))) {
      problems.push("未覆盖栏非空,而首节没有 已落账/总数 比值,也未由 --landed/--total 给出。");
    }
  }

  // 2026-08-16 用户亲签修语义(B 份登记 #6):landed==total 不再无条件写「未覆盖为零」——
  // 未覆盖栏非空时,交办完成与批面干净是两件事,HEADLINE 必须两头都说。
  let headline = null;
  if (Number.isFinite(landed) && Number.isFinite(total)) {
    if (landed < total) {
      headline = `本批交付 ${landed}/${total} —— 未落账 ${total - landed} 项,逐条见「本批未覆盖」栏。**这不是做完。**`;
    } else if (r.uncoveredNonEmpty) {
      headline = `本轮交办 ${landed}/${total} 已落;另有未覆盖项见「本批未覆盖」栏。`;
    } else {
      headline = `本批交付 ${landed}/${total},未覆盖为零。`;
    }
  }

  return { ok: problems.length === 0, problems, headline, ...r };
}

// ── 自测 ──
function selfTest() {
  const cases = [
    ["未覆盖非空 + 裸完成断言 ⇒ 拒",
      "# 报告\n做完了。\n\n## 本批未覆盖\n\n- 还有 20 条没验\n", false],
    ["未覆盖非空 + 带比值 + 无完成词 ⇒ 过",
      "# 报告\n本批交付 9/29。\n\n## 本批未覆盖\n\n- 还有 20 条\n", true],
    ["未覆盖非空 + 无比值 ⇒ 拒",
      "# 报告\n首节一切正常。\n\n## 本批未覆盖\n\n- 还有 20 条\n", false],
    ["未覆盖栏只有表头分隔行 ⇒ 视为空 ⇒ 过",
      "# 报告\n做完了。\n\n## 本批未覆盖\n\n| a | b |\n|---|---|\n", true],
    ["缺未覆盖栏 ⇒ 拒(缺席不等于零)",
      "# 报告\n做完了。\n\n## 关账\n\n无欠账\n", false],
    ["未覆盖非空 + 完成词但在正文非首节 ⇒ 过",
      "# 报告\n本批交付 9/29。\n\n## 细节\n这一条做完了。\n\n## 本批未覆盖\n\n- 20 条\n", true],
  ];
  let pass = 0, fail = 0;
  for (const [name, text, want] of cases) {
    const got = gate(text).ok;
    if (got === want) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}  期望 ok=${want} 实得 ok=${got}`); }
  }
  // headline 供给面
  const h = gate("# r\n本批交付 9/29\n## 本批未覆盖\n- x\n", { landed: 9, total: 29 }).headline;
  if (h && h.includes("9/29") && h.includes("不是做完")) { pass++; console.log("  PASS  headline 供给(未完成态)"); }
  else { fail++; console.log(`  FAIL  headline 供给,实得:${h}`); }
  const h2 = gate("# r\n29/29\n## 本批未覆盖\n\n| a |\n|---|\n", { landed: 29, total: 29 }).headline;
  if (h2 && h2.includes("未覆盖为零")) { pass++; console.log("  PASS  headline 供给(完成态)"); }
  else { fail++; console.log(`  FAIL  headline 完成态,实得:${h2}`); }
  // B份#6 缺陷情形(2026-08-16 修语义):交办全落但未覆盖栏非空 ⇒ 两头都说,禁「未覆盖为零」。
  const h3 = gate("# r\n本批交付 7/7\n## 本批未覆盖\n\n- 还有 5 条\n", { landed: 7, total: 7 }).headline;
  if (h3 && h3.includes("已落") && h3.includes("另有未覆盖") && !h3.includes("未覆盖为零")) {
    pass++; console.log("  PASS  headline 供给(交办全落但栏非空 ⇒ 两头都说)");
  } else { fail++; console.log(`  FAIL  headline 栏非空情形,实得:${h3}`); }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

// ── CLI ──
const argv = process.argv.slice(2);
if (argv.includes("--self-test")) selfTest();
else {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("用法: node --no-warnings scripts/report-gate.mjs <报告路径> [--landed N --total M]");
    process.exit(3);
  }
  const num = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : undefined;
  };
  const res = gate(fs.readFileSync(file, "utf8"), { landed: num("--landed"), total: num("--total") });
  if (res.headline) console.log(`HEADLINE: ${res.headline}`);
  // C-C1/C-C3 试点(2026-08-16,048 组四签「试点」):仪器自报天花板与标定态。
  // (原「已知缺陷 B份#6」自曝警告已随 2026-08-16 用户亲签的 headline 修语义一并退役。)
  console.log(
    "CEILING: 本闸只检「未覆盖栏在场 + 首节比值/完成词形态」,不检栏内容的真实与完整;" +
      "CALIBRATED=false(判据未与人工裁决标定,输出是证据不是判决)。",
  );
  if (res.ok) { console.log("report-gate: PASS"); process.exit(0); }
  console.log("report-gate: 拒交");
  for (const p of res.problems) console.log(`  - ${p}`);
  process.exit(2);
}
