#!/usr/bin/env node
// batch-goal.mjs —— 批级完成条件(命令自带的 goal)
//
// 干什么:让**每条命令在开工时自己写下这一批的完成条件**,收尾闸每轮拿它比,
//        收尾时(有 git commit)未逐条确认即拦。
//
// 为什么不用官方 `/goal`:它是**内建 slash command,模型调不了**——只有用户能敲。
//        而 2026-08-19 用户明示「以后原则上每个命令都必须 goal,而不是我搁那打 goal」。
//        官方 `/goal` 的机制(session 级 prompt Stop hook、另一个模型判、后台任务在跑时跳过)
//        本仓已由 `.claude/settings.json` 的 prompt hook + `hook-stop-closure` 分别覆盖;
//        本文件补的是它**唯一无法自动化的那一半:条件从哪来**。
//
// 判据(全部结构事实,不判语义):
//   - 条件是否**存在**:文件在不在、conditions 非空;
//   - 条件是否**被逐条确认**:助理输出里出现「条件N:达成」或「条件N:未达成」形态;
//   - 谁也不判「条件本身是否真的达成」——那是语义,机器给不出,由跨模型判官与人兜。
//
// 天花板(CEILING):本闸只证「条件写下来了、收尾时被逐条对照过」,
//        **不证条件写得对、更不证它真的达成**。一条写得含糊的条件会顺利通过本闸。
//        与官方 `/goal` 的评估器同限:不跑命令、不读文件。
//
// 用法:
//   node --no-warnings scripts/batch-goal.mjs --arm <批号> --cond "…" [--cond "…"]
//   node --no-warnings scripts/batch-goal.mjs --status
//   node --no-warnings scripts/batch-goal.mjs --decision "<本批决定一句话>"   ⇒ 自动编号 <批号>-D<n>(批 256)
//   node --no-warnings scripts/batch-goal.mjs --no-decision "<为什么本批没有决定>"   ⇒ 承重面批零决定时的声明(批 276,D177)
//   node --no-warnings scripts/batch-goal.mjs --outcome "<可见成果一句话>"    ⇒ 自动序号 O<n>(批 256)
//   node --no-warnings scripts/batch-goal.mjs --withdraw <批号-Dn | On> --reason "<理由>"   撤回误登记的一项(批 256b)
//   node --no-warnings scripts/batch-goal.mjs --clear
//   node --no-warnings scripts/batch-goal.mjs --self-test
// 退出码: 0=正常  2=用法错 / 拒清
//
// ⚠️ **次序:`--clear` 必须是本批的最后一个动作,收尾提交要排在它前面。**
//   反了会命中 K0——因为「已结清 + 本轮又有 commit」按判据即「新批未武装就提交」,
//   而那正是 K0 该拦的形态。2026-08-19 实撞:我先 --clear 再提交日记与寄存器,
//   当场被自己刚修好的 K0 逮住。判据没错,是我的次序错。
//   正确序:武装 → 干活 → 逐条对照 → **提交** → `--clear`。

import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ledgerAppend } from "./lib/ledger-chain.mjs";
import { quoteUntrusted } from "./lib/gate-ctx.mjs";
import { isCarrierPath, CARRIER_SURFACE } from "./lib/gate-carriers.mjs";
const JOURNAL = path.join(".claude", ".batch-goal.jsonl");
// 盲审日志(fpAudit / fpAuditLast 用)。须在顶部定义:--clear / --arm 分支在文件中段执行并 exit,
//   定义在函数旁边时落在暂时性死区,发车与读结论都会失败(codex 259-final-r1 附节 1 实测)
const FP_AUDIT_LOG = path.join("clipboard", "codex", "fp-audit-last.log");

