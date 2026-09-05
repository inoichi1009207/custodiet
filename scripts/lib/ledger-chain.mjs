// ledger-chain.mjs —— JSONL 台账**完整性告警** + 呈签件**截断检测**(D1+D28,批 102 实现)
//
// 规范权威 = clipboard/prompts/101-ledger-chain-design.md(v2,经 codex 四眼 13 条全采纳);
// 本头注只记实现者须知的判据,不复述设计动机。
//
// **定性(一字不许放大)**:完整性告警,不是防伪/鉴伪/认证——
//   · 担保:链内改写、插入、非尾部删行 ⇒ verify 必红;
//   · 明确不担保:完整后缀删除/回退到旧前缀(前缀自洽,文件内前向链在结构上发现不了,
//     codex 内存复现;外部锚归 D51)、蓄意重写(能写台账的人能重算整链)。
//   · 正向探针钉住不担保面:自测里「完整尾删后 verify 通过」是**断言为真**的用例,
//     防未来有人误以为它担保了。
//
// 格式:
//   · 链记录 = 原 JSON 记录 + 末字段 `h`(完整 64 hex);
//     h = sha256(prevH + bodyBytes),bodyBytes = 不含 h 的 JSON.stringify 的 UTF-8 字节;
//   · verify 从盘上**原始行字节**剥末尾 h 字段还原 body,**不 parse→stringify**(那是规范化,
//     空白改动会被吞);
//   · 链首 = 版本化 genesis 真 JSON 行 {"genesis":"v1","enabled":"<日期>","h":sha256("GENESIS"+日期)}
//     (JSONL 没有注释这回事);
//   · require-chain:首个链记录前可有 legacy 旧行(不担保、不重写);首个链记录必须是 genesis;
//     零链记录 / 重复 genesis / 链开始后无 h 行 ⇒ 违例退出 1。
//   · TORN-TAIL = 物理末行未以 LF 完整终止——只描述文件形态,不推断成因。
//
// 并发:追加按文件加锁(mkdir 原子锁,陈锁 10s 判失主可夺)覆盖「读尾→算 h→追加」全临界区;
//   两个并发追加者读到同一 prevH ⇒ 第二条必断链,锁就是防这个的。
// 追加读尾:从末 4KB 反向分块直至取得完整末行(--fp 理由无上限,固定 4KB 会截坏)。
//
// 呈签件尾标(stamp/check):
//   · 尾标行 `⏹ SIGN-CHECK LINES:<N> SHA256:<64hex>`;正文 = 尾标行之前的全部内容;
//   · LINES = 正文为空时 0,否则 1 + 正文中 LF 数;摘要 = sha256(正文 UTF-8);
//   · 归一:仅 CRLF/CR→LF,其余(尾空格/Unicode/BOM)一律不动
//     ——复制中的尾空格裁剪/硬换行会表现为摘要失败,**安全的假阴性**(CEILING);
//   · stamp 幂等替换唯一尾标;正文中出现可识别为尾标的独立行 ⇒ 拒(嵌套尾标是
//     「截断回旧尾标照样通过」的成因,codex 复现);stamp 后内部自跑一次 check;
//   · check 只证明**被检查的那份文件**完整;经聊天/终端渲染中转的文本不在担保内,
//     回退到旧的完整 stamped 版本检不出(要外部锚,D51 族)。
//
// 用法:
//   node --no-warnings scripts/lib/ledger-chain.mjs verify <file.jsonl>
//   node --no-warnings scripts/lib/ledger-chain.mjs stamp <file.md>
//   node --no-warnings scripts/lib/ledger-chain.mjs check <file.md>
//   node --no-warnings scripts/lib/ledger-chain.mjs --self-test
// 退出码:0=过 1=违例/校验失败 2=用法错
// CALIBRATED=false。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const H_RE = /"h":"([0-9a-f]{64})"\}$/;

// ── 锁(mkdir 原子;陈锁按 mtime 判失主) ─────────────────────────────────────
const LOCK_STALE_MS = 10_000;
const LOCK_TRIES = 250;           // × 20ms ≈ 5s 上限
function withLock(file, fn) {
  const lock = file + ".lock";
  for (let i = 0; i < LOCK_TRIES; i++) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; }
      } catch { /* 锁在竞态中消失 ⇒ 直接重试 */ }
      if (i === LOCK_TRIES - 1) throw new Error(`锁超时:${lock}(陈锁未过期或持有者过慢)`);
      const until = Date.now() + 20;
      while (Date.now() < until) { /* 忙等 20ms:同步上下文没有 sleep,追加临界区极短 */ }
    }
  }
  try { return fn(); }
  finally { try { fs.rmdirSync(lock); } catch { /* 释放失败留给陈锁回收 */ } }
}

