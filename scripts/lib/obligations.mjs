// obligations.mjs —— 义务账(批 298;287 设计 2.1、2.7「横切契约:义务记录与判不了」)
//
// 干什么:每条「还没清的事」记成一条独立的义务记录,不挂在批状态上。换批、`--arm --force`、同号重放都丢不掉;
//   判不了一律按开着算;模型手里没有任何 CLI 能把它标成「已清」。拒绝点在 batch-goal `--clear`(状态迁移那一步)。
//   本文件只有库,**没有 CLI 入口**(故意:设计 2.7「已清只由取证结果写入」)。
//
// ── 存放 ────────────────────────────────────────────────────────────────────────
//   `<git 公共目录的上一级>/.claude/.obligations/`(取法同 batch-goal candidateLedgerPath:
//   `git rev-parse --path-format=absolute --git-common-dir` 的父级 = 主 checkout)。各 worktree 共用一本。
//     ledger.jsonl —— 只追加台账,行级 hash 链(lib/ledger-chain.mjs)。**真相在这里**。
//     state.json   —— 物化视图(= 台账重放的结果),给读者快读。手改它 ⇒ 与台账重放不符 ⇒ 判「被改过」。
//     state.lock/  —— 写锁(mkdir 原子)。
//   取不到 git 公共目录 ⇒ { unknown },调用方按判不了处理(--clear 拒)。
//
// ── 记录格式(state.json 的 obligations[] 与台账行的 rec 字段同形)──────────────────────
//   { id:"OB-<时刻36进制>-<4hex>", type, status, owner:<会话号|null>, checkout:<建它的 checkout 绝对路径|null>,
//     origin:{batch, armedAt, baseCommit}|null   —— 产生时所在的批(类型求值器用它的基点)
//     batch:{batch, armedAt}|null                —— 现在归哪一批(换批 / --force / 并入时改);null = 未归属
//     trigger:{…} 触发事实, payload:{…} 类型专属, outlet:"出路一句话", createdAt, due:null|<批号>,
//     binding:{hash?}|null                       —— 绑定的版本;回件绑定的哈希对不上 ⇒ 作废重开
//     unknownStreak:<连续判不了次数>, lastResult:{at,result,by,why}|null,
//     settle:{debtId, expiry, table, at}|null,  rev:<本条修订号> }
//   state.json 外层:{ format:"obligations/v1", version:<台账数据行数>, ledgerHead:<末行 h>, obligations:[…按 id 排序] }
//   台账行:{ at, op, id, from, to, by, why?, rec } + 链字段 h。op ∈ create / transition / adopt / import /
//           settle / reopen / void-stale / withdraw。重放 = 每个 id 取最后一行的 rec。
//
// ── 状态机 ────────────────────────────────────────────────────────────────────────
//   open ──取证判不了──▶ unknown(连续计数 unknownStreak)──取证给出结论──▶ cleared / open
//   unknown 且 unknownStreak ≥ UNKNOWN_LIMIT(=1+MAX_RETRIES=3)──batch-goal --settle 写债表行──▶ settling
//   settling ──--clear 在 HEAD 已提交的债表里认到那一行──▶ settled(不再挡关账)
//   settled ──批号超过失效期的 --arm──▶ open(回到开着,并入那一批)
//   withdrawn:只给模型自己登记的两类(decision-adr / outcome-diary,即 --decision / --outcome)用,
//             对应既有 `--withdraw --reason`(批 256b BP-9);产生器建的义务不能撤。
//   挡关账的:open / unknown / settling。判不了按开着算(设计 2.7)。
//
// ── 并发(设计 2.7「状态文件并发」;拆批稿 0.8:原 CAS「近乎装饰」)──────────────────────
//   ① 一切写都在 state.lock 里做「读台账 → 验链 → 重放 → 改 → 追加台账 → 写 state.json」;
//      等锁超时(缺省 5 s,环境变量 OBLIGATIONS_LOCK_WAIT_MS 只能调等多久)⇒ 抛 LOCK-TIMEOUT,不覆盖。
//      陈锁(mtime 超过 30 s)可夺,这个阈值不开放调。
//   ② 跨长操作持有版本:调用方先 read() 拿 version,长操作后 mutate(fn, {expectVersion}) ⇒ 盘上版本变了就抛 CONFLICT。
//   ③ 回件绑定:recordEvidence 带 boundHash / seenRev;与记录当前的 binding.hash 或 rev 对不上 ⇒ 作废(void-stale),
//      记录回到 open,**不拿旧回件覆盖较新的状态**。
//
// ── 判「被改过」(拒清口径同 batch-goal checks-tampered)──────────────────────────────
//   台账链断(改行 / 插行 / 非尾删)⇒ ledger-broken;只有末行撕裂(写到一半崩了)⇒ torn,可 repair 截掉;
//   state.json 与「台账重放到它记的 ledgerHead 为止」不符 ⇒ tampered;state.json 落后于台账但前缀一致 ⇒ lag(写到一半崩了,自愈)。
//   CEILING(与 ledger-chain 同一天花板,不放大):能执行任意 node 代码的人能重算整条链、也能直接调本库的 recordEvidence;
//   整个目录删掉 / 台账整段尾删,本文件内部发现不了——batch-goal 在武装台账里记一个外部锚(oblHead)补一半。
//   本层担保的是:①没有 CLI 能把义务置为已清;②手改 state.json 被抓;③改台账行断链被抓;④三类保留类型
//   (decision-adr / outcome-diary / load-bearing-decision)不能经 recordEvidence 写结论,只由 batch-goal --clear 的求值器写。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ledgerAppend, stripH, readLastCompleteLine } from "./ledger-chain.mjs";

