// 束缚面触发史事件流(036 批,决策载体 clipboard/prompts/036-constraint-standing-review.md)。
//
// 存在理由:031 批要判「C25 这条条款是不是没人执行」,只能靠**人力翻会话记录现挖**
// (`clipboard/031-scan-realdeny.mjs` 就是那次的一次性考古脚本),挖出执行率 0/6。
// 换一条条款就得重挖一次。本工装把触发史变成**常设产物,自动累积**。
//
// ── 本模块的姿态:只记事实,判不了的一律说判不了 ────────────────────────
//
// 规范权威在 docs/constraint-register.md 章程(宪法附件;2026-08-17 大修自 AGENTS.md 迁入),本文件只是它的执行面,
// **不复述、不放宽**。凡「能不能裁撤」类判断一律 fail-closed:**判不了就报 UNKNOWN**,
// 绝不给出可被当成放行依据的绿。
// 本模块产出的结论**只是免签裁撤的必要条件之一**——入册须亲签(该节第二条)、
// 承重八族与 proxy 一律仍需亲签(第四条 / 第五条第三档),那几道闸不在本文件里。
//
// ── 契约(不变量,改实现不得改这几条)────────────────────────────────────
//
//   I1 两层分离 —— 事件流分两层,**写入端不得声明「真拦」**:
//        · raw 层(原始事实):deny / allow / heartbeat / comply / violate / bypass_suspect。
//          钩子只知道「发生了 deny」,**不知道拦得对不对**,故不许写裁决词。
//        · adj 层(裁决):真拦 / 误拦 / 绕闸,带裁决者身份与时间,另行追加。
//      (r1-4:原设计让 --record 直接收 `--kind 真拦`,等于写入者兼任事实裁判。)
//
//   I2 只增不改 —— 两层都只追加;任何路径不得改写或删除既有行。
//      追加走 **lockfile 串行**(r2-5:只读批可并行、多支钩子可能同刻写,
//      「单机单用户所以无需并发安全」不成立——它防的是竞态与崩溃,不是防篡改)。
//
//   I3 generation(世代)—— 台账首行是 genesis 行,带 generation id 与 started_at。
//      **观察窗口不得早于当前 generation 的起点。**
//      清盘后下一次写入会建新 generation ⇒ 旧历史**永久 UNKNOWN**,
//      且新 generation 必须重新积满完整窗口才可用。
//      (r2-5:光靠「文件缺失 / seq 断裂」检不出「清盘后从 seq=1 重建」——
//       报告看到的是一个完整的新文件,既不缺失也不断裂。)
//
//   I4 多对多映射 —— raw 事件带 `ids: []`(一次拒绝可能同时触及多条条款);
//      裁决按 **(raw_seq, id)** 配对。**同一配对出现冲突裁决 ⇒ 该 id 判 UNKNOWN。**
//      (r2-2:原设计到裁决时才绑 id,未裁决事件究竟让哪条 UNKNOWN 无法机械回答。)
//
//   I5 写批时钟(2026-08-03 用户亲签定义)——
//      **写批 = 落账产生 ≥1 commit 的批;只读批不入分母。**
//      载体取号、两查重跑次数**均不作数**(它们与写批不一一对应:只读规划也取号、
//      不经 kplan/tplan 的写会话可能没号、两查可能重跑)。
//      ⇒ 覆盖率判据:**批边界由 heartbeat 划定,不由 commit 划定**——一个写批可产生多个
//        commit(036 本身就落了两个)。判据 = **每个 commit 之前必须至少有过一条 heartbeat**。
//        它检出的是真正该检出的事:**某个会话没跑开工两查就直接落账**。
//      **残余局限(登记不处置)**:挂在 session-triage 尾部的 heartbeat 只证明两查跑过,
//      **不证明 hook-guard / hook-tplan-permission 各支仪器在线**(r2-1 后半)。
//      来源级覆盖(按条款的预期仪器集合逐支判)尚未做,故本模块只判「有没有人值守」,
//      不判「哪支仪器在线」。
//
//   I6 两类条款的可裁证据**极性相反**(2026-08-03 用户亲签分两套)——
//      **有闸条款**(instrument=gate):证据 = `零真拦`。
//      **无闸条款**(instrument=checker):永远不产生真拦(没有闸在检查它),
//        证据 = **持续零遵守** = 连续 10 个写批内 `comply=0` 且 `violate≥1`。
//        `unknown` 与 `n/a` **不入分母**。
//      **proxy(代理指标)**:单独不足以支撑免签裁撤,一律判「需亲签」。
//      依据:C25 被裁的真实理由是执行率 0/6(零遵守),与「零真拦」极性相反;
//      照搬会让「没有闸」本身成为裁撤理由。
//
// ── 用法 ────────────────────────────────────────────────────────────
//
//   --record-raw --kind <deny|allow|heartbeat|comply|violate|bypass_suspect>
//                [--ids C-01,C-04] --tool <t> --target <s> [--session <id>]
//                [--source <仪器名>] [--evidence <一行>]
//   --adjudicate --raw-seq <n> --id <C-id> --verdict <真拦|误拦|绕闸> --by <裁决者> [--reason <一行>]
//   --report [--since YYYY-MM-DD]   逐 id 计数 + 写批覆盖率(I5)+ 未裁决数 + 逐 id 结论
//   --backfill                      补历史(话术字面匹配;**永不证明仪器在线**)
//   --self-test
//
//   环境变量 CONSTRAINT_EVENTS_LEDGER 覆盖台账路径(自测用)。
//
// ── backfill 的已知局限(硬性纪律 8:降级要写进文档,不许假装解决)──────
//   靠**拒绝话术字面**匹配历史会话 jsonl,话术一改就失灵;
//   且 backfill **永远不能证明「仪器在线」**——它不产生 heartbeat,不参与覆盖判定。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER = path.join(REPO_ROOT, "clipboard", "constraint-events.jsonl");