/** 从末 4KB 反向分块读,返回最后一个**完整**行(以 LF 终止的最后一行;文件不以 LF 结尾时,
 *  末尾撕裂片段不算行,返回它之前的完整行)。文件空/无完整行 ⇒ null。 */
export function readLastCompleteLine(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    let buf = Buffer.alloc(0);
    let pos = size;
    while (pos > 0) {
      const step = Math.min(4096, pos);
      pos -= step;
      const chunk = Buffer.alloc(step);
      fs.readSync(fd, chunk, 0, step, pos);
      buf = Buffer.concat([chunk, buf]);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // text 末尾若非 \n,最后一段是撕裂片段;丢弃后从后往前找非空完整行
      const complete = text.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
      for (let i = complete.length - 1; i >= 0; i--) {
        if (complete[i].trim()) {
          // 首行可能被分块截了头:只有当我们已读到文件头,或该行不是缓冲首行时才可信
          if (pos === 0 || i > 0) return complete[i];
          break;              // 该行可能不完整,继续向前读
        }
      }
    }
    return null;
  } finally { fs.closeSync(fd); }
}

/** 剥掉链记录行末尾的 h 字段,还原 bodyBytes(字节级,不 parse→stringify)。
 *  非链行(无末位 h)⇒ null。 */
export function stripH(rawLine) {
  const m = H_RE.exec(rawLine);
  if (!m) return null;
  const cut = rawLine.slice(0, m.index);           // 去掉 `"h":"…"}` 之后剩 `…{,` 或 `…,`
  if (cut === "{") return { body: "{}", h: m[1] }; // 空记录形态 {"h":"…"}
  if (cut.endsWith(",")) return { body: cut.slice(0, -1) + "}", h: m[1] };
  return null;                                     // h 不在末位/形态不合 ⇒ 不算链行
}

const genesisH = (enabled) => sha256("GENESIS" + enabled);

/** 追加一条链记录。record 不得自带 h;首次链写自动先落 genesis 行。
 *  失败一律抛错——**调用方必须出声**(LEDGER-WRITE-FAILED),不许静默吞。 */
export function ledgerAppend(file, record) {
  if (record && Object.prototype.hasOwnProperty.call(record, "h")) {
    throw new Error("record 不得自带保留字段 h");
  }
  return withLock(file, () => {
    let prevH = null;
    let prefix = "";
    const last = readLastCompleteLine(file);
    if (last) {
      const s = stripH(last);
      if (s) prevH = s.h;
    }
    let exists = false;
    try { exists = fs.statSync(file).size > 0; } catch { /* 不存在 */ }
    if (prevH === null) {
      // 尾行无链 ⇒ 要么纯 legacy/空文件(开链:先落 genesis),要么链后混入无 h 行
      // (verify 的违例面;此处照样从 genesis 之后最近链行接——但反向找链行代价不定,
      //  保守做法:开新 genesis 会造成重复 genesis 违例 ⇒ 先全读一次找最后链行)。
      let lastChainH = null;
      if (exists) {
        try {
          for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            const s = stripH(line.trim());
            if (s) lastChainH = s.h;
          }
        } catch { /* 读不了按无链处理 */ }
      }
      if (lastChainH) {
        prevH = lastChainH;                        // 链存在但尾行被 legacy 污染:verify 会红,链本身不再添乱
      } else {
        const enabled = new Date().toISOString().slice(0, 10);
        const g = `{"genesis":"v1","enabled":"${enabled}","h":"${genesisH(enabled)}"}`;
        prefix = (exists && !fileEndsWithLF(file) ? "\n" : "") + g + "\n";
        prevH = genesisH(enabled);
      }
    }
    const body = JSON.stringify(record);
    const h = sha256(Buffer.concat([Buffer.from(prevH, "utf8"), Buffer.from(body, "utf8")]));
    const line = body === "{}" ? `{"h":"${h}"}` : body.slice(0, -1) + `,"h":"${h}"}`;
    fs.appendFileSync(file, prefix + line + "\n");
    return h;
  });
}

function fileEndsWithLF(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (!size) return true;
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      return b[0] === 0x0a;
    } finally { fs.closeSync(fd); }
  } catch { return true; }
}