export const STORE_FORMAT = "obligations/v1";
export const MAX_RETRIES = 2;
export const UNKNOWN_LIMIT = 1 + MAX_RETRIES;
export const STATUSES = new Set(["open", "unknown", "cleared", "settling", "settled", "withdrawn"]);
export const BLOCKING = new Set(["open", "unknown", "settling"]);
/** 由 batch-goal --clear 的求值器结论的类型:recordEvidence 拒写(防「调库自助标已清」的最短路)。 */
export const RESERVED_TYPES = new Set(["decision-adr", "outcome-diary", "load-bearing-decision"]);
const LOCK_STALE_MS = 30_000;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t) { /* 退回忙等 */ } } };
const clone = (x) => JSON.parse(JSON.stringify(x));   // 记录全是 JSON 值(要进台账),JSON 往返即深拷贝
const canon = (list) => JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

export class ObligationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 义务账目录。git 可注入(自测)。取不到 ⇒ { unknown, why }。 */
export function storeDir(git = (args) => spawnSync("git", args, { encoding: "utf8", windowsHide: true, timeout: 30_000 })) {
  let r;
  try { r = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]); } catch (e) { return { unknown: true, why: `git 跑不起来(${e.message})` }; }
  const d = r && r.status === 0 ? String(r.stdout || "").trim() : "";
  if (!d) return { unknown: true, why: `取不到 git 公共目录(${String(r?.stderr || "").trim() || "非 git 仓?"})` };
  return { dir: path.join(path.dirname(d), ".claude", ".obligations") };
}

const files = (dir) => ({ ledger: path.join(dir, "ledger.jsonl"), state: path.join(dir, "state.json"), lock: path.join(dir, "state.lock") });

function lockWaitMs() {
  const v = Number(process.env.OBLIGATIONS_LOCK_WAIT_MS);
  return Number.isFinite(v) && v >= 0 && v <= 60_000 ? v : 5_000;
}

/** 锁持有者(令牌 / pid / 拿锁时刻),读不到 ⇒ null。 */
function lockOwner(lock) { try { return JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8")); } catch { return null; } }

/** 写锁(批 298 r1:锁目录里写持有者令牌;只释放自己的;拿锁满 30 s 视为陈锁可夺——没有续租,所以临界区里不做 git 一类慢活)。 */
function withStoreLock(dir, fn) {
  const { lock } = files(dir);
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + lockWaitMs();
  const token = crypto.randomBytes(8).toString("hex");
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; } }
      catch { /* 锁在竞态中消失 ⇒ 重试 */ }
      if (Date.now() >= deadline) {
        const o = lockOwner(lock);
        throw new ObligationError("LOCK-TIMEOUT", `义务账写锁被别的进程持有(${o ? `pid ${o.pid},${o.at} 拿到` : "持有者未知"};等了 ${lockWaitMs()} ms)——判不了,不覆盖。等那个进程结束后重跑;它若已经死了,拿锁满 ${LOCK_STALE_MS / 1000} s 后锁会被当成陈锁夺走`);
      }
      sleepMs(25);
    }
  }
  try { fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })); } catch { /* 记不了持有者:释放时按「不是我的」处理,留给陈锁回收 */ }
  const mine = () => lockOwner(lock)?.token === token;
  try { return fn(mine); }
  finally { try { if (mine()) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* 释放失败留给陈锁回收 */ } }
}

