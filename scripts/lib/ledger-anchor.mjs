// ledger-anchor.mjs —— **外部锚**(D51 姿态 B,2026-08-26 用户亲签「我被雷劈了机器也跑得下去」)
//
// 干什么:把三份链账的「前缀指纹」定期快照到 **agent 仓外**的用户目录;verify 时比对——
// 快照点之前的任何改写/插行/删行/截断 ⇒ 必红;快照点之后的追加 ⇒ 合法(append-only 语义)。
// 这补上文件内前向链在结构上防不了的那半(完整尾删/整链重算),先例=CT/Rekor 的
// 「外部持有树头」形(2026-08-26 WebSearch 取证:truncation attack 的业界修法即外部锚)。
//
// **诚实边界(头注钉死,不许产品文案放大)**:
//   同一台机、同一 OS 用户下,「agent 不可写」是**软边界**——提高伪造成本、保证事后取证面,
//   不是硬隔离(能以你的身份跑任意命令的进程也能动锚)。硬隔离=异机/CI 收树头(D51 的 C 档)。
//   快照间隙内的「写了又擦」检不出(间隙=计划任务周期,默认每日)。
//
// 快照行:{ts, file, bytes, sha256, lastH, lines} —— sha256=快照时**全文件字节**的摘要;
// verify:当前文件 size≥bytes 且 前 bytes 字节的 sha256 与记录一致 ⇒ 前缀完好;否则红。
// 锚目录:~/.custodiet/anchor/<仓名>.jsonl(追加不覆盖,锚自身留全史)。
// 无锚快照 ⇒ verify 报 NO-ANCHOR 退出 1(fail-closed:该跑而没跑过的锚不是「没问题」)。
//
// 用法:
//   node --no-warnings scripts/lib/ledger-anchor.mjs snapshot        # 快照(计划任务每日跑)
//   node --no-warnings scripts/lib/ledger-anchor.mjs verify          # 比对(开工面/按需)
//   node --no-warnings scripts/lib/ledger-anchor.mjs install-task    # 装 OS 级每日任务(schtasks)
//   node --no-warnings scripts/lib/ledger-anchor.mjs --self-test
// 退出码:0=过 1=违例/无锚 2=用法错
// 触发层:snapshot=OS 计划任务(agent 会话外);verify=session-triage 开工面第三行(接线另处)。
// 失效条件:①升 C 档(异机/CI 树头)⇒ 本件降为本地缓存,复议;②计划任务连续 14 天无新快照
//   且无人察觉 ⇒ 「必然执行」名存实亡,verify 的 STALE 告警就是它的看门狗。
// CALIBRATED=false。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const H_RE = /"h":"([0-9a-f]{64})"\}$/;

export const LEDGERS = [
  ".claude/.gate-alerts.jsonl",
  ".claude/.gate-fp-ledger.jsonl",
  ".claude/.batch-goal.jsonl",
];

const repoRootOf = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const anchorFileFor = (repoRoot) =>
  path.join(os.homedir(), ".custodiet", "anchor", path.basename(repoRoot) + ".jsonl");

/** 快照三账当前前缀指纹,追加进锚文件。返回快照行数组。 */
export function snapshot(repoRoot = repoRootOf(), anchorFile = anchorFileFor(repoRoot)) {
  fs.mkdirSync(path.dirname(anchorFile), { recursive: true });
  const rows = [];
  for (const rel of LEDGERS) {
    const p = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }        // 账不在 ⇒ 不锚(它建立后自然进下次快照)
    const text = buf.toString("utf8");
    let lastH = null;
    for (const line of text.split("\n")) { const m = H_RE.exec(line.trim()); if (m) lastH = m[1]; }
    const row = { ts: new Date().toISOString(), file: rel, bytes: buf.length,
      sha256: sha256(buf), lastH, lines: text.split("\n").filter((l) => l.trim()).length };
    rows.push(row);
    fs.appendFileSync(anchorFile, JSON.stringify(row) + "\n");
  }
  return rows;
}

/** 对着**最后一次**快照验前缀。返回 {ok, results:[{file,status,detail}]}。 */
export function verify(repoRoot = repoRootOf(), anchorFile = anchorFileFor(repoRoot)) {
  let lines = [];
  try { lines = fs.readFileSync(anchorFile, "utf8").split("\n").filter((l) => l.trim()); }
  catch { return { ok: false, results: [{ file: "(全部)", status: "NO-ANCHOR", detail: "锚文件不存在——该跑而没跑过的锚不是「没问题」;先 snapshot 或查计划任务" }] }; }
  const last = {};
  for (const l of lines) { try { const r = JSON.parse(l); if (r.file) last[r.file] = r; } catch { /* 坏行跳过 */ } }
  const results = [];
  let ok = true;
  for (const rel of LEDGERS) {
    const snap = last[rel];
    if (!snap) { results.push({ file: rel, status: "NO-ANCHOR", detail: "无该账快照" }); ok = false; continue; }
    let buf;
    try { buf = fs.readFileSync(path.join(repoRoot, rel)); }
    catch { results.push({ file: rel, status: "MISSING", detail: "账文件消失而锚记得它存在过" }); ok = false; continue; }
    if (buf.length < snap.bytes) {
      results.push({ file: rel, status: "TRUNCATED", detail: `现长 ${buf.length} < 锚点 ${snap.bytes}——快照点之前被删` }); ok = false; continue;
    }
    if (sha256(buf.subarray(0, snap.bytes)) !== snap.sha256) {
      results.push({ file: rel, status: "PREFIX-REWRITTEN", detail: `锚点前 ${snap.bytes} 字节与快照不符——快照点之前被改写` }); ok = false; continue;
    }
    const ageH = (Date.now() - Date.parse(snap.ts)) / 3600_000;
    results.push({ file: rel, status: ageH > 48 ? "OK-STALE" : "OK",
      detail: `前缀完好,追加 ${buf.length - snap.bytes} 字节;锚龄 ${ageH.toFixed(1)}h${ageH > 48 ? "——计划任务疑似没在跑" : ""}` });
    if (ageH > 48) ok = false;                               // 陈锚=看门狗告警:锚不新鲜等于半个没锚
  }
  return { ok, results };
}

