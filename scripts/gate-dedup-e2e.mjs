// D184 到期动作(批 277):临时克隆里同 session_id 连喂 Stop 载荷,看非阻断提示是否只报一次、新行是否照报。
//   场景 = 等 codex 回件时每轮 poll 一次(误拦猎手 r9 FB-2):A 的「状态未知」同一行第二、三轮应静音,换新作业应照报。
//   去重在 hook 的 live 分支,夹具键写不出多轮,故走真实 Stop 入口;克隆 + 起子进程要十几秒,不进 gate:self-test。
// 用法: node --no-warnings scripts/gate-dedup-e2e.mjs <仓根> [要测的 hook 文件,缺省为仓内那份]
//   exit 0 = 符合预期;1 = 不符合(逐轮读数照打)。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const [repo, hookArg] = process.argv.slice(2);
if (!repo) { console.error("用法: gate-dedup-e2e.mjs <仓根> [hook 文件]"); process.exit(2); }
const hookSrc = hookArg || path.join(repo, "scripts", "hook-stop-closure.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-e2e-"));
const clone = path.join(tmp, "c");
execFileSync("git", ["clone", "-q", "--depth", "1", "file:///" + repo.split("\\").join("/"), clone], { windowsHide: true });
fs.copyFileSync(hookSrc, path.join(clone, "scripts", "hook-stop-closure.mjs"));
fs.mkdirSync(path.join(clone, ".claude"), { recursive: true });

let nid = 0;
const T0 = Date.now() - 60_000;
const call = (name, input, text) => {
  const id = `toolu_e2e${++nid}`; const t = T0 + nid * 1000;
  return [
    { type: "assistant", cwd: clone, timestamp: new Date(t).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", cwd: clone, timestamp: new Date(t + 500).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] } },
  ];
};
const launchBg = (J) => call("Bash", { command: "node ~/.claude/scripts/codex-run.mjs --task clipboard/codex/t.md" },
  `CODEX_JOB=${J}\nCODEX_STATE=background\nCODEX_RESULT=${clone}\\clipboard\\codex\\${J}.md\nCODEX_POLL=node scripts/codex-run.mjs --poll ${J}\nCODEX_END=${J}\n\n[exited with code 0]`);
const userSay = (t) => ({ type: "user", cwd: clone, timestamp: new Date(T0).toISOString(), message: { role: "user", content: [{ type: "text", text: t }] } });
const say = (t) => ({ type: "assistant", cwd: clone, timestamp: new Date(T0 + 50_000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: t }] } });

const writeTp = (name, entries) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
};
const sid = "e2e-" + Date.now();
const stop = (tp) => {
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/hook-stop-closure.mjs"], {
    cwd: clone, windowsHide: true, encoding: "utf8",
    input: JSON.stringify({ session_id: sid, transcript_path: tp, hook_event_name: "Stop", last_assistant_message: "等回件。" }),
    env: { ...process.env, GATE_PAYLOAD_CAPTURE: "0" },
  });
  let ctx = "", sys = "";
  try { const j = JSON.parse(r.stdout || "{}"); ctx = j.hookSpecificOutput?.additionalContext || j.additionalContext || j.reason || ""; sys = j.systemMessage || ""; } catch { ctx = `(stdout 非 JSON:${(r.stdout || "").slice(0, 80)})`; }
  const first = ctx.split("\n").filter((l) => /^\s+\[/.test(l)).join(" | ");
  // said = 给模型的(会续轮);sys = 只给人看的 systemMessage(不续轮),照打以便看出静音轮投了什么
  return { exit: r.status, said: !!ctx, first: first.slice(0, 160), sys: sys.slice(0, 120) };
};

// 每轮只 poll 一下(FB-2 的处境):同一作业、本轮有新事件
const pollJ1 = () => call("Bash", { command: "node scripts/codex-run.mjs --poll probeJ1" }, "CODEX_JOB=probeJ1\nCODEX_STATE=unknown\nCODEX_END=probeJ1\n");
const base = [userSay("开始"), ...launchBg("probeJ1")];
const r1 = stop(writeTp("t1.jsonl", [...base, say("等回件。")]));
const r2 = stop(writeTp("t2.jsonl", [...base, userSay("继续"), ...pollJ1(), say("等回件。")]));
const r3 = stop(writeTp("t3.jsonl", [...base, userSay("继续"), ...pollJ1(), ...pollJ1(), say("等回件。")]));
// 新作业 ⇒ 新的一行,应照报
const r4 = stop(writeTp("t4.jsonl", [...base, userSay("继续"), ...launchBg("probeJ2"), say("等回件。")]));
for (const [k, r] of Object.entries({ r1, r2, r3, r4 })) console.log(k, JSON.stringify(r));
fs.rmSync(tmp, { recursive: true, force: true });
// 批 285(D184,codex 277-deliverables-audit-r1 登记项的一半):各轮退出码都须为 0——非阻断轮若误退 2 就成了阻断,原断言看不出
const exitsOk = [r1, r2, r3, r4].every((r) => r.exit === 0);
const ok = exitsOk && r1.said && /probeJ1/.test(r1.first) && !r2.said && !r3.said && r4.said && /probeJ2/.test(r4.first);
console.log(ok ? "DEDUP-E2E PASS" : "DEDUP-E2E FAIL(期望:r1 报 probeJ1、r2/r3 静音、r4 报 probeJ2,各轮 exit 0)");
process.exit(ok ? 0 : 1);
