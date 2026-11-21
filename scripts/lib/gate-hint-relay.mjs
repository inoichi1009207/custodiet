#!/usr/bin/env node
// gate-hint-relay.mjs —— 收尾闸「只提示」的延后送达:寄存、取走、过期丢弃记账(批 305;唯一实现)
//
// 为什么要有:收尾闸的「只提示」原来经 Stop 钩子的 `hookSpecificOutput.additionalContext` 送给模型,
//   而这个字段会让模型**再走一轮**(本机 changelog:「…to give Claude feedback and keep the turn going」;
//   本机转录 1,057 次只提示里 1,040 次的下一条是 assistant 续轮)。「只提示」按设计不该打断人和模型的节奏
//   ⇒ 交互会话里改成:收尾钩子把提示寄存到盘上,开工钩子在下一次 UserPromptSubmit 时取走、随那条消息注入一次。
//
// 两头各是谁:
//   · 写端 = scripts/hook-stop-closure.mjs 的 emit()(`stashHint`);
//   · 读端 = scripts/hook-start-gate.mjs 的 UserPromptSubmit 分支(`sweepExpired` → `takeHints` → 输出 → `commit`)。
//   格式、路径、过期口径只在本文件里;两头都不自己拼路径。
//
// 盘上形态(都在 gitignore 面,与别的运行时台账同目录约定):
//   · `.claude/.gate-pending-hints/<sha1(session_id) 前 16 位>.json` —— 每会话一个信箱:
//       { sid, rx: 读端上次在本会话跑过的时刻(毫秒), items: [{ t: 寄存时刻, text: 提示全文, ids: [规则 id] }] }
//   · `.claude/.gate-hints-dropped.jsonl` —— 没送到模型就被丢弃的提示,一行一次(`--fp-report` 末尾汇总一行)。
//
// 三条不变量:
//   ① **读端在场才寄存**(`receiverSeen`):信箱里有 `rx` = 开工钩子在本会话的 UserPromptSubmit 上真跑过。
//      只装了收尾钩子、没接开工钩子的仓(安装器缺省就是这样)永远没有 `rx` ⇒ 写端照旧走老通道,提示不会寄存了没人取。
//   ② **拿不准是不是交互会话 ⇒ 不寄存**(`interactiveSession`):只认转录行上的 `entrypoint` 字段等于 "cli"
//      (本机转录实测取值:cli / sdk-cli / sdk-ts;sdk-cli 的 50 份里 49 份没有任何用户亲自发言)。
//      取不到、或是别的值 ⇒ 当无头处理,走老通道。两类错的代价:寄存了没人取 = 提示悄悄丢了;多走一轮只是啰嗦。
//   ③ **丢弃必须留痕**:过期(寄存超过 `HINT_TTL_MS` 没被取走)或信箱损坏 ⇒ 先写丢弃账、写成了才删;写不成就留着下次再试。
//   ④ **只在人发起的那一轮寄存**(批 305 回修,用户裁定;判在写端 hook-stop-closure 的 `turnOpenedByHuman`):本轮起点
//      (与 lastTurn 同一切点)是人亲口说的一条消息才寄存;后台任务回报、定时唤醒、子代理 / 跨会话消息、自动续跑、
//      闸的反馈让模型续的那一轮 ⇒ 老通道当轮送。否则全自动跑的批里,提示要等人的下一条消息才到,可能从头到尾没人看到。
//
// CEILING:
//   · 「送到」只保证注入进了下一条用户消息的上下文,不保证模型读了、照做了。
//   · `entrypoint` 的取值含义没有官方文档出处(本机 changelog 未检到),只有本机转录的分布;它改名或改值 ⇒ ② 判成无头 ⇒ 退回老通道(多走一轮,不丢)。
//   · 会话在提示寄存之后再没有下一条用户消息(直接关掉、清屏换了会话号)⇒ 提示到期后记进丢弃账,模型没看到。
//   · 会话**最后一轮**的提示寄存后,用户清屏或退出就没人看到,7 天后记一笔丢弃账——这是已知并接受的代价
//     (换来的是人在场的每一轮不为「只提示」单独再叫模型一轮)。
//   · 这是送达通道,不是防线:手改信箱能压掉提示,按「只数诚实遗忘」不设防。
// 失效条件:Claude Code 不再因 Stop 的非阻断反馈续轮 ⇒ 本件与收尾钩子里的寄存分支一起撤,提示回到当轮送达。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const PENDING_DIR = ".claude/.gate-pending-hints";
export const DROP_LOG = ".claude/.gate-hints-dropped.jsonl";
/** 寄存多久没被取走就丢弃并记账。取 7 天(与开工钩子去重账的保留期同一口径):同一会话隔夜、隔周末回来仍送得到。 */
export const HINT_TTL_MS = 7 * 24 * 3600 * 1000;

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const boxName = (sid) => crypto.createHash("sha1").update(String(sid)).digest("hex").slice(0, 16) + ".json";
export const boxFile = (root, sid) => path.join(root, PENDING_DIR, boxName(sid));
const validItem = (it) => isObj(it) && Number.isFinite(it.t) && typeof it.text === "string" && it.text.length > 0;
const sameItem = (a, b) => a.t === b.t && a.text === b.text;