function selfTest() {
  const t = [];
  const chk = (n, got, want) => t.push([got === want ? "PASS" : "FAIL", n, `实得 ${got}`]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-st-"));
  const repo = path.join(dir, "repo"); const anchor = path.join(dir, "a.jsonl");
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  const led = path.join(repo, LEDGERS[0]);
  fs.writeFileSync(led, '{"a":1,"h":"' + "a".repeat(64) + '"}\n');
  fs.writeFileSync(path.join(repo, LEDGERS[1]), '{"b":1}\n');
  fs.writeFileSync(path.join(repo, LEDGERS[2]), '{"c":1}\n');

  chk("无锚 ⇒ NO-ANCHOR 红(fail-closed)", verify(repo, anchor).ok, false);
  snapshot(repo, anchor);
  chk("快照后 verify 过", verify(repo, anchor).ok, true);
  fs.appendFileSync(led, '{"a":2,"h":"' + "b".repeat(64) + '"}\n');
  chk("快照点后追加 ⇒ 仍过(append-only 合法)", verify(repo, anchor).ok, true);
  { const buf = fs.readFileSync(led, "utf8"); fs.writeFileSync(led, buf.replace('"a":1', '"a":9'));
    chk("快照点前改写 ⇒ PREFIX-REWRITTEN 红", verify(repo, anchor).results[0].status, "PREFIX-REWRITTEN");
    fs.writeFileSync(led, buf); }
  { const buf = fs.readFileSync(led, "utf8"); fs.writeFileSync(led, buf.slice(0, 10));
    chk("截断到快照点前 ⇒ TRUNCATED 红", verify(repo, anchor).results[0].status, "TRUNCATED");
    fs.writeFileSync(led, buf); }
  { fs.rmSync(led); chk("账文件消失 ⇒ MISSING 红", verify(repo, anchor).results[0].status, "MISSING"); }
  { // 陈锚看门狗:把锚行时间改老 ⇒ OK-STALE 且整体红
    fs.writeFileSync(path.join(repo, LEDGERS[0]), '{"a":1,"h":"' + "a".repeat(64) + '"}\n{"a":2,"h":"' + "b".repeat(64) + '"}\n');
    const rows = fs.readFileSync(anchor, "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).map((r) => ({ ...r, ts: "2026-08-01T00:00:00Z" }));
    fs.writeFileSync(anchor, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const v = verify(repo, anchor);
    chk("锚龄>48h ⇒ OK-STALE 且整体红(锚不新鲜=半个没锚)", v.results[0].status === "OK-STALE" && v.ok === false, true); }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  let pass = 0;
  for (const [r, n, extra] of t) { console.log(`  ${r}  ${n}${r === "FAIL" ? "  ← " + extra : ""}`); if (r === "PASS") pass++; }
  console.log(`\n锚自测 ${pass}/${t.length}`);
  return pass === t.length;
}

const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;

if (IS_MAIN) {
  const cmd = process.argv[2];
  if (cmd === "--self-test") process.exit(selfTest() ? 0 : 1);
  if (cmd === "snapshot") {
    const rows = snapshot();
    console.log(`已快照 ${rows.length} 账 → ${anchorFileFor(repoRootOf())}`);
    process.exit(0);
  }
  if (cmd === "verify") {
    const v = verify();
    for (const r of v.results) console.log(`  ${r.status.padEnd(16)} ${r.file}  ${r.detail}`);
    console.log(v.ok ? "PASS 外部锚比对通过(软边界与快照间隙见头注)" : "FAIL 外部锚比对未过");
    process.exit(v.ok ? 0 : 1);
  }
  if (cmd === "install-task") {
    const { execFileSync } = await import("node:child_process");
    const node = process.execPath;
    const script = fileURLToPath(import.meta.url);
    const tr = `"${node}" --no-warnings "${script}" snapshot`;
    execFileSync("schtasks", ["/Create", "/F", "/SC", "DAILY", "/ST", "05:33",
      "/TN", "custodiet-anchor-" + path.basename(repoRootOf()), "/TR", tr], { stdio: "inherit" });
    console.log("已装每日 05:33 计划任务(每用户级,agent 会话外执行)");
    process.exit(0);
  }
  console.error("用法: snapshot | verify | install-task | --self-test");
  process.exit(2);
}
