#!/usr/bin/env node
// gate-replay.mjs —— 收尾闸的**误拦通道**:改规则前后两版,在真实转录上回放,看「新增了哪些阻断回合」
//
// 为什么要有(批 266,用户 10-19 签:「我们设计了一堆防漏放,结果误拦了,得不偿失」;ADR 0028 / 265b-D1):
//   红队(_gate-bypass-hunter)按设计找的是「怎样不被拦住」,误拦要靠真实语料才看得出——批 265 用一个比赛用仓
//   2,837 个真实回合回放,才量出直接开阻断会拦 30.7% 的回合。本工具把那次一次性回放做成每次改规则都能跑的默认件:
//   误拦猎手 agent(用户级 ~/.claude/agents/_gate-false-block-hunter.md,权威在 my-dotfiles)的固定动作就是跑它、再对「新增阻断」逐条抽样判拦对 / 误拦。
//
// 做什么:
//   · 改前 = `--base <rev>`(工具缺省 HEAD;误拦猎手不许靠缺省——批内已提交时 HEAD 对工作树恒为零新增,P 也不认)时刻的 scripts/hook-stop-closure.mjs + scripts/lib/**,落到 .claude/.gate-replay/<sha8>/(gitignore 面);
//     改后 = 当前工作树。两版的 `run()` 走 `ctx.entries` 入口直接调(不写临时转录)。
//     批 308 起**缺省按转录分子进程串行跑**(见 CEILING「分进程」);`--in-process` 回到原来的单进程跑法(自测拿它当对照组)。
//   · 语料 = 本项目转录目录(~/.claude/projects/<项目名>/*.jsonl,不含子代理转录)+ `--corpus <目录>` 追加的;
//     每个主线 assistant 的 end_turn 是一个回合,截该处之前最多 `--tail` 条条目当转录前缀。
//   · 抽样:全部回合按 `--seed` 洗牌后取前 `--max` 个(缺省 1500;按 mtime 排序会只取到写规则的那个会话 = 拿训练集测,见 hook run() 头注)。
//   · 产出:一屏摘要(阻断回合改前 / 改后、新增 / 解除、按规则分、前 10 条新增样例)+ 全量 JSON(`--out`,缺省 .claude/.gate-replay/run-<时刻>-<pid>.json,另抄 last.json)。
//
// 用法:node --no-warnings scripts/gate-replay.mjs [--base <rev> | --base=<rev>] [--corpus <目录>]... [--max N] [--seed S] [--tail N] [--out 文件] [--in-process]
//       node --no-warnings scripts/gate-replay.mjs --self-test
//       (`--worker <job 文件>` 是父进程起子进程用的内部入口,不手敲)
// 退出码:0 跑完(有没有新增阻断都是 0——判拦对 / 误拦是误拦猎手的活,不是本工具的);2 参数错;3 改前版本取不到;4 语料为空;
//         5 回放失败、读数作废(子进程非零退出 / 回件对不上 / 转录在枚举后变了 / 有超大转录,消息里点名是哪份)
//
// CEILING(进程内回放的天花板,报告里照抄):
//   · 外部状态**冻结为「无」**:回放前设 STOP_CLOSURE_SELFTEST=1,批目标、批日志基点、P 台账三处读盘一律返回 null
//     (codex 266-r1 §3:不冻结时两版各读一遍磁盘,台账在两次之间变了,同一版规则也能读出「版本差异」)。
//     ⇒ 读数反映的是「无批、无台账」处境下规则本身的变化,不是「那一刻的仓状态下会不会拦」。
//   · 新证据(预检台账、git 索引、末次提交新增文件)取一次、两版共用;**改前版本早于批 266 时**它不认注入,仍各读一遍(codex 266-r2 §6)。
//   · 不带 git 事实(P 的 headFacts)⇒ P 走语法回退;**原样装入豁免(vendoredEngine)这条路径根本不在回放覆盖面里**。
//     后台任务载荷、观察档、连拦降级(yielding)也不模拟。P / DP / A / K 这类依赖实时面的规则,读数要打折看。
//   · 每回合只取末尾 `--tail` 条条目,更早的历史证据看不到;解析依赖(tree-sitter,scripts/gate-deps)两版共用主 checkout 那一份,没随基线冻结。
//   · 判「阻断」= finding.block 为真。语料是本人的历史会话:写规则的人与语料同源,新增阻断少不等于对别的仓也少。
//   · **回放面小于闸引擎面**:只回放 Stop 规则,改前版本只拷 hook-stop-closure.mjs 与 scripts/lib/**——hook-guard.mjs、fp-audit.mjs、gate-deps、本文件自己的改动,
//     以及批 276 起并入闸引擎面的远端守卫三件(hook-remote-check.mjs / install-git-hooks.mjs / git-hooks/*.mjs)和开工闸 hook-start-gate.mjs,
//     回放恒为空,只能靠读 diff 与各自的自测(误拦猎手回件 a48b3bca 附节二⑤;批 285 D174⑥ 补远端守卫一句)。
//   · 语料目录:本 checkout 与主树(git-common-dir 的父目录)两处的项目转录目录都进缺省语料(批 285 D174⑥:原先 worktree 里缺省语料为空)。
//   · 语料含正在写的会话转录:两次运行之间可用回合数会变,洗牌后入样的回合就换一批;只有语料不动时种子才可复现(同上附节二③)。
//   · 不写真台账:run() 不传 live,台账 / 心跳 / journal 的落盘都在 live 门后(hook-stop-closure.mjs)。
//   · (原「MF 在 detect 里直接读此刻盘面上那条 memory 的全文」一条:MF 已于批 308 删除,它的核对早在批 301 挪进了 --clear 的写入类取证,
//     回放面不再有读盘面正文的 Stop 规则。)
//   · **P 的跨模型格在回放里是盲的**(批 297):该格只认 codex-run 的作业记录(ctx.codexJobs),回放进程设了 STOP_CLOSURE_SELFTEST=1,
//     hook 不读作业目录 ⇒ codexJobs 冻结为未接 ⇒ 该格只剩 MCP 通路;改这一格的判据,回放的「新增 / 解除」读数不作数,只能靠夹具与 live 探针。
//   · **「修闸 tag」零覆盖**(批 279):回放里 `gateTouched` 恒为 undefined ⇒ P 的 selfTouched 恒真 ⇒ 修闸 tag 与 PF 一条都回放不到,
//     只能靠读 diff、hook 自测与内存探针(误拦猎手 279 终版附节二 4)。
//   · **安装方名单不冻结**(批 305):W 的部署脚本文件名、DP 的私仓仓名来自本 checkout 根的 gate-install.json(deployScripts / privateRepos)。
//     回放器读一次、注入两版(`installNames`);它是随仓提交的配置,不是台账那类两次读之间会变的状态。读到的是**今天**的名单,套在历史回合上。
//     本 checkout 没有这份文件(闸仓自己就没有)或没写这两个键 ⇒ 两个空名单 ⇒ 改后版本里 W 的部署脚本那一支不响、DP 的私仓短路不生效;
//     改前版本早于批 305 时不认这个键(它按一族名字认)⇒ 那种对比读数量的是「按一族认 → 按名单认」,名单为空时就是「按一族认 → 这一支关掉」。
//     要量「安装方的判决变没变」,得在装了闸、带着真实名单的安装方 checkout 里回放。摘要里有一行报两份名单各几个名字。
//   · 输出:缺省写 `.claude/.gate-replay/run-<时刻>-<pid>.json` 并抄一份到 last.json;并发时 last.json 只留最后写的那次,以摘要里「全量:」那行的路径为准(批 279)。
//   · **分进程**(批 308;单进程在内存紧的机器上涨到 4–5 GB 跑不完):父进程流式枚举全部回合(只留「哪份转录第几条」)、
//     按种子洗牌取前 max 个(与单进程同一个 sampleTurns、同一份候选次序)、取一次新证据与安装方名单,再按转录分组
//     (派活顺序 = 单进程的 byFile 顺序),**同一时刻只起一个子进程**;子进程流式读自己那组转录,只留最近 tail 条 + 余量,
//     到抽中的回合就两版各跑一遍,回件写文件;父进程逐行核对(份数、回合数、下标、顺序、字段形状)后按派活顺序拼起来再汇总。
//     子进程非零退出 / 回件解析不了或对不上 ⇒ 整次以退出码 5 失败、点名转录,不当成「这份没有阻断」。
//     限度:①等价靠「两版 run() 不改写传入的条目」——同一份转录里子进程按下标升序跑、单进程按抽样次序跑,
//       相邻窗口共用同一批条目对象;探针(4 份转录 36 回合,前后各序列化一遍比对)未观测到改写,不是证明。
//     ②规则模块的进程内缓存(git 索引、common-dir 等)单进程全程一份、分进程每个子进程各取一次;
//       回放期间这些盘面变了(别的会话提交、改 memory),两种跑法的读数可能不同——与「语料在写」同类,要可比就别在回放时动它们。
//     ③新证据里的 Set 按数组传、函数(checkoutOf / trackedIn)在子进程里取改后版本自己的同名函数;出现认不出的类型直接报错。
//     ④单个转录超过 V8 字符串上限(约 512 MB)时单进程会静默跳过它、流式读得了 ⇒ 分进程拒绝回放(退出码 5),不让两种跑法的抽样分叉。
//     ⑤内存:子进程峰值主要随 tail 条条目的体积走,不随转录文件大小走;父进程只留下标。摘要与全量 JSON 的 memory 字段报父子各自的
//       maxRSS 峰值(process.resourceUsage)。读数是否与单进程相同,以自测「分进程 ≡ 单进程」与同参数 `--in-process` 对跑为准。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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