/** 读一个信箱。state:missing(没有)/ ok / corrupt(在但读不出或结构不对)。绝不抛。 */
function readBox(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return { state: e && e.code === "ENOENT" ? "missing" : "corrupt", box: null }; }
  let o; try { o = JSON.parse(raw); } catch { return { state: "corrupt", box: null }; }
  if (!isObj(o) || !Array.isArray(o.items) || !o.items.every(validItem)) return { state: "corrupt", box: null };
  return { state: "ok", box: { sid: typeof o.sid === "string" ? o.sid : "", rx: Number.isFinite(o.rx) ? o.rx : null, items: o.items.map((it) => ({ t: it.t, text: it.text, ids: Array.isArray(it.ids) ? it.ids.map(String) : [] })) } };
}
/** 写信箱:临时文件再改名(读者不会读到半截);改名失败退回直接覆盖写。写不成就抛。 */
function writeBox(file, box) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(box);
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); }
  catch { try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉临时件不影响 */ } fs.writeFileSync(file, body); }
}
/** 记一笔丢弃。写不成就抛(调用方据此不删原件)。 */
function logDrop(root, row) {
  const f = path.join(root, DROP_LOG);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(row) + "\n");
}
const dropRow = (now, sid, reason, items) => ({
  ts: new Date(now).toISOString(), sid: sid || undefined, reason, n: items.length,
  ids: [...new Set(items.flatMap((it) => it.ids || []))],
  ...(items.length ? { stashedAt: new Date(Math.min(...items.map((it) => it.t))).toISOString() } : {}),
  // 只留每条提示的前两行(标题行 + 第一条命中),够回头认是哪条;全文不重复存
  heads: items.map((it) => it.text.split("\n").slice(0, 2).join(" / ").slice(0, 200)),
});

/** 转录条目里最后一个 `entrypoint` 字段的值(续会话换了入口时以最近的为准);没有 ⇒ null。 */
export function sessionEntrypoint(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const v = entries[i] && entries[i].entrypoint;
    if (typeof v === "string" && v) return v;
  }
  return null;
}
/** 是不是交互会话(有「下一条用户消息」可等)。只在正面认出时返回 true,见头注不变量②。
 *  环境变量 CLAUDE_CODE_ENTRYPOINT 只用来**否决**(给了且不是 cli ⇒ 不是交互),不单独作肯定依据。 */
export function interactiveSession(entries, env = process.env) {
  if (sessionEntrypoint(entries) !== "cli") return false;
  const e = env && env.CLAUDE_CODE_ENTRYPOINT;
  if (typeof e === "string" && e && e !== "cli") return false;
  return true;
}

