#!/usr/bin/env node
// hook-start-gate.mjs —— 开工面闸(挂 `UserPromptSubmit` / `PreToolUse` / `SessionStart` 三个事件;
//   批 294 起的现行行为以下文「287 设计 2.7」一节为准,本段以下到 CALIBRATED 是 2026-08 的立法史)
//
// 存在理由(2026-08-19 用户当场逼出):本仓此前**所有闸都在收尾面**
// (`PreToolUse`/`PostToolUse`/`Stop`),而当日反复吃亏的两件事都属**开工面**:
//   ① xros 的 Gate 0「如果我现在给你一个答案,你会怎么检查它对不对?」
//      ——关账时才问「能不能用 xros」已经晚了,结论都下完了;
//   ② 「业界踩过没有」——动手前查才有用,关账时查只能证明自己做错了。
// 当日实测:关账自审第⑤⑥⑦问被答过六次,**六次全答「本轮不需要」**,零次触发行动。
// 位置错了,再怎么加判据都没用。
//
// 为什么用 command 而不是 prompt 型:本闸只做**提醒**不做判断,零模型成本、必然执行。
// 判断那一半已经由 Stop 面的 P 项(三通道必跑)承担。
//
// 触发条件(批 294 前):**批级完成条件未武装时才出声**(读 `.claude/.batch-goal.json`)。
//   一旦 `--arm` 过就闭嘴,`--clear` 之后(即新批开始)重新出声。(批 294 起改为「必达注入」,见下文 2.7 一节)
//   这样它自带节流,不会每条消息都刷屏——用户当日明确抱怨过「hook 说的内容太多了」。
//
// 输出:官方 `hookSpecificOutput.additionalContext`(changelog:5150 明示支持),
//   **一行**,不阻断。开工面阻断会把每次闲聊都卡住,代价不对称在这里反向。
//
// CEILING: 它只提醒,不验证你是否真的答了那三问;真正的验收在 Stop 面的 K/K0/P。
// CALIBRATED=false。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ── 2026-08-20 增补:武装之后**不再一律闭嘴** ────────────────────────────────
// 用户当场逼出的问题:「为什么快结束了才开始联网搜索?联网搜索应该不是开工时搜索吗?」
// 诊断(已由当日两次实撞证实,非推断):
//   三通道的唯一硬闸是 Stop 面的 P 项,而 P 的窗口是「自上次 commit 起」——
//   **它结构上只能在活干完之后才响**。为过闸去跑的三通道,产出只能是返工,不可能是导航。
//   当日两次:① 采样策略写完了 grill 才报出它退化成 testing on training data(全部推倒);
//             ② 内容指纹选完了才捞到 Bazel「按输入哈希不按时间戳」的理由(事后追认)。
//   两次都是**开工前十分钟能省掉的事,变成了收尾后一小时的返工**。
// 修法:本闸原来「一 --arm 就闭嘴」,于是提醒恰好在最该说话的时候消失。
//   改成:武装了但**三通道一条都没跑**时,继续出声,并指名缺哪条。
//   仍然只提醒不阻断——开工面阻断会把每次闲聊都卡住,代价不对称在这里反向(见头注)。
// CEILING: 只证「该通道在本批被调用过」,不证调用得对、不证结论被采纳;
//   也不区分「跑在动手前」与「跑在动手后」——它只把提醒**留在场上**,不做时序判定。

/** 从 transcript 里数本批(自 --arm 的时刻起)跑过哪几条通道。取不到就返回 null。
 *
 *  `opts.gateEngine`(批 226 加):**闸引擎面**口径 —— 独立视角那格只认绑定了目标的
 *  `_gate-bypass-hunter`,通用 `grill:*` 不顶(D11,2026-09-06 用户亲签)。
 *  不加这个开关的话会「开工判齐、Stop 又判缺」:本函数放行的东西 Stop 面的 P 还要再拦一次
 *  (跨模型设计评审逮到,批 225 回件)。
 *  ⚠️ **天花板**:P 走结构化 ctx(逐个 action 看 `subagent_type` 与入参),本函数只有 transcript
 *  **文本**,故只能做到「形近」不能做到「同源」——文本里出现这些串就算数。
 *  方向是宁可判缺(多拦一次,跑完就放行),不是宁可判齐。 */