// ── 可执行判据(D98-③,2026-09-04 用户「趁这个功夫把闸修了」;同日 codex + grill 双审后加固)──────
//   `--cond "…" --check "<命令>" [--expect "<子串>" | --expect-re "<正则>"]`:check 挂在**它前面最近的那条** --cond 上。
//   `--clear` 先跑全部 check:退出码非 0、或输出(stdout+stderr)不含 expect ⇒ **拒清**(fail-closed),
//   不再只认「条件N:达成」那句自述。实撞:半写的 mp4 被我按日志行宣布落盘,ffprobe 当场就能否掉。
//   加固点(审出的漏放,逐条):
//   · check 一律经 **Git Bash** `bash -c` 跑(不是 cmd.exe——`$()`/`2>/dev/null`/`;` 在 cmd 下要么字面要么报错,曾能空过);
//     找不到 bash ⇒ --arm 直接拒(fail-closed),并把 shell 写进状态。
//   · 语法严格:未知 `--flag`、缺值、空值、值以 `--` 开头、重复 --expect、--expect 前没有 --check ⇒ 退出 2;
//     expect 为空/纯空白 ⇒ 拒(空串 includes 恒真);expect ≤2 字符 ⇒ 警告。
//   · 判据与武装台账绑定:--clear/--dry-check 先核状态文件里的 checks 与本批最后一条 arm 日志行**逐字相同**,
//     不同 ⇒ 拒跑(状态文件 gitignore、可被别的进程改写;曾有后台 codex 用 --force 盖过它——把它变成 RCE 入口不行)。
//   · 同批重武装若 conditions/checks 有任何变化 ⇒ 须 --force(否则可以悄悄把判据删掉);--force 覆盖带判据的批时先跑一遍旧判据并记入日志。
//   · 整批 wall-clock 上限 600 s、单条 120 s、maxBuffer 4 MiB;失败输出经 quoteUntrusted 回显。
//   天花板(诚实写出):自由 `--check` 只证「这条命令在此刻通过」,不证它和条件对象真有关系——写 `echo 218.` 照样过;
//   它是低保证级判据,结构性绑定(按路径自动组 ffprobe)是另一批;探针结果与写入时序的关系由引擎 X 项另管。
const KNOWN_ARM_FLAGS = new Set(["--arm", "--cond", "--check", "--expect", "--expect-re", "--force"]);
export function parseArm(argv) {
  const conds = [], checks = [];
  const val = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).trim() === "") throw new Error(`${flag} 缺值或为空`);
    if (/^--/.test(v)) throw new Error(`${flag} 的值不能以 -- 开头(得到「${v}」,像是漏写了值)`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arm") { i++; continue; }
    if (a === "--force" || a === "--imported-noop") continue;
    if (a === "--cond") { conds.push(val(i, a)); i++; continue; }
    if (a === "--check") {
      if (!conds.length) throw new Error("--check 必须跟在某条 --cond 之后");
      checks.push({ i: conds.length - 1, cmd: val(i, a) }); i++; continue;
    }
    if (a === "--expect" || a === "--expect-re") {
      const last = checks[checks.length - 1];
      if (!last || last.i !== conds.length - 1) throw new Error(`${a} 必须紧跟本条 --check`);
      if (last.expect !== undefined || last.expectRe !== undefined) throw new Error(`${a} 重复:一条 --check 只能配一个 expect`);
      const v = val(i, a); i++;
      if (a === "--expect-re") { try { new RegExp(v); } catch (e) { throw new Error(`--expect-re 不是合法正则:${e.message}`); } last.expectRe = v; }
      else { if (v.trim().length < 4) throw new Error(`--expect「${v}」太短(<4 字符):几乎任何输出都含它;要短匹配用 --expect-re 加锚点`); last.expect = v; }
      continue;
    }
    if (/^--/.test(a)) throw new Error(`未知参数 ${a}(合法:${[...KNOWN_ARM_FLAGS].join(" ")})`);
    throw new Error(`多余的位置参数「${a}」——每个值都要跟在它的 flag 后面`);
  }
  return { conds, checks };
}
/** Git Bash 路径(check 一律经它跑)。找不到返回 null。 */
export function findBash() {
  const cands = [process.env.BATCH_GOAL_BASH, "C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe", "/usr/bin/bash", "/bin/bash"].filter(Boolean);
  // r2:也扫 PATH(便携 Git / 自定义安装目录只在 PATH 里)
  for (const d of String(process.env.PATH || "").split(path.delimiter)) if (d) cands.push(path.join(d, "bash.exe"), path.join(d, "bash"));
  for (const c of cands) { try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}
/** 跑一批 check,返回失败清单(空数组 = 全过)。`run` 可注入(自测用)。checks 形状不对 ⇒ 当失败(fail-closed)。 */
export function runChecks(goal, run = defaultRun, budgetMs = 600_000) {
  const out = []; const t0 = Date.now();
  const checks = goal?.checks;
  if (checks !== undefined && checks !== null && !Array.isArray(checks)) return [{ i: 0, cmd: String(checks), status: -1, stdout: "", stderr: "checks 不是数组(状态文件损坏或被改写)" }];
  for (const c of (checks || [])) {
    if (!c || typeof c.cmd !== "string" || !c.cmd.trim()) { out.push({ i: c?.i ?? 0, cmd: String(c?.cmd), status: -1, stdout: "", stderr: "check 命令不是非空字符串" }); continue; }
    if (Date.now() - t0 > budgetMs) { out.push({ i: c.i, cmd: c.cmd, status: -1, stdout: "", stderr: `整批判据超过 ${budgetMs / 1000}s 上限,未跑` }); continue; }
    const r = run(c.cmd);
    const output = (String(r.stdout || "") + "\n" + String(r.stderr || "")).slice(0, 65536);   // r2:正则只跑在前 64 KB 上,压住 ReDoS 面
    let ok = r.status === 0;
    if (ok && c.expect !== undefined) ok = String(c.expect).trim() !== "" && output.includes(c.expect);
    if (ok && c.expectRe !== undefined) { try { ok = new RegExp(c.expectRe, "m").test(output); } catch { ok = false; } }
    if (!ok) out.push({ i: c.i, cmd: c.cmd, expect: c.expect ?? c.expectRe, status: r.status, stdout: String(r.stdout || "").trim().slice(0, 200), stderr: String(r.stderr || "").trim().slice(0, 200) });
  }
  return out;
}
function defaultRun(cmd) {
  const bash = findBash();
  if (!bash) return { status: -1, stdout: "", stderr: "找不到 Git Bash(BATCH_GOAL_BASH 可指定)" };
  const r = spawnSync(bash, ["-c", cmd], { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: String(r.stderr || "") + (r.error ? " " + String(r.error) : "") };
}
function printCheckFails(fails, goal) {
  for (const f of fails) {
    const text = (goal?.conditions || [])[f.i]; console.error(`  条件${f.i + 1}«${typeof text === "string" ? text.slice(0, 60) : ""}» check 未过:`);
    console.error(`    $ ${f.cmd}\n    退出码 ${f.status}${f.expect !== undefined ? `,期待含「${f.expect}」` : ""}${f.stdout ? `\n    stdout: ${quoteUntrusted(f.stdout, 200)}` : ""}${f.stderr ? `\n    stderr: ${quoteUntrusted(f.stderr, 200)}` : ""}`);
  }
}
/** 本批最后一条 arm 日志行(按批号),用来核状态文件里的 checks 没被改过。 */
function lastArmRow(batch) {
  let lines = []; try { lines = fs.readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean); } catch { return null; }
  for (let k = lines.length - 1; k >= 0; k--) { let o; try { o = JSON.parse(lines[k]); } catch { continue; } if (o.action === "arm" && o.batch === batch) return o; }
  return null;
}
export function checksMatchJournal(goal, row) {
  const norm = (x) => JSON.stringify(Array.isArray(x) ? x : []);
  return norm(goal?.checks) === norm(row?.checks);
}
/** 同批重武装是否改了内容(conditions 或 checks 任一不同)。 */
export function armChanged(cur, conds, checks) {
  const norm = (x) => JSON.stringify(Array.isArray(x) ? x : []);
  return norm(cur?.conditions) !== norm(conds) || norm(cur?.checks) !== norm(checks);
}

const FILE = path.join(".claude", ".batch-goal.json");

// ── 「小 git」:原子写 + 只追加日志 + 覆盖保护(2026-08-19,用户提议;当日实撞事故)──
//
// 事故:codex 在后台跑审计时,把 `.batch-goal.json` 整个盖成它自己任务的条件,
//   **批 061 的验收标准就此丢失**,靠我在对话里记得才恢复。发现它只是因为
//   收尾闸报出一个我从没武装过的批号——**否则无声无息**。
// grill:error-handling 早已逐字警告过这个面(已从 transcript 核过原文):
//   「`[RUN]` It is **gitignored** — no version history, no recovery path」
//   「`writeFileSync` directly on the live path — **no temp+rename, no lock, no fsync**」
//
// 三样都补上:
//   ① **原子写**:临时文件 + rename,并发读者不会看到被截断的空文件;
//   ② **只追加日志** `.claude/.batch-goal.jsonl`:每次 arm/clear 追加一行,永不覆盖
//      ——这就是那个「小 git」,任何一次覆盖都能从这儿翻回来;
//   ③ **覆盖保护**:当前已武装且批号不同时,`--arm` 拒绝执行,除非显式 `--force`。
//      这一条直接挡住本次事故的形态。

function journal(action, payload) {
  try {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    // D1/批 102:改走 ledger-chain(行级 hash 链,完整性告警)。三接线点之一——
    //   本台账独立承担 K0 结清证据补回与 --audit 历史重放(D46),状态文件替代不了它的历史面。
    ledgerAppend(JOURNAL, { at: new Date().toISOString(), action, ...payload });
  } catch (e) {
    // 写失败不阻断主流程(原子写仍要做),但**必须出声**——静默吞错=报警从分母无声消失(四眼判词)
    console.error("JOURNAL-WRITE-FAILED: " + String(e && e.message));
  }
}

/** 读当前版本号。文件不存在或没有 version 字段 ⇒ 0。 */
function currentVersion() {
  try { return Number(JSON.parse(fs.readFileSync(FILE, "utf8"))?.version) || 0; } catch { return 0; }
}

/**
 * 原子写 + **乐观并发控制(CAS)**。
 * 外部先例(2026-08-19 WebSearch,event sourcing / OCC):
 *   「写新事件时断言该聚合的最新 sequence_number 是 N−1」「两个并发写同一版本 ⇒
 *    一个成功、一个拿到冲突并重试」。
 * 为什么需要:上一版的覆盖保护比的是**批号**,而两个进程武装**同一批号**照样互相盖。
 *   版本号才是并发的正确判据——批号是业务标识,不是并发标识。
 * ⚠️ **天花板(实测后改写,不要照先例的话直接信)**:本 CLI 是「读版本 → 立刻写」,
 *   两步相隔微秒,外部进程插不进去 ⇒ **这层 CAS 在本场景里近乎装饰**。
 *   实测:从外部把盘上版本推高再调 --arm,它照样成功,因为 --arm 自己会重新读一遍。
 *   OCC 真正有用的前提是**调用方跨越一段较长的操作持有版本**(交互式流程、跨请求),
 *   我们不是那个形态。
 *   真正挡住本次事故的是**批号覆盖保护**(已实证:模拟 codex 那次覆盖被拒)。
 *   保留 version 字段的理由是它让 --history 能排序、也给将来真持有版本的调用方留口;
 *   **但不要把它当成并发安全的证据**。要真安全得上锁文件或换载体。
 */
function atomicWrite(obj, expectVersion) {
  const now = currentVersion();
  if (expectVersion !== undefined && now !== expectVersion) {
    throw new Error(`并发冲突:期待版本 ${expectVersion},盘上已是 ${now}——` +
      `有别的进程在你读取之后写过。历史见 --history,重试前先 --status 看当前状态`);
  }
  // ⚠️ tmp 必须**每进程唯一**。原实现用固定名 `FILE + ".tmp"`,于是机器上每个进程
  //   都往**同一个缓冲文件**里写。grill:edge-cases F2 实测 16 路并发:
  //   **10 个报成功、版本只到 9、盘上是某一个进程的条件**——
  //   一个进程写了共享 tmp,却被**另一个进程**把它 rename 到位。
  //   「报成功的那个,不一定是条件落盘的那个」——正是原事故的损坏形状,
  //   而且不需要批号不同就能发生。
  const tmp = `${FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...obj, version: now + 1 }, null, 2), "utf8");
    fs.renameSync(tmp, FILE);   // 同卷 rename 是原子的
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 残骸清不掉不阻断 */ }
  }
}

/**
 * 读状态。**必须区分「没有」与「读不了」**——这是 F1 的根:
 * 原实现两种情况都返回 null,而覆盖保护写的是 `if (cur && …)`,
 * 于是**零字节/损坏的状态文件让保护整个跳过**,`--arm` 成功退出 0。
 * 而零字节正是修复前那个裸 writeFileSync 留下的产物 —— 事故的那一类状态,
 * 恰恰关掉了唯一挡住事故的机制(grill:edge-cases F1,已实测复现)。
 * 现在:文件不存在 ⇒ `null`(真的没武装);存在但解析不了 ⇒ 抛,由调用方 fail-closed。
 */
export function load(file = FILE) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw new Error(`状态文件读不了(${e.code}):${file}`); }
  if (!raw.trim()) throw new Error(`状态文件为空 —— 可能是被中断的写留下的残骸:${file}`);
  try { return JSON.parse(raw); }
  catch { throw new Error(`状态文件解析失败(${raw.length} 字节)—— 不得当作「没武装」处理:${file}`); }
}

// 从助理输出里认「逐条对照」的痕迹。刻意只认带编号的形态,
// 因为无编号的「都达成了」正是本闸要防的那种笼统完成断言。
export function confirmedIndices(text) {
  const hit = new Set();
  // ⚠️ 冒号类必须含全角 U+FF1A。这份**曾与 hook 里的那份分叉**:hook 已修、本份没修,
  //   而自测 7/7 全绿——因为它测的正是这份**没人 import 的死代码**(grill:edge-cases F22)。
  //   分叉的根是 F23(本文件不是 import-safe,hook 只好抄一份正则),已一并修。
  for (const m of String(text || "").matchAll(/条件\s*(\d+)\s*[:：]\s*(达成|未达成|已达成|不适用)/g)) {
    hit.add(Number(m[1]));
  }
  return hit;
}

export function evaluate(goal, text) {
  if (!goal || !Array.isArray(goal.conditions) || !goal.conditions.length) return null;
  const done = confirmedIndices(text);
  const pending = goal.conditions
    .map((c, i) => ({ n: i + 1, text: typeof c === "string" ? c : c?.text || "" }))
    .filter((c) => !done.has(c.n));
  return { batch: goal.batch || "?", total: goal.conditions.length, pending };
}

// ── D116:结清前工作树必须干净(批 243,用户 2026-09-16 授权「567 你自己判断」)──────────
// 病:生产法三已亲签「收尾清账不征询」,但 Stop 时**根本没 commit 也不响**——DP 只判
//   「推了之后有没有跑欠账探针」,D/H/K0 均不覆盖「本批改动没提交」。批 204 就是这么漏的。
// 为什么修在工装侧、不修在闸侧:与 D126 同理——`--clear` 是「批次完成」这个事件的唯一入口,
//   在这里拒比在 Stop hook 里猜「这轮算不算收尾」窄得多;且本文件不在 GATE_ENGINE 正则里。
// 只看**已跟踪**文件(含已暂存):未跟踪文件常是草稿与探针,拿它们拒清会逼人绕路。
// fail-closed:git 跑不起来 ⇒ 判不了 ⇒ 拒清(不是放行)。
// CEILING:只证「结清那一刻没有未提交的已跟踪改动」;不证推了没有(那是 DP),
//   不证提交的是本批的东西(先提交别的再 clear 也能过)。
//   codex 243 复核(clipboard/codex/243-crosscheck-r1.md)实指两条,均未修、方向已知:
//   ① **误拦**:仓里有一处**批前就在、不属于本批**的未提交改动(例如用户自己改到一半)⇒ 本批提交干净也拒清。
//      方向是 fail-closed 且当场可见;出路是停下问用户,**绝不替用户撤销**(拒清文案按此写,
//      首版曾建议 `git checkout -- <路径>`,可能诱导丢掉用户改动,已删)。
//      根治思路(未做):--arm 时记下已脏路径与内容哈希,--clear 只拒「arm 之后新脏或内容变了」的路径。
//   ② **绕过**:把本批改动 `git stash` 挪走再 --clear 即放行。这是蓄意规避,本判据不防。
function uncommittedTracked(porcelain) {
  return String(porcelain || "").split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("??") && !l.startsWith("!!"))
    .map((l) => l.slice(3));
}
function worktreeState(run = (args) => spawnSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", windowsHide: true, timeout: 30_000 })) {
  let r;
  try { r = run(["status", "--porcelain", "--untracked-files=no"]); } catch (e) { return { unknown: true, why: e.message }; }
  if (!r || r.error || r.status !== 0) return { unknown: true, why: (r && (r.error?.message || String(r.stderr || "").trim())) || "git 不可用" };
  return { unknown: false, paths: uncommittedTracked(r.stdout) };
}

// ── 批 256:批基点 + 决定清单 + 成果义务(开工单 clipboard/256-custodiet-review-and-directions.md「三之二」1–3)──
// 设计 v2 的总原则:**硬闸只核「已登记的义务」,发现候选只提示**(候选提示是引擎 AD 项,见 gate-rules.mjs)。
//   原案(按提交命令入参找签字词、按字面词表判、子串匹配「批 21」)被 codex 与红队两路否决:
//   看不见 heredoc/-F 提交、漏「用户 2026-09-17 签」、误拦「待亲签」、`批 21` 命中 `批 210`。
// ① 批基点 `baseCommit`:第一次 `--arm` 记当时的 HEAD;**同号重武装(未结清)保留不刷新**——
//    含 --force 的同号重开。旧批(本功能上线前武装的)没有基点 ⇒ 保持 null,**不现场补记**:
//    补记的是重武装时刻的 HEAD,比真基点晚,会把基点前写好的 ADR 排出范围 ⇒ 误拦。
// ② 决定清单:`--decision` 登记,自动编号 `<批号>-D<n>`。`--clear` 要求每个编号都出现在
//    `git diff <基点> HEAD -- docs/adr/` 新增/修改/改名过的某张 `NNNN-*.md` 的 HEAD 版正文里,
//    且**在声明语境里**:所在行含「决定编号」或「取代」(新写一张写 `- 决定编号:256-D1`,
//    或在旧 ADR 上标「被 256-D1 取代」「部分取代」都算;顺带写「另见 256-D2(待写)」不算——批 256b BP-1)。
//    编号的 D 号认前导零(`256-D01` = `256-D1`,BP-8)。没登记决定 ⇒ 不查。
//    基点取不到(null / 换分支后对象不在)⇒ 退回在 HEAD 的**全部** ADR 里找编号,并出声。
//    同号批结清后重开(批 256b BP-2):新决定编号接着**台账里该批号已用过的最大 D 号**往上数,
//    撤回过的编号也不复用 ⇒ 同一编号在一个仓里只登记一次,退回全部 ADR 时旧 ADR 不会替新决定抵账。
//    `git show` 某张 ADR 失败 ⇒ unknown(拒清),不当「缺 ADR」报(BP-10)。
//    取路径的 git 调用一律 `-c core.quotePath=false` + `-z`:中文文件名的 ADR 曾被引号转义整张丢掉(BP-5)。
// ③ 成果义务:`--outcome` 登记。登记过 ⇒ `--clear` 要求 `docs/product-diary.md` 表格里有一行,
//    其「事项」栏**第一个**批号标记覆盖本批号:精确相等,或范围(`批 186–187`)、合并写法
//    (`批 202/202b`、`批 255 与 256`、`和`、`+`)含本批;反序写法 `256 批` 也认;全角数字先归一(BP-7)。
//    有基点时那一行还须出现在 `git diff <基点> HEAD -- docs/product-diary.md` 的**新增行**里
//    (同号重开的批不能拿上次那行抵账,BP-2);无基点或基点取不到 ⇒ 维持只看全文并出声。
//    没登记成果 ⇒ 不查(汇报法「产品日记每批收尾必更」:无证据不写、纯调查批不写)。
//    日记文件不存在(ENOENT)⇒ 只提示不拒清(别的仓没有这本日记);其它读错误 ⇒ unknown 拒清(BP-4,与 ADR 一侧同口径)。
// ④ 撤回(批 256b BP-9):`--withdraw <批号-Dn | On> --reason "…"` 把误登记的一项挪进 `withdrawn`,
//    不再参与核对;台账记 `withdraw` 行带理由,`--status` 列出已撤项。成果序号 `O<n>` 登记时定死,撤回不重排。
// ⑤ `--force` 换批覆盖带决定/成果的未结清批(BP-3):输出点名丢了哪些编号与成果,并记台账 `force-over-obligations`。
// 两道检查都在**写入 cleared 之前**跑,拒清时说清缺哪个编号、给可复制的模板;没有「正文写某个固定字面串就放行」的出口。
// 残余(拿不准一律选了不拦,逐条写明):
//   · 批号标记只认事项栏**第一个** `批 <数字…>` 或 `<数字…> 批`;写成「ADR 闸(批 256)」可过,而「修批 255 的残余(批 256)」不过
//     (第一个是 255)——后者须把本批号写在前面。认全栏任意位置会让「批 N:…(批 N+1 再做)」替下一批抵账。
//     反序写法会把量词「16 批遗留」也读成批号标记:它若排在本批标记之前,那一行就不抵本批(误拦方向,须把本批号写在前面)。
//   · 无后缀批号覆盖带后缀批号:日记行「批 202」抵「202b」(子批常与主批聚合记);反之「批 202b」不抵「202」。
//     范围按数字比,不看后缀(「批 201–203」抵「202b」)。
//   · ADR 只核「编号出现在本批动过的 ADR 里」,不核那张 ADR 写得对不对、是不是 proposed;不核成果那行写得对不对。
//   · 「--clear 才查」只保护调用它的路径:忘了 `--decision`/`--outcome` 时两道检查都不跑(候选发现由 AD 项提示,不拦)。
//   · 路径一律相对**仓根**(与状态文件同一假设:本工具在仓根跑)。
//   · 蓄意规避(手改状态文件删掉 decisions)不计——用户签的代价模型。
const ADR_DIR = "docs/adr";
const DIARY = "docs/product-diary.md";
// `-c core.quotePath=false`:不然非 ASCII 路径被转成带引号的八进制转义,正则对不上整张丢(BP-5)。
const gitRun = (args) => spawnSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
const arr = (x) => (Array.isArray(x) ? x : []);
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 当前 HEAD 的完整 sha;取不到(非 git 仓 / 零提交)⇒ null。 */
export function headCommit(git = gitRun) {
  try {
    const r = git(["rev-parse", "--verify", "HEAD"]);
    const s = String(r?.stdout || "").trim();
    if (r && r.status === 0 && /^[0-9a-f]{7,64}$/i.test(s)) return s;
  } catch { /* 取不到 ⇒ null */ }
  return null;
}

/** 正文里有没有决定编号 `<批号>-D<n>`。精确:`256-D1` 不命中 `256-D10`、`1256-D1`;连字符认半角/全角/各类破折号,大小写不敏感。
 *  前导零不计(批 256b BP-8):`256-D01` = `256-D1`,`092-D1` = `92-D1`。 */
export function hasDecisionId(text, id) {
  const k = String(id).toUpperCase().lastIndexOf("-D");
  if (k <= 0) return false;
  const batch = String(id).slice(0, k), n = String(id).slice(k + 2);
  if (!/^\d+$/.test(n)) return false;
  const bm = batch.match(/^0*(\d+)([A-Za-z]*)$/);
  const bPat = bm ? `0*${bm[1]}${reEsc(bm[2])}` : reEsc(batch);
  // 前缀边界也排除连字符(红队 66803b1 BP-1):`hk-256-D1` 不得替 `256-D1` 抵账
  return new RegExp(`(?<![0-9A-Za-z\-])${bPat}\\s*[-‐‑–—－]\\s*D0*${Number(n)}(?![0-9])`, "i").test(String(text || ""));
}

/** ADR 正文是否**声明**了这个编号(批 256b BP-1):编号所在行须含「决定编号」或「取代」。
 *  批 285(D140⑧,误拦):照模板写也会被拒的三形当场放行——①全角数字「２５６-D1」(先过 normWidth 再判);
 *  ②「决定编号:」行本身不带编号、编号分列在紧接着的列表行(须比标签行缩进更深,标签行不是列表项时任意缩进;
 *  空行或非列表行即止);③表头格写「决定编号」、编号写在下面数据行的**同一列**(连续表格行,分隔行跳过)。
 *  只放宽、不收紧:任何此前算已声明的写法照旧算。代价(漏放面,按用户取舍不修):列表 / 同列里顺带写的兄弟编号
 *  也算已声明,与 D140⑦ 同族。 */
export function adrDeclaresId(text, id) {
  const lines = normWidth(text).split(/\r?\n/);
  const LABEL = /决定编号|取代/;
  const HAS_ID = /\d+\s*[-‐‑–—－]\s*D\d/i;
  const LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
  const cellsOf = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!LABEL.test(l)) continue;
    if (hasDecisionId(l, id)) return true;
    if (/^\s*\|/.test(l)) {
      // ③ 表头:取含「决定编号」的那一格的列号,往下扫连续表格行的同一列
      const col = cellsOf(l).findIndex((c) => /决定编号/.test(c));
      if (col < 0) continue;
      for (let j = i + 1; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
        const cells = cellsOf(lines[j]);
        if (cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c))) continue;
        if (hasDecisionId(cells[col] ?? "", id)) return true;
      }
      continue;
    }
    if (HAS_ID.test(l) || !/决定编号/.test(l)) continue;   // ② 只在「决定编号」标签行本身不带编号时往下并
    const lm = l.match(LIST);
    const baseIndent = lm ? lm[1].length : -1;
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(LIST);
      if (!m || m[1].length <= baseIndent) break;
      if (hasDecisionId(lines[j], id)) return true;
    }
  }
  return false;
}

/** 编号尾部的 D 号(`256-D07` ⇒ 7);不是编号 ⇒ 0。 */
export function decisionNo(id) {
  const m = String(id ?? "").match(/-D0*(\d+)$/i);
  return m ? Number(m[1]) : 0;
}

/** 台账里该批号已用过的最大 D 号(登记行与撤回行都算,批 256b BP-2)。台账不存在 ⇒ 0;读不了 ⇒ 抛(调用方拒登记)。 */
/** 批 278(D173①):这个批号是否已在台账里**结清过**(按去前导零、不分大小写比,同 maxDecisionNoInJournal)。
 *  实撞:两个会话共用本仓台账,会话乙 `--arm 277` 时会话甲的 277 已结清 ⇒ 台账里两笔不同条件的 277,
 *  lanes 等读者按批号显示,把乙那笔未结清的 277 当成甲已结清的批「还挂着」。台账读不了 ⇒ 抛(调用方 fail-closed 拒武装)。 */
export function batchClearedBefore(batch, file = JOURNAL) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e?.code === "ENOENT") return false; throw new Error(`台账读不了(${e?.code || e?.message}):${file}`); }
  const nb = (x) => String(x ?? "").replace(/^0+(?=\d)/, "").toLowerCase();
  for (const l of raw.split("\n")) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o && o.action === "clear" && nb(o.batch) === nb(batch)) return true;
  }
  return false;
}

export function maxDecisionNoInJournal(batch, file = JOURNAL) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e?.code === "ENOENT") return 0; throw new Error(`台账读不了(${e?.code || e?.message}):${file}`); }
  let max = 0;
  for (const l of raw.split("\n")) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    // codex 256b 发现 A/B:①登记行写台账失败时(锁超时等,登记照样成功),那条 D 号只活在后来 clear 行的 decisions 里 ⇒ 一并扫;
    //   ②批号按去前导零比(0705 与 705 同一命名空间),与 hasDecisionId 的编号等价口径一致。
    const nb = (x) => String(x ?? "").replace(/^0+(?=\d)/, "").toLowerCase();   // 去前导零、不分大小写(红队 b0d1aa6 BP-2);与 hasDecisionId 在常规批号(数字加字母后缀)上同口径,带连字符的批号这里偏宽(只会跳号不会撞号)
    if (!o || nb(o.batch) !== nb(batch)) continue;
    if (o.action === "decision" || o.action === "withdraw") max = Math.max(max, decisionNo(o.id));
    else if (o.action === "clear" || o.action === "force-over-obligations") for (const d of [].concat(o.decisions || [], o.withdrawn || [])) max = Math.max(max, decisionNo(d?.id ?? d));
  }
  return max;
}

/** 成果补上定死的序号 n(旧状态没有 n ⇒ 按位置 1..k 补)。 */
const numberOutcomes = (list) => arr(list).map((o, k) => ({ ...o, n: Number.isInteger(o?.n) && o.n > 0 ? o.n : k + 1 }));

/** 全角数字/字母/加号/斜杠 ⇒ 半角(批 256b BP-7)。 */
const normWidth = (s) => String(s || "").replace(/[０-９Ａ-Ｚａ-ｚ＋／]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/** 批号 → {n, suf};不是「数字+字母后缀」形 ⇒ {raw}。前导零不计(`092` = `92`)。 */
export function parseBatchId(s) {
  const m = String(s ?? "").trim().match(/^0*(\d+)([A-Za-z]*)$/);
  return m ? { n: Number(m[1]), suf: m[2].toLowerCase() } : { raw: String(s ?? "").trim() };
}

/** 一个事项栏里**第一个**批号标记 → [{lo, hi?}];没有 ⇒ null。认 `批 186–187`、`批 202/202b`、`批 211、213`,
 *  批 256b(BP-7)起再认 `批 255 与 256` / `和` / `+`、反序 `256 批` / `255、256 批`,全角数字先归一。
 *  正序与反序都出现时取**位置靠前**的那个。 */
const D_ID = "\\d+[A-Za-z]*";
// 批 285(D140⑧,误拦):日记连接词再认「及 / 以及」(「批 255 及 256」照模板写也被拒)
const D_LIST = `${D_ID}(?:\\s*(?:[–—~～\\-/、,,+]|与|和|以及|及)\\s*${D_ID})*`;
const RE_DESIG_FWD = new RegExp(`批\\s*(${D_LIST})`);
const RE_DESIG_REV = new RegExp(`(?<![0-9A-Za-z])(${D_LIST})\\s*批`);
export function parseDesignator(cell) {
  const s = normWidth(cell);
  const f = RE_DESIG_FWD.exec(s), r = RE_DESIG_REV.exec(s);
  const m = f && r ? (r.index < f.index ? r : f) : (f || r);
  if (!m) return null;
  const items = [];
  let pendingRange = false;
  for (const t of m[1].matchAll(/(\d+[A-Za-z]*)|([–—~～-])|([/、,,+]|与|和|以及|及)/g)) {
    if (t[1]) {
      const id = parseBatchId(t[1]);
      if (pendingRange && items.length) items[items.length - 1].hi = id; else items.push({ lo: id });
      pendingRange = false;
    } else if (t[2]) pendingRange = true;
    else pendingRange = false;
  }
  return items;
}

/** 日记里有没有一行的事项栏覆盖本批号(规则见上方 ③ 与残余)。 */
export function diaryHasBatch(md, batch) {
  const b = parseBatchId(batch);
  for (const line of String(md || "").split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (cells.length < 2 || /^\s*:?-{3,}/.test(cells[0])) continue;
    const cell = normWidth(cells[1]);
    if (b.raw !== undefined) {
      if (b.raw && new RegExp(`批\\s*${reEsc(b.raw)}(?![0-9A-Za-z])`).test(cell)) return true;
      continue;
    }
    for (const it of parseDesignator(cell) || []) {
      if (it.hi) { if (it.lo.n !== undefined && it.hi.n !== undefined && it.lo.n <= b.n && b.n <= it.hi.n) return true; continue; }
      if (it.lo.n === b.n && (it.lo.suf === b.suf || it.lo.suf === "")) return true;
    }
  }
  return false;
}

/** ADR 覆盖:返回 {missing, notes} 或 {unknown, why}。git 可注入(自测)。 */
export function adrCoverage(decisions, baseCommit, git = gitRun) {
  const ids = arr(decisions).map((d) => d && d.id).filter((x) => typeof x === "string" && x);
  if (!ids.length) return { missing: [], notes: [] };
  const notes = [];
  let files = null;
  // 路径列表一律 `-z`(NUL 分隔、不转义;gitRun 另带 core.quotePath=false)——BP-5:中文短名 ADR 曾被转义丢掉。
  const splitZ = (s) => String(s || "").split("\0").map((x) => x.replace(/^\r?\n|\r?\n$/g, "")).filter(Boolean);
  if (typeof baseCommit === "string" && baseCommit) {
    let r; try { r = git(["diff", "--name-only", "-z", "--diff-filter=AMR", "-M", baseCommit, "HEAD", "--", ADR_DIR]); } catch { r = null; }
    if (r && r.status === 0) files = splitZ(r.stdout);
    else notes.push(`基点 ${baseCommit.slice(0, 10)} 在本仓取不到(换过分支或改写过历史?)——退回在 HEAD 的全部 ADR 里找编号`);
  } else notes.push("本批武装时没记基点(早于批 256 的武装)——退回在 HEAD 的全部 ADR 里找编号");
  if (files === null) {
    let r; try { r = git(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ADR_DIR]); } catch (e) { return { unknown: true, why: e.message }; }
    if (!r || r.status !== 0) return { unknown: true, why: String(r?.stderr || "git ls-tree 失败").trim() };
    files = splitZ(r.stdout);
  }
  const texts = [];
  for (const f of files.map((x) => x.replace(/\\/g, "/")).filter((x) => /^docs\/adr\/\d{4}-[^/]+\.md$/i.test(x))) {
    // BP-10:show 失败 ⇒ 判不了(unknown,拒清),不当成「这张没写编号」报缺 ADR——报缺会把人引去补一张根本不缺的 ADR。
    let r; try { r = git(["show", `HEAD:${f}`]); } catch (e) { return { unknown: true, why: `git show HEAD:${f} 抛错(${e.message})` }; }
    if (!r || r.status !== 0) return { unknown: true, why: `git show HEAD:${f} 失败(${String(r?.stderr || "").trim() || "无输出"})` };
    texts.push(String(r.stdout || ""));
  }
  return { missing: ids.filter((id) => !texts.some((t) => adrDeclaresId(t, id))), notes };
}

/** 有基点时取 `git diff <基点> HEAD -- 日记` 的新增行(批 256b BP-2);取不到 ⇒ {note}(调用方退回全文)。 */
export function diaryAddedLines(baseCommit, git = gitRun) {
  if (!(typeof baseCommit === "string" && baseCommit)) return { note: `本批武装时没记基点——日记只看全文有没有本批行(同号重开的批可能拿上次那行抵账)` };
  let r; try { r = git(["diff", "--no-color", "--no-ext-diff", "--text", "-U0", baseCommit, "HEAD", "--", DIARY])  /* --text:codex 256b 发现 D,仓里若给日记设了 -diff 属性,不加则只出二进制摘要、零 + 行 ⇒ 误判缺行 */; } catch { r = null; }
  if (!r || r.status !== 0) return { note: `基点 ${baseCommit.slice(0, 10)} 在本仓取不到——日记退回只看全文有没有本批行` };
  return { lines: String(r.stdout || "").split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)) };
}

// 批 276(D177②,用户 2026-10-24「你觉得是把 ADR 管理做成 skill 还是加进闸来的好?自己选吧」⇒ 选闸):
//   原先「登记了决定才核 ADR」——零登记即零核对,改了既有机制的批可以一张 ADR 都不碰就结清(本批实撞:开工至用户发问,
//   `docs/adr/` 零读取、`--decision` 零登记)。补一格:本批基点之后的提交触及**承重面**而零登记 ⇒ 拒清,
//   除非 `--no-decision "<为什么本批没有决定>"` 留一句话(只数格子,不判理由对不对)。
//   承重面 = 汇报法「三通道必跑」的触发面(hook-* / docs/laws / AGENTS.md / .claude 的 agents·skills·commands)∪ 闸引擎(lib/gate-* 与推送钩子);自测文件不算。
//   无基点(早于批 256 的武装)⇒ 跳过并提示;git 判不了 ⇒ unknown 拒清。
//   失效条件:实现后连续 20 个承重面批 `--no-decision` 占比 >80% ⇒ 它成了仪式,复议(D177)。
//   红队 r4 BP-2:原表漏了闸引擎的其余成员(write-effects / fp-audit / gate-replay / gate-deps)与 settings.json、CLAUDE.md、两份寄存器、batch-goal 自身。
const LOAD_BEARING_PATH = /^(?:AGENTS\.md$|CLAUDE\.md$|docs\/laws\/|docs\/(?:constraint|tool)-register\.md$|\.claude\/(?:agents|skills|commands)\/|\.claude\/settings(?:\.[\w-]+)?\.json$|scripts\/hook-[^/]+\.mjs$|scripts\/lib\/(?:gate-[^/]+|write-effects)\.mjs$|scripts\/(?:fp-audit|gate-replay|batch-goal|install-git-hooks)\.mjs$|scripts\/gate-deps\/package(?:-lock)?\.json$|scripts\/git-hooks\/)/i;
export function loadBearingTouched(baseCommit, git = gitRun) {
  if (!(typeof baseCommit === "string" && baseCommit)) return { paths: [], note: "本批武装时没记基点——「承重面零决定」核对跳过" };
  //   --no-renames:改名时两侧路径都列出(红队 r4 BP-4:把 skill 挪出承重面,原先 diff 只剩新路径)
  let r; try { r = git(["diff", "--name-only", "--no-renames", "-z", baseCommit, "HEAD"]); } catch (e) { return { unknown: true, why: e.message }; }
  if (!r || r.status !== 0) return { unknown: true, why: String(r?.stderr || "git diff 失败").trim() || "git diff 失败" };
  const paths = String(r.stdout || "").split("\0").map((x) => x.trim().replace(/\\/g, "/")).filter(Boolean)
    //   红队 r6 BP-20:手抄表只是子集(漏 package.json / verify-laws / perm-match…)⇒ 并上 P 实际用的判据面,不再另抄;
    //   codex 276-r6-fix-audit 附 3:用 isCarrierPath(CARRIER_SURFACE, …)(排除暂存 / 依赖 / 构建区),不用裸 isLoadBearing
    .filter((p) => (LOAD_BEARING_PATH.test(p) || isCarrierPath(CARRIER_SURFACE, p)) && !/\.(?:selftest|test|spec)\.[cm]?[jt]s$/i.test(p));
  return { paths };
}

/** --no-decision 的理由是不是照抄了拒清消息里的模板(红队 r6 BP-23:「决定在批 N」/「<为什么…>」原样贴回)。 */
//   误拦 r7 FB-5:只认消息给过的模板原串,不认任意尖括号(「只改 <details> 折叠块」「Map<string, Node>」是真理由)
export const isTemplateReason = (t) => /批\s*N\b|<为什么本批没有决定>|<那一批的真实批号>|<一句话>|<理由>/.test(String(t || ""));

/** --clear 的检查。io 可注入:{git, readDiary():string|null(不存在=null), adrNames():string[]}。 */
export function obligationCheck(goal, io = {}) {
  const git = io.git || gitRun;
  const out = { notes: [], missingDecisions: [], diaryMissing: false, noDecisionTouched: [], unknown: null };
  const decisions = arr(goal?.decisions), outcomes = arr(goal?.outcomes);
  const unk = [];
  if (decisions.length) {
    const c = adrCoverage(decisions, goal?.baseCommit, git);
    if (c.unknown) unk.push(`ADR 覆盖:${c.why || "git 不可用"}`);
    else { out.notes.push(...c.notes); out.missingDecisions = c.missing; }
  } else if (!goal?.noDecision || isTemplateReason(goal.noDecision.text)) {
    const lb = loadBearingTouched(goal?.baseCommit, git);
    if (lb.unknown) unk.push(`承重面零决定核对:${lb.why}`);
    else { if (lb.note) out.notes.push(lb.note); out.noDecisionTouched = lb.paths; }
  }
  if (outcomes.length) {
    // BP-4:只有 ENOENT 算「这个仓没有日记」;其它读错误判不了 ⇒ unknown 拒清(与 ADR 一侧同口径)。
    let md = null, readErr = null;
    try { md = io.readDiary ? io.readDiary() : fs.readFileSync(DIARY, "utf8"); }
    catch (e) { if (e?.code !== "ENOENT") readErr = e; md = null; }
    if (readErr) unk.push(`日记读不了(${readErr?.code || readErr?.message})`);
    else if (md === null) out.notes.push(`${DIARY} 不存在——成果核对跳过(只提示,不拒清)`);
    else {
      const d = diaryAddedLines(goal?.baseCommit, git);
      if (d.lines) out.diaryMissing = !diaryHasBatch(d.lines.join("\n"), goal?.batch);
      else { out.notes.push(d.note); out.diaryMissing = !diaryHasBatch(md, goal?.batch); }
    }
  }
  if (unk.length) out.unknown = unk.join(";");
  return out;
}

function localDate(d = new Date()) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nextAdrNumber() {
  let max = 0;
  try { for (const f of fs.readdirSync(ADR_DIR)) { const m = f.match(/^(\d{4})-/); if (m) max = Math.max(max, Number(m[1])); } } catch { /* 无目录 ⇒ 0001 */ }
  return String(max + 1).padStart(4, "0");
}
function printObligationRefusal(goal, obl) {
  const batch = goal?.batch;
  if (obl.noDecisionTouched.length) {
    console.error(`拒绝结清:本批基点到 HEAD 之间触及承重面(${obl.noDecisionTouched.slice(0, 5).join("、")}${obl.noDecisionTouched.length > 5 ? ` 等 ${obl.noDecisionTouched.length} 个` : ""};按树差判,含合并带入的别批改动),却一条决定都没登记(D177)。`);
    console.error(`  若这些改动是合并带入、不是本批做的(另一会话的批里已登记过决定),\`--no-decision "合并带入,决定在批 <那一批的真实批号>"\` 即可(占位原样贴回会被拒)。`);
    console.error(`  先翻 ${ADR_DIR}/README.md:本批是否改了某张 ADR 记载的决定?改了 ⇒ \`--decision "<一句话>"\` 登记并写 / 改 ADR;`);
    console.error(`  确实没有决定(纯修笔误、只补测试……)⇒ \`--no-decision "<为什么本批没有决定>"\`,再 --clear。`);
  }
  if (obl.missingDecisions.length) {
    const byId = new Map(arr(goal?.decisions).map((d) => [d.id, d.text]));
    console.error(`拒绝结清:${obl.missingDecisions.length} 个已登记决定还没有 ADR —— 缺:${obl.missingDecisions.join("、")}`);
    console.error(`  判据:编号要出现在基点 ${goal?.baseCommit ? String(goal.baseCommit).slice(0, 10) : "(无,退回全部 ADR)"}..HEAD 范围内新增或修改的 ${ADR_DIR}/NNNN-*.md 正文里,且已提交。`);
    let num = Number(nextAdrNumber());
    for (const id of obl.missingDecisions) {
      const n = String(num++).padStart(4, "0");
      console.error(`  ── ${id}「${String(byId.get(id) || "").slice(0, 60)}」可新写一张(状态只许 proposed,accepted 须用户签):`);
      console.error(`    ${ADR_DIR}/${n}-<短名>.md`);
      console.error(`      # ${n} — ${String(byId.get(id) || "<决定一句话>").slice(0, 60)}`);
      console.error(`      - 状态:proposed`);
      console.error(`      - 决定编号:${id}`);
      console.error(`      - 日期:${localDate()}`);
      console.error(`    或在被它推翻的旧 ADR 上加一行:「被 ${id} 取代」。`);
    }
  }
  if (obl.diaryMissing) {
    const head = headCommit();
    const outcome = String(arr(goal?.outcomes)[0]?.text || "<可见成果一句话>").replace(/\|/g, "/").slice(0, 80);
    console.error(`拒绝结清:本批登记了 ${arr(goal?.outcomes).length} 项可见成果,而 ${DIARY} 里没有一行的事项栏第一个批号标记是「批 ${batch}」(或范围/合并写法含本批)` +
      `${goal?.baseCommit ? `——有基点时只认基点 ${String(goal.baseCommit).slice(0, 10)} 之后新增并已提交的行` : ""}。`);
    console.error(`  可复制到表尾的一行(证据换成本批 commit 短哈希或 clipboard/ 报告路径):`);
    console.error(`  | ${localDate()} | 批 ${batch}:${outcome} | <一句话结果> | \`${head ? head.slice(0, 7) : "<commit 短哈希>"}\` |`);
  }
  console.error(`出路:补好、提交,再 --clear。登记错了的决定/成果用 --withdraw <编号|O序号> --reason "<理由>" 撤回(记台账),不得靠改状态文件删。`);
}

