// write-state.mjs —— 「这一轮写没写」的**唯一一份结构化观测**(批 299 立,批 299b 按设计稿 clipboard/299b-design.md v2 + 5b 补丁重写)
//
// 三态(287 设计 2.5:看不清按写了算;本批改判法,见 299b-design 第 1 节与 5b):
//   · 识别到潜在写动作(state = "wrote"):本轮动作区间里有写类工具(Edit / Write / MultiEdit / NotebookEdit),
//     或某条 shell 命令里 write-effects 认出了写目标(重定向、cp / mv / sed -i …),或 git 改 HEAD / ref 的子命令
//     (commit / push / merge / checkout / switch / rebase / reset / cherry-pick / revert / am / pull / fetch / tag / branch / stash / update-ref)。
//     **只作回执的触发资格**:`false && echo x > f`、`git commit --help`、失败的 Write 调用等也会落到这里;
//     不用于断言写入成功、远端变化,也不用于统计实际写入率(5b 第 3 条)。
//   · 没写(none):本轮动作区间里**只有**只读工具(READONLY_TOOLS)或一个工具都没有,并且同时满足——
//     **没有**任何 Bash / PowerShell 执行(不论命令长什么样:命令形状证明不了没写,批 299 三轮每轮都有新漏判形);
//     **没有**不透明工具(Agent / Workflow / Skill / 任何 MCP / 不认识的工具);
//     区间内**没有**后台任务完成通知(task-notification、子代理回件,含 queue-operation 行;正文全文匹配):
//       上一轮启动、本轮完成的任务会在本轮写文件,而 Stop 时它已不在 background_tasks 里(5b 第 1 条);
//     区间内**没有**用户 `!` 执行的 shell(`<bash-input>` 行)与 IDE 编辑附件(edited_text_file 一类)(5c 第 5 条);
//     Stop 载荷**带** background_tasks 字段且是**空数组**(缺字段 / 非空 / 状态未知都不能证明没有在飞任务;5c 第 4 条);
//     区间**完整性有正证**:收集器显式给出 `complete: true`(5b 第 5 条、5c 第 2 条)。零工具轮也服从这几条(5b 第 6 条)。
//   · 看不清(unclear):其余一律。典型:执行过 shell 但没认出写动作。
//   **三态计数口径**(5c 第 7 条):写类工具与完成通知(或别的看不清来源)并存时记「识别到潜在写动作」——取最强的那个来源。
//
// **「没写」的范围**(5b 第 2 条、5c 第 6 条):只指「**业务写入**」没有通道被使用。业务写入 = 本仓里 git 跟踪的文件与
//   未被 .gitignore 忽略的未跟踪文件,加上配置的仓外目录。不在此范围:.gitignore 忽略面(含 clipboard/、clipboard/codex/ 回件——
//   脱离进程的 codex worker 只写那里)、WebFetch 落盘的二进制响应、钩子自身的遥测(本文件的 .write-state.jsonl 等)、
//   TodoWrite 的会话清单。它不是「文件系统没变化」;也不防蓄意伪造(ADR 0009)。
//
// **撤回的 287 要求**(5b 第 4 条,明写,不以「看不清」顶替):
//   逐轮的 HEAD 移动、工作树内容哈希、其他 worktree HEAD 的观测(287 设计 2.5、2.7「观测范围」)撤回——
//   开轮 / 收尾快照只能比端点(A→B→A 证明不了没写),且快照进程卡在操作系统同步读时钩子 31 秒退不掉(codex 299-review-r3),
//   快照代码已整体删除。287 2.7「找出实际变了的文件再跑 T / MF / J」挪到写入类批(T / MF / J / M),
//   在 `batch-goal --clear` 时用 `git diff 基点..HEAD` + `git status` 一次性定位,不逐轮做。
//
// **动作区间**(299b 第 3 节 + 5c 第 1 条;写入观测专用,不复用 gate-ctx 的补收):
//   起点 = 「上一次**放行**的 Stop 之后」与「最后一条用户亲口消息」两个边界里**更早**的那个(5c-②)。
//   只用前者:软续轮(Stop 带 additionalContext 放行后模型不等用户接着干)的前段被切掉;只用后者:中断 / API 错误 / 安全截停
//   结束的轮不触发 Stop、轮中排队插话、空闲时先 `!` 命令再发消息——这些动作落在亲口消息之前、上一次 Stop 之后,哪次 Stop 都看不到。
//   取较早者 ⇒ 任何还没被某次 Stop 看过的动作都进区间;代价是多收(多交回执),接受。
//   「亲口消息」是**正证**:只认 origin.kind === "human" 的 user 行(压缩摘要除外);没有 origin 的行(中断标记、老转录)一律不算,
//   不维护排除表。task-notification / 子代理回件开头的轮靠「完成通知 ⇒ 看不清」兜,不靠挪起点。
//   完整性(5c 第 2 条):整份转录只要有任何损坏行 / 半行 ⇒ 不完整(起点判别依赖的证据行可能正是坏的那一行);
//   没有一条带 type 的有效记录 ⇒ 不完整;找不到放行过的 Stop、又不能确认已读到会话开头 ⇒ 不完整。
//
// 记数口径(299b 第 4 节):收尾回执批接入前,用 .claude/.write-state.jsonl 统计 没写 / 识别到潜在写动作 / 看不清 三态比例;
//   本模块**不改任何规则的判决**:观测只由 hook-stop-closure 落账,规则不读它。
// CALIBRATED=false。

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeBash } from "./write-effects.mjs";
import { isBlockedStop, blockedStopIds } from "./gate-ctx.mjs";