/** 回合切点的判据(单进程与分进程两条路径共用这一份)。 */
const isTurnEnd = (o) => !!(o && o.type === "assistant" && !o.isSidechain && o.message && o.message.stop_reason === "end_turn");

/** 一份转录里的回合切点:主线(非 sidechain)assistant 且 stop_reason=end_turn 的条目下标。纯函数。 */
export function turnEnds(entries) {
  const out = [];
  entries.forEach((o, i) => { if (isTurnEnd(o)) out.push(i); });
  return out;
}

/** 回合末条的正文摘要(摘要样例行用)。两条路径共用。 */
const turnText = (last) => ((last && last.message && last.message.content) || []).filter((c) => c && c.type === "text").map((c) => c.text).join(" ").replace(/\s+/g, " ").slice(0, 160);

const blockIds = (findings) => [...new Set((findings || []).filter((f) => f && f.block).map((f) => f.id))].sort();

/** 逐回合两版各跑一遍,只出行(不汇总)。分进程时子进程跑这一步,父进程拼起来再 summarizeRows。 */
export function replayRows(jobs, runBefore, runAfter) {
  const rows = [];
  for (const j of jobs) {
    let b = null, a = null, err = null;
    try { b = blockIds(runBefore(j.entries)); } catch (e) { err = `改前出错:${String(e && e.message || e).slice(0, 80)}`; }
    try { a = blockIds(runAfter(j.entries)); } catch (e) { err = (err ? err + ";" : "") + `改后出错:${String(e && e.message || e).slice(0, 80)}`; }
    rows.push({ file: j.file, idx: j.idx, text: j.text, before: b, after: a, err });
  }
  return rows;
}

/** 两版各跑一遍并比较。runBefore / runAfter = (entries) => findings。纯函数(注入跑法,自测用假的)。 */
export function diffRuns(jobs, runBefore, runAfter) {
  return summarizeRows(replayRows(jobs, runBefore, runAfter));
}

/** 行 ⇒ 摘要。纯函数;行的顺序原样保留(分进程时父进程按派活顺序拼行,顺序与单进程一致)。 */
export function summarizeRows(rows) {
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

// 批 285(D174⑥,工装缺陷):原来只按本 checkout 的根推项目转录目录——在 worktree 里跑时 slug 是 worktree 自己的路径,
//   那个目录往往不存在或只有零星会话 ⇒ 缺省语料为空(退出 4),误拦猎手只能手带 `--corpus`。现在主树根(git-common-dir 的父目录)
//   的转录目录一并纳入;本 checkout 自己的目录在就也留着。主树里跑时两者相同,去重后与原来一致。
export function corpusRoots(root = ROOT) {
  const roots = [root];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    if (common) roots.push(path.dirname(path.resolve(root, common)));
  } catch { /* 不在 git 里:只用本 checkout 的根 */ }
  return roots;
}
export function corpusDirs(extra, roots = corpusRoots(), home = os.homedir(), exists = fs.existsSync) {
  //   slug 另把 `.` 换成 `-`(Claude Code 的项目目录名实见 `example-project--claude-worktrees-…`;主树 `\repo` 不含点,与原来同)
  const own = roots.map((r) => path.join(home, ".claude", "projects", path.resolve(r).replace(/[:\\/.]/g, "-"))).filter((d) => exists(d));
  // 去重(同一目录给两次会让回合重复入样)、排序(codex 266-r1 §9)
  return [...new Set([...own, ...extra].map((d) => path.resolve(d)))].sort();
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

/** 单进程路径的读法(原样保留,`--in-process` 与自测的对照组都走它)。 */
export function loadEntries(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行跳过 */ }
  }
  return out;
}