/** 读端(开工钩子)在本会话的 UserPromptSubmit 上跑过没有。 */
export function receiverSeen(root, sid) {
  if (!sid) return false;
  const r = readBox(boxFile(root, sid));
  return r.state === "ok" && r.box.rx !== null;
}
/** 读端每次 UserPromptSubmit 调:信箱没有 `rx` 就补上(已有就不写,平时零写入)。失败返回 false,不抛。 */
export function markReceiver(root, sid, now = Date.now()) {
  if (!sid) return false;
  const f = boxFile(root, sid);
  try {
    const r = readBox(f);
    if (r.state === "ok" && r.box.rx !== null) return true;
    if (r.state === "corrupt") return false;   // 损坏的信箱由 takeHints 记账后重置,这里不盖
    writeBox(f, { sid, rx: now, items: r.state === "ok" ? r.box.items : [] });
    return true;
  } catch { return false; }
}

/** 写端(收尾钩子)调:把一条提示放进本会话的信箱。写不成就抛——调用方退回老通道,不得当作已寄存。 */
export function stashHint(root, sid, hint, now = Date.now()) {
  if (!sid) throw new Error("没有会话号,寄存不了");
  const text = String((hint && hint.text) || "");
  if (!text) throw new Error("空提示");
  const f = boxFile(root, sid);
  const r = readBox(f);
  if (r.state !== "ok") throw new Error(`信箱不可用(${r.state})`);
  writeBox(f, { ...r.box, sid, items: [...r.box.items, { t: now, text, ids: Array.isArray(hint.ids) ? hint.ids.map(String) : [] }] });
}

/** 把要注入的正文拼出来:同文只留一份;寄存超过一小时的标明多久以前。 */
export function formatRelay(items, now = Date.now()) {
  const seen = new Set(), keep = [];
  for (const it of items) { if (seen.has(it.text)) continue; seen.add(it.text); keep.push(it); }
  if (!keep.length) return "";
  const age = (t) => { const h = Math.floor((now - t) / 3600e3); return h >= 1 ? `(${h >= 48 ? Math.floor(h / 24) + " 天" : h + " 小时"}前留下)` : ""; };
  return "⟦上一轮收尾闸的提示⟧(只提示、不拦;随本条消息送达,上一轮没有为它单独叫你回来)\n" +
    keep.map((it) => it.text + age(it.t)).join("\n");
}

/** 读端调:取本会话信箱里的提示。返回 `{ text, n, expired, commit }`;没有可送的 ⇒ text 为空串。
 *  **先输出、后 `commit()`**:commit 才把已送的从信箱里拿掉(中途出事 ⇒ 下次再送一遍,多送方向)。
 *  过期的不送,commit 时记进丢弃账;信箱损坏 ⇒ commit 时记账并重置。commit 绝不抛。 */
export function takeHints(root, sid, now = Date.now(), ttl = HINT_TTL_MS) {
  const none = { text: "", n: 0, expired: 0, commit() {} };
  if (!sid) return none;
  const f = boxFile(root, sid);
  const r = readBox(f);
  if (r.state === "missing") return none;
  if (r.state === "corrupt") {
    return { ...none, commit() {
      try { logDrop(root, { ...dropRow(now, sid, "corrupt", []), n: null }); } catch { return; }   // 记不上账 ⇒ 原件留着
      try { writeBox(f, { sid, rx: now, items: [] }); } catch { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* 下次再试 */ } }
    } };
  }
  const fresh = r.box.items.filter((it) => now - it.t <= ttl);
  const expired = r.box.items.filter((it) => now - it.t > ttl);
  if (!fresh.length && !expired.length) return none;
  return {
    text: formatRelay(fresh, now), n: fresh.length, expired: expired.length,
    commit() {
      let gone = fresh;
      if (expired.length) { try { logDrop(root, dropRow(now, sid, "expired", expired)); gone = gone.concat(expired); } catch { /* 记不上账 ⇒ 过期件留着下次再记 */ } }
      try {
        // 重读一遍再减:输出期间写端若又放进新的一条,不能被整份覆盖掉
        const again = readBox(f);
        const base = again.state === "ok" ? again.box : r.box;
        writeBox(f, { sid, rx: base.rx ?? now, items: base.items.filter((it) => !gone.some((g) => sameItem(g, it))) });
      } catch { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* 删不掉 ⇒ 下次会再送一遍 */ } }
    },
  };
}

