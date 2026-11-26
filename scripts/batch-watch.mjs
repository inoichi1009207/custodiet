#!/usr/bin/env node
// batch-watch.mjs —— 看守:执行会话空转时叫停的纯判定(批 307)
//
// 干什么:吃 `claude -p --output-format stream-json` 的事件(一行一条,已解析),认出「同一个工具调用报同样的错,连着出现」。
//   发车脚本(batch-run.mjs)在逐行读执行会话输出的那一处把事件喂进来,命中就杀掉执行会话、停下写交接。
//   本文件不起子进程、不碰网络、不读写批状态;看守只管停,不判对错。
//
// 判据(只有这一条;轮数、单次花费、整批花费、总时长四条「到线」由发车脚本自己管,这里不重做):
//   - 「同一个调用」= 工具名相同 + 入参(JSON 序列化)逐字相同;入参顶层的 `description`(给人看的说明)不参与比较;
//   - 「同样的错」= 结果 is_error 为真,且错误文字归一后(空白折成一个空格)全文相同;展示时只取前 500 字;
//   - 「连着」= 严格连着:同一条线上先后到达的工具结果,连续 N 个都是它;中间夹了任何别的结果(成功的,或别的错)就从头数。
//     一条线 = 主会话,或某一个子代理(事件带 parent_tool_use_id 的按它分线,互不打断、互不合并)。
//   - 找不到对应 tool_use 的结果:忽略,不打断也不计数。
//
// N = 3 怎么来的:拿另一个项目的 15 份真实无头执行日志回放——共 1293 次工具调用、86 个报错的结果,
//   同一个调用报同样的错从没连着出现过第二次(最长连串是 1)。取 3,给「瞬时错误原样重试一次」留一格余量。
//
// 明确不做的两样:
//   ① 不按签名累计(同一个调用隔三岔五失败、累计到 N 次就停):有的机器上有钩子会让不带 timeout 的 Bash 调用
//      被权限检查拒一次、带上再发就过,累计口径会把这种正常节奏判成空转。
//   ② 不造定时器、不轮询日志文件:事件驱动,挂在发车脚本本来就有的逐行读取上;没有输出的挂死由整批截止时间兜住。
// 代价不对称:该过的批被误停更贵(人要多说一句话)⇒ 拿不准往「不停」那边偏;漏掉的空转有轮数 / 花费 / 截止时间兜底。
//
// 用法:
//   import { createWatch, SAME_ERROR_LIMIT } from "./batch-watch.mjs"
//     createWatch({ sameErrorLimit }) → { feed(event) → 命中 | null, stats() → { calls, errors, longestRun, longestTool } }
//     命中只返回一次:{ code:"same-error", tool, input(入参 JSON 前 300 字), error(归一后的错误文字), count, lane };sameErrorLimit 0 = 关掉。
//   node --no-warnings scripts/batch-watch.mjs --replay <日志文件…> [--limit N]
//     逐份回放(每份一行:文件名、调用数、报错数、最长连串、会不会停),只打计数与工具名,不打日志原文;退出码 0(量具,不是闸)。
//   node --no-warnings scripts/batch-watch.mjs --self-test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
export const SAME_ERROR_LIMIT = 3;
const INPUT_MAX = 300, ERROR_MAX = 500;
export const MAIN_LANE = "main";

/** 工具结果的错误文字归一:字符串原样;数组取各块的 text 拼起来;空白折成一个空格、去首尾、取前 500 字。纯函数。 */
export function normError(content) {
  return normErrorFull(content).slice(0, ERROR_MAX);
}
/** 同上但不截断:判「同样的错」比的是这份全文。只比前 500 字的话,前面是一样的样板、后面才不同的几个错
 *  会被当成同一个错而误停(批 307 codex 第 1 条);截断只用于展示。纯函数。 */
export function normErrorFull(content) {
  let s;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) s = content.map((c) => (typeof c === "string" ? c : c && typeof c.text === "string" ? c.text : "")).join(" ");
  else if (content == null) s = "";
  else { try { s = JSON.stringify(content); } catch { s = String(content); } }
  return s.replace(/\s+/g, " ").trim();
}
function inputJson(x) {
  try { const s = JSON.stringify(x === undefined ? null : x); return s === undefined ? "null" : s; } catch { return String(x); }
}
/** 判「同一个调用」用的入参:顶层的 `description` 不算。它是给人看的说明,模型每次重试都会改写
 *  (真跑实测 2026-11-26:同一条命令原样连试 8 次、8 次同样的错,说明依次写成「attempt 1」…「attempt 8」,
 *  逐字比入参时一次都没连上)。展示用的 input 仍是原样的 JSON。 */
