#!/usr/bin/env node
// batch-run.mjs —— 发车脚本:开批 → 无头执行会话 → 自动验收 → 同会话回修 → 关账,或停下写交接(批 306)
//
// 干什么:把已有的件串成一条线。人只说一句话(`--instruction`)、写下什么算完成(`--cond` + 至少一条 `--check`),
//   本脚本在自己的 git worktree 里开批、拉起 `claude -p` 执行、重跑开批时登记的检查验收,不过就用**同一个会话**回修
//   (至多三轮),过了就并回基分支、(可选)推私仓、`batch-goal --clear` 关账;任何一步判不了就停下,`batch-goal --handoff`
//   生成交接并补一节「卡在哪」。
//
// 用法:
//   node --no-warnings scripts/batch-run.mjs --batch <批号> --instruction "<用户原话>"
//        --cond "<条件>" [--check "<命令>" [--expect "<子串>" | --expect-re "<正则>"]] [--cond …]   (原样透传给 batch-goal --arm)
//        [--finish-line "<终点线>"] [--max-turns 80] [--max-budget-usd 8] [--cap-usd 20] [--deadline-min 90]
//        [--model <名>] [--judge-model opus] [--no-merge] [--push <远端名>] [--handoff-out <路径>] [--same-error-limit 3]
//        [--route plan|criteria|direct [--route-reason "<一句>"]] [--triage-model <名>]
//   node --no-warnings scripts/batch-run.mjs --status [<批号>]      只读:运行状态与 runs.jsonl
//   node --no-warnings scripts/batch-run.mjs --self-test           临时 git 仓 + 真 batch-goal + 按剧本行事的假 claude
// 退出码:0 = 已关账;10 = 停下了(交接已写);2 = 拒绝发车(什么都没起);1 = 内部错误(尽量也写交接)。
// stdout 最后一行恒为 `BATCH_RUN_RESULT=<JSON>`(键:batch status reason reasonCode stage rounds acceptRounds costUsd
//   sessionId worktree branch handoff ruler pushed notes triage)。进度信息一律写 stderr。
//
// 分流(批 309,判词见 batch-triage.mjs):发车前检查的最后一步。
//   给了 --route ⇒ 照它(source caller),不筛规则、不调模型——规则误判时的出路;
//   没给 --route、带了 --cond ⇒ 只过规则:命中 ⇒ plan;没命中 ⇒ criteria(source caller);
//   没给 --route、也没给 --cond ⇒ 规则 + 便宜模型(--triage-model > batch-triage.json 的 model > haiku)。
//   plan ⇒ 拒绝发车(triage-plan);criteria 缺 --cond 或 --check ⇒ 拒绝(triage-need-criteria);
//   direct ⇒ 没 --cond 就拿「照这句话做完:<原话>」当条件,没 --check 就用 batch-triage.json 的 directCheck,也没有 ⇒ 拒绝(triage-no-default-check)。
//   拒绝时什么都不起(只往 triage.jsonl 记一行判词);判词对象记进运行状态、runs.jsonl 那一行和结果行的 triage 键。
//
// 代价不对称(拿不准时照这个定):
//   ① 不该关的批被关了账(检查没过、活没提交、裁决缺失却 --clear)最贵 ⇒ 验收与关账任何一步判不了,一律停下写交接,不猜成「过」;
//   ② 该过的批被停下次之 ⇒ 辅助件(方向复核、清理工作树)失败只记一行(notes)继续,不因它们把已过硬门的批判成停。
//
// 流程与不变量(细节见 docs/batch-run.md):
//   发车前检查(不过 ⇒ 退出 2、不留痕迹)→ 建工作树 `<主树>/.claude/worktrees/batch-<批号>`(分支 `batch-run/<批号>`,
//   收尾闸只认这个位置的 worktree 批状态)→ 在工作树里 `batch-goal --arm`(环境变量 CLAUDE_CODE_SESSION_ID = 执行会话号,
//   批状态的 armedBy 因此是执行会话)→ `claude -p --session-id <号>`(提示词走 stdin)→ 分类(classifyRun,照无头上限实测表)
//   (执行与回修的拉起挂看守 batch-watch.mjs:同一个工具调用连着 3 次报同样的错 ⇒ 杀执行会话、停,不回修;`--same-error-limit 0` 关掉)
//   → 验收(工作树干净 / `batch-goal --dry-check` / 逐条裁决 / 本批发起过的外审作业)→ 回修 `claude -p --resume <号>`
//   (至多 3 轮;第二次验收不过时先拉一次方向复核 `_direction-judge`)→ 关账(ff 并回 / 基分支前进过则 rebase 一次 /
//   推私仓并回读 / 欠账探针 / `--clear --verdict`)→ 清理(辅助件)。
//   禁用 `--dangerously-skip-permissions`;无人值守的围栏是 `--permission-mode auto` 的权限分类器。
//   不碰闸引擎文件:batch-goal / codex-run / install-config 只 import 或走命令行。
//
// 运行面(都在 `<主树>/.claude/.batch-run/`,gitignore):`<批号>.json`(运行状态,原子写;status running 且 pid 活着即为锁,
//   同时只跑一个)、`<批号>-r<k>.log`(第 k 次拉起的 stdout/stderr)、`<批号>-judge.log`、`<批号>-handoff.md`、`runs.jsonl`(每次运行一行)。
//
// 测试接缝(只给自测用):BATCH_RUN_CLAUDE_BIN(指定 claude 可执行文件;以 .mjs / .js 结尾时用本 node 跑它)、
//   BATCH_RUN_CODEX_JOB_ROOT(codex-run 作业台账目录,缺省同 codex-run 的 JOB_ROOT)、BATCH_RUN_POLL_MS(轮询外审作业的间隔)。
//
// 天花板(诚实写出):硬门只证「登记的检查此刻通过」,不证检查和条件对象真有关系;逐条裁决只认格式,不判真假;
//   花费是 CLI 每轮结束才比的客户端估算,会超一点;续接会话(--resume)时 CLI 报的 total_cost_usd 是会话累计值(实测),
//   本脚本对回修轮按差额记账(见 launch 里的头注与 launchCost)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBash, normCheckout, parseArm } from "./batch-goal.mjs";
import { JOB_ROOT as CODEX_JOB_ROOT, isPlaceholder } from "./codex-run.mjs";
import { readInstallConfig, installNames, INSTALL_CONFIG_FILE } from "./lib/install-config.mjs";
import { createWatch, SAME_ERROR_LIMIT } from "./batch-watch.mjs";
import { triage as triageAsk, ruleVerdict, DEFAULT_RULES, extraRules, readTriageConfig, appendLedger, verdictRow, DEFAULT_MODEL as TRIAGE_DEFAULT_MODEL, ROUTES, TRIAGE_CONFIG_FILE } from "./batch-triage.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const BG = path.join(HERE, "batch-goal.mjs");
const fwd = (p) => (p == null ? p : String(p).replace(/\\/g, "/"));
const BG_FWD = fwd(BG);
export const RESULT_KEY = "BATCH_RUN_RESULT=";
export const REPAIR_MAX = 3;
export const DEFAULTS = Object.freeze({ maxTurns: 80, maxBudgetUsd: 8, capUsd: 20, deadlineMin: 90, judgeModel: "opus", sameErrorLimit: SAME_ERROR_LIMIT });
const JUDGE_MAX_TURNS = 15, JUDGE_MAX_USD = 2;
const say = (s) => process.stderr.write(`[batch-run] ${s}\n`);
const tail = (s, n = 600) => { const t = String(s || "").trim(); return t.length > n ? "…" + t.slice(-n) : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round4 = (x) => Math.round(x * 10000) / 10000;

// ── 命令行 ────────────────────────────────────────────────────────────────────────────
/** 解析命令行。返回 { mode:"run"|"status"|"self-test", … };用法错 ⇒ 抛(调用方按拒绝发车处理,退出 2)。纯函数。 */
export function parseCli(argv) {
  if (argv.includes("--self-test")) return { mode: "self-test" };
  if (argv[0] === "--status") {
    if (argv.length > 2 || (argv[1] !== undefined && !/^[\w.-]+$/.test(argv[1]))) throw new Error("用法: --status [<批号>]");
    return { mode: "status", batch: argv[1] ?? null };
  }
  const STR = { "--batch": "batch", "--instruction": "instruction", "--finish-line": "finishLine", "--model": "model", "--judge-model": "judgeModel", "--push": "push", "--handoff-out": "handoffOut",
    "--route": "route", "--route-reason": "routeReason", "--triage-model": "triageModel" };
  const NUM = { "--max-turns": "maxTurns", "--max-budget-usd": "maxBudgetUsd", "--cap-usd": "capUsd", "--deadline-min": "deadlineMin" };
  const INT0 = { "--same-error-limit": "sameErrorLimit" };   // 非负整数;0 = 关掉看守
  const PASS = new Set(["--cond", "--check", "--expect", "--expect-re"]);
  const o = { arm: [], noMerge: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || !String(v).trim()) throw new Error(`${a} 缺值或为空`);
      if (/^--/.test(v)) throw new Error(`${a} 的值不能以 -- 开头(得到「${v}」,像是漏写了值)`);
      i++; return String(v);
    };
    if (PASS.has(a)) { o.arm.push(a, val()); continue; }
    if (a === "--no-merge") { o.noMerge = true; continue; }
    if (INT0[a]) {
      if (seen.has(a)) throw new Error(`${a} 给了两次`);
      seen.add(a);
      const v = val();
      if (!/^\d+$/.test(v)) throw new Error(`${a}「${v}」要是非负整数(0 = 关掉)`);
      o[INT0[a]] = Number(v);
      continue;
    }
    if (STR[a] || NUM[a]) {
      if (seen.has(a)) throw new Error(`${a} 给了两次`);
      seen.add(a);
      const v = val();
      if (STR[a]) o[STR[a]] = v;
      else {
        if (!/^\d+(?:\.\d+)?$/.test(v) || !(Number(v) > 0)) throw new Error(`${a}「${v}」不是正数`);
        if (a === "--max-turns" && !Number.isInteger(Number(v))) throw new Error(`--max-turns「${v}」要是正整数`);
        o[NUM[a]] = Number(v);
      }
      continue;
    }
    throw new Error(/^--/.test(a) ? `未知参数 ${a}` : `多余的位置参数「${a}」——每个值都要跟在它的旗标后面`);
  }
  if (!o.batch) throw new Error("缺 --batch <批号>");
  if (!/^[\w.-]+$/.test(o.batch)) throw new Error(`批号「${o.batch}」只能含字母、数字、下划线、点、横线`);
  if (!o.instruction) throw new Error("缺 --instruction \"<用户原话>\"");
  let parsed;
  try { parsed = parseArm(o.arm); } catch (e) { throw new Error(`完成条件参数(与 batch-goal --arm 同一语法):${e.message}`); }
  // 「至少一条 --cond 和 --check」不在这里拒了:没写完成标准的一句话要先过分流(direct 路线由脚本补条件与检查);
  //   criteria 路线缺它们时由 routeDecision 拒(triage-need-criteria),拒绝那段话里写出路(批 309)。
  if (o.route !== undefined && !ROUTES.includes(o.route)) throw new Error(`--route「${o.route}」要是 ${ROUTES.join(" / ")} 之一`);
  if (o.routeReason !== undefined && o.route === undefined) throw new Error("--route-reason 要和 --route 一起给(比如 --route criteria --route-reason \"<理由>\")");
  if (o.triageModel !== undefined && !/^[\w.:[\]-]{1,80}$/.test(o.triageModel)) throw new Error(`--triage-model「${o.triageModel}」不像模型名`);
  return { mode: "run", ...DEFAULTS, ...o, conds: parsed.conds, checks: parsed.checks };
}

// ── 分流(批 309)──────────────────────────────────────────────────────────────────────
/** 定判词(不落盘)。--route ⇒ caller;带 --cond ⇒ 只过规则;都没有 ⇒ 规则 + 便宜模型(askTriage 可换,自测用)。 */
export async function decideTriage(o, conf, { bin, askTriage = triageAsk } = {}) {
  if (o.route) return { route: o.route, reason: o.routeReason || `调用方用 --route ${o.route} 指定`, source: "caller", ruleHits: [], model: null, costUsd: 0, ms: 0 };
  const rules = [...DEFAULT_RULES, ...extraRules(conf.planPatterns)];
  if (o.conds.length) {
    const rv = ruleVerdict(o.instruction, rules);
    if (rv) return rv;
    return { route: "criteria", reason: "调用方已写好完成标准(--cond),规则没命中;没调模型", source: "caller", ruleHits: [], model: null, costUsd: 0, ms: 0 };
  }
  return askTriage({ instruction: o.instruction, model: o.triageModel || conf.model || TRIAGE_DEFAULT_MODEL, planPatterns: conf.planPatterns, bin });
}
const SRC_ZH = { rule: "规则", model: "模型", fallback: "兜底", caller: "调用方" };
/** 判词 ⇒ 发车与否。返回 { refuse:{ code, why } } | { arm, conds, checks }(direct 补过条件与检查的)。纯函数。 */
export function routeDecision(o, v, conf) {
  const head = (zh) => `分流判「${zh}」(${SRC_ZH[v.source] || v.source}):${v.reason}`;
  if (v.route === "plan") {
    return { refuse: { code: "triage-plan", why: `${head("完整计划")}。这句话该走完整计划(含对抗审计),发车脚本不收。判错了的出路:加 --route criteria --route-reason "<理由>"(带上 --cond 和至少一条 --check)重发` } };
  }
  if (v.route === "criteria") {
    if (o.conds.length && o.checks.length) return { arm: o.arm, conds: o.conds, checks: o.checks };
    const miss = o.conds.length ? "缺 --check(硬门只认可执行检查)" : "没有 --cond 和 --check";
    return { refuse: { code: "triage-need-criteria", why: `${head("只写完成标准")}。这条路要先写好完成标准和检查,现在${miss}。写好 --cond "<什么算完成>" 和 --check "<命令>" 后带 --route criteria 重发` } };
  }
  // direct
  const dc = conf.directCheck;
  if (!o.checks.length && !dc) {
    return { refuse: { code: "triage-no-default-check", why: `${head("直接做")}。直接做也要一条跑得出「过 / 不过」的检查,但没给 --check,${TRIAGE_CONFIG_FILE} 里也没配 directCheck。出路二选一:① 带 --cond "<什么算完成>" --check "<命令>" --route direct 重发;② 在主 checkout 根目录的 ${TRIAGE_CONFIG_FILE} 里配 "directCheck": "<命令>"` } };
  }
  let arm = o.arm.slice();
  if (!o.conds.length) arm = ["--cond", `照这句话做完:${o.instruction}`];
  if (!o.checks.length) arm.push("--check", dc.cmd, ...(dc.expect !== undefined ? ["--expect", dc.expect] : dc.expectRe !== undefined ? ["--expect-re", dc.expectRe] : []));
  let p;
  try { p = parseArm(arm); } catch (e) { return { refuse: { code: "triage-no-default-check", why: `${head("直接做")}。${TRIAGE_CONFIG_FILE} 的 directCheck 不合 batch-goal --arm 的语法(${e.message})。出路:改好 directCheck,或带 --cond / --check 重发` } }; }
  return { arm, conds: p.conds, checks: p.checks };
}

// ── 纯判定(自测逐条钉住)────────────────────────────────────────────────────────────
// 撞账户额度时 CLI 的结果文字(只在 is_error 真而 subtype 为 success 时才看):宽一点只会把「失败」认成「等额度」,两者都停。
export const QUOTA_RE = /usage limit|limit (?:reached|exceeded)|hit your (?:usage )?limit|out of (?:extra )?usage|quota|rate.?limit|too many requests|resets? (?:at|in|on)\b|额度|用量/i;
/** 一次拉起的分类(照无头上限实测表)。入参 { code, result(最后一条 type:"result" 事件或 null), killed(被截止时间杀掉),
 *  watch(看守的命中或 null) }。返回 { cls: done|cap|stalled|quota|failed|unknown, code(reasonCode), why }。
 *  不能只看 subtype:撞账户额度时它写的是 success。优先级:看守命中 > 截止时间被杀 > 其余——进程是被看守杀的,
 *  退出码与 result 事件都不可信;stalled 和 cap 一样停、不回修。 */