export const STATES = Object.freeze({ wrote: "识别到潜在写动作", none: "没写", unclear: "看不清" });

/** 只读工具(调用本身不写业务面;WebFetch 落盘、TodoWrite 会话清单不在「没写」的范围内,见头注)。
 *  = hook-start-gate.mjs 的 READONLY_TOOLS **去掉 TaskOutput**(5c 第 3 条:TaskOutput 在等上一轮的后台任务,任务可能本轮写)。
 *  自测比对源码:两表之差恰为 {TaskOutput},漂了即红。Skill 不在表里(有的 skill 在子代理里跑)。 */
export const READONLY_TOOLS = Object.freeze(new Set([
  "Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "ToolSearch",
  "TodoWrite", "ListAgents", "AskUserQuestion",
]));
/** 与 hook-start-gate 只读表的**有意差异**(自测钉住)。 */
export const READONLY_DIFF_FROM_START_GATE = Object.freeze(["TaskOutput"]);
const WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
/** git 改 HEAD 或 ref 的子命令(正证「识别到潜在写动作」;不证成功)。 */
const GIT_REF_SUBS = new Set(["commit", "push", "merge", "checkout", "switch", "rebase", "reset", "cherry-pick", "revert", "am", "pull", "fetch",
  "tag", "branch", "stash", "update-ref"]);

/** 一条 Bash 命令:只找「潜在写动作」的正证;找不到 ⇒ 看不清(**永不判没写**)。 */
export function shellEvidence(cmd, opts = {}) {
  const s = String(cmd ?? "");
  let r = null;
  try { r = analyzeBash(s, { root: opts.root }); } catch { r = null; }
  const targets = [];
  if (r && r.ok) {
    for (const e of r.effects || []) targets.push(e.known ? e.path : (e.pattern || e.suffix || e.expr || "?"));
    for (const g of r.gitCalls || []) if (g && GIT_REF_SUBS.has(String(g.sub))) targets.push(`git ${g.sub}`);
  }
  return targets.length
    ? { state: "wrote", targets: [...new Set(targets)].slice(0, 20), why: "shell 里识别到潜在写动作" }
    : { state: "unclear", targets: [], why: r && r.ok ? "执行过 shell,没认出写动作(命令形状证明不了没写)" : "执行过 shell,解析不了" };
}

const bodyOf = (name, input) => {
  if (!input || typeof input !== "object") return "";
  if (name === "MultiEdit" && Array.isArray(input.edits)) return input.edits.map((x) => String(x?.new_string ?? "")).join("\n");
  return String(input.new_string ?? input.content ?? input.new_source ?? "");
};

/** 一个动作:{ tool, id, state, targets, truncated, why, body? } */
export function classifyAction(a, opts = {}) {
  const name = String(a?.name || "");
  const input = a?.input || {};
  const base = { tool: name, id: typeof a?.id === "string" ? a.id : null };
  if (WRITE_TOOLS.test(name)) {
    const p = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
    return { ...base, state: "wrote", targets: [p ? p.replace(/\\/g, "/") : "?"], truncated: false, why: `${name} 工具`, body: bodyOf(name, input).slice(0, 2000) };
  }
  if (name === "Bash") return { ...base, ...shellEvidence(input.command, opts), truncated: String(input.command ?? "").length > 8000 };
  if (name === "PowerShell") return { ...base, state: "unclear", targets: [], truncated: String(input.command ?? "").length > 8000, why: "执行过 PowerShell(本仓不解析其载荷)" };
  if (READONLY_TOOLS.has(name)) return { ...base, state: "none", targets: [], truncated: false, why: "只读工具" };
  if (/^(?:Agent|Task|Workflow)$/.test(name)) return { ...base, state: "unclear", targets: [], truncated: false, why: "子代理 / 工作流,写能力不明" };
  return { ...base, state: "unclear", targets: [], truncated: false, why: `${name || "(无名)"} 不在只读工具表(不透明工具)` };
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => String(b.text || "")).join("") : "");
const NOTICE_RE = /<task-notification>|<agent-message\b/;
/** 一条条目是不是「后台任务完成通知」(上一轮启动、本轮完成的任务可能在本轮写过文件)。
 *  认的形:user 行 / 排队消息附件 origin.kind=task-notification;正文含 `<task-notification>` 或子代理回件 `<agent-message`(**全文**匹配,
 *  5c 第 3 条);queue-operation 行(enqueue / remove)的 content 带上述标签;task_status 附件的状态不是 running / pending。 */
export function isTaskNotice(e) {
  if (!e || typeof e !== "object") return false;
  if (e.type === "user") {
    if (e.origin?.kind === "task-notification") return true;
    return NOTICE_RE.test(textOf(e.message?.content));
  }
  if (e.type === "attachment" && e.attachment?.type === "queued_command") {
    if (e.attachment.origin?.kind === "task-notification") return true;
    return NOTICE_RE.test(textOf(e.attachment.prompt));
  }
  if (e.type === "queue-operation") return NOTICE_RE.test(textOf(e.content));
  if (e.type === "attachment" && e.attachment?.type === "task_status") return !/^(?:running|pending)$/i.test(String(e.attachment.status || ""));
  return false;
}
/** 用户在会话里绕过模型直接动了文件的痕迹(5c 第 5 条):`!` 执行的 shell(`<bash-input>` 行)、IDE 编辑附件(edited_text_file 一类)。 */
export function isUserSideWrite(e) {
  if (!e || typeof e !== "object") return false;
  if (e.type === "user") return /<bash-input>/.test(textOf(e.message?.content));
  if (e.type === "attachment") return /^edited_(?:text_)?file$|^edited_/.test(String(e.attachment?.type || ""));
  return false;
}
/** 「用户亲口消息」**正证**(5c-② 修订):只认 `origin.kind === "human"` 的 user 行(压缩摘要除外——它带 human origin,却是模型转述)。
 *  不再维护「哪些不算亲口」的排除表:`[Request interrupted by user]` 一类没有 origin 的行、无 origin 的老转录行一律不算;
 *  带 human origin 的斜杠命令(`/xros:…`)、`!` 命令行都算(它们是用户亲手发起的)。 */