function channelsSince(tsPath, sinceMs, opts = {}) {
  if (!tsPath || !Number.isFinite(sinceMs)) return null;
  let lines;
  try { lines = fs.readFileSync(tsPath, "utf8").split("\n"); } catch { return null; }
  const win = [];
  for (const l of lines) {
    if (!l) continue;
    // 只保留 --arm 之后的行:按 JSON 里的 timestamp 比,取不到时间戳的行一律保留(宁可宽)
    const m = l.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t) && t < sinceMs) continue; }
    win.push(l);
  }
  const w = win.join("\n");
  const miss = [];
  // 与 Stop 面 P 项**同一组判据**(含 MCP 那条通路——只认脚本会漏报,2026-08-20 实撞)
  if (!/codex-run\.mjs|CODEX_JOB=|-audit-r\d|mcp__codex-cli__codex/.test(w)) miss.push("codex 跨模型");
  if (opts.gateEngine) {
    // 闸引擎面(D11):名字对了还不够——入参须绑定闸文件名 / 规则 id / diff(P 的 `hunterBound` 同义)。
    const named = /_gate-bypass-hunter/.test(w);
    // 批 260(红队 a700dedc BP-5):与 P 的 hunterBound 同步纳入 D160⑥ 的文件名与欠账号
    // P0 收口(codex p0-close r2 ②):词表补齐到与 P 的 hunterBound 一致(远端守卫三件 + 新纳入引擎面的九个文件名)。
    //   这里比 P 窄 ⇒ 红队只点名这些文件时 P 判齐、开工闸仍拒写(误拦);比 P 宽无妨,Stop 面的 P 兜底。
    //   注意:本处扫的是整段窗口而非红队入参,窗口里出现过 codex-run.mjs 即算绑定——绑定的真判据在 P,这里只求不比它窄。
    const bound = /hook-stop-closure|hook-guard|hook-remote-check(?!\.selftest)|install-git-hooks|git-hooks\/[\w.-]+\.mjs|gate-[\w-]+\.mjs|write-effects|fp-audit|gate-deps|(?:hook-start-gate|batch-goal|verify-laws|codex-run|write-checks|write-state|debt-schema|obligations|install-config)(?!\.selftest)\.mjs|\.diff\b|规则 ?id|rule ids?|\bRULE_[A-Z0-9]+\b|批 ?\d{3}|\bD\d{3}\b/i.test(w);
    if (!named || !bound) miss.push("红队 _gate-bypass-hunter(闸引擎面专用,须绑定目标)");
    // 批 266:误拦猎手 `_gate-false-block-hunter` **不进开工清单**——它的固定动作是回放「改动前 vs 改动后」,
    //   开工时还没有改动,跑出来恒为零新增,在这里强制它等于逼一次空跑。它只在收尾面由 P 的 D11 要求(与红队并列)。
    //   失效条件:误拦猎手改为也审设计稿(不依赖回放)⇒ 复议是否进开工清单。
  } else if (!/"subagent_type":"grill:|grill:(architecture|security|testing|error-handling|edge-cases|recon)/.test(w)) {
    miss.push("grill 独立视角");
  }
  if (!/"name":"WebSearch"|"name":"WebFetch"/.test(w)) miss.push("联网先例");
  return miss;
}

// D58 锚定(2026-08-26,批 109):hook 进程继承会话 shell 的 cwd,裸相对读会读到
// **shell 当时所在那棵树**的批目标——2026-08-25 实撞的正是同族(cwd 停在 OSS 暂存树,
// Stop 闸审了副本)。装载面已由 $CLAUDE_PROJECT_DIR 绝对化,但那只管「加载哪个脚本」,
// 管不了脚本自己读的相对路径,故此处独立锚。
// 批 294:**没有任何环境变量能改本脚本读写的路径**。首版给自测开过 `START_GATE_*_FILE` 两个覆盖口,
//   红队 294 BP-6 / BP-8 + codex 294-r2:settings.json 的 `env` 能把它们(连同 TEMP)带进 hook 进程,
//   「只认临时目录」挡不住(临时目录本来就归模型写、TEMP 自己也能改),覆盖被拒时还静默回落写真账本。
//   ⇒ 撤掉覆盖口;自测改为把脚本拷进系统临时目录里的迷你仓跑(路径全按脚本自身位置锚定)。
const GOAL_URL = new URL("../.claude/.batch-goal.json", import.meta.url);