export function classifyRun({ code, result, killed, watch } = {}) {
  if (watch) return { cls: "stalled", code: "watch-same-error", why: `同一个工具调用(${watch.tool})连着 ${watch.count} 次报同样的错,看守把执行会话停了` };
  if (killed) return { cls: "cap", code: "cap-deadline", why: "到整批截止时间,执行会话被杀掉" };
  if (!result || typeof result !== "object") return { cls: "unknown", code: "unknown", why: `没有 result 事件(退出码 ${code})` };
  const st = result.subtype, text = String(result.result ?? "");
  if (st === "error_max_turns") return { cls: "cap", code: "cap-turns", why: "到轮数上限(error_max_turns)" };
  if (st === "error_max_budget_usd") return { cls: "cap", code: "cap-budget", why: "到单次拉起的花费上限(error_max_budget_usd)" };
  if (code === 0 && result.is_error === false && st === "success") return { cls: "done", code: "done", why: "执行会话说跑完了" };
  if (result.is_error === true && st === "success") {
    return QUOTA_RE.test(text)
      ? { cls: "quota", code: "quota", why: `撞账户额度,等额度恢复再接着干:${tail(text, 200)}` }
      : { cls: "failed", code: "failed", why: `执行会话报错(退出码 ${code}):${tail(text, 200)}` };
  }
  return { cls: "unknown", code: "unknown", why: `判不了这次拉起的结局(退出码 ${code},subtype ${st},is_error ${result.is_error})` };
}

/** 一次拉起自己花了多少:total = CLI 这次报的 total_cost_usd;seen = 同一会话上一次报的读数(首次拉起传 null)。
 *  续接时读数是会话累计值 ⇒ 记差额;读数比上一次小(按次计的形状)⇒ 整笔记。纯函数。 */
export function launchCost(total, seen) {
  return Number.isFinite(seen) && seen >= 0 && total >= seen ? total - seen : total;
}

/** 运行时面:`.claude/` 下**名字以点开头的那一层**(批状态、批台账、义务账、各份台账、本脚本的运行目录)和 `.claude/worktrees/`。
 *  `.claude/agents/`、`.claude/commands/`、`.claude/settings.json` 这类是版本化内容,**不算**——
 *  原先整个 `.claude/` 都不看,执行会话在那里新建文件忘了 `git add` 时验收照过、关账后清理还会把它删掉(批 306 独立审查发现 1)。纯函数。 */
export function isRuntimePath(p) {
  return /^\.claude\/(?:\.[^/]+|worktrees)(?:\/|$)/.test(String(p || "").replace(/\\/g, "/"));
}

/** `git status --porcelain --untracked-files=all` ⇒ { tracked:[已跟踪文件的改动], untracked:[未跟踪未忽略] };运行时面(isRuntimePath)不算。
 *  要带 `--untracked-files=all`:不带时整个未跟踪目录只报一行(如 `?? .claude/`),分不出里面是运行时件还是交付物——那种目录行按未跟踪算。纯函数。 */
export function porcelainIssues(text) {
  const tracked = [], untracked = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim() || line.length < 4) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (p.includes(" -> ")) p = p.split(" -> ").pop();
    p = p.replace(/^"(.*)"$/, "$1").replace(/\\/g, "/");
    if (isRuntimePath(p)) continue;
    if (xy === "!!") continue;
    (xy === "??" ? untracked : tracked).push(p);
  }
  return { tracked, untracked };
}

/** 从执行会话最后一条消息里取逐条裁决。每个条件取**最后一次**出现;全角 / 半角冒号都认,全角数字归一。
 *  返回 { verdicts:[{n,verdict,why?}](n 个都齐、都可用时才完整), problems:[不过项文字] }。纯函数。 */
export function parseVerdicts(text, n) {
  const s = String(text || "").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const last = new Map();
  // 号与冒号、冒号与裁决之间容忍 Markdown 的强调符与反引号(`**条件1**:达成`、`条件1:**达成**` 都是常见写法;认不出要白耗一轮回修)
  for (const m of s.matchAll(/条件\s*(\d+)[\s*_`]*[:：][\s*_`]*(未达成|不适用|达成)([^\n]*)/g)) {
    const k = Number(m[1]);
    if (k >= 1 && k <= n) last.set(k, { verdict: m[2], rest: m[3] });
  }
  const verdicts = [], problems = [];
  for (let k = 1; k <= n; k++) {
    const v = last.get(k);
    if (!v) { problems.push(`缺条件${k}的逐条裁决(最后一条消息末尾要写「条件${k}:达成」/「条件${k}:未达成:<理由>」/「条件${k}:不适用:<理由>」)`); continue; }
    const why = String(v.rest || "").replace(/^[\s*_`]*[:：]?[\s*_`]*/, "").replace(/[\s*_`。．.;；,，!！]+$/, "").trim();
    if (v.verdict === "达成") verdicts.push({ n: k, verdict: "达成" });
    else if (v.verdict === "未达成") problems.push(`条件${k} 执行会话自己判未达成${why ? `:${why.slice(0, 300)}` : "(没写理由)"}`);
    else if (!why) problems.push(`条件${k} 判「不适用」却没写理由(写「条件${k}:不适用:<理由>」)`);
    else verdicts.push({ n: k, verdict: "不适用", why: why.slice(0, 300) });
  }
  return { verdicts: problems.length ? [] : verdicts, problems };
}

/** 外审结果件 ⇒ pass / fail / unknown:只认**最后一个非空行**的固定结论(「不用再审」/「要改」);两样都有、都没有、占位 ⇒ unknown。 */
export function reviewVerdict(body) {
  const lines = String(body ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  if (!lastLine || isPlaceholder(lastLine)) return { v: "unknown", line: lastLine };
  const ok = /不用再审/.test(lastLine), bad = /要改/.test(lastLine);
  return { v: ok && !bad ? "pass" : bad && !ok ? "fail" : "unknown", line: lastLine };
}

/** `batch-goal --clear` 的拒清行 ⇒ { reason, repairable };没有拒清行 ⇒ null。
 *  只有执行会话自己补得上的拒因才回修:检查没过、有没提交的改动、登记的决定缺记录、登记的成果缺日记行、缺「没有决定」的声明、
 *  名下还有开着的义务、转欠账的那一行还没提交。拒因由 `+` 连起来时要**每一段**都在这张单子里。
 *  其余(判不了工作树 / 判不了义务、检查被改过、批身份或义务账对不上、配置在批内改坏、裁决参数不对、没有可关的批……)
 *  一律不回修——那不是再干一轮能解决的,按「判不了就停」处理(批 306 补审 codex 第 3 条)。纯函数。 */
const CLEAR_REPAIRABLE = new Set(["checks-failed", "uncommitted", "adr-missing", "diary-missing", "no-decision", "obligation-open", "settle-uncommitted"]);
export function clearRefusal(stderr) {
  const m = /BATCH-GOAL-CLEAR-REFUSED\b[^\n]*?\breason=([^\s]+)/.exec(String(stderr || ""));
  if (!m) return null;
  const parts = m[1].split("+").filter(Boolean);
  return { reason: m[1], repairable: parts.length > 0 && parts.every((p) => CLEAR_REPAIRABLE.has(p)) };
}

/** 远端地址 ⇒ 仓名(末段,去 `.git` 与尾斜杠)。认不出 ⇒ null。纯函数。 */
export function repoNameOf(url) {
  const s = String(url || "").trim().replace(/[\\/]+$/, "");
  const seg = s.split(/[\\/:]/).pop() || "";
  const n = seg.replace(/\.git$/i, "");
  return n && !/\s/.test(n) ? n : null;
}

/** 同一个 slug 只留最新的一个作业(执行会话改完重发外审,以新回件为准)。纯函数。 */
export function latestPerSlug(jobs) {
  const by = new Map();
  for (const j of jobs) {
    const k = j.slug || j.id;
    const prev = by.get(k);
    if (!prev || String(j.startedAt) > String(prev.startedAt)) by.set(k, j);
  }
  return [...by.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

// ── 提示词 ────────────────────────────────────────────────────────────────────────────
function condLines(o) {
  const out = [];
  o.conds.forEach((c, i) => {
    out.push(`- 条件${i + 1}:${c}`);
    for (const k of o.checks.filter((x) => x.i === i)) {
      out.push(`  - 检查命令:\`${k.cmd}\`${k.expect !== undefined ? `(输出要含「${k.expect}」)` : k.expectRe !== undefined ? `(输出要匹配正则 \`${k.expectRe}\`)` : "(退出码 0 即过)"}`);
    }
  });
  return out;
}
function constraintLines(C) {
  return [
    "## 约束",
    `- 只做本批(批 ${C.o.batch})范围内的事:不开下一批,不扩大范围;不放宽、也不改完成条件与检查。`,
    "- 不跑 `batch-goal --arm` / `--clear` / `--force`(开批与关账由发车脚本做)。",
    `- 不推送、不合并、不切分支:就在当前工作树(分支 \`${C.branch}\`)里干。`,
    "- 不碰服务器内容,不产音视频。",
    "",
    "## 收尾要求",
    "- 改动全部提交,做到工作树干净(新文件要先 `git add`)。",
    `- 有可见成果:\`node --no-warnings "${BG_FWD}" --outcome "<成果一句话>"\`;做了决定:\`node --no-warnings "${BG_FWD}" --decision "<决定一句话>"\`。`,
    `- 随时可以自查:\`node --no-warnings "${BG_FWD}" --dry-check\`(只跑登记的检查,不结清)。`,
    `- 最后一条消息末尾逐条写:\`条件N:达成\` / \`条件N:未达成:<理由>\` / \`条件N:不适用:<理由>\`(N = 1…${C.o.conds.length},每条一行)。`,
    "- 你结束后,发车脚本会重跑上面的检查、看工作树干不干净、读你写的逐条裁决;不过就回到这个会话让你回修。",
  ];
}
export function execPrompt(C) {
  const { o } = C;
  return [
    `你是批 ${o.batch} 的执行会话:无头运行,由发车脚本拉起,没有人在看,也没有人会回答问题。按下面做完就结束。`,
    "",
    "## 用户原话(逐字)",
    o.instruction,
    "",
    `## 批号与完成条件(批 ${o.batch};开批已由发车脚本做完)`,
    ...condLines(o),
    ...(o.finishLine ? ["", "## 终点线", o.finishLine] : []),
    "",
    ...constraintLines(C),
    "",
  ].join("\n");
}
export function repairPrompt(C, k, items) {
  return [
    `回修第 ${k} 轮,共 ${REPAIR_MAX} 轮。发车脚本验收没过,不过项如下(原文):`,
    "",
    ...items.map((it, i) => `### 不过项 ${i + 1}(${it.kind})\n${it.text}`),
    "",
    `完成条件不变(批 ${C.o.batch}):`,
    ...condLines(C.o),
    "",
    ...constraintLines(C),
    "",
  ].join("\n");
}
function judgeInput(C) {
  const { o } = C;
  const diff = git(C.wt, ["diff", "--stat", `${C.baseCommit}..HEAD`]);
  return [
    "下面是四样材料:用户原话、完成标准、现状一页、待裁件。",
    "",
    "## 用户原话(逐字)",
    o.instruction,
    "",
    "## 完成标准(开批登记的原文)",
    ...condLines(o),
    ...(o.finishLine ? [`- 终点线:${o.finishLine}`] : []),
    "",
    "## 现状一页(只写事实)",
    `- 已拉起执行会话 ${C.launches.length} 次:${C.launches.map((r) => `第 ${r.k} 次 ${r.kind === "exec" ? "执行" : "回修"},分类 ${r.cls},轮数 ${r.turns ?? "未知"},花费 ${r.costUsd ?? "未知"} 美元`).join(";")}`,
    `- 已验收 ${C.R.acceptRounds} 次,每次的不过项条数:${C.failHistory.map((f) => f.length).join("、")}`,
    `- 检查结果:登记了 ${o.checks.length} 条可执行检查;最近一次 dry-check:${C.lastCheck || "未记"}`,
    `- 改动(git diff --stat 基点..HEAD):`,
    diff.status === 0 ? (diff.stdout.trim() || "(没有改动)") : `取不到(${tail(diff.stderr, 200)})`,
    `- 已花费 ${round4(C.spent)} 美元,整批上限 ${o.capUsd} 美元`,
    "",
    "- 下面的不过项全部来自机器检查(登记的检查命令的退出码与输出、git 状态、结清命令的拒绝原文、执行会话自己写的逐条裁决),不是审查者的意见;工作树要提交干净是关账的机械前提。",
    "",
    "## 待裁件(两次验收的不过项原文)",
    ...C.failHistory.slice(-2).map((items, i) => [`### 第 ${i + 1} 次验收`, ...items.map((it) => `- (${it.kind})${it.text}`)].join("\n")),
    "",
    "最后一行三选一:`方向判定:在路上` / `方向判定:偏了` / `方向判定:该停`。",
    "",
  ].join("\n");
}

// ── 子进程 ────────────────────────────────────────────────────────────────────────────
function git(cwd, args, timeout = 60_000) {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") + (r.error ? ` ${r.error.message}` : "") };
}
/** 调本脚本同目录那份 batch-goal(绝对路径)。sid ⇒ 子进程的 CLAUDE_CODE_SESSION_ID。 */
function bg(cwd, sid, args, timeout = 15 * 60_000) {
  const env = { ...process.env };
  if (sid) env.CLAUDE_CODE_SESSION_ID = sid;
  const r = spawnSync(process.execPath, ["--no-warnings", BG, ...args], { cwd, env, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") + (r.error ? ` ${r.error.message}` : "") };
}
/** claude 可执行文件。BATCH_RUN_CLAUDE_BIN 优先(.mjs / .js ⇒ 用本 node 跑);否则在 PATH 里找(Windows 上 .cmd 垫片走 shell)。 */
export function resolveClaudeBin(env = process.env) {
  const e = env.BATCH_RUN_CLAUDE_BIN;
  if (e) {
    if (!fs.existsSync(e)) return null;
    if (/\.(?:mjs|js)$/i.test(e)) return { cmd: process.execPath, pre: ["--no-warnings", e], shell: false, how: "BATCH_RUN_CLAUDE_BIN(node)" };
    const sh = /\.(?:cmd|bat)$/i.test(e);
    return { cmd: sh && /\s/.test(e) ? `"${e}"` : e, pre: [], shell: sh, how: "BATCH_RUN_CLAUDE_BIN" };
  }
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const d of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (!d) continue;
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) {
          const sh = /\.cmd$/i.test(n);
          return { cmd: sh && /\s/.test(p) ? `"${p}"` : p, pre: [], shell: sh, how: sh ? "PATH(.cmd 垫片,shell)" : "PATH" };
        }
      } catch { /* 没有就找下一个 */ }
    }
  }
  return null;
}
/** 杀子进程树。Windows 上先 `taskkill /T /F`;它起不来或没成功(退出码非 0)⇒ 退一步只杀直接子进程。
 *  返回「杀的动作发出去了没有」;进程退没退由 close 事件说,发出去了也可能不退——所以调用方另设宽限(见 runClaude 的 askKill)。
 *  BATCH_RUN_TEST_NO_KILL=1 只给自测用:什么都不杀,用来走「杀不掉」那条路。 */
function killTree(child) {
  if (!child || !child.pid) return false;
  if (process.env.BATCH_RUN_TEST_NO_KILL === "1") return false;
  let ok = false;
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 30_000 });
    ok = !r.error && r.status === 0;
  }
  if (!ok) { try { ok = child.kill("SIGKILL"); } catch { ok = false; } }
  return ok;
}
const KILL_GRACE_MS = 20_000;
/** 拉起一次 claude:提示词走 stdin;stdout / stderr 追加进日志;逐行扫最后一条 type:"result";到 deadlineAt 杀进程树。
 *  watch(看守实例,可缺):逐行把事件喂给它,命中 ⇒ 记下命中内容、日志里写一行、杀进程树(事件驱动,不另起定时器)。 */