export function isHumanOpen(e) {
  return e?.type === "user" && e.origin?.kind === "human" && e.isCompactSummary !== true;
}
/** 上一次**放行**的 Stop 汇总行的下标(被拦的不算);没有 ⇒ -1。 */
function lastReleasedStop(entries) {
  const ids = blockedStopIds(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "system" && e.hookCount !== undefined && !isBlockedStop(entries, i, ids)) return i;
  }
  return -1;
}

/**
 * 写入观测专用的**动作区间收集器**(5b 第 5 条、5c、5c-②)。
 * @param entries 本会话转录的条目(按顺序)
 * @param opts.fromStart  true = entries 是从转录**第一行**读起的(hook 的 readTranscript 读全文件);没给 / false ⇒ 不能确认读到了会话开头
 * @param opts.badAt      读转录时损坏行 / 半行在 entries 里的位置;没给 ⇒ 当作不知道有没有坏行 ⇒ 不完整;**有任何一个** ⇒ 不完整(5c 第 2 条)
 * @returns { complete, why, start, actions:[{name, input, id}], notices, userWrites }
 *   complete 只在显式确认时为 true。区间起点 = 下面两个边界里**更早**的那个(5c-②):
 *     ① 上一次**放行**的 Stop 之后(没有放行过的 Stop 且确认读到了会话开头 ⇒ 0;两样都没有 ⇒ 不完整);
 *     ② 最后一条用户亲口消息(没有 ⇒ 只用①)。
 *   取较早者 ⇒ 任何还没被某次放行的 Stop 看过的动作都进区间(中断 / API 错误 / 安全截停结束的轮不触发 Stop;
 *   轮中排队插话的 human 行;空闲时先 `!` 命令再发消息),同时软续轮(放行后不等用户接着干)的前段也在。代价是多收,接受。
 */
export function collectInterval(entries, opts = {}) {
  const out = { complete: false, why: "", start: -1, actions: [], notices: 0, userWrites: 0 };
  if (!Array.isArray(entries)) { out.why = "没有转录条目"; return out; }
  const rs = lastReleasedStop(entries);
  const stopB = rs >= 0 ? rs + 1 : (opts.fromStart === true ? 0 : -1);
  let humanB = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (isHumanOpen(entries[i])) { humanB = i; break; }
  const start = stopB < 0 ? -1 : (humanB >= 0 ? Math.min(stopB, humanB) : stopB);
  if (start >= 0) {
    out.start = start;
    for (let i = start; i < entries.length; i++) {
      const e = entries[i];
      if (isTaskNotice(e)) out.notices++;
      if (isUserSideWrite(e)) out.userWrites++;
      if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) if (b?.type === "tool_use") out.actions.push({ name: String(b.name || ""), input: b.input || {}, id: typeof b.id === "string" ? b.id : null });
      }
    }
  }
  // 有效记录 = 至少一条带字符串 type 的对象(5c-② 第 3 条:[null]、[{}] 不算)
  if (!entries.some((e) => e && typeof e === "object" && typeof e.type === "string")) { out.why = "转录没有任何有效记录"; return out; }
  if (!Array.isArray(opts.badAt)) { out.why = "不知道转录有没有损坏行"; return out; }
  if (opts.badAt.length > 0) { out.why = `转录有 ${opts.badAt.length} 处损坏行 / 半行(起点判别的证据可能就在其中)`; return out; }
  if (start < 0) { out.why = "找不到上一次放行的 Stop,又不能确认读到了会话开头"; return out; }
  out.complete = true;
  out.why = start === humanB ? "起点是最后一条用户亲口消息(早于上一次放行的 Stop 之后)" : rs >= 0 ? "起点是上一次放行的 Stop 之后" : "读到了转录第一行,此前没有放行过的 Stop";
  return out;
}

/**
 * 主入口。interval = collectInterval 的产物(没给 / complete 不是 true ⇒ 看不清)。
 * opts: root(相对化写目标)、bgTasks(Stop 载荷的 background_tasks **原样**:缺字段 / 不是数组 / 非空 ⇒ 看不清,5c 第 4 条)。
 * 返回(唯一一份结构化观测):{ v, state, label, asWrote, truncated, targets:[{path, tool}], sources:[…], facts:{…}, reasons:[…] }
 */
