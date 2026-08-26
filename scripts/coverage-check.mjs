#!/usr/bin/env node
// coverage-check.mjs —— 用 **Node 自带的 V8 覆盖率**判「哪些函数从没被执行过」
//
// 立此文件的理由(2026-08-20,用户问「这件事有没有最优实践」):
//   有,而且情况比「没搜到」难看——「哪些函数没有任何测试跑到」正是 coverage 测的东西:
//     · **Node 24 自带**,`NODE_V8_COVERAGE=<dir>` 对任意进程都生效,**零新依赖**;
//     · 而 **tdd-guardian 的配置里本来就有 coverage 槽位**
//       (`coverage` / `coverageSummaryPath` / `coverageThresholds`),
//       那三处的 `"none"` 和 `0` 是我自己填的 —— **最优实践的接口就在手上,被我亲手关掉**。
//   我当时手搓的替代是「函数名有没有出现在自测的调用位」,它:
//     · 会被解释性注释骗(「提到 ≠ 做过」),
//     · 剥注释时又被用例里的 glob `ls scripts/*.mjs` 中那个 `/*` 骗(当成块注释开头),
//     · 而且**根本不知道代码有没有真的跑到**。
//   落差实测:手搓检查报 **7/7 全覆盖**,而本件报 **63 个函数里 21 个零执行**。
//
// 用法:
//   node --no-warnings scripts/coverage-check.mjs --cmd "<跑测试的命令>" <被测文件...>
//   node --no-warnings scripts/coverage-check.mjs --ctx-consumers
//   node --no-warnings scripts/coverage-check.mjs --self-test
// 退出码: 0=无零执行的具名函数/无零消费字段  1=本件自身出错  2=有零执行/有零消费  3=用法错
//
// ⚠️ CEILING(与手搓那条是同一族限制,只是高一层):
//   覆盖率只证函数**被执行过**,不证**有人检查过它的输出**。
//   一条 `f(1)` 不断言任何东西,覆盖率照样记它为已覆盖。
//   「用例有没有鉴别力」归**变异验收**管(gate-migrate-check 的 §2b),不归这里。
//   另:V8 把箭头函数、回调等记为匿名,本件**只报具名函数**——匿名的零执行会被漏掉。
// CALIBRATED=false。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 跑一次命令并收集 V8 覆盖率,返回 {file -> [{name, count}]}(只含具名函数)。 */
export function collect(cmd, cwd = process.cwd()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-"));
  const r = spawnSync(cmd, { shell: true, cwd, env: { ...process.env, NODE_V8_COVERAGE: dir }, stdio: "ignore" });
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir); } catch { /* 没产出 */ }
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    for (const res of j.result || []) {
      const url = String(res.url || "");
      if (!url.startsWith("file:")) continue;
      const p = url.replace(/^file:\/\/\/?/, "").replace(/\\/g, "/");
      // ⚠️ **必须跨进程合并,不能覆盖**(2026-08-20,本件上线当轮自己的 bug):
      //   `npm run gate:self-test` 是一条 `&&` 链,每个 `--self-test` 是**独立进程**、
      //   各写一份覆盖文件。原写法 `out[p] = fns` 是**后读的覆盖前读的**,
      //   于是「在进程 A 里跑过、进程 B 里只被 import」的函数被记成零执行,
      //   而只在别的进程里加载的文件干脆报「未被加载」。
      //   正确语义是**取各进程的最大执行数**:任一进程执行过即算执行过。
      // ⚠️ 合并键是 **name + 源码偏移**,不是光用函数名(codex 2026-08-20 的「你没问到的」):
      //   同名函数(不同作用域里的 `apply`、`selfTest`、闭包里的同名helper)会**串账**——
      //   一个跑过、一个没跑,取 max 后两个都算跑过。偏移唯一标识一个函数体。
      const fns = (res.functions || [])
        .filter((x) => x.functionName)                       // 只报具名(见 CEILING)
        .map((x) => ({
          name: x.functionName,
          key: `${x.functionName}@${x.ranges?.[0]?.startOffset ?? "?"}-${x.ranges?.[0]?.endOffset ?? "?"}`,
          count: x.ranges?.[0]?.count ?? 0,
        }));
      if (!fns.length) continue;
      if (!out[p]) { out[p] = fns; continue; }
      const byKey = new Map(out[p].map((x) => [x.key, x]));
      for (const x of fns) {
        const prev = byKey.get(x.key);
        byKey.set(x.key, prev ? { ...x, count: Math.max(prev.count, x.count) } : x);
      }
      out[p] = [...byKey.values()];
    }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  return { files: out, exitCode: r.status };
}

