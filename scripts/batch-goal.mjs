#!/usr/bin/env node
// batch-goal.mjs —— 批级完成条件(命令自带的 goal)
//
// 干什么:让**每条命令在开工时自己写下这一批的完成条件**,收尾闸每轮拿它比,
//        收尾时(有 git commit)未逐条确认即拦。
//
// 为什么不用官方 `/goal`:它是**内建 slash command,模型调不了**——只有用户能敲。
//        而 2026-08-19 用户明示「以后原则上每个命令都必须 goal,而不是我搁那打 goal」。
//        官方 `/goal` 的机制(session 级 prompt Stop hook、另一个模型判、后台任务在跑时跳过)
//        本仓原由 `.claude/settings.json` 的 prompt hook + `hook-stop-closure` 分别覆盖
//        (批 294 按 287 设计 2.8 撤掉了 Stop 上的 prompt hook,「另一个模型判」那一半不再有);
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
//        开批记录(批 305,全部可选、只记录不阻断):--instruction "<引出本批的那句指令,原话>" [--instruction-session <会话号>] [--instruction-at <ISO 时刻>]
//        --finish-line "<终点线:做到什么就停>"  --cap-usd <整批花费上限,美元>  --deadline <总截止时间,ISO>
//   node --no-warnings scripts/batch-goal.mjs --status
//   node --no-warnings scripts/batch-goal.mjs --decision "<本批决定一句话>"   ⇒ 自动编号 <批号>-D<n>(批 256)
//   node --no-warnings scripts/batch-goal.mjs --no-decision "<为什么本批没有决定>"   ⇒ 承重面批零决定时的声明(批 276,D177)
//   node --no-warnings scripts/batch-goal.mjs --outcome "<可见成果一句话>"    ⇒ 自动序号 O<n>(批 256)
//   node --no-warnings scripts/batch-goal.mjs --withdraw <批号-Dn | On> --reason "<理由>"   撤回误登记的一项(批 256b)
//   node --no-warnings scripts/batch-goal.mjs --clear [--verdict "N=达成|未达成|不适用[:理由]"]…   (批 298:逐条裁决,可选)
//        (批 305:成功时多打一行主尺并记进 clear 行——从指令到关账,转录里人亲口说了几条;量不出写明原因)
//   node --no-warnings scripts/batch-goal.mjs --ruler              ⇒ 只读:现算主尺(未结清)或打关账时记下的那份(批 305)
//   node --no-warnings scripts/batch-goal.mjs --handoff [--out <路径>] ⇒ 只读:交接从事实生成(分支 / 工作树 / 批 / 外部作业 / 到期欠账;批 305)
//        (批 305:git worktree 里的 --arm / --clear 另记一行进主 checkout 的 .claude/.batch-goal.worktrees.jsonl,主树 --history 并进来显示)
//   node --no-warnings scripts/batch-goal.mjs --context            ⇒ 一行摘要 + 状态文件路径 + 内容哈希(批 298)
//   node --no-warnings scripts/batch-goal.mjs --settle [<义务 id>]  ⇒ 卡住(连续判不了 ≥3 次)的义务转欠账(批 298)
//   node --no-warnings scripts/batch-goal.mjs --repair-obligations ⇒ 按台账重建义务账状态文件(批 298;不改结论)
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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ledgerAppend, verifyFile as verifyFileChain } from "./lib/ledger-chain.mjs";
import { quoteUntrusted, buildCtx } from "./lib/gate-ctx.mjs";   // buildCtx:批 305 自测拿它和主尺的认人口径逐条对账
import { isCarrierPath, CARRIER_SURFACE } from "./lib/gate-carriers.mjs";
import { readInstallConfig, parseInstallConfig, mergeInstallConfig, absentInstallConfig, snapshotConfig, configFromSnapshot, installNames, INSTALL_CONFIG_FILE } from "./lib/install-config.mjs";
import * as OB from "./lib/obligations.mjs";
import { debtRowCells, debtRowParked, liveDebtRows } from "./lib/debt-schema.mjs";   // 批 301:切列一份实现
import { planWriteChecks, applyWriteChecks, isWriteCheckType, withdrawnClears, transcriptDirs, projectDirName } from "./lib/write-checks.mjs";   // 批 301:写入类义务产生器(T / MF / J / M);批 305:转录目录的定位沿用它
import * as RULER from "./lib/batch-ruler.mjs";   // 批 305:指令定位与主尺(从指令到关账人亲口说了几条话)
export { debtRowCells, debtRowParked };
const JOURNAL = path.join(".claude", ".batch-goal.jsonl");

// ── 批 298:义务账 + 编排状态 + 安装方配置接缝(287 设计 2.1、2.7;拆批稿 clipboard/294-p0-breakdown.md「297」节,实际编号 298)──
//   ① 义务账(scripts/lib/obligations.mjs,格式见其头注)落在 git 公共目录的上一级 `.claude/.obligations/`,各 worktree 共用;
//      每条带归属会话(owner)与现归属批(batch = 批号 + armedAt)。
//      本文件把三道既有核对改造成义务类型(行为不变,自测钉住):decision-adr(--decision)、outcome-diary(--outcome)、
//      load-bearing-decision(承重面零决定,D177)。它们的结论只由 --clear 的求值器写;新产生器(后续批)走 recordEvidence。
//   ② 带过来:`--arm` 换批、`--arm --force`、同号重放都把本 checkout 上一批未清的义务原样并入新批(原 force-over-obligations
//      「不再被任何 --clear 核对」那条丢项路已删,批 256b BP-3 的台账行改名 force-carry-obligations,只记不丢);
//      未归属的义务**只看 checkout**:同一 checkout 的并入(不看会话号,批 298 r2);转欠账到期的也按 checkout 认回开批的那一批。
//   ③ `--clear` 通用拒绝:本批名下还有 开着 / 判不了 / 待提交转欠账 的义务 ⇒ 拒(退出 2,拒清痕迹同 refuse())。
//      判不了按开着算。义务账自身判不了(取不到目录 / 锁超时 / 被改过 / 链断)⇒ 也拒。
//   ④ 没有任何 CLI 能把义务置为「已清」:CLI 只有 --settle(转欠账,不是已清)、--withdraw(只撤自己登记的决定 / 成果,既有)、
//      --repair-obligations(只按台账重建,不改任何结论)。
//   ⑤ 卡住转欠账:连续判不了 ≥3 次(首次 + 重试 2 次)⇒ `--settle` 往债表写一行(失效期 ≤ 批号数字部分 + 3)⇒ 提交 ⇒
//      `--clear` 只认 **HEAD 里已提交**的那一行(不在 --clear 里写债表:写完工作树就脏,D116 自锁;拆批稿 0.5)。
//   ⑥ 安装方配置(scripts/lib/install-config.mjs):日记、ADR 目录、安装方专属承重路径从仓根 gate-install.json 读;
//      没有这份文件的仓不做日记 / ADR / 承重面零决定核对。HostApp 的那份照原值写,行为零变化。
//   ⑦ `--context`:一行摘要 + 状态文件路径 + 内容哈希(给开工注入用,批 299)。`--clear --verdict "N=达成|未达成|不适用[:理由]"`:
//      逐条裁决参数(2.2 K 行),可选;给了就须覆盖全部条件,记进台账 clear 行。「条件N:达成」文字判据照旧保留(302 再撤)。
let CONFIG_OVERRIDE = null;   // 自测用:纯函数测试注入 HostApp 形的配置,不依赖 cwd 有没有那份文件
let CONFIG_CACHE;
function installConfig() { return CONFIG_OVERRIDE || (CONFIG_CACHE ??= readInstallConfig()); }
/** 现行配置并上批基点那一版(批内关掉核对的绕过面,见 install-config.mjs 头注)。 */
function effectiveConfig(goal, git = gitRun) {
  if (CONFIG_OVERRIDE) return CONFIG_OVERRIDE;
  const head = installConfig();
  // 批 298 r2(codex ① / 猎手 FB-6):现行版解析坏 ⇒ 一律 brokenInBatch(不看基点有没有配置,快照也遮不住);
  //   读错误(EBUSY / EPERM / EISDIR…)⇒ 原样返回(判不了、可重试),不算改坏
  if (head.error) return head.readError ? head : { ...head, brokenInBatch: true };
  const base = goal?.baseCommit;
  if (!(typeof base === "string" && base)) return head;
  let r; try { r = git(["show", `${base}:${INSTALL_CONFIG_FILE}`]); } catch { r = null; }
  if (!r || r.status !== 0) return head;   // 基点没有这份文件(或取不到)⇒ 只用现行版
  const b = parseInstallConfig(String(r.stdout || ""), `${base.slice(0, 10)}:${INSTALL_CONFIG_FILE}`);
  return mergeInstallConfig(head.found ? head : { ...absentInstallConfig(), found: true }, b);
}
/** 批 298 r1(配置冻结):本批的求值配置 = 本批承重面零决定记录建立时(武装时)的快照;没有那条记录(旧批导入)⇒ 现行 ∪ 基点。 */
function batchConfig(goal, recs, git = gitRun) {
  const key = batchKeyOf(goal);
  const lb = arr(recs).find((r) => r.type === "load-bearing-decision" && sameKey(r.origin, key) && r.config);
  return (lb && configFromSnapshot(lb.config)) || effectiveConfig(goal, git);
}
/** 带入义务的求值配置 = 它自己的快照;旧记录没有快照 ⇒ 现行 ∪ 它那一批的基点。改名跟随见 followConfPaths。 */
const recConfig = (r, git = gitRun) => followConfPaths(configFromSnapshot(r.config) || effectiveConfig({ baseCommit: r.origin?.baseCommit }, git), r.origin?.baseCommit, git);

/** 批 298 r2(猎手 FB-3,诚实迁移):快照里的路径在 HEAD 不存在,而 `git diff -M --name-status 基点..HEAD` 显示它被改名到 curPath、
 *  且现行配置也指向 curPath ⇒ 返回 curPath;其余一律 null(照旧按快照路径核,不在就算缺)。文件与目录(目录内逐个改名)都认。 */
export const FOLLOW_UNKNOWN = Symbol("follow-unknown");
export function followRename(p, base, curPath, git = gitRun) {
  if (!p || !curPath || curPath === p || !(typeof base === "string" && base)) return null;
  // 批 298 r3(猎手 FB-6③):git 失败(基点不可达等)⇒ 返回 FOLLOW_UNKNOWN(判不了),不返回 null(null 会落成「缺」)
  let r; try { r = git(["ls-tree", "--name-only", "HEAD", "--", p]); } catch { return FOLLOW_UNKNOWN; }
  if (!r || r.status !== 0) return FOLLOW_UNKNOWN;
  if (String(r.stdout || "").trim()) return null;   // 原路径还在 ⇒ 不跟
  try { r = git(["diff", "-M", "--name-status", "-z", base, "HEAD"]); } catch { return FOLLOW_UNKNOWN; }
  if (!r || r.status !== 0) return FOLLOW_UNKNOWN;
  const parts = String(r.stdout || "").split("\0").map((x) => x.replace(/^\r?\n/, ""));
  for (let i = 0; i < parts.length;) {
    const st = parts[i];
    if (/^[RC]\d*$/.test(st)) {
      const from = parts[i + 1] || "", to = parts[i + 2] || ""; i += 3;
      if (/^R/.test(st) && from === p && to === curPath) return curPath;
      if (/^R/.test(st) && from.startsWith(p + "/") && to.startsWith(curPath + "/") && from.slice(p.length) === to.slice(curPath.length)) return curPath;
    } else i += 2;
  }
  return null;
}
/** 对一份求值配置的日记 / ADR 路径做改名跟随(只在现行配置合法时;现行配置指向哪里由它说了算)。 */
function followConfPaths(conf, base, git = gitRun) {
  if (!conf || conf.error) return conf;
  const cur = installConfig();
  if (cur.error) return conf;
  const d = followRename(conf.diary, base, cur.diary, git), a = followRename(conf.adrDir, base, cur.adrDir, git);
  if (d === FOLLOW_UNKNOWN || a === FOLLOW_UNKNOWN) return { ...conf, error: `改名跟随判不了(git diff 基点 ${String(base).slice(0, 10)}..HEAD 失败——基点不可达?)`, readError: true };
  return d || a ? { ...conf, ...(d ? { diary: d } : {}), ...(a ? { adrDir: a } : {}), followed: [d && `${conf.diary} → ${d}`, a && `${conf.adrDir} → ${a}`].filter(Boolean) } : conf;
}

/** 批 298 r1(codex §1 / 红队 BP-1、BP-6):批身份 = 批号 + armedAt + baseCommit,以武装台账(带 hash 链)里该批最后一条 arm 行为准。
 *  返回 { ok, row, why }。旧 arm 行没记 armedAt ⇒ 只比 baseCommit;一条 arm 行都没有 ⇒ 不 ok。 */
export function armIdentity(g, row = g ? lastArmRow(g.batch) : null) {
  if (!g || !g.batch) return { ok: false, row: null, why: "没有批" };
  if (!row) return { ok: false, row: null, why: `武装台账里没有批 ${g.batch} 的 arm 行(状态文件不是 --arm 写出来的)` };
  const sb = typeof g.baseCommit === "string" && g.baseCommit ? g.baseCommit : null, rb = typeof row.baseCommit === "string" && row.baseCommit ? row.baseCommit : null;
  if (sb !== rb) return { ok: false, row, why: `状态文件基点 ${String(sb).slice(0, 10)} ≠ 武装台账 ${String(rb).slice(0, 10)}` };
  if (typeof row.armedAt === "string" && row.armedAt !== (g.armedAt || null)) return { ok: false, row, why: `状态文件 armedAt ${g.armedAt} ≠ 武装台账 ${row.armedAt}` };
  return { ok: true, row };
}
/** 批 298 r1(codex §2)/ r2(猎手 FB-2):批台账里**当前批 arm 行之后**(含 arm 行自己)最后记下的义务账末行 { h, version };
 *  往前扫到最后一条 arm 行就停——更早的批记的锚不再约束(否则一次丢账会把这个 checkout 永久锁死)。没有 ⇒ null。 */
export function lastOblAnchor(file = JOURNAL) {
  let lines = []; try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return null; }
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lines[k].trim()) continue;
    let o; try { o = JSON.parse(lines[k]); } catch { continue; }
    if (o?.oblHead && typeof o.oblHead.h === "string") return o.oblHead;
    // 批 298 r3(codex ① / 红队 BP-1):arm 行自带武装那一刻的锚;义务账当时不可信写 anchorUnknown ⇒ 不停,继续往前找
    if (o?.action === "arm" && o.anchorUnknown === true) continue;
    if (o?.action === "arm" || o?.action === "accept-obligation-loss") return null;
  }
  return null;
}
/** 批 298 r3(codex 另项):坏配置的说法按基点有没有这份文件分开——基点没有就不说「基点合法、是本批改坏」,也不给 git show 基点。 */
function brokenConfigText(base, git = gitRun) {
  const err = installConfig().error;
  let r = null;
  if (typeof base === "string" && base) { try { r = git(["show", `${base}:${INSTALL_CONFIG_FILE}`]); } catch { r = null; } }
  // 批 298 r3(猎手 FB-4):三种说法——基点没有这份文件 / 基点版也解析不了 / 基点版合法
  const fixHint = "修好它(格式见 scripts/lib/install-config.mjs 头注;不要这份配置就删掉它),提交,再重跑。";
  if (!(r && r.status === 0)) return `现行 ${INSTALL_CONFIG_FILE} 解析失败(${err})(基点无此文件)。\n出路:${fixHint}`;
  const b = parseInstallConfig(String(r.stdout || ""), "基点版");
  if (b.error) return `现行 ${INSTALL_CONFIG_FILE} 解析失败(${err});基点那一版也解析不了(${b.error})——不是本批改坏的,但现在照样判坏。\n出路:${fixHint}`;
  return `${INSTALL_CONFIG_FILE} 在本批基点时是合法的,现在解析失败(${err})——是本批改坏的。\n出路:改回 ${INSTALL_CONFIG_FILE}(\`git show ${String(base).slice(0, 10)}:${INSTALL_CONFIG_FILE}\` 对照),提交,再重跑。`;
}
/** 批 298 r3(codex §3):确认义务账丢失的记录要看得见。current = 最后一条 clear 行之后(本批期间)的;latest = 全台账最近一条。 */
export function acceptLossRows(file = JOURNAL) {
  let rows = [];
  try { rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return { current: [], latest: null }; }
  let k = rows.length - 1;
  for (; k >= 0; k--) if (rows[k].action === "clear") break;
  const all = rows.filter((r) => r.action === "accept-obligation-loss");
  return { current: rows.slice(k + 1).filter((r) => r.action === "accept-obligation-loss"), latest: all[all.length - 1] || null };
}
const fmtAccept = (r) => `${String(r.at || "").slice(0, 19)} 批 ${r.batch}:理由「${r.reason}」;丢失前锚 ${r.lostAnchor ? `第 ${r.lostAnchor.version} 行 h=${String(r.lostAnchor.h).slice(0, 12)}…` : "无"};经手会话 ${r.by || "?"}`;
/** 批 298 r2(codex ②):写义务账的入口(--decision / --outcome / --withdraw / --settle)写前核锚;对不上 ⇒ 拒,给出路。 */
function requireAnchorOk(what) {
  const sd = OB.storeDir();
  if (sd.unknown) return;   // 取不到目录:写入本身会出声,--clear 时拒
  const snap = OB.readStore(sd.dir);
  if (!OB.TRUSTED.has(snap.kind)) return;
  const p = anchorProblem(snap);
  if (!p) return;
  console.error(`拒绝${what}:${p}。\n  不得在丢过的账上重建并覆盖旧锚。出路:停下告诉用户。**须用户确认后才用**:\`--arm <批号> <原条件…> --accept-obligation-loss "<理由>"\` 记一行并重开锚。`);
  process.exit(2);
}
/** 外部锚核对:最后记下的末行仍在义务账里、且义务账不短于它。 */
export function anchorProblem(snap, anchor = lastOblAnchor()) {
  if (!anchor) return null;
  if (!snap?.heads?.has(anchor.h)) return `批台账最后记下的义务账末行(第 ${anchor.version} 行,h=${anchor.h.slice(0, 12)}…)现在不在义务账里——台账被截短或整本换过`;
  if (Number(snap.version) < Number(anchor.version)) return `义务账只有 ${snap.version} 行,短于批台账记下的 ${anchor.version} 行`;
  return null;
}
const cfgDiary = () => installConfig().diary || "(未配置日记)";
const cfgAdrDir = () => installConfig().adrDir || "(未配置 ADR 目录)";
const cfgDebtTable = () => installConfig().debtTable || "docs/gate-debts.md";
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
// 批 305:开批记录旗标(只记录,不参与任何阻断;值由 parseArmMeta 读,parseArm 只负责跳过它们——返回形状不变)
const ARM_META_FLAGS = new Set(["--instruction", "--instruction-session", "--instruction-at", "--finish-line", "--cap-usd", "--deadline"]);
const KNOWN_ARM_FLAGS = new Set(["--arm", "--cond", "--check", "--expect", "--expect-re", "--force", "--accept-obligation-loss", ...ARM_META_FLAGS]);
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
    if (a === "--accept-obligation-loss") { val(i, a); i++; continue; }   // 批 298 r2:值是理由,由 --arm 分支自己读
    if (ARM_META_FLAGS.has(a)) { val(i, a); i++; continue; }              // 批 305:值由 parseArmMeta 读
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
/** 批 305:`--arm` 的开批记录旗标。全部可选,只记录:
 *    --instruction "<引出本批的那句指令,原话>"   [--instruction-session <会话号>] [--instruction-at <ISO 时刻>]
 *    --finish-line "<终点线:做到什么就停>"   --cap-usd <整批花费上限,美元>   --deadline <总截止时间,ISO>
 *  一个都没给 ⇒ { }(开批行为与以前逐字相同)。给了而值不合法 ⇒ 抛(用法错,退出 2;老用法碰不到)。
 *  会话号 / 时刻不给 ⇒ 开批时到本会话转录里按原话定位(见 locateInstructionForArm);给了时刻 ⇒ 照记,不再定位。 */
export function parseArmMeta(argv) {
  const get = (flag) => {
    const at = argv.map((a, i) => (a === flag ? i : -1)).filter((i) => i >= 0);
    if (!at.length) return undefined;
    if (at.length > 1) throw new Error(`${flag} 给了两次`);
    const v = argv[at[0] + 1];
    if (v === undefined || !String(v).trim()) throw new Error(`${flag} 缺值或为空`);
    if (/^--/.test(v)) throw new Error(`${flag} 的值不能以 -- 开头(得到「${v}」,像是漏写了值)`);
    return String(v);
  };
  const out = {};
  const text = get("--instruction"), sid = get("--instruction-session"), at = get("--instruction-at");
  if ((sid !== undefined || at !== undefined) && text === undefined) throw new Error("--instruction-session / --instruction-at 要和 --instruction 一起给");
  if (sid !== undefined && !/^[\w-]{8,80}$/.test(sid)) throw new Error(`--instruction-session「${sid}」不像会话号`);
  let atIso;
  if (at !== undefined) { const ms = Date.parse(at); if (!Number.isFinite(ms)) throw new Error(`--instruction-at「${at}」不是可解析的时刻(写 ISO 形,如 2026-11-16T08:30:00+08:00)`); atIso = new Date(ms).toISOString(); }
  if (text !== undefined) out.instruction = { text, ...(sid ? { sid } : {}), ...(atIso ? { at: atIso } : {}) };
  const fin = get("--finish-line");
  if (fin !== undefined) out.finishLine = fin;
  const usd = get("--cap-usd"), dl = get("--deadline");
  const caps = {};
  if (usd !== undefined) { if (!/^\d+(?:\.\d+)?$/.test(usd) || !(Number(usd) > 0)) throw new Error(`--cap-usd「${usd}」不是正数(只写数字,单位美元)`); caps.usd = Number(usd); }
  if (dl !== undefined) { const ms = Date.parse(dl); if (!Number.isFinite(ms)) throw new Error(`--deadline「${dl}」不是可解析的时刻(写 ISO 形)`); caps.deadline = new Date(ms).toISOString(); }
  if (Object.keys(caps).length) out.caps = caps;
  return out;
}
/** 批 298(2.2 K 行):`--clear --verdict "N=达成|未达成|不适用[:理由]"` 逐条裁决。一个都没给 ⇒ null(照旧);
 *  给了 ⇒ 编号须在 1..n、不重复、覆盖全部;值只认三个词;「未达成」「不适用」须带理由。只记进台账,不判真假(判断归模型)。 */
export function parseVerdicts(argv, n) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--verdict") continue;
    const v = argv[i + 1];
    if (v === undefined || !String(v).trim() || /^--/.test(v)) throw new Error("--verdict 缺值(写 \"N=达成\" / \"N=未达成:理由\" / \"N=不适用:理由\")");
    // 批 298 r1(猎手 FB-8):全角数字 / 全角等号归一,容忍句末标点
    const m = normWidth(String(v)).replace(/＝/g, "=").match(/^\s*(\d+)\s*=\s*(达成|未达成|不适用)\s*(?:[:：]\s*(.*?))?[\s。．.;；,，!！]*$/s);
    if (!m) throw new Error(`--verdict「${v}」格式不对(写 "N=达成|未达成|不适用[:理由]")`);
    const k = Number(m[1]);
    if (!(k >= 1 && k <= n)) throw new Error(`--verdict 条件编号 ${k} 不在 1..${n}`);
    if (out.some((x) => x.n === k)) throw new Error(`--verdict 条件 ${k} 给了两次`);
    if (m[2] !== "达成" && !String(m[3] || "").trim()) throw new Error(`--verdict 条件 ${k}「${m[2]}」须带理由(N=${m[2]}:理由)`);
    out.push({ n: k, verdict: m[2], ...(m[3] && m[3].trim() ? { why: m[3].trim().slice(0, 300) } : {}) });
  }
  if (!out.length) return null;
  const missing = Array.from({ length: n }, (_, i) => i + 1).filter((k) => !out.some((x) => x.n === k));
  if (missing.length) throw new Error(`--verdict 没覆盖全部条件:缺 ${missing.join("、")}`);
  return out.sort((a, b) => a.n - b.n);
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
//   在这里拒比在 Stop hook 里猜「这轮算不算收尾」窄得多。(立项时本文件不在闸引擎面里;2026-11-08 P0 收口起已纳入,改这里的拒绝点同样要过 D11 两猎手。)
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
//    批 298 r2 起:没配日记的仓不核;配了而文件不存在(ENOENT)⇒ 按「缺」拒清(建出来、加本批行、提交);
//    其它读错误 ⇒ unknown 拒清(BP-4,与 ADR 一侧同口径)。本批求值按武装时的配置快照,改名会跟随(见 install-config.mjs 头注)。
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
//   · 蓄意规避(手改状态文件删掉 decisions)不计——用户签的代价模型。(批 298 起:决定 / 成果另记在义务账,
//     --clear 按「状态文件 ∪ 义务账」核,手改状态文件删掉的那条照样核。)
//   · 批 298:ADR 目录与日记路径改读安装方配置(gate-install.json);没配的仓这两道与承重面零决定都不做(只出一行提示)。
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
    else if (o.action === "clear" || o.action === "force-over-obligations" || o.action === "force-carry-obligations") for (const d of [].concat(o.decisions || [], o.withdrawn || [])) max = Math.max(max, decisionNo(d?.id ?? d));
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
export function adrCoverage(decisions, baseCommit, git = gitRun, adrDir = installConfig().adrDir) {
  const ids = arr(decisions).map((d) => d && d.id).filter((x) => typeof x === "string" && x);
  if (!ids.length) return { missing: [], notes: [] };
  // 批 298:安装方没配 ADR 目录 ⇒ 不做 ADR 核对(只出声)
  if (!adrDir) return { missing: [], notes: [`本仓没配 ADR 目录(${INSTALL_CONFIG_FILE} 无 adrDir)——决定的 ADR 覆盖核对跳过`] };
  const ADR_DIR = adrDir;
  const adrRe = new RegExp(`^${reEsc(adrDir)}/\\d{4}-[^/]+\\.md$`, "i");
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
  // 批 298 r2(猎手 FB-4):配置写了 ADR 目录、HEAD 里却没有 ⇒ 按「缺 ADR」报(给模板,且须已提交),不判不了、也不跳过
  if (!files.length) {
    let r; try { r = git(["ls-tree", "--name-only", "HEAD", "--", ADR_DIR]); } catch (e) { return { unknown: true, why: e.message }; }
    if (r && r.status === 0 && !String(r.stdout || "").trim()) notes.push(`${ADR_DIR} 在 HEAD 里不存在(配置写了这个目录)——按缺报,建目录写 ADR 并提交`);
  }
  const texts = [];
  for (const f of files.map((x) => x.replace(/\\/g, "/")).filter((x) => adrRe.test(x))) {
    // BP-10:show 失败 ⇒ 判不了(unknown,拒清),不当成「这张没写编号」报缺 ADR——报缺会把人引去补一张根本不缺的 ADR。
    let r; try { r = git(["show", `HEAD:${f}`]); } catch (e) { return { unknown: true, why: `git show HEAD:${f} 抛错(${e.message})` }; }
    if (!r || r.status !== 0) return { unknown: true, why: `git show HEAD:${f} 失败(${String(r?.stderr || "").trim() || "无输出"})` };
    texts.push(String(r.stdout || ""));
  }
  return { missing: ids.filter((id) => !texts.some((t) => adrDeclaresId(t, id))), notes };
}

/** 有基点时取 `git diff <基点> HEAD -- 日记` 的新增行(批 256b BP-2);取不到 ⇒ {note}(调用方退回全文)。 */
export function diaryAddedLines(baseCommit, git = gitRun, DIARY = installConfig().diary) {
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
//   批 298(安装方配置接缝):原表拆成两半——闸自己的通用面写在这里;安装方专属的(HostApp:docs/gate/AGENTS.md、
//   docs/laws/、存档法典、verify-prod.mjs、两份寄存器)搬进 gate-install.json 的 loadBearingExtra。两半之并与原表在
//   同一组路径上逐条相等(自测「298 承重面拆分等价」钉住);新加的只有本批新文件(obligations / install-config / gate-install.json)。
export const LOAD_BEARING_GENERIC = /^(?:AGENTS\.md$|CLAUDE\.md$|\.claude\/(?:agents|skills|commands)\/|\.claude\/settings(?:\.[\w-]+)?\.json$|scripts\/hook-[^/]+\.mjs$|scripts\/lib\/(?:gate-[^/]+|write-effects|obligations|install-config)\.mjs$|scripts\/(?:fp-audit|gate-replay|batch-goal|install-git-hooks)\.mjs$|scripts\/gate-deps\/package(?:-lock)?\.json$|scripts\/git-hooks\/|gate-install\.json$)/i;
export const isLoadBearingPath = (p, extra = installConfig().loadBearingExtra || []) => LOAD_BEARING_GENERIC.test(p) || arr(extra).some((re) => re.test(p));
export function loadBearingTouched(baseCommit, git = gitRun, extra = installConfig().loadBearingExtra || [], head = "HEAD") {
  if (!(typeof baseCommit === "string" && baseCommit)) return { paths: [], note: "本批武装时没记基点——「承重面零决定」核对跳过" };
  //   --no-renames:改名时两侧路径都列出(红队 r4 BP-4:把 skill 挪出承重面,原先 diff 只剩新路径)
  let r; try { r = git(["diff", "--name-only", "--no-renames", "-z", baseCommit, head]); } catch (e) { return { unknown: true, why: e.message }; }
  if (!r || r.status !== 0) return { unknown: true, why: String(r?.stderr || "git diff 失败").trim() || "git diff 失败" };
  const paths = String(r.stdout || "").split("\0").map((x) => x.trim().replace(/\\/g, "/")).filter(Boolean)
    //   红队 r6 BP-20:手抄表只是子集(漏 package.json / verify-laws / perm-match…)⇒ 并上 P 实际用的判据面,不再另抄;
    //   codex 276-r6-fix-audit 附 3:用 isCarrierPath(CARRIER_SURFACE, …)(排除暂存 / 依赖 / 构建区),不用裸 isLoadBearing
    .filter((p) => (isLoadBearingPath(p, extra) || isCarrierPath(CARRIER_SURFACE, p)) && !/\.(?:selftest|test|spec)\.[cm]?[jt]s$/i.test(p));
  return { paths };
}

/** --no-decision 的理由是不是照抄了拒清消息里的模板(红队 r6 BP-23:「决定在批 N」/「<为什么…>」原样贴回)。 */
//   误拦 r7 FB-5:只认消息给过的模板原串,不认任意尖括号(「只改 <details> 折叠块」「Map<string, Node>」是真理由)
export const isTemplateReason = (t) => /批\s*N\b|<为什么本批没有决定>|<那一批的真实批号>|<一句话>|<理由>/.test(String(t || ""));

/** --clear 的检查。io 可注入:{git, readDiary():string|null(不存在=null), adrNames():string[]}。 */
export function obligationCheck(goal, io = {}) {
  const git = io.git || gitRun;
  // 批 298:unknownParts 按部位记判不了(义务账据此只把那一类义务记成 UNKNOWN);unknown 串照旧。
  const out = { notes: [], missingDecisions: [], diaryMissing: false, noDecisionTouched: [], unknown: null, unknownParts: {} };
  const decisions = arr(goal?.decisions), outcomes = arr(goal?.outcomes);
  const unk = [];
  const conf = io.config || effectiveConfig(goal, git);
  if (conf.error) {
    out.unknown = `安装方配置判不了:${conf.error}(出路:修好仓根 ${INSTALL_CONFIG_FILE})`;
    out.unknownParts = { config: true, adr: true, diary: true, loadBearing: true };
    return out;
  }
  if (conf.mergedFromBase) out.notes.push(`${INSTALL_CONFIG_FILE} 在本批基点之后关掉或改动了核对——按基点那一版并入(批内改配置关不掉基点时已开着的核对)`);
  if (!conf.adrDir) {
    if (decisions.length || goal?.baseCommit) out.notes.push(`本仓没配 ADR 目录(${INSTALL_CONFIG_FILE} 缺或无 adrDir)——决定的 ADR 覆盖与承重面零决定核对都不做`);
  } else if (decisions.length) {
    const c = adrCoverage(decisions, goal?.baseCommit, git, conf.adrDir);
    if (c.unknown) { unk.push(`ADR 覆盖:${c.why || "git 不可用"}`); out.unknownParts.adr = true; }
    else { out.notes.push(...c.notes); out.missingDecisions = c.missing; }
  } else if (!goal?.noDecision || isTemplateReason(goal.noDecision.text)) {
    const lb = loadBearingTouched(goal?.baseCommit, git, conf.loadBearingExtra || []);
    if (lb.unknown) { unk.push(`承重面零决定核对:${lb.why}`); out.unknownParts.loadBearing = true; }
    else { if (lb.note) out.notes.push(lb.note); out.noDecisionTouched = lb.paths; }
  }
  if (outcomes.length && !conf.diary) out.notes.push(`本仓没配产品日记(${INSTALL_CONFIG_FILE} 缺或无 diary)——成果的日记核对不做`);
  else if (outcomes.length) {
    const DIARY = conf.diary;
    // BP-4:只有 ENOENT 算「这个仓没有日记」;其它读错误判不了 ⇒ unknown 拒清(与 ADR 一侧同口径)。
    let md = null, readErr = null;
    try { md = io.readDiary ? io.readDiary() : fs.readFileSync(DIARY, "utf8"); }
    catch (e) { if (e?.code !== "ENOENT") readErr = e; md = null; }
    if (readErr) { unk.push(`日记读不了(${readErr?.code || readErr?.message})`); out.unknownParts.diary = true; }
    // 批 298 r2(猎手 FB-4):配置写了日记路径、文件却不在 ⇒ 按「缺」报(建出来、加本批行、提交);只有读错误才判不了
    else if (md === null) { out.diaryMissing = true; out.notes.push(`${DIARY} 不存在(配置写了这个路径)——按缺报:建出这份日记、加本批行并提交`); }
    else {
      const d = diaryAddedLines(goal?.baseCommit, git, DIARY);
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
  const ADR_DIR = installConfig().adrDir;
  if (ADR_DIR) try { for (const f of fs.readdirSync(ADR_DIR)) { const m = f.match(/^(\d{4})-/); if (m) max = Math.max(max, Number(m[1])); } } catch { /* 无目录 ⇒ 0001 */ }
  return String(max + 1).padStart(4, "0");
}
function printObligationRefusal(goal, obl) {
  const batch = goal?.batch;
  const ADR_DIR = cfgAdrDir(), DIARY = cfgDiary();
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

// ── 批 298:义务账接线(格式与状态机见 lib/obligations.mjs 头注;本文件负责三类保留类型的求值与批归属)──────────
const sidEnv = () => (typeof process.env.CLAUDE_CODE_SESSION_ID === "string" && /^[\w-]{8,80}$/.test(process.env.CLAUDE_CODE_SESSION_ID) ? process.env.CLAUDE_CODE_SESSION_ID : null);
export function normCheckout(p) {
  if (!p) return null;
  let s = String(p);
  try { s = fs.realpathSync.native(s); } catch { /* 不存在就按原样 */ }
  s = s.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}
function checkoutRoot(git = gitRun) {
  try { const r = git(["rev-parse", "--show-toplevel"]); if (r && r.status === 0 && String(r.stdout).trim()) return normCheckout(String(r.stdout).trim()); } catch { /* 退回 cwd */ }
  return normCheckout(process.cwd());
}
const oblCtx = () => ({ sid: sidEnv(), checkout: checkoutRoot() });
/** 批键 = 批号 + 武装时刻(同号重放保留 armedAt ⇒ 键不变;结清后同号重开 ⇒ 新键)。 */
export const batchKeyOf = (g) => (g && g.batch !== undefined && g.batch !== null ? { batch: String(g.batch), armedAt: typeof g.armedAt === "string" ? g.armedAt : null } : null);
export const sameKey = (a, b) => !!(a && b && String(a.batch) === String(b.batch) && (a.armedAt || null) === (b.armedAt || null));
/** 未归属的义务并入谁:**只看 checkout**——同一 checkout 的并入,别的 checkout 的不并入(批 298 r2;会话号每次换会话都变,不作判据)。 */
//   批 298 r2(红队 BP-1 / codex ⑤ / 猎手 FB-1):统一判据 = **checkout 相同**,不看会话号。会话号每次换会话都变,
//   按它认领会让到期债谁都认不回;owner 只作记录(换批带入时更新为经手会话)。sid 参数保留签名、不参与判定。
export const ownerMatches = (rec, sid, checkout) => !!checkout && rec.checkout === checkout;
const isDone = (r) => r.status === "cleared" || r.status === "withdrawn";
const recLabel = (r) => r.type === "decision-adr" ? `决定 ${r.payload?.id}` : r.type === "outcome-diary" ? `成果 ${r.origin?.batch}:O${r.payload?.n}` : r.type === "load-bearing-decision" ? `批 ${r.origin?.batch} 承重面零决定` : `${r.type}${r.payload?.path ? ` ${r.payload.path}` : ""}`;
const OUTLETS = {
  "decision-adr": (id) => `写 / 改一张 ADR,在声明语境里写「决定编号:${id}」(或旧 ADR 上「被 ${id} 取代」)并提交;登记错了 --withdraw ${id} --reason "…"`,
  "outcome-diary": (b, n) => `产品日记加一行、事项栏第一个批号标记是「批 ${b}」,并提交;登记错了 --withdraw ${b}:O${n} --reason "…"`,
  "load-bearing-decision": (b) => `批 ${b} 触及承重面却零决定:--decision "<一句话>" 登记并写 ADR,或 --no-decision "<为什么没有决定>"`,
};

/** 把一份批状态里的决定 / 成果 / 承重面核对导入成义务记录(已有的不重复建);状态里的已撤项同步成 withdrawn。 */
//   confSnap(批 298 r1 配置冻结):本批求值配置的快照(调用方在锁外算好,snapshotConfig 形);本批已有记录带快照的,沿用那一份
export function syncCurrent(draft, g, ctx, by = "batch-goal:sync", confSnap = null) {
  const key = batchKeyOf(g);
  if (!key || g.cleared || !Array.isArray(g.conditions) || !g.conditions.length) return;
  const origin = { ...key, baseCommit: typeof g.baseCommit === "string" && g.baseCommit ? g.baseCommit : null };
  const owner = typeof g.armedBy === "string" && g.armedBy ? g.armedBy : ctx.sid;
  const mine = () => draft.list().filter((r) => sameKey(r.origin, key));
  let m = mine();
  const snap = (m.find((r) => r.type === "load-bearing-decision" && r.config) || m.find((r) => r.config))?.config || confSnap;
  const mk = (type, payload, outlet, trigger) => OB.createObligation(draft, { type, owner, checkout: ctx.checkout, origin, batch: key, payload, outlet, trigger, config: snap, op: "import" }, by);
  for (const d of arr(g.decisions)) if (d?.id && !m.some((r) => r.type === "decision-adr" && r.payload?.id === d.id)) mk("decision-adr", { id: d.id, text: d.text }, OUTLETS["decision-adr"](d.id), { via: "--decision", at: d.at || null });
  for (const o of numberOutcomes(g.outcomes)) if (!m.some((r) => r.type === "outcome-diary" && r.payload?.n === o.n)) mk("outcome-diary", { n: o.n, text: o.text }, OUTLETS["outcome-diary"](key.batch, o.n), { via: "--outcome", at: o.at || null });
  if (!m.some((r) => r.type === "load-bearing-decision")) mk("load-bearing-decision", {}, OUTLETS["load-bearing-decision"](key.batch), { via: "--arm", baseCommit: origin.baseCommit });
  m = mine();
  for (const w of arr(g.withdrawn)) {
    const r = m.find((x) => (w?.kind === "decision" ? x.type === "decision-adr" && x.payload?.id === w.id : x.type === "outcome-diary" && x.payload?.n === w.n));
    if (r && r.status !== "withdrawn") draft.put({ ...r, status: "withdrawn", lastResult: { at: new Date().toISOString(), result: "withdrawn", by: "batch-goal --withdraw", why: w.reason } }, { op: "withdraw", by: "batch-goal --withdraw", why: w.reason });
  }
}

/** `--arm` 时的带入:上一批(本 checkout)名下未清的义务原样并入新批;未归属、属于本 checkout 的并入;转欠账到期的回到开着,同 checkout 的并入(只看 checkout)。 */
//   key0:被换掉 / 重放的那一批的键(调用方按武装台账定,不信状态文件);curConf:那一批导入时用的配置快照
export function armCarry(draft, cur, newKey, ctx, { head = null, forced = false, key0 = batchKeyOf(cur), curConf = null } = {}) {
  if (cur && !cur.cleared) syncCurrent(draft, { ...cur, ...(key0 ? { armedAt: key0.armedAt } : {}) }, ctx, "batch-goal:arm-import", curConf);
  const switching = !!key0 && !sameKey(key0, newKey);
  const num = OB.batchNumber(newKey.batch);
  const out = { carried: [], adopted: [], reopened: [], reopenedOthers: [] };
  for (const r of draft.list()) {
    if (isDone(r)) continue;
    if (r.status === "settled") {
      if (Number.isFinite(num) && Number(r.settle?.expiry) < num) {
        // 批 298 r2(红队 BP-1 / codex ⑤):到期回到开着;同一 checkout 的并入本批(不看会话号),别的 checkout 的回到「未归属」只在 --status 列出
        const same = ownerMatches(r, ctx.sid, ctx.checkout);
        draft.put({ ...r, status: "open", unknownStreak: 0, batch: same ? newKey : null, ...(same && ctx.sid ? { owner: ctx.sid } : {}), settle: { ...r.settle, expiredAt: new Date().toISOString() } },
          { op: "reopen", by: "batch-goal --arm", why: `转欠账 ${r.settle?.debtId}(≤${r.settle?.expiry})到期未结,回到开着${same ? `,并入批 ${newKey.batch}` : "(别的 checkout 的,不并入,等那个 checkout 开批认领)"}` });
        (same ? out.reopened : out.reopenedOthers).push(r);
      }
      continue;
    }
    if (switching && sameKey(r.batch, key0)) {
      const next = { ...r, batch: newKey, ...(ctx.sid ? { owner: ctx.sid } : {}) };   // owner 更新为经手会话(只作记录)
      if (r.type === "load-bearing-decision" && sameKey(r.origin, key0) && !r.payload?.carriedHead) {
        next.payload = { ...r.payload, carriedHead: head, hadDecision: arr(cur?.decisions).length > 0,
          noDecision: cur?.noDecision && !isTemplateReason(cur.noDecision.text) ? String(cur.noDecision.text) : null };
      }
      draft.put(next, { op: "adopt", by: "batch-goal --arm", why: `批 ${key0.batch} ${cur?.cleared ? "已结清" : "未结清"}即${forced ? " --force " : ""}换批 ${newKey.batch},原样带入` });
      out.carried.push(r);
    } else if (!r.batch && ownerMatches(r, ctx.sid, ctx.checkout)) {
      draft.put({ ...r, batch: newKey, ...(ctx.sid ? { owner: ctx.sid } : {}) }, { op: "adopt", by: "batch-goal --arm", why: "未归属、属于本 checkout 的义务并入本批" });
      out.adopted.push(r);
    }
  }
  return out;
}

/** --clear 用:批状态 ∪ 义务账里本批自己的决定 / 成果(手改状态文件删掉的那条照样核)。 */
export function unionGoal(prev, recs) {
  const key = batchKeyOf(prev);
  const mine = arr(recs).filter((r) => sameKey(r.origin, key) && r.status !== "withdrawn");
  const decisions = arr(prev?.decisions).slice();
  for (const r of mine) if (r.type === "decision-adr" && r.payload?.id && !decisions.some((d) => d?.id === r.payload.id)) decisions.push({ id: r.payload.id, text: r.payload.text });
  const outcomes = numberOutcomes(prev?.outcomes);
  for (const r of mine) if (r.type === "outcome-diary" && Number.isInteger(r.payload?.n) && !outcomes.some((o) => o.n === r.payload.n)) outcomes.push({ n: r.payload.n, text: r.payload.text });
  return { ...prev, decisions, outcomes };
}

/** 本批自己的保留类型:结论取自 obligationCheck(与原核对同一份判定,行为不变)。 */
export function currentResult(r, obl) {
  const u = obl.unknownParts || {};
  if (u.config) return { result: "unknown", why: obl.unknown };
  if (r.type === "decision-adr") return u.adr ? { result: "unknown", why: obl.unknown } : arr(obl.missingDecisions).includes(r.payload?.id) ? { result: "open", why: "ADR 里没有声明这个编号" } : { result: "cleared", why: "ADR 覆盖核对通过" };
  if (r.type === "outcome-diary") return u.diary ? { result: "unknown", why: obl.unknown } : obl.diaryMissing ? { result: "open", why: "日记缺本批行" } : { result: "cleared", why: "日记核对通过(或本仓不做)" };
  if (r.type === "load-bearing-decision") return u.loadBearing ? { result: "unknown", why: obl.unknown } : arr(obl.noDecisionTouched).length ? { result: "open", why: `触及承重面零决定:${obl.noDecisionTouched.slice(0, 3).join("、")}` } : { result: "cleared", why: "承重面零决定核对通过(或已登记决定 / 已声明)" };
  return null;
}

/** 带进来的(别的批产生的)保留类型:按它产生时那一批的基点与批号求值。 */
export function carriedResult(r, goalU, confIn, io = {}) {
  const git = io.git || gitRun;
  // 批 298 r1(配置冻结):按记录自己的快照求值,不按现行 / 新批配置;旧记录没快照才用调用方给的
  const conf = confIn || configFromSnapshot(r.config);   // 调用方给的是「快照 + 改名跟随」(recConfig),优先用它
  if (!conf || conf.error) return { result: "unknown", why: `安装方配置判不了:${conf?.error || "缺"}` };
  const o = r.origin || {};
  if (r.type === "decision-adr") {
    if (!conf.adrDir) return { result: "cleared", why: "本仓不做 ADR 核对" };
    const c = adrCoverage([{ id: r.payload?.id }], o.baseCommit, git, conf.adrDir);
    if (c.unknown) return { result: "unknown", why: `ADR 覆盖:${c.why}` };
    return c.missing.length ? { result: "open", why: `ADR 里没有声明 ${r.payload?.id}(按批 ${o.batch} 的基点 ${String(o.baseCommit || "无").slice(0, 10)} 起算)` } : { result: "cleared", why: "ADR 覆盖核对通过" };
  }
  if (r.type === "outcome-diary") {
    if (!conf.diary) return { result: "cleared", why: "本仓不做日记核对" };
    let md;
    try { md = io.readDiary ? io.readDiary() : fs.readFileSync(conf.diary, "utf8"); }
    catch (e) { return e?.code === "ENOENT" ? { result: "open", why: `${conf.diary} 不存在(配置写了这个路径)——按缺报` } : { result: "unknown", why: `日记读不了(${e?.code || e?.message})` }; }
    const d = diaryAddedLines(o.baseCommit, git, conf.diary);
    const ok = d.lines ? diaryHasBatch(d.lines.join("\n"), o.batch) : diaryHasBatch(md, o.batch);
    return ok ? { result: "cleared", why: "日记核对通过" } : { result: "open", why: `日记缺「批 ${o.batch}」行${d.lines ? `(只认基点 ${String(o.baseCommit).slice(0, 10)} 之后新增的行)` : ""}` };
  }
  if (r.type === "load-bearing-decision") {
    if (!conf.adrDir) return { result: "cleared", why: "本仓不做承重面零决定核对" };
    if (r.payload?.hadDecision || r.payload?.noDecision) return { result: "cleared", why: `批 ${o.batch} 换批前已登记决定 / 已声明无决定` };
    if (arr(goalU?.decisions).length || (goalU?.noDecision && !isTemplateReason(goalU.noDecision.text))) return { result: "cleared", why: `由批 ${goalU?.batch} 的决定登记 / 无决定声明承接` };
    const lb = loadBearingTouched(o.baseCommit, git, conf.loadBearingExtra || [], r.payload?.carriedHead || "HEAD");
    if (lb.unknown) return { result: "unknown", why: `承重面零决定核对:${lb.why}` };
    return lb.paths.length ? { result: "open", why: `批 ${o.batch} 触及承重面零决定:${lb.paths.slice(0, 3).join("、")}` } : { result: "cleared", why: "未触及承重面(或无基点)" };
  }
  return null;
}

/** 批 298 r1:--clear 的锁外计划。所有 git / 读文件(取证)在这里做完;返回锁内落笔要用的结论与本批相关记录的指纹。 */
export function planClear(prev, recs, ctx, io = {}) {
  const git = io.git || gitRun;
  const key = batchKeyOf(prev);
  const adoptable = (r) => !isDone(r) && r.status !== "settled" && ((prev.carriedFrom && sameKey(r.batch, prev.carriedFrom)) || (!r.batch && ownerMatches(r, ctx.sid, ctx.checkout)));
  const relevant = (list) => list.filter((r) => sameKey(r.batch, key) || sameKey(r.origin, key) || adoptable(r));
  const rel = relevant(arr(recs));
  const conf = io.config || followConfPaths(batchConfig(prev, recs, git), prev.baseCommit, git);
  const goalU = unionGoal(prev, recs);
  const obl = obligationCheck(goalU, { ...io, git, config: conf });
  if (conf.followed?.length) obl.notes.push(`配置快照里的路径在基点之后被改名,且现行配置也指向新路径 ⇒ 按新路径核:${conf.followed.join(";")}`);
  const carried = {};
  for (const r of rel) if (OB.RESERVED_TYPES.has(r.type) && !sameKey(r.origin, key) && r.status !== "withdrawn") carried[r.id] = carriedResult(r, goalU, recConfig(r, git), io);
  const tables = {};
  for (const r of rel.filter((x) => x.status === "settling")) {
    const t = r.settle?.table || conf.debtTable || "docs/gate-debts.md";
    if (!(t in tables)) { let g; try { g = git(["show", `HEAD:${t}`]); } catch { g = null; } tables[t] = g && g.status === 0 ? String(g.stdout || "") : null; }
  }
  const fpOf = (list) => relevant(arr(list)).map((r) => `${r.id}:${r.rev}`).sort().join(",");
  return { key, conf, confSnap: snapshotConfig(conf), goalU, obl, carried, tables, fp: fpOf(recs), fpOf, head: headCommit(git), writeChecks: io.writeChecks || null };
}
/** 批 298 r1:--clear 的锁内落笔。不做 git;本批相关记录的指纹变了 ⇒ CONFLICT(调用方重读重算一次)。 */
export function applyClearPlan(draft, prev, plan, ctx) {
  if (plan.fpOf(draft.list()) !== plan.fp) throw new OB.ObligationError("CONFLICT", "本批名下的义务在读与写之间被别的进程改过");
  const key = plan.key;
  syncCurrent(draft, prev, ctx, "batch-goal:clear-import", plan.confSnap);
  for (const r of draft.list()) {
    if (isDone(r) || r.status === "settled") continue;
    const fromPrev = prev.carriedFrom && sameKey(r.batch, prev.carriedFrom);
    if (fromPrev || (!r.batch && ownerMatches(r, ctx.sid, ctx.checkout))) draft.put({ ...r, batch: key }, { op: "adopt", by: "batch-goal --clear", why: fromPrev ? `换批时没带过来(上一批 ${prev.carriedFrom.batch}),结清时补带` : "未归属、属于本 checkout 的义务并入本批" });
  }
  // 保留类型每次 --clear 都重算(「已清」对它们不是粘性的:批没结清前把 ADR 删掉,照原口径要再拒);产生器的「已清」是粘性的
  for (const r0 of draft.list().filter((r) => sameKey(r.batch, key) && r.status !== "withdrawn" && (r.status !== "cleared" || OB.RESERVED_TYPES.has(r.type)))) {
    const res = !OB.RESERVED_TYPES.has(r0.type) ? null : sameKey(r0.origin, key) ? currentResult(r0, plan.obl)
      : (plan.carried[r0.id] || { result: "unknown", why: "这条带入义务不在锁外计划里(读写之间新增)——重跑 --clear" });
    if (res && r0.status === "cleared" && res.result !== "cleared") {
      draft.put({ ...r0, status: res.result, unknownStreak: res.result === "unknown" ? 1 : 0, lastResult: { at: new Date().toISOString(), result: res.result, by: `evaluator:${r0.type}@clear`, why: res.why } }, { op: "reopen", by: `evaluator:${r0.type}@clear`, why: res.why });
    } else if (res) OB.applyEvaluation(draft, r0, res, `evaluator:${r0.type}@clear`);
    const r = draft.get(r0.id);
    if (r.status === "settling") {
      const text = plan.tables[r.settle?.table || plan.conf.debtTable || "docs/gate-debts.md"];
      if (text != null && OB.debtRowCommitted(text, r)) draft.put({ ...r, status: "settled", settle: { ...r.settle, confirmedAt: new Date().toISOString(), confirmedHead: plan.head } }, { op: "settle", by: "batch-goal --clear", why: `HEAD 里已提交债表行 ${r.settle.debtId}(≤${r.settle.expiry})` });
    }
  }
  if (plan.writeChecks) applyWriteChecks(draft, prev, plan.writeChecks, key, ctx);   // 批 301:写入类义务(T / MF / J / M)
  return draft.list().filter((r) => sameKey(r.batch, key));
}

/** 义务账不可信时的拒清原因与出路。 */
function storeRefusal(kind, why) {
  if (kind === "tampered") return { reason: "obligations-tampered", msg: `义务账的状态文件与台账对不上(${why})`, outlet: "node --no-warnings scripts/batch-goal.mjs --repair-obligations(只按台账重建状态文件,不改任何结论),再 --clear" };
  if (kind === "ledger-broken") return { reason: "obligations-ledger-broken", msg: why, outlet: "停下告诉用户:台账行被改写,自动修会把改写过的历史洗成真相——只有用户能裁(--repair-obligations 对这种情况拒做)" };
  if (kind === "torn") return { reason: "obligations-unknown", msg: why, outlet: "node --no-warnings scripts/batch-goal.mjs --repair-obligations(截掉撕裂残片,原样备份),再 --clear" };
  // 批 298 r3(猎手 FB-3):与 requireAnchorOk 同一句出路
  if (kind === "anchor") return { reason: "obligations-tampered", msg: why, outlet: "停下告诉用户:义务账被整本换过或截短,本层无法自证——只有用户能裁。**须用户确认后才用**:`--arm <批号> <原条件…> --accept-obligation-loss \"<理由>\"` 记一行并重开锚" };
  if (kind === "identity") return { reason: "obligations-tampered", msg: why, outlet: "照武装时的条件逐字原样重放 `--arm <批号> --cond …`(批身份从武装台账恢复);对不上就 --history 对照,停下告诉用户" };
  // 批 298 r1(猎手附二①):按真实原因分三种说,不写「无人续」(锁没有续租)
  if (kind === "conflict") return { reason: "obligations-unknown", msg: why, outlet: "别的进程在本次读与写之间改了本批名下的义务——直接重跑 --clear(会重读重算)" };
  if (kind === "lock-timeout") return { reason: "obligations-unknown", msg: why, outlet: "等持有写锁的那个进程结束后重跑;它若已死,拿锁满 30 s 后锁会被当陈锁夺走,届时重跑即可" };
  return { reason: "obligations-unknown", msg: why, outlet: "义务账目录 / 文件读不了:查权限、杀毒占用、磁盘;修好后重跑" };
}
/** 库错误码 ⇒ storeRefusal 的 kind。 */
const errKind = (e) => (e?.code === "PARTIAL" ? (e.chainBroken ? "ledger-broken" : "torn")   // 批 298 r3:写到一半——链断 ⇒ 停下告诉用户;只是 state 落后 ⇒ repair
  : ({ CONFLICT: "conflict", "LOCK-TIMEOUT": "lock-timeout", TAMPERED: "tampered", "LEDGER-BROKEN": "ledger-broken", TORN: "torn" })[e?.code] || "unknown");

/** 本 checkout 当前批状态(结清态也返回)的义务摘要。readStore 结果 + 批状态 ⇒ { key, mine, unassignedMine, unassignedOthers, settledAll }。 */
function oblView(snap, g, ctx) {
  const key = g && !g.cleared ? batchKeyOf(g) : null;
  const all = arr(snap?.obligations);
  return {
    key,
    mine: key ? all.filter((r) => sameKey(r.batch, key) && !isDone(r)) : [],
    unassignedMine: all.filter((r) => !r.batch && !isDone(r) && ownerMatches(r, ctx.sid, ctx.checkout)),
    unassignedOthers: all.filter((r) => !r.batch && !isDone(r) && !ownerMatches(r, ctx.sid, ctx.checkout)),
    settledAll: all.filter((r) => r.status === "settled"),
  };
}
const statusZh = { open: "开着", unknown: "判不了", settling: "转欠账待提交", settled: "已转欠账", cleared: "已清", withdrawn: "已撤" };
const fmtRec = (r) => `${r.id} [${statusZh[r.status] || r.status}${r.status === "unknown" ? ` ×${r.unknownStreak || 0}` : ""}] ${recLabel(r)}${r.settle?.debtId ? `(${r.settle.debtId} ≤${r.settle.expiry})` : ""}`;

/** --decision / --outcome / --withdraw 之后把批状态同步进义务账。失败只出声(--clear 时会从状态文件补导入)。 */
//   返回新的 oblHead({h, version})或 null;调用方把它记进批台账那一行(批 298 r1 外部锚覆盖每个写点)
function syncStoreQuiet(g) {
  const sd = OB.storeDir();
  if (sd.unknown) { console.error(`⚠ 义务账没记上(${sd.why})——--clear 时会从状态文件补导入;在那之前手改状态文件删掉的项核不到`); return null; }
  try {
    const ctx = oblCtx();
    const snap0 = OB.readStore(sd.dir);
    const confSnap = snapshotConfig(batchConfig(g, snap0.obligations));   // git 在锁外
    const r = OB.mutateStore(sd.dir, (d) => syncCurrent(d, g, ctx, "batch-goal:sync", confSnap));
    return r.head ? { h: r.head, version: r.version } : null;
  } catch (e) { console.error(`⚠ 义务账没记上(${e.code || ""} ${e.message})——--clear 时会从状态文件补导入;在那之前手改状态文件删掉的项核不到`); return null; }
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
  requireAnchorOk(kind === "decision" ? "登记决定" : "登记成果");   // 批 298 r2(codex ②):写前核锚,不在丢过的账上重建
  try { atomicWrite({ ...cur, [key]: list }, Number(cur.version) || 0); } catch (e) { console.error(e.message); process.exit(2); }
  const oh = syncStoreQuiet({ ...cur, [key]: list });   // 批 298:同时记进义务账(换批 / --force 带得走,手改状态文件删不掉)
  journal(kind, { batch: cur.batch, ...item, ...(oh ? { oblHead: oh } : {}) });   // oblHead:外部锚(批 298 r1)
  // 批 298 r2:提示按本批冻结的配置快照说(武装时那一版),与 --clear 的求值同口径
  const conf = (() => { const sd = OB.storeDir(); const recs = sd.unknown ? [] : OB.readStore(sd.dir).obligations; return batchConfig(cur, recs); })();
  if (kind === "decision") console.log(`已登记决定 ${item.id}:${item.text}\n  ${conf.adrDir ? `--clear 时要求 ${conf.adrDir}/NNNN-*.md(本批基点之后新增或修改、且已提交)里有一行「决定编号:${item.id}」或「被 ${item.id} 取代」(目录按本批武装时的配置快照;目录不在算缺)。` : `本批武装时的配置没配 ADR 目录(${INSTALL_CONFIG_FILE}),--clear 不核 ADR。`}`);
  else console.log(`已登记可见成果 O${item.n}:${item.text}\n  ${conf.diary ? `--clear 时要求 ${conf.diary}(本批武装时的配置快照;改名会跟随)有一行基点之后新增、且已提交的事项栏第一个批号标记是「批 ${cur.batch}」;文件不在算缺,读不了才算判不了。` : `本批武装时的配置没配产品日记(${INSTALL_CONFIG_FILE}),--clear 不核日记。`}`);
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
  requireAnchorOk("撤回");   // 批 298 r2(codex ②)
  const loc = locateWithdraw(cur, a.target);
  if (loc.error) {
    // 批 298:本批状态里没有 ⇒ 再找换批带进来的(别的批登记的决定 / 成果;成果写 <批号>:O<n>)
    const sd = OB.storeDir();
    if (!sd.unknown) {
      const snap = OB.readStore(sd.dir);
      const key = batchKeyOf(cur);
      const om = String(a.target).match(/^(.+):O0*(\d+)$/i);
      const hit = OB.TRUSTED.has(snap.kind) ? arr(snap.obligations).find((r) => sameKey(r.batch, key) && !sameKey(r.origin, key) && !isDone(r) &&
        (om ? r.type === "outcome-diary" && String(r.origin?.batch) === om[1] && r.payload?.n === Number(om[2])
          : r.type === "decision-adr" && decisionNo(r.payload?.id) === decisionNo(a.target) && hasDecisionId(String(r.payload?.id), a.target))) : null;
      if (hit) {
        let wr;
        try {
          wr = OB.mutateStore(sd.dir, (d) => { const r = d.get(hit.id); if (!r || r.rev !== hit.rev) throw new OB.ObligationError("CONFLICT", "读后这条义务被改过"); d.put({ ...r, status: "withdrawn", lastResult: { at: new Date().toISOString(), result: "withdrawn", by: "batch-goal --withdraw", why: a.reason } }, { op: "withdraw", by: "batch-goal --withdraw", why: a.reason }); });
        } catch (e) { console.error(`拒绝撤回:义务账写不进去(${e.code || ""} ${e.message})——重跑一次`); process.exit(2); }
        journal("withdraw", { batch: hit.origin?.batch ?? null, intoBatch: cur.batch, kind: hit.type === "decision-adr" ? "decision" : "outcome", ...(hit.type === "decision-adr" ? { id: hit.payload.id } : { o: a.target }), text: hit.payload?.text, reason: a.reason, oblHead: { h: wr.head, version: wr.version } });
        console.log(`已撤回带入本批的${recLabel(hit)}「${String(hit.payload?.text || "").slice(0, 60)}」——理由:${a.reason}(义务账记 withdraw 行)`);
        process.exit(0);
      }
    }
    console.error(`拒绝撤回:${loc.error}`); process.exit(2);
  }
  const item = loc.list[loc.index];
  const rest = loc.list.filter((_, k) => k !== loc.index);
  const w = { kind: loc.kind, ...item, reason: a.reason, withdrawnAt: new Date().toISOString() };
  const key = loc.kind === "decision" ? "decisions" : "outcomes";
  try { atomicWrite({ ...cur, [key]: rest, withdrawn: [...arr(cur.withdrawn), w] }, Number(cur.version) || 0); } catch (e) { console.error(e.message); process.exit(2); }
  const oh = syncStoreQuiet({ ...cur, [key]: rest, withdrawn: [...arr(cur.withdrawn), w] });
  const label = loc.kind === "decision" ? item.id : `O${item.n}`;
  journal("withdraw", { batch: cur.batch, kind: loc.kind, ...(loc.kind === "decision" ? { id: item.id } : { o: label }), text: item.text, reason: a.reason, ...(oh ? { oblHead: oh } : {}) });
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
// 批 301:debtRowCells(批 285 D133)/ debtRowParked(批 286 D193④)挪进 scripts/lib/debt-schema.mjs(欠账表整份校验的同一份切列),
//   这里原名再导出,调用方不变。

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

/** 批 305:债表里参与到期判定的行(`| Dnn |` 起头、未停放)。读不到 ⇒ 抛(调用方各自处理:--arm 只提示,--handoff 写取不到)。 */
//   批 308 S1b D-2:取行改走 debt-schema 的 liveDebtRows(同一份区段口径:「已销账」「已结清」二级标题下的行不取)。
function debtTableRows() {
  return liveDebtRows(fs.readFileSync(cfgDebtTable(), "utf8"));
}

function debtTableWarn() {
  try {
    const issues = debtTableIssues(fs.readFileSync(cfgDebtTable(), "utf8"));
    if (issues.length) console.log(`🔴 欠账表结构坏了(${cfgDebtTable()}):${issues.join(";")}——先看 git log -p -- docs/gate-debts.md 找哪笔提交弄坏的,以那笔之前的版本为底重建`);
  } catch { /* 表读不到由到期腿报 */ }
}

// ── 批 305:开批记指令 / 终点线 / 上限(只记录)──────────────────────────────────────────
//   (这一段放在自测与 CLI 段之前:CLI 段在文件中段执行并 exit,const 定义在它后面会落在暂时性死区——同 FP_AUDIT_LOG 的教训)
/** 本 checkout 的布局:{ root, main, linked }。linked = 这是 `git worktree add` 出来的工作树(git 目录 ≠ 公共目录);
 *  main = 主 checkout(公共目录的上一级,与义务账 / 候选台账同一算法)。取不到 ⇒ { unknown, why }。 */
export function checkoutLayout(git = gitRun) {
  let r;
  try { r = git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]); } catch (e) { return { unknown: true, why: `git 跑不起来(${e.message})` }; }
  const ls = r && r.status === 0 ? String(r.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
  if (ls.length < 3) return { unknown: true, why: String(r?.stderr || "").trim().split("\n")[0] || "不在 git 工作树里" };
  const [gitDir, common, top] = ls;
  return { root: top, main: path.dirname(common), linked: normCheckout(gitDir) !== normCheckout(common) };
}
/** 本仓各 checkout 对应的转录目录(~/.claude/projects 下;定位规则沿用 write-checks.transcriptDirs)。非 git 目录按 cwd 算。 */
function transcriptDirsHere(layout = checkoutLayout()) {
  const main = layout.unknown ? process.cwd() : layout.main;
  return transcriptDirs(main, layout.unknown ? null : gitRun, os.homedir());
}
/** `--arm --instruction`:补上这句指令在转录里的位置(会话号 + 时间戳)。拿不到 ⇒ at 留空、why 写明原因(--status 显示「未定位」)。只读。 */
function locateInstructionForArm(m, io = {}) {
  const sid = m.sid || (io.sid !== undefined ? io.sid : sidEnv());
  const base = { text: String(m.text), sid: sid || null, at: null };
  if (m.at) return { ...base, at: m.at, located: "explicit" };
  if (!sid) return { ...base, located: null, why: "取不到会话号(环境里没有 CLAUDE_CODE_SESSION_ID;可用 --instruction-session / --instruction-at 显式给)" };
  let dirs = null;
  try { dirs = io.dirs !== undefined ? io.dirs : transcriptDirsHere(); } catch { dirs = null; }
  if (!dirs || !dirs.length) return { ...base, located: null, why: "本仓的转录目录不在或读不了" };
  const file = RULER.findTranscript(sid, dirs);
  if (!file) return { ...base, located: null, why: `找不到会话 ${sid} 的转录文件` };
  const hit = RULER.locateInstruction(file, m.text, { untilMs: Date.now() + 5000 });
  if (!hit.at) return { ...base, located: null, why: hit.why };
  return { ...base, at: hit.at, ...(hit.uuid ? { uuid: hit.uuid } : {}), located: "transcript", match: hit.match };
}
/** 批状态里的开批记录 ⇒ 展示行(--arm / --status / --handoff 共用)。一项都没记 ⇒ 空数组。 */
export function armMetaLines(g) {
  const out = [];
  const ins = g && g.instruction;
  if (ins && typeof ins.text === "string") {
    out.push(`指令:「${ins.text.replace(/\s+/g, " ").slice(0, 300)}${ins.text.length > 300 ? "…" : ""}」`);
    out.push(ins.at
      ? `指令位置:会话 ${ins.sid || "(未记会话号)"} · ${ins.at}(${ins.located === "explicit" ? "显式给定" : `按原话在转录里定位,${ins.match === "contains" ? "那条消息包含原话" : "整条相等"}`})`
      : `指令位置:未定位(${ins.why || "原因未记"})${ins.sid ? `;会话 ${ins.sid}` : ""}`);
  }
  if (g && typeof g.finishLine === "string") out.push(`终点线:${g.finishLine}`);
  const c = g && g.caps;
  if (c && (c.usd !== undefined || c.deadline !== undefined)) out.push(`上限(只记录,不阻断):${[c.usd !== undefined ? `花费 ≤ ${c.usd} 美元` : null, c.deadline ? `总截止 ${c.deadline}` : null].filter(Boolean).join(";")}`);
  return out;
}
function pickArmMeta(g) {
  return { ...(g && g.instruction ? { instruction: g.instruction } : {}), ...(g && typeof g.finishLine === "string" ? { finishLine: g.finishLine } : {}), ...(g && g.caps ? { caps: g.caps } : {}) };
}
// ── 批 305:工作树里开的批并进主树看得到的地方 ──────────────────────────────────────────
//   现状(改前实测,自测「305 ③ 现状钉住」):批状态与批台账都按 cwd 相对路径写(`.claude/.batch-goal.json` / `.jsonl`),
//   在 `git worktree add` 出来的工作树里跑,写的是**工作树自己的**那两份(被忽略、随工作树删除而消失);主树那份一行不多,
//   主树的 `--history` 只读 cwd 那份,所以看不到。
//   改法(最小):工作树里每次成功的 --arm / --clear,**另外**往主 checkout 的 `.claude/.batch-goal.worktrees.jsonl` 追加同一行
//   (多带 checkout / worktree / branch 三个键)。主树的 `--history` 把它按时间并进来显示。工作树自己的台账照旧、仍是它的权威。
//   为什么不直接追加进主树的 `.batch-goal.jsonl`:收尾闸认「刚结清」靠**台账末行是本批的 clear 行**(hook-stop-closure readBatchGoal),
//   主树结清以后任何一个工作树追加一行,主树这条证据就没了 ⇒ 改判决;batch-goal 自己的 lastArmRow / batchClearedBefore /
//   lastOblAnchor 也按批号在这份文件里找行,而同一个批号同时在多个工作树里是常态。所以另放一份、行的结构不变。
//   并发:追加走 ledger-chain 的 ledgerAppend(按文件加锁、读尾算 h、追加在同一临界区),多个工作树同时写链不断(自测「305 ③ 并发」)。
//   只是记录:写不进去 ⇒ 出声,本次 --arm / --clear 照常。
const WORKTREE_JOURNAL = ".batch-goal.worktrees.jsonl";
export const worktreeJournalFile = (layout) => path.join(layout.main, ".claude", WORKTREE_JOURNAL);
function mirrorToMain(action, payload) {
  let layout;
  try { layout = checkoutLayout(); } catch { return; }
  if (layout.unknown || !layout.linked) return;   // 主树、非 git 目录:不写
  const file = worktreeJournalFile(layout);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let branch = null;
    try { const r = gitRun(["symbolic-ref", "--short", "-q", "HEAD"]); if (r && r.status === 0) branch = String(r.stdout || "").trim() || null; } catch { branch = null; }
    ledgerAppend(file, { at: new Date().toISOString(), action, ...payload, checkout: layout.root, worktree: path.basename(layout.root), ...(branch ? { branch } : {}) });
  } catch (e) {
    console.error(`⚠ 主树的工作树批日志写不进去(${e.code || String(e.message).slice(0, 120)}):${file}——本次 ${action} 照常,只是主树 --history 看不到这一行`);
  }
}
/** `--history` 用:主树里把各工作树镜像过来的行并进本 checkout 的行,按 `at` 排(同一份内部次序不变;时刻相同按本 checkout 在前)。 */
export function mergeHistoryRows(own, mirrored) {
  const all = [];
  [own, mirrored].forEach((rows, k) => { let prev = 0; (rows || []).forEach((o, i) => { const at = Date.parse(String(o && o.at || "")); prev = Number.isFinite(at) ? Math.max(prev, at) : prev; all.push({ o, at: prev, k, i }); }); });
  all.sort((a, b) => a.at - b.at || a.k - b.k || a.i - b.i);
  return all.map((x) => x.o);
}

/** 批 305:主尺——从指令那一刻到现在,转录里人亲口说了几条(数法与天花板见 lib/batch-ruler.mjs 头注)。只读;任何一步拿不到 ⇒ { ok:false, why },不猜。
 *  读哪几份转录:指令所在会话、武装过本批的会话(批状态的 armedBy 与本批各 arm 行的 armedBy)、现在跑这条命令的会话。 */
function computeRuler(g) {
  try {
    const ins = g && g.instruction;
    if (!ins || !ins.at) return RULER.measureRuler({ instruction: ins || null });
    return RULER.measureRuler({ instruction: ins, sids: batchSessionIds(g), dirs: transcriptDirsHere(), nowMs: Date.now() });
  } catch (e) { return { ok: false, why: `算的时候出错:${String(e && e.message || e).slice(0, 160)}` }; }
}
/** 这一批干过活的会话号:开批的会话(批状态 armedBy)、现在跑这条命令的会话、本批各 arm 行(同批号同 armedAt)的 armedBy。
 *  主尺(批 305)与关账侧的 P 取证(批 309)共用。去重、去掉不像会话号的。 */
function batchSessionIds(g) {
  const sids = [g && g.armedBy, sidEnv()];
  try {
    for (const l of fs.readFileSync(JOURNAL, "utf8").split("\n")) {
      if (!l.includes('"arm"')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o && o.action === "arm" && String(o.batch) === String(g.batch) && (o.armedAt || null) === (g.armedAt || null) && typeof o.armedBy === "string") sids.push(o.armedBy);
    }
  } catch { /* 台账读不到 ⇒ 只按批状态里的会话号 */ }
  return [...new Set(sids.filter((s) => typeof s === "string" && /^[\w-]{8,80}$/.test(s)))];
}

/// ── 批 309:规则 P 的拒绝挪进关账(--clear 拒、--dry-check 报;判定在 hook-stop-closure reviewVerdict,判据唯一实现 = RULE_P)──
//   收尾钩子里的 P 只提示、永不阻断;这里问同一份判据,只改「什么时候拦」:本批(开批基点..HEAD)P 的 detect 有硬欠项 ⇒ 拒清
//   `review-missing`(不分是改闸引擎文件的提交还是规矩文件类的承重提交,消息里分开写);有这两类提交但一份转录都读不到
//   (或 git 事实取不到)⇒ `review-unknown`;只欠软项 ⇒ 不拒,提示登记。
//   零成本路径:范围里没有一个提交碰过 scripts/(闸引擎文件全在它下面,是 P 的 ENGINE_PATHSPECS 的超集,自测钉着)或承重面
//   (CARRIER_SURFACE,与 P 同一份判据)⇒ 只跑这一次 git,不载入收尾闸、不读转录。碰过才载入收尾闸;那边再先不读转录预判一次
//   (规矩文件类提交在宽限内就到此为止),预判有命中才读转录。
//   出路(复用现成的误报记账,不新造台账):`hook-stop-closure.mjs --fp P "<为什么拦错了>"`——本批武装之后记的、没撤回的一笔 P 误报
//   ⇒ 这道拒绝放行,结清行记下那一笔的 h(留痕;误报记账照旧在批次结清时交盲审)。
export const ENGINE_SUPERSET_PREFIX = "scripts/";
const FP_LEDGER = path.join(".claude", ".gate-fp-ledger.jsonl");
/** 本批武装之后记的、没被撤回的最后一笔 P 误报(纯函数,自测直接喂行)。没有 ⇒ null。 */
export function reviewWaiver(g, rows) {
  const since = Date.parse(String((g && g.armedAt) || ""));
  if (!Number.isFinite(since)) return null;
  const list = (rows || []).filter((r) => r && typeof r === "object");
  const retracted = new Set(list.filter((r) => r.kind === "retraction" && r.id === "P" && typeof r.ref === "string").map((r) => r.ref));
  const hit = list.filter((r) => r.kind === "claimed_fp" && r.id === "P" && typeof r.h === "string" && !retracted.has(r.h) && Date.parse(String(r.ts || "")) >= since);
  return hit.length ? hit[hit.length - 1] : null;
}
/** 这个仓相对路径会不会让 P 触发:闸引擎面的超集(scripts/ 下)或承重面(与 P 的 isCarrierPath(CARRIER_SURFACE) 同一份)。 */
export const reviewRelevantPath = (p) => { const s = String(p || "").replace(/\\/g, "/"); return s.startsWith(ENGINE_SUPERSET_PREFIX) || isCarrierPath(CARRIER_SURFACE, s); };
/** 零成本路径的那一次 git:开批基点..HEAD 里各提交改过的文件名(`--no-renames`:改名的新旧两头都列;合并进来的旁支提交也在范围里)。
 *  false = 一个都不会让 P 触发(直接过);true = 有;null = git 没跑成(交给精确判定,那边取不到事实就判不了)。 */
export function reviewRangeTouched(base, git = gitRun) {
  let r; try { r = git(["log", "--no-renames", "--name-only", "--format=", `${base}..HEAD`]); } catch { return null; }
  if (!r || r.status !== 0) return null;
  return String(r.stdout || "").split(/\r?\n/).some((l) => l.trim() && reviewRelevantPath(l.trim()));
}
function readFpRows() {
  try { return fs.readFileSync(FP_LEDGER, "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
/** 关账侧的 P 判定。返回 reviewVerdict 的结论,另加 status `none`(零成本路径)/ `skip`(没有开批基点 / 本仓没有收尾闸脚本,不查)。
 *  `io` 可注入(自测):git、loadHook(载入收尾闸)、dirs(转录目录)。 */
export async function loadBearingReview(g, io = {}) {
  const base = g && g.baseCommit;
  if (typeof base !== "string" || !/^[0-9a-f]{7,64}$/i.test(base)) return { status: "skip", why: "批状态里没有开批基点(baseCommit),判不了本批有没有承重面 / 改闸提交" };
  if (reviewRangeTouched(base, io.git || gitRun) === false) return { status: "none" };
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook-stop-closure.mjs");
  if (!io.loadHook && !fs.existsSync(script)) return { status: "skip", why: "本仓没有收尾闸脚本(hook-stop-closure.mjs),不查" };
  let m;
  try { m = io.loadHook ? await io.loadHook() : await import(new URL("./hook-stop-closure.mjs", import.meta.url).href); }
  catch (e) { return { status: "unknown", step: "载入收尾闸", why: String(e && e.message || e).slice(0, 160) }; }
  try {
    let dirs = io.dirs;
    if (dirs === undefined) { try { dirs = transcriptDirsHere(); } catch { dirs = []; } }
    return m.reviewVerdict({ base, sids: batchSessionIds(g), ledgerSid: sidEnv() || g.armedBy, batchGoal: g,
      findTranscript: (sid) => RULER.findTranscript(sid, dirs || []), ...(io.verdict || {}) });
  } catch (e) { return { status: "unknown", step: "判定", why: `判定自己出错:${String(e && e.message || e).slice(0, 160)}` }; }
}
/** 每一欠格怎么补(拒绝那段话里列)。 */
function reviewFix(h, g) {
  const ch = String((h && h.ch) || "");
  if (/独立视角/.test(ch) && (Array.isArray(h.missing) || /闸引擎面/.test(ch))) {
    const miss = Array.isArray(h.missing) && h.missing.length ? h.missing : ["_gate-bypass-hunter", "_gate-false-block-hunter"];
    return `起 ${miss.map((x) => `\`${x}\``).join(" 与 ")}(只读子代理),prompt 里带本批闸文件名 / 规则 id / diff 文件;误拦猎手派单里只写一个 \`--base ${String(g.baseCommit || "<开批基点>").slice(0, 12)}\`(开批基点,早于本批第一笔改闸提交)`;
  }
  if (/独立视角/.test(ch)) return "起一个只读子代理复核(grill: 系列或 `_` 开头的只读 agent),prompt 里带本批改的规矩文件名";
  if (/跨模型/.test(ch)) return "跑一次跨模型复核:`node ~/.claude/scripts/codex-run.mjs --task <任务文件>`,等作业结束(作业记录 state=done、有 resultAt)";
  if (/外部先例/.test(ch)) return "用 WebSearch / WebFetch 查一次同类做法(只认工具调用,不认正文里写的字)";
  return "照收尾钩子 P 的提示补";
}
const commitList = (cs) => `${cs.slice(0, 8).map((c) => `${c.aggregated ? "(聚合)" : ""}${String(c.sha || "?").slice(0, 7)}${c.files && c.files.length ? `[${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? " …" : ""}]` : ""}`).join(";")}${cs.length > 8 ? " …" : ""}`;
/** 拒绝 / 报告那段话(--clear 与 --dry-check 共用)。 */
function printReview(er, g, head) {
  console.error(head);
  const ec = Array.isArray(er.engineCommits) ? er.engineCommits : [], cc = Array.isArray(er.carrierCommits) ? er.carrierCommits : [];
  if (ec.length) console.error(`  改了闸引擎文件的提交(${ec.length} 个):${commitList(ec)}`);
  if (cc.length) console.error(`  改了规矩文件类承重面的提交(${cc.length} 个):${commitList(cc)}`);
  if (er.status === "unknown") {
    console.error(`  判不了:${er.step || "?"} 这一步——${er.why || "原因未记"}。判不了按欠着算(这是这类提交唯一剩下的一道关)。`);
  } else {
    for (const h of er.hard || []) console.error(`  · 欠 ${String(h.ch).replace(/(.)——.*$/, "$1")}${Array.isArray(h.missing) && h.missing.length ? `(缺 ${h.missing.join("、")})` : ""}${Number.isFinite(h.commits) ? `(本会话 P 账 ${h.commits} 次承重提交,每 ${h.every} 次要跑一遍)` : ""}——怎么补:${reviewFix(h, g)}`);
    if ((er.soft || []).length) console.error(`  (另:${er.soft.map((h) => String(h.ch).replace(/(.)——.*$/, "$1")).join(" / ")} 通道不可用,只算软项,收尾报告须登记欠账)`);
  }
  if (Array.isArray(er.unread) && er.unread.length) console.error(`  这几个本批会话的转录没读到(那里跑过的复核不算):${er.unread.join("、")}`);
  console.error("  补完重跑 --clear(或先 --dry-check 看)。");
  console.error("  认为这次拦错了(复核确实跑过,只是不在读到的转录里;或判据本身错了):`node --no-warnings scripts/hook-stop-closure.mjs --fp P \"<为什么拦错了>\"`,再重跑 --clear——" +
    "本批武装之后记的那笔 P 误报会让这一项放行,结清行记下它;误报记账照旧在批次结清时交盲审。");
}
/** 拒绝 / 报告那段话的首句:说清是改了闸引擎文件还是规矩文件类承重面。 */
const reviewWhat = (er) => (er.engine || (Array.isArray(er.engineCommits) && er.engineCommits.length && !(er.carrierCommits || []).length)
  ? "改闸引擎文件的提交" : (Array.isArray(er.engineCommits) && er.engineCommits.length ? "改闸引擎文件与规矩文件类承重面的提交" : "规矩文件类承重提交"));
// ── 批 305:`--handoff`——交接文件从事实生成 ─────────────────────────────────────────────
//   每一段只写查得到的事实(git、批状态、作业目录、转录、债表);任何一段拿不到 ⇒「取不到(原因)」,不留空、不编。
//   不写任何叙述(「下一步做什么」之类),那是读它的会话自己的事。只读:除 `--out` 指定的那一个文件外不写任何东西。
const NA = (why) => `取不到(${String(why || "原因未知").replace(/\s+/g, " ").trim().slice(0, 200)})`;
const gitAt = (cwd, args) => spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
const gitErr = (r) => (r && (r.error?.message || String(r.stderr || "").trim().split("\n")[0])) || "git 不可用";
/** 工作区干不干净:{ tracked, untracked } 或 { why }。 */
function dirtyOf(cwd) {
  const r = gitAt(cwd, ["status", "--porcelain"]);
  if (!r || r.status !== 0) return { why: gitErr(r) };
  const ls = String(r.stdout || "").split(/\r?\n/).filter((l) => l.trim());
  return { tracked: ls.filter((l) => !l.startsWith("??")).length, untracked: ls.filter((l) => l.startsWith("??")).length };
}
const fmtDirty = (d) => d.why ? NA(d.why) : d.tracked || d.untracked ? `不干净(已跟踪文件改动 ${d.tracked} 个,未跟踪 ${d.untracked} 个)` : "干净";
/** 未推送的提交数。远端名一律从 git 配置读:先看上游(@{u}),再看 branch.<分支>.pushRemote / remote.pushDefault / branch.<分支>.remote,
 *  都没配而只有一个远端 ⇒ 用它。数的是本地的远端跟踪引用(没联网,没 fetch 过的不算数)。 */
export function unpushedOf(cwd, branch, git = (a) => gitAt(cwd, a)) {
  if (!branch) return NA("分离 HEAD,没有分支");
  const u = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (u && u.status === 0 && String(u.stdout || "").trim()) {
    const up = String(u.stdout).trim();
    const c = git(["rev-list", "--count", "@{u}..HEAD"]);
    return c && c.status === 0 ? `${String(c.stdout).trim()}(相对上游 ${up};按本地的远端跟踪引用算,没联网)` : NA(`git rev-list 失败:${gitErr(c)}`);
  }
  const cfg = (k) => { const r = git(["config", "--get", k]); return r && r.status === 0 ? String(r.stdout || "").trim() || null : null; };
  let remote = cfg(`branch.${branch}.pushRemote`) || cfg("remote.pushDefault") || cfg(`branch.${branch}.remote`), how = "配置";
  if (!remote) {
    const rl = git(["remote"]);
    const names = rl && rl.status === 0 ? String(rl.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : null;
    if (!names) return NA(`git remote 失败:${gitErr(rl)}`);
    if (!names.length) return NA("本仓没配远端");
    if (names.length > 1) return NA(`本分支没配上游 / 推送远端,而本仓有 ${names.length} 个远端(${names.join("、")}),不猜推到哪个`);
    remote = names[0]; how = "本仓唯一的远端";
  }
  const ref = `refs/remotes/${remote}/${branch}`;
  const has = git(["rev-parse", "--verify", "-q", ref]);
  if (!(has && has.status === 0)) return NA(`远端 ${remote}(${how})上没有 ${branch} 的跟踪引用——可能从没推过`);
  const c = git(["rev-list", "--count", `${ref}..HEAD`]);
  return c && c.status === 0 ? `${String(c.stdout).trim()}(相对 ${remote}/${branch},远端名取自${how};按本地的远端跟踪引用算,没联网)` : NA(`git rev-list 失败:${gitErr(c)}`);
}
/** 一个 checkout 里的批状态一行(工作树列表用)。 */
function batchLineAt(root) {
  let g;
  try { g = load(path.join(root, ".claude", ".batch-goal.json")); } catch (e) { return NA(e.message); }
  if (!g) return "未武装(没有批状态文件)";
  if (g.cleared) return `批 ${g.batch ?? "?"} 已结清`;
  return Array.isArray(g.conditions) && g.conditions.length ? `批 ${g.batch} 未结清(${g.conditions.length} 条完成条件)` : NA("批状态文件形状不对(没有完成条件)");
}
/** 外部作业(codex-run)。复用收尾闸委派闭环那条内建检查的判法(hook-stop-closure 导出的 codexLedger + liveCodexEnv,只读调用):
 *  本会话转录里发起过的作业按它的六态判;作业目录里另有本仓 checkout 发起的 running 作业也列出。
 *  收尾闸加载不了 / 本会话转录取不到 ⇒ 只列作业目录里的作业与结果路径,写明「是否读过:未判」。 */
async function externalJobs(ctx) {
  const out = [];
  let H = null, loadWhy = null;
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook-stop-closure.mjs");
    if (!fs.existsSync(f)) loadWhy = "本仓没有 scripts/hook-stop-closure.mjs";
    else { H = await import(new URL("./hook-stop-closure.mjs", import.meta.url).href); if (typeof H.codexLedger !== "function" || typeof H.liveCodexEnv !== "function") { loadWhy = "hook-stop-closure.mjs 没导出 codexLedger / liveCodexEnv"; H = null; } }
  } catch (e) { loadWhy = `加载 hook-stop-closure.mjs 失败:${String(e && e.message || e).slice(0, 120)}`; H = null; }
  const env = H ? H.liveCodexEnv() : null;
  // 作业目录里的记录(与收尾闸同一读法 listJobs;收尾闸加载不了 ⇒ 按 codex-run 的作业目录自己读)
  let listed = null, listWhy = null;
  const since = Number.isFinite(Date.parse(String(ctx.since || ""))) ? Date.parse(ctx.since) : Date.now() - 24 * 3600_000;
  try {
    if (env && typeof env.listJobs === "function") listed = env.listJobs({ since });
    else {
      const root = path.join(os.tmpdir(), "codex-run-jobs");
      let names = [];
      try { names = fs.readdirSync(root).filter((n) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(n)); } catch (e) { if (e.code !== "ENOENT") throw e; }
      listed = [];
      for (const n of names.slice(-3000)) { try { const j = JSON.parse(fs.readFileSync(path.join(root, n), "utf8")); const t = Date.parse(j.startedAt || ""); if (Number.isFinite(t) && t >= since) listed.push({ ...j, id: n.slice(0, -5), top: null }); } catch { /* 半写 / 坏件跳过 */ } }
    }
  } catch (e) { listWhy = String(e && e.message || e).slice(0, 160); }
  const mineTop = (j) => { const c = normCheckout(j.top || j.cwd || ""); return !!c && ctx.checkouts.some((k) => c === k || c.startsWith(k + "/")); };
  const here = (listed || []).filter(mineTop);
  // 本会话的委派账
  let ledger = null, ledgerWhy = null;
  if (!H) ledgerWhy = loadWhy;
  else if (!ctx.sid) ledgerWhy = "取不到本会话的会话号(环境里没有 CLAUDE_CODE_SESSION_ID)";
  else {
    const file = ctx.dirs ? RULER.findTranscript(ctx.sid, ctx.dirs) : null;
    if (!file) ledgerWhy = `找不到本会话 ${ctx.sid} 的转录文件`;
    else {
      const entries = [];
      const r = RULER.eachEntry(file, (e) => { if (e && (e.type === "user" || e.type === "assistant")) entries.push(e); }, { match: /"type"\s*:\s*"(?:user|assistant)"/ });
      if (r.err) ledgerWhy = r.err;
      else { try { ledger = H.codexLedger(entries, { ...env, turnStart: 0 }); } catch (e) { ledgerWhy = `委派账算的时候出错:${String(e && e.message || e).slice(0, 120)}`; } }
    }
  }
  const ZH = { running: "运行中", "pending-read": "已产出待读", read: "已读回", "failed-handled": "失败已处理", "failed-open": "失败未处理", unknown: "状态未知" };
  if (ledger) {
    const open = ledger.jobs.filter((j) => j.status !== "read" && j.status !== "failed-handled");
    out.push(`- 本会话发起的 codex 作业:${ledger.jobs.length} 个(判法 = 收尾闸委派闭环那条内建检查,hook-stop-closure 的 codexLedger)`);
    for (const j of open) out.push(`  - ${j.label}:${ZH[j.status] || j.status}${j.R ? `;结果件 ${j.R}` : ""}${j.L ? `;日志 ${j.L}` : ""}${j.why ? `;${String(j.why).slice(0, 100)}` : ""}`);
    const done = ledger.jobs.length - open.length;
    if (done) out.push(`  - 另 ${done} 个已读回 / 失败已处理,不列`);
    if (!ledger.jobs.length) out.push("  - (零个)");
  } else out.push(`- 本会话发起的 codex 作业:${NA(ledgerWhy)}`);
  if (listWhy) out.push(`- 作业目录里本仓发起的作业:${NA(`读作业目录失败:${listWhy}`)}`);
  else {
    const known = new Set((ledger ? ledger.jobs : []).map((j) => j.label));
    const others = here.filter((j) => !known.has(j.id));
    const running = others.filter((j) => j.state === "running");
    const doneNot = ledger ? [] : others.filter((j) => j.state === "done" || j.state === "failed");
    out.push(`- 作业目录里本仓发起、${ledger ? "不在本会话委派账里" : "自 " + new Date(since).toISOString() + " 起"}的作业:running ${running.length} 个${ledger ? "" : `,已完成 / 失败 ${doneNot.length} 个`}(作业目录记录自 ${new Date(since).toISOString()} 起)`);
    for (const j of [...running, ...doneNot]) out.push(`  - ${j.id}:state=${j.state};结果件 ${j.result || "(未记)"}${j.log ? `;日志 ${j.log}` : ""};任务 ${j.task || "(未记)"}${ledger ? ";别的会话发起的,是否读过:未判(委派账只认发起方会话)" : ";是否读过:未判"}`);
  }
  return out;
}
/** 组一份交接正文。io 可注入 now / sid(自测用)。 */
export async function buildHandoff(io = {}) {
  const now = io.now || new Date();
  const sid = io.sid !== undefined ? io.sid : sidEnv();
  const L = [];
  L.push(`# 交接(生成于 ${now.toISOString()})——本文件由工具从事实生成,不含叙述`);
  L.push("");
  L.push(`生成命令:node --no-warnings scripts/batch-goal.mjs --handoff;会话号:${sid || NA("环境里没有 CLAUDE_CODE_SESSION_ID")};工作目录:${normCheckout(process.cwd())}`);
  // ── 1 当前 checkout ──
  const layout = checkoutLayout();
  L.push("", "## 当前分支与工作区");
  let branch = null;
  if (layout.unknown) L.push(`- ${NA(layout.why)}`);
  else {
    const b = gitRun(["symbolic-ref", "--short", "-q", "HEAD"]); branch = b && b.status === 0 ? String(b.stdout || "").trim() || null : null;
    const h = gitRun(["log", "-1", "--format=%H%x09%s"]);
    const [sha, subj] = h && h.status === 0 ? String(h.stdout || "").trim().split("\t") : [null, null];
    L.push(`- checkout:${normCheckout(layout.root)}${layout.linked ? "(git worktree)" : "(主 checkout)"}`);
    L.push(`- 分支:${branch || "(分离 HEAD)"}`);
    L.push(`- HEAD:${sha ? `${sha.slice(0, 12)} ${String(subj || "").slice(0, 120)}` : NA(gitErr(h))}`);
    L.push(`- 工作区:${fmtDirty(dirtyOf(process.cwd()))}`);
    L.push(`- 未推送的提交:${unpushedOf(process.cwd(), branch)}`);
  }
  // ── 2 全部 worktree ──
  L.push("", "## 全部 git worktree");
  const checkouts = [];
  if (layout.unknown) L.push(`- ${NA(layout.why)}`);
  else {
    const r = gitRun(["worktree", "list", "--porcelain"]);
    if (!r || r.status !== 0) L.push(`- ${NA(gitErr(r))}`);
    else {
      const blocks = String(r.stdout || "").split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/).filter(Boolean)).filter((b) => b.length);
      for (const b of blocks) {
        const kv = (k) => { const l = b.find((x) => x === k || x.startsWith(k + " ")); return l === undefined ? undefined : l.slice(k.length + 1); };
        const p = kv("worktree"); if (!p) continue;
        const np = normCheckout(p); checkouts.push(np);
        const br = kv("branch"), head = kv("HEAD");
        const exists = fs.existsSync(p);
        const cur = np === normCheckout(layout.root) ? "(当前)" : "";
        L.push(`- ${np}${cur}:分支 ${br ? br.replace(/^refs\/heads\//, "") : kv("detached") !== undefined ? "(分离 HEAD)" : kv("bare") !== undefined ? "(裸仓)" : "(未知)"};HEAD ${head ? head.slice(0, 12) : "(无)"};` +
          `${exists ? `工作区 ${fmtDirty(dirtyOf(p))};批状态 ${batchLineAt(p)}` : NA("目录不在了(git worktree prune 可清)")}${kv("locked") !== undefined ? ";已锁定" : ""}`);
      }
      if (!checkouts.length) L.push(`- ${NA("git worktree list 没列出任何工作树")}`);
    }
  }
  // ── 3 批状态 ──
  L.push("", "## 批状态(本 checkout)");
  let g = null, gWhy = null;
  try { g = load(); } catch (e) { gWhy = e.message; }
  if (gWhy) L.push(`- ${NA(gWhy)}`);
  else if (!g) L.push("- 未武装(没有批状态文件)");
  else if (g.cleared) {
    L.push(`- 批 ${g.batch ?? "?"} 已结清,未武装新批`);
    let row = null;
    try { for (const l of fs.readFileSync(JOURNAL, "utf8").split("\n")) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; } if (o && o.action === "clear" && String(o.batch) === String(g.batch)) row = o; } } catch { row = null; }
    if (row) { for (const l of armMetaLines(row)) L.push(`- ${l}`); L.push(`- ${RULER.formatRuler(row.ruler || { ok: false, why: "这一批关账时还没有主尺" })}`); }
    else L.push(`- 关账记录:${NA("批台账里没有这批的 clear 行")}`);
  } else if (!Array.isArray(g.conditions) || !g.conditions.length) L.push(`- ${NA("批状态文件形状不对(没有完成条件)")}`);
  else {
    L.push(`- 批号:${g.batch};武装于 ${g.armedAt || "(未记)"};基点 ${g.baseCommit ? String(g.baseCommit).slice(0, 12) : "(无)"};武装者会话 ${g.armedBy || "(未记)"}`);
    for (const l of armMetaLines(g)) L.push(`- ${l}`);
    if (!armMetaLines(g).length) L.push("- 指令 / 终点线 / 上限:开批时没记");
    L.push(`- 完成条件 ${g.conditions.length} 条:`);
    g.conditions.forEach((c, i) => {
      L.push(`  ${i + 1}. ${typeof c === "string" ? c : c?.text || ""}`);
      for (const k of arr(g.checks).filter((x) => x && x.i === i)) L.push(`     判据:$ ${k.cmd}${k.expect !== undefined ? `  期待含「${k.expect}」` : ""}${k.expectRe !== undefined ? `  期待匹配 /${k.expectRe}/` : ""}`);
    });
    L.push(`- 已登记的决定:${arr(g.decisions).length ? arr(g.decisions).map((d) => `${d.id}「${d.text}」`).join(";") : g.noDecision ? `无(声明没有决定:${g.noDecision.text})` : "无"}`);
    L.push(`- 已登记的成果:${numberOutcomes(g.outcomes).length ? numberOutcomes(g.outcomes).map((o) => `O${o.n}「${o.text}」`).join(";") : "无"}`);
    if (arr(g.withdrawn).length) L.push(`- 已撤回:${arr(g.withdrawn).map((w) => `${w?.kind === "decision" ? w.id : `O${w?.n}`}(${w?.reason})`).join(";")}`);
    if (g.clearRefusedAt) L.push(`- 上次 --clear 被拒:${g.clearRefusedAt},原因 ${g.clearRefusedReason || "(未记)"}`);
    try {
      const o = oblRead(g), s = OB.summarize(o.view.mine);
      L.push(`- 义务账:${OB.TRUSTED.has(o.kind) ? `本批名下挡关账 ${s.blocking} 条(开着 ${s.open} / 判不了 ${s.unknown} / 转欠账待提交 ${s.settling}),已转欠账 ${s.settled} 条` : NA(`义务账判不了:${o.kind} ${o.why || ""}`)}`);
    } catch (e) { L.push(`- 义务账:${NA(e.message)}`); }
    L.push(`- ${RULER.formatRuler(computeRuler(g))}`);
  }
  // ── 4 外部作业 ──
  L.push("", "## 在跑或未读的外部作业(codex-run)");
  try {
    let dirs = null; try { dirs = transcriptDirsHere(layout); } catch { dirs = null; }
    for (const l of await externalJobs({ sid, dirs, since: g && !g.cleared ? g.armedAt : null, checkouts: checkouts.length ? checkouts : [normCheckout(layout.unknown ? process.cwd() : layout.root)] })) L.push(l);
  } catch (e) { L.push(`- ${NA(e.message)}`); }
  // ── 5 到期未结的欠账 ──
  L.push("", "## 到期未结的欠账");
  {
    const num = g && g.batch !== undefined && g.batch !== null ? parseInt(g.batch, 10) : NaN;
    let rows = null, why = null;
    try { rows = debtTableRows(); } catch (e) { why = `债表 ${cfgDebtTable()} 读不了(${e.code || e.message})`; }
    if (why) L.push(`- ${NA(why)}`);
    else if (!Number.isFinite(num)) L.push(`- ${NA(g ? `批号「${g.batch}」没有数字部分,算不出到期` : "没有批号,算不出到期")}`);
    else {
      const { mine, yours, colBad } = debtDue(rows, num);
      L.push(`- 按批号 ${num} 算(与 --arm 开批时那段同一判法):${mine.length + yours.length} 条——【我做】${mine.length ? mine.join(" ") : "无"};【需你裁】${yours.length ? yours.join(" ") : "无"}`);
      if (colBad.length) L.push(`- 另有 ${colBad.length} 行列数异常、看不见到期:${colBad.join(" ")}`);
    }
  }
  return L.join("\n") + "\n";
}

/** 主尺结果 ⇒ 写进批日志 clear 行的那一份(不带展示用的长串)。 */
function rulerRecord(r) {
  if (!r || !r.ok) return { ok: false, why: String((r && r.why) || "没有结果"), ...(r && r.sessions ? { sessions: r.sessions } : {}) };
  return { ok: true, count: r.count, byKind: r.byKind, excluded: r.excluded, since: r.since, until: r.until, sessions: r.sessions,
    ...(Object.keys(r.unknownOrigins || {}).length ? { unknownOrigins: r.unknownOrigins } : {}), ...(r.noTimestamp ? { noTimestamp: r.noTimestamp } : {}) };
}

// 自测用的安装方配置:HostApp 的取值,写成字面量(不读 cwd 那份,自测在哪跑都一样)。沙盒仓里写同一份进 gate-install.json。
//   批 305:两份名单键(deployScripts / privateRepos)用**中性占位名**——真名是安装方的私有事实,不进闸仓;
//   所以「仓里那份与字面量逐项相等」那条只比路径四项,名单两项只核形状(解析得出、没有告警),不比名字。
const TEST_INSTALL_JSON = JSON.stringify({ format: "gate-install/v1", diary: "docs/product-diary.md", adrDir: "docs/adr", debtTable: "docs/gate-debts.md",
  loadBearingExtra: ["^docs/gate/AGENTS\\.md$", "^docs/laws/", "^docs/archive/laws-[^/]+/(?:collab|reporting|constitution-[\\w-]+)\\.md$", "^scripts/verify-prod\\.mjs$", "^docs/(?:constraint|tool)-register\\.md$"],
  deployScripts: ["deploy-prod.ps1"], privateRepos: ["app-private"] }, null, 2) + "\n";

function selfTest() {
  const cases = [];
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    cases.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      实得 ${JSON.stringify(got)}\n      期待 ${JSON.stringify(want)}`}`);
  };
  CONFIG_OVERRIDE = parseInstallConfig(TEST_INSTALL_JSON, "selftest");
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
    // 批 286(D193④):描述列提到「已撤销」不让整行免到期;失效期 / 出路列写了才算停放
    t("286 D193④:描述里提到已撤销 ⇒ 照追到期", debtRowParked("| D901 | 原判据已撤销,但新问题仍在 | 285 | **≤280** | 来源 | 出路 |"), false);
    t("286 D193④:失效期列写已撤销 ⇒ 停放", debtRowParked("| D902 | 某事 | 285 | **已撤销** | 来源 | 出路 |"), true);
    t("286 D193④:出路列写待用户裁 ⇒ 停放", debtRowParked("| D903 | 某事 | 285 | **≤280** | 来源 | 待用户裁:二选一 |"), true);
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
    // 批 308 D1(实撞):随仓发的示例欠账表里有一行「D1 示例行 … ≤5」,任何批号大于 5 的开批都把它当到期未结的债列出来。
    //   钉住:随仓那份表在任何批号下都没有到期项(取行口径同 debtTableRows)。仓里没有这份文件(安装方换了位置)⇒ 不比。
    t("308 D1:随仓的示例欠账表在任何批号下都没有到期项", (() => {
      const f = fileURLToPath(new URL("../docs/gate-debts.md", import.meta.url));
      if (!fs.existsSync(f)) return [[], []];
      const d = debtDue(liveDebtRows(fs.readFileSync(f, "utf8")), 9999);
      return [d.mine, d.yours];
    })(), [[], []]);
    // 批 308 S1b D-2:同一份随仓表,「已结清」表里 4 列的行不再被点名「列数异常、看不见到期」
    t("308 S1b D-2:随仓的示例欠账表没有列数异常的行(已结清区段不取)", (() => {
      const f = fileURLToPath(new URL("../docs/gate-debts.md", import.meta.url));
      if (!fs.existsSync(f)) return [];
      return debtDue(liveDebtRows(fs.readFileSync(f, "utf8")), 9999).colBad;
    })(), []);
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
  // 批 298 r2(猎手 FB-4):配置写了日记路径、文件不在 ⇒ 按「缺」报(不判不了、也不只提示);没配日记的仓才跳过
  t("298 r2(原 BP-4 改):配置了日记而 ENOENT ⇒ 缺(diaryMissing),不是判不了", (() => { const o = obligationCheck({ batch: "256", outcomes: [{ text: "x" }] }, { readDiary: () => { const e = new Error("no"); e.code = "ENOENT"; throw e; } }); return [!!o.unknown, o.diaryMissing]; })(), [false, true]);
  const diffGit = (added) => (a) => a[0] === "diff" ? { status: 0, stdout: `--- a/docs/product-diary.md\n+++ b/docs/product-diary.md\n@@ -9 +9,1 @@\n${added.map((l) => "+" + l).join("\n")}\n` } : { status: 1, stdout: "" };
  t("BP-2:有基点时日记行须在新增行里(旧行不抵)", obligationCheck({ batch: "256", baseCommit: "abc1234", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 256:旧 | y | e |", git: diffGit(["| d | 批 255:别的 | y | e |"]) }).diaryMissing, true);
  t("BP-2:有基点、新增行有本批 ⇒ 过", obligationCheck({ batch: "256", baseCommit: "abc1234", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 256:新 | y | e |", git: diffGit(["| d | 批 256:新 | y | e |"]) }).diaryMissing, false);
  t("BP-2:有基点但 diff 取不到 ⇒ 退回全文并出声", (() => { const o = obligationCheck({ batch: "256", baseCommit: "dead", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 256:x | y | e |", git: () => ({ status: 128, stdout: "" }) }); return [o.diaryMissing, o.notes.length]; })(), [false, 1]);
  t("BP-9:--withdraw 必须带非空 --reason", (() => { try { parseWithdraw(["--withdraw", "256-D1"]); return "no-throw"; } catch { return "throw"; } })(), "throw");
  t("BP-9:定位决定(前导零也认)与成果序号", [locateWithdraw({ decisions: [{ id: "256-D1" }, { id: "256-D2" }] }, "256-D02").index, locateWithdraw({ outcomes: [{ n: 3, text: "a" }] }, "O3").index, !!locateWithdraw({ decisions: [{ id: "256-D1" }] }, "257-D1").error], [1, 0, true]);
  t("ADR:没登记决定 ⇒ 不查(不调 git)", adrCoverage([], "abc", () => { throw new Error("不该调"); }).missing, []);
  t("298 r2(原「日记不存在只提示」改):配置了日记而不存在 ⇒ 缺、不是判不了", (() => { const o = obligationCheck({ batch: "256", outcomes: [{ text: "x" }] }, { readDiary: () => null }); return [o.diaryMissing, !!o.unknownParts.diary]; })(), [true, false]);
  t("义务:没登记成果 ⇒ 不读日记", obligationCheck({ batch: "256" }, { readDiary: () => { throw new Error("不该读"); } }).diaryMissing, false);
  t("义务:登记了成果、日记无本批 ⇒ 缺", obligationCheck({ batch: "256", outcomes: [{ text: "x" }] }, { readDiary: () => "| d | 批 2560:x | y | e |" }).diaryMissing, true);
  t("义务:git 判不了 ⇒ unknown", !!obligationCheck({ batch: "256", decisions: dec }, { git: () => ({ status: 128, stdout: "" }) }).unknown, true);
  // 批 276(D177②):承重面零决定
  {
    const names = (list) => (a) => (a[0] === "diff" && a.includes("--name-only") ? { status: 0, stdout: list.join("\0") + "\0" } : { status: 1, stdout: "" });
    const g0 = { batch: "276", baseCommit: "abc1234" };
    t("D177:触及承重面且零决定 ⇒ 列出", obligationCheck(g0, { git: names(["scripts/hook-remote-check.mjs", "docs/x.md"]) }).noDecisionTouched, ["scripts/hook-remote-check.mjs"]);
    t("D177:触及法典 / AGENTS.md / 闸引擎 / 推送钩子都算", obligationCheck(g0, { git: names(["docs/laws/collab.md", "AGENTS.md", "scripts/lib/gate-rules.mjs", "scripts/git-hooks/pre-push.mjs", "scripts/install-git-hooks.mjs"]) }).noDecisionTouched.length, 5);
    // 批 292:候选台账汇总(结清时的唯一必经读点)
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cand-"));
      const f = path.join(dir, "c.jsonl");
      t("292 候选汇总:台账不存在 ⇒ 零(台账未建)", /零\(台账未建\)/.test(candidateSummary("2026-11-06T00:00:00Z", f)), true);
      // (批 292 codex r1:文案「本批」改「武装以来,各会话合计」——只按时间归集,不按会话 / 批次)
      fs.writeFileSync(f, [
        { ts: "2026-11-05T23:00:00Z", hits: [{ id: "E2" }] },                       // 武装之前,不计
        { ts: "2026-11-06T01:00:00Z", hits: [{ id: "E2" }, { id: "S" }] },
        { ts: "2026-11-06T02:00:00Z", hits: [{ id: "E2" }] },
      ].map((x) => JSON.stringify(x)).join("\n") + "\n坏行\n");
      const s = candidateSummary("2026-11-06T00:00:00Z", f);
      t("292 候选汇总:只计武装之后、按次数降序", /2 轮;坏行 1\(未计入,台账可能缺损\)\):E2×2、S×1/.test(s), true);
      t("292 codex r1 §3:汇总带可追溯样本与回放前提", /· E2 @/.test(s) && /真阳性回放,再定删不删/.test(s) && !/⇒ 删检测/.test(s), true);
      fs.writeFileSync(f, JSON.stringify({ ts: "2026-11-05T23:00:00Z", hits: [{ id: "Q" }] }) + "\n");
      t("292 候选汇总:武装之后无命中 ⇒ 零(也出声)", /武装以来命中:零 ──$/.test(candidateSummary("2026-11-06T00:00:00Z", f)), true);
      fs.writeFileSync(f, "坏行\n坏行二\n");
      t("292 codex r1 §5:全是坏行 ⇒ 不报成干净的零", /零;坏行 2/.test(candidateSummary("2026-11-06T00:00:00Z", f)), true);
      fs.writeFileSync(f, JSON.stringify({ ts: "2026-11-06T01:00:00Z", hits: "broken" }) + "\n" + JSON.stringify({ ts: "坏时刻", hits: [] }) + "\n");
      t("292 codex fix-r1 §4:合法 JSON 但结构坏 ⇒ 计坏行", /零;坏行 2/.test(candidateSummary("2026-11-06T00:00:00Z", f)), true);
      fs.writeFileSync(f, JSON.stringify({ ts: "2026-11-06T01:00:00Z", hits: [null, {}] }) + "\n");
      t("292 codex fix2-r1:hits 元素结构坏 ⇒ 计坏行,不报干净的零", /零;坏行 2/.test(candidateSummary("2026-11-06T00:00:00Z", f)), true);
      t("292 红队 附三④:武装时刻缺 ⇒ 不汇总(不把历史全量计进来)", /武装时刻缺,不汇总/.test(candidateSummary(undefined, f)), true);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录留着无害 */ }
      // 红队 BP-1:worktree 里结清时读主树那一份(git 公共目录的上一级)
      t("292 红队 BP-1:台账路径按 git 公共目录定主树",
        candidateLedgerPath(() => ({ status: 0, stdout: "/repo/.git\n" })).replace(/\\/g, "/"), "/repo/.claude/.gate-candidates.jsonl");
      t("292 红队 BP-1:git 取不到 ⇒ 退回 cwd 相对", candidateLedgerPath(() => ({ status: 128, stdout: "" })), ".claude/.gate-candidates.jsonl");
    }
    t("290 FB-15:只改存档 README ⇒ 不列",obligationCheck(g0, { git: names(["docs/archive/laws-2026-11/README.md"]) }).noDecisionTouched, []);
    t("290 FB-15 对照:改规则锚着的存档法典 ⇒ 列出", obligationCheck(g0, { git: names(["docs/archive/laws-2026-11/collab.md"]) }).noDecisionTouched, ["docs/archive/laws-2026-11/collab.md"]);
    t("D177:只改自测文件与普通文档 ⇒ 不拦",obligationCheck(g0, { git: names(["scripts/hook-remote-check.selftest.mjs", "docs/gate-debts.md", "app/page.tsx"]) }).noDecisionTouched, []);
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
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CEILING_DIRECTORIES: path.dirname(tmp) };   // r2:沙盒一律设天花板(本机用户目录是 git 仓)
    const g = (...a) => spawnSync("git", a, { cwd: tmp, encoding: "utf8", env, windowsHide: true });
    const cli = (...a) => spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), ...a], { cwd: tmp, encoding: "utf8", env, windowsHide: true, timeout: 60_000 });
    const w = (rel, s) => { fs.mkdirSync(path.dirname(J(tmp, rel)), { recursive: true }); fs.writeFileSync(J(tmp, rel), s); };
    const commit = (m) => { g("add", "-A"); return g("commit", "-q", "-m", m); };
    const st = () => JSON.parse(fs.readFileSync(J(tmp, ".claude", ".batch-goal.json"), "utf8"));
    const res = {};
    try {
      g("init", "-q"); w(".gitignore", ".claude/\n"); w("gate-install.json", TEST_INSTALL_JSON); w("docs/adr/0008-old.md", "# 0008\n"); w("docs/product-diary.md", "| 日期 | 事项 | 结果 | 证据 |\n|---|---|---|---|\n| d | 批 2560:x | y | e |\n");
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
      const r3 = cli("--clear"); res.noDiary = r3.status === 2 && /reason=diary-missing/.test(r3.stderr) && /不存在/.test(r3.stderr);
    } catch (e) { res.err = String(e && e.message); }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不判 */ } }
    return res;
  })();
  t("集成:arm 记下基点 = 当时 HEAD", [integ.arm, integ.base], [0, true]);
  t("集成:--decision 自动编号 256-D1", [integ.dec, integ.out, integ.decId], [0, 0, "256-D1"]);
  t("集成:同号重武装保留基点与决定", integ.rearmKeepsBase, true);
  t("集成:缺 ADR 与日记行 ⇒ 拒清(exit 2)、点名编号、给日记行模板、状态未结清", [integ.refuse, integ.refuseMsg, integ.notCleared], [2, true, true]);
  t("集成:补 ADR + 日记行并提交 ⇒ 结清", [integ.clear, integ.cleared], [0, true]);
  t("集成 298 r2(原「日记不存在只提示」改):配置了日记而文件被删 ⇒ 按缺拒清 diary-missing", [integ.arm2, integ.noDiary], [0, true]);
  if (integ.err) console.log("  集成段异常:" + integ.err);

  // ── 批 256b 集成:每个回件一个独立临时 git 仓(cwd=临时目录 ⇒ 状态与台账都写在那里,不碰真台账)──
  const sandbox = (fn, opt = {}) => {
    const J = path.join; const tmp = fs.mkdtempSync(J(os.tmpdir(), "bg256b-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CEILING_DIRECTORIES: path.dirname(tmp) };   // r2:沙盒一律设天花板(本机用户目录是 git 仓)
    const g = (...a) => spawnSync("git", a, { cwd: tmp, encoding: "utf8", env, windowsHide: true });
    const cliEnv = (extra, ...a) => spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), ...a], { cwd: tmp, encoding: "utf8", env: { ...env, ...extra }, windowsHide: true, timeout: 60_000 });
    const cli = (...a) => cliEnv({}, ...a);
    const w = (rel, s) => { fs.mkdirSync(path.dirname(J(tmp, rel)), { recursive: true }); fs.writeFileSync(J(tmp, rel), s); };
    const commit = (m) => { g("add", "-A"); return g("commit", "-q", "-m", m); };
    const st = () => JSON.parse(fs.readFileSync(J(tmp, ".claude", ".batch-goal.json"), "utf8"));
    const jrows = () => fs.readFileSync(J(tmp, ".claude", ".batch-goal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const oblDir = J(tmp, ".claude", ".obligations");
    const ost = () => JSON.parse(fs.readFileSync(J(oblDir, "state.json"), "utf8"));
    // 产生器替身:在沙盒仓里经 lib 建义务 / 回报取证(本批不新增真产生器;这只是测通用拒绝与出路)
    const probeFile = J(tmp, "..", `${path.basename(tmp)}-probe.mjs`);
    fs.writeFileSync(probeFile, `import * as OB from ${JSON.stringify(new URL("./lib/obligations.mjs", import.meta.url).href)};
const [cmd, a1, a2, a3] = process.argv.slice(2);
import { spawnSync as __sp } from "node:child_process"; import __fs from "node:fs";
const here = () => { let p = String(__sp("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).stdout || "").trim(); try { p = __fs.realpathSync.native(p); } catch {} p = p.split(String.fromCharCode(92)).join("/"); while (p.endsWith("/")) p = p.slice(0, -1); return process.platform === "win32" ? p.toLowerCase() : p; };
const { dir } = OB.storeDir();
const r = OB.mutateStore(dir, (d) => cmd === "create"
  ? OB.createObligation(d, { type: "selftest-probe", owner: a1 === "-" ? null : a1, checkout: a2 === "-" ? null : (a2 || here()), outlet: "probe evidence <id> cleared", binding: a3 ? { hash: a3 } : null }, "selftest")
  : OB.recordEvidence(d, a1, { producer: "selftest-probe", result: a2, ...(a3 ? { boundHash: a3 } : {}), why: "probe" }));
console.log(JSON.stringify(cmd === "create" ? { id: r.result.id } : r.result));
`);
    const probe = (...a) => { const r = spawnSync(process.execPath, ["--no-warnings", probeFile, ...a], { cwd: tmp, encoding: "utf8", env, windowsHide: true, timeout: 60_000 }); try { return JSON.parse(r.stdout); } catch { return { err: r.stderr }; } };
    const DIARY0 = "| 日期 | 事项 | 结果 | 证据 |\n|---|---|---|---|\n| d | 批 1:x | y | e |\n";
    try {
      g("init", "-q"); g("config", "core.autocrlf", "false"); w(".gitignore", ".claude/\n"); if (opt.config !== false) w("gate-install.json", opt.config || TEST_INSTALL_JSON);
      w("docs/adr/0008-old.md", "# 0008\n"); w("docs/product-diary.md", DIARY0); commit("init");
      return fn({ tmp, g, cli, cliEnv, w, commit, st, jrows, oblDir, ost, probe });
    } catch (e) { return { err: String(e && e.message) }; }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(probeFile, { force: true }); } catch { /* 清不掉不判 */ } }
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
  // 批 298:原 BP-3 是「点名丢失项」——现在不丢:带进新批,新批 --clear 照样核;补上 ADR 与日记行(按批 303 的基点算)才放行
  t("集成 298(原 BP-3 改):--force 换批 ⇒ 决定 / 成果带进新批、记 force-carry-obligations;新批 --clear 拒 obligation-open;补齐后放行", sandbox(({ tmp, cli, w, commit, jrows }) => {
    cli("--arm", "303", "--cond", "甲"); cli("--decision", "会带走的决定"); cli("--outcome", "会带走的成果");
    const r = cli("--arm", "304", "--cond", "乙", "--force");
    const row = jrows().find((o) => o.action === "force-carry-obligations");
    const stat = cli("--status").stdout;
    cli("--no-decision", "自测:本批无决定");
    const c1 = cli("--clear");
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:303-D1\n"); fs.appendFileSync(path.join(tmp, "docs/product-diary.md"), "| d | 批 303:会带走的成果 | y | e |\n"); commit("adr+diary for 303");
    const c2 = cli("--clear");
    return [r.status, /303-D1/.test(r.stderr) && /原样带进批 304/.test(r.stderr), row?.batch, row?.newBatch, row?.decisions?.[0]?.id,
      /决定 303-D1\S来自批 303/.test(stat) && /成果 303:O1/.test(stat), c1.status, /reason=obligation-open/.test(c1.stderr) && /303-D1/.test(c1.stderr), c2.status];
  }), [0, true, "303", "304", "303-D1", true, 2, true, 0]);
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
  oblSelfTest(t, sandbox);
  selfTest305(t);
  selfTest309(t);
  // 批 305:开批列「误报率待修」时带上误报表的口径句(整表不印,口径句单独转出);没有待修行 ⇒ 不印口径句
  {
    const NOTE = "口径:只统计被申诉过的拦截,不是全部拦截的准确率;没人申诉的拦截不在这张表里。";
    const hotOut = [NOTE, "🔴 台账链违例:x", "待修 S       20     3   15.0%             0  ← 下一批待修", ""].join("\n");
    t("305 待修腿:有待修行 ⇒ 告警行、标题、口径句、待修行(去掉标记)依次转出", hotLegLines(hotOut),
      ["🔴 台账链违例:x", "⚠ **误报率待修的规则 1 条**(误报率 ≥15% 且报警 ≥20;本批要么修判据,要么在收尾对照里写明为什么不修):", "  " + NOTE, "  S       20     3   15.0%             0"]);
    t("305 待修腿:没有待修行 ⇒ 口径句不单独出现(只转告警行)", hotLegLines([NOTE, "⚠ 台账坏行:alerts 1 / ledger 0(已跳过)——下面的数字按缺损读", ""].join("\n")), ["⚠ 台账坏行:alerts 1 / ledger 0(已跳过)——下面的数字按缺损读"]);
    t("305 待修腿:报表没带口径句(旧版 hook)⇒ 照旧只列待修行", hotLegLines("待修 K       30     9   30.0%             2  ← 下一批待修\n").length, 2);
    t("305 待修腿:报表跑不出来(空串)⇒ 什么都不印", hotLegLines(""), []);
  }
  CONFIG_OVERRIDE = null;
  const pass = cases.filter(Boolean).length;
  console.log(`\n自测 ${pass}/${cases.length}`);
  return pass === cases.length ? 0 : 1;
}

// ── 批 298 自测:义务账 / 安装方配置 / --clear 通用拒绝 / --settle / 带入(拆批稿「297」节测试矩阵四类:成功、边界、拒绝点实测、出路)──
//   拒绝点一律**主动造一次**该拦的事件看退出码与 reason,不以「没报错」为准。沙盒仓 cwd=临时目录 ⇒ 义务账也在那里,不碰主树。
function oblSelfTest(t, sandbox) {
  const J = path.join;
  const SID = { CLAUDE_CODE_SESSION_ID: "selftest-sess-me-0298" };
  const OTHER = "selftest-sess-other-0298";
  // ── 安装方配置 ──
  const K = parseInstallConfig(TEST_INSTALL_JSON);
  t("298 配置:HostApp 那份解析成功、取值照旧", [K.found, K.diary, K.adrDir, K.debtTable, K.loadBearingExtra.length], [true, "docs/product-diary.md", "docs/adr", "docs/gate-debts.md", 5]);
  // 批 309 C-4:闸的源头仓(安装器脚本在场)自带一份 gate-install.json,只把欠账表指到不随包的 docs/own-debts.md ⇒ 源头仓里不比 HostApp 字面量,
  //   改钉源头仓那份的取值;安装方的仓(没有安装器脚本)照旧与字面量比。
  const isSourceRepo = fs.existsSync(fileURLToPath(new URL("./custodiet-init.mjs", import.meta.url)));
  t("298 配置:仓里那份 gate-install.json 与自测字面量逐项相等(仓里没有这份文件 / 闸的源头仓 ⇒ 不比)", (() => { const f = fileURLToPath(new URL("../gate-install.json", import.meta.url)); if (isSourceRepo || !fs.existsSync(f)) return [K.diary, K.adrDir, K.debtTable, K.loadBearingSrc]; const r = parseInstallConfig(fs.readFileSync(f, "utf8")); return [r.diary, r.adrDir, r.debtTable, r.loadBearingSrc]; })(), [K.diary, K.adrDir, K.debtTable, K.loadBearingSrc]);
  t("309 C-4:源头仓的 gate-install.json 只把欠账表指到 docs/own-debts.md(日记 / ADR / 承重 / 名单都不配),那份表在场(安装方的仓 ⇒ 不比)", (() => {
    if (!isSourceRepo) return [null, null, "docs/own-debts.md", true, [], true];
    const f = fileURLToPath(new URL("../gate-install.json", import.meta.url));
    const r = fs.existsSync(f) ? parseInstallConfig(fs.readFileSync(f, "utf8")) : {};
    return [r.diary, r.adrDir, r.debtTable, r.debtTableExplicit, r.loadBearingSrc, fs.existsSync(fileURLToPath(new URL("../docs/own-debts.md", import.meta.url)))];
  })(), [null, null, "docs/own-debts.md", true, [], true]);
  t("309 C-4:installNames 把显式配置的欠账表交给收尾闸;缺省的不交", [installNames(parseInstallConfig(JSON.stringify({ format: "gate-install/v1", debtTable: "docs/own-debts.md" }))).debtTables,
    installNames(parseInstallConfig(JSON.stringify({ format: "gate-install/v1" }))).debtTables, installNames({ error: "x" }).debtTables], [["docs/own-debts.md"], [], []]);
  t("309 C-6:codexFallbackModel 是登记过的键(不判坏整份);形状不对按没配 + 告警", (() => {
    const a = parseInstallConfig(JSON.stringify({ format: "gate-install/v1", codexFallbackModel: "gpt-x" }));
    const b = parseInstallConfig(JSON.stringify({ format: "gate-install/v1", codexFallbackModel: "a b", diary: "docs/d.md" }));
    return [!!a.error, a.codexFallbackModel, !!b.error, b.codexFallbackModel, b.diary, b.warnings.length];
  })(), [false, "gpt-x", false, null, "docs/d.md", 1]);
  // ── 批 305:两份名单键(部署脚本文件名 / 私仓仓名)──
  t("305 配置:字面量里的两份名单解析得出、没有告警", [K.deployScripts, K.privateRepos, K.warnings], [["deploy-prod.ps1"], ["app-private"], []]);
  t("305 配置:仓里那份 gate-install.json 的两份名单形状对(解析不坏、没有告警;名字是安装方的事,不与字面量比;仓里没有这份文件 ⇒ 不核)", (() => {
    const f = fileURLToPath(new URL("../gate-install.json", import.meta.url)); if (!fs.existsSync(f)) return [true, true, []];
    const r = parseInstallConfig(fs.readFileSync(f, "utf8")); return [Array.isArray(r.deployScripts), Array.isArray(r.privateRepos), r.warnings || [r.error]]; })(), [true, true, []]);
  {
    const pc = (o) => parseInstallConfig(JSON.stringify({ format: "gate-install/v1", ...o }));
    t("305 配置:缺键 / null ⇒ 空名单、无告警、不判坏", [{}, { deployScripts: null, privateRepos: null }].map((o) => { const r = pc(o); return [r.error || null, r.deployScripts, r.privateRepos, r.warnings]; }), [[null, [], [], []], [null, [], [], []]]);
    t("305 配置:没有配置文件 ⇒ 两个空名单", (() => { const r = readInstallConfig(() => { const e = new Error("no"); e.code = "ENOENT"; throw e; }); return [r.deployScripts, r.privateRepos, r.warnings]; })(), [[], [], []]);
    t("305 配置:值类型不对(字符串 / 对象 / 含数字 / 含空串)⇒ 那一键按空名单 + 一行告警,整份不判坏、另一键照取",
      [{ deployScripts: "deploy-prod.ps1", privateRepos: ["app-private"] }, { deployScripts: { a: 1 } }, { privateRepos: ["app-private", 7] }, { deployScripts: ["deploy-prod.ps1", " "] }]
        .map((o) => { const r = pc(o); return [r.error || null, r.deployScripts, r.privateRepos, r.warnings.length]; }),
      [[null, [], ["app-private"], 1], [null, [], [], 1], [null, [], [], 1], [null, [], [], 1]]);
    t("305 配置:部署脚本项带目录 / 私仓项带属主或地址 ⇒ 同样按空名单 + 告警(名单里只写名字)",
      [{ deployScripts: ["scripts/deploy-prod.ps1"] }, { deployScripts: ["scripts\\deploy-prod.ps1"] }, { privateRepos: ["x/app-private"] }, { privateRepos: ["https://github.com/x/app-private.git"] }]
        .map((o) => { const r = pc(o); return [r.deployScripts, r.privateRepos, r.warnings.length]; }), [[[], [], 1], [[], [], 1], [[], [], 1], [[], [], 1]]);
    t("305 配置:归一——去首尾空白、大小写不同的重复项只留一个、私仓名结尾的 .git 去掉",
      (() => { const r = pc({ deployScripts: [" deploy-prod.ps1 ", "Deploy-Prod.PS1", "release.sh"], privateRepos: ["app-private.git", "App-Private"] }); return [r.deployScripts, r.privateRepos, r.warnings]; })(),
      [["deploy-prod.ps1", "release.sh"], ["app-private"], []]);
    t("305 配置:告警文字点名是哪个键、后果是什么", (() => { const w = pc({ privateRepos: "app-private" }).warnings[0] || ""; return [/privateRepos/.test(w), /空名单/.test(w), /判据不响/.test(w)]; })(), [true, true, true]);
    t("305 配置:名单不进义务快照(义务核对不读它们;旧快照比对不变)", (() => { const s = snapshotConfig(K); return ["deployScripts" in s, "privateRepos" in s, "warnings" in s]; })(), [false, false, false]);
    t("305 配置:并基点版时名单与告警跟现行版走", (() => { const m = mergeInstallConfig(pc({ deployScripts: ["a.ps1"], privateRepos: "坏" }), K); return [m.deployScripts, m.privateRepos, m.warnings.length]; })(), [["a.ps1"], [], 1]);
  }
  t("305 --status:名单键写错 ⇒ 打一行告警、退出码照旧 0;写对了 ⇒ 没有这行", [
    sandbox(({ cli }) => { const r = cli("--status"); return [r.status, /⚠ 安装方配置:.*deployScripts.*空名单/.test(r.stdout)]; }, { config: JSON.stringify({ format: "gate-install/v1", deployScripts: "deploy-prod.ps1" }) }),
    sandbox(({ cli }) => { cli("--arm", "305", "--cond", "甲"); const r = cli("--status"); return [r.status, /⚠ 安装方配置:.*privateRepos.*空名单/.test(r.stdout)]; }, { config: JSON.stringify({ format: "gate-install/v1", privateRepos: [1] }) }),
    sandbox(({ cli }) => { const r = cli("--status"); return [r.status, /⚠ 安装方配置/.test(r.stdout)]; }),
  ], [[0, true], [0, true], [0, false]]);
  t("298 配置:未知键(拼错 diray)⇒ 整份判坏", !!parseInstallConfig(JSON.stringify({ format: "gate-install/v1", diray: "x.md" })).error, true);
  t("298 配置:路径带 .. / 绝对路径 ⇒ 判坏", [!!parseInstallConfig(JSON.stringify({ format: "gate-install/v1", diary: "../x.md" })).error, !!parseInstallConfig(JSON.stringify({ format: "gate-install/v1", adrDir: "/abs" })).error], [true, true]);
  t("298 配置:format 不对 / 不是 JSON ⇒ 判坏", [!!parseInstallConfig("{}").error, !!parseInstallConfig("{oops").error], [true, true]);
  t("298 配置:文件不存在 ⇒ 不做日记 / ADR,欠账表取缺省", (() => { const r = readInstallConfig(() => { const e = new Error("no"); e.code = "ENOENT"; throw e; }); return [r.found, r.diary, r.adrDir, r.debtTable]; })(), [false, null, null, "docs/gate-debts.md"]);
  t("298 配置:读错误(非 ENOENT)⇒ error(判不了)", !!readInstallConfig(() => { const e = new Error("busy"); e.code = "EBUSY"; throw e; }).error, true);
  t("298 配置绕过面:批内把 diary 改成 null ⇒ 并入基点版仍要日记", (() => { const m = mergeInstallConfig(parseInstallConfig(JSON.stringify({ format: "gate-install/v1", adrDir: "docs/adr" })), K); return [m.diary, m.mergedFromBase]; })(), ["docs/product-diary.md", true]);
  // ── 承重面拆分等价(行为零变化的机器判据)──
  const OLD = /^(?:AGENTS\.md$|CLAUDE\.md$|docs\/gate\/AGENTS\.md$|docs\/laws\/|docs\/archive\/laws-[^/]+\/(?:collab|reporting|constitution-[\w-]+)\.md$|scripts\/verify-prod\.mjs$|docs\/(?:constraint|tool)-register\.md$|\.claude\/(?:agents|skills|commands)\/|\.claude\/settings(?:\.[\w-]+)?\.json$|scripts\/hook-[^/]+\.mjs$|scripts\/lib\/(?:gate-[^/]+|write-effects)\.mjs$|scripts\/(?:fp-audit|gate-replay|batch-goal|install-git-hooks)\.mjs$|scripts\/gate-deps\/package(?:-lock)?\.json$|scripts\/git-hooks\/)/i;
  const PATHS = ["AGENTS.md", "CLAUDE.md", "docs/gate/AGENTS.md", "docs/laws/collab.md", "docs/archive/laws-2026-11/collab.md", "docs/archive/laws-2026-11/README.md", "docs/archive/laws-x/constitution-core.md",
    "scripts/verify-prod.mjs", "scripts/verify-prod.mjs.bak", "docs/constraint-register.md", "docs/tool-register.md", "docs/tool-index.md", ".claude/agents/a.md", ".claude/skills/x/SKILL.md", ".claude/commands/kplan.md",
    ".claude/settings.json", ".claude/settings.tplan-exec.json", ".claude/settings.local.json", "scripts/hook-guard.mjs", "scripts/hook-guard.selftest.mjs", "scripts/lib/gate-rules.mjs", "scripts/lib/write-effects.mjs",
    "scripts/lib/ledger-chain.mjs", "scripts/fp-audit.mjs", "scripts/gate-replay.mjs", "scripts/batch-goal.mjs", "scripts/install-git-hooks.mjs", "scripts/gate-deps/package.json", "scripts/gate-deps/package-lock.json",
    "scripts/git-hooks/pre-push.mjs", "docs/gate-debts.md", "docs/product-diary.md", "app/page.tsx", "sub/AGENTS.md", "Docs/Laws/x.md", "docs/adr/0001-x.md"];
  t("298 承重面拆分等价:通用面 ∪ HostApp 配置 与原表在 36 条路径上逐条相等", PATHS.filter((p) => OLD.test(p) !== isLoadBearingPath(p, K.loadBearingExtra)), []);
  t("298 承重面:无配置时 HostApp 专属项不算(docs/laws、verify-prod)", [isLoadBearingPath("docs/laws/collab.md", []), isLoadBearingPath("scripts/verify-prod.mjs", []), isLoadBearingPath("scripts/hook-guard.mjs", [])], [false, false, true]);
  t("298 承重面:本批新文件也算(obligations / install-config / gate-install.json)", ["scripts/lib/obligations.mjs", "scripts/lib/install-config.mjs", "gate-install.json"].map((p) => isLoadBearingPath(p, [])), [true, true, true]);
  t("298 无配置:obligationCheck 不核日记 / ADR / 承重面零决定(只出声)", (() => { const o = obligationCheck({ batch: "330", baseCommit: "abc1234", decisions: [{ id: "330-D1" }], outcomes: [{ text: "x" }] }, { config: absentInstallConfig(), git: () => { throw new Error("不该调 git"); }, readDiary: () => { throw new Error("不该读日记"); } }); return [o.missingDecisions, o.diaryMissing, o.noDecisionTouched, !!o.unknown, o.notes.length >= 2]; })(), [[], false, [], false, true]);
  t("298 配置坏 ⇒ obligationCheck 判不了(unknownParts.config)", (() => { const o = obligationCheck({ batch: "330" }, { config: { error: "坏了" } }); return [!!o.unknown, !!o.unknownParts.config]; })(), [true, true]);
  // ── 纯函数:批号 / 失效期 / 债表行 / 裁决参数 ──
  t("298 边界:批号带后缀 292b ⇒ 数字部分 292,失效期 ≤295", [OB.batchNumber("292b"), OB.batchNumber("292b") + 3, OB.batchNumber("hk-1")], [292, 295, NaN]);
  {
    const rec = { id: "OB-x-1", type: "outcome-diary", origin: { batch: "320", baseCommit: "abcdef123456" }, unknownStreak: 3, lastResult: { why: "日记读不了(EISDIR)| 带竖线" }, outlet: "做完它" };
    const row = OB.settleRow(rec, { debtId: "D900", batch: "320", expiry: 323 });
    t("298 债表行:恰 6 列、失效期在第 4 列、竖线被替换", [debtRowCells(row).length, debtRowCells(row)[3].trim(), row.includes("| 带竖线")], [6, "**≤323**", false]);
    t("298 债表行:到期腿在批 324 列出、323 不列", [debtDue([row], 324).mine, debtDue([row], 323).mine], [["D900(≤323)"], []]);
    const tbl = "# x\n## 在账欠账\n\n| # | a | b | c | d | e |\n|---|---|---|---|---|---|\n| D7 | a | 1 | **≤2** | s | o |\n\n## 已销账\n| D9 | x | y | z |\n";
    const ins = OB.insertDebtRow(tbl, row);
    t("298 债表行:插在「在账欠账」节表尾、最大 D 号全表算", [ins.split("\n").indexOf(row), ins.split("\n").indexOf("| D7 | a | 1 | **≤2** | s | o |") + 1, OB.maxDebtId(tbl)], [ins.split("\n").indexOf(row), ins.split("\n").indexOf(row), 9]);
    t("298 债表行:HEAD 版认行要 D 号 + 义务 id + 失效期同在一行", [OB.debtRowCommitted(ins, { ...rec, settle: { debtId: "D900", expiry: 323 } }), OB.debtRowCommitted(ins, { ...rec, settle: { debtId: "D900", expiry: 324 } }), OB.debtRowCommitted(tbl, { ...rec, settle: { debtId: "D900", expiry: 323 } })], [true, false, false]);
  }
  {
    const pv = (a, n) => { try { return parseVerdicts(a, n); } catch { return "throw"; } };
    t("298 裁决参数:不给 ⇒ null;全给 ⇒ 排好序", [pv(["--clear"], 2), pv(["--clear", "--verdict", "2=不适用:没有日记", "--verdict", "1=达成"], 2)], [null, [{ n: 1, verdict: "达成" }, { n: 2, verdict: "不适用", why: "没有日记" }]]);
    t("298 裁决参数:缺条 / 越界 / 重复 / 未达成不带理由 / 乱写 ⇒ 抛", [pv(["--verdict", "1=达成"], 2), pv(["--verdict", "3=达成"], 2), pv(["--verdict", "1=达成", "--verdict", "1=达成"], 1), pv(["--verdict", "1=未达成"], 1), pv(["--verdict", "1=done"], 1)], ["throw", "throw", "throw", "throw", "throw"]);
  }
  // ── 义务账库(临时目录,不经 git)──
  {
    const dir = fs.mkdtempSync(J(os.tmpdir(), "obl298-"));
    const L = J(dir, "ledger.jsonl"), S = J(dir, "state.json");
    const env0 = process.env.OBLIGATIONS_LOCK_WAIT_MS;
    try {
      t("298 库:空目录 ⇒ empty(可信、零条)", [OB.readStore(dir).kind, OB.readStore(dir).obligations.length], ["empty", 0]);
      const a = OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe", owner: "s1", outlet: "x", binding: { hash: "h1" } }, "selftest")).result;
      t("298 库:建一条 ⇒ ok、版本 1、台账验链过", [OB.readStore(dir).kind, OB.readStore(dir).version, verifyChainOk(L)], ["ok", 1, true]);
      const v1 = OB.readStore(dir).version;
      OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe", outlet: "y" }, "selftest"));
      t("298 库 并发:跨长操作持有旧版本再写 ⇒ CONFLICT,不覆盖", (() => { try { OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe" }, "x"), { expectVersion: v1 }); return "no-throw"; } catch (e) { return [e.code, OB.readStore(dir).obligations.length]; } })(), ["CONFLICT", 2]);
      t("298 库 回件绑定:哈希对不上 ⇒ 作废重开(void-stale),不写结论", (() => { const r = OB.mutateStore(dir, (d) => OB.recordEvidence(d, a.id, { producer: "p", result: "cleared", boundHash: "h0" })).result; return [r.voided, OB.readStore(dir).obligations.find((x) => x.id === a.id).status]; })(), [true, "open"]);
      t("298 库 回件绑定:旧 rev 的回件 ⇒ 作废", OB.mutateStore(dir, (d) => OB.recordEvidence(d, a.id, { producer: "p", result: "cleared", boundHash: "h1", seenRev: 1 })).result.voided, true);
      t("298 库:判不了 3 次 ⇒ 可转欠账;中间一次「开着」把连续计数归零", (() => {
        const ev = (res) => OB.mutateStore(dir, (d) => OB.recordEvidence(d, a.id, { producer: "p", result: res, boundHash: "h1" })).result.rec;
        ev("unknown"); ev("unknown"); const mid = OB.settleEligible(ev("open")); ev("unknown"); ev("unknown"); const two = OB.settleEligible(ev("unknown") && OB.readStore(dir).obligations.find((x) => x.id === a.id)); return [mid, two, OB.readStore(dir).obligations.find((x) => x.id === a.id).unknownStreak];
      })(), [false, true, 3]);
      t("298 库:保留类型不收外部回报(调库自助标已清的最短路)", (() => { const id = OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "decision-adr", payload: { id: "1-D1" } }, "x")).result.id; try { OB.mutateStore(dir, (d) => OB.recordEvidence(d, id, { producer: "p", result: "cleared" })); return "no-throw"; } catch (e) { return e.code; } })(), "RESERVED");
      const good = fs.readFileSync(S, "utf8");
      fs.writeFileSync(S, good.replace(/"status": "unknown"/, '"status": "cleared"'));
      t("298 库 拒绝点:手改 state.json 把义务改成已清 ⇒ tampered", OB.readStore(dir).kind, "tampered");
      t("298 库 拒绝点:tampered 时写入一律拒(不在被改过的状态上叠写)", (() => { try { OB.mutateStore(dir, () => 0); return "no-throw"; } catch (e) { return e.code; } })(), "TAMPERED");
      t("298 库 出路:repair 按台账重建 ⇒ ok,结论回到台账里的那个(未清)", (() => { OB.repairStore(dir); const s = OB.readStore(dir); return [s.kind, s.obligations.find((x) => x.id === a.id).status]; })(), ["ok", "unknown"]);
      fs.writeFileSync(S, "");
      t("298 库 边界:state.json 为空 ⇒ tampered(判不了,不当没有)", OB.readStore(dir).kind, "tampered");
      fs.rmSync(S);
      t("298 库 边界:state.json 缺(写到一半崩了)⇒ lag,以台账为准", [OB.readStore(dir).kind, OB.readStore(dir).obligations.length], ["lag", 3]);
      OB.repairStore(dir);
      const raw = fs.readFileSync(L, "utf8");
      fs.writeFileSync(L, raw + '{"at":"x","op":"transition","id":"OB-torn"');
      t("298 库 边界:台账末行撕裂 ⇒ torn(不可信);repair 截掉后恢复", (() => { const k1 = OB.readStore(dir).kind; OB.repairStore(dir); return [k1, OB.readStore(dir).kind, OB.readStore(dir).obligations.length]; })(), ["torn", "ok", 3]);
      fs.writeFileSync(L, raw.replace(/"to":"unknown"/, '"to":"cleared"'));
      t("298 库 拒绝点:改台账行 ⇒ ledger-broken;repair 拒做", [OB.readStore(dir).kind, (() => { try { OB.repairStore(dir); return "no-throw"; } catch (e) { return e.code; } })()], ["ledger-broken", "LEDGER-BROKEN"]);
      fs.writeFileSync(L, raw);
      fs.mkdirSync(J(dir, "state.lock"));
      process.env.OBLIGATIONS_LOCK_WAIT_MS = "150";
      t("298 库 拒绝点:锁被占(未过期)⇒ LOCK-TIMEOUT,盘上不变", (() => { const v = OB.readStore(dir).version; try { OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe" }, "x")); return "no-throw"; } catch (e) { return [e.code, OB.readStore(dir).version === v]; } })(), ["LOCK-TIMEOUT", true]);
      const old = new Date(Date.now() - 60_000); fs.utimesSync(J(dir, "state.lock"), old, old);
      t("298 库 出路:陈锁(>30 s)可夺 ⇒ 写入成功", (() => { try { OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe" }, "x")); return OB.readStore(dir).kind; } catch (e) { return e.code; } })(), "ok");
    } finally {
      if (env0 === undefined) delete process.env.OBLIGATIONS_LOCK_WAIT_MS; else process.env.OBLIGATIONS_LOCK_WAIT_MS = env0;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留着无害 */ }
    }
  }
  // 多进程真并发:6 个进程同时建义务 ⇒ 6 条都在、台账链完好、版本 6(锁真起作用;原 CAS「近乎装饰」)
  {
    const dir = fs.mkdtempSync(J(os.tmpdir(), "obl298c-"));
    const w = J(dir, "..", `${path.basename(dir)}-race.mjs`);
    try {
      fs.writeFileSync(w, `import * as OB from ${JSON.stringify(new URL("./lib/obligations.mjs", import.meta.url).href)};
import { spawn } from "node:child_process";
const dir = ${JSON.stringify(dir)};
if (process.argv[2] === "one") { OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "race" }, "race")); process.exit(0); }
const kids = Array.from({ length: 6 }, () => new Promise((res) => { const c = spawn(process.execPath, [process.argv[1], "one"], { stdio: "ignore", windowsHide: true }); c.on("exit", (code) => res(code)); }));
Promise.all(kids).then((codes) => { console.log(JSON.stringify(codes)); });
`);
      const r = spawnSync(process.execPath, ["--no-warnings", w], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
      const s = OB.readStore(dir);
      t("298 库 并发:6 进程同时写 ⇒ 全部成功、6 条、版本 6、链完好", [r.stdout.trim(), s.kind, s.obligations.length, s.version, verifyChainOk(J(dir, "ledger.jsonl"))], ["[0,0,0,0,0,0]", "ok", 6, 6, true]);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(w, { force: true }); } catch { /* 无害 */ } }
  }

  // ── CLI 集成(沙盒 git 仓)──
  t("298 成功:产生器在未武装时建义务 ⇒ 武装并入 ⇒ --clear 拒(obligation-open)⇒ 产生器写已清 ⇒ 放行", sandbox(({ cliEnv, probe }) => {
    const { id } = probe("create", SID.CLAUDE_CODE_SESSION_ID);
    const arm = cliEnv(SID, "--arm", "310", "--cond", "甲");
    const c1 = cliEnv(SID, "--clear");
    const ev = probe("evidence", id, "cleared");
    const c2 = cliEnv(SID, "--clear");
    return [arm.status, /并入本批/.test(arm.stdout), c1.status, /reason=obligation-open/.test(c1.stderr) && c1.stderr.includes(id), ev.applied, c2.status, /义务:已清 \d+ 条/.test(c2.stdout)];
  }), [0, true, 2, true, true, 0, true]);
  t("298 拒绝点:只有 UNKNOWN ⇒ 拒(obligation-unknown);换批 --force 后新批 --clear 仍拒", sandbox(({ cliEnv, probe }) => {
    cliEnv(SID, "--arm", "311", "--cond", "甲");
    const { id } = probe("create", SID.CLAUDE_CODE_SESSION_ID); probe("evidence", id, "unknown");
    const c1 = cliEnv(SID, "--clear");
    const f = cliEnv(SID, "--arm", "312", "--cond", "乙", "--force");
    const c2 = cliEnv(SID, "--clear");
    const stat = cliEnv(SID, "--status").stdout;
    return [c1.status, /reason=obligation-unknown/.test(c1.stderr), f.status, c2.status, /reason=obligation-unknown/.test(c2.stderr), stat.includes(id)];
  }), [2, true, 0, 2, true, true]);
  // 批 298 r2(红队 BP-1 / codex ⑤):归属只看 checkout——别的 checkout 的不并入、只在 --status 列;同 checkout 换了会话照样认回
  t("298 r2 边界:别的 checkout 未归属的义务不并入本批(不挡本批)、--status 单列;同 checkout 别的会话建的 ⇒ 认回并挡关账", sandbox(({ cliEnv, probe }) => {
    const { id } = probe("create", OTHER, "c:/elsewhere/checkout");
    const arm = cliEnv(SID, "--arm", "313", "--cond", "甲");
    const stat = cliEnv(SID, "--status").stdout;
    const c = cliEnv(SID, "--clear");
    const { id: id2 } = probe("create", OTHER);   // 同 checkout、别的会话
    const arm2 = cliEnv(SID, "--arm", "314", "--cond", "乙");
    const c2 = cliEnv(SID, "--clear");
    return [arm.status, /并入本批/.test(arm.stdout), /别的 checkout 未归属 1 条/.test(stat) && stat.includes(id), c.status, /并入本批/.test(arm2.stdout), c2.status, c2.stderr.includes(id2)];
  }), [0, false, true, 0, true, 2, true]);
  t("298 边界:同号未结清重放 ⇒ 义务与 armedAt 原样保留", sandbox(({ cliEnv, st, ost }) => {
    cliEnv(SID, "--arm", "315", "--cond", "甲"); cliEnv(SID, "--decision", "甲决定"); const a1 = st().armedAt;
    const r = cliEnv(SID, "--arm", "315", "--cond", "甲");
    const rec = ost().obligations.find((x) => x.type === "decision-adr");
    return [r.status, st().armedAt === a1, rec?.payload?.id, rec?.batch?.armedAt === a1, /315-D1/.test(cliEnv(SID, "--status").stdout)];
  }), [0, true, "315-D1", true, true]);
  t("298 拒绝点:手改义务账 state.json 把义务改成已清 ⇒ 拒(obligations-tampered);--repair-obligations 后照台账仍开着 ⇒ 拒 obligation-open", sandbox(({ cliEnv, probe, oblDir }) => {
    cliEnv(SID, "--arm", "316", "--cond", "甲");
    const { id } = probe("create", SID.CLAUDE_CODE_SESSION_ID);
    cliEnv(SID, "--status");
    const S = J(oblDir, "state.json"); fs.writeFileSync(S, fs.readFileSync(S, "utf8").replace(/"status": "open"/g, '"status": "cleared"'));
    const c1 = cliEnv(SID, "--clear");
    const rp = cliEnv(SID, "--repair-obligations");
    const c2 = cliEnv(SID, "--clear");
    return [c1.status, /reason=obligations-tampered/.test(c1.stderr) && /--repair-obligations/.test(c1.stderr), rp.status, c2.status, /reason=obligation-open/.test(c2.stderr) && c2.stderr.includes(id)];
  }), [2, true, 0, 2, true]);
  t("298 拒绝点:改义务账台账行 ⇒ 拒(obligations-ledger-broken);repair 拒做(停下告诉用户)", sandbox(({ cliEnv, probe, oblDir }) => {
    cliEnv(SID, "--arm", "317", "--cond", "甲"); probe("create", SID.CLAUDE_CODE_SESSION_ID);
    const L = J(oblDir, "ledger.jsonl"); fs.writeFileSync(L, fs.readFileSync(L, "utf8").replace('"status":"open"', '"status":"cleared"'));
    const c = cliEnv(SID, "--clear"); const rp = cliEnv(SID, "--repair-obligations");
    return [c.status, /reason=obligations-ledger-broken/.test(c.stderr) && /告诉用户/.test(c.stderr), rp.status];
  }), [2, true, 2]);
  t("298 拒绝点:义务账锁被别的进程占着 ⇒ 拒(obligations-unknown)、批状态不动、不覆盖", sandbox(({ cliEnv, st, oblDir }) => {
    cliEnv(SID, "--arm", "318", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    fs.mkdirSync(J(oblDir, "state.lock"));
    const c = cliEnv({ ...SID, OBLIGATIONS_LOCK_WAIT_MS: "200" }, "--clear");
    const notCleared = st().cleared !== true && !!st().clearRefusedAt;
    fs.rmSync(J(oblDir, "state.lock"), { recursive: true, force: true });
    const c2 = cliEnv(SID, "--clear");
    return [c.status, /reason=obligations-unknown/.test(c.stderr), notCleared, c2.status];
  }), [2, true, true, 0]);
  t("298 拒绝点:武装后整本义务账被删 ⇒ 外部锚对不上 ⇒ 拒(obligations-tampered)", sandbox(({ cliEnv, oblDir }) => {
    cliEnv(SID, "--arm", "319", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    fs.rmSync(oblDir, { recursive: true, force: true });
    const c = cliEnv(SID, "--clear");
    return [c.status, /reason=obligations-tampered/.test(c.stderr) && /不在义务账里/.test(c.stderr)];
  }), [2, true]);
  t("298 出路(完整):判不了 3 次 ⇒ --settle 写债表行(≤批号+3)⇒ 未提交 --clear 拒(D116)⇒ 提交 ⇒ --clear 放行;不足 3 次 --settle 拒;到期开批回到开着", sandbox(({ tmp, g, cliEnv, w, commit }) => {
    g("rm", "-q", "docs/product-diary.md"); w("docs/product-diary.md/keep.txt", "x");
    w("docs/gate-debts.md", "# 欠账\n\n## 在账欠账\n\n| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |\n|---|---|---|---|---|---|\n| D7 | 旧 | 1 | **≤2** | s | o |\n\n## 已销账\n"); commit("diary becomes dir");
    cliEnv(SID, "--arm", "320", "--cond", "甲"); cliEnv(SID, "--outcome", "某成果");
    const k1 = cliEnv(SID, "--clear"), k2 = cliEnv(SID, "--clear");
    const early = cliEnv(SID, "--settle");
    const k3 = cliEnv(SID, "--clear");
    const s = cliEnv(SID, "--settle");
    const table = fs.readFileSync(J(tmp, "docs/gate-debts.md"), "utf8");
    const row = table.split("\n").find((l) => /^\| D8 \|/.test(l)) || "";
    const dirty = cliEnv(SID, "--clear");
    commit("settle row");
    const ok = cliEnv(SID, "--clear");
    const a321 = cliEnv(SID, "--arm", "321", "--cond", "乙"); const c321 = cliEnv(SID, "--clear");
    const a324 = cliEnv(SID, "--arm", "324", "--cond", "丙"); const c324 = cliEnv(SID, "--clear");
    return [[k1.status, /reason=obligation-unknown/.test(k1.stderr), k2.status], [early.status, /还差 1 次/.test(early.stderr)], k3.status,
      [s.status, debtRowCells(row).length, debtRowCells(row)[3]?.trim(), /\| 320 \|/.test(row), /## 已销账/.test(table.split(row)[1] || "")],
      [dirty.status, /reason=uncommitted/.test(dirty.stderr)], [ok.status, ok.stdout.includes("转欠账 1 条(D8 ≤323")],
      [a321.status, /回到开着/.test(a321.stdout), c321.status], [a324.status, /回到开着/.test(a324.stdout), c324.status, /reason=obligation-unknown/.test(c324.stderr)]];
  }), [[2, true, 2], [2, true], 2, [0, 6, "**≤323**", true, true], [2, true], [0, true], [0, false, 0], [0, true, 2, true]]);
  t("298 拒绝点:转欠账行写了又被丢掉(工作树干净、HEAD 里没有)⇒ 拒(settle-uncommitted);重跑 --settle 用同一 D 号补行 ⇒ 提交 ⇒ 放行", sandbox(({ tmp, g, cliEnv, w, commit }) => {
    g("rm", "-q", "docs/product-diary.md"); w("docs/product-diary.md/keep.txt", "x");
    w("docs/gate-debts.md", "## 在账欠账\n\n| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |\n|---|---|---|---|---|---|\n"); commit("diary becomes dir");
    cliEnv(SID, "--arm", "326", "--cond", "甲"); cliEnv(SID, "--outcome", "某成果");
    cliEnv(SID, "--clear"); cliEnv(SID, "--clear"); cliEnv(SID, "--clear");
    const s1 = cliEnv(SID, "--settle");
    const id1 = (s1.stdout.match(/(D\d+) ≤329/) || [])[1];
    g("checkout", "--", "docs/gate-debts.md");   // 把写进去的那一行丢掉 ⇒ 工作树干净、HEAD 里也没有
    const lost = cliEnv(SID, "--clear");
    const s2 = cliEnv(SID, "--settle");
    const id2 = (s2.stdout.match(/(D\d+) ≤329/) || [])[1];
    commit("settle row");
    const ok = cliEnv(SID, "--clear");
    return [s1.status, lost.status, /reason=settle-uncommitted/.test(lost.stderr), s2.status, !!id1 && id1 === id2, fs.existsSync(J(tmp, "docs/gate-debts.md")), ok.status];
  }), [0, 2, true, 0, true, true, 0]);
  t("298 拒绝点:开着(不是判不了)的义务 --settle 拒,出路写「做完它」", sandbox(({ cliEnv, probe }) => {
    cliEnv(SID, "--arm", "325", "--cond", "甲"); probe("create", SID.CLAUDE_CODE_SESSION_ID); cliEnv(SID, "--clear");
    const s = cliEnv(SID, "--settle"); return [s.status, /做完它/.test(s.stderr)];
  }), [2, true]);
  t("298 无配置的临时仓:登记了决定与成果、没有 ADR 也没有日记行 ⇒ --clear 放行(只出声)", sandbox(({ cliEnv }) => {
    cliEnv(SID, "--arm", "330", "--cond", "甲"); cliEnv(SID, "--decision", "某决定"); cliEnv(SID, "--outcome", "某成果");
    const c = cliEnv(SID, "--clear"); return [c.status, /没配 ADR 目录/.test(c.stderr) && /没配产品日记/.test(c.stderr)];
  }, { config: false }), [0, true]);
  t("298 绕过面:批内把配置的 diary 改成 null 并提交 ⇒ 按基点版仍要日记行(diary-missing)", sandbox(({ cliEnv, w, commit }) => {
    cliEnv(SID, "--arm", "331", "--cond", "甲"); cliEnv(SID, "--outcome", "某成果"); cliEnv(SID, "--decision", "改配置");
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:331-D1\n");
    w("gate-install.json", JSON.stringify({ format: "gate-install/v1", adrDir: "docs/adr" })); commit("disable diary");
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=diary-missing/.test(c.stderr)];
  }), [2, true]);
  t("298 r1 配置冻结:批内把 diary 改指到一份有本批行的别的文件 ⇒ 仍按武装时的 product-diary.md 核(diary-missing)", sandbox(({ cliEnv, w, commit }) => {
    cliEnv(SID, "--arm", "345", "--cond", "甲"); cliEnv(SID, "--outcome", "某成果"); cliEnv(SID, "--no-decision", "自测");
    w("docs/other-diary.md", "| 日期 | 事项 | 结果 | 证据 |\n|---|---|---|---|\n| d | 批 345:某成果 | y | e |\n");
    w("gate-install.json", TEST_INSTALL_JSON.replace("docs/product-diary.md", "docs/other-diary.md")); commit("repoint diary");
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=diary-missing/.test(c.stderr)];
  }), [2, true]);
  t("298 r1 拒绝点:本批把 gate-install.json 改坏(基点版合法)⇒ 拒 config-broken-in-batch、不计判不了、--settle 也拒;改回后放行", sandbox(({ g, cliEnv, w, commit, ost }) => {
    cliEnv(SID, "--arm", "346", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    w("gate-install.json", "{坏了"); commit("break config");
    const c1 = cliEnv(SID, "--clear"), c2 = cliEnv(SID, "--clear"), c3 = cliEnv(SID, "--clear");
    const streak = Math.max(0, ...ost().obligations.map((r) => r.unknownStreak || 0));
    const s = cliEnv(SID, "--settle");
    w("gate-install.json", TEST_INSTALL_JSON); commit("fix config");
    const ok = cliEnv(SID, "--clear");
    return [c1.status, /reason=config-broken-in-batch/.test(c1.stderr) && /改回 gate-install\.json/.test(c1.stderr), c3.status, streak, s.status, ok.status, !!g];
  }), [2, true, 2, 0, 2, 0, true]);
  t("298 拒绝点:手改批状态文件删掉已登记的决定 ⇒ 义务账里还在 ⇒ 照样拒(adr-missing)", sandbox(({ tmp, cliEnv }) => {
    cliEnv(SID, "--arm", "332", "--cond", "甲"); cliEnv(SID, "--decision", "会被手删的决定");
    const F = J(tmp, ".claude", ".batch-goal.json"); const o = JSON.parse(fs.readFileSync(F, "utf8")); o.decisions = []; fs.writeFileSync(F, JSON.stringify(o));
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=adr-missing/.test(c.stderr) && /332-D1/.test(c.stderr)];
  }), [2, true]);
  t("298 迁移:旧版批状态(带决定、义务账里没有)⇒ --clear 导入并照常核;补 ADR 后放行", sandbox(({ tmp, g, cliEnv, w, commit }) => {
    const base = g("rev-parse", "HEAD").stdout.trim();
    w(".claude/.batch-goal.json", JSON.stringify({ batch: "333", conditions: ["甲"], checks: [], shell: "bash", armedAt: "2026-11-01T00:00:00.000Z", baseCommit: base, decisions: [{ id: "333-D1", text: "旧决定" }], outcomes: [], withdrawn: [], version: 3 }));
    ledgerAppend(J(tmp, ".claude", ".batch-goal.jsonl"), { at: "2026-11-01T00:00:00.000Z", action: "arm", batch: "333", conditions: ["甲"], checks: [], shell: "bash", baseCommit: base });   // 旧版 arm 行:没有 armedAt / oblHead
    const c1 = cliEnv(SID, "--clear");
    const stat = cliEnv(SID, "--status").stdout;
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:333-D1\n"); commit("adr");
    const c2 = cliEnv(SID, "--clear");
    return [c1.status, /reason=adr-missing/.test(c1.stderr), /决定 333-D1/.test(stat), c2.status, fs.existsSync(J(tmp, ".claude", ".obligations", "ledger.jsonl"))];
  }), [2, true, true, 0, true]);
  t("298 --context:一行、带路径与哈希;内容不变哈希不变,义务变了哈希变", sandbox(({ cliEnv, probe }) => {
    cliEnv(SID, "--arm", "334", "--cond", "甲");
    const a = cliEnv(SID, "--context").stdout.trim(), b = cliEnv(SID, "--context").stdout.trim();
    probe("create", SID.CLAUDE_CODE_SESSION_ID);
    const c = cliEnv(SID, "--context").stdout.trim();
    const h = (s) => (s.match(/sha256=([0-9a-f]{16})/) || [])[1];
    return [a.split("\n").length, /^BATCH-CONTEXT 批 334 已武装/.test(a) && /path=\S+state\.json/.test(a), h(a) === h(b), h(a) !== h(c), /本 checkout 未归属 1/.test(c)];
  }), [1, true, true, true, true]);
  t("298 裁决参数:--clear --verdict 全给 ⇒ 记进台账 clear 行;缺条 ⇒ 拒(verdict-usage)且留拒清痕迹", sandbox(({ cliEnv, st, jrows }) => {
    cliEnv(SID, "--arm", "335", "--cond", "甲", "--cond", "乙"); cliEnv(SID, "--no-decision", "自测");
    const bad = cliEnv(SID, "--clear", "--verdict", "1=达成");
    const trace = !!st().clearRefusedAt;
    const ok = cliEnv(SID, "--clear", "--verdict", "1=达成", "--verdict", "2=不适用:本仓无此项");
    const row = jrows().filter((o) => o.action === "clear").pop();
    return [bad.status, /reason=verdict-usage/.test(bad.stderr), trace, ok.status, row?.verdicts?.map((v) => v.verdict)];
  }), [2, true, true, 0, ["达成", "不适用"]]);
  t("298 withdraw:带进来的决定可按编号撤回(出路之一),撤后新批 --clear 放行", sandbox(({ cliEnv }) => {
    cliEnv(SID, "--arm", "336", "--cond", "甲"); cliEnv(SID, "--decision", "登记错了的决定");
    cliEnv(SID, "--arm", "337", "--cond", "乙", "--force"); cliEnv(SID, "--no-decision", "自测");
    const c1 = cliEnv(SID, "--clear");
    const wd = cliEnv(SID, "--withdraw", "336-D1", "--reason", "不是决定");
    const c2 = cliEnv(SID, "--clear");
    return [c1.status, wd.status, /带入本批/.test(wd.stdout), c2.status];
  }), [2, 0, true, 0]);
  oblSelfTestR1(t, sandbox, SID, OTHER);
  oblSelfTestR2(t, sandbox, SID);
  oblSelfTestR3(t, sandbox, SID);
}
// ── 批 298 r3(codex 298-review-r3 ①②§3 另项 / 红队 r3 BP-1)──
function oblSelfTestR3(t, sandbox, SID) {
  const J = path.join;
  t("298 r3 拒绝点(codex ①):重武装时批状态写失败(arm 行已落盘)→ 删账 → --clear ⇒ arm 行自带的锚抓住(obligations-tampered)", sandbox(({ tmp, cliEnv, oblDir }) => {
    cliEnv(SID, "--arm", "391", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    const F = J(tmp, ".claude", ".batch-goal.json"); fs.chmodSync(F, 0o444);
    const re = cliEnv(SID, "--arm", "391", "--cond", "甲");
    fs.chmodSync(F, 0o666);
    fs.rmSync(oblDir, { recursive: true, force: true });
    const c = cliEnv(SID, "--clear");
    return [re.status, c.status, /reason=obligations-tampered/.test(c.stderr)];
  }), [2, 2, true]);
  t("298 r3 拒绝点(红队 BP-1):截账 + 弄坏 state → 账坏时 --arm(arm 行记 anchorUnknown)→ repair → --clear ⇒ 越过 anchorUnknown 用更早的锚抓住", sandbox(({ cliEnv, oblDir }) => {
    cliEnv(SID, "--arm", "392", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测"); const c0 = cliEnv(SID, "--clear");
    const L = J(oblDir, "ledger.jsonl"), S = J(oblDir, "state.json");
    fs.writeFileSync(L, fs.readFileSync(L, "utf8").split("\n").slice(0, 2).join("\n") + "\n"); fs.writeFileSync(S, "坏");
    const a = cliEnv(SID, "--arm", "393", "--cond", "乙");
    const rp = cliEnv(SID, "--repair-obligations");
    const c = cliEnv(SID, "--clear");
    return [c0.status, a.status, rp.status, c.status, /reason=obligations-tampered/.test(c.stderr)];
  }), [0, 0, 0, 2, true]);
  t("298 r3(codex ②):写到一半失锁——链断 ⇒ 「停下告诉用户」不推荐 repair;只是 state 落后 ⇒ 推荐 repair", (() => {
    const run = (inject) => {
      const dir = fs.mkdtempSync(J(os.tmpdir(), "obl298r3-"));
      try {
        OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t" }, "x"));
        let err = null;
        try { OB.mutateStore(dir, (d) => { OB.createObligation(d, { type: "t" }, "x"); OB.createObligation(d, { type: "t" }, "x"); }, { onStep: ({ phase, appended }) => { if (phase === "ledger" && appended === 1) inject(J(dir, "ledger.jsonl")); } }); }
        catch (e) { err = e; }
        fs.rmSync(J(dir, "state.lock"), { recursive: true, force: true });
        return [err?.code, !!err?.chainBroken, /停下告诉用户/.test(err?.message || ""), /--repair-obligations/.test(err?.message || "")];
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
    };
    return [run((L) => fs.appendFileSync(L, "garbage\n")), run((L) => ledgerAppend(L, { foreign: 1 }))];
  })(), [["PARTIAL", true, true, false], ["PARTIAL", false, false, true]]);
  t("298 r3(codex §3):确认义务账丢失看得见——--status 列理由、--clear 首行写明、--history 显示理由", sandbox(({ cliEnv, w, commit, oblDir }) => {
    cliEnv(SID, "--arm", "394", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    fs.rmSync(oblDir, { recursive: true, force: true });
    const acc = cliEnv(SID, "--arm", "394", "--cond", "甲", "--accept-obligation-loss", "理由X");
    const stat = cliEnv(SID, "--status").stdout;
    w("docs/adr/0009-a.md", "# 0009\n- 决定编号:394-D1\n"); commit("adr");
    const c = cliEnv(SID, "--clear");
    const hist = cliEnv(SID, "--history", "50").stdout;
    return [acc.status, /本批曾确认义务账丢失:.*理由「理由X」/.test(stat), c.status, String(c.stdout).split("\n")[0].startsWith("本批曾确认义务账丢失(理由:理由X)"), /理由:理由X/.test(hist)];
  }), [0, true, 0, true, true]);
  // 猎手 r3 FB-1 / FB-3 / FB-4 / FB-6③(只改文案或一行判定)
  t("298 r3 FB-1:确认丢失已记、武装因批状态写失败而失败 ⇒ 文案说「确认已记,重跑时去掉 --accept-obligation-loss」;照做 ⇒ 放行", sandbox(({ tmp, cliEnv, oblDir }) => {
    cliEnv(SID, "--arm", "396", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    fs.rmSync(oblDir, { recursive: true, force: true });
    const F = J(tmp, ".claude", ".batch-goal.json"); fs.chmodSync(F, 0o444);
    const a1 = cliEnv(SID, "--arm", "396", "--cond", "甲", "--accept-obligation-loss", "确认");
    fs.chmodSync(F, 0o666);
    const a2 = cliEnv(SID, "--arm", "396", "--cond", "甲");
    return [a1.status, /确认已记进批台账/.test(a1.stderr) && /重跑时去掉 --accept-obligation-loss/.test(a1.stderr), a2.status];
  }), [2, true, 0]);
  t("298 r3 FB-3:--clear 的锚类拒绝出路带 accept 命令且写明须用户确认", sandbox(({ cliEnv, oblDir }) => {
    cliEnv(SID, "--arm", "397", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    fs.rmSync(oblDir, { recursive: true, force: true });
    const c = cliEnv(SID, "--clear"); return [c.status, /--accept-obligation-loss/.test(c.stderr) && /须用户确认后才用/.test(c.stderr)];
  }), [2, true]);
  t("298 r3 FB-4:基点版也解析不了 ⇒ 文案说「基点那一版也解析不了」,不说「是本批改坏的」", sandbox(({ cliEnv, w, commit }) => {
    w("gate-install.json", "{基点就坏"); commit("bad base");
    cliEnv(SID, "--arm", "398", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    w("gate-install.json", "{还是坏"); commit("still bad");
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=config-broken-in-batch/.test(c.stderr), /基点那一版也解析不了/.test(c.stderr), /基点时是合法的/.test(c.stderr)];
  }), [2, true, true, false]);
  t("298 r3 FB-6③:改名跟随时 git diff 失败(基点不可达)⇒ 判不了,不落成「缺」", (() => {
    const g = (a) => (a[0] === "ls-tree" ? { status: 0, stdout: "" } : { status: 128, stdout: "", stderr: "bad object" });
    return [followRename("docs/a.md", "dead", "docs/b.md", g) === FOLLOW_UNKNOWN, followRename("docs/a.md", "dead", "docs/a.md", g)];
  })(), [true, null]);
  t("298 r3(codex 另项):基点没有配置时的坏配置文案不说「基点合法、本批改坏」、不给 git show 基点", sandbox(({ cliEnv, w, commit }) => {
    cliEnv(SID, "--arm", "395", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    w("gate-install.json", "{坏"); commit("bad config");
    const c = cliEnv(SID, "--clear");
    return [c.status, /reason=config-broken-in-batch/.test(c.stderr), /基点无此文件/.test(c.stderr), /基点时是合法的|git show/.test(c.stderr)];
  }, { config: false }), [2, true, true, false]);
}
// ── 批 298 r2 复审修复的夹具(codex 298-review-r2 / 红队 BP-1、BP-6、附三 / 误拦猎手 FB-1~6)──
function oblSelfTestR2(t, sandbox, SID) {
  const J = path.join;
  const DT = "## 在账欠账\n\n| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |\n|---|---|---|---|---|---|\n";
  // ② 锚覆盖所有写入口 + 人工确认出路
  t("298 r2 拒绝点:删账后走 --outcome 重建 ⇒ 写前核锚就拒;--accept-obligation-loss 只在锚对不上时可用;确认后记一行、放行、下一批不被旧锚锁死", sandbox(({ cliEnv, oblDir, jrows }) => {
    cliEnv(SID, "--arm", "380", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    fs.rmSync(oblDir, { recursive: true, force: true });
    const o = cliEnv(SID, "--outcome", "想重建");
    const a0 = cliEnv(SID, "--arm", "380", "--cond", "甲");
    const acc = cliEnv(SID, "--arm", "380", "--cond", "甲", "--accept-obligation-loss", "测试:用户确认丢账");
    const row = jrows().find((r) => r.action === "accept-obligation-loss");
    const bad = cliEnv(SID, "--arm", "380", "--cond", "甲", "--accept-obligation-loss", "锚对得上时不许用");
    const d2 = cliEnv(SID, "--decision", "丢账之后的决定");
    return [o.status, /拒绝登记成果/.test(o.stderr), a0.status, acc.status, /义务账丢失已由执行者确认/.test(acc.stdout), row?.reason, !!row?.lostAnchor?.h, bad.status, d2.status];
  }), [2, true, 2, 0, true, "测试:用户确认丢账", true, 2, 0]);
  // ② 锚范围只到当前批 arm 行(猎手 FB-2:更早批记的锚不再约束,否则一次丢账永久锁死这个 checkout)
  t("298 r2 锚范围:最后一条 arm / accept-obligation-loss 行之前记的锚不算;之后记的才算", (() => {
    const f = J(os.tmpdir(), `bg298-anchor-${process.pid}.jsonl`);
    const put = (rows) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    try {
      put([{ action: "decision", oblHead: { h: "old", version: 3 } }, { action: "arm", batch: "2" }, { action: "decision", batch: "2" }]); const a = lastOblAnchor(f);
      put([{ action: "decision", oblHead: { h: "old", version: 3 } }, { action: "accept-obligation-loss" }]); const b = lastOblAnchor(f);
      put([{ action: "arm", batch: "2" }, { action: "obl-head", oblHead: { h: "new", version: 5 } }]); const c = lastOblAnchor(f);
      return [a, b, c?.h];
    } finally { try { fs.rmSync(f, { force: true }); } catch { /* 无害 */ } }
  })(), [null, null, "new"]);
  // ③ --force 换批:导入用武装台账的基点
  t("298 r2 边界:旧版批状态的基点被手改后 --force 换批 ⇒ 带入的决定按武装台账的基点记", sandbox(({ tmp, g, cliEnv, w, commit, ost }) => {
    const base1 = g("rev-parse", "HEAD").stdout.trim();
    w("x.txt", "1"); commit("c2"); const base2 = g("rev-parse", "HEAD").stdout.trim();
    w(".claude/.batch-goal.json", JSON.stringify({ batch: "381", conditions: ["甲"], checks: [], shell: "bash", armedAt: "2026-11-01T00:00:00.000Z", baseCommit: base2, decisions: [{ id: "381-D1", text: "旧决定" }], outcomes: [], withdrawn: [], version: 3 }));
    ledgerAppend(J(tmp, ".claude", ".batch-goal.jsonl"), { at: "2026-11-01T00:00:00.000Z", action: "arm", batch: "381", conditions: ["甲"], checks: [], shell: "bash", baseCommit: base1, armedAt: "2026-11-01T00:00:00.000Z" });
    const f = cliEnv(SID, "--arm", "382", "--cond", "乙", "--force");
    const rec = ost().obligations.find((r) => r.type === "decision-adr" && r.payload?.id === "381-D1");
    return [f.status, /对不上/.test(f.stderr), rec?.origin?.baseCommit === base1, rec?.batch?.batch];
  }), [0, true, true, "382"]);
  // ④ arm 行写不进 ⇒ 拒武装、批状态与义务账都不动
  t("298 r2 拒绝点:--arm 时批台账写不进 ⇒ 拒(exit 2)、批状态仍是旧批、义务账没多行", sandbox(({ tmp, cliEnv, st, ost }) => {
    cliEnv(SID, "--arm", "383", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测"); cliEnv(SID, "--clear");
    const v0 = ost().version, s0 = JSON.stringify(st());
    const Jf = J(tmp, ".claude", ".batch-goal.jsonl"); fs.chmodSync(Jf, 0o444);
    const a = cliEnv(SID, "--arm", "384", "--cond", "乙");
    fs.chmodSync(Jf, 0o666);
    return [a.status, /批台账 .* 写不进去/.test(a.stderr), JSON.stringify(st()) === s0, ost().version === v0];
  }), [2, true, true, true]);
  // ⑤a 现行配置解析坏 ⇒ broken-in-batch(基点没有配置也一样)
  t("298 r2 拒绝点:基点没有配置、本批写了一份坏的 gate-install.json ⇒ config-broken-in-batch", sandbox(({ cliEnv, w, commit }) => {
    cliEnv(SID, "--arm", "385", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    w("gate-install.json", "{坏"); commit("bad config");
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=config-broken-in-batch/.test(c.stderr)];
  }, { config: false }), [2, true]);
  // ⑤b 读错误 ⇒ 判不了(不是 broken)
  t("298 r2 误拦:gate-install.json 读不了(变成目录 EISDIR)⇒ obligation-unknown、不算本批改坏", sandbox(({ g, cliEnv, w, commit }) => {
    cliEnv(SID, "--arm", "386", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    g("rm", "-q", "gate-install.json"); w("gate-install.json/keep.txt", "x"); commit("config becomes dir");
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=obligation-unknown/.test(c.stderr), /config-broken-in-batch/.test(c.stderr)];
  }), [2, true, false]);
  // ⑤c 诚实迁移:改名跟随
  t("298 r2 误拦:日记在本批被 git mv 改名、现行配置也指向新路径 ⇒ 按新路径核(有本批行就放行);现行配置没跟上 ⇒ 按缺拒", sandbox(({ tmp, g, cliEnv, w, commit }) => {
    cliEnv(SID, "--arm", "387", "--cond", "甲"); cliEnv(SID, "--outcome", "某成果"); cliEnv(SID, "--no-decision", "自测:只改配置路径");
    g("mv", "docs/product-diary.md", "docs/diary2.md"); fs.appendFileSync(J(tmp, "docs/diary2.md"), "| d | 批 387:某成果 | y | e |\n"); commit("rename diary");
    const c1 = cliEnv(SID, "--clear");
    w("gate-install.json", TEST_INSTALL_JSON.replace("docs/product-diary.md", "docs/diary2.md")); commit("config follows");
    const c2 = cliEnv(SID, "--clear");
    return [c1.status, /reason=diary-missing/.test(c1.stderr), c2.status, /按新路径核/.test(c2.stderr)];
  }), [2, true, 0, true]);
  // ⑤d ADR 目录不在 ⇒ 按缺(给模板),不是判不了
  t("298 r2 误拦:配置的 ADR 目录在 HEAD 里不存在 ⇒ adr-missing(给模板),不是 obligation-unknown", sandbox(({ cliEnv }) => {
    cliEnv(SID, "--arm", "388", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=adr-missing/.test(c.stderr) && /决定编号:388-D1/.test(c.stderr)];
  }, { config: TEST_INSTALL_JSON.replace('"docs/adr"', '"docs/adr2"') }), [2, true]);
  // ⑥ 落盘逐步核锁:写到一半失锁 ⇒ PARTIAL、报写到第几行、立即停;repair 可修
  t("298 r2 拒绝点:追加第 2 行前锁被夺 ⇒ PARTIAL(台账已写 1 行、state 未同步、指向 --repair-obligations),第 2 行没写", (() => {
    const dir = fs.mkdtempSync(J(os.tmpdir(), "obl298r2p-"));
    try {
      OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t" }, "x"));
      const v0 = OB.readStore(dir).version;
      let err = null;
      try {
        OB.mutateStore(dir, (d) => { OB.createObligation(d, { type: "t" }, "x"); OB.createObligation(d, { type: "t" }, "x"); },
          { onStep: ({ phase, appended }) => { if (phase === "ledger" && appended === 1) fs.writeFileSync(J(dir, "state.lock", "owner"), JSON.stringify({ token: "thief" })); } });
      } catch (e) { err = e; }
      fs.rmSync(J(dir, "state.lock"), { recursive: true, force: true });
      const k = OB.readStore(dir).kind, v1 = OB.readStore(dir).version;
      OB.repairStore(dir);
      return [err?.code, err?.phase, err?.appended, /--repair-obligations/.test(err?.message || ""), v1 - v0, k, OB.readStore(dir).kind];
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  })(), ["PARTIAL", "ledger", 1, true, 1, "lag", "ok"]);
  // ⑦ --settle 分阶段如实报:台账已追加、state 同步失败
  t("298 r2 出路:--settle 时 state 写失败 ⇒ 报「债表已写、台账已追加、state 未同步」(不说「义务账未记」);repair 后重跑同号补齐", sandbox(({ tmp, g, cliEnv, w, commit, oblDir }) => {
    g("rm", "-q", "docs/product-diary.md"); w("docs/product-diary.md/keep.txt", "x"); w("docs/gate-debts.md", DT); commit("setup");
    cliEnv(SID, "--arm", "389", "--cond", "甲"); cliEnv(SID, "--outcome", "某成果");
    cliEnv(SID, "--clear"); cliEnv(SID, "--clear"); cliEnv(SID, "--clear");
    const S = J(oblDir, "state.json"); fs.chmodSync(S, 0o444);
    const s1 = cliEnv(SID, "--settle");
    fs.chmodSync(S, 0o666);
    const rp = cliEnv(SID, "--repair-obligations"), s2 = cliEnv(SID, "--settle");
    const rows = fs.readFileSync(J(tmp, "docs/gate-debts.md"), "utf8").split("\n").filter((l) => /^\| D\d+ \|/.test(l));
    return [s1.status, /债表已写 D1/.test(s1.stderr) && /台账已追加 1 行/.test(s1.stderr) && /state 未同步/.test(s1.stderr) && !/义务账未记/.test(s1.stderr), rp.status, s2.status, rows.length];
  }), [2, true, 0, 0, 1]);
  // ⑧ 被拒的 --clear 也记锚
  t("298 r2:被拒的 --clear 写过义务账 ⇒ 批台账也记 obl-head;截掉那几行 ⇒ 下次 --clear 被锚抓住", sandbox(({ cliEnv, probe, oblDir, jrows }) => {
    cliEnv(SID, "--arm", "390", "--cond", "甲"); probe("create", SID.CLAUDE_CODE_SESSION_ID);
    const L = J(oblDir, "ledger.jsonl"); const before = fs.readFileSync(L, "utf8");
    const c1 = cliEnv(SID, "--clear");
    const last = jrows().filter((r) => r.oblHead).pop();
    fs.writeFileSync(L, before); fs.rmSync(J(oblDir, "state.json"), { force: true });
    const c2 = cliEnv(SID, "--clear");
    return [c1.status, last?.action, c2.status, /reason=obligations-tampered/.test(c2.stderr)];
  }), [2, "obl-head", 2, true]);
}
// ── 批 298 r1 复审修复的夹具(codex 298-review-r1 / 红队 BP-1~6 / 误拦猎手 FB-1~8)──
function oblSelfTestR1(t, sandbox, SID, OTHER) {
  const J = path.join;
  // 配置方言 / 裁决方言(FB-2 / FB-3 / FB-8)
  t("298 r1 配置:UTF-8 BOM 剥掉照常解析;./ 前缀归一", (() => { const r = parseInstallConfig(String.fromCharCode(0xFEFF) + JSON.stringify({ format: "gate-install/v1", diary: "./docs/product-diary.md" })); return [r.error || null, r.diary]; })(), [null, "docs/product-diary.md"]);
  t("298 r1 配置:UTF-16 给可读报错", /UTF-16/.test(parseInstallConfig("��{\u0000\"\u0000").error || ""), true);
  t("298 r1 配置:debtTable 批内去掉 ⇒ 并基点版", mergeInstallConfig(parseInstallConfig(JSON.stringify({ format: "gate-install/v1" })), parseInstallConfig(JSON.stringify({ format: "gate-install/v1", debtTable: "docs/x-debts.md" }))).debtTable, "docs/x-debts.md");
  t("298 r1 裁决:全角数字 / 全角等号 / 句末标点", (() => { try { return parseVerdicts(["--verdict", "１＝达成。", "--verdict", "2=不适用:没有日记。"], 2); } catch (e) { return `throw:${e.message}`; } })(), [{ n: 1, verdict: "达成" }, { n: 2, verdict: "不适用", why: "没有日记" }]);
  // 库:绑定必填、读错重试、锁令牌、窄冲突、重放性能
  {
    const dir = fs.mkdtempSync(J(os.tmpdir(), "obl298r1-"));
    try {
      const a = OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe", binding: { hash: "h1" } }, "x")).result;
      t("298 r1 绑定:义务带 binding 而回报不给 boundHash ⇒ 拒(BINDING-REQUIRED)", (() => { try { OB.mutateStore(dir, (d) => OB.recordEvidence(d, a.id, { producer: "p", result: "cleared" })); return "no-throw"; } catch (e) { return e.code; } })(), "BINDING-REQUIRED");
      let n = 0;
      const flaky = (f, enc) => { if (n++ < 2) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } return fs.readFileSync(f, enc); };
      t("298 r1 锁外读:前两次 EBUSY ⇒ 重试后读到 ok(不归 tampered)", [OB.readStore(dir, 5, flaky).kind, n > 2], ["ok", true]);
      t("298 r1 锁外读:一直 EBUSY ⇒ unreadable(不是 tampered)", OB.readStore(dir, 3, () => { const e = new Error("busy"); e.code = "EBUSY"; throw e; }).kind, "unreadable");
      const lock = J(dir, "state.lock");
      t("298 r1 锁令牌:临界区里锁被别人夺走 ⇒ 写入前再核 ⇒ CONFLICT、不写、不删别人的锁", (() => {
        const v = OB.readStore(dir).version;
        try { OB.mutateStore(dir, (d) => { fs.writeFileSync(J(lock, "owner"), JSON.stringify({ token: "someone-else" })); OB.createObligation(d, { type: "t-probe" }, "x"); }); return "no-throw"; }
        catch (e) { const left = fs.existsSync(lock); fs.rmSync(lock, { recursive: true, force: true }); return [e.code, OB.readStore(dir).version === v, left]; }
      })(), ["CONFLICT", true, true]);
      // 窄冲突(FB-1):别批的记录变了不算冲突;本批的变了才算
      const prevG = { batch: "350", armedAt: "2026-11-07T00:00:00.000Z", conditions: ["甲"], baseCommit: null };
      const key = batchKeyOf(prevG);
      const mine = OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe", batch: key }, "x")).result;
      const other = OB.mutateStore(dir, (d) => OB.createObligation(d, { type: "t-probe", batch: { batch: "999", armedAt: "z" } }, "x")).result;
      const ctx = { sid: null, checkout: "nowhere" };
      const plan = planClear(prevG, OB.readStore(dir).obligations, ctx, { config: absentInstallConfig(), git: () => ({ status: 128, stdout: "" }) });
      OB.mutateStore(dir, (d) => OB.recordEvidence(d, other.id, { producer: "p", result: "unknown" }));
      const okUnrelated = (() => { try { OB.mutateStore(dir, (d) => applyClearPlan(d, prevG, plan, ctx)); return "ok"; } catch (e) { return e.code; } })();
      const plan2 = planClear(prevG, OB.readStore(dir).obligations, ctx, { config: absentInstallConfig(), git: () => ({ status: 128, stdout: "" }) });
      OB.mutateStore(dir, (d) => OB.recordEvidence(d, mine.id, { producer: "p", result: "unknown" }));
      const conflict = (() => { try { OB.mutateStore(dir, (d) => applyClearPlan(d, prevG, plan2, ctx)); return "ok"; } catch (e) { return e.code; } })();
      t("298 r1 窄冲突:别批记录变了 ⇒ 照常落笔;本批记录变了 ⇒ CONFLICT", [okUnrelated, conflict], ["ok", "CONFLICT"]);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  }
  {
    // 重放性能(FB-4):300 批 × 3 条 × 2 行 = 1800 行台账,readStore 一次 < 300 ms
    const dir = fs.mkdtempSync(J(os.tmpdir(), "obl298p-"));
    try {
      const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
      const enabled = "2026-11-07", gh = sha("GENESIS" + enabled);
      const out = [`{"genesis":"v1","enabled":"${enabled}","h":"${gh}"}`];
      let prevH = gh;
      const recs = new Map();
      for (let b = 0; b < 300; b++) for (let k = 0; k < 3; k++) for (let step = 0; step < 2; step++) {
        const id = `OB-p${b}-${k}`;
        const rec = { id, type: "decision-adr", status: step ? "cleared" : "open", owner: null, checkout: null, origin: { batch: String(b), armedAt: "a", baseCommit: null }, batch: { batch: String(b), armedAt: "a" }, trigger: {}, payload: { id: `${b}-D${k + 1}`, text: "x".repeat(40) }, outlet: "o", createdAt: "t", due: null, binding: null, unknownStreak: 0, lastResult: null, settle: null, config: null, rev: step + 1 };
        recs.set(id, rec);
        const body = JSON.stringify({ at: "t", op: step ? "transition" : "create", id, from: step ? "open" : null, to: rec.status, by: "perf", rec });
        const h = sha(Buffer.concat([Buffer.from(prevH, "utf8"), Buffer.from(body, "utf8")]));
        out.push(body.slice(0, -1) + `,"h":"${h}"}`); prevH = h;
      }
      fs.writeFileSync(J(dir, "ledger.jsonl"), out.join("\n") + "\n");
      OB.repairStore(dir);
      OB.readStore(dir);   // 预热
      const t0 = process.hrtime.bigint(); const s = OB.readStore(dir); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const rssMb = Math.round(process.memoryUsage().rss / 1048576);
      console.log(`      (298 r1 重放读数:1800 行台账 readStore ${ms.toFixed(1)} ms,rss ${rssMb} MB)`);
      t("298 r1 性能:1800 行台账 readStore 一次 < 300 ms、结论 ok、900 条", [ms < 300, s.kind, s.obligations.length], [true, "ok", 900]);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  }
  // CLI:批身份绑定(codex §1 / BP-1 / BP-6)
  t("298 r1 拒绝点:手改状态文件的基点 ⇒ 拒(obligations-tampered);--settle 也拒;照原条件原样重放 --arm 从台账恢复 ⇒ 放行", sandbox(({ tmp, g, cliEnv, w, commit, st }) => {
    w("x.txt", "1"); commit("c1"); const base1 = g("rev-parse", "HEAD").stdout.trim();
    cliEnv(SID, "--arm", "351", "--cond", "甲"); cliEnv(SID, "--no-decision", "自测");
    w("y.txt", "2"); commit("c2");
    const F = J(tmp, ".claude", ".batch-goal.json"); const o = st(); o.baseCommit = g("rev-parse", "HEAD").stdout.trim(); fs.writeFileSync(F, JSON.stringify(o));
    const c1 = cliEnv(SID, "--clear"), s1 = cliEnv(SID, "--settle");
    const re = cliEnv(SID, "--arm", "351", "--cond", "甲");
    const restored = st().baseCommit === base1;
    const c2 = cliEnv(SID, "--clear");
    return [c1.status, /reason=obligations-tampered/.test(c1.stderr) && /基点/.test(c1.stderr), s1.status, re.status, restored, c2.status];
  }), [2, true, 2, 0, true, 0]);
  t("298 r1 拒绝点:手改状态文件的 armedAt(想把义务挂到假键上)⇒ 拒(obligations-tampered)", sandbox(({ tmp, cliEnv, st }) => {
    cliEnv(SID, "--arm", "352", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    const F = J(tmp, ".claude", ".batch-goal.json"); const o = st(); o.armedAt = "2020-01-01T00:00:00.000Z"; o.decisions = []; fs.writeFileSync(F, JSON.stringify(o));
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=obligations-tampered/.test(c.stderr) && /armedAt/.test(c.stderr)];
  }), [2, true]);
  // 外部锚覆盖每个写点(codex §2)
  t("298 r1 拒绝点:义务账截尾(保留武装时前缀、删掉后加的决定)⇒ 拒(obligations-tampered)", sandbox(({ tmp, cliEnv, oblDir }) => {
    cliEnv(SID, "--arm", "353", "--cond", "甲");
    const L = J(oblDir, "ledger.jsonl"); const atArm = fs.readFileSync(L, "utf8");
    cliEnv(SID, "--decision", "会被截掉的决定");
    fs.writeFileSync(L, atArm); fs.rmSync(J(oblDir, "state.json"), { force: true });
    const F = J(tmp, ".claude", ".batch-goal.json"); const o = JSON.parse(fs.readFileSync(F, "utf8")); o.decisions = []; fs.writeFileSync(F, JSON.stringify(o));
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=obligations-tampered/.test(c.stderr) && /截短|不在义务账里/.test(c.stderr)];
  }), [2, true]);
  t("298 r1 拒绝点:整本义务账删除后同号重武装 ⇒ --arm 就拒", sandbox(({ cliEnv, oblDir }) => {
    cliEnv(SID, "--arm", "354", "--cond", "甲"); cliEnv(SID, "--decision", "某决定");
    fs.rmSync(oblDir, { recursive: true, force: true });
    const a = cliEnv(SID, "--arm", "354", "--cond", "甲"); return [a.status, /不在义务账里|截短/.test(a.stderr)];
  }), [2, true]);
  // --settle 半写(codex 另项):债表写了、义务账追加失败 ⇒ 如实报;重跑用同一 D 号补记、不多写一行
  t("298 r1 出路:--settle 半写如实报「债表已写 Dn、义务账未记」;重跑沿用同一 D 号补记", sandbox(({ tmp, g, cliEnv, w, commit, oblDir }) => {
    g("rm", "-q", "docs/product-diary.md"); w("docs/product-diary.md/keep.txt", "x");
    w("docs/gate-debts.md", "## 在账欠账\n\n| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |\n|---|---|---|---|---|---|\n"); commit("setup");
    cliEnv(SID, "--arm", "355", "--cond", "甲"); cliEnv(SID, "--outcome", "某成果");
    cliEnv(SID, "--clear"); cliEnv(SID, "--clear"); cliEnv(SID, "--clear");
    const L = J(oblDir, "ledger.jsonl"); fs.chmodSync(L, 0o444);
    const s1 = cliEnv(SID, "--settle");
    fs.chmodSync(L, 0o666);
    const s2 = cliEnv(SID, "--settle");
    const rows = fs.readFileSync(J(tmp, "docs/gate-debts.md"), "utf8").split("\n").filter((l) => /^\| D\d+ \|/.test(l));
    return [s1.status, /债表已写 D1/.test(s1.stderr) && /台账(未追加|只追加了)/.test(s1.stderr) && !/都没写/.test(s1.stderr), s2.status, rows.length, /D1 ≤358/.test(s2.stdout)];
  }), [2, true, 0, 1, true]);
  // 批 298 r2(红队 BP-1 / codex ⑤ / 猎手 FB-1):到期回开着按 checkout 认——原 r1 这条把「同 checkout 换了会话的到期债落成未归属」写成了正确行为,改掉
  t("298 r2 边界:同 checkout 换了会话,转欠账到期 ⇒ 认回并入本批、挡关账", sandbox(({ g, cliEnv, w, commit }) => {
    g("rm", "-q", "docs/product-diary.md"); w("docs/product-diary.md/keep.txt", "x");
    w("docs/gate-debts.md", "## 在账欠账\n\n| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |\n|---|---|---|---|---|---|\n"); commit("setup");
    const O = { CLAUDE_CODE_SESSION_ID: OTHER };
    cliEnv(O, "--arm", "360", "--cond", "甲"); cliEnv(O, "--outcome", "某成果");
    cliEnv(O, "--clear"); cliEnv(O, "--clear"); cliEnv(O, "--clear"); cliEnv(O, "--settle"); commit("settle"); const c0 = cliEnv(O, "--clear");
    const a = cliEnv(SID, "--arm", "364", "--cond", "乙");
    const stat = cliEnv(SID, "--status").stdout;
    const c = cliEnv(SID, "--clear");
    return [c0.status, /回到开着/.test(a.stdout) && /并入本批/.test(a.stdout), /成果 360:O1/.test(stat), c.status, /reason=obligation-unknown/.test(c.stderr)];
  }), [0, true, true, 2, true]);
  // 别的 checkout 的到期债:库层直接造(另起一个 checkout 跑完整个转欠账流程太重)
  t("298 r2 边界:别的 checkout 的转欠账到期 ⇒ 回到开着但未归属、不并入本批", (() => {
    const dir = fs.mkdtempSync(J(os.tmpdir(), "obl298r2-"));
    try {
      const mk = (checkout) => OB.mutateStore(dir, (d) => { const r = OB.createObligation(d, { type: "outcome-diary", checkout, owner: "s-old", origin: { batch: "360" }, batch: { batch: "360", armedAt: "a" } }, "x"); return d.put({ ...r, status: "settled", settle: { debtId: "D9", expiry: 363 } }, { op: "settle", by: "x" }); }).result;
      const mine = mk("c:/here"), theirs = mk("c:/there");
      const out = OB.mutateStore(dir, (d) => armCarry(d, null, { batch: "364", armedAt: "b" }, { sid: "s-new", checkout: "c:/here" })).result;
      const s = OB.readStore(dir).obligations;
      const m = s.find((r) => r.id === mine.id), o = s.find((r) => r.id === theirs.id);
      return [out.reopened.length, out.reopenedOthers.length, m.status, m.batch?.batch, m.owner, o.status, o.batch];
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  })(), [1, 1, "open", "364", "s-new", "open", null]);
  // 没有冻结快照的旧批(本功能之前武装)⇒ 按「现行 ∪ 基点」求值:批内关掉日记也关不掉
  t("298 r1 绕过面(旧批无快照):批内把配置的 diary 去掉并提交 ⇒ 按基点版仍要日记行", sandbox(({ tmp, g, cliEnv, w, commit }) => {
    const base = g("rev-parse", "HEAD").stdout.trim();
    w(".claude/.batch-goal.json", JSON.stringify({ batch: "347", conditions: ["甲"], checks: [], shell: "bash", armedAt: "2026-11-01T00:00:00.000Z", baseCommit: base, decisions: [], outcomes: [{ n: 1, text: "旧成果" }], withdrawn: [], noDecision: { text: "自测" }, version: 3 }));
    ledgerAppend(J(tmp, ".claude", ".batch-goal.jsonl"), { at: "2026-11-01T00:00:00.000Z", action: "arm", batch: "347", conditions: ["甲"], checks: [], shell: "bash", baseCommit: base });
    w("gate-install.json", JSON.stringify({ format: "gate-install/v1", adrDir: "docs/adr" })); commit("drop diary");
    const c = cliEnv(SID, "--clear"); return [c.status, /reason=diary-missing/.test(c.stderr)];
  }), [2, true]);
  // 非 git 目录 --arm --force、旧批名下本来没东西(FB-7)
  {
    const dir = fs.mkdtempSync(J(os.tmpdir(), "bg298ng-"));
    try {
      // GIT_CEILING_DIRECTORIES:不让 git 往上找(本机用户目录本身是 git 仓,临时目录在它下面——不设的话「非 git」夹具会把义务账写进用户目录)
      const run = (...a) => spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), ...a], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, ...SID, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
      const a1 = run("--arm", "370", "--cond", "甲"), a2 = run("--arm", "371", "--cond", "乙", "--force");
      t("298 r1 误拦:非 git 目录 --arm --force、旧批名下没东西可带 ⇒ 不拒(且确实走的是「取不到义务账」那条路)", [a1.status, a2.status, /义务账判不了/.test(a1.stderr + a2.stderr)], [0, 0, true]);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  }
}
// ── 批 305 自测:开批记指令 / 主尺 / worktree 并进主树批日志 / --handoff ──────────────────────────
//   转录一律用造的夹具(沙盒里的假用户目录,经 USERPROFILE / HOME 指过去),不读本机真实转录。
//   每条完成标准正例加反例;拒绝 / 量不出的路都主动造一次看输出,不以「没报错」为准。
/** 夹具:一个临时目录,里面一个 git 仓(repo)和一个假用户目录(home)。fn 收到工具箱,返回值即用例实得。 */
function box305(fn) {
  const J = path.join;
  const tmp = fs.mkdtempSync(J(os.tmpdir(), "bg305-"));
  const repo = J(tmp, "repo"), home = J(tmp, "home");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CEILING_DIRECTORIES: tmp, USERPROFILE: home, HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const g = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env, windowsHide: true });
  const cliAt = (cwd, extra, ...a) => spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), ...a], { cwd, encoding: "utf8", env: { ...env, ...extra }, windowsHide: true, timeout: 120_000 });
  const w = (root, rel, s) => { fs.mkdirSync(path.dirname(J(root, rel)), { recursive: true }); fs.writeFileSync(J(root, rel), s); };
  const commit = (cwd, m) => { g(cwd, "add", "-A"); return g(cwd, "commit", "-q", "-m", m); };
  const st = (root = repo) => JSON.parse(fs.readFileSync(J(root, ".claude", ".batch-goal.json"), "utf8"));
  const rowsOf = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
  const jrows = (root = repo) => rowsOf(J(root, ".claude", ".batch-goal.jsonl"));
  try {
    fs.mkdirSync(repo); fs.mkdirSync(home);
    g(repo, "init", "-q"); g(repo, "config", "core.autocrlf", "false"); w(repo, ".gitignore", ".claude/\nclipboard/\n"); w(repo, "a.txt", "a\n"); commit(repo, "init");
    // 转录目录名按子进程会算出的主 checkout 路径换算(git 给的绝对路径;临时目录可能带短文件名,不能拿 tmp 直接算)
    const mainAbs = path.dirname(String(g(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout || "").trim());
    const projDir = (root = mainAbs) => J(home, ".claude", "projects", projectDirName(root));
    const transcript = (sid, entries, root = mainAbs) => { const f = J(projDir(root), `${sid}.jsonl`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); return f; };
    return fn({ tmp, repo, home, env, g, cliAt, cli: (extra, ...a) => cliAt(repo, extra, ...a), w, commit, st, jrows, rowsOf, mainAbs, projDir, transcript });
  } catch (e) { return { err: String(e && e.stack || e) }; }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不判 */ } }
}
/** 转录条目夹具(形状照本机转录的结构统计造;正文全是造的)。min = 相对基准时刻的分钟数。 */
function fx305(baseMs = Date.now() - 6 * 3600_000) {
  let n = 0;
  const uid = () => `u305-${String(++n).padStart(4, "0")}`;
  const iso = (min) => new Date(baseMs + min * 60_000).toISOString();
  const U = (content, min, x = {}) => ({ type: "user", uuid: uid(), timestamp: iso(min), message: { role: "user", content }, ...x });
  return {
    iso, uid, U,
    H: (text, min, x = {}) => U(text, min, { origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human", ...x }),
    A: (blocks, min) => ({ type: "assistant", uuid: uid(), timestamp: iso(min), message: { role: "assistant", content: blocks } }),
    AT: (attachment, min, x = {}) => ({ type: "attachment", uuid: uid(), timestamp: iso(min), attachment, ...x }),
    TR: (id, text, min, x = {}) => U([{ type: "tool_result", tool_use_id: id, content: text }], min, { toolUseResult: { stdout: text }, ...x }),
  };
}
/// ── 批 309 自测:规则 P 的拒绝挪进关账(review-missing / review-unknown;判定本体的零件用例在 hook-stop-closure 自测)──
//   沙盒仓里真跑 --arm / 提交 / --dry-check / --clear;转录是造的(假用户目录)。每条拒绝都主动造一次,看拒因行、退出码与出路走不走得通。
export function selfTest309(t) {
  const SID = "selftest-sess-0309-aaaa", SIDE = { CLAUDE_CODE_SESSION_ID: SID };
  // 纯函数:误报记账放行只认本批武装之后、没撤回的 P 那一笔
  {
    const g = { armedAt: "2026-11-20T08:00:00.000Z" };
    const row = (o) => ({ kind: "claimed_fp", id: "P", h: "h-after-0001", ts: "2026-11-20T08:30:00.000Z", why: "复核在别的会话", ...o });
    t("309 出路:本批武装之后记的 P 误报 ⇒ 放行(取那一笔)", reviewWaiver(g, [row()])?.h, "h-after-0001");
    t("309 出路反例:武装之前记的 / 别的规则 / 已撤回 ⇒ 不放行", [
      reviewWaiver(g, [row({ ts: "2026-11-20T07:59:00.000Z" })]),
      reviewWaiver(g, [row({ id: "K" })]),
      reviewWaiver(g, [row(), { kind: "retraction", id: "P", ref: "h-after-0001" }]),
      reviewWaiver({}, [row()])], [null, null, null, null]);
    const out = (s) => () => ({ status: 0, stdout: s });
    t("309 零成本路径:范围里的文件都不是闸引擎面超集 / 承重面 ⇒ false;有 scripts/ 下的 ⇒ true;有规矩文件 ⇒ true;git 没跑成 ⇒ null",
      [reviewRangeTouched("1234567", out("src/a.ts\n\nREADME.txt\n")), reviewRangeTouched("1234567", out("src/a.ts\nscripts/lib/gate-rules.mjs\n")),
        reviewRangeTouched("1234567", out("AGENTS.md\n")), reviewRangeTouched("1234567", out("docs/laws/collab.md\n")),
        reviewRangeTouched("1234567", () => ({ status: 128, stdout: "" })), reviewRangeTouched("1234567", () => { throw new Error("x"); })], [false, true, true, true, null, null]);
    t("309 零成本路径只跑一次 git(改名的新旧两头都列,不按 TREESAME 剪枝)",
      (() => { let got = null; reviewRangeTouched("1234567", (a) => { got = a; return { status: 0, stdout: "" }; }); return got; })(),
      ["log", "--no-renames", "--name-only", "--format=", "1234567..HEAD"]);
    t("309 承重面判法与 P 同一份(isCarrierPath(CARRIER_SURFACE));clipboard / node_modules 下的同名件不算",
      [reviewRelevantPath(".claude/agents/_x.md"), reviewRelevantPath("clipboard/x/AGENTS.md"), reviewRelevantPath("src/x.ts")], [true, false, false]);
  }
  const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook-stop-closure.mjs");
  const ENGINE = "scripts/lib/gate-rules.mjs";
  const agentAt = (f, min, type, prompt) => f.A([{ type: "tool_use", id: `toolu_${type}_${min}`, name: "Agent", input: { subagent_type: type, prompt } }], min);
  const toolAt = (f, min, name, input) => f.A([{ type: "tool_use", id: `toolu_${name}_${min}`, name, input }], min);
  t("309 零成本:只改业务文件 ⇒ 过,结清行 review.status=none(没载入收尾闸、没读转录)", box305(({ repo, cli, w, commit, jrows }) => {
    const a = cli(SIDE, "--arm", "309", "--cond", "甲");
    w(repo, "src/app.txt", "x\n"); commit(repo, "biz");
    const d = cli(SIDE, "--dry-check"), c = cli(SIDE, "--clear", "--verdict", "1=达成");
    return [a.status, d.status, c.status, jrows().at(-1)?.review?.status];
  }), [0, 0, 0, "none"]);
  t("309 关账侧:改了闸引擎文件、本会话转录找不到 ⇒ --clear 拒 review-unknown(写明读转录这一步),拒清痕迹在;--dry-check 报判不了、不带「条未过」", box305(({ repo, cli, w, commit, st }) => {
    cli(SIDE, "--arm", "309", "--cond", "甲");
    w(repo, ENGINE, "// 改闸\n"); commit(repo, "gate");
    const d = cli(SIDE, "--dry-check"), c = cli(SIDE, "--clear", "--verdict", "1=达成");
    return [d.status, /reason=review-unknown/.test(d.stderr), /条未过/.test(d.stderr), c.status, /BATCH-GOAL-CLEAR-REFUSED batch=309 reason=review-unknown/.test(c.stderr),
      /读转录/.test(c.stderr), /改了闸引擎文件的提交.*gate-rules\.mjs/.test(c.stderr), st().clearRefusedReason, st().cleared === true];
  }), [2, true, false, 2, true, true, true, "review-unknown", false]);
  t("309 关账侧:改了闸引擎、转录里只有红队 ⇒ --dry-check 报 1 条未过(发车脚本当验收不过)、--clear 拒 review-missing 并点名缺误拦猎手与怎么补;两猎手补齐 ⇒ 都过", box305(({ repo, cli, w, commit, st, jrows, transcript }) => {
    cli(SIDE, "--arm", "309", "--cond", "甲");
    const base = st().baseCommit;
    w(repo, ENGINE, "// 改闸\n"); commit(repo, "gate");
    const f = fx305(Date.now());
    transcript(SID, [f.H("改闸", 1), agentAt(f, 2, "_gate-bypass-hunter", `红队本批 ${ENGINE} 的改动`)]);
    const d1 = cli(SIDE, "--dry-check"), c1 = cli(SIDE, "--clear", "--verdict", "1=达成");
    const r1 = [d1.status, /条未过/.test(d1.stderr), /reason=review-missing/.test(d1.stderr), c1.status, /reason=review-missing/.test(c1.stderr),
      /缺 _gate-false-block-hunter/.test(c1.stderr), c1.stderr.includes(`--base ${base.slice(0, 12)}`), /补完重跑 --clear/.test(c1.stderr), /--fp P/.test(c1.stderr)];
    transcript(SID, [f.H("改闸", 1), agentAt(f, 2, "_gate-bypass-hunter", `红队本批 ${ENGINE} 的改动`), agentAt(f, 3, "_gate-false-block-hunter", `回放本批 ${ENGINE} 的改动 --base ${base}`)]);
    const d2 = cli(SIDE, "--dry-check"), c2 = cli(SIDE, "--clear", "--verdict", "1=达成");
    return [...r1, d2.status, c2.status, jrows().at(-1)?.review];
  }), [2, true, true, 2, true, true, true, true, true, 0, 0, { status: "ok", engineCommits: 1, carrierCommits: 0 }]);
  // 规矩文件类承重提交(不改闸):把三通道的重新武装阈值调成 1(STOP_CLOSURE_P_REARM,P 现成的旋钮)⇒ 这一笔就要三通道各一遍;
  //   跨模型格认 codex-run 的作业记录 ⇒ 系统临时目录指到沙盒里,合格记录手写一份(不碰本机真作业目录)
  t("309 关账侧:只改规矩文件、三通道都没跑 ⇒ --dry-check 报 1 条未过、--clear 拒 review-missing(写明规矩文件类、列三格);三格补齐 ⇒ 都过", box305(({ tmp, repo, g, cli, w, commit, st, jrows, transcript }) => {
    const TMPD = path.join(tmp, "t"); fs.mkdirSync(path.join(TMPD, "codex-run-jobs"), { recursive: true });
    const E = { ...SIDE, STOP_CLOSURE_P_REARM: "1", TEMP: TMPD, TMP: TMPD };
    cli(E, "--arm", "309", "--cond", "甲");
    cli(E, "--no-decision", "自测:只改一句规矩,没有决定");
    const f = fx305(Date.now());
    w(repo, "docs/tool-register.md", "# 工具登记\n改一句。\n"); commit(repo, "law");
    const commitAct = toolAt(f, 0.5, "Bash", { command: "git add -A && git commit -m law" });
    transcript(SID, [f.H("改规矩", 0.2), commitAct]);
    const d1 = cli(E, "--dry-check"), c1 = cli(E, "--clear", "--verdict", "1=达成");
    const r1 = [d1.status, /条未过/.test(d1.stderr), c1.status, /reason=review-missing/.test(c1.stderr), /规矩文件类承重/.test(c1.stderr),
      /欠 跨模型/.test(c1.stderr), /欠 独立视角/.test(c1.stderr), /欠 外部先例/.test(c1.stderr), /改闸引擎文件的提交/.test(c1.stderr)];
    const top = String(g(repo, "rev-parse", "--show-toplevel").stdout || "").trim();
    const t0 = Date.now();
    fs.writeFileSync(path.join(TMPD, "codex-run-jobs", "J309.json"), JSON.stringify({ state: "done", exitCode: 0, threadId: "t-309", cwd: top,
      startedAt: new Date(t0 - 1000).toISOString(), endedAt: t0 - 500, resultAt: t0 - 600 }));
    transcript(SID, [f.H("改规矩", 0.2), commitAct, agentAt(f, 1, "grill:testing", "审本批 docs/tool-register.md 的改动"), toolAt(f, 1.5, "WebSearch", { query: "同类规矩" })]);
    const d2 = cli(E, "--dry-check"), c2 = cli(E, "--clear", "--verdict", "1=达成");
    return [...r1, d2.status, c2.status, jrows().at(-1)?.review];
  }), [2, true, 2, true, true, true, true, true, false, 0, 0, { status: "ok", engineCommits: 0, carrierCommits: 1 }]);
  t("309 关账侧:只改规矩文件、在宽限内(缺省阈值)⇒ 不读转录直接过(转录根本不存在也过)", box305(({ repo, cli, w, commit, jrows }) => {
    cli(SIDE, "--arm", "309", "--cond", "甲");
    cli(SIDE, "--no-decision", "自测:只改一句规矩,没有决定");
    w(repo, "docs/tool-register.md", "# 工具登记\n改一句。\n"); commit(repo, "law");
    const c = cli(SIDE, "--clear", "--verdict", "1=达成");
    return [c.status, jrows().at(-1)?.review];
  }), [0, { status: "ok", engineCommits: 0, carrierCommits: 1 }]);
  t("309 关账侧:猎手跑在别的会话(开批的会话),关账在另一个会话 ⇒ 两份转录都读,过", box305(({ repo, cli, w, commit, jrows, transcript, st }) => {
    cli(SIDE, "--arm", "309", "--cond", "甲");
    const base = st().baseCommit;
    w(repo, ENGINE, "// 改闸\n"); commit(repo, "gate");
    const f = fx305(Date.now());
    transcript(SID, [f.H("改闸", 1), agentAt(f, 2, "_gate-bypass-hunter", `红队本批 ${ENGINE} 的改动`), agentAt(f, 3, "_gate-false-block-hunter", `回放本批 ${ENGINE} --base ${base}`)]);
    const SB = "selftest-sess-0309-bbbb";
    transcript(SB, [f.H("接着关账", 10)]);
    const c = cli({ CLAUDE_CODE_SESSION_ID: SB }, "--clear", "--verdict", "1=达成");
    return [c.status, jrows().at(-1)?.review?.status];
  }), [0, "ok"]);
  t("309 出路走得通:欠审被拒后照提示记一笔 P 误报 ⇒ 重跑 --clear 放行,结清行记下那一笔的 h", box305(({ repo, cli, w, commit, jrows, env }) => {
    cli(SIDE, "--arm", "309", "--cond", "甲");
    w(repo, ENGINE, "// 改闸\n"); commit(repo, "gate");
    const c1 = cli(SIDE, "--clear", "--verdict", "1=达成");
    const fp = spawnSync(process.execPath, ["--no-warnings", hookScript, "--fp", "P", "复核在没登记的会话里跑过"], { cwd: repo, encoding: "utf8", env: { ...env, ...SIDE }, windowsHide: true, timeout: 60_000 });
    const c2 = cli(SIDE, "--clear", "--verdict", "1=达成");
    const er = jrows().at(-1)?.review;
    return [c1.status, fp.status, c2.status, /按本批记的 P 误报放行/.test(c2.stderr), er?.status, typeof er?.waivedBy === "string" && er.waivedBy.length > 6];
  }), [2, 0, 0, true, "unknown", true]);
}
export function selfTest305(t) {
  const SID = "selftest-sess-0305-aaaa", SIDE = { CLAUDE_CODE_SESSION_ID: SID };
  // ── ① 开批记指令 / 终点线 / 上限 ──
  t("305 ① parseArm:带开批记录旗标时返回形状不变(只有 conds / checks)", parseArm(["--arm", "500", "--cond", "甲", "--instruction", "做这个", "--finish-line", "自测过就停", "--cap-usd", "5", "--deadline", "2030-01-01T00:00:00Z"]), { conds: ["甲"], checks: [] });
  t("305 ① parseArmMeta:一个都没给 ⇒ 空对象", parseArmMeta(["--arm", "500", "--cond", "甲"]), {});
  t("305 ① parseArmMeta:全给 ⇒ 逐项解析(上限转数字、截止转 ISO)", parseArmMeta(["--arm", "500", "--cond", "甲", "--instruction", "做这个", "--instruction-session", "sess-12345678", "--instruction-at", "2030-01-01T08:00:00+08:00", "--finish-line", "自测过就停", "--cap-usd", "12.5", "--deadline", "2030-01-02T03:04:05Z"]),
    { instruction: { text: "做这个", sid: "sess-12345678", at: "2030-01-01T00:00:00.000Z" }, finishLine: "自测过就停", caps: { usd: 12.5, deadline: "2030-01-02T03:04:05.000Z" } });
  {
    const bad = (a) => { try { parseArmMeta(a); return "no-throw"; } catch { return "throw"; } };
    t("305 ① 反例 parseArmMeta:上限不是正数 / 截止不是时刻 / 位置旗标没配指令 / 给两次 / 缺值 ⇒ 全抛",
      [bad(["--cap-usd", "abc"]), bad(["--cap-usd", "0"]), bad(["--deadline", "下周"]), bad(["--instruction-at", "2030-01-01T00:00:00Z"]), bad(["--instruction-session", "sess-12345678"]),
        bad(["--instruction", "a", "--instruction", "b"]), bad(["--instruction"]), bad(["--instruction", "a", "--instruction-session", "短"]), bad(["--instruction", "a", "--instruction-at", "不是时刻"])],
      Array(9).fill("throw"));
  }
  const INS = "把开批脚本加上记指令这一项";
  t("305 ① 正例:--arm 带指令 / 终点线 / 上限 ⇒ 批状态与 arm 行都记下;指令按原话定位到会话号与时间戳;--status 全打出来", box305(({ cli, st, jrows, transcript }) => {
    const f = fx305();
    transcript(SID, [f.H("先看一下现状", 0), f.A([{ type: "text", text: "看了" }], 1), f.H(INS, 10), f.A([{ type: "text", text: "开工" }], 11)]);
    const r = cli(SIDE, "--arm", "500", "--cond", "甲", "--instruction", INS, "--finish-line", "自测全过就停", "--cap-usd", "12.5", "--deadline", "2030-01-02T03:04:05Z");
    const s = st(), row = jrows().filter((x) => x.action === "arm").pop() || {};
    const out = cli(SIDE, "--status").stdout;
    return [r.status, s.instruction?.text, s.instruction?.sid, s.instruction?.at === f.iso(10), s.instruction?.located, s.instruction?.match, s.finishLine, s.caps,
      row.instruction?.at === f.iso(10), row.finishLine, row.caps,
      /指令:「把开批脚本加上记指令这一项」/.test(out), out.includes(`指令位置:会话 ${SID} · ${f.iso(10)}`), /终点线:自测全过就停/.test(out), out.includes("花费 ≤ 12.5 美元;总截止 2030-01-02T03:04:05.000Z")];
  }), [0, INS, SID, true, "transcript", "exact", "自测全过就停", { usd: 12.5, deadline: "2030-01-02T03:04:05.000Z" }, true, "自测全过就停", { usd: 12.5, deadline: "2030-01-02T03:04:05.000Z" }, true, true, true, true]);
  t("305 ① 反例:原话是转述的(转录里没有这句)⇒ 照常武装(退出 0)、位置留空、--status 写「未定位」并给原因", box305(({ cli, st, transcript }) => {
    const f = fx305();
    transcript(SID, [f.H("先看一下现状", 0), f.H("帮我把记指令那个功能做了", 10)]);
    const r = cli(SIDE, "--arm", "500", "--cond", "甲", "--instruction", INS);
    const s = st(), out = cli(SIDE, "--status").stdout;
    return [r.status, s.instruction?.text, s.instruction?.at, s.instruction?.located, /对不上这句原话/.test(s.instruction?.why || ""), out.includes("指令位置:未定位")];
  }), [0, INS, null, null, true, true]);
  t("305 ① 反例:那句话只出现在钩子反馈 / 工具结果 / 压缩摘要 / 后台通知里(都不是人说的)⇒ 不认,未定位", box305(({ cli, st, transcript }) => {
    const f = fx305();
    transcript(SID, [f.H("先看一下现状", 0), f.U(`Stop hook feedback:\n${INS}`, 2, { isMeta: true }), f.TR("toolu_1", INS, 3), f.U(INS, 4, { isCompactSummary: true }),
      f.U(INS, 5, { origin: { kind: "task-notification" } }), f.U(INS, 6, { origin: { kind: "peer" }, isMeta: true }), f.AT({ type: "hook_additional_context", content: [INS] }, 7)]);
    const r = cli(SIDE, "--arm", "500", "--cond", "甲", "--instruction", INS);
    return [r.status, st().instruction?.at, st().instruction?.located];
  }), [0, null, null]);
  t("305 ① 反例:环境里没有会话号 ⇒ 未定位(写明取不到会话号);转录文件不在 ⇒ 未定位(写明找不到)", box305(({ cli, st }) => {
    const a = cli({}, "--arm", "500", "--cond", "甲", "--instruction", INS); const w1 = st().instruction?.why || "";
    const b = cli(SIDE, "--arm", "500", "--cond", "甲", "--instruction", INS, "--force"); const w2 = st().instruction?.why || "";
    return [a.status, /取不到会话号/.test(w1), b.status, /转录目录不在|找不到会话/.test(w2), st().instruction?.sid];
  }), [0, true, 0, true, SID]);
  t("305 ① 老用法:不带新旗标 ⇒ 批状态与 arm 行里没有新键,--arm / --status 输出里不多出指令 / 终点线 / 上限行", box305(({ cli, st, jrows }) => {
    const r = cli(SIDE, "--arm", "501", "--cond", "甲");
    const s = st(), row = jrows().filter((x) => x.action === "arm").pop() || {};
    const out = r.stdout + cli(SIDE, "--status").stdout;
    const has = (o) => ["instruction", "finishLine", "caps"].filter((k) => k in o);
    return [r.status, has(s), has(row), /指令|终点线|上限/.test(out), Object.keys(s).sort().join(",")];
  }), [0, [], [], false, "armedAt,armedBy,baseCommit,batch,checks,conditions,decisions,outcomes,shell,version,withdrawn"]);
  t("305 ① 用法错(新旗标的值不合法)⇒ 退出 2、批状态不落盘", box305(({ cli, repo }) => {
    const a = cli(SIDE, "--arm", "502", "--cond", "甲", "--cap-usd", "很多"), b = cli(SIDE, "--arm", "502", "--cond", "甲", "--instruction-at", "2030-01-01T00:00:00Z");
    return [a.status, /用法错误:--cap-usd/.test(a.stderr), b.status, fs.existsSync(path.join(repo, ".claude", ".batch-goal.json"))];
  }), [2, true, 2, false]);
  t("305 ① 同号重放:不带旗标 ⇒ 记录原样保留;只带新终点线 ⇒ 只换终点线(不要 --force)", box305(({ cli, st, transcript }) => {
    const f = fx305();
    transcript(SID, [f.H(INS, 10)]);
    cli(SIDE, "--arm", "503", "--cond", "甲", "--instruction", INS, "--finish-line", "甲线", "--cap-usd", "3");
    const r1 = cli(SIDE, "--arm", "503", "--cond", "甲"); const s1 = st();
    const r2 = cli(SIDE, "--arm", "503", "--cond", "甲", "--finish-line", "乙线", "--deadline", "2030-01-02T00:00:00Z"); const s2 = st();
    return [r1.status, s1.instruction?.at === f.iso(10), s1.finishLine, s1.caps, r2.status, s2.instruction?.at === f.iso(10), s2.finishLine, s2.caps];
  }), [0, true, "甲线", { usd: 3 }, 0, true, "乙线", { usd: 3, deadline: "2030-01-02T00:00:00.000Z" }]);
  t("305 ① 显式给位置(--instruction-session / --instruction-at)⇒ 照记、标「显式给定」,不读转录", box305(({ cli, st }) => {
    const r = cli({}, "--arm", "504", "--cond", "甲", "--instruction", INS, "--instruction-session", "sess-explicit-0001", "--instruction-at", "2030-01-01T08:00:00+08:00");
    const s = st(), out = cli({}, "--status").stdout;
    return [r.status, s.instruction?.sid, s.instruction?.at, s.instruction?.located, /显式给定/.test(out)];
  }), [0, "sess-explicit-0001", "2030-01-01T00:00:00.000Z", "explicit", true]);
  {
    const f = fx305();
    const es = [f.H("做这个", 0), f.H(`嗯,${INS},另外顺手看下文档`, 5), f.H("继续", 6), f.H("好的继续往下做吧", 7), f.H(INS, 20), f.AT({ type: "queued_command", origin: { kind: "human" }, commandMode: "prompt", prompt: "排队里说的那句要紧的话" }, 25), f.H(INS, 9000)];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bg305l-"));
    try {
      const file = path.join(tmp, "s.jsonl"); fs.writeFileSync(file, es.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const L = (text, untilMin) => { const r = RULER.locateInstruction(file, text, { untilMs: Date.parse(f.iso(untilMin)) }); return r.at ? [r.at === f.iso(5) ? 5 : r.at === f.iso(20) ? 20 : r.at === f.iso(25) ? 25 : r.at === f.iso(0) ? 0 : r.at === f.iso(6) ? 6 : "?", r.match] : null; };
      t("305 ① 定位:同一句说过两次 ⇒ 取开批前最后一次;晚于开批时刻的不取", [L(INS, 30), L(INS, 15)], [[20, "exact"], [5, "contains"]]);
      t("305 ① 定位:短原话(不足 6 字)只认整条相等,不做包含匹配;排队插的话也能定位", [L("继续", 30), L("做这个", 30), L("往下做", 30), L("排队里说的那句要紧的话", 30)], [[6, "exact"], [0, "exact"], null, [25, "exact"]]);
      t("305 ① 反例 定位:文件不存在 ⇒ 给原因,不抛", /转录读不了/.test(RULER.locateInstruction(path.join(tmp, "none.jsonl"), INS).why || ""), true);
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不判 */ } }
  }
  // ── ② 主尺:指令到关账,人亲口说了几条 ──
  //   夹具:每一种「不是人说的」各一条、每一种「算」的各一条。notHuman / human 两张表同时是数法的说明书。
  const fxAll = (f, at0 = 10) => {
    const notHuman = [
      ["工具结果", "tool-result", f.TR("toolu_a", "命令输出里的一句话", at0 + 1)],
      ["子代理回件(Agent 工具的结果)", "tool-result", f.TR("toolu_agent", "子代理说:都做完了", at0 + 1, { toolUseResult: { agentId: "a1", status: "completed" } })],
      ["钩子反馈(Stop hook feedback,isMeta)", "hook", f.U("Stop hook feedback:\n[闸] 条件没对照", at0 + 2, { isMeta: true })],
      ["钩子反馈(插件来源)", "hook", f.U([{ type: "text", text: "Stop hook feedback:\n插件说的话" }], at0 + 2, { isMeta: true, origin: { kind: "plugin" } })],
      ["钩子反馈(老形态:无来源、非 isMeta)", "hook", f.U("Stop hook feedback:\n老形态", at0 + 2)],
      ["钩子注入的附件(开工注入)", "hook", f.AT({ type: "hook_additional_context", content: ["BATCH-CONTEXT 批 500 已武装"] }, at0 + 2)],
      ["钩子注入的附件(阻断)", "hook", f.AT({ type: "hook_blocking_error", toolUseID: "x", blockingError: { blockingError: "拦了" } }, at0 + 2)],
      ["系统提醒(isMeta)", "system-reminder", f.U("<system-reminder>\n今天的日期是某天\n</system-reminder>", at0 + 3, { isMeta: true })],
      ["系统提醒(无来源、非 isMeta 的整条提醒)", "system-reminder", f.U("<system-reminder>记得更新任务清单</system-reminder>", at0 + 3)],
      ["后台任务通知(user 行)", "task-notification", f.U("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>", at0 + 4, { origin: { kind: "task-notification" } })],
      ["后台任务通知(排队附件)", "task-notification", f.AT({ type: "queued_command", origin: { kind: "task-notification" }, commandMode: "task-notification", prompt: "<task-notification>\n<task-id>b2</task-id>\n</task-notification>" }, at0 + 4)],
      ["后台任务通知(排队附件,老形态无来源)", "task-notification", f.AT({ type: "queued_command", commandMode: "task-notification", prompt: "<task-notification>\n<task-id>b3</task-id>\n</task-notification>" }, at0 + 4)],
      ["子代理回件(排队附件,来源 peer)", "peer", f.AT({ type: "queued_command", origin: { kind: "peer" }, commandMode: "prompt", prompt: "<agent-message from=\"worker\">做完了</agent-message>" }, at0 + 5)],
      ["跨会话消息(来源 peer)", "peer", f.U("Another Claude session sent a message: 你好", at0 + 5, { isMeta: true, origin: { kind: "peer" } })],
      ["子代理侧链里的人形消息(isSidechain)", "subagent", f.H("给子代理的任务书", at0 + 5, { isSidechain: true })],
      ["压缩后的摘要", "compact-summary", f.U("This session is being continued from a previous conversation. 用户先前说过要改三处", at0 + 6, { isCompactSummary: true })],
      ["技能 / 命令正文(isMeta)", "meta", f.U([{ type: "text", text: "Base directory for this skill: /repo/.claude/skills/x\n请照下面做" }], at0 + 6, { isMeta: true })],
      ["本地命令的说明行(isMeta)", "meta", f.U("<local-command-caveat>Caveat: 下面是本地命令产生的</local-command-caveat>", at0 + 6, { isMeta: true })],
      ["本地命令输出", "command-output", f.U("<local-command-stdout>已切换模型</local-command-stdout>", at0 + 7)],
      ["「!」命令的输出", "command-output", f.U("<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>", at0 + 7)],
      ["自动续跑", "auto-continuation", f.U("继续上一轮没做完的事", at0 + 7, { isMeta: true, origin: { kind: "auto-continuation" } })],
      ["来源不认识(单列,不计入)", "unknown-origin", f.U("某种新来源的消息", at0 + 7, { origin: { kind: "channel-x" } })],
      ["其它附件(日期、工具清单等)", "attachment-other", f.AT({ type: "date", date: "某天" }, at0 + 7)],
    ];
    const human = [
      ["打字的消息", "typed", f.H("这里改一下", at0 + 8)],
      ["带图的消息(文字 + 图片块)", "typed", f.H([{ type: "text", text: "看这张图" }, { type: "image", source: { type: "base64", data: "AAAA" } }], at0 + 8)],
      ["排队插话(附件)", "queued", f.AT({ type: "queued_command", origin: { kind: "human" }, commandMode: "prompt", prompt: "顺便把文档也改了" }, at0 + 9)],
      ["排队插话(落成 user 行的)", "queued", f.H("到哪一步了", at0 + 9, { promptSource: "queued" })],
      ["斜杠命令(带来源)", "slash", f.H("<command-message>status</command-message>\n<command-name>/status</command-name>", at0 + 10)],
      ["斜杠命令(本地命令,无来源)", "slash", f.U("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>", at0 + 10)],
      ["「!」命令的输入", "bang", f.U("<bash-input>git status</bash-input>", at0 + 11)],
      ["中断标记", "interrupt", f.U([{ type: "text", text: "[Request interrupted by user]" }], at0 + 12)],
      ["无头会话的提示词", "sdk", f.H("执行方案 500", at0 + 13, { promptSource: "sdk", turnOrigin: "sdk" })],
      ["无来源标记的老形态", "legacy", f.U("老转录里的一句话", at0 + 14)],
    ];
    return { notHuman, human };
  };
  {
    const f = fx305(), all = fxAll(f);
    const k = (e) => { const c = RULER.classifyEntry(e); return c ? [c.human, c.kind] : null; };
    t("305 ② 认人:每一种不是人说的消息都不算(工具结果 / 钩子 / 系统提醒 / 后台通知 / 子代理 / 压缩摘要 / 技能正文 / 命令输出 / 自动续跑 / 来源不认识 / 其它附件)",
      all.notHuman.filter(([, kind, e]) => JSON.stringify(k(e)) !== JSON.stringify([false, kind])).map(([name, , e]) => `${name}⇒${JSON.stringify(k(e))}`), []);
    t("305 ② 认人:每一种人说的都算,且分到对的类型(打字 / 排队 / 斜杠命令 / 「!」命令 / 中断 / 无头提示词 / 老形态)",
      all.human.filter(([, kind, e]) => JSON.stringify(k(e)) !== JSON.stringify([true, kind])).map(([name, , e]) => `${name}⇒${JSON.stringify(k(e))}`), []);
    t("305 ② 认人:助理消息与 system 行不参与(返回 null)", [RULER.classifyEntry(f.A([{ type: "text", text: "x" }], 1)), RULER.classifyEntry({ type: "system", subtype: "stop_hook_summary" }), RULER.classifyEntry(null)], [null, null, null]);
    // 与 gate-ctx.buildCtx 对账:同一条条目,buildCtx 收没收到用户的字 == 这里算不算人说的。差异只许是头注写明的两处。
    const ctxHuman = (e) => String(buildCtx([e]).userText || "").trim() !== "";
    const diff = [...all.notHuman, ...all.human].filter(([, , e]) => ctxHuman(e) !== !!RULER.classifyEntry(e)?.human).map(([name]) => name);
    t("305 ② 与 gate-ctx.buildCtx 的认人口径逐条对账:差异只有头注写明的「侧链条目」一处(buildCtx 不看 isSidechain)", diff, ["子代理侧链里的人形消息(isSidechain)"]);
    t("305 ② 与 gate-ctx 对账(第二处差异):只有图片没有文字的人的消息,buildCtx 收不到字,这里算一条",
      (() => { const e = f.H([{ type: "image", source: { type: "base64", data: "AAAA" } }], 1); return [ctxHuman(e), RULER.classifyEntry(e)]; })(), [false, { human: true, kind: "typed" }]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bg305r-"));
    try {
      const wr = (name, es) => { const p = path.join(tmp, `${name}.jsonl`); fs.writeFileSync(p, es.map((e) => JSON.stringify(e)).join("\n") + "\n"); return p; };
      const SA = "selftest-sess-0305-aaaa", SB = "selftest-sess-0305-bbbb", SC = "selftest-sess-0305-cccc";
      const ins = f.H(INS, 10);
      const before = [f.H("指令之前说的话", 0), f.H("指令之前又说了一句", 5)];
      wr(SA, [...before, ins, f.A([{ type: "text", text: "开工" }], 10), ...all.notHuman.map((x) => x[2]), ...all.human.map((x) => x[2]),
        { type: "api-request-blob", blob: "x".repeat(2000) + "\"role\":\"user\"" }, "这一行不是 JSON"].map((e) => e));
      const I = { text: INS, sid: SA, at: f.iso(10) };
      const now = Date.parse(f.iso(600));
      const r1 = RULER.measureRuler({ instruction: I, sids: [SA], dirs: [tmp], nowMs: now });
      t("305 ② 主尺正例:指令 1 条 + 之后 10 条人说的 = 11;指令之前的 2 条不算;23 条不是人说的一条没混进来",
        [r1.ok, r1.count, r1.byKind, Object.values(r1.excluded).reduce((a, b) => a + b, 0), r1.unknownOrigins, r1.since === f.iso(10)],
        [true, 11, { typed: 3, queued: 2, slash: 2, bang: 1, interrupt: 1, sdk: 1, legacy: 1 }, 23, { "channel-x": 1 }, true]);
      t("305 ② 主尺的一行:写明条数、分项、含指令、读了几份、口径是上界", (() => { const l = RULER.formatRuler(r1); return [/^主尺:人亲口说了 11 条/.test(l), /打字 3/.test(l) && /排队插话 2/.test(l) && /斜杠命令 2/.test(l) && /中断标记 1/.test(l), /含引出本批的那句指令/.test(l), /读了 1 份转录/.test(l), /上界/.test(l) && /不区分纠正 \/ 拍板 \/ 问进度/.test(l) && /只数读得到的转录/.test(l)]; })(), [true, true, true, true, true]);
      t("305 ② 明细:没算进去的各类各几条、来源不认识的单列出声", (() => { const d = RULER.formatRulerDetail(r1).join("\n"); return [/工具结果 2/.test(d), /钩子注入 5/.test(d), /后台任务通知 3/.test(d), /压缩摘要 1/.test(d), /来源不认识、没计入:channel-x×1/.test(d)]; })(), [true, true, true, true, true]);
      t("305 ② 窗口:截止时刻之后的人话不算(关账以后说的不进本批)", RULER.measureRuler({ instruction: I, sids: [SA], dirs: [tmp], nowMs: Date.parse(f.iso(18)) }).count, 3);
      // 跨会话:续跑的会话 B 里又说了 2 条;其中一条的 uuid 与 A 里的同一条重复(续接带上的旧行)⇒ 不重复数
      const dupA = all.human[0][2];
      wr(SB, [dupA, f.H("续跑会话里说的第一句", 300), f.TR("toolu_b", "结果", 301), f.H("续跑会话里说的第二句", 302)]);
      const r2 = RULER.measureRuler({ instruction: I, sids: [SA, SB, SC], dirs: [tmp], nowMs: now });
      t("305 ② 跨会话:读得到的两份合计(同一条在两份里只数一次),读不到的那份点名、不当成零也不让整体作废",
        [r2.ok, r2.count, r2.sessions.map((s) => [s.sid === SA ? "A" : s.sid === SB ? "B" : "C", s.read, s.count ?? null]), /读了 2 份转录、另 1 份读不到/.test(RULER.formatRuler(r2))],
        [true, 13, [["A", true, 11], ["B", true, 2], ["C", false, null]], true]);
      // 排队附件与它落成的 user 行指向同一条 ⇒ 只数一次
      const qa = f.AT({ type: "queued_command", origin: { kind: "human" }, commandMode: "prompt", prompt: "同一句排队的话", source_uuid: "u305-same" }, 20);
      const qu = f.H("同一句排队的话", 21, { uuid: "u305-same", promptSource: "queued" });
      const fq = wr("selftest-sess-0305-qqqq", [f.H(INS, 10), qa, qu]);
      t("305 ② 去重:排队附件与它后来落成的 user 行(source_uuid 相同)只数一次", (() => { const r = RULER.countHuman(fq, { sinceMs: Date.parse(f.iso(10)), untilMs: now }); return [r.count, r.deduped]; })(), [2, 1]);
      const why = (x) => { const r = RULER.measureRuler(x); return [r.ok, RULER.formatRuler(r)]; };
      t("305 ② 反例:没记指令 ⇒ 量不出(写明原因),不猜", why({ instruction: null, sids: [SA], dirs: [tmp] }), [false, "主尺:量不出(开批时没记指令(--arm 时加 --instruction \"<原话>\"))"]);
      t("305 ② 反例:指令未定位 ⇒ 量不出,带上未定位的原因", (() => { const [ok, l] = why({ instruction: { text: INS, sid: SA, at: null, why: "找不到会话的转录文件" }, sids: [SA], dirs: [tmp] }); return [ok, l]; })(), [false, "主尺:量不出(指令未定位:找不到会话的转录文件)"]);
      t("305 ② 反例:指令所在会话的转录读不到 ⇒ 量不出(别的会话读得到也不拿来顶)", (() => { const [ok, l] = why({ instruction: { text: INS, sid: SC, at: f.iso(10) }, sids: [SA], dirs: [tmp] }); return [ok, /读不到指令所在会话的转录/.test(l)]; })(), [false, true]);
      t("305 ② 反例:转录目录不在 / 没有会话号 ⇒ 量不出", [why({ instruction: I, sids: [SA], dirs: null })[1], why({ instruction: { text: INS, sid: null, at: f.iso(10) }, sids: [], dirs: [tmp] })[1]].map((l) => l.startsWith("主尺:量不出(")), [true, true]);
      t("305 ② 反例:转录超过扫描上限 ⇒ 量不出(不把读了一半的数当结果)", (() => { const r = RULER.measureRuler({ instruction: I, sids: [SA], dirs: [tmp], nowMs: now, budget: 64 }); return [r.ok, /超过扫描上限/.test(r.why || "")]; })(), [false, true]);
      t("305 ② 流式读:多字节字符与超长行跨读块边界不坏(4MB 一块,造一条 5MB 的人话)", (() => {
        const big = "汉字".repeat(900_000);   // UTF-8 约 5.4MB,必跨块
        const p = wr("selftest-sess-0305-bigg", [f.H(INS, 10), f.H(big, 11), f.H("尾巴", 12)]);
        const r = RULER.countHuman(p, { sinceMs: Date.parse(f.iso(10)), untilMs: now });
        const hit = RULER.locateInstruction(p, "尾巴", { untilMs: now });
        return [r.count, r.err || null, hit.at === f.iso(12)];
      })(), [3, null, true]);
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不判 */ } }
  }
  t("305 ② 集成正例:--clear 成功时多打一行主尺、写进批日志 clear 行;clear 行仍是台账末行(收尾闸的结清证据不受影响);--ruler 只读、读数一致", box305(({ cli, st, jrows, transcript, repo }) => {
    const f = fx305(), all = fxAll(f);
    transcript(SID, [f.H("先看一下现状", 0), f.H(INS, 10), ...all.notHuman.map((x) => x[2]), f.H("这里改一下", 20), f.U([{ type: "text", text: "[Request interrupted by user]" }], 21),
      f.AT({ type: "queued_command", origin: { kind: "human" }, commandMode: "prompt", prompt: "顺便把文档也改了" }, 22)]);
    cli(SIDE, "--arm", "510", "--cond", "甲", "--instruction", INS, "--finish-line", "自测过就停");
    const v0 = st().version, n0 = jrows().length;
    const q = cli(SIDE, "--ruler");
    const ro = [st().version === v0, jrows().length === n0];
    const c = cli(SIDE, "--clear");
    const rows = jrows(), last = rows[rows.length - 1] || {};
    const q2 = cli(SIDE, "--ruler");
    return [q.status, q.stdout.includes("主尺:人亲口说了 4 条(打字 2、"), q.stdout.includes("没算进去(不是人说的):"), ro, c.status, /主尺:人亲口说了 4 条/.test(c.stdout), last.action, last.ruler?.ok, last.ruler?.count, last.ruler?.byKind,
      last.instruction?.text, last.finishLine, st().cleared, q2.status, /批 510 已结清/.test(q2.stdout) && /主尺:人亲口说了 4 条/.test(q2.stdout), verifyChainOk(path.join(repo, ".claude", ".batch-goal.jsonl"))];
  }), [0, true, true, [true, true], 0, true, "clear", true, 4, { typed: 2, interrupt: 1, queued: 1 }, INS, "自测过就停", true, 0, true, true]);
  t("305 ② 集成反例:老用法(没记指令)⇒ 照常结清(退出 0),主尺那行写「量不出(开批时没记指令…)」,clear 行记 ruler.ok=false", box305(({ cli, jrows }) => {
    cli(SIDE, "--arm", "511", "--cond", "甲");
    const c = cli(SIDE, "--clear"); const last = jrows().pop() || {};
    return [c.status, c.stdout.includes("主尺:量不出(开批时没记指令"), last.action, last.ruler?.ok, "instruction" in last];
  }), [0, true, "clear", false, false]);
  t("305 ② 集成反例:指令未定位 / 开批后转录被删 ⇒ 照常结清,主尺写量不出并给原因(不猜一个数)", box305(({ cli, jrows, transcript }) => {
    cli(SIDE, "--arm", "512", "--cond", "甲", "--instruction", INS);
    const c1 = cli(SIDE, "--clear"); const l1 = jrows().pop() || {};
    const f = fx305(); const file = transcript(SID, [f.H(INS, 10)]);
    cli(SIDE, "--arm", "513", "--cond", "甲", "--instruction", INS);
    fs.rmSync(file);
    const c2 = cli(SIDE, "--clear"); const l2 = jrows().pop() || {};
    return [c1.status, c1.stdout.includes("主尺:量不出(指令未定位"), l1.ruler?.ok, c2.status, c2.stdout.includes("主尺:量不出(读不到指令所在会话的转录"), l2.ruler?.ok];
  }), [0, true, false, 0, true, false]);
  t("305 ② 集成:跑关账的是另一个会话 ⇒ 两份转录都读;--ruler 在未武装时说明没有批", box305(({ cli, jrows, transcript }) => {
    const f = fx305(), SB = "selftest-sess-0305-bbbb";
    const none = cli(SIDE, "--ruler");
    transcript(SID, [f.H(INS, 10), f.H("第一个会话里又说一句", 12)]);
    transcript(SB, [f.H("换了会话接着干", 100), f.TR("toolu_z", "结果", 101)]);
    cli(SIDE, "--arm", "514", "--cond", "甲", "--instruction", INS);
    const c = cli({ CLAUDE_CODE_SESSION_ID: SB }, "--clear"); const last = jrows().pop() || {};
    return [none.status, none.stdout.includes("主尺:量不出(未武装"), c.status, last.ruler?.count, (last.ruler?.sessions || []).map((s) => [s.sid === SID ? "A" : "B", s.read, s.count])];
  }), [0, true, 0, 3, [["A", true, 2], ["B", true, 1]]]);
  // ── ③ worktree 里开的批并进主树的批日志 ──
  const SHARED = (repo) => path.join(repo, ".claude", ".batch-goal.worktrees.jsonl");
  const addWt = (b, name) => { const p = path.join(b.tmp, name); const r = b.g(b.repo, "worktree", "add", "-q", "-b", `br-${name}`, p); if (r.status !== 0) throw new Error(`worktree add 失败:${r.stderr}`); return p; };
  t("305 ③ 现状钉住:工作树里 --arm / --clear 写的是工作树自己的台账;主树自己的 .batch-goal.jsonl 一行不多(主树「末行是 clear 行」的结清证据不被工作树的行顶掉)", box305((b) => {
    b.cli(SIDE, "--arm", "520", "--cond", "主树的批"); b.cli(SIDE, "--clear");
    const mainBefore = b.jrows().length;
    const wt = addWt(b, "wt-a");
    const a = b.cliAt(wt, SIDE, "--arm", "521", "--cond", "工作树的批"), c = b.cliAt(wt, SIDE, "--clear");
    const mainRows = b.jrows();
    return [a.status, c.status, b.jrows(wt).filter((x) => x.action === "arm" || x.action === "clear").map((x) => `${x.action}:${x.batch}`), mainRows.length === mainBefore, mainRows[mainRows.length - 1]?.action, mainRows[mainRows.length - 1]?.batch];
  }), [0, 0, ["arm:521", "clear:521"], true, "clear", "520"]);
  t("305 ③ 正例:工作树里 --arm / --clear ⇒ 主树的工作树批日志各记一行(带工作树名、路径、分支),hash 链可校验;主树 --history 看得到并标明来自哪个工作树", box305((b) => {
    b.cli(SIDE, "--arm", "520", "--cond", "主树的批");
    const wt = addWt(b, "wt-a");
    const a = b.cliAt(wt, SIDE, "--arm", "521", "--cond", "工作树的批", "--finish-line", "测过就停"), c = b.cliAt(wt, SIDE, "--clear");
    const rows = b.rowsOf(SHARED(b.repo)).filter((x) => x.action);
    const hist = b.cli(SIDE, "--history", "20").stdout, histWt = b.cliAt(wt, SIDE, "--history", "20").stdout;
    return [a.status, c.status, rows.map((x) => `${x.action}:${x.batch}:${x.worktree}:${x.branch}`), rows.every((x) => typeof x.checkout === "string" && x.checkout), rows[0]?.finishLine, typeof rows[1]?.ruler?.ok,
      verifyChainOk(SHARED(b.repo)), /批 521/.test(hist) && /工作树 wt-a · br-wt-a/.test(hist), /批 520/.test(hist), (hist.match(/批 521/g) || []).length,
      /工作树 wt-a/.test(histWt), fs.existsSync(SHARED(wt))];
  }), [0, 0, ["arm:521:wt-a:br-wt-a", "clear:521:wt-a:br-wt-a"], true, "测过就停", "boolean", true, true, true, 2, false, false]);
  t("305 ③ 反例:主树自己的 --arm / --clear 不往工作树批日志里写(那份文件不出现);非 git 目录照常武装", box305((b) => {
    const a = b.cli(SIDE, "--arm", "522", "--cond", "甲"), c = b.cli(SIDE, "--clear");
    const ng = path.join(b.tmp, "plain"); fs.mkdirSync(ng);
    const n = b.cliAt(ng, SIDE, "--arm", "523", "--cond", "甲");
    return [a.status, c.status, fs.existsSync(SHARED(b.repo)), n.status, fs.existsSync(SHARED(ng))];
  }), [0, 0, false, 0, false]);
  t("305 ③ 反例:主树那份写不进去(路径被一个目录占着)⇒ 工作树里照常武装(退出 0)并出声,不拦", box305((b) => {
    const wt = addWt(b, "wt-a");
    fs.mkdirSync(SHARED(b.repo), { recursive: true });
    const a = b.cliAt(wt, SIDE, "--arm", "524", "--cond", "甲");
    return [a.status, /主树.*写不进去/.test(a.stderr), b.st(wt).batch];
  }), [0, true, "524"]);
  t("305 ③ 并发:4 个工作树同时 --arm、再同时 --clear ⇒ 8 行一行不少、hash 链完好(两个工作树并发写不坏同一份日志)", box305((b) => {
    const wts = ["wt-a", "wt-b", "wt-c", "wt-d"].map((n) => addWt(b, n));
    const launcher = path.join(b.tmp, "race305.mjs");
    fs.writeFileSync(launcher, `import { spawn } from "node:child_process";
const jobs = JSON.parse(process.argv[2]);
const run = (j) => new Promise((res) => { const c = spawn(process.execPath, ["--no-warnings", ${JSON.stringify(fileURLToPath(import.meta.url))}, ...j.args], { cwd: j.cwd, stdio: "ignore", windowsHide: true }); c.on("exit", (code) => res(code)); });
Promise.all(jobs.map(run)).then((codes) => { console.log(JSON.stringify(codes)); });
`);
    const fire = (mk) => spawnSync(process.execPath, ["--no-warnings", launcher, JSON.stringify(wts.map((cwd, i) => ({ cwd, args: mk(i) })))], { encoding: "utf8", env: { ...b.env, ...SIDE }, windowsHide: true, timeout: 180_000 }).stdout.trim();
    const arms = fire((i) => ["--arm", `53${i}`, "--cond", `工作树 ${i} 的批`]);
    const clears = fire(() => ["--clear"]);
    const rows = b.rowsOf(SHARED(b.repo)).filter((x) => x.action);
    return [arms, clears, rows.filter((x) => x.action === "arm").map((x) => x.batch).sort(), rows.filter((x) => x.action === "clear").map((x) => x.batch).sort(), verifyChainOk(SHARED(b.repo))];
  }), ["[0,0,0,0]", "[0,0,0,0]", ["530", "531", "532", "533"], ["530", "531", "532", "533"], true]);
  // ── ④ --handoff:交接文件从事实生成 ──
  const DEBT = "## 在账欠账\n| # | 欠账 | 批 | 失效期 | 复核来源 | 出路 |\n|---|---|---|---|---|---|\n| D900 | 甲事 | 530 | **≤535** | r | o |\n| D901 | 乙事待用户裁 | 530 | **≤536** | r | o |\n| D902 | 丙事 | 530 | **≤560** | r | o |\n";
  const sec = (txt, h) => { const i = txt.indexOf(`## ${h}`); if (i < 0) return null; const j = txt.indexOf("\n## ", i + 3); return txt.slice(i, j < 0 ? undefined : j); };
  t("305 ④ 正例:实跑 --handoff(带远端、工作树、批、作业、欠账)⇒ 首行写生成时间与「由工具从事实生成」;每段都是查得到的事实", box305((b) => {
    const J = path.join;
    // 远端起名 up(不是 origin):核「远端名从 git 配置读、不写死」
    const bare = J(b.tmp, "remote.git"); b.g(b.tmp, "init", "-q", "--bare", bare);
    b.g(b.repo, "remote", "add", "up", bare); b.g(b.repo, "push", "-q", "-u", "up", "HEAD:refs/heads/main");
    const br = String(b.g(b.repo, "symbolic-ref", "--short", "HEAD").stdout).trim();
    if (br !== "main") { b.g(b.repo, "branch", "-q", "-m", br, "main"); b.g(b.repo, "branch", "-q", "-u", "up/main"); }
    b.w(b.repo, "docs/gate-debts.md", DEBT); b.w(b.repo, "b.txt", "b\n"); b.commit(b.repo, "本地一笔");
    const wt = addWt(b, "wt-h"); b.cliAt(wt, SIDE, "--arm", "540", "--cond", "工作树的批");
    b.w(b.repo, "dirty.txt", "未跟踪\n");
    // 作业目录:子进程的系统临时目录指到夹具里
    const TMPD = J(b.tmp, "systmp"), JOBS = J(TMPD, "codex-run-jobs"); fs.mkdirSync(JOBS, { recursive: true });
    const now = Date.now(), iso = (d) => new Date(now + d).toISOString();
    const R1 = J(b.repo, "clipboard", "codex", "t-r1.md"), R2 = J(b.repo, "clipboard", "codex", "t-r2.md");
    b.w(b.repo, "clipboard/codex/t-r1.md", "---\nx\n---\n读过的回件正文\n"); b.w(b.repo, "clipboard/codex/t-r2.md", "---\nx\n---\n没读的回件正文\n");
    const job = (id, o) => fs.writeFileSync(J(JOBS, `${id}.json`), JSON.stringify({ id, task: J(b.repo, "t.md"), cwd: b.repo, timeoutMs: 900000, ...o }));
    job("JREAD", { state: "done", startedAt: iso(-50 * 60e3), endedAt: iso(-40 * 60e3), resultAt: iso(-40 * 60e3), result: R1 });
    job("JPEND", { state: "done", startedAt: iso(-30 * 60e3), endedAt: iso(-20 * 60e3), resultAt: iso(-20 * 60e3), result: R2 });
    job("JRUN", { state: "running", startedAt: iso(-2 * 60e3), result: J(b.repo, "clipboard", "codex", "t-r3.md") });
    job("JOTHER", { state: "running", startedAt: iso(-60e3), cwd: J(b.tmp, "elsewhere"), result: "x" });
    const call = (id, name, input, out, d) => [{ type: "assistant", uuid: `a-${id}`, timestamp: iso(d), cwd: b.repo, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
      { type: "user", uuid: `r-${id}`, timestamp: iso(d + 500), cwd: b.repo, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out }] } }];
    const launch = (id, J0, st, R, d) => call(id, "Bash", { command: "node scripts/codex-run.mjs --task t.md" }, `CODEX_JOB=${J0}\nCODEX_STATE=${st}\nCODEX_RESULT=${R}\nCODEX_END=${J0}\n`, d);
    const f = fx305(now - 3 * 3600_000);
    b.transcript(SID, [f.H(INS, 10), ...launch("toolu_l1", "JREAD", "done", R1, -45 * 60e3), ...call("toolu_r1", "Read", { file_path: R1 }, "1\t---\n2\tx\n3\t---\n4\t读过的回件正文", -35 * 60e3),
      ...launch("toolu_l2", "JPEND", "done", R2, -25 * 60e3), ...launch("toolu_l3", "JRUN", "running", J(b.repo, "clipboard", "codex", "t-r3.md"), -60e3)]);
    b.cli(SIDE, "--arm", "541", "--cond", "主树的批", "--check", "node -e \"console.log('okay')\"", "--expect", "okay", "--instruction", INS, "--finish-line", "测过就停", "--cap-usd", "5");
    b.cli(SIDE, "--decision", "改用另一份台账"); b.cli(SIDE, "--outcome", "交接可生成");
    const out = J(b.tmp, "out", "handoff.md");
    const r = b.cli({ ...SIDE, TEMP: TMPD, TMP: TMPD, TMPDIR: TMPD }, "--handoff", "--out", out);
    const txt = r.stdout, file = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
    const s1 = sec(txt, "当前分支与工作区") || "", s2 = sec(txt, "全部 git worktree") || "", s3 = sec(txt, "批状态") || "", s4 = sec(txt, "在跑或未读的外部作业") || "", s5 = sec(txt, "到期未结的欠账") || "";
    const first = txt.split("\n")[0];
    return [r.status, first.startsWith("# 交接(生成于 ") && first.endsWith("——本文件由工具从事实生成,不含叙述") && Number.isFinite(Date.parse(first.slice(first.indexOf("于 ") + 2, first.indexOf("——") - 1))), file === txt,
      s1.includes("分支:main"), /HEAD:[0-9a-f]{12} 本地一笔/.test(s1), s1.includes("工作区:不干净(已跟踪文件改动 0 个,未跟踪 1 个)"), s1.includes("未推送的提交:1(相对上游 up/main"),
      s2.includes("(当前):分支 main"), /wt-h:分支 br-wt-h;HEAD [0-9a-f]{12};工作区 干净;批状态 批 540 未结清/.test(s2),
      s3.includes("批号:541"), s3.includes("指令:「把开批脚本加上记指令这一项」"), s3.includes("终点线:测过就停"), s3.includes("花费 ≤ 5 美元"), s3.includes("1. 主树的批"), s3.includes("判据:$ node -e"),
      s3.includes("541-D1「改用另一份台账」"), s3.includes("O1「交接可生成」"), s3.includes("主尺:人亲口说了 1 条"),
      s4.includes("本会话发起的 codex 作业:3 个"), s4.includes("JPEND:已产出待读;结果件 "), s4.includes("JRUN:运行中"), !s4.includes("JREAD:"), s4.includes("另 1 个已读回"), !s4.includes("JOTHER"),
      s5.includes("按批号 541 算") && s5.includes("2 条——【我做】D900(≤535);【需你裁】D901(≤536)"), !s5.includes("D902"),
      !txt.includes("取不到")];
  }), [0, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]);
  t("305 ④ 反例:非 git 目录、没有会话号、没有批、没有债表 ⇒ 每一段都写「取不到(原因)」或事实状态,不留空、不编;退出 0", box305((b) => {
    const ng = path.join(b.tmp, "plain"); fs.mkdirSync(ng);
    const r = b.cliAt(ng, {}, "--handoff");
    const txt = r.stdout;
    const heads = ["当前分支与工作区", "全部 git worktree", "批状态", "在跑或未读的外部作业", "到期未结的欠账"];
    const bodies = heads.map((h) => (sec(txt, h) || "").split("\n").slice(1).filter((l) => l.trim()));
    return [r.status, txt.split("\n")[0].includes("本文件由工具从事实生成"), bodies.map((x) => x.length > 0), txt.includes("## 当前分支与工作区\n- 取不到("), txt.includes("## 全部 git worktree\n- 取不到("),
      txt.includes("未武装(没有批状态文件)"), txt.includes("本会话发起的 codex 作业:取不到("), txt.includes("## 到期未结的欠账\n- 取不到(债表 ")];
  }), [0, true, [true, true, true, true, true], true, true, true, true, true]);
  t("305 ④ 反例:没配远端 / 多个远端都没配上游 / 远端上没有同名分支 ⇒ 未推送数写取不到并说清为什么(不猜推到哪个)", box305((b) => {
    const un = (git) => unpushedOf(b.repo, "main", git);
    const fake = (m) => (a) => { const k = a.join(" "); for (const [p, v] of m) if (k.startsWith(p)) return v; return { status: 1, stdout: "", stderr: "" }; };
    const none = un(fake([["remote", { status: 0, stdout: "" }]]));
    const many = un(fake([["remote", { status: 0, stdout: "a\nb\n" }]]));
    const noRef = un(fake([["config --get branch.main.remote", { status: 0, stdout: "up\n" }]]));
    const cfgd = un(fake([["config --get remote.pushDefault", { status: 0, stdout: "pub\n" }], ["rev-parse --verify -q refs/remotes/pub/main", { status: 0, stdout: "x" }], ["rev-list --count refs/remotes/pub/main..HEAD", { status: 0, stdout: "3\n" }]]));
    return [none, many.includes("有 2 个远端(a、b),不猜"), noRef.includes("远端 up(配置)上没有 main 的跟踪引用"), cfgd.startsWith("3(相对 pub/main,远端名取自配置"), unpushedOf(b.repo, null)];
  }), ["取不到(本仓没配远端)", true, true, true, "取不到(分离 HEAD,没有分支)"]);
  t("305 ④ 反例:作业在本会话转录里取不到(没有会话号)⇒ 只列作业目录里本仓的作业与结果路径,写明「是否读过:未判」", box305((b) => {
    const J = path.join, TMPD = J(b.tmp, "systmp"), JOBS = J(TMPD, "codex-run-jobs"); fs.mkdirSync(JOBS, { recursive: true });
    fs.writeFileSync(J(JOBS, "JDONE.json"), JSON.stringify({ id: "JDONE", state: "done", startedAt: new Date(Date.now() - 60e3).toISOString(), cwd: b.repo, result: J(b.repo, "r.md"), task: "t.md" }));
    const r = b.cli({ TEMP: TMPD, TMP: TMPD, TMPDIR: TMPD }, "--handoff");
    const s4 = sec(r.stdout, "在跑或未读的外部作业") || "";
    return [r.status, s4.includes("本会话发起的 codex 作业:取不到(取不到本会话的会话号"), s4.includes("JDONE:state=done;结果件 ") && s4.includes("r.md") && s4.includes("是否读过:未判")];
  }), [0, true, true]);
  t("305 ④ --out:写到的文件与打印的逐字相同;--out 指向一个目录 / 缺值 / 多余参数 ⇒ 退出 2,不写", box305((b) => {
    const d = path.join(b.tmp, "adir"); fs.mkdirSync(d);
    const a = b.cli(SIDE, "--handoff", "--out", d), c = b.cli(SIDE, "--handoff", "--out"), e = b.cli(SIDE, "--handoff", "多余");
    return [a.status, /--out/.test(a.stderr), c.status, e.status];
  }), [2, true, 2, 2]);
}
const verifyChainOk = (f) => { try { return verifyFileChain(f).ok; } catch { return false; } };

// ⚠️ **主模块守卫**(grill:edge-cases F23):本文件 export 了 load/confirmedIndices/evaluate,
//   而下面的 CLI 段原先**无条件执行** ⇒ 任何 import 它的进程当场退出(0 或 2),
//   调用方代码一行都不跑。**这正是 hook 当初抄一份正则而不 import 的原因**,
//   也就是说那条双半角冒号的分叉(F22)是本条的**后果**。
const IS_MAIN = !!process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
const argv = IS_MAIN ? process.argv.slice(2) : ["--imported-noop"];
if (argv.includes("--self-test")) process.exit(selfTest());
{ const modes = ["--arm", "--status", "--dry-check", "--clear", "--history", "--decision", "--outcome", "--withdraw", "--settle", "--repair-obligations", "--context", "--ruler", "--handoff"].filter((m) => argv.includes(m));
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
    // 批 298(2.2 K 行):逐条裁决参数,可选;给了就须覆盖全部条件
    let verdicts = null;
    try { verdicts = parseVerdicts(argv, prev.conditions.length); }
    catch (e) {
      refuse("verdict-usage");
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev.batch} reason=verdict-usage`);
      console.error(`拒绝结清:${e.message}\n出路:每条条件给一个 --verdict "N=达成|未达成|不适用[:理由]",或一个都不给(文字对照「条件N:达成」照旧认)。`);
      process.exit(2);
    }
    // 批 298:义务账可信性先查(拒清口径同 checks-tampered:状态与台账对不上就拒,不猜)
    const oblDir = OB.storeDir();
    const refuseStore = (kind, why) => {
      const s = storeRefusal(kind, why);
      refuse(s.reason);
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev.batch} reason=${s.reason}`);
      console.error(`拒绝结清:义务账判不了——${s.msg}。判不了按开着算。\n出路:${s.outlet}`);
      process.exit(2);
    };
    // 批 298 r1(codex §1 / BP-1 / BP-6):批身份必须与武装台账最后一条 arm 行一致(状态文件 gitignore、可被改)
    { const id = armIdentity(prev); if (!id.ok) refuseStore("identity", `批身份与武装台账对不上:${id.why}`); }
    if (oblDir.unknown) refuseStore("unknown", `取不到义务账目录(${oblDir.why})`);
    let oblSnap = OB.readStore(oblDir.dir);
    if (!OB.TRUSTED.has(oblSnap.kind)) refuseStore(oblSnap.kind, oblSnap.why);
    { const p = anchorProblem(oblSnap); if (p) refuseStore("anchor", p); }   // 批 298 r1(codex §2):每个写点都记锚
    // 批 298 r1(红队 BP-4):本批把配置改坏(基点版合法)⇒ 直接拒,不计判不了、不能 --settle
    // 批 298 r2(猎手 FB-6):配置读错误(EBUSY / EPERM / EISDIR…)⇒ 判不了、可重试;不算改坏,也不动义务账
    if (effectiveConfig(prev).readError) {
      refuse("obligation-unknown");
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev.batch} reason=obligation-unknown`);
      console.error(`拒绝结清:${installConfig().error}——读错误不是配置坏了,判不了。\n出路:查占用 / 权限后重跑 --clear。`);
      process.exit(2);
    }
    if (effectiveConfig(prev).brokenInBatch) {
      refuse("config-broken-in-batch");
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev.batch} reason=config-broken-in-batch`);
      console.error(`拒绝结清:${brokenConfigText(prev.baseCommit)}\n这一项不计入判不了次数,不能 --settle。`);
      process.exit(2);
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
      console.error(`拒绝结清:还有 ${wt.paths.length} 个已跟踪文件的改动没提交(AGENTS.md「三、生产」收尾清部署欠账不用问,提交是清账的一部分):`);
      for (const f of wt.paths.slice(0, 10)) console.error(`  ${f}`);
      if (wt.paths.length > 10) console.error(`  …另 ${wt.paths.length - 10} 个`);
      console.error("出路:本批的改动先提交再 --clear。**不是本批做的改动(可能是用户自己的)不得撤销、不得丢弃**——停下告诉用户,由用户决定。");
      process.exit(2);
    }
    // 批 309:规则 P 的拒绝挪到这里(判据同收尾钩子那一份;零成本路径与出路见 loadBearingReview 头注)。放在义务账求值之前:拒了不留义务账写入。
    const er = await loadBearingReview(prev);
    let reviewWaived = null;
    if (er.status === "missing" || er.status === "unknown") {
      reviewWaived = reviewWaiver(prev, readFpRows());
      if (!reviewWaived) {
        const why = er.status === "missing" ? "review-missing" : "review-unknown";
        refuse(why);
        console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev.batch} reason=${why}`);
        printReview(er, prev, er.status === "missing"
          ? `拒绝结清:本批有${reviewWhat(er)},复核通道没跑齐(规则 P;判据与收尾钩子同一份,只是换到关账这一步问)。`
          : `拒绝结清:本批有${reviewWhat(er)},但复核有没有跑齐判不了(规则 P)。`);
        process.exit(2);
      }
      console.error(`提示:承重面复核${er.status === "missing" ? "没跑齐" : "判不了"},按本批记的 P 误报放行(${String(reviewWaived.h).slice(0, 8)} ${String(reviewWaived.why || "").slice(0, 80)});收尾报告须写明。`);
    } else if (er.status === "soft") console.error(`提示:${er.line}`);
    else if (er.status === "skip") console.error(`提示:承重面复核这一项没查——${er.why}`);
    // 批 256:登记过的决定要有 ADR、登记过的成果要有日记行——写入 cleared 之前查,缺 ⇒ 拒清并给模板。
    // 批 298:判据照旧是 obligationCheck(同一份判定),但对象是「批状态 ∪ 义务账里本批的记录」;结论写回义务账,
    //   拒不拒按义务账里本批名下的记录定(带进来的、产生器建的都在内);转欠账且已提交的不再挡。
    // 批 298 r1(codex §4 / 猎手 FB-1、附二⑤):取证(git)全在锁外算成计划;锁内只核「本批名下的记录没被别人动过」再落笔。
    //   只有本批相关记录的 rev 变了才算冲突;冲突 ⇒ 重读重算一次,还冲突才拒。
    const key = batchKeyOf(prev);
    const ctx = oblCtx();
    let evalOut = null, goalU, obl;
    let lastWriteHints = [];   // 批 301:写入类取证里只提示、不产生义务的(M 全部;仓外 memory 的 shell 写入)
    for (let attempt = 0; attempt < 2 && !evalOut; attempt++) {
      oblSnap = OB.readStore(oblDir.dir);
      if (!OB.TRUSTED.has(oblSnap.kind)) refuseStore(oblSnap.kind, oblSnap.why);
      // 批 301:写入类取证(T / MF / J / M)在锁外做(异步:要载入 MF / verify-laws 判据),含本批名下与待并入的既有写入类义务;
      //   结论在锁内由 applyClearPlan 落笔(同一次指纹核对;冲突重读时连同它重算)。取证自身抛错 ⇒ 一条 UNKNOWN,不当「没事」。
      let writeChecks, existing = [];
      try {
        //   本批名下的连已清的也重判(已清后文件又回到坏内容、且退出了净 diff ⇒ 要能重开;codex 301 r1 F2)
        existing = oblSnap.obligations.filter((r) => isWriteCheckType(r.type) && r.status !== "withdrawn" &&
          ((sameKey(r.batch, key)) || (!isDone(r) && ((prev.carriedFrom && sameKey(r.batch, prev.carriedFrom)) || (!r.batch && ownerMatches(r, ctx.sid, ctx.checkout))))));
        writeChecks = await planWriteChecks(prev, { conf: followConfPaths(batchConfig(prev, oblSnap.obligations), prev.baseCommit), existing });
      } catch (e) {
        // codex 301 r4 ①:取证抛错的兜底也先把已撤回的 T / MF / M 写清,再放一条 J 的 UNKNOWN
        let wc = []; try { wc = withdrawnClears(existing); } catch { wc = []; }
        writeChecks = { items: [...wc, { type: "write-law-verify", path: "(写入类取证)", result: "unknown", why: `取证抛错:${String(e && e.message || e).slice(0, 160)}` }], hints: [] };
      }
      lastWriteHints = writeChecks.hints || [];
      const plan = planClear(prev, oblSnap.obligations, ctx, { writeChecks });
      ({ goalU, obl } = plan);
      if (attempt === 0) for (const n of obl.notes) console.error("提示:" + n);
      try { evalOut = OB.mutateStore(oblDir.dir, (draft) => applyClearPlan(draft, prev, plan, ctx)); }
      catch (e) { if (e.code === "CONFLICT" && attempt === 0) continue; refuseStore(errKind(e), `${e.code || ""} ${e.message}`.trim()); }
    }
    for (const h of lastWriteHints.slice(0, 12)) console.error("提示:" + h);
    if (lastWriteHints.length > 12) console.error(`提示:写入类另有 ${lastWriteHints.length - 12} 条只提示项未列`);
    const recs = evalOut.result;
    const blocking0 = recs.filter((r) => OB.BLOCKING.has(r.status));
    // 批 298 r2(红队附三):求值已写进义务账、而本次又被拒 ⇒ 也记锚(否则拒清后截掉这几行查不出);放行的那次锚记在 clear 行里
    if (blocking0.length && evalOut.changed?.length) journal("obl-head", { batch: prev.batch, oblHead: { h: evalOut.head, version: evalOut.version } });
    const blocking = recs.filter((r) => OB.BLOCKING.has(r.status));
    if (blocking.length) {
      const own = blocking.filter((r) => sameKey(r.origin, key) && OB.RESERVED_TYPES.has(r.type) && r.status !== "settling");
      const other = blocking.filter((r) => !own.includes(r));
      const reasons = [];
      const ownUnknown = own.some((r) => r.status === "unknown");
      if (ownUnknown) reasons.push("obligation-unknown");   // 原口径:本批核对判不了时只报判不了
      else {
        if (own.some((r) => r.type === "decision-adr")) reasons.push("adr-missing");
        if (own.some((r) => r.type === "outcome-diary")) reasons.push("diary-missing");
        if (own.some((r) => r.type === "load-bearing-decision")) reasons.push("no-decision");
      }
      for (const r of other) reasons.push(r.status === "settling" ? "settle-uncommitted" : r.status === "unknown" ? "obligation-unknown" : "obligation-open");
      const why = [...new Set(reasons)].join("+");
      refuse(why);
      console.error(`BATCH-GOAL-CLEAR-REFUSED batch=${prev?.batch} reason=${why}`);
      if (ownUnknown) {
        const u = own.filter((r) => r.status === "unknown");
        console.error(`拒绝结清:决定 / 成果 / 承重面的核对判不了(${obl.unknown})。判不了按没过算。`);
        console.error(`  连续判不了:${u.map((r) => `${recLabel(r)} ×${r.unknownStreak || 0}`).join("、")};到 ${OB.UNKNOWN_LIMIT} 次(首次 + 重试 ${OB.MAX_RETRIES} 次)后可 \`--settle\` 转欠账 ⇒ 提交 ⇒ 再 --clear。`);
      } else if (own.length) {
        const ownObl = { ...obl,
          missingDecisions: own.filter((r) => r.type === "decision-adr").map((r) => r.payload?.id),
          diaryMissing: own.some((r) => r.type === "outcome-diary"),
          noDecisionTouched: own.some((r) => r.type === "load-bearing-decision") ? obl.noDecisionTouched : [] };
        printObligationRefusal(goalU, ownObl);
      }
      if (other.length) {
        console.error(`拒绝结清:本批名下还有 ${other.length} 条未清的义务(带进来的 / 产生器建的;判不了按开着算):`);
        for (const r of other) {
          const outlet = r.status === "settling" ? `把债表行 ${r.settle?.debtId} 提交(git add ${r.settle?.table || cfgDebtTable()} && git commit),再 --clear;行丢了就重跑 --settle`
            : OB.RESERVED_TYPES.has(r.type) ? (r.type === "decision-adr" ? OUTLETS["decision-adr"](r.payload?.id) : r.type === "outcome-diary" ? OUTLETS["outcome-diary"](r.origin?.batch, r.payload?.n) : OUTLETS["load-bearing-decision"](r.origin?.batch).replace(/:/, `(由本批 ${prev.batch} 承接):`))
            : (r.outlet || "让产生它的流程重跑取证");
          console.error(`  · ${fmtRec(r)}${r.origin?.batch && r.origin.batch !== prev.batch ? `(来自批 ${r.origin.batch})` : ""} —— ${r.lastResult?.why ? `${String(r.lastResult.why).slice(0, 120)};` : ""}出路:${outlet}`);
          if (r.status === "unknown") console.error(`    连续判不了 ×${r.unknownStreak || 0};到 ${OB.UNKNOWN_LIMIT} 次后可 --settle 转欠账`);
        }
      }
      console.error("没有任何命令能把义务直接标成已清:已清只由取证结果写(做完它再 --clear),卡住的转欠账(--settle)。");
      process.exit(2);
    }
    // 批 298 r3(codex §3):结清报告首行写明本批曾确认义务账丢失(要在写 clear 行之前取,否则「本批期间」就空了)
    const accNow = acceptLossRows().current;
    if (accNow.length) console.log(`本批曾确认义务账丢失(理由:${accNow.map((r) => r.reason).join(";")})——收尾报告须写明`);
    const oblCleared = recs.filter((r) => r.status === "cleared").map((r) => r.id);
    const oblSettled = recs.filter((r) => r.status === "settled").map((r) => ({ id: r.id, debtId: r.settle?.debtId, expiry: r.settle?.expiry }));
    // 批 305:主尺在写 clear 行**之前**算好、记在 clear 行里(收尾闸要求台账末行就是 clear 行,不能事后另追一行)。只读转录,量不出也照常结清。
    const ruler = computeRuler(prev);
    const clearRow = { batch: prev?.batch ?? null, conditions: prev?.conditions ?? null, ...pickArmMeta(prev), ruler: rulerRecord(ruler),
      checks: prev?.checks ?? null, armedAt: prev?.armedAt ?? null, baseCommit: prev?.baseCommit ?? null,
      decisions: prev?.decisions ?? null, outcomes: prev?.outcomes ?? null, withdrawn: prev?.withdrawn ?? null,
      obligations: { cleared: oblCleared.length, settled: oblSettled, head: evalOut.head ?? null, version: evalOut.version },
      ...(evalOut.head ? { oblHead: { h: evalOut.head, version: evalOut.version } } : {}),
      ...(verdicts ? { verdicts } : {}),
      // 批 309:关账侧 P 判定的结论进结清行(放行靠误报记账的,记下那一笔的 h)
      review: { status: er.status, ...(Array.isArray(er.engineCommits) ? { engineCommits: er.engineCommits.length } : {}),
        ...(Array.isArray(er.carrierCommits) ? { carrierCommits: er.carrierCommits.length } : {}), ...(reviewWaived ? { waivedBy: reviewWaived.h } : {}) } };
    journal("clear", clearRow);
    console.log(`义务:已清 ${oblCleared.length} 条;转欠账 ${oblSettled.length} 条${oblSettled.length ? `(${oblSettled.map((s) => `${s.debtId} ≤${s.expiry}`).join("、")};到期未结会在开批时回到开着)` : ""}`);
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
    mirrorToMain("clear", clearRow);   // 批 305:工作树里结清的批,主树也看得到(只在工作树里才写;写不进只出声)
    console.log("已结清批级完成条件(留结清标记,下次 --arm 覆盖;条件已存入 .batch-goal.jsonl)");
    console.log(RULER.formatRuler(ruler));   // 批 305:主尺一行(量不出也打,写明原因)
    debtTableWarn();
    // 批 258 条件 4:收尾自动出一张报警量 × 误报率表(按规则),待修行下一批 --arm 会再列一次
    const rep = fpReport();
    if (rep) console.log("\n── 收尾误报率表 ──\n" + rep.trim());
    // 批 292(287 设计 2.6 / 2.8;用户 11-06「记账了真的还有人去看嘛」):「只记账」档(E0 / E2 / S / Q)不进模型上下文,
    //   命中落在 `.claude/.gate-candidates.jsonl`;结清这一步是它唯一的必经读点——按本批武装时刻起汇总一行。
    //   失效条件:连续 5 批这行的命中没有一次引起改动 ⇒ 真阳性回放后删检测(债表 D200)。读不到 ⇒ 说出来,不拦结清。
    try { const line = candidateSummary(prev?.armedAt); if (line) console.log("\n" + line); }
    catch (e) { console.log(`⚠ 候选台账读不到(${String(e && e.message || e).slice(0, 120)})——「只记账」档本批的命中没法汇总`); }
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

/** 批 298:义务账的只读视图(--status / --context 共用)。返回 { kind, why, dir, view, all }。 */
function oblRead(g) {
  const sd = OB.storeDir();
  if (sd.unknown) return { kind: "unknown", why: sd.why, dir: null, view: oblView(null, g, oblCtx()) };
  const snap = OB.readStore(sd.dir);
  return { kind: snap.kind, why: snap.why, dir: sd.dir, view: oblView(OB.TRUSTED.has(snap.kind) ? snap : null, g, oblCtx()) };
}
function printOblStatus(g) {
  // 批 305:安装方配置里的名单键(deployScripts / privateRepos)写错了不判坏整份配置,只是那一支判据不响——在这里出声(--status 的两条路径都经过本函数)
  for (const w of arr(installConfig().warnings)) console.log(`  ⚠ 安装方配置:${w}`);
  const o = oblRead(g);
  const v = o.view;
  console.log(`  义务账(${o.dir ? path.join(o.dir, "state.json") : "取不到"}):${OB.TRUSTED.has(o.kind) ? "可信" : `判不了(${o.kind}:${o.why})——--clear 会拒`}`);
  {
    const acc = acceptLossRows();
    for (const r of acc.current) console.log(`  ⚠ 本批曾确认义务账丢失:${fmtAccept(r)}——收尾报告须写明`);
    if (acc.latest && !acc.current.includes(acc.latest)) console.log(`  最近一次确认义务账丢失:${fmtAccept(acc.latest)}`);
  }
  if (g) { const id = armIdentity(g); if (!id.ok) console.log(`  ⚠ 批身份与武装台账对不上(${id.why})——--clear / --settle 会拒(obligations-tampered);下面按状态文件列,可能不准`); }
  if (v.key) {
    const s = OB.summarize(v.mine);
    console.log(`  本批名下未清 ${v.mine.length} 条:开着 ${s.open} / 判不了 ${s.unknown} / 转欠账待提交 ${s.settling} / 已转欠账 ${s.settled}${s.blocking ? `  ⇒ --clear 会拒(挡关账 ${s.blocking} 条)` : ""}`);
    for (const r of v.mine) console.log(`    ${fmtRec(r)}${r.origin?.batch && String(r.origin.batch) !== String(g.batch) ? `(来自批 ${r.origin.batch})` : ""}${OB.settleEligible(r) && r.status === "unknown" ? "  ← 可 --settle 转欠账" : ""}`);
  }
  if (v.unassignedMine.length) console.log(`  本 checkout 未归属 ${v.unassignedMine.length} 条(下次 --arm / --clear 并入):${v.unassignedMine.map(fmtRec).join(";")}`);
  if (v.unassignedOthers.length) console.log(`  别的 checkout 未归属 ${v.unassignedOthers.length} 条(不并入本批):${v.unassignedOthers.map((r) => `${fmtRec(r)} @${String(r.owner || r.checkout || "?").slice(0, 12)}`).join(";")}`);
  const settledElsewhere = v.settledAll.filter((r) => !v.mine.includes(r));
  if (settledElsewhere.length) console.log(`  已转欠账 ${settledElsewhere.length} 条(到期未结会在开批时回到开着):${settledElsewhere.map(fmtRec).join(";")}`);
}

if (argv.includes("--context")) {
  // 批 298(2.1「每轮给模型一份上下文」):一行摘要 + 一个路径 + 内容哈希。只读。哈希只随内容变(给注入去重用)。
  let g = null, gErr = null;
  try { g = load(); } catch (e) { gErr = e.message; }
  const o = oblRead(g && !g.cleared ? g : null);
  const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length;
  const s = OB.summarize(o.view.mine);
  const content = { batch: armed ? g.batch : null, gErr, store: o.kind, mine: o.view.mine.map((r) => [r.id, r.status, r.unknownStreak || 0]), un: o.view.unassignedMine.map((r) => [r.id, r.status]) };
  const line = gErr ? `批状态读不了(${gErr})` : armed ? `批 ${g.batch} 已武装(${g.conditions.length} 条条件)` : g?.cleared ? `批 ${g.batch} 已结清,未武装新批` : "未武装";
  console.log(`BATCH-CONTEXT ${line};义务:挡关账 ${s.blocking}(开着 ${s.open} / 判不了 ${s.unknown} / 转欠账待提交 ${s.settling})、已转欠账 ${s.settled}、本 checkout 未归属 ${o.view.unassignedMine.length}${OB.TRUSTED.has(o.kind) ? "" : `;义务账判不了(${o.kind})`} path=${o.dir ? path.join(o.dir, "state.json") : "-"} sha256=${OB.digest(content).slice(0, 16)}`);
  process.exit(0);
}

if (argv.includes("--repair-obligations")) {
  // 批 298:只按台账重建状态文件 / 截掉台账末尾撕裂残片。不改任何一条义务的结论;链断(台账行被改写)拒做。
  const sd = OB.storeDir();
  if (sd.unknown) { console.error(`取不到义务账目录:${sd.why}`); process.exit(2); }
  try {
    const notes = OB.repairStore(sd.dir);
    for (const n of notes) console.log(`修复:${n}`);
    // 不往批台账 .batch-goal.jsonl 记行:结清后收尾闸要求台账末行就是 clear 行(hook-stop-closure K0 证据),
    //   在那之后追加任何行都会让一次正常关账被 K0 误拦。修复的痕迹是 ledger / state 的 *.bak 备份。
    process.exit(0);
  } catch (e) {
    console.error(`拒绝修复:${e.message}`);
    process.exit(2);
  }
}

if (argv.includes("--settle")) {
  // 批 298(287 设计 2.7「卡住以后自动转成欠账」;拆批稿 0.5):连续判不了 ≥3 次的义务写一行债表(失效期 ≤ 批号数字部分 + 3),
  //   状态改「转欠账待提交」。不提交、不结清:提交以后 --clear 只认 HEAD 里那一行(不在 --clear 里写债表,D116 自锁)。
  const i = argv.indexOf("--settle");
  const target = argv[i + 1] && !/^--/.test(argv[i + 1]) ? argv[i + 1] : null;
  const extra = argv.filter((a, k) => k !== i && !(target && k === i + 1));
  if (extra.length) { console.error(`用法错误:--settle [<义务 id>],多余参数:${extra.join(" ")}`); process.exit(2); }
  let g;
  try { g = load(); } catch (e) { console.error(`拒绝转欠账:${e.message}`); process.exit(2); }
  if (!g || g.cleared || !Array.isArray(g.conditions) || !g.conditions.length) { console.error("拒绝转欠账:盘上没有未结清的批(转欠账要记在某一批名下,失效期按批号算)。"); process.exit(2); }
  const num = OB.batchNumber(g.batch);
  if (!Number.isFinite(num)) { console.error(`拒绝转欠账:批号「${g.batch}」没有数字部分,算不出失效期(≤批号+3)。出路:--arm <数字批号> --cond … --force 换到数字批号(义务会原样带过去),再 --settle。`); process.exit(2); }
  const expiry = num + OB.MAX_RETRIES + 1;   // = 批号 + 3(287 设计 2.7「默认 ≤ 当前批号 + 3」)
  { const id = armIdentity(g); if (!id.ok) { const s = storeRefusal("identity", id.why); console.error(`拒绝转欠账:批身份与武装台账对不上——${s.msg}\n出路:${s.outlet}`); process.exit(2); } }
  const sd = OB.storeDir();
  if (sd.unknown) { console.error(`拒绝转欠账:取不到义务账目录(${sd.why})`); process.exit(2); }
  const snap = OB.readStore(sd.dir);
  if (!OB.TRUSTED.has(snap.kind)) { const s = storeRefusal(snap.kind, snap.why); console.error(`拒绝转欠账:义务账判不了——${s.msg}\n出路:${s.outlet}`); process.exit(2); }
  { const p = anchorProblem(snap); if (p) { const s = storeRefusal("anchor", p); console.error(`拒绝转欠账:${s.msg}\n出路:${s.outlet}`); process.exit(2); } }
  const key = batchKeyOf(g);
  const mine = arr(snap.obligations).filter((r) => sameKey(r.batch, key) && !isDone(r) && (!target || r.id === target));
  const eligible = mine.filter(OB.settleEligible);
  if (!eligible.length) {
    console.error(`拒绝转欠账:${target ? `义务 ${target} 不在本批名下,或` : "本批名下"}没有可转欠账的义务——只有**连续判不了 ≥${OB.UNKNOWN_LIMIT} 次**(首次 + 重试 ${OB.MAX_RETRIES} 次)的才转;开着的是「没做」,不是「卡住」。`);
    for (const r of mine.filter((x) => OB.BLOCKING.has(x.status))) {
      const why = r.status === "open" ? "开着(取证给出了「没做」):做完它再 --clear" : r.status === "unknown" ? `判不了 ×${r.unknownStreak || 0}:再跑 --clear 重试(还差 ${OB.UNKNOWN_LIMIT - (r.unknownStreak || 0)} 次),或先修好取证条件` : r.status;
      console.error(`  · ${fmtRec(r)} —— ${why}`);
    }
    process.exit(2);
  }
  // 批 298 r1:债表路径按本批冻结的配置(武装时快照 ∪ 基点版);配置写了路径而文件不在 ⇒ 判不了,拒(不悄悄新建)
  if (effectiveConfig(g).brokenInBatch) { console.error(`拒绝转欠账:${brokenConfigText(g.baseCommit)}\n这一项不能拿转欠账绕过。`); process.exit(2); }
  const bconf = batchConfig(g, snap.obligations);
  if (bconf.error) { console.error(`拒绝转欠账:安装方配置判不了(${bconf.error})${bconf.brokenInBatch ? "——是本批改坏的,改回 gate-install.json 再来(不能拿转欠账绕过)" : ""}`); process.exit(2); }
  const table = bconf.debtTable || "docs/gate-debts.md";
  let text0 = "";
  try { text0 = fs.readFileSync(table, "utf8"); }
  catch (e) {
    if (e.code !== "ENOENT") { console.error(`拒绝转欠账:债表读不了(${e.code}):${table}`); process.exit(2); }
    if (bconf.debtTableExplicit) { console.error(`拒绝转欠账:配置写了债表 ${table},文件却不存在——判不了。出路:确认路径(gate-install.json 的 debtTable)或把债表建出来并提交,再 --settle`); process.exit(2); }
  }
  const tableWritten = [];
  let written;
  try {
    written = OB.mutateStore(sd.dir, (draft) => {
      let text = text0;
      let next = OB.maxDebtId(text);
      const done = [];
      for (const r0 of eligible) {
        const r = draft.get(r0.id);
        if (!r || r.rev !== r0.rev) throw new OB.ObligationError("CONFLICT", `义务 ${r0.id} 在读后被改过`);
        // 工作树里已有写着这条义务 id 的行(上次「债表已写、义务账未记」,或待提交时重跑)⇒ 沿用那个 D 号、不重复写
        const existing = (text.match(new RegExp(`^\\|\\s*(D\\d+)\\s*\\|[^\\n]*${r.id}`, "m")) || [])[1];
        const debtId = existing || (r.status === "settling" && r.settle?.debtId) || `D${++next}`;
        if (!existing) text = OB.insertDebtRow(text, OB.settleRow(r, { debtId, batch: g.batch, expiry: r.settle?.expiry ?? expiry }));
        draft.put({ ...r, status: "settling", settle: { debtId, expiry: r.settle?.expiry ?? expiry, table, at: new Date().toISOString(), batch: g.batch } },
          { op: "settle", by: "batch-goal --settle", why: `连续判不了 ${r.unknownStreak || 0} 次,转欠账 ${debtId}(≤${r.settle?.expiry ?? expiry})` });
        done.push({ id: r.id, debtId, expiry: r.settle?.expiry ?? expiry, label: recLabel(r) });
      }
      if (text !== text0) { fs.mkdirSync(path.dirname(table) || ".", { recursive: true }); fs.writeFileSync(table, text, "utf8"); tableWritten.push(...done.map((d) => d.debtId)); }
      return done;
    }, { expectVersion: snap.version });
  } catch (e) {
    // 批 298 r1(codex 另项):债表写了、义务账追加失败 ⇒ 如实说,不说「什么都没写」
    // 批 298 r2(codex ⑥):三步(债表 / 义务账台账 / state)各自成败如实报
    const ledgerSt = e.phase === "state" ? `台账已追加 ${e.appended} 行` : e.phase === "ledger" && e.appended ? `台账只追加了 ${e.appended} 行(没写完)` : "台账未追加";
    const stateSt = e.chainBroken ? "台账链已断(不能自动修复,停下告诉用户)" : e.phase === "state" || (e.phase === "ledger" && e.appended) ? "state 未同步(--repair-obligations 按台账重建)" : "state 未动";
    if (tableWritten.length || e.phase) {
      console.error(`转欠账半写:${tableWritten.length ? `债表已写 ${tableWritten.join("、")}(${table})` : "债表未写"};${ledgerSt};${stateSt}。原因:${e.code || ""} ${e.message}`);
      if (e.chainBroken) { console.error("恢复:台账链已断,不能自动修复(--repair-obligations 对链断拒做)——停下告诉用户。"); process.exit(2); }
      console.error(`恢复:${e.phase === "state" || (e.phase === "ledger" && e.appended) ? "先 `node --no-warnings scripts/batch-goal.mjs --repair-obligations`,再" : ""}重跑 \`node --no-warnings scripts/batch-goal.mjs --settle\`——它会认出债表里写着这条义务 id 的行,用同一个 D 号补记,不会再写一行。`);
    } else console.error(`拒绝转欠账:${e.code || ""} ${e.message}——债表、台账、state 都没写;重跑一次`);
    process.exit(2);
  }
  journal("settle", { batch: g.batch, settled: written.result, oblHead: { h: written.head, version: written.version } });
  console.log(`已转欠账 ${written.result.length} 条(写进 ${table},状态「转欠账待提交」):`);
  for (const d of written.result) console.log(`  ${d.debtId} ≤${d.expiry}:${d.label}(义务 ${d.id})`);
  const issues = (() => { try { return debtTableIssues(fs.readFileSync(table, "utf8")); } catch { return []; } })();
  if (issues.length) console.log(`🔴 写完后债表结构有问题:${issues.join(";")}`);
  console.log(`下一步:git add ${table} && git commit -m "…"(提交本批其余改动时一起),然后 --clear——它只认 HEAD 里已提交的这几行。`);
  console.log("转欠账不等于完成:报告里与「已清」分开列;到期未结的,开批时回到开着。");
  process.exit(0);
}

if (argv.includes("--status")) {
  const g = load();
  if (!g || g.cleared || !Array.isArray(g.conditions)) {
    // F25: 之后状态是 {cleared:true},truthy 但没有 conditions ⇒ 原实现在
    //   **每两批之间那个必然存在的状态**上崩溃。--status 是文档写明的检视口。
    console.log(g?.cleared ? "已结清:上一批已关账,尚未武装新批" : "未武装:本批没有完成条件(开工时应 --arm)");
    printOblStatus(null);
    process.exit(0);
  }
  console.log(`批 ${g.batch} · ${g.conditions.length} 条完成条件:`);
  g.conditions.forEach((c, i) => console.log(`  条件${i + 1}: ${typeof c === "string" ? c : c.text}`));
  for (const c of (Array.isArray(g.checks) ? g.checks : [])) console.log(`    判据(条件${c.i + 1}): $ ${c.cmd}${c.expect !== undefined ? `  期待含「${c.expect}」` : ""}${c.expectRe !== undefined ? `  期待匹配 /${c.expectRe}/` : ""}`);
  console.log(`  基点:${g.baseCommit ? String(g.baseCommit).slice(0, 10) : "(无——早于批 256 的武装,ADR 核对退回全部 ADR)"}`);
  for (const l of armMetaLines(g)) console.log(`  ${l}`);   // 批 305:指令 / 终点线 / 上限(记了才打)
  for (const d of arr(g.decisions)) console.log(`  决定 ${d.id}: ${d.text}`);
  for (const o of numberOutcomes(g.outcomes)) console.log(`  成果 O${o.n}: ${o.text}`);
  for (const w of arr(g.withdrawn)) console.log(`  已撤 ${w?.kind === "decision" ? w.id : `O${w?.n}`}: ${w?.text}  ——理由:${w?.reason}`);
  printOblStatus(g);
  process.exit(0);
}

if (argv.includes("--ruler")) {
  // 批 305:主尺的只读子命令——随时单独算一遍,便于核对。不写批状态、不写台账。
  //   未结清的批 ⇒ 现算(指令到此刻);刚结清 ⇒ 打关账时记进 clear 行的那一份;没有批 ⇒ 量不出。
  let g = null;
  try { g = load(); } catch (e) { console.log(`主尺:量不出(批状态读不了:${e.message})`); process.exit(0); }
  if (g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length) {
    const r = computeRuler(g);
    console.log(`批 ${g.batch}(未结清;现算到此刻)`);
    for (const l of armMetaLines(g)) console.log(`  ${l}`);
    console.log(RULER.formatRuler(r));
    for (const l of RULER.formatRulerDetail(r)) console.log(l);
  } else if (g && g.cleared) {
    let row = null;
    try { for (const l of fs.readFileSync(JOURNAL, "utf8").split("\n")) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; } if (o && o.action === "clear" && String(o.batch) === String(g.batch)) row = o; } } catch { row = null; }
    console.log(`批 ${g.batch} 已结清;下面是关账时记进批日志的那一份(${row ? String(row.at || "").slice(0, 19) : "台账里没找到这批的 clear 行"})`);
    if (row) for (const l of armMetaLines(row)) console.log(`  ${l}`);
    const r = row && row.ruler ? row.ruler : { ok: false, why: row ? "这一批关账时还没有主尺(旧版本关的账)" : "台账里没有这批的 clear 行" };
    console.log(RULER.formatRuler(r));
    for (const l of RULER.formatRulerDetail(r)) console.log(l);
  } else console.log("主尺:量不出(未武装:盘上没有批)");
  process.exit(0);
}

if (argv.includes("--handoff")) {
  // 批 305:交接文件从事实生成(只读;--out 写一个文件,写后回读核对)。各段的取数与「取不到」口径见 buildHandoff 头注。
  const i = argv.indexOf("--handoff");
  const rest = argv.filter((_, k) => k !== i);
  let out = null;
  if (rest.length) {
    if (rest[0] !== "--out" || rest.length !== 2 || !String(rest[1] || "").trim() || /^--/.test(rest[1])) { console.error("用法: --handoff [--out <路径>]"); process.exit(2); }
    out = path.resolve(rest[1]);
    try { if (fs.statSync(out).isDirectory()) { console.error(`--out 指向的是一个目录:${out}——给一个文件路径`); process.exit(2); } } catch { /* 不存在 ⇒ 新建 */ }
  }
  const text = await buildHandoff();
  process.stdout.write(text);
  if (out) {
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, "utf8");
      if (fs.readFileSync(out, "utf8") !== text) throw new Error("回读与写入的内容不一致");
      console.error(`已写入 ${out}(${Buffer.byteLength(text, "utf8")} 字节,已回读核对)`);
    } catch (e) { console.error(`--out 写不进去:${out}(${e.code || e.message})`); process.exit(2); }
  }
  process.exit(0);
}

if (argv.includes("--arm")) {
  const batch = argv[argv.indexOf("--arm") + 1];
  let conds, checks;
  try { ({ conds, checks } = parseArm(argv)); } catch (e) { console.error(`用法错误:${e.message}`); process.exit(2); }
  if (!batch || !conds.length) { console.error("用法: --arm <批号> --cond \"条件\" [--check \"命令\" [--expect \"子串\"]] [--cond …]"); process.exit(2); }
  let armMeta;   // 批 305:开批记录旗标(只记录)
  try { armMeta = parseArmMeta(argv); } catch (e) { console.error(`用法错误:${e.message}`); process.exit(2); }
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
  // 批 256b BP-3 → 批 298:--force 换批覆盖未结清的批,原先点名「以下不再被任何 --clear 核对」后丢掉;
  //   现在它名下未清的义务(决定 / 成果 / 承重面零决定,以及产生器建的)原样带进新批,新批 --clear 照样核(287 设计 2.7 禁丢)。
  //   台账行改名 force-carry-obligations(字段不变,续排编号照认)。
  const forced = argv.includes("--force");
  const needCarry = !!(cur && !cur.cleared && !sameOpen);
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
  // 批 298:carriedFrom = 被本批换掉的那一批的键。义务账带入若在写台账那一步失败,--clear 按它补带(不留孤儿)。
  // 批 298 r1(codex §1 / BP-1):上一批的身份以武装台账为准(状态文件可被改);同号重放沿用台账里的 armedAt / 基点
  const curRow = cur && cur.batch ? lastArmRow(cur.batch) : null;
  const trueCur = cur && curRow ? { ...cur, ...(typeof curRow.armedAt === "string" ? { armedAt: curRow.armedAt } : {}), ...(!cur.cleared ? { baseCommit: curRow.baseCommit ?? null } : {}) } : cur;
  const armedAtT = sameOpen && typeof trueCur.armedAt === "string" && trueCur.armedAt ? trueCur.armedAt : armedAt;
  const baseCommitT = sameOpen ? (typeof trueCur.baseCommit === "string" ? trueCur.baseCommit : null) : baseCommit;
  const key0 = batchKeyOf(trueCur);
  const carriedFrom = needCarry ? key0 : (sameOpen && cur.carriedFrom ? cur.carriedFrom : null);
  // 批 305:开批记录(指令 / 终点线 / 上限)。同号未结清的重放不带旗标 ⇒ 原样保留;带了 ⇒ 按新给的记(上限按项合并)。
  //   一项都没有 ⇒ 批状态与 arm 行里都不出现这几个键(老用法的落盘内容不变)。定位指令只读转录,失败只记「未定位」,不拦开批。
  const metaKept = sameOpen ? pickArmMeta(cur) : {};
  const metaState = { ...metaKept,
    ...(armMeta.instruction ? { instruction: locateInstructionForArm(armMeta.instruction) } : {}),
    ...(armMeta.finishLine !== undefined ? { finishLine: armMeta.finishLine } : {}),
    ...(armMeta.caps ? { caps: { ...(metaKept.caps || {}), ...armMeta.caps } } : {}) };
  const newState = { batch, conditions: conds, checks, shell: "bash", armedAt: armedAtT, baseCommit: baseCommitT, ...(armedBy ? { armedBy } : {}), ...kept, ...carry, ...(carriedFrom ? { carriedFrom } : {}), ...metaState };
  const newKey = { batch: String(batch), armedAt: armedAtT };
  // 批 298 r2(codex ③ / 红队 BP-6):--arm 自身也核上一批的身份;对不上 ⇒ 按武装台账恢复(trueCur),并说出来
  if (cur && !cur.cleared) { const id = armIdentity(cur, curRow); if (!id.ok && curRow) console.error(`注意:批 ${cur.batch} 的状态文件与武装台账对不上(${id.why})——按武装台账的身份${needCarry ? "导入并带入" : "重放"}`); }
  // 批 298 r2(codex ② / 猎手 FB-2):义务账丢失的人工确认出路——只在锚对不上时可用,记进 hash 链台账
  const acceptLoss = argv.includes("--accept-obligation-loss") ? String(argv[argv.indexOf("--accept-obligation-loss") + 1] || "").trim() : null;
  // 批 298 r2(猎手 FB-5):arm 行在写批状态**之前**、同一把义务账锁里写;写不进去 ⇒ 拒武装、批状态与义务账都不动(无需事后回滚)
  const armRow = { batch, conditions: conds, checks, shell: "bash", overwrote: cur?.batch ?? null, baseCommit: baseCommitT, armedAt: armedAtT, ...(forced ? { forced: true } : {}), ...(sidEnv ? { armedBy: sidEnv } : {}), ...metaState };   // forced:批 278;armedBy:批 281;armedAt:批 298 r1;metaState:批 305
  let armRowErr = null;
  // 批 298 r3(codex ① / 红队 BP-1):arm 行自带武装那一刻的锚(义务账当时的末行);义务账不可信 / 取不到 ⇒ anchorUnknown:true
  //   (lastOblAnchor 遇到它继续往前找,不让「账坏时武装」或「arm 行落盘后批状态写失败」把旧锚抹掉)。义务账可信但还空 ⇒ oblHead:null
  let armAnchor = { anchorUnknown: true };
  const writeArmRow = () => { try { fs.mkdirSync(path.dirname(JOURNAL), { recursive: true }); ledgerAppend(JOURNAL, { at: new Date().toISOString(), action: "arm", ...armRow, ...armAnchor }); } catch (e) { armRowErr = e; throw e; } };
  // 批 298 r3(猎手 FB-1):确认丢失那一行已落盘、武装又因别的原因失败 ⇒ 如实说,并告诉重跑时去掉 --accept-obligation-loss
  //   (那一行是扫锚的停点,重跑不带它即可放行;再带一次会因「锚对得上」被拒)
  let acceptWritten = false;
  const acceptNote = () => { if (acceptWritten) console.error("  注意:义务账丢失的确认已记进批台账(多了一行 accept-obligation-loss)——重跑时去掉 --accept-obligation-loss。"); };
  const refuseArmRow = () => { console.error(`拒绝武装:批台账 ${JOURNAL} 写不进去(${armRowErr.code || armRowErr.message})——批状态与义务账都没动${acceptWritten ? "(批台账只多了那一行确认)" : ""}。\n  出路:查文件占用 / 只读属性 / 磁盘后重跑同一条 --arm。`); acceptNote(); process.exit(2); };
  let wrote = false, writeErr = null, carryOut = null, oblErr = null, oblHead = null;
  const doWrite = () => { try { atomicWrite(newState, seenVersion); wrote = true; } catch (e) { writeErr = e; throw e; } };
  {
    const sd = OB.storeDir();
    if (sd.unknown) oblErr = sd.why;
    else {
      const snap = OB.readStore(sd.dir);
      if (OB.TRUSTED.has(snap.kind)) armAnchor = snap.ledgerHead ? { oblHead: { h: snap.ledgerHead, version: snap.version } } : { oblHead: null };
      // 批 298 r1(codex §2):每次 --arm 前核外部锚(整本删后同号重武装、截尾都在这里被抓)
      const ap = OB.TRUSTED.has(snap.kind) ? anchorProblem(snap) : null;
      if (ap && !acceptLoss) {
        console.error(`拒绝武装:${ap}。\n  出路:停下告诉用户——义务账被整本换过或截短,本层无法自证;不得删批台账绕过。用户确认丢失后:原命令加 \`--accept-obligation-loss "<理由>"\`(记一行,收尾报告须写明)。`);
        process.exit(2);
      }
      if (acceptLoss !== null && !ap) { console.error("用法错误:--accept-obligation-loss 只在义务账锚对不上时可用;现在锚对得上,去掉它。"); process.exit(2); }
      if (ap && acceptLoss) {
        try { fs.mkdirSync(path.dirname(JOURNAL), { recursive: true }); ledgerAppend(JOURNAL, { at: new Date().toISOString(), action: "accept-obligation-loss", batch, reason: acceptLoss, lostAnchor: lastOblAnchor(), problem: ap, storeHead: { h: snap.ledgerHead, version: snap.version }, ...(sidEnv ? { by: sidEnv } : {}) }); }
        catch (e) { console.error(`拒绝武装:确认丢失的那一行写不进批台账(${e.code || e.message})——不记就不放行`); process.exit(2); }
        acceptWritten = true;
        console.log(`\n████ 义务账丢失已由执行者确认 ████\n  ${ap}\n  理由:${acceptLoss}\n  已记入批台账(accept-obligation-loss 行,含丢失前的锚)。**收尾报告须写明这一项。**\n`);
      }
      try {
        const ctx = oblCtx();
        // 锁外先算好慢活(git):HEAD、两批的配置快照
        const headNow = headCommit();
        const recs0 = OB.TRUSTED.has(snap.kind) ? snap.obligations : [];
        const curConf = cur && !cur.cleared ? snapshotConfig(batchConfig(trueCur, recs0)) : null;
        const newConf = snapshotConfig(sameOpen ? batchConfig(newState, recs0) : effectiveConfig(newState));
        // 带入、arm 行、写批状态在同一把锁里:任一步失败 ⇒ fn 抛 ⇒ 义务账一行不落;arm 行写不进 ⇒ 批状态也不写
        //   批 298 r2(codex ③):带入时导入用 trueCur(武装台账的基点),不用状态文件里可被改的那个
        const res = OB.mutateStore(sd.dir, (draft) => { const c = armCarry(draft, trueCur, newKey, ctx, { head: headNow, forced, key0, curConf }); syncCurrent(draft, newState, ctx, "batch-goal:arm", newConf); writeArmRow(); doWrite(); return c; });
        carryOut = res.result; oblHead = { h: res.head, version: res.version };
      } catch (e) {
        if (armRowErr) refuseArmRow();
        if (writeErr) { console.error(writeErr.message); acceptNote(); process.exit(2); }
        oblErr = `${e.code || ""} ${e.message}`.trim();
      }
    }
  }
  // 批 298 r1(猎手 FB-7):非 git 目录取不到义务账、而旧批名下本来就没有可带的东西(没登记决定 / 成果,也没有更早的带入)⇒ 不拒
  const nothingToCarry = needCarry && !arr(cur.decisions).length && !arr(cur.outcomes).length && !cur.carriedFrom;
  if (oblErr && !wrote) {
    if (needCarry && !(nothingToCarry && OB.storeDir().unknown)) {
      console.error(`拒绝武装:批 ${cur.batch} 还没结清,换批要把它名下未清的义务带进批 ${batch},可义务账判不了(${oblErr})。`);
      console.error(`  不带就换批 = 把义务悄悄丢掉(287 设计 2.7 禁止)。出路:义务账被改过 ⇒ \`--repair-obligations\`;锁被占 ⇒ 过一会儿重跑;链断 ⇒ 停下告诉用户。`);
      acceptNote();
      process.exit(2);
    }
    console.error(`⚠ 义务账判不了(${oblErr})——本次武装照常(没有要带的);在它恢复可信之前 --clear 会拒清,出路见那时的提示`);
    try { writeArmRow(); } catch { refuseArmRow(); }
    try { atomicWrite(newState, seenVersion); } catch (e) { console.error(e.message); acceptNote(); process.exit(2); }
  } else if (oblErr) console.error(`⚠ 批状态已写,义务账台账没写全(${oblErr})——新批记了 carriedFrom,--clear 时补带`);
  if (needCarry && (arr(cur.decisions).length || arr(cur.outcomes).length)) {
    journal("force-carry-obligations", { batch: cur.batch, newBatch: batch, decisions: arr(cur.decisions), outcomes: numberOutcomes(cur.outcomes).map((o) => ({ o: `O${o.n}`, text: o.text })) });
  }
  // 外部锚:arm 行已在锁里写过(那时还不知道义务账新末行),这里补记一行 obl-head;写不进只出声(锚落后但仍在台账里)
  if (oblHead) journal("obl-head", { batch, oblHead });
  if (carryOut) {
    if (carryOut.carried.length) {
      console.error(`注意:批 ${cur?.batch} ${cur?.cleared ? "" : "未结清就"}被换掉,它名下 ${carryOut.carried.length} 条未清的义务原样带进批 ${batch}(--clear 照样核;已记义务账 adopt 行):`);
      for (const r of carryOut.carried) console.error(`  ${fmtRec(r)}`);
    }
    if (carryOut.reopened.length) {
      console.log(`⚠ **转欠账到期未结的义务 ${carryOut.reopened.length} 条回到开着**,并入本批(本批 --clear 照样核):`);
      for (const r of carryOut.reopened) console.log(`  ${fmtRec({ ...r, status: "open" })}`);
    }
    if (carryOut.reopenedOthers.length) console.log(`⚠ 转欠账到期未结、但是别的 checkout 的义务 ${carryOut.reopenedOthers.length} 条回到开着(未归属,不并入本批,--status 列出):${carryOut.reopenedOthers.map((r) => fmtRec({ ...r, status: "open" })).join(";")}`);
    if (carryOut.adopted.length) {
      console.log(`本 checkout 未归属的义务 ${carryOut.adopted.length} 条并入本批:`);
      for (const r of carryOut.adopted) console.log(`  ${fmtRec(r)}`);
    }
  }
  mirrorToMain("arm", armRow);   // 批 305:工作树里开的批,主树也看得到(只在工作树里才写;写不进只出声)
  console.log(`已武装批 ${batch} 的 ${conds.length} 条完成条件${checks.length ? `(其中 ${checks.length} 条带可执行判据,--clear 时经 bash 跑)` : ""};收尾时须逐条写「条件N:达成/未达成/不适用」`);
  for (const c of checks) console.log(`  条件${c.i + 1} ⇐ $ ${c.cmd}${c.expect !== undefined ? `  期待含「${c.expect}」` : ""}${c.expectRe !== undefined ? `  期待匹配 /${c.expectRe}/` : ""}`);
  for (const l of armMetaLines(metaState)) console.log(`  ${l}`);   // 批 305:记了才打
  // ── 到期债强制腿(2026-08-22,用户逼出:「失效期是装饰品——D34/D35 ≤080 早到期,没人查」)──
  //   立法史:词表路线(Q 的 defer 正则)已判死(B 扩表实败 + xros non-goal + Q「确无结构判据」),
  //   「推迟」的结构载体 = 批条件 + 带失效期的债表;失效期没有执行腿 ⇒ 装饰品。
  //   本腿在**开工时刻**(--arm = 唯一必经的结构点)机械列出到期未结的债,不靠散文不靠词表。
  //   一期只警不拦(拦会把「开工」堵死在还债上——比例归人判);连续多批仍列 ⇒ 升级另议。
  try {
    const rows = debtTableRows();   // 批 305:读表抽成 debtTableRows(--handoff 复用;读不到照旧抛到下面的 catch)
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
  for (const l of hotLegLines(fpReport(["--hot"]))) console.log(l);
  process.exit(0);
}

/** 开批时「误报率待修」那一段要印的行(纯函数,自测直接调)。入参 = `hook-stop-closure --fp-report --hot` 的 stdout。
 *  · 报表自己的完整性告警(台账断链 / 坏行)原样转出——开批只留「待修」行会把它们滤掉(codex 258-cond34-r1 附节);
 *  · 批 305:有待修行时把报表首行的口径句(「口径:」开头)也转出一行——待修行是那张表的摘录,口径跟着走;
 *    没有待修行 ⇒ 不印口径句(没有表可注);报表没带口径句(旧版 hook)⇒ 照旧只列待修行。 */
export function hotLegLines(hotRep) {
  const lines = String(hotRep || "").split("\n");
  const out = lines.filter((l) => /^(🔴|⚠)/.test(l));
  const hot = lines.filter((l) => l.startsWith("待修 "));
  if (hot.length) {
    out.push(`⚠ **误报率待修的规则 ${hot.length} 条**(误报率 ≥15% 且报警 ≥20;本批要么修判据,要么在收尾对照里写明为什么不修):`);
    const scope = lines.find((l) => l.startsWith("口径:"));
    if (scope) out.push("  " + scope);
    for (const l of hot) out.push("  " + l.replace(/^待修 /, "").replace(/\s*← 下一批待修\s*$/, ""));
  }
  return out;
}

/** 批 292 红队 BP-1:候选台账由 Stop hook 写在**主树**(`$CLAUDE_PROJECT_DIR` 即主 checkout)的 `.claude/` 下;
 *  在 worktree 里跑 `--clear` 时按 cwd 相对路径读,读到的是 worktree 里不存在的那一份 ⇒ 永远「零」。
 *  改按 git 公共目录定主树:`git rev-parse --path-format=absolute --git-common-dir` 的上一级。取不到 ⇒ 退回 cwd 相对(旧行为)。 */
export function candidateLedgerPath(git = (args) => spawnSync("git", args, { encoding: "utf8", windowsHide: true })) {
  try {
    const r = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const d = r && r.status === 0 ? String(r.stdout || "").trim() : "";
    if (d) return path.join(path.dirname(d), ".claude", ".gate-candidates.jsonl");
  } catch { /* 退回 */ }
  return ".claude/.gate-candidates.jsonl";
}

/** 批 292:候选台账(只记账档命中)按 `since` 起汇总成一行;没有命中 ⇒ 「零命中」一行(也要出声,沉默分不清是零还是没读)。
 *  台账文件不存在 ⇒ 「零命中(台账未建)」。纯读,`file` 可注入供自测。 */
export function candidateSummary(since, file = candidateLedgerPath()) {
  const t0 = Date.parse(String(since || ""));
  // 红队 附节三④:武装时刻缺 ⇒ 原来 t0=NaN 把历史全量计进来;现在明说不汇总(不给一个会误导的数)
  if (!Number.isFinite(t0)) return "── 只记账档本批命中:本批武装时刻缺,不汇总 ──";
  if (!fs.existsSync(file)) return "── 只记账档武装以来命中:零(台账未建)──";
  const n = {}, samples = [];
  let rows = 0, bad = 0;
  for (const ln of fs.readFileSync(file, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    let x; try { x = JSON.parse(ln); } catch { bad++; continue; }
    // codex fix-r1 §4:合法 JSON 但结构坏(不是对象 / 时刻解析不了 / hits 不是数组)也算坏行,不能报成干净的零
    if (!x || typeof x !== "object" || !Number.isFinite(Date.parse(String(x.ts || ""))) || !Array.isArray(x.hits)) { bad++; continue; }
    if (!(Date.parse(String(x.ts || "")) >= t0)) continue;
    rows++;
    for (const h of Array.isArray(x.hits) ? x.hits : []) {
      if (!h || typeof h !== "object" || typeof h.id !== "string" || !h.id) { bad++; continue; }   // codex fix2-r1:元素结构坏也计坏行
      n[h.id] = (n[h.id] || 0) + 1;
      // codex 292-wording-review-r1 §3:一行数字之外给少量可追溯样本(规则 + 原句片段 + 会话 / 条目位置),供逐条判拦对 / 拦错
      if (samples.length < 3) samples.push(`  · ${h.id} @${String(x.sid || "?").slice(0, 8)}#${x.at ?? "?"}:${String(h.msg || h.first || "").replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  // codex §3 / §5:只按时间归集(武装以来,各会话合计)——并发会话的命中也在内,文案照实说,不叫「本批」;坏行不报成零
  const badNote = bad ? `;坏行 ${bad}(未计入,台账可能缺损)` : "";
  const parts = Object.entries(n).sort((a, b) => b[1] - a[1]).map(([id, c]) => `${id}×${c}`);
  return parts.length
    ? `── 只记账档武装以来命中(各会话合计,${rows} 轮${badNote}):${parts.join("、")} ── 明细 ${file}\n${samples.join("\n")}\n  (D200:连续 5 批无人据此改动 ⇒ 做真阳性回放,再定删不删)`
    : `── 只记账档武装以来命中:零${badNote} ──`;
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
  // 批 309:关账侧的 P 判定在这里也报(同一个判定;发车脚本的验收硬门跑的是 --dry-check,在并回基分支之前)。
  //   欠审 ⇒ 退出 2,stderr 带「N 条未过」(发车脚本当一次验收不过,回修补得上);判不了 ⇒ 退出 2,不带那几个字(发车脚本按判不了停)。
  const er = await loadBearingReview(g);
  const erWaived = (er.status === "missing" || er.status === "unknown") ? reviewWaiver(g, readFpRows()) : null;
  const erBad = (er.status === "missing" || er.status === "unknown") && !erWaived;
  const erReport = () => {
    if (erBad) {
      console.error(`BATCH-GOAL-DRY-CHECK reason=review-${er.status}`);
      printReview(er, g, er.status === "missing"
        ? `批 ${g.batch}:关账前还有 1 条未过——本批有${reviewWhat(er)},复核通道没跑齐(规则 P;--clear 会以 review-missing 拒)。`
        : `批 ${g.batch}:关账前判不了——本批有${reviewWhat(er)},复核有没有跑齐判不了(规则 P;--clear 会以 review-unknown 拒)。`);
    } else if (erWaived) console.log(`提示:承重面复核${er.status === "missing" ? "没跑齐" : "判不了"},按本批记的 P 误报放行(${String(erWaived.h).slice(0, 8)});收尾报告须写明。`);
    else if (er.status === "soft") console.log(`提示:${er.line}`);
    else if (er.status === "skip") console.log(`提示:承重面复核这一项没查——${er.why}`);
  };
  const fails = runChecks(g); const n = (g.checks || []).length;
  if (!n) { erReport(); if (erBad) process.exit(2); console.log(`批 ${g.batch}:${g.conditions.length} 条条件均无可执行判据`); process.exit(0); }
  if (fails.length) { console.error(`批 ${g.batch}:${n} 条判据,${fails.length} 条未过`); printCheckFails(fails, g); erReport(); process.exit(2); }
  erReport(); if (erBad) process.exit(2);
  console.log(`批 ${g.batch}:${n} 条可执行判据全过`); process.exit(0);
}

if (argv.includes("--history")) {
  // 「小 git」的 log:任何一次覆盖都能从这儿翻回来
  let lines = [];
  try { lines = fs.readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean); } catch { lines = []; }
  // 批 305:主树里把各工作树镜像过来的 arm / clear 行按时间并进来(工作树里只看自己的;见 mirrorToMain 头注)
  let mirrored = [];
  try { const lay = checkoutLayout(); if (!lay.unknown && !lay.linked) mirrored = fs.readFileSync(worktreeJournalFile(lay), "utf8").split("\n").filter(Boolean); } catch { mirrored = []; }
  if (!lines.length && !mirrored.length) { console.log("无历史(.claude/.batch-goal.jsonl 不存在或为空)"); process.exit(0); }
  const n = Number(argv[argv.indexOf("--history") + 1]) || 10;
  const parse = (ls) => ls.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.action);   // genesis/非事件行(ledger-chain 链首)不进历史视图
  for (const o of mergeHistoryRows(parse(lines), parse(mirrored)).slice(-n)) {
    const when = String(o.at).slice(11, 19);
    const extra = (o.overwrote ? `  ⚠️ 覆盖了批 ${o.overwrote}` : "") + (o.worktree ? `  〔工作树 ${o.worktree}${o.branch ? ` · ${o.branch}` : ""}〕` : "");
    console.log(`  ${when}  ${o.action.padEnd(5)} 批 ${o.batch ?? "—"}  ${(o.conditions || []).length} 条${extra}`);
    for (const c of (o.conditions || [])) console.log(`           · ${typeof c === "string" ? c : c.text}`);
    if (o.action === "accept-obligation-loss") console.log(`           ⚠ 确认义务账丢失 —— 理由:${o.reason};丢失前锚 ${o.lostAnchor ? `第 ${o.lostAnchor.version} 行` : "无"}`);
  }
  process.exit(0);
}

// ⚠️ 被 import 时到此**什么都不做**。原实现在这里无条件 `exit(2)`,
//   于是守卫算对了也没用——调用方照样被这句用法错误杀掉(实测复现)。
if (IS_MAIN) {
  console.error("用法: --arm <批号> --cond \"…\" [--check \"命令\" [--expect \"子串\" | --expect-re \"正则\"]] [--force] [--instruction \"<原话>\" [--instruction-session <会话号>] [--instruction-at <时刻>]] [--finish-line \"<终点线>\"] [--cap-usd <美元>] [--deadline <时刻>] | --ruler | --handoff [--out <路径>] | --decision \"<决定>\" | --no-decision \"<为什么本批没有决定>\" | --outcome \"<成果>\" | --withdraw <批号-Dn | On | 批号:On> --reason \"<理由>\" | --status | --context | --dry-check | --clear [--verdict \"N=达成|未达成|不适用[:理由]\"]… | --settle [<义务 id>] | --repair-obligations | --history [n] | --self-test");
  process.exit(2);
}
