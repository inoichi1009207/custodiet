// ledger-anchor.mjs —— **外部锚**(D51 姿态 B,2026-08-26 用户亲签「我被雷劈了机器也跑得下去」)
//
// 干什么:把三份链账的「前缀指纹」定期快照到 **agent 仓外**的用户目录(同机同用户的家目录,
// 见诚实边界①——「仓外」不等于「够不到」);verify 时比对。
//
// ⚠️ **担保句的限定词必须跟着走**(2026-08-26 grill:recon A1 审出:摘要层加了限定,
//   而三份公开文档都写着「以头注为准」,本处却留着上一版的未限定原话
//   ⇒ 限定词只拦住了不较真的读者。判词原话:「不是措辞问题,是权威指向指错了地方」):
//   · 快照点**之前**的改写/插行/删行/截断 ⇒ 红,**前提是**锚文件自身未被同身份进程改写、
//     且 verify 确实被运行过(两条都不自动成立,见①与失效条件②)。
//   · 快照点**之后**的追加 ⇒ 合法(append-only 语义)。
//   · 因此本件补的是「**锚点之前**的完整尾删/整链重算」那半,**不是**尾删问题整体。
//   · ⚠️ 窟窿比「整段删除」宽(A3 审出,判据在 L~128 的 `buf.length < snap.bytes`):
//     只要当前长度**仍 ≥ 快照长度**且前缀一致就判 OK ⇒ 快照后追加 10 行、只删末 3 行
//     同样检不出,不必「整段砍掉、长度正好退回快照值」。而 ledger-chain 对尾部删行
//     剩下的链仍自洽 ⇒ 两件都不覆盖。别把这个洞说窄。
// 先例=CT 的「日志外比对树头」形:
//   RFC 6962 §7.3 写明日志可「presenting two different, conflicting views of the Merkle Tree at
//   different times and/or to different parties」——内部 Merkle 自洽挡不住;而该违例
//   「is detected by global gossiping, i.e., everyone auditing logs comparing their versions of
//   the latest Signed Tree Heads」——检出靠**日志之外**的比对。这就是本件在做的事。
//   出处 https://www.rfc-editor.org/rfc/rfc6962(§7.3、§5),2026-08-26 取页,
//   三条引语经 fetch-quote-check 逐字命中各 1 处。
//   **三档标注**:「单份树头不足以自证」= 文档未记载(该 RFC 未直陈此句,不得写成它说了)。
//   旧头注「WebSearch 取证 / Rekor / 业界修法即外部锚」三项均无真取页支撑,本次删除。
//   ⚠️ **反类比要一并读(grill:recon 108 审出,采纳)**:CT 那套之所以成立,承重前提是
//   树头由**另一方**持有并跨信任域 gossip 比对;本件的锚在**同机同用户**——
//   先例里唯一让它成立的那个属性,本件恰恰没有。故 CT 只作**形状**参照,不作强度背书;
//   拿到那个强度要升 D51 的 C 档(异机/CI 收树头)。引先例而不写这句 = 拿跨方设计的
//   信誉给同方部署背书。
//
// **诚实边界(头注钉死,不许产品文案放大;后四条系 codex 108 四眼补齐)**:
//   ① 同一台机、同一 OS 用户下,「agent 不可写」是**软边界**——提高伪造成本、留取证面,
//     不是硬隔离(能以你的身份跑任意命令的进程也能改锚;锚自身无认证无链)。
//     硬隔离=异机/CI 收树头(D51 的 C 档)。
//   ② 快照间隙内的「写了又擦」检不出(间隙=计划任务周期,默认每日)。
//   ③ 最新锚点**之后**的后缀不受任何约束——锚证明的是「锚点前未动」,不证明「只追加过」
//     (后缀的行级完整性归 ledger-chain 的链验,两件合用才是全貌)。
//   ④ snapshot **先验后锚**:对旧锚 verify 未过 ⇒ 拒绝重锚、落 violation 行、退出 1——
//     没有这一条,每日任务会把篡改「合法化」(codex 108 复现的洗白环,已堵)。
//   ⑤ session-triage 的 ANCHOR 行是提示面(不进 verdict);机器判据=本件 verify 的退出码。
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
// 触发层:snapshot=OS 计划任务(agent 会话外)。
//   verify 的唤醒面**因仓而异,本件自己不接线**:
//     · 源项目(KliniK)接在 `scripts/session-triage.mjs` 的开工面;
//     · **custodiet 等拷贝仓没有 session-triage,也没有任何其他唤醒面** ⇒ 拷走后须自行接一个,
//       否则下面的 STALE 看门狗没有唤醒者(= 闸在仓里但不在跑)。
//   ⚠️ 本段原写作「本仓的唤醒面是…」——`本仓` 在移植后是**假指代**(grill:recon A2 审出:
//     custodiet 正是本段所说的「没有 session-triage 的仓」,而头注却以第一人称说它接好了)。
//     凡随仓走的文件,自指词都会漂;写仓名不写「本仓」。
// 失效条件:①升 C 档(异机/CI 树头)⇒ 本件降为本地缓存,复议;②计划任务连续 14 天无新快照
//   且无人察觉 ⇒ 「必然执行」名存实亡。
//   ⚠️ 两个数不是一回事,别读混(grill:recon 108 点破):**48h** 是代码里的 STALE 告警阈值
//   (L~118,`ageH > 48` ⇒ OK-STALE 且 ok=false);**14 天**是上面那条失效条件的复议期。
//   且看门狗**只在有人跑 verify 时才响**,唤醒面因仓而异(见上面「触发层」那段),
//   没有唤醒面的仓里,失效条件②永不可能触发,等于「闸在仓里但不在跑」。
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
/** 仓键=basename+全路径短哈希——两个同名仓不再共享锚文件/计划任务(codex 108 逮到的碰撞面)。 */
export const repoKeyOf = (repoRoot) =>
  path.basename(repoRoot) + "-" + sha256(path.resolve(repoRoot)).slice(0, 8);