/** 验链。返回 { ok, violations: [{line, kind, detail}], legacyLines, chainLines }。 */
export function verifyFile(file) {
  const v = [];
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    return { ok: false, violations: [{ line: 0, kind: "UNREADABLE", detail: String(e && e.message) }], legacyLines: 0, chainLines: 0 };
  }
  const torn = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n");
  if (raw.endsWith("\n")) lines.pop();
  let state = "legacy";
  let prevH = null;
  let legacyLines = 0, chainLines = 0;
  lines.forEach((line, i) => {
    const n = i + 1;
    const isLast = i === lines.length - 1;
    if (torn && isLast) { v.push({ line: n, kind: "TORN-TAIL", detail: "物理末行未以 LF 完整终止(只描述形态,不推断成因)" }); return; }
    if (!line.trim()) {
      if (state === "chain") v.push({ line: n, kind: "NO-H-AFTER-CHAIN", detail: "链区出现空行" });
      return;
    }
    const s = stripH(line);
    if (state === "legacy") {
      if (!s) { legacyLines++; return; }
      // 首个链记录必须是 genesis
      let j = null;
      try { j = JSON.parse(line); } catch { /* 下面按坏 genesis 报 */ }
      if (!j || j.genesis !== "v1" || typeof j.enabled !== "string" || j.h !== genesisH(j.enabled)) {
        v.push({ line: n, kind: "BAD-GENESIS", detail: "首个链记录不是合法 genesis" });
        prevH = s.h;                               // 尽力续判后文,避免一处坏掩全文
      } else {
        prevH = j.h;
      }
      state = "chain"; chainLines++;
      return;
    }
    // chain 区
    if (!s) {
      let isG = false;
      try { isG = JSON.parse(line).genesis === "v1"; } catch { /* 非 JSON 也归 NO-H */ }
      v.push({ line: n, kind: isG ? "DUPLICATE-GENESIS" : "NO-H-AFTER-CHAIN", detail: line.slice(0, 60) });
      return;
    }
    let j = null;
    try { j = JSON.parse(line); } catch { v.push({ line: n, kind: "JSON-BAD", detail: line.slice(0, 60) }); return; }
    if (j.genesis === "v1") { v.push({ line: n, kind: "DUPLICATE-GENESIS", detail: "" }); chainLines++; prevH = s.h; return; }
    chainLines++;
    const want = sha256(Buffer.concat([Buffer.from(prevH, "utf8"), Buffer.from(s.body, "utf8")]));
    if (want !== s.h) v.push({ line: n, kind: "CHAIN-BREAK", detail: `期待 ${want.slice(0, 12)}… 实得 ${s.h.slice(0, 12)}…` });
    prevH = s.h;
  });
  if (chainLines === 0) v.push({ line: 0, kind: "CHAIN-MISSING", detail: "全文件零链记录(require-chain 文件不得降级回 legacy)" });
  return { ok: v.length === 0, violations: v, legacyLines, chainLines };
}

// ── 呈签件尾标 ───────────────────────────────────────────────────────────────
const STAMP_RE = /^⏹ SIGN-CHECK LINES:(\d+) SHA256:([0-9a-f]{64})$/;

const normalize = (text) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** 拆正文与尾标。尾标只认**最后一个非空行**;正文中(除该行外)出现尾标形态的独立行 ⇒ nested。 */
function splitStamp(text) {
  const t = normalize(text);
  const lines = t.split("\n");
  let stampIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    if (STAMP_RE.test(lines[i])) stampIdx = i;
    break;
  }
  const bodyLines = stampIdx >= 0 ? lines.slice(0, stampIdx) : lines;
  const nested = bodyLines.some((l) => STAMP_RE.test(l));
  const body = bodyLines.join("\n").replace(/\n$/, "");   // 正文不含与尾标之间的那个换行
  return { body, stampLine: stampIdx >= 0 ? lines[stampIdx] : null, nested };
}

const bodyLineCount = (body) => (body === "" ? 0 : 1 + (body.match(/\n/g) || []).length);

export function stampFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const { body, nested } = splitStamp(raw);
  if (nested) throw new Error("正文中存在可识别为尾标的独立行——嵌套尾标必须先清除(截断回旧尾标即通过的成因)");
  const stamp = `⏹ SIGN-CHECK LINES:${bodyLineCount(body)} SHA256:${sha256(Buffer.from(body, "utf8"))}`;
  fs.writeFileSync(file, body + "\n" + stamp + "\n");
  const chk = checkFile(file);                     // 生成方 stamp 后独立自查(设计稿二.1)
  if (!chk.ok) throw new Error("stamp 后自查未过:" + chk.reason);
  return stamp;
}