export function observeWrites(interval, opts = {}) {
  const sources = [];
  const iv = interval && typeof interval === "object" ? interval : null;
  for (const a of iv && Array.isArray(iv.actions) ? iv.actions : []) sources.push(classifyAction(a, opts));
  const facts = { complete: !!(iv && iv.complete === true), start: iv ? iv.start : null, notices: iv ? iv.notices || 0 : 0 };
  if (!iv || iv.complete !== true) sources.push({ tool: "(区间)", id: null, state: "unclear", targets: [], truncated: true, why: "动作区间完整性没有正证" + (iv && iv.why ? `:${iv.why}` : "") });
  if (iv && iv.notices > 0) sources.push({ tool: "(后台任务)", id: null, state: "unclear", targets: [], truncated: false, why: `区间内有 ${iv.notices} 条后台任务完成通知(上一轮启动的任务可能在本轮写过)` });
  if (iv && iv.userWrites > 0) sources.push({ tool: "(用户侧)", id: null, state: "unclear", targets: [], truncated: false, why: `区间内有 ${iv.userWrites} 处用户 ! shell / IDE 编辑` });
  // 后台任务(5c 第 4 条):官方说明里数组的每一项就是一个在飞任务——缺字段证明不了为空,非空(不论 status 认不认得)证明不了已结束
  if (!Array.isArray(opts.bgTasks)) sources.push({ tool: "(后台任务)", id: null, state: "unclear", targets: [], truncated: false, why: opts.bgTasks === undefined ? "Stop 载荷缺 background_tasks 字段" : "Stop 载荷的 background_tasks 不是数组" });
  else if (opts.bgTasks.length > 0) sources.push({ tool: "(后台任务)", id: null, state: "unclear", targets: [], truncated: false, why: `Stop 时 background_tasks 有 ${opts.bgTasks.length} 项` });
  facts.bgTasks = Array.isArray(opts.bgTasks) ? opts.bgTasks.length : null;
  const state = sources.some((s) => s.state === "wrote") ? "wrote" : sources.some((s) => s.state === "unclear") ? "unclear" : "none";
  const r = opts.root ? String(opts.root).replace(/\\/g, "/").replace(/\/+$/, "") : null;
  const rel = (p) => { const s = String(p).replace(/\\/g, "/"); return r && s.toLowerCase().startsWith(r.toLowerCase() + "/") ? s.slice(r.length + 1) : s; };
  const targets = [];
  for (const s of sources) if (s.state === "wrote") for (const t of s.targets || []) targets.push({ path: rel(t), tool: s.tool });
  return {
    v: 2, state, label: STATES[state], asWrote: state !== "none",
    truncated: sources.some((s) => s.truncated),
    targets: targets.slice(0, 50), sources, facts,
    reasons: sources.filter((s) => s.state !== "none").map((s) => `${s.tool}:${s.why}`).slice(0, 20),
  };
}

/** 落账用的瘦身形:不带写入正文、截短原因。 */
export function ledgerRow(obs, extra = {}) {
  return {
    ts: new Date().toISOString(), ...extra,
    state: obs.state, truncated: obs.truncated, complete: obs.facts.complete, notices: obs.facts.notices,
    targets: obs.targets.slice(0, 20).map((t) => t.path),
    n: obs.sources.length,
    tools: [...new Set(obs.sources.map((s) => s.tool))].slice(0, 12),
    reasons: obs.reasons.slice(0, 8).map((x) => String(x).slice(0, 160)),
  };
}

