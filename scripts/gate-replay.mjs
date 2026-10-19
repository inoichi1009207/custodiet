#!/usr/bin/env node
// gate-replay.mjs —— 收尾闸的**误拦通道**:改规则前后两版,在真实转录上回放,看「新增了哪些阻断回合」
//
// 为什么要有(批 266,用户 10-19 签:「我们设计了一堆防漏放,结果误拦了,得不偿失」;ADR 0028 / 265b-D1):
//   红队(_gate-bypass-hunter)按设计找的是「怎样不被拦住」,误拦要靠真实语料才看得出——批 265 用一个比赛用仓
//   2,837 个真实回合回放,才量出直接开阻断会拦 30.7% 的回合。本工具把那次一次性回放做成每次改规则都能跑的默认件:
//   误拦猎手 agent(.claude/agents/_gate-false-block-hunter.md)的固定动作就是跑它、再对「新增阻断」逐条抽样判拦对 / 误拦。
//
// 做什么:
//   · 改前 = `--base <rev>`(缺省 HEAD)时刻的 scripts/hook-stop-closure.mjs + scripts/lib/**,落到 .claude/.gate-replay/<sha8>/(gitignore 面);
//     改后 = 当前工作树。两版的 `run()` 都在**本进程内**直接调(`ctx.entries` 入口,不起子进程、不写临时转录)。
//   · 语料 = 本项目转录目录(~/.claude/projects/<项目名>/*.jsonl,不含子代理转录)+ `--corpus <目录>` 追加的;
//     每个主线 assistant 的 end_turn 是一个回合,截该处之前最多 `--tail` 条条目当转录前缀。
//   · 抽样:全部回合按 `--seed` 洗牌后取前 `--max` 个(缺省 1500;按 mtime 排序会只取到写规则的那个会话 = 拿训练集测,见 hook run() 头注)。
//   · 产出:一屏摘要(阻断回合改前 / 改后、新增 / 解除、按规则分、前 10 条新增样例)+ 全量 JSON(`--out`,缺省 .claude/.gate-replay/last.json)。
//
// 用法:node --no-warnings scripts/gate-replay.mjs [--base <rev>] [--corpus <目录>]... [--max N] [--seed S] [--tail N] [--out 文件]
//       node --no-warnings scripts/gate-replay.mjs --self-test
// 退出码:0 跑完(有没有新增阻断都是 0——判拦对 / 误拦是误拦猎手的活,不是本工具的);2 参数错;3 改前版本取不到;4 语料为空
//
// CEILING(进程内回放的天花板,报告里照抄):
//   · 外部状态**冻结为「无」**:回放前设 STOP_CLOSURE_SELFTEST=1,批目标、批日志基点、P 台账三处读盘一律返回 null
//     (codex 266-r1 §3:不冻结时两版各读一遍磁盘,台账在两次之间变了,同一版规则也能读出「版本差异」)。
//     ⇒ 读数反映的是「无批、无台账」处境下规则本身的变化,不是「那一刻的仓状态下会不会拦」。
//   · 不带 git 事实(P 的 headFacts)⇒ P 走语法回退;**原样装入豁免(vendoredEngine)这条路径根本不在回放覆盖面里**。
//     后台任务载荷、观察档、连拦降级(yielding)也不模拟。P / DP / A / K 这类依赖实时面的规则,读数要打折看。
//   · 每回合只取末尾 `--tail` 条条目,更早的历史证据看不到;解析依赖(tree-sitter,scripts/gate-deps)两版共用主 checkout 那一份,没随基线冻结。
//   · 判「阻断」= finding.block 为真。语料是本人的历史会话:写规则的人与语料同源,新增阻断少不等于对别的仓也少。
//   · **回放面小于闸引擎面**:改前版本只拷 hook-stop-closure.mjs 与 scripts/lib/**——hook-guard.mjs、fp-audit.mjs、gate-deps、本文件自己的改动
//     回放恒为空,只能靠读 diff(误拦猎手回件 a48b3bca 附节二⑤)。
//   · 语料含正在写的会话转录:两次运行之间可用回合数会变,洗牌后入样的回合就换一批;只有语料不动时种子才可复现(同上附节二③)。
//   · 不写真台账:run() 不传 live,台账 / 心跳 / journal 的落盘都在 live 门后(hook-stop-closure.mjs)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });

/** 把回合列表按种子洗牌(mulberry32),取前 max 个。纯函数。 */
export function sampleTurns(turns, max, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const xs = turns.slice();
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs.slice(0, max);
}

/** 一份转录里的回合切点:主线(非 sidechain)assistant 且 stop_reason=end_turn 的条目下标。纯函数。 */
export function turnEnds(entries) {
  const out = [];
  entries.forEach((o, i) => { if (o && o.type === "assistant" && !o.isSidechain && o.message && o.message.stop_reason === "end_turn") out.push(i); });
  return out;
}

const blockIds = (findings) => [...new Set((findings || []).filter((f) => f && f.block).map((f) => f.id))].sort();

/** 两版各跑一遍并比较。runBefore / runAfter = (entries) => findings。纯函数(注入跑法,自测用假的)。 */
export function diffRuns(jobs, runBefore, runAfter) {
  const rows = [];
  for (const j of jobs) {
    let b = null, a = null, err = null;
    try { b = blockIds(runBefore(j.entries)); } catch (e) { err = `改前出错:${String(e && e.message || e).slice(0, 80)}`; }
    try { a = blockIds(runAfter(j.entries)); } catch (e) { err = (err ? err + ";" : "") + `改后出错:${String(e && e.message || e).slice(0, 80)}`; }
    rows.push({ file: j.file, idx: j.idx, text: j.text, before: b, after: a, err });
  }
  const ok = rows.filter((r) => !r.err);
  const added = ok.filter((r) => r.after.length && !r.before.length);
  const removed = ok.filter((r) => r.before.length && !r.after.length);
  // 两边都拦、但拦的规则不同:单列,规则级的新增也要看
  const changed = ok.filter((r) => r.after.length && r.before.length && r.after.join() !== r.before.join());
  const byRule = {};
  for (const r of ok) for (const id of r.after) if (!r.before.includes(id)) byRule[id] = (byRule[id] || 0) + 1;
  return {
    turns: rows.length, errors: rows.filter((r) => r.err).length,
    blockedBefore: ok.filter((r) => r.before.length).length, blockedAfter: ok.filter((r) => r.after.length).length,
    added, removed, changed, newBlocksByRule: byRule, rows,
  };
}

function corpusDirs(extra) {
  const slug = ROOT.replace(/[:\\/]/g, "-");
  const own = path.join(os.homedir(), ".claude", "projects", slug);
  // 去重(同一目录给两次会让回合重复入样)、排序(codex 266-r1 §9)
  return [...new Set([...(fs.existsSync(own) ? [own] : []), ...extra].map((d) => path.resolve(d)))].sort();
}

function collectJobs(dirs, tail) {
  const turns = [];
  const files = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort(); } catch { continue; }   // 排序:抽样只靠种子就能复现(codex 266-r1 §9)
    for (const f of names) files.push(path.join(d, f));
  }
  for (const f of files) {
    let size = 0; try { size = fs.statSync(f).size; } catch { continue; }
    if (size === 0) continue;
    turns.push({ file: f, size });
  }
  return { files: turns, tail };
}

function loadEntries(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行跳过 */ }
  }
  return out;
}