const genesisH = (enabled) => sha256("GENESIS" + enabled);
const TRANSIENT = /^(EPERM|EBUSY|EACCES|EAGAIN)$/;

/** 单趟读:验链 + 重放 + 与 state.json 比对(批 298 r1 FB-4:原实现每行留一份全量 canon,O(n²))。canon 只在 state.json 记的 ledgerHead 那一行算一次。 */
function readStoreOnce(dir, rf = fs.readFileSync) {
  const f = files(dir);
  let st = null, stBad = null;
  try { const t = rf(f.state, "utf8"); try { st = JSON.parse(t); } catch { stBad = t.trim() ? "state.json 解析不了" : "state.json 为空"; } }
  catch (e) { if (e.code !== "ENOENT") return { kind: TRANSIENT.test(String(e.code)) ? "transient" : "unreadable", why: `state.json 读不了(${e.code || e.message})`, dir }; }
  let raw;
  try { raw = rf(f.ledger, "utf8"); }
  catch (e) { if (e.code !== "ENOENT") return { kind: TRANSIENT.test(String(e.code)) ? "transient" : "unreadable", why: `台账读不了(${e.code || e.message})`, dir }; raw = ""; }
  const recs = new Map(); const heads = new Set();
  let version = 0, head = null, prevH = null, atState = null, n = 0;
  const torn = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n"); lines.pop();   // 末段:完整时是空串,撕裂时是残片
  for (const line of lines) {
    n++;
    if (!line.trim()) return { kind: "ledger-broken", why: `台账第 ${n} 行是空行`, dir };
    const s = stripH(line);
    if (!s) return { kind: "ledger-broken", why: `台账第 ${n} 行没有链字段`, dir };
    let o; try { o = JSON.parse(line); } catch { return { kind: "ledger-broken", why: `台账第 ${n} 行不是 JSON`, dir }; }
    if (prevH === null) {
      if (!(o.genesis === "v1" && typeof o.enabled === "string" && s.h === genesisH(o.enabled))) return { kind: "ledger-broken", why: "台账首行不是合法 genesis", dir };
    } else {
      if (o.genesis) return { kind: "ledger-broken", why: `台账第 ${n} 行重复 genesis`, dir };
      if (sha256(Buffer.concat([Buffer.from(prevH, "utf8"), Buffer.from(s.body, "utf8")])) !== s.h) return { kind: "ledger-broken", why: `台账 hash 链在第 ${n} 行断了——有人改过台账行`, dir };
      if (o.rec && typeof o.rec === "object" && typeof o.rec.id === "string") recs.set(o.rec.id, o.rec);
      version++;
    }
    prevH = s.h; head = s.h; heads.add(s.h);
    if (st && st.ledgerHead === s.h) atState = { version, canon: canon(recs.values()) };
  }
  const obligations = [...recs.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const base = { dir, obligations, version, ledgerHead: head, heads };
  if (torn) return { ...base, kind: "torn", why: "台账末行撕裂(写到一半中断,或别的进程正写到一半)——跑 batch-goal --repair-obligations 截掉残片" };
  if (!lines.length) {
    if (stBad || (st && Array.isArray(st.obligations) && st.obligations.length)) return { ...base, kind: "tampered", why: "台账不存在,state.json 却有内容(或坏了)——状态不能脱离台账存在" };
    return { ...base, kind: "empty" };
  }
  if (stBad) return { ...base, kind: "tampered", why: stBad };
  if (!st) return { ...base, kind: "lag", why: "state.json 缺(以台账为准,下次写入时重建)" };
  if (st.format !== STORE_FORMAT || !Array.isArray(st.obligations)) return { ...base, kind: "tampered", why: "state.json 格式不对" };
  if (atState && atState.version === st.version && atState.canon === canon(st.obligations)) {
    return st.ledgerHead === head ? { ...base, kind: "ok" } : { ...base, kind: "lag", why: `state.json 停在第 ${st.version} 行,台账已到第 ${version} 行(写到一半中断;以台账为准)` };
  }
  return { ...base, kind: "tampered", why: "state.json 与台账重放的结果不一致——有人手改过状态文件" };
}

/** 读义务账(不加锁、不写盘)。kind:
 *   ok / empty(还没有台账)/ lag(state.json 落后但前缀一致;以台账为准)/
 *   tampered(state.json 与台账不符)/ ledger-broken / torn(末行撕裂)/ unreadable(读错误,不归 tampered)。
 *   只有 ok / empty / lag 给出可信的 obligations。锁外读到 EPERM / EBUSY / 撕裂 ⇒ 短重试几次(批 298 r1 FB-6)。 */
export function readStore(dir, tries = 5, rf = fs.readFileSync) {   // rf 可注入(自测造 EBUSY)
  let s;
  for (let i = 0; i < tries; i++) {
    s = readStoreOnce(dir, rf);
    if (s.kind !== "transient" && s.kind !== "torn") return s;
    if (i < tries - 1) sleepMs(30 + 30 * i);
  }
  return s.kind === "transient" ? { ...s, kind: "unreadable" } : s;
}

export const TRUSTED = new Set(["ok", "empty", "lag"]);

function writeState(dir, version, head, recs) {
  const f = files(dir);
  const tmp = `${f.state}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const body = JSON.stringify({ format: STORE_FORMAT, version, ledgerHead: head, obligations: [...recs].sort((a, b) => (a.id < b.id ? -1 : 1)) }, null, 2);
  try {
    fs.writeFileSync(tmp, body, "utf8");
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, f.state); break; }
      catch (e) { if (i >= 20 || !/EPERM|EBUSY|EACCES/.test(String(e.code))) throw e; sleepMs(15); }   // Windows:读者占着目标时 rename 偶发 EPERM
    }
  } finally { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 残骸不阻断 */ } }
}

let seq = 0;
export function newId() { return `OB-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}${(seq++).toString(36)}`; }

/** 在锁里改义务账。fn(draft) 里用 draft.get / draft.list / draft.put(rec, {op, from, by, why})。
 *  opts.expectVersion:调用方先 read 拿到的版本;盘上已变 ⇒ 抛 CONFLICT。返回 { version, changed:[id…], result:fn 的返回值 }。 */
export function mutateStore(dir, fn, opts = {}) {
  return withStoreLock(dir, (lockIsMine) => {
    const s = readStore(dir, 1);
    if (!TRUSTED.has(s.kind)) throw new ObligationError(s.kind.toUpperCase(), `义务账不可信(${s.kind}):${s.why}`);
    if (opts.expectVersion !== undefined && opts.expectVersion !== s.version) throw new ObligationError("CONFLICT", `义务账并发冲突:期待版本 ${opts.expectVersion},盘上已是 ${s.version}——读后有别的进程写过,重读再来`);
    const recs = new Map(s.obligations.map((r) => [r.id, r]));
    const pending = [];
    const draft = {
      get: (id) => (recs.has(id) ? clone(recs.get(id)) : null),
      list: () => [...recs.values()].map(clone),
      put: (rec, meta = {}) => {
        if (!rec || typeof rec.id !== "string") throw new Error("put:记录缺 id");
        if (!STATUSES.has(rec.status)) throw new Error(`put:非法状态 ${rec.status}`);
        const prev = recs.get(rec.id);
        const next = { ...rec, rev: (prev?.rev || 0) + 1 };
        recs.set(rec.id, next);
        pending.push({ at: new Date().toISOString(), op: meta.op || "transition", id: rec.id, from: prev ? prev.status : null, to: next.status, by: meta.by || "?", ...(meta.why ? { why: String(meta.why).slice(0, 300) } : {}), rec: next });
        return next;
      },
    };
    const result = fn(draft);
    let head = s.ledgerHead, version = s.version;
    const f = files(dir);
    // 落盘逐步核锁(批 298 r1 codex §4 / r2 ④):每追加一行台账前、写 state 前,都核「锁还是我的、台账末行是我上一笔」。
    //   第一行之前失锁 ⇒ CONFLICT(什么都没写);写到一半失锁 ⇒ PARTIAL(报写到第几行、state 未同步,--repair-obligations 可修),立即停。
    //   错误对象带 phase(none / ledger / state)与 appended(本次已追加行数),调用方据此分阶段如实报。
    const stepOk = (expectHead) => {
      if (!lockIsMine()) return "义务账写锁已不是本进程的(临界区太久被当陈锁夺走?)";
      const tail = readLastCompleteLine(f.ledger);
      if ((tail ? stripH(tail)?.h ?? null : null) !== expectHead) return "义务账台账末行被别人推进了";
      return null;
    };
    const fail = (why, phase, appended, cause) => {
      // 批 298 r3(codex ②):恢复指引按「链断没断」分开——断了不能自动修(repair 会把被插入的历史洗成真相),只有 state 落后才推荐 repair
      const broken = !(appended === 0 && phase !== "state") && readStore(dir, 1).kind === "ledger-broken";
      const e = appended === 0 && phase !== "state"
        ? new ObligationError("CONFLICT", `${why}——义务账一行没写,重跑`)
        : broken
          ? new ObligationError("PARTIAL", `${why}——本次已追加 ${appended} 行后台账链断了(有别的写入者插进来),不能自动修复:停下告诉用户`)
          : new ObligationError("PARTIAL", `${why}——台账已追加到第 ${version} 行(本次 ${appended} 行)、state 未同步;跑 batch-goal --repair-obligations 按台账重建`);
      e.phase = phase; e.appended = appended; e.chainBroken = broken; if (cause) e.cause = cause;
      return e;
    };
    let appended = 0;
    for (const row of pending) {
      if (opts.onStep) opts.onStep({ phase: "ledger", appended });   // 自测缝:模拟「写到一半失锁」
      const bad = stepOk(head);
      if (bad) throw fail(bad, "ledger", appended);
      try { head = ledgerAppend(f.ledger, row); } catch (err) { throw fail(`台账追加失败(${err.code || err.message})`, "ledger", appended, err); }
      version++; appended++;
    }
    if (pending.length || s.kind === "lag") {
      if (opts.onStep) opts.onStep({ phase: "state", appended });
      const bad = pending.length ? stepOk(head) : null;
      if (bad) throw fail(bad, "state", appended);
      try { writeState(dir, version, head, recs.values()); } catch (err) { throw fail(`state.json 写失败(${err.code || err.message})`, "state", appended, err); }
    }
    return { version, head, changed: pending.map((p) => p.id), result };
  });
}

/** 修复:①末行撕裂 ⇒ 截掉残片;②state.json 被改 / 缺 / 落后 ⇒ 按台账重建。链断不修(那要人裁)。返回说明串数组。 */
export function repairStore(dir) {
  return withStoreLock(dir, () => {
    const f = files(dir); const notes = [];
    let s = readStore(dir);
    if (s.kind === "ledger-broken" || s.kind === "unreadable") throw new ObligationError(s.kind.toUpperCase(), `${s.why}——不自动修(会把被改写的历史洗成真相)。停下告诉用户`);
    if (s.kind === "torn") {
      const raw = fs.readFileSync(f.ledger, "utf8");
      const cut = raw.lastIndexOf("\n") + 1;
      fs.writeFileSync(f.ledger + `.torn-${Date.now().toString(36)}.bak`, raw.slice(cut));
      fs.truncateSync(f.ledger, Buffer.byteLength(raw.slice(0, cut), "utf8"));
      notes.push(`截掉台账末尾 ${Buffer.byteLength(raw.slice(cut), "utf8")} 字节撕裂残片(原样备份在 ledger.jsonl.torn-*.bak)`);
      s = readStore(dir);
    }
    if (s.kind === "tampered" || s.kind === "lag" || s.kind === "torn") {
      try { fs.copyFileSync(f.state, f.state + `.replaced-${Date.now().toString(36)}.bak`); } catch { /* 没有旧 state 就不备份 */ }
      writeState(dir, s.version, s.ledgerHead, s.obligations);
      notes.push(`state.json 按台账重建(${s.version} 行,${s.obligations.length} 条义务;旧文件备份为 state.json.replaced-*.bak)`);
    }
    if (!notes.length) notes.push("义务账完好,无需修复");
    return notes;
  });
}

/** 建一条义务。返回新记录。 */
export function createObligation(draft, spec, by) {
  if (!spec || typeof spec.type !== "string" || !spec.type) throw new Error("createObligation:缺 type");
  const rec = {
    id: spec.id || newId(), type: spec.type, status: "open",
    owner: typeof spec.owner === "string" && spec.owner ? spec.owner : null,
    checkout: spec.checkout || null,
    origin: spec.origin || null, batch: spec.batch || null,
    trigger: spec.trigger || {}, payload: spec.payload || {},
    outlet: String(spec.outlet || ""), createdAt: new Date().toISOString(), due: spec.due ?? null,
    binding: spec.binding || null, unknownStreak: 0, lastResult: null, settle: null,
    config: spec.config || null,   // 批 298 r1:求值配置快照(配置冻结);产生器建的通用类型可以不带
  };
  return draft.put(rec, { op: spec.op || "create", by: by || "?", why: spec.why });
}

/** 产生器回报取证结果。result ∈ cleared / open / unknown。
 *  ev:{ producer, result, why?, boundHash?, seenRev? }。返回 { applied, voided?, rec }。
 *  保留类型(RESERVED_TYPES)不收:它们的结论只由 batch-goal --clear 的求值器经 applyEvaluation 写。 */
export function recordEvidence(draft, id, ev) {
  const rec = draft.get(id);
  if (!rec) throw new Error(`recordEvidence:没有义务 ${id}`);
  if (RESERVED_TYPES.has(rec.type)) throw new ObligationError("RESERVED", `类型 ${rec.type} 的结论只由 batch-goal --clear 求值,不收外部回报`);
  if (!ev || typeof ev.producer !== "string" || !ev.producer.trim()) throw new Error("recordEvidence:缺 producer");
  // 批 298 r1:义务带绑定 ⇒ 回报必须给出绑定值,缺省即拒(不让「不报哈希」绕过作废检查)
  if (rec.binding?.hash && (ev.boundHash === undefined || ev.boundHash === null)) throw new ObligationError("BINDING-REQUIRED", `义务 ${id} 绑定了 ${String(rec.binding.hash).slice(0, 16)},回报必须带 boundHash`);
  if (rec.binding?.rev !== undefined && ev.seenRev === undefined) throw new ObligationError("BINDING-REQUIRED", `义务 ${id} 要求回报带 seenRev`);
  return applyEvaluation(draft, rec, ev, `producer:${ev.producer}`);
}

/** 内部共用:把一次取证结论落到记录上(含作废旧回件)。batch-goal 的求值器也走这里。 */
export function applyEvaluation(draft, rec, ev, by) {
  if (!["cleared", "open", "unknown"].includes(ev.result)) throw new Error(`取证结论只能是 cleared / open / unknown(得到 ${ev.result})`);
  const at = new Date().toISOString();
  const stale = (rec.binding && rec.binding.hash && ev.boundHash !== undefined && ev.boundHash !== rec.binding.hash) ||
    (ev.seenRev !== undefined && ev.seenRev !== rec.rev);
  if (stale) {
    if (rec.status === "cleared" || rec.status === "withdrawn") return { applied: false, voided: true, rec };
    const next = draft.put({ ...rec, status: "open", unknownStreak: 0, lastResult: { at, result: "void-stale", by, why: `回件绑定 ${String(ev.boundHash ?? `rev ${ev.seenRev}`).slice(0, 16)} 与当前 ${String(rec.binding?.hash ?? `rev ${rec.rev}`).slice(0, 16)} 不符,作废重开` } }, { op: "void-stale", by });
    return { applied: false, voided: true, rec: next };
  }
  if (rec.status === "cleared" || rec.status === "withdrawn") return { applied: false, rec };
  // settling / settled 只认「已清」;没清的结论不改它的转欠账状态(settling 由 --clear 认提交行另行推进)
  if ((rec.status === "settled" || rec.status === "settling") && ev.result !== "cleared") return { applied: false, rec };
  const streak = ev.result === "unknown" ? (rec.unknownStreak || 0) + 1 : 0;
  if (rec.status === ev.result && ev.result !== "unknown" && (rec.unknownStreak || 0) === streak) return { applied: false, rec };
  const next = draft.put({ ...rec, status: ev.result, unknownStreak: streak, lastResult: { at, result: ev.result, by, why: ev.why ? String(ev.why).slice(0, 300) : undefined } }, { op: "transition", by, why: ev.why });
  return { applied: true, rec: next };
}

/** 能不能转欠账:判不了且连续次数够了。 */
export const settleEligible = (rec) => rec && (rec.status === "unknown" && (rec.unknownStreak || 0) >= UNKNOWN_LIMIT || rec.status === "settling");

/** 批号的数字部分(292b ⇒ 292);取不到 ⇒ NaN。失效期 = 它 + 3。 */
export const batchNumber = (b) => { const m = String(b ?? "").trim().match(/^0*(\d+)/); return m ? Number(m[1]) : NaN; };

const cellSafe = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "/").replace(/`/g, "'").trim();

