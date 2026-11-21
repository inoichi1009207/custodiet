// batch-ruler.mjs —— 主尺:从引出这一批的那句指令到关账,人亲口说了几条话(批 305)
//
// 干什么:batch-goal 的 `--arm --instruction` 用它在会话转录里定位那句指令;`--clear` / `--ruler` 用它数
//        指令那一刻起转录里**人亲口说的消息**。只读转录,不写任何东西。
//
// 认人口径(与 gate-ctx.buildCtx 的 userText 同一套结构判据,自测逐条对账;差异两处,见 classifyEntry 头注):
//   算(人说的)        打字的消息 / 模型忙时排队插的话 / 斜杠命令 / 「!」命令 / 中断标记 / 无头会话的提示词 /
//                      没有来源标记的老形态
//   不算(不是人说的)  工具结果 / 钩子注入(Stop 反馈、hook_* 附件、插件消息)/ 系统提醒 / 后台任务通知 /
//                      子代理与跨会话消息 / 压缩后的摘要 / 技能与命令正文(isMeta)/ 命令输出 / 自动续跑 /
//                      来源不认识的消息(单列,不计入)
//   拿不准的类型一律**算进去**并按类型分项打出(任务书预付的决定:宁可上界偏大,不悄悄漏数)。
//
// 天花板(照实写进输出):
//   · 这是**上界**:不区分纠正、拍板、问进度;无头会话的开场提示词常是发车方写的,也算了进去(分项单列,可自行减)。
//   · 只数得到**读得到的那几份转录**:指令所在会话、武装过本批的会话、跑关账的会话;中途换过的别的会话不在内。
//   · 指令靠「原话逐字出现在某条人说的消息里」定位(空白归一);转述过的原话定位不到 ⇒ 量不出,不猜。
//
// 转录在哪:沿用 write-checks.mjs 的 transcriptDirs / projectDirName(~/.claude/projects/<项目目录名>/<会话号>.jsonl),不另拼路径规则。

import fs from "node:fs";
import path from "node:path";
import { isInterruptLine, isStopFeedbackLine } from "./gate-ctx.mjs";

export const HUMAN_KINDS = Object.freeze({
  typed: "打字",
  queued: "排队插话",
  slash: "斜杠命令",
  bang: "「!」命令",
  interrupt: "中断标记",
  sdk: "无头会话的提示词",
  legacy: "无来源标记的老形态",
});
export const OTHER_KINDS = Object.freeze({
  "tool-result": "工具结果",
  hook: "钩子注入",
  "system-reminder": "系统提醒",
  "task-notification": "后台任务通知",
  peer: "子代理 / 跨会话消息",
  subagent: "子代理侧链",
  "compact-summary": "压缩摘要",
  meta: "技能 / 命令正文",
  "command-output": "命令输出",
  "auto-continuation": "自动续跑",
  "unknown-origin": "来源不认识",
  "attachment-other": "其它附件",
});

const textOf = (c) => typeof c === "string" ? c
  : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => String(b.text || "")).join("\n") : "";