/** 某个文件里零执行的具名函数。 */
export function zeroExec(cov, fileSuffix) {
  const key = Object.keys(cov).find((k) => k.endsWith(fileSuffix.replace(/\\/g, "/")));
  if (!key) return null;                                     // 该文件没被加载 ⇒ null,不是空数组
  const seen = new Map();
  for (const f of cov[key]) seen.set(f.name, Math.max(seen.get(f.name) ?? 0, f.count));
  return [...seen].filter(([, c]) => c === 0).map(([n]) => n).sort();
}

// ── D27(批 101):变异按分支不按条数——V8 原生分支枚举器 ─────────────────────
// 立据:D27「变异按条数不按分支覆盖」——每规则 ≥2 变异是条数下限,不证分支面盖满;
//   手造枚举器违反「有现成的先查」(本文件头注就是那次实撞的记档),
//   故复用 NODE_V8_COVERAGE 的 ranges:函数首 range 是函数体,后续 ranges 是块级片段,
//   count=0 的片段 = 从没被任何用例走到的分支。
// 用法:--branches <目标文件> [--cmd "<测试命令>"](缺省=引擎验收台)[--strict]
// 判读:未覆盖片段按源内 RULE_<id> 声明区间归各规则;区间外归「共享零件」。
//   门槛纪律(D27 债行):新迁规则未覆盖分支须为 0,或在该行行内注明「弃测」+理由;
//   带「弃测」字样的行不计(--strict 下也不计)。缺省报表不拦,--strict 时有未弃测
//   未覆盖分支 ⇒ 退出码 2。
// CEILING:①片段覆盖≠路径覆盖,短路表达式的半边 V8 记不出独立 range 时漏报;
//   ②归属按字符区间,共享零件被规则调用的分支记在零件名下不记规则;
//   ③覆盖只证执行,不证断言(归变异验收)——三条与函数模式同族,只是粒度更细。
export function branchReport(cmd, targetFile, cwd = process.cwd()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covbr-"));
  spawnSync(cmd, { shell: true, cwd, env: { ...process.env, NODE_V8_COVERAGE: dir }, stdio: "ignore" });
  const suffix = targetFile.replace(/\\/g, "/");
  const ranges = new Map();                     // "start-end" -> 跨进程 max count
  let seen = false;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { /* 没产出 */ }
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    for (const res of j.result || []) {
      const p = String(res.url || "").replace(/^file:\/\/\/?/, "").replace(/\\/g, "/");
      if (!p.endsWith(suffix)) continue;
      seen = true;
      for (const fn of res.functions || []) {
        for (const r of fn.ranges || []) {
          const key = `${r.startOffset}-${r.endOffset}`;
          ranges.set(key, Math.max(ranges.get(key) ?? 0, r.count ?? 0));
        }
      }
    }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  if (!seen) return null;                        // 目标没被加载 ⇒ null,不是「全覆盖」
  const src = fs.readFileSync(targetFile, "utf8");
  const lineOf = (off) => src.slice(0, off).split("\n").length;
  const lineText = (off) => (src.split("\n")[lineOf(off) - 1] || "");
  const spans = [];
  for (const m of src.matchAll(/(?:export\s+)?const\s+RULE_(\w+)\s*=\s*\{/g)) spans.push({ id: m[1], start: m.index });
  spans.forEach((s, i) => { s.end = spans[i + 1] ? spans[i + 1].start : src.length; });
  const byRule = {};
  for (const [key, count] of ranges) {
    if (count !== 0) continue;
    const [start] = key.split("-").map(Number);
    if (/弃测/.test(lineText(start))) continue;   // 行内弃测声明 ⇒ 不计(带理由的取舍)
    const owner = spans.find((s) => start >= s.start && start < s.end);
    const id = owner ? owner.id : "(共享零件)";
    (byRule[id] ??= []).push(lineOf(start));
  }
  for (const id of Object.keys(byRule)) byRule[id] = [...new Set(byRule[id])].sort((a, b) => a - b);
  return { byRule, total: Object.values(byRule).reduce((n, a) => n + a.length, 0) };
}

// ── D10(批 101):INV-5 的仪器面——「ctx 字段须有消费者」──────────────────────
// 立据:D13「断线即红证人」——ctx 造一个字段而全部规则/引擎零消费,说明判据的输入面
//   与判据本身已经断线(实例:conditionCount 曾全仓零消费,注释宣称的消费者不存在,grill E10)。
// 判法(纯 grep,机器判):
//   ① 枚举 = buildCtx 的 return 块顶层键(括号深度=1 的 `key:` 与简写 `key,`);
//   ② 消费点 = 扫描文件里的 `<任意标识符>[cC]tx.<字段>` 与 `requires: [... "<字段>" ...]`;
//   ③ 零消费 ⇒ 列出,退出码 2。
// CEILING(方向=多报候删,不静默):窗口式消费(`win.text` 等)与解构形态不计——
//   会把「只被窗口消费」的字段报成零消费,人工复核后处置;报出来复核一次的代价
//   远低于死字段在 ctx 里挂三周(D13 的原始形态)。
export function ctxConsumers(opts = {}) {
  const ctxFile = opts.ctxFile ?? "scripts/lib/gate-ctx.mjs";
  const scanFiles = opts.scanFiles ?? [
    "scripts/lib/gate-rules.mjs", "scripts/lib/gate-registry.mjs", "scripts/hook-stop-closure.mjs",
  ];
  const src = fs.readFileSync(ctxFile, "utf8");
  // ⚠️ 文件里不止一个 `return {`:batchGoal 等**通道 IIFE 的内层小 return** 也长这样
  //   (首版 indexOf 撞上它,把通道内层 6 个键当成了 ctx 契约面——自测当场逮住)。
  //   判据 = 取**键数最多**的 return 块:buildCtx 主返回是全部通道的超集。
  //   通道内层字段(batchGoal.batch 等)经 `g.<字段>` 别名消费,机械扫不到 ⇒ 不在射程。
  const starts = [];
  for (let p = src.indexOf("return {"); p >= 0; p = src.indexOf("return {", p + 1)) starts.push(p);
  if (!starts.length) throw new Error(`${ctxFile} 里找不到 buildCtx 的 return 块`);
  const keysOf = (at) => {
  // 括号深度扫描取顶层键(简写与 `key:` 两形态;方法名同样计入——它们也是契约面)
  let depth = 0, i = at + "return ".length, block = "";
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
    if (depth >= 1) block += depth === 1 ? ch : " ";   // 深层内容占位,防内层键混入
  }
    const ks = new Set();
    // 尾分隔符用 lookahead **不消费**:消费掉逗号会让相邻简写键隔一个漏一个(首版实撞)
    for (const m of block.matchAll(/(?:^|[{,\n])\s*(\w+)\s*(?=[:,}])/g)) ks.add(m[1]);
    return ks;
  };
  let fields = new Set();
  for (const p of starts) {
    const ks = keysOf(p);
    if (ks.size > fields.size) fields = ks;
  }
  const blobs = scanFiles.map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } });
  // 别名消费例外表(2026-08-25 人工复核入册)。**例外自带活性证据**:登记的引用形态
  //   必须仍在扫描面上 grep 得到,引用点被删/改名 ⇒ 例外失效、该字段自动回红——
  //   与 EXPECTED_DIVERGENCE「登记项须可验」同一形制,防例外表沦为第二张手写白名单。
  const ALIAS_CONSUMERS = {
    agents: /\bc\.agents\.length\b/,       // gate-rules reviewed():窗口∪本轮的 agent 面
    commits: /\bwin\.commits\b/,           // gate-rules batchDrifting():窗口式消费
  };
  const dead = [];
  for (const f of [...fields].sort()) {
    const re = new RegExp(`\\b\\w*[cC]tx\\.${f}\\b|requires:\\s*\\[[^\\]]*["']${f}["']`);
    const alias = ALIAS_CONSUMERS[f];
    if (blobs.some((b) => re.test(b))) continue;
    if (alias && blobs.some((b) => alias.test(b))) continue;   // 例外成立(证据仍在)
    dead.push(f);
  }
  return { fields: [...fields].sort(), dead };
}