// ── 分进程路径的流式读法(批 308)──────────────────────────────────────────────
// 必须与 loadEntries **逐条相同**:同样按 "\n" 切(不认 "\r\n",\r 留在行尾,JSON.parse 当空白)、同样跳过 trim 后为空的行、
//   同样跳过 JSON.parse 失败的行、下标只数解析成功的行(JSON 里的 null 也算一条)。
//   按字节找 0x0A 再逐行 Buffer#toString("utf8")(与 readFileSync(…,"utf8") 同一个解码器,不剥 BOM):
//   0x0A 不会出现在 UTF-8 多字节序列里,所以逐行解码与整文件解码逐字符相同(坏字节的替换符也一样)。自测用 1 字节等小块核过。
// V8 单个字符串的长度上限(64 位):单进程路径 readFileSync 读超过它的文件会抛错,被枚举那步的 catch 静默跳过;
//   流式读法读得了 ⇒ 两条路径的可用回合会不一样。分进程路径遇到这么大的文件直接报错退出,不静默分叉(见 CEILING)。
const V8_MAX_STRING = 536870888;
const READ_CHUNK = 8 << 20;

/** 逐行回调,切法等价于 `readFileSync(file,"utf8").split("\n")`(含末尾那段)。onLine 返回 false ⇒ 提前停。 */
export function forEachLine(file, onLine, chunkSize = READ_CHUNK) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let carry = [];
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      const view = buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(10, start);
        if (nl === -1) break;
        const line = carry.length ? Buffer.concat([...carry, view.subarray(start, nl)]).toString("utf8") : view.toString("utf8", start, nl);
        carry = [];
        if (onLine(line) === false) return;
        start = nl + 1;
      }
      if (start < n) carry.push(Buffer.from(view.subarray(start, n)));   // 拷出来:buf 下一轮会被覆盖
    }
    onLine(carry.length ? Buffer.concat(carry).toString("utf8") : "");
  } finally { fs.closeSync(fd); }
}

/** 逐条回调 (entry, 下标),口径与 loadEntries 相同。onEntry 返回 false ⇒ 提前停。 */
export function forEachEntry(file, onEntry, chunkSize = READ_CHUNK) {
  let i = 0;
  forEachLine(file, (line) => {
    if (!line.trim()) return true;
    let o;
    try { o = JSON.parse(line); } catch { return true; /* 半行跳过 */ }
    return onEntry(o, i++);
  }, chunkSize);
}

/** 流式取一份转录的回合切点(只留下标,不留条目)。与 turnEnds(loadEntries(file)) 相同。 */
export function turnEndsOfFile(file, chunkSize = READ_CHUNK) {
  const out = [];
  forEachEntry(file, (o, i) => { if (isTurnEnd(o)) out.push(i); return true; }, chunkSize);
  return out;
}

/** 对一份转录里抽中的回合逐个出 job(按下标升序流过去,只留最近 tail 条 + 一段余量)。
 *  每个 job 的 entries 与单进程的 `ents.slice(max(0, idx+1-tail), idx+1)` 相同、text 相同。
 *  抽中的下标不再是回合结尾(转录在枚举之后被改写)或已不在文件里 ⇒ 抛错(不静默少一个回合)。 */
export function windowJobs(file, idxs, tail, onJob, chunkSize = READ_CHUNK) {
  const want = [...idxs].sort((a, b) => a - b);
  for (let k = 1; k < want.length; k++) if (want[k] === want[k - 1]) throw new Error(`同一回合派了两次:${file}#${want[k]}`);
  const slack = Math.max(1024, Math.min(tail, 4096));
  let buf = [], w = 0, err = null;
  if (want.length) forEachEntry(file, (o, i) => {
    buf.push(o);
    if (buf.length > tail + slack) buf = buf.slice(buf.length - tail);
    if (i === want[w]) {
      if (!isTurnEnd(o)) { err = new Error(`第 ${i} 条已不是回合结尾(枚举之后转录变了?):${file}`); return false; }
      onJob({ file, idx: i, text: turnText(o), entries: buf.slice(Math.max(0, buf.length - tail)) });
      w++;
      if (w === want.length) return false;
    }
    return true;
  }, chunkSize);
  if (err) throw err;
  if (w < want.length) throw new Error(`抽中的第 ${want[w]} 条已不在转录里(枚举之后转录变短了?):${file}`);
}

// ── 两版共用的证据怎么传给子进程 ──────────────────────────────────────────────
// 单进程时 newEvidence 是父进程取一次、全部回合共用的同一个对象;分进程时它要原样到每个子进程。
//   Set ⇒ 数组再还原(保序);函数(checkoutOf / trackedIn,只读盘面的查找)⇒ 子进程里取改后版本自己的同名函数
//   (单进程时两版拿到的也是改后版本的这两个函数);值为 undefined 的键照样保留(`"k" in ev` 不变)。
//   其余只认纯 JSON;认不出的类型 ⇒ 抛错,不猜。
const isPlainJson = (v) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0)) ||
  (Array.isArray(v) && v.every(isPlainJson)) ||
  (typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.values(v).every(isPlainJson));