const RE_HOOK = /^\s*Stop hook (feedback|additional context)/;
const RE_SYSNOTE = /^\s*\[SYSTEM NOTIFICATION/;
const RE_TASK = /^\s*<task-notification>/;
const RE_PEER = /^\s*(<cross-session-message|Another Claude session sent a message|<agent-message|<teammate-message)/;
const RE_CMD_OUT = /^\s*<(bash-(stdout|stderr)|local-command-(stdout|stderr))>/;
const RE_SLASH = /^\s*<command-(name|message)>/;
const RE_BANG = /^\s*<bash-input>/;
const stripReminders = (s) => String(s || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");

/** 一条转录条目是不是人亲口说的。返回 { human, kind },kind 见 HUMAN_KINDS / OTHER_KINDS;与数人无关的条目(assistant、system…)⇒ null。
 *  与 gate-ctx.buildCtx 的差异(都只让上界变大或把非人排掉,自测「与 gate-ctx 对账」逐条钉住):
 *   ① 只有图片、没有文字的人的消息:buildCtx 收不到字,这里算一条;
 *   ② 侧链条目(isSidechain,子代理自己的对话):buildCtx 不看这个键,这里一律不算。 */
export function classifyEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (e.type === "attachment") {
    const a = e.attachment || {};
    if (e.isSidechain === true) return { human: false, kind: "subagent" };
    if (a.type === "queued_command") {
      const ok = a.origin && a.origin.kind;
      const t = textOf(a.prompt);
      if (ok === "task-notification" || a.commandMode === "task-notification" || (!ok && RE_TASK.test(t))) return { human: false, kind: "task-notification" };
      if (ok === "peer" || (!ok && RE_PEER.test(t))) return { human: false, kind: "peer" };
      if (ok && ok !== "human") return { human: false, kind: "unknown-origin", origin: String(ok) };
      if (!ok && (RE_HOOK.test(t) || RE_SYSNOTE.test(t))) return { human: false, kind: "hook" };
      return { human: true, kind: RE_SLASH.test(t) ? "slash" : "queued" };
    }
    return { human: false, kind: /^hook_/.test(String(a.type || "")) ? "hook" : "attachment-other" };
  }
  if (e.type !== "user") return null;
  if (e.isSidechain === true) return { human: false, kind: "subagent" };
  if (e.isCompactSummary === true) return { human: false, kind: "compact-summary" };
  const c = e.message && e.message.content;
  const t = textOf(c);
  const ok = e.origin && e.origin.kind;
  if (ok) {
    if (ok === "human") {
      if (e.promptSource === "sdk" || e.turnOrigin === "sdk") return { human: true, kind: "sdk" };
      if (RE_SLASH.test(t)) return { human: true, kind: "slash" };
      return { human: true, kind: e.promptSource === "queued" ? "queued" : "typed" };
    }
    if (ok === "task-notification") return { human: false, kind: "task-notification" };
    if (ok === "peer") return { human: false, kind: "peer" };
    if (ok === "plugin") return { human: false, kind: "hook" };
    if (ok === "auto-continuation") return { human: false, kind: "auto-continuation" };
    return { human: false, kind: "unknown-origin", origin: String(ok) };
  }
  if (e.isMeta === true) {
    if (RE_HOOK.test(t)) return { human: false, kind: "hook" };
    if (t.trim() && !stripReminders(t).trim()) return { human: false, kind: "system-reminder" };
    return { human: false, kind: "meta" };
  }
  const hasToolResult = Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
  if (hasToolResult && !t.trim()) return { human: false, kind: "tool-result" };
  if (isInterruptLine(e)) return { human: true, kind: "interrupt" };
  if (isStopFeedbackLine(e) || RE_HOOK.test(t) || RE_SYSNOTE.test(t)) return { human: false, kind: "hook" };
  if (RE_TASK.test(t)) return { human: false, kind: "task-notification" };
  if (RE_PEER.test(t)) return { human: false, kind: "peer" };
  if (RE_CMD_OUT.test(t)) return { human: false, kind: "command-output" };
  if (t.trim() && !stripReminders(t).trim()) return { human: false, kind: "system-reminder" };
  if (RE_SLASH.test(t)) return { human: true, kind: "slash" };
  if (RE_BANG.test(t)) return { human: true, kind: "bang" };
  return { human: true, kind: "legacy" };
}

/** 人说的那条消息的文字(排队附件取 prompt;系统提醒块剥掉)。 */
export function entryText(e) {
  const raw = e && e.type === "attachment" ? textOf(e.attachment && e.attachment.prompt) : textOf(e && e.message && e.message.content);
  return stripReminders(raw);
}

export const SCAN_BUDGET = 512 * 1024 * 1024;
const RE_LINE = /"type"\s*:\s*"(?:user|attachment)"/;

/** 流式逐行读一份转录,只解析像 user / attachment 的行(其余行不解析:转录里大头是请求快照与助理输出)。
 *  返回 { err? }:读不了 / 超过扫描上限 ⇒ err(调用方按量不出处理,不当成零)。`all` = 每一行都解析;`match` = 换一条行预筛正则。 */
export function eachEntry(file, onEntry, { budget = SCAN_BUDGET, all = false, match = null } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let parts = [], used = 0;   // parts = 还没遇到换行的那一行的字节片(按字节攒、整行再解码:多字节字符落在块边界时不会被切坏)
    const onLine = (line) => {
      if (!line.trim()) return;
      if (!all && !(match || RE_LINE).test(line)) return;
      let e; try { e = JSON.parse(line); } catch { return; }
      onEntry(e);
    };
    const flush = (piece) => { const b = parts.length ? Buffer.concat(piece ? [...parts, piece] : parts) : piece; parts = []; if (b && b.length) onLine(b.toString("utf8")); };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      used += n;
      if (used > budget) return { err: `转录超过扫描上限 ${Math.round(budget / 1048576)}MB(${path.basename(file)})` };
      const chunk = buf.subarray(0, n);
      let start = 0;
      for (let k = chunk.indexOf(10, start); k >= 0; k = chunk.indexOf(10, start)) { flush(chunk.subarray(start, k)); start = k + 1; }
      if (start < n) parts.push(Buffer.from(chunk.subarray(start, n)));
    }
    flush(null);
    return {};
  } catch (e) { return { err: `转录读不了(${path.basename(String(file))}:${e.code || e.message})` }; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* 关不了不影响结论 */ } }
}

