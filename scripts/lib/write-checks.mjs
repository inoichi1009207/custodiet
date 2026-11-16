// write-checks.mjs —— 写入类拒绝点 T / MF / J / M 的两层实现(批 301;设计稿 clipboard/301-design.md v2;287 设计 2.2、2.7)
//
// 本文件的测试(write-checks.selftest.mjs)防的失败:
//   ① 用 Edit / Write / MultiEdit 把债表失效期改空、写出缺执行面的「以后都这样」memory、把规矩文件改到 verify-laws 不过——写进去了没人拦;
//   ② 用 sed / node 脚本 / PowerShell / 子代理写同样的东西——事前谁也看不见,关账时也没人查;
//   ③ shell 写入静默没生效(替换没命中、退出码 0),文件一字未动,却当成改好了(M);
//   ④ 判不了(列数异常、git 取不到、转录读不了、写目标定位不了、写前哈希没记全)被当成「没事」放过;
//   ⑤ 反方向:诚实的小改、改前就有的旧问题被拦(误拦)。
//
// ── 两层(287 2.2「两层」;任务单第 1 条)──────────────────────────────────────────────
//   写前(hook-guard PreToolUse,Edit / Write / MultiEdit):按「应用编辑以后的整份文件」校验,只拒**这次新引入**的不合格
//     (T 按 D 号认、J 按问题稳定键认、MF 按「改前就缺 + 全是小改」豁免);算不出改后全文 / 判不了 / 校验出错 ⇒ 不拒(关账接住)。
//   关账(batch-goal --clear,锁外取证 planWriteChecks + 锁内落笔 applyWriteChecks):对本批改过的文件、以及本批名下已有的
//     写入类义务,读**此刻的内容**整份校验;不合格 ⇒ open;判不了 ⇒ unknown(按开着算,拒关账)。
//   「本批改过哪些文件」= `git diff --name-only <基点> HEAD` + 未跟踪未忽略文件(D116 先于此保证没有未提交的已跟踪改动)
//     + memoryDirs 里 mtime ≥ armedAt 的 memory 文件。不逐轮观测(299b 已删快照)。
//
// ── 记账点(四问见设计稿第 1.5 节)──────────────────────────────────────────────────────
//   <主 checkout>/.claude/.write-approvals.jsonl  PreToolUse:写前**正面判过**「改前就缺执行面、这次全是小改」而放行的那次 memory 写,
//                                                 记预期改后全文的 sha256(不是工具成功后的盘上内容)。关账时此刻内容等于它 ⇒ 不当 shell 写入判。
//   <主 checkout>/.claude/.write-prehash.jsonl    PreToolUse Bash / PowerShell:先记一行 attempt(pending),再记一行 pre(写前内容哈希);
//                                                 定位不了的写目标记 unlocated。
//   失败标记:主账写不进去 ⇒ <主 checkout>/.claude/.write-prehash-failed.jsonl;再不行 ⇒ 系统临时目录下按主 checkout 命名的一份。
//   全部只追加单行 JSON;读的一方坏行跳过。gitignore 面(.claude/*)与临时目录,不进产物。
//
// ── 义务类型(产生器类型,走 obligations.applyEvaluation;没有任何 CLI 能标已清)──────────────
//   write-debt-schema(T)/ write-memory-face(MF)/ write-law-verify(J)/ write-readback(M)。一条义务 = (类型, 文件)。
//   每次 --clear 重算(含带入的);已清后又不合格 ⇒ 重开;settling / settled 只认已清(applyEvaluation 口径)。
//
// 天花板(CEILING):T 只证失效期列非空;MF 只证那一行执行面在;J 只证 verify-laws 过;M 的触发只认 bashWriteTargets 解析得出的
//   写目标(node 脚本内部写、解析不出目标的命令不触发),清只证「写进去了 / 写后成功读过」不证写对。
// CALIBRATED=false。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as OB from "./obligations.mjs";
import { checkDebtTable, introducedBad, introducedUnknown } from "./debt-schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TYPES = Object.freeze({ T: "write-debt-schema", MF: "write-memory-face", J: "write-law-verify", M: "write-readback" });
const TYPE_SET = new Set(Object.values(TYPES));
export const isWriteCheckType = (t) => TYPE_SET.has(t);
const HASH_MAX = 512 * 1024 * 1024;
const SCAN_BUDGET = 800 * 1024 * 1024;

// ── 路径 ─────────────────────────────────────────────────────────────────────────────
const slash = (p) => String(p).replace(/\\/g, "/");
/** 比较用的路径键:绝对、`/` 分隔、Windows 上不分大小写。 */
export const pkey = (p) => { const r = slash(path.resolve(String(p))); return process.platform === "win32" ? r.toLowerCase() : r; };