export function checkFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    return { ok: false, reason: "读不到文件:" + String(e && e.message) };
  }
  const { body, stampLine, nested } = splitStamp(raw);
  if (!stampLine) return { ok: false, reason: "尾标缺失——不得凭无尾标/被截掉尾标的呈签件继续" };
  if (nested) return { ok: false, reason: "正文含嵌套尾标——拒读(可能是截断回旧尾标的形态)" };
  const m = STAMP_RE.exec(stampLine);
  const wantLines = Number(m[1]);
  const gotLines = bodyLineCount(body);
  if (gotLines !== wantLines) return { ok: false, reason: `行数不符:尾标记 ${wantLines},实得 ${gotLines} ⇒ 截断/增删` };
  const gotSha = sha256(Buffer.from(body, "utf8"));
  if (gotSha !== m[2]) return { ok: false, reason: "摘要不符 ⇒ 正文被改动(或复制过程改了字节;CRLF 之外的归一不做,属安全假阴性)" };
  return { ok: true, reason: "" };
}

// ── 自测(设计稿第 7 款反向探针,全数必红;外加正向钉住不担保面) ─────────────
function selfTest() {
  const os = { tmpdir: () => process.env.TEMP || process.env.TMP || "/tmp" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-st-"));
  const t = [];
  const chk = (name, got, want) => t.push([got === want ? "PASS" : "FAIL", name, `实得 ${got}`]);
  const F = (n) => path.join(dir, n);
  const mk = (n, rows = 3, legacy = 0) => {
    const f = F(n);
    for (let i = 0; i < legacy; i++) fs.appendFileSync(f, JSON.stringify({ old: i }) + "\n");
    for (let i = 0; i < rows; i++) ledgerAppend(f, { i, msg: "行" + i });
    return f;
  };
  const lines = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
  const rewrite = (f, arr) => fs.writeFileSync(f, arr.join("\n") + "\n");
  const kinds = (f) => verifyFile(f).violations.map((x) => x.kind).join(",");

  // 基线:正常链全绿(含 legacy 前缀)
  chk("正常链 verify 过", verifyFile(mk("ok.jsonl", 3, 2)).ok, true);
  chk("legacy 行数照报", verifyFile(F("ok.jsonl")).legacyLines, 2);

  // 反向探针
  { const f = mk("tamper.jsonl"); const L = lines(f); L[2] = L[2].replace('"行1"', '"改"'); rewrite(f, L);
    chk("篡改中间行 ⇒ CHAIN-BREAK", kinds(f).includes("CHAIN-BREAK"), true); }
  { const f = mk("del.jsonl"); const L = lines(f); L.splice(2, 1); rewrite(f, L);
    chk("删中间行 ⇒ CHAIN-BREAK", kinds(f).includes("CHAIN-BREAK"), true); }
  { const f = mk("ins.jsonl"); const L = lines(f); L.splice(2, 0, '{"插":"入","h":"' + "a".repeat(64) + '"}'); rewrite(f, L);
    chk("插行 ⇒ CHAIN-BREAK", kinds(f).includes("CHAIN-BREAK"), true); }
  { const f = mk("noh.jsonl"); fs.appendFileSync(f, '{"裸":"行"}\n');
    chk("链后无 h 行 ⇒ NO-H-AFTER-CHAIN", kinds(f).includes("NO-H-AFTER-CHAIN"), true); }
  { const f = mk("gone.jsonl"); const L = lines(f).filter((l) => !stripH(l)); rewrite(f, L.length ? L : ['{"old":1}']);
    chk("全链删光 ⇒ CHAIN-MISSING(不降级回 legacy)", kinds(f).includes("CHAIN-MISSING"), true); }
  { const f = mk("dupg.jsonl"); const g = lines(f).find((l) => l.includes('"genesis"')); fs.appendFileSync(f, g + "\n");
    chk("重复 genesis ⇒ DUPLICATE-GENESIS", kinds(f).includes("DUPLICATE-GENESIS"), true); }
  { const f = F("long.jsonl"); ledgerAppend(f, { pad: "x".repeat(9000) }); ledgerAppend(f, { after: "长行之后" });
    chk("超 4KB 长行后仍能正确接链", verifyFile(f).ok, true); }
  { const f = mk("torn.jsonl"); fs.appendFileSync(f, '{"半截');
    chk("尾行撕裂 ⇒ TORN-TAIL", kinds(f).includes("TORN-TAIL"), true); }
  { const f = mk("crlf.jsonl"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
    chk("CRLF 混入 ⇒ 违例(字节变了就是变了)", verifyFile(f).ok, false); }
  { const f = mk("blank.jsonl"); fs.appendFileSync(f, "\n\n");
    chk("链区尾空行 ⇒ 违例", verifyFile(f).ok, false); }
  // 并发锁:锁被持有时第二个追加者等;陈锁可夺
  { const f = F("lock.jsonl"); fs.mkdirSync(f + ".lock");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(f + ".lock", old, old);
    ledgerAppend(f, { seized: true });             // 陈锁应被夺,不抛
    chk("陈锁可夺、追加成功", verifyFile(f).ok, true);
    chk("锁已释放", fs.existsSync(f + ".lock"), false); }
  // 正向钉住不担保面
  { const f = mk("taildel.jsonl", 4); const L = lines(f); rewrite(f, L.slice(0, -2));
    chk("**完整尾删后 verify 通过**(按设计不担保,防有人误以为担保了)", verifyFile(f).ok, true); }
  // record 自带 h ⇒ 拒
  { let threw = false; try { ledgerAppend(F("selfh.jsonl"), { h: "x" }); } catch { threw = true; }
    chk("record 自带 h ⇒ 拒写", threw, true); }

  // ── 尾标 ──
  const md = (n, s) => { const f = F(n); fs.writeFileSync(f, s); return f; };
  { const f = md("s1.md", "第一行\n第二行\n"); stampFile(f);
    chk("stamp 后 check 过", checkFile(f).ok, true);
    stampFile(f);                                  // 幂等:二次 stamp 替换不叠加
    chk("二次 stamp 幂等替换(唯一尾标)", (fs.readFileSync(f, "utf8").match(/SIGN-CHECK/g) || []).length, 1);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").slice(1).join("\n"));
    chk("删正文一行 ⇒ check 拒", checkFile(f).ok, false); }
  { const f = md("s2.md", "正文\n"); stampFile(f);
    const t2 = fs.readFileSync(f, "utf8").split("\n"); t2.splice(1, 0, "追加的一行"); fs.writeFileSync(f, t2.join("\n"));
    chk("改正文 ⇒ check 拒(行数/摘要必炸一个)", checkFile(f).ok, false); }
  { const f = md("s3.md", "无尾标正文\n");
    chk("尾标缺失 ⇒ check 拒", checkFile(f).ok, false); }
  { const f = md("s4.md", "正文\n⏹ SIGN-CHECK LINES:1 SHA256:" + "a".repeat(64) + "\n尾巴\n更多\n");
    chk("正文含旧尾标(嵌套)⇒ check 拒", checkFile(f).ok, false);
    let threw = false; try { stampFile(f); } catch { threw = true; }
    chk("嵌套尾标 ⇒ stamp 拒", threw, true); }
  { const f = md("s5.md", "甲\r\n乙\r\n"); stampFile(f);
    chk("CRLF 呈签件:stamp/check 同归一后过", checkFile(f).ok, true); }
  { const f = md("s6.md", ""); stampFile(f);
    chk("空正文 LINES=0 形态成立", checkFile(f).ok, true); }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  let pass = 0;
  for (const [r, n, extra] of t) { console.log(`  ${r}  ${n}${r === "FAIL" ? "  ← " + extra : ""}`); if (r === "PASS") pass++; }
  console.log(`\nledger-chain 自测 ${pass}/${t.length}`);
  return pass === t.length;
}

const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;

if (IS_MAIN) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "--self-test") process.exit(selfTest() ? 0 : 1);
  if (!file || !["verify", "stamp", "check"].includes(cmd)) {
    console.error("用法: verify|stamp|check <file> | --self-test");
    process.exit(2);
  }
  if (cmd === "verify") {
    const r = verifyFile(file);
    console.log(`${file}: legacy ${r.legacyLines} 行(不担保)/ 链 ${r.chainLines} 行`);
    for (const x of r.violations) console.log(`  违例 L${x.line} [${x.kind}] ${x.detail}`);
    console.log(r.ok ? "PASS 链完整(担保边界:不含完整尾删/回退/蓄意,见头注)" : `FAIL ${r.violations.length} 处违例`);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "stamp") {
    try { console.log("已盖:" + stampFile(file)); process.exit(0); }
    catch (e) { console.error("stamp 拒:" + String(e && e.message)); process.exit(1); }
  }
  if (cmd === "check") {
    const r = checkFile(file);
    console.log(r.ok ? "PASS 尾标核对通过(只证本文件;聊天/渲染中转面不担保)" : "FAIL " + r.reason);
    process.exit(r.ok ? 0 : 1);
  }
}