const RAW_KINDS = new Set(["deny", "allow", "heartbeat", "comply", "violate", "bypass_suspect"]);
const VERDICTS = new Set(["真拦", "误拦", "绕闸"]);
// 需要裁决才能计入结论的 raw 种类。comply/violate 由检查器直接产出,是自明事实。
const NEEDS_ADJ = new Set(["deny", "allow", "bypass_suspect"]);
// 「持续零遵守」的窗口长度(写批数),与复议节拍 N=10 同步。
const SUSTAINED_BATCHES = 10;

const ledgerPath = () => process.env.CONSTRAINT_EVENTS_LEDGER || DEFAULT_LEDGER;

// ---------- 串行追加(I2)----------

function withLock(file, fn) {
  const lock = file + ".lock";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 5000;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, "wx"); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 陈旧锁兜底:超过 30 秒的锁视为持有者已死
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.unlinkSync(lock); continue; }
      } catch { /* 锁刚被别人删掉,重试 */ }
      if (Date.now() > deadline) throw new Error(`constraint-events: 取锁超时(${lock})`);
    }
  }
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

// ---------- 读 ----------

export function readLedger(file = ledgerPath()) {
  const problems = [];
  if (!fs.existsSync(file)) return { ok: false, rows: [], generation: null, problems: [`台账文件不存在:${file}(清盘或换机?)`] };
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    return { ok: false, rows: [], generation: null, problems: [`台账读不出:${e.message}`] };
  }
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { problems.push(`第 ${i + 1} 行不是合法 JSON,已跳过`); }
  }
  // genesis(I3)
  const genesis = rows.find((r) => r.layer === "genesis");
  if (!genesis) problems.push("缺 genesis 行——无法确定 generation 起点,历史不可信");
  if (rows.length && rows[0].layer !== "genesis") problems.push("首行不是 genesis 行(台账可能被前缀截断)");
  // seq 连续性
  const seqs = rows.map((r) => r.seq).filter(Number.isInteger).sort((a, b) => a - b);
  if (seqs.length !== rows.length) problems.push("有行缺 seq 字段");
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] === seqs[i - 1]) problems.push(`seq 重复:${seqs[i]}`);
    else if (seqs[i] !== seqs[i - 1] + 1) problems.push(`seq 断裂:${seqs[i - 1]} → ${seqs[i]}`);
  }
  return { ok: problems.length === 0, rows, generation: genesis || null, problems };
}

const nextSeq = (rows) => rows.reduce((m, r) => (Number.isInteger(r.seq) && r.seq > m ? r.seq : m), 0) + 1;

// ---------- 写 ----------