let armed = false, armedAt = NaN, armedBatch = null;   // armedBatch:批 225 加,供 D119 标记文件按批命名
let armedConds = 0;                                    // 批 294:武装态的一行摘要用
let goalState = "none";                                // 批 294:武装 / 结清一变它就变 ⇒ 「只注入一次」随之重置
try {
  const g = JSON.parse(fs.readFileSync(GOAL_URL, "utf8"));
  armed = Array.isArray(g?.conditions) && g.conditions.length > 0 && !g?.cleared;
  armedAt = Date.parse(g?.armedAt || g?.at || "");
  armedBatch = g?.batch ?? null;
  armedConds = Array.isArray(g?.conditions) ? g.conditions.length : 0;
  goalState = [armed ? "A" : "U", g?.batch ?? "", g?.armedAt || g?.at || "", g?.cleared ? (g?.clearedAt || "1") : ""].join("|");
} catch { armed = false; }

// ── 批 294(287 设计 2.7「开工上下文怎么必达」)────────────────────────────────
//   原来每条用户消息都注入同一段话(开工三问 / 本批三通道还缺)——设计 2.1:只在内容**变了**时注入。
//   但 codex 指出「变化才注入」只是去重、不保证触发,故 2.7 定了三个必达点:
//     ① 每个会话的第一条用户消息注入一次;
//     ② 未武装时,第一次调用**非只读**工具注入一次(按「不是只读」判,不列举写工具名);
//     ③ 武装或结清以后重置(goalState 进键)。
//   记账目录 `.claude/.start-ctx-seen/`(gitignore 面),**每会话一个文件** `<sha1(session_id) 前 16 位>.json`:
//   { [槽]: { v: 上次送出的内容指纹, t: 时刻 } }。每会话一份 ⇒ 别的会话的读改写碰不到本会话的账
//   (codex 294-r2 §5 / 红队 BP-9:原先整本一份,B 会话拿旧快照整份写回,会把 A 刚忘掉的账写活)。
//   **记的是「上次送的是什么」,不是「送过哪些」**(codex 294-r1 §6:历史集合下 A→B→A 的第二个 A 会被吞)。
//   顺序是**先输出、后记账**(codex 294-r1 §3:先记后输出,中途出事会把没送到的压成「已送」)。
//   取不到 session_id、账本坏了 / 结构异常 ⇒ 当没送过,照旧注入。
//   写失败的退路(codex 294-r2 §3 / r3 §1):记账改名失败 ⇒ 直接覆盖写 ⇒ 再失败就删本会话账(下次当没送过);
//   忘账删不掉 ⇒ 覆盖成空账 ⇒ 再失败就 SessionStart(非 startup 来源)不查账直接说。**只有同一文件的写、删全部失败**
//   (文件被独占锁住)时才会少说一次——这是唯一剩下的漏送形态,登 D202⑤。
//   七天清理与别的进程并发时可能删掉刚写的账 ⇒ 只会多说一次,接受(codex 294-r3 §2)。
//   每会话一个文件只消掉**跨会话**竞态;同一会话并行的 PreToolUse 若并发起进程,两个都判「没送过」会各说一次
//   (多说方向;CLI 是否并发起进程未证,D202③)。
//   这是**去重缓存**,不是防线:模型手改它能压掉提醒,按 ADR 0009「只数诚实遗忘、蓄意规避不计」不设防。
//   CEILING: 只保证「本会话送到过」,不保证模型读了、照做了;读不读由收尾闸 K/K0 与关账兜。
const SEEN_DIR = fileURLToPath(new URL("../.claude/.start-ctx-seen/", import.meta.url));
const SEEN_TTL_MS = 7 * 24 * 3600 * 1000;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const seenFile = (sid) => path.join(SEEN_DIR, crypto.createHash("sha1").update(sid).digest("hex").slice(0, 16) + ".json");
/** 读本会话的账;任何异常都返回空账(绝不抛)。过期条目在读时就当不存在。 */
function loadMine(sid, now) {
  let mine = {};
  try { mine = JSON.parse(fs.readFileSync(seenFile(sid), "utf8")); } catch { return {}; }
  if (!isObj(mine)) return {};
  const keep = {};
  try {
    for (const [k, e] of Object.entries(mine)) {
      if (isObj(e) && typeof e.v === "string" && Number.isFinite(e.t) && now - e.t <= SEEN_TTL_MS) keep[k] = e;
    }
  } catch { return {}; }
  return keep;
}
/** 误拦猎手 294 FB-5:读者不能读到写了一半的文件 ⇒ 写临时文件再改名(同目录 rename 原子)。 */
function writeMine(sid, mine) {
  fs.mkdirSync(SEEN_DIR, { recursive: true });
  const f = seenFile(sid), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mine));
  try { fs.renameSync(tmp, f); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉临时件不影响 */ } throw e; }
}
/** 顺手清掉 7 天没动过的会话文件(按 mtime),目录不无限长。失败不管。 */
function pruneOld(now) {
  try {
    for (const n of fs.readdirSync(SEEN_DIR)) {
      const f = path.join(SEEN_DIR, n);
      try { if (now - fs.statSync(f).mtimeMs > SEEN_TTL_MS) fs.rmSync(f, { force: true }); } catch { /* 下次再清 */ }
    }
  } catch { /* 目录不存在等 */ }
}
/** 本会话这个槽上次送的不是 value ⇒ true(该说)。无 session_id ⇒ 恒 true。 */
function shouldSay(sessionId, slot, value) {
  if (!sessionId) return true;
  try { return loadMine(sessionId, Date.now())[slot]?.v !== value; } catch { return true; }
}
/** 输出之后再调:记下本会话这个槽送出的是 value。写失败静默(后果见头注)。 */
function record(sessionId, slot, value) {
  if (!sessionId) return;
  try {
    const now = Date.now();
    writeMine(sessionId, { ...loadMine(sessionId, now), [slot]: { v: value, t: now } });
  } catch {
    // codex 294-r3 §1:改名写失败时账里还是**更早那次**的值 ⇒ 内容回到那个值会被当成已送(A→B→A 吞掉最后的 A)。
    //   退路依次:直接覆盖写(不经改名)→ 删掉本会话账(下次一律当没送过)。三步都失败才会漏,见头注。
    const f = seenFile(sessionId);
    try { fs.writeFileSync(f, JSON.stringify({ ...loadMine(sessionId, Date.now()), [slot]: { v: value, t: Date.now() } })); }
    catch { try { fs.rmSync(f, { force: true }); } catch { /* 三步全失败 ⇒ 见头注 */ } }
  }
}
/** 红队 294 BP-2:SessionStart 时忘掉本会话的账。**假设**压缩 / 清屏后 session_id 不变而上下文里已无那次注入
 *  (未经真 CLI 证实,见 D202③;若 session_id 会变,新会话本来就是空账,行为不变)。
 *  不看 source:resume / fork 若恢复了带注入的转录,会多说一次(误拦猎手 294-r2 FB-1)——「多说」方向、封顶一次,接受。 */