/** 读端调:清别的会话留下的信箱——过期的提示记进丢弃账后删;空信箱过期后直接删(只是在场标记,不算丢弃)。
 *  本会话自己的信箱不在这里动(`takeHints` 管)。返回丢弃的提示条数。绝不抛。 */
export function sweepExpired(root, sid, now = Date.now(), ttl = HINT_TTL_MS) {
  let dropped = 0;
  let names = [];
  try { names = fs.readdirSync(path.join(root, PENDING_DIR)); } catch { return 0; }
  const own = sid ? boxName(sid) : null;
  for (const n of names) {
    if (n === own) continue;
    const f = path.join(root, PENDING_DIR, n);
    try {
      if (!n.endsWith(".json")) { if (now - fs.statSync(f).mtimeMs > ttl) fs.rmSync(f, { recursive: true, force: true }); continue; }   // 残留的临时件
      const r = readBox(f);
      if (r.state === "missing") continue;
      if (r.state === "corrupt") {
        if (now - fs.statSync(f).mtimeMs <= ttl) continue;
        logDrop(root, { ...dropRow(now, "", "corrupt", []), n: null, box: n });
        fs.rmSync(f, { recursive: true, force: true });
        continue;
      }
      const expired = r.box.items.filter((it) => now - it.t > ttl);
      const rest = r.box.items.filter((it) => now - it.t <= ttl);
      if (expired.length) { logDrop(root, dropRow(now, r.box.sid, "expired", expired)); dropped += expired.length; }
      if (!rest.length) { if (expired.length || now - (r.box.rx ?? 0) > ttl) fs.rmSync(f, { force: true }); }
      else if (expired.length) writeBox(f, { ...r.box, items: rest });
    } catch { /* 这一个下次再清(丢弃账没写成时原件还在) */ }
  }
  return dropped;
}

/** 丢弃账汇总(`--fp-report` 末尾那一行用)。读不到 ⇒ 零。 */
export function dropSummary(root) {
  let rows = [];
  try { rows = fs.readFileSync(path.join(root, DROP_LOG), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isObj); } catch { rows = []; }
  const n = rows.reduce((a, r) => a + (Number.isFinite(r.n) ? r.n : 1), 0);
  return { times: rows.length, hints: n, last: rows.length ? String(rows[rows.length - 1].ts || "") : "" };
}