/** 从 start 往上找 `.git`:返回 { root:工作树根, main:主 checkout(git 公共目录的上一级) };找不到 ⇒ null。只读文件系统,不起 git。 */
export function checkoutOf(start) {
  let d = path.resolve(String(start || "."));
  try { if (fs.statSync(d).isFile()) d = path.dirname(d); } catch { /* 不存在就按目录往上找 */ }
  for (let i = 0; i < 64; i++) {
    const g = path.join(d, ".git");
    let st = null; try { st = fs.lstatSync(g); } catch { st = null; }
    if (st) {
      if (st.isDirectory()) return { root: d, main: d };
      try {
        const m = fs.readFileSync(g, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
        if (m) {
          const gd = path.resolve(d, m[1]);
          let common = gd;
          try { common = path.resolve(gd, fs.readFileSync(path.join(gd, "commondir"), "utf8").trim()); } catch { /* 不是 worktree 的 gitdir 文件 ⇒ 用 gitdir 本身 */ }
          return { root: d, main: path.dirname(common) };
        }
      } catch { /* 读不了 .git 文件 ⇒ 当普通目录 */ }
      return { root: d, main: d };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** Claude Code 项目目录名(与 fp-audit.mjs 同一换算:非字母数字一律换成 -)。 */
export const projectDirName = (p) => String(path.resolve(p)).replace(/[^A-Za-z0-9]/g, "-");

/** 安装方配置 memoryDirs ⇒ 绝对目录列表。`@claude-project-memory` / `~/…` / 其余相对主 checkout(允许 ..)/ 绝对。
 *  批 301 红队 BP-3:仓内相对路径(不以 .. 起头)**同时**按当前 checkout 根解析——worktree 会话写自己 worktree 下的
 *  `.claude/agent-memory/` 也要管。 */
export function resolveMemoryDirs(list, mainRoot, home = os.homedir(), checkoutRoot = null) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v);
    if (s === "@claude-project-memory") out.push(path.join(home, ".claude", "projects", projectDirName(mainRoot), "memory"));
    else if (/^~[\\/]/.test(s)) out.push(path.join(home, s.slice(2)));
    else {
      out.push(path.resolve(mainRoot, s));
      if (checkoutRoot && !path.isAbsolute(s) && !/^\.\.(?:[\\/]|$)/.test(s)) out.push(path.resolve(checkoutRoot, s));
    }
  }
  return [...new Map(out.map((d) => [pkey(d), d])).values()];
}

/** abs 是不是某个 memory 根下的 .md(索引除外:根下的 MEMORY.md;agent-memory 类根下 <名>/MEMORY.md)。返回所在根或 null。 */
export function memoryRootOf(abs, roots) {
  const k = pkey(abs);
  if (!/\.md$/i.test(k)) return null;
  for (const r of roots) {
    const rk = pkey(r);
    if (!k.startsWith(rk + "/")) continue;
    const rel = k.slice(rk.length + 1);
    if (/^memory\.md$/i.test(rel)) return null;
    if (/agent-memory[^/]*$/i.test(rk) && /^[^/]+\/memory\.md$/i.test(rel)) return null;
    return r;
  }
  return null;
}

/** 规矩文件(J):verify-laws 的 RULE_FILES + 退役目录 docs/laws/ 下的 .md。返回仓根相对路径或 null。 */
export function lawRelOf(abs, root) {
  if (!root) return null;
  const rel = slash(path.relative(root, abs));
  if (!rel || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  const cmp = process.platform === "win32" ? rel.toLowerCase() : rel;
  if (cmp === "agents.md") return "AGENTS.md";
  if (cmp === "docs/gate/agents.md") return "docs/gate/AGENTS.md";
  if (/^docs\/laws\/[^/]+\.md$/i.test(rel)) return rel;
  return null;
}

/** 内容哈希(真内容,流式):不在 ⇒ absent;目录 ⇒ dir;超过上限 / 读不了 ⇒ null(判不了)。 */
export function contentHash(abs, onErr = null) {
  // onErr(why):判不了的原因交给调用方出声(批 301 主会话:写前哈希读取异常不许吞)
  const fail = (why) => { try { if (onErr) onErr(why); } catch { /* 出声失败不影响结论 */ } return null; };
  let st;
  try { st = fs.statSync(abs); } catch (e) { return e && e.code === "ENOENT" ? "absent" : fail(`stat ${e?.code || e?.message}`); }
  if (st.isDirectory()) return "dir";
  if (st.size > HASH_MAX) return fail(`超过 ${Math.round(HASH_MAX / 1048576)}MB`);
  let fd;
  try {
    fd = fs.openSync(abs, "r");
    const h = crypto.createHash("sha256"), buf = Buffer.alloc(4 * 1024 * 1024);
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; h.update(n === buf.length ? buf : buf.subarray(0, n)); }
    return h.digest("hex");
  } catch (e) { return fail(`读 ${e?.code || e?.message}`); }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* 关不了不影响结论 */ } }
}
const shaText = (s) => crypto.createHash("sha256").update(Buffer.from(String(s), "utf8")).digest("hex");

/** 台账目录 = <主 checkout>/.claude。改道只在 hook-guard 自测里认(GATE_HOOK_GUARD_SELFTEST=1 + WRITE_CHECKS_LEDGER_DIR),
 *  且改道目录必须在系统临时目录下(批 301 红队 BP-4:原来只看两个环境变量,生产会话带上它们即可把台账指到别处、让关账读空账;
 *  现在两个条件缺一不可,否则一律用 <主 checkout>/.claude——这两个环境变量本身仍可被伪造,天花板同 GATE_TOUCH_FILE)。 */
const ledgerDir = (mainRoot) => {
  const o = process.env.WRITE_CHECKS_LEDGER_DIR;
  const ok = process.env.GATE_HOOK_GUARD_SELFTEST === "1" && typeof o === "string" && o && pkey(o).startsWith(pkey(os.tmpdir()) + "/");
  return ok ? o : path.join(mainRoot, ".claude");
};
export const ledgerFiles = (mainRoot) => ({
  approvals: path.join(ledgerDir(mainRoot), ".write-approvals.jsonl"),
  prehash: path.join(ledgerDir(mainRoot), ".write-prehash.jsonl"),
  failed: path.join(ledgerDir(mainRoot), ".write-prehash-failed.jsonl"),
  failedTmp: path.join(os.tmpdir(), `write-prehash-failed-${crypto.createHash("sha256").update(pkey(mainRoot)).digest("hex").slice(0, 16)}.jsonl`),
});
function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}
/** 读一份只追加台账:{ rows, err }。ENOENT ⇒ 空;别的读错误 ⇒ err。坏行跳过。 */
function readLedger(file) {
  let t;
  try { t = fs.readFileSync(file, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? { rows: [] } : { rows: [], err: e.code || e.message }; }
  const rows = [];
  for (const l of t.split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* 坏行跳过(并发写到一半)*/ } }
  return { rows };
}

async function configAt(root) {
  const { readInstallConfig, INSTALL_CONFIG_FILE } = await import("./install-config.mjs");
  return readInstallConfig((f) => fs.readFileSync(path.join(root, f), "utf8"), INSTALL_CONFIG_FILE);
}