function runClaude({ bin, args, cwd, input, log, deadlineAt, env, onPid, keepStdout = false, watch = null }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = fs.createWriteStream(log, { flags: "a" });
    out.write(`# batch-run ${new Date().toISOString()} bin=${bin.how} args=${args.join(" ")}\n`);
    let settled = false, killed = false, result = null, buf = "", all = "", spawnError = null, timer = null, hit = null, child = null, graceTimer = null, killStuck = null;
    const done = (code) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (buf) onLine(buf);
      out.end(() => resolve({ code, killed, result, spawnError, watch: hit, killStuck, ms: Date.now() - t0, stdout: all }));
    };
    // 看守命中或到截止时间 ⇒ 杀进程树;杀的动作发出去后进程迟迟不退(或根本杀不了)⇒ 宽限到了就不再等:
    //   松开它的管道与引用(否则本进程退不出去),按已经定下的原因停,并把「这个进程可能还活着」交给上层写进交接。
    //   原先杀的命令失败时没人知道,而本函数只等 close 事件 ⇒ 会一直等下去(批 307 codex 第 2 条)。
    const askKill = (why) => {
      const sent = killTree(child);
      out.write(`# ${why}:杀子进程树 pid ${child?.pid}${sent ? "" : "(杀的动作没发出去)"}\n`);
      if (graceTimer || settled) return;
      const grace = Math.max(50, Number(process.env.BATCH_RUN_KILL_GRACE_MS) || KILL_GRACE_MS);
      graceTimer = setTimeout(() => {
        if (settled) return;
        killStuck = child?.pid ?? null;
        out.write(`# 宽限 ${grace} 毫秒到了,pid ${killStuck} 还没退:不再等它\n`);
        try { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); } catch { /* 松不开也照常往下走 */ }
        done(-1);
      }, sent ? grace : Math.min(grace, 2000));
    };
    const onLine = (line) => {
      const s = line.trim();
      if (!s.startsWith("{")) return;
      let o;
      try { o = JSON.parse(s); } catch { return; /* 不是整行 JSON */ }
      if (o && o.type === "result") result = o;
      if (!watch || hit || settled) return;
      const h = watch.feed(o);
      if (!h) return;
      hit = h;
      out.write("\n");
      askKill(`看守:同一个工具调用(${h.tool})连着 ${h.count} 次报同样的错`);
    };
    try { child = spawn(bin.cmd, [...bin.pre, ...args], { cwd, env, shell: bin.shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch (e) { spawnError = e.message; out.write(`# 起不来:${e.message}\n`); return done(-1); }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s) => {
      if (settled) return;
      out.write(s);
      if (keepStdout) all += s;
      buf += s;
      let k;
      while ((k = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); }
    });
    child.stderr.on("data", (s) => { if (!settled) out.write(s); });
    child.stdin.on("error", () => { /* 子进程先退,写 stdin 撞 EPIPE:不影响判定 */ });
    child.on("error", (e) => { spawnError = e.message; out.write(`# 子进程错误:${e.message}\n`); setTimeout(() => done(-1), 200); });
    child.on("close", (code) => done(code ?? -1));
    if (child.pid && onPid) onPid(child.pid);
    timer = setTimeout(() => { if (settled) return; killed = true; askKill("到整批截止时间"); }, Math.max(0, deadlineAt - Date.now()));
    child.stdin.end(input);
  });
}

// ── 运行状态 ──────────────────────────────────────────────────────────────────────────
function atomicJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function stateOf(C) {
  const { o, R } = C;
  return {
    batch: o.batch, status: R.status === null ? "running" : R.status, stage: R.stage, reason: R.reason, reasonCode: R.reasonCode,
    pid: process.pid, childPid: C.childPid ?? null, sessionId: C.sid, launcherSession: C.launcherSid,
    worktree: fwd(C.wt), branch: C.branch, base: C.base, baseCommit: C.baseCommit,
    caps: { maxTurns: o.maxTurns, maxBudgetUsd: o.maxBudgetUsd, capUsd: o.capUsd, deadline: new Date(C.deadlineAt).toISOString(), sameErrorLimit: o.sameErrorLimit ?? null },
    model: o.model ?? null, judgeModel: o.judgeModel, instruction: o.instruction,
    rounds: C.launches, acceptRounds: R.acceptRounds, failHistory: C.failHistory.map((f) => f.map((i) => i.kind)),
    judge: C.judge, triage: C.triage ?? null, costUsd: round4(C.spent), merged: C.merged, pushed: R.pushed, handoff: R.handoff, ruler: R.ruler, notes: R.notes,
    startedAt: new Date(C.startMs).toISOString(), updatedAt: new Date().toISOString(),
  };
}
function saveState(C) {
  try { atomicJson(C.stateFile, stateOf(C)); } catch (e) { say(`运行状态写不进去(${e.code || e.message}):${C.stateFile}`); }
}
function note(C, s) { C.R.notes.push(s); say(s); }
function emitResult(R) {
  const keys = ["batch", "status", "reason", "reasonCode", "stage", "rounds", "acceptRounds", "costUsd", "sessionId", "worktree", "branch", "handoff", "ruler", "pushed", "notes", "triage"];
  process.stdout.write(RESULT_KEY + JSON.stringify(Object.fromEntries(keys.map((k) => [k, R[k] ?? (k === "notes" ? [] : k === "pushed" ? false : null)]))) + "\n");
}

// ── 发车前检查 ────────────────────────────────────────────────────────────────────────
function preflight(o, cwd = process.cwd()) {
  const no = (why) => ({ ok: false, why });
  const rp = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
  if (rp.status !== 0) return no(`当前目录不是 git 仓(${tail(rp.stderr, 200)})`);
  const [top, gitDir, common] = rp.stdout.split(/\r?\n/).map((x) => x.trim());
  if (!top || !gitDir || !common) return no("取不到仓根 / git 目录");
  if (normCheckout(gitDir) !== normCheckout(common)) return no("当前目录在一个 linked worktree 里:要在仓的主 checkout 根目录发车");
  if (normCheckout(top) !== normCheckout(cwd)) return no(`要在仓的主 checkout 根目录发车(当前 ${fwd(cwd)},仓根 ${fwd(top)})`);
  const br = git(top, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (br.status !== 0 || !br.stdout.trim()) return no("HEAD 不在分支上(游离 HEAD 没有基分支可并回)");
  const head = git(top, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !/^[0-9a-f]{40}/.test(head.stdout.trim())) return no("取不到 HEAD 提交(零提交的仓?)");
  if (!/^[\w.-]+$/.test(o.batch)) return no(`批号「${o.batch}」不合格`);
  if (!findBash()) return no("找不到 Git Bash(检查一律经 bash -c 跑;BATCH_GOAL_BASH 可指定)");
  const claude = resolveClaudeBin();
  if (!claude) return no("找不到 claude(PATH 里没有;BATCH_RUN_CLAUDE_BIN 可指定)");
  const wt = path.join(top, ".claude", "worktrees", `batch-${o.batch}`);
  if (fs.existsSync(wt)) return no(`工作树目录已存在:${fwd(wt)}(上一次的工作树还在;接着干就进去 claude --resume,否则先清掉)`);
  const branch = `batch-run/${o.batch}`;
  const sr = git(top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (sr.status === 0) return no(`分支 ${branch} 已存在`);
  if (sr.status !== 1) return no(`判不了分支 ${branch} 在不在(git show-ref 退出码 ${sr.status})`);
  const runDir = path.join(top, ".claude", ".batch-run");
  const stateFile = path.join(runDir, `${o.batch}.json`);
  if (fs.existsSync(stateFile)) return no(`批 ${o.batch} 发过车(运行状态 ${fwd(stateFile)} 已在);换一个批号,或确认不要了再删掉它`);
  let names = [];
  try { names = fs.readdirSync(runDir).filter((n) => n.endsWith(".json")); } catch (e) { if (e.code !== "ENOENT") return no(`读不了运行状态目录(${e.code})`); }
  for (const n of names) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(runDir, n), "utf8")); }
    catch (e) { return no(`运行状态 ${n} 读不了或坏了(${e.code || "解析失败"}),判不了有没有别的发车在跑`); }
    if (s && s.status === "running" && pidAlive(s.pid)) return no(`批 ${s.batch ?? n} 的发车还在跑(pid ${s.pid},${n});同时只跑一个`);
  }
  return { ok: true, root: top, base: br.stdout.trim(), baseCommit: head.stdout.trim().slice(0, 40), wt, branch, runDir, stateFile, claude };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────────────
function capGate(C) {
  if (Date.now() >= C.deadlineAt) return { code: "cap-deadline", why: `到整批截止时间(${new Date(C.deadlineAt).toISOString()})` };
  if (C.spent >= C.o.capUsd) return { code: "cap-usd", why: `整批累计花费 ${round4(C.spent)} 美元,到了上限 ${C.o.capUsd} 美元` };
  return null;
}
const fmtUsd = (x) => String(Math.max(0.01, Math.floor(x * 100) / 100));

async function launch(C, prompt, resume) {
  const { o, R } = C;
  const k = C.launches.length + 1;
  R.stage = "launch";
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto",
    "--max-turns", String(o.maxTurns), "--max-budget-usd", fmtUsd(Math.min(o.maxBudgetUsd, o.capUsd - C.spent)),
    ...(o.model ? ["--model", o.model] : []), ...(resume ? ["--resume", C.sid] : ["--session-id", C.sid])];
  const log = path.join(C.runDir, `${o.batch}-r${k}.log`);
  say(`第 ${k} 次拉起(${resume ? `回修第 ${C.repairs} 轮` : "执行"}),日志 ${fwd(log)}`);
  // 看守只挂执行与回修的拉起(方向复核那次不挂);sameErrorLimit 0 ⇒ 不挂
  const watch = o.sameErrorLimit > 0 ? createWatch({ sameErrorLimit: o.sameErrorLimit }) : null;
  const r = await runClaude({ bin: C.claude, args, cwd: C.wt, input: prompt, log, deadlineAt: C.deadlineAt, watch,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: C.sid }, onPid: (pid) => { C.childPid = pid; saveState(C); } });
  C.childPid = null;
  if (r.watch) C.watchHit = { ...r.watch, k };
  const c = classifyRun({ code: r.code, result: r.result, killed: r.killed, watch: r.watch });
  // 续接(--resume)时 CLI 报的 total_cost_usd 是**这个会话的累计值**,而 --max-budget-usd 是按本次拉起比的
  //   (实测 2026-11-22,claude 2.1.327:同一会话续接四次,读数 0.0112 → 0.0118 → 0.0136 → 0.0142 → 0.0147 单调增,
  //   只回两个字的一轮只多 0.0005;累计 0.0142 时带 --max-budget-usd 0.005 续接,照常 success)。
  //   所以回修轮按「本次读数 − 这个会话上一次的读数」记账;读数不增反降(CLI 改回按次计)⇒ 按本次读数整笔记。
  //   天花板:若将来改成按次计、而读数又恰好一次比一次大,会少算——单次拉起的 --max-budget-usd 仍是硬上限。
  const total = Number(r.result?.total_cost_usd);
  const costKnown = Number.isFinite(total) && total >= 0;
  const cost = costKnown ? launchCost(total, resume ? C.sessionCostSeen : null) : NaN;
  if (costKnown) { C.spent += cost; C.sessionCostSeen = total; }
  else note(C, `第 ${k} 次拉起没有花费读数(按 0 计)`);
  if (r.killStuck) note(C, `第 ${k} 次拉起的执行会话杀不掉或迟迟不退(pid ${r.killStuck}),发车脚本没有再等它:请手工确认这个进程已经不在,再接着干`);
  C.launches.push({ k, kind: resume ? "repair" : "exec", cls: c.cls, exitCode: r.code, subtype: r.result?.subtype ?? null, isError: r.result?.is_error ?? null,
    turns: r.result?.num_turns ?? null, costUsd: costKnown ? round4(cost) : null, ms: r.ms, log: fwd(log), watch: r.watch || null, ...(r.spawnError ? { spawnError: r.spawnError } : {}) });
  C.lastResultText = String(r.result?.result ?? "");
  R.rounds = C.launches.length; R.costUsd = round4(C.spent);
  saveState(C);
  say(`第 ${k} 次拉起结束:${c.cls}(${c.why}),累计花费 ${round4(C.spent)} 美元`);
  return c;
}

function readArmedAt(wt) {
  try { const g = JSON.parse(fs.readFileSync(path.join(wt, ".claude", ".batch-goal.json"), "utf8")); return typeof g.armedAt === "string" ? g.armedAt : null; } catch { return null; }
}
/** 读作业台账里属于本批的作业。台账件解析不了时:codex-run 的 worker 是先截断再写(不是原子写),读到半截是正常的瞬间
 *  ⇒ 隔一下重读,至多 4 次;还解析不了 ⇒ 看文件的修改时刻:开批之后动过的,可能就是本批的作业 ⇒ 报错(调用方按判不了停);
 *  开批之前就没再动过的坏件不可能是本批的 ⇒ 跳过(台账目录是全机共用的,别的仓留下的坏件不该拦住这一批)。
 *  原先解析不了一律跳过:唯一的外审作业恰好在被重写时,会被当成「本批没发起过外审」(批 306 独立审查发现 2)。 */
async function readJobs(root, sinceMs, wt) {
  let names;
  try { names = fs.readdirSync(root).filter((n) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(n)); }
  catch (e) { if (e.code === "ENOENT") return { jobs: [] }; return { error: `读不了作业台账目录(${e.code})` }; }
  const w = normCheckout(wt), jobs = [];
  for (const n of names) {
    const file = path.join(root, n);
    let j = null, gone = false;
    for (let k = 0; k < 4 && !j && !gone; k++) {
      if (k) await sleep(150);
      try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { j = null; if (e.code === "ENOENT") gone = true; }
      if (j === null || typeof j !== "object") j = null;
    }
    if (gone) continue;
    if (!j) {
      let m = NaN;
      try { m = fs.statSync(file).mtimeMs; } catch { m = NaN; }
      if (!Number.isFinite(m) || m >= sinceMs - 2000) return { error: `外审作业台账 ${n} 读不出(半截或坏件,开批之后动过),判不了它是不是本批的作业` };
      continue;
    }
    const t = Date.parse(j.startedAt || "");
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const c = normCheckout(j.cwd || "");
    if (!c || !(c === w || c.startsWith(w + "/"))) continue;
    jobs.push({ ...j, id: j.id || n.slice(0, -5) });
  }
  return { jobs: latestPerSlug(jobs) };
}
async function codexReviews(C) {
  const root = process.env.BATCH_RUN_CODEX_JOB_ROOT || CODEX_JOB_ROOT;
  const pollMs = Math.max(50, Number(process.env.BATCH_RUN_POLL_MS) || 5000);
  const since = Date.parse(C.armedAt);
  let got = await readJobs(root, since, C.wt);
  if (got.error) return { unknown: [got.error], items: [] };
  if (!got.jobs.length) return { unknown: [], items: [], none: true };
  while (got.jobs.some((j) => j.state === "running") && Date.now() < C.deadlineAt) {
    say(`等外审作业到终态:${got.jobs.filter((j) => j.state === "running").map((j) => j.id).join("、")}`);
    await sleep(Math.min(pollMs, Math.max(50, C.deadlineAt - Date.now())));
    got = await readJobs(root, since, C.wt);
    if (got.error) return { unknown: [got.error], items: [] };
  }
  const unknown = [], items = [];
  for (const j of got.jobs) {
    if (j.state === "running") { unknown.push(`外审作业 ${j.id} 到整批截止时间仍在跑`); continue; }
    if (j.state === "failed") { unknown.push(`外审作业 ${j.id} 失败了(${tail(j.error || j.errorCode || "未记原因", 200)})`); continue; }
    if (j.state !== "done") { unknown.push(`外审作业 ${j.id} 的状态认不出(${j.state})`); continue; }
    let body = null;
    try { body = fs.readFileSync(j.result, "utf8"); } catch { body = null; }
    if (body == null) { unknown.push(`外审作业 ${j.id} 的结果件读不到(${fwd(j.result) || "未记"})`); continue; }
    const v = reviewVerdict(body);
    if (v.v === "fail") items.push({ kind: "codex", text: `外审作业 ${j.id}(${j.slug || "无 slug"})的结论是要改。结果件 ${fwd(j.result)},最后一行:${v.line}` });
    else if (v.v === "unknown") unknown.push(`外审作业 ${j.id} 的结果件最后一行不是固定结论(${tail(v.line, 120) || "空"})`);
  }
  return { unknown, items };
}