const RE_SID = /^[\w-]{8,80}$/;
/** 会话号 ⇒ 转录文件(在 transcriptDirs 给的目录里找 <会话号>.jsonl)。找不到 ⇒ null。 */
export function findTranscript(sid, dirs) {
  if (!RE_SID.test(String(sid || ""))) return null;
  for (const d of Array.isArray(dirs) ? dirs : []) {
    const f = path.join(d, `${sid}.jsonl`);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* 不在这个目录 */ }
  }
  return null;
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
/** 「原话太短就不做包含匹配」的门槛:短串(如「好」「继续」)会撞上不相干的消息,只认整条相等。 */
export const CONTAINS_MIN = 6;

/** 在一份转录里找那句指令:最后一条**文字等于原话**、或(原话 ≥ CONTAINS_MIN 字时)**包含原话**的人说的消息,时刻不晚于 untilMs。
 *  返回 { at, uuid, match:"exact"|"contains" } 或 { why }。中断标记不参与(那不是一句话)。 */
export function locateInstruction(file, text, { untilMs = Infinity, budget } = {}) {
  const want = norm(text);
  if (!want) return { why: "原话为空" };
  let hit = null, humans = 0;
  const r = eachEntry(file, (e) => {
    const c = classifyEntry(e);
    if (!c || !c.human || c.kind === "interrupt") return;
    humans++;
    const ts = Date.parse(String(e.timestamp || ""));
    if (!Number.isFinite(ts) || ts > untilMs) return;
    const got = norm(entryText(e));
    const match = got === want ? "exact" : (want.length >= CONTAINS_MIN && got.includes(want) ? "contains" : null);
    if (!match) return;
    if (!hit || ts >= hit.ts) hit = { ts, at: new Date(ts).toISOString(), uuid: typeof e.uuid === "string" ? e.uuid : null, match };
  }, { budget });
  if (r.err) return { why: r.err };
  if (!hit) return { why: humans ? `转录里 ${humans} 条人说的消息都对不上这句原话(逐字比,空白归一;转述过的原话定位不到)` : "转录里没有人说的消息" };
  return { at: hit.at, uuid: hit.uuid, match: hit.match };
}

/** 数一份转录里 [sinceMs, untilMs] 内人说的消息。seen = 跨文件去重用的键集(条目 uuid;排队附件另记 source_uuid)。
 *  返回 { count, byKind, excluded, unknownOrigins, noTimestamp, err? }。 */
export function countHuman(file, { sinceMs, untilMs = Infinity, seen = new Set(), budget } = {}) {
  const out = { count: 0, byKind: {}, excluded: {}, unknownOrigins: {}, noTimestamp: 0, deduped: 0 };
  const r = eachEntry(file, (e) => {
    const c = classifyEntry(e);
    if (!c) return;
    const ts = Date.parse(String(e.timestamp || ""));
    const hasTs = Number.isFinite(ts);
    if (hasTs && (ts < sinceMs || ts > untilMs)) return;
    if (!c.human) {
      out.excluded[c.kind] = (out.excluded[c.kind] || 0) + 1;
      if (c.kind === "unknown-origin") out.unknownOrigins[c.origin] = (out.unknownOrigins[c.origin] || 0) + 1;
      return;
    }
    // 去重:同一条消息在多份转录里各有一行(续接会话会带上旧行),或排队附件与它后来落成的 user 行指向同一条
    const uuid = typeof e.uuid === "string" && e.uuid ? e.uuid : null;
    const src = e.type === "attachment" && typeof e.attachment?.source_uuid === "string" ? e.attachment.source_uuid : null;
    if ((uuid && (seen.has(`u:${uuid}`) || seen.has(`s:${uuid}`))) || (src && seen.has(`u:${src}`))) { out.deduped++; return; }
    if (uuid) seen.add(`u:${uuid}`);
    if (src) seen.add(`s:${src}`);
    if (!hasTs) out.noTimestamp++;   // 没有时间戳的放不进窗口:算进去(上界),并单列
    out.count++;
    out.byKind[c.kind] = (out.byKind[c.kind] || 0) + 1;
  }, { budget });
  return r.err ? { ...out, err: r.err } : out;
}