// ── MF 判据(同一份实现:gate-rules 的 RULE_MF)─────────────────────────────────────
let MF_CACHE = null;
export async function loadMF() {
  if (MF_CACHE) return MF_CACHE;
  const { RULES } = await import("./gate-rules.mjs");
  const R = RULES.find((r) => r && r.id === "MF");
  if (!R || typeof R.faceOk !== "function" || typeof R.fmType !== "function" || typeof R._smallEdit !== "function") throw new Error("RULE_MF 判据件缺(faceOk / fmType / _smallEdit)");
  return (MF_CACHE = R);
}
/** 这份 memory 正文是不是「以后都这样做」类却没有执行面(原 MF 的触发口径 + faceOk)。 */
export function mfBad(body, MF) {
  const b = String(body ?? "");
  const ty = MF.fmType(b);
  if (ty !== "feedback" && ty !== "user") return false;
  if (ty === "user" && !MF._USER_CUE.test(b.replace(/^\s+/, "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---/, ""))) return false;
  return !MF.faceOk(b);
}

// ── 改后全文 ───────────────────────────────────────────────────────────────────────
/** 套编辑(依次套,后一个编辑作用在前一个的结果上):Write = content;Edit / MultiEdit 逐个 old→new(原样找,找不到再按 CRLF 找)。
 *  任何一个找不到 ⇒ { after:null }(算不出)。 */
export function applyEdits(before, toolName, input) {
  const ti = input || {};
  if (toolName === "Write") return { after: String(ti.content ?? "") };
  const edits = toolName === "MultiEdit" ? (Array.isArray(ti.edits) ? ti.edits : []) : toolName === "Edit" ? [ti] : null;
  if (!edits || before == null) return { after: null };
  let text = before;
  for (const e of edits) {
    const o = String(e?.old_string ?? ""), nw = String(e?.new_string ?? "");
    if (!o) return { after: null };
    let done = false;
    for (const [oo, nn] of [[o, nw], [o.replace(/\r?\n/g, "\r\n"), nw.replace(/\r?\n/g, "\r\n")]]) {
      const i = text.indexOf(oo);
      if (i < 0) continue;
      text = e.replace_all ? text.split(oo).join(nn) : text.slice(0, i) + nn + text.slice(i + oo.length);
      done = true; break;
    }
    if (!done) return { after: null };
  }
  return { after: text };
}

// ── 第一层:写前(hook-guard PreToolUse)──────────────────────────────────────────────
const PRE_READ_MAX = 2 * 1024 * 1024;
/** 返回 { deny: 理由 | null, kind: "T"|"MF"|"J"|null, note?, warn? }。warn = 放行但要出声(读不了 / 超预算 / 记账失败);
 *  任何异常由调用方 try/catch 当放行,并出声 + 记一行写前判定台账(批 301 codex 合并审 r1 ③)。
 *  先按路径判目标属不属于 T / J / MF,不属于就不读文件;属于且超过 2 MB ⇒ 不读、放行并出声(合并审 r1 ⑤)。 */
export async function preWriteVerdict(input, opts = {}) {
  // 批 301 最终裁定(codex 合并审 r3 后,T / MF 已过三轮):**T、MF 退回只记账**——判定照跑,结论不拒,只出声(stderr + .write-precheck.jsonl);
  //   J 照旧写前拒。判定代码(preWriteJudge)原样保留,供 ≤304 独立设计复核重做用。
  const v = await preWriteJudge(input, opts);
  if (v.deny && (v.kind === "T" || v.kind === "MF")) return { deny: null, kind: v.kind, note: `${v.kind}(只提示,拒绝已撤回,待独立设计复核):${v.deny}`, warn: true, wouldDeny: true };
  return v;
}
/** 写前判定本体(T / MF / J)。preWriteVerdict 决定要不要拒。 */
export async function preWriteJudge(input, { repoRoot } = {}) {
  const tool = String(input?.tool_name || "");
  if (!/^(Edit|Write|MultiEdit)$/.test(tool)) return { deny: null, kind: null };
  const fp = input?.tool_input?.file_path;
  if (!fp) return { deny: null, kind: null };
  const base = typeof input.cwd === "string" && input.cwd ? input.cwd : repoRoot || process.cwd();
  const abs = path.resolve(base, String(fp));
  const co = checkoutOf(abs) || checkoutOf(repoRoot || base);
  const cfgRoot = co ? co.root : (repoRoot || base);
  const conf = await configAt(cfgRoot);
  const ok = conf && !conf.error;
  const debtRel = ok ? (conf.debtTable || "docs/gate-debts.md") : "docs/gate-debts.md";
  // 会话项目(钩子环境的 CLAUDE_PROJECT_DIR,缺省 hook 脚本所在的仓)
  const pco = checkoutOf(process.env.CLAUDE_PROJECT_DIR || repoRoot || base) || co;
  // ── 先按路径分类(不读文件)
  let kind = null, lawRel = null, roots = [], mainRoot = pco ? pco.main : cfgRoot;
  if (pkey(abs) === pkey(path.join(cfgRoot, debtRel))) kind = "T";
  else {
    // J:只管本仓 checkout(主树 + 本仓 worktree);别的 git 仓不判(误拦 FB-6);仓里改前就没有 AGENTS.md 的不判(误拦 FB-7)
    const sameRepo = !!(co && pco && pkey(co.main) === pkey(pco.main));
    lawRel = co && sameRepo && fs.existsSync(path.join(co.root, "AGENTS.md")) ? lawRelOf(abs, co.root) : null;
    if (lawRel) kind = "J";
    else {
      // MF:受管目录由会话项目的配置定(codex 301 r1 F1)
      const pconf = pco ? await configAt(pco.root) : null;
      roots = pconf && !pconf.error ? resolveMemoryDirs(pconf.memoryDirs, mainRoot, os.homedir(), pco ? pco.root : null) : [];
      if (roots.length && memoryRootOf(abs, roots)) kind = "MF";
    }
  }
  if (!kind) return { deny: null, kind: null };
  // ── 属于目标:读改前全文(有预算)
  let before = null, beforeErr = null, size = 0;
  try { size = fs.statSync(abs).size; } catch (e) { if (e.code !== "ENOENT") beforeErr = e.code || e.message; }
  if (!beforeErr && size > PRE_READ_MAX) return { deny: null, kind, note: `改前文件 ${Math.round(size / 1048576)}MB 超过写前读取预算 2MB ⇒ 写前不判(关账层照判)`, warn: true };
  if (!beforeErr) { try { before = fs.readFileSync(abs, "utf8"); } catch (e) { if (e.code === "ENOENT") before = ""; else beforeErr = e.code || e.message; } }
  const existed = before !== null && fs.existsSync(abs);
  if (beforeErr) return { deny: null, kind, note: `改前读不了(${beforeErr})⇒ 写前不判(关账层照判)`, warn: true };

  if (kind === "T") {
    const { after } = applyEdits(before, tool, input.tool_input);
    if (after == null) return { deny: null, kind: "T", note: "算不出改后全文 ⇒ 写前不判" };
    const fresh = introducedBad(before, after);
    // 误拦 FB-8:新引入的列数异常行当场拒(写前就能给出转义写法);既有的不追溯
    const freshCols = introducedUnknown(before, after);
    if (!fresh.length && !freshCols.length) return { deny: null, kind: "T" };
    const parts = [];
    if (fresh.length) parts.push(fresh.length + " 条在账行失效期为空或只是占位(" + fresh.slice(0, 5).map((b) => b.label).join("、") + ")——「Open-ended exceptions are not exceptions; they are undeclared policy changes.」(287 设计 2.2 T 行)。出路:给这几行的「失效期」列写上期限(如 **≤<批号>**、**已结清 <批号>**)");
    if (freshCols.length) parts.push(freshCols.length + " 行切不出 6 列、失效期列定位不了(" + freshCols.slice(0, 5).map((b) => b.label + ":" + b.why).join("、") + ")。出路:描述里的竖线写成反斜杠竖线(\\|),或放进反引号代码段");
    return { kind: "T", deny: "欠账表写入会新引入:\n" + parts.map((p) => "  - " + p).join("\n") + "\n改好再写。判据见 scripts/lib/debt-schema.mjs。" };
  }
  if (kind === "J") {
    const { after } = applyEdits(before, tool, input.tool_input);
    if (after == null) return { deny: null, kind: "J", note: "算不出改后全文 ⇒ 写前不判" };
    const { checkLaws, problemKey } = await import(pathToFileURL(path.join(HERE, "..", "verify-laws.mjs")).href);
    const was = new Set(checkLaws(co.root).problems.map(problemKey));
    const now = checkLaws(co.root, { [lawRel]: after }).problems;
    const fresh = now.filter((p) => !was.has(problemKey(p)));
    if (!fresh.length) return { deny: null, kind: "J" };
    return { kind: "J", deny: `规矩文件 ${lawRel} 改完会让 verify-laws 新增 ${fresh.length} 个问题:\n${fresh.slice(0, 6).map((p) => `  - ${p}`).join("\n")}\n` +
      `出路:按上面逐条改——指针 / 项名写错就改正;指向的文件还没建就先建好再写这一笔;` +
      `只是在叙述里提到、并非指针的路径(历史路径、已删 / 将删的文件),去掉反引号写成普通文字(反引号里以 docs/ scripts/ .claude/ 开头的才当指针核);docs/laws/ 已于 2026-11-05 退役,规矩不放那里。判据 = scripts/verify-laws.mjs 跑在改后全文上(不认正文里的任何字样)。` };
  }
  // MF
  const MF = await loadMF();
  // 窄版(批 301 主会话裁定退回,codex 合并审 r2 F4 后冻结):不再记 seen;仓外 memory 关账层一律只提示
  let warn = false, seenNote = "";
  const { after } = applyEdits(before, tool, input.tool_input);
  if (after == null) return { deny: null, kind: "MF", note: "算不出改后全文 ⇒ 写前不判(不记批准,关账按此刻内容判)" + seenNote, warn };
  if (!mfBad(after, MF)) return { deny: null, kind: "MF", ...(warn ? { note: seenNote.slice(1), warn } : {}) };
  const edits = tool === "Edit" ? [input.tool_input] : tool === "MultiEdit" ? (input.tool_input?.edits || []) : [];
  const small = tool !== "Write" && existed && mfBad(before, MF) && edits.length > 0 && edits.every((e) => MF._smallEdit(e));
  if (small) {
    // 正面判过的豁免 ⇒ 记预期改后全文的哈希(关账时此刻内容等于它才认)
    try { appendLine(ledgerFiles(mainRoot).approvals, { kind: "exempt", at: new Date().toISOString(), p: pkey(abs), h: shaText(after), sid: String(input.session_id || ""), id: String(input.tool_use_id || "") }); }
    catch (e) { warn = true; seenNote += `;批准记账失败(${e.code || e.message})——关账时这份按「非工具写出」判`; }
    return { deny: null, kind: "MF", note: "改前就没有执行面、这次全是小改 ⇒ 放行(批 279 口径),已记批准" + seenNote, warn };
  }
  return { kind: "MF", deny: `这份 memory 是「以后都这样做」类(type: feedback / user),改完没有执行面行(D179)。\n出路:在正文里加一行「执行面:<执行它的文件路径 / 收尾闸规则 id「X 项」/ npm run 脚本 / 登记了候选闸的 D 号>」,或「不可机械化:<理由>」,再写。` };
}

/** 写前判定台账:写前层放行但有话要说(读不了 / 超预算 / 记账失败 / 抛错)时追加一行(合并审 ③:不许静默)。失败只抛给调用方出声。 */
export function logPrecheck(input, row, { repoRoot } = {}) {
  const base = typeof input?.cwd === "string" && input.cwd ? input.cwd : repoRoot || process.cwd();
  const pco = checkoutOf(process.env.CLAUDE_PROJECT_DIR || repoRoot || base);
  if (!pco) throw new Error("找不到会话项目的 git 工作树");
  appendLine(path.join(ledgerDir(pco.main), ".write-precheck.jsonl"), { at: new Date().toISOString(), sid: String(input?.session_id || ""), id: String(input?.tool_use_id || ""), tool: String(input?.tool_name || ""), file: String(input?.tool_input?.file_path || ""), ...row });
}

// ── 记账点:PreToolUse Bash / PowerShell 写前哈希(M 的触发)──────────────────────────────
const shellToks = (seg) => {
  const out = []; let cur = "", q = null, any = false;
  for (const ch of String(seg)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out.map((t) => t.replace(/^(?:\d?>>?|&>>?|>\|)/, "")).filter(Boolean);
};
const TEMP_LIT = /^(?:\$\{?(?:TEMP|TMP|TMPDIR)\}?|%(?:TEMP|TMP)%|\$env:(?:TEMP|TMP))[\\/]/i;

/** 定位一条命令的写目标:[{ abs } | { unlocated: 字面 }]。目标识别用 bashWriteTargets(唯一实现),cd 用 RULE_P._p.walk(唯一实现);
 *  再要求命令段里有一个字面词与解析结果对得上(无损定位),对不上 / 含变量通配 ⇒ unlocated。临时目录下的跳过。 */
export async function locateTargets(cmd, dialect, cwd) {
  const { bashWriteTargets } = await import(pathToFileURL(path.join(HERE, "..", "hook-stop-closure.mjs")).href);
  const { RULES } = await import("./gate-rules.mjs");
  const P = RULES.find((r) => r.id === "P")._p;
  const tmp = pkey(os.tmpdir()), home = os.homedir();
  const out = [];
  const segs = P.walk(cmd, dialect);
  for (const { seg, cwd: cdRel } of segs) {
    let ts = [];
    try { ts = bashWriteTargets(seg, /[\s\S]/, { dialect }); } catch { ts = []; }
    if (!ts.length) continue;
    const toks = shellToks(seg);
    for (const t0 of ts) {
      const t = slash(t0).replace(/^\.\//, "");
      if (!t || t === "/dev/null" || /^nul$/i.test(t)) continue;
      const tt = t.replace(/\/+$/, "");
      // 候选字面:命令词 + 解释器程序串里引号包着的字面量(`node -e "fs.writeFileSync('docs/x.md',…)"`)——都是命令里逐字出现的路径。
      //   分两档:①等同(原样 / Git Bash 的 /d/… 盘符形 / 归一后相等,尾斜杠去掉再比);②以 `/<目标>` 结尾。
      //   取最高一档;该档里解析出的不同路径必须**恰好一个**,否则(源参数与目标同后缀等,codex 301 r1 F3)⇒ 定位不了。
      const norm = (k) => slash(k).replace(/^\.\//, "").replace(/\/+$/, "");
      const exact = (k) => { const s = norm(k); return s === tt || s.replace(/^\/([a-z])\//i, "$1/") === tt || P.resolve(null, s) === tt; };
      const suffix = (k) => norm(k).endsWith("/" + tt);
      const cands = [...toks, ...[...String(seg).matchAll(/(['"`])([^'"`\n]+?)\1/g)].map((m) => m[2])];
      const tier = cands.filter(exact).length ? cands.filter(exact) : cands.filter(suffix);
      // 按候选**字面**去重(批 301 主会话裁定:退回 r2 之前的方式——r2 改成按解析后路径去重,r3 证出它把动态候选
      //   `$env:TEMP/..` 与真实目标合并后跳过了真实写入(漏放)。代价:同一目标写成两种字面 ⇒ 定位不了 ⇒ UNKNOWN,接受)。
      //   **本定位子系统已冻结,不再补形态**;重做方向见设计稿拟登债(不解析命令,改按 git 事实 + Read 记录判)。
      const distinct = [...new Map(tier.map((k) => [norm(k), k])).values()];
      if (distinct.length !== 1) { out.push({ unlocated: String(distinct.length ? distinct.join(" | ") : t0) }); continue; }
      const lit = distinct[0];
      if (TEMP_LIT.test(lit)) continue;
      if (/[$`*?{}%]/.test(lit) || (cdRel && /[$`*?{}%]/.test(cdRel))) { out.push({ unlocated: lit }); continue; }
      const litH = slash(lit).replace(/^~(?=\/)/, slash(home));
      const rel = P.resolve(cdRel, litH);   // 唯一的路径归一:认 Git Bash 的 /d/… 盘符形,保留无法消去的前导 ..
      const abs = path.resolve(cwd, rel);
      // 系统临时目录下、且不在任何 git 工作树里的(scratchpad / 探针)不算业务写入;临时目录里的 git 仓(测试仓)照算
      if ((pkey(abs).startsWith(tmp + "/") || /^\/(?:var\/)?tmp\//.test(slash(lit))) && !checkoutOf(abs)) continue;
      out.push({ abs });
    }
  }
  return out;
}

/** 写前那一刻:先记 attempt(pending),再记写前哈希;定位不了的记 unlocated。失败 ⇒ 失败标记(两处),再抛给调用方出声。返回记下的行数。 */
export async function recordPrehash(input, { repoRoot, located } = {}) {
  const tool = String(input?.tool_name || "");
  if (tool !== "Bash" && tool !== "PowerShell") return 0;
  const cmd = String(input?.tool_input?.command || "");
  if (!cmd.trim()) return 0;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : repoRoot || process.cwd();
  const co = checkoutOf(cwd) || checkoutOf(repoRoot || cwd);
  if (!co) return 0;
  const files = ledgerFiles(co.main);
  const id = String(input.tool_use_id || "") || `noid-${crypto.randomBytes(6).toString("hex")}`;
  const sid = String(input.session_id || "");
  try {
    const ts = located || await locateTargets(cmd, tool === "PowerShell" ? "ps" : "bash", cwd);
    if (!ts.length) return 0;
    const at = new Date().toISOString();
    let n = 0;
    for (const x of ts) {
      if (x.unlocated !== undefined) { appendLine(files.prehash, { kind: "unlocated", at, lit: String(x.unlocated).slice(0, 300), root: pkey(co.root), sid, id, tool }); n++; continue; }
      const p = pkey(x.abs);
      appendLine(files.prehash, { kind: "attempt", at, p, sid, id, tool });   // 先记尝试:哈希读到一半被杀 ⇒ 关账见 attempt 无 pre ⇒ 判不了
      const pre = contentHash(x.abs, (why) => { try { console.error(`hook-guard:写前哈希读不了 ${p}(${why})——记为判不了`); } catch { /* 不阻断 */ } });
      appendLine(files.prehash, { kind: "pre", at, p, pre, sid, id, tool });
      n++;
    }
    return n;
  } catch (e) {
    const row = { at: new Date().toISOString(), sid, id, why: String(e && (e.code || e.message) || e).slice(0, 200) };
    try { appendLine(files.failed, row); } catch { try { appendLine(files.failedTmp, row); } catch { /* 三处都写不进去:只能出声(调用方 stderr)*/ } }
    throw e;
  }
}

// ── 第二层:关账(batch-goal --clear)──────────────────────────────────────────────────
const gitDefault = (cwd) => (args) => spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });

/** 本批改过的工作树内文件(仓根相对)。返回 { paths:Set, err? }。 */
export function changedInBatch(base, git) {
  if (!(typeof base === "string" && base)) return { paths: new Set(), err: "本批没有基点(旧批)——判不了改过哪些文件" };
  const a = git(["diff", "--name-only", "-z", base, "HEAD"]);
  if (!a || a.status !== 0) return { paths: new Set(), err: `git diff ${base.slice(0, 10)}..HEAD 失败(${String(a?.stderr || a?.error?.message || "").trim().slice(0, 120)})` };
  const b = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!b || b.status !== 0) return { paths: new Set(), err: `git ls-files --others 失败(${String(b?.stderr || "").trim().slice(0, 120)})` };
  const s = new Set();
  for (const x of (String(a.stdout || "") + "\0" + String(b.stdout || "")).split("\0")) if (x.trim()) s.add(slash(x.trim()));
  return { paths: s };
}

/** 递归列 .md(深度 ≤3),mtime ≥ since。根目录不存在 ⇒ 零个(换机器 / 公开仓没有那个目录);目录读错误抛;
 *  单个文件 stat 失败(不是 ENOENT)⇒ 记进 out.errs,调用方按判不了处理(codex 301 r1 F6:原来静默跳过)。 */
function recentMd(dir, sinceMs) {
  const out = [];
  out.errs = [];
  const walk = (d, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT" && depth === 0) return; throw e; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!/\.md$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch (e2) { if (e2.code !== "ENOENT") out.errs.push({ p, code: e2.code || e2.message }); continue; }
      if (st.mtimeMs >= sinceMs) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** 转录目录:~/.claude/projects 下主 checkout 名、它的 --claude-worktrees-* 名,以及 `git worktree list` 里每个工作树的名(不分大小写)。 */
export function transcriptDirs(mainRoot, git, home = os.homedir()) {
  const pd = path.join(home, ".claude", "projects");
  const want = new Set([projectDirName(mainRoot).toLowerCase()]);
  try {
    const r = git && git(["worktree", "list", "--porcelain"]);
    if (r && r.status === 0) for (const m of String(r.stdout || "").matchAll(/^worktree (.+)$/gm)) want.add(projectDirName(m[1].trim()).toLowerCase());
  } catch { /* 取不到就只按主 checkout 名 */ }
  const base = projectDirName(mainRoot).toLowerCase();
  let names;
  try { names = fs.readdirSync(pd); } catch { return null; }
  return names.filter((n) => { const l = n.toLowerCase(); return want.has(l) || l.startsWith(base + "--claude-worktrees-"); }).map((n) => path.join(pd, n));
}

/** 在转录里找「写完成之后、成功的读」:Read / NotebookRead,或 output_mode=content 的 Grep,指向 want 的路径。
 *  want: Map<pkey, { after:ISO, writeIds:string[] }>——after = 写前记录时刻;若转录里找到该写调用的 tool_result,以它的时刻为准(写完成)。
 *  返回 { found:Set<pkey>, err? }。超出扫描上限 / 读错误 ⇒ err(调用方把没找到的判 unknown)。 */
export function scanReads(dirs, want, sinceMs, budget = SCAN_BUDGET) {
  const found = new Set();
  if (!want.size) return { found };
  if (!dirs || !dirs.length) return { found, err: "转录目录不在或读不了" };
  const files = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      if (!/\.jsonl$/i.test(e.name)) continue;
      try { if (fs.statSync(p).mtimeMs >= sinceMs) files.push(p); } catch { /* 消失了 */ }
    }
  };
  for (const d of dirs) walk(d, 0);
  const writeIds = new Map();   // 写调用 id ⇒ Set<pkey>(一次写调用可能写多个目标,共享完成时刻;codex 301 r1 F4)
  for (const [k, w] of want) for (const id of w.writeIds || []) if (id) { if (!writeIds.has(id)) writeIds.set(id, new Set()); writeIds.get(id).add(k); }
  const writeDone = new Map();  // pkey ⇒ 最晚的写完成时刻
  const reads = [];             // { id, k, ts }
  const results = new Map();    // tool_use_id ⇒ { ok, ts }
  let used = 0;
  const onLine = (line) => {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return;
    let e; try { e = JSON.parse(line); } catch { return; }
    const ts = String(e?.timestamp || "");
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    for (const b of content) {
      if (b && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        results.set(b.tool_use_id, { ok: b.is_error !== true, ts });
        for (const k of writeIds.get(b.tool_use_id) || []) if (ts && (!writeDone.has(k) || ts > writeDone.get(k))) writeDone.set(k, ts);
        continue;
      }
      if (!b || b.type !== "tool_use") continue;
      const name = String(b.name);
      if (!/^(Read|NotebookRead|Grep)$/.test(name)) continue;
      if (name === "Grep" && b.input?.output_mode !== "content") continue;
      const p = b.input?.file_path || b.input?.notebook_path || (name === "Grep" ? b.input?.path : null);
      if (!p) continue;
      const k = pkey(path.isAbsolute(String(p)) ? p : path.resolve(String(e?.cwd || "."), String(p)));
      if (want.has(k)) reads.push({ id: String(b.id || ""), k, ts });
    }
  };
  let err = null;
  for (const f of files) {
    let fd;
    try {
      fd = fs.openSync(f, "r");
      const buf = Buffer.alloc(8 * 1024 * 1024);
      let rest = "";
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        used += n;
        if (used > budget) { err = `转录超过扫描上限 ${Math.round(budget / 1048576)}MB`; break; }
        const lines = (rest + buf.toString("utf8", 0, n)).split("\n");
        rest = lines.pop();
        for (const l of lines) onLine(l);
      }
      if (!err && rest) onLine(rest);
    } catch (e) { err = `转录读不了(${path.basename(f)}:${e.code || e.message})`; }
    finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* 关不了不影响结论 */ } }
    if (err) break;
  }
  for (const r of reads) {
    const res = results.get(r.id);
    if (!res || !res.ok) continue;                         // 只认成功的读
    const after = writeDone.get(r.k) || want.get(r.k).after;
    if (r.ts && r.ts > after) found.add(r.k);
  }
  return err ? { found, err } : { found };
}

const OUTLETS = {
  [TYPES.T]: (p) => `给 ${p} 里失效期为空 / 只是占位的行写上期限(列 4,如 **≤<批号>** / **已结清 <批号>**);切不出 6 列的行把描述里的竖线写成反斜杠竖线或放进反引号;提交后重跑 --clear`,
  [TYPES.MF]: (p) => `在 ${p} 正文加一行「执行面:<文件路径 / 规则 id「X 项」/ npm run 脚本 / D 号>」或「不可机械化:<理由>」(用 Edit 写),重跑 --clear`,
  [TYPES.J]: (p) => `跑 node --no-warnings scripts/verify-laws.mjs,按 FAIL 行修 ${p} 或被引用的文件,提交后重跑 --clear`,
  [TYPES.M]: (p) => `用 Read 打开 ${p} 看一眼(写入没生效就重写;写进去了哈希会变),重跑 --clear;目标定位不了 / 判不了的,修好取证条件或连续判不了 3 次后 --settle`,
};

/** --clear 的锁外取证。existing = 本批名下(含带入、待并入)的写入类义务。
 *  返回 { items:[{type, path, result, why, payload?}] }。每个 (type, path) 至多一条。 */
export async function planWriteChecks(prev, { git: gitIn, conf, cwd = process.cwd(), home = os.homedir(), transcriptDirs: tdIn, existing = [] } = {}) {
  const items = new Map();
  const hints = [];   // 只提示、不产生义务的(M 全部;仓外 memory 的 shell 写入)
  const put = (it) => items.set(`${it.type}\u0000${pkey(it.path)}`, it);
  const co = checkoutOf(cwd);
  // codex 301 r4 ①:撤回清账先于一切提前返回
  if (!co) return { items: [...withdrawnClears(existing), { type: TYPES.J, path: "(写入类取证)", result: "unknown", why: "找不到 git 工作树(.git)" }], hints };
  const git = gitIn || gitDefault(co.root);
  const armedMs = Date.parse(prev?.armedAt || "");
  const since = Number.isFinite(armedMs) ? armedMs : NaN;
  const sinceIso = Number.isFinite(since) ? new Date(since).toISOString() : null;
  const ch = changedInBatch(prev?.baseCommit, git);
  const cfg = conf && !conf.error ? conf : null;
  const debtRel = (cfg && cfg.debtTable) || "docs/gate-debts.md";
  const roots = cfg ? resolveMemoryDirs(cfg.memoryDirs, co.main, home, co.root) : [];
  const ex = (type) => existing.filter((r) => r && r.type === type);
  const noBase = !(typeof prev?.baseCommit === "string" && prev.baseCommit);   // 批 301 误拦 FB-7:没有基点 ⇒ 按此刻文件判,不判 unknown
  const hasAgents = fs.existsSync(path.join(co.root, "AGENTS.md"));

  // T:判一份债表
  const judgeT = (abs, label) => {
    let text = null;
    try { text = fs.readFileSync(abs, "utf8"); } catch (e) { return e.code === "ENOENT" ? { type: TYPES.T, path: label, result: "open", why: "欠账表不在(被删了)" } : { type: TYPES.T, path: label, result: "unknown", why: `读不了(${e.code || e.message})` }; }
    const r = checkDebtTable(text);
    if (r.bad.length) return { type: TYPES.T, path: label, result: "open", why: `失效期为空或只是占位:${r.bad.slice(0, 6).map((b) => `${b.label}(第 ${b.n} 行)`).join("、")}` };
    if (r.unknown.length) return { type: TYPES.T, path: label, result: "unknown", why: `列数异常判不了:${r.unknown.slice(0, 6).map((b) => `${b.label}(第 ${b.n} 行,${b.why})`).join("、")}——描述里的竖线写成反斜杠竖线或放进反引号,恢复 6 列` };
    return { type: TYPES.T, path: label, result: "cleared", why: `${r.rows} 行失效期都非空` };
  };
  if (ch.err && noBase) { if (fs.existsSync(path.join(co.root, debtRel))) put(judgeT(path.join(co.root, debtRel), debtRel)); }
  else if (ch.err) put({ type: TYPES.T, path: debtRel, result: "unknown", why: ch.err });
  else if ([...ch.paths].some((p) => pkey(path.join(co.root, p)) === pkey(path.join(co.root, debtRel)))) put(judgeT(path.join(co.root, debtRel), debtRel));
  for (const r of ex(TYPES.T)) if (!items.has(`${TYPES.T}\u0000${pkey(r.payload?.path || debtRel)}`)) put(judgeT(path.resolve(co.root, r.payload?.path || debtRel), r.payload?.path || debtRel));

  // J:对此刻工作树跑 verify-laws
  // 关账层按**整份** verify-laws 判,不扣「基点时就在」的问题。批 302 曾按误拦 FB-3 加过「只判本批新增」的减法(`2c6e59f`),
  //   codex p0-close r3 ⑧ 实测假绿:减法要从问题的展示字符串里反解析出目标路径,文件名带空格或 `#` 时把本批新增的问题扣成既有、关账放行。
  //   这是「从文本外形推回事实」那一族,按闸规矩第三节退回、不补正则;FB-3 的误拦(改前就有的问题挡本批关账)留账 D225 ⑪,
  //   重做时让 verify-laws 直接给出结构化的目标路径。
  const judgeJ = async (why0) => {
    try {
      const { checkLaws } = await import(pathToFileURL(path.join(HERE, "..", "verify-laws.mjs")).href);
      const r = checkLaws(co.root);
      return { type: TYPES.J, path: "AGENTS.md", result: r.ok ? "cleared" : "open", why: r.ok ? `verify-laws PASS(${why0})` : `verify-laws FAIL:${r.problems.slice(0, 4).join(" | ")}` };
    } catch (e) { return { type: TYPES.J, path: "AGENTS.md", result: "unknown", why: `verify-laws 跑不了(${e.message})` }; }
  };
  // 批 301 误拦 FB-7:J 只在仓里有 AGENTS.md(或本批删掉了它)时判;没有基点 ⇒ 有 AGENTS.md 就按此刻文件判
  if (ch.err && noBase) { if (hasAgents) put(await judgeJ("没有基点,按此刻文件判")); }
  else if (ch.err) put({ type: TYPES.J, path: "AGENTS.md", result: "unknown", why: ch.err });
  else {
    const laws = [...ch.paths].filter((p) => lawRelOf(path.join(co.root, p), co.root));
    if (laws.length && (hasAgents || laws.some((p) => /^agents\.md$/i.test(p)))) put(await judgeJ(`本批改过 ${laws.join("、")}`));
    else if (ex(TYPES.J).length) put(await judgeJ("带入 / 已有的 J 义务重判"));
  }

  // MF
  if (roots.length || ex(TYPES.MF).length) {
    let MF = null, err = null;
    try { MF = await loadMF(); } catch (e) { err = `MF 判据载入失败(${e.message})`; }
    const ap = readLedger(ledgerFiles(co.main).approvals);
    const approved = new Set(ap.rows.filter((x) => x && x.kind === "exempt" && x.p && x.h).map((x) => `${x.p}\u0000${x.h}`));
    const judgeMF = (f) => {
      let body; try { body = fs.readFileSync(f, "utf8"); } catch (e) { return e.code === "ENOENT" ? { type: TYPES.MF, path: slash(f), result: "cleared", why: "文件已不在" } : { type: TYPES.MF, path: slash(f), result: "unknown", why: `读不了(${e.code})` }; }
      if (!mfBad(body, MF)) return { type: TYPES.MF, path: slash(f), result: "cleared", why: "带执行面(或不是规则类)" };
      if (approved.has(`${pkey(f)}\u0000${contentHash(f)}`)) return { type: TYPES.MF, path: slash(f), result: "cleared", why: "缺执行面,但此刻内容正是写前判过「改前就缺、全是小改」而放行的那一版" };
      if (ap.err) return { type: TYPES.MF, path: slash(f), result: "unknown", why: `批准记录读不了(${ap.err})` };
      return { type: TYPES.MF, path: slash(f), result: "open", why: "「以后都这样做」类 memory 缺执行面,且此刻内容不是写前判过的小改版本(shell / 脚本 / 子代理写入,或写前没判成)" };
    };
    if (err) put({ type: TYPES.MF, path: "(memory)", result: "unknown", why: err });
    else {
      if (roots.length) {
        // 窄版(批 301 主会话裁定退回并冻结,codex 合并审 r2 F4 后):
        //   **仓内**的 memory 根(本 checkout / 主树下):只看 git 事实——本批改过的文件(基点 diff + 未跟踪未忽略)里落在这些根下的;
        //   **仓外**的根(项目 memory、全局 memory、家目录 agent-memory):一律只提示,不产生义务(取证失败也只提示)。
        const inRepo = (r) => { const k = pkey(r); return k === pkey(co.root) || k.startsWith(pkey(co.root) + "/") || k === pkey(co.main) || k.startsWith(pkey(co.main) + "/"); };
        const rootsIn = roots.filter(inRepo), rootsOut = roots.filter((r) => !inRepo(r));
        if (rootsIn.length) {
          if (ch.err && noBase) hints.push(`MF:本批没有基点,仓内 memory 不判(${rootsIn.map(slash).join("、")})——只提示`);
          else if (ch.err) put({ type: TYPES.MF, path: "(memory)", result: "unknown", why: ch.err });
          else for (const p of ch.paths) { const f = path.join(co.root, p); if (memoryRootOf(f, rootsIn)) put(judgeMF(f)); }
        }
        if (rootsOut.length) {
          if (!Number.isFinite(since)) hints.push("MF:本批没有 armedAt,仓外 memory 没查——只提示");
          else for (const r of rootsOut) {
            let got = [];
            try { got = recentMd(r, since); } catch (e) { hints.push(`MF:仓外 memory 目录 ${slash(r)} 读不了(${e.code || e.message})——只提示`); continue; }
            for (const x of got.errs) if (memoryRootOf(x.p, rootsOut)) hints.push(`MF:仓外 memory ${slash(x.p)} stat 失败(${x.code})——只提示`);
            for (const f of got) if (memoryRootOf(f, rootsOut)) {
              let body = null; try { body = fs.readFileSync(f, "utf8"); } catch (e) { hints.push(`MF:仓外 memory ${slash(f)} 读不了(${e.code || e.message})——只提示`); continue; }
              if (mfBad(body, MF) && !approved.has(`${pkey(f)}\u0000${contentHash(f)}`)) hints.push(`MF:仓外 memory ${slash(f)} 本批窗口里改过、缺执行面——只提示(仓外 memory 不进关账义务)`);
            }
          }
        }
      }
      for (const r of ex(TYPES.MF)) {
        const p = r.payload?.path;
        if (!p || items.has(`${TYPES.MF}\u0000${pkey(p)}`)) continue;
        // 聚合的判不了项:只有同一个窗口(同一次武装)里这次取证跑成了才清;带入的(窗口已换)仍判不了(codex 301 r1 F5 同族)
        const sameWin = (r.origin?.armedAt || null) === (prev?.armedAt || null);
        const pk = pkey(p), inRepoP = pk.startsWith(pkey(co.root) + "/") || pk.startsWith(pkey(co.main) + "/");
        if (!p.startsWith("(") && !inRepoP) { put({ type: TYPES.MF, path: p, result: "cleared", why: "仓外 memory 已改为只提示(批 301 窄版),本条不再挡关账" }); continue; }
        put(p.startsWith("(") ? { type: TYPES.MF, path: p, result: roots.length && sameWin ? "cleared" : "unknown", why: roots.length && sameWin ? "同一窗口里这次取证跑成了" : "带入的判不了项仍判不了(原窗口里的 memory 写入无从重查)" } : judgeMF(p));
      }
    }
  }

  // M:批 301 主会话裁定撤出关账拒绝后**不再做关账取证**(codex 合并审 r1 ⑥:省掉台账读取 / 哈希 / 转录扫描);写前哈希记账照留,
  //   给 ≤304 的 M 重做用(重做方向见设计稿拟登债:按 git 事实 + Read 记录判,不解析命令)。

  // 批 301 主会话裁定(合并前误拦猎手 FB-1/2/3/4/10 确认误拦):**M 整条撤出关账拒绝**,不产生义务。
  //   已有的 M 义务(撤回前建的)一律写清,理由写明是撤回。
  // 批 301 最终裁定(codex 合并审 r3 后):**T、MF 关账层也退回只记账**——取证结论只进提示、不产生义务;已有的 T / MF 义务一律写清。J 照旧。
  const out = [];
  for (const it of items.values()) {
    if (it.type === TYPES.T || it.type === TYPES.MF) { if (it.result !== "cleared") hints.push(`${it.type === TYPES.T ? "T" : "MF"}(只提示,拒绝已撤回):${it.path} —— ${it.why}`); continue; }
    out.push(it);
  }
  out.push(...withdrawnClears(existing));
  // codex 301 r4 ②:取证故障建的 J 兜底聚合项「(写入类取证)」——这次取证跑成了(走到这里),不论 J 结论一律写清
  for (const r of ex(TYPES.J)) if (r.payload?.path === "(写入类取证)" && r.status !== "cleared") out.push({ type: TYPES.J, path: r.payload.path, result: "cleared", why: "这次写入类取证跑成了,故障兜底项写清" });
  return { items: out, hints };
}

/** 撤回清账(codex 301 r4 ①):已有的 T / MF / M 义务(含聚合项、unknown / settling / settled)一律写清。
 *  planWriteChecks 的正常路径、提前返回,以及 batch-goal 取证抛错的兜底都先放这些,再放各自的结论。 */
export function withdrawnClears(existing = []) {
  const out = [];
  for (const r of existing || []) {
    if (!r || !r.payload?.path || r.status === "cleared" || r.status === "withdrawn") continue;
    if (r.type === TYPES.T || r.type === TYPES.MF) out.push({ type: r.type, path: r.payload.path, result: "cleared", why: "拒绝撤回,待独立设计复核(批 301 最终裁定)" });
    else if (r.type === TYPES.M) out.push({ type: TYPES.M, path: r.payload.path, result: "cleared", why: "M 的关账拒绝已撤回(批 301 主会话裁定,待 ≤304 重做);本条不再挡关账" });
  }
  return out;
}

/** --clear 的锁内落笔:把取证结论写进义务账。key = 批键。返回改过的义务 id。 */
export function applyWriteChecks(draft, prev, plan, key, ctx = {}) {
  if (!plan || !Array.isArray(plan.items)) return [];
  const by = "evaluator:write-checks@clear";
  const changed = [];
  const sameKey = (a, b) => !!(a && b && String(a.batch) === String(b.batch) && (a.armedAt || null) === (b.armedAt || null));
  const mine = () => draft.list().filter((r) => TYPE_SET.has(r.type) && sameKey(r.batch, key) && r.status !== "withdrawn");
  for (const it of plan.items) {
    let rec = mine().find((r) => r.type === it.type && pkey(r.payload?.path || "") === pkey(it.path) && r.status !== "cleared")
      || mine().find((r) => r.type === it.type && pkey(r.payload?.path || "") === pkey(it.path));
    if (!rec) {
      if (it.result === "cleared") continue;
      rec = OB.createObligation(draft, { type: it.type, owner: ctx.sid || null, checkout: ctx.checkout || null,
        origin: { ...key, baseCommit: typeof prev?.baseCommit === "string" ? prev.baseCommit : null }, batch: key,
        payload: { path: it.path, ...(it.payload || {}) }, outlet: OUTLETS[it.type](it.path),
        trigger: { via: "--clear", rule: Object.keys(TYPES).find((k) => TYPES[k] === it.type) } }, by);
      changed.push(rec.id);
      // 新建即开着:把这次取证的理由写进 lastResult(拒清消息据此点名);unknown 再走 applyEvaluation 计连续判不了次数
      if (it.result === "open") { draft.put({ ...rec, lastResult: { at: new Date().toISOString(), result: "open", by, why: it.why } }, { op: "transition", by, why: it.why }); continue; }
    } else if (it.payload) {
      const p2 = { ...(rec.payload || {}), ...it.payload, path: rec.payload?.path || it.path };
      if (JSON.stringify(p2) !== JSON.stringify(rec.payload) && rec.status !== "settled" && rec.status !== "settling") { rec = draft.put({ ...rec, payload: p2 }, { op: "transition", by, why: "更新取证所需的写前哈希 / 时刻" }); changed.push(rec.id); }
    }
    if (rec.status === "cleared" && it.result !== "cleared") {
      draft.put({ ...rec, status: it.result, unknownStreak: it.result === "unknown" ? 1 : 0, lastResult: { at: new Date().toISOString(), result: it.result, by, why: it.why } }, { op: "reopen", by, why: it.why });
      changed.push(rec.id);
      continue;
    }
    const r = OB.applyEvaluation(draft, draft.get(rec.id), { result: it.result, why: it.why }, by);
    if (r.applied) { changed.push(rec.id); continue; }
    // 结论没变(仍开着)但理由变了(比如从「指针丢了」变成「孤儿法典」)⇒ 只更新理由,拒清消息不说旧话
    const cur = draft.get(rec.id);
    if (cur && cur.status === "open" && it.result === "open" && cur.lastResult?.why !== it.why) {
      draft.put({ ...cur, lastResult: { at: new Date().toISOString(), result: "open", by, why: it.why } }, { op: "transition", by, why: it.why });
      changed.push(rec.id);
    }
  }
  return changed;
}

// ── 自测(在 write-checks.selftest.mjs;只在 --self-test 时载入)───────────────────────────
const isMain = (() => {
  if (!process.argv[1]) return false;
  const canon = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
  try { return canon(fileURLToPath(import.meta.url)) === canon(process.argv[1]); } catch { return false; }
})();
if (isMain && process.argv.includes("--self-test")) {
  // 自测件静态 import 本文件;在本文件的顶层 await 里再 import 它会互等(循环 + TLA)⇒ 起子进程跑
  const r = spawnSync(process.execPath, ["--no-warnings", path.join(HERE, "write-checks.selftest.mjs")], { stdio: "inherit", windowsHide: true, timeout: 590_000 });
  process.exit(r.status ?? 1);
}