/** 验收(3.6)。onlyStatic ⇒ 只做第 1、2 项(rebase 后重验用)。返回 { pass, unknown:[]|null, items, verdicts }。 */
async function accept(C, { onlyStatic = false } = {}) {
  const { o, R } = C;
  R.stage = "accept";
  if (!onlyStatic) R.acceptRounds++;
  const items = [], unknown = [];
  const st = git(C.wt, ["status", "--porcelain", "--untracked-files=all"]);
  if (st.status !== 0) unknown.push(`git status 跑不起来:${tail(st.stderr, 200)}`);
  else {
    const p = porcelainIssues(st.stdout);
    if (p.tracked.length) items.push({ kind: "uncommitted", text: `有 ${p.tracked.length} 个已跟踪文件的改动没提交:\n${p.tracked.slice(0, 30).map((x) => `  ${x}`).join("\n")}` });
    if (p.untracked.length) items.push({ kind: "untracked", text: `有 ${p.untracked.length} 个未跟踪、未忽略的新文件(是本批的就 git add 再提交,是临时件就删掉):\n${p.untracked.slice(0, 30).map((x) => `  ${x}`).join("\n")}` });
  }
  const dc = bg(C.wt, C.sid, ["--dry-check"]);
  if (dc.status === 0 && /可执行判据全过/.test(dc.stdout)) C.lastCheck = "全过";
  else if (dc.status === 2 && /条未过/.test(dc.stderr)) { C.lastCheck = "没过"; items.push({ kind: "check", text: `硬门 batch-goal --dry-check 没过:\n${tail(dc.stderr, 3000)}` }); }
  else { C.lastCheck = "判不了"; unknown.push(`batch-goal --dry-check 判不了(退出码 ${dc.status}):${tail(dc.stdout + "\n" + dc.stderr, 400)}`); }
  if (onlyStatic) return { pass: !items.length && !unknown.length, unknown: unknown.length ? unknown : null, items, verdicts: [] };
  const v = parseVerdicts(C.lastResultText, o.conds.length);
  for (const p of v.problems) items.push({ kind: "verdict", text: p });
  const cx = await codexReviews(C);
  unknown.push(...cx.unknown);
  items.push(...cx.items);
  say(`第 ${R.acceptRounds} 次验收:${unknown.length ? `判不了 ${unknown.length} 项` : items.length ? `不过 ${items.length} 项` : "全过"}${cx.none ? "(本批没发起过外审作业,那一项跳过)" : ""}`);
  return { pass: !items.length && !unknown.length, unknown: unknown.length ? unknown : null, items, verdicts: v.verdicts };
}

async function directionJudge(C) {
  const { o, R } = C;
  R.stage = "judge";
  const gate = capGate(C);
  if (gate) { note(C, `方向复核没拉:${gate.why}`); C.judge = { verdict: null, why: gate.why }; return {}; }
  const args = ["-p", "--agent", "_direction-judge", "--model", o.judgeModel, "--permission-mode", "auto",
    "--max-turns", String(JUDGE_MAX_TURNS), "--max-budget-usd", fmtUsd(Math.min(JUDGE_MAX_USD, o.capUsd - C.spent)), "--output-format", "json"];
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;   // 复核者是另一个会话,不顶执行会话的号
  const log = path.join(C.runDir, `${o.batch}-judge.log`);
  say(`第二次验收不过:先拉一次方向复核,日志 ${fwd(log)}`);
  const r = await runClaude({ bin: C.claude, args, cwd: C.wt, input: judgeInput(C), log, deadlineAt: C.deadlineAt, env, keepStdout: true });
  let obj = r.result;
  if (!obj) { try { obj = JSON.parse(String(r.stdout || "").trim()); } catch { obj = null; } }
  const cost = Number(obj?.total_cost_usd);
  if (Number.isFinite(cost) && cost >= 0) { C.spent += cost; R.costUsd = round4(C.spent); }
  const text = String(obj?.result ?? "");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = /方向判定\s*[:：]\s*(在路上|偏了|该停)/.exec(lines[lines.length - 1] || "");
  if (r.killed || !obj || obj.is_error === true || !m) {
    const why = r.killed ? "到截止时间被杀" : !obj ? `读不出输出(退出码 ${r.code})` : obj.is_error ? "复核会话报错" : "最后一行不是三选一的方向判定";
    C.judge = { verdict: null, why, costUsd: Number.isFinite(cost) ? round4(cost) : null };
    note(C, `方向复核判不了(${why}),照常回修`);
    saveState(C);
    return {};
  }
  C.judge = { verdict: m[1], costUsd: Number.isFinite(cost) ? round4(cost) : null, text };
  saveState(C);
  say(`方向复核:${m[1]}`);
  if (m[1] === "在路上") return {};
  return { stop: true, code: m[1] === "偏了" ? "judge-off" : "judge-stop", why: `方向复核判「${m[1]}」` };
}

function pushBase(C) {
  const { o, R } = C;
  R.stage = "push";
  const u = git(C.root, ["remote", "get-url", o.push]);
  if (u.status !== 0) return { stop: { code: "push-failed", why: `远端 ${o.push} 取不到地址(${tail(u.stderr, 200)})`, stage: "push" } };
  const name = repoNameOf(u.stdout.trim());
  const conf = readInstallConfig(undefined, path.join(C.root, INSTALL_CONFIG_FILE));
  const names = installNames(conf).privateRepos;
  if (!name || !names.includes(name)) {
    note(C, `未推送:远端不在私仓名单(远端 ${o.push} 的仓名 ${name || "认不出"};名单 = ${INSTALL_CONFIG_FILE} 的 privateRepos${conf.error ? `,配置读不了:${conf.error}` : ""})`);
    return {};
  }
  const ps = git(C.root, ["push", o.push, C.base], 300_000);
  if (ps.status !== 0) return { stop: { code: "push-failed", why: `git push ${o.push} ${C.base} 失败:${tail(ps.stderr, 300)}`, stage: "push" } };
  const ls = git(C.root, ["ls-remote", o.push, `refs/heads/${C.base}`], 120_000);
  const remote = ls.stdout.trim().split(/\s+/)[0] || "";
  const local = git(C.root, ["rev-parse", C.base]).stdout.trim();
  if (ls.status !== 0 || !local || remote !== local) return { stop: { code: "push-mismatch", why: `推送后回读不一致(远端 ${remote || "取不到"},本地 ${local || "取不到"})`, stage: "push" } };
  R.pushed = true; C.pushedNow = true;
  note(C, `已推送 ${C.base} 到 ${o.push},回读一致(${local.slice(0, 12)})`);
  return {};
}

/** 关账(3.8)。返回 { closed:true } | { stop:{code,why,stage} } | { fail:[不过项] }(--clear 拒清 / rebase 后重验不过)。 */
async function closeOut(C, acc) {
  const { o, R } = C;
  C.pushedNow = false;
  if (!o.noMerge) {
    R.stage = "merge";
    const cur = git(C.root, ["symbolic-ref", "-q", "--short", "HEAD"]);
    if (cur.status !== 0 || cur.stdout.trim() !== C.base) return { stop: { code: "main-moved", why: `主 checkout 不在基分支 ${C.base} 上了(现在:${cur.stdout.trim() || "游离或取不到"}),不并`, stage: "merge" } };
    const anc = git(C.root, ["merge-base", "--is-ancestor", C.base, C.branch]);
    if (anc.status === 1) {
      R.stage = "rebase";
      const rb = git(C.wt, ["rebase", C.base], 300_000);
      if (rb.status !== 0) {
        const ab = git(C.wt, ["rebase", "--abort"]);
        return { stop: { code: "rebase-conflict", why: `基分支 ${C.base} 前进过,在工作树里 rebase 不成(${tail(rb.stdout + "\n" + rb.stderr, 300)});已 git rebase --abort${ab.status === 0 ? "" : `(abort 也失败了:${tail(ab.stderr, 200)})`}`, stage: "rebase" } };
      }
      note(C, `基分支 ${C.base} 前进过,已在工作树里 rebase 一次`);
      const re = await accept(C, { onlyStatic: true });
      if (re.unknown) return { stop: { code: "accept-unknown", why: `rebase 后重验判不了:${re.unknown.join(";")}`, stage: "rebase" } };
      if (re.items.length) return { fail: re.items.map((i) => ({ ...i, text: `(rebase 到 ${C.base} 之后)${i.text}` })) };
      R.stage = "merge";
      const anc2 = git(C.root, ["merge-base", "--is-ancestor", C.base, C.branch]);
      if (anc2.status !== 0) return { stop: { code: "merge-unknown", why: "rebase 之后仍判不成能快进", stage: "merge" } };
    } else if (anc.status !== 0) return { stop: { code: "merge-unknown", why: `判不了能不能快进(git merge-base 退出码 ${anc.status})`, stage: "merge" } };
    const mg = git(C.root, ["merge", "--ff-only", C.branch], 120_000);
    if (mg.status !== 0) return { stop: { code: "merge-refused", why: `git merge --ff-only 被拒(主 checkout 可能有本地改动;脚本不 stash / reset / checkout 主树):${tail(mg.stderr, 300)}`, stage: "merge" } };
    C.merged = true;
    saveState(C);
    if (o.push) { const p = pushBase(C); if (p.stop) return p; }
  } else if (o.push) note(C, "给了 --no-merge:不并回,也不推送(--push 不生效)");
  if (C.pushedNow && fs.existsSync(path.join(C.root, "scripts", "verify-prod.mjs"))) {
    R.stage = "probe";
    const pr = spawnSync(process.execPath, ["--no-warnings", path.join(C.root, "scripts", "verify-prod.mjs"), "--debt-only"], { cwd: C.root, encoding: "utf8", windowsHide: true, timeout: 300_000 });
    if (pr.status !== 0) return { stop: { code: "probe-failed", why: `欠账探针 verify-prod.mjs --debt-only 没过(退出码 ${pr.status ?? "超时"}):${tail(String(pr.stdout || "") + "\n" + String(pr.stderr || ""), 300)}`, stage: "probe" } };
  }
  R.stage = "clear";
  const vargs = acc.verdicts.flatMap((v) => ["--verdict", v.verdict === "达成" ? `${v.n}=达成` : `${v.n}=${v.verdict}:${v.why}`]);
  const cl = bg(C.wt, C.sid, ["--clear", ...vargs]);
  if (cl.status === 0) {
    R.ruler = cl.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("主尺")) || null;
    return { closed: true };
  }
  const ref = cl.status === 2 ? clearRefusal(cl.stderr) : null;
  if (ref && ref.repairable) return { fail: [{ kind: "clear-refused", text: `batch-goal --clear 拒绝结清(原文):\n${tail(cl.stderr, 3000)}` }] };
  if (ref) return { stop: { code: "clear-unknown", why: `batch-goal --clear 拒绝结清,拒因 ${ref.reason} 不是执行会话回修得了的(判不了 / 状态对不上一类):${tail(cl.stderr, 400)}`, stage: "clear" } };
  return { stop: { code: "clear-unknown", why: `batch-goal --clear 退出码 ${cl.status}:${tail(cl.stdout + "\n" + cl.stderr, 300)}`, stage: "clear" } };
}

/** 工作树里只剩「运行时残留」时把它们删掉,好让不带 --force 的 `git worktree remove` 走得通。
 *  实撞(2026-11-22,没装闸的空仓里真跑一次):批已并回、已结清,工作树里还有三个未跟踪文件——批状态与批台账
 *  (`.claude/` 下;目标仓没忽略它们时算未跟踪)和结清时后台盲审写的日志——git 因此拒删,工作树与分支留了下来。
 *  这些文件在忽略了它们的仓里本来就会随工作树一起删掉;批台账的 arm / clear 行已镜像到主树。
 *  只在**全部**未提交项都是未跟踪、且都属于下面两类时才动;有一项不是 ⇒ 一个都不删,交给 git 去拒。 */
const isRuntimeLeftover = (p) => isRuntimePath(p) || p === "clipboard/codex/fp-audit-last.log";
function dropRuntimeLeftovers(C) {
  const st = git(C.wt, ["status", "--porcelain", "--untracked-files=all"]);
  if (st.status !== 0) return;
  const rows = st.stdout.split(/\r?\n/).filter((l) => l.trim());
  if (!rows.length) return;
  const paths = [];
  for (const l of rows) {
    const p = l.slice(3).replace(/^"(.*)"$/, "$1").replace(/\\/g, "/");
    if (l.slice(0, 2) !== "??" || !isRuntimeLeftover(p) || p.includes("..")) return;
    paths.push(p);
  }
  for (const p of paths) { try { fs.rmSync(path.join(C.wt, p), { force: true }); } catch { /* 删不掉 ⇒ 下面的 git worktree remove 照旧会拒,只记一行 */ } }
}

async function cleanup(C) {
  if (!C.merged) { note(C, "--no-merge:工作树与分支都留着"); return; }
  C.R.stage = "cleanup";
  let ok = false, last = "";
  for (let i = 0; i < 3 && !ok; i++) {
    if (i) await sleep(1000);   // 关账时后台起的盲审进程可能还占着工作树里的文件,等一下再试
    dropRuntimeLeftovers(C);
    const r = git(C.root, ["worktree", "remove", C.wt]);
    ok = r.status === 0; last = r.stderr;
    if (!ok && !fs.existsSync(C.wt)) { git(C.root, ["worktree", "prune"]); ok = true; }
  }
  if (!ok) { note(C, `清理:git worktree remove 没成(${tail(last, 200)}),工作树留着`); return; }
  const b = git(C.root, ["branch", "-d", C.branch]);
  if (b.status !== 0) note(C, `清理:git branch -d ${C.branch} 没成(${tail(b.stderr, 200)})`);
}