// ── 自测(299b-design 第 6 节验收 + 批 299 r1–r3 与设计复核 r1/r2 报过的全部反例)───────────────
export function selfTest({ quiet = false } = {}) {
  const t = [];
  const chk = (name, got, want) => t.push([JSON.stringify(got) === JSON.stringify(want) ? "PASS" : "FAIL", name, JSON.stringify(got)]);
  let n = 0;
  const use = (name, input) => ({ type: "tool_use", id: `toolu_ws${++n}`, name, input });
  const A = (...blocks) => ({ type: "assistant", message: { content: blocks } });
  const H = (s = "做") => ({ type: "user", origin: { kind: "human" }, message: { content: s } });
  const passedStop = (id) => ({ type: "system", hookCount: 1, toolUseID: id });
  const blockedStop = (id) => [{ type: "system", hookCount: 1, toolUseID: id }, { type: "attachment", attachment: { type: "hook_blocking_error", toolUseID: id } }];
  const fb = { type: "user", message: { content: "Stop hook feedback:\n拦了" } };
  // 标准包:上一轮(只读)放行后开新轮;badAt=[] 表示读转录时没有坏行;bgTasks=[] 表示 Stop 载荷带了空的 background_tasks
  const PRIOR_W = [H("旧"), A(use("Write", { file_path: "old.md", content: "x" })), passedStop("s0")];
  const run = (turn, { prior = [H("旧"), A(use("Read", { file_path: "o.md" })), passedStop("s0")], badAt = [], fromStart = true, bgTasks = [] } = {}) =>
    observeWrites(collectInterval([...prior, ...turn], { badAt, fromStart }), { bgTasks });
  const st = (turn, o) => run(turn, o).state;
  const bash = (cmd) => [H(), A(use("Bash", { command: cmd }))];

  // ── 第 6 节验收 ──
  chk("纯 Read 轮 ⇒ 没写", st([H(), A(use("Read", { file_path: "a.md" }), use("Grep", { pattern: "x" }))]), "none");
  chk("零工具轮 ⇒ 没写", st([H(), A({ type: "text", text: "只是说话" })]), "none");
  chk("Bash ls ⇒ 看不清", st(bash("ls")), "unclear");
  chk("Bash git status ⇒ 看不清", st(bash("git status")), "unclear");
  chk("echo x > f ⇒ 识别到潜在写动作", st(bash("echo x > f")), "wrote");
  chk("git commit ⇒ 识别到潜在写动作", st(bash("git commit -m x")), "wrote");
  chk("Agent ⇒ 看不清", st([H(), A(use("Agent", { prompt: "x", subagent_type: "Explore" }))]), "unclear");
  chk("MCP ⇒ 看不清", st([H(), A(use("mcp__x__read", {}))]), "unclear");
  chk("前段不完整(找不到起点、不能确认读到开头)⇒ 看不清", st([A(use("Read", { file_path: "a" }))], { prior: [], fromStart: false }), "unclear");
  chk("在飞后台任务 ⇒ 看不清", st([H(), A(use("Read", { file_path: "a" }))], { bgTasks: [{ id: "b1", status: "running" }] }), "unclear");
  chk("上一轮已放行的 Write 不计入本轮(本轮有新的亲口消息);本轮只 Read ⇒ 没写", st([H(), A(use("Read", { file_path: "a" }))], { prior: PRIOR_W }), "none");
  // 5b 第 1 条(优先于第 6 节原写法):task-notification 开头的轮,即便只 Read ⇒ 看不清
  chk("task-notification 轮只 Read ⇒ 看不清(5b ①:上轮启动的任务可能本轮写过)",
    st([{ type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>done</task-notification>" } }, A(use("Read", { file_path: "a" }))]), "unclear");
  chk("origin=task-notification、正文不带标签 ⇒ 仍认作完成通知", st([{ type: "user", origin: { kind: "task-notification" }, message: { content: "后台任务完成" } }]), "unclear");
  chk("排队附件 origin=task-notification、正文不带标签 ⇒ 仍认作完成通知", st([H(), { type: "attachment", attachment: { type: "queued_command", origin: { kind: "task-notification" }, prompt: "完成了" } }]), "unclear");
  chk("排队的 task-notification 附件 ⇒ 看不清", st([H(), { type: "attachment", attachment: { type: "queued_command", origin: { kind: "task-notification" }, prompt: "<task-notification>x</task-notification>" } }, A(use("Read", { file_path: "a" }))]), "unclear");
  chk("子代理回件(agent-message)⇒ 看不清", st([H(), { type: "attachment", attachment: { type: "queued_command", origin: { kind: "peer" }, prompt: "<agent-message from=\"a1\">报告</agent-message>" } }]), "unclear");
  chk("task_status 已完成 ⇒ 看不清", st([H(), { type: "attachment", attachment: { type: "task_status", status: "completed" } }]), "unclear");
  chk("task_status 仍在跑 ⇒ 不算完成通知", st([H(), { type: "attachment", attachment: { type: "task_status", status: "running" } }]), "none");
  chk("老转录(无 origin)正文开头 <task-notification> ⇒ 看不清", st([{ type: "user", message: { content: "<task-notification>x</task-notification>" } }]), "unclear");
  chk("5c ④:background_tasks 非空、status 写着已完成也 ⇒ 看不清(数组每项都是在飞任务)", st([H(), A(use("Read", { file_path: "a" }))], { bgTasks: [{ id: "b1", status: "completed" }] }), "unclear");
  chk("5c ④:Stop 载荷缺 background_tasks 字段 ⇒ 看不清", observeWrites(collectInterval([H(), A(use("Read", { file_path: "a" }))], { fromStart: true, badAt: [] }), {}).state, "unclear");
  chk("5c ④:非空数组里状态缺失 ⇒ 看不清(codex P1 反例)", st([H(), A(use("Read", { file_path: "a" }))], { bgTasks: [{ id: "live" }] }), "unclear");
  // 被拦续轮:起点是最后一条用户亲口消息,被拦的 Stop、反馈行都不截断 ⇒ 前段动作都在区间里
  chk("被拦续轮:前段 Edit 保留 ⇒ 识别到潜在写动作", st([H(), A(use("Edit", { file_path: "p.md", old_string: "a", new_string: "b" })), ...blockedStop("s1"), fb, A(use("Read", { file_path: "a" }))]), "wrote");
  chk("被拦续轮:前段 NotebookEdit 保留", st([H(), A(use("NotebookEdit", { notebook_path: "n.ipynb", new_source: "x" })), ...blockedStop("s1"), fb, A(use("Read", { file_path: "a" }))]), "wrote");
  for (const nm of ["Agent", "Skill", "Workflow", "mcp__x__write", "SomethingNew", "PowerShell"]) chk(`被拦续轮:前段 ${nm} ⇒ 看不清`, st([H(), A(use(nm, { command: "x" })), ...blockedStop("s1"), fb, A(use("Read", { file_path: "a" }))]), "unclear");
  chk("被拦续轮:前段只 Read ⇒ 没写", st([H(), A(use("Read", { file_path: "b" })), ...blockedStop("s1"), fb, A(use("Grep", { pattern: "x" }))]), "none");
  chk("被拦续轮:压缩摘要夹在中间也不截断区间(前段 Write 保留)", st([H(), A(use("Write", { file_path: "w.md", content: "x" })), { type: "user", isCompactSummary: true, origin: { kind: "human" }, message: { content: "摘要" } }, ...blockedStop("s2"), fb, A(use("Read", { file_path: "a" }))]), "wrote");
  // 完整性正证(5b 第 5 条、5c 第 2 条)
  chk("区间里有损坏行 ⇒ 看不清", st([H(), A(use("Read", { file_path: "a" }))], { badAt: [4] }), "unclear");
  chk("5c ②:损坏行在区间之前也 ⇒ 看不清(起点判别的证据可能就是那一行)", st([H(), A(use("Read", { file_path: "a" }))], { badAt: [1] }), "unclear");
  chk("5c ②:codex P1 构造(human → Write → 损坏的阻断附件 → 被拦 Stop 汇总 → Read)⇒ 不是没写",
    run([H(), A(use("Write", { file_path: "w.md", content: "x" })), { type: "system", hookCount: 1, toolUseID: "s9" }, A(use("Read", { file_path: "a" }))], { prior: [], badAt: [2] }).state === "none", false);
  chk("5c ②:同一构造、Write 换成 Read ⇒ 仍看不清(只靠坏行判不完整)",
    run([H(), A(use("Read", { file_path: "w.md" })), { type: "system", hookCount: 1, toolUseID: "s9" }, A(use("Read", { file_path: "a" }))], { prior: [], badAt: [2] }).state, "unclear");
  chk("5c ②:转录没有任何有效记录(空文件)⇒ 不完整(codex P2)", (() => { const iv = collectInterval([], { fromStart: true, badAt: [] }); return [iv.complete, observeWrites(iv, { bgTasks: [] }).state]; })(), [false, "unclear"]);
  chk("末尾半行(位置 = 条目数)⇒ 看不清", st([H(), A(use("Read", { file_path: "a" }))], { badAt: [5] }), "unclear");
  chk("不知道有没有坏行(badAt 不是数组)⇒ 不完整 ⇒ 看不清", (() => { const o = run([H(), A(use("Read", { file_path: "a" }))], { badAt: null }); return [o.facts.complete, o.state]; })(), [false, "unclear"]);
  chk("收集器不给 badAt(调用方自带条目)⇒ 不完整", collectInterval([H(), passedStop("p"), H(), A(use("Read", { file_path: "a" }))], { fromStart: true }).complete, false);
  chk("会话首轮、读到了第一行 ⇒ 完整 ⇒ 没写", st([H(), A(use("Read", { file_path: "a" }))], { prior: [], fromStart: true }), "none");
  chk("全程没有亲口消息、读到了第一行 ⇒ 起点 0 ⇒ 完整", collectInterval([A(use("Read", { file_path: "a" }))], { fromStart: true, badAt: [] }).complete, true);
  chk("全程没有亲口消息、不能确认读到第一行 ⇒ 看不清", st([A(use("Read", { file_path: "a" }))], { prior: [], fromStart: false }), "unclear");
  chk("收集器缺席(interval 没给)⇒ 看不清", observeWrites(undefined).state, "unclear");
  chk("complete 属性缺席 ⇒ 看不清", observeWrites({ actions: [] }).state, "unclear");
  chk("complete 不是 true(字符串 \"true\")⇒ 看不清", observeWrites({ actions: [], complete: "true" }).state, "unclear");
  chk("零工具轮 + 在飞任务 ⇒ 看不清(5b ⑥)", st([H(), A({ type: "text", text: "等着" })], { bgTasks: [{ status: "running" }] }), "unclear");
  // ── 5c 第 1 条:起点 = 最后一条用户亲口消息(分类器 BP-1「软续轮」)──
  chk("5c ①:软续轮(Stop 带附加上下文放行,模型不等用户接着干)⇒ 前段 Write 保留 ⇒ 识别到潜在写动作",
    st([H(), A(use("Write", { file_path: "w.md", content: "x" })), passedStop("sx"), { type: "attachment", attachment: { type: "hook_additional_context", hookEvent: "Stop", content: ["提醒"] } }, A(use("Read", { file_path: "a" }))]), "wrote");
  chk("5c ①:软续轮前段只 Read ⇒ 没写", st([H(), A(use("Read", { file_path: "b" })), passedStop("sx"), A(use("Read", { file_path: "a" }))]), "none");
  chk("5c-②:Write 之后有一次放行的 Stop、再来一条亲口消息 ⇒ 那次 Stop 已看过 Write ⇒ 本轮只 Read ⇒ 没写", st([H(), A(use("Write", { file_path: "w.md", content: "x" })), passedStop("sy"), H("新问题"), A(use("Read", { file_path: "a" }))]), "none");
  chk("5c ①:只装工具结果的 user 行不算起点", isHumanOpen({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] } }), false);
  chk("5c ①:工具结果行即便夹带文字块也不算起点", isHumanOpen({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y" }, { type: "text", text: "附带的说明" }] } }), false);
  chk("5c ①:压缩摘要 / 被拦反馈 / task-notification 不算起点", [isHumanOpen({ type: "user", isCompactSummary: true, origin: { kind: "human" }, message: { content: "摘要" } }), isHumanOpen(fb), isHumanOpen({ type: "user", origin: { kind: "task-notification" }, message: { content: "x" } })], [false, false, false]);
  chk("5c-②:无 origin 的行不算亲口(正证)", isHumanOpen({ type: "user", message: { content: "老会话的一句话" } }), false);
  chk("5c-②:带 human origin 的斜杠命令算亲口(codex r2:/xros:… 原被排除)", isHumanOpen({ type: "user", origin: { kind: "human" }, message: { content: "<command-name>/xros:xros-run</command-name>" } }), true);
  chk("5c-②:中断标记(无 origin)不算亲口(codex r2 P1)", isHumanOpen({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }), false);
  // ── 5c-②:分类器 r2 的 F1–F6 构造(动作落在亲口消息之前、上一次放行的 Stop 之后)——全部不是没写 ──
  {
    const P = [H("上一轮"), A(use("Read", { file_path: "o" })), passedStop("p0")];
    const W = A(use("Write", { file_path: "w.md", content: "x" }));
    const B = A(use("Bash", { command: "ls" }));
    const intr = { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } };
    const cases = [
      ["F1 轮中排队插话的 human 行(插话之前的 Write)", [H("做"), W, H("顺便再看一下"), A(use("Read", { file_path: "a" }))]],
      ["F2 Esc 中断结束的轮不触发 Stop,随后新消息", [H("做"), W, intr, H("继续"), A(use("Read", { file_path: "a" }))]],
      ["F3 API 错误结束的轮不触发 Stop", [H("做"), W, { type: "system", subtype: "api_error", content: "overloaded" }, H("再试"), A(use("Read", { file_path: "a" }))]],
      ["F4 安全截停结束的轮不触发 Stop", [H("做"), { type: "assistant", message: { stop_reason: "refusal", content: [{ type: "tool_use", id: "tf4", name: "Edit", input: { file_path: "e.md", old_string: "a", new_string: "b" } }] } }, H("换个说法"), A(use("Read", { file_path: "a" }))]],
      ["F5 空闲时先 ! 命令再发消息", [{ type: "user", origin: { kind: "human" }, message: { content: "<bash-input>cp a b</bash-input>" } }, { type: "user", origin: { kind: "human" }, message: { content: "<bash-stdout></bash-stdout>" } }, H("看看"), A(use("Read", { file_path: "a" }))]],
      ["F6 中断标记之后就 Stop(前段 Bash)", [H("做"), B, intr]],
    ];
    for (const [nm, turn] of cases) chk("5c-② " + nm + " ⇒ 不是没写", run(turn, { prior: P }).state === "none" ? "none" : "not-none", "not-none");
    // codex r2 的 某会话 真转录形:亲口消息 → 11 次 Bash / 3 次 PowerShell / Agent / ListAgents → 原生中断标记 → Stop(期间无新亲口消息)
    const d1225 = [H("真正的亲口消息"), ...Array.from({ length: 11 }, (_, k) => A(use("Bash", { command: "echo " + k }))), ...Array.from({ length: 3 }, () => A(use("PowerShell", { command: "Get-Date" }))),
      A(use("Agent", { prompt: "x" })), ...Array.from({ length: 3 }, () => A(use("ListAgents", {}))), intr];
    const iv = collectInterval([...P, ...d1225], { fromStart: true, badAt: [] });
    chk("5c-② codex 某会话 中断例:起点不落在中断标记上,收到 18 个动作 ⇒ 看不清", [iv.actions.length, observeWrites(iv, { bgTasks: [] }).state], [18, "unclear"]);
  }
  // 5c-② 第 3 条:有效记录要带 type
  chk("5c-②:无亲口行的转录里被拦续轮 ⇒ 被拦的 Stop 不当边界 ⇒ 前段 Write 保留",
    observeWrites(collectInterval([A(use("Read", { file_path: "o" })), passedStop("q0"), A(use("Write", { file_path: "w.md", content: "x" })), ...blockedStop("q1"), fb, A(use("Read", { file_path: "a" }))], { fromStart: true, badAt: [] }), { bgTasks: [] }).state, "wrote");
  chk("5c-②:[null] ⇒ 不完整(codex r2 P2)", collectInterval([null], { fromStart: true, badAt: [] }).complete, false);
  chk("5c-②:[{}] ⇒ 不完整", collectInterval([{}], { fromStart: true, badAt: [] }).complete, false);
  chk("5c-②:没有放行过的 Stop、不能确认读到会话开头 ⇒ 即便有亲口消息也不完整", collectInterval([H(), A(use("Read", { file_path: "a" }))], { fromStart: false, badAt: [] }).complete, false);
  chk("5c ①:task-notification 开头的轮 + 上一轮 Write ⇒ 前段 Write 在区间里 ⇒ 识别到潜在写动作", st([{ type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>x</task-notification>" } }, A(use("Read", { file_path: "a" }))], { prior: PRIOR_W }), "wrote");
  // ── 5c 第 3 条:完成通知形态补全;TaskOutput 移出只读表 ──
  chk("5c ③:queue-operation enqueue 带 <task-notification> ⇒ 看不清", st([H(), { type: "queue-operation", operation: "enqueue", content: "<task-notification>done</task-notification>" }, A(use("Read", { file_path: "a" }))]), "unclear");
  chk("5c ③:queue-operation remove 带 <agent-message ⇒ 看不清", st([H(), { type: "queue-operation", operation: "remove", content: "<agent-message from=\"a1\">r</agent-message>" }]), "unclear");
  chk("5c ③:普通排队文字(queue-operation)⇒ 不算通知", st([H(), { type: "queue-operation", operation: "enqueue", content: "再看一下" }]), "none");
  chk("5c ③:通知标签在 4000 字之后也认(全文匹配)", st([H(), { type: "attachment", attachment: { type: "queued_command", origin: { kind: "peer" }, prompt: "x".repeat(5000) + "<agent-message from=\"a\">r</agent-message>" } }]), "unclear");
  chk("5c ③:TaskOutput ⇒ 看不清(在等上一轮的后台任务)", st([H(), A(use("TaskOutput", { task_id: "b1" }))]), "unclear");
  // ── 5c 第 5 条:用户 ! shell 与 IDE 编辑 ──
  chk("5c ⑤:区间里有 <bash-input> 行 ⇒ 看不清", st([H(), { type: "user", message: { content: "<bash-input>cp a b</bash-input>" } }, A(use("Read", { file_path: "a" }))]), "unclear");
  chk("5c ⑤:区间里有 edited_text_file 附件 ⇒ 看不清", st([H(), { type: "attachment", attachment: { type: "edited_text_file", filename: "a.md" } }, A(use("Read", { file_path: "a" }))]), "unclear");
  // ── 5c 第 7 条:Write 与完成通知并存 ⇒ 记「识别到潜在写动作」──
  chk("5c ⑦:Write 与完成通知并存 ⇒ 识别到潜在写动作", st([H(), { type: "queue-operation", operation: "enqueue", content: "<task-notification>x</task-notification>" }, A(use("Write", { file_path: "w.md", content: "x" }))]), "wrote");
  chk("background_tasks 不是数组 ⇒ 看不清", run([H()], { bgTasks: "x" }).state, "unclear");
  // 其余工具与正证
  chk("NotebookEdit(notebook_path)⇒ 写目标在", run([H(), A(use("NotebookEdit", { notebook_path: "n.ipynb", new_source: "x" }))]).targets.map((x) => x.path), ["n.ipynb"]);
  chk("MultiEdit ⇒ 正文进 body", run([H(), A(use("MultiEdit", { file_path: "a.md", edits: [{ old_string: "a", new_string: "BODY" }] }))]).sources[0].body, "BODY");
  chk("WebFetch / WebSearch / TodoWrite ⇒ 没写(落盘与会话清单不在范围内)", st([H(), A(use("WebFetch", { url: "u" }), use("WebSearch", { query: "q" }), use("TodoWrite", { todos: [] }))]), "none");
  chk("Skill ⇒ 看不清", st([H(), A(use("Skill", { skill: "x" }))]), "unclear");
  chk("看不清按写了算(asWrote)", run(bash("ls")).asWrote, true);
  chk("没写 ⇒ asWrote 为假", run([H(), A(use("Read", { file_path: "a" }))]).asWrote, false);
  const so = run([H(), A(use("Edit", { file_path: "x.md", old_string: "a", new_string: "b" }))]).sources[0];
  chk("观测带来源工具与调用编号", [so.tool, /^toolu_ws\d+$/.test(so.id)], ["Edit", true]);
  chk("失败的 Write 也算潜在写动作(只作触发资格)", st([H(), A(use("Write", { file_path: "z.md", content: "x" })), { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", is_error: true, content: "失败" }] } }]), "wrote");

  // ── 批 299 r1–r3 报过的全部「命令漏判」形 + 设计复核 r1/r2 的反例:**没有一条是没写** ──
  for (const cmd of [
    "file -C -m magic", "./cat a.md", "scripts/ls", "../bin/grep x a.md", "cat.exe a.md", "/tmp/tool/cat a.md",
    "git cat-file --filters HEAD:a.txt", "git cat-file --textconv HEAD:a.txt", "git diff --ext-diff", "git diff", "git show HEAD", "git log -p",
    "git log --stat", "git grep -Oless x", "git blame a.txt", "git stash list --format=%h", "git rev-list --objects HEAD",
    "git log --pretty --output=out.txt", "git log --abbrev --output=out.txt", "git status --porcelain --output=x",
    "git config --file --get audit.key value", "git config --file -l audit.key value", "git config --get user.name",
    "cat a.md > /dev/stderr", "cat a.md 2>/dev/tty", "ls 2>nul", "ls 2>NUL", "ls 2>/dev/NULL", "ls >&-",
    "git log '--format=%G?' -n 1", "git log --pretty=format:%GS", "git for-each-ref '--format=%(signature)'",
    "grep -r x *", "cat a?.md", "ls [ab].md", "cat {a,b}.md", "cd docs && cat a.md", "cd / && cat etc/passwd",
    "git -C E:/other status", "git -C ../other status", "git --git-dir=/other/.git log", "git --work-tree E:/other status",
    "grep --ignore x a.md", "rg --pre=cat x", "rg -z x", "head -5 a.md", "date 0101", "find . -fls out.txt", "find . -delete",
    "sort -o out.txt in.txt", "sort in.txt", "echo $(date)", "cat \"$F\"", "cat <<'EOF'\nx\nEOF", "node x.mjs",
    "false && echo x > f", "f() { echo x > f; }", "git push --dry-run private", "git commit --help",
    "cp a.md b.md && cp b.md a.md", "echo B > f && echo A > f",
  ]) chk(`反例 ${JSON.stringify(cmd).slice(0, 48)} ⇒ 不是没写`, st(bash(cmd)) === "none" ? "none" : "not-none", "not-none");
  chk("PowerShell(任意)⇒ 看不清", st([H(), A(use("PowerShell", { command: "Get-ChildItem" }))]), "unclear");
  chk("超长命令 ⇒ 不是没写且标截断", (() => { const o = run(bash("echo " + "x".repeat(8100))); return [o.state !== "none", o.truncated]; })(), [true, true]);

  // 只读工具表与 hook-start-gate 同源(漂了即红)
  try {
    const src = fs.readFileSync(fileURLToPath(new URL("../hook-start-gate.mjs", import.meta.url)), "utf8");
    const m = /const READONLY_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    const theirs = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : null;
    chk("READONLY_TOOLS = hook-start-gate 的只读表去掉 TaskOutput", theirs && theirs.filter((x) => !READONLY_DIFF_FROM_START_GATE.includes(x)), [...READONLY_TOOLS].sort());
    chk("hook-start-gate 的只读表里确有 TaskOutput(差异是有意的)", !!theirs && theirs.includes("TaskOutput"), true);
    chk("hook-start-gate 不再有快照代码", /SNAPSHOT_WIRED|snapshotInWorker|turn-snapshot/.test(src.replace(/\/\/[^\n]*/g, "")), false);
  } catch (e) { chk("READONLY_TOOLS 与 hook-start-gate 逐项相同", "读不到 hook-start-gate:" + e.message, "ok"); }

  let pass = 0;
  for (const [res, name, got] of t) { if (res === "PASS") pass++; if (!quiet || res === "FAIL") console.log(`  ${res}  ${name}${res === "FAIL" ? "  ← 实得 " + got : ""}`); }
  if (!quiet) console.log(`\nwrite-state 自测 ${pass}/${t.length}`);
  return { pass, total: t.length };
}

const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
if (IS_MAIN && process.argv.includes("--self-test")) {
  const r = selfTest();
  process.exit(r.pass === r.total ? 0 : 1);
}