function identityJson(x) {
  if (x && typeof x === "object" && !Array.isArray(x) && Object.prototype.hasOwnProperty.call(x, "description")) {
    const { description: _d, ...rest } = x;
    return inputJson(rest);
  }
  return inputJson(x);
}
const laneOf = (evt) => (typeof evt.parent_tool_use_id === "string" && evt.parent_tool_use_id ? evt.parent_tool_use_id : null);

/** 看守实例。sameErrorLimit:非负整数,缺省 3;0 ⇒ 永远不命中(只记统计)。 */
export function createWatch({ sameErrorLimit = SAME_ERROR_LIMIT } = {}) {
  if (!Number.isInteger(sameErrorLimit) || sameErrorLimit < 0) throw new TypeError(`sameErrorLimit 要是非负整数(得到 ${sameErrorLimit})`);
  const limit = sameErrorLimit;
  const uses = new Map();    // tool_use id → { name, input, lane }
  const lanes = new Map();   // 线 → { key, count }
  let fired = false, calls = 0, errors = 0, longestRun = 0, longestTool = null;

  function onResult(b, evtLane) {
    if (typeof b.tool_use_id !== "string") return null;
    const u = uses.get(b.tool_use_id);
    if (!u) return null;                         // 找不到对应 tool_use:不打断也不计数
    uses.delete(b.tool_use_id);
    const lane = evtLane || u.lane;
    let st = lanes.get(lane);
    if (!st) { st = { key: null, count: 0 }; lanes.set(lane, st); }
    if (b.is_error !== true) { st.key = null; st.count = 0; return null; }
    errors++;
    const full = normErrorFull(b.content);
    const error = full.slice(0, ERROR_MAX);
    const key = JSON.stringify([u.name, u.ident, full]);
    if (st.key === key) st.count++;
    else { st.key = key; st.count = 1; }
    if (st.count > longestRun) { longestRun = st.count; longestTool = u.name; }
    if (fired || limit === 0 || st.count < limit) return null;
    fired = true;
    return { code: "same-error", tool: u.name, input: u.input.slice(0, INPUT_MAX), error, count: st.count, lane };
  }

  function feed(evt) {
    if (!evt || typeof evt !== "object" || !evt.message || !Array.isArray(evt.message.content)) return null;
    const lane = laneOf(evt);
    let hit = null;
    if (evt.type === "assistant") {
      for (const b of evt.message.content) {
        if (!b || b.type !== "tool_use" || typeof b.id !== "string" || uses.has(b.id)) continue;
        calls++;
        uses.set(b.id, { name: String(b.name ?? ""), input: inputJson(b.input), ident: identityJson(b.input), lane: lane || MAIN_LANE });
      }
    } else if (evt.type === "user") {
      for (const b of evt.message.content) {
        if (!b || b.type !== "tool_result") continue;
        const h = onResult(b, lane);
        if (h && !hit) hit = h;
      }
    }
    return hit;
  }

  return { feed, stats: () => ({ calls, errors, longestRun, longestTool }) };
}

// ── 回放(量具)────────────────────────────────────────────────────────────────────────
/** 解析 `--replay <文件…> [--limit N]`。用法错 ⇒ 抛。纯函数。 */
export function parseReplayArgs(argv) {
  const files = [];
  let limit = SAME_ERROR_LIMIT, seenLimit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replay") continue;
    if (a === "--limit") {
      const v = argv[i + 1];
      if (seenLimit) throw new Error("--limit 给了两次");
      if (v === undefined || !/^\d+$/.test(v)) throw new Error(`--limit 要跟一个非负整数(得到「${v ?? ""}」)`);
      limit = Number(v); seenLimit = true; i++; continue;
    }
    if (/^--/.test(a)) throw new Error(`未知参数 ${a}`);
    files.push(a);
  }
  if (!files.length) throw new Error("用法: --replay <日志文件…> [--limit N]");
  return { files, limit };
}