/** 主尺。instruction = 批状态里记的 { text, sid, at };sids = 要读的会话号(指令所在、武装过本批的、跑关账的);dirs = 转录目录。
 *  返回 { ok:true, count, byKind, excluded, since, until, sessions:[{ sid, read, count?, why? }] } 或 { ok:false, why }。 */
export function measureRuler({ instruction, sids = [], dirs, nowMs = Date.now(), budget } = {}) {
  if (!instruction || !norm(instruction.text)) return { ok: false, why: "开批时没记指令(--arm 时加 --instruction \"<原话>\")" };
  const sinceMs = Date.parse(String(instruction.at || ""));
  if (!Number.isFinite(sinceMs)) return { ok: false, why: `指令未定位${instruction.why ? `:${instruction.why}` : ""}` };
  const want = [...new Set([instruction.sid, ...sids].filter((s) => RE_SID.test(String(s || ""))))];
  if (!want.length) return { ok: false, why: "没有可读的会话号(指令的会话号没记,当前也取不到会话号)" };
  if (!Array.isArray(dirs) || !dirs.length) return { ok: false, why: "转录目录不在或读不了" };
  const seen = new Set();
  const total = { count: 0, byKind: {}, excluded: {}, unknownOrigins: {}, noTimestamp: 0 };
  const add = (into, from) => { for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v; };
  const sessions = [];
  for (const sid of want) {
    const file = findTranscript(sid, dirs);
    if (!file) { sessions.push({ sid, read: false, why: "找不到转录文件" }); continue; }
    const r = countHuman(file, { sinceMs, untilMs: nowMs, seen, budget });
    if (r.err) { sessions.push({ sid, read: false, why: r.err }); continue; }
    sessions.push({ sid, read: true, count: r.count });
    total.count += r.count; total.noTimestamp += r.noTimestamp;
    add(total.byKind, r.byKind); add(total.excluded, r.excluded); add(total.unknownOrigins, r.unknownOrigins);
  }
  const base = instruction.sid ? sessions.find((s) => s.sid === instruction.sid) : null;
  if (base && !base.read) return { ok: false, why: `读不到指令所在会话的转录(会话 ${base.sid}:${base.why})`, sessions };
  if (!sessions.some((s) => s.read)) return { ok: false, why: `一份转录都读不到(${sessions.map((s) => `${s.sid}:${s.why}`).join(";")})`, sessions };
  return { ok: true, ...total, since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString(), sessions };
}

const kindList = (m, labels) => Object.entries(m || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${labels[k] || k} ${n}`).join("、");

/** 主尺的一行(关账时打、也写进批日志的 ruler.line)。 */
export function formatRuler(r) {
  if (!r || !r.ok) return `主尺:量不出(${(r && r.why) || "没有结果"})`;
  const read = r.sessions.filter((s) => s.read).length, unread = r.sessions.length - read;
  return `主尺:人亲口说了 ${r.count} 条(${kindList(r.byKind, HUMAN_KINDS) || "零"};含引出本批的那句指令)——自 ${r.since} 至 ${r.until},` +
    `读了 ${read} 份转录${unread ? `、另 ${unread} 份读不到` : ""}。口径:上界,不区分纠正 / 拍板 / 问进度;跨会话续跑的批只数读得到的转录。`;
}

/** 明细(--ruler 用):每份转录读没读到、没算进去的各类各几条。 */
export function formatRulerDetail(r) {
  const out = [];
  for (const s of (r && r.sessions) || []) out.push(`  会话 ${s.sid}:${s.read ? `读到,人说的 ${s.count} 条` : `读不到(${s.why})`}`);
  if (r && r.ok) {
    out.push(`  没算进去(不是人说的):${kindList(r.excluded, OTHER_KINDS) || "零"}`);
    const uo = Object.entries(r.unknownOrigins || {});
    if (uo.length) out.push(`  ⚠ 来源不认识、没计入:${uo.map(([k, n]) => `${k}×${n}`).join("、")}(转录格式可能变了——核对后把这种来源归到「算」或「不算」)`);
    if (r.noTimestamp) out.push(`  ⚠ ${r.noTimestamp} 条人说的消息没有时间戳,放不进窗口,已算进去(上界)`);
  }
  return out;
}