const encVal = (v, where) => {
  if (v === undefined) return { t: "u" };
  if (v instanceof Set) { const a = [...v]; if (!a.every(isPlainJson)) throw new Error(`${where} 里的 Set 含非 JSON 值,传不了子进程`); return { t: "set", v: a }; }
  if (typeof v === "function") return { t: "fn" };
  if (isPlainJson(v)) return { t: "j", v };
  throw new Error(`${where} 的值类型认不出(${Object.prototype.toString.call(v)}),传不了子进程`);
};
export function encodeShared(ev, names) {
  const evE = ev === undefined ? { t: "u" }
    : (ev && typeof ev === "object" && !Array.isArray(ev)) ? { t: "o", keys: Object.keys(ev).map((k) => [k, encVal(ev[k], `newEvidence.${k}`)]) }
    : (() => { throw new Error("newEvidence 不是对象,传不了子进程"); })();
  return { ev: evE, names: encVal(names, "installNames") };
}
/** localEv = 子进程里改后版本自己 isNewEvidence() 的结果(只从里面取函数)。 */
export function decodeShared(enc, localEv) {
  const dec = (x, k) => {
    if (x.t === "u") return undefined;
    if (x.t === "set") return new Set(x.v);
    if (x.t === "j") return x.v;
    if (x.t === "fn") {
      const f = localEv && localEv[k];
      if (typeof f !== "function") throw new Error(`newEvidence.${k} 是函数,子进程里改后版本没有同名函数可取`);
      return f;
    }
    throw new Error(`传入的共用证据格式坏了(${JSON.stringify(x).slice(0, 60)})`);
  };
  let ev;
  if (enc.ev.t === "u") ev = undefined;
  else if (enc.ev.t === "o") { ev = {}; for (const [k, x] of enc.ev.keys) ev[k] = dec(x, k); }
  else throw new Error("传入的共用证据格式坏了");
  return { ev, names: dec(enc.names, "installNames") };
}

/** 父进程核子进程回件:每份转录、每个回合都要对得上派出去的那份(数目、顺序、下标、字段形状)。认不出 ⇒ 抛错。纯函数。 */
export function checkWorkerResult(group, res) {
  const bad = (why) => { throw new Error(`回件对不上:${why}`); };
  if (!res || res.ok !== true || !Array.isArray(res.files)) bad("不是成功回件");
  if (res.files.length !== group.length) bad(`派了 ${group.length} 份转录,回了 ${res.files.length} 份`);
  const rows = [];
  group.forEach((g, gi) => {
    const f = res.files[gi];
    if (!f || f.file !== g.file) bad(`第 ${gi + 1} 份应是 ${g.file}`);
    if (!Array.isArray(f.rows) || f.rows.length !== g.idxs.length) bad(`${g.file} 派了 ${g.idxs.length} 个回合,回了 ${f.rows ? f.rows.length : "无"}`);
    f.rows.forEach((r, k) => {
      const ids = (x) => x === null || (Array.isArray(x) && x.every((s) => typeof s === "string"));
      if (!r || r.file !== g.file || r.idx !== g.idxs[k]) bad(`${g.file} 第 ${k + 1} 行应是 #${g.idxs[k]}`);
      if (typeof r.text !== "string" || !ids(r.before) || !ids(r.after) || !(r.err === null || typeof r.err === "string")) bad(`${g.file}#${r.idx} 字段形状不对`);
      if (r.err === null && (!Array.isArray(r.before) || !Array.isArray(r.after))) bad(`${g.file}#${r.idx} 没出错却缺判决`);
      rows.push(r);
    });
  });
  return rows;
}