export const anchorFileFor = (repoRoot) =>
  path.join(os.homedir(), ".custodiet", "anchor", repoKeyOf(repoRoot) + ".jsonl");

/** 快照三账当前前缀指纹。**先验后锚**(codex 108 高优先级洞):旧锚 verify 未过 ⇒
 *  拒绝重锚、落 violation 行、返回 {refused:true}——否则每日任务会把篡改合法化。
 *  返回 {rows, skipped, refused, violations}。 */
export function snapshot(repoRoot = repoRootOf(), anchorFile = anchorFileFor(repoRoot)) {
  fs.mkdirSync(path.dirname(anchorFile), { recursive: true });
  // 先验:锚文件已存在时,当前状态必须过旧锚(首锚除外——没有旧锚可验)
  if (fs.existsSync(anchorFile)) {
    const pre = verify(repoRoot, anchorFile);
    const hard = pre.results.filter((r) => !r.status.startsWith("OK") && r.status !== "NO-ANCHOR");
    // NO-ANCHOR(某账首次出现)不拒——新账进锚正是本次快照的活;其余违例一律拒锚
    if (hard.length) {
      fs.appendFileSync(anchorFile, JSON.stringify({ ts: new Date().toISOString(),
        kind: "refused-snapshot", reasons: hard.map((r) => `${r.file}:${r.status}`) }) + "\n");
      return { rows: [], skipped: [], refused: true, violations: hard };
    }
  }
  const rows = [], skipped = [];
  for (const rel of LEDGERS) {
    const p = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(p); } catch { skipped.push(rel); continue; }   // 账不在:跳过但**必须出声**(CLI 侧)
    const text = buf.toString("utf8");
    let lastH = null;
    for (const line of text.split("\n")) { const m = H_RE.exec(line.trim()); if (m) lastH = m[1]; }
    const row = { ts: new Date().toISOString(), file: rel, bytes: buf.length,
      sha256: sha256(buf), lastH, lines: text.split("\n").filter((l) => l.trim()).length };
    rows.push(row);
    fs.appendFileSync(anchorFile, JSON.stringify(row) + "\n");
  }
  return { rows, skipped, refused: false, violations: [] };
}

/** 锚行自身的合法性(codex 108:语义合法、判据有毒的行——bytes:0/空 sha/坏 ts——不许放行)。 */
const validSnap = (r) => Number.isInteger(r.bytes) && r.bytes > 0 &&
  /^[0-9a-f]{64}$/.test(String(r.sha256 || "")) && Number.isFinite(Date.parse(r.ts));

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
    if (!validSnap(snap)) {                        // 有毒锚行 ≠ 无锚:显式定性,fail-closed
      results.push({ file: rel, status: "ANCHOR-POISONED", detail: "锚行字段非法(bytes/sha256/ts)——锚被动过或写坏,不得当有效锚用" }); ok = false; continue;
    }
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
  // **洗白环必须堵死**(codex 108 高优先级洞的回归钉):篡改 → 再 snapshot ⇒ 拒锚且 verify 仍红
  { const buf = fs.readFileSync(led, "utf8");
    fs.writeFileSync(led, buf.replace('"a":1', '"a":8'));
    const s2 = snapshot(repo, anchor);
    chk("篡改后再快照 ⇒ 拒锚(refused)", s2.refused, true);
    chk("拒锚后 verify **仍红**(篡改没被每日任务洗白)", verify(repo, anchor).ok, false);
    fs.writeFileSync(led, buf); }
  // 有毒锚行 ⇒ ANCHOR-POISONED 红(语义合法、判据有毒的行不放行)
  { const good = fs.readFileSync(anchor, "utf8");
    fs.appendFileSync(anchor, JSON.stringify({ ts: "坏", file: LEDGERS[0], bytes: 0, sha256: "", lastH: null, lines: 0 }) + "\n");
    chk("有毒锚行 ⇒ ANCHOR-POISONED 红", verify(repo, anchor).results[0].status, "ANCHOR-POISONED");
    fs.writeFileSync(anchor, good); }
  chk("同名仓不同路径 ⇒ 仓键不同(锚/任务不碰撞)",
    repoKeyOf(path.join(dir, "x", "same")) === repoKeyOf(path.join(dir, "y", "same")), false);
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
    const r = snapshot();
    if (r.refused) {
      console.error(`拒绝重锚:当前台账过不了旧锚(${r.violations.map((v) => `${v.file}:${v.status}`).join(" ")})——先查明再谈重锚,violation 行已落`);
      process.exit(1);
    }
    if (r.skipped.length) console.error(`⚠ 跳过 ${r.skipped.length} 账(读不到):${r.skipped.join(", ")}`);
    console.log(`已快照 ${r.rows.length} 账 → ${anchorFileFor(repoRootOf())}`);
    process.exit(r.rows.length ? 0 : 1);           // 零账快照不是成功(codex 108:静默 0 账退出 0 已堵)
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
      "/TN", "custodiet-anchor-" + repoKeyOf(repoRootOf()), "/TR", tr], { stdio: "inherit" });
    console.log("已装每日 05:33 计划任务(每用户级,agent 会话外执行;任务名带仓键防同名仓覆盖;" +
      "node/仓路径固化——移动仓或换 node 安装位后须重跑本命令)");
    process.exit(0);
  }
  console.error("用法: snapshot | verify | install-task | --self-test");
  process.exit(2);
}