/** 逐份回放,返回要打印的行。只出计数与工具名,不出日志里的任何原文(日志可能是私有的)。 */
export function replayFiles(files, { limit = SAME_ERROR_LIMIT } = {}) {
  const out = [];
  let n = 0, stopped = 0, unreadable = 0, longest = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); }
    catch (e) { unreadable++; out.push(`${path.basename(f)}  读不了(${e.code || "错误"})`); continue; }
    const w = createWatch({ sameErrorLimit: limit });
    let hit = null;
    for (const raw of text.split(/\r?\n/)) {
      const s = raw.trim();
      if (!s.startsWith("{")) continue;
      let o;
      try { o = JSON.parse(s); } catch { continue; }
      const h = w.feed(o);
      if (h && !hit) hit = h;
    }
    const st = w.stats();
    n++;
    if (hit) stopped++;
    longest = Math.max(longest, st.longestRun);
    out.push(`${path.basename(f)}  调用 ${st.calls}  报错 ${st.errors}  最长连串 ${st.longestRun}${st.longestTool ? `(${st.longestTool})` : ""}  会停 ${hit ? `是(${hit.tool},连着 ${hit.count} 次)` : "否"}`);
  }
  if (unreadable) out.push(`读不了 ${unreadable} 份`);
  out.push(`回放 ${n} 份:会停 ${stopped} 份(阈值 ${limit});最长连串 ${longest}`);
  return out;
}