/** 债表一行(6 列,与 docs/gate-debts.md 在账表表头同序:# / 欠账 / 登记批 / 失效期 / 复核来源 / 到期动作)。 */
export function settleRow(rec, { debtId, batch, expiry }) {
  const step = rec.lastResult?.why ? cellSafe(rec.lastResult.why).slice(0, 160) : "取证判不了";
  const bind = rec.binding?.hash ? `,绑定 ${cellSafe(rec.binding.hash).slice(0, 16)}` : (rec.origin?.baseCommit ? `,基点 ${String(rec.origin.baseCommit).slice(0, 10)}` : "");
  return `| ${debtId} | **义务转欠账(batch-goal --settle 自动写)**:义务 \`${rec.id}\`(${cellSafe(rec.type)},来自批 ${cellSafe(rec.origin?.batch ?? "?")}${bind})连续 ${rec.unknownStreak || 0} 次判不了,卡在:${step} | ${cellSafe(batch)} | **≤${expiry}** | 编排脚本自动转(287 设计 2.7,不需人批) | 到期未结 ⇒ 开批时回到开着并入那一批;出路:${cellSafe(rec.outlet || "修好取证条件后重跑 --clear")} |`;
}

/** 债表里已用过的最大 D 号(全表任意节)。 */
export function maxDebtId(text) {
  let max = 0;
  for (const m of String(text || "").matchAll(/^\|\s*D(\d+)[a-z]?\s*\|/gm)) max = Math.max(max, Number(m[1]));
  return max;
}

