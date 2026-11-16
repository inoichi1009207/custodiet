// 束缚面条款检查器(036 批,用户 2026-08-03 裁决取「第 2 条:改仪器口径」)。
//
// ── 存在理由(读这段就够了)────────────────────────────────────────────
//
// 036 的事件流记录的是「**闸拦下了什么**」。但 036 盘点发现:**最该被复议的那一类条款,
// 恰恰是现有仪器一条都覆盖不到的那一类** —— 汇报格式与行为习惯类条款**不产生 deny 事件**,
// 因为根本没有任何守卫在检查它们。C25 当年就是这一类,所以 031 批只能靠**人力翻会话记录**
// 数出执行率 0/6。
//
// 本工装是那次人力普查的**自动化版**:对这类条款,可观测量不是 `deny`,是 `遵守/未遵守`。
//
// ── 极性警告(必读,constraint-events.mjs 头注 I6)────────────────────
//
// **有闸的条款**:可裁证据 = `零真拦`(从没拦住过任何东西)。
// **本工装覆盖的条款**:可裁证据 = `零遵守`(从没人照做),**极性相反**。
// 2026-08-03 签署的宪法稿写的是「零真拦记录」,**未覆盖无闸条款**,该缺口尚未消解。
// ⇒ 本工装产出的 comply/violate 事件,当前**不得**被用作免签裁撤的依据;
//   `constraint-events --report` 对 instrument=checker 的条款一律判 UNKNOWN。
//
// ── 三档判定(诚实优先于好看)──────────────────────────────────────
//
//   comply  —— 明确照做了。
//   violate —— 明确没照做。
//   unknown —— **机器分不出来**(如「首节多行」可能是合法的异常展开,也可能是没压缩)。
//   n/a     —— 本批没出现该条款的适用场合(=零触发,不是遵守也不是违反)。
//
// **unknown 不是失败,是本工装的诚实边界。**把 unknown 强判成 comply 会让执行率虚高,
// 把它强判成 violate 会冤枉合法行为 —— 两个方向都会污染复议单的证据。
//
// ── 真检查器 vs 代理指标 ────────────────────────────────────────────
//
//   real  —— 判据与条款语义**一一对应**。
//   proxy —— 判据只是条款语义的**近似**,有已知漏检/误判面(逐条写在 note 里)。
//            代理指标**单独不足以支撑免签裁撤**(r1-5:降级的东西容易被当成「该面已覆盖」)。
//
// 用法:
//   node scripts/constraint-checkers.mjs --report-file <本批报告.md> [--batch NNN] [--record]
//   node scripts/constraint-checkers.mjs --self-test
//
//   --record 才写事件流;不带则只打印(便于先看结论再决定记不记)。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 小工具 ----------

const readIf = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

/** 取报告的「首节」正文:第一个二级标题之后,到下一个二级标题之前。 */
function firstSection(md) {
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

/** 报告里最长的围栏块行数。 */
function longestFence(md) {
  const lines = md.split(/\r?\n/);
  let inFence = false, cur = 0, max = 0;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      if (inFence) { max = Math.max(max, cur); cur = 0; inFence = false; }
      else inFence = true;
      continue;
    }
    if (inFence) cur++;
  }
  return max;
}

// ---------- 检查器 ----------