// ── 自测 ──────────────────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      得到 ${JSON.stringify(got)}\n      期待 ${JSON.stringify(want)}`}`);
  };
  let seq = 0;
  const use = (name, input, lane = null) => { const id = `tu_${++seq}`; return { id, evt: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: lane } }; };
  const res = (id, isError, content, lane = null) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] }, parent_tool_use_id: lane });
  /** 按剧本喂:每步 [工具名, 入参, 是否报错, 结果文字, 线];返回每步的命中(null 或命中的 code+count+lane)。 */
  const play = (w, steps) => steps.map(([name, input, isErr, text, lane = null]) => {
    const u = use(name, input, lane);
    w.feed(u.evt);
    const h = w.feed(res(u.id, isErr, text, lane));
    return h ? `${h.code}:${h.count}:${h.lane}` : null;
  });
  const E = ["Bash", { command: "false" }, true, "Exit code 1"];
  const S = ["Bash", { command: "true" }, false, "ok"];

  { const w = createWatch();
    const hits = [];
    for (let i = 0; i < 4; i++) { const v = use("Bash", { command: "false" }); w.feed(v.evt); hits.push(w.feed(res(v.id, true, "Exit code 1"))); }
    t("连着 3 次同一调用同样的错 ⇒ 第 3 次命中,第 4 次不再报", hits.map((h) => (h ? h.code : null)), [null, null, "same-error", null]);
    t("命中内容:工具名、入参 JSON、错误、次数、线", (({ tool, input, error, count, lane }) => ({ tool, input, error, count, lane }))(hits[2]),
      { tool: "Bash", input: "{\"command\":\"false\"}", error: "Exit code 1", count: 3, lane: "main" });
    const w2 = createWatch();
    const big = [];
    for (let i = 0; i < 3; i++) { const v = use("Bash", { command: "x".repeat(400) }); w2.feed(v.evt); big.push(w2.feed(res(v.id, true, "e".repeat(800)))); }
    t("命中内容:入参截到 300 字,错误截到 500 字", [big[2]?.input.length, big[2]?.error.length], [300, 500]); }
  t("中间夹一次成功 ⇒ 从头数,不命中", play(createWatch(), [E, E, S, E, E]), [null, null, null, null, null]);
  t("换了入参 ⇒ 不算同一个调用,不命中", play(createWatch(), [E, E, ["Bash", { command: "false", timeout: 5000 }, true, "Exit code 1"], E]), [null, null, null, null]);
  t("只有顶层 description 不同(模型每次重试都改写说明)⇒ 仍是同一个调用,第 3 次命中;展示的入参是原样的",
    (() => { const w = createWatch(); const hs = [1, 2, 3].map((i) => { const v = use("Bash", { command: "false", description: `attempt ${i}`, timeout: 5000 }); w.feed(v.evt); return w.feed(res(v.id, true, "Exit code 1")); }); return [hs[0], hs[1], hs[2]?.count, hs[2]?.input]; })(),
    [null, null, 3, "{\"command\":\"false\",\"description\":\"attempt 3\",\"timeout\":5000}"]);
  t("description 之外的入参不同、或嵌套在里层的 description 不同 ⇒ 不算同一个调用",
    [play(createWatch(), [["Bash", { command: "false", description: "a" }, true, "Exit code 1"], ["Bash", { command: "false ", description: "a" }, true, "Exit code 1"], ["Bash", { command: "false", description: "b" }, true, "Exit code 1"]]),
      play(createWatch(), [1, 2, 3].map((i) => ["Agent", { prompt: "p", opts: { description: `d${i}` } }, true, "boom"]))],
    [[null, null, null], [null, null, null]]);
  t("错误文字前 500 字相同、后面才不同 ⇒ 不算同样的错,不命中;全文相同的长错误照样命中",
    [play(createWatch(), ["A", "B", "C"].map((x) => ["Bash", { command: "false" }, true, "x".repeat(500) + x])),
      play(createWatch(), [1, 2, 3].map(() => ["Bash", { command: "false" }, true, "x".repeat(900)]))],
    [[null, null, null], [null, null, "same-error:3:main"]]);
  t("换了错误文字 ⇒ 不算同样的错,不命中", play(createWatch(), [E, E, ["Bash", { command: "false" }, true, "Exit code 2"], E]), [null, null, null, null]);
  t("换了工具名、入参同 ⇒ 不命中", play(createWatch(), [E, E, ["Grep", { command: "false" }, true, "Exit code 1"]]), [null, null, null]);
  t("甲乙甲乙轮流失败 ⇒ 不算连着(已登记的漏放)", play(createWatch(), [E, ["Read", { file_path: "a" }, true, "nope"], E, ["Read", { file_path: "a" }, true, "nope"], E, ["Read", { file_path: "a" }, true, "nope"]]), [null, null, null, null, null, null]);
  { const L = "toolu_parent_1";
    const sub = (s) => [...s.slice(0, 4), L];
    t("两条线各自计数:主会话与子代理交替报同样的错,互不打断 ⇒ 主会话第 3 次命中、线 = main",
      play(createWatch(), [E, sub(E), E, sub(S), E]), [null, null, null, null, "same-error:3:main"]);
    t("两条线互不合并:主会话 2 次 + 子代理 1 次 ⇒ 不命中", play(createWatch(), [E, E, sub(E)]), [null, null, null]);
    t("子代理线自己连着 3 次 ⇒ 命中,线 = 它的 parent_tool_use_id", play(createWatch(), [sub(E), S, sub(E), sub(E)]), [null, null, null, `same-error:3:${L}`]); }
  { const w = createWatch();
    const hits = [];
    const one = () => { const v = use("Bash", { command: "false" }); w.feed(v.evt); return w.feed(res(v.id, true, "Exit code 1")); };
    hits.push(one(), one());
    hits.push(w.feed(res("tu_nobody", false, "ok")), w.feed(res("tu_nobody2", true, "Exit code 1")));
    hits.push(one());
    t("找不到 tool_use 的结果被忽略:成功的不打断、报错的不计数", hits.map((h) => (h ? h.count : null)), [null, null, null, null, 3]);
    const w2 = createWatch();
    t("只有孤儿结果 ⇒ 永不命中、不算报错", [w2.feed(res("x1", true, "e")), w2.feed(res("x2", true, "e")), w2.feed(res("x3", true, "e")), w2.stats().errors], [null, null, null, 0]); }
  t("sameErrorLimit 可调:2 ⇒ 第 2 次命中", play(createWatch({ sameErrorLimit: 2 }), [E, E, E]), [null, "same-error:2:main", null]);
  { const w = createWatch({ sameErrorLimit: 0 });
    const hits = play(w, Array.from({ length: 10 }, () => E));
    t("sameErrorLimit 0 ⇒ 关掉,10 次也不命中;统计照记", [hits.every((h) => h === null), w.stats()], [true, { calls: 10, errors: 10, longestRun: 10, longestTool: "Bash" }]); }
  { let threw = 0;
    for (const bad of [-1, 1.5, "3", null]) { try { createWatch({ sameErrorLimit: bad }); } catch { threw++; } }
    t("sameErrorLimit 不是非负整数 ⇒ 抛", threw, 4); }
  t("错误文字空白归一:多空格、换行、制表、首尾空白 与 一个空格同等;数组形结果与字符串形同等",
    play(createWatch(), [["Bash", { c: 1 }, true, "Error:  no such\n\tfile "], ["Bash", { c: 1 }, true, [{ type: "text", text: "Error: no such file" }]], ["Bash", { c: 1 }, true, " Error: no  such file"]]),
    [null, null, "same-error:3:main"]);
  t("normError:取前 500 字、空内容为空串", [normError("a".repeat(900)).length, normError(undefined), normError([{ type: "image" }, { type: "text", text: " x  y " }])], [500, "", "x y"]);
  { const w = createWatch();
    const a = use("Bash", { command: "false" }), b = use("Bash", { command: "false" }), c = use("Bash", { command: "false" });
    w.feed({ type: "assistant", message: { content: [a.evt.message.content[0], b.evt.message.content[0], c.evt.message.content[0]] }, parent_tool_use_id: null });
    const h = w.feed({ type: "user", message: { content: [a, b, c].map((x) => ({ type: "tool_result", tool_use_id: x.id, is_error: true, content: "Exit code 1" })) }, parent_tool_use_id: null });
    t("一条消息里多个工具调用 / 多个结果按先后计数", [h?.count, w.stats().calls], [3, 3]); }
  { const w = createWatch();
    const junk = [null, 5, "x", {}, { type: "user", message: { content: "提示词正文" } }, { type: "result", subtype: "success" }, { type: "system" }];
    t("不认识的事件 ⇒ 返回 null、不抛", junk.map((e) => w.feed(e)), junk.map(() => null)); }
  t("回放参数:--limit 可放在文件前后;缺文件 / 坏 --limit / 未知旗标 ⇒ 抛",
    [parseReplayArgs(["--replay", "a.log", "--limit", "2", "b.log"]), ...[["--replay"], ["--replay", "a", "--limit", "-1"], ["--replay", "a", "--limit"], ["--replay", "a", "--x"]].map((a) => { try { parseReplayArgs(a); return "ok"; } catch { return "throw"; } })],
    [{ files: ["a.log", "b.log"], limit: 2 }, "throw", "throw", "throw", "throw"]);

  // 回放:临时目录里造两份日志(一份有连着 3 次的同样错误,一份干净)+ 一份不存在的
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-watch-st-"));
  try {
    const SECRET = "机密原文-不许出现在回放输出里";
    const lines = (steps) => {
      const L = ["# batch-run 日志头(不是 JSON)", JSON.stringify({ type: "system", subtype: "init" })];
      for (const [name, input, isErr, text] of steps) { const u = use(name, input); L.push(JSON.stringify(u.evt), JSON.stringify(res(u.id, isErr, text))); }
      L.push("{坏行", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: SECRET }));
      return L.join("\n") + "\n";
    };
    const bad = ["Bash", { command: SECRET }, true, `${SECRET} 报错`];
    fs.writeFileSync(path.join(tmp, "spin.log"), lines([S, bad, bad, bad, S]));
    fs.writeFileSync(path.join(tmp, "clean.log"), lines([S, E, S]));
    const files = [path.join(tmp, "spin.log"), path.join(tmp, "clean.log"), path.join(tmp, "missing.log")];
    const out = replayFiles(files);
    t("回放:末行固定形(读得了的 2 份里会停 1 份,最长连串 3)", out[out.length - 1], "回放 2 份:会停 1 份(阈值 3);最长连串 3");
    t("回放:每份一行计数;读不了的单独报一行并计数", [out[0].startsWith("spin.log  调用 5  报错 3  最长连串 3(Bash)  会停 是"), out[1].startsWith("clean.log  调用 3  报错 1  最长连串 1(Bash)  会停 否"), out[2].startsWith("missing.log  读不了"), out[3]], [true, true, true, "读不了 1 份"]);
    t("回放:输出里没有日志原文", out.some((l) => l.includes("机密原文")), false);
    t("回放:--limit 4 ⇒ 都不停", replayFiles(files.slice(0, 2), { limit: 4 }).pop(), "回放 2 份:会停 0 份(阈值 4);最长连串 3");
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不判 */ } }

  console.log(`batch-watch 自测 ${pass}/${pass + fail}`);
  return fail ? 1 : 0;
}

// ── 入口 ──────────────────────────────────────────────────────────────────────────────
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest());
  if (argv[0] === "--replay") {
    let p;
    try { p = parseReplayArgs(argv); } catch (e) { console.error(e.message); process.exit(2); }
    for (const l of replayFiles(p.files, { limit: p.limit })) console.log(l);
    process.exit(0);
  }
  console.error("用法: --replay <日志文件…> [--limit N] | --self-test");
  process.exit(2);
}