function selfTest() {
  const t = [];
  const chk = (n, got, want) => { const ok = got === want; t.push([ok, n, `实得 ${got}`]); };

  // 造一个确定的被测件:两个具名函数,只调一个
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-st-"));
  const target = path.join(dir, "subject.mjs");
  fs.writeFileSync(target,
    "export function called() { return 1; }\n" +
    "export function neverCalled() { return 2; }\n" +
    "if (process.argv.includes('--go')) called();\n");
  const { files } = collect(`node --no-warnings "${target.replace(/\\/g, "/")}" --go`, dir);
  const zero = zeroExec(files, "subject.mjs");

  chk("找得到被测文件(未加载应返回 null 而非空数组)", zero !== null, true);
  chk("零执行的函数被逮住", (zero || []).includes("neverCalled"), true);
  // ⚠️ 反向:被调用过的**不许**出现在零执行清单里。只测前一半的话,
  //   「一律报零执行」这种实现照样通过。
  chk("被调用过的不在清单里(防「一律报零执行」)", (zero || []).includes("called"), false);
  chk("不存在的文件返回 null", zeroExec(files, "nope-xyz.mjs"), null);

  // ── 分支枚举器:未走分支被逮 + 已走分支不误报 + 弃测行豁免 + 规则归属 ──────────
  {
    const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-br-"));
    const bt = path.join(bdir, "rules-like.mjs");
    fs.writeFileSync(bt,
      "export const RULE_ZZ = {\n" +
      "  detect(x) {\n" +
      "    if (x > 0) { return 'taken'; }\n" +
      "    else { return 'never-taken'; }\n" +
      "  },\n" +
      "};\n" +
      "export const RULE_WW = {\n" +
      "  detect(x) {\n" +
      "    if (x > 99) { return 'waived-never'; } // 弃测:夹具造不出该输入,登记取舍\n" +
      "    return 'ok';\n" +
      "  },\n" +
      "};\n" +
      "RULE_ZZ.detect(1); RULE_WW.detect(1);\n");
    const rep = branchReport(`node --no-warnings "${bt.replace(/\\/g, "/")}"`, bt, bdir);
    chk("目标被加载(否则应 null)", rep !== null, true);
    const zz = rep ? rep.byRule.ZZ || [] : [];
    chk("未走的 else 分支归到所属规则", zz.length >= 1, true);
    chk("已走分支不误报(RULE 区间只报 else 那一片)", zz.length <= 1, true);
    chk("行内「弃测」的零执行片段不计", rep ? (rep.byRule.WW || []).length : -1, 0);
    chk("未加载文件返回 null", branchReport("node -e 1", bt, bdir), null);
    try { fs.rmSync(bdir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  // ── ctx 消费者扫描:正反两向都要钉(只测「报得出死字段」的话,「一律报死」也全绿)──
  {
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-ctx-"));
    const cf = path.join(cdir, "ctx.mjs"), rf = path.join(cdir, "rules.mjs");
    fs.writeFileSync(cf,
      "export function buildCtx(){\n  const used=1, deadField=2, viaRequires=3;\n" +
      "  return {\n    used, deadField,\n    viaRequires,\n    inner: { notAField: 1 },\n  };\n}\n");
    fs.writeFileSync(rf, 'const x = (ctx) => ctx.used;\nconst r = { requires: ["viaRequires"] };\n');
    const { fields, dead } = ctxConsumers({ ctxFile: cf, scanFiles: [rf] });
    chk("字段枚举齐(含简写与换行形态)", ["deadField", "used", "viaRequires"].every((f) => fields.includes(f)), true);
    chk("内层对象的键不混入顶层字段", fields.includes("notAField"), false);
    chk("零消费字段被逮住", dead.includes("deadField"), true);
    chk("ctx.<字段> 消费算数(防「一律报死」)", dead.includes("used"), false);
    chk("requires 契约面消费算数", dead.includes("viaRequires"), false);
    try { fs.rmSync(cdir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  let pass = 0;
  for (const [ok, n, extra] of t) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  ← " + extra}`); if (ok) pass++; }
  console.log(`\n覆盖率自测 ${pass}/${t.length}`);
  return pass === t.length;
}

const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

  if (argv.includes("--branches")) {
    const target = argv[argv.indexOf("--branches") + 1];
    if (!target || target.startsWith("--")) { console.error('用法: --branches <目标文件> [--cmd "<测试命令>"] [--strict]'); process.exit(3); }
    const ci2 = argv.indexOf("--cmd");
    const cmd2 = ci2 >= 0 ? argv[ci2 + 1] : "node --no-warnings scripts/gate-migrate-check.mjs";
    const rep = branchReport(cmd2, target);
    if (rep === null) { console.log(`⚠️  ${target}: 该文件未被测试命令加载 —— 不是「全覆盖」,是没测到`); process.exit(2); }
    const ids = Object.keys(rep.byRule).sort();
    if (!ids.length) console.log(`PASS  ${target}: 无未弃测的零执行分支片段`);
    for (const id of ids) {
      console.log(`  ${id === "(共享零件)" ? "零件" : "规则"} ${id}: ${rep.byRule[id].length} 个零执行片段 → 行 ${rep.byRule[id].slice(0, 12).join(",")}${rep.byRule[id].length > 12 ? "…" : ""}`);
    }
    console.log(`\n合计 ${rep.total} 片段零执行(片段≠路径,行内「弃测」不计;断言力归变异验收)`);
    process.exit(argv.includes("--strict") && rep.total ? 2 : 0);
  }

  if (argv.includes("--ctx-consumers")) {
    const { fields, dead } = ctxConsumers();
    console.log(`ctx 字段 ${fields.length} 个:${fields.join(", ")}`);
    if (!dead.length) {
      console.log("PASS  全部字段在规则/引擎/契约面上有消费点(窗口式消费不计,见 CEILING)");
      process.exit(0);
    }
    console.log(`FAIL  零消费字段 ${dead.length} 个 → ${dead.join(", ")}`);
    console.log("  处置二选一:删字段,或给它接上消费者;「注释里宣称有消费者」不算(grill E10 原型)");
    process.exit(2);
  }

  const ci = argv.indexOf("--cmd");
  const cmd = ci >= 0 ? argv[ci + 1] : null;
  const targets = ci >= 0 ? [...argv.slice(0, ci), ...argv.slice(ci + 2)] : argv;
  if (!cmd || !targets.length) {
    console.error('用法: --cmd "<跑测试的命令>" <被测文件...>');
    process.exit(3);
  }
  const { files } = collect(cmd);
  let bad = 0;
  for (const t of targets) {
    const zero = zeroExec(files, t);
    if (zero === null) { console.log(`  ⚠️  ${t}: **该文件未被加载** —— 不是「全覆盖」,是没测到`); bad++; continue; }
    if (!zero.length) { console.log(`  PASS  ${t}: 具名函数全部被执行过`); continue; }
    console.log(`  FAIL  ${t}: ${zero.length} 个具名函数**零执行** → ${zero.slice(0, 8).join(", ")}${zero.length > 8 ? " …" : ""}`);
    bad++;
  }
  console.log(`\n覆盖率:${bad ? `${bad} 个文件有零执行函数` : "全部通过"}` +
    `(⚠️ 只证被执行过,**不证有人检查过它的输出**——那归变异验收)`);
  process.exit(bad ? 2 : 0);
}