function forgetSession(sessionId) {
  if (!sessionId) return true;
  const f = seenFile(sessionId);
  try { fs.rmSync(f, { force: true }); return true; } catch { /* 删不掉 ⇒ 试覆盖成空账 */ }
  try { fs.writeFileSync(f, "{}"); return true; } catch { return false; }   // 返回 false ⇒ 调用方不查账、直接说
}
/** 该说就说,说完再记。 */
function sayIfChanged(slot, text, value = textKey(text)) {
  if (!text || !shouldSay(sessionId, slot, value)) return;
  // 红队 294-r3 BP-12:目录清理放在**输出之前**——记账之后不再做任何慢操作,
  //   免得「已记账、进程还没退出」时被超时杀掉,账上写着已送、模型其实没收到。
  pruneOld(Date.now());
  say(text);
  record(sessionId, slot, value);
}
const textKey = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

// 只读工具:调用它们不算「开始动手」。不在表里的(含一切 MCP)按非只读算——错了的代价只是多注入一次。
const READONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "ToolSearch",
  "TodoWrite", "TaskOutput", "ListAgents", "AskUserQuestion",
]);
// 闸引擎首写 deny 的工具范围 = 批 294 之前 matcher 的原范围,一个不多
const WRITE_TOOLS_FOR_DENY = new Set(["Edit", "Write", "MultiEdit"]);

// 批 225:`hookEventName` 必须回填**当前事件**,不能再硬编码 UserPromptSubmit
//   (本脚本自批 225 起同时挂 PreToolUse)。两个事件都支持 additionalContext——
//   本机 changelog :5452「Added support for PreToolUse hooks to return additionalContext to the model」,
//   :3832 还修过它在工具调用失败时被丢弃的 bug ⇒ 通道是官方在维护的,不是我推测的。
//   ⚠️ `hookEvent` 声明在下方,但 say 是箭头函数、求值发生在调用时,而全部调用点都在其后。
const say = (s) => process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: hookEvent || "UserPromptSubmit", additionalContext: s },
}));