/** --decision / --outcome 共用:往未结清的当前批追加一项。 */
function appendItem(kind, argv) {
  const flag = kind === "decision" ? "--decision" : "--outcome";
  const i = argv.indexOf(flag);
  const text = argv[i + 1];
  const extra = argv.filter((a, k) => k !== i && k !== i + 1);
  if (text === undefined || !String(text).trim() || /^--/.test(text)) { console.error(`用法: ${flag} "<一句话>"(缺值、为空或以 -- 开头)`); process.exit(2); }
  if (extra.length) { console.error(`用法错误:${flag} 只收一个值,多余参数:${extra.join(" ")}`); process.exit(2); }
  let cur;
  try { cur = load(); } catch (e) { console.error(`拒绝登记:${e.message}`); process.exit(2); }
  if (!cur || cur.cleared || !Array.isArray(cur.conditions) || !cur.conditions.length) {
    console.error(`拒绝登记:盘上没有未结清的批。先 --arm <批号> --cond …,再 ${flag}。`); process.exit(2);
  }
  const key = kind === "decision" ? "decisions" : "outcomes";
  const withdrawn = arr(cur.withdrawn);
  let item;
  if (kind === "decision") {
    // BP-2:编号接着「台账里该批号用过的最大 D 号」与盘上清单(含已撤)往上数——同号重开不从 D1 重来,撤回的编号不复用。
    let used;
    try { used = maxDecisionNoInJournal(cur.batch); } catch (e) { console.error(`拒绝登记:${e.message}——取不到已用编号就可能撞号`); process.exit(2); }
    for (const d of [...arr(cur.decisions), ...withdrawn.filter((w) => w?.kind === "decision")]) used = Math.max(used, decisionNo(d?.id));
    item = { id: `${cur.batch}-D${used + 1}`, text: String(text), at: new Date().toISOString() };
  } else {
    let used = 0;
    for (const o of [...numberOutcomes(cur.outcomes), ...withdrawn.filter((w) => w?.kind === "outcome")]) used = Math.max(used, Number(o?.n) || 0);
    item = { n: used + 1, text: String(text), at: new Date().toISOString() };
  }
  const list = (kind === "outcome" ? numberOutcomes(cur[key]) : arr(cur[key]).slice());
  list.push(item);
  try { atomicWrite({ ...cur, [key]: list }, Number(cur.version) || 0); } catch (e) { console.error(e.message); process.exit(2); }
  journal(kind, { batch: cur.batch, ...item });
  if (kind === "decision") console.log(`已登记决定 ${item.id}:${item.text}\n  --clear 时要求 ${ADR_DIR}/NNNN-*.md(本批基点之后新增或修改)里有一行「决定编号:${item.id}」或「被 ${item.id} 取代」。`);
  else console.log(`已登记可见成果 O${item.n}:${item.text}\n  --clear 时要求 ${DIARY} 有一行(基点之后新增)的事项栏第一个批号标记是「批 ${cur.batch}」(文件不存在则只提示)。`);
  process.exit(0);
}