function stuckSection(C) {
  const { o, R } = C;
  const L = ["", "## 卡在哪(发车脚本写)", ""];
  L.push(`- 停在:${R.stage}(${R.reasonCode})`);
  L.push(`- 原因:${R.reason}`);
  L.push(`- 拉起:${C.launches.length} 次${C.launches.length ? "——" + C.launches.map((r) => `第 ${r.k} 次${r.kind === "exec" ? "执行" : "回修"}:${r.cls}(花费 ${r.costUsd ?? "未知"} 美元,轮数 ${r.turns ?? "未知"},${Math.round(r.ms / 1000)} 秒)`).join(";") : ""}`);
  L.push(`- 验收:${R.acceptRounds} 次;最后一次验收的不过项:${C.lastItems && C.lastItems.length ? "" : "无"}`);
  for (const it of C.lastItems || []) L.push(`  - (${it.kind})${String(it.text).replace(/\n/g, "\n    ")}`);
  if (C.lastUnknown && C.lastUnknown.length) { L.push("- 判不了的项:"); for (const u of C.lastUnknown) L.push(`  - ${u}`); }
  if (C.watchHit) {
    const w = C.watchHit;
    L.push(`- 看守:第 ${w.k} 次拉起里,同一个工具调用连着 ${w.count} 次报同样的错,执行会话被杀掉(线:${w.lane === "main" ? "主会话" : `子代理 ${w.lane}`})`);
    L.push(`  - 工具:${w.tool}`);
    L.push(`  - 入参(JSON,前 300 字):${w.input}`);
    L.push(`  - 错误(空白已折叠,前 500 字):${w.error || "(空)"}`);
  }
  L.push(`- 方向复核:${C.judge ? (C.judge.verdict ? `判「${C.judge.verdict}」` : `判不了(${C.judge.why})`) : "没拉"}`);
  L.push(`- 花费:累计 ${round4(C.spent)} 美元 / 整批上限 ${o.capUsd} 美元(单次拉起上限 ${o.maxBudgetUsd} 美元,轮数上限 ${o.maxTurns});整批截止 ${new Date(C.deadlineAt).toISOString()}`);
  L.push(`- 执行会话号:${C.sid}`);
  L.push(`- 工作树:${fwd(C.wt)};分支:${C.branch};基分支:${C.base}(基点 ${String(C.baseCommit).slice(0, 12)})`);
  L.push(`- 已并回基分支:${C.merged ? "是(--clear 没过,批仍未结清)" : "否"};已推送:${R.pushed ? "是" : "否"}`);
  if (R.notes.length) { L.push("- 备注:"); for (const n of R.notes) L.push(`  - ${n}`); }
  L.push(`- 怎么接着干:进工作树 \`cd "${fwd(C.wt)}"\`,再 \`claude --resume ${C.sid}\`。批 ${o.batch} 没有结清,工作树与分支都留着。`);
  if (C.judge && C.judge.text && C.judge.verdict && C.judge.verdict !== "在路上") L.push("", "### 方向复核全文", "", C.judge.text);
  return L.join("\n") + "\n";
}
function writeHandoff(C) {
  const { o, R } = C;
  const out = path.resolve(o.handoffOut || path.join(C.runDir, `${o.batch}-handoff.md`));
  const cwd = C.wt && fs.existsSync(C.wt) ? C.wt : C.root;
  const sec = stuckSection(C);
  const h = bg(cwd, C.sid, ["--handoff", "--out", out], 120_000);
  if (h.status !== 0) { process.stderr.write(`[batch-run] 交接写不出来(batch-goal --handoff 退出码 ${h.status}:${tail(h.stderr, 300)}),卡在哪如下:\n${sec}`); return; }
  try { fs.appendFileSync(out, sec, "utf8"); R.handoff = fwd(out); say(`交接已写:${fwd(out)}`); }
  catch (e) { R.handoff = fwd(out); process.stderr.write(`[batch-run] 交接正文写了,「卡在哪」追加不进去(${e.code || e.message}):\n${sec}`); }
}
function appendRun(C) {
  const { o, R } = C;
  const row = { at: new Date().toISOString(), batch: o.batch, status: R.status, reason: R.reason, reasonCode: R.reasonCode, stage: R.stage,
    rounds: C.launches.map((r) => ({ k: r.k, kind: r.kind, cls: r.cls, turns: r.turns, costUsd: r.costUsd, ms: r.ms })),
    acceptRounds: R.acceptRounds, judge: C.judge ? (C.judge.verdict || "判不了") : null, watch: C.watchHit || null, triage: C.triage ?? null, costUsd: round4(C.spent),
    model: o.model ?? null, judgeModel: o.judgeModel, sessionId: C.sid, ruler: R.ruler, pushed: R.pushed, totalMs: Date.now() - C.startMs };
  try { fs.mkdirSync(C.runDir, { recursive: true }); fs.appendFileSync(path.join(C.runDir, "runs.jsonl"), JSON.stringify(row) + "\n", "utf8"); }
  catch (e) { say(`runs.jsonl 写不进去(${e.code || e.message})`); }
}
function finish(C, status, exitCode) {
  C.R.status = status;
  saveState(C);
  appendRun(C);
  emitResult(C.R);
  return exitCode;
}
function stop(C, code, why, stage) {
  const { R } = C;
  R.reasonCode = code; R.reason = why;
  if (stage) R.stage = stage;
  say(`停下:${why}`);
  writeHandoff(C);
  return finish(C, "stopped", 10);
}

async function drive(C) {
  const { o, R } = C;
  saveState(C);
  R.stage = "worktree";
  const wa = git(C.root, ["worktree", "add", C.wt, "-b", C.branch]);
  if (wa.status !== 0) {
    R.reasonCode = "worktree-failed"; R.reason = `建工作树失败:${tail(wa.stderr, 300)}`;
    say(R.reason);
    writeHandoff(C);
    return finish(C, "error", 1);
  }
  R.worktree = fwd(C.wt); R.branch = C.branch;
  R.stage = "arm";
  const armArgs = ["--arm", o.batch, "--instruction", o.instruction, ...(C.launcherSid ? ["--instruction-session", C.launcherSid] : []),
    ...(o.finishLine ? ["--finish-line", o.finishLine] : []), "--cap-usd", String(o.capUsd), "--deadline", new Date(C.deadlineAt).toISOString(), ...o.arm];
  const ar = bg(C.wt, C.sid, armArgs, 120_000);
  if (ar.status !== 0) return stop(C, "arm-failed", `开批失败(batch-goal --arm 退出码 ${ar.status}):${tail(ar.stderr, 400)}`, "arm");
  C.armedAt = readArmedAt(C.wt) || new Date(C.startMs).toISOString();
  saveState(C);
  let prompt = execPrompt(C), resume = false;
  for (;;) {
    const gate = capGate(C);
    if (gate) return stop(C, gate.code, gate.why, "launch");
    const c = await launch(C, prompt, resume);
    if (c.cls !== "done") return stop(C, c.code, c.why, "launch");
    let acc = await accept(C);
    C.lastUnknown = acc.unknown || [];
    if (acc.unknown) { C.lastItems = acc.items; return stop(C, "accept-unknown", `验收判不了:${acc.unknown.join(";")}`, "accept"); }
    if (acc.pass) {
      const cl = await closeOut(C, acc);
      if (cl.closed) {
        await cleanup(C);
        R.stage = "done"; R.reasonCode = "closed"; R.reason = "验收全过,已关账";
        return finish(C, "closed", 0);
      }
      if (cl.stop) return stop(C, cl.stop.code, cl.stop.why, cl.stop.stage);
      acc = { pass: false, items: cl.fail };
    }
    C.failHistory.push(acc.items); C.lastItems = acc.items;
    saveState(C);
    if (C.repairs >= REPAIR_MAX) return stop(C, "repair-exhausted", `回修 ${REPAIR_MAX} 轮后验收仍不过`, "accept");
    if (C.failHistory.length === 2) {
      const j = await directionJudge(C);
      if (j.stop) return stop(C, j.code, j.why, "judge");
    }
    C.repairs++;
    prompt = repairPrompt(C, C.repairs, acc.items); resume = true;
  }
}

async function runBatch(o) {
  const R = { batch: o.batch, status: null, reason: null, reasonCode: null, stage: "preflight", rounds: 0, acceptRounds: 0, costUsd: 0,
    sessionId: null, worktree: null, branch: null, handoff: null, ruler: null, pushed: false, notes: [] };
  const pf = preflight(o);
  if (!pf.ok) { R.status = "refused"; R.reasonCode = "refused"; R.reason = pf.why; say(`拒绝发车:${pf.why}`); emitResult(R); return 2; }
  // 分流:发车前检查的最后一步(要问模型,放在便宜的检查之后;拒绝时什么都不起,只往 triage.jsonl 记一行判词)
  const conf = readTriageConfig(pf.root);
  if (conf.error) say(conf.error);
  for (const n of conf.notes) say(n);
  const tv = await decideTriage(o, conf, { bin: pf.claude });
  R.triage = tv; R.costUsd = round4(Number.isFinite(tv.costUsd) ? tv.costUsd : 0);
  say(`分流:${tv.route}(${tv.source})${tv.reason}`);
  appendLedger(pf.root, verdictRow(tv, { instruction: o.instruction, batch: o.batch, via: "batch-run" }));
  const dec = routeDecision(o, tv, conf);
  if (dec.refuse) { R.status = "refused"; R.reasonCode = dec.refuse.code; R.reason = dec.refuse.why; say(`拒绝发车:${dec.refuse.why}`); emitResult(R); return 2; }
  o = { ...o, arm: dec.arm, conds: dec.conds, checks: dec.checks };
  const startMs = Date.now();
  const sidEnv = process.env.CLAUDE_CODE_SESSION_ID;
  const C = { o, R, ...pf, sid: crypto.randomUUID(), launcherSid: typeof sidEnv === "string" && /^[\w-]{8,80}$/.test(sidEnv) ? sidEnv : null,
    startMs, deadlineAt: startMs + o.deadlineMin * 60_000, spent: Number.isFinite(tv.costUsd) ? tv.costUsd : 0, triage: tv, launches: [], failHistory: [], lastItems: [], lastUnknown: [],
    judge: null, repairs: 0, merged: false, pushedNow: false, childPid: null, armedAt: null, lastResultText: "", lastCheck: null, sessionCostSeen: null, watchHit: null };
  R.sessionId = C.sid;
  try { return await drive(C); }
  catch (e) {
    R.reasonCode = "internal"; R.reason = `内部错误:${e && e.stack ? tail(e.stack, 600) : String(e)}`;
    say(R.reason);
    try { writeHandoff(C); } catch (e2) { say(`交接也写不出来:${e2.message}`); }
    return finish(C, "error", 1);
  }
}