// ── 待续件检查(2026-08-26 实撞立):恢复动作必须绑**条件**,不许只绑触发器 ──
//   实撞:撞额度后按全局规范八建了 3:11 的一次性内存态 cron——机器睡眠错过那一分钟,
//   分钟精确匹配**错过即永失**(下次匹配=明年同日),而阻断条件(额度重置)凌晨就解除了,
//   我到早上 8 点还在「等闹钟」,被用户点破「能不能自己动动脑子」。
//   修法=把「到点检查」放在必然执行面:每条用户消息都看一眼待续标记,PENDING 就顶到提醒首位。
//   cron 降级为补充通道。
//   停止提醒条件=仓根标记不存在,或首行精确为 STATUS: DONE;文件存在但不可读/状态非法时
//   **显式提示异常,不得冒充「无待续件」**。机制边界:无新用户消息、hook 未挂载或
//   additionalContext 未被消费时本通道不会主动恢复任务——cron 仍是补充通道,不是被取代。
//   机制失效条件=任一主仓 PENDING 漏报/错树误报,或本查拖慢、破坏 UserPromptSubmit ⇒ 登记复议。
//   (codex 103 四眼三条全采纳:锚定 import.meta.url 防 D58 面扩大 / 首行精确枚举防
//   PENDINGLY 类前缀误命中 / 定长读首段防大文件线性开销。)
let pendingNote = "";
try {
  // 锚定到脚本所属仓根,不吃进程 cwd(D58 实撞面;本 hook 其余相对读仍在 D58 清单内)
  const pmURL = new URL("../clipboard/.pending-after-limit.md", import.meta.url);
  let firstChunk = null;
  try {
    const fd = fs.openSync(pmURL, "r");
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      firstChunk = buf.toString("utf8", 0, n);
    } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e && e.code !== "ENOENT") firstChunk = "";   // 存在但读不了 ⇒ 走异常提示,不冒充没有
  }
  if (firstChunk !== null) {
    const firstLine = firstChunk.split("\n")[0].replace(/^﻿/, "").trim();
    if (/^STATUS:\s*PENDING$/.test(firstLine)) {
      pendingNote = "⟦待续件 PENDING⟧ clipboard/.pending-after-limit.md 挂着——先判它的阻断条件还在不在;" +
        "不在了就**现在办**,别等任何定时器(内存态 cron 睡过即永失,2026-08-26 实撞)。 ";
    } else if (!/^STATUS:\s*DONE\b/.test(firstLine)) {
      pendingNote = "⟦待续件状态异常⟧ clipboard/.pending-after-limit.md 存在但首行既非 STATUS: PENDING " +
        "也非 STATUS: DONE(或不可读)——去看一眼,别当作没有待续件。 ";
    }
  }
} catch { /* 本查自身崩不许拖垮开工提醒 */ }

// ── 批 225(D119):本脚本现在挂**两个**事件,先分流。────────────────────────────
//   立法依据:D119 登记的「三通道提示挂在 UserPromptSubmit ⇒『开工跑』从未落地」。
//   三重失效:(a) 用户发消息那一刻**还不知道这批要做什么**——2026-09-16 当日开局是
//   「LADR 习题有没有答案」,谁也想不到会变成改闸引擎,等知道要动承重面时提示早刷过去了;
//   (b) 提示内容每次一模一样 ⇒ 脱敏(当日响了至少 6 次,零次被当回事);
//   (c) 真正**阻断**的 P 项在 Stop 才响 ⇒ 活已经干完。
//   当日实证:13 个批全是收尾才跑外审,而外审连续三轮推翻前一批的修法,
//   其中两条洞是那一批**自己刚装进去的**——开工跑的话根本不会被写出来。
//   ⇒ 触发点移到「**第一次写承重面文件时**」:那一刻才知道本批要改什么,且**还来得及改方向**。
const rawPayload = (() => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } })();
const hookEvent = (() => {
  try { return JSON.parse(rawPayload || "{}").hook_event_name || null; }
  catch { return (/"hook_event_name"\s*:\s*"([A-Za-z]+)"/.exec(rawPayload || "") || [])[1] || null; }
})();
const payloadObj = (() => { try { return JSON.parse(rawPayload || "{}") || {}; } catch { return {}; } })();
const sessionId = typeof payloadObj.session_id === "string" ? payloadObj.session_id : "";