/** `--withdraw <批号-Dn | On> --reason "<理由>"`(批 256b BP-9):把误登记的一项挪进 withdrawn,台账记 withdraw 行。 */
export function parseWithdraw(argv) {
  const i = argv.indexOf("--withdraw"), j = argv.indexOf("--reason");
  const target = argv[i + 1], reason = j >= 0 ? argv[j + 1] : undefined;
  if (target === undefined || !String(target).trim() || /^--/.test(target)) throw new Error("--withdraw 缺编号(决定写 <批号>-D<n>,成果写 O<n>)");
  if (j < 0 || reason === undefined || !String(reason).trim() || /^--/.test(reason)) throw new Error("--withdraw 必须带 --reason \"<理由>\"(非空)");
  const extra = argv.filter((a, k) => ![i, i + 1, j, j + 1].includes(k));
  if (extra.length) throw new Error(`--withdraw 多余参数:${extra.join(" ")}`);
  return { target: String(target).trim(), reason: String(reason).trim() };
}
/** 在批状态里定位要撤的项。返回 {kind, index} 或 {error}。纯函数(自测用)。 */
export function locateWithdraw(cur, target) {
  const o = String(target).match(/^O0*(\d+)$/i);
  if (o) {
    const list = numberOutcomes(cur?.outcomes);
    const k = list.findIndex((x) => x.n === Number(o[1]));
    return k >= 0 ? { kind: "outcome", index: k, list } : { error: `本批没有在册的成果 O${o[1]}(在册:${list.map((x) => "O" + x.n).join("、") || "无"})` };
  }
  const list = arr(cur?.decisions);
  const n = decisionNo(target);
  const k = n ? list.findIndex((d) => decisionNo(d?.id) === n && hasDecisionId(String(d?.id), target)) : -1;
  return k >= 0 ? { kind: "decision", index: k, list } : { error: `本批没有在册的决定「${target}」(在册:${list.map((d) => d.id).join("、") || "无"})` };
}
function withdrawItem(argv) {
  let a;
  try { a = parseWithdraw(argv); } catch (e) { console.error(`用法错误:${e.message}`); process.exit(2); }
  let cur;
  try { cur = load(); } catch (e) { console.error(`拒绝撤回:${e.message}`); process.exit(2); }
  if (!cur || cur.cleared || !Array.isArray(cur.conditions) || !cur.conditions.length) { console.error("拒绝撤回:盘上没有未结清的批。"); process.exit(2); }
  const loc = locateWithdraw(cur, a.target);
  if (loc.error) { console.error(`拒绝撤回:${loc.error}`); process.exit(2); }
  const item = loc.list[loc.index];
  const rest = loc.list.filter((_, k) => k !== loc.index);
  const w = { kind: loc.kind, ...item, reason: a.reason, withdrawnAt: new Date().toISOString() };
  const key = loc.kind === "decision" ? "decisions" : "outcomes";
  try { atomicWrite({ ...cur, [key]: rest, withdrawn: [...arr(cur.withdrawn), w] }, Number(cur.version) || 0); } catch (e) { console.error(e.message); process.exit(2); }
  const label = loc.kind === "decision" ? item.id : `O${item.n}`;
  journal("withdraw", { batch: cur.batch, kind: loc.kind, ...(loc.kind === "decision" ? { id: item.id } : { o: label }), text: item.text, reason: a.reason });
  console.log(`已撤回${loc.kind === "decision" ? "决定" : "成果"} ${label}「${String(item.text || "").slice(0, 60)}」——理由:${a.reason}\n  --clear 不再核它;台账留 withdraw 行;编号/序号不复用。`);
  process.exit(0);
}

/** 批 284(交接单 20261028 第一条,某会话 实撞):欠账表 docs/gate-debts.md 的结构核。
 *  那次是一笔提交里整段纯插入 113 行 ⇒ 每个 D 号两行、三个小节标题两套;是 `--arm` 吐出的到期清单「每个号两遍」才被人看出来。
 *  现在 --arm / --clear 两个必经点机械查:D 号行重复、`## ` 小节标题重复 ⇒ 红字点名。只报不拦(拦会把开工与结清堵在别人弄坏的表上)。
 *  天花板:只认「重复」这一种坏形;读改写丢更新(某一行整行消失)看不见——那一半靠 Edit 工具的「读后被改即拒写」与本仓 hook 账的
 *  写前重读合并(P 账,批 284)。返回问题描述数组,空 = 无问题。 */