// ── --status(只读)──────────────────────────────────────────────────────────────────
function statusCmd(batch) {
  const rp = git(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (rp.status !== 0) { console.error("不在 git 仓里"); return 2; }
  const root = path.dirname(rp.stdout.trim());
  const dir = path.join(root, ".claude", ".batch-run");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { names = []; }
  if (!names.length) console.log(`没有运行状态(${fwd(dir)} 不在或为空)`);
  for (const n of names) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch (e) { console.log(`  ${n}:读不了(${e.code || "解析失败"})`); continue; }
    if (batch && s.batch !== batch) continue;
    const alive = s.status === "running" ? (pidAlive(s.pid) ? ",进程活着" : ",进程已不在(上次中断了)") : "";
    console.log(`  批 ${s.batch}:${s.status}${alive} · 站 ${s.stage} · ${s.reasonCode || ""} · 拉起 ${(s.rounds || []).length} 次 · 验收 ${s.acceptRounds ?? 0} 次 · 花费 ${s.costUsd} 美元 · 会话 ${s.sessionId}`);
    if (batch) console.log(JSON.stringify(s, null, 2));
  }
  let rows = [];
  try { rows = fs.readFileSync(path.join(dir, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { rows = []; }
  if (batch) rows = rows.filter((r) => r.batch === batch);
  if (rows.length) console.log(`── runs.jsonl 最近 ${Math.min(10, rows.length)} 行 ──`);
  for (const r of rows.slice(-10)) console.log(`  ${r.at} 批 ${r.batch} ${r.status}(${r.reasonCode}) 拉起 ${(r.rounds || []).length} 次 验收 ${r.acceptRounds} 次 花费 ${r.costUsd} 美元${r.ruler ? ` · ${r.ruler.slice(0, 60)}` : ""}`);
  return 0;
}

// ── 自测 ──────────────────────────────────────────────────────────────────────────────
// 假 claude:每次被拉起按序号执行剧本里的一步(写文件 / 提交 / 动基分支 / 造外审作业 / 逐行吐流式事件 / 睡),再打印一条 result 事件并以指定退出码退出。
const FAKE_CLAUDE_SRC = String.raw`
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(process.env.BATCH_RUN_FAKE_PLAN, "utf8"));
const callsFile = process.env.BATCH_RUN_FAKE_CALLS;
const kind = argv.includes("--tools") ? "triage" : argv.includes("--agent") ? "judge" : "exec";
let prior = [];
try { prior = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
const idx = prior.filter((c) => c.kind === kind).length;
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const stdin = Buffer.concat(chunks).toString("utf8");
fs.appendFileSync(callsFile, JSON.stringify({ kind, idx, argv, cwd: process.cwd(), stdin, env: { sid: process.env.CLAUDE_CODE_SESSION_ID || null } }) + "\n");
if (kind === "triage") {   // 分流的便宜模型:一个 json 结果(--output-format json 的形状)
  const st = (plan.triage || [])[idx] || { reply: "剧本没有这一步" };
  if (st.sleepMs) await new Promise((r) => setTimeout(r, st.sleepMs));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: st.reply ?? "", total_cost_usd: st.cost ?? 0.001, num_turns: 1 }) + "\n");
  process.exit(st.code ?? 0);
}
const step = ((kind === "judge" ? plan.judge : plan.steps) || [])[idx] || { result: { text: "剧本没有这一步" } };
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", windowsHide: true });
for (const a of step.actions || []) {
  if (a.write) { const f = path.join(process.cwd(), a.write); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, a.content ?? "x\n"); }
  if (a.commit) { git(process.cwd(), "add", "-A"); git(process.cwd(), "commit", "-q", "-m", a.commit); }
  if (a.main) { const M = process.env.BATCH_RUN_FAKE_MAIN; fs.writeFileSync(path.join(M, a.main), a.content ?? "m\n"); git(M, "add", a.main); git(M, "commit", "-q", "-m", "base moves"); }
  if (a.job) {
    const R = process.env.BATCH_RUN_CODEX_JOB_ROOT; fs.mkdirSync(R, { recursive: true });
    const id = "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const res = path.join(R, id + "-r1.md"); fs.writeFileSync(res, a.job.body ?? "");
    fs.writeFileSync(path.join(R, id + ".json"), JSON.stringify({ id, state: a.job.state, startedAt: new Date().toISOString(), cwd: process.cwd(), slug: a.job.slug, result: res, log: path.join(R, id + ".log"), error: a.job.error }));
    await new Promise((r) => setTimeout(r, 5));
  }
}
// 剧本里的流式事件(assistant 的 tool_use、user 的 tool_result …)逐行吐出,先于长睡,好让看守在睡着时就能命中
for (const ev of step.stream || []) process.stdout.write(JSON.stringify(ev) + "\n");
if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
const sid =argv.includes("--session-id") ? argv[argv.indexOf("--session-id") + 1] : argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : "judge";
const lines = kind === "judge" ? [] : [JSON.stringify({ type: "system", subtype: "init", session_id: sid })];
if (step.result !== null) {
  const r = step.result || {};
  // 与真 CLI 同形:续接(--resume)时 total_cost_usd 报的是这个会话的累计值(剧本里的 cost 是每一步自己的花费)
  const own = (st) => (st && st.result === null ? 0 : (st && st.result && st.result.cost) ?? 0.01);
  const before = kind === "exec" && argv.includes("--resume") ? (plan.steps || []).slice(0, idx).reduce((s, st) => s + own(st), 0) : 0;
  lines.push(JSON.stringify({ type: "result", subtype: r.subtype ?? "success", is_error: r.is_error ?? false, result: r.text ?? "", total_cost_usd: before + (r.cost ?? 0.01), num_turns: 3, session_id: sid }));
}
process.stdout.write(lines.join("\n") + "\n");
process.exit(step.code ?? 0);
`;

async function selfTest() {
  const T0 = Date.now();
  let pass = 0, fail = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      得到 ${JSON.stringify(got)}\n      期待 ${JSON.stringify(want)}`}`);
  };

  // ── 纯函数 ──
  const cr = (code, subtype, is_error, text = "") => classifyRun({ code, result: { type: "result", subtype, is_error, result: text } }).cls;
  t("分类:实测表第 1 行 撞轮数(退出 1,error_max_turns,is_error 真)⇒ cap", cr(1, "error_max_turns", true), "cap");
  t("分类:实测表第 2 行 撞花费(退出 1,error_max_budget_usd,is_error 真)⇒ cap", cr(1, "error_max_budget_usd", true), "cap");
  t("分类:实测表第 3 行 正常跑完(退出 0,success,is_error 假)⇒ done", cr(0, "success", false), "done");
  t("分类:实测表第 4 行 撞账户额度(退出 1,success,is_error 真,文字像额度)⇒ quota", cr(1, "success", true, "Claude AI usage limit reached|1763800000"), "quota");
  t("分类:is_error 真、success、文字不像额度 ⇒ failed;不能只看 subtype", cr(1, "success", true, "something broke"), "failed");
  t("分类:没有 result 事件 / 被截止时间杀掉 / 退出 0 却 is_error 真且非 success ⇒ unknown / cap / unknown",
    [classifyRun({ code: 0, result: null }).cls, classifyRun({ code: null, result: null, killed: true }).code, cr(0, "error_during_execution", true)], ["unknown", "cap-deadline", "unknown"]);
  t("分类:退出码非 0 但 result 说 success 且 is_error 假 ⇒ unknown(不猜成跑完)", cr(1, "success", false), "unknown");
  { const wh = { code: "same-error", tool: "Bash", input: "{}", error: "Exit code 1", count: 3, lane: "main" };
    const a = classifyRun({ code: 0, result: { type: "result", subtype: "success", is_error: false, result: "" }, killed: true, watch: wh });
    t("分类:看守命中 ⇒ stalled / watch-same-error,压过截止时间被杀与 result 事件;why 点名工具与次数",
      [a.cls, a.code, a.why.includes("(Bash)"), a.why.includes("连着 3 次")], ["stalled", "watch-same-error", true, true]);
    t("分类:watch 为 null ⇒ 照旧(被杀 ⇒ cap-deadline;跑完 ⇒ done)",
      [classifyRun({ code: null, result: null, killed: true, watch: null }).code, classifyRun({ code: 0, result: { type: "result", subtype: "success", is_error: false }, watch: null }).code], ["cap-deadline", "done"]); }
  t("裁决:全角冒号与全角数字都认,同一条取最后一次", parseVerdicts("条件1:未达成:先写着\n…\n条件１：达成\n条件2:不适用:本仓没有日记。", 2),
    { verdicts: [{ n: 1, verdict: "达成" }, { n: 2, verdict: "不适用", why: "本仓没有日记" }], problems: [] });
  { const p = parseVerdicts("条件1:达成", 2); t("裁决:缺一条 ⇒ 不过项点名缺哪条,verdicts 不给", [p.verdicts, p.problems.length, /缺条件2/.test(p.problems[0])], [[], 1, true]); }
  { const p = parseVerdicts("条件1:未达成:接口不够\n条件2:不适用", 2); t("裁决:未达成 ⇒ 不过项;不适用不带理由 ⇒ 不过项", [p.problems.length, /未达成:接口不够/.test(p.problems[0]), /没写理由/.test(p.problems[1])], [2, true, true]); }
  t("结清被拒:补得上的拒因才回修(单个与 + 连起来的);判不了 / 对不上一类不回修;没有拒清行 ⇒ null",
    [clearRefusal("BATCH-GOAL-CLEAR-REFUSED batch=9 reason=checks-failed n=1\n拒绝结清:…"), clearRefusal("BATCH-GOAL-CLEAR-REFUSED batch=9 reason=adr-missing+diary-missing"),
      clearRefusal("BATCH-GOAL-CLEAR-REFUSED batch=9 reason=worktree-unknown"), clearRefusal("BATCH-GOAL-CLEAR-REFUSED batch=9 reason=uncommitted+obligation-unknown"),
      clearRefusal("BATCH-GOAL-CLEAR-REFUSED batch=9 reason=checks-tampered"), clearRefusal("结清失败: 别的错")],
    [{ reason: "checks-failed", repairable: true }, { reason: "adr-missing+diary-missing", repairable: true },
      { reason: "worktree-unknown", repairable: false }, { reason: "uncommitted+obligation-unknown", repairable: false },
      { reason: "checks-tampered", repairable: false }, null]);
  t("花费:首次拉起整笔记;续接按会话累计读数的差额记;读数不增反降 ⇒ 整笔记",
    [launchCost(0.05, null), round4(launchCost(0.0136, 0.0118)), launchCost(0.02, 0.05), launchCost(0.05, 0.05)], [0.05, 0.0018, 0.02, 0]);
  t("裁决:Markdown 强调符夹在号、冒号、裁决之间照认,理由里的强调符剥掉",
    parseVerdicts("- **条件1**:达成 ✅\n- 条件 2: **不适用**:`本仓没有日记`\n**条件3:达成**", 3),
    { verdicts: [{ n: 1, verdict: "达成" }, { n: 2, verdict: "不适用", why: "本仓没有日记" }, { n: 3, verdict: "达成" }], problems: [] });
  t("工作树:已跟踪改动 / 未跟踪新文件各自认;.claude/ 下的不算;改名取新路径",
    porcelainIssues(" M a.txt\n?? new.txt\n?? .claude/.batch-goal.json\n?? .claude/.obligations/state.json\n?? .claude/worktrees/batch-9/x\nR  old.txt -> moved.txt\n!! ignored.txt\n"), { tracked: ["a.txt", "moved.txt"], untracked: ["new.txt"] });
  t("工作树:.claude/ 下的版本化内容照算(新 agent 定义忘了 git add、设置文件改了没提交、整个目录只报一行)",
    porcelainIssues("?? .claude/agents/_x.md\n M .claude/settings.json\n?? .claude/\n?? .claude/commands/y.md\n"), { tracked: [".claude/settings.json"], untracked: [".claude/agents/_x.md", ".claude/", ".claude/commands/y.md"] });
  t("工作树:干净 ⇒ 两项都空", porcelainIssues(""), { tracked: [], untracked: [] });
  t("外审结论:只认最后一个非空行", ["可以用,不用再审", "要改的有三条\n\n有会翻转的,要改\n", "判不了", "", "要改?不用再审?"].map((b) => reviewVerdict(b).v), ["pass", "fail", "unknown", "unknown", "unknown"]);
  t("外审结论:占位行 ⇒ unknown", reviewVerdict("(codex-run 作业 abc 运行中,结果未产出——占位)\n").v, "unknown");
  t("仓名:ssh / https / 本地路径 / 尾斜杠", ["git@example.com:o/app-private.git", "https://example.com/o/r", "E:/x/priv-remote.git", "/repo/a.git/", ""].map(repoNameOf), ["app-private", "r", "priv-remote", "a", null]);
  t("外审作业:同 slug 只留最新", latestPerSlug([{ id: "a", slug: "s", startedAt: "2026-01-01T00:00:01Z" }, { id: "b", slug: "s", startedAt: "2026-01-01T00:00:02Z" }, { id: "c", slug: "u", startedAt: "2026-01-01T00:00:00Z" }]).map((j) => j.id), ["c", "b"]);
  const pe = (a) => { try { return parseCli(a).mode; } catch (e) { return `throw:${/--check/.test(e.message) ? "check" : e.message.slice(0, 20)}`; } };
  t("命令行:没有 --cond / --check 不再在这里拒(先过分流);--route 只收三个词;--route-reason 单给 ⇒ 抛;--triage-model 照收",
    [pe(["--batch", "x", "--instruction", "做", "--cond", "甲"]), pe(["--batch", "x", "--instruction", "做"]), pe(["--batch", "x", "--instruction", "做", "--route", "fast"]),
      pe(["--batch", "x", "--instruction", "做", "--route-reason", "规则误判"]), parseCli(["--batch", "x", "--instruction", "做", "--route", "direct", "--route-reason", "小", "--triage-model", "haiku"]).route].map((x) => (String(x).startsWith("throw") ? "throw" : x)),
    ["run", "run", "throw", "throw", "direct"]);
  { // 分流的纯部分:decideTriage(换掉问模型的那一步)与 routeDecision
    const P = (extra) => parseCli(["--batch", "x", "--instruction", extra.ins ?? "给 README 加一行", ...(extra.args || [])]);
    let asked = 0;
    const ask = async () => { asked++; return { route: "direct", reason: "小", source: "model", ruleHits: [], model: "haiku", costUsd: 0.001, ms: 1 }; };
    const noConf = { planPatterns: [], model: null, directCheck: null };
    const v1 = await decideTriage(P({ args: ["--route", "criteria", "--route-reason", "规则误判了"], ins: "部署到服务器" }), noConf, { askTriage: ask });
    const v2 = await decideTriage(P({ args: ["--cond", "甲", "--check", "true"], ins: "部署到服务器" }), noConf, { askTriage: ask });
    const v3 = await decideTriage(P({ args: ["--cond", "甲", "--check", "true"] }), noConf, { askTriage: ask });
    t("分流:--route 给了 ⇒ caller、照它、不筛规则不调模型;带 --cond ⇒ 只过规则(命中 plan / 没命中 criteria caller),不调模型",
      [v1.route, v1.source, v1.reason, v2.route, v2.source, v3.route, v3.source, asked], ["criteria", "caller", "规则误判了", "plan", "rule", "criteria", "caller", 0]);
    const v4 = await decideTriage(P({}), { ...noConf, model: "sonnet" }, { askTriage: async (a) => { asked++; return { route: "direct", reason: a.model, source: "model" }; } });
    const v5 = await decideTriage(P({ args: ["--triage-model", "opus"] }), { ...noConf, model: "sonnet" }, { askTriage: async (a) => ({ route: "direct", reason: a.model, source: "model" }) });
    t("分流:没 --cond 没 --route ⇒ 问模型;模型名 --triage-model > 配置 > haiku", [asked, v4.reason, v5.reason], [1, "sonnet", "opus"]);
    const V = (route, source = "model") => ({ route, reason: "理由甲", source });
    const d1 = routeDecision(P({}), V("plan"), noConf);
    t("出路:plan ⇒ triage-plan,写明理由与 --route criteria --route-reason 的出路", [d1.refuse?.code, /理由甲/.test(d1.refuse?.why), /--route criteria --route-reason/.test(d1.refuse?.why), /完整计划/.test(d1.refuse?.why)], ["triage-plan", true, true, true]);
    const d2 = routeDecision(P({}), V("criteria"), noConf), d2b = routeDecision(P({ args: ["--cond", "甲"] }), V("criteria", "caller"), noConf);
    t("出路:criteria 缺 --cond / 缺 --check ⇒ triage-need-criteria,写明带 --route criteria 重发", [d2.refuse?.code, /--route criteria 重发/.test(d2.refuse?.why), d2b.refuse?.code, /缺 --check/.test(d2b.refuse?.why)], ["triage-need-criteria", true, "triage-need-criteria", true]);
    const d3 = routeDecision(P({}), V("direct"), noConf);
    t("出路:direct 没 --check 也没 directCheck ⇒ triage-no-default-check,两条出路都写", [d3.refuse?.code, /--check/.test(d3.refuse?.why), /directCheck/.test(d3.refuse?.why)], ["triage-no-default-check", true, true]);
    const d4 = routeDecision(P({}), V("direct"), { ...noConf, directCheck: { cmd: "test -f a", expectRe: "^" } });
    const d5 = routeDecision(P({ args: ["--cond", "甲"] }), V("direct", "caller"), { ...noConf, directCheck: { cmd: "true" } });
    const d6 = routeDecision(P({ args: ["--cond", "甲", "--check", "test -f b"] }), V("direct", "caller"), { ...noConf, directCheck: { cmd: "true" } });
    t("出路:direct 没 --cond ⇒ 条件「照这句话做完:<原话>」+ directCheck;有 --cond 没 --check ⇒ 挂 directCheck;两样都给 ⇒ 照调用方的",
      [d4.conds, d4.checks, d5.conds, d5.checks.map((c) => c.cmd), d6.checks.map((c) => c.cmd)],
      [["照这句话做完:给 README 加一行"], [{ i: 0, cmd: "test -f a", expectRe: "^" }], ["甲"], ["true"], ["test -f b"]]);
    t("出路:criteria 有条件有检查 ⇒ 照发", routeDecision(P({ args: ["--cond", "甲", "--check", "true"] }), V("criteria", "caller"), noConf).conds, ["甲"]); }
  t("命令行:缺省值 / 透传", (() => { const p = parseCli(["--batch", "x", "--instruction", "做", "--cond", "甲", "--check", "true", "--expect-re", "^ok"]); return [p.maxTurns, p.maxBudgetUsd, p.capUsd, p.deadlineMin, p.judgeModel, p.model, p.arm]; })(),
    [80, 8, 20, 90, "opus", undefined, ["--cond", "甲", "--check", "true", "--expect-re", "^ok"]]);
  { const base = ["--batch", "x", "--instruction", "做", "--cond", "甲", "--check", "true"];
    const sel = (extra) => { try { return parseCli([...base, ...extra]).sameErrorLimit; } catch { return "throw"; } };
    t("命令行:--same-error-limit 缺省 3;0 / 5 照收;负数、小数、非数、给两次 ⇒ 抛",
      [sel([]), sel(["--same-error-limit", "0"]), sel(["--same-error-limit", "5"]), sel(["--same-error-limit", "-1"]), sel(["--same-error-limit", "1.5"]), sel(["--same-error-limit", "x"]), sel(["--same-error-limit", "2", "--same-error-limit", "3"])],
      [3, 0, 5, "throw", "throw", "throw", "throw"]); }
  t("命令行:值以 -- 开头 / 未知旗标 / 坏批号 ⇒ 抛", [pe(["--batch", "--x"]), pe(["--batch", "x", "--bogus"]), pe(["--batch", "a b", "--instruction", "i", "--cond", "c", "--check", "true"])].map((x) => String(x).startsWith("throw")), [true, true, true]);
  { const C = { o: { batch: "x", instruction: "原话一字不差", conds: ["甲"], checks: [{ i: 0, cmd: "test -f a" }], finishLine: "到 a 为止" }, branch: "batch-run/x" };
    const p = execPrompt(C), r = repairPrompt(C, 2, [{ kind: "check", text: "没过" }]);
    t("提示词:执行提示含原话、条件与检查、终点线、约束与 batch-goal 绝对路径命令形", [p.includes("原话一字不差"), p.includes("条件1:甲"), p.includes("`test -f a`"), p.includes("到 a 为止"), p.includes("不跑 `batch-goal --arm` / `--clear` / `--force`"), p.includes(`"${BG_FWD}" --outcome`), p.includes("条件N:未达成:<理由>")], [true, true, true, true, true, true, true]);
    t("提示词:回修提示写明第几轮、列不过项、重申约束", [r.startsWith("回修第 2 轮,共 3 轮"), r.includes("没过"), r.includes("不推送、不合并、不切分支")], [true, true, true]); }

  // ── 端到端:临时 git 仓 + 真 batch-goal + 假 claude ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-run-st-"));
  try { await selfTestE2E(t, tmp); }
  catch (e) { fail++; console.log(`FAIL  端到端段异常:${e && e.stack}`); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 后台盲审进程可能还占着文件:临时目录清不掉不判 */ } }
  console.log(`用时 ${((Date.now() - T0) / 1000).toFixed(1)} 秒`);
  console.log(`batch-run 自测 ${pass}/${pass + fail}`);
  return fail ? 1 : 0;
}