function ensureGenesis(file) {
  // 调用方须已持锁
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) return;
  const gen = `g${Date.now().toString(36)}-${process.pid.toString(36)}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    layer: "genesis", seq: 1, ts: new Date().toISOString(), generation: gen,
    note: "本行标记一个新世代。清盘/换机后重建 ⇒ 新世代 ⇒ 旧历史永久 UNKNOWN,新世代须重新积满窗口(I3)。",
  }) + "\n", "utf8");
}

export function recordRaw({ kind, ids, tool, target, session, source, evidence }, file = ledgerPath()) {
  if (!RAW_KINDS.has(kind)) {
    throw new Error(`recordRaw: kind 必须是 ${[...RAW_KINDS].join("|")},收到「${kind}」。` +
      `裁决词(真拦/误拦/绕闸)属 adj 层,写入端不得声明(契约 I1)。`);
  }
  return withLock(file, () => {
    ensureGenesis(file);
    const { rows, generation } = readLedger(file);
    const row = {
      layer: "raw", seq: nextSeq(rows), ts: new Date().toISOString(),
      generation: generation ? generation.generation : null,
      kind,
      ids: Array.isArray(ids) ? ids : ids ? String(ids).split(",").map((s) => s.trim()).filter(Boolean) : [],
      tool: tool || null, target: target || null, session: session || null,
      source: source || "manual", evidence: evidence || null,
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    return row;
  });
}

export function adjudicate({ rawSeq, id, verdict, by, reason }, file = ledgerPath()) {
  if (!VERDICTS.has(verdict)) throw new Error(`adjudicate: verdict 必须是 ${[...VERDICTS].join("|")}`);
  if (!by) throw new Error("adjudicate: 缺 --by(裁决者身份是硬要求,匿名裁决不予承认)");
  if (!id) throw new Error("adjudicate: 缺 --id(裁决按 (raw_seq, id) 配对,契约 I4)");
  return withLock(file, () => {
    const { rows, generation } = readLedger(file);
    const target = rows.find((r) => r.layer === "raw" && r.seq === Number(rawSeq));
    if (!target) throw new Error(`adjudicate: 找不到 raw seq=${rawSeq}`);
    const row = {
      layer: "adj", seq: nextSeq(rows), ts: new Date().toISOString(),
      generation: generation ? generation.generation : null,
      raw_seq: Number(rawSeq), id, verdict, by, reason: reason || null,
    };
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    return row;
  });
}

// ---------- 写批时钟(I5)----------

/** 窗口内的写批 = 产生 commit 的批。返回 [{sha, ts}],按时间升序。只读批不产生 commit,自然不入分母。 */
export function writeBatches({ sinceTs, repo = REPO_ROOT } = {}) {
  const args = ["log", "--format=%H %ct"];
  if (sinceTs) args.push(`--since=${Math.floor(sinceTs / 1000)}`);
  const r = spawnSync("git", args, { windowsHide: true, cwd: repo, encoding: "utf8" });
  if (r.status !== 0) return null;                       // 取不到 ⇒ 调用方判 UNKNOWN
  return (r.stdout || "").split(/\r?\n/).filter(Boolean).map((l) => {
    const [sha, ct] = l.split(/\s+/);
    return { sha: sha.slice(0, 7), ts: Number(ct) * 1000 };
  }).reverse();
}

/**
 * 覆盖率:**批边界由 heartbeat 划定,不由 commit 划定**。
 *
 * 一个写批可以产生**多个 commit**(036 批本身就落了两个),所以判据不能是
 * 「每两个 commit 之间要有一条心跳」——那会把同一批的第二个 commit 误报成无值守
 * (2026-08-03 接上真数据后实撞,当场修正)。
 *
 * 正确判据:**每个 commit 之前必须至少有过一条 heartbeat**(在窗口内)。
 * 它检出的是真正该检出的那件事:**某个会话没跑开工两查就直接落账**。
 *
 * 返回 { ok, commits, batches, uncovered: [sha] };取不到 git 数据时 ok=false(fail-closed)。
 */
export function batchCoverage(rows, { sinceTs, repo = REPO_ROOT } = {}) {
  const commits = writeBatches({ sinceTs, repo });
  if (!commits) return { ok: false, commits: 0, batches: 0, uncovered: [], note: "git log 取不到,覆盖率不可判" };
  const hb = rows.filter((r) => r.layer === "raw" && r.kind === "heartbeat" && r.ts)
    .map((r) => Date.parse(r.ts)).sort((a, b) => a - b);
  const uncovered = commits.filter((c) => !hb.some((h) => h <= c.ts)).map((c) => c.sha);
  // 批数 = 有 commit 归属的 heartbeat 段数(同段内的多个 commit 算一个批)
  const segs = new Set();
  for (const c of commits) {
    const owner = hb.filter((h) => h <= c.ts).pop();
    segs.add(owner === undefined ? `none:${c.sha}` : String(owner));
  }
  return { ok: true, commits: commits.length, batches: segs.size, uncovered, note: null };
}

/**
 * 写批窗口:把「最近 n 个写批」折算成一个起始时间戳(2026-08-11 增量审计 F5 修)。
 *
 * **治的病**:免签裁撤的条件二写的是「连续 n 个**写批**内调用数 = 0」,而它点名的仪器
 * `tool-usage-census.mjs` 只有 `--since <日期>` —— **条件的单位与仪器的单位对不上**。
 * 中间那一步过去只能由人手工折算(`docs/tool-register.md` 曾写死「起算点 = 2026-08-11」),
 * 而「靠印象折算」正是工具面退役章程(docs/tool-register.md)开篇要消灭的那件事。
 * 折算逻辑放本模块而不是放 census:写批时钟只此一处实现,改语义只改这一个文件。
 *
 * **口径与 `batchCoverage()` 一致**:批边界由 heartbeat 划定,不由 commit 划定
 * (一个写批可产生多个 commit)。批的起点 = 该批那条 heartbeat 的时刻;
 * 无 heartbeat 归属的 commit 自成一批,起点取该 commit 自身时刻。
 *
 * **fail-closed(本函数的全部要点)**:台账不可信 / git 取不到 / 世代内写批不足 n 个
 * ⇒ `ok:false`,调用方一律判 UNKNOWN。**「窗口凑不满」绝不得读作「窗口内零使用」**
 * —— 零使用是免签裁撤的唯一证据,这个方向的假阴性会把在用的工具裁掉。
 *
 * 返回 { ok, sinceTs, batches, total, commits, generation, note }。
 */
export function writeBatchWindow({ n, file = ledgerPath(), repo = REPO_ROOT } = {}) {
  const count = Number(n);
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, note: `写批数须为正整数,收到「${n}」` };
  }
  const { ok: ledgerOk, rows, generation, problems } = readLedger(file);
  if (!ledgerOk) {
    return { ok: false, note: `台账不可信,写批边界不可判:${problems.slice(0, 2).join(" / ")}` };
  }
  const commits = writeBatches({ repo });
  if (!commits) return { ok: false, note: "git log 取不到,写批时钟不可判" };

  // I3:世代起点之前的历史永久 UNKNOWN,不得计入窗口。
  //
  // **genesis 时间戳不可解析 ⇒ 判 UNKNOWN,不得退回「全部 commit」**
  // (2026-08-11 独立复核实撞:原写法 `Number.isFinite(genStart) ? filter : commits` 是
  // **fail-open**——世代起点一坏,窗口反而变成全历史,与本函数注释承诺的
  // 「台账不可信即 UNKNOWN」正好相反,且方向上会把窗口撑宽、让使用数看起来更足)。
  // `readLedger()` 只校验 genesis 行**在不在**,不校验它的 `ts` 好不好,故此处必须自查。
  const genStart = generation ? Date.parse(generation.ts) : NaN;
  if (!Number.isFinite(genStart)) {
    return { ok: false, note: `genesis 行的时间戳不可解析(「${generation?.ts}」),世代起点不可判` };
  }
  const inGen = commits.filter((c) => c.ts >= genStart);

  const hb = rows
    .filter((r) => r.layer === "raw" && r.kind === "heartbeat" && r.ts)
    .map((r) => Date.parse(r.ts))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const byOwner = new Map();
  for (const c of inGen) {
    const owner = hb.filter((h) => h <= c.ts).pop();
    const key = owner === undefined ? `none:${c.sha}` : String(owner);
    if (!byOwner.has(key)) byOwner.set(key, { start_ts: owner ?? c.ts, commits: [] });
    byOwner.get(key).commits.push(c.sha);
  }
  const batches = [...byOwner.values()].sort((a, b) => a.start_ts - b.start_ts);

  if (batches.length < count) {
    return {
      ok: false,
      total: batches.length,
      note:
        `世代内只积到 ${batches.length} 个写批,不足 ${count} 个 —— 窗口未满,` +
        `按 I3 判 UNKNOWN(新世代须重新积满完整窗口),不得读作零使用`,
    };
  }
  const win = batches.slice(-count);
  return {
    ok: true,
    sinceTs: win[0].start_ts,
    batches: win.length,
    total: batches.length,
    commits: win.flatMap((b) => b.commits),
    generation: generation?.generation ?? null,
    note: null,
  };
}

// ---------- 报告 ----------

export function buildReport({ since, file = ledgerPath(), registry = null, coverage = null } = {}) {
  const { ok, rows, generation, problems } = readLedger(file);

  // I3:窗口不得早于 generation 起点
  const genStart = generation ? Date.parse(generation.ts) : null;
  let cutoff = since ? Date.parse(since + "T00:00:00Z") : null;
  const windowNotes = [];
  if (genStart && (cutoff === null || cutoff < genStart)) {
    if (cutoff !== null && cutoff < genStart) {
      windowNotes.push(`--since 早于当前世代起点,已上抬到 ${generation.ts}(I3:旧世代历史永久 UNKNOWN)`);
    }
    cutoff = genStart;
  }
  const inWindow = (r) => !cutoff || (r.ts && Date.parse(r.ts) >= cutoff);

  const raw = rows.filter((r) => r.layer === "raw" && inWindow(r));
  const adj = rows.filter((r) => r.layer === "adj" && inWindow(r));

  // (raw_seq, id) → 裁决集合(I4:冲突 ⇒ UNKNOWN)
  const adjByPair = new Map();
  for (const a of adj) {
    const k = `${a.raw_seq}|${a.id}`;
    if (!adjByPair.has(k)) adjByPair.set(k, []);
    adjByPair.get(k).push(a);
  }

  const ids = new Map();
  const touch = (id) => {
    if (!ids.has(id)) ids.set(id, {
      id, deny: 0, allow: 0, comply: 0, violate: 0, bypass_suspect: 0,
      真拦: 0, 误拦: 0, 绕闸: 0, unadjudicated: 0, conflicts: 0,
    });
    return ids.get(id);
  };
  if (registry) for (const r of registry) touch(r.id);

  let orphans = 0;
  for (const r of raw) {
    if (r.kind === "heartbeat") continue;
    const targets = r.ids && r.ids.length ? r.ids : null;
    if (!targets) { orphans++; continue; }
    for (const id of targets) {
      const rec = touch(id);
      rec[r.kind] = (rec[r.kind] || 0) + 1;
      if (!NEEDS_ADJ.has(r.kind)) continue;
      const list = adjByPair.get(`${r.seq}|${id}`) || [];
      const distinct = new Set(list.map((a) => a.verdict));
      if (list.length === 0) rec.unadjudicated += 1;
      else if (distinct.size > 1) rec.conflicts += 1;
      else rec[[...distinct][0]] += 1;
    }
  }

  const hbBySource = {};
  for (const r of raw) if (r.kind === "heartbeat") hbBySource[r.source || "?"] = (hbBySource[r.source || "?"] || 0) + 1;

  // 写批时钟与覆盖率(I5)。coverage 可注入,仅自测用——生产路径一律现算。
  const cov = coverage || batchCoverage(rows, { sinceTs: cutoff });

  const regById = new Map((registry || []).map((r) => [r.id, r]));
  for (const rec of ids.values()) {
    const reasons = [];
    if (!ok) reasons.push("台账不可信(见 PROBLEM 行)");
    if (!cov.ok) reasons.push(cov.note);
    else if (cov.uncovered.length) reasons.push(`${cov.uncovered.length} 个写批无 heartbeat 值守:${cov.uncovered.join(",")}`);
    if (orphans) reasons.push(`有 ${orphans} 条 raw 事件未绑定任何条款 id(孤儿事件)`);
    if (rec.unadjudicated > 0) reasons.push(`未裁决 raw 事件 ${rec.unadjudicated} 条`);
    if (rec.conflicts > 0) reasons.push(`同一 (raw_seq,id) 存在冲突裁决 ${rec.conflicts} 处(I4)`);

    const reg = regById.get(rec.id);
    const kind = reg ? reg.instrument : null;

    if (!reg) {
      reasons.push("该 id 不在寄存器内(未入册 ⇒ 不适用免签裁撤)");
      rec.verdict = "UNKNOWN";
    } else if (kind === "proxy") {
      // 代理指标单独不足以支撑免签裁撤,永远走亲签(宪法第五节第三档)
      rec.verdict = "需亲签";
      rec.reasons = ["仪器为代理指标(proxy),单独不足以支撑免签裁撤,一律需亲签", ...reasons];
      continue;
    } else if (reasons.length) {
      rec.verdict = "UNKNOWN";
    } else if (kind === "gate") {
      // (A) 有闸条款:零真拦
      rec.verdict = rec["真拦"] === 0 ? "可议裁撤(零真拦)" : "有真拦,不可裁";
    } else if (kind === "checker") {
      // (B) 无闸条款:持续零遵守 = 连续 10 个写批内 comply=0 且 violate>=1
      if (cov.batches < SUSTAINED_BATCHES) {
        rec.verdict = "UNKNOWN";
        rec.reasons = [`窗口内写批仅 ${cov.batches} 个,不足 ${SUSTAINED_BATCHES} 个,「持续零遵守」尚不可判`, ...reasons];
        continue;
      }
      rec.verdict = rec.comply === 0 && rec.violate >= 1 ? "可议裁撤(持续零遵守)" : "仍在被遵守,不可裁";
    } else {
      reasons.push(`寄存器 instrument=「${kind}」不是 gate/checker/proxy,判不了`);
      rec.verdict = "UNKNOWN";
    }
    rec.reasons = reasons;
  }

  return {
    ok, problems, windowNotes, generation: generation ? generation.generation : null,
    windowFrom: cutoff ? new Date(cutoff).toISOString() : null,
    heartbeatBySource: hbBySource, orphans, coverage: cov,
    ids: [...ids.values()], rawCount: raw.length, adjCount: adj.length,
  };
}

function printReport(rep) {
  console.log(`LEDGER ok=${rep.ok} generation=${rep.generation || "-"} raw=${rep.rawCount} adj=${rep.adjCount} 孤儿=${rep.orphans}`);
  for (const p of rep.problems) console.log(`  PROBLEM ${p}`);
  for (const n of rep.windowNotes) console.log(`  WINDOW ${n}`);
  console.log(`WINDOW_FROM ${rep.windowFrom || "(全量)"}`);
  const hb = Object.entries(rep.heartbeatBySource).map(([k, v]) => `${k}=${v}`).join(" ") || "(无)";
  console.log(`HEARTBEAT 按来源计数 ${hb}`);
  const c = rep.coverage;
  console.log(
    c.ok
      ? `COVERAGE commit ${c.commits} 个 → 写批 ${c.batches} 个(批边界由 heartbeat 划定),无值守 commit ${c.uncovered.length} 个` +
        `${c.uncovered.length ? " → " + c.uncovered.join(",") : ""}`
      : `COVERAGE UNKNOWN —— ${c.note}`,
  );
  console.log(`  ↳ 局限:两查尾部的心跳只证明「有人值守」,不证明各支仪器在线(来源级覆盖未做)。`);
  if (!rep.ids.length) console.log("(无 id 级事件)");
  for (const r of rep.ids) {
    console.log(
      `ID ${r.id} deny=${r.deny} allow=${r.allow} comply=${r.comply} violate=${r.violate} ` +
      `绕闸?=${r.bypass_suspect} 真拦=${r["真拦"]} 误拦=${r["误拦"]} 绕闸=${r["绕闸"]} ` +
      `未裁决=${r.unadjudicated} 冲突=${r.conflicts} ⇒ ${r.verdict}`,
    );
    for (const why of r.reasons) console.log(`    ↳ ${why}`);
  }
}

// ---------- backfill ----------

const GUARD_MARKS = ["内容写入唯一入口=write-node API", "该命令显式推向 origin", "该命令未写远端"];

export function backfill({ dir, file = ledgerPath() } = {}) {
  const sessDir = dir || path.join(os.homedir(), ".claude", "projects", path.resolve(REPO_ROOT).replace(/[^A-Za-z0-9]/g, "-"));   // 由本 checkout 的根换算(同 lib/write-checks.mjs 的 projectDirName),不写死项目目录名
  if (!fs.existsSync(sessDir)) return { scanned: 0, added: 0, note: `会话目录不存在:${sessDir}` };
  let scanned = 0, added = 0;
  for (const f of fs.readdirSync(sessDir).filter((x) => x.endsWith(".jsonl"))) {
    scanned++;
    let text;
    try { text = fs.readFileSync(path.join(sessDir, f), "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || !GUARD_MARKS.some((m) => line.includes(m))) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (!c || c.type !== "tool_result") continue;
        const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        if (!GUARD_MARKS.some((m) => body.includes(m))) continue;
        recordRaw({ kind: "deny", ids: [], tool: "(backfill 未知)", target: "(backfill 未知)",
          session: f.slice(0, 8), source: "backfill", evidence: body.slice(0, 120) }, file);
        added++;
      }
    }
  }
  return { scanned, added, note: "靠拒绝话术字面匹配,话术一改即失灵;**永不证明仪器在线**;补进来的事件无 ids ⇒ 计入孤儿 ⇒ 推 UNKNOWN" };
}

// ---------- self-test ----------

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cev-"));
  let pass = 0, fail = 0;
  const t = (n, c) => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}`); } };
  const L = (n) => path.join(tmp, n + ".jsonl");

  t("① 台账不存在 ⇒ ok=false(I3-a 清盘防线)", readLedger(L("a")).ok === false);

  let threw = false;
  try { recordRaw({ kind: "真拦", tool: "x", target: "y" }, L("b")); } catch { threw = true; }
  t("② raw 层拒收裁决词「真拦」(I1)", threw);

  const b = L("c");
  recordRaw({ kind: "deny", ids: ["C-99"], tool: "Write", target: "content/private/x.mdx", source: "hook-guard" }, b);
  const r1 = readLedger(b);
  t("③ 首次写入自动建 genesis 行(I3)", r1.ok === true && r1.rows[0].layer === "genesis" && !!r1.generation);
  t("④ raw 行带 generation 且 ids 是数组(I3/I4)", r1.rows[1].generation === r1.generation.generation && Array.isArray(r1.rows[1].ids));

  const rep1 = buildReport({ file: b });
  const rec1 = rep1.ids.find((x) => x.id === "C-99");
  t("⑤ 有未裁决 raw ⇒ UNKNOWN", rec1 && rec1.verdict === "UNKNOWN" && rec1.unadjudicated === 1);

  adjudicate({ rawSeq: 2, id: "C-99", verdict: "误拦", by: "self-test" }, b);
  const rec2 = buildReport({ file: b }).ids.find((x) => x.id === "C-99");
  t("⑥ 裁决后 未裁决=0 且 误拦=1", rec2 && rec2.unadjudicated === 0 && rec2["误拦"] === 1);
  t("⑦ 即便全部裁决完,覆盖率不可判 ⇒ 仍 UNKNOWN(I5,刻意的)", rec2 && rec2.verdict === "UNKNOWN");

  // I4 冲突裁决
  adjudicate({ rawSeq: 2, id: "C-99", verdict: "真拦", by: "self-test-2" }, b);
  const rec3 = buildReport({ file: b }).ids.find((x) => x.id === "C-99");
  t("⑧ 同一 (raw_seq,id) 冲突裁决被检出(I4)", rec3 && rec3.conflicts === 1);

  // I4 多对多
  const d = L("d");
  recordRaw({ kind: "deny", ids: ["C-01", "C-04"], tool: "Bash", target: "rm -rf", source: "hook" }, d);
  const rep4 = buildReport({ file: d });
  t("⑨ 一条事件可同时归属多条条款(I4)", rep4.ids.length === 2 && rep4.ids.every((x) => x.deny === 1));

  // I3 世代:清盘重建看得出来
  const e = L("e");
  recordRaw({ kind: "allow", ids: ["C-01"], tool: "x", target: "y" }, e);
  const gen1 = readLedger(e).generation.generation;
  fs.unlinkSync(e);                                     // ← 模拟清盘
  recordRaw({ kind: "allow", ids: ["C-01"], tool: "x", target: "y" }, e);
  const gen2 = readLedger(e).generation.generation;
  t("⑩ 清盘重建 ⇒ 新世代(旧历史永久 UNKNOWN,I3)", gen1 !== gen2);

  // I3 窗口不得早于世代起点
  const rep5 = buildReport({ file: e, since: "2000-01-01" });
  t("⑪ --since 早于世代起点被上抬(不能靠 --since 把不利事件截到窗口外)", rep5.windowNotes.length === 1);

  // ── I6:两套极性(2026-08-03 亲签)──
  const COV_OK = { ok: true, commits: 14, batches: 12, uncovered: [], note: null };   // 覆盖干净、写批够 12 个
  const COV_THIN = { ok: true, commits: 3, batches: 3, uncovered: [], note: null };  // 写批不足 10 个

  // (A) 有闸条款:零真拦 ⇒ 可议裁撤
  const f = L("f");
  recordRaw({ kind: "allow", ids: ["C-G"], tool: "hook", target: "x", source: "hook-guard" }, f);
  adjudicate({ rawSeq: 2, id: "C-G", verdict: "误拦", by: "self-test" }, f);
  const gA = buildReport({ file: f, registry: [{ id: "C-G", instrument: "gate" }], coverage: COV_OK }).ids.find((x) => x.id === "C-G");
  t("㉑ (A) 有闸条款零真拦 ⇒ 可议裁撤", gA && gA.verdict === "可议裁撤(零真拦)");

  // (A) 反向:有真拦 ⇒ 不可裁(用干净台账,免得 seq 与上一用例纠缠)
  const f2 = L("f2");
  const denyRow = recordRaw({ kind: "deny", ids: ["C-G2"], tool: "hook", target: "x", source: "hook-guard" }, f2);
  adjudicate({ rawSeq: denyRow.seq, id: "C-G2", verdict: "真拦", by: "self-test" }, f2);
  const gA2 = buildReport({ file: f2, registry: [{ id: "C-G2", instrument: "gate" }], coverage: COV_OK }).ids.find((x) => x.id === "C-G2");
  t("㉒ (A) 反向:有真拦 ⇒ 不可裁", gA2 && gA2.verdict === "有真拦,不可裁");

  // (B) 无闸条款:持续零遵守 ⇒ 可议裁撤
  const g2 = L("g2");
  recordRaw({ kind: "violate", ids: ["C-C"], tool: "checker", target: "报告首节", source: "checker:real" }, g2);
  const regC = [{ id: "C-C", instrument: "checker" }];
  const cB = buildReport({ file: g2, registry: regC, coverage: COV_OK }).ids.find((x) => x.id === "C-C");
  t("㉓ (B) 无闸条款持续零遵守(comply=0 且 violate≥1)⇒ 可议裁撤", cB && cB.verdict === "可议裁撤(持续零遵守)");

  // (B) 反向:有人遵守 ⇒ 不可裁
  recordRaw({ kind: "comply", ids: ["C-C"], tool: "checker", target: "报告首节", source: "checker:real" }, g2);
  const cB2 = buildReport({ file: g2, registry: regC, coverage: COV_OK }).ids.find((x) => x.id === "C-C");
  t("㉔ (B) 反向:窗口内有 comply ⇒ 仍在被遵守,不可裁", cB2 && cB2.verdict === "仍在被遵守,不可裁");

  // (B) 写批不足 ⇒ 判不了(「持续」的持续性是硬要求)
  const cB3 = buildReport({ file: g2, registry: regC, coverage: COV_THIN }).ids.find((x) => x.id === "C-C");
  t("㉕ (B) 写批不足 10 个 ⇒ UNKNOWN(「持续」不可省)",
    cB3 && cB3.verdict === "UNKNOWN" && cB3.reasons.some((r) => r.includes("持续零遵守")));

  // proxy 永远需亲签
  const cP = buildReport({ file: g2, registry: [{ id: "C-C", instrument: "proxy" }], coverage: COV_OK }).ids.find((x) => x.id === "C-C");
  t("㉖ proxy 代理指标 ⇒ 一律需亲签(不进免签域)", cP && cP.verdict === "需亲签");

  // 未入册 ⇒ 不适用免签
  const cN = buildReport({ file: g2, registry: [], coverage: COV_OK }).ids.find((x) => x.id === "C-C");
  t("㉗ 未入册的 id ⇒ UNKNOWN(不适用免签裁撤)",
    cN && cN.verdict === "UNKNOWN" && cN.reasons.some((r) => r.includes("不在寄存器")));

  // 写批无值守 ⇒ UNKNOWN(即便条件都满足)
  const covGap = { ok: true, commits: 13, batches: 12, uncovered: ["abc1234"], note: null };
  const cG = buildReport({ file: g2, registry: regC, coverage: covGap }).ids.find((x) => x.id === "C-C");
  t("㉘ 有写批无 heartbeat 值守 ⇒ UNKNOWN(压过一切结论)", cG && cG.verdict === "UNKNOWN");

  // 批边界由 heartbeat 划定:同一批的多个 commit 不该各要一条心跳
  {
    const k = L("k");
    recordRaw({ kind: "heartbeat", tool: "session-triage", target: "GREEN", source: "session-triage" }, k);
    const rowsK = readLedger(k).rows;
    const hbTs = Date.parse(rowsK.find((r) => r.kind === "heartbeat").ts);
    const fakeCommits = [{ sha: "aaa1111", ts: hbTs + 1000 }, { sha: "bbb2222", ts: hbTs + 2000 }];
    const hb = [hbTs];                               // 不改全局,直接算一遍等价逻辑
    const uncovered = fakeCommits.filter((c) => !hb.some((h) => h <= c.ts)).map((c) => c.sha);
    const segs = new Set(fakeCommits.map((c) => String(hb.filter((h) => h <= c.ts).pop())));
    t("㉙ 一条心跳 + 同批两个 commit ⇒ 零无值守、批数=1(不把同批第二个 commit 误报)",
      uncovered.length === 0 && segs.size === 1);
    // 反向:心跳之前就落的 commit ⇒ 无值守(检出「没跑两查就落账」)
    const early = [{ sha: "ccc3333", ts: hbTs - 1000 }];
    t("㉚ 反向:心跳之前落的 commit ⇒ 判无值守(=没跑开工两查就落账)",
      early.filter((c) => !hb.some((h) => h <= c.ts)).length === 1);
  }

  // 孤儿事件
  const g = L("g");
  recordRaw({ kind: "deny", ids: [], tool: "x", target: "y", source: "backfill" }, g);
  recordRaw({ kind: "deny", ids: ["C-02"], tool: "x", target: "y" }, g);
  const rep7 = buildReport({ file: g });
  t("⑬ 未绑定条款的事件计入孤儿并推 UNKNOWN", rep7.orphans === 1 &&
    rep7.ids.find((x) => x.id === "C-02").reasons.some((r) => r.includes("孤儿")));

  t("⑭ adjudicate 拒匿名", (() => { try { adjudicate({ rawSeq: 2, id: "C-02", verdict: "真拦" }, g); return false; } catch { return true; } })());
  t("⑮ adjudicate 拒缺 id(裁决须按 (raw_seq,id) 配对,I4)",
    (() => { try { adjudicate({ rawSeq: 2, verdict: "真拦", by: "x" }, g); return false; } catch { return true; } })());

  const before = fs.readFileSync(g, "utf8");
  recordRaw({ kind: "allow", ids: ["C-02"], tool: "x", target: "y" }, g);
  t("⑯ 只增不改(既有内容是新内容的前缀,I2)", fs.readFileSync(g, "utf8").startsWith(before));

  t("⑰ 追加后锁文件已清理(I2)", !fs.existsSync(g + ".lock"));

  // seq 断裂
  fs.appendFileSync(g, JSON.stringify({ layer: "raw", seq: 99, ts: new Date().toISOString(), kind: "allow", ids: [] }) + "\n");
  t("⑱ seq 断裂 ⇒ ok=false", readLedger(g).ok === false);

  // 前缀截断:首行不是 genesis
  const h = L("h");
  fs.writeFileSync(h, JSON.stringify({ layer: "raw", seq: 5, ts: new Date().toISOString(), kind: "allow", ids: [] }) + "\n");
  const rh = readLedger(h);
  t("⑲ 前缀被截断(首行非 genesis)⇒ ok=false(I3)", rh.ok === false && rh.problems.some((p) => p.includes("genesis")));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`SELFTEST PASS=${pass} FAIL=${fail}`);
  console.log(`PROBED_AT=${new Date().toISOString()}`);
  return fail === 0 ? 0 : 1;
}