// 开工三问正文(批 294:UserPromptSubmit 与 PreToolUse 两个必达点共用一份)
const KAIGONG = "⟦开工三问⟧ ① 什么算完成?(`node --no-warnings scripts/batch-goal.mjs --arm <批号> --cond …`) " +
  "② 如果现在给出答案,拿什么检查它对不对?(答不出 ⇒ `/xros:sharpen` 去找检验手段,别硬造) " +
  "③ 这类问题业界怎么做的?(动手**前**查先例;关账再查只能证明自己做错了) " +
  // ④ 2026-08-22 用户亲签加:倒排索引接到开工时刻——「工具选用」这个每轮决策点无闸可拦,
  //   只能在必经处放路标。按问题查,不按工具名查(D19 的病根)。
  "④ 有没有现成件?(按**问题**扫一眼 `docs/tool-index.md`,别按工具名想)";

// 批 294:会话级开工上下文正文——SessionStart 与 UserPromptSubmit 共用一份、共用一个槽(goalState|msg),
//   所以 SessionStart 说过,同内容的首条消息就不再说。
//   ⚠️ 批 225:transcript_path **复用上面那次 stdin 读取**,不得再读一次 —— `fs.readFileSync(0)` 对管道 stdin
//   只能成功一次,第二次拿到空串 ⇒ `channelsSince` 恒 null ⇒ 提示静默消失。
//   ⚠️ 已武装时也必须**有话可说**(codex 294-r1 §2:原版已武装 + 通道齐 + 无待续件 ⇒ 新会话首条静默)
//   ⇒ 武装态恒带一行批状态摘要(设计 2.1「一行摘要加一个文件路径」);三通道有缺口时再接一句缺哪条。
function msgText() {
  if (!armed) return pendingNote + KAIGONG;
  const armedLine = `⟦本批 ${armedBatch ?? "?"} 已武装:${armedConds} 条完成条件⟧ 条件与进度:` +
    "`node --no-warnings scripts/batch-goal.mjs --status`(状态文件 .claude/.batch-goal.json)。";
  const tsPath = typeof payloadObj.transcript_path === "string" ? payloadObj.transcript_path : null;
  const miss = channelsSince(tsPath, armedAt);
  if (miss === null || !miss.length) return pendingNote + armedLine;
  return pendingNote + armedLine + ` ⟦本批三通道还缺:${miss.join(" / ")}⟧ 现在跑比收尾跑值钱——` +
    `收尾跑只能证明自己做错了,开工跑才能改方向。(Stop 面的 P 项是兜底,不是它的正确位置)`;
}
const sayOnce = (text) => sayIfChanged(`${goalState}|msg`, text);

if (hookEvent === "SessionStart") {
  // 红队 294-r3 BP-11(已复现):子代理的 SessionStart 带的是父会话 session_id——它若忘账并注入,
  //   会删掉父会话的账、把开工上下文送进子代理、再按父会话记「已送」⇒ 父会话结清后的首条静默。
  //   与 PreToolUse 分支同一口径:带 agent_id 的不忘、不说、不记。
  if (payloadObj.agent_id) process.exit(0);
  // 红队 294 BP-2 / BP-10:压缩、清屏、续会话后(假设 session_id 不变,见 forgetSession 头注)上下文已无那次注入 ⇒ 先忘账,
  //   再**当场**注入一次(一轮内自动压缩、无头 `-p` 单条消息时等不到下一条用户消息)。
  //   SessionStart 支持 additionalContext(官方 hooks 文档 SessionStart 一节,codex 294-r2 取页)。
  // 误拦猎手 294-r3 FB-1:startup 时转录多半还没落盘(本机 11 份转录里 8 份文件晚于首条 user 条目建立)⇒ 此刻说的
  //   正文缺三通道那句,首条消息读到转录后正文不同又说一遍。新会话的首条消息本来就会说 ⇒ startup 只忘账、不当场说。
  //   compact / clear / resume / fork:上下文已丢或转录已在,当场说。
  if (payloadObj.source === "startup") { forgetSession(sessionId); process.exit(0); }
  // codex 294-r3 §1:忘账失败(删、覆盖都不成)时旧账还在 ⇒ 不查账、直接说(不记账,免得再把失败的账写一遍)。
  if (forgetSession(sessionId)) sayOnce(msgText());
  else { const t = msgText(); if (t) say(t); }
  process.exit(0);
}