/** 把一行插进「## 在账欠账」节表格末尾;没有该节 ⇒ 文末新建一节(带表头)。返回新正文。纯函数。 */
export function insertDebtRow(text, row) {
  const src = String(text || "");
  const eol = /\r\n/.test(src) ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const h = lines.findIndex((l) => /^##\s*在账欠账\s*$/.test(l));
  if (h >= 0) {
    let last = -1;
    for (let i = h + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (/^\|/.test(lines[i])) last = i;
    if (last >= 0) { lines.splice(last + 1, 0, row); return lines.join(eol); }
  }
  const head = ["", "## 在账欠账", "", "| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |", "|---|---|---|---|---|---|", row, ""];
  return src.replace(/\s*$/, "") + eol + head.join(eol);
}

/** HEAD 版债表里有没有这条义务的转欠账行(D 号、义务 id、失效期三样都在同一行)。 */
export function debtRowCommitted(headText, rec) {
  const s = rec?.settle; if (!s) return false;
  const re = new RegExp(`^\\|\\s*${s.debtId}\\s*\\|`);
  return String(headText || "").split(/\r?\n/).some((l) => re.test(l) && l.includes(rec.id) && new RegExp(`≤\\s*${s.expiry}(?!\\d)`).test(l));
}

/** 摘要(给 --status / --context)。recs = 与本批相关的记录。 */
export function summarize(recs) {
  const n = (st) => recs.filter((r) => r.status === st).length;
  return { open: n("open"), unknown: n("unknown"), settling: n("settling"), settled: n("settled"), blocking: recs.filter((r) => BLOCKING.has(r.status)).length };
}

export const digest = (x) => sha256(typeof x === "string" ? x : JSON.stringify(x));