async function selfTestE2E(t, tmp) {
  const J = path.join;
  const A = J(tmp, "repo");
  const fake = J(tmp, "fake-claude.mjs");
  const jobs = J(tmp, "jobs");
  fs.mkdirSync(A); fs.mkdirSync(J(tmp, "plans")); fs.mkdirSync(jobs);
  fs.writeFileSync(fake, FAKE_CLAUDE_SRC, "utf8");
  const LAUNCHER = "selftest-launcher-0306";
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CEILING_DIRECTORIES: tmp, CLAUDE_CODE_SESSION_ID: LAUNCHER, BATCH_RUN_CLAUDE_BIN: fake, BATCH_RUN_CODEX_JOB_ROOT: jobs, BATCH_RUN_POLL_MS: "100", BATCH_RUN_FAKE_MAIN: A };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const g = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", env, windowsHide: true, timeout: 30_000 }); return { status: r.status, out: String(r.stdout || "").trim(), err: String(r.stderr || "") }; };
  g(A, "init", "-q", "-b", "main");
  fs.writeFileSync(J(A, ".gitignore"), ".claude/\nclipboard/\n");
  fs.writeFileSync(J(A, "base.txt"), "base\n");
  g(A, "add", "-A"); g(A, "commit", "-q", "-m", "init");
  const RUN = J(A, ".claude", ".batch-run");
  const wtOf = (b) => J(A, ".claude", "worktrees", `batch-${b}`);
  const branchExists = (b) => g(A, "show-ref", "--verify", "--quiet", `refs/heads/batch-run/${b}`).status === 0;
  const runsCount = () => { try { return fs.readFileSync(J(RUN, "runs.jsonl"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  const okText = (n = 1) => Array.from({ length: n }, (_, i) => `条件${i + 1}:达成`).join("\n");
  const ok = (cost = 0.05, text = okText()) => ({ subtype: "success", is_error: false, text, cost });
  const W = (f, content) => ({ write: f, content });
  const CM = { commit: "work" };
  // 看守剧本:n 组「同一个 tool_use + 同样的报错 tool_result」(主会话线)
  const sameErr = (n, tag) => Array.from({ length: n }, (_, i) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_${tag}_${i}`, name: "Bash", input: { command: "false", timeout: 5000 } }] }, parent_tool_use_id: null },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_${tag}_${i}`, is_error: true, content: "Exit code 1" }] }, parent_tool_use_id: null },
  ]).flat();
  const run = (name, args, plan, { cwd = A, extraEnv = {} } = {}) => {
    const T1 = Date.now();
    const pf = J(tmp, "plans", `${name}.json`), calls = J(tmp, "plans", `${name}.calls.jsonl`);
    fs.writeFileSync(pf, JSON.stringify(plan || { steps: [] }));
    const r = spawnSync(process.execPath, ["--no-warnings", SELF, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000,
      env: { ...env, BATCH_RUN_FAKE_PLAN: pf, BATCH_RUN_FAKE_CALLS: calls, ...extraEnv } });
    const lines = String(r.stdout || "").trim().split(/\r?\n/);
    const lastLine = lines[lines.length - 1] || "";
    let res = null;
    try { res = lastLine.startsWith(RESULT_KEY) ? JSON.parse(lastLine.slice(RESULT_KEY.length)) : null; } catch { res = null; }
    let cs = [];
    try { cs = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { cs = []; }
    if (!res) console.log(`      (${name} 末行不是结果行;stderr 尾部:${tail(r.stderr, 800)})`);
    if (process.env.BATCH_RUN_SELFTEST_TIMING) console.log(`      (${name} ${Date.now() - T1} ms)`);
    return { code: r.status, res: res || {}, calls: cs, exec: cs.filter((c) => c.kind === "exec"), judge: cs.filter((c) => c.kind === "judge"), triage: cs.filter((c) => c.kind === "triage"), stderr: String(r.stderr || "") };
  };
  const argsFor = (b, extra = [], check = `test -f ${b}.txt`) => ["--batch", b, "--instruction", `自测指令 ${b}:照剧本做`, "--cond", `${b}.txt 在`, "--check", check, ...extra];
  const has = (arr, x) => arr.includes(x);
  const valAfter = (arr, f) => (arr.includes(f) ? arr[arr.indexOf(f) + 1] : null);

  // 清理前删运行时残留(没忽略 .claude/ 与盲审日志的仓):全是残留 ⇒ 删;混着别的未跟踪文件 ⇒ 一个都不删
  { const B = J(tmp, "bare-repo");
    fs.mkdirSync(B); g(B, "init", "-q", "-b", "main");
    fs.writeFileSync(J(B, "base.txt"), "base\n"); g(B, "add", "-A"); g(B, "commit", "-q", "-m", "init");
    const left = [J(B, ".claude", ".batch-goal.json"), J(B, ".claude", ".batch-goal.jsonl"), J(B, "clipboard", "codex", "fp-audit-last.log")];
    const seed = () => { for (const f of left) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x\n"); } };
    seed(); dropRuntimeLeftovers({ wt: B });
    const gone = left.map((f) => fs.existsSync(f));
    const agent = J(B, ".claude", "agents", "_x.md");
    seed(); fs.mkdirSync(path.dirname(agent), { recursive: true }); fs.writeFileSync(agent, "忘了 git add 的交付物\n"); dropRuntimeLeftovers({ wt: B });
    const kept = [...left, agent].map((f) => fs.existsSync(f));
    fs.rmSync(agent); fs.writeFileSync(J(B, "base.txt"), "改过\n"); dropRuntimeLeftovers({ wt: B });
    const keptDirty = left.map((f) => fs.existsSync(f));
    t("清理:工作树里只剩运行时残留 ⇒ 删掉;混着 .claude/ 下的版本化新文件或已跟踪改动 ⇒ 一个都不删", [gone, kept, keptDirty], [[false, false, false], [true, true, true, true], [true, true, true]]);
  }
  // 外审作业台账:半截 / 坏件。开批之后动过的 ⇒ 判不了(不当成「没发起过外审」);开批之前就没再动过的 ⇒ 跳过
  { const JR = J(tmp, "jobs-broken");
    fs.mkdirSync(JR);
    const f = J(JR, "jhalf.json");
    fs.writeFileSync(f, "");
    const fresh = await readJobs(JR, Date.now() - 60_000, A);
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(f, old, old);
    const stale = await readJobs(JR, Date.now() - 60_000, A);
    t("外审台账:0 字节的台账件,开批后动过 ⇒ 报判不了;开批前的旧坏件 ⇒ 跳过", [/读不出/.test(fresh.error || ""), stale.error ?? null, (stale.jobs || []).length], [true, null, 0]);
  }

  // ① 一次过 ⇒ 关账(同一次运行兼测 ⑨ 的前一半:--push 的远端不在私仓名单 ⇒ 不推,照常关账;
  //   也兼测 ⑬ 的后一半:--same-error-limit 0 时,和 ⑬ 同一段「连着 3 次同样的错」不被看守停下)
  { const before = runsCount();
    const bare = J(tmp, "pub-remote.git");
    g(tmp, "init", "-q", "--bare", bare); g(A, "remote", "add", "pubr", bare);
    const r = run("t1", argsFor("t1", ["--push", "pubr", "--same-error-limit", "0"]), { steps: [{ actions: [W("t1.txt"), CM], stream: sameErr(3, "t1"), result: ok() }] });
    const a = r.exec[0]?.argv || [];
    t("① 一次过 ⇒ 关账:退出 0、closed、拉起 1 次、验收 1 次、末行可解析", [r.code, r.res.status, r.res.rounds, r.res.acceptRounds, typeof r.res.sessionId], [0, "closed", 1, 1, "string"]);
    let st0 = {}; try { st0 = JSON.parse(fs.readFileSync(J(RUN, "t1.json"), "utf8")); } catch { st0 = {}; }
    t("⑬ --same-error-limit 0 ⇒ 同一段连着 3 次的同样错误不被停(没有 watch-same-error、拉起记录的 watch 为 null)",
      [r.res.reasonCode !== "watch-same-error", st0.rounds?.[0]?.watch, st0.caps?.sameErrorLimit], [true, null, 0]);
    t("⑨ 远端不在私仓名单 ⇒ 不推、照常关账、结果里记「未推送」", [r.res.pushed, r.res.notes.some((n) => n.startsWith("未推送:远端不在私仓名单")), g(A, "ls-remote", "pubr", "refs/heads/main").out], [false, true, ""]);
    t("① 基分支快进了、工作树与分支已删", [fs.existsSync(J(A, "t1.txt")), g(A, "symbolic-ref", "--short", "HEAD").out, fs.existsSync(wtOf("t1")), branchExists("t1")], [true, "main", false, false]);
    let st = {}; try { st = JSON.parse(fs.readFileSync(J(RUN, "t1.json"), "utf8")); } catch { st = {}; }
    t("① 运行状态 closed、runs.jsonl 多一行、主尺一行", [st.status, runsCount() - before, /^主尺/.test(r.res.ruler || "")], ["closed", 1, true]);
    t("① 拉起命令形:-p stream-json --verbose auto 模式、轮数 / 花费上限、--session-id = 结果里的会话号;没有 --dangerously-skip-permissions",
      [has(a, "-p"), valAfter(a, "--output-format"), has(a, "--verbose"), valAfter(a, "--permission-mode"), valAfter(a, "--max-turns"), valAfter(a, "--max-budget-usd"), valAfter(a, "--session-id") === r.res.sessionId, has(a, "--dangerously-skip-permissions"), has(a, "--resume")],
      [true, "stream-json", true, "auto", "80", "8", true, false, false]);
    t("① 提示词走 stdin(含原话与 batch-goal 绝对路径);执行会话环境里的会话号 = 执行会话号", [r.exec[0]?.stdin.includes("自测指令 t1:照剧本做"), r.exec[0]?.stdin.includes(BG_FWD), r.exec[0]?.env.sid === r.res.sessionId], [true, true, true]);
    let mir = []; try { mir = fs.readFileSync(J(A, ".claude", ".batch-goal.worktrees.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.batch === "t1"); } catch { mir = []; }
    const arm = mir.find((o) => o.action === "arm");
    t("① 批在工作树里由执行会话武装(armedBy = 执行会话号;指令会话 = 发车方会话号),并有 clear 行", [arm?.armedBy === r.res.sessionId, arm?.instruction?.sid, arm?.caps?.usd, mir.some((o) => o.action === "clear")], [true, LAUNCHER, 20, true]); }

  // ② 首轮检查不过 ⇒ 回修一轮过(同一次运行兼测 ⑧ 的前一半:执行期间基分支前进、不冲突 ⇒ rebase 后关账)
  { const r = run("t2", argsFor("t2"), { steps: [{ actions: [W("other2.txt"), CM, { main: "main2.txt" }], result: ok() }, { actions: [W("t2.txt"), CM], result: ok() }] });
    const a1 = r.exec[0]?.argv || [], a2 = r.exec[1]?.argv || [];
    t("② 首轮检查不过 ⇒ 回修一轮过:退出 0、拉起 2 次、验收 2 次", [r.code, r.res.status, r.exec.length, r.res.acceptRounds], [0, "closed", 2, 2]);
    t("② 第二次拉起带 --resume <同一个会话号>、不带 --session-id;回修提示写明轮次并带检查命令", [valAfter(a2, "--resume") === valAfter(a1, "--session-id"), has(a2, "--session-id"), r.exec[1]?.stdin.startsWith("回修第 1 轮,共 3 轮"), r.exec[1]?.stdin.includes("test -f t2.txt")], [true, false, true, true]);
    t("⑧ 基分支前进、不冲突 ⇒ rebase 后关账(两边的提交都在基分支上,工作树已删)", [fs.existsSync(J(A, "t2.txt")), fs.existsSync(J(A, "main2.txt")), r.res.notes.some((n) => /rebase/.test(n)), fs.existsSync(wtOf("t2"))], [true, true, true, false]); }

  // ③ 三轮回修仍不过 ⇒ 停(方向复核读不出 ⇒ 继续)
  { const r = run("t3", argsFor("t3"), { steps: [0, 1, 2, 3].map(() => ({ actions: [], result: ok() })), judge: [{ result: { text: "看了一下,说不清" } }] });
    let st = {}; try { st = JSON.parse(fs.readFileSync(J(wtOf("t3"), ".claude", ".batch-goal.json"), "utf8")); } catch { st = {}; }
    const h = r.res.handoff ? (() => { try { return fs.readFileSync(r.res.handoff, "utf8"); } catch { return ""; } })() : "";
    t("③ 三轮回修仍不过 ⇒ 停:退出 10、恰好拉起 4 次、原因 repair-exhausted", [r.code, r.res.status, r.exec.length, r.res.reasonCode], [10, "stopped", 4, "repair-exhausted"]);
    t("③ 交接文件在且含「卡在哪」;工作树与分支都在;批仍未结清", [h.includes("卡在哪(发车脚本写)"), h.includes("claude --resume"), fs.existsSync(wtOf("t3")), branchExists("t3"), st.batch, st.cleared === true], [true, true, true, true, "t3", false]);
    const order = r.calls.map((c) => c.kind).join(",");
    t("⑦ 方向复核:第二次验收不过时拉一次(--agent _direction-judge --model opus,stdin 含原话);读不出 ⇒ 记一行、照常回修",
      [order, valAfter(r.judge[0]?.argv || [], "--agent"), valAfter(r.judge[0]?.argv || [], "--model"), r.judge[0]?.stdin.includes("自测指令 t3:照剧本做"), r.judge[0]?.env.sid, r.res.notes.some((n) => /方向复核判不了/.test(n))],
      ["exec,exec,judge,exec,exec", "_direction-judge", "opus", true, null, true]); }

  // ⑦ 方向复核判「该停」⇒ 停,交接含其全文
  { const r = run("t7", argsFor("t7"), { steps: [{ actions: [], result: ok() }, { actions: [], result: ok() }], judge: [{ result: { text: "两条发现不修也成立。\n标记-甲乙丙\n方向判定:该停" } }] });
    const h = (() => { try { return fs.readFileSync(r.res.handoff, "utf8"); } catch { return ""; } })();
    t("⑦ 方向复核判「该停」⇒ 停:退出 10、只拉起 2 次、交接含复核全文", [r.code, r.res.reasonCode, r.exec.length, h.includes("标记-甲乙丙"), h.includes("方向复核全文")], [10, "judge-stop", 2, true, true]); }

  // ④ 到上限 / 撞额度 / 没有 result ⇒ 各自停,不回修
  for (const [b, step, want] of [
    ["t4a", { result: { subtype: "error_max_turns", is_error: true, text: "", cost: 0.01 }, code: 1 }, "cap-turns"],
    ["t4b", { result: { subtype: "error_max_budget_usd", is_error: true, text: "", cost: 0.02 }, code: 1 }, "cap-budget"],
    ["t4c", { result: { subtype: "success", is_error: true, text: "Claude AI usage limit reached|1763800000", cost: 0 }, code: 1 }, "quota"],
    ["t4d", { result: null, code: 0 }, "unknown"],
  ]) {
    const r = run(b, argsFor(b), { steps: [step] });
    t(`④ ${want}:各自停(退出 10)、原因分得清、不回修(只拉起 1 次)、交接在`, [r.code, r.res.reasonCode, r.exec.length, !!r.res.handoff], [10, want, 1, true]);
  }

  // ⑤ 检查过了,但缺逐条裁决 / 有未提交改动 / 有未跟踪新文件 ⇒ 各自算不过并回修
  { const r = run("t5", argsFor("t5"), { steps: [
    { actions: [W("t5.txt"), CM, W("base.txt", "changed\n"), W("stray5.txt")], result: ok(0.05, "做完了") },
    { actions: [CM], result: ok() }] });
    const p = r.exec[1]?.stdin || "";
    t("⑤ 缺裁决 / 未提交 / 未跟踪 ⇒ 各算一项不过、回修一轮后关账", [r.code, r.res.status, r.exec.length], [0, "closed", 2]);
    t("⑤ 回修提示逐项列出:未提交(base.txt)、未跟踪(stray5.txt)、缺条件1的裁决", [/\(uncommitted\)[\s\S]*base\.txt/.test(p), /\(untracked\)[\s\S]*stray5\.txt/.test(p), /\(verdict\)\n缺条件1/.test(p)], [true, true, true]); }

  // ⑥ 累计花费到 --cap-usd ⇒ 不再拉起
  { const r = run("t6", argsFor("t6", ["--cap-usd", "1"]), { steps: [{ actions: [], result: ok(1.2) }, { actions: [W("t6.txt"), CM], result: ok() }] });
    t("⑥ 累计花费到整批上限 ⇒ 不再拉起:退出 10、cap-usd、只拉起 1 次、单次上限取 min(8, 1)", [r.code, r.res.reasonCode, r.exec.length, valAfter(r.exec[0]?.argv || [], "--max-budget-usd")], [10, "cap-usd", 1, "1"]); }

  // ⑧ 基分支前进且冲突 ⇒ 停,工作树不在 rebase 中途(不冲突的那一半并在 ② 里)
  { const r = run("t8b", argsFor("t8b"), { steps: [{ actions: [W("t8b.txt"), W("c8.txt", "A\n"), CM, { main: "c8.txt", content: "B\n" }], result: ok() }] });
    const s = g(wtOf("t8b"), "status");
    t("⑧ 基分支前进且冲突 ⇒ 停(rebase-conflict),工作树在、不处在 rebase 中途、基分支没动到批的提交", [r.code, r.res.reasonCode, fs.existsSync(wtOf("t8b")), /rebase/i.test(s.out), fs.existsSync(J(A, "t8b.txt"))], [10, "rebase-conflict", true, false, false]); }

  // ⑪ 外审作业(假台账):「要改」⇒ 不过并回修;改完重发「不用再审」⇒ 过;作业 failed ⇒ 停
  { const r = run("t11b", argsFor("t11b"), { steps: [
    { actions: [W("t11b.txt"), CM, { job: { slug: "rev", state: "done", body: "审完了\n有会翻转的,要改\n" } }], result: ok() },
    { actions: [{ job: { slug: "rev", state: "done", body: "可以用,不用再审\n" } }], result: ok() }] });
    t("⑪ 外审末行「要改」⇒ 不过并回修(提示里带结论行);重发后「不用再审」⇒ 过并关账", [r.code, r.res.status, r.exec.length, /\(codex\)[\s\S]*要改/.test(r.exec[1]?.stdin || "")], [0, "closed", 2, true]); }
  { const r = run("t11c", argsFor("t11c"), { steps: [{ actions: [W("t11c.txt"), CM, { job: { slug: "rev", state: "failed", error: "boom" } }], result: ok() }] });
    t("⑪ 外审作业 failed ⇒ 判不了、停(不猜成过)", [r.code, r.res.reasonCode, r.exec.length, fs.existsSync(J(A, "t11c.txt"))], [10, "accept-unknown", 1, false]); }

  // ④ 补:被截止时间杀掉 ⇒ 到上限(实杀子进程树)
  { const t0 = Date.now();
    const r = run("t12", argsFor("t12", ["--deadline-min", "0.04"]), { steps: [{ sleepMs: 30_000, result: ok() }] });
    t("④ 到整批截止时间 ⇒ 杀掉执行会话、停(cap-deadline)、不回修", [r.code, r.res.reasonCode, r.exec.length <= 1, Date.now() - t0 < 25_000], [10, "cap-deadline", true, true]); }

  // ⑬ 看守:执行会话吐出三组同一个 tool_use + 同样的报错后长睡 ⇒ 被看守杀掉、停(watch-same-error)、不回修
  { const t0 = Date.now();
    const r = run("t13", argsFor("t13"), { steps: [{ actions: [W("t13.txt"), CM], stream: sameErr(3, "t13"), sleepMs: 30_000, result: ok() }] });
    const ms = Date.now() - t0;
    const h = (() => { try { return fs.readFileSync(r.res.handoff, "utf8"); } catch { return ""; } })();
    let row = null; try { row = fs.readFileSync(J(RUN, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.batch === "t13").pop() || null; } catch { row = null; }
    let st = {}; try { st = JSON.parse(fs.readFileSync(J(RUN, "t13.json"), "utf8")); } catch { st = {}; }
    const log = (() => { try { return fs.readFileSync(J(RUN, "t13-r1.log"), "utf8"); } catch { return ""; } })();
    t("⑬ 看守命中 ⇒ 退出 10、watch-same-error、只拉起 1 次、没回修、没拉方向复核、远早于那段 30 秒长睡(是被杀的)",
      [r.code, r.res.reasonCode, r.exec.length, r.judge.length, ms < 20_000], [10, "watch-same-error", 1, 0, true]);
    t("⑬ 交接「卡在哪」写明工具名、连着 3 次、入参与错误;日志里有看守那一行",
      [h.includes("卡在哪(发车脚本写)"), /看守:第 1 次拉起里,同一个工具调用连着 3 次/.test(h), h.includes("工具:Bash"), h.includes("\"command\":\"false\""), h.includes("Exit code 1"), h.includes("线:主会话"), log.includes("# 看守:")],
      [true, true, true, true, true, true, true]);
    t("⑬ runs.jsonl 那一行与运行状态的拉起记录都带 watch(工具、次数、线);没有花费读数 ⇒ 记一行按 0 计",
      [row?.watch?.tool, row?.watch?.count, row?.watch?.lane, st.rounds?.[0]?.watch?.count, st.rounds?.[0]?.cls, r.res.notes.some((n) => /没有花费读数/.test(n))], ["Bash", 3, "main", 3, "stalled", true]); }

  // ⑭ 杀不掉(自测接缝:什么都不杀):看守命中后宽限一到就不再等,照样停下、写交接,并写明那个进程可能还在
  { const t0 = Date.now();
    //   那段长睡给到 20 秒、断言放到 15 秒:原先是 4 秒对 3.5 秒,量的是整次发车的墙钟(建工作树、开批就要两三秒),
    //   机器一忙就超(批 308 实撞:同机另有重活时这条红了,与被测逻辑无关)。假 claude 没人杀,会在自测结束后自己睡完退出。
    const r = run("t14", argsFor("t14"), { steps: [{ stream: sameErr(3, "t14"), sleepMs: 20_000, result: ok() }] }, { extraEnv: { BATCH_RUN_TEST_NO_KILL: "1", BATCH_RUN_KILL_GRACE_MS: "300" } });
    const ms = Date.now() - t0;
    const log = (() => { try { return fs.readFileSync(J(RUN, "t14-r1.log"), "utf8"); } catch { return ""; } })();
    t("⑭ 杀的动作没发出去、进程不退 ⇒ 宽限到了不再等:退出 10、watch-same-error、远早于那段 20 秒长睡、备注写明杀不掉、日志里有不再等那一行",
      [r.code, r.res.reasonCode, r.exec.length, ms < 15_000, r.res.notes.some((n) => /杀不掉或迟迟不退/.test(n)), /还没退:不再等它/.test(log), !!r.res.handoff],
      [10, "watch-same-error", 1, true, true, true, true]); }

  // ⑩ 发车前检查:没有 --check / 锁被活进程占着 / 在 linked worktree 里 ⇒ 退出 2,不留工作树
  { const r = run("t10a", ["--batch", "t10a", "--instruction", "x", "--cond", "甲"], null);
    t("⑩ 没有 --check ⇒ 退出 2、refused(triage-need-criteria,点名缺 --check)、没起 claude、没留工作树", [r.code, r.res.status, r.res.reasonCode, /缺 --check/.test(r.res.reason || ""), r.calls.length, fs.existsSync(wtOf("t10a"))], [2, "refused", "triage-need-criteria", true, 0, false]); }
  { fs.mkdirSync(RUN, { recursive: true });
    const lock = J(RUN, "zz-lock.json");
    fs.writeFileSync(lock, JSON.stringify({ batch: "zz-lock", status: "running", pid: process.pid }));
    const r = run("t10b", argsFor("t10b"), null);
    fs.rmSync(lock, { force: true });
    t("⑩ 锁被活进程占着 ⇒ 退出 2、没留工作树与分支、没写运行状态", [r.code, r.res.status, /还在跑/.test(r.res.reason || ""), fs.existsSync(wtOf("t10b")), branchExists("t10b"), fs.existsSync(J(RUN, "t10b.json"))], [2, "refused", true, false, false, false]); }
  { const r = run("t10c", argsFor("t10c"), null, { cwd: wtOf("t3") });
    t("⑩ 在 linked worktree 里发车 ⇒ 退出 2、没留工作树", [r.code, r.res.status, /linked worktree/.test(r.res.reason || ""), fs.existsSync(wtOf("t10c")), fs.existsSync(J(wtOf("t3"), ".claude", "worktrees"))], [2, "refused", true, false, false]); }

  // ⑮–㉑ 分流(批 309)
  const left = (b) => [fs.existsSync(wtOf(b)), branchExists(b), fs.existsSync(J(RUN, `${b}.json`))];
  const triRows = (b) => { try { return fs.readFileSync(J(RUN, "triage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.batch === b); } catch { return []; } };
  const lastRun = (b) => { try { return fs.readFileSync(J(RUN, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.batch === b).pop() || null; } catch { return null; } };
  const only = (b) => ["--batch", b, "--instruction", `自测指令 ${b}:给文档加一行`];
  { const r = run("t1x", argsFor("t1x"), { steps: [{ actions: [W("t1x.txt"), CM], result: ok() }] });
    t("⑮ 带 --cond 不带 --route、规则没命中 ⇒ 不调模型、criteria / caller、照常关账;判词进结果行、runs.jsonl、triage.jsonl",
      [r.code, r.triage.length, r.res.triage?.route, r.res.triage?.source, lastRun("t1x")?.triage?.route, triRows("t1x").map((x) => [x.route, x.source, x.via])],
      [0, 0, "criteria", "caller", "criteria", [["criteria", "caller", "batch-run"]]]); }
  { const r = run("t20", ["--batch", "t20", "--instruction", "自测:部署到服务器", "--cond", "甲", "--check", "true"], { triage: [{ reply: "direct\n不该被问到" }] });
    t("⑳ 带 --cond、规则命中 ⇒ 拒绝发车(triage-plan)、不调模型、什么都不留(只记一行判词),出路写在拒绝那段话里",
      [r.code, r.res.status, r.res.reasonCode, r.calls.length, left("t20"), /--route criteria --route-reason/.test(r.res.reason || ""), r.res.triage?.ruleHits, triRows("t20").length, lastRun("t20")],
      [2, "refused", "triage-plan", 0, [false, false, false], true, ["server", "deploy"], 1, null]); }
  { const r = run("t21", ["--batch", "t21", "--instruction", "自测:部署到服务器(其实只是本地文件)", "--route", "criteria", "--route-reason", "规则误判:只动本地", "--cond", "t21.txt 在", "--check", "test -f t21.txt"],
      { steps: [{ actions: [W("t21.txt"), CM], result: ok() }], triage: [{ reply: "plan\n不该被问到" }] });
    let st = {}; try { st = JSON.parse(fs.readFileSync(J(RUN, "t21.json"), "utf8")); } catch { st = {}; }
    t("㉑ --route criteria --route-reason ⇒ 不筛规则、不调模型、关账;判词 caller 带理由,进运行状态",
      [r.code, r.res.status, r.triage.length, r.res.triage?.source, r.res.triage?.reason, st.triage?.route], [0, "closed", 0, "caller", "规则误判:只动本地", "criteria"]); }
  { const r = run("t16", only("t16"), { triage: [{ reply: "plan\n要动线上" }] });
    t("⑯ 只有一句话、模型判 plan ⇒ 拒绝发车(triage-plan)、什么都不留、理由里带模型的话",
      [r.code, r.res.reasonCode, r.exec.length, r.triage.length, left("t16"), /要动线上/.test(r.res.reason || ""), r.res.triage?.source], [2, "triage-plan", 0, 1, [false, false, false], true, "model"]); }
  { const r = run("t17", only("t17"), { triage: [{ reply: "criteria\n要做取舍" }] });
    t("⑰ 只有一句话、模型判 criteria ⇒ 拒绝发车(triage-need-criteria),写明带 --route criteria 重发", [r.code, r.res.reasonCode, r.exec.length, left("t17"), /--route criteria 重发/.test(r.res.reason || "")], [2, "triage-need-criteria", 0, [false, false, false], true]); }
  { const r = run("t18", only("t18"), { triage: [{ reply: "嗯,看情况" }] });
    t("⑱ 模型乱答 ⇒ 兜底 criteria / fallback ⇒ 拒绝发车(triage-need-criteria)", [r.code, r.res.reasonCode, r.res.triage?.route, r.res.triage?.source], [2, "triage-need-criteria", "criteria", "fallback"]); }
  { const r = run("t19", only("t19"), { triage: [{ reply: "direct\n只加一行" }] });
    t("⑲ 模型判 direct、没 --check、没配 directCheck ⇒ 拒绝发车(triage-no-default-check)、两条出路都写、什么都不留",
      [r.code, r.res.reasonCode, r.exec.length, left("t19"), /--check/.test(r.res.reason || "") && /directCheck/.test(r.res.reason || "")], [2, "triage-no-default-check", 0, [false, false, false], true]); }
  { fs.writeFileSync(J(A, TRIAGE_CONFIG_FILE), JSON.stringify({ directCheck: "test -f t15.txt" }));
    const r = run("t15", only("t15"), { triage: [{ reply: "```\nDirect\n只加一行\n```", cost: 0.002 }], steps: [{ actions: [W("t15.txt"), CM], result: ok() }] });
    fs.rmSync(J(A, TRIAGE_CONFIG_FILE), { force: true });
    const ta = r.triage[0]?.argv || [];
    t("⑲ 只有一句话、模型判 direct、配了 directCheck ⇒ 条件「照这句话做完:<原话>」+ 缺省检查,跑到关账",
      [r.code, r.res.status, r.res.triage?.route, r.res.triage?.source, r.exec[0]?.stdin.includes("照这句话做完:自测指令 t15"), r.exec[0]?.stdin.includes("test -f t15.txt"), lastRun("t15")?.triage?.route],
      [0, "closed", "direct", "model", true, true, "direct"]);
    t("⑲ 分流那次调用:--model haiku、--max-turns 1、json、--tools 空串、工作目录不是仓;花费算进整批", [valAfter(ta, "--model"), valAfter(ta, "--max-turns"), valAfter(ta, "--output-format"), valAfter(ta, "--tools"), path.resolve(r.triage[0]?.cwd || A).startsWith(path.resolve(A)), r.res.costUsd >= 0.002], ["haiku", "1", "json", "", false, true]); }

  // ⑨ --push 远端在私仓名单(本地裸仓当远端)⇒ 推了且回读一致(不在名单的那一半并在 ① 里)
  { const bare = J(tmp, "priv-remote.git");
    g(tmp, "init", "-q", "--bare", bare); g(A, "remote", "add", "privr", bare);
    fs.writeFileSync(J(A, "gate-install.json"), JSON.stringify({ format: "gate-install/v1", privateRepos: ["priv-remote"] }));
    const r = run("t9b", argsFor("t9b", ["--push", "privr"]), { steps: [{ actions: [W("t9b.txt"), CM], result: ok() }] });
    const remote = (g(A, "ls-remote", "privr", "refs/heads/main").out.split(/\s+/)[0] || "");
    t("⑨ 远端在私仓名单 ⇒ 推了、回读等于本地基分支、关账", [r.code, r.res.status, r.res.pushed, remote === g(A, "rev-parse", "main").out && !!remote], [0, "closed", true, true]); }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────────────
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (IS_MAIN) {
  let o;
  try { o = parseCli(process.argv.slice(2)); }
  catch (e) {
    say(`拒绝发车:${e.message}`);
    const b = process.argv.indexOf("--batch");
    emitResult({ batch: b >= 0 ? process.argv[b + 1] ?? null : null, status: "refused", reasonCode: "usage", reason: e.message, stage: "preflight", rounds: 0, acceptRounds: 0, costUsd: 0, notes: [] });
    process.exit(2);
  }
  if (o.mode === "self-test") process.exit(await selfTest());
  if (o.mode === "status") process.exit(statusCmd(o.batch));
  process.exitCode = await runBatch(o);
}