/** 按派活顺序把转录分组:每组一个子进程。分组只影响起几个子进程,不影响读数(各组的规则模块各自从头加载,缓存都只缓存盘面事实)。 */
export function groupFiles(byFile, sizes, { maxFiles = 16, maxBytes = 128 << 20 } = {}) {
  const groups = [];
  let cur = [], bytes = 0;
  for (const [file, idxs] of byFile) {
    const sz = sizes.get(file) || 0;
    if (cur.length && (cur.length >= maxFiles || bytes + sz > maxBytes)) { groups.push(cur); cur = []; bytes = 0; }
    cur.push({ file, idxs });
    bytes += sz;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const SELF = fileURLToPath(import.meta.url);
const mb = (kb) => Math.round(kb / 1024);

/** 起一个子进程跑一组转录。同步(同一时刻只一个子进程)。失败 ⇒ 抛错并点名转录。 */
function runGroup(group, shared, opt, workDir, k) {
  const jobFile = path.join(workDir, `job-${k}.json`), result = path.join(workDir, `result-${k}.json`), progress = path.join(workDir, `progress-${k}.txt`);
  fs.writeFileSync(jobFile, JSON.stringify({ beforeHook: opt.beforeHook, afterHook: opt.afterHook, tail: opt.tail, chunk: opt.chunk, shared, files: group, result, progress }));
  const r = spawnSync(process.execPath, ["--no-warnings", SELF, "--worker", jobFile],
    { cwd: process.cwd(), env: { ...process.env, STOP_CLOSURE_SELFTEST: "1" }, stdio: ["ignore", "inherit", "pipe"], maxBuffer: 16 << 20, windowsHide: true });
  const errTail = r.stderr ? String(r.stderr).trim().split("\n").slice(-6).join(" | ").slice(0, 600) : "";
  if (r.stderr && r.stderr.length && !opt.quietChildStderr) process.stderr.write(r.stderr);
  const names = group.map((g) => g.file).join(" , ");
  const fail = (why) => {
    let at = ""; try { at = fs.readFileSync(progress, "utf8").trim(); } catch { /* 没写到进度 */ }
    const e = new Error(`子进程回放失败(${why});这一组转录:${names}${at ? `;出事时在处理:${at}` : ""}${errTail ? `;子进程 stderr 末尾:${errTail}` : ""}`);
    e.replayFailed = true;
    throw e;
  };
  if (r.error) fail(`起不来或被终止:${r.error.message}`);
  if (r.status !== 0 || r.signal) fail(`退出码 ${r.status}${r.signal ? `、信号 ${r.signal}` : ""}`);
  let res;
  try { res = JSON.parse(fs.readFileSync(result, "utf8")); } catch (e) { fail(`回件读不出或解析不了:${e.message}`); }
  let rows;
  try { rows = checkWorkerResult(group, res); } catch (e) { fail(e.message); }
  for (const f of [jobFile, result, progress]) { try { fs.rmSync(f, { force: true }); } catch { /* 清不掉不影响读数 */ } }
  return { rows, maxRSS: Number(res.maxRSS) || 0 };
}

/** 子进程入口:读 job 文件,逐份转录流式出窗口、两版各跑、回件写文件。 */
async function runWorker(jobFile) {
  process.env.STOP_CLOSURE_SELFTEST = "1";   // 与父进程同一冻结口径(见 CEILING),在加载规则之前设
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const before = await import(pathToFileURL(job.beforeHook).href);
  const after = await import(pathToFileURL(job.afterHook).href);
  const needFn = job.shared.ev.t === "o" && job.shared.ev.keys.some(([, x]) => x.t === "fn");
  const localEv = needFn && typeof after.isNewEvidence === "function" ? after.isNewEvidence(undefined) : undefined;
  const { ev, names } = decodeShared(job.shared, localEv);
  const runB = (e) => before.run(null, { entries: e, newEvidence: ev, installNames: names });
  const runA = (e) => after.run(null, { entries: e, newEvidence: ev, installNames: names });
  const files = [];
  for (const g of job.files) {
    fs.writeFileSync(job.progress, g.file);
    const got = new Map();
    windowJobs(g.file, g.idxs, job.tail, (j) => { got.set(j.idx, replayRows([j], runB, runA)[0]); }, job.chunk || READ_CHUNK);
    files.push({ file: g.file, rows: g.idxs.map((i) => got.get(i)) });
  }
  fs.writeFileSync(job.result, JSON.stringify({ ok: true, files, maxRSS: process.resourceUsage().maxRSS }));
  return 0;
}

/** 回放主体(main 与自测共用)。opt:beforeHook / afterHook(两版 hook 的路径)、dirs、max、seed、tail、inProcess、root、workDir,
 *  另有自测才用的 chunk / group / quietChildStderr。语料为空 ⇒ { empty:true }。 */
export async function replay(opt) {
  const before = await import(pathToFileURL(opt.beforeHook).href);
  const after = await import(pathToFileURL(opt.afterHook).href);
  const { files } = collectJobs(opt.dirs, opt.tail);
  // 先列全部回合(只记位置,不留条目),抽样后再按文件分组加载——大语料下不把所有转录同时放进内存
  const all = [];
  for (const f of files) {
    if (opt.inProcess) {
      let ents; try { ents = loadEntries(f.file); } catch { continue; }
      for (const idx of turnEnds(ents)) all.push({ file: f.file, idx });
    } else {
      if (f.size > V8_MAX_STRING) throw Object.assign(new Error(`转录 ${f.file} 有 ${f.size} 字节,超过单进程路径能读成一个字符串的上限:单进程会静默跳过它,分进程能读——两条路径的抽样会分叉,拒绝回放。把它移出语料目录再跑`), { replayFailed: true });
      let idxs; try { idxs = turnEndsOfFile(f.file, opt.chunk || READ_CHUNK); } catch { continue; }   // 读不了 ⇒ 跳过,与单进程同口径
      for (const idx of idxs) all.push({ file: f.file, idx });
    }
  }
  if (!all.length) return { empty: true, files };
  const picked = sampleTurns(all, opt.max, opt.seed);
  const byFile = new Map();
  for (const p of picked) { if (!byFile.has(p.file)) byFile.set(p.file, []); byFile.get(p.file).push(p.idx); }
  const t0 = Date.now();
  // 新证据(预检台账 / git 索引 / 末次提交新增文件)只取一次,两版共用(codex 266-r2 §6:各取一次时同一版规则也能读出「解除阻断」)。
  //   改前版本若早于本改动(不认 ctx.newEvidence),它那一侧仍会自己读一遍——见 CEILING。分进程时父进程取这一次、原样传给每个子进程。
  const ev = typeof after.isNewEvidence === "function" ? after.isNewEvidence(undefined) : undefined;
  const evShared = typeof before.isNewEvidence === "function";   // 导出与 run 认注入是同一次改动加的,以导出在否作代理
  // 批 305:安装方名单读一次、两版共用(见 CEILING「安装方名单不冻结」)。改后版本没有这个导出(回放一个早于批 305 的工作树)⇒ 不注入。
  const names = typeof after.readInstallNames === "function" ? after.readInstallNames(opt.root) : undefined;
  const namesCount = names ? { deployScripts: names.deployScripts.length, privateRepos: names.privateRepos.length } : null;
  let rows, children = 0, childPeak = null;
  if (opt.inProcess) {
    const jobs = [];
    for (const [file, idxs] of byFile) {
      const ents = loadEntries(file);
      for (const idx of idxs) {
        const prefix = ents.slice(Math.max(0, idx + 1 - opt.tail), idx + 1);
        jobs.push({ file, idx, text: turnText(ents[idx]), entries: prefix });
      }
    }
    rows = replayRows(jobs, (e) => before.run(null, { entries: e, newEvidence: ev, installNames: names }), (e) => after.run(null, { entries: e, newEvidence: ev, installNames: names }));
  } else {
    const shared = encodeShared(ev, names);   // 先编码:传不了就在起子进程之前报错
    const sizes = new Map(files.map((f) => [f.file, f.size]));
    const groups = groupFiles(byFile, sizes, opt.group);
    fs.mkdirSync(opt.workDir, { recursive: true });
    rows = [];
    groups.forEach((g, k) => {
      const out = runGroup(g, shared, opt, opt.workDir, k);
      children++;
      for (const r of out.rows) rows.push(r);
      if (!childPeak || out.maxRSS > childPeak.kb) childPeak = { kb: out.maxRSS, files: g.map((x) => x.file), bytes: g.reduce((s, x) => s + (sizes.get(x.file) || 0), 0) };
    });
    try { fs.rmdirSync(opt.workDir); } catch { /* 非空或已没了:不影响读数 */ }
  }
  if (rows.length !== picked.length) throw Object.assign(new Error(`回放行数 ${rows.length} ≠ 抽中回合数 ${picked.length}`), { replayFailed: true });
  const memory = {
    parentPeakMB: mb(process.resourceUsage().maxRSS),
    ...(opt.inProcess ? {} : { children, childPeakMB: childPeak ? mb(childPeak.kb) : null, childPeakFiles: childPeak ? childPeak.files : [], childPeakBytes: childPeak ? childPeak.bytes : 0 }),
  };
  return { empty: false, files, available: all.length, r: summarizeRows(rows), evShared, namesCount, seconds: Math.round((Date.now() - t0) / 1000), memory, mode: opt.inProcess ? "in-process" : "per-file" };
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
  // 批 279(274 追加节「并发回放互相覆盖」):缺省输出按进程分开,两个猎手同时跑不再互相盖掉;跑完另抄一份到 last.json(并发时它取最后写的那次)
  const opt = { base: "HEAD", corpus: [], max: 1500, seed: 20261019, tail: 4000, out: path.join(ROOT, ".claude", ".gate-replay", `run-${Date.now()}-${process.pid}.json`), outDefault: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k.startsWith("--base=")) { opt.base = k.slice("--base=".length); continue; }   // codex 266-r7 §1:与 P 认的写法对齐
    if (k === "--base") { opt.base = v; i++; }
    else if (k === "--corpus") { opt.corpus.push(path.resolve(v)); i++; }
    else if (k === "--max") { opt.max = Number(v); i++; }
    else if (k === "--seed") { opt.seed = Number(v); i++; }
    else if (k === "--tail") { opt.tail = Number(v); i++; }
    else if (k === "--out") { opt.out = path.resolve(v); opt.outDefault = false; i++; }
    else if (k === "--in-process") opt.inProcess = true;
    else { console.error(`未知参数 ${k}`); return 2; }
  }
  if (!(opt.max > 0) || !Number.isFinite(opt.seed) || !(opt.tail > 0)) { console.error("--max / --tail 须为正数,--seed 须为数"); return 2; }
  // 冻结外部状态(见 CEILING):两版都按「无批、无台账」读(子进程继承这个环境变量,入口里另设一次)
  process.env.STOP_CLOSURE_SELFTEST = "1";
  let base;
  try { base = materializeBase(opt.base); } catch (e) { console.error(`改前版本取不到:${String(e && e.message || e).slice(0, 200)}`); return 3; }
  const dirs = corpusDirs(opt.corpus);
  let res;
  try {
    res = await replay({ beforeHook: base.hook, afterHook: path.join(ROOT, "scripts", "hook-stop-closure.mjs"), dirs, max: opt.max, seed: opt.seed, tail: opt.tail,
      inProcess: opt.inProcess, root: ROOT, workDir: path.join(ROOT, ".claude", ".gate-replay", `work-${Date.now()}-${process.pid}`) });
  } catch (e) {
    if (!e || !e.replayFailed) throw e;
    console.error(`回放失败,读数作废:${String(e.message).slice(0, 1200)}`);
    return 5;
  }
  if (res.empty) { console.error(`语料为空(目录:${dirs.join(" , ") || "无"})`); return 4; }
  const { r, files, evShared, namesCount, memory } = res;
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  const rel = (f) => path.basename(path.dirname(f)) + "/" + path.basename(f).slice(0, 8);
  // 保存抽样清单(file#idx)与出错回合(codex 266-r1 §9 / §11:原先只留错误总数,哪轮出错无从追查)
  const errored = r.rows.filter((x) => x.err).map((x) => ({ file: x.file, idx: x.idx, err: x.err }));
  let worktree = null;
  try { worktree = git(["rev-parse", "HEAD"]).trim() + (git(["status", "--porcelain", "--", "scripts/hook-stop-closure.mjs", "scripts/lib"]).trim() ? "+dirty" : ""); } catch { /* 取不到不影响 */ }
  fs.writeFileSync(opt.out, JSON.stringify({ base: base.sha, after: "worktree", worktree, seed: opt.seed, max: opt.max, tail: opt.tail, corpus: dirs,
    turnsAvailable: res.available, evidenceShared: evShared, installNames: namesCount, ...r, rows: undefined, added: r.added, removed: r.removed, changed: r.changed, errored,
    mode: res.mode, memory,
    picked: r.rows.map((j) => `${j.file}#${j.idx}`),   // 全路径:多语料目录有同名转录时也能唯一反查(codex 266-r2 表)
    // 批 308:每个回合的两版判决(与 picked 同序),分进程与 --in-process 两次的全量文件可逐回合比对
    verdicts: r.rows.map((j) => ({ before: j.before, after: j.after, err: j.err })) }, null, 1));
  if (opt.outDefault) { try { fs.copyFileSync(opt.out, path.join(path.dirname(opt.out), "last.json")); } catch { /* 抄不成不影响本次结果文件 */ } }
  const rules = Object.entries(r.newBlocksByRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ") || "无";
  console.log(`gate-replay base=${base.sha.slice(0, 8)} → 工作树:回放 ${r.turns} 回合(可用 ${res.available};语料 ${files.length} 份转录;种子 ${opt.seed};${res.seconds} 秒)`);
  console.log(`  阻断回合:改前 ${r.blockedBefore} / 改后 ${r.blockedAfter};新增 ${r.added.length}、解除 ${r.removed.length}、规则变了 ${r.changed.length};出错 ${r.errors}`);
  console.log(res.mode === "in-process"
    ? `  跑法:单进程(--in-process);内存峰值 ${memory.parentPeakMB} MB`
    : `  跑法:按转录分 ${memory.children} 个子进程串行跑;内存峰值:父进程 ${memory.parentPeakMB} MB、子进程最高 ${memory.childPeakMB} MB(那组 ${memory.childPeakFiles.length} 份转录共 ${Math.round(memory.childPeakBytes / 1e6)} MB)`);
  for (const x of errored.slice(0, 5)) console.log(`  ! ${rel(x.file)}#${x.idx} ${x.err}`);
  console.log(`  新增阻断按规则:${rules}`);
  for (const x of [...r.added, ...r.changed].slice(0, 10)) console.log(`  + ${rel(x.file)}#${x.idx} [${x.before.join(",") || "-"}→${x.after.join(",")}] «${x.text.slice(0, 80)}»`);
  // 只报个数,不印名字(名字是安装方的私有事实,回放摘要常被整段贴进报告)
  console.log(namesCount
    ? `  安装方名单(本 checkout 根的 gate-install.json,读一次两版共用):部署脚本 ${namesCount.deployScripts} 个、私仓 ${namesCount.privateRepos} 个` +
      (namesCount.deployScripts && namesCount.privateRepos ? "" : ";为 0 的那份 ⇒ 改后版本里对应判据关掉(W 的部署脚本那一支 / DP 的私仓短路)")
    : "  安装方名单:改后版本不认(早于批 305)⇒ 未注入");
  console.log(`  全量:${path.relative(ROOT, opt.out).replace(/\\/g, "/")}`);
  console.log("  CEILING: 外部状态冻结为「无批、无台账」;不带 git 事实(原样装入豁免不在覆盖面)/ 后台任务载荷 / 观察档;每回合只看末尾 --tail 条;P / DP / A / K 读数打折看");
  // codex 266-r3 补充事实:改前版本不认 newEvidence 注入时,它自己读预检台账 / git 索引,同一份规则也能读出假的新增 I——明说,别让人当真
  if (!evShared) console.log("  ⚠ 改前版本早于「新证据注入」接口(批 266):两版的新证据读数不同源,I 等依赖新证据的规则新增 / 解除不可比,按「判不了」处理");
  return 0;
}

async function selfTest() {
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
  // 批 285(D174⑥):worktree 里跑时主树的转录目录也进缺省语料;slug 把 `.` 也换成 `-`;不存在的目录不进
  {
    const H = path.resolve("/h285"), P = (s) => path.join(H, ".claude", "projects", s);
    const seen = new Set([P("E--m"), P("E--m--claude-worktrees-w")]);
    const got = corpusDirs([], [path.resolve("E:/m/.claude/worktrees/w"), path.resolve("E:/m")], H, (d) => seen.has(d)).map((d) => path.basename(d));
    chk("285 D174⑥ corpusDirs:worktree 自己的目录 + 主树目录都进", got, ["E--m", "E--m--claude-worktrees-w"]);
    chk("285 D174⑥ corpusDirs:主树目录缺 ⇒ 只剩存在的", corpusDirs([], [path.resolve("E:/m/x"), path.resolve("E:/m")], H, (d) => seen.has(d)).map((d) => path.basename(d)), ["E--m"]);
    const cr = corpusRoots();
    chk("285 D174⑥ corpusRoots:末项是主树根(含 .git 目录)", cr.length === 1 || fs.existsSync(path.join(cr[cr.length - 1], ".git")), true);
  }
  // 批 308:分进程。夹具全在临时目录;假规则模块用中性写法
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replay-308-"));
  try {
    const W = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
    const T = (text, extra = {}) => JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text }] }, ...extra });
    const U = (text) => JSON.stringify({ type: "user", message: { content: text } });
    // ① 流式读法 ≡ loadEntries:BOM、CRLF、空行、纯空白行、坏行、JSON null、中文 / emoji、坏 UTF-8 字节、末行无换行、末尾半行
    const tricky = Buffer.concat([
      Buffer.from("﻿" + U("头") + "\n" + T("中文 回合 😀") + "\r\n\n   \n{坏行\nnull\n" + U("u2") + "\n"),
      Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xe4, 0xb8, 0x22, 0x7d, 0x0a]),   // {"t":"<截断的三字节>"} 换行
      Buffer.from(T("末回合", { isSidechain: false }) + "\n" + T("旁支", { isSidechain: true }) + "\n" + T("尾") + "\n" + '{"type":"assistant","mess'),
    ]);
    const tf = W(path.join(tmp, "tricky", "t.jsonl"), tricky);
    const ref = loadEntries(tf);
    for (const cs of [1, 2, 3, 7, 64, 1 << 20]) {
      const got = []; forEachEntry(tf, (o) => { got.push(o); return true; }, cs);
      chk(`308 forEachEntry ≡ loadEntries(块 ${cs} 字节)`, JSON.stringify(got) === JSON.stringify(ref) && got.length === ref.length, true);
      chk(`308 turnEndsOfFile ≡ turnEnds(loadEntries)(块 ${cs} 字节)`, turnEndsOfFile(tf, cs), turnEnds(ref));
    }
    // ② 窗口 ≡ 单进程切片:乱序下标、多种 tail(含 1 与超过文件长度)
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(i % 3 === 2 ? T(`回合 ${i}`) : U(`问 ${i}`));
    const wf = W(path.join(tmp, "win", "w.jsonl"), lines.join("\n") + "\n");
    const went = loadEntries(wf), wEnds = turnEnds(went), wPick = [wEnds[5], wEnds[0], wEnds[12], wEnds[3]];
    for (const tail of [1, 2, 5, 9, 1000]) for (const cs of [3, 1 << 20]) {
      const got = new Map(); windowJobs(wf, wPick, tail, (j) => got.set(j.idx, j), cs);
      const same = wPick.every((idx) => { const j = got.get(idx); return j && JSON.stringify(j.entries) === JSON.stringify(went.slice(Math.max(0, idx + 1 - tail), idx + 1)) && j.text === turnText(went[idx]); });
      chk(`308 windowJobs ≡ 单进程切片(tail ${tail},块 ${cs})`, same && got.size === wPick.length, true);
    }
    const thrown = (f) => { try { f(); return null; } catch (e) { return String(e.message); } };
    chk("308 windowJobs:抽中的下标已不是回合结尾 ⇒ 抛错", /已不是回合结尾/.test(thrown(() => windowJobs(wf, [0], 4, () => {}))), true);
    chk("308 windowJobs:抽中的下标已不在文件里 ⇒ 抛错", /已不在转录里/.test(thrown(() => windowJobs(wf, [wEnds[1], 999], 4, () => {}))), true);
    chk("308 windowJobs:同一回合派两次 ⇒ 抛错", /派了两次/.test(thrown(() => windowJobs(wf, [wEnds[1], wEnds[1]], 4, () => {}))), true);
    // ③ 共用证据编码:Set 保序、undefined 键保留、函数取子进程本地的、认不出的类型报错
    {
      const fnLocal = () => "local";
      const enc = encodeShared({ tracked: new Set(["b", "a"]), justAdded: undefined, checkoutOf: () => "parent", hookCheckout: "H" }, { deployScripts: ["d"], privateRepos: [] });
      const dec = decodeShared(JSON.parse(JSON.stringify(enc)), { checkoutOf: fnLocal });
      chk("308 共用证据:往返后 Set 保序、undefined 键在、函数取本地", [[...dec.ev.tracked], "justAdded" in dec.ev, dec.ev.justAdded, dec.ev.checkoutOf === fnLocal, dec.ev.hookCheckout, dec.names],
        [["b", "a"], true, undefined, true, "H", { deployScripts: ["d"], privateRepos: [] }]);
      chk("308 共用证据:undefined 整体往返", decodeShared(JSON.parse(JSON.stringify(encodeShared(undefined, undefined))), undefined), { ev: undefined, names: undefined });
      chk("308 共用证据:Map 认不出 ⇒ 报错", /认不出/.test(thrown(() => encodeShared({ m: new Map() }, undefined))), true);
      chk("308 共用证据:子进程没有同名函数 ⇒ 报错", /没有同名函数/.test(thrown(() => decodeShared(enc, {}))), true);
    }
    // ④ 回件核对
    {
      const g = [{ file: "f1", idxs: [3, 1] }];
      const row = (idx, o = {}) => ({ file: "f1", idx, text: "", before: [], after: ["K"], err: null, ...o });
      chk("308 回件核对:对得上 ⇒ 原样出行", checkWorkerResult(g, { ok: true, files: [{ file: "f1", rows: [row(3), row(1)] }] }).map((r) => r.idx), [3, 1]);
      chk("308 回件核对:少一行 ⇒ 报错", /回了 1/.test(thrown(() => checkWorkerResult(g, { ok: true, files: [{ file: "f1", rows: [row(3)] }] }))), true);
      chk("308 回件核对:顺序错 ⇒ 报错", /应是 #3/.test(thrown(() => checkWorkerResult(g, { ok: true, files: [{ file: "f1", rows: [row(1), row(3)] }] }))), true);
      chk("308 回件核对:没出错却缺判决 ⇒ 报错", /缺判决/.test(thrown(() => checkWorkerResult(g, { ok: true, files: [{ file: "f1", rows: [row(3, { after: null }), row(1)] }] }))), true);
      chk("308 回件核对:不是成功回件 ⇒ 报错", /不是成功回件/.test(thrown(() => checkWorkerResult(g, {}))), true);
      chk("308 回件核对:份数不对 ⇒ 报错", /回了 0 份/.test(thrown(() => checkWorkerResult(g, { ok: true, files: [] }))), true);
    }
    // ⑤ 端到端:同一份语料、同一组参数,分进程(小块读、每组 2 份转录 ⇒ 多个子进程)与单进程逐项相同
    //   假规则:改前看正文关键词与窗口长度;改后另核共用证据与名单是否原样到达(子进程若自取证据,tracked 会是 "child")
    const hooks = path.join(tmp, "hooks");
    const fakeEv = `export function isNewEvidence() { return { tracked: new Set([process.argv.includes("--worker") ? "child" : "a", "b"]), justAdded: undefined, checkoutOf: (p) => "R:" + p, hookCheckout: "H" }; }
export function readInstallNames() { return { deployScripts: ["d"], privateRepos: [] }; }
const txt = (e) => JSON.stringify(e[e.length - 1]);`;
    const beforeHook = W(path.join(hooks, "before.mjs"), `${fakeEv}
export function run(_, ctx) { const e = ctx.entries, t = txt(e), out = [];
  if (t.includes("kB")) out.push({ id: "M", block: true });
  if (e.length >= 3 && t.includes("w")) out.push({ id: "L", block: true });
  if (t.includes("tB")) throw new Error("改前夹具异常");
  return out; }`);
    const afterHook = W(path.join(hooks, "after.mjs"), `${fakeEv}
export function run(_, ctx) { const e = ctx.entries, t = txt(e), ev = ctx.newEvidence, out = [];
  if (!(ev.tracked instanceof Set) || [...ev.tracked].join() !== "a,b" || !("justAdded" in ev) || ev.checkoutOf("x") !== "R:x" || ev.hookCheckout !== "H") out.push({ id: "EV", block: true });
  if (!ctx.installNames || ctx.installNames.deployScripts.join() !== "d") out.push({ id: "NM", block: true });
  if (t.includes("kA")) out.push({ id: "K0", block: true });
  if (t.includes("kB") && !t.includes("keep")) out.push({ id: "S", block: true });
  if (e.length === 2) out.push({ id: "C", block: false });
  if (t.includes("crash")) process.exit(9);
  return out; }`);
    const corpus = path.join(tmp, "corpus");
    const words = ["kA", "kB", "kB keep", "w", "tB", "plain", "kA w", "中文 kB"];
    for (let f = 0; f < 5; f++) {
      const ls = ["", "  "];
      for (let i = 0; i < 9; i++) { ls.push(U(`q${f}-${i}`)); if (i % 4 === 1) ls.push(T("旁支 kA", { isSidechain: true })); ls.push(T(`${words[(f * 3 + i) % words.length]} #${f}-${i}`)); if (i === 4) ls.push("{半行"); }
      W(path.join(corpus, `s${f}.jsonl`), ls.join(f % 2 ? "\r\n" : "\n") + (f === 3 ? "" : "\n"));
    }
    W(path.join(corpus, "empty.jsonl"), "");
    const base = { beforeHook, afterHook, dirs: [corpus], max: 30, seed: 7, tail: 3, root: tmp, quietChildStderr: true };
    const inP = await replay({ ...base, inProcess: true });
    const perF = await replay({ ...base, inProcess: false, workDir: path.join(tmp, "work1"), chunk: 5, group: { maxFiles: 2 } });
    const view = (x) => ({ available: x.available, files: x.files.length, evShared: x.evShared, namesCount: x.namesCount, ...x.r });
    chk("308 端到端:分进程 ≡ 单进程(摘要各数与每个回合的判决、顺序)", JSON.stringify(view(perF)) === JSON.stringify(view(inP)), true);
    chk("308 端到端:夹具确有阻断 / 新增 / 解除 / 出错(对照不是空对空)", [inP.r.turns, inP.r.blockedBefore > 0, inP.r.added.length > 0, inP.r.removed.length > 0, inP.r.errors > 0], [30, true, true, true, true]);
    chk("308 端到端:共用证据与名单原样到达子进程(没有 EV / NM 阻断)", perF.r.rows.some((r) => (r.after || []).some((id) => id === "EV" || id === "NM")), false);
    chk("308 端到端:确实起了多个子进程、量到了子进程内存", [perF.memory.children >= 2, perF.memory.childPeakMB > 0], [true, true]);
    // ⑥ 子进程失败 ⇒ 整次失败、点名转录(不当成「这份没有阻断」)
    const corpus2 = path.join(tmp, "corpus2");
    W(path.join(corpus2, "ok.jsonl"), [U("q"), T("plain")].join("\n") + "\n");
    W(path.join(corpus2, "boom.jsonl"), [U("q"), T("crash here")].join("\n") + "\n");
    let fail = null;
    try { await replay({ ...base, dirs: [corpus2], max: 10, inProcess: false, workDir: path.join(tmp, "work2"), group: { maxFiles: 1 } }); } catch (e) { fail = e; }
    chk("308 子进程非零退出 ⇒ 整次失败(replayFailed)、消息点名那份转录与退出码", [!!(fail && fail.replayFailed), /boom\.jsonl/.test(fail && fail.message), /退出码 9/.test(fail && fail.message)], [true, true, true]);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ } }
  console.log(`\ngate-replay 自测 ${pass}/${total}`);
  return pass === total ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker") runWorker(argv[1]).then((c) => process.exit(c), (e) => { console.error(`[gate-replay 子进程] ${String(e && e.stack || e).slice(0, 600)}`); process.exit(1); });
  else if (argv.includes("--self-test")) selfTest().then((c) => process.exit(c), (e) => { console.error(String(e && e.stack || e).slice(0, 600)); process.exit(1); });
  else
  main(argv).then((c) => process.exit(c), (e) => { console.error(String(e && e.stack || e).slice(0, 400)); process.exit(1); });
}