export const CHECKERS = [
  {
    id: "C-01",
    clause: "恒定条款·7 报告首节压缩(异常才展开)",
    kind: "real",
    note: "能数出首节行数;但「多行」既可能是没压缩,也可能是合法的异常展开 ⇒ 判 unknown,不强判。",
    run({ report }) {
      if (!report) return { verdict: "n/a", evidence: "本批无报告文件" };
      const body = firstSection(report);
      if (!body) return { verdict: "n/a", evidence: "报告无二级标题" };
      const n = body.filter((l) => l.trim()).length;
      if (n === 0) return { verdict: "n/a", evidence: "首节为空" };
      if (n <= 2) return { verdict: "comply", evidence: `首节 ${n} 行(已压缩)` };
      return { verdict: "unknown", evidence: `首节 ${n} 行——可能是合法展开,机器分不出` };
    },
  },
  {
    id: "C-02",
    clause: "停下确认时的通知「⏸ 需要你确认」",
    kind: "proxy",
    note: "只能查「报告里有需亲签/待确认段时,是否带 ⏸」。查不出「会话是否真的停下等过」——" +
      "会话停下等待发生在对话面,不在报告里。漏检面:在对话里停下但报告没写的场合。",
    run({ report }) {
      if (!report) return { verdict: "n/a", evidence: "本批无报告文件" };
      const needsSign = /需亲签|待确认|需要你确认|归用户裁|待你裁/.test(report);
      if (!needsSign) return { verdict: "n/a", evidence: "本批报告无待确认段(零触发)" };
      return /⏸/.test(report)
        ? { verdict: "comply", evidence: "有待确认段且带 ⏸ 标识" }
        : { verdict: "violate", evidence: "有待确认段但**无** ⏸ 标识" };
    },
  },
  {
    id: "C-04",
    clause: "Battle 协议·默认 ≤3 轮",
    kind: "real",
    note: "数 clipboard/prompts/<NNN>-*-audit-r<n>.md 的份数,与条款语义一一对应。",
    run({ batch }) {
      if (!batch) return { verdict: "n/a", evidence: "未给 --batch,无法定位本批 audit 件" };
      const dir = path.join(REPO_ROOT, "clipboard", "prompts");
      if (!fs.existsSync(dir)) return { verdict: "n/a", evidence: "prompts 目录不存在" };
      const re = new RegExp(`^${batch}-.*-audit-r(\\d+)\\.md$`);
      const rounds = fs.readdirSync(dir).map((f) => re.exec(f)).filter(Boolean).map((m) => Number(m[1]));
      if (!rounds.length) return { verdict: "n/a", evidence: "本批无 audit 件(T0/T1 免 battle)" };
      const max = Math.max(...rounds);
      return max <= 3
        ? { verdict: "comply", evidence: `battle 轮数 ${max} ≤ 3` }
        : { verdict: "violate", evidence: `battle 轮数 ${max} > 3` };
    },
  },
  {
    id: "C-05",
    clause: "汇报规范·产品日记每批必更(可见成果批)",
    kind: "real",
    note: "查工作树/暂存区是否触及 docs/product-diary.md。语义一一对应。" +
      "已知边界:「本批是否算可见成果批」由人判,故无成果时判 n/a 而非 violate。",
    run({ visibleOutcome }) {
      const r = spawnSync("git", ["status", "--porcelain", "--", "docs/product-diary.md"],
        { windowsHide: true, cwd: REPO_ROOT, encoding: "utf8" });
      const touched = Boolean((r.stdout || "").trim());
      if (!visibleOutcome) {
        return { verdict: "n/a", evidence: `本批未声明可见成果;日记${touched ? "已" : "未"}触及(不判)` };
      }
      return touched
        ? { verdict: "comply", evidence: "产品日记已改动" }
        : { verdict: "violate", evidence: "本批有可见成果但产品日记未改动" };
    },
  },
  {
    id: "C-06",
    clause: "汇报规范·核对/diff 只报差异片段,不整段 echo 正文",
    kind: "proxy",
    note: "代理判据 = 报告里最长围栏块行数。判不了「块里装的是不是正文」——" +
      "一段 120 行的 self-test 输出与 120 行正文,在本判据下无法区分 ⇒ 超阈值只判 unknown。",
    run({ report }) {
      if (!report) return { verdict: "n/a", evidence: "本批无报告文件" };
      const max = longestFence(report);
      if (max === 0) return { verdict: "n/a", evidence: "报告无围栏块" };
      return max <= 60
        ? { verdict: "comply", evidence: `最长围栏块 ${max} 行(≤60)` }
        : { verdict: "unknown", evidence: `最长围栏块 ${max} 行——装的是不是正文,机器分不出` };
    },
  },
  {
    id: "C-07",
    clause: "汇报规范·长输出(build/测试/日志)重定向到文件,只报尾部或摘要",
    kind: "proxy",
    note: "代理判据 = 报告里有没有出现 build/测试工具的典型长输出特征行。" +
      "漏检面:输出被人工裁剪过、或用了本判据不认识的工具。",
    run({ report }) {
      if (!report) return { verdict: "n/a", evidence: "本批无报告文件" };
      const lines = report.split(/\r?\n/);
      const noisy = lines.filter((l) => /^\s*(at |webpack |✓ |PASS |FAIL |warn |\[\d+\/\d+\])/.test(l)).length;
      if (noisy === 0) return { verdict: "comply", evidence: "报告无成批的原始工具输出行" };
      return noisy > 40
        ? { verdict: "unknown", evidence: `疑似原始输出行 ${noisy} 条——是否属「长输出未重定向」,机器分不出` }
        : { verdict: "comply", evidence: `疑似原始输出行 ${noisy} 条(未超阈值)` };
    },
  },
];

