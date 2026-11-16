#!/usr/bin/env node
// hook-start-gate.selftest.mjs —— 开工面闸「必达注入」自测(批 294,287 设计 2.7)
//
// 测的是行为,不是接线:每个用例真起一次 hook 进程,喂 payload,看它说没说话。
// 夹具 = 系统临时目录里的**迷你仓**:把 scripts/*.mjs 与 scripts/lib/ 拷进去,批目标、去重账、待续件都在迷你仓里。
//   hook 只按自身位置锚定路径、不认任何环境变量覆盖(codex 294-r2 / 红队 BP-8:覆盖口挡不住 settings env),
//   所以迷你仓是唯一不碰真仓状态的测法。
// 每次调用都断言:正常退出、输出要么为空要么是合法 hook JSON(codex 294-r1 §5:负例不得把崩溃判绿)。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "start-gate-st-"));
const MS = path.join(dir, "scripts");
fs.mkdirSync(MS, { recursive: true });
for (const n of fs.readdirSync(SRC)) if (n.endsWith(".mjs")) fs.copyFileSync(path.join(SRC, n), path.join(MS, n));
fs.cpSync(path.join(SRC, "lib"), path.join(MS, "lib"), { recursive: true });
fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
fs.mkdirSync(path.join(dir, "clipboard"), { recursive: true });
const HOOK = path.join(MS, "hook-start-gate.mjs");
const GOAL = path.join(dir, ".claude", ".batch-goal.json");
const SEEN_DIR = path.join(dir, ".claude", ".start-ctx-seen");
const PENDING = path.join(dir, "clipboard", ".pending-after-limit.md");
const seenFile = (sid) => path.join(SEEN_DIR, crypto.createHash("sha1").update(sid).digest("hex").slice(0, 16) + ".json");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function run(payload) {
  const r = spawnSync(process.execPath, ["--no-warnings", HOOK], {
    input: JSON.stringify(payload), encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  let ctx = "", out = {};
  try { out = JSON.parse(r.stdout || "{}"); ctx = out?.hookSpecificOutput?.additionalContext || ""; } catch { ctx = "PARSE_FAIL:" + r.stdout; }
  const okShape = !r.stdout || (out && typeof out.hookSpecificOutput === "object");
  if (r.status !== 0 || !okShape || ctx.startsWith("PARSE_FAIL")) {
    fail++; console.log(`FAIL 进程异常: exit=${r.status} stdout=${String(r.stdout).slice(0, 120)} stderr=${String(r.stderr).slice(0, 200)}`);
  }
  return { ctx, out, decision: out?.hookSpecificOutput?.permissionDecision || "" };
}
const unarmed = (batch = "900") => fs.writeFileSync(GOAL, JSON.stringify({ batch, conditions: ["x"], armedAt: "2026-11-07T00:00:00Z", cleared: true }));
const armedGoal = (at, batch = "901") => fs.writeFileSync(GOAL, JSON.stringify({ batch, conditions: ["x"], armedAt: at }));
const resetSeen = () => fs.rmSync(SEEN_DIR, { recursive: true, force: true });
const msg = (sid, extra = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi", ...extra });
const tool = (sid, name, input = {}, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: sid, tool_name: name, tool_input: input, ...extra });
const start = (sid, extra = {}) => ({ hook_event_name: "SessionStart", session_id: sid, source: "compact", ...extra });
const has = (r, s) => r.ctx.includes(s);
const jsonl = (rows) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";

try {
  // ── 未武装 ──
  unarmed(); resetSeen();
  check("U1 会话第一条消息注入开工三问", has(run(msg("s1")), "开工三问"), true);
  check("U2 同会话第二条消息不再注入", run(msg("s1")).ctx, "");
  check("U3 另一个会话的第一条消息照样注入", has(run(msg("s2")), "开工三问"), true);
  check("U4 只读工具 Read 不注入", run(tool("s1", "Read", { file_path: "a" })).ctx, "");
  check("U5 只读工具 Grep 不注入", run(tool("s1", "Grep")).ctx, "");
  check("U6 第一次非只读工具(Bash)注入一次", has(run(tool("s1", "Bash", { command: "ls" })), "开工三问"), true);
  check("U7 第二次非只读工具(Edit)不再注入", run(tool("s1", "Edit", { file_path: "x.md" })).ctx, "");
  check("U8 未列名的 MCP 工具按非只读算", has(run(tool("s3", "mcp__foo__bar")), "开工三问"), true);
  check("U9 没有 session_id ⇒ 照旧注入(必达优先)", has(run(msg("")), "开工三问"), true);
  check("U10 没有 session_id 第二次也照旧注入", has(run(msg("")), "开工三问"), true);
  fs.writeFileSync(seenFile("s1"), "{not json");
  check("U11 本会话账损坏 ⇒ 照旧注入", has(run(msg("s1")), "开工三问"), true);
  check("U12 损坏后重建了账 ⇒ 第二条不再注入", run(msg("s1")).ctx, "");
  // 账写不进去(把本会话的账文件位置占成目录)⇒ 每次都注入,不报错
  fs.rmSync(seenFile("s4"), { force: true }); fs.mkdirSync(seenFile("s4"), { recursive: true });
  check("U13 账不可写 ⇒ 注入", has(run(msg("s4")), "开工三问"), true);
  check("U14 账不可写 ⇒ 再次也注入", has(run(msg("s4")), "开工三问"), true);
  fs.rmSync(seenFile("s4"), { recursive: true, force: true });

  // ── 武装 / 结清 重置 ──
  resetSeen();
  check("R1 未武装首条注入", has(run(msg("r")), "开工三问"), true);
  check("R2 未武装第二条静默", run(msg("r")).ctx, "");
  armedGoal("2026-11-07T02:00:00Z");
  const r3 = run(msg("r"));
  check("R3 武装后首条:说批状态摘要、不说开工三问", has(r3, "已武装") && !has(r3, "开工三问"), true);
  check("R4 武装后 PreToolUse 非闸文件不注入开工三问", has(run(tool("r", "Bash", { command: "ls" })), "开工三问"), false);
  // 结清:按 batch-goal --clear 的真实形态(只置 cleared:true,不写 clearedAt——红队 294 附节三②)
  fs.writeFileSync(GOAL, JSON.stringify({ batch: "901", conditions: ["x"], armedAt: "2026-11-07T02:00:00Z", cleared: true }));
  check("R5 结清后同会话第一条消息重新注入", has(run(msg("r")), "开工三问"), true);
  check("R6 结清后第一次非只读工具重新注入", has(run(tool("r", "Write", { file_path: "y.md" })), "开工三问"), true);
  check("R7 结清后第二条消息静默", run(msg("r")).ctx, "");

  // ── 武装:三通道还缺 ⇒ 内容不变只说一次,内容变了再说 ──
  resetSeen(); armedGoal("2026-11-07T04:00:00Z");
  const ts = path.join(dir, "t.jsonl");
  fs.writeFileSync(ts, jsonl([{ timestamp: "2026-11-07T05:00:00Z", text: "nothing" }]));
  check("C1 武装缺通道 ⇒ 注入一次", has(run(msg("c", { transcript_path: ts })), "本批三通道还缺"), true);
  check("C2 缺口没变 ⇒ 第二条静默", run(msg("c", { transcript_path: ts })).ctx, "");
  fs.appendFileSync(ts, jsonl([{ timestamp: "2026-11-07T05:10:00Z", name: "WebSearch" }]));
  const c3 = run(msg("c", { transcript_path: ts }));
  check("C3 缺口变了(联网补上)⇒ 再注入", has(c3, "本批三通道还缺") && !has(c3, "联网先例"), true);
  check("C4 新缺口不变 ⇒ 静默", run(msg("c", { transcript_path: ts })).ctx, "");
  check("C5 另一个会话照样能看到", has(run(msg("c2", { transcript_path: ts })), "本批三通道还缺"), true);

  // ── 武装后闸引擎写入 deny:只认 Edit / Write / MultiEdit(codex 294-r1 §1)──
  const gate = { file_path: "scripts/hook-stop-closure.mjs" };
  check("D1 武装 + 通道缺 + Edit 闸引擎 ⇒ deny", run(tool("d", "Edit", gate, { transcript_path: ts })).decision, "deny");
  check("D2 武装 + 通道缺 + Read 闸文件 ⇒ 不 deny", run(tool("d", "Read", gate, { transcript_path: ts })).decision, "");
  check("D3 武装 + 通道缺 + 带同形 file_path 的 MCP 工具 ⇒ 不 deny", run(tool("d", "mcp__fs__read_file", gate, { transcript_path: ts })).decision, "");
  check("D4 武装 + 通道缺 + Write 闸文件 ⇒ deny", run(tool("d", "Write", gate, { transcript_path: ts })).decision, "deny");
  check("D5 武装 + 通道缺 + MultiEdit 闸文件 ⇒ deny", run(tool("d", "MultiEdit", gate, { transcript_path: ts })).decision, "deny");
  // ── P0 收口(codex p0-close r2 ②):新纳入引擎面的文件同样 deny;红队只点名这些文件也算绑定(与 P 的 hunterBound 一致),只点名其 .selftest 不算 ──
  const gate9 = { file_path: "scripts/batch-goal.mjs" };
  check("D6 武装 + 通道缺 + Edit 新纳入的 batch-goal.mjs ⇒ deny", run(tool("d", "Edit", gate9, { transcript_path: ts })).decision, "deny");
  check("D7 武装 + 通道缺 + Edit 非闸脚本 verify-prod.mjs ⇒ 不 deny", run(tool("d", "Edit", { file_path: "scripts/verify-prod.mjs" }, { transcript_path: ts })).decision, "");
  const tsB = path.join(dir, "bound.jsonl");
  const boundTs = (hunterLine) => fs.writeFileSync(tsB, jsonl([
    { timestamp: "2026-11-07T05:00:00Z", t: "CODEX_JOB=j1" },
    { timestamp: "2026-11-07T05:00:00Z", t: hunterLine },
    { timestamp: "2026-11-07T05:00:00Z", name: "WebSearch" },
  ]));
  boundTs("_gate-bypass-hunter 只看 scripts/lib/write-checks.mjs 的拒绝点");
  check("D8 红队只点名新纳入的 lib/write-checks.mjs ⇒ 算绑定,通道齐,不 deny", run(tool("d", "Edit", gate9, { transcript_path: tsB })).decision, "");
  boundTs("_gate-bypass-hunter 只看 scripts/lib/write-checks.selftest.mjs");
  check("D9【反向】红队只点名它的 .selftest ⇒ 不算绑定,照旧 deny", run(tool("d", "Edit", gate9, { transcript_path: tsB })).decision, "deny");

  // ── codex 294-r1 §2:已武装、通道齐、无待续件 ⇒ 新会话首条也必须有话(批状态摘要)──
  resetSeen();
  const tsFull = path.join(dir, "full.jsonl");
  fs.writeFileSync(tsFull, jsonl([
    { timestamp: "2026-11-07T05:00:00Z", t: "codex-run.mjs" },
    { timestamp: "2026-11-07T05:00:00Z", t: "_gate-bypass-hunter hook-stop-closure grill:architecture" },
    { timestamp: "2026-11-07T05:00:00Z", name: "WebSearch" },
  ]));
  const f1 = run(msg("full", { transcript_path: tsFull }));
  check("A1 已武装 + 通道齐 ⇒ 新会话首条仍注入批状态摘要", has(f1, "已武装") && !has(f1, "三通道还缺"), true);
  check("A2 同会话第二条 ⇒ 静默", run(msg("full", { transcript_path: tsFull })).ctx, "");
  check("A3 另一新会话首条 ⇒ 注入", has(run(msg("full2", { transcript_path: tsFull })), "已武装"), true);

  // ── codex 294-r1 §6:内容 A→B→A ⇒ 三次都说 ──
  resetSeen();
  const tsAB = path.join(dir, "ab.jsonl");
  fs.writeFileSync(tsAB, jsonl([{ timestamp: "2026-11-07T05:00:00Z", t: "nothing" }]));
  const sA = run(msg("ab", { transcript_path: tsAB })).ctx;
  fs.writeFileSync(tsAB, jsonl([{ timestamp: "2026-11-07T05:00:00Z", name: "WebSearch" }]));
  const sB = run(msg("ab", { transcript_path: tsAB })).ctx;
  fs.writeFileSync(tsAB, jsonl([{ timestamp: "2026-11-07T05:00:00Z", t: "nothing" }]));
  const sA2 = run(msg("ab", { transcript_path: tsAB })).ctx;
  check("H1 A→B→A:三次都注入,第三次与第一次同文", !!sA && !!sB && sA !== sB && sA2 === sA, true);

  // ── 待续件 PENDING → DONE → PENDING(红队 294 BP-3):第二次 PENDING 也要说 ──
  unarmed(); resetSeen();
  run(msg("pd"));                                                           // 先吃掉无待续件的那一次
  fs.writeFileSync(PENDING, "STATUS: PENDING\n等额度\n");
  check("P1 待续件冒出 ⇒ 注入且带 PENDING", has(run(msg("pd")), "待续件 PENDING"), true);
  fs.writeFileSync(PENDING, "STATUS: DONE\n");
  check("P2 待续件结清 ⇒ 正文变回原样,再说一次(不带 PENDING)", (() => { const r = run(msg("pd")); return has(r, "开工三问") && !has(r, "PENDING"); })(), true);
  fs.writeFileSync(PENDING, "STATUS: PENDING\n又撞额度\n");
  check("P3 第二次 PENDING ⇒ 照样注入", has(run(msg("pd")), "待续件 PENDING"), true);
  fs.rmSync(PENDING, { force: true });

  // ── 结构异常账 / 过期条目 ⇒ 当没送过,照旧注入,且不崩 ──
  resetSeen(); fs.mkdirSync(SEEN_DIR, { recursive: true });
  fs.writeFileSync(seenFile("s9"), JSON.stringify(new Array(200000).fill(1)));
  check("B1 账里是 20 万元素数组 ⇒ 照旧注入、不崩", has(run(msg("s9")), "开工三问"), true);
  fs.writeFileSync(seenFile("s9"), JSON.stringify({ x: 0, y: [1, 2], z: "str" }));
  check("B2 账条目形状不对 ⇒ 照旧注入", has(run(msg("s9")), "开工三问"), true);
  const old = JSON.parse(fs.readFileSync(seenFile("s9"), "utf8"));
  for (const k of Object.keys(old)) if (old[k] && typeof old[k] === "object") old[k].t = Date.now() - 8 * 24 * 3600 * 1000;
  fs.writeFileSync(seenFile("s9"), JSON.stringify(old));
  check("B3 条目已过 7 天 ⇒ 当没送过,照旧注入", has(run(msg("s9")), "开工三问"), true);
  check("B4 过期条目被覆盖后 ⇒ 第二条静默", run(msg("s9")).ctx, "");
  check("B5 账文件随后仍是合法 JSON", (() => { try { JSON.parse(fs.readFileSync(seenFile("s9"), "utf8")); return true; } catch { return false; } })(), true);
  check("B6 写账不留临时件", fs.readdirSync(SEEN_DIR).some((f) => f.endsWith(".tmp")), false);
  // 7 天没动过的别的会话文件被顺手清掉
  fs.writeFileSync(seenFile("stale"), "{}");
  const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(seenFile("stale"), past, past);
  run(msg("fresh"));
  check("B7 7 天没动的会话文件被清掉", fs.existsSync(seenFile("stale")), false);

  // ── 红队 294 BP-1:子代理(带 agent_id)的非只读调用不注入、不占主会话那一槽 ──
  resetSeen(); unarmed();
  check("S1 子代理的 Bash ⇒ 不注入", run(tool("p", "Bash", { command: "ls" }, { agent_id: "a1", agent_type: "x" })).ctx, "");
  check("S2 随后主会话第一次非只读调用 ⇒ 仍注入", has(run(tool("p", "Bash", { command: "ls" })), "开工三问"), true);

  // ── 红队 294 BP-2 / BP-10 + codex 294-r2 §5:SessionStart ⇒ 忘账并当场注入;别的会话不受影响 ──
  resetSeen();
  check("K1 首条注入", has(run(msg("k")), "开工三问"), true);
  check("K2 另一会话首条注入", has(run(msg("k2")), "开工三问"), true);
  check("K3 第二条静默", run(msg("k")).ctx, "");
  check("K4 SessionStart(compact)⇒ 当场注入", has(run(start("k")), "开工三问"), true);
  check("K5 SessionStart 之后同内容的下一条 ⇒ 不重复", run(msg("k")).ctx, "");
  check("K6 别的会话的账不受影响(仍静默)", run(msg("k2")).ctx, "");
  // 交错:别的会话 k2 在 k 忘账之后写账,不会把 k 的旧账写回来(每会话一个文件)
  run(msg("k3"));
  check("K7 别的会话写账后,k 的账仍是 SessionStart 后那份", run(msg("k")).ctx, "");
  // codex 294-r3 §5:K8/K9 原先武装时刻晚于转录时间戳 ⇒ 三通道记录全被过滤,测的不是「通道齐」。改为武装在转录之前。
  armedGoal("2026-11-07T04:30:00Z");
  const k8 = run(start("k8", { source: "resume", transcript_path: tsFull }));
  check("K8 已武装 + 通道齐时 SessionStart(resume)⇒ 只注入批状态摘要", has(k8, "已武装") && !has(k8, "三通道还缺"), true);
  // 误拦猎手 294-r3 FB-1:startup 时转录未落盘 ⇒ 不当场说,首条消息读到转录后说一次,不重复
  const tsLate = path.join(dir, "late.jsonl");
  check("K8b startup ⇒ 当场不说", run(start("k8b", { source: "startup", transcript_path: tsLate })).ctx, "");
  fs.writeFileSync(tsLate, jsonl([{ timestamp: "2026-11-07T07:00:00Z", type: "user", t: "hi" }]));
  check("K8c startup 后首条 ⇒ 说一次(带缺口)", has(run(msg("k8b", { transcript_path: tsLate })), "本批三通道还缺"), true);
  check("K8d 再一条 ⇒ 不重复", run(msg("k8b", { transcript_path: tsLate })).ctx, "");
  check("K9 随后首条同内容 ⇒ 不重复", run(msg("k8", { transcript_path: tsFull })).ctx, "");
  check("K9b SessionStart 读不到转录、首条读到缺口 ⇒ 首条按新内容再说", (() => {
    run(start("k9", {}));                                       // 无 transcript ⇒ 只说摘要
    return has(run(msg("k9", { transcript_path: ts })), "本批三通道还缺");
  })(), true);
  check("K10 SessionStart 的 hookEventName 回填 SessionStart", k8.out?.hookSpecificOutput?.hookEventName, "SessionStart");
  // 红队 294-r3 BP-11:子代理的 SessionStart(带 agent_id)不忘、不说、不记 ⇒ 父会话结清后首条照说
  unarmed(); resetSeen();
  check("K11 子代理 SessionStart ⇒ 不说", run(start("kp", { agent_id: "a1", agent_type: "x" })).ctx, "");
  check("K12 随后父会话首条 ⇒ 照说", has(run(msg("kp")), "开工三问"), true);
  run(msg("kq"));
  check("K13 子代理 SessionStart 不删父会话的账", (() => { const f = seenFile("kq"); const before = fs.existsSync(f); run(start("kq", { agent_id: "a2" })); return before && fs.existsSync(f); })(), true);
  // codex 294-r3 §1:忘账失败(本会话账位置被占成非空目录:删、覆盖都失败)⇒ SessionStart 不查账、直接说。
  //   ⚠️ 判别力有限:占成目录时读账也失败、按空账算,改前版本同样会说——这两条只证「失败路径不崩、照说」。
  //   「账可读而写 / 删全失败」那一形在本机文件系统上造不出来(libuv 删只读文件会先清只读位),没有夹具,如实登 D202⑤。
  unarmed(); resetSeen();
  fs.mkdirSync(path.join(seenFile("kf"), "x"), { recursive: true });
  check("K14 忘账失败 ⇒ SessionStart 照说", has(run(start("kf")), "开工三问"), true);
  check("K15 忘账失败 ⇒ 再次 SessionStart 也照说", has(run(start("kf")), "开工三问"), true);
  fs.rmSync(seenFile("kf"), { recursive: true, force: true });

  // ── 红队 294 BP-6 / BP-8:环境变量改不了 hook 读写的路径 ──
  unarmed(); resetSeen();
  const fake = path.join(dir, "fake-goal.json");
  fs.writeFileSync(fake, JSON.stringify({ batch: "666", conditions: ["x"], armedAt: "2026-11-07T00:00:00Z" }));
  const e1 = spawnSync(process.execPath, ["--no-warnings", HOOK], {
    input: JSON.stringify(msg("env")), encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, START_GATE_GOAL_FILE: fake, START_GATE_SEEN_FILE: path.join(dir, "fake-seen.json") },
  });
  let e1ctx = ""; try { e1ctx = JSON.parse(e1.stdout || "{}")?.hookSpecificOutput?.additionalContext || ""; } catch { /* 下面判 */ }
  check("E1 START_GATE_GOAL_FILE 指向伪造的已武装件 ⇒ 不采纳(仍按迷你仓的未武装件)", e1.status === 0 && e1ctx.includes("开工三问") && !e1ctx.includes("666"), true);
  check("E2 START_GATE_SEEN_FILE 不被写", fs.existsSync(path.join(dir, "fake-seen.json")), false);

  // ── 批 299(拆批稿「298」完成条件 3):未武装时第一次 Bash / PowerShell / Agent 调用各注入一次;同状态连续 5 次只注入 1 次 ──
  unarmed(); resetSeen();
  check("N1 第一次 PowerShell ⇒ 注入", has(run(tool("n-ps", "PowerShell", { command: "Get-Date" })), "开工三问"), true);
  check("N2 第一次 Agent ⇒ 注入", has(run(tool("n-ag", "Agent", { prompt: "x", subagent_type: "Explore" })), "开工三问"), true);
  check("N3 第一次 Bash ⇒ 注入", has(run(tool("n-sh", "Bash", { command: "node x.mjs" })), "开工三问"), true);
  const five = [0, 1, 2, 3, 4].map(() => run(tool("n-five", "Bash", { command: "ls" })).ctx).filter(Boolean).length;
  check("N4 同状态连续 5 次非只读调用 ⇒ 只注入 1 次", five, 1);
  fs.writeFileSync(GOAL, JSON.stringify({ batch: "905", conditions: ["x"], armedAt: "2026-11-07T08:00:00Z" }));
  run(tool("n-five", "Bash", { command: "ls" }));
  unarmed("905");
  check("N5 武装再结清后 ⇒ 重置,再注入一次", has(run(tool("n-five", "PowerShell", { command: "Get-Date" })), "开工三问"), true);

  // ── 批 299b:快照代码已整体删除(299b-design 第 2 节)——UserPromptSubmit 不写 .turn-snapshot/、不起 Worker、注入照旧(回归钉)──
  const SNAPDIR = path.join(dir, ".claude", ".turn-snapshot");
  unarmed(); resetSeen();
  fs.rmSync(SNAPDIR, { recursive: true, force: true });
  const q1 = run(msg("snap1"));
  check("Q1 UserPromptSubmit ⇒ 注入照旧", has(q1, "开工三问"), true);
  check("Q2 非 git 仓 ⇒ 不写 .turn-snapshot/", fs.existsSync(SNAPDIR), false);
  run(tool("snap2", "Bash", { command: "ls" }));
  run(start("snap3"));
  check("Q3 PreToolUse / SessionStart ⇒ 也不写 .turn-snapshot/", fs.existsSync(SNAPDIR), false);
  // 真 git 仓:同样不采(不起 Worker、不跑 git、连 git 路径缓存 git-exe.json 也不写)
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 15000 });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "x"); g("add", "README.md"); g("commit", "-qm", "init");
  const t4 = Date.now(); const q4 = run(msg("snap4", { prompt_id: "p-1" }));
  const el4 = Date.now() - t4;
  check("Q4 git 仓里 UserPromptSubmit ⇒ 注入照旧", has(q4, "开工三问"), true);
  check("Q5 git 仓里 UserPromptSubmit ⇒ 不写 .turn-snapshot/(连 git 路径缓存也没有)", fs.existsSync(SNAPDIR), false);
  check("Q6 git 仓里 UserPromptSubmit 2 秒内返回(不等快照)", el4 < 2000, true);

  // ── 批 305:收尾闸的「只提示」随下一条用户消息送达(读端;寄存库 lib/gate-hint-relay.mjs)──
  //   写端在收尾钩子里;这里用库的 stashHint 直接往迷你仓的信箱里放,最后一组用真的 emit() 走一遍全程。
  const relay = await import("./lib/gate-hint-relay.mjs");
  const DROPS = path.join(dir, relay.DROP_LOG);
  const dropRows = () => { try { return fs.readFileSync(DROPS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const HEAD = "上一轮收尾闸的提示";
  const NOTE = (id) => `收尾闭环闸命中 1 项:\n  [${id}] 承诺未兑现(自测 ${id})`;
  unarmed(); resetSeen();
  check("H1 读端没跑过 ⇒ 不在场(写端据此不寄存)", relay.receiverSeen(dir, "h1"), false);
  const h1 = run(msg("h1"));
  check("H2 第一条消息之后读端在场;没有寄存的提示时注入照旧", [relay.receiverSeen(dir, "h1"), has(h1, "开工三问"), has(h1, HEAD)].join(":"), "true:true:false");
  relay.stashHint(dir, "h1", { text: NOTE("B"), ids: ["B"] });
  const h3 = run(msg("h1"));
  check("H3 下一条消息取走提示(全文在;开工三问已说过不重复)", [has(h3, HEAD), has(h3, "[B] 承诺未兑现"), has(h3, "开工三问")].join(":"), "true:true:false");
  check("H4 再下一条消息不再送(同一条只送一次)", run(msg("h1")).ctx, "");
  // 与开工上下文同一条消息里一起说:一份合法 JSON、两段都在(run() 自带 JSON 形状断言)
  relay.markReceiver(dir, "h5"); relay.stashHint(dir, "h5", { text: NOTE("C"), ids: ["C"] });
  const h5 = run(msg("h5"));
  check("H5 新会话首条消息:提示与开工三问合在一次输出里", [has(h5, HEAD), has(h5, "[C] 承诺未兑现"), has(h5, "开工三问")].join(":"), "true:true:true");
  check("H6 之后两样都不重复", run(msg("h5")).ctx, "");
  // 会话隔离
  run(msg("h7a")); run(msg("h7b"));
  relay.stashHint(dir, "h7a", { text: NOTE("D"), ids: ["D"] });
  check("H7 别的会话的消息拿不到本会话的提示", has(run(msg("h7b")), HEAD), false);
  check("H8 本会话的下一条消息照样拿到", has(run(msg("h7a")), "[D] 承诺未兑现"), true);
  // 只有 UserPromptSubmit 取:工具调用、会话起点、子代理都不取
  run(msg("h9")); relay.stashHint(dir, "h9", { text: NOTE("F"), ids: ["F"] });
  check("H9 PreToolUse 不取", has(run(tool("h9", "Bash", { command: "ls" })), HEAD), false);
  check("H10 SessionStart(compact)不取", has(run(start("h9")), HEAD), false);
  check("H11 带 agent_id 的 UserPromptSubmit(子代理)不取", has(run(msg("h9", { agent_id: "sub-1" })), HEAD), false);
  check("H12 主会话的下一条消息才取到", has(run(msg("h9")), "[F] 承诺未兑现"), true);
  // 取不到的三种:过期、会话换了、信箱损坏 —— 都要在丢弃账里留一行
  const OLD = Date.now() - relay.HINT_TTL_MS - 3600e3;
  run(msg("h13")); relay.stashHint(dir, "h13", { text: NOTE("G"), ids: ["G"] }, OLD);
  const d0 = dropRows().length;
  const h13 = run(msg("h13"));
  check("H13 寄存超期 ⇒ 不送", has(h13, HEAD), false);
  check("H14 超期的记进丢弃账(原因、条数、规则 id)", (() => { const r = dropRows(); const x = r[r.length - 1] || {}; return [r.length - d0, x.reason, x.n, (x.ids || []).join(",")].join(":"); })(), "1:expired:1:G");
  check("H15 记账之后不再重复记", (() => { run(msg("h13")); return dropRows().length - d0; })(), 1);
  relay.markReceiver(dir, "h16-gone"); relay.stashHint(dir, "h16-gone", { text: NOTE("H"), ids: ["H"] }, OLD);
  const d1 = dropRows().length;
  const h16 = run(msg("h16-new"));
  check("H16 会话换了:旧会话的提示不会送给新会话", has(h16, "[H] 承诺未兑现"), false);
  check("H17 旧会话超期的提示由别的会话清掉并记账(带原会话号)", (() => { const r = dropRows(); const x = r[r.length - 1] || {}; return [r.length - d1, x.reason, x.sid, fs.existsSync(relay.boxFile(dir, "h16-gone"))].join(":"); })(), "1:expired:h16-gone:false");
  relay.markReceiver(dir, "h18-live"); relay.stashHint(dir, "h18-live", { text: NOTE("J"), ids: ["J"] });
  run(msg("h16-new"));
  check("H18 别的会话没超期的提示不动(等它自己的下一条消息)", has(run(msg("h18-live")), "[J] 承诺未兑现"), true);
  run(msg("h19")); fs.writeFileSync(relay.boxFile(dir, "h19"), "{坏的");
  const d2 = dropRows().length;
  const h19 = run(msg("h19"));
  check("H19 信箱损坏 ⇒ 不崩、不送,记一笔并重置", [has(h19, HEAD), dropRows().length - d2, (dropRows().pop() || {}).reason, relay.receiverSeen(dir, "h19")].join(":"), "false:1:corrupt:true");
  check("H20 没有 session_id ⇒ 不取、不崩(开工三问照旧)", [has(run(msg("")), HEAD), has(run(msg("")), "开工三问")].join(":"), "false:true");
  // 丢弃账写不进去 ⇒ 过期件留着,不静默删
  run(msg("h21")); relay.stashHint(dir, "h21", { text: NOTE("K"), ids: ["K"] }, OLD);
  const dropsBak = fs.existsSync(DROPS) ? fs.readFileSync(DROPS, "utf8") : "";
  fs.rmSync(DROPS, { force: true }); fs.mkdirSync(DROPS, { recursive: true });
  run(msg("h21"));
  check("H21 丢弃账写不成 ⇒ 过期件还在信箱(下次再记)", relay.takeHints(dir, "h21").expired, 1);
  fs.rmSync(DROPS, { recursive: true, force: true }); fs.writeFileSync(DROPS, dropsBak);
  run(msg("h21"));
  check("H22 丢弃账恢复后补记", (dropRows().pop() || {}).ids?.join(","), "K");

  // 全程:真的收尾钩子 emit() 寄存 → 下一次 UserPromptSubmit 取走、只送一次;无头会话与开关都不走新通道
  const stopHook = await import("./hook-stop-closure.mjs");
  const capture = (fn) => { const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr); let buf = "";
    process.stdout.write = (s) => { buf += String(s); return true; }; process.stderr.write = () => true;
    try { fn(); } finally { process.stdout.write = w; process.stderr.write = e; } return buf; };
  const hintF = [{ id: "DRIFT", block: false, msg: "文档漂移(全程自测)" }];
  const stopAs = (sid, over = {}) => capture(() => stopHook.emit(hintF, 0, { hintRelay: { root: dir, sid, entries: [{ entrypoint: "cli" }], env: {}, ...over } }));
  const firstStop = stopAs("z1");
  check("Z1 会话还没发过消息(读端没跑过)⇒ 收尾钩子走老通道", firstStop.includes("additionalContext"), true);
  run(msg("z1"));
  const z2 = stopAs("z1");
  check("Z2 读端在场的交互会话:收尾钩子不输出 additionalContext(不续轮)", z2.includes("additionalContext"), false);
  const z3 = run(msg("z1"));
  check("Z3 下一条用户消息拿到那条提示", [has(z3, HEAD), has(z3, "[DRIFT] 文档漂移(全程自测)")].join(":"), "true:true");
  check("Z4 只送一次", run(msg("z1")).ctx, "");
  const z5 = stopAs("z1", { entries: [{ entrypoint: "sdk-cli" }] });
  check("Z5 无头会话:收尾钩子照旧当轮送,下一条消息没有重复件", [z5.includes("additionalContext"), run(msg("z1")).ctx].join(":"), "true:");
  const z6 = stopAs("z1", { env: { STOP_CLOSURE_HINT_DEFER: "0" } });
  check("Z6 开关关掉:收尾钩子照旧当轮送,下一条消息没有重复件", [z6.includes("additionalContext"), run(msg("z1")).ctx].join(":"), "true:");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`hook-start-gate selftest: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