// ---------- CLI ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

  if (argv.includes("--help") || argv.length === 0) {
    console.log([
      "束缚面触发史事件流(036 批)",
      "",
      "  --record-raw --kind <deny|allow|heartbeat|comply|violate|bypass_suspect>",
      "               [--ids C-01,C-04] --tool <t> --target <s> [--session <id>]",
      "               [--source <仪器>] [--evidence <一行>]",
      "  --adjudicate --raw-seq <n> --id <C-id> --verdict <真拦|误拦|绕闸> --by <裁决者> [--reason <一行>]",
      "  --report [--since YYYY-MM-DD]",
      "  --backfill        补历史(话术字面匹配,一改即失灵;**永不证明仪器在线**)",
      "  --self-test",
      "",
      "硬约束(改实现不得改):",
      "  · raw 层不收裁决词——钩子只知道发生了 deny,不知道拦得对不对(I1)。",
      "  · 追加走 lockfile 串行;只增不改(I2)。",
      "  · 台账带 generation;清盘重建 ⇒ 新世代,旧历史永久 UNKNOWN;",
      "    --since 早于世代起点会被上抬(不能靠它把不利事件截到窗口外)(I3)。",
      "  · 事件按 ids[] 多对多映射;同一 (raw_seq,id) 冲突裁决 ⇒ UNKNOWN(I4)。",
      "  · 覆盖率按**写批**(=产生 commit 的批)判:每个 commit 前须有 heartbeat 值守;两查尾部的心跳",
      "    只证明有人值守,**不证明各支仪器在线**(来源级覆盖未做,I5)。",
      "  · 两套极性(I6):gate 看「零真拦」,checker 看「持续零遵守」,proxy 一律需亲签。",
      "",
      "⇒ 本工装只出必要条件之一;入册亲签、承重八族、proxy 三道闸不在本文件,原章程见存档 docs/archive/laws-2026-11/constraint-register-charter.md(2026-11-05 退役)。",
    ].join("\n"));
    process.exit(0);
  }

  try {
    if (argv.includes("--self-test")) process.exit(selfTest());
    if (argv.includes("--record-raw")) {
      const row = recordRaw({
        kind: flag("--kind"), ids: flag("--ids"), tool: flag("--tool"), target: flag("--target"),
        session: flag("--session"), source: flag("--source"), evidence: flag("--evidence"),
      });
      console.log(`RECORDED seq=${row.seq} kind=${row.kind} ids=${row.ids.join(",") || "-"} gen=${row.generation}`);
      process.exit(0);
    }
    if (argv.includes("--adjudicate")) {
      const row = adjudicate({ rawSeq: flag("--raw-seq"), id: flag("--id"), verdict: flag("--verdict"), by: flag("--by"), reason: flag("--reason") });
      console.log(`ADJUDICATED seq=${row.seq} raw_seq=${row.raw_seq} id=${row.id} ${row.verdict}`);
      process.exit(0);
    }
    if (argv.includes("--backfill")) {
      const r = backfill();
      console.log(`BACKFILL scanned=${r.scanned} added=${r.added}`);
      console.log(`  NOTE ${r.note}`);
      process.exit(0);
    }
    if (argv.includes("--report")) { printReport(buildReport({ since: flag("--since") })); process.exit(0); }
    console.error("未知参数;看 --help");
    process.exit(2);
  } catch (e) {
    console.error(`ERROR ${e.message}`);
    process.exit(2);
  }
}