// ---------- 跑 ----------

export function runCheckers(ctx) {
  return CHECKERS.map((c) => {
    let out;
    try { out = c.run(ctx); } catch (e) { out = { verdict: "unknown", evidence: `检查器抛错:${e.message}` }; }
    return { id: c.id, clause: c.clause, kind: c.kind, note: c.note, ...out };
  });
}

function record(results, ledgerEnv) {
  let n = 0;
  for (const r of results) {
    if (r.verdict !== "comply" && r.verdict !== "violate") continue; // n/a 与 unknown 不入流
    const res = spawnSync("node", [
      "--no-warnings", path.join(REPO_ROOT, "scripts", "constraint-events.mjs"),
      "--record-raw", "--kind", r.verdict, "--ids", r.id,
      "--tool", "constraint-checkers", "--target", r.clause,
      "--source", `checker:${r.kind}`, "--evidence", r.evidence,
    ], { windowsHide: true, cwd: REPO_ROOT, encoding: "utf8", env: ledgerEnv || process.env });
    if (res.status === 0) n++;
  }
  return n;
}

// ---------- self-test ----------

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cck-"));
  let pass = 0, fail = 0;
  const t = (n, c) => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}`); } };
  const find = (rs, id) => rs.find((x) => x.id === id);

  // C-01
  let rs = runCheckers({ report: "# T\n\n## 首节\n\n全绿一行。\n\n## 下一节\n" });
  t("① C-01 首节 1 行 ⇒ comply", find(rs, "C-01").verdict === "comply");
  rs = runCheckers({ report: "# T\n\n## 首节\n" + "行\n".repeat(9) + "\n## 下一节\n" });
  t("② C-01 首节多行 ⇒ unknown(不强判 violate,合法展开也长这样)", find(rs, "C-01").verdict === "unknown");

  // C-02
  rs = runCheckers({ report: "## 首节\nx\n## 决策\n需亲签项 3 条\n" });
  t("③ C-02 有待确认段但无 ⏸ ⇒ violate", find(rs, "C-02").verdict === "violate");
  rs = runCheckers({ report: "## 首节\nx\n## 决策\n⏸ 需要你确认——需亲签项 3 条\n" });
  t("④ C-02 有待确认段且有 ⏸ ⇒ comply", find(rs, "C-02").verdict === "comply");
  rs = runCheckers({ report: "## 首节\n全绿。\n" });
  t("⑤ C-02 无待确认段 ⇒ n/a(零触发,不算遵守也不算违反)", find(rs, "C-02").verdict === "n/a");

  // C-04(真实目录)
  rs = runCheckers({ batch: "036" });
  const c4 = find(rs, "C-04");
  if (c4.verdict === "n/a") console.log("SKIP ⑥ C-04(真实目录里没有 036 批的 audit 件;带这些件的仓里照核)");
  else t("⑥ C-04 数出本批 audit 轮数且 ≤3 ⇒ comply", c4.verdict === "comply" && /轮数 2/.test(c4.evidence));
  rs = runCheckers({ batch: "999" });
  t("⑦ C-04 无 audit 件 ⇒ n/a(免 battle 的批不算违反)", find(rs, "C-04").verdict === "n/a");

  // C-05
  rs = runCheckers({ visibleOutcome: false });
  t("⑧ C-05 未声明可见成果 ⇒ n/a(是不是成果批由人判)", find(rs, "C-05").verdict === "n/a");

  // C-06
  rs = runCheckers({ report: "## 首节\nx\n\n```\n" + "l\n".repeat(80) + "```\n" });
  t("⑨ C-06 超长围栏块 ⇒ unknown(装的是不是正文分不出)", find(rs, "C-06").verdict === "unknown");
  rs = runCheckers({ report: "## 首节\nx\n\n```\nl\nl\n```\n" });
  t("⑩ C-06 短围栏块 ⇒ comply", find(rs, "C-06").verdict === "comply");

  // C-07
  rs = runCheckers({ report: "## 首节\nx\n" + "PASS 某项\n".repeat(50) });
  t("⑪ C-07 成批原始输出行 ⇒ unknown", find(rs, "C-07").verdict === "unknown");

  // 无报告
  rs = runCheckers({});
  t("⑫ 无报告文件 ⇒ 报告类检查器全判 n/a(不误判成违反)",
    ["C-01", "C-02", "C-06", "C-07"].every((id) => find(rs, id).verdict === "n/a"));

  // 检查器抛错不带倒整轮
  const bad = { id: "C-XX", clause: "x", kind: "real", note: "", run() { throw new Error("boom"); } };
  CHECKERS.push(bad);
  const rs2 = runCheckers({});
  CHECKERS.pop();
  t("⑬ 某个检查器抛错 ⇒ 该条判 unknown,其余照跑(停不弃车)",
    find(rs2, "C-XX").verdict === "unknown" && rs2.length === CHECKERS.length + 1);

  // 只有 comply/violate 入流
  t("⑭ n/a 与 unknown 不入事件流(不污染执行率分母)",
    record(runCheckers({}), { ...process.env, CONSTRAINT_EVENTS_LEDGER: path.join(tmp, "l.jsonl") }) === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`SELFTEST PASS=${pass} FAIL=${fail}`);
  console.log(`PROBED_AT=${new Date().toISOString()}`);
  return fail === 0 ? 0 : 1;
}

// ---------- CLI ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

  if (argv.includes("--help") || argv.length === 0) {
    console.log([
      "束缚面条款检查器(036 批)",
      "",
      "  --report-file <本批报告.md> [--batch NNN] [--visible-outcome] [--record]",
      "  --self-test",
      "",
      "四档判定:comply / violate / unknown(机器分不出)/ n/a(本批无适用场合=零触发)。",
      "**只有 comply 与 violate 入事件流**;unknown 与 n/a 不入,免得污染执行率分母。",
      "",
      "极性警告:本工装覆盖的是**无闸条款**,其可裁证据是「零遵守」,",
      "与宪法稿写的「零真拦」**极性相反**(见 constraint-events.mjs 头注 I6)。",
      "该缺口未消解前,本工装产出**不得**用作免签裁撤依据。",
    ].join("\n"));
    process.exit(0);
  }

  if (argv.includes("--self-test")) process.exit(selfTest());

  const rf = flag("--report-file");
  const results = runCheckers({
    report: rf ? readIf(path.isAbsolute(rf) ? rf : path.join(REPO_ROOT, rf)) : null,
    batch: flag("--batch"),
    visibleOutcome: argv.includes("--visible-outcome"),
  });
  for (const r of results) {
    console.log(`${r.id} [${r.kind}] ${r.verdict.toUpperCase().padEnd(7)} ${r.evidence}`);
    if (r.kind === "proxy") console.log(`    ↳ 代理指标,单独不足以支撑免签裁撤:${r.note}`);
  }
  const tally = results.reduce((a, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {});
  console.log(`TALLY ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (argv.includes("--record")) console.log(`RECORDED ${record(results)} 条(仅 comply/violate 入流)`);
  else console.log("(未带 --record,未写事件流)");
  process.exit(0);
}