if (hookEvent === "PreToolUse") {
  // 批 294 必达点②:未武装时第一次调用非只读工具,注入一次开工三问(不阻断)
  //   红队 294 BP-1:子代理的载荷带的是**父会话**的 session_id(gate-touch.mjs 头注的探针实录),
  //   它先调一次写工具就会把父会话这一槽用掉,而注入进的是子代理的上下文 ⇒ 带 agent_id(changelog:8075)的调用不说也不记。
  if (!armed) {
    const tool = String(payloadObj.tool_name || "");
    if (!payloadObj.agent_id && !READONLY_TOOLS.has(tool)) sayIfChanged(`${goalState}|tool`, KAIGONG, "1");
    process.exit(0);
  }
  // 批 294(codex 294-r1 §1 复现的误拦):matcher 放宽成 `*` 以后,下面的 deny **只认原来那三个写工具**——
  //   否则武装且通道未齐时,Read / 带同形 file_path 的 MCP 读工具读一下闸文件也会被拒。
  if (!WRITE_TOOLS_FOR_DENY.has(String(payloadObj.tool_name || ""))) process.exit(0);
  // 本批**第一次写闸引擎文件**时:三通道缺口未补齐 ⇒ **deny**,补齐即自动放行。
  //
  // ⚠️ 批 226 按跨模型设计评审(codex,批 225 回件)整体重写。首版的三处错,每处都致命:
  //   (1) **只提醒不阻断 ⇒ 治不了病**。非阻断的 additionalContext 随工具结果进入上下文,
  //       而那时**第一次 Edit 已经执行完了** —— 提示到得再早也只是给已发生的事加注脚。
  //       唯一能保证「改前外审」的形态是 deny:缺证据即拒,跑完外审重试自然放行。
  //   (2) **范围抄错了表**。首版用 `isLoadBearing`,而它远宽于闸引擎(还含法典、指令、
  //       settings、package)。对那么宽的面强制外审会把日常改动全卡死。闸引擎另有判据
  //       `RULE_P._p.GATE_ENGINE`,与 D11 的口径**同源**,用它。(批 285 D145:改用 P 的锚定口径 `_p.startGateHit`,见下)
  //   (3) **通道判据与 P 不一致 ⇒ 开工判齐、Stop 又判缺**。本文件的 `channelsSince()`
  //       把任意 `grill:*` 算通过,而 P 在闸引擎面**只认绑定了目标的 `_gate-bypass-hunter`**
  //       (D11)。两处判据必须同源,否则这道闸会放行一批 Stop face 还要再拦的东西。
  //   同时撤掉批号标记文件:评审指出它同批 `--force`/重新武装会复用旧标记、且无限累积;
  //   而「证据齐即放行」本身就是无状态的解除条件,不需要记「提示过没有」。
  let target = "";
  try { target = JSON.parse(rawPayload).tool_input?.file_path || ""; } catch { /* 解不出按不命中 */ }
  if (!target) process.exit(0);

  // ⚠️ `RULE_P` **没有具名导出**(实测:具名导入拿到 undefined),只在 RULES 数组里。
  //   本批首版写成 `{ RULE_P }` 具名解构 ⇒ 判据恒取不到 ⇒ 整条闸静默失效、看起来「正常放行」。
  //   —— 又一个「编 API」,靠逐段验证当场抓住的(语法检查与静默输出都发现不了)。
  let P = null;
  try {
    const { RULES } = await import("./lib/gate-rules.mjs");
    P = Array.isArray(RULES) ? RULES.find((r) => r && r.id === "P") : null;
  } catch { P = null; }
  // 判据取不到 ⇒ **不冒充「不是闸引擎」**。但本闸只管导航,取不到判据时不该把人堵死
  //   (fail-closed 的那一半由 Stop 面的 P 项承担,它无逃生口)。
  if (typeof P?._p?.startGateHit !== "function") process.exit(0);
  // 批 276c(误拦猎手 FB-5):本仓内的绝对路径先化成仓相对形——通用名两支(install-git-hooks / git-hooks/*.mjs)
  //   只认相对形,别的仓里的同名文件保持绝对路径,因而不算本仓闸引擎
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
  //   先规范化 `.` / `..` / `//` 再剥仓根(规则层红队 r3 BP-4:`scripts/./git-hooks/pre-push.mjs` 原可绕开)
  let rel = path.posix.normalize(String(target).replace(/\\/g, "/"));
  if (rel.toLowerCase().startsWith(ROOT.toLowerCase() + "/")) rel = rel.slice(ROOT.length + 1);
  // 批 285(D145 误拦子项):判据从未锚定的 GATE_ENGINE 换成 P 同一份锚定口径(startGateHit = isEnginePath:剔 NON_CARRIER_AREA 与
  //   worktree 区)——原来写外发暂存树里的闸副本 `clipboard/oss/public-repo/scripts/…` 在批已武装、通道未齐时被 deny,
  //   而 Stop 面的 P 并不把它当闸引擎。代价与边界见 gate-rules 的 startGateHit 头注。
  if (!P._p.startGateHit(rel, ROOT)) process.exit(0);

  let tsNow = null;
  try { tsNow = JSON.parse(rawPayload || "{}").transcript_path || null; } catch { tsNow = null; }
  const missNow = channelsSince(tsNow, armedAt, { gateEngine: true });
  if (missNow === null) process.exit(0);             // 读不到 transcript ⇒ 算不出缺口,不拦(Stop 面兜)
  if (!missNow.length) process.exit(0);              // 证据齐 ⇒ 放行,这就是解除条件

  // deny 的官方形态:PreToolUse 的 permissionDecision。exit 0 + 这段 JSON,**不是** hook error。
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `⟦闸引擎面写入被拦:${target}⟧ 本批三通道还缺:${missNow.join(" / ")}。\n` +
        `这不是让你绕过——是让你**现在**跑,而不是收尾跑。收尾跑只能证明你已经做错了。\n` +
        `2026-09-16 实证:13 个批全是收尾才外审,外审连续三轮推翻前一批修法,` +
        `其中两条洞是那一批自己刚装进去的;而本条规则的首版(只提醒不阻断)当场被评审判为「治不了病」。\n` +
        `跑完缺的通道后**原样重试这次写入**即自动放行(本闸无状态,证据齐就不再拦)。\n` +
        `⚠️ 闸引擎面的独立视角那格只认 \`_gate-bypass-hunter\`(D11),入参须带闸文件名/规则 id/diff;` +
        `通用 grill 不顶。`,
    },
  }));
  process.exit(0);
}