function materializeBase(rev) {
  const sha = git(["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  const dir = path.join(ROOT, ".claude", ".gate-replay", sha.slice(0, 12));
  const marker = path.join(dir, ".complete");
  if (!fs.existsSync(marker)) {
    const list = git(["ls-tree", "-r", "--name-only", sha, "--", "scripts/hook-stop-closure.mjs", "scripts/lib"]).split("\n").filter(Boolean);
    if (!list.includes("scripts/hook-stop-closure.mjs")) throw new Error(`${rev} 里没有 scripts/hook-stop-closure.mjs`);
    for (const rel of list) {
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, execFileSync("git", ["show", `${sha}:${rel}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }));
    }
    fs.writeFileSync(marker, sha + "\n");
  }
  return { sha, hook: path.join(dir, "scripts", "hook-stop-closure.mjs") };
}

async function main(argv) {
  const opt = { base: "HEAD", corpus: [], max: 1500, seed: 20261019, tail: 4000, out: path.join(ROOT, ".claude", ".gate-replay", "last.json") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--base") { opt.base = v; i++; }
    else if (k === "--corpus") { opt.corpus.push(path.resolve(v)); i++; }
    else if (k === "--max") { opt.max = Number(v); i++; }
    else if (k === "--seed") { opt.seed = Number(v); i++; }
    else if (k === "--tail") { opt.tail = Number(v); i++; }
    else if (k === "--out") { opt.out = path.resolve(v); i++; }
    else { console.error(`未知参数 ${k}`); return 2; }
  }
  if (!(opt.max > 0) || !Number.isFinite(opt.seed) || !(opt.tail > 0)) { console.error("--max / --tail 须为正数,--seed 须为数"); return 2; }
  // 冻结外部状态(见 CEILING):两版都按「无批、无台账」读
  process.env.STOP_CLOSURE_SELFTEST = "1";
  let base;
  try { base = materializeBase(opt.base); } catch (e) { console.error(`改前版本取不到:${String(e && e.message || e).slice(0, 200)}`); return 3; }
  const before = await import(pathToFileURL(base.hook).href);
  const after = await import(pathToFileURL(path.join(ROOT, "scripts", "hook-stop-closure.mjs")).href);

  const dirs = corpusDirs(opt.corpus);
  const { files } = collectJobs(dirs, opt.tail);
  // 先列全部回合(只记位置,不留条目),抽样后再按文件分组加载——大语料下不把所有转录同时放进内存
  const all = [];
  for (const f of files) {
    let ents; try { ents = loadEntries(f.file); } catch { continue; }
    for (const idx of turnEnds(ents)) all.push({ file: f.file, idx });
  }
  if (!all.length) { console.error(`语料为空(目录:${dirs.join(" , ") || "无"})`); return 4; }
  const picked = sampleTurns(all, opt.max, opt.seed);
  const byFile = new Map();
  for (const p of picked) { if (!byFile.has(p.file)) byFile.set(p.file, []); byFile.get(p.file).push(p.idx); }
  const jobs = [];
  for (const [file, idxs] of byFile) {
    const ents = loadEntries(file);
    for (const idx of idxs) {
      const prefix = ents.slice(Math.max(0, idx + 1 - opt.tail), idx + 1);
      const last = ents[idx];
      const text = ((last && last.message && last.message.content) || []).filter((c) => c && c.type === "text").map((c) => c.text).join(" ").replace(/\s+/g, " ").slice(0, 160);
      jobs.push({ file, idx, text, entries: prefix });
    }
  }
  const t0 = Date.now();
  const r = diffRuns(jobs, (e) => before.run(null, { entries: e }), (e) => after.run(null, { entries: e }));
  for (const row of r.rows) delete row.entries;
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  const rel = (f) => path.basename(path.dirname(f)) + "/" + path.basename(f).slice(0, 8);
  // 保存抽样清单(file#idx)与出错回合(codex 266-r1 §9 / §11:原先只留错误总数,哪轮出错无从追查)
  const errored = r.rows.filter((x) => x.err).map((x) => ({ file: x.file, idx: x.idx, err: x.err }));
  let worktree = null;
  try { worktree = git(["rev-parse", "HEAD"]).trim() + (git(["status", "--porcelain", "--", "scripts/hook-stop-closure.mjs", "scripts/lib"]).trim() ? "+dirty" : ""); } catch { /* 取不到不影响 */ }
  fs.writeFileSync(opt.out, JSON.stringify({ base: base.sha, after: "worktree", worktree, seed: opt.seed, max: opt.max, tail: opt.tail, corpus: dirs,
    turnsAvailable: all.length, ...r, rows: undefined, added: r.added, removed: r.removed, changed: r.changed, errored,
    picked: jobs.map((j) => `${path.basename(j.file)}#${j.idx}`) }, null, 1));
  const rules = Object.entries(r.newBlocksByRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ") || "无";
  console.log(`gate-replay base=${base.sha.slice(0, 8)} → 工作树:回放 ${r.turns} 回合(可用 ${all.length};语料 ${files.length} 份转录;种子 ${opt.seed};${Math.round((Date.now() - t0) / 1000)} 秒)`);
  console.log(`  阻断回合:改前 ${r.blockedBefore} / 改后 ${r.blockedAfter};新增 ${r.added.length}、解除 ${r.removed.length}、规则变了 ${r.changed.length};出错 ${r.errors}`);
  for (const x of errored.slice(0, 5)) console.log(`  ! ${rel(x.file)}#${x.idx} ${x.err}`);
  console.log(`  新增阻断按规则:${rules}`);
  for (const x of [...r.added, ...r.changed].slice(0, 10)) console.log(`  + ${rel(x.file)}#${x.idx} [${x.before.join(",") || "-"}→${x.after.join(",")}] «${x.text.slice(0, 80)}»`);
  console.log(`  全量:${path.relative(ROOT, opt.out).replace(/\\/g, "/")}`);
  console.log("  CEILING: 外部状态冻结为「无批、无台账」;不带 git 事实(原样装入豁免不在覆盖面)/ 后台任务载荷 / 观察档;每回合只看末尾 --tail 条;P / DP / A / K 读数打折看");
  return 0;
}

function selfTest() {
  let pass = 0, total = 0;
  const chk = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`); };
  const A = (end) => ({ type: "assistant", message: { stop_reason: end ? "end_turn" : null, content: [{ type: "text", text: "x" }] } });
  chk("turnEnds:只认主线 end_turn", turnEnds([A(false), A(true), { ...A(true), isSidechain: true }, { type: "user" }, A(true)]), [1, 4]);
  chk("sampleTurns:同种子可复现、不超量", [sampleTurns([1, 2, 3, 4, 5], 3, 7), sampleTurns([1, 2, 3, 4, 5], 3, 7)].map((x) => x.length), [3, 3]);
  chk("sampleTurns:同种子同结果", JSON.stringify(sampleTurns([1, 2, 3, 4, 5], 5, 7)) === JSON.stringify(sampleTurns([1, 2, 3, 4, 5], 5, 7)), true);
  chk("sampleTurns:是原集合的排列", sampleTurns([1, 2, 3, 4, 5], 5, 9).slice().sort(), [1, 2, 3, 4, 5]);
  const jobs = [1, 2, 3, 4].map((n) => ({ file: "f", idx: n, text: "", entries: [n] }));
  const before = (e) => (e[0] === 2 ? [{ id: "M", block: true }] : e[0] === 4 ? [{ id: "E0", block: true }] : []);
  const after = (e) => (e[0] === 1 ? [{ id: "K0", block: true }] : e[0] === 4 ? [{ id: "E0", block: true }, { id: "S", block: true }] : e[0] === 3 ? [{ id: "C", block: false }] : []);
  const d = diffRuns(jobs, before, after);
  chk("diffRuns:新增 / 解除 / 规则变了", [d.added.map((r) => r.idx), d.removed.map((r) => r.idx), d.changed.map((r) => r.idx)], [[1], [2], [4]]);
  chk("diffRuns:提示项不算阻断", d.rows.find((r) => r.idx === 3).after, []);
  chk("diffRuns:新增按规则计(含两边都拦但多出的规则)", d.newBlocksByRule, { K0: 1, S: 1 });
  const e = diffRuns([{ file: "f", idx: 9, text: "", entries: [] }], () => { throw new Error("boom"); }, () => []);
  chk("diffRuns:一边出错 ⇒ 记出错、不进新增 / 解除", [e.errors, e.added.length, e.removed.length], [1, 0, 0]);
  console.log(`\ngate-replay 自测 ${pass}/${total}`);
  return pass === total ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest());
  main(argv).then((c) => process.exit(c), (e) => { console.error(String(e && e.stack || e).slice(0, 400)); process.exit(1); });
}