export function debtTableIssues(text) {
  const out = [];
  const count = (re) => {
    const m = new Map();
    for (const l of String(text || "").split(/\r?\n/)) { const k = (re.exec(l) || [])[1]; if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m].filter(([, n]) => n > 1);
  };
  const ids = count(/^\| (D\d+[a-z]?) \|/), heads = count(/^(## .+?)\s*$/);
  if (ids.length) out.push(`${ids.length} 个 D 号出现不止一行(${ids.slice(0, 5).map(([k, n]) => `${k}×${n}`).join(" ")}${ids.length > 5 ? " …" : ""})`);
  if (heads.length) out.push(`${heads.length} 个小节标题重复(${heads.slice(0, 3).map(([k, n]) => `「${k.replace(/^## /, "")}」×${n}`).join(" ")})`);
  return out;
}
/** 批 285(D133):债表一行切成列。反引号代码段里的 `|` 与转义的 `\|` 不是列分隔(坏行里的竖线几乎都出在代码段里),
 *  先换成占位再切、切完还原。返回去掉首尾空串的各列;列数由调用方判(到期腿要求恰为 6)。
 *  天花板:代码段外的裸竖线(描述里直接写 a|b)仍会把行切多——那种行被点名跳过,不猜。 */
export function debtRowCells(line) {
  const P = "\u0001";
  return String(line || "")
    .replace(/`[^`\n]*`/g, (s) => s.replace(/\|/g, P))
    .replace(/\\\|/g, "\\" + P)
    .split("|").slice(1, -1)
    .map((c) => c.split(P).join("|"));
}

/** 到期腿的逐行判定(批 285 D133 从 --arm 分支抽出)。rows = 债表里 `| Dnn |` 起头的行;cur = 本批号(数)。
 *  返回 { mine, yours, colBad }:到期未结的【我做】/【需你裁】条目,与列数异常被跳过的 D 号。 */
export function debtDue(rows, cur) {
  const mine = [], yours = [], colBad = [];
  for (const l of rows) {
    const id = (l.match(/^\| (D\d+) \|/) || [])[1];
    // 批 285(D133):先掩码反引号代码段与 `\|` 再切列(debtRowCells),且列数必须**恰为** 6。
    //   原守卫 `cells.length < 6` 只挡太少不挡太多:描述列里一个代码段竖线(正则、matcher)就把行切多,
    //   第 4 列读到的是描述片段 ⇒ 失效期取不到(静默漏提示)或「已结」字样落进错位格(整行被当已结)。
    //   实测(批 285 当时的债表):190 行里旧切法 33 行不是 6 列,掩码后剩 14 行;那 14 行点名跳过(原来只报个数)。
    //   代价:点名跳过的行仍看不见到期——比读错列安全(不猜)。只是提示层,不阻断。
    let cells = debtRowCells(l);
    // 批 285 收尾:正文里反引号是单数(D129 / D130 实况)时,掩码把成对关系配错、切出 2 列;这时若按裸竖线切恰为 6 列 ⇒ 用它
    if (cells.length !== 6) { const naive = String(l).split("|").slice(1, -1); if (naive.length === 6) cells = naive; }
    if (cells.length !== 6) { colBad.push(id); continue; }   // 列数不对 ⇒ 不猜,点名后跳过
    const expiryCell = cells[3];
    if (/~~[^~]*≤/.test(expiryCell) || /已(修|结|销)/.test(expiryCell)) continue;  // 已结
    const m = expiryCell.match(/≤\s*0?(\d+)/);
    if (!(m && Number.isFinite(cur) && cur > +m[1])) continue;
    (/亲签|呈签|归用户|用户裁/.test(l) ? yours : mine).push(`${id}(≤${m[1]})`);
  }
  return { mine, yours, colBad };
}

function debtTableWarn() {
  try {
    const issues = debtTableIssues(fs.readFileSync("docs/gate-debts.md", "utf8"));
    if (issues.length) console.log(`🔴 欠账表结构坏了(docs/gate-debts.md):${issues.join(";")}——先看 git log -p -- docs/gate-debts.md 找哪笔提交弄坏的,以那笔之前的版本为底重建`);
  } catch { /* 表读不到由到期腿报 */ }
}

function selfTest() {
  const cases = [];
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    cases.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };
  const goal = { batch: "053", conditions: ["九项落地", "逐文件提交", "工作树为空"] };
  t("零确认 ⇒ 三条全 pending", evaluate(goal, "干完了").pending.map((p) => p.n), [1, 2, 3]);
  t("逐条确认 ⇒ 无 pending", evaluate(goal, "条件1:达成\n条件2:达成\n条件3:达成").pending.length, 0);
  t("部分确认", evaluate(goal, "条件1:达成 条件3:不适用").pending.map((p) => p.n), [2]);
  t("笼统完成断言不算确认", evaluate(goal, "三项全部完成").pending.length, 3);
  t("未达成也算对照过", evaluate(goal, "条件1:未达成,原因是…").pending.map((p) => p.n), [2, 3]);
  t("无 goal ⇒ null", evaluate(null, "x"), null);
  {
    const ok = "## 在账欠账\n| # | 欠账 |\n| D103 | a |\n| D104 | b |\n## 已销账\n| D105 | c |\n";
    t("284 欠账表结构:正常表 ⇒ 无问题", debtTableIssues(ok), []);
    t("284 欠账表结构:整段叠了一份 ⇒ 报 D 号与小节重复(某会话 实撞形)", debtTableIssues(ok + ok).length, 2);
    t("284 欠账表结构:只有一个号重复 ⇒ 点名", debtTableIssues(ok + "| D104 | b2 |\n"), ["1 个 D 号出现不止一行(D104×2)"]);
    t("284 欠账表结构:正文里提到 D104 不算行", debtTableIssues(ok + "见 | D104 | 的说明\n"), []);
  }
  t("空条件 ⇒ null", evaluate({ conditions: [] }, "x"), null);
  // ── 批 285(D133):到期腿切列掩码代码段竖线、列数恰为 6、坏行点名 ──
  {
    const okRow = "| D900 | 描述 | 280 | **≤281** | 来源 | 出路 |";
    const codeRow = "| D901 | matcher 写成 `Edit|Write|MultiEdit` 一条 | 280 | **≤281** | 来源 | 出路 |";
    const escRow = "| D902 | 正则 a\\|b 转义 | 280 | **≤281** | 来源 | 出路 |";
    const bareRow = "| D903 | 描述里裸写 a|b | 280 | **≤281** | 来源 | 出路 |";
    const thinRow = "| D904 | 只有三列 | 280 |";
    t("285 D133:正常行切出 6 列", debtRowCells(okRow).length, 6);
    // 批 285 收尾:正文反引号是单数 ⇒ 掩码切错,退回裸竖线切法(D129 实况)
    t("285 收尾:单数反引号的行退回裸切法,失效期照取",
      debtDue(["| D900 | 某 `x 的说明 | 285 | **≤280** | 来源 | 出路 |"], 286).mine, ["D900(≤280)"]);
    t("285 D133:代码段里的竖线不切列,失效期列取得到", debtRowCells(codeRow)[3].trim(), "**≤281**");
    t("285 D133:代码段内容切完还原", debtRowCells(codeRow)[1].includes("`Edit|Write|MultiEdit`"), true);
    t("285 D133:转义的 \\| 不切列", debtRowCells(escRow).length, 6);
    const r = debtDue([okRow, codeRow, escRow, bareRow, thinRow], 285);
    t("285 D133:代码段 / 转义行照常判到期", r.mine, ["D900(≤281)", "D901(≤281)", "D902(≤281)"]);
    t("285 D133:列数太多与太少的坏行都点名跳过(原守卫只挡太少)", r.colBad, ["D903", "D904"]);
    // 旧切法下这行的第 4 列是「批」列(含「已结」字样)⇒ 整行被当已结;掩码后第 4 列才是真失效期
    const shiftRow = "| D905 | 描述 `a|b` | 已结过一轮的 270 | **≤281** | 来源 | x |";
    t("285 D133:对照——旧切法第 4 列读到错位格", shiftRow.split("|").slice(1, -1)[3].trim(), "已结过一轮的 270");
    t("285 D133:掩码后不再被错位格的「已结」当成已结", debtDue([shiftRow], 285).mine, ["D905(≤281)"]);
  }
  // ⚠️ **「结清后再武装」这条序列此前零覆盖**(2026-08-20 实撞后补)。
  //   为修 grill E6 我让 `--clear` 把批号写进状态文件 ⇒ 结清后是 `{cleared:true, batch:"073"}`;
  //   而 `--arm` 的守卫只判 `cur.batch` 存在,于是**结清之后再 --arm 当场崩**
  //   (`cur.conditions` 是 undefined,读 `.length` 抛 TypeError)。
  //   而自测**修前修后都是 7/7** —— 它从没走过这条路。
  //   本组三条把守卫的判据本身钉住,而不只是钉 `evaluate`。
  const blocks = (cur, batch) => !!(cur && cur.batch && !cur.cleared && cur.batch !== batch);
  t("已结清 + 换批号 ⇒ **放行**(不是拒绝)", blocks({ cleared: true, batch: "073" }, "074"), false);
  t("未结清 + 换批号 ⇒ 拒绝", blocks({ batch: "073", conditions: ["x"] }, "074"), true);
  t("未结清 + 同批号 ⇒ 放行(重武装同一批)", blocks({ batch: "073", conditions: ["x"] }, "073"), false);
  // ── D98-③ 可执行判据 ──
  t("check 挂到它前面最近的 cond", parseArm(["--arm", "170", "--cond", "甲", "--cond", "乙", "--check", "c2", "--expect", "okay"]),
    { conds: ["甲", "乙"], checks: [{ i: 1, cmd: "c2", expect: "okay" }] });
  t("check 在任何 cond 之前 ⇒ 抛", (() => { try { parseArm(["--check", "x"]); return "no-throw"; } catch { return "throw"; } })(), "throw");
  const fake = (m) => (cmd) => m[cmd] || { status: 1, stdout: "", stderr: "unknown" };
  const g = { conditions: ["a", "b"], checks: [{ i: 0, cmd: "ok-cmd", expect: "218." }, { i: 1, cmd: "bad-cmd" }] };
  t("退出 0 且含 expect ⇒ 过;退出非 0 ⇒ 拒", runChecks(g, fake({ "ok-cmd": { status: 0, stdout: "218.83" }, "bad-cmd": { status: 1, stdout: "" } })).map((f) => f.i), [1]);
  t("退出 0 但 stdout 不含 expect ⇒ 拒", runChecks(g, fake({ "ok-cmd": { status: 0, stdout: "moov atom not found" }, "bad-cmd": { status: 0 } })).map((f) => f.i), [0]);
  t("无 check ⇒ 空失败表(旧批不受影响)", runChecks({ conditions: ["a"] }, fake({})), []);
  t("真跑:node 退出 1 被判失败", runChecks({ conditions: ["a"], checks: [{ i: 0, cmd: `node -e "process.exit(1)"` }] }).length, 1);
  t("真跑:node 打印 ok 且期待 ok ⇒ 过", runChecks({ conditions: ["a"], checks: [{ i: 0, cmd: `node -e "console.log('ok')"`, expect: "ok" }] }).length, 0);
  // ── 双审后加固 ──
  const throws = (args) => { try { parseArm(args); return "no-throw"; } catch { return "throw"; } };
  t("未知 flag 拼错 ⇒ 抛(不再静默跳过)", throws(["--cond", "a", "--chek", "x"]), "throw");
  t("空 expect ⇒ 抛", throws(["--cond", "a", "--check", "x", "--expect", ""]), "throw");
  t("expect <4 字符 ⇒ 抛(宽子串)", throws(["--cond", "a", "--check", "x", "--expect", "0"]), "throw");
  t("值以 -- 开头(漏写值)⇒ 抛", throws(["--cond", "--check", "x"]), "throw");
  t("重复 expect ⇒ 抛", throws(["--cond", "a", "--check", "x", "--expect", "1", "--expect", "2"]), "throw");
  t("--expect-re 解析", parseArm(["--cond", "a", "--check", "x", "--expect-re", "^duration=218"]).checks[0].expectRe, "^duration=218");
  t("expect 匹配面含 stderr", runChecks({ conditions: ["a"], checks: [{ i: 0, cmd: "x", expect: "moov" }] }, () => ({ status: 0, stdout: "", stderr: "moov atom not found" })).length, 0);
  t("expectRe 不匹配 ⇒ 拒", runChecks({ conditions: ["a"], checks: [{ i: 0, cmd: "x", expectRe: "^dur=218" }] }, () => ({ status: 0, stdout: "dur=1218.8" })).length, 1);
  // ── D116:结清前工作树必须干净 ──
  t("porcelain:已修改与已暂存计入,未跟踪不计", uncommittedTracked(" M a.txt\nA  b.txt\n?? c.txt\n"), ["a.txt", "b.txt"]);
  t("porcelain:空输出 ⇒ 空表", uncommittedTracked(""), []);
  t("执行器:git 成功且干净 ⇒ 不脏", worktreeState(() => ({ status: 0, stdout: "" })), { unknown: false, paths: [] });
  t("执行器:git 非零退出 ⇒ unknown(fail-closed)", worktreeState(() => ({ status: 128, stdout: "", stderr: "not a git repository" })).unknown, true);
  t("执行器:git 抛异常 ⇒ unknown", worktreeState(() => { throw new Error("ENOENT"); }).unknown, true);
  t("checks 不是数组 ⇒ 当失败(fail-closed)", runChecks({ conditions: ["a"], checks: "ls" }, fake({})).length, 1);
  t("check 真经 bash:$() 会展开", runChecks({ conditions: ["a"], checks: [{ i: 0, cmd: "echo size=$(echo 42)", expect: "size=42" }] }).length, 0);
  t("同批重武装内容不同 ⇒ armChanged", armChanged({ conditions: ["a"], checks: [{ i: 0, cmd: "x" }] }, ["a"], []), true);
  t("同批逐字相同 ⇒ 不算改", armChanged({ conditions: ["a"], checks: [] }, ["a"], []), false);
  t("判据与台账不一致 ⇒ 拒", checksMatchJournal({ checks: [{ i: 0, cmd: "x" }] }, { checks: [{ i: 0, cmd: "y" }] }), false);
  // ── 批 256:决定编号 / 日记批号 / ADR 覆盖(纯函数)──
  t("编号精确:256-D1 命中", hasDecisionId("- 决定编号:256-D1\n", "256-D1"), true);
  t("编号精确:256-D10 不抵 256-D1", hasDecisionId("被 256-D10 取代", "256-D1"), false);
  t("编号精确:1256-D1 不抵 256-D1", hasDecisionId("1256-D1", "256-D1"), false);
  t("编号:全角连字符与小写也认", hasDecisionId("被 256－d2 取代", "256-D2"), true);
  t("日记:批 21 不命中 批 210", diaryHasBatch("| 2026-09-15 | 批 210:x | y | `abc` |", "21"), false);
  t("日记:批 210 精确命中", diaryHasBatch("| 2026-09-15 | 批 210:x | y | `abc` |", "210"), true);
  t("日记:范围 186–187 含 187", diaryHasBatch("| d | 批 186–187:P | y | e |", "187"), true);
  t("日记:范围 186–187 不含 188", diaryHasBatch("| d | 批 186–187:P | y | e |", "188"), false);
  t("日记:合并写法 202/202b 含 202b", diaryHasBatch("| d | 批 202/202b:x | y | e |", "202b"), true);
  t("日记:前导零 批 092 抵 92", diaryHasBatch("| d | 批 092:16 条 | y | e |", "92"), true);
  t("日记:只认事项栏第一个批号(批 207 行里提到的批 206 不抵 206)", diaryHasBatch("| d | 批 207:进入编辑态(批 206 的逆向) | y | e |", "206"), false);
  t("日记:批号写在事项后部也认(第一个)", diaryHasBatch("| d | ADR 与日志闸(批 256) | y | e |", "256"), true);
  t("日记:批 255——isNew 不被破折号读成范围", diaryHasBatch("| d | 批 255——isNew | y | e |", "256"), false);
  t("日记:批号只出现在证据栏不算", diaryHasBatch("| d | 闸修补 | y | 批 256 的 commit |", "256"), false);
  t("日记:无后缀行抵带后缀批", diaryHasBatch("| d | 批 202:x | y | e |", "202b"), true);
  t("日记:带后缀行不抵无后缀批", diaryHasBatch("| d | 批 202b:x | y | e |", "202"), false);
  const fakeGit = (files, diffOk = true) => (args) => {
    if (args[0] === "diff") return diffOk ? { status: 0, stdout: Object.keys(files).filter((f) => !f.startsWith("old:")).join("\0") } : { status: 128, stdout: "", stderr: "bad object" };
    if (args[0] === "ls-tree") return { status: 0, stdout: Object.keys(files).map((f) => f.replace(/^old:/, "")).join("\0") };
    if (args[0] === "show") { const p = args[1].slice(5); return p in files ? { status: 0, stdout: files[p] } : ("old:" + p) in files ? { status: 0, stdout: files["old:" + p] } : { status: 128, stdout: "" }; }
    return { status: 1, stdout: "" };
  };
  const dec = [{ id: "256-D1", text: "甲" }, { id: "256-D2", text: "乙" }];
  t("ADR:范围内一张写了 D1 ⇒ 只缺 D2", adrCoverage(dec, "abc1234", fakeGit({ "docs/adr/0009-a.md": "决定编号:256-D1" })).missing, ["256-D2"]);
  t("ADR:范围外的旧 ADR 写了编号不算", adrCoverage(dec.slice(0, 1), "abc1234", fakeGit({ "old:docs/adr/0003-x.md": "256-D1" })).missing, ["256-D1"]);
  t("ADR:README 不算 ADR", adrCoverage(dec.slice(0, 1), "abc1234", fakeGit({ "docs/adr/README.md": "256-D1" })).missing, ["256-D1"]);
  t("ADR:无基点 ⇒ 退回全部 ADR(范围外也认)并出声", (() => { const r = adrCoverage(dec.slice(0, 1), null, fakeGit({ "old:docs/adr/0003-x.md": "被 256-D1 取代" })); return [r.missing, r.notes.length]; })(), [[], 1]);
  t("ADR:基点对象不在 ⇒ 退回全部 ADR", adrCoverage(dec.slice(0, 1), "dead", fakeGit({ "old:docs/adr/0003-x.md": "- 决定编号:256-D1" }, false)).missing, []);
  // ── 批 256b(红队回件 BP-1…BP-10)纯函数 ──
  t("BP-1:顺带提及(另见 256-D2(待写))不算声明", adrCoverage(dec, "abc1234", fakeGit({ "docs/adr/0009-a.md": "- 决定编号:256-D1\n另见 256-D2(待写)\n" })).missing, ["256-D2"]);
  t("BP-1:「被 X 部分取代」算声明", adrDeclaresId("- **部分取代**:一句被 256-D6(ADR 0014)部分取代", "256-D6"), true);
  t("BP-1:同一行「决定编号」列多个编号都算", adrDeclaresId("- 决定编号:256-D1、256-D2", "256-D2"), true);
  // 批 285(D140⑧):三形误拦当场放行;反例钉「只放宽到所列形态」
  t("D140⑧:全角数字「２５６-D1」算声明", adrDeclaresId("- 决定编号:２５６-D1", "256-D1"), true);
  t("D140⑧:编号分列在下一行列表项", adrDeclaresId("决定编号:\n- 256-D1\n- 256-D2\n", "256-D2"), true);
  t("D140⑧:标签行是列表项、编号在更深一层", adrDeclaresId("- 决定编号:\n  - 256-D1\n", "256-D1"), true);
  t("D140⑧ 反例:同级的下一条列表项不并进来", adrDeclaresId("- 决定编号:\n- 另见 256-D2(待写)\n", "256-D2"), false);
  t("D140⑧ 反例:空行之后的列表不并进来", adrDeclaresId("决定编号:\n\n- 256-D2\n", "256-D2"), false);
  t("D140⑧ 反例:标签行已带编号时下一行列表不并进来", adrDeclaresId("决定编号:256-D1\n- 另见 256-D2\n", "256-D2"), false);
  t("D140⑧:表头「决定编号」列、编号在数据行同列", adrDeclaresId("| 决定编号 | 内容 |\n|---|---|\n| 256-D1 | 甲 |\n| 256-D2 | 乙 |\n", "256-D2"), true);
  t("D140⑧ 反例:编号在数据行的别的列不算", adrDeclaresId("| 决定编号 | 内容 |\n|---|---|\n| 256-D1 | 另见 256-D2 |\n", "256-D2"), false);
  t("BP-5:-z 输出里多张 ADR(含中文名)全都读到", adrCoverage(dec, "abc1234", fakeGit({ "docs/adr/0009-中文.md": "- 决定编号:256-D1", "docs/adr/0010-b.md": "- 决定编号:256-D2" })).missing, []);
  t("BP-8:256-D01 认作 256-D1", hasDecisionId("- 决定编号:256-D01", "256-D1"), true);
  t("BP-8:256-D01 仍不抵 256-D10", hasDecisionId("- 决定编号:256-D01", "256-D10"), false);
  t("BP-8:批号前导零 092-D1 认作 92-D1", hasDecisionId("- 决定编号:092-D1", "92-D1"), true);
  // 续排编号回归钉(codex 256b 发现 A/B + 红队 b0d1aa6 BP-1/BP-2):临时台账文件,不碰真台账
  {
    const jf = path.join(os.tmpdir(), `bg-num-${process.pid}.jsonl`);
    const put = (rows) => fs.writeFileSync(jf, rows.map((r) => JSON.stringify(r) + "\n").join(""));
    put([{ action: "arm", batch: "703" }, { action: "clear", batch: "703", decisions: [{ id: "703-D1" }] }]);
    t("续排 A:登记行没写进台账、只在 clear 行里 ⇒ 仍算已用", maxDecisionNoInJournal("703", jf), 1);
    put([{ action: "decision", batch: "0705", id: "0705-D1" }]);
    t("续排 B:前导零同号", maxDecisionNoInJournal("705", jf), 1);
    put([{ action: "decision", batch: "256b", id: "256b-D1" }]);
    t("续排 BP-2:后缀大小写同号", maxDecisionNoInJournal("256B", jf), 1);
    put([{ action: "force-over-obligations", batch: "703", newBatch: "704", decisions: [{ id: "703-D1" }] }]);
    t("续排 BP-1:被 --force 盖掉的批,D 号在 force-over-obligations 行", maxDecisionNoInJournal("703", jf), 1);
    put([{ action: "decision", batch: "1", id: "1-D3" }]);
    t("续排:批 1 与批 10 不串号", maxDecisionNoInJournal("10", jf), 0);
    t("编号边界:hk-256-D1 不替 256-D1 抵账", hasDecisionId("- 决定编号:hk-256-D1", "256-D1"), false);
    t("编号边界:本批自己的带连字符批号照认", hasDecisionId("- 决定编号:hk-256-D1", "hk-256-D1"), true);
    try { fs.rmSync(jf, { force: true }); } catch { /* 清理失败不影响判定 */ }
  }
  t("BP-10:git show 失败 ⇒ unknown,不报缺", (() => { const r = adrCoverage(dec.slice(0, 1), "abc1234", (a) => a[0] === "diff" ? { status: 0, stdout: "docs/adr/0009-a.md\0" } : { status: 128, stdout: "", stderr: "bad object" }); return [!!r.unknown, r.missing]; })(), [true, undefined]);
  t("BP-7:反序「256 批」认", diaryHasBatch("| d | 256 批:x | y | e |", "256"), true);
  t("BP-7:「批 255 与 256」含 256", diaryHasBatch("| d | 批 255 与 256:x | y | e |", "256"), true);
  t("BP-7:「批 255 和 256」「批 255+256」含 256", [diaryHasBatch("| d | 批 255 和 256:x | y | e |", "256"), diaryHasBatch("| d | 批 255+256:x | y | e |", "256")], [true, true]);
  t("BP-7:反序合并「255、256 批」含 256", diaryHasBatch("| d | 255、256 批:x | y | e |", "256"), true);
  t("BP-7:全角数字「批２５６」归一", diaryHasBatch("| d | 批２５６:x | y | e |", "256"), true);
  t("D140⑧:「批 255 及 256」「批 255 以及 256」含 256", [diaryHasBatch("| d | 批 255 及 256:x | y | e |", "256"), diaryHasBatch("| d | 批 255 以及 256:x | y | e |", "256")], [true, true]);
  t("D140⑧ 反例:「批 255 及用户讨论 256」不把 256 并进来", diaryHasBatch("| d | 批 255 及用户讨论 256 | y | e |", "256"), false);
  t("BP-7:「批 255 和用户讨论 256」不把 256 并进来", diaryHasBatch("| d | 批 255 和用户讨论 256 | y | e |", "256"), false);
  t("BP-7:正序在前时反序量词不抢位(批 255:回顾 256 批)", diaryHasBatch("| d | 批 255:回顾 256 批 | y | e |", "256"), false);
  t("BP-4:日记读错误(非 ENOENT)⇒ unknown", (() => { const o = obligationCheck({ batch: "256", outcomes: [{ text: "x" }] }, { readDiary: () => { const e = new Error("busy"); e.code = "EBUSY"; throw e; } }); return [!!o.unknown, o.diaryMissing]; })(), [true, false]);
  t("BP-4:日记 ENOENT ⇒ 只提示", (() => { const o = obligationCheck({ batch: "256", outcomes: [{ text: "x" }] }, { readDiary: () => { const e = new Error("no"); e.code = "ENOENT"; throw e; } }); return [!!o.unknown, o.notes.filter((n) => /product-diary|日记/.test(n)).length]; })(), [false, 1]);
  const diffGit = (added) => (a) => a[0] === "diff" ? { status: 0, stdout: `--- a/docs/product-diary.md\n+++ b/docs/product-diary.md\n@@ -9 +9,1 @@\n${added.map((l) => "+" + l).join("\n")}\n` } : { status: 1, stdout: "" };
  t("BP-2:有基点时日记行须在新增行里(旧行不抵)", obligationCheck({ batch: "256", baseCommit: "abc1234", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 256:旧 | y | e |", git: diffGit(["| d | 批 255:别的 | y | e |"]) }).diaryMissing, true);
  t("BP-2:有基点、新增行有本批 ⇒ 过", obligationCheck({ batch: "256", baseCommit: "abc1234", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 256:新 | y | e |", git: diffGit(["| d | 批 256:新 | y | e |"]) }).diaryMissing, false);
  t("BP-2:有基点但 diff 取不到 ⇒ 退回全文并出声", (() => { const o = obligationCheck({ batch: "256", baseCommit: "dead", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 256:x | y | e |", git: () => ({ status: 128, stdout: "" }) }); return [o.diaryMissing, o.notes.length]; })(), [false, 1]);
  t("BP-9:--withdraw 必须带非空 --reason", (() => { try { parseWithdraw(["--withdraw", "256-D1"]); return "no-throw"; } catch { return "throw"; } })(), "throw");
  t("BP-9:定位决定(前导零也认)与成果序号", [locateWithdraw({ decisions: [{ id: "256-D1" }, { id: "256-D2" }] }, "256-D02").index, locateWithdraw({ outcomes: [{ n: 3, text: "a" }] }, "O3").index, !!locateWithdraw({ decisions: [{ id: "256-D1" }] }, "257-D1").error], [1, 0, true]);
  t("ADR:没登记决定 ⇒ 不查(不调 git)", adrCoverage([], "abc", () => { throw new Error("不该调"); }).missing, []);
  t("义务:日记不存在 ⇒ 只提示不拒", (() => { const o = obligationCheck({ batch: "256", outcomes: [{ text: "x" }] }, { readDiary: () => null }); return [o.diaryMissing, o.notes.filter((n) => /product-diary|日记/.test(n)).length]; })(), [false, 1]);
  t("义务:没登记成果 ⇒ 不读日记", obligationCheck({ batch: "256" }, { readDiary: () => { throw new Error("不该读"); } }).diaryMissing, false);
  t("义务:登记了成果、日记无本批 ⇒ 缺", obligationCheck({ batch: "256", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 2560:x | y | e |" }).diaryMissing, true);
  t("义务:git 判不了 ⇒ unknown", !!obligationCheck({ batch: "256", decisions: dec }, { git: () => ({ status: 128, stdout: "" }) }).unknown, true);
  // 批 276(D177②):承重面零决定
  {
    const names = (list) => (a) => (a[0] === "diff" && a.includes("--name-only") ? { status: 0, stdout: list.join("\0") + "\0" } : { status: 1, stdout: "" });
    const g0 = { batch: "276", baseCommit: "abc1234" };
    t("D177:触及承重面且零决定 ⇒ 列出", obligationCheck(g0, { git: names(["scripts/hook-remote-check.mjs", "docs/x.md"]) }).noDecisionTouched, ["scripts/hook-remote-check.mjs"]);
    t("D177:触及法典 / AGENTS.md / 闸引擎 / 推送钩子都算", obligationCheck(g0, { git: names(["docs/laws/collab.md", "AGENTS.md", "scripts/lib/gate-rules.mjs", "scripts/git-hooks/pre-push.mjs", "scripts/install-git-hooks.mjs"]) }).noDecisionTouched.length, 5);
    t("D177:只改自测文件与普通文档 ⇒ 不拦", obligationCheck(g0, { git: names(["scripts/hook-remote-check.selftest.mjs", "docs/gate-debts.md", "app/page.tsx"]) }).noDecisionTouched, []);
    t("D177:声明过 --no-decision ⇒ 不核", obligationCheck({ ...g0, noDecision: { text: "只修笔误" } }, { git: names(["scripts/hook-guard.mjs"]) }).noDecisionTouched, []);
    t("D177 r6 BP-23:照抄消息模板的理由不算声明", obligationCheck({ ...g0, noDecision: { text: "合并带入,决定在批 N" } }, { git: names(["scripts/hook-guard.mjs"]) }).noDecisionTouched.length, 1);
    t("D177 r6 BP-20:手抄表外的承重件(package.json / verify-laws / perm-match)也核", obligationCheck(g0, { git: names(["package.json", "scripts/verify-laws.mjs", "scripts/lib/perm-match.mjs"]) }).noDecisionTouched.length, 3);
    t("D177 误拦 r7 FB-5:理由里的尖括号字面量不算模板", isTemplateReason("只改 <details> 折叠块的笔误") || isTemplateReason("修 Map<string, Node> 的注释"), false);
    t("D177 codex r6-fix 附 3:构建区 build/package.json 不算承重面", obligationCheck(g0, { git: names(["build/package.json"]) }).noDecisionTouched, []);
    t("D177:登记了决定 ⇒ 走 ADR 覆盖,不走本格", obligationCheck({ ...g0, decisions: dec }, { git: () => ({ status: 0, stdout: "" }) }).noDecisionTouched, []);
    t("D177:没基点 ⇒ 跳过并提示", (() => { const o = obligationCheck({ batch: "276" }, { git: names(["scripts/hook-guard.mjs"]) }); return [o.noDecisionTouched.length, o.notes.length]; })(), [0, 1]);
    t("D177:git 判不了 ⇒ unknown", !!obligationCheck(g0, { git: () => ({ status: 128, stdout: "" }) }).unknown, true);
    t("D177 r4 BP-2:闸引擎其余成员 / settings / 寄存器 / CLAUDE.md 都算", obligationCheck(g0, { git: names(["scripts/lib/write-effects.mjs", "scripts/fp-audit.mjs", "scripts/gate-replay.mjs", "scripts/gate-deps/package.json", ".claude/settings.json", "CLAUDE.md", "docs/tool-register.md", "scripts/batch-goal.mjs"]) }).noDecisionTouched.length, 8);
    t("D177 r4 BP-4:取改动清单时带 --no-renames(改名两侧都列)", (() => { let seen = null; obligationCheck(g0, { git: (a) => { if (a[0] === "diff") seen = a.includes("--no-renames"); return { status: 0, stdout: "" }; } }); return seen; })(), true);
  }

  // ── 批 256 集成:真 CLI 跑在临时 git 仓里(**不碰真台账**:cwd=临时目录,状态与台账都写在那里)──
  const integ = (() => {
    const J = path.join; const tmp = fs.mkdtempSync(J(os.tmpdir(), "bg256-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const g = (...a) => spawnSync("git", a, { cwd: tmp, encoding: "utf8", env, windowsHide: true });
    const cli = (...a) => spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), ...a], { cwd: tmp, encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
    const w = (rel, s) => { fs.mkdirSync(path.dirname(J(tmp, rel)), { recursive: true }); fs.writeFileSync(J(tmp, rel), s); };
    const commit = (m) => { g("add", "-A"); return g("commit", "-q", "-m", m); };
    const st = () => JSON.parse(fs.readFileSync(J(tmp, ".claude", ".batch-goal.json"), "utf8"));
    const res = {};
    try {
      g("init", "-q"); w(".gitignore", ".claude/\n"); w("docs/adr/0008-old.md", "# 0008\n"); w("docs/product-diary.md", "| 日期 | 事项 | 结果 | 证据 |\n|---|---|---|---|\n| d | 批 2560:x | y | e |\n");
      commit("init");
      const base = g("rev-parse", "HEAD").stdout.trim();
      res.arm = cli("--arm", "256", "--cond", "甲").status;
      res.base = st().baseCommit === base;
      res.dec = cli("--decision", "代价模型").status;
      res.out = cli("--outcome", "ADR 闸上线").status;
      res.decId = st().decisions?.[0]?.id;
      w("x.txt", "1"); commit("work");
      res.rearmKeepsBase = (cli("--arm", "256", "--cond", "甲").status === 0) && st().baseCommit === base && st().decisions?.length === 1;
      const r1 = cli("--clear");
      res.refuse = r1.status; res.refuseMsg = /256-D1/.test(r1.stderr) && /\| 批 256:ADR 闸上线 \|/.test(r1.stderr) && /diary-missing/.test(r1.stderr);
      res.notCleared = st().cleared !== true && !!st().clearRefusedAt;
      w("docs/adr/0009-cost.md", "# 0009\n- 状态:proposed\n- 决定编号:256-D1\n");
      fs.appendFileSync(J(tmp, "docs/product-diary.md"), "| d | 批 256:ADR 闸上线 | y | e |\n");
      commit("adr+diary");
      const r2 = cli("--clear");
      res.clear = r2.status; res.cleared = st().cleared === true;
      // 日记文件不存在 ⇒ 只提示
      res.arm2 = cli("--arm", "257", "--cond", "乙").status;
      cli("--outcome", "某成果"); g("rm", "-q", "docs/product-diary.md"); commit("rm diary");
      const r3 = cli("--clear"); res.noDiary = r3.status === 0 && /不存在/.test(r3.stderr);
    } catch (e) { res.err = String(e && e.message); }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不判 */ } }
    return res;
  })();
  t("集成:arm 记下基点 = 当时 HEAD", [integ.arm, integ.base], [0, true]);
  t("集成:--decision 自动编号 256-D1", [integ.dec, integ.out, integ.decId], [0, 0, "256-D1"]);
  t("集成:同号重武装保留基点与决定", integ.rearmKeepsBase, true);
  t("集成:缺 ADR 与日记行 ⇒ 拒清(exit 2)、点名编号、给日记行模板、状态未结清", [integ.refuse, integ.refuseMsg, integ.notCleared], [2, true, true]);
  t("集成:补 ADR + 日记行并提交 ⇒ 结清", [integ.clear, integ.cleared], [0, true]);
  t("集成:日记文件不存在 ⇒ 只提示、照常结清", [integ.arm2, integ.noDiary], [0, true]);
  if (integ.err) console.log("  集成段异常:" + integ.err);

  // ── 批 256b 集成:每个回件一个独立临时 git 仓(cwd=临时目录 ⇒ 状态与台账都写在那里,不碰真台账)──
  const sandbox = (fn) => {
    const J = path.join; const tmp = fs.mkdtempSync(J(os.tmpdir(), "bg256b-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const g = (...a) => spawnSync("git", a, { cwd: tmp, encoding: "utf8", env, windowsHide: true });
    const cli = (...a) => spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), ...a], { cwd: tmp, encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
    const w = (rel, s) => { fs.mkdirSync(path.dirname(J(tmp, rel)), { recursive: true }); fs.writeFileSync(J(tmp, rel), s); };
    const commit = (m) => { g("add", "-A"); return g("commit", "-q", "-m", m); };
    const st = () => JSON.parse(fs.readFileSync(J(tmp, ".claude", ".batch-goal.json"), "utf8"));
    const jrows = () => fs.readFileSync(J(tmp, ".claude", ".batch-goal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const DIARY0 = "| 日期 | 事项 | 结果 | 证据 |\n|---|---|---|---|\n| d | 批 1:x | y | e |\n";
    try {
      g("init", "-q"); g("config", "core.autocrlf", "false"); w(".gitignore", ".claude/\n"); w("docs/adr/0008-old.md", "# 0008\n"); w("docs/product-diary.md", DIARY0); commit("init");
      return fn({ tmp, g, cli, w, commit, st, jrows });
    } catch (e) { return { err: String(e && e.message) }; }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不判 */ } }
  };
  t("集成 BP-5:中文短名 ADR 写了编号 ⇒ 结清(此前被 quotePath 转义丢掉报缺)", sandbox(({ cli, w, commit, st }) => {
    cli("--arm", "300", "--cond", "甲"); cli("--decision", "中文名决定");
    w("docs/adr/0009-中文短名.md", "# 0009\n- 决定编号:300-D1\n"); commit("adr");
    const r = cli("--clear"); return [r.status, st().cleared === true];
  }), [0, true]);
  t("集成 BP-1:ADR 里只顺带「另见 301-D2(待写)」⇒ 拒清且只点名 D2", sandbox(({ cli, w, commit }) => {
    cli("--arm", "301", "--cond", "甲"); cli("--decision", "甲决定"); cli("--decision", "乙决定");
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:301-D1\n另见 301-D2(待写)\n"); commit("adr");
    const r = cli("--clear"); return [r.status, /缺:301-D2(?![0-9、])/.test(r.stderr), /reason=adr-missing/.test(r.stderr)];
  }), [2, true, true]);
  // 批 258(codex 258-cond2-r1 断言 3):同号未结清的原样重放保留 armedAt;结清后重开取新时刻
  t("集成 258:同号原样重放不刷新 armedAt,--force 换号刷新", sandbox(({ cli, st }) => {
    cli("--arm", "303", "--cond", "甲"); const a1 = st().armedAt;
    const t0 = Date.now(); while (Date.now() - t0 < 15) { /* 让时钟走过一毫秒级 */ }
    cli("--arm", "303", "--cond", "甲"); const a2 = st().armedAt;
    const t1 = Date.now(); while (Date.now() - t1 < 15) { /* 同上 */ }
    cli("--arm", "304", "--cond", "乙", "--force"); const a3 = st().armedAt;
    return [typeof a1 === "string" && a1 === a2, a3 !== a1];
  }), [true, true]);
  // 批 285 第二轮复核(误拦猎手第 4 份 FB-2 / FB-3):--clear 后结清态保留 armedBy / armedAt(收尾闸 pickBatchDir 据此认出本会话刚结清的批)
  {
    const sidKey = "CLAUDE_CODE_SESSION_ID", sid0 = process.env[sidKey];
    process.env[sidKey] = "selftest-sess-0285";
    try {
      t("285 二轮:--clear 后状态文件保留 armedBy / armedAt", sandbox(({ cli, st }) => {
        cli("--arm", "309", "--cond", "甲"); const a = st();
        cli("--no-decision", "自测"); const r = cli("--clear"); const c = st();
        return [r.status, c.cleared === true, c.batch, c.armedBy, typeof a.armedAt === "string" && c.armedAt === a.armedAt];
      }), [0, true, "309", "selftest-sess-0285", true]);
    } finally { if (sid0 === undefined) delete process.env[sidKey]; else process.env[sidKey] = sid0; }
  }
  // 批 278(D173①):批号结清过 ⇒ 不带 --force 拒复用(台账多会话共用,另一会话 --arm 277 时 277 已结清过)
  t("集成 278 D173①:结清过的批号再武装 ⇒ 拒(exit 2、状态不变);换号放行;--force 放行", sandbox(({ cli, st }) => {
    cli("--arm", "305", "--cond", "甲"); cli("--no-decision", "自测"); cli("--clear");
    const r = cli("--arm", "305", "--cond", "乙");
    const refused = [r.status, /已结清过/.test(r.stderr), st().cleared === true];
    const ok = cli("--arm", "305b", "--cond", "乙").status;
    cli("--no-decision", "自测"); cli("--clear");
    const forced = cli("--arm", "305", "--cond", "丙", "--force").status;
    return [...refused, ok, forced];
  }), [2, true, true, 0, 0]);
  t("集成 BP-2:同号结清后重开 ⇒ 编号接着 D2、旧日记行与旧 ADR 不抵、补新的才结清", sandbox(({ tmp, cli, w, commit, st }) => {
    cli("--arm", "302", "--cond", "甲"); cli("--decision", "第一次"); cli("--outcome", "成果一");
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:302-D1\n"); fs.appendFileSync(path.join(tmp, "docs/product-diary.md"), "| d | 批 302:成果一 | y | e |\n"); commit("first");
    const c1 = cli("--clear").status;
    cli("--arm", "302", "--cond", "乙", "--force"); cli("--decision", "第二次"); cli("--outcome", "成果二");   // 批 278:结清过的号重开须 --force
    const id2 = st().decisions?.[0]?.id;
    const r2 = cli("--clear");
    const refused = [r2.status, /缺:302-D2/.test(r2.stderr), /diary-missing/.test(r2.stderr)];
    w("docs/adr/0010-b.md", "# 0010\n- 决定编号:302-D2\n"); fs.appendFileSync(path.join(tmp, "docs/product-diary.md"), "| d | 批 302:成果二 | y | e |\n"); commit("second");
    const c3 = cli("--clear").status;
    return [c1, id2, refused, c3];
  }), [0, "302-D2", [2, true, true], 0]);
  t("集成 BP-3:--force 换批覆盖带决定/成果的批 ⇒ 点名丢失项并记 force-over-obligations", sandbox(({ cli, jrows }) => {
    cli("--arm", "303", "--cond", "甲"); cli("--decision", "会丢的决定"); cli("--outcome", "会丢的成果");
    const r = cli("--arm", "304", "--cond", "乙", "--force");
    const row = jrows().find((o) => o.action === "force-over-obligations");
    return [r.status, /303-D1/.test(r.stderr) && /O1/.test(r.stderr), row?.batch, row?.newBatch, row?.decisions?.[0]?.id];
  }), [0, true, "303", "304", "303-D1"]);
  t("集成 BP-4:日记读错误(EISDIR)⇒ 拒清 obligation-unknown,不再放行", sandbox(({ g, cli, w, commit }) => {
    g("rm", "-q", "docs/product-diary.md"); w("docs/product-diary.md/keep.txt", "x"); commit("diary becomes dir");
    cli("--arm", "305", "--cond", "甲"); cli("--outcome", "某成果");
    const r = cli("--clear"); return [r.status, /reason=obligation-unknown/.test(r.stderr)];
  }), [2, true]);
  t("集成 BP-10:ADR 的 blob 读不出(git show 失败)⇒ 拒清 obligation-unknown,不报缺 ADR", sandbox(({ tmp, g, cli, w, commit }) => {
    cli("--arm", "306", "--cond", "甲"); cli("--decision", "甲决定");
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:306-D1\n"); commit("adr");
    const sha = g("rev-parse", "HEAD:docs/adr/0009-a.md").stdout.trim();
    const obj = path.join(tmp, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    try { fs.chmodSync(obj, 0o666); } catch { /* 权限改不了照样试删 */ }
    fs.unlinkSync(obj);
    const r = cli("--clear"); return [r.status, /reason=obligation-unknown/.test(r.stderr), /reason=adr-missing/.test(r.stderr)];
  }), [2, true, false]);
  t("集成 BP-7:日记写「３０６ 与 ３０７ 批」(反序+合并+全角)⇒ 结清", sandbox(({ tmp, cli, commit }) => {
    cli("--arm", "307", "--cond", "甲"); cli("--outcome", "合并记");
    fs.appendFileSync(path.join(tmp, "docs/product-diary.md"), "| d | ３０６ 与 ３０７ 批:合并记 | y | e |\n"); commit("diary");
    return cli("--clear").status;
  }), 0);
  t("集成 BP-8:ADR 写 308-D01 ⇒ 认作 308-D1、结清", sandbox(({ cli, w, commit }) => {
    cli("--arm", "308", "--cond", "甲"); cli("--decision", "前导零");
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:308-D01\n"); commit("adr");
    return cli("--clear").status;
  }), 0);
  t("集成 BP-9:--withdraw 撤决定与成果 ⇒ 台账带理由、--status 列已撤、编号不复用、只核在册项", sandbox(({ cli, w, commit, st, jrows }) => {
    cli("--arm", "309", "--cond", "甲"); cli("--decision", "对的"); cli("--decision", "误登记"); cli("--outcome", "误登记成果");
    const noReason = cli("--withdraw", "309-D2").status;
    const wd = cli("--withdraw", "309-D2", "--reason", "登记错了,不是决定").status;
    const wo = cli("--withdraw", "O1", "--reason", "纯调查无成果").status;
    const stat = cli("--status").stdout;
    cli("--decision", "新的"); const id3 = st().decisions?.[1]?.id;
    const rows = jrows().filter((o) => o.action === "withdraw");
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:309-D1、309-D3\n"); commit("adr");
    const c = cli("--clear").status;
    return [noReason, wd, wo, /已撤 309-D2/.test(stat) && /已撤 O1/.test(stat), id3, rows.map((o) => o.reason), c];
  }), [2, 0, 0, true, "309-D3", ["登记错了,不是决定", "纯调查无成果"], 0]);
  const pass = cases.filter(Boolean).length;
  console.log(`\n自测 ${pass}/${cases.length}`);
  return pass === cases.length ? 0 : 1;
}

// ⚠️ **主模块守卫**(grill:edge-cases F23):本文件 export 了 load/confirmedIndices/evaluate,
//   而下面的 CLI 段原先**无条件执行** ⇒ 任何 import 它的进程当场退出(0 或 2),
//   调用方代码一行都不跑。**这正是 hook 当初抄一份正则而不 import 的原因**,
//   也就是说那条双半角冒号的分叉(F22)是本条的**后果**。
const IS_MAIN = !!process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
const argv = IS_MAIN ? process.argv.slice(2) : ["--imported-noop"];
if (argv.includes("--self-test")) process.exit(selfTest());
{ const modes = ["--arm", "--status", "--dry-check", "--clear", "--history", "--decision", "--outcome", "--withdraw"].filter((m) => argv.includes(m));
  if (modes.length > 1) { console.error(`一次只能一个模式,得到:${modes.join(" ")}`); process.exit(2); } }

if (argv.includes("--clear")) {
  // 写「已结清」标记而**不删文件**:直接删会让同一轮的 K0 立刻抱怨「未武装」
  // ——清账动作自己触发未武装告警(2026-08-19 实撞三次,第三次的根因是修复代码
  // 用 node -e 替换、字符串没匹配上而它**静默不报错**,我只看 echo 就当改完了)。
  // 标记在下次 --arm 时被整体覆盖。
  try {
    const prev = load();
    // D98-③:先核判据未被改写(与本批 arm 日志逐字相同),再跑;任一未过 ⇒ 拒清、退出 2、状态不动。写在 journal 之前:拒清不该留 clear 行。
    // 拒清要**留痕在状态文件**(clearRefusedAt):引擎的 ranClear 只看得到 tool_use 入参与盘上状态,
    //   看不到退出码;没有这条痕迹,「发起过 --clear」会被当成「已结清」(codex/grill 双审 2026-09-04)。
    const refuse = (reason) => { try { atomicWrite({ ...prev, clearRefusedAt: new Date().toISOString(), clearRefusedReason: reason }); } catch (e) { console.error("BATCH-GOAL-REFUSE-TRACE-FAILED " + e.message + "\n  留痕没写进状态文件 ⇒ 引擎会把这次 --clear 当成功;请先修状态文件再收工。"); } };

    // ⚠️ **没有东西可关时必须拒,而不是「成功地关掉零个条件」**(批 238,D126)。
    //   病:`prev===null`(从未武装)或条件为空时,原实现照样走到下面的
    //   `atomicWrite({ cleared: true, batch: prev?.batch ?? null })` 并 exit 0
    //   ⇒ 盘上永久变成 `{cleared:true, batch:null}`,而 `RULE_K.detect` 第一行
    //   `if (!g || g.cleared) return []` 对该状态**直接返回空** ⇒ 一把万能钥匙:
    //   敲一次空 `--clear`,此后 K 对这个状态再也不响。
    //   发现路径:红队报「零武装 + 一行 `echo …--clear` 抹掉 K0 的阻断」,
    //   而破窗复核(grill,跨模型配额耗尽时的降级)在「你没问到的」里指出
    //   **同一把钥匙在工装侧也成立,且工装侧的修法比三条闸侧修法都窄、都便宜**
    //   ——它不动 `ranClear` 的跨消费者语义(那个谓词同时喂着 K 的 blocking 与 W 的 blocking)。
    //   ⚠️ 这里**刻意不调 `refuse()`**:从未武装时 `prev` 为 null,`{...null, clearRefusedAt}`
    //   会凭空造出一个只有拒绝痕迹的状态文件,等于给 K/K0 喂一个它们没见过的形态。
    //   没有批就没有状态,拒绝时也不该留下状态。
    if (!prev || !Array.isArray(prev.conditions) || !prev.conditions.length) {
      console.error("BATCH-GOAL-CLEAR-REFUSED reason=nothing-to-clear");
      console.error("拒绝结清:盘上没有已武装的完成条件。`--clear` 只能关掉一个 `--arm` 过的批;" +
        "对空状态结清会把盘写成「已结清」,而闸对该状态直接放行——那是一把万能钥匙,不是一次清账。");
      console.error("出路:要开新批用 `--arm <批号> --cond …`;要看盘上现状用 `--status`。");
      process.exit(2);
    }
    if (prev && !prev.cleared && (prev.checks || []).length && !checksMatchJournal(prev, lastArmRow(prev.batch))) {
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev.batch} reason=checks-tampered`);
      console.error("拒绝结清:状态文件里的可执行判据与武装时的台账不一致——有人改过状态文件。用 --history 对照后重新 --arm。");
      refuse("checks-tampered"); process.exit(2);
    }
    const fails = runChecks(prev);
    if (fails.length) {
      refuse("checks-failed");
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev?.batch} reason=checks-failed n=${fails.length}`);
      console.error(`拒绝结清:${fails.length} 条可执行判据未过(条件自述不顶用,判据是命令说了算)`);
      printCheckFails(fails, prev);
      process.exit(2);
    }
    // D116:判据过了还不够——结清那一刻不得有未提交的已跟踪改动(不证这些改动属于本批,详见 worktreeState 头注)。
    const wt = worktreeState();
    if (wt.unknown) {
      refuse("worktree-unknown");
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev?.batch} reason=worktree-unknown`);
      console.error(`拒绝结清:判不了工作树是否干净(${wt.why})。判不了按没过算,不按过了算。`);
      process.exit(2);
    }
    if (wt.paths.length) {
      refuse("uncommitted");
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev?.batch} reason=uncommitted n=${wt.paths.length}`);
      console.error(`拒绝结清:还有 ${wt.paths.length} 个已跟踪文件的改动没提交(生产法三:收尾清账不征询,提交是清账的一部分):`);
      for (const f of wt.paths.slice(0, 10)) console.error(`  ${f}`);
      if (wt.paths.length > 10) console.error(`  …另 ${wt.paths.length - 10} 个`);
      console.error("出路:本批的改动先提交再 --clear。**不是本批做的改动(可能是用户自己的)不得撤销、不得丢弃**——停下告诉用户,由用户决定。");
      process.exit(2);
    }
    // 批 256:登记过的决定要有 ADR、登记过的成果要有日记行——写入 cleared 之前查,缺 ⇒ 拒清并给模板。
    const obl = obligationCheck(prev);
    for (const n of obl.notes) console.error("提示:" + n);
    if (obl.unknown) {
      refuse("obligation-unknown");
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev?.batch} reason=obligation-unknown`);
      console.error(`拒绝结清:决定 / 成果 / 承重面的核对判不了(${obl.unknown})。判不了按没过算。`);
      process.exit(2);
    }
    if (obl.missingDecisions.length || obl.diaryMissing || obl.noDecisionTouched.length) {
      const why = [obl.missingDecisions.length ? "adr-missing" : "", obl.diaryMissing ? "diary-missing" : "", obl.noDecisionTouched.length ? "no-decision" : ""].filter(Boolean).join("+");
      refuse(why);
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev?.batch} reason=${why}`);
      printObligationRefusal(prev, obl);
      process.exit(2);
    }
    journal("clear", { batch: prev?.batch ?? null, conditions: prev?.conditions ?? null,
      checks: prev?.checks ?? null, armedAt: prev?.armedAt ?? null, baseCommit: prev?.baseCommit ?? null,
      decisions: prev?.decisions ?? null, outcomes: prev?.outcomes ?? null, withdrawn: prev?.withdrawn ?? null });
    // ⚠️ **批号要留在状态文件里**(2026-08-20,grill:edge-cases E6)。
    //   闸判「这次关账是真的」靠台账末行,但  的 catch 会把写失败整个吞掉
    //   (Windows 上文件被占用即触发),而 atomicWrite 照常成功、CLI 照常 exit 0
    //   ⇒ **三天前另一批的 clear 行会顶替成本轮证据**,且没有任何一处会说出来。
    //   留下批号,闸就能要求「台账末行的批号 == 状态文件的批号」——写失败时对不上。
    //   批 285(误拦猎手第 4 份 FB-2 / FB-3):武装者与武装时刻也留着——收尾闸在主树与各 worktree 的批状态里挑「本会话的」那份
    //   (hook-stop-closure pickBatchDir),结清态原来丢了 armedBy,worktree 里本会话刚结清的批认不出,挑中了别处没关的旧批
    atomicWrite({ cleared: true, batch: prev?.batch ?? null,
      ...(typeof prev?.armedBy === "string" && prev.armedBy ? { armedBy: prev.armedBy } : {}),
      ...(typeof prev?.armedAt === "string" && prev.armedAt ? { armedAt: prev.armedAt } : {}) });
    console.log("已结清批级完成条件(留结清标记,下次 --arm 覆盖;条件已存入 .batch-goal.jsonl)");
    debtTableWarn();
    // 批 258 条件 4:收尾自动出一张报警量 × 误报率表(按规则),待修行下一批 --arm 会再列一次
    const rep = fpReport();
    if (rep) console.log("\n── 收尾误报率表 ──\n" + rep.trim());
    // 2026-10-12:自签误报交 codex 盲审(scripts/fp-audit.mjs)——独立核对由另一个模型做,不靠用户按按钮
    //   (用户:「有问题不应该自己解决嘛」)。审不了 ⇒ 说出来,不拦结清。
    fpAudit();
  } catch (e) {
    // ⚠️ 失败必须走 stderr + 非零退出。原实现打 stdout 且 exit 0,
    //   调用方检查 $? 会以为清账成功,而陈旧条件还留在盘上(grill:error-handling 报出)。
    console.error("结清失败:", e.message); process.exit(1);
  }
  process.exit(0);
}

if (argv.includes("--no-decision")) {
  // 批 276(D177②):承重面批声明「本批没有决定」——留一句理由,--clear 不再要求决定编号;台账记 no-decision 行
  const i = argv.indexOf("--no-decision"), text = argv[i + 1];
  if (text === undefined || !String(text).trim() || /^--/.test(text)) { console.error('用法: --no-decision "<为什么本批没有决定>"'); process.exit(2); }
  if (isTemplateReason(text)) { console.error("--no-decision 的理由照抄了模板(含「批 N」或尖括号占位)——写本批真实的理由 / 真实批号"); process.exit(2); }
  let cur;
  try { cur = load(); } catch (e) { console.error(`拒绝:${e.message}`); process.exit(2); }
  if (!cur || cur.cleared || !Array.isArray(cur.conditions) || !cur.conditions.length) { console.error("拒绝:盘上没有未结清的批。"); process.exit(2); }
  if (arr(cur.decisions).length) { console.error(`拒绝:本批已登记 ${arr(cur.decisions).length} 条决定,不能再声明「没有决定」(登记错了用 --withdraw)。`); process.exit(2); }
  const item = { text: String(text), at: new Date().toISOString() };
  try { atomicWrite({ ...cur, noDecision: item }, Number(cur.version) || 0); } catch (e) { console.error(e.message); process.exit(2); }
  journal("no-decision", { batch: cur.batch, ...item });
  console.log(`已声明批 ${cur.batch} 没有决定:${item.text}`);
  process.exit(0);
}
if (argv.includes("--decision")) appendItem("decision", argv);
if (argv.includes("--outcome")) appendItem("outcome", argv);
if (argv.includes("--withdraw")) withdrawItem(argv);

if (argv.includes("--status")) {
  const g = load();
  if (!g || g.cleared || !Array.isArray(g.conditions)) {
    // F25: 之后状态是 {cleared:true},truthy 但没有 conditions ⇒ 原实现在
    //   **每两批之间那个必然存在的状态**上崩溃。--status 是文档写明的检视口。
    console.log(g?.cleared ? "已结清:上一批已关账,尚未武装新批" : "未武装:本批没有完成条件(开工时应 --arm)");
    process.exit(0);
  }
  console.log(`批 ${g.batch} · ${g.conditions.length} 条完成条件:`);
  g.conditions.forEach((c, i) => console.log(`  条件${i + 1}: ${typeof c === "string" ? c : c.text}`));
  for (const c of (Array.isArray(g.checks) ? g.checks : [])) console.log(`    判据(条件${c.i + 1}): $ ${c.cmd}${c.expect !== undefined ? `  期待含「${c.expect}」` : ""}${c.expectRe !== undefined ? `  期待匹配 /${c.expectRe}/` : ""}`);
  console.log(`  基点:${g.baseCommit ? String(g.baseCommit).slice(0, 10) : "(无——早于批 256 的武装,ADR 核对退回全部 ADR)"}`);
  for (const d of arr(g.decisions)) console.log(`  决定 ${d.id}: ${d.text}`);
  for (const o of numberOutcomes(g.outcomes)) console.log(`  成果 O${o.n}: ${o.text}`);
  for (const w of arr(g.withdrawn)) console.log(`  已撤 ${w?.kind === "decision" ? w.id : `O${w?.n}`}: ${w?.text}  ——理由:${w?.reason}`);
  process.exit(0);
}

if (argv.includes("--arm")) {
  const batch = argv[argv.indexOf("--arm") + 1];
  let conds, checks;
  try { ({ conds, checks } = parseArm(argv)); } catch (e) { console.error(`用法错误:${e.message}`); process.exit(2); }
  if (!batch || !conds.length) { console.error("用法: --arm <批号> --cond \"条件\" [--check \"命令\" [--expect \"子串\"]] [--cond …]"); process.exit(2); }
  // ⚠️ 覆盖保护:当前已武装且批号不同 ⇒ 拒绝,除非 --force。
  //   本次事故的形态就是这个:后台 codex 用它自己的批号 --arm,把 061 的条件盖没了。
  // load() 现在对**损坏/空**状态会抛(F1 的 fail-closed)。在这里接住并给人话:
  // 直接让栈打出来等于把 fail-closed 变成 fail-noisy,操作者读不懂就会去 --force。
  let cur;
  try { cur = load(); }
  catch (e) {
    console.error(`拒绝武装:${e.message}`);
    console.error(`  这类状态**不得当作「没武装」**——它可能是被中断的写留下的残骸,`);
    console.error(`  盖上去会把真实批次的验收标准无声抹掉(2026-08-19 实撞过一次)。`);
    console.error(`  先看 --history 确认上一批是什么,再决定 --force。`);
    process.exit(2);
  }
  const seenVersion = Number(cur?.version) || 0;
  // ⚠️ **必须先看 `cleared`**(2026-08-20 实撞,而且是我自己上一批造的)。
  //   为修 grill E6(台账写失败时陈旧行顶替本轮证据),我让 `--clear` 把批号写进状态文件
  //   ⇒ 结清后状态是 `{cleared:true, batch:"073"}`。而本守卫只判 `cur.batch` 存在,
  //   于是**结清之后再 --arm 会当场崩**:`cur.conditions` 是 undefined,读 `.length` 抛 TypeError。
  //   两个教训:①「已结清」与「有批号」不是一回事,守卫得判前者;
  //   ②我改的是 clear 那一侧,崩的是 arm 那一侧 —— **同一状态文件的两个读者,只改了一个**。
  if (cur && cur.batch && !cur.cleared && cur.batch === batch && armChanged(cur, conds, checks) && !argv.includes("--force")) {
    console.error(`拒绝:批 ${batch} 已武装且本次 conditions/checks 与盘上不同——同批只允许逐字相同的重放。改判据要显式 --force(会记入台账)。`);
    process.exit(2);
  }
  if (cur && cur.batch && !cur.cleared && argv.includes("--force") && (cur.checks || []).length) {
    const oldFails = runChecks(cur);
    journal("force-over-checks", { batch: cur.batch, failing: oldFails.length, total: cur.checks.length, newBatch: batch });
    console.error(`注意:--force 覆盖了批 ${cur.batch} 的 ${cur.checks.length} 条判据(其中 ${oldFails.length} 条当时未过),已记台账。`);
  }
  if (checks.length && !findBash()) { console.error("拒绝武装:带 --check 但找不到 Git Bash(判据一律经 bash -c 跑;可设 BATCH_GOAL_BASH)"); process.exit(2); }
  if (cur && cur.batch && !cur.cleared && cur.batch !== batch && !argv.includes("--force")) {
    console.error(`拒绝:批 ${cur.batch} 尚未结清(${(cur.conditions || []).length} 条条件),不能直接武装批 ${batch}。`);
    console.error(`  正常序:先把批 ${cur.batch} 逐条对照并 --clear,再武装新批。`);
    console.error(`  确需覆盖(会丢失当前条件,但可从 .claude/.batch-goal.jsonl 翻回):加 --force`);
    process.exit(2);
  }
  // 批 278(D173①):批号在台账里已结清过 ⇒ 拒绝复用(换个号,如加字母后缀),除非 --force。
  //   同号未结清的重放不受影响(那是同一批);结清后用同号重开要 --force,台账照记。
  if (!(cur && !cur.cleared && cur.batch === batch) && !argv.includes("--force")) {
    let used = false;
    try { used = batchClearedBefore(batch); } catch (e) { console.error(`拒绝武装:${e.message}`); process.exit(2); }
    if (used) {
      console.error(`拒绝:批号 ${batch} 在台账里已结清过——本仓台账多会话共用,复用批号会让两笔不同条件的批同号(lanes 等按批号显示的读者会混)。`);
      console.error(`  换一个没用过的号(如 ${batch}b,或下一个数字);确是同一批要重开就加 --force(记入台账)。`);
      process.exit(2);
    }
  }
  // 批 256:同号未结清的重武装(含同号 --force)保留基点与决定/成果清单;换批或结清后重开才取新基点。
  //   旧批没有基点 ⇒ 保持 null 不补记(补记的 HEAD 比真基点晚,会误拦,见 headCommit 上方头注 ①)。
  const sameOpen = !!(cur && !cur.cleared && cur.batch === batch);
  const baseCommit = sameOpen ? (typeof cur.baseCommit === "string" ? cur.baseCommit : null) : headCommit();
  // 批 276(误拦猎手 FB-13):同号重放时 --no-decision 声明一并保留,原先被静默丢掉 ⇒ --clear 拒清
  const kept = sameOpen ? { decisions: arr(cur.decisions), outcomes: arr(cur.outcomes), withdrawn: arr(cur.withdrawn), ...(cur.noDecision ? { noDecision: cur.noDecision } : {}) } : { decisions: [], outcomes: [], withdrawn: [] };
  if (!baseCommit) console.log(sameOpen ? "注意:本批武装于基点功能之前,基点保持空;--clear 的 ADR 核对会退回全部 ADR。" : "注意:取不到 HEAD(非 git 仓或零提交),本批没有基点;--clear 的 ADR 核对会退回全部 ADR。");
  // 批 256b BP-3:--force 换批覆盖带决定/成果的未结清批 ⇒ 点名丢了什么,并记台账(此前静默丢掉)。
  if (cur && !cur.cleared && !sameOpen && (arr(cur.decisions).length || arr(cur.outcomes).length)) {
    const lostD = arr(cur.decisions).map((d) => d?.id).filter(Boolean);
    const lostO = numberOutcomes(cur.outcomes).map((o) => ({ o: `O${o.n}`, text: o.text }));
    journal("force-over-obligations", { batch: cur.batch, newBatch: batch, decisions: arr(cur.decisions), outcomes: lostO });
    console.error(`注意:--force 覆盖了批 ${cur.batch} 未结清的义务,以下不再被任何 --clear 核对(已记台账 force-over-obligations):`);
    for (const d of arr(cur.decisions)) console.error(`  决定 ${d?.id}: ${String(d?.text || "").slice(0, 80)}`);
    for (const o of lostO) console.error(`  成果 ${o.o}: ${String(o.text || "").slice(0, 80)}`);
    if (!lostD.length && !lostO.length) console.error("  (清单形状异常,未能列出)");
  }
  journal("arm", { batch, conditions: conds, checks, shell: "bash", overwrote: cur?.batch ?? null, baseCommit, ...(argv.includes("--force") ? { forced: true } : {}),
    ...(typeof process.env.CLAUDE_CODE_SESSION_ID === "string" && /^[\w-]{8,80}$/.test(process.env.CLAUDE_CODE_SESSION_ID) ? { armedBy: process.env.CLAUDE_CODE_SESSION_ID } : {}) });   // forced:批 278(误拦猎手附节二 6);armedBy:批 281(与状态文件同一校验,误拦猎手 281 附节二 ①)
  // ⚠️ `armedAt` 是 2026-08-20 加的:开工面闸要判「**本批**跑过哪几条通道」,
  //   而状态文件此前**不记武装时刻**,于是那个窗口起点取不到 ⇒ 闸只能闭嘴。
  //   台账 .jsonl 里有时间,但让读者去 join 两份文件是把简单的事做复杂了。
  // r2:同批逐字重放不得抹掉拒清痕迹(否则「拒清 → 原样重 arm → 正文写达成」就绕过了 K);换批或 --force 才清
  const carry = (cur && !cur.cleared && cur.batch === batch && cur.clearRefusedAt && !argv.includes("--force")) ? { clearRefusedAt: cur.clearRefusedAt, clearRefusedReason: cur.clearRefusedReason } : {};
  // 批 258(codex 258-cond2-r1 断言 3):同号未结清的重放保留原 armedAt——它是「本批从何时起」,W 按它切交付物、
  //   P 按它切凭证池;重放刷新它会把本批更早的写入切到批外(本批未审的交付物被放行)。换批或结清后重开才取新时刻。
  const armedAt = sameOpen && typeof cur.armedAt === "string" && cur.armedAt ? cur.armedAt : new Date().toISOString();
  // 批 281:记武装者会话号(Claude Code 给子进程的 CLAUDE_CODE_SESSION_ID);收尾闸据此把别的会话武装的批标 foreign,
  //   S 不再拿它拦本会话。同号重放时状态文件保留原武装者(台账行记本次武装者);取不到 ⇒ 不记,
  //   这时收尾闸看本会话转录里有没有武装过该批号(没有 ⇒ 外来,判法见 hook-stop-closure.mjs isForeignBatch)
  const sidEnv = typeof process.env.CLAUDE_CODE_SESSION_ID === "string" && /^[\w-]{8,80}$/.test(process.env.CLAUDE_CODE_SESSION_ID) ? process.env.CLAUDE_CODE_SESSION_ID : null;
  const armedBy = sameOpen && typeof cur.armedBy === "string" && cur.armedBy ? cur.armedBy : sidEnv;
  try { atomicWrite({ batch, conditions: conds, checks, shell: "bash", armedAt, baseCommit, ...(armedBy ? { armedBy } : {}), ...kept, ...carry }, seenVersion); }
  catch (e) { console.error(e.message); process.exit(2); }
  console.log(`已武装批 ${batch} 的 ${conds.length} 条完成条件${checks.length ? `(其中 ${checks.length} 条带可执行判据,--clear 时经 bash 跑)` : ""};收尾时须逐条写「条件N:达成/未达成/不适用」`);
  for (const c of checks) console.log(`  条件${c.i + 1} ⇐ $ ${c.cmd}${c.expect !== undefined ? `  期待含「${c.expect}」` : ""}${c.expectRe !== undefined ? `  期待匹配 /${c.expectRe}/` : ""}`);
  // ── 到期债强制腿(2026-08-22,用户逼出:「失效期是装饰品——D34/D35 ≤080 早到期,没人查」)──
  //   立法史:词表路线(Q 的 defer 正则)已判死(B 扩表实败 + xros non-goal + Q「确无结构判据」),
  //   「推迟」的结构载体 = 批条件 + 带失效期的债表;失效期没有执行腿 ⇒ 装饰品。
  //   本腿在**开工时刻**(--arm = 唯一必经的结构点)机械列出到期未结的债,不靠散文不靠词表。
  //   一期只警不拦(拦会把「开工」堵死在还债上——比例归人判);连续多批仍列 ⇒ 升级另议。
  try {
    const rows = fs.readFileSync("docs/gate-debts.md", "utf8").split(/\r?\n/)
      .filter((l) => /^\| D\d+ \|/.test(l) && !/已撤销|待用户裁/.test(l));
    const cur = parseInt(batch, 10);
    // 分诊(2026-08-23 批 099,用户点破「到期腿跑出一堆我看不懂的」):
    //   行含亲签/呈签/归用户/用户裁 ⇒ 【需你裁】,其余 ⇒ 【我做】——用户只须看前一列。
    //   判据是关键词面,天花板:亲签字样写在方案叙述里也会归到【需你裁】(宁多勿漏,
    //   错归方向=多请示一次,反向=漏请示,代价不对称选这边)。
    // ⚠️ 2026-08-27 改为**按列解析**(D88,批 118 关账后当场撞到)。两个毛病叠在一起:
    //   ① 排除词表认 `已结` **不认 `已修`** —— 又一次措辞白名单(本族第十二次);
    //   ② `≤` 取的是**整行第一个**匹配,而已结清的行里同时有 `~~≤113~~`(旧,划掉)
    //      与 `**已修 118**`(新)⇒ 抓到旧的那个 ⇒ 判成逾期。
    //   合起来:我一批清掉七条债,下一批 `--arm` **照样把它们全列成到期未结**。
    //   **假欠账比没有欠账清单更坏**:它让人对整张清单脱敏,真到期的那几条就淹在里面。
    //   ⇒ 失效期只从**第 4 列**取(表头:`| # | 欠账 | 批 | 失效期 | 复核来源 | 出路 |`),
    //   并按**结构**判已结:该列被 `~~` 划掉,或含 已修/已结/已销 之一。
    //   天花板:仍依赖表格列序;列序若变,本腿会静默失准 ⇒ 下面加了列数断言。
    //   (批 285 D133:逐行判定抽成 debtDue,便于自测)
    const { mine, yours, colBad } = debtDue(rows, cur);
    if (colBad.length) console.log(`⚠ 到期腿:${colBad.length} 行列数异常已跳过(${colBad.join(" ")})—— 描述列里有代码段外的竖线,或表格列序变了;这些行的到期本腿看不见`);
    const due = [...mine, ...yours];
    if (due.length) {
      console.log(`⚠ **到期未结的债 ${due.length} 条**(本批号已超过其失效期):`);
      if (mine.length) console.log(`  【我做】${mine.join(" ")} —— 不需要你看懂,按到期语义自动进批,我协调`);
      if (yours.length) console.log(`  【需你裁】${yours.join(" ")} —— 含亲签面,会摊全文给你`);
      console.log(`  到期语义:自动回 active——本批要么办掉,要么在收尾对照里写明为什么还不办。`);
    }
  } catch { console.log("⚠ 债表读不到,到期检查跳过(fail-open,仅提示层)"); }
  debtTableWarn();
  // ── 误报率待修腿(批 258 条件 4)──
  //   误报率 ≥15% 且报警 ≥20 的规则在开工时刻列出,与上面的到期债同一结构点:不靠人记得去翻报表。
  //   报表由 hook-stop-closure `--fp-report --hot` 算(唯一实现);跑不出来 ⇒ 只提示,不拦开工。
  fpAuditLast();
  const hotRep = fpReport(["--hot"]);
  // 报表自己的完整性告警(台账断链 / 坏行)原样转出——开批只留「待修」行会把它们滤掉(codex 258-cond34-r1 附节)
  for (const l of hotRep.split("\n")) if (/^(🔴|⚠)/.test(l)) console.log(l);
  const hot = hotRep.split("\n").filter((l) => l.startsWith("待修 "));
  if (hot.length) {
    console.log(`⚠ **误报率待修的规则 ${hot.length} 条**(误报率 ≥15% 且报警 ≥20;本批要么修判据,要么在收尾对照里写明为什么不修):`);
    for (const l of hot) console.log("  " + l.replace(/^待修 /, "").replace(/\s*← 下一批待修\s*$/, ""));
  }
  process.exit(0);
}

/** 结清时后台发车 scripts/fp-audit.mjs(自签误报的 codex 盲审)。grill 259 F11:同步跑最长约 16 分钟,Bash 工具 2 分钟就转后台,
 *  结论没人读到、被杀时还留孤儿作业 ⇒ 改为脱离父进程跑,输出写 FP_AUDIT_LOG;下次 --arm 把日志里的结论行打出来(开批必经)。
 *  脚本缺席 ⇒ 不提(本仓未装);发不了车 ⇒ 说出来。 */
function fpAudit() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "fp-audit.mjs");
  if (!fs.existsSync(script)) return;
  try {
    fs.mkdirSync(path.dirname(FP_AUDIT_LOG), { recursive: true });
    const fd = fs.openSync(FP_AUDIT_LOG, "w");
    fs.writeSync(fd, `# 发车 ${new Date().toISOString()}(batch-goal --clear)\n`);
    const child = spawn(process.execPath, ["--no-warnings", script], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
    child.unref();
    fs.closeSync(fd);
    console.log(`\n── 自签误报盲审(codex)──\n已在后台发车(pid ${child.pid}),结论写 ${FP_AUDIT_LOG},下次 --arm 时列出`);
  } catch (e) { console.log(`⚠ 盲审发不了车(${String(e && e.message || e).slice(0, 160)})`); }
}
/** --arm 时转出上一次盲审的结论行(日志没有结论行 ⇒ 说它还没跑完或失败了)。 */
function fpAuditLast() {
  let txt; try { txt = fs.readFileSync(FP_AUDIT_LOG, "utf8"); } catch { return; }
  const lines = txt.split("\n").filter((l) => /^(FP-AUDIT|⚠|  拦对了)/.test(l));
  const head = (txt.split("\n")[0] || "").replace(/^#\s*/, "");
  console.log(lines.length ? `── 上一次自签误报盲审(${head})──\n${lines.join("\n")}`
    : `⚠ 上一次自签误报盲审(${head})日志里没有结论行——还在跑,或中途失败(看 ${FP_AUDIT_LOG})`);
}

/** 跑 hook-stop-closure `--fp-report [extra…]`,返回 stdout;跑不出 ⇒ 空串,**并说出来**(提示层 fail-open,但不静默——
 *  codex 258-cond34-r1 断言 4:原实现非零退出 / 超时 / 异常一律无声,待修腿与收尾表看起来像「没有待修」)。 */
function fpReport(extra = []) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook-stop-closure.mjs");
  if (!fs.existsSync(script)) return "";   // 本仓没有收尾闸脚本:无从出表,不算故障
  try {
    const r = spawnSync(process.execPath, ["--no-warnings", script, "--fp-report", ...extra], { windowsHide: true, encoding: "utf8", timeout: 60000 });
    if (r.status === 0) return String(r.stdout || "");
    const why = r.error ? String(r.error.message || r.error) : `退出码 ${r.status}${r.signal ? `(${r.signal})` : ""}`;
    console.log(`⚠ 误报率表跑不出来(${why}):${String(r.stderr || "").split("\n")[0].slice(0, 160)}——待修与收尾表本次缺,不拦`);
    return "";
  } catch (e) { console.log(`⚠ 误报率表跑不出来(${String(e && e.message || e).slice(0, 160)})——待修与收尾表本次缺,不拦`); return ""; }
}

if (argv.includes("--dry-check")) {
  // 只跑可执行判据不结清:干活中途看看离「机器认可」还差哪条。
  const g = load();
  if (!g || g.cleared || !Array.isArray(g.conditions)) { console.log("未武装或已结清,无判据可跑"); process.exit(0); }
  if ((g.checks || []).length && !checksMatchJournal(g, lastArmRow(g.batch))) { console.error("状态文件里的判据与武装时的台账不一致,拒跑"); process.exit(2); }
  const fails = runChecks(g); const n = (g.checks || []).length;
  if (!n) { console.log(`批 ${g.batch}:${g.conditions.length} 条条件均无可执行判据`); process.exit(0); }
  if (fails.length) { console.error(`批 ${g.batch}:${n} 条判据,${fails.length} 条未过`); printCheckFails(fails, g); process.exit(2); }
  console.log(`批 ${g.batch}:${n} 条可执行判据全过`); process.exit(0);
}

if (argv.includes("--history")) {
  // 「小 git」的 log:任何一次覆盖都能从这儿翻回来
  let lines = [];
  try { lines = fs.readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean); } catch { lines = []; }
  if (!lines.length) { console.log("无历史(.claude/.batch-goal.jsonl 不存在或为空)"); process.exit(0); }
  const n = Number(argv[argv.indexOf("--history") + 1]) || 10;
  for (const l of lines.slice(-n)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o.action) continue;               // genesis/非事件行(ledger-chain 链首)不进历史视图
    const when = String(o.at).slice(11, 19);
    const extra = o.overwrote ? `  ⚠️ 覆盖了批 ${o.overwrote}` : "";
    console.log(`  ${when}  ${o.action.padEnd(5)} 批 ${o.batch ?? "—"}  ${(o.conditions || []).length} 条${extra}`);
    for (const c of (o.conditions || [])) console.log(`           · ${typeof c === "string" ? c : c.text}`);
  }
  process.exit(0);
}

// ⚠️ 被 import 时到此**什么都不做**。原实现在这里无条件 `exit(2)`,
//   于是守卫算对了也没用——调用方照样被这句用法错误杀掉(实测复现)。
if (IS_MAIN) {
  console.error("用法: --arm <批号> --cond \"…\" [--check \"命令\" [--expect \"子串\" | --expect-re \"正则\"]] [--force] | --decision \"<决定>\" | --no-decision \"<为什么本批没有决定>\" | --outcome \"<成果>\" | --withdraw <批号-Dn | On> --reason \"<理由>\" | --status | --dry-check | --clear | --history [n] | --self-test");
  process.exit(2);
}