// ── 自测(经 hook-stop-closure 的 --self-test 进 gate:self-test / gate:accept;也可单跑 `node scripts/lib/gate-hint-relay.mjs --self-test`)──
export function selfTest({ quiet = false } = {}) {
  let pass = 0, total = 0;
  const t = (name, got, want) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++;
    if (!ok || !quiet) console.log(`${ok ? "PASS" : "FAIL"}  只提示延后:${name}${ok ? "" : `  ← 期待 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`}`);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hint-relay-st-"));
  const T0 = Date.parse("2026-11-16T08:00:00Z"), H = 3600e3;
  const drops = () => { try { return fs.readFileSync(path.join(root, DROP_LOG), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  try {
    // 交互判定
    t("entrypoint 取最后一个", sessionEntrypoint([{ entrypoint: "cli" }, { type: "x" }, { entrypoint: "sdk-cli" }, {}]), "sdk-cli");
    t("转录 cli、环境没给 ⇒ 交互", interactiveSession([{ entrypoint: "cli" }], {}), true);
    t("转录 cli、环境也是 cli ⇒ 交互", interactiveSession([{ entrypoint: "cli" }], { CLAUDE_CODE_ENTRYPOINT: "cli" }), true);
    t("转录 sdk-cli ⇒ 不是交互(无头)", interactiveSession([{ entrypoint: "sdk-cli" }], {}), false);
    t("转录 sdk-ts ⇒ 不是交互", interactiveSession([{ entrypoint: "sdk-ts" }], {}), false);
    t("转录没有这个字段 ⇒ 不是交互(拿不准)", interactiveSession([{ type: "user" }], { CLAUDE_CODE_ENTRYPOINT: "cli" }), false);
    t("没有转录 ⇒ 不是交互", interactiveSession(null, {}), false);
    t("转录 cli 但环境是 sdk-cli ⇒ 不是交互(环境否决)", interactiveSession([{ entrypoint: "cli" }], { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), false);
    t("交互会话续成无头(最后一个是 sdk-cli)⇒ 不是交互", interactiveSession([{ entrypoint: "cli" }, { entrypoint: "sdk-cli" }], {}), false);
    // 读端在场
    t("没跑过读端 ⇒ receiverSeen 假", receiverSeen(root, "s1"), false);
    t("读端没在场 ⇒ 寄存抛错(调用方退回老通道)", (() => { try { stashHint(root, "s1", { text: "x" }, T0); return "没抛"; } catch { return "抛"; } })(), "抛");
    t("markReceiver 之后在场", [markReceiver(root, "s1", T0), receiverSeen(root, "s1")], [true, true]);
    t("另一个会话不因此在场", receiverSeen(root, "s2"), false);
    t("没有会话号 ⇒ 不在场、标记失败", [receiverSeen(root, ""), markReceiver(root, "", T0)], [false, false]);
    // 寄存 → 取走 → 只送一次
    stashHint(root, "s1", { text: "收尾闭环闸命中 1 项:\n  [B] 承诺未兑现", ids: ["B"] }, T0 + 1000);
    const a = takeHints(root, "s1", T0 + 2000);
    t("取到:带标题与全文", [a.n, a.text.includes("上一轮收尾闸的提示"), a.text.includes("[B] 承诺未兑现")], [1, true, true]);
    t("没 commit ⇒ 下次还在(中途出事宁可多送)", takeHints(root, "s1", T0 + 3000).n, 1);
    a.commit();
    t("commit 之后取不到(同一条不重复送)", takeHints(root, "s1", T0 + 4000).text, "");
    t("commit 之后读端仍算在场", receiverSeen(root, "s1"), true);
    t("别的会话取不到本会话的提示", (() => { stashHint(root, "s1", { text: "甲", ids: ["C"] }, T0 + 5000); markReceiver(root, "s2", T0); return takeHints(root, "s2", T0 + 6000).text; })(), "");
    // 多条、同文去重、输出期间又进新的一条
    stashHint(root, "s1", { text: "甲", ids: ["C"] }, T0 + 7000);
    stashHint(root, "s1", { text: "乙", ids: ["D"] }, T0 + 8000);
    const b = takeHints(root, "s1", T0 + 9000);
    t("三条里同文的只注入一份", [b.n, b.text.split("甲").length - 1, b.text.includes("乙")], [3, 1, true]);
    stashHint(root, "s1", { text: "丙", ids: ["F"] }, T0 + 9500);
    b.commit();
    t("commit 不吞掉输出期间新进的那条", takeHints(root, "s1", T0 + 9600).text.includes("丙"), true);
    takeHints(root, "s1", T0 + 9700).commit();
    // 寄存久了的标明多久以前;过期的不送、记账
    stashHint(root, "s1", { text: "隔夜", ids: ["G"] }, T0);
    t("寄存 20 小时 ⇒ 照送并标明", takeHints(root, "s1", T0 + 20 * H).text.includes("(20 小时前留下)"), true);
    const before = drops().length;
    const c = takeHints(root, "s1", T0 + HINT_TTL_MS + H);
    t("过期 ⇒ 不送", [c.text, c.n, c.expired], ["", 0, 1]);
    c.commit();
    const d1 = drops();
    t("过期 ⇒ 丢弃账多一行,带规则 id 与条数", [d1.length - before, d1[d1.length - 1]?.reason, d1[d1.length - 1]?.n, d1[d1.length - 1]?.ids], [1, "expired", 1, ["G"]]);
    t("过期件记账后不再留在信箱", takeHints(root, "s1", T0 + HINT_TTL_MS + 2 * H).expired, 0);
    // 会话换了:旧会话的信箱由别的会话清,记账
    markReceiver(root, "dead", T0); stashHint(root, "dead", { text: "没人来取", ids: ["H"] }, T0);
    t("没过期 ⇒ 别的会话不动它", [sweepExpired(root, "s1", T0 + H), fs.existsSync(boxFile(root, "dead"))], [0, true]);
    const n0 = drops().length;
    t("过期 ⇒ 别的会话清掉并返回条数", sweepExpired(root, "s1", T0 + HINT_TTL_MS + H), 1);
    t("清掉的记了账(原会话号在)", [drops().length - n0, drops().pop()?.sid, drops().pop()?.ids], [1, "dead", ["H"]]);
    t("清掉后信箱没了", fs.existsSync(boxFile(root, "dead")), false);
    markReceiver(root, "idle", T0);
    t("空信箱过期 ⇒ 直接删,不算丢弃", [sweepExpired(root, "s1", T0 + HINT_TTL_MS + H), fs.existsSync(boxFile(root, "idle"))], [0, false]);
    t("sweep 不动本会话自己的信箱", (() => { stashHint(root, "s1", { text: "自己的", ids: [] }, T0); sweepExpired(root, "s1", T0 + HINT_TTL_MS + H); return takeHints(root, "s1", T0 + HINT_TTL_MS + H).expired; })(), 1);
    takeHints(root, "s1", T0 + HINT_TTL_MS + H).commit();
    // 损坏
    fs.writeFileSync(boxFile(root, "s1"), "{not json");
    t("信箱损坏 ⇒ 不在场、寄存抛错", [receiverSeen(root, "s1"), (() => { try { stashHint(root, "s1", { text: "x" }, T0); return "没抛"; } catch { return "抛"; } })()], [false, "抛"]);
    const n1 = drops().length;
    const e = takeHints(root, "s1", T0);
    t("信箱损坏 ⇒ 没东西可送", e.text, "");
    e.commit();
    t("损坏 ⇒ commit 记一笔并重置成可用", [drops().length - n1, drops().pop()?.reason, receiverSeen(root, "s1")], [1, "corrupt", true]);
    // 丢弃账写不进去 ⇒ 原件留着
    {
      const r2 = fs.mkdtempSync(path.join(os.tmpdir(), "hint-relay-st2-"));
      try {
        markReceiver(r2, "z", T0); stashHint(r2, "z", { text: "记不上账", ids: ["B"] }, T0);
        fs.mkdirSync(path.join(r2, DROP_LOG), { recursive: true });   // 把丢弃账的位置占成目录 ⇒ 写不进去
        takeHints(r2, "z", T0 + HINT_TTL_MS + H).commit();
        t("丢弃账写不成 ⇒ 过期件还在信箱里(下次再记)", takeHints(r2, "z", T0 + HINT_TTL_MS + 2 * H).expired, 1);
        markReceiver(r2, "y", T0); stashHint(r2, "y", { text: "别人的", ids: [] }, T0);
        t("丢弃账写不成 ⇒ sweep 不删别的会话的过期信箱", [sweepExpired(r2, "z", T0 + HINT_TTL_MS + H), fs.existsSync(boxFile(r2, "y"))], [0, true]);
      } finally { try { fs.rmSync(r2, { recursive: true, force: true }); } catch { /* 空 */ } }
    }
    // 汇总
    const s = dropSummary(root);
    t("丢弃账汇总:次数与条数", [s.times, s.hints, !!s.last], [drops().length, drops().reduce((x, r) => x + (Number.isFinite(r.n) ? r.n : 1), 0), true]);
    t("没有丢弃账 ⇒ 汇总为零", dropSummary(path.join(root, "nope")), { times: 0, hints: 0, last: "" });
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 空 */ } }
  if (!quiet) console.log(`只提示延后自测 ${pass}/${total}`);
  return { pass, total };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--self-test")) {
  const r = selfTest();
  process.exit(r.pass === r.total ? 0 : 1);
}