// 批 294:UserPromptSubmit 侧一律「同会话、同状态、同内容只说一次」。
//   槽 = goalState|msg,值 = 正文指纹 ⇒ 武装 / 结清(必达点③)或内容跟**上次送的**不一样才会再说。
//   必达点①(会话第一条消息)由按会话分账满足:新会话的账是空的,第一条一定说(SessionStart 已说过同内容则不重复)。
//
// 批 305(设计稿第三节第 5 项):收尾闸的「只提示」在交互会话里不再当轮续轮,寄存到 `.claude/.gate-pending-hints/`,
//   由这里在下一次 UserPromptSubmit 取走、与开工上下文合成**一次**输出注入,然后清掉(lib/gate-hint-relay.mjs 是唯一实现)。
//   每次都先打「读端在场」标记——收尾钩子只在看见这个标记时才寄存(没接本钩子的仓永远走老通道,提示不会寄存了没人取)。
//   顺序同上:**先输出、后记账**(commit 在输出之后;中途出事 ⇒ 下次再送一遍,多送方向)。
//   别的会话留下、超期没人取的提示在这里记进丢弃账后清掉(会话换了的情形)。
//   子代理(带 agent_id)不取也不打标记:注入进的会是子代理的上下文(同 PreToolUse 分支的口径)。
//   本段任何一步出错 ⇒ 只当没有可送的提示,开工上下文照旧(fail-open:不许拖垮开工提醒)。
let relayTake = null;
if (sessionId && !payloadObj.agent_id) {
  try {
    const relay = await import("./lib/gate-hint-relay.mjs");
    const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
    relay.markReceiver(ROOT_DIR, sessionId);
    relay.sweepExpired(ROOT_DIR, sessionId);
    relayTake = relay.takeHints(ROOT_DIR, sessionId);
  } catch { relayTake = null; }
}
{
  const startText = msgText();
  const slot = `${goalState}|msg`;
  const sayStart = !!startText && shouldSay(sessionId, slot, textKey(startText));
  const parts = [];
  if (sayStart) parts.push(startText);
  if (relayTake && relayTake.text) parts.push(relayTake.text);
  if (parts.length) {
    if (sayStart) pruneOld(Date.now());   // 慢操作放在输出之前(红队 294-r3 BP-12)
    say(parts.join("\n\n"));
    if (sayStart) record(sessionId, slot, textKey(startText));
  }
  try { if (relayTake) relayTake.commit(); } catch { /* commit 自己不抛;防御 */ }
}
