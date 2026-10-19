#!/usr/bin/env node
// hook-stop-closure.mjs —— 收尾闭环闸(Stop hook)
//
// 干什么:在「停下来」这个动作上做机械检查。判据选在**结构层**不是语义层——
//        不判「这个问题修没修」(机器判不了),判「**有没有落地动作或登记**」(transcript 里全是事实)。
//
// 为什么:2026-08-19 实撞——同一轮对话里四类失误各犯一次,而当时 settings.json 的四个 hook
//        **全部挂在工具调用上**,「停下来」这个动作没有任何闸。既有收尾闸 report-gate.mjs
//        要人主动跑、且要一个报告文件当参数,对话式收尾没有作用对象。
//        依据=恒定条款④「预期外发现登记不处置」:发现问题的合法出路只有两条——
//        当批修掉,或登记进未覆盖栏/事件流;**两条都没走才是违规**。
//
// 判据:条数以引擎规则表 `RULES.length` 为准——**手写计数禁令**(codex 2026-08-22 逮到本文件
// 三处手写数字各自漂移:十四/二十/二十一,而真值已是二十二)。阻断项共同特征=结构事实+出路便宜:
//   A  委派/后台任务未闭环   —— 原生后台任务:发起后再没被提过;codex 委派(批 257):
//                               已产出却没成功读回正文 / 失败了没读日志也没登记。   【阻断;状态未知只提示】
//   E0 裸因果断言            —— 下了因果断言且三条出路一条没走。         【阻断】
//   I  新建载体未扫工具面     —— 写了 agents/skills/commands/scripts 而无扫描痕迹。【阻断】
//   J  立/改法未交代触发层   —— 动了 AGENTS.md 或 docs/laws/ 而没说它靠什么触发。【阻断】
//   E2 缺「形」那一半      —— 没问过有没有机械判据;自标「推断」不豁免本项。【阻断】
//   K  结清没成            —— 本轮跑了 --clear,盘上仍未结清(被拒或出错)。批 250 瘦身。【阻断】
//   K0 未武装 / 关账漏对照  —— 动了工作面却没批;结清时条件没逐条对照。【阻断/提示】
//   B 承诺未兑现 / C 缺陷陈述无处置 / D 强制项被降级成征询
//   E1 缺独立性那一半 / F 完成断言与欠件并存 / G 提交前无自审 / H 自陈「能做」却无落地动作【提示】
//
// 天花板(CEILING):除 A 外全部是关键词匹配,**判不出语义**。
//   已知误报:①「X 没有 Y」可能只是在回答提问 ②引用/复盘一句断言与说出它同样命中
//            ③讨论某条纪律时会撞上该纪律的关键词。
//   已知漏报:C/H 的豁免看「本轮有没有写动作」而非「写的是不是那件事」——
//            **一次无关的 Edit 即可豁免整项**;判「这个写动作是否对应那个自陈」需要语义。
//   A 只证发起与取回未配对,不证结果被读懂或被采纳(codex 账:结构配对只证「有正文返回过」,
//     不证读全、读懂;残余逐条列在 `codexLedger` 头注)。
//   **所有结构判据的共同天花板:只管「做没做」,管不了「做得对不对」**——
//   I 证扫过工具面,不证扫的方式对(2026-08-19 实撞:手工 ls 而非跑 census,I 不触发,故补 L 项);
//   G 证自审过,不证自审到位;K 证条件被逐条对照,不证条件写得对或真达成。
//   这一层要靠跨模型判官与人,机器给不出。
//   **召回率是命门**:E 项原五条模式对 2026-08-19 全天输出只逮到 3/20,
//   最常见的「X 是因为 Y」全数漏过——造完只测「编的用例能否命中」、不测「真实数据漏多少」,
//   会给出「它在工作」的错觉。误报看得见,漏报不会说话。
//   CALIBRATED=false;误报率满 20 批按 053 决策单口径复议(>50% 则该项退役)。
//
// 为什么四项敢阻断:出路都只要一句话——A=去取回;E0=就地自标「这是推断」;
//   I=写一行「工具面已扫:命中X/无命中」;J=写一句「触发层=每会话加载/挂在X事件/靠人记得」。
//   本闸买的不是「必须做对」,是「**不许既跳过又不说**」(三档判定禁止二值的机制化)。
//
// 用法: 由 settings.json 的 Stop hook 调用,stdin 收 hook payload(含 transcript_path)。
//       手动自测: node --no-warnings scripts/hook-stop-closure.mjs --self-test
//                 node --no-warnings scripts/hook-stop-closure.mjs --dry-run <transcript.jsonl>
// 退出码: 0=放行(可能带提示)  2=阻断
//       临时解除: STOP_CLOSURE_BLOCK_{A|E|I|J|K}=0
//
// 输出契约: 命中时向 stderr 打印人类可读清单;阻断时同时向 stdout 打印 JSON
//          {"decision":"block","reason":"..."} —— Stop hook 的阻断形态。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

// ── 阻断项开关:四项**默认阻断**。
//
// 判定依据是**代价不对称,不是命中率**:四项的出路都只要一句话
// (A=去取回;E0=就地自标「这是推断」;I=写一行「工具面已扫」;J=写一句「触发层=…」)。
//   误报成本 = 多写一句话;漏报成本 = 错误断言/未闭环任务**无声进入法条与报告**。
// ⇒ 方向明确支持保持阻断。
//
// ⚠️ 2026-08-19 曾据「留出集精确率 50%」把四项降级成影子模式,**当日即撤回**。
// 那个 50% 出自 **n=6 次命中**——样本量连方向都定不了,拿它做处置是小样本下强结论,
// 与本闸 E0 项要拦的错误同型。同日跨模型判官另指出**同一缺陷我只撤了一半**:
// 撤了「Google 静态分析阈值」这个不相干权威,却把同样出自 n=6 的百分比写进了寄存器。
// **现口径**:那次比对只支持一个方向性结论——**存在漏报,且集中在 F/H/C**;
// 「20%/50%」不作为精确率/召回率使用,任何由它外推的百分比一律无效。
// 同批撤回的还有一条编造的解释:「F/H/C 是单条件所以全漏」——单条件比双条件**更容易**命中,
// 全漏的真实原因是模式没匹配上那些句子,与条件数量无关。
//
// 临时解除:STOP_CLOSURE_BLOCK_{A|E|I|J}=0
const BLOCK_ON_R = process.env.STOP_CLOSURE_BLOCK_R !== "0";
// ⚠️ `Q` 是 2026-08-20 补的(grill:architecture 5.3)。它在引擎里 `blocking: true`,
//   却不在 `BLOCK_OFF` 表里 ⇒ `BLOCK_OFF["Q"] ?? true` 恒为 true
//   ⇒ **闸消息里印的 `STOP_CLOSURE_BLOCK_Q=0` 敲了不起作用**。
//   这是「阻断项留纯文本出路」的**镜像**:一条看起来存在、实际不存在的出路。
//   根因是 `BLOCK_OFF` 手工枚举 vs 引擎 `blocking` 声明式,两者之间没有对账
//   —— 正是 gate-registry 头注号称已消灭的「新增 block:true 没进开关链」在**逃生口这一侧**复发。
//   已在自测里加对账闸(搜「逃生口对账」),否则下一条迁进来的阻断规则会自动再踩一次。

/** 读一次批次状态文件,交给引擎注入。**规则不自己读磁盘**——
 *  规则自读的代价已实测:同一条用例在「当前批 arm 过」与「没 arm」下结果不同,
 *  自测从 34/34 掉到 13/34,而代码一行没改。
 *  读不到 ⇒ 返回 `null`(**不是空对象**):「没有批次状态」与「批次状态是空的」是两件事。 */
function readBatchGoal() {
  // ⚠️ 我此前在提交信息里说过「注入之后 STOP_CLOSURE_SELFTEST 就不再需要存在」——**那是错的**,
  //   在此更正:注入解决的是「规则自己读磁盘」,没解决「自测跑在真磁盘状态上」。
  //   自测仍需一个显式的「本通道不供」信号,只是它现在只影响这一个读取点,
  //   而不再像旧实现那样从 `run()` 里跳过一整段判据。
  // 自测下**显式供 null**(= 「查过了,没有批次状态」),不供 `undefined`。
  // 差别不是修辞:`undefined` 现在会让 K/K0 报 UNKNOWN 阻断(契约层,见 registry 的 requires)。
  // 「不供」是调用方的缺陷,「供 null」是一个真实世界状态——自测要的是后者。
  if (process.env.STOP_CLOSURE_SELFTEST === "1") return null;
  let g;
  // ⚠️ **文件不在 ≠ 文件坏了**(D2 结案,grill P3 的残余半条):
  //   ENOENT = 真没武装 ⇒ null(K0 的正当领地);
  //   **内容坏了 = 台账损坏 ⇒ undefined** ⇒ K/K0 报 UNKNOWN 阻断(契约层),
  //   排障者看到的是「必需通道缺席」而不是被误导去 --arm 一个新批。
  //   (D2 的另一半——「静默降级」——已被 K0 强化与切换改向,坏文件从不响变成了必响。)
  let raw;
  try { raw = fs.readFileSync(".claude/.batch-goal.json", "utf8"); }
  catch { return null; }                       // 文件不在:真没武装
  try { g = JSON.parse(raw); }
  catch { return undefined; }                  // 文件在但坏:UNKNOWN,fail-closed
  // ⚠️ **`--clear` 会把 conditions 整个丢掉**,结清后文件只剩 `{cleared:true, version}`。
  //   2026-08-20 实撞:我给 K0 的豁免加了「conditions.length > 0」以堵 grill P1 的洞,
  //   结果那条豁免**永远不成立** ⇒ 每次正常关账都被 K0 误报。
  //   更值得记的是**为什么没测出来**:grill 的矩阵和我的复测都用了
  //   `{conditions:["甲"], cleared:true}` —— 一个**真实系统永远不会产生的状态**。
  //   夹具与现实不符,于是「验证通过」是假的。这比判据写错更隐蔽。
  //   ⇒ 从**只追加台账**补回被清掉的那半:`--clear` 会往 `.batch-goal.jsonl`
  //     追加 `{action:"clear", batch, conditions}`,那才是「确实关掉过一个有条件的批」的证据。
  if (g && g.cleared && !Array.isArray(g.conditions)) {
    try {
      const lines = fs.readFileSync(".claude/.batch-goal.jsonl", "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]);
      // ⚠️ **末行的批号必须与状态文件一致**(grill:edge-cases E6)。
      //   `journal()` 的 `catch {}` 把写失败整个吞掉,而 `atomicWrite` 照常成功、
      //   CLI 照常 exit 0(Windows 上文件被占用即触发)⇒ 陈旧的旧批 clear 行
      //   会顶替成本轮证据,豁免照发,**没有任何一处会说出来**。
      //   `--clear` 现在把批号写进状态文件,这里对一次就能识破。
      //   对不上 ⇒ 不补 `closedConditions` ⇒ K0 照常命中(fail-closed 那侧)。
      const sameBatch = (last?.batch ?? null) === (g.batch ?? null);
      if (last?.action === "clear" && Array.isArray(last.conditions) && sameBatch) {
        // 只补 `closedConditions`,**不冒充 `conditions`**:
        // 「当前武装着这些条件」与「刚关掉的那批曾有这些条件」是两件事,混了 K 会误响。
        g = { ...g, batch: last.batch ?? null, closedConditions: last.conditions };
        // 批 258(codex 258-cond2-r1 发现 1):结清态没有 armedAt ⇒ W 按批切交付物的判据退回整窗口,上一批的交付物又算回来。
        //   补回这一批**最早一次**武装的时刻,放独立键 `clearedArmedAt`(不冒充 armedAt:P / K 等按 armedAt 判「武装中」的读者不受影响)。
        const first = clearedArmedAtOf(lines, last.batch);
        if (first) g = { ...g, clearedArmedAt: first };
      }
    } catch { /* 台账读不到 ⇒ 维持现状,fail-closed 那侧 */ }
  }
  // 批 253(红队 BP-2):盘上是武装态时,若台账末尾是「结清某批 → 武装本批」,补上刚关掉那批的条件,
  //   让 K 在「同一轮关旧批、开新批」时能核对旧批有没有逐条对照。台账读不到或形状对不上 ⇒ 不补(K 报取不到,fail-closed)。
  if (g && !g.cleared && Array.isArray(g.conditions)) {
    try {
      const rows = fs.readFileSync(".claude/.batch-goal.jsonl", "utf8").trim().split("\n");
      g = priorClosedFromJournal(rows, g);
    } catch { /* 读不到 ⇒ 不补 */ }
  }
  // 批 256:AD 项(候选决定提示)要本批提交的**完整信息**——读提交对象,不读转录里的命令段
  //   (heredoc / -F / 多行 -m 在命令面看不全,codex 256 回件)。只在「未结清、有基点、决定清单为空」时跑一次 git。
  return attachBatchLog(g);
}

/** 给批状态补 `batchLog`(`git log <baseCommit>..HEAD` 的提交全文,每条一项)。纯函数式:git 可注入(自测)。
 *  不该查 / 取不到 ⇒ 原样返回(不加键 ⇒ ctx 里 batchLog=null ⇒ AD 沉默;提示面 fail-open)。 */
function attachBatchLog(g, git = (args) => execFileSync("git", args, { encoding: "utf8", cwd: process.cwd(), timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })) {
  if (!g || typeof g !== "object" || g.cleared || !Array.isArray(g.conditions)) return g;
  if (typeof g.baseCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(g.baseCommit)) return g;
  if (Array.isArray(g.decisions) && g.decisions.length) return g;
  try {
    const out = String(git(["log", "--format=%B%x00", "-n", "300", `${g.baseCommit}..HEAD`]) || "");
    return { ...g, batchLog: out.split("\0").map((s) => s.trim()).filter(Boolean) };
  } catch { return g; }
}

const _gitHere = (args) => execFileSync("git", args, { encoding: "utf8", cwd: process.cwd(), timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });

/** `git diff --name-status -M -z <range>` 的解析(唯一实现;分档事实与 HEAD 移动事实共用)。 */
function gitNameStatus(git, range) {
  const parts = String(git(["-c", "core.quotepath=false", "diff", "--name-status", "-M", "-z", ...range, "--"]) || "").split("\0");
  const files = [];
  for (let k = 0; k < parts.length && parts[k];) {
    const st = parts[k++];
    const oldPath = /^[RC]/.test(st) ? parts[k++] : null;
    const path = parts[k++];
    if (!path) break;
    files.push({ path, oldPath, status: st });
  }
  return files;
}

/** P 项的 **HEAD 移动事实**(红队 a27628dd:「本轮是否有承重提交 / 是否带进了闸引擎改动」改用 git 事实判)。
 *  base = 本会话上次 P 结清时的 HEAD。返回 `{ base, head, root, commits:[{sha, at, files}], engineAnchorAt }`:
 *    · base 是 HEAD 祖先 ⇒ `base..HEAD` 首父链上的每个提交,改动取**对第一父**(merge 同理:子代理在 worktree 改、
 *      父侧 `merge --no-ff` / `--squash`+commit / cherry-pick 合回,都在这里现形);
 *    · 不是祖先(amend / reset / 换分支)⇒ 取 merge-base..HEAD 首父链上的提交(红队 a2a9f58b BP-9:原取「base 与 HEAD 的
 *      树差」当一笔 ⇒ `reset --hard HEAD~1` 再提交业务改动时,被撤掉的承重 / 闸文件被算成改动),各自改动**只留 base 与 HEAD 之间
 *      真有差的路径**(只改提交信息的 amend ⇒ 无改动;amend 进新闸改动 ⇒ 正好是那几处);标 `rewritten`。
 *    · 每个提交带 `parents` 与 `branches`(合回提交的分支名:第二父上的分支指针 ∪ 合回标题里的 `Merge branch 'X'`;
 *      非合回提交为 [])——原供 P 的红队点名抵账(BP-8),该抵账已撤(D149④),现无消费者;
 *      每个合回提交多一次 `git branch --points-at` 调用,留待 D149④ 的非文本判据决定去留(红队 a12212b9 附节二④)。
 *    · engineAnchorAt = 范围起点**及更早**的最后一次带闸引擎改动的提交时刻(首父链,ms),P 的红队凭证切点。
 *      非祖先时取「base 自身那条链」与 merge-base 两者较晚的一个(BP-3:原只取 merge-base,amend 进已红队提交时切点回退得更早
 *      ⇒ 旧红队照样抵账;与祖先情形「切点 = base 上最后一次闸改动」对齐)。
 *    · 范围首父链提交 > 60(CAP)⇒ 不再返回 null(红队 a9af71da BP-1):整段当一笔聚合提交
 *      `{sha:HEAD, at, files:范围净差, aggregated:true, count}`,见函数内注。
 *  取不到(基点不合法、git 失败/超时)⇒ null ⇒ P 回退命令语法判据(fail-closed,不静默放行),
 *  且 hook 不推进基点(BP-2)。git 可注入(自测)。pathspecs = 闸引擎 pathspec(由 P 提供,与 ENGINE_REL 同一口径)。 */
/** 批 258 条件 4:按规则的报警量 × 误报率表(纯函数,自测直接调)。误报 = 自签 − 撤回(按规则 id 扣,不低于 0;撤回含 codex 盲审判拦对了的);
 *  待修 = 误报率 ≥ 15% 且报警 ≥ 20。按报警量降序。台账行形状:alerts `{ids:[…]}`;ledger `{kind, id}`。 */
/** 按规则的净误报(批 259,grill F1 / F8):自签 claimed_fp +1;执行方人工撤回(retraction,by≠codex)−1;
 *  codex 盲审判「拦对了」的**每一笔**(fp_audit 的 ref 去重)−1,该笔若已标「已人工撤回」则不再扣。
 *  r1 那次 fp-audit 另写过 by:codex 的 retraction 行——现由 fp_audit 推导,那种行不计(否则同一笔扣两次)。
 *  confirmed_fp(用户加签,已撤)是对已有自签的加签,不另计。 */
export function fpNetById(ledger) {
  // codex 259-final-r1 A3:人工撤回也按笔去重——带 ref 的撤回行(或「已人工撤回」标记)每笔只扣一次,
  //   撤回行写成功、标记行没写成功的半截情形照样认出这一笔已人工撤回,不再被 codex 结论二次扣
  const fp = {}, manual = new Map(), right = new Map();
  for (const x of ledger || []) {
    if (!x || !x.id) continue;
    if ((x.kind === "fp_audit" && x.verdict === "已人工撤回") || (x.kind === "retraction" && x.by !== "codex")) { if (x.ref) manual.set(x.ref, x.id); }
    if (x.kind === "fp_audit" && x.ref && x.by === "codex" && x.verdict === "拦对了") right.set(x.ref, x.id);
  }
  for (const x of ledger || []) {
    if (!x || !x.id) continue;
    if (x.kind === "claimed_fp") fp[x.id] = (fp[x.id] || 0) + 1;
    else if (x.kind === "retraction" && x.by !== "codex" && !x.ref) fp[x.id] = (fp[x.id] || 0) - 1;   // 老式不带 ref 的撤回:逐行扣(无从去重)
  }
  for (const [ref, id] of manual) {
    // 老式无 ref 撤回已经逐行扣过的那几笔(批 259 迁移补的「已人工撤回」标记 by:fp-audit-migration)不再重复扣
    const migrated = (ledger || []).some((x) => x && x.kind === "fp_audit" && x.ref === ref && x.by === "fp-audit-migration");
    if (!migrated) fp[id] = (fp[id] || 0) - 1;
  }
  for (const [ref, id] of right) if (!manual.has(ref)) fp[id] = (fp[id] || 0) - 1;
  return fp;
}

/** 误报率分母口径(fpTable 与 --fp-report 表头共用,红队 a30a87d8 BP-3):只数主 Stop 通道、不数 UNKNOWN。 */
export const fpRowCounted = (a) => !!a && a.channel !== "SubagentStop";
export const fpIdsOf = (a) => ((a && a.ids) || []).filter((id) => id !== "UNKNOWN");
export function fpTable(alerts, ledger, { minAlerts = 20, minRate = 0.15 } = {}) {
  const per = {}, fp = {};
  // 只数主 Stop 通道、不数 UNKNOWN:子代理通道只在观察档落 I/M/L/B 提示行,混进来会摊薄分母、让规则掉出「待修」
  //   (红队 a0dfbfce BP-4);UNKNOWN 是「没判成」,不是一条规则
  //   claimed_fp 不带通道:默认它针对主通道(本仓 211 笔里 0 笔属子代理通道);子代理行若有人记误报,分子会偏高(红队 a30a87d8 BP-4,D164⑬)
  for (const a of (alerts || []).filter(fpRowCounted)) for (const id of fpIdsOf(a)) per[id] = (per[id] || 0) + 1;
  for (const [id, d] of Object.entries(fpNetById(ledger))) fp[id] = d;
  return Object.keys(per).map((id) => {
    const f = Math.max(0, fp[id] || 0), rate = per[id] ? f / per[id] : 0;
    return { id, alerts: per[id], fp: f, rate, hot: per[id] >= minAlerts && rate >= minRate };
  }).sort((a, b) => b.alerts - a.alerts || a.id.localeCompare(b.id));
}

/** 批 266:原样装入的闸引擎(用户 10-19「红队要么设置成可选,要么就把红队体系完善了」;新仓装闸那次提交必撞 D11,
 *  而审原样拷入的发布件没有意义)。安装器写 `.claude/custodiet-manifest.json`:`{ files: { <仓相对路径>: <内容摘要> } }`;
 *  一个提交里**每个**闸引擎文件都满足「该提交树里的清单有这条路径、该提交树里的文件内容摘要与之相等」⇒ `vendoredEngine`。
 *  内容摘要 = CRLF 归一为 LF 后的 sha256(源仓 autocrlf 会让拷贝是 CRLF,目标仓存成什么取决于它自己的设置)。
 *  删除、改名、清单缺条目、清单读不到、聚合项、**清单标了源树不干净(`sourceClean !== true`)** ⇒ 不算(偏严:照旧要两个猎手)。
 *  能证明的只有「与安装清单一致」,不是「已审过的发布件」(codex 266-r1 §5):安装器从源树当前内容算摘要,
 *  故清单另记源树干净与否与源提交号——从改过、没提交的源树装进来的不豁免(红队 aa75af79 BP-1)。
 *  CEILING:手改清单去匹配改过的文件 ⇒ 认作原样装入——蓄意伪造形(用户代价模型不计)。 */
export const CUSTODIET_MANIFEST = ".claude/custodiet-manifest.json";
export const contentDigest = (s) => crypto.createHash("sha256").update(String(s).replace(/\r\n/g, "\n"), "utf8").digest("hex");
export function vendoredEngineCommit(git, c, isEngine) {
  if (!c || c.aggregated || typeof c.sha !== "string" || !Array.isArray(c.files) || typeof isEngine !== "function") return false;
  const eng = c.files.filter((x) => isEngine(x.path) || (!!x.oldPath && isEngine(x.oldPath)));
  if (!eng.length) return false;
  let files = null, m = null;
  try { m = JSON.parse(String(git(["show", `${c.sha}:${CUSTODIET_MANIFEST}`]) || "")); files = m && typeof m.files === "object" ? m.files : null; } catch { return false; }
  if (!files || m.sourceClean !== true) return false;
  return eng.every((x) => {
    if (x.oldPath || /^D/.test(String(x.status || ""))) return false;
    const want = files[x.path];
    if (typeof want !== "string" || !/^[0-9a-f]{64}$/i.test(want)) return false;
    let body; try { body = String(git(["show", `${c.sha}:${x.path}`])); } catch { return false; }
    return contentDigest(body) === want.toLowerCase();
  });
}

export function readHeadFacts(base, git = _gitHere, pathspecs = [], engineRe = null) {
  if (typeof base !== "string" || !/^[0-9a-f]{7,64}$/i.test(base)) return null;
  const HEX = /^[0-9a-f]{40,64}$/i;
  try {
    const root = String(git(["rev-parse", "--show-toplevel"]) || "").trim();
    const head = String(git(["rev-parse", "HEAD"]) || "").trim();
    const full = String(git(["rev-parse", "--verify", `${base}^{commit}`]) || "").trim();
    if (!root || !HEX.test(head) || !HEX.test(full)) return null;
    const CAP = 60;
    const commits = [];
    let anchor = full;
    let ancestor = true;
    try { git(["merge-base", "--is-ancestor", full, head]); } catch { ancestor = false; }
    if (!ancestor) {
      anchor = String(git(["merge-base", full, head]) || "").trim();
      if (!HEX.test(anchor)) return null;
    }
    if (anchor !== head) {
      // 字段以 \x1f 分隔:sha、提交时刻、父提交(空格分隔)、标题
      const lines = String(git(["rev-list", "--first-parent", `--max-count=${CAP + 1}`, "--format=%H%x1f%ct%x1f%P%x1f%s", "--no-commit-header", `${anchor}..${head}`]) || "")
        .split("\n").map((s) => s.trim()).filter(Boolean);
      // 非祖先:只留 base 与 HEAD 之间真有差的路径(BP-9)
      let differ = null;
      if (!ancestor) {
        differ = new Set();
        for (const x of gitNameStatus(git, [full, head])) { differ.add(x.path); if (x.oldPath) differ.add(x.oldPath); }
      }
      const keep = (files) => (differ ? files.filter((x) => differ.has(x.path) || (!!x.oldPath && differ.has(x.oldPath))) : files);
      if (lines.length > CAP) {
        // 红队 a9af71da BP-1:原来这里返回 null ⇒ hook 不推进基点 ⇒ 范围只增不减 ⇒ 本会话此后事实恒 null、P 永久退回语法面
        //   (语法面看不见 merge 合回的闸改动;跑齐三通道也恢复不了)。现把整段范围当**一笔聚合提交**:改动取范围净差
        //   (一次 diff,无上限),带范围内首父链提交数 `count`(取不到按 CAP+1 计,只会多计)与 `aggregated: true`;
        //   sha / at 取 HEAD(首父链第一行)。P 侧按 `count` 计账(偏严)、按范围键 `agg:<基点>..<HEAD>` 去重(codex 257-p-agg-r1 断言 2:
        //   只按 HEAD sha 去重会吞掉变大的范围;基点非全长 sha ⇒ 不去重);P 结清即推进基点 ⇒ 溢出可恢复。
        //   CEILING:净差看不见「范围内改了又改回」的承重改动(净差为空 ⇒ 不计);合回分支名不取(点名覆盖已撤,无消费者)。
        const [sha, ct] = lines[0].split("\x1f");
        if (!HEX.test(sha || "") || sha.toLowerCase() !== head.toLowerCase()) return null;
        let cnt = NaN;
        try { cnt = Number(String(git(["rev-list", "--first-parent", "--count", `${anchor}..${head}`]) || "").trim()); } catch { /* 取不到 ⇒ 按 CAP+1 */ }
        commits.push({ sha, at: /^\d+$/.test(ct || "") ? +ct * 1000 : null, files: keep(gitNameStatus(git, [anchor, head])), parents: [], branches: [],
          aggregated: true, count: Number.isInteger(cnt) && cnt > CAP ? cnt : CAP + 1, ...(ancestor ? {} : { rewritten: true }) });
      } else for (const ln of lines.reverse()) {
        const [sha, ct, ps = "", subject = ""] = ln.split("\x1f");
        if (!HEX.test(sha || "")) return null;
        const parents = ps.split(/\s+/).filter((p) => HEX.test(p));
        const files = keep(gitNameStatus(git, [`${sha}^1`, sha]));
        const branches = [];
        if (parents.length > 1) {
          const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
          if (m) branches.push(m[1]);
          try {
            for (const b of String(git(["branch", "--format=%(refname:short)", "--points-at", parents[1]]) || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
              if (!branches.includes(b)) branches.push(b);
            }
          } catch { /* 分支指针取不到 ⇒ 只用标题 */ }
        }
        commits.push({ sha, at: /^\d+$/.test(ct || "") ? +ct * 1000 : null, files, parents, branches, ...(ancestor ? {} : { rewritten: true }) });
      }
    }
    let engineAnchorAt = null;
    if (Array.isArray(pathspecs) && pathspecs.length) {
      const at = (rev) => { const ct = String(git(["log", "--first-parent", "-1", "--format=%ct", rev, "--", ...pathspecs]) || "").trim(); return /^\d+$/.test(ct) ? +ct * 1000 : null; };
      const xs = [at(full), ...(ancestor ? [] : [at(anchor)])].filter((x) => x !== null);
      engineAnchorAt = xs.length ? Math.max(...xs) : null;
    }
    // 批 266:原样装入的闸引擎提交打标(见 vendoredEngineCommit);判不了一律不打标
    if (engineRe instanceof RegExp) for (const c of commits) { try { if (vendoredEngineCommit(git, c, (p) => engineRe.test(p))) c.vendoredEngine = true; } catch { /* 不打标 */ } }
    return { base: full, head, root, commits, engineAnchorAt };
  } catch { return null; }
}

/** P 的 HEAD 基点(每会话一份:`.claude/.p-head/<会话 id>.json`,gitignore 面)。
 *  按会话分文件:同一 checkout 上别的会话结清不得替本会话推进基点。
 *  失效条件:无会话 id ⇒ 不读不写(P 回退语法判据)。 */
const P_HEAD_DIR = ".claude/.p-head";
const pHeadFile = (sid) => (typeof sid === "string" && /^[\w-]{1,128}$/.test(sid) ? `${P_HEAD_DIR}/${sid}.json` : null);
function readPHead(sid) {
  const p = pHeadFile(sid);
  if (!p) return null;
  try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return typeof j.head === "string" && /^[0-9a-f]{40,64}$/i.test(j.head) ? j.head : null; }
  catch { return null; }
}
/** 写基点。`head` = 读 git 事实那一刻的 HEAD(红队 a2a9f58b BP-6:原来在这里重新 `rev-parse HEAD`
 *  ⇒ 读事实与写基点之间落的提交永远不被审);不给才现取。 */
function writePHead(sid, head, git = _gitHere) {
  const p = pHeadFile(sid);
  if (!p) return;
  if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/i.test(head)) head = String(git(["rev-parse", "HEAD"]) || "").trim();
  if (!/^[0-9a-f]{40,64}$/i.test(head)) return;
  fs.mkdirSync(P_HEAD_DIR, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify({ head, at: new Date().toISOString() })); fs.renameSync(tmp, p); }
  finally { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 残骸不阻断 */ } }
  // 30 天未动的会话基点顺手清掉(会话早已结束;残留只占盘,不影响判据)
  try {
    const old = Date.now() - 30 * 86400e3;
    for (const n of fs.readdirSync(P_HEAD_DIR)) { const q = `${P_HEAD_DIR}/${n}`; if (fs.statSync(q).mtimeMs < old) fs.unlinkSync(q); }
  } catch { /* 清理失败不影响 */ }
}
/** 基点:有基点文件用它;没有(会话第一次 Stop)⇒ 取**会话开始时刻**的 HEAD(reflog `HEAD@{时刻}`)。
 *  会话开始时刻 = 转录里第一条带时间戳的条目。取不到 ⇒ null(P 回退语法判据)。
 *  红队 a2a9f58b BP-2 附带:`HEAD@{早于 reflog 起点}` 带 -q 时**静默返回最老一条记录**(不报错)⇒ reflog 被截断时,
 *  会话开始到截断点之间的提交会落在基点之前、永不被审。现读 HEAD reflog 第一行:其时刻晚于会话开始、且不是建立记录
 *  (旧 sha 非全零;全零 = checkout 自此才有 HEAD,最老记录就是起点,照用)⇒ 当作取不到。读 reflog 的函数可注入(自测)。 */
const _reflogFirstLine = (git) => {
  const p = String(git(["rev-parse", "--git-path", "logs/HEAD"]) || "").trim();
  if (!p) return "";
  const fd = fs.openSync(p, "r");
  try { const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); return buf.toString("utf8", 0, n).split("\n")[0] || ""; }
  finally { fs.closeSync(fd); }
};
/** reflog 取不到基点时的退路(红队 a9af71da BP-1 附):**未结清**的当前批的 `baseCommit`。
 *  红队 a07e98e9 BP-5(误拦):原从台账尾部倒找第一条 arm 行、不看其后的 clear 行 ⇒ 批已结清后的新会话拿已关批的基点
 *  ⇒ 整批提交算到新会话头上(现场 66803b1..HEAD 首父链 61 笔 ⇒ 聚合计 61)。现两处都认结清:
 *  · `batchBaseOfGoal(g)`:hook 已读的批状态(`ctx.batchGoal` / `readBatchGoal()`),`cleared` ⇒ null(生产调用点用它);
 *  · `batchBaseFromRows(rows)`:台账行,最后一条 arm 之后若有 clear 行 ⇒ null(默认退路,状态读不到时的兜底)。
 *  读不到 / 没有 / 坏 ⇒ null。 */
export function batchBaseOfGoal(g) {
  if (!g || typeof g !== "object" || g.cleared) return null;
  return typeof g.baseCommit === "string" ? g.baseCommit : null;
}
export function batchBaseFromRows(rows) {
  for (let i = (rows || []).length - 1; i >= 0; i--) {
    let r; try { r = typeof rows[i] === "string" ? JSON.parse(rows[i]) : rows[i]; } catch { continue; }
    if (r && r.action === "clear") return null;                 // 最后一次 arm 之后已结清 ⇒ 没有当前批
    if (r && r.action === "arm") return typeof r.baseCommit === "string" ? r.baseCommit : null;
  }
  return null;
}
const _batchJournalBase = () => {
  if (process.env.STOP_CLOSURE_SELFTEST === "1") return null;   // 自测隔离(同 readPLedger:测出来的东西不得取决于磁盘上碰巧有什么)
  try { return batchBaseFromRows(fs.readFileSync(".claude/.batch-goal.jsonl", "utf8").trim().split("\n")); }
  catch { return null; }                                          // 台账读不到 ⇒ 无退路
};
/** 退路 `batchBase`(可注入,自测):reflog 那支取不到(截断 / 读不懂 / 无时间戳 / HEAD@{} 解析不出)时,当前批的 `baseCommit`
 *  是 HEAD 祖先 ⇒ 用它当基点;否则维持 null(P 回退语法判据)。
 *  CEILING(登记残余):批基点晚于会话开始 ⇒ 会话开始到武装之间的提交不在 git 事实范围内(只剩语法面看);
 *  早于会话开始 ⇒ 范围更大(只会多看,方向偏严;超 60 笔走聚合)。 */
export function pHeadBase(sid, entries, git = _gitHere, reflogFirst = _reflogFirstLine, batchBase = _batchJournalBase) {
  if (!pHeadFile(sid)) return null;
  const b = readPHead(sid);
  if (b) return b;
  const fromReflog = () => {
    try {
      const first = (entries || []).find((e) => e && typeof e.timestamp === "string" && Number.isFinite(Date.parse(e.timestamp)));
      if (!first) return null;
      const t0 = Date.parse(first.timestamp);
      const d = new Date(t0).toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");
      const v = String(git(["rev-parse", "--verify", "-q", `HEAD@{${d}}`]) || "").trim();
      if (!/^[0-9a-f]{40,64}$/i.test(v)) return null;
      const m = /^([0-9a-f]{40,64}) [0-9a-f]{40,64} .*? (\d+) [+-]\d{4}(\t|$)/i.exec(String(reflogFirst(git) || ""));
      if (!m) return null;                                         // reflog 读不懂 ⇒ 不知道够不够早 ⇒ 取不到
      if (+m[2] * 1000 > t0 && !/^0+$/.test(m[1])) return null;   // 起点晚于会话开始且不是建立记录 ⇒ 被截断
      return v;
    } catch { return null; }
  };
  const v = fromReflog();
  if (v) return v;
  try {
    const bb = typeof batchBase === "function" ? batchBase() : null;
    if (typeof bb !== "string" || !/^[0-9a-f]{7,64}$/i.test(bb)) return null;
    git(["merge-base", "--is-ancestor", bb, "HEAD"]);           // 非祖先 ⇒ 抛 ⇒ null
    return bb;
  } catch { return null; }
}

/** P 项分档的 diff 事实(批 257 条件 3;判据在 `lib/gate-difftier.mjs`):批基点到 HEAD **并上**基点到工作树的改动文件
 *  (提交后又在工作树还原的,两边任一处出现都算,红队 c3 BP-7 同族),带状态、改名的旧路径、新内容读不读得到。
 *  只在 P 真欠跨模型/联网时由 ctx.diffTier 惰性调用;只用 `--name-status`,不取全文(红队 c3 BP-8:逐文件 git show 会撞 hook 超时)。
 *  取不到(无基点、git 失败、文件过多)⇒ null(不分档)。git / exists 可注入(自测)。 */
export function readDiffFacts(base, git = (args) => execFileSync("git", args, { encoding: "utf8", cwd: process.cwd(), timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }),
  exists = (p) => fs.existsSync(p), readText = (p) => fs.readFileSync(p, "utf8")) {
  if (typeof base !== "string" || !/^[0-9a-f]{7,64}$/i.test(base)) return null;
  try {
    const root = String(git(["rev-parse", "--show-toplevel"]) || "").trim();
    if (!root) return null;
    const files = [];
    for (const range of [[base, "HEAD"], [base]]) {
      for (const f of gitNameStatus(git, range)) {
        files.push({ ...f, readable: /^[AM]/.test(f.status) ? exists(`${root}/${f.path}`) : false, head: range.length === 2 });
      }
    }
    if (files.length > 600) return null;
    // 文案类已撤(用户 10-10,D144):分档只看测试文件名,不取前后全文(逐文件 git show 也有撞 hook 超时的风险)。
    void readText;
    return { base, root, files };
  } catch { return null; }
}

/** 从台账行补「刚关掉那批」的条件。纯函数(不读盘),抽出来供自测直接喂行。
 *  从最后一条 arm 往回走:
 *    · 批号与当前批相同的行(重开的 arm、`--arm <同号> --force` 留下的 force-over-checks)⇒ 跳过,继续往回;
 *    · clear 行:批号≠当前批且带条件数组 ⇒ 补 priorClosed;否则不补。遇到 clear 即停;
 *    · 其它(别的批号的 arm、读不懂的行、无 action 的链首行)⇒ 停,不补(K 报取不到,fail-closed 那侧)。
 *  批 253b(红队 BP-14):旧实现只看「最后 arm 行的前一行」,同轮 clear 253 → arm 254 → `--arm 254 --force`
 *    重开时前一行是 arm 254 ⇒ 补不出 ⇒ K 阻断误报「取不到」。
 *  残余:最后 arm 与当前批号对不上(盘上状态与台账不同步)⇒ 不补,照旧报取不到。 */
/** 结清态的「本批从何时起」(批 258,W 的 `clearedArmedAt`):台账从末尾的 clear 行往前走,收集同批号的 arm 行,
 *  遇到更早的 clear 行或别批的 arm 行即停,取最早那条 arm 的 `at`。取不到 ⇒ null(W 退回整窗口,偏严)。 */
export function clearedArmedAtOf(rows, batch) {
  if (!Array.isArray(rows) || !rows.length || batch == null) return null;
  let first = null;
  for (let i = rows.length - 2; i >= 0; i--) {     // 末行是本次 clear
    let r; try { r = JSON.parse(rows[i]); } catch { break; }
    if (!r || r.action === "clear") break;
    if (r.action === "arm") { if (r.batch !== batch) break; if (typeof r.at === "string") first = r.at; }
  }
  return first;
}
/** 批 258(codex 258-cond2-r2):「本轮开始那一刻正开着的那一批」从何时起——W 按它切交付物(取较早者)。
 *  台账从头顺读到本轮开始时刻:arm 时若无开着的批则记起点(同号重放不刷新),clear 即关;本轮开始时有开着的批 ⇒ 它的起点;
 *  没有 ⇒ 本轮内第一次 arm 的时刻;都没有 ⇒ null。覆盖「同号关账后重开」「同轮连关两批」(此前的单步回溯只看最后一段)。
 *  turnStartMs 取不到(本轮条目无时间戳)⇒ null(W 退回其余起点 / 整窗口,偏严)。 */
export function turnBatchStartOf(rows, turnStartMs) {
  if (!Array.isArray(rows) || !Number.isFinite(turnStartMs)) return null;
  let openSince = null, firstInTurn = null;
  for (const line of rows) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const at = Date.parse(String((r && r.at) || ""));
    if (!Number.isFinite(at)) continue;
    if (at < turnStartMs) {
      if (r.action === "arm" && openSince === null) openSince = r.at;
      else if (r.action === "clear") openSince = null;
    } else if (r.action === "arm" && firstInTurn === null) firstInTurn = r.at;
  }
  return openSince || firstInTurn;
}
function priorClosedFromJournal(rows, g) {
  const cur = g?.batch ?? null;
  const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  let i = rows.length - 1;
  for (; i >= 0; i--) {
    const r = parse(rows[i]);
    if (r === undefined) return g;
    if (r?.action === "arm") break;
  }
  if (i < 0 || (parse(rows[i]).batch ?? null) !== cur) return g;
  for (let j = i - 1; j >= 0; j--) {
    const r = parse(rows[j]);
    if (r === undefined) return g;
    if (r?.action === "clear") {
      if (!(Array.isArray(r.conditions) && (r.batch ?? null) !== cur)) return g;
      // 批 258(复核红队 BP-1):同轮「关旧批 → 开新批」时,W 要按**被关那批**的起点切交付物——补回它最早一次武装的时刻
      const priorArmedAt = clearedArmedAtOf(rows.slice(0, j + 1), r.batch ?? null);
      return { ...g, priorClosedBatch: r.batch ?? null, priorClosedConditions: r.conditions, ...(priorArmedAt ? { priorClosedArmedAt: priorArmedAt } : {}) };
    }
    if (r?.action && (r.batch ?? null) === cur) continue;
    return g;
  }
  return g;
}

/** 逃生口表:`emit()` 印出的 `STOP_CLOSURE_BLOCK_<id>=0` 只有在这里有键才真的能关。
 *  提到模块级是为了让**自测够得着它**(见「逃生口对账」),
 *  否则它藏在 `emit()` 里,与引擎的声明式 `blocking` 之间永远没有对账。 */
/** id → **环境变量后缀**。这是唯一事实源:`BLOCK_OFF` 与 `emit()` 印出的提示**都从它派生**。
 *
 *  ⚠️ 2026-08-20 grill:architecture P6 实撞:两者原本各写各的 ——
 *    `emit()` 硬编码 `f.id === "E0" ? "E" : f.id` ⇒ 印出 `STOP_CLOSURE_BLOCK_K0=0` /
 *    `..._E2=0`,而表里 `K0: BLOCK_ON_K`、`E2: BLOCK_ON_E` ⇒ **印出来的变量没人读**。
 *  两个方向都坏:照它说的敲没反应(可见、便宜);敲真正生效的 `..._K=0` 想放行 K,
 *  会**连 K0 一起永久关掉**——另一条规则、另一份义务,fail-open 且不可见。
 *  ⇒ 派生而非并列。**共用一个环境变量这件事本身仍在**(K/K0 同开关),
 *    但现在它至少是**印出来那个**,不再骗人;要拆成独立开关是另一批。 */
const BLOCK_ENV = { A: "A", E0: "E", E1: "E", E2: "E", I: "I", J: "J", W: "W",
  K: "K", K0: "K", M: "M", R: "R", Q: "Q", S: "S", T: "T", U: "U", ND: "ND", DP: "DP", X: "X" };

// ⚠️ **由 BLOCK_ENV 计算得出,不再是第二张手写表**(D21 结案,codex 072 裁决原话:
//   「对账只能发现漂移,不能阻止漂移」——一份表按构造不漂)。
//   E1 刻意不在 BLOCK_ENV(非阻断);P 刻意不在(**无逃生口**,用户裁定,对账测试同步注册例外)。
/** 观察档开关(批 265):`.claude/custodiet-mode` 首行 = observe,且该文件已提交、未改动、早于本会话开始提交。读不到 ⇒ 不是观察档(照常阻断)。 */
//   逃生口封堵(批 265):文件若会话里随手写一行就生效,等于一个对**所有**规则(含无逃生口的 P)零成本的总开关。
//   ⇒ 文件只在三件都成立时算数:已提交进 git、工作树与 HEAD 一致、最后改它的提交**早于本会话开始**。
//   会话里新写 / 改 / 写完再提交,都不生效(照常阻断);装闸(提交)之后新开的会话才进观察档。
//   环境变量那支已撤(红队 a9bf37ae BP-2:裸环境变量不绑仓,给比赛仓设了它,本仓的闸也跟着静音)。
//   自测经 `_observeForTest` 注入,不读宿主仓的模式文件(BP-5)。
let _observeForTest = null;
/** 本仓是否立过批:本 checkout 或主 checkout 的批台账 / 状态文件在场(批 265;codex 265-r1 A3 补主 checkout)。
 *  查不出主 checkout(git 失败 / 超时 / 太旧不认 --path-format)⇒ undefined(K0 照判),不落 false(红队 a363e144 BP-2:原先静默落「不判」)。 */
function batchEverArmedHere() {
  const has = (root) => [".claude/.batch-goal.jsonl", ".claude/.batch-goal.json"].some((f) => fs.existsSync(path.join(root, f)));
  if (has(".")) return true;
  let common = "";
  try {
    common = String(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })).trim();
  } catch { return undefined; }
  if (!common) return undefined;
  return has(path.dirname(common));
}
function observeMode() {
  if (_observeForTest !== null) return _observeForTest;
  const F = ".claude/custodiet-mode";
  try { if (fs.readFileSync(F, "utf8").split(/\r?\n/)[0].trim() !== "observe") return false; } catch { return false; }
  try {
    const git = (a) => execFileSync("git", a, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    git(["ls-files", "--error-unmatch", "--", F]);
    git(["diff", "--quiet", "HEAD", "--", F]);              // 工作树与 HEAD 不同 ⇒ 抛 ⇒ 不算
    const ct = Number(String(git(["log", "-1", "--format=%ct", "--", F])).trim());
    if (!Number.isFinite(ct) || ct <= 0) return false;
    const first = (_allEntriesCache || []).find((e) => e && typeof e.timestamp === "string" && Number.isFinite(Date.parse(e.timestamp)));
    if (!first) return false;                                 // 不知道会话何时开始 ⇒ 不认(fail-closed)
    // git 提交时间只有秒精度:按该秒的最后一毫秒算(codex 265-r1 附 3:同秒稍后的会话内提交原先会被认)
    return ct * 1000 + 999 < Date.parse(first.timestamp);
  } catch { return false; }
}
const BLOCK_OFF = Object.fromEntries(
  Object.entries(BLOCK_ENV).map(([id, sfx]) => [id, process.env[`STOP_CLOSURE_BLOCK_${sfx}`] !== "0"]));
/** 引擎是否为已迁规则的**权威**。已硬编码 true,**无运行时回退**——回退=git revert 切换 commit(见下)。
 *  (2026-08-23 修注:旧注「设为 0 即整体退回」描述的是切换前的 env 开关形态,早已失效——批 091 codex 复核逮到。) */
// ⚠️ **切换已执行(2026-08-22 用户亲签「12签咯;3…正常做就好」)**:引擎独占,env 逃生口焊死。
//   此前 `process.env.STOP_CLOSURE_ENGINE !== "0"` 留着一行回退——切换判定 5/5 GO
//   (K0/U 覆盖走亲签例外)后,回退线改为 **git revert 本次切换 commit**,不再留运行时开关:
//   运行时开关的代价已实测过一族(BLOCK_CAP 那次:「一个让闸永不阻断的改动会 44/44 通过,
//   而且连改代码都不需要」)。
const ENGINE_AUTHORITATIVE = true;

// ── 模式表(B/C/D)。刻意写得窄:宁可漏报,不要吵到被加 flag 绕过——那是 C25 的死法。
export const PAT = {
  promise: [
    /我(这就|马上|现在就|接下来)(去|就)?(做|办|改|写|修|落|跑|查|核|补|处理|加)/,
    /我打算(这么|这样)?做/,
    /不问[,,]\s*(你)?(喊停|叫停)/,
    /(下一步|接下来)我会/,
    // ⚠️ **已知召回缺口,试过放宽,失败了,记在这里免得下次再试一遍**(2026-08-20)。
    //   用户当场逮到:我说「这期间接着收 E8/E11」然后回合结束,B 一声没响 ——
    //   它只认「我这就去改 X」这种第一人称显式句,不认「接着收 X」「下一批做」
    //   这类**省略主语的跨轮承诺**,而后者才是我最常写的形态。
    //   我加了四条形态(全取自当日原话),**两个证据说明这个改法是错的**:
    //     ① 对照组失败:真动手了 B 照样命中 —— 「E8/E11」不是文件路径,目标比对匹配不上;
    //     ② 与 Q 打架:「说留给下次但没指出阻断」变成 B+Q 双报,纯重复噪声。
    //   **根因是塞错了地方**:B 管「本轮承诺、本轮零动作」,而「下一批做」不是同轮承诺,
    //   是**跨轮欠账** —— 判据形状不同(前者比对本轮动作面,后者要跨轮账本 + 失效期)。
    //   ⇒ 正解是单立一条欠账规则,与「登记未修需带失效期」是同一件事,已在 codex 呈签件里。
    //   **不要再往 promise 里加跨轮形态。**
  ],
  defect: [
    /(还)?(没|未)(有)?(落盘|入仓|接线|生效|实现|覆盖|做完)/,
    /(缺|少)(了|一个|一条|一处)/,
    /只(有|看得到).{0,12}(没|缺)/,
    /(不在|没进)(仓|索引|白名单)/,
  ],
  downgrade: [
    /要不要我(去|帮你)?/,
    /你要是(要|想)/,
    /我可以(帮你|去)?(跑|做|核|查)/,
    /需要(我)?(的话|再)/,
  ],
  // E 项:因果断言。纪律 32 第②款要求它走双通道(能造机械判据→xros:compile+run;
  // 造不出→xros:reason + codex 独立复核,一个管形一个管独立性)。
  // ⚠️ 召回率是本项的命门:2026-08-19 实测,原五条模式对当日全部输出只逮到 3 条,
  // 而实际因果断言远多于此——最常见的「X 是因为 Y」因原模式强制要求「之所以」而全数漏过。
  // 宁可误报不可漏报(本项只提示不阻断,误报成本≈一行提示;漏报成本=断言无声进法条)。
  causal: [
    /根因(是|在于)/,
    /(是|系)因为/,                        // 「X 是因为 Y」——最常见形态,原版漏
    /(原因|理由|症结)(是|在于)/,
    /(之所以)/,
    /(导致|造成|使得|让).{0,20}(了)?(这|该|上述|它|我)/,
    // ⚠️ 以下两条 2026-08-20 用户亲签「这两条没啥问题,改呗」后加,补的是实测出来的召回洞。
    //   原表对六条明摆着的中文因果句**漏 4 条**,漏的都是最自然的说法:
    //     「路径写错**导致**整闸失效」「**这导致**整闸失效」「正则跨段匹配**使得**目标取错」
    //       —— 上一条要求 `导致` 后 20 字内出现「这/该/它/我」,而中文里那个词常在**前面**;
    //     「改坏**了因为**路径写错」—— `(是|系)因为` 要求前面是「是/系」。
    //   memory `causal-claim-threshold` 记着 E0 真实召回 **3/20**,与此一致。
    //   ⚠️ 代价是**误报必涨**,已在全语料上量过(见本次提交信息里的前后对比)。
    //   天花板不变:它认的是**措辞**,判不出那句话是不是真在下因果断言
    //   ——引用别人的话、讨论这条判据本身,都会命中。
    /(导致|造成|使得)/,
    /(了|过|完|完了)因为/,
    /(说明|证明|意味着)(了)?(它|这|该|我们)/,
    /(因为|由于).{0,40}(所以|因此|于是|才)/,
    /(正是|恰恰是).{0,20}(因为|由于)/,
    /(解释了|能解释)/,
  ],
  // F 项:裸完成断言。汇报法「完成性断言须与未覆盖栏一致」的**对话版**——
  // report-gate.mjs 实现了这条,但它只作用于报告文件,对话式收尾无作用对象
  // (2026-08-19 实撞:同一段里既说「9 项全部执行完毕」又登记「还欠一件」)。
  done: [
    /(全部|都|均)(已)?(执行完|做完|完成|落地|落盘)/,
    /\d+\s*项(全部|都)(完成|执行完|落)/,
    /(已)?全(部)?(搞定|办完|结清)/,
  ],
  owed: [
    /欠(件|着|一件|一条)/,
    /(还)?(没|未)(造|做|跑|接|验证|落盘|入仓)/,
    /(零|0)\s*(次)?调用/,
    /(待办|未覆盖|留给下(批|轮)|下批再)/,
  ],
  // G 项:关账/提交动作。汇报法「关账前自审一遍」的机器提醒——
  // 2026-08-19 实撞:当日自审查出的四条漏,六项机器闸无一能发现。
  selfAudit: [/自审/, /grill\s*yourself/i, /逐条(核对|自查)/, /四问/],
  // I 项:纪律 32「造之前先扫工具面」的**闸化**。该纪律 2026-08-17 立,
  // 但它住在 skill 正文(按需加载)且只是纪律不是闸,故 08-19 同一个病复发三次
  // (扫了已装件仍手搓官方已有实现 / xros 联动未触发 / 绕过命令直调底层)。
  // 判据取「本轮新建了载体文件」这一结构事实,不猜意图。
  scanned: [/工具面已扫/, /已扫(三层|一遍)/, /命中\s*\d|无命中/, /扫过(工具面|三层)/],
  // S 项:**把决定推回给用户**的表述。只收「我停下来等你定」那一族,
  // 不收「等 codex 回件」「等 grill」——那是等机器,不是停工。
  // ⚠️ 判据故意窄:宁可漏报也不误伤正常的信息性提问。
  //   立法动机是当日实撞——我连续多轮用问句结尾(「选 A/B/C 吗」「E7–E11 收不收」),
  //   而那些问题的答案**仓里的代价不对称已经写死了**。用户三次问「为什么就停了」,
  //   答案每次都是「不是闸放的行,是我自己停的」。
  handoff: [
    /等你(一句话|放行|裁|说|定|确认|回)/, /你说一声/, /归你(裁|定|签|决)/,
    /要不要(现在)?(收|做|修|改|加|立)/, /收不收|做不做|改不改|要不要继续/,
    /你(来)?(定|裁|拍板|选)/, /请你(裁|定|选)/, /等你的?(裁决|决定|意见)/,
    // **摆选项让用户挑**——当日实撞的正是这一形态(「选 A / B / C，还是先不做？」),
    // 而第一版 handoff 漏了它:自测「过」是因为模式没命中,不是因为那句话合法。
    // 差点据此宣布 S 覆盖到位。
    /[A-D]\s*[\/、]\s*[A-D]/, /还是先不做|要不要先/, /哪(个|种)方案/,
    // ⚠️ **第三次漏网,形态同前两次:本表是措辞白名单**(2026-08-26,用户逮到)。
    //   实况漏网句:「要我现在接着办 D60,还是**先停在这里**?」——同一个行为、第一人称说法,
    //   上面 11 条一条不中 ⇒ S 整条跳过,连「标没标 ⏸」那一问都没走到。
    //   我不是故意绕的,这更糟:**规则能不能拦住我,取决于我碰巧挑了哪个词**。
    //   下面补的是「把『继续 vs 停下』摆给用户挑」这一族的通用形状,不再逐句枚举:
    /要我(现在)?[^。?？]{0,12}(还是|,还是)/,          // 要我…还是…
    /还是(先)?(停|不做|放着|搁|等)/,                    // …还是先停在这里
    // ⚠️ 原写作 `/(需不需要|是否需要|用不用)(我)?[^。?？]{0,10}/` —— 跨模型复核 Q3 判它
    //   **误报面可能高频**:不要求问号、不要求指向用户,技术讨论里「这里需不需要加个锁」
    //   这类**自问自答**会被命中。已收窄为「必须指向我 + 必须以问号收尾」。
    /(需不需要|是否需要|用不用)我[^。]{0,14}[?？]/,      // 需不需要我…?
    /(接着|继续)(办|做|干|修)[^。?？]{0,10}(还是|吗|？|\?)/,
    // 天花板(照抄进任何引用本表的报告):**本表仍是措辞面,不是行为面**。
    //   真正的行为判据应是「本轮以提问收尾 + 批目标尚有未达成条件 + 无阻断理由」,
    //   那需要结构信号而不是正则。已登记 D67,补上之前本表只能靠加词维持。
  ],
  // ⚠️ 光有 `handoff` 不够:**「陈述某事归你」≠「停下来等你」**。
  //   实撞:Q 的用例「这件留给下次——它改的是授权边界,需亲签,归你签。」被 S 误伤,
  //   而那是一条**合法的推迟**(Q 的地盘),不是停工。
  //   ⇒ 再要一个「真的在问」的标志:问号,或显式的等待动词。
  askMark: [/？|\?/, /等你/, /你说一声/, /等你的?(裁决|决定|意见)/],
  // T 项:**把「登记」当成处置**的表述。
  registered: [/已登记未修/, /登记(未修|在案|下来|了)/, /记在案/, /先挂着|挂着不修|暂不处理/,
    /登记(而非|不是)处置/, /已(记|录)(下|入)(案|册)/],
  // 失效期标记:到期就该自动回到 active。
  // ⚠️ 2026-08-27(D84):原表不认 **`失效期 ≤NNN`** —— 而那正是 `docs/gate-debts.md`
  //   全表在用的规范记法(每一行的失效期列都是 `≤115`/`≤118` 这个形状)。
  //   于是:照台账的写法交代失效期,T 判「没给失效期」。**第十次同型**——
  //   闸的判据不认本仓自己的规范记法。方向是**误拦**:交代了却被判没交代。
  //   要求带数字,免得只写「失效期」三个字就过。
  expiry: [/失效条件/, /到期/, /\d+\s*(批|天|周|月)内/, /下(一)?批(必|须)/, /复议/,
    /\d{4}-\d{2}-\d{2}/, /(本|下)批(收尾|关账)前/,
    /失效期\s*[:：]?\s*(≤|<=|不晚于)?\s*\d+/, /(≤|<=)\s*\d{2,4}\s*批?/],
  // 宪法:「停下等确认必标『⏸ 需要你确认』——三家 CLI 唯一通用等待标识,不得省略」。
  // ⚠️ 认**宪法写死的规范形态**,不认裸字符(2026-08-26 实测误报,当轮就撞上):
  //   宪法「永久红线」写的是「停下等确认必标『⏸ 需要你确认』——三家 CLI 唯一通用等待标识」。
  //   而判据只认一个裸 `⏸` ⇒ **讨论这个标记本身就会触发它**:那一轮我在复述用户的话、
  //   写夹具名、写判据说明,文里出现了三次 ⏸,零次真停工 ⇒ S 判「标了但没给理由」。
  //   这在本仓是高频形态——闸自己就是本仓的工作对象,谈论判据是日常。
  //   收紧成「⏸ + 需要你确认(允许中间有空白/冒号)」或行首独立出现,不是加规矩,是照宪法改对。
  //   ⚠️ **拆成两个判据**(2026-08-26 跨模型复核 Q4 判「方向只对了一半」):
  //     收紧「合规凭证」是对的,但**同时把它当成唯一的「停工意图入口」**是在**放松闸**——
  //     一个只写了裸 `⏸`、不写规范形态的停工,会从「该被拦的违规停工」变成「完全不审」。
  //     故:`waitMark` = **意图**面(宽,但要求行首独立出现,以排除散文里的提及);
  //         `waitMarkStrict` = **凭证**面(窄,认宪法写死的完整形态)。
  //     意图命中而凭证不中 ⇒ 拦「标了但没用规范形态」,不再静默放行。
  //     ⚠️ 2026-08-27(D76,本轮自撞第三轮):`\s*` **吃不下 markdown 强调符**。
  //       实测 `⏸ **需要你确认 …**` 不认、`⏸ 需要你确认` 认——而把短语加粗
  //       (`⏸ **需要你确认**`)恰恰是最自然的写法,我连着三轮都这么写、连着被拦三轮。
  //       **同族第六次**(D69 自标出路、ranProbe 运行时、D73 的 W 拦词、D75 的 F 格式、
  //       四眼逮到的 declHasOracle 白名单):**出路的判据比出路的说明窄**。
  //       本项尤其贵:它是**凭证**面——不认凭证 = 合法停工被判成违规停工,
  //       而人照着宪法原文写却过不去,只会去关逃生口。
  //       修法:⏸ 与「需要你确认」之间允许**有界**的强调符/空白/冒号。
  //       量词全部封顶(本文件有 ReDoS 前科,见 PROBE_SCAN_CAP 头注)。
  waitMark: [/⏸[\s*_~`]{0,8}[:：]?[\s*_~`]{0,8}需要你确认/, /^[\s*_~`]{0,8}⏸/m],
  waitMarkStrict: [/⏸[\s*_~`]{0,8}[:：]?[\s*_~`]{0,8}需要你确认/],
  // 三类合法停工理由(宪法「执行共识」:只有实打实阻断才算)。
  // ⚠️ 2026-09-02(D97,一夜 30+ 笔误报台账复现后定位):原表**没有第三类的分类名本身**——
  //   「不可逆」「亲签」认,「实打实阻断」不认,只认它的例子(缺凭据/站点不可达/只有用户能)。
  //   而闸消息与出路⑥都写着「写清属三类中的哪一类(不可逆/需你亲签/实打实阻断)」,
  //   照消息写的第三类分类名全被判「未说明理由」;实录里「属需你亲签类」的轮次全过、
  //   「属实打实阻断类」的轮次全拦,与此完全吻合。**出路的判据比出路的说明窄**,同族再一次。
  //   修法:把三类分类名本身逐字加进表;天花板照旧——它验的是「声明了哪类」,不验真假。
  stopReason: [/不可逆/, /亲签|需你签|要你签|签字/, /缺凭据|站点不可达|不可达|只有(用户|你)能/,
    /需用户亲签|归用户/, /产品(形态|取舍)|涉钱|版权|凭据/, /实打实阻断|阻断类/],
  // J 项:立法时未交代触发层。**这是本闸里唯一一条针对「立法这个动作本身」的检查**——
  // 2026-08-19 实撞:纪律 32(2026-08-17 立)三天内复发三次,根因不是条文不对,
  // 而是它**只是纪律没有闸**;而「把纪律升级成闸」这件事本身也是纪律,于是必须靠人推
  // (当日七项检查全部由用户一句话推动,无一为主动)。本项把「这条法的触发层是什么」
  // 变成每次立法必答的一问,让递归的最后一层也留下痕迹。
  // ⚠️ 收窄(2026-08-19):原模式含裸词「触发层/默认路径」——**写这三个字即豁免**,
  //   等于只要提到这个概念就放行。现要求答案里出现**具体的触发机制**:
  //   哪个 hook / 哪个事件 / 每会话加载 / 或诚实写「靠人记得」。
  triggerLayer: [
    /触发层\s*[=:：].{0,6}(hook|钩子|Stop|PreToolUse|PostToolUse|每会话|靠人记得|人工)/i,
    /挂在\s*\S{0,10}(hook|钩子|事件)/i,
    /(每会话|开工即)(加载|读取|在场)/,
    /(靠人记得|无自动触发|已知风险)/,
    /hook-stop-closure|verify-laws|report-gate/,
  ],
  // H 项:自陈「我能做」却只登记不做。C 项判「有没有落地动作或登记」,
  // 但**列进清单本身算登记**,于是「能做却只列出来」从 C 的网眼里漏过去
  // (2026-08-19 实撞:自己写下「这是本批唯一有机器闸能验、却没接上的缺口」后停手等发话)。
  // 恒定条款④授权的是**记录不是省略**:能当批做完的仍须当批做完。
  canDo: [
    /我能做[,,、]?(但)?(还)?(没|未)/,
    /不需要(你|用户)?签/,
    /属(工装面|预授权|机械类)/,
    /(我)?(可以|能)(自己|立刻|直接)(做|办|写|改)/,
    /不必(等|经)(你|用户)(发话|点名|授权)/,
  ],
};

// 已知强制面关键词 —— D 项只在这些词附近出现降级句式时才算命中

// ── D53(批 101):性能债「先量」——每轮 Stop 的耗时与 transcript 读取账 ──────────
//   债行实况:run / turn 组装 / consecutiveBlocks 各全量读一遍 transcript,无 p95 目标。
//   修法纪律=先量再改(D23/D32 的「量>改」序):打点进心跳行与报警台账(gitignore 面,
//   冲突表 #3 遥测不计写入),攒够批数后按 p95 定增量消费方案,量之前不动读法。
const _T0 = Date.now();
const _perf = { rt: 0, rtMs: 0, rtBytes: 0 };
function readTranscript(p) {
  const t = Date.now();
  const raw = fs.readFileSync(p, "utf8");
  _perf.rt++; _perf.rtBytes += raw.length;
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行/损坏行跳过 */ }
  }
  _perf.rtMs += Date.now() - t;
  return out;
}
/** 打点摘要,进心跳行与报警台账。只在 live 形态被读,离线回放不落。 */
function perfLine() {
  return `dur=${Date.now() - _T0}ms rt=${_perf.rt}x/${_perf.rtMs}ms/${Math.round(_perf.rtBytes / 1024)}KB`;
}

// 「本轮」= 最后一个**轮次边界**之后的全部条目;找不到边界则取全文件。边界(细则见函数体内各条):
//   ① 用户发言与 peer / task-notification 行(技能正文等无 origin 的 isMeta 行、插件消息**不算**);
//   ② **本闸自己上一次输出**(hook feedback:system 汇总行、「Stop hook feedback:」非用户亲口的字符串行,从其后起算);
//   ③ 已结束的 Stop 拦截附件(hook_blocking_error,从同一 toolUseID 的汇总行之后起算;进行中的不切)。
// 为什么要 ②:连续几轮都是 system reminder 时,只认 ① 会让「本轮」无限增长,
//   于是**已经纠正过的旧句被反复重判**(2026-08-19 实撞:同一句完成断言被 F 项连判三轮)。
//   hook feedback 天然是轮次边界——它之后的输出才是「对上次拦截的回应」。
export function lastTurn(entries) {
  let start = 0;
  const blockedIds = blockedStopIds(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // ⚠️ 边界③(2026-10-09 批 257 实撞,探针直证):Stop 拦截也会以 `type:"attachment"` +
    //   `attachment.type:"hook_blocking_error"` 的形态落盘、**不再**生成「Stop hook feedback:」用户行
    //   (开着 lanes 闸转投时观测到;是否还有别的触发条件文档未记载)。边界①②′都认不出它 ⇒
    //   「本轮」一路回溯到上一条真用户发言,已纠正过的旧句被连拦(同一句 E2 连拦 5 轮,lastTurn 探针:
    //   本轮 116 条、含被拦旧句)。与②′同理 `i+1`:拦截之后才是「对拦截的回应」。
    //   只认**已结束**的那次 Stop(其后已有同 toolUseID 的汇总行)——进行中的这一次里别的 hook 先落的附件不得切窗(热修红队 BP-2)。
    //   起点取那条汇总行之后:汇总行里带着各 hook 的全文(含判官提示词),不得进证据窗(热修红队附节二 4)。
    //   a2155edb BP-6:「这次 Stop 被拦没有」改由 gate-ctx 的 `isBlockedStop` 判(唯一实现,被拦后续跑的补收回扫同用它):
    //   同 toolUseID 拦截附件、或汇总行前的 feedback 行(判官型 prompt hook 只留这一种)任一即算。倒着扫先遇到的是
    //   汇总行(它在附件与 feedback 行之后),起点取它之后;没有汇总行的那次(进行中)不在这里切,与原③一致。
    if (e.type === "system" && e.hookCount !== undefined && isBlockedStop(entries, i, blockedIds)) { start = i + 1; break; }
    if (e.type === "system" && e.hookCount !== undefined) {
      const s = JSON.stringify(e.hookErrors || []) + JSON.stringify(e.hookAdditionalContext || "");
      // ⚠️ `i + 1` 而不是 `i`:本闸自己的输出**不得进入自己的证据窗口**。
      //   grill:security 实测(S7):`slice(i)` 是**含首**的,于是上一轮阻断消息里
      //   引用的字符串成了下一轮「我做了什么」的证据。零工具调用、只说了一句
      //   「我什么都没做」的回合,因上一条阻断消息里含 `git commit` 而被 K0 判「已提交」并阻断。
      //   更坏的是它构成**洗白链**:注入进 .batch-goal.json 的文本 → 被 K 回显进阻断消息
      //   → 落进 system 条目 → 下一轮进入 P 的证据窗口,`"name":"WebSearch"` 之类字样
      //   即可满足三通道。断掉首项就断了这条链的中段。
      if (/收尾闸阻断|收尾闭环闸命中/.test(s)) { start = i + 1; break; }   // 边界②
    }
    if (e.type !== "user") continue;
    // 工具结果也记作 type:user,不算真正的用户发言
    const c = e.message?.content;
    const isToolResult = Array.isArray(c) && c.some((b) => b?.type === "tool_result");
    if (isToolResult) continue;
    // ⚠️ 边界②′(2026-08-25,批 101/D46 探针直证):生产 transcript 里 hook 反馈的
    //   **实际形态**是 `type:"user"` + **字符串** content、首行 "Stop hook feedback:"——
    //   上面那个认 `type:"system"+hookCount` 的边界②在真实语料里**从未命中过**
    //   (scratchpad/d101-dump.mjs 对 21717 条实测),于是闸自己的阻断消息一直以
    //   「真实用户发言」身份**含首**进入证据窗(rawText 消费面被自己上一轮的判词污染,
    //   正是 S7 立 `i+1` 要断的那条洗白链)。同理 `i+1` 排除,反馈之后才是「对拦截的回应」。
    //   真实用户发言也可能是字符串形态 ⇒ 判据锚定 harness 固定前缀,不看正文关键词。
    // v7(codex v6 接缝 1):用户亲口打的话恰以这个前缀开头(贴报错来问)⇒ 是用户发言,走边界①,不当 hook 反馈切掉
    if (isStopFeedbackLine(e)) { start = i + 1; break; }
    // 边界②″ 已撤(2026-10-09):lanes 转投 v1 的插件消息形态已退役;v2 以 isMeta 行附全文、引擎仍落 feedback 行与附件,由②′/③认。
    //   lanes 附给模型的闸全文(isMeta 且以 Stop hook feedback: 开头)由上一行②′按 `i+1` 当边界(窗口从它之后起),不当边界①。
    //   热修红队 BP-4/9(10-09):无 origin 的 isMeta 行(技能/命令展开的正文、系统提醒)与插件消息都不是新一轮的起点
    //   ——轮中调 Skill 曾把本轮先前的 Write/Edit 整段切出窗口(真语料 45 处)。peer/task-notification/human 照旧当边界①。
    if ((e.isMeta === true && !e.origin?.kind) || e.origin?.kind === "plugin") continue;
    start = i;                                                         // 边界①
    break;
  }
  return entries.slice(start);
}

function assistantText(entries) {
  const chunks = [];
  for (const e of entries) {
    if (e.type !== "assistant") continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === "text" && b.text) chunks.push(b.text);
  }
  return chunks.join("\n");
}

function toolNames(entries) {
  const names = [];
  for (const e of entries) {
    if (e.type !== "assistant") continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === "tool_use" && b.name) names.push(b.name);
  }
  return names;
}

// 全文本(含工具入参与结果)——A 项要在这里面找 job id
function rawText(entries) {
  return entries.map((e) => { try { return JSON.stringify(e); } catch { return ""; } }).join("\n");
}

// A 项的**官方数据源**版本(2026-08-19 调研发现,优先于下面的正则配对):
// Stop hook 输入自 v2.1.145 起含 `background_tasks[]`(id/type/status/description/…)
// 与 `session_crons[]`(changelog:1748)。官方对同一情形的默认动作是**延后**不是拦
// ——`/goal` 在有子代理或后台命令在飞时**跳过本轮评估**。据此本项只逮真正的失联:
//   status 已完成 / 失败,而本轮文本与动作里再没提过它 ⇒ 命中;
//   还在 running ⇒ **不拦**(正常等待,今天两次后台委派都是这个形态)。
function checkAFromPayload(tasks, raw, text) {
  const open = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const id = String(t?.id || "");
    if (!id) continue;
    const st = String(t?.status || "").toLowerCase();
    if (BG_RUNNING_STATUS.test(st.trim())) continue;               // 在飞 ⇒ 放行(整词枚举,与 S 的 bgRunning 同一份;子串版让 inactive 也算在飞)
    if (raw.includes(id) || text.includes(id)) continue;          // 本轮提过 ⇒ 跟过了
    open.push(`${id}(${st || "unknown"}${t?.description ? " · " + String(t.description).slice(0, 30) : ""})`);
  }
  return { open, source: "background_tasks[]" };
}

// 原生后台任务(Bash run_in_background)这一族的正则配对。批 257 起**只管原生这一族**:
//   codex 委派那一族(CODEX_JOB=)已挪到下面的 `codexLedger`,只从实际工具事件取证——
//   这里原来对 raw 扫 `CODEX_JOB=` 并认「id 再出现一次」为闭环,于是发车交接块自带的
//   `CODEX_POLL=… --poll J` 与 `CODEX_LOG=…/J.log` 两行**各自**就足以结清(D141 复核夹具已证)。
function checkA(entries) {
  const raw = rawText(entries);
  const started = new Set();
  const closed = new Set();
  for (const m of raw.matchAll(CODEX_BG_ID)) started.add(m[1]);
  // 取回形态(四种都算「跟过了」):
  //   ① --poll <id>  ② 完成通知里的 <task-id>  ③ 读了 <id>.output  ④ 该 id 出现在任何 Bash 命令参数里
  // 判据取「有没有跟踪动作」而**不是**「任务是否已完成」——一个还在 running 的任务
  // 只要跟过就不算失联;真正要逮的是**发起后再没提过**(2026-08-19 首次真实拦截当场暴露:
  // 原实现把 running 中的任务判成未闭环,而两套 id 并存[后台 Bash id / codex job id]会误报)。
  for (const m of raw.matchAll(/--poll\s+([A-Za-z0-9_-]+)/g)) closed.add(m[1]);
  for (const m of raw.matchAll(/<task-id>([A-Za-z0-9_-]+)<\/task-id>/g)) closed.add(m[1]);
  // ⚠️ 量词必须封顶(D57,2026-08-26)。无上限的 `{6,}` 后接字面量,在 200KB 单字符输入上
  //   实测 **57.6 秒**——远超 hook 的 30s 超时,而**被超时杀死的 hook 不阻断** ⇒ 整闸静默失效。
  //   封顶到 64(后台任务 id 远短于此)后同一输入 55ms,千倍。同族封顶见本批 D57 另五处。
  for (const m of raw.matchAll(/([A-Za-z0-9_-]{6,64})\.output/g)) closed.add(m[1]);
  // ④ 只在「发起之后」再次出现才算——发起行自身不算跟踪
  for (const id of started) {
    const first = raw.indexOf(id);
    if (first >= 0 && raw.indexOf(id, first + id.length) >= 0) closed.add(id);
  }
  const open = [...started].filter((id) => !closed.has(id));
  return { open, started: [...started] };
}

// ── A 项 · codex 委派这一族(批 257 / D141;v5 = clipboard/257-a-fix-r3-list.md「主会话裁定 v5」)──
//
// 原则:**谁发车谁读**;「这段输出是不是 R」由 runner 用带 J 的定界块给出,闸不再从 shell 语法或文本相似推断
//   (v1–v4 的误拦与漏放都出在那一层,v5 整层删除)。
//
// 发起 = 一次 Bash / PowerShell / Monitor 调用以脚本参数跑了 codex-run.mjs 且带 --task(`out=$(…)`、反引号、
//   `bash -c '…'` 内层都展开再找 runner)。J 取自配对返回里的 CODEX_JOB / CODEX_END / CODEX_POLL / CODEX_LOG,
//   每个 CODEX_JOB 块各记一笔。返回里没有字段(截尾、重定向、run_in_background、超时被杀)⇒ 每个 --task 记一笔
//   **无主占位**。之后任一工具返回里出现本账没有的 J 的 CODEX_JOB 块(poll、读后台 `.output` / 重定向文件……),
//   或旧版 `--poll J` 有状态文件 ⇒ 认领占位:按状态文件的任务认领;没有状态文件(离线)认领同一次发起里最早的未认领占位;
//   生产态未认领的占位还按「任务 + 发起时刻」或结果路径到作业目录反查(注入面 findJob)。参数错误(缺 --task 等)不是发起。
// 观测只升不降:终态(done / failed)只能被另一个终态改写;同一终态的重复观测不覆盖首次(CX-3);
//   running / unknown 不覆盖终态(BP4-2)。最近观测是 running / 未知时仍查状态文件,终态为准。
// 读回 = 发起之后:某次**成功**工具返回里出现完整的 `CODEX_BODY_BEGIN=J` … `CODEX_BODY_END=J`(runner 在 done 时打出;
//   块中正文须与 R 的当前正文一致,防旧回件;R 读不到时只认块。Read 返回先剥行号前缀);或 Read 工具的 file_path 就是 R
//   且成功返回。cat / sed / awk / 管道 / 复合命令一律不再推断——出路是 `--poll J` 一次(正文随结果打出)或 Read R。
// 失败已处理 = 任一返回里出现完整的 `CODEX_FAIL_BEGIN=J` … `CODEX_FAIL_END=J`(runner 在 failed 时打出日志尾部);
//   或「得知失败」之后 Read 工具成功读了它的日志(CODEX_LOG / `<J>.log` / `<J>.last.txt`);或同一任务重发。
//   「得知失败」= 转录里首次观测到 failed;只有状态文件说 failed 时 = 其 endedAt 之后(按条目 timestamp;取不到则不认)。
//   旧作业 done 了就得读一次——同任务重发、新作业读过,都不替它结账。
// 状态:运行中待取 / 已产出待读(阻断)/ 已读回 / 失败已处理 / 失败未处理(阻断)/ 状态未知(提示)。运行中先于读回判。
// 子代理边界(`subagentCodexVerdict`):子代理自己发车的作业,收尾时 **运行中 / 已产出待读 / 失败未处理都阻断**;
//   运行中的出路 = `codex-run.mjs --poll J --wait-ms N` 等到终态(上限 10 分钟;done 时正文随结果打出即读回,
//   到期仍在跑退出码 3)。状态未知只提示,且只在本轮有该作业新事件时提示。依据 = 用户亲签代价模型「不接受只记录降级」;
//   不设按次数自动放行(连撞交给官方连续阻断上限);`STOP_CLOSURE_BLOCK_A=0` 两通道同样生效。
// 账在**发车方会话转录全量**上算;子代理转录超过整分支预算时,A 只读尾段。其他规则的窗口不动。
// 注入面(规则不自读磁盘):jobState / findJob / resultBody / bgTasks / now。生产 hook 由 `liveCodexEnv` 读
//   作业目录与结果件;查找目录 = hook 自己的 os.tmpdir() 作业目录 + 转录里 CODEX_LOG 的目录(归一去重)。
//
// v6(同文件「主会话裁定 v6」,两路复核 v5 的修法):占位认领核 startedAt 是否落在该占位发起窗口(旧 J 不认领新占位);
//   BODY 按块判、不看整次调用退出码;分页 Read 同一文件按行号拼接后取块;Read R 只认作业终态之后的读
//   (台账 endedAt 比条目 timestamp,取不到退到转录首次观测 done 的位置);`--cwd` 参与解 `--task`;
//   自动转后台的措辞「moved to the background (ID: …)」与显式后台同认;用户级 runner 不带 BODY 能力时提示只给 Read R。
//   runner 侧:发起即 `wx` 占住 r<n>;日志读不到不发 FAIL 块。
//   失败「见即处理」(FAIL 块送达即算处理)是裁定接受的代价,与 BODY「送达即读回」同口径:闸核信息到没到,不核拿它做了什么。
// v7(同文件「主会话裁定 v7」,两路复核 v6 的修法):**身份靠直连,时间只作筛选**——后台发起的 `.output` 里有 CODEX_JOB
//   ⇒ 直接定身份;回退认领的窗口只留下界(startedAt ≥ 发起 − 2 秒)、上界 60 分钟,台账缺 startedAt 不认领,反查从最晚的发起往前认。
//   Read R 的界 = 台账 resultAt(runner 写 R 之前记;旧台账退 endedAt),比较用 ≥;有界而读没时间戳不算;台账读不到 ⇒ 发起之后即可;
//   读到 runner 占位文字永不算。分页拼块按每段连续行号各自取。job-missing / 台账缺失不是终态观测。
//   **规则不追溯**:生效时刻(`CODEX_A_SINCE`)之前发起的作业不入账。提示里的 poll 用这次发起用的那支 runner,能力按它判。
// 残余(照实列):
//   ①历史转录没有 BODY 块:旧 runner 发起、用 cat 等 shell 读法读 R 的会判待读(v5 接受的代价;出路一条 `--poll J` 或 Read R)。
//   ②Read R 不证读全:读到正文(第二个 `---` 之后;第 1 行没读到时按第 9 行起)任意一段即算(10-10 收紧:只读到头部不算;
//     a2155edb BP-8 更正行号——runner 头部 8 行、正文第 9 行起,原写第 10 行;空正文回件完整读过头部并读到文件尾即算)。显式 `--out` 复用同一路径不占位,旧件可能被当成新件读。
//   ③R 读不到(超过 2MB、已移走)时 BODY 块只比 J 不比正文。
//   ④别的会话发起、本会话只 poll 的作业不入账。
//   ⑤hook 进程 os.tmpdir() 未直证;一个 CODEX_LOG 都没留下的作业,目录不一致时只能落「未知」。
//   ⑥子代理转录超预算时只读尾段:发起早于尾段的作业不入账。
const CODEX_RUNNERS = /^(node|node\.exe|nodejs|bun)$/i;
// 后台任务号的三种措辞:显式 run_in_background「running in background with ID: x」,
//   超时自动转后台「was moved to the background (ID: x)」(v6,红队附二-2;lanes 10 秒转后台后这是主形态),
//   用户手动转后台「manually backgrounded by user with ID: x」(v7,红队 v6 附二-3)
const CODEX_BG_ID = /(?:running in background with ID:|moved to the background \(ID:|manually backgrounded by user with ID:)\s*([A-Za-z0-9_-]+)/g;
// 后台输出文件路径(工具返回里「Output is being written to: <路径>」):v7 起 hook 读它取 CODEX_JOB,直接认领占位
const CODEX_BG_OUT = /Output is being written to:\s*(\S+?\.output)\b/;
const CODEX_JOB_GRACE_MS = 2 * 60 * 1000;
const CODEX_FIND_WINDOW_MS = 60 * 60 * 1000;     // 无主占位反查的上界:发起之后 60 分钟内开跑的(v7:身份主靠 .output 直连,窗口只作回退筛选)
const CODEX_SKEW_MS = 2000;                      // 下界容差:runner 的 startedAt 不会早于发起 tool_use 超过这么多
// v7(红队 v6 BP-4):A 账只追这一刻之后发起的作业——规则不追溯,旧判据下诚实做完的作业不按新判据补账
//   = v7 合并进 master 的提交时刻(b513d68,2026-10-10T14:33:44+08:00)。原先写成 12:00Z(北京 20:00),
//   比真生效晚 6 小时,合并后发起的新作业也被豁免(codex 终审 L1)——截止只能取真实生效时刻。
export const CODEX_A_SINCE = Date.parse("2026-10-10T06:33:44Z");
// runner 的发起占位行(与 codex-run.mjs 的 PLACEHOLDER_RE 同一正则,自测核两边一致):Read 到它永不算读回
export const CODEX_PLACEHOLDER_RE = /^\(codex-run 作业 \S+ 运行中,结果未产出——占位\)\s*$/;
// runner 写的结果件头部是两个 `---` 之间共 8 行(含两条 `---`),**正文从第 9 行起**(codex-run.mjs `resultHeader`;
//   红队 a2155edb BP-8:原写「8 行加 1 空行、正文第 10 行」与 runner 不符——runner 头部以 `---\n` 收尾、正文紧接其后,
//   没有空行)。Read 只读到头部不算读回(红队 7e1392f 轮 BP-4)。判读回时优先按读到的第二个 `---` 定位,本常量只在
//   第 1 行没读到时兜底;自测用 runner 的 `resultHeader` 拼夹具并核两边一致(照 PLACEHOLDER_RE 的对齐做法)。
export const CODEX_BODY_FIRST_LINE = 9;
/** 结果件去掉 runner 头部(第 1 行是 `---` 时剥到第二个 `---` 为止),余下即正文;不是该形态原样返回。 */
export function codexStripHeader(s) {
  const lines = String(s).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return String(s);
  const k = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return k > 0 ? lines.slice(k + 1).join("\n") : String(s);
}
const CODEX_ARG_ERROR = /缺 --task|任务文件不存在|拒绝入参|未知参数|参数 \S+ 缺值/;

/** tool_result 的正文(字符串或 text 块数组)。 */
function codexResultText(b) {
  const c = b && b.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("\n");
  return "";
}

/** 段内分词:认单/双引号;`ps` = PowerShell(反斜杠是普通字符,反引号是转义符,`@"…"@` here-string 整段一个词的一部分)。
 *  不做变量展开。转义与引号规则与 gate-cmd `quoteScan(…, ps)` 同一方言(红队 a811daae BP-6:掩码与分词须同一套)。 */
export function codexWords(seg, ps = false) {
  return codexWordsShaped(seg, ps).map((x) => x.w);
}
/** 同 `codexWords`,每个词另带 `shape`:与 `w` 等长,**引号内或转义而来**的字符换成 `\u0001`,裸字符原样。
 *  给「算子只认引号外」的判断用(复核红队 aaf414b6 BP-3:`-Value ">" -Path 日记` 的 `">"` 分词后与裸 `>` 同形,
 *  `dropRedirWords` 把它连同下一词 `-Path` 一起剔掉)。`w` 与 `codexWords` 逐字相同(唯一实现,`codexWords` 由此派生)。 */
function codexWordsShaped(seg, ps = false) {
  const QCH = "\u0001";
  const s = String(seg || "");
  const out = [];
  let cur = "", shape = "", has = false, q = null;
  const lit = (x) => { cur += x; shape += QCH.repeat(x.length); };   // 引号内 / 转义:字面
  const bare = (x) => { cur += x; shape += x; };                      // 引号外:裸字符
  const flush = () => { if (has || cur) out.push({ w: cur, shape }); cur = ""; shape = ""; has = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else lit(c); continue; }
    // bash `\`+换行 = 续行:引号外与双引号内都整对删除(不断词、不留字符)。原把换行当转义出的字面字符收进词里,
    //   BP-2 的 `sed -i '…' \⏎  AGENTS.md` 因此多出一个 "\n" 目标(aaf414b6 BP-2 同批;单引号内不是转义,不动)。
    if (!ps && q !== "'" && c === "\\" && (s[i + 1] === "\n" || (s[i + 1] === "\r" && s[i + 2] === "\n"))) {
      i += s[i + 1] === "\r" ? 2 : 1; continue;
    }
    if (q === '"') {
      if (c === '"') { q = null; continue; }
      if (!ps && c === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) { lit(s[++i]); continue; }
      if (ps && c === "`" && i + 1 < s.length) { lit(s[++i]); continue; }
      lit(c); continue;
    }
    if (ps && c === "@" && (s[i + 1] === '"' || s[i + 1] === "'") && /^\r?\n/.test(s.slice(i + 2, i + 4))) {
      const close = s.indexOf("\n" + s[i + 1] + "@", i + 2);
      const end = close < 0 ? s.length : close + 3;
      lit(s.slice(s[i + 2] === "\r" ? i + 4 : i + 3, close < 0 ? s.length : close)); has = true;
      i = end - 1; continue;
    }
    if (ps && c === "`" && i + 1 < s.length) {
      const n = s[++i];
      if (n === "\r" || n === "\n") {                          // 行尾反引号 = 续行,等于空白
        if (n === "\r" && s[i + 1] === "\n") i++;
        flush(); continue;
      }
      lit(n); has = true; continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    if (!ps && c === "\\" && i + 1 < s.length) { lit(s[++i]); has = true; continue; }
    bare(c); has = true;
  }
  flush();
  return out;
}

/** 剥命令替换外壳:`out=$(node` ⇒ `node`、`` `node `` ⇒ `node`,替换体收尾的 `)`/反引号去掉;
 *  剥过壳且带空白的词(`"$(node a b)"`)再按空白拆。引号里本来就带空格的普通参数保持一个词。 */
export function codexUnwrapSubst(words, ps = false) {
  const out = [];
  let depth = 0;
  for (const w of words) {
    let x = String(w);
    const k = x.lastIndexOf("$(");
    const opened = k >= 0 || x.startsWith("`");
    if (k >= 0) { x = x.slice(k + 2); depth++; }
    else if (x.startsWith("`")) { x = x.slice(1); depth++; }
    if (depth > 0 && /[)`]$/.test(x)) { x = x.replace(/[)`]+$/, ""); depth = Math.max(0, depth - 1); }
    if (opened && /\s/.test(x.trim())) out.push(...codexWords(x, ps));
    else if (x) out.push(x);
  }
  return out;
}

/** 一条命令拆成分词后的段;`bash|sh|zsh -c '…'`、`pwsh|powershell -Command '…'` 的内层展开成更多段(BP4-12);
 *  `segments` 不切单个 `&`(后台并发),这里按独立的 `&` 词再切一次(BP4-3:`… --task a & … --task b; wait`)。 */
function codexCommandSegs(cmd, ps, depth = 0) {
  const out = [];
  const groups = [];
  for (const seg of segments(cmd, ps)) {                 // 切段与分词同一方言(红队 a811daae BP-6 同族)
    const ws = codexUnwrapSubst(codexWords(seg, ps), ps);
    for (let a = 0, k = 0; k <= ws.length; k++) if (k === ws.length || ws[k] === "&") { if (k > a) groups.push(ws.slice(a, k)); a = k + 1; }
  }
  for (const words of groups) {
    const head = String(words[0]).replace(/^.*[\\/]/, "").toLowerCase();
    const ci = words.findIndex((w, i) => i > 0 && /^(-l?c|-command)$/i.test(w));
    if (depth < 2 && /^(bash|sh|zsh|pwsh|powershell)(\.exe)?$/.test(head) && ci > 0 && words[ci + 1] != null) {
      out.push(...codexCommandSegs(words[ci + 1], /^(pwsh|powershell)/.test(head), depth + 1));
      continue;
    }
    out.push(words);
  }
  return out;
}

/** 路径归一:分隔符、`/d/…`、`~/…`、相对 → 绝对(给了 cwd 时)、消 `.`/`..`;盘符路径整体小写。
 *  解不出(相对且无 cwd)⇒ null。 */
export function codexNormPath(p, cwd) {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  if (!s) return null;
  const home = String(process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/");
  if (/^~(\/|$)/.test(s)) { if (!home) return null; s = home + s.slice(1); }
  let m = /^\/mnt\/([A-Za-z])(\/|$)/.exec(s) || /^\/([A-Za-z])(\/|$)/.exec(s);
  if (m) s = `${m[1]}:/${s.slice(m[0].length)}`;
  if (!/^(?:[A-Za-z]:\/|\/)/.test(s)) {
    if (/^[A-Za-z]:[^/]/.test(s)) return null;                 // `D:foo` 盘符相对:不猜
    if (!cwd) return null;
    const base = codexNormPath(cwd, null);
    if (!base) return null;
    s = `${base.replace(/\/+$/, "")}/${s}`;
  }
  const drive = /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : "";
  const parts = [];
  for (const seg of s.slice(drive.length).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  const out = `${drive}/${parts.join("/")}`;
  return drive ? out.toLowerCase() : out;
}

/** 一段命令是否以脚本参数跑了 codex-run.mjs;是则返回 { task, polls:[J] }。 */
function codexInvocation(words) {
  const at = words.findIndex((w) => /(^|[\\/])codex-run\.mjs$/.test(w));
  if (at < 0) return null;
  if (!words.slice(0, at).some((w) => CODEX_RUNNERS.test(String(w).replace(/^.*[\\/]/, "")))) return null;
  let task = null, dir = null;
  const polls = [];
  for (let k = at + 1; k < words.length; k++) {
    if (words[k] === "--task" && words[k + 1] != null) task = words[++k];
    else if (words[k] === "--cwd" && words[k + 1] != null) dir = words[++k];   // runner 按 --cwd 解 --task(v6,红队 BP-5)
    else if (words[k] === "--poll" && words[k + 1] != null) polls.push(words[++k]);
  }
  // runner = 这次发起用的那支脚本路径(v7):闸提示里的 poll 命令用同一支,能力也按这一支判
  return { task, dir, polls, runner: words[at] };
}

/** 取出返回里完整的 BODY / FAIL 定界块(BEGIN 与 END 的 J 相同才成块)。块内是数据,里面的 CODEX_ 行不进字段解析。
 *  numbered = Read 的返回(先剥行号前缀)。只有 BEGIN(被截尾)⇒ 其后都当数据;只有 END(被截头)⇒ 之前都是正文
 *  残段,只留 `CODEX_END=J` 作 J 的载体。返回 { bodies:[{kind,J,text}], rest }。 */
export function codexBodies(text, numbered = false) {
  let lines = String(text || "").split(/\r?\n/);
  if (numbered) lines = lines.map((l) => l.replace(/^\s*\d+[\t→]/, ""));
  const bodies = [];
  let rest = [];
  let open = null;
  for (const l of lines) {
    const m = /^CODEX_(BODY|FAIL)_(BEGIN|END)=([A-Za-z0-9_-]{1,64})\s*$/.exec(l);
    if (open) {
      if (m && m[2] === "END" && m[1] === open.kind && m[3] === open.J) { bodies.push({ kind: open.kind, J: open.J, text: open.buf.join("\n") }); open = null; }
      else open.buf.push(l);
    } else if (m && m[2] === "BEGIN") open = { kind: m[1], J: m[3], buf: [] };
    else if (m) rest = [`CODEX_END=${m[3]}`];
    else rest.push(l);
  }
  return { bodies, rest: rest.join("\n") };
}

/** 把一段返回切成 CODEX_* 字段块(每个 CODEX_JOB= 开一块;没有 JOB 的旧形态整段一块)。Read 的行号前缀先剥。 */
export function codexBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^CODEX_([A-Z_]+)=(.*)$/.exec(line.replace(/^\s*\d+[\t→]/, "").trim());
    if (!m) continue;
    if (m[1] === "JOB" || !cur || (m[1] in cur && m[1] !== "JOB")) { cur = {}; blocks.push(cur); }
    cur[m[1]] = m[2].trim();
  }
  return blocks;
}

/** 发起返回字段块里的 J:CODEX_JOB;截尾时退到 CODEX_END / CODEX_POLL 的 `--poll J` / CODEX_LOG 的 `<J>.log`。 */
function codexIdOf(bk) {
  if (bk.JOB) return bk.JOB;
  if (bk.END) return bk.END;
  if (bk.POLL) { const m = /--poll\s+([A-Za-z0-9_-]{1,64})/.exec(bk.POLL); if (m) return m[1]; }
  if (bk.LOG) { const m = /([A-Za-z0-9_-]{1,64})\.log$/.exec(bk.LOG); if (m) return m[1]; }
  return null;
}

const CODEX_RANK = { unknown: 0, background: 1, running: 1, done: 2, failed: 2 };
/** 观测只升不降(BP4-2):终态只被另一个终态改写;同一终态的重复观测不覆盖首次(CX-3)。 */
function codexObserve(job, kind, seq, why = "") {
  const cur = job.obs ? job.obs.kind : "unknown";
  if (CODEX_RANK[kind] < CODEX_RANK[cur]) return;
  if (CODEX_RANK[cur] === 2 && kind === cur) return;
  if (CODEX_RANK[cur] === 2 && CODEX_RANK[kind] < 2) return;
  job.obs = { kind, seq, why };
}

/** 正文比对口径:换行归一、行尾空白与首尾空白不计(工具回显会吃掉这些)。 */
const codexNormBody = (s) => String(s).replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).join("\n").trim();

/** codex 委派账。entries = 发车方会话转录全量;env = 注入面(见段首),缺省 = 不注入。
 *  返回 { jobs, open:[…阻断行], unknown:[…提示行], running:[…运行中行] }(unknown 已按本轮门控)。 */
export function codexLedger(entries, env = {}) {
  const uses = new Map();
  const events = [];
  const notifs = [];   // { ei, text }:后台任务完成通知(只用来刷新占位的「本轮有事件」)
  let seq = 0;
  const list = Array.isArray(entries) ? entries : [];
  const tsOf = (e) => { const t = Date.parse(e && e.timestamp || ""); return Number.isFinite(t) ? t : null; };
  for (let ei = 0; ei < list.length; ei++) {
    const e = list[ei];
    const c = e && e.message && e.message.content;
    if (e && e.type === "user" && typeof c === "string" && c.includes("<task-id>")) notifs.push({ ei, text: c });
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      seq++;
      if (e.type === "user" && b && b.type === "text" && typeof b.text === "string" && b.text.includes("<task-id>")) notifs.push({ ei, text: b.text });
      if (e.type === "assistant" && b && b.type === "tool_use" && b.id) {
        uses.set(b.id, { name: String(b.name || ""), input: b.input || {}, cwd: e.cwd || null, ts: tsOf(e) });
      } else if (b && b.type === "tool_result" && b.tool_use_id && uses.has(b.tool_use_id)) {
        const u = uses.get(b.tool_use_id);
        events.push({ seq, ei, use: u, useId: b.tool_use_id, text: codexResultText(b), isError: b.is_error === true,
          cwd: u.cwd || e.cwd || env.cwd || null, ts: tsOf(e) });
      }
    }
  }
  const jobs = new Map();        // 键 = J 或 `@<tool_use 尾号>[#k]`(无主占位)
  const delivered = [];          // { seq, J, kind, text }:完整 BODY / FAIL 块(BODY 只收成功返回里的)
  const reads = [];              // { seq, ts, p }:Read 工具成功读到的路径(归一)
  const pages = new Map();       // 归一路径 → Map(行号 → 行):分页 Read 拼块用
  const relaunch = [];           // { seq, ts, task, id }
  const jobDirs = new Set();     // 返回里 CODEX_LOG 的目录(hook 进程 tmpdir 不一致时兜底查)
  const mkJob = (o) => ({ R: new Set(), Rraw: null, L: null, err: null, ...o });
  const byJ = (J) => jobs.get(J) || [...jobs.values()].find((j) => j.foundId === J);
  const note = (job, bk, cwd) => {
    if (bk.RESULT) { const r = codexNormPath(bk.RESULT, cwd); if (r) job.R.add(r); job.Rraw = job.Rraw || bk.RESULT; }
    if (bk.LOG) job.L = job.L || codexNormPath(bk.LOG, cwd);
    if (bk.ERROR_CODE || bk.ERROR) job.err = bk.ERROR_CODE || bk.ERROR;
  };
  // job-missing(台账已被清掉)不是作业的终态,是「查不到」——不得改写已有观测(v7,红队 v6 BP-3:
  //   照提示 poll 一下,旧作业就从待读翻成「失败未处理」,再也清不掉)
  const stOf = (bk) => {
    if (String(bk.ERROR_CODE || "") === "job-missing") return "unknown";
    const s = String(bk.STATE || "").toLowerCase(); return /^(background|running|done|failed)$/.test(s) ? s : "unknown";
  };
  // 本账没有的 J:按状态文件的任务认领占位;台账没记任务(离线 / 旧台账)才认领同一次发起里最早的未认领占位。
  //   注入了 jobState 而查不到台账 ⇒ 不是作业(`--poll $(grep …)` 剥壳得 `grep`),不认领;台账任务对不上任何占位 ⇒ 不认领。
  //   v6(红队 BP-1 / codex v5 第 1 条):台账有 startedAt 且占位有发起时刻 ⇒ 只认 startedAt 落在该占位发起窗口内的
  //   (旧 J——同会话更早一次发起、或历史作业——不得认领新占位,否则新作业的欠账悄悄消失)。
  //   v7(codex v6 第 1/2 条、红队 v6 BP-2/6):时间只作筛选、不作身份——下界收到 2 秒容差(早于发起的旧作业不认),
  //   上界放到 60 分钟(发起前有准备步骤也认得上);台账缺 startedAt ⇒ 不认领(原先直接放行)。身份主靠 `.output` 直连(见发起处)。
  const inWin = (j, sf) => {
    const t = Date.parse(sf && sf.startedAt || "");
    if (!Number.isFinite(t)) return false;
    return !Number.isFinite(j.useTs) || (t >= j.useTs - CODEX_SKEW_MS && t <= j.useTs + CODEX_FIND_WINDOW_MS);
  };
  const claim = (J, seq) => {
    const sf = typeof env.jobState === "function" ? env.jobState(J, [...jobDirs]) : undefined;
    if (sf === null) return null;
    const anons = [...jobs.values()].filter((j) => j.anon && j.launchSeq < seq);
    let pick = sf && sf.task ? [...anons].reverse().find((j) => j.taskNorm && j.taskNorm === codexNormPath(sf.task, null) && inWin(j, sf)) : null;
    if (!(sf && sf.task) && anons.length && anons.every((j) => j.launchSeq === anons[0].launchSeq)) pick = anons[0];
    if (pick) { pick.foundId = J; pick.label = J; pick.anon = false; }
    return pick || null;
  };
  for (const ev of events) {
    const { use, text } = ev;
    const name = use.name;
    const inp = use.input || {};
    const isErr = ev.isError || /^\s*<tool_use_error>/.test(text);
    const { bodies, rest } = codexBodies(text, name === "Read");
    // 块按块判(v6,红队 BP-8 / codex v5 第 3 条):同一次调用里别的命令失败,不否掉已完整送达的块——
    //   块本身带 J、BEGIN/END 成对,BODY 还要与 R 一致,整次调用的退出码对它没有证明力
    for (const b of bodies) delivered.push({ seq: ev.seq, ...b });
    if (name === "Read" && typeof inp.file_path === "string" && !isErr) {
      const p = codexNormPath(inp.file_path, ev.cwd);
      if (p) {
        // 读到的是 runner 的发起占位 ⇒ 永不算读回(v7,按内容判,不靠时间戳)
        const plain = text.split(/\r?\n/).map((l) => l.replace(/^\s*\d+[\t→]/, "")).join("\n").trim();
        // 一行带行号的内容都没有(越界 offset 只回一句提示)也不算读到(红队 d1cae02 轮 BP-6);
        //   只读到 runner 写的头部(`---` 包着的版本/模型/沙箱…)也不算(红队 7e1392f 轮 BP-4:Read limit 看一眼头部就被判读回)。
        const lineNos = [...text.matchAll(/^\s*(\d+)[\t→]/gm)].map((m) => Number(m[1]));
        // 分页 Read 同一文件:按行号拼接后取块(v6,codex v5 第 4 条:BODY 跨页时单页都不完整)。
        //   v7(codex v6 第 5 条):每段连续行号各自拼——前面有没读到的空档,不连累后面完整的块;不用 Math.min(...) 展开(红队附二-4)
        //   (a2155edb:拼页先于下面判「读到正文没有」,正文起始行要用到本页)
        const pg = pages.get(p) || new Map();
        pages.set(p, pg);
        for (const l of text.split(/\r?\n/)) { const m = /^\s*(\d+)[\t→](.*)$/.exec(l); if (m) pg.set(Number(m[1]), m[2]); }
        // 正文起始行(红队 a2155edb BP-8:原写死第 10 行,而 runner 实际头部是两个 `---` 之间共 8 行、正文从第 9 行起,
        //   一行正文的回件完整 Read 后永远判「只读到头部」;自测 HEAD 多带一个空行所以没逮到):
        //   **按第二个 `---` 定位**——已读到的页里第 1 行是 `---` 且其后某行也是 `---` ⇒ 正文从那行的下一行起;
        //   第 1 行没读到(从中间开读)⇒ 退回 runner 头部常量推导的 `CODEX_BODY_FIRST_LINE`(自测核它与 runner 真实头部一致)。
        let dashAt = null;
        if (String(pg.get(1) ?? "").trim() === "---") {
          for (const n of [...pg.keys()].sort((x, y) => x - y)) if (n > 1 && String(pg.get(n)).trim() === "---") { dashAt = n; break; }
        }
        const bodyFirst = dashAt != null ? dashAt + 1 : CODEX_BODY_FIRST_LINE;
        const reachesBody = lineNos.some((n) => n >= bodyFirst);
        // 空正文回件(只有头部):**完整读过即读回**(a2155edb BP-8 的派出方口径)。「完整」= 头部 1..收尾 `---` 每行都已读到、
        //   本次读到了收尾那行、且本次读到了文件尾(近似:返回行数少于请求上限,没给上限按 Read 缺省 2000)、收尾之后只有空行。
        //   ⚠️ 「行数少于上限 ⇒ 到了文件尾」这个前提**并不成立**(红队 a811daae 附节二④;本机 changelog 照实:
        //   2.1.145「whole-file read exceeds the token limit ⇒ truncated first page with a "PARTIAL view" notice」——
        //   超 token 限时返回的是截断的首页,行数可能远少于 2000;2.1.86「deduplicates unchanged re-reads」——
        //   重复读未变文件不回正文,本函数看到的行可能是 0)。现在不出事,靠的是另两条同时成立:头部 1..收尾 `---`
        //   全部读到、且**收尾之后读到的行全是空行**——截断首页在空正文回件上就是全文(回件短),在非空回件上
        //   收尾后必有非空行而不满足 tailBlank。判据不改;回件若长到首页截断且截断点恰在空行段,此近似会失效。
        //   判「正文确实为空」在下面结账处做:能读到 R 时以 R 的当前内容为准,读不到才信本次读的文件尾。
        const lim = Number(inp.limit) > 0 ? Number(inp.limit) : 2000;
        const fullHead = dashAt != null && lineNos.includes(dashAt) && [...Array(dashAt).keys()].every((k) => pg.has(k + 1));
        const tailBlank = lineNos.filter((n) => n > (dashAt ?? Infinity)).every((n) => !String(pg.get(n) ?? "").trim());
        const emptyBodyRead = fullHead && tailBlank && lineNos.length < lim;
        reads.push({ seq: ev.seq, ts: ev.ts, p, ph: CODEX_PLACEHOLDER_RE.test(plain) || !lineNos.length, head: !reachesBody, emptyBodyRead });
        if (/^\s*\d+[\t→]CODEX_(BODY|FAIL)_BEGIN=/m.test(text)) pg.hasBegin = true;
        if (pg.hasBegin) {                                       // 没见过 BEGIN 的文件不拼(省得每次 Read 都重扫)
          const keys = [...pg.keys()].sort((x, y) => x - y);
          for (let a = 0; a < keys.length;) {
            let b = a;
            while (b + 1 < keys.length && keys[b + 1] === keys[b] + 1) b++;
            const run = keys.slice(a, b + 1).map((k) => pg.get(k)).join("\n");
            for (const blk of codexBodies(run).bodies) if (!bodies.some((x) => x.J === blk.J && x.kind === blk.kind)) delivered.push({ seq: ev.seq, ...blk });
            a = b + 1;
          }
        }
      }
    }
    for (const bk of codexBlocks(rest)) if (bk.LOG) { const l = codexNormPath(bk.LOG, ev.cwd); if (l) jobDirs.add(l.replace(/\/[^/]*$/, "")); }
    const launches = [];
    const polls = [];
    let cwd = ev.cwd;
    if (/^(Bash|PowerShell|Monitor)$/.test(name) && typeof inp.command === "string") {
      const ps = name === "PowerShell";
      // heredoc 正文是数据不是命令(与 `bashWriteTargets` 同一界符口径)
      const cmdNoDoc = ps ? inp.command : inp.command.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ");
      for (const words of codexCommandSegs(cmdNoDoc, ps)) {
        if (/^(cd|set-location|sl|pushd|chdir)$/i.test(words[0]) && words[1]) {
          const p = codexNormPath(words.filter((w, i) => i > 0 && !/^-/.test(w))[0] || words[1], cwd);
          if (p) cwd = p;
          continue;
        }
        const inv = codexInvocation(words);
        if (!inv) continue;
        const base = inv.dir ? codexNormPath(inv.dir, cwd) || cwd : cwd;
        if (inv.task) launches.push({ task: inv.task, cwd: base, taskNorm: codexNormPath(inv.task, base), runner: inv.runner, shellCwd: cwd });
        polls.push(...inv.polls);
      }
    }
    const blocks = codexBlocks(rest).filter((bk) => codexIdOf(bk) || bk.STATE || bk.RESULT);
    if (launches.length) {
      const base = (l) => ({ launchSeq: ev.seq, lastEi: ev.ei, cwd: l.cwd, task: l.task, taskNorm: l.taskNorm, useTs: use.ts,
        runner: l.runner, runnerCwd: l.shellCwd });
      if (!blocks.length) {
        // 无主占位(每个 --task 一笔):后台 / 重定向 / 超时被杀 / 截尾。参数错误不是发起。
        if (isErr && CODEX_ARG_ERROR.test(text)) continue;
        const bgm = new RegExp(CODEX_BG_ID.source).exec(text);
        // v7 直连:后台发起的输出文件里就有 runner 打的 CODEX_JOB——读出来直接定身份,不靠时间窗(codex v6 第 1 条)。
        //   只取身份与路径,不取 BODY(那份正文发车方没看过,不算送达);一次发起只认一个 J 时才直连
        const outm = CODEX_BG_OUT.exec(text);
        let outBk = null;
        if (outm && launches.length === 1 && typeof env.readOutput === "function") {
          let ot = null;
          try { ot = env.readOutput(outm[1]); } catch { ot = null; }
          const ids = ot ? codexBlocks(codexBodies(ot).rest).filter((bk) => bk.JOB) : [];
          if (ids.length && ids.every((bk) => bk.JOB === ids[0].JOB) && !byJ(ids[0].JOB)) outBk = ids[0];
        }
        if (outBk) {
          const l = launches[0];
          const job = mkJob({ ...base(l), id: outBk.JOB, anon: false, bgId: bgm ? bgm[1] : null,
            obs: { kind: "unknown", seq: ev.seq, why: "后台发起(身份取自后台输出文件;状态以台账为准)" } });
          jobs.set(outBk.JOB, job);
          note(job, outBk, l.cwd);
          if (l.taskNorm) relaunch.push({ seq: ev.seq, ts: ev.ts, task: l.taskNorm, id: job.id });
          continue;
        }
        const bg = inp.run_in_background === true || !!bgm || name === "Monitor";
        const why = bg ? "以后台 / Monitor 发起,CODEX_ 字段在后台输出里"
          : isErr ? "发起那次 Bash 报错返回(超时被杀?worker 是 detached 的,作业可能照跑)"
          : "发起返回里没有 CODEX_ 字段(截尾、重定向或过滤?)";
        launches.forEach((l, k) => {
          const id = `@${ev.useId.slice(-8)}${launches.length > 1 ? `#${k}` : ""}`;
          jobs.set(id, mkJob({ ...base(l), id, anon: true, bgId: bgm ? bgm[1] : null, obs: { kind: "unknown", seq: ev.seq, why } }));
          if (l.taskNorm) relaunch.push({ seq: ev.seq, ts: ev.ts, task: l.taskNorm, id });
        });
        continue;
      }
      blocks.forEach((bk, k) => {
        const l = launches[Math.min(k, launches.length - 1)];
        const J = codexIdOf(bk);
        let job = J ? byJ(J) : null;
        if (!job) {
          const id = J || `@${ev.useId.slice(-8)}#${jobs.size}`;
          job = mkJob({ ...base(l), id, anon: !J, obs: { kind: "unknown", seq: ev.seq, why: "" } });
          jobs.set(id, job);
        }
        codexObserve(job, stOf(bk), ev.seq, bk.STATE ? "" : "返回里没有 CODEX_STATE(被截断)");
        note(job, bk, l.cwd);
        if (l.taskNorm) relaunch.push({ seq: ev.seq, ts: ev.ts, task: l.taskNorm, id: job.id });
      });
      continue;
    }
    // 非发起:返回里的 CODEX_JOB 块(poll、读后台 .output / 重定向文件……)按 J 归属;本账没有的 J 认领占位(BP4-3/4)
    const seen = new Set();
    for (const bk of blocks) {
      if (!bk.JOB) continue;
      const job = byJ(bk.JOB) || claim(bk.JOB, ev.seq);   // 账按事件序建,认领只挑更早的占位 ⇒ job 必在本事件之前发起
      if (!job) continue;
      seen.add(bk.JOB);
      job.lastEi = ev.ei;
      codexObserve(job, stOf(bk) === "background" ? "running" : stOf(bk), ev.seq, `返回 CODEX_STATE=${bk.STATE || "(缺)"}`);
      note(job, bk, cwd);
    }
    // 旧版 poll(无机器块):一条命令只 poll 一个 J、返回只有一行状态时才归属
    const uniqPolls = [...new Set(polls)];   // `until … --poll J …; do …; done; … --poll J` 是同一个 J
    const legacy = [...rest.matchAll(/^(running|done|failed)\b[ \t]*(.*)$/gm)];
    for (const J of uniqPolls) {
      if (seen.has(J)) continue;
      const job = byJ(J) || (typeof env.jobState === "function" && env.jobState(J, [...jobDirs]) ? claim(J, ev.seq) : null);
      if (!job) continue;
      job.lastEi = ev.ei;
      if (uniqPolls.length === 1 && legacy.length === 1) {
        const [, st, more] = legacy[0];
        if (st === "failed" && /台账缺失/.test(more)) { codexObserve(job, "unknown", ev.seq, "poll 报台账缺失"); continue; }   // v7,同 stOf 的 job-missing
        codexObserve(job, st, ev.seq);
        if (st === "done" && more) note(job, { RESULT: more.trim() }, cwd);
        if (st === "failed") job.err = more || job.err;
      } else codexObserve(job, "unknown", ev.seq, "poll 返回无法归属到该 J(一条命令多个 poll 或返回被混入)");
    }
  }
  // 后台任务完成通知:刷新对应占位的「本轮有事件」
  for (const job of jobs.values()) {
    if (!job.bgId) continue;
    for (const n of notifs) if (n.ei > job.lastEi && n.text.includes(`<task-id>${job.bgId}</task-id>`)) job.lastEi = n.ei;
  }

  const now = Number.isFinite(env.now) ? env.now : Date.now();
  const claimed = new Set([...jobs.values()].filter((j) => !j.anon).map((j) => j.foundId || j.id));
  // 无主占位反查(回退路径):**从最晚的发起往前**认——早一次没跑起来的发起不得抢走后一次发起的作业(v7);
  //   下界 = 发起时刻 − 2 秒容差,反查取 startedAt 不早于下界、离发起最近的一笔(注入面 findJob 取窗口内最早)
  const found = new Map();
  if (typeof env.findJob === "function") {
    for (const job of [...jobs.values()].reverse()) {
      if (!job.anon) continue;
      const q = { exclude: claimed, dirs: [...jobDirs] };
      if (job.Rraw) q.result = codexNormPath(job.Rraw, job.cwd);
      if (job.taskNorm && Number.isFinite(job.useTs)) { q.task = job.taskNorm; q.from = job.useTs - CODEX_SKEW_MS; q.to = job.useTs + CODEX_FIND_WINDOW_MS; }
      let f;
      try { f = (q.result || q.task) ? env.findJob(q) : null; } catch { f = null; }
      if (f && f.id) { job.label = f.id; claimed.add(f.id); job.anon = false; job.foundId = f.id; found.set(job, f); }
    }
  }
  const since = Number.isFinite(env.since) ? env.since : -Infinity;
  const out = { jobs: [], open: [], unknown: [], running: [] };
  for (const job of jobs.values()) {
    // 规则不追溯(v7,红队 v6 BP-4):v7 生效之前发起的作业不入账——旧判据下诚实做完的,不按新判据补账
    if (Number.isFinite(job.useTs) && job.useTs < since) continue;
    let kind = job.obs.kind;
    let why = job.obs.why || "";
    let failSeq = kind === "failed" ? job.obs.seq : null;
    let failTs = null;
    let f = found.has(job) ? found.get(job) : undefined;
    if (/^(background|running|unknown)$/.test(kind)) {
      if (f === undefined && !job.anon && typeof env.jobState === "function") f = env.jobState(job.foundId || job.id, [...jobDirs]);
      if (f === undefined) {
        if (kind !== "running") { kind = "unknown"; why = why || "只见到发车 background,作业状态文件未注入(离线回放)"; }
      } else if (!f || typeof f !== "object") {
        if (kind !== "running") { kind = "unknown"; why = job.anon ? why : "作业状态文件读不到或半写"; }
      } else if (f.state === "running") {
        const t0 = Date.parse(f.startedAt || "");
        const lim = (Number(f.timeoutMs) || 15 * 60 * 1000) + CODEX_JOB_GRACE_MS;
        if (Number.isFinite(t0) && now > t0 + lim) { kind = "unknown"; why = "状态文件仍是 running 但已超出其超时(卡住?去 poll 或读日志)"; }
        else kind = "running";
      } else if (f.state === "done") {
        kind = "done";
      } else if (f.state === "failed") {
        kind = "failed"; job.err = f.errorCode || f.error || job.err;
        const te = Date.parse(f.endedAt || "");
        failTs = Number.isFinite(te) ? te : null;
        failSeq = null;
      } else { kind = "unknown"; why = `状态文件 state=${f.state}`; }
      if (f && typeof f === "object") {
        if (f.result) note(job, { RESULT: f.result }, job.cwd);
        if (f.log && !job.L) job.L = codexNormPath(f.log, job.cwd);
      }
    }
    if (kind === "unknown" && job.bgId && Array.isArray(env.bgTasks) &&
      env.bgTasks.some((t) => String(t && t.id) === job.bgId && BG_RUNNING_STATUS.test(String(t && t.status || "").toLowerCase().trim()))) {
      kind = "running";
    }
    const J = job.label || job.foundId || (job.anon ? null : job.id);
    const mine = (k) => (J ? delivered.filter((d) => d.J === J && d.kind === k && d.seq >= job.launchSeq) : []);
    const after = (rec) => (failSeq != null ? rec.seq > failSeq : failTs != null ? rec.ts != null && rec.ts > failTs : false);
    let status;
    // 「运行中」只在台账确实说 running 时先于读回判;台账已清(只剩转录里的旧 running 观测)⇒ 读回仍可结账(红队终审 BP-8:
    //   原先 job-missing 之后又完整 Read 了 R,子代理收尾照拦「运行中」,零出路)
    const ledgerRunning = !!(f && typeof f === "object" && f.state === "running");
    if (kind === "running" && ledgerRunning) status = "running";
    else if (kind === "failed") {
      const jl = J ? J.toLowerCase() : null;
      const handled = mine("FAIL").length > 0 ||
        reads.some((r) => after(r) && ((job.L && r.p === job.L) || (jl && (r.p.endsWith(`/${jl}.log`) || r.p.endsWith(`/${jl}.last.txt`))))) ||
        relaunch.some((x) => after(x) && x.id !== job.id && x.task && x.task === job.taskNorm);
      status = handled ? "failed-handled" : "failed-open";
    } else {
      // 读回:runner 交付的完整 BODY 块(与 R 当前正文一致;R 读不到只认块),或 Read 工具读 R 成功
      let rBody = null;
      if (typeof env.resultBody === "function" && job.Rraw) { try { rBody = env.resultBody(job.Rraw); } catch { rBody = null; } }
      // Read R 只认作业终态之后的读(v6,红队 BP-2 / codex v5「没问到的」第 1 条):之前读到的是占位或同路径旧件。
      //   终态时刻 = 台账 endedAt(与条目 timestamp 比);取不到则 = 转录里首次观测到 done 的位置;都没有 ⇒ 发起之后即可
      //   v7(codex v6 第 3/4 条、红队 v6 BP-8):界 = 台账 resultAt(runner 写 R 之前记;旧台账退到 endedAt),比较用 ≥;
      //   有界而这次读没有时间戳 ⇒ 不算(原先放行);台账在但没有界 ⇒ 退到转录首次观测 done 的位置;
      //   台账读不到 ⇒ 发起之后即可(原先退到 doneSeq,收到通知先 Read 再 poll 的诚实节奏被误拦)。
      //   读到的是 runner 占位文字 ⇒ 永不算(按内容,与时间无关)。
      let doneTs = null, ledger = null;
      const doneSeq = job.obs.kind === "done" ? job.obs.seq : null;
      if (kind === "done") {
        ledger = f && typeof f === "object" ? f : null;
        if (!ledger && !job.anon && typeof env.jobState === "function") { try { ledger = env.jobState(job.foundId || job.id, [...jobDirs]); } catch { ledger = null; } }
        if (ledger && typeof ledger !== "object") ledger = null;
        const te = Date.parse(ledger && (ledger.resultAt || ledger.endedAt) || "");
        if (Number.isFinite(te)) doneTs = te;
      }
      const afterDone = (r) => (doneTs != null ? (r.ts != null && r.ts >= doneTs)
        : ledger && doneSeq != null ? r.seq > doneSeq : true);
      // 空正文回件(a2155edb BP-8):完整读过头部且读到文件尾即算;R 读得到时以 R 当前正文是否为空为准
      //   (R 有正文而本次只回了头部——例如 limit 恰好截在收尾 `---`——不算)。
      const rBodyEmpty = typeof rBody === "string" ? !codexStripHeader(rBody).trim() : true;
      const readBack = mine("BODY").some((d) => typeof rBody !== "string" || codexNormBody(d.text) === codexNormBody(rBody)) ||
        reads.some((r) => r.seq > job.launchSeq && job.R.has(r.p) && !r.ph && (!r.head || (r.emptyBodyRead && rBodyEmpty)) && afterDone(r));
      status = readBack ? "read" : kind === "done" ? "pending-read" : kind === "running" ? "running" : "unknown";
    }
    const label = J || `codex 作业(tool_use …${job.id.slice(1)})`;
    // v7(红队 v6 BP-1 / 附二-5):poll 命令用**这次发起用的那支 runner**,能力也按那一支判——
    //   注入面 runnerDelivers(path, cwd) 判不了(读不到)⇒ 按旧版提示(只给 Read,不给可能不存在的出路)
    const runner = job.runner || "~/.claude/scripts/codex-run.mjs";
    const poll = `node ${runner} --poll ${J || "<J>"}`;
    out.jobs.push({ id: job.id, label, status, why, R: job.Rraw, L: job.L, err: job.err });
    let delivers;
    if (typeof env.runnerDelivers === "function") { try { delivers = env.runnerDelivers(runner, job.runnerCwd || job.cwd); } catch { delivers = undefined; } }
    const legacy = typeof env.runnerDelivers === "function" ? delivers !== true : env.pollDelivers === false;
    const bgNote = "(Bash 的 timeout 给到 600000;命令仍被转后台时,等完成通知后用 Read 读它的输出文件,BODY 块在里面;别接 `| tail`)";
    if (status === "pending-read") {
      out.open.push(legacy
        ? `${label}(已产出待读:${job.Rraw || "结果件"}。谁发车谁读——用 Read 工具读结果件;这次发起用的 runner 是旧版(或判不了),poll 不打正文;` +
          `cat / sed 等 shell 读法不算,子代理读、同任务新作业读过也不替它结账)`
        : `${label}(已产出待读:${job.Rraw || "结果件"}。谁发车谁读——发车方自己 \`${poll}\` 一次` +
          `(正文夹在 CODEX_BODY_BEGIN/END=${J || "<J>"} 里随结果打出,这一条就算读回)${bgNote},或用 Read 工具读结果件;` +
          `cat / sed 等 shell 读法不算,子代理读、同任务新作业读过也不替它结账)`);
    } else if (status === "failed-open") {
      out.open.push(`${label}(失败未处理:${String(job.err || "未记录原因").slice(0, 60)};` +
        (legacy ? "" : `\`${poll}\` 一次(日志尾部夹在 CODEX_FAIL_BEGIN/END 里随结果打出),或`) +
        `用 Read 读日志${job.L ? " " + job.L : ""},或重发同一任务)`);
    } else if (status === "running") {
      out.running.push(legacy
        ? `${label}(运行中:${job.Rraw || "结果件未知"};等它跑完再用 Read 读结果件——这次发起用的 runner 是旧版(或判不了),poll 不会等待)`
        : `${label}(运行中:${job.Rraw || "结果件未知"};用 \`${poll} --wait-ms 600000\` 等到终态——` +
          `done 时正文随结果打出,这一条就算读回;到期仍在跑会以退出码 3 返回)${bgNote}`);
    } else if (status === "unknown" && (!Number.isInteger(env.turnStart) || job.lastEi >= env.turnStart)) {
      const hint = J ? `poll 一次(${poll})或用 Read 读结果件${job.Rraw ? " " + job.Rraw : ""}`
        : job.Rraw ? `用 Read 读结果件 ${job.Rraw}`
        : `这次发起没留下 J 与结果路径:到 <系统临时目录>/codex-run-jobs/ 按任务名${job.task ? "(" + job.task + ")" : ""}找到它的 J,` +
          `再 --poll J(后台 / 重定向输出里的 CODEX_JOB 块被读到时也会认领这笔)`;
      out.unknown.push(`${label}(状态未知:${why || "无法判定"};${hint})`);
    }
  }
  return out;
}

/** SubagentStop 边界上的 codex 账:子代理自己发车的作业,收尾时 **运行中 / 已产出待读 / 失败未处理** 都阻断;
 *  状态未知只提示(本轮门控:entries 末轮之前的作业不重报,BP4-11)。`STOP_CLOSURE_BLOCK_A=0` ⇒ 阻断降为提示。 */
export function subagentCodexVerdict(entries, env = {}) {
  const turn = lastTurn(Array.isArray(entries) ? entries : []);
  const r = codexLedger(entries, { turnStart: Math.max(0, (entries || []).length - turn.length), ...env });
  const block = [...r.open, ...r.running].map((s) => `A:codex 委派未闭环 ${s}`);
  const notes = r.unknown.map((s) => `A:codex 委派 ${s}`);
  const off = env.blockOff !== undefined ? env.blockOff : BLOCK_OFF.A === false;   // 与主通道同一开关(自测可注入)
  if (off) return { block: [], notes: [...block.map((s) => `${s}(STOP_CLOSURE_BLOCK_A=0,降为提示)`), ...notes] };
  return { block, notes };
}

/** SubagentStop 分支用的外壳:账抛错 ⇒ 点名 A 的 UNKNOWN 行,不静默(BP3-4)。 */
export function subagentCodexSafe(entries, env = {}) {
  try { return subagentCodexVerdict(entries, env); }
  catch (e) { return { block: [], notes: [`A:UNKNOWN codex 账出错(${safeErrMsg(e).slice(0, 60)})——本项未判,不得读作无欠账`] }; }
}

/** 读转录尾段(子代理转录超整分支预算时,A 只读尾段,BP4-13):最后 bytes 字节,丢掉第一行残段。 */
export function readTranscriptTail(p, bytes) {
  const fd = fs.openSync(p, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (size > len) lines.shift();
    const out = [];
    for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* 残行跳过 */ } }
    return out;
  } finally { fs.closeSync(fd); }
}

/** 生产 hook 的注入面:作业状态文件、反查、结果正文。读不到 ⇒ null(未知),半写有限重试。 */
export function liveCodexEnv(extra = {}) {
  const root = `${String(os.tmpdir()).replace(/\\/g, "/")}/codex-run-jobs`;
  const readJson = (f) => {
    for (let k = 0; k < 3; k++) {
      try { return JSON.parse(fs.readFileSync(f, "utf8")); }
      catch (e) { if (e && e.code === "ENOENT") return null; }
    }
    return null;
  };
  // 查找目录 = hook 自己的作业目录 + 转录里 CODEX_LOG 显示的作业目录;按归一路径去重(盘符路径不分大小写)
  const rootsWith = (dirs) => {
    const seen = new Map();
    for (const d of [root, ...(Array.isArray(dirs) ? dirs : [])]) {
      const k = codexNormPath(d, null);
      if (k && !seen.has(k)) seen.set(k, String(d).replace(/\\/g, "/").replace(/\/+$/, ""));
    }
    return [...seen.values()];
  };
  // 某支 runner 带不带 v5 交付能力(v7,红队 v6 附二-5):看它的**代码**里有没有导出交付函数(注释里提到不算);
  //   读不到 ⇒ false(按旧版提示,只给 Read)。按归一路径缓存。
  const delivCache = new Map();
  const runnerDelivers = (p, cwd) => {
    const k = codexNormPath(p, cwd || process.cwd());
    if (!k) return false;
    if (!delivCache.has(k)) {
      let v = false;
      try { v = /^export function formatDelimited\(/m.test(fs.readFileSync(k, "utf8")); } catch { v = false; }
      delivCache.set(k, v);
    }
    return delivCache.get(k);
  };
  return {
    cwd: process.cwd(),
    root,
    roots: rootsWith,
    since: CODEX_A_SINCE,
    runnerDelivers,
    // 后台发起的输出文件(v7 直连身份):只读前 256KB,读不到 ⇒ null
    readOutput(p) {
      const k = codexNormPath(p, null);
      if (!k || !/\.output$/i.test(k)) return null;
      try {
        const fd = fs.openSync(k, "r");
        try { const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 256 * 1024)); fs.readSync(fd, buf, 0, buf.length, 0); return buf.toString("utf8"); }
        finally { fs.closeSync(fd); }
      } catch { return null; }
    },
    ...extra,
    jobState(J, dirs) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(J)) return null;
      for (const d of rootsWith(dirs)) { const j = readJson(`${d}/${J}.json`); if (j) return j; }
      return null;
    },
    // 无主占位反查:结果路径相等,或任务文件相等且 startedAt 落在窗口内(取最早一笔);每目录上限 3000 份台账
    findJob(q) {
      let best = null;
      for (const d of rootsWith(q.dirs)) {
        let names;
        try { names = fs.readdirSync(d).filter((n) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(n)); } catch { continue; }
        for (const n of names.slice(-3000)) {
          const id = n.slice(0, -5);
          if (q.exclude && q.exclude.has(id)) continue;
          const j = readJson(`${d}/${n}`);
          if (!j || typeof j !== "object") continue;
          if (q.result && j.result && codexNormPath(j.result, null) === q.result) return { ...j, id };
          if (q.task && j.task && codexNormPath(j.task, null) === q.task) {
            const t = Date.parse(j.startedAt || "");
            if (Number.isFinite(t) && t >= q.from && t <= q.to && (!best || t < best.t)) best = { j: { ...j, id }, t };
          }
        }
      }
      return best ? best.j : null;
    },
    resultBody(R) {
      try {
        const st = fs.statSync(R);
        if (st.size > 2_000_000) return null;
        return fs.readFileSync(R, "utf8");
      } catch { return null; }
    },
  };
}

// 判 Bash 命令是否真的**写了**某类文件。两处必须先剥掉,否则必然误报
// (2026-08-19 实撞:一条 `git add <载体> && git commit -m "$(cat <<'EOF' … EOF)"`
//  被判成「经 Bash 写载体」——载体路径来自 git add 的参数,写动作符号来自 commit message 正文):
//   ① **heredoc 正文是数据不是命令**,整段剥掉;
//   ② **git 子命令不是写文件**(add/commit/push/status/log/diff/show 只动索引与历史,
//      真正写工作树的 checkout/restore/reset 另算,但那不是「造物」)。
/** 有没有真跑过一条**机械探针**(node … verify/check/probe/-test/audit)。
 *
 *  ⚠️ 这里刻意**不用带间隙的正则**。原式 `/node\s+(?:[^"]|\\")*(verify|check|…)/`
 *  是一条灾难性回溯的正则:`[^"]` 与 `\\"` **重叠**(反斜杠本身也匹配 `[^"]`),
 *  于是同一段文本有指数级多种匹配路径。实测(2026-08-20,grill:edge-cases 报出、我复核):
 *      50KB → 370ms   200KB → 3935ms   400KB → **16716ms**
 *  输入翻 8 倍耗时翻 45 倍;600KB 就冲过 hook 的 30 秒超时,而**被超时杀死的 hook 不阻断**
 *  ⇒ 19 项检查全部静默跳过,外面看到的与「全跑,无命中」无从区分。
 *  也就是说这是一个**由普通工作量触发的、无声的全局关闭开关**——一次长 Bash 日志、
 *  一份大文件、一个子代理的长回件就够。它比任何一条误拦都严重,因为其余问题至少会以
 *  「拦错了」的形式暴露,只有这一条让人在闸已经死了的时候继续以为它活着。
 *
 *  更讽刺的是:`(?:[^"]|\\")*` 本身是 2026-08-19 的**修法**(为穿过 Windows 带引号路径),
 *  原来的 `[^"]*` 不会爆炸。**修一个漏判,换来一个全局关闭开关。**
 *
 *  现在的形态:先按命令分隔切段,再在**定长窗口**内找关键词——无间隙、无回溯,线性。
 *  同时对输入设上限:`gate-ctx.mjs` 早就为这个形状备了 SCAN_CAP,只是一直没接到这条路径上。
 */
/** 一条 `node …` 命令最长看多少字符。2000 而不是 400 —— 后者是我拍的,
 *  codex 复核给出可复现漏判:`"node " + "a".repeat(395) + "verify"` 旧式认、新式不认。
 *  2000 覆盖「Windows 绝对路径 + 若干长 flag」的现实上限;它仍是个**硬阈值**,
 *  故下面有专门用例把边界两侧钉住(codex 原话:阈值没有业务依据,而测试没钉住边界)。 */
export const PROBE_WINDOW = 2000;
/** 扫描输入上限。留尾不留头,与 gate-ctx 的 SCAN_CAP 同口径。
 *  **已知取舍**:一条探针命令若落在 200KB 噪声的**开头**,会被截掉 ⇒ 漏判。
 *  这是任何上限都躲不掉的代价,而没有上限的代价是整道闸被超时杀死(旧式实测 400KB/16.7s)。
 *  两害相权:漏判一次出路①只是多拦一轮,闸静默失效是全局无声关闭。 */
export const PROBE_SCAN_CAP = 200_000;

/** 认得出的探针运行时。**每加一个词都是 fail-open 面**,故只按实撞加,不按「可能有人用」加。
 *
 *  ⚠️ 消费者只有一个:`eFacts().shaped`,即 E0 与 E2。**本注释首版写的是「C/H/E0/E2 都吃」,
 *  那是错的**(codex 114 Q4 逐行核出,已复证:C 看写入/登记、H 看承诺兑现,均不调 `ranProbe`)。
 *  错的来源是文件里更早的一处同样过期的注释——**注释漂移会直接把攻击面判大或判小**,
 *  而安全审计正是照着注释找入口的。改这条时请连带核一遍调用点,别再照抄。
 *  - `node`/`nodejs`:本仓自身。
 *  - `python`/`python3`:2026-08-27 实撞(D69)——另一条会话在 Python 仓里写了
 *    `tests/probe_rate1_determinism.py` 并跑出退出码,是教科书式的「形」证据,
 *    却因运行时不是 node 而 `shaped=false` ⇒ E0 拦下一句**有机器判据兜底**的话。
 *    闸已开源(custodiet),别人的仓本就不必是 Node。
 *  **天花板**:这是一张运行时白名单,go/cargo/ruby/deno 一律不认。
 *  **失效条件**:再撞到第二个未列运行时,就不许继续往表里塞词——
 *  改成读仓库配置(或按「本轮写出的文件被本轮执行」这一行为判据),否则这表会长到没人维护。 */
export const PROBE_RUNTIMES = ["nodejs", "node", "python3", "python"];
/** 词界与旧式逐字等价:前界非 `[\w-]`(挡 `bin/mynode`),后界非 `[A-Za-z0-9_-]`
 *  (挡 `nodemon`/`pythonic`,放行 `node.exe`)。长词在前,`nodejs`/`python3` 先于短词匹配。
 *  形状上是纯字面量交替 + 环视,**无嵌套量词、线性**——这条路径上一次爆炸过一回(见上文)。 */
const PROBE_RT_RE = new RegExp(
  String.raw`(?<![\w-])(?:${PROBE_RUNTIMES.join("|")})(?![A-Za-z0-9_-])`, "g");

export function ranProbe(blob) {
  const s = String(blob).slice(-PROBE_SCAN_CAP);
  const PROBE = /verify|check|probe|-test|audit/;
  PROBE_RT_RE.lastIndex = 0;
  for (;;) {
    const m = PROBE_RT_RE.exec(s);
    if (!m) return false;
    const at = m.index;
    // 只看这条运行时命令之后的一段:命令通常远短于此,超出即视为跨到别的命令去了
    const seg = s.slice(at, at + PROBE_WINDOW)
      // ⚠️ shell 续行 `\<换行>` 要先接回来,否则换行被当命令边界 ⇒
      //   `node --no-warnings \<换行> scripts/verify-laws.mjs` 漏判(codex 复核给出)。
      .replace(/\\\r?\n\s*/g, " ").replace(/\\\\n\s*/g, " ");
    // 切到命令边界为止,再找关键词。
    // ⚠️ 只在**未转义**的 `"` 处切(JSON 字段边界),`\"` 要能穿过去——
    //   否则 `node --no-warnings \"…/verify-claims.mjs\"` 会被切在 verify **之前**,
    //   等于把 2026-08-19 修掉的那个「带引号路径漏判」原样带回来。
    //   (第一版我就这么写的,自测当场逮住。Windows 长路径几乎总要加引号。)
    const cmd = seg.split(/(?<!\\)"|[;&|\n]/)[0];
    if (PROBE.test(cmd)) return true;
  }
}

/** 从一条命令里取出**具体的写目标路径**(与 `bashWrites` 同源,不另写一套判据)。
 *
 *  ⚠️ 2026-08-20 grill:error-handling 逮到一个**正在生效的阻断 bug**,由本文件的载体合并引入:
 *  I 项原来用 `cmd.match(CARRIER_RE)` 取路径,而派生正则是把各类 source 用 `|` 拼的,
 *  交替支「最左最先」⇒ `m[0]` 往往是**前缀**不是路径:
 *      scripts/lib/gate-carriers.mjs  → m[0] = "scripts/lib/"
 *      .claude/agents/foo.md          → m[0] = ".claude/agents/"
 *  而 `scripts/lib/` 在 `git ls-files` 里当然不存在 ⇒ `isNew()` **恒判新建**
 *  ⇒ **经 Bash 改任何既有承重文件都被 I 阻断**。
 *  这正是 `isNew` 当初要修的那个误拦(「连改三轮同一个既有文件被连拦三次」),
 *  被合并原样放回来,而且这次带 `block: true`。
 *  修法不是改分类表,是**别用 m[0]**:拿 `bashWrites` 已经解出来的目标。 */
/** 重定向目标的路径 token,**只此一份**(D100,2026-09-06;grill 复核逮到「两处须一起改」其实是三处:
 *  本函数、`bashWrites` 的普通支、`bashWrites` 的 execForm 支——改了两处漏一处,
 *  `node gen.mjs > ~/…/memory/x.md` 对 I 隐形)。允许盘符 / `~` / `$HOME` 前缀;
 *  `${VAR}`、含空格的引号路径仍解不出——那是**漏放侧**(bashWrites 直接 false,I 根本不跑),不是误报侧。 */
const PATH_TOK = String.raw`(?:[A-Za-z]:|~|\$HOME|\$\{HOME\})?[\w./-]+`;
/** 剥 heredoc 正文(数据不是命令),**保留界符所在行的其余部分**。
 *  ⚠️ heredoc 界符要认**引号形式**(codex 2026-08-20:原式只认 `<<'X'` 与 `<<X`,
 *   而 `cat <<"EOF"` 剥不掉 ⇒ **正文被当命令**,产生假写入)。
 *  ⚠️ a2155edb(BP-7 同批):原式从界符**之后**一路吃到收尾行,把同一行的 `>> docs/noun-diary.md` 也吃掉了
 *   ——`cat <<'EOF' >> 文件` 是追加的常见写法,真写入因此对本函数隐形。 */
function stripHeredocBodies(cmd) {
  return String(cmd).replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?^\s*\2\s*$/gm, (_m, _q, _w, rest) => " " + rest);
}
/** 一段命令(已按语句分隔符切过)里**引号外**的 `&`、`(`、`)`、反引号再切一刀:子 shell、命令替换、后台 `&`、
 *  `2>&1` 都在这里断开。返回原文切片(引号内容原样保留,供取 JS/Python 写调用的入参)。 */
function subParts(seg, ps = false) {
  const masked = stripQuoted(seg, ps);
  const esc = ps ? "`" : "\\";
  const out = [];
  let at = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === esc) { i++; continue; }
    if ("&()`".includes(masked[i])) { out.push(seg.slice(at, i)); at = i + 1; }
  }
  out.push(seg.slice(at));
  return out.map((s) => s.trim()).filter(Boolean);
}
/** 重定向目标:只认**引号外**的 `>` / `>>`(`awk 'NF > 3'`、`--cond "…>1MB"`、node -e 里的 `=>` 都在引号里,a2155edb BP-2);
 *  目标 token 从原文取(可带引号)。`>&1` 这类 fd 复制、`/dev/*`、PowerShell 的 `$null` 不算写。 */
function redirectTargets(part, ps = false) {
  const masked = stripQuoted(part, ps);
  const esc = ps ? "`" : "\\";
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === esc) { i++; continue; }
    if (masked[i] !== ">") continue;
    const prev = i > 0 ? masked[i - 1] : "";
    if (prev === "=" || prev === "-") continue;                 // `=>` 箭头、`->`(2026-08-22 实撞,--fp 第 3 笔)
    let j = i + 1;
    if (masked[j] === ">") j++;
    if (masked[j] === "|") j++;                                 // `>|` 强制覆盖
    while (j < part.length && /\s/.test(part[j])) j++;
    if (part[j] === "&") { i = j; continue; }                   // `>&2`
    const tok = codexWords(part.slice(j), ps)[0] || "";
    i = j;
    if (!tok || /^(\/dev\/|\$null$|nul$)/i.test(tok)) continue;
    out.push(tok);
  }
  return out;
}
/** 解释器内联脚本里的写文件调用(入参是字面量路径才取得到;变量、path.join 取不到——漏放侧,照实列在头注)。 */
const API_WRITE_RES = [
  // node:fs 同步 / 回调 / promises / 流
  /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*(['"`])([^'"`]+)\1/g,
  // python:open(路径, 'a'|'w'|'x'|'+') 与 Path(路径).write_text/.write_bytes/.open('a')
  /\bopen\s*\(\s*[rRbBuU]?(['"])([^'"]+)\1\s*,\s*(?:mode\s*=\s*)?[rRbBuU]?['"][^'"]*[wax+][^'"]*['"]/g,
  /\bPath\s*\(\s*[rR]?(['"])([^'"]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|open\s*\(\s*['"][^'"]*[wax+])/g,
  // .NET:[IO.File]::WriteAllText / AppendAllText / AppendAllLines …
  /\[(?:System\.)?IO\.File\]::(?:WriteAll\w*|AppendAll\w*)\s*\(\s*(['"])([^'"]+)\1/gi,
];
/** PowerShell 写文件 cmdlet:取 -Path / -LiteralPath / -FilePath 的值,没有就取第一个位置参数(这三个 cmdlet 的 0 号位都是路径)。 */
const PS_WRITE_CMDLETS = /^(?:add-content|set-content|out-file|tee-object|ac)$/i;
const PS_MOVE_CMDLETS = /^(?:copy-item|move-item|cpi|mi|copy|move)$/i;
const PS_PATH_PARAMS = /^(?:path|literalpath|filepath|pspath|lp|destination)$/i;
const PS_SWITCHES = /^(?:nonewline|force|append|noclobber|passthru|whatif|confirm|asbytestream|recurse|container)$/i;
function psTargets(words, k, move) {
  const named = [], pos = [];
  for (let i = k + 1; i < words.length; i++) {
    const w = words[i];
    if (/^-[A-Za-z]/.test(w)) {
      const [name, inline] = w.slice(1).split(/:(.*)/s);
      if (PS_SWITCHES.test(name)) continue;
      const val = inline !== undefined && inline !== "" ? inline : words[++i];
      if (val === undefined) break;
      if (PS_PATH_PARAMS.test(name) && (!move || /^destination$/i.test(name))) named.push(val);
      continue;
    }
    pos.push(w);
  }
  if (named.length) return named;
  return move ? (pos.length >= 2 ? [pos[1]] : []) : (pos.length ? [pos[0]] : []);
}
/** 命令名比较:`/usr/bin/sed`、`sed.exe` 都是 sed;**整词**比较(a2155edb:旧式 `(?:tee|cp|mv)\s+` 缺词界,
 *  `committee x`、`scp a b`、`gcp …` 都被当成 tee/cp)。 */
const cmdName = (w) => String(w || "").replace(/\\/g, "/").replace(/^.*\//, "").replace(/\.exe$/i, "").toLowerCase();
/** 包装器 → 它**带值**的选项(红队 a811daae BP-4:原式只跳 `-` 开头的词,`nice -n 10 cp`、`sudo -u bob cp`、
 *  `xargs -I {} cp` 的选项值被当成命令名 ⇒ 写命令整个看不见)。`s` = 带值短选项字母(可附着 `-ubob` 或取下一词;
 *  簇 `-Eu bob` 里带值字母在簇尾才取下一词),`l` = 带值长选项(`--user bob`;`--user=bob` 自带值),`pos` = 选项之后
 *  还要吞掉的位置参数个数(timeout 的时长)。表外选项一律当无值开关——**漏表的带值选项是漏放侧**(其值被当命令名)。 */
const CMD_WRAPPERS = {
  sudo: { s: "ugpCDrRtTU", l: /^--(?:user|group|prompt|close-from|chdir|role|type|other-user|command-timeout|host)$/ },
  doas: { s: "uC" },
  env: { s: "uCS", l: /^--(?:unset|chdir|split-string)$/ },
  xargs: { s: "IdEaLnPs", l: /^--(?:arg-file|delimiter|max-args|max-lines|max-procs|max-chars|process-slot-var)$/ },
  nice: { s: "n", l: /^--adjustment$/ },
  ionice: { s: "cnp", l: /^--(?:class|classdata|pid)$/ },
  nohup: {}, command: {}, busybox: {}, builtin: {},
  time: { s: "fo", l: /^--(?:format|output)$/ },
  exec: { s: "a" },
  stdbuf: { s: "ioe", l: /^--(?:input|output|error)$/ },
  timeout: { s: "sk", l: /^--(?:signal|kill-after)$/, pos: 1 },
};
const wrapperOptTakesNext = (w, spec) => {
  if (/^--/.test(w)) return !w.includes("=") && !!spec.l && spec.l.test(w);
  for (let i = 1; i < w.length; i++) if ((spec.s || "").includes(w[i])) return i === w.length - 1;
  return false;
};
/** 段首的 shell 保留字 / PowerShell 关键字:**其后**仍是命令位(BP-4:`then cp …`、`do …`、`{ cp …; }`、`! cp …`
 *  原被当成命令名)。`SH_NO_CMD`:其后不是命令(`for x in …` 的变量名、`case x in`)——整段无命令。 */
const SH_LEAD = /^(?:then|do|else|elif|if|while|until|!|\{|try|finally)$/;
const SH_NO_CMD = /^(?:for|foreach|select|case|in|function|done|fi|esac|\}|;;)$/;
/** 一个子段的词序列里哪些位置是**命令位**:返回 `[{k, end}]`,`end` = 该命令参数的右界(不含)——
 *  find `-exec … \;`/`+` 的终止符、`{ … }` 的右括号都在这里截住(否则 `{ cp a b }` 的 `}` 被当成 cp 的目标)。见调用点注释。 */
function cmdPositions(words) {
  const out = [];
  const start = (k, end) => {
    for (;;) {
      while (k < end && /^[A-Za-z_]\w*=/.test(words[k])) k++;                    // 前置 VAR=…
      if (k >= end) return;
      const n = cmdName(words[k]);
      if (SH_LEAD.test(n)) {
        if (n === "{") { const c = words.indexOf("}", k + 1); if (c > k && c < end) end = c; }
        k++; continue;
      }
      if (SH_NO_CMD.test(n)) return;
      if (n === "git") {
        // git 子命令里只有 `mv` 在工作树里造出新路径(语料实撞:`git -C \repo mv a b`,旧式靠缺词界的 `mv\s+` 碰巧认到)
        let j = k + 1;
        while (j < end && /^-/.test(words[j])) { if (/^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(words[j])) j++; j++; }
        if (words[j] === "mv") out.push({ k: j, end });
        return;
      }
      if (/^(?:echo|printf|write-host|write-output)$/.test(n)) return;
      const spec = Object.hasOwn(CMD_WRAPPERS, n) ? CMD_WRAPPERS[n] : null;
      if (!spec) { out.push({ k, end }); return; }
      k++;
      while (k < end && /^-./.test(words[k])) {                                   // 包装器自己的选项(带值的连值一起跳)
        if (words[k] === "--") { k++; break; }
        k += wrapperOptTakesNext(words[k], spec) ? 2 : 1;
      }
      for (let p = 0; p < (spec.pos || 0) && k < end; p++) k++;                   // timeout 的时长
    }
  };
  start(0, words.length);
  for (let k = 1; k < words.length; k++) {
    if (/^-(?:exec|execdir|ok|okdir)$/.test(words[k])) {
      let e = k + 1;
      while (e < words.length && !/^(?:\\?;|\+)$/.test(words[e])) e++;           // find 的 -exec 以 `;`/`\;`/`+` 收尾
      start(k + 1, e);
    } else if (/^%?\{$/.test(words[k])) start(k + 1, words.length);
  }
  return out;
}
/** 剔除重定向词(红队 a811daae BP-3:`cp a .claude/agents/new.md 2>/dev/null` 的「最后一个位置参数」取成了
 *  `2>/dev/null`;tee 把 `>`、`/dev/null` 当目标)。认 `>` `>>` `>|` `&>` `&>>` `<` `<<<` `>&` `<&`,前可带 fd 号或 `*`(PS);
 *  算子自带目标(`2>/dev/null`、`2>&1`)只剔本词,裸算子(`>`、`2>`)连下一词一起剔。
 *  重定向**目标**由 `redirectTargets` 另行(引号感知地)取,这里只管不让它冒充命令参数。
 *  **算子只认引号外**(复核红队 aaf414b6 BP-3,365fd54 引入):原在分词后的纯词上判,引号信息已丢 ⇒
 *  `Add-Content -Value ">" -Path docs/noun-diary.md` 里的 `">"` 被当裸算子、连 `-Path` 一起剔 ⇒ `-Value` 吞掉真路径
 *  (ND 误拦;`Set-Content -Value "<" -Path AGENTS.md` 对 P 不可见)。现吃 `codexWordsShaped` 的词:在 `shape`
 *  (引号内 / 转义字符已换成 \u0001)上判算子,`">x"`、`\>`、`` `> `` 都是参数;`>"x y"` 的算子在引号外,照剔。
 *  失效条件:调用方改回喂纯词数组(无 `shape`)⇒ 按 `w` 判,退回旧行为(BP-3 复活),自测「BP-3b:」各条翻红。 */
const REDIR_WORD = /^(?:\d+|&|\*)?(?:>>|>\||>&|<<<|<&|&>>|&>|>|<)(.*)$/s;
function dropRedirWords(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const x = words[i];
    const w = typeof x === "string" ? x : x.w;
    const m = REDIR_WORD.exec(typeof x === "string" ? x : x.shape);
    if (!m) { out.push(w); continue; }
    if (m[1] === "") i++;                                                          // 裸算子:目标在下一词
  }
  return out;
}
/** sed:-i / --in-place 才是写;有 -e/-f 时全部非选项词都是文件,否则第一个非选项词是脚本、其余是文件。 */
function sedTargets(words, k) {
  let inPlace = false, hasScript = false, endOpts = false;
  const rest = [];
  for (let i = k + 1; i < words.length; i++) {
    const w = words[i];
    if (!endOpts && w === "--") { endOpts = true; continue; }
    if (!endOpts && /^-/.test(w) && w.length > 1) {
      if (/^-[A-Za-z]*i/.test(w) && !/^--/.test(w) || /^--in-place\b/.test(w)) inPlace = true;
      if (w === "-e" || w === "-f" || w === "--expression" || w === "--file") { hasScript = true; i++; }
      else if (/^--(expression|file)=/.test(w)) hasScript = true;
      continue;
    }
    if (w !== "") rest.push(w);
  }
  if (!inPlace) return [];
  return hasScript ? rest : rest.slice(1);
}
/** 方言自判(红队 a811daae BP-6):调用方知道工具名就传 `dialect`("bash" / "ps",或工具名 "Bash" / "PowerShell");
 *  不知道(P 的调用点、窗口外旧调用方、夹具)⇒ 按命令自判:像 PowerShell(段首是动词-名词 cmdlet、或含 `$env:` / `*>` / `>$null`;heredoc 正文先剥掉再看)取 ps,
 *  否则 bash;**所选方言下引号不闭合、另一方言下闭合 ⇒ 换方言**(同一串在一种方言里闭合、另一种不闭合,多半是方言选错)。
 *  自判是近似:两种方言都闭合时只看 cmdlet 形,`powershell -Command "…"` 这类嵌套由 nestedScript 按内层再定。 */
const PS_CMDLET_LEAD = /(?:^|[\n;|{(]\s*|&&\s*)(?:Get|Set|Add|Out|New|Remove|Copy|Move|Test|Select|Where|ForEach|Write|Invoke|Start|Stop|Import|Export|ConvertTo|ConvertFrom|Join|Split|Measure|Sort|Tee|Clear|Rename|Resolve|Push|Pop)-[A-Z][A-Za-z]+\b|\$env:|(?:^|\s)\*>|[\s>]\$null\b/;
export function cmdDialect(cmd, hint) {
  const h = String(hint || "").toLowerCase();
  if (h === "ps" || h === "powershell" || h === "pwsh") return "ps";
  if (h === "bash" || h === "sh") return "bash";
  // 先剥 bash heredoc 正文再看形(语料对照实撞:`cat > x.ps1 <<'EOF'` 正文里的 `$env:`/`Get-…` 把整条 bash 命令判成 ps,
  //   于是 heredoc 不剥、正文被当命令解析);PowerShell 没有 `<<`,对 ps 命令这一步是空操作。
  const s = stripHeredocBodies(String(cmd || ""));
  // 复核红队 aaf414b6 BP-2(365fd54 引入):PS 标记只认**引号外**的。原在未掩码原串上测 ⇒ `sed -i 's/$env:A/$env:B/g' \⏎ AGENTS.md`
  //   引号里的 `$env:` 把 bash 命令判成 ps ⇒ `\`+换行续行失效、换行成分段 ⇒ 续行后的目标丢(P 漏放)。
  //   掩码本身方言相关 ⇒ 两种口径各掩一次各测一次:一致 ⇒ 取之;不一致 ⇒ 取引号闭合的那种口径的结论;
  //   两口径都闭合或都不闭合 ⇒ 取 bash 口径的结论(先按 bash 掩码找、ps 掩码复核)。之后照旧做「所选方言不闭合、另一方言闭合 ⇒ 换」。
  //   失效条件:改回在原串上测 ⇒ 自测「BP-2b:」与 P pos「aaf414b6 BP-2」翻红。
  const qb = quoteScan(s, false), qp = quoteScan(s, true);
  const byB = PS_CMDLET_LEAD.test(qb.masked) ? "ps" : "bash";
  const byP = PS_CMDLET_LEAD.test(qp.masked) ? "ps" : "bash";
  const d = byB === byP ? byB : (qb.open && !qp.open ? byP : byB);
  const [qd, qo] = d === "ps" ? [qp, qb] : [qb, qp];
  return qd.open && !qo.open ? (d === "ps" ? "bash" : "ps") : d;
}
export function bashWriteTargets(rawCmd, pathRe, opts = {}) {
  const ps = cmdDialect(rawCmd, typeof opts === "string" ? opts : opts && opts.dialect) === "ps";
  // heredoc 是 POSIX 语法;PowerShell 没有 `<<`(here-string 由 quoteScan/codexWords 的 ps 口径整段吞)
  const noHeredoc = ps ? String(rawCmd) : stripHeredocBodies(rawCmd);
  // ⚠️ **已知误报，试过一次修法、失败并退回，记在这里免得下次再试**（2026-08-20）。
  //   症状：M 报了一个**根本不存在**的 `f.md` —— 它来自我为了测正则而写的探针字符串
  //   `node -e "…cat > f.md <<EOF…"`。仓里 grep 全零。
  //   **为了验闸而写的探针，自己在喂闸**（同形态在 P 的通道①上也发生了，已登记 D30）。
  //
  //   试过的修法：剥掉 `-e`/`--eval` 的引号载荷。**错的**，两个证据：
  //     ① 非贪婪匹配在第一个转义引号处就停了，探针那条照样命中；
  //     ② **它弄坏了一条真用例**（零件用例 23/23 → 22/23）——
  //       因为 `node -e 'fs.writeFileSync("scripts/x.mjs",…)'` **本身就是真写入**，
  //       而那正是我最常用的写文件方式 ⇒ 剥掋载荷 = 对主要写入通道彻底失明（fail-open）。
  //   → 根因：「载荷里**提到**写入」与「载荷里**真的在**写入」的区别，
  //     要靠**读懂 JS**，不是读懂 shell。shell 层分不开。
  //   → 现状保留：假写入目标会让 M 要求回读一个不存在的文件（吓人但 **fail-closed**）。
  //     宁可如此，不要为了安静而把真写入放过去。
  // ── a2155edb(BP-2 / BP-7)改为**引号感知**:先按 gate-cmd 的 `segments()`(引号外才切,含 `|`)切语句,
  //   段内再按引号外的 `&` `(` `)` 反引号切成子段;重定向只认引号外的 `>`,命令按词(`codexWords`,PowerShell 口径:
  //   反斜杠是普通字符)认、整词比命令名。由此修掉:`awk 'NF > 3'`、`--cond "…>1MB"`、`=>` 被当重定向;
  //   `sed -i '$a | wg | … |' 文件` 的脚本里的 `|` 把真目标截掉;`committee`/`scp` 被当 tee/cp;
  //   Add-Content / Set-Content / Out-File、python open(…,'a') 认不出;`cat <<'EOF' >> 文件` 同行重定向被 heredoc 剥掉。
  //   顺带结清 D7「引号包分号——真目标丢失」(那条用例改钉新行为)。
  // ⚠️ 仍不做的(漏放侧,照实):变量 / 命令替换拼出的路径、`path.join(...)` 入参、`cd docs; … >> noun-diary.md` 的相对目录、
  //   `dd of=`、`install`、`New-Item -Value`;`cp -r a/ b/` 仍取到目录 `b/`。
  // ── a811daae:BP-6 掩码/切段/分词按**同一方言**(bash:反斜杠转义;PowerShell:反引号转义、反斜杠是普通字符);
  //   BP-4 命令位跳过 shell 保留字(then/do/else/{/! …)与包装器带值选项(`nice -n 10`、`sudo -u bob`、`xargs -I {}`);
  //   BP-3 命令参数先剔重定向词(`2>/dev/null`、`>`+目标)再取「最后一个位置参数」。
  const out = rawWriteTargets(noHeredoc, 0, ps);
  // ⚠️ 规格化 `./` 与 `..`(codex:`scripts/../scripts/x.mjs` 实际是既有文件,
  //   而 `isNew` 只做字符串裁剪、不消解 `..` ⇒ 误判新建)。
  const norm = (p) => {
    const parts = [];
    for (const seg of String(p).replace(/\\/g, "/").replace(/^\.\//, "").split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === ".." ) { parts.pop(); continue; }
      parts.push(seg);
    }
    return parts.join("/");
  };
  // ⚠️【已登记未修】codex 另报三条:
  //   ① `node a.mjs | tee scripts/new.mjs` —— `bashWrites` 的 execForm 分支不识别 tee ⇒
  //      本函数根本不被调用(缺陷在 bashWrites 侧,不在这里);
  //   ② `cp -r a/ b/` 取到目录 `b/`,无从知道实际写的是 `b/a`;
  //   ③ (a2155edb 起已解:按词取认引号)`cp a ".claude/agents/new agent.md"` 曾被按空白拆碎。
  // 含未展开变量的目标(`.claude/skills/x/$NAME.md`、`$env:X`)解不出真路径 ⇒ 不报(旧 PATH_TOK 在 `$` 处截断,
  //   调用点再按「不闭合」丢掉;按词取之后整段都在,这里显式丢,口径不变)。`~`、`$HOME`、`${HOME}` 前缀照旧认。
  const unresolved = (p) => /\$/.test(String(p).replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, ""));
  return [...new Set(out.map(norm))].filter((p) => p && !unresolved(p) && pathRe.test(p));
}
/** 子 shell 的脚本参数:`bash -c '…'` / `sh -lc "…"` / `cmd /c "…"` / `powershell -Command "…"`。
 *  语料对照实撞:`cmd /c "cd /d \repo && pnpm graph:check > clipboard\x.log"` 的重定向在引号里,引号感知后要递归进去才认得。 */
function nestedScript(words, k) {
  const n = cmdName(words[k]);
  if (/^(?:bash|sh|zsh|dash)$/.test(n)) {
    for (let i = k + 1; i < words.length; i++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[i]) && !/^--/.test(words[i])) return words[i + 1] ?? null;
      if (!/^-/.test(words[i])) return null;                      // 跑脚本文件,不是 -c
    }
    return null;
  }
  if (n === "cmd") {
    const i = words.findIndex((w, j) => j > k && /^\/[ck]$/i.test(w));
    return i > 0 ? words.slice(i + 1).join(" ") : null;
  }
  if (n === "powershell" || n === "pwsh") {
    const i = words.findIndex((w, j) => j > k && /^-(?:c|command)$/i.test(w));
    return i > 0 ? words.slice(i + 1).join(" ") : null;
  }
  return null;
}
function rawWriteTargets(noHeredoc, depth, ps = false) {
  const out = [];
  for (const seg0 of segments(noHeredoc, ps)) {
    for (const part of subParts(seg0, ps)) {
      // 解释器内联脚本里的写调用:入参在引号里,扫原文(「提到」与「真写」shell 层分不开——见上方已知误报,保留 fail-closed)
      for (const re of API_WRITE_RES) { re.lastIndex = 0; for (const m of part.matchAll(re)) out.push(m[2]); }
      // 分词与掩码同一方言(BP-6);重定向词先剔掉,不让它冒充命令名或参数(BP-3)
      const words = dropRedirWords(codexWordsShaped(part, ps));   // 带 shape:引号里的 `>`/`<` 不是算子(aaf414b6 BP-3)
      // ⚠️ `(?<![=\-])` 的旧意(2026-08-22 实撞,--fp 第 3 笔):箭头函数不是重定向——现由 redirectTargets 的前一字符检查承接。
      // ⚠️ D100(2026-09-06):盘符 / `~` 路径要整段取到——现由按词取承接(不再走 PATH_TOK 字符类)。
      for (const t of redirectTargets(part, ps)) out.push(t);
      // 只在**命令位**认写命令(`grep -n tee docs/noun-diary.md` 的 tee 是参数,不是命令):
      //   段首(跳过前置 VAR=… 与 shell 保留字 then/do/else/{/! …)、包装器(sudo/env/xargs/nohup/time/nice/timeout/busybox…,
      //   带值选项连值跳过)之后、find 的 -exec/-execdir 之后(到 `;`/`+` 为止)、PowerShell 脚本块 `{` / `%{` 之后。
      //   git 子命令不写工作树文件(重定向照上面认)。
      for (const { k, end } of cmdPositions(words)) {
        const ws = words.slice(0, end);
        const name = cmdName(ws[k]);
        if (name === "sed") out.push(...sedTargets(ws, k));
        else if (name === "tee") out.push(...ws.slice(k + 1).filter((x) => x && !x.startsWith("-")));   // `--` 不是目标(codex 2026-08-20)
        else if (name === "cp" || name === "mv") {
          // `-t DIR` / `--target-directory[=]DIR`:目标是 DIR(语料:`find … -exec mv -t packets/math {} +`,旧取到 `+`)。
          //   与 `cp -r a/ b/` 同一天花板:取到的是目录,不知道落进去的文件名。
          const ti = ws.findIndex((x, i) => i > k && /^(?:-t|--target-directory)(?:=|$)|^-t./.test(x));
          if (ti > 0) {
            const w = ws[ti];
            const v = w === "-t" || w === "--target-directory" ? ws[ti + 1] : w.replace(/^(?:--target-directory=|-t)/, "");
            if (v) out.push(v);
            continue;
          }
          const toks = ws.slice(k + 1).filter((x) => x && !x.startsWith("-"));
          if (toks.length >= 2) out.push(toks[toks.length - 1]);      // cp A B 写的是 B
        }
        else if (PS_WRITE_CMDLETS.test(name)) out.push(...psTargets(ws, k, false));
        else if (PS_MOVE_CMDLETS.test(name)) out.push(...psTargets(ws, k, true));
        else if (depth < 3) {
          const inner = nestedScript(ws, k);
          // 内层方言按外壳定:bash/sh -c ⇒ bash;powershell/pwsh -Command、cmd /c ⇒ ps 口径(反斜杠是普通字符)
          if (inner) {
            const innerPs = !/^(?:bash|sh|zsh|dash)$/.test(name);
            out.push(...rawWriteTargets(innerPs ? inner : stripHeredocBodies(inner), depth + 1, innerPs));
          }
        }
      }
    }
  }
  return out;
}

export function bashWrites(rawCmd, pathRe) {
  const noHeredoc = String(rawCmd).replace(/<<-?\s*'?(\w+)'?[\s\S]*?^\s*\1\s*$/gm, " ");
  const segs = noHeredoc.split(/&&|\|\||;|\n/);
  return segs.some((s) => {
    const seg = s.trim().replace(/\\/g, "/");
    if (/^git\s+(add|commit|push|status|log|diff|show|stash|fetch|pull|branch|tag)\b/.test(seg)) return false;
    // **执行一个脚本 ≠ 写它**(2026-08-19 实撞:`node scripts/batch-goal.mjs --arm … >/dev/null`
    // 因命令里同时有载体路径与 `>` 被判成写载体)。凡载体路径出现在解释器/执行位上,一律不算写。
    const execForm = new RegExp(`(node|python3?|bash|sh|npx|pnpm)\\s+(--?[\\w-]+\\s+)*${"[^|;&]*"}`).exec(seg);
    if (execForm && pathRe.test(execForm[0])) {
      // 载体在执行位:只有当写动作的**目标**另有其路径时才算写
      // 路径类用 `PATH_TOK`(D100 三处之一;grill 复核逮到这一处漏改 ⇒ `node gen.mjs > ~/…/memory/x.md` 对 I 隐形)
      const target = new RegExp(String.raw`(?:writeFileSync|appendFileSync)\s*\(\s*['"]([^'"]+)|>>?\s*['"]?(${PATH_TOK})|sed\s+-i[^ ]*\s+\S+\s+(${PATH_TOK})`).exec(seg);
      const t = target ? (target[1] || target[2] || target[3] || "") : "";
      return !!t && pathRe.test(t);
    }
    if (!pathRe.test(seg)) return false;
    // ⚠️ 写动作必须**以载体为目标**,不能只是「命令里同时出现了载体和某个写符号」。
    //   2026-08-19 实撞:`ls .claude/agents/*.md 2>/dev/null` 和
    //   `grep -Rl x .claude/skills/ 2>/dev/null` 被判成「本轮新建载体」——
    //   载体是被**读**的对象,`>` 的目标是 /dev/null。同族第 N 次:判据看措辞不看后果。
    if (/writeFileSync|appendFileSync|sed\s+-i|tee\s/.test(seg)) return true;
    // 路径类见 `PATH_TOK`(D100 三处之一)。
    for (const m of seg.matchAll(new RegExp(String.raw`>>?\s*['"]?(${PATH_TOK})`, "g"))) {
      if (/^\/dev\//.test(m[1])) continue;            // 丢进黑洞不算写
      if (pathRe.test(m[1])) return true;
    }
    for (const m of seg.matchAll(/\b(?:cp|mv)\s+([^;&|]+)/g)) {
      const toks = m[1].trim().split(/\s+/).filter((t) => !t.startsWith("-"))
        .map((t) => t.replace(/^["'`]|["'`]$/g, ""));
      if (toks.length && pathRe.test(toks[toks.length - 1])) return true;   // cp A B 写的是 B
    }
    return false;
  });
}

// 从一句承诺/自陈里抽出它**指向的对象**:反引号内容、路径、`--flag`、命令名。
// 为什么要它:B/C/H 的豁免原本只看「本轮有没有写动作」,于是一次**无关**的动作即可豁免整项
// (2026-08-19 实撞:说「我现在就跑那个检查」而本轮跑的是另一件事,B 被豁免)。
// 判「这个动作是不是那件事」需要语义,机器给不出;但**对象层面的字符串包含**是可判的近似:
// 承诺里提到 `foo.mjs`,就看本轮工具调用里有没有 `foo.mjs`。
// 两种情况都算命中:①提了对象但本轮动作里没有它 ②**根本没提任何具体对象**
// ——后者是刻意的:无对象的承诺句本身不可验证,「我这就去处理一下」正是最常见的空头支票。
export function extractTargets(line) {
  const t = new Set();
  for (const m of line.matchAll(/`([^`\n]{2,60})`/g)) t.add(m[1].trim());
  // 量词封顶同上(D57):原 `[\w.-]+\/[\w./-]+` 在 200KB 单字符输入上实测 31.3 秒。
  for (const m of line.matchAll(/([\w.-]{1,128}\/[\w./-]{1,512}\.\w{1,5})/g)) t.add(m[1]);
  for (const m of line.matchAll(/(--[a-z][\w-]{2,})/g)) t.add(m[1]);
  for (const m of line.matchAll(/\b([\w-]+\.(mjs|ts|js|md|json))\b/g)) t.add(m[1]);
  return [...t];
}

// **只**序列化工具调用的入参与结果,不含 assistant 自己的文本。
// 为什么必须分开:承诺句里提到 `foo.mjs`,那串字符本来就在 assistant 文本里,
// 若拿全文做包含判断,**承诺句永远自证兑现**(2026-08-19 自测当场逮到)。
function toolRawText(entries) {
  const parts = [];
  for (const e of entries) {
    const c = e.message?.content;
    if (!Array.isArray(c)) { continue; }
    for (const b of c) {
      if (b?.type === "tool_use") { try { parts.push(JSON.stringify(b.input || {})); } catch {} }
      if (b?.type === "tool_result") { try { parts.push(JSON.stringify(b.content || "")); } catch {} }
    }
  }
  return parts.join("\n");
}

// 承诺/自陈句是否被本轮的动作兑现。返回未兑现的句子列表。

/** ⚠️ **原实现每个模式只取第一条命中行就 `break`**(2026-08-20 grill:recon 查出,已复验)。
 *  两个后果,都不轻:
 *   ① **所有计数型消息系统性谎报**——「裸因果断言(**1 处**)」里的「1」不是断言条数,
 *      是「命中了几个不同模式」。十条同型断言只报 1 条。
 *   ② **更实际的:处置掉被点名的那一行就能过闸**,同一轮里其余同型违规**不出现在证据里**,
 *      于是它们既没被拦、也没被看见。这横切 12 条 PAT 驱动的规则。
 *  ⇒ 去掉 `break`,收全部命中行(仍按行去重:一行撞多个模式只列一次)。
 *  代价:消息可能变长 ⇒ 由各规则的 `.slice(0, N)` 控制展示条数,**但计数是真的**。 */
/** @param {string} [echoFrom] 回显源。给了就**拿它的同号行**当回显,判据仍跑在 `text` 上。
 *  用途:因果族先把引文抹成空格再判(免得跨引号边界咬合),但抹完的文本**不能拿去回显**
 *  —— 2026-08-27 proj-a 实况:拦截消息显示成「是因为 会让你在 和 之间反复权衡」,
 *  引文里的名词全没了,人看不出被拦的是哪句、更无从处置(D71)。
 *  成立前提:掩码**等长且保留换行**(见 `maskQuoted`),行号才对得上;
 *  对不上时按 `echo[i] != null` 退回剥过的行,**不抛错**——回显退化远好过整闸崩。 */
export function matchAny(text, pats, echoFrom) {
  const hits = new Set();   // 去重:一行可能同时撞上多个模式,不重复列
  const lines = text.split("\n");
  const echo = typeof echoFrom === "string" ? echoFrom.split("\n") : null;
  for (const re of pats) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const shown = echo && echo[i] != null ? echo[i] : lines[i];
      hits.add(shown.trim().slice(0, 120));
    }
  }
  return [...hits];
}

// ctx 可覆盖三样:text(官方 last_assistant_message)、turn(本轮条目)、bgTasks(官方 background_tasks[])。
// 批 257 加第四样 codexEnv(A 项 codex 账的注入面:jobState / resultBody / now;live 缺省读盘,其余缺省不注入)。
// 离线模式(--audit/--dry-run)不传 ctx,全部从 transcript 取。
// `export` 是为**并行 diff 迁移**加的(2026-08-19):新引擎与本实现对同一批夹具
// 跑出的 findings 必须逐条一致,才算某条规则搬完。见 scripts/lib/gate-registry.mjs。
// 迁移期间本函数是**唯一权威**;搬完一条才把该条从这里摘掉。
/** `git ls-files` 的进程内缓存。undefined=还没取过;Set=取到;null=取不到(fail-closed)。 */
/** 本轮之前的若干轮 entries —— 喂给 `buildCtx` 的 `priorEntries`,供 `ctx.window()` 用。
 *
 *  为什么需要:有些判据管的是**一个批**而非一个回合。实撞的是纪律 32(I 项):
 *  「造之前查过没有」里,联网那层与扫本地那层**天然不同轮**——决定要不要引依赖时联网,
 *  扫在册件在后面一轮。要求同轮出现会逼人为了过闸再搜一次,连撞 5 轮。
 *
 *  为什么按**条数**封顶而不按时间:entries 的时间戳不保证存在,而条数一定有;
 *  且成本要可预期——窗口是每轮都要重建 ctx 的,不能让它随会话长度线性涨。
 *  取不到 ⇒ 返回 undefined(**不是 []**):「没有窗口」与「窗口是空的」是两件事,
 *  规则侧 `window()` 拿到 null 会 fail-closed,与接线前的行为一致。 */
const PRIOR_WINDOW_ENTRIES = 400;
function _priorWindow(turn) {
  try {
    if (!Array.isArray(_allEntriesCache) || !_allEntriesCache.length) return undefined;
    const cut = _allEntriesCache.length - (Array.isArray(turn) ? turn.length : 0);
    if (cut <= 0) return undefined;
    return _allEntriesCache.slice(Math.max(0, cut - PRIOR_WINDOW_ENTRIES), cut);
  } catch { return undefined; }
}
/** 整份 transcript 的缓存,由 `run()` 填。只为 `_priorWindow` 服务。 */
let _allEntriesCache;
/** 本次 `run()` 的会话号,只给 emit 落报警台账用(批 265:观察档数据事后要能回到原会话)。 */
let _ledgerSid;

/** P 的跨批持久账(2026-08-22 亲签)。读不到/坏 ⇒ null(首跑语义,宽限计 0)。
 *  为什么不怕坏账读成 null:方向是**少收一轮税**,而下一次真提交会重新开始累计;
 *  比反向(坏账读成天文数字 ⇒ 永久拦死)便宜得多。 */
function readPLedger() {
  // 自测隔离(2026-08-26 实撞):readBatchGoal 有这道阀而本函数没有——真实 P 账爬满 5 笔当天,
  // 夹具世界被磁盘真账污染,G 的用例凭空多出 P 命中(「测出来的东西取决于磁盘上碰巧有什么」,
  // K 的同型教训第二次应验)。null=接了、账不存在=宽限语义,与注入约定一致。
  if (process.env.STOP_CLOSURE_SELFTEST === "1") return null;
  try {
    const j = JSON.parse(fs.readFileSync(".claude/.p-ledger.json", "utf8"));
    return { carriers: Number.isFinite(+j.carriers) ? Math.max(0, Math.floor(+j.carriers)) : 0,
      shas: Array.isArray(j.shas) ? j.shas : [] };
  } catch { return null; }
}

/** P 的收尾结算(唯一实现;live 路径落盘、自测直接喂):计账 + 基点推进。纯函数,不读写盘。
 *  返回 `{ ledger, advance, head }`:
 *    · ledger = 要写的账 `{carriers, shas}`,null = 不动账。三通道齐(动作面)⇒ 清零;否则累加 `tally(eCtx).n`
 *      (红队 a2a9f58b BP-1:与 detect 同一份取值——git 事实在 ⇒ 范围内带承重改动、未记过 sha 的提交数;
 *       原来这里是命令语法计数,`git add -A` / merge 合回计 0 ⇒ 宽限账永不涨)。`shas` 累积已计提交(封顶 400),去重用;
 *    · advance = 推进基点:**只在 git 事实非 null 且 P 无命中**时(BP-2:事实取不到时回退面沉默 ≠ 结清,推进会让之前欠的蒸发);
 *    · head = 推进到哪:git 事实读到的那个 HEAD(BP-6:不重新 rev-parse,读事实与写基点之间落的提交留给下一次审)。 */
export function settleP(P, eCtx, eFindings) {
  const prior = (eCtx.pLedger && eCtx.pLedger.carriers) || 0;
  const priorShas = (eCtx.pLedger && Array.isArray(eCtx.pLedger.shas)) ? eCtx.pLedger.shas : [];
  const t = P.tally(eCtx);
  // ⚠️ **补账面必须与规则面同一张脸**(2026-08-22 用户追问「搜索结果打算干啥」逼出的反思
  //   当场逮到:规则认「窗口∪本轮」,补账原来只认「单轮三通道齐」⇒ 通道分散跑时
  //   账永不清零,爬满后窗口一滑走就全额讨税——教科书 reset 病长在自己刚写的代码里)。
  //   天花板写明:窗口里的旧一轮通道在滑出前可能多次抵账(有界宽松,上限=400 条窗口),方向是少收税。
  // codex 185「你没问到」3 / 派出方 a27628dd 口径⑤:计账与判据同一取值池、同一谓词(`channelsMet`;BP-8 的点名抵账已撤)。
  const allThree = P.channelsMet(eCtx).every(Boolean);
  const next = allThree ? 0 : prior + t.n;
  const shas = [...new Set([...priorShas, ...t.shas])].slice(-400);
  const ledger = (next !== prior || allThree || shas.length !== priorShas.length) ? { carriers: next, shas } : null;
  const f = P.facts(eCtx);
  const advance = !!f && !eFindings.some((x) => x && x.id === "P");
  return { ledger, advance, head: f && typeof f.head === "string" ? f.head : null };
}

let _trackedCache;
/** D56:PreToolUse 实测的「写之前是否已存在」记录。
 *  由 `hook-guard` 在写发生**之前**用 `existsSync` 量出来并追加,收尾侧只读不写。
 *  与 `tracked` 同为**注入面**——规则不自读磁盘(那条纪律的代价已实测过)。
 *  读失败/文件不在 ⇒ 返回 null ⇒ `isNew` 退回旧判据(误报侧,不开漏放口)。 */
let _preExistedCache;
/** @param {string} [sid] 本会话 id。**按会话过滤、任一 false 记录即判新建**(D104(b);首版「只认首笔」对
 *  rm+重建哑,已改。codex 复核 2026-09-06「你没问到」①):
 *  原实现把整份台账里凡 `existed:true` 的路径都收——「首次创建前 false、第二次追加前 true」两笔普通写入
 *  就让本批新建的载体判成既有(漏放);台账又从不修剪,几天前的 true 对今天的 rm+重建同样生效。
 *  现:有 sid 且台账里有本会话记录 ⇒ 只看本会话,按路径取**第一笔**的 existed;
 *  无 sid(离线回放/夹具)或本会话零记录 ⇒ 退回旧口径(误报侧不变,漏放侧不再扩大到本会话之外)。 */
function preExistedSet(sid) {
  if (_preExistedCache !== undefined) return _preExistedCache;
  try {
    // 路径与 hook-guard 写侧同一环境变量改道(只供自测,不污染真台账)
    const txt = fs.readFileSync(process.env.GATE_CARRIER_PRECHECK_FILE || ".claude/.carrier-precheck.jsonl", "utf8");
    const rows = [];
    for (const line of txt.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.path) rows.push(r); } catch { /* 跳过坏行 */ }
    }
    const mine = sid ? rows.filter((r) => r.sid === sid) : [];
    const use = mine.length ? mine : rows;
    // D104(b)(2026-09-06,窄例外④自签,收紧方向):一条路径**只要在所考虑的记录里出现过一次 false**,
    //   就当本会话新建——覆盖「首次创建前 false」与「rm 后重建前 false」两种形态;
    //   原「只看首笔」对后者哑(首笔 true 盖住后来的 false)。方向是更多路径判新建(误报侧)。
    const seenFalse = new Set(), anyTrue = new Map();   // path → raw(取最早一笔 true 的 raw)
    for (const r of use) {
      const p = String(r.path);
      if (!r.existed) { seenFalse.add(p); continue; }
      if (!anyTrue.has(p)) anyTrue.set(p, r.raw);
    }
    const set = new Set();
    for (const [p, raw] of anyTrue) {
      if (seenFalse.has(p)) continue;
      set.add(p);
      // D100:Bash 面记录带 `raw`(命令里的 `~/…` 原形);收尾侧目标解出来就是原形,只认全路径比对。
      if (raw) set.add(String(raw));
    }
    _preExistedCache = set;
  } catch { _preExistedCache = null; }
  return _preExistedCache;
}

/** `git log -1 --diff-filter=A` 的进程内缓存(同 _trackedCache 的理由)。 */
let _justAddedCache;

/** 批 255:目标文件所属 checkout 根。从目标所在目录逐级向上,找第一个含 `.git`(文件或目录)的目录。
 *  只认绝对路径(`X:/…` 或 `/…`);相对形、`~/…` ⇒ null ⇒ `isNew` 走原判据(以 hook cwd 的索引为准)。
 *  不 import path(本文件刻意保持 import 面不变),纯字符串逐级上溯。 */
function checkoutOfFs(p, exists = fs.existsSync) {
  const s = String(p || "").replace(/\\/g, "/");
  if (!/^(?:[A-Za-z]:\/|\/)/.test(s)) return null;
  let dir = s.replace(/\/+$/, "");
  dir = dir.slice(0, dir.lastIndexOf("/"));                    // 目标所在目录("E:/x" ⇒ "E:";"/x" ⇒ "")
  for (;;) {
    let hit = false;
    try { hit = !!exists(`${dir}/.git`); } catch { /* 探不了当没有 */ }
    if (hit) return dir === "" ? "/" : dir;
    const i = dir.lastIndexOf("/");
    if (i < 0) return null;                                     // 到盘根/根了
    dir = dir.slice(0, i);
  }
}

/** 批 255:某 checkout 的追踪集(仓根相对、正斜杠),按根缓存;取不到 ⇒ null(isNew 当新建)。 */
const _trackedInCache = new Map();
function trackedInFs(root) {
  const key = String(root);
  if (_trackedInCache.has(key)) return _trackedInCache.get(key);
  let set;
  try {
    set = new Set(execFileSync("git", ["-C", key, "-c", "core.quotepath=false", "ls-files", "-z", "--full-name"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      .split("\0").filter(Boolean));
  } catch { set = null; }
  _trackedInCache.set(key, set);
  return set;
}

/** 批 255:`isNew` 的**全部生产证据**,主 Stop 通道与 SubagentStop 通道共用这一份(抽出来,不复制)。
 *  修的是第二件事:SubagentStop 分支原在 `_trackedCache` 初始化之前构造 ctx ⇒ `tracked` 为 undefined
 *  ⇒ `isNew` 对一切路径判真(红队 BP-3、codex「你没问到」1)。
 *  第一件(目标 checkout 与 hook checkout 不同源)的判据在 gate-ctx.mjs `isNewInCheckout`,本函数只供证据。
 *  残余(照实列,本批不改):
 *   ①`justAdded` 名不副实——实为 hook checkout **可达历史最近一次**含新增的提交,不是「本轮刚加」
 *     (红队 254 附节二①),已登记;按目标 checkout 取时它只在同根参与。
 *   ②相对路径、`~/…` 目标 `checkoutOfFs` 返回 null ⇒ 仍用 hook cwd 的索引(原判据)。
 *   ③目标 checkout 的 `.git` 指向坏 gitdir / git 不可用 ⇒ `trackedInFs` 为 null ⇒ 判新建(误拦侧)。
 *   ④`relOf` 的字符串规则与 gate-carriers 的 `normPath`/`NON_CARRIER_AREA` 未动(红队 BP-5/BP-6,另批)。
 *   ⑤SubagentStop 仍是提示面不阻断;本批只补证据,不改其升档判据。
 *  @param {string} [sid] 本会话 id(`preExistedSet` 按会话过滤) */
export function isNewEvidence(sid) {
  let tracked = _trackedCache;
  if (tracked === undefined) try {
    // 批 261(D138④):-c core.quotepath=false -z,中文 / 空格 / 特殊字符文件名不被转义成 "\346…" 引号串(否则被判新建)
    tracked = new Set(execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], { encoding: "utf8", cwd: process.cwd(), windowsHide: true })
      .split("\0").filter(Boolean));
  } catch { tracked = null; }
  _trackedCache = tracked;
  let justAdded = _justAddedCache;
  if (justAdded === undefined) try {
    // 批 261(红队 a415bf26 BP-4):与 tracked 同口径不转义(-c core.quotepath=false -z)——两边口径一分裂,
    //   中文名新载体 justAdded 认不出、tracked 却认得 ⇒ isNew 判既有,G / I 静默
    justAdded = new Set(execFileSync("git", ["-c", "core.quotepath=false", "log", "-1", "--diff-filter=A", "--name-only", "-z", "--format="],
      { encoding: "utf8", cwd: process.cwd(), windowsHide: true }).split("\0").map((s2) => s2.replace(/^\n+/, "")).filter(Boolean));
  } catch { justAdded = null; }
  _justAddedCache = justAdded;
  const hookCheckout = checkoutOfFs(`${process.cwd()}/.probe`);
  return {
    tracked: _trackedCache instanceof Set ? _trackedCache : undefined,
    justAdded: _justAddedCache instanceof Set ? _justAddedCache : undefined,
    preExisted: preExistedSet(sid) || undefined,
    checkoutOf: checkoutOfFs,
    trackedIn: trackedInFs,
    ...(hookCheckout ? { hookCheckout } : {}),
  };
}

/** P 项的承重面。模块级导出,因为**自测要拿它跑漂移检查**(见 selfTest 的「承重面漂移」一节)。
 *
 *  ⚠️ 这是一份**枚举白名单**,而枚举白名单的病是已知的:每长一个新零件就漏一次。
 *  外部先例(2026-08-20 WebSearch,GitHub CODEOWNERS)描述的是同一个病:
 *    「写死的文件路径会在**被重命名或移动后失去归属**(于是不再需要批准)」
 *    「最难的不是设置,是**维护**……那需要一套流程,而不只是意愿」。
 *  他们的修法不是维护一份更好的清单,而是**加一条漂移测试**:
 *    「当一个文件被移动时,测试可以确保新路径出现在 CODEOWNERS 里」。
 *  本仓照搬这个形状:下面的 `gateMachineryFiles()` **从 `.claude/settings.json` 的 hooks 节
 *  反推出闸机件清单**(而不是再手抄一份),自测断言每一个都被本正则覆盖。
 *  ⇒ 新增一个 hook 却忘了把它纳入承重面,自测当场转红,不再靠人想起来。
 */
// ⚠️ 2026-08-20 第三次加宽。这次补的七项是 grill:edge-cases 的 P-5 逐条实测出来的,
//   我复核后确认**七项全部存在且全部在管辖外**(它列的第八项 perm-match.mjs 路径记错了,
//   实为 `scripts/lib/perm-match.mjs`,早已被 `lib/` 分支覆盖):
//     `report-gate.mjs`(汇报法的闸) / `.claude/settings.local.json`(权限授权面) /
//     `.claude/settings.tplan-exec.json`(无头档案,019/026 记着处理器挂在这儿) /
//     `CLAUDE.md` / `docs/prod-facts.md` / `docs/repo-brief.md` / `docs/carrier-facts.md`
//     (后三份是宪法《法律索引》点名的事实文档,行内义务句以索引表为规范来源)。
//   `settings\.json` 收窄写法改成 `settings[\w.-]*\.json`,把 local/plan/tplan-exec 一并纳入。
// ⚠️ 2026-08-20:两张各自演化的枚举**已合并**成一份分类表 `lib/gate-carriers.mjs`。
//   合并前 `git log -G` 实测:本条(P 用)在 4 次提交里被改过,而 `CARRIER_RE`(I 用)**1 次**
//   ——于是我把一条新规则写进 memory 时 I 一声不吭,而同日本条已被加宽三次。
//   codex 裁「合并为一份分类表,但**不合并成一个正则**」:每类路径独立标
//   `creation`(新建触发 I)与 `loadBearing`(改动并提交触发 P)两个属性,因为两者
//   问的不是同一个问题——「改一个已有法典条文」是承重不是造物,「新建一份 memory」反之。
export { CARRIER_SURFACE } from "./lib/gate-carriers.mjs";
import { CARRIER_SURFACE, normPath as normPathC, isCarrierPath as isCarrierPathC, selfTest as carriersSelfTest } from "./lib/gate-carriers.mjs";
// ⚠️ **反向导入引擎**(2026-08-20)。看起来是循环依赖(`gate-rules` 也从本文件导入
//   `PAT`/`matchAny`/`bashWrites`…),但**实测无害**:规则只在 `detect` **体内**
//   (调用时)碰那些符号,不在模块求值时碰 ⇒ ESM 的循环导入对这种形态成立。
//   我此前断言「循环依赖是这道缝做不成的唯一技术障碍」——**那是没试就说的**,
//   探针(scratchpad/cycle-probe)三条全过:两边 import 成功、依赖 PAT 的规则在环里正常命中、
//   旧实现同进程也正常。**障碍不存在,缝一直做得成。**
import { RULES, ranClear as ranClearRule, maskQuoted, BG_RUNNING_STATUS } from "./lib/gate-rules.mjs";
// `validateRules` 是 2026-08-20 才接进**生产路径**的 —— 此前它只在 `gate:accept` 里跑,
// 于是 INV-1..4 对真跑的闸完全不生效(grill:recon 查出,`grep -c` = 0)。
import { runRules, validateRules } from "./lib/gate-registry.mjs";
import { buildCtx, isBlockedStop, blockedStopIds, isStopFeedbackLine } from "./lib/gate-ctx.mjs";
import { segments, stripQuoted, quoteScan } from "./lib/gate-cmd.mjs";   // 批 257:A 项 codex 账的命令切段(引号外才切,唯一实现)
// DP 的部署欠账事实源(2026-09-12 批 202)。**动态导入、缺件静默退场**:本文件随公开树 custodiet 分发,
//   那边未必带 debt-facts.mjs;缺件时注入 undefined,DP 退回命令解析判法(与判活探针三件同一缺件纪律)。
let readDebtFacts = () => undefined;
let debtFactsSelfTest = null;
try { ({ readDebtFacts, selfTest: debtFactsSelfTest } = await import("./lib/debt-facts.mjs")); }
catch (e) {
  // 只有**本文件缺席**才静默;文件在而求值失败(含它自己的依赖缺失,错误码同样是 ERR_MODULE_NOT_FOUND)是坏件,必须出声
  //   (红队 202 第五轮附节 4 + codex 复核 r2:只看错误码会把「依赖缺失」也吞掉)
  if (fs.existsSync(new URL("./lib/debt-facts.mjs", import.meta.url))) console.error(`[收尾闸] lib/debt-facts.mjs 加载失败,DP 只剩命令解析判法:${e && e.message}`);
}
// 批 257 r2:自测核「hook 端作业目录与 codex-run 的 JOB_ROOT 同算法」用。只在 --self-test 形态加载、缺件(公开树)不计。
const _codexRunForSelfTest = process.argv.includes("--self-test")
  ? await import("./codex-run.mjs").catch(() => null) : null;
// D1/批 102:两份台账的追加改走行级 hash 链(完整性告警;担保边界见 ledger-chain 头注)
import { ledgerAppend, verifyFile as ledgerVerify } from "./lib/ledger-chain.mjs";

/** 反推「闸机件」清单:凡**改了它就可能改变闸的行为**的文件。
 *
 *  ⚠️ 采样面 2026-08-20 加宽,而这是 grill:edge-cases 的 X-1 逼出来的,**它说得对**:
 *  原实现只扫 `.claude/settings.json` 里的 `scripts/*.mjs`,实跑只列出 5 个文件、
 *  **全部以 `hook-` 开头**——而 `CARRIER_SURFACE` 的第一个分支就是 `scripts/hook-`。
 *  ⇒ 这条漂移测试**在结构上恒绿**,发现不了任何真实缺口。
 *  我的「鉴别力探针」用的是一份**假 settings 文件**,只证明了比对逻辑能工作,
 *  没证明采样面覆盖任何真东西——上一个提交却把它宣传成「照搬 CODEOWNERS 先例」,
 *  而那条先例是「文件被移动时测试能发现新路径没登记」,原实现做不到这件事。
 *
 *  现在的采样面(每一项都答「改了它闸会不会变」):
 *    ① 全部 `.claude/settings*.json` —— 它们**自己**决定哪些 hook 跑;
 *    ② 从这些文件里抽出的本仓 `scripts/*.mjs`;
 *    ③ `package.json` 里 `gate:*` 命令引用的脚本;
 *    ④ 宪法《法律索引》点名的事实文档(改了它规则就变)。
 *  取不到文件 ⇒ 返回 null(自测据此跳过并明说,不谎报通过)。
 *
 *  CEILING: 仍是**枚举**,只是枚举的是「载体的类别」而不是「文件名」,
 *    所以新增一个 settings 文件或一条 gate: 命令会被自动纳入,新增一类载体不会。
 */
export function gateMachineryFiles(settingsDir = ".claude") {
  const found = new Set();
  let any = false;
  try {
    for (const f of fs.readdirSync(settingsDir)) {
      if (!/^settings.*\.json$/.test(f)) continue;
      any = true;
      found.add(`${settingsDir}/${f}`);                       // ① 文件自己
      // ② ⚠️ **只扫 `hooks` 节,不扫全文**。第一版扫全文,当场把
      //   `scripts/.probe-p.mjs`、`scripts/lib/.probe-*.mjs` 这些**已删除的临时探针文件**
      //   列成了「闸机件」——因为 `settings.local.json` 是一份**权限授予台账**,
      //   里面记着我跑过的每条命令。台账 ≠ 机件声明:拿台账当清单,清单会被历史噪声灌满,
      //   而且列进来的文件根本不存在,漂移检查会为幽灵报红。
      //   (这与本仓登记的「拿 HANDOFF 当批次状态」是同一族:用错权威载体。)
      let hooksBlob = "";
      try { hooksBlob = JSON.stringify(JSON.parse(fs.readFileSync(`${settingsDir}/${f}`, "utf8")).hooks || {}); }
      catch { hooksBlob = ""; }
      for (const m of hooksBlob.matchAll(/(scripts\/[\w./-]+\.mjs)/g)) found.add(m[1]);
    }
  } catch { /* 目录读不到 ⇒ 下面按 null 处理 */ }
  try {                                                        // ③
    const pkg = fs.readFileSync("package.json", "utf8");
    const scripts = JSON.parse(pkg).scripts || {};
    for (const [k, v] of Object.entries(scripts)) {
      // ⚠️ 2026-08-27:也认 `_gate:machinery` 这个**专用声明键**。
      //   此前清单是寄生在 `gate:lint` 的 glob 上的副产品——把那条 glob 从 5 个点名文件
      //   改成 `scripts/` 目录(D59①),清单当场少一项,而自测印的是
      //   「承重面漂移 26/26」:**分母缩了还全绿**,正是这条测试当初立来防的那种漂移,
      //   这次它自己被同一种手法绕过去了。根因=清单来源不该是一条管别的事的脚本。
      //   目录形态(`scripts/`)刻意**不展开**:52 个 .mjs 里 24 个本就不是承重件
      //   (`cdp.mjs`/`prod-lib.mjs` 是业务工装),展开只会制造 24 条假红。
      if (!/^_?gate:/.test(k)) continue;
      any = true;
      for (const m of String(v).matchAll(/(scripts\/[\w./-]+\.mjs)/g)) found.add(m[1]);
    }
  } catch { /* 没有 package.json 也不致命 */ }
  // ④ 宪法法律索引点名的事实文档:它们不是法典,但行内义务句以索引表为规范来源
  for (const d of ["docs/prod-facts.md", "docs/repo-brief.md", "docs/carrier-facts.md", "CLAUDE.md"]) {
    try { fs.accessSync(d); found.add(d); any = true; } catch { /* 不存在就不列 */ }
  }
  return any ? [...found].sort() : null;
}

export function run(transcriptPath, ctx = {}) {
  _ledgerSid = typeof ctx.sessionId === "string" && ctx.sessionId ? ctx.sessionId : undefined;
  // D40:生产形态一律以**显式语境**声明(`ctx.live === true`),不再用 `process.argv.length<=2`
  // 推断——argv 判的是「进程怎么起的」不是「这次调用什么语境」:settings.json 的 hook command
  // 一旦加任何 flag,心跳与分母会**同时无声停摆**;被测试 import 直调时又会把测试写入混进真账。
  // 只有文件末尾的生产 hook 路径传 live:true;--audit/--dry-run/自测/import 缺省 false。
  const live = ctx.live === true;
  // ⚠️ `ctx.entries` 是 2026-08-20 加的,**只为验收台**:原来只能给路径,于是并行 diff
  //   每比一片就得写一个临时文件再重新解析一遍 —— grill:testing 量出全语料 6604 片
  //   要 258 秒,其中 **256 秒是这个来回**,规则求值本身只占 2 秒。
  //   为绕开那 258 秒,验收台上了采样(65 片 = 1.0%),而采样按 mtime 排序恰好
  //   **只取到写规则的那个会话本身**——「拿真实流量」这一步被排序偷偷退回成了
  //   testing on training data,并因此漏掉 L 的 20 条真分歧。
  //   ⇒ 性能不是无关的:**它决定了判据能不能在全语料上跑**,进而决定判据是真是假。
  const entries = ctx.entries ? ctx.entries : (transcriptPath ? readTranscript(transcriptPath) : []);
  const turn = ctx.turn !== undefined ? ctx.turn : lastTurn(entries);
  _allEntriesCache = entries;      // 供 `_priorWindow()` 取跨轮窗口(见其头注)
  const text = ctx.text !== undefined ? ctx.text : assistantText(turn);
  const tools = toolNames(turn);

  // A 项数据源:原生后台任务 = 官方 background_tasks[] 优先,拿不到才退回正则配对(本轮窗口);
  //   codex 委派 = `codexLedger`,在**本会话转录全量**上算(跨用户轮与 Stop 反馈轮),
  //   且**不论 background_tasks 是否为数组(含空数组)都照跑**——空数组只说明此刻没有原生在飞任务,
  //   不说明过去的 codex 结果读过了(D141 复核「二」)。两路结果合并。
  const a = Array.isArray(ctx.bgTasks)
    ? checkAFromPayload(ctx.bgTasks, rawText(turn), text)
    : checkA(turn);
  const codexEnv = ctx.codexEnv !== undefined ? ctx.codexEnv : (live ? liveCodexEnv() : {});
  let cx;
  try {
    const cxEntries = entries.length ? entries : turn;
    // 本轮起点(条目下标):turn 是 entries 的后缀(两条生产路径都由 lastTurn 切出),只供「未知」提示限本轮
    // bgTasks:后台发起的无主占位若原生载荷说该后台 Bash 仍在飞,按「运行中」等待(BP-4)
    cx = codexLedger(cxEntries, { ...(Array.isArray(ctx.bgTasks) ? { bgTasks: ctx.bgTasks } : {}), ...(codexEnv || {}),
      turnStart: Math.max(0, cxEntries.length - turn.length) });
  }
  catch (e) { cx = { open: [], unknown: [`codex 账自身出错(${safeErrMsg(e).slice(0, 60)})`] }; }

  const findings = [];
  if (a.open.length || cx.open.length) {
    findings.push({
      id: "A", block: true,
      msg: [
        a.open.length ? `后台/委派任务未闭环:${a.open.join(", ")} —— 发起了但没有取回动作(poll 或读结果)。` : "",
        cx.open.length ? `codex 委派未闭环:${cx.open.join(";")}` : "",
        cx.unknown.length ? `(另有状态未知,提示不阻断:${cx.unknown.join(";")})` : "",
      ].filter(Boolean).join("\n    "),
    });
  } else if (cx.unknown.length) {
    findings.push({
      id: "A", block: false,
      // 出路按作业给(红队附节二 3):有 J 的给 poll,无主有结果路径的给 Read,两者都没有的给「按任务名找 J」
      msg: `codex 委派提示(不阻断):${cx.unknown.join(";")} —— 判不了就照实写明未知。`,
    });
  }
  // ── [切换第二刀 2026-08-22 亲签] 此处原是 B/C/D/E0/E1/E2/F/G/H/I/P/Q 十二条内联实现,
  //   已由引擎(gate-rules.mjs)独占,尸体删除;史料 = git 21b0152 之前。


  // ── R(**阻断**):完成时陈述无对应动作 ──────────────────────────────────────
  //
  // 2026-08-20 用户授权(原话:「新增阻断项一律授权自动化。行了吧?」)。
  //
  // 立法动机 —— **同一天两次**「假陈述进耐久载体」:
  //   ① 我在 `gate-carriers.mjs` 的注释里把 memory 相对路径那条标成「**已修**」,
  //      而实测它没修(绝对路径才认)。代码注释会被后来的人当事实。
  //   ② 我在报告里写「工具面已扫(四层)…④ 联网/GitHub——搜到 `nlpm:vague-scanner`」,
  //      而第四层**一次都没跑**,那个发现来自本地 `ls`。用户当场逮到:
  //      「我连联网搜索命令都没看到」。
  //   两次都不是记错,是**在没做的情况下按流程该有的样子把格子填了**。
  //
  // 与 B 的分工:B 管**未来时**的承诺句(「我这就去改 X」),本项管**完成时**的陈述句
  //   (「已修 X」「已扫」「已跑 X」)。前者的失败是空头支票,后者的失败是**伪造记录**
  //   ——后者更坏,因为它进了耐久载体之后没人再查。
  //
  // 判据:出现完成时陈述 **且** 本轮动作面找不到对应动作 ⇒ 拦。
  //   证据一律落**动作面**(工具入参),不看文本——否则「我说我扫过了」自己就能豁免自己。
  // 天花板:只认几种固定说法,判不出「已修」的那个 X 是不是真被修对了;
  //   也判不出跨轮完成的事(上一轮修的、这一轮才报)。后者是已知误报形态。
  {
    const claims = [];
    // ⚠️ **剥引文**(2026-08-27,D74,本轮自撞):本项原来在原文上匹配 ⇒
    //   **引用被拦的那句话来更正它,更正本身再被拦**——我照出路把话改准,
    //   而改准的写法必然要复述原词(「说了『工具面已扫』,那是转述台账不是本轮动作」),
    //   于是连撞两轮,第二轮的触发源就是第一轮的处置。
    //   回声族第四次(前三:S 的 handoff、E2 的 declHasOracle、E0/E2 的 PAT.causal),
    //   口径统一到 `maskQuoted`:**引文=提及不是使用**。
    //   方向:本项证据一律落动作面,剥引文只减少「文本命中」,不放松任何真拦截。
    const rTxt = maskQuoted(text);
    // 「已扫/已查工具面」⇒ 须有读或搜的动作
    if (/工具面已扫|已扫(三层|四层|一遍)|扫过(工具面|三层|四层)/.test(rTxt)) {
      const acted = tools.some((n) => /^(Read|Grep|Glob|WebSearch|WebFetch)$/.test(n)) ||
        /(^|[\s;&|])(gh|grep|ls|rg)\s/.test(toolRawText(turn));
      if (!acted) claims.push("说了「工具面已扫」,但本轮没有任何读取或搜索动作");
    }
    // 「已跑 X」⇒ 须有 Bash/PowerShell 动作
    // ⚠️ **必须指名对象**(上线当轮自己误报后收窄):原式只认「已跑」二字,
    //   于是七问自审里的「⑤ **已跑** ⑥ 已查」被当成完成时陈述——那是清单答案不是断言。
    //   现要求其后紧跟一个像名字的 token(≥3 字符的路径/命令/反引号内容)。
    //   天花板:**无对象的完成陈述**(光说「跑过了」)因此漏掉——那种本来也无从核。
    if (/(已跑|跑完了|实测(过)?)\s*[`「"']?[\w./:-]{3,}/.test(rTxt)) {
      if (!tools.some((n) => /^(Bash|PowerShell)$/.test(n))) {
        claims.push("说了「已跑/实测 X」,但本轮没有任何命令执行动作");
      }
    }
    // 「已修 X / 已改 X」⇒ 须有写动作。同样要求指名对象。
    if (/(已修(掉|好)?|已改(掉|好)?|修好了|改好了)\s*[`「"']?[\w./:-]{3,}/.test(rTxt)) {
      const wroteSomething = tools.some((n) => /^(Edit|Write|NotebookEdit)$/.test(n)) ||
        /writeFileSync|sed\s+-i|>>?\s*[\w./-]+\./.test(toolRawText(turn));
      if (!wroteSomething) claims.push("说了「已修/已改」,但本轮没有任何写入动作");
    }
    if (claims.length) {
      findings.push({ id: "R", block: BLOCK_ON_R, msg:
        `**完成时陈述无对应动作**(说「做过了」而动作面上没有):\n    · ${claims.join("\n    · ")}\n` +
        `      与 B 的分工:B 管**未来时**承诺(「我这就去改 X」),本项管**完成时**陈述(「已修 X」)。\n` +
        `      后者更坏——它进了提交信息与代码注释之后,**后来的人会当事实**,没人再查。\n` +
        `      立法动机是当日两次实撞:把没修的标「已修」、把本地 ls 的发现写成「联网搜到的」。\n` +
        `      出路:要么真做,要么把话改准(「上一轮修的」「这条没修,登记不修」)。\n` +
        `      ⚠️ 已知误报形态:**跨轮完成**——上一轮做的、这一轮才报。那种情况请写明是哪一轮。` });
    }
  }

  // ── [切换第二刀 2026-08-22 亲签] 此处原是 L/N/M/K/K0/J 六条内联实现,已删,同上。

  // ── 缝:让引擎成为已迁规则的**权威** ────────────────────────────────────────
  //
  // 2026-08-20。此前的状态是:引擎里 15 条声明式规则**跑但不算数**,
  // 真正在拦人的仍是这个文件里的 20 个内联块——用户原话:
  // 「你刚才跟我说在做引擎,那为什么现在还在 if?」**他是对的**。
  //
  // 我此前说「循环依赖是这道缝做不成的唯一技术障碍」——**那是没试就断言的**。
  // 实测(cycle-probe):两边互相 import 全部成功,依赖 `PAT` 的规则在环里正常命中,
  // 旧实现同进程也正常。原因:规则只在 `detect` **体内**(调用时)碰 PAT,
  // 不在模块求值时碰 ⇒ ESM 的循环导入对这种形态无害。
  //
  // ⚠️【2026-08-20 的「内联块不删」裁定已被 2026-08-22 用户亲签的切换**取代**】:
  //   当时不删的三个理由(一行回退/对照组/崩溃兜底)分别由
  //   git revert 回退线 / 验收台史料化 / ENGINE 阻断(fail-closed,不再回退)接任。
  //
  // ── **tracked/justAdded 生产者**(2026-08-22 第二刀时从被删的 I 内联块里救出——
  //   删块当轮自测立刻逮到 I 全误报:引擎经缝拿的就是这两个缓存,删了生产者=断粮)──
  //   批 255:生产者抽成 `isNewEvidence()`(与 SubagentStop 通道共用),此处只调一次、结果交给下面的缝。
  // 批 266(codex 266-r2 §6):回放器注入同一份 newEvidence,两版不各读一遍预检台账 / git 索引
  const newEv = ctx.newEvidence !== undefined ? ctx.newEvidence : isNewEvidence(ctx.sessionId);
  // 史注(削删前原文):形态选替换不选删除…(2026-08-20)
  //   我原本把它们当「僵尸代码,待清扫」——**那个理解是错的**。它们是**回退路径**:
  //     · `STOP_CLOSURE_ENGINE=0` 时用它们(我一直在宣传的「一行可退」);
  //     · `ctx.engine === false` 时用它们(验收台的**对照组**,我刚修回来的那个);
  //     · **引擎抛错的 catch 分支**也落回它们。
  //   ⇒ 删了它们,一行回退失效、对照组消失、且那 15 条**在引擎异常时静默消失**。
  //   另有一处硬依赖:I 块里的 `_trackedCache = tracked` 被本缝(下面)交给 `buildCtx`;
  //   整块删掉会让引擎收到 `undefined` ⇒ `isNew` 对全部路径判真(当日已实撞过一次)。
  //   codex 原话:「未先确定新的 fail-closed 策略前,应倾向不删。」
  //   ⇒ **「文件变短」不是目标,「引擎说了算且退得回去」才是**,而后者已经达成。
  //   要删,前置条件是先给引擎一套独立的 fail-closed 兜底,那是另一批的事。
  //
  //   顺带记一条方法论:我为这件事写了个静态判据(扫块内声明、查块外引用),
  //   它跑出来的结果**明显弱于 codex**——块边界判错、把单字母循环变量报成块外引用,
  //   而且**完全看不到「这个块的副作用被别处依赖」**。按名字匹配的检查在结构上找不到语义依赖。
  //
  // ⚠️ 这是**逐条切换**(strangler fig 的正规做法:rollback 与 cutover 都按 capability 逐个来),
  //   不是整体切换。整体切换的判据仍是 `--cutover-check` 的五条,当前 NO-GO(15/20)。
  // ⚠️ 天花板:引擎与旧实现在这 15 条上有 **234 条已指名分歧**(全语料 6789 片),
  //   每一条都登记在 `gate-migrate-check.mjs` 的 EXPECTED_DIVERGENCE 里、方向已核。
  //   切换意味着**那些分歧从此生效**——它们的方向全部指向「新实现更准」,这是切换的目的。
  // ⚠️ `ctx.engine === false` 让调用方**显式绕过引擎**,拿到接管前的旧行为。
  //   验收台必须用它:接管之后旧实现对那 15 条已经**委派给引擎**,
  //   并行 diff 就变成了「引擎跟自己比」——分歧会掉到 0,而那是**鉴别力消失**不是「修好了」。
  //   这是 harness-induced 假绿的一个新形态:**被测系统吞掉了对照组**。
  //   不用 env 而用参数,是因为 env 在模块求值时读一次、整进程生效,
  //   而验收台需要在**同一进程**里同时拿到两种行为。
  if (ENGINE_AUTHORITATIVE && ctx.engine !== false) {
    try {
      const engineIds = new Set(RULES.map((r) => r.id));
      // ⚠️ **必须把 `ctx.text` 一起交给引擎**(2026-08-20 grill:architecture A1,实测)。
      //   生产主路径传的是 `{ text: merged, turn, bgTasks }`,而 `merged` =
      //   轮内 assistant 文本 **∪** 官方 `last_assistant_message`(见文件末尾的组装处)。
      //   那个并集立于 2026-08-19,理由是官方明写 **transcript 在 Stop 时不保证含最后一条消息**。
      //   缝原来只喂 `turn`,`buildCtx` 从 entries 重建文本 ⇒ **官方字段那一半丢了**。
      //   实测:transcript 读不到时(`turn` 就是 `[]`,见末尾的组装),
      //     engine=on → 只剩 K;engine=off → E0!/E2!/K/Q!,**三条阻断项当场消失**。
      //   即:**transcript 落后的那一刻恰恰是官方字段存在的全部理由,而引擎在那一刻是瞎的**,
      //   且旧的产出已被 `kept` 丢掉 ⇒ 标准的「两边都不响」,而 emit 会打印
      //   「收尾闸:全跑,无命中。」——与真·全过逐字节相同。
      //   `gate-ctx.mjs` 早就备好了 `extra.lastAssistantMessage` 这个入口,缝没接。
      const eCtx = buildCtx(turn, {
        // tracked / justAdded(grill A3:少了它「取证时机前移」原样失效)/ preExisted(D56)/
        //   checkoutOf + trackedIn + hookCheckout(批 255:按目标 checkout 取追踪集)——全部来自 `isNewEvidence`
        ...newEv,
        lastAssistantMessage: typeof ctx.text === "string" ? ctx.text : undefined,
        bgTasks: ctx.bgTasks,
        // 批次状态**在这里读一次、注入进去**,不让规则自己读磁盘 ——
        //   规则自读的代价已实测过:同一条用例在「当前批 arm 过」与「没 arm」下结果不同,
        //   自测从 34/34 掉到 13/34,而代码一行没改。
        //   自测隔离(STOP_CLOSURE_SELFTEST)靠的也是这个:注入 undefined 即可,不必改判据。
        // 批 265:本仓**从来没立过批**(台账与状态文件都不在)⇒ K0 不判。「批」是可选做法;
        //   一个比赛用仓 2,837 回合的模拟回放里,抽样发现 K0 要求未采用批流程的仓立完成条件(用户:「那你要不改一下」)。
        //   只在实时路径注入;夹具与自测不注入(undefined)⇒ K0 判法照旧。
        //   codex 265-r1 A3:台账被 gitignore,新开的 worktree / 新 clone 里两份都缺 ⇒ 在用批的仓也会被当成「从没立过批」。
        //   ⇒ 本 checkout 没有时再看主 checkout(git common dir 的上一级)的台账。
        //   自测进程不注入(否则新装闸、还没立过批的仓,自测里 K0 全部静音而红;公开树 gate:accept 实撞)
        //   红队 a363e144 BP-1:按 ctx.live 门控(离线 --audit / --dry-run 读的是现在的盘面,套到历史轮上是错配)
        batchEverArmed: ctx.batchGoal !== undefined || !ctx.live || process.env.STOP_CLOSURE_SELFTEST === "1" ? undefined : batchEverArmedHere(),
        // 批 258:实时路径给批状态补 `turnBatchStart`(本轮开始时正开着的那一批的起点;W 按它切交付物)
        batchGoal: ctx.batchGoal !== undefined ? ctx.batchGoal : (() => {
          const g = readBatchGoal();
          if (!g || typeof g !== "object") return g;
          try {
            const ts = (Array.isArray(turn) ? turn : []).map((e) => Date.parse(String((e && e.timestamp) || ""))).filter(Number.isFinite);
            const rows = fs.readFileSync(".claude/.batch-goal.jsonl", "utf8").trim().split("\n");
            const tbs = ts.length ? turnBatchStartOf(rows, Math.min(...ts)) : null;
            return tbs ? { ...g, turnBatchStart: tbs } : g;
          } catch { return g; }
        })(),
        // P 的跨批持久计账(2026-08-22 亲签「改吧」):同 batchGoal 的注入纪律——
        //   hook 读一次、规则纯函数;账文件在 gitignore 面;夹具经 ctx.pLedger 精确控制。
        pLedger: ctx.pLedger !== undefined ? ctx.pLedger : readPLedger(),
        // DP 的部署欠账事实(2026-09-12 批 202):同一注入纪律——hook 读一次、规则纯函数。
        //   **只在实时路径读**:离线回放读到的是「现在」的 reflog,套到历史轮上是错配 ⇒ 保持 undefined,DP 退回解析判法。
        debtFacts: ctx.debtFacts !== undefined ? ctx.debtFacts : (ctx.live ? readDebtFacts(process.cwd()) : undefined),
        // P 的 diff 分档事实(批 257 条件 3):惰性,只在实时路径接——离线回放拿到的是「现在」的工作树,套到历史轮上是错配。
        diffTier: ctx.diffTier !== undefined ? ctx.diffTier
          : (ctx.live ? () => { const g = ctx.batchGoal !== undefined ? ctx.batchGoal : readBatchGoal(); return readDiffFacts(g && g.baseCommit); } : undefined),
        // P 的 HEAD 移动事实(红队 a27628dd):惰性,只在实时路径接(离线回放拿到的是「现在」的 HEAD,套到历史轮上是错配 ⇒
        //   undefined ⇒ P 回退命令语法判据)。基点 = 本会话上次 P 结清时的 HEAD,没有就取会话开始时刻的 HEAD(reflog)。
        // 批 266(codex 266-r2 §1):误拦猎手 `--base <ref>` 的 ref 解析(只在实时路径;缓存;取不到 ⇒ null)
        resolveRev: ctx.resolveRev !== undefined ? ctx.resolveRev : (ctx.live ? (() => {
          const memo = new Map();
          return (r) => {
            if (memo.has(r)) return memo.get(r);
            let v = null;
            try { v = String(_gitHere(["rev-parse", "--verify", "--quiet", `${r}^{commit}`]) || "").trim() || null; } catch { v = null; }
            memo.set(r, v); return v;
          };
        })() : undefined),
        headFacts: ctx.headFacts !== undefined ? ctx.headFacts
          : (ctx.live ? () => {
            const pp = RULES.find((r) => r.id === "P")?._p;
            // 退路批基点取 hook 已有的批状态(带 cleared;a07e98e9 BP-5):已结清 ⇒ 无退路,不拿已关批的基点
            const batchBase = () => batchBaseOfGoal(ctx.batchGoal !== undefined ? ctx.batchGoal : readBatchGoal());
            return readHeadFacts(pHeadBase(ctx.sessionId, _allEntriesCache, undefined, undefined, batchBase), undefined, pp ? pp.ENGINE_PATHSPECS : [], pp ? pp.ENGINE_REL : null);
          } : undefined),
        // ⚠️ **跨轮窗口必须真的传进来**(2026-08-20 实撞)。
        //   `ctx.window()` 从落地起就没被生产路径喂过 `priorEntries` ⇒ **恒为 null**,
        //   于是 I 项那条「取证窗口放宽到批窗口」的修法是**死代码**,我改完当轮它照样拦我。
        //   这是当日**第三次**「造了机制却不接线」:
        //     ① `segments()` 造出来零调用(codex 判出);
        //     ② `requires` 契约在生产路径不可达(grill P3);
        //     ③ 就是这一条。
        //   ⇒ 造完当场问一句「谁调用它」,比事后被三方审计逐条逮便宜得多。
        //   窗口取**上一个回合边界之前的若干轮**,按条数封顶控成本;
        //   取不到 ⇒ 不传(`window()` 仍返回 null,规则侧 fail-closed,与原行为一致)。
        priorEntries: ctx.priorEntries !== undefined ? ctx.priorEntries : _priorWindow(turn),
      });
      // ⚠️ **装载期不变量必须在真跑的闸里执行**(2026-08-20 grill:recon 查出,已验)。
      //   `grep -c validateRules scripts/hook-stop-closure.mjs` ⇒ **0**:
      //   INV-1(阻断项不得只挂 text 豁免)/ INV-2(law 锚点)/ INV-3(正反例)/ INV-4(≥2 变异)
      //   四条**只在 `gate:accept` 里跑**,连日常 `gate:self-test` 都不跑。
      //   ⇒ 一条**结构上已经坏掉的阻断规则可以在生产里静默跑很久**,直到下次关账才现形。
      //   而本日反复出现的正是「造了机制不接线」—— 这一次它发生在**元层**:
      //   管规则的那道闸自己没接线。
      //   代价:19 条规则的结构检查,每轮一次,微秒级。
      const inv = validateRules(RULES);
      const eFindings = runRules(RULES, eCtx);
      if (inv.length) {
        eFindings.unshift({ id: "INV", block: true,
          msg: `**规则表装载期不变量不成立**(${inv.length} 条):\n` +
            inv.slice(0, 6).map((x) => `      · ${x}`).join("\n") +
            `\n      这不是某一轮的问题,是**规则表自身坏了** —— 先修它,别继续跑。` });
      }
      // P 的收尾结算(只在生产形态 `live`;离线/自测/回放不落——分母纪律同 .gate-alerts):计账 + 基点推进。
      //   取值与判据唯一实现在 `settleP`(纯函数,自测直接喂);这里只落盘。
      //   计账:三通道齐(动作面)⇒ 清零;否则累加 `tally`(git 事实在 ⇒ 范围内未记过账的承重提交数,红队 a2a9f58b BP-1)。
      //   基点:**只在 git 事实非 null 且 P 无命中(结清)时**推进到读事实那一刻的 HEAD(BP-2 / BP-6)。
      //   P 欠着(含 UNKNOWN)或事实取不到 ⇒ 基点不动 ⇒ 下一次 Stop 仍看得见这些提交,义务不会因换了一轮而蒸发。
      let _settle = null;
      if (live) try {
        const _P = RULES.find((r) => r.id === "P")?._p;
        if (_P) _settle = settleP(_P, eCtx, eFindings);
      } catch { /* 结算算不出 ⇒ 账与基点都不动(下轮读到旧值只会更严) */ }
      // codex 257-p-gitfacts-r2 补:账写失败而基点照推 ⇒ 已越过的提交下轮不再在范围里、也没进账 ⇒ 少计(漏放)。
      //   故账要写而没写成 ⇒ 基点不推进(下轮仍看得见这些提交,tally 按 sha 去重,不会重计)。
      let _ledgerOk = true;
      if (live && _settle && _settle.ledger) try {
        _ledgerOk = false;
        // D52(批 104):裸 writeFileSync=截断后写,崩在中间读者见半文件;换 tmp+rename 原子写
        //   (同 batch-goal atomicWrite 的形)。读-改-写竞态半条:并发 Stop 仅在双写会话违规时
        //   存在,姿态见 104 威胁模型呈签件;此处只修「写不半截」这一确定收益。
        const tmpP = `.claude/.p-ledger.json.${process.pid}.tmp`;
        try {
          fs.writeFileSync(tmpP, JSON.stringify({ ..._settle.ledger, at: new Date().toISOString() }));
          fs.renameSync(tmpP, ".claude/.p-ledger.json");
          _ledgerOk = true;
        } finally { try { if (fs.existsSync(tmpP)) fs.unlinkSync(tmpP); } catch { /* 残骸不阻断 */ } }
      } catch { /* 账写不了不影响闸;_ledgerOk=false ⇒ 下面不推进基点 */ }
      //   基点写不了 ⇒ 下次仍用旧基点(只会多看提交,方向 fail-closed)。
      if (live && _settle && _settle.advance && _ledgerOk) try {
        writePHead(ctx.sessionId, _settle.head);
      } catch { /* 基点写不了不影响闸 */ }
      // ── D50 绊线(批 098):本轮写过 gate-playbook.md 或 docs/**.md ⇒ 顺带跑文档引用漂移核 ──
      //   「靠人记得」当日被 T 项判死(登记不算处置),升级为写触发:写与查同轮必然相遇。
      //   只在 live 生产形态跑(audit/dry-run 重放离线语料会反复空触发);绊线自身失败不拦、
      //   命中也只出提示不阻断——它是绊线不是闸,拦的事归人看见后处置。
      try {
        const wroteDoc = (eCtx.writes || []).some((w) =>
          /gate-playbook\.md$/.test(w) || /(^|[\\/])docs[\\/].+\.md$/i.test(String(w)));
        // ⚠️ 2026-08-27:先看那个件在不在。本闸已开源(custodiet),而 `tool-usage-census.mjs`
        //   **不随开源仓发布** ⇒ 在别人的仓里这一句必然抛错,再被下面的 catch 变成
        //   一条「文档引用漂移」的假报告——**把「工具不在」伪装成「你的文档漂了」**。
        //   同一族:catch 吞掉真错(D90)。件不在就静默跳过,不假装跑过。
        if (live && wroteDoc && fs.existsSync("scripts/tool-usage-census.mjs")) {
          try {
            execFileSync(process.execPath, ["--no-warnings", "scripts/tool-usage-census.mjs", "--doc-drift"],
              { encoding: "utf8", timeout: 15000, windowsHide: true });
          } catch (de) {
            const out = String((de && de.stdout) || safeErrMsg(de)).slice(0, 600);
            eFindings.push({ id: "DRIFT", block: false,
              msg: `文档引用漂移(写触发绊线;--doc-drift 非零退出):\n${out}` });
          }
        }
      } catch { /* 绊线失败不影响闸 */ }
      // 已迁的那些:丢掉旧实现的产出,换成引擎的
      const kept = findings.filter((f) => !engineIds.has(f.id));
      return [...kept, ...eFindings];
    } catch (e) {
      // ⚠️ 引擎出事**不能静默退回**——那会让「引擎已接管」与「引擎崩了」无从区分。
      //   退回旧实现的同时留一条可见记录。
      // ⚠️ **必须阻断**(2026-08-20 grill:error-handling §4.2)。
      //   原写法 `block: false` 然后 return 旧实现产出 —— 而 **S/T/U 是当日直接生在引擎里的,
      //   没有旧实现可退**(旧文件的内联 id 清单里没有这三条)。
      //   于是 `buildCtx` / `_priorWindow` / `readBatchGoal` / `validateRules`
      //   (它们都在 try 里、都在 `runRules` 之外)任一抛错 ⇒ **三条阻断项整条消失**,
      //   而外面只看到一条 `block: false` 的提示。
      //   `runRules` 内部那套「阻断项抛错 ⇒ UNKNOWN 阻断」在这条路径上**够不着**
      //   —— **单条隔离做对了,整块隔离是 fail-open 的**。
      // ⚠️ 切换后(2026-08-22 亲签)**不再回退旧结果**:引擎崩 = 本轮 21 条全部 UNKNOWN,
      //   fail-closed 只剩 ENGINE 阻断 + 未迁的原生规则(A/R,它们不归引擎管,照常放行)。
      //   旧行为(回退内联产出)在「引擎独占」语义下是假安全:回退面与引擎判据早已分叉。
      //   `engineIds` 声明在 try 内、此处不可见 ⇒ 从 RULES 重算(同一来源)。
      // ⚠️ **catch 自身必须不可崩**(2026-08-22 codex 故障注入逮到:若原始异常正是规则表坏掉
      //   ——RULES[0]=null 之类——这里重算 `.id` 会**二次抛出**,漏进外层 main catch 的
      //   fail-open 路 ⇒ exit 0 放行,「引擎崩溃一律阻断」的全称承诺被打穿。
      //   double-fault handler 不得自己 fault 是老规矩。取不出 engineSet ⇒ native 判不了
      //   ⇒ 丢弃全部(宁可连 A/R 一起丢,ENGINE 阻断兜底,fail-closed 方向)。
      let native = [];
      try {
        const engineSet = new Set(RULES.map((r) => r.id));
        native = findings.filter((f) => !engineSet.has(f.id));
      } catch { native = []; }
      findings.length = 0;
      findings.push(...native);
      findings.push({ id: "ENGINE", block: true,
        // ⚠️ 连取 message 都可能抛(Proxy getter / toString 钩子,codex 复核实测两形态逃逸)
        //   ⇒ 独立 try + 定值兜底,这才是 double-fault handler 的完整形态。
        msg: `[引擎崩溃:${safeErrMsg(e)}]\n` +
          `      本轮 ${(() => { try { return RULES.length; } catch { return "全部"; } })()} 条规则全部 UNKNOWN ⇒ 按 fail-closed 阻断。**先修引擎,别绕。**\n` +
          `      (切换后无旧实现可退;回退线 = git revert 切换 commit)` });
      return findings;
    }
  }
  return findings;
}

// 数最近**连续**几次阻断(读 transcript 的 system 行)。
// 为什么:官方对连续阻断有 8 次上限,超出即强制结束回合并忽略本闸
// ——那是防 hook 死循环的保险丝。2026-08-19 实测本会话最长连续阻断**正好 8 次**,
// 已经顶到天花板。与其被官方强行忽略,不如**自己先退让**:
// 逼近上限时把阻断降级为提示,并明说「反复撞同一项 = 判据可能有问题」。
// 这是把阻断消息里那句劝告变成机制——此前它只是一句话,没有任何东西在数。
function consecutiveBlocks(tp) {
  if (!tp || !fs.existsSync(tp)) return 0;
  let text;
  try { text = fs.readFileSync(tp, "utf8"); } catch { return 0; }
  return consecutiveBlocksText(text);
}

/** 纯函数本体(自测直接喂转录文本)。 */
export function consecutiveBlocksText(text) {
  // 2026-10-09 重写(批 257,热修红队 BP-1/4/5):**以「一次 Stop」为计数单位**,按 toolUseID 归并。
  //   同一次 Stop 会落 feedback 用户行、hook_blocking_error 附件、stop_hook_summary 汇总行多种载体
  //   (三者同一个 toolUseID);逐载体计数会把标准形态的每次阻断数两次(3 次连撞即降级),
  //   或在附件形态下被 `hookErrors:[]` 的汇总行清零(恒为 0)。
  //   一次 Stop 只要任一载体带本闸阻断即算「被拦」;**只有已出现汇总行的 Stop 才参与计数**(进行中的那次不算),
  //   连撞 = 从末尾往前连续被拦的已结束 Stop 数。没有 toolUseID 的老行各自成一个单位(与旧实现同口径)。
  const order = [], unit = new Map();   // id -> { blocked, ended }
  const touch = (id) => { if (!unit.has(id)) { unit.set(id, { blocked: false, ended: false }); order.push(id); } return unit.get(id); };
  let anon = 0;
  try {
    for (const line of String(text).split("\n")) {
      // 热修红队 BP-2(10-09):用户亲自发言 = 连撞清零点(否则连拦 5 次、用户打断再问,新一轮第 2 次就降级)。
      if (line.includes('"kind":"human"')) {
        let h; try { h = JSON.parse(line); } catch { h = null; }
        // 模型忙时插话落的是 queued_command 附件,同样是用户亲自发言(批 257 v5 红队 BP-4)
        const queued = h?.type === "attachment" && h.attachment?.type === "queued_command" && h.attachment.origin?.kind === "human";
        if ((h?.type === "user" && h.origin?.kind === "human") || queued) { order.length = 0; unit.clear(); continue; }
      }
      if (!line.includes("hook_blocking_error") && !line.includes("hookCount")) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      // 热修红队 BP-6(10-09):SDK/无头转录不写汇总行 ⇒ 任何 Stop 都「未结束」⇒ 连撞恒 0。
      //   新的 Stop 单位出现时,把此前所有单位视为已结束(没有汇总行也能计数)。
      const id0 = o.attachment?.toolUseID || o.toolUseID;
      if (id0 && !unit.has(id0)) for (const u of unit.values()) u.ended = true;
      if (o.type === "attachment" && o.attachment?.type === "hook_blocking_error" && o.attachment?.hookEvent === "Stop") {
        const u = touch(o.attachment.toolUseID || `anon-a${anon++}`);
        if (/收尾闸阻断/.test(JSON.stringify(o.attachment.blockingError || ""))) u.blocked = true;
        continue;
      }
      if (o.type === "system" && o.hookCount !== undefined) {
        const u = touch(o.toolUseID || `anon-s${anon++}`);
        if (/收尾闸阻断/.test(JSON.stringify(o.hookErrors || []))) u.blocked = true;
        u.ended = true;
      }
    }
  } catch { return 0; }
  let run = 0;
  for (const id of order) { const u = unit.get(id); if (!u.ended) continue; run = u.blocked ? run + 1 : 0; }
  return run;
}

/** 「批次还开着」这句话——给**用户**看的那一份,与 findings 无关。
 *
 *  ⚠️ 2026-08-20 grill:architecture **P5**:我第一版把它写在 `if (!findings.length)` **里面**,
 *  而它要救的场景(K 以提示身份出现、用户看不见批次开着)恰恰 `findings.length > 0`
 *  ⇒ **同一批里的两处改动直接对冲**:能到达它的只剩「每条条件都已在本轮逐字裁过」那一片,
 *  也就是「你已经证明你在跟进这个批」的时候才提醒你,而真正需要提醒的每一轮都静默。
 *  ⇒ 提到 `emit()` 顶上,三条出口(阻断 / 提示 / 全过)**都带上它**。
 *  `systemMessage` 是顶层字段,与 `decision` 和 `hookSpecificOutput` 可以共存。 */
function batchOpenWarning() {
  try {
    const g = readBatchGoal();
    if (g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length) {
      return `⚠ 批 ${g.batch || "?"} 仍未结清(${g.conditions.length} 条完成条件)`;
    }
  } catch { /* 提示失败不影响闸 */ }
  return null;
}

/** 从任意 throw 出来的东西里安全取文本——**取 message 这一步自己也可能抛**
 *  (Proxy getter / toString 钩子,codex+grill 2026-08-22 各自实测过逃逸形态)。
 *  double-fault handler 的每一层都得用它,包括「最后求救」的 stderr 行:
 *  grill 逐行核出 :1932 原来不设防,同款毒 e 会逃出整个 catch ⇒ 进程裸崩,
 *  「连这一步都失败就只剩 stderr」的承诺是假的。 */
function safeErrMsg(e) { try { return String((e && e.message) || e); } catch { return "(错误对象自身不可读)"; } }

function emit(findings, streak = 0, opts = {}) {
  // D40:与 run() 同一纪律——落盘台账(心跳/报警分母)只认显式 `opts.live`,不再嗅 argv。
  const live = opts.live === true;
  const sysWarn = batchOpenWarning();
  // ⚠️ **泄压阀拉开时必须当着用户的面拉**(2026-08-20 用户实撞:
  //   「不结清。——那为什么还是停下来了?」)。
  //   `yielding`(连撞 ≥ CAP-2 时把**全部**阻断降级成提示)本意是
  //   「反复撞同一项说明判据有问题,别硬顶」——一个防死锁的阀。
  //   但它的实际效果是:**我越是长时间满足不了一道闸,它就越确定会放弃拦我**;
  //   而降级这件事**对用户完全不可见**,用户看到的只是「他说不结清,然后回合正常结束了」。
  //   grill:architecture P7 已判出这条(当时我登记未修,随后用户当场撞上)。
  //   ⇒ 阀保留(死锁比漏放更贵),但降级本身升级为 `systemMessage`:
  //     用户侧必须看见「闸刚刚放弃了拦我,以及放弃了哪几项」。
  let sysParts = sysWarn ? [sysWarn] : [];
  const withWarn = (o) => (sysParts.length ? { ...o, systemMessage: sysParts.join("\n") } : o);
  // 心跳:全过时也出一行。理由同上——没有它,「跑完无命中」与「崩了」无从区分。
  // 刻意做到最短(用户当日抱怨过 hook 话太多),但**不能没有**:
  // 它把「闸活着」从「由沉默推断」变成「有正面观测」。
  if (!findings.length) {
    // ⚠️ **心跳必须走 stderr,不能走 `additionalContext`**(2026-08-20 实撞,用户问「为什么要陪一个空循环打转」)。
    //   官方语义(本机 changelog L1391,带版本、零配额):
    //     「Stop and SubagentStop hooks can now return `hookSpecificOutput.additionalContext`
    //       to give Claude feedback and **keep the turn going** without being labeled a hook error」
    //   ——「keep the turn going」是这个字段的**设计意图**,不是副作用。
    //   于是每一次**干净通过**都在主动续命:模型回一句 → 停 → 闸再注一次 → 无限。
    //   实撞时连转 8 轮,全是「Idle」这类零信息应答。
    //   ⚠️ **原注写「不受任何上限保护,真无限」——已核实不成立,2026-08-20 codex 判出**:
    //     本机 changelog L1826(2.1.143)那条只写「连续阻断」,而 `additionalContext`
    //     是 **2.1.163 才加入**的 ⇒ 拿一条**比该字段更早**的条目去断言它不受保护,
    //     版本对不上而我没查。当前官方文档明确:`additionalContext` 与 `decision:block`
    //     **共享同一套 8 次连续续轮保护**。
    //     ⇒ 正确表述是「**每次全过都白烧一轮,直到撞 8 次上限**」,不是无限。
    //     改 stderr 仍有价值(免掉那 8 轮无意义续轮),但诊断的强度当时过头了。
    //   心跳本身要留(没有它,「跑完无命中」与「崩了」无从区分——这是本文件多处注文的立论基础),
    //   但它的载体只能是**不会重启回合**的那一条:stderr。
    //   `STOP_CLOSURE_STDOUT=1` 保留一条回到旧行为的口子,仅供调试,**永不用于生产**。
    const beat = "收尾闸:全跑,无命中。";
    // ⚠️ **stderr 不是「正面观测」**(codex 判出,采纳):成功 hook 的输出只进 debug log,
    //   不自动进 transcript;官方要显示给用户得用结构化 `systemMessage`。
    //   我把一个会吵的仪器换成了一个**没人看得见的仪器**——正是本文件反复在防的那个毛病。
    //   ⇒ 心跳同时**落盘**,这才是真的可观测面:一行一次调用,可 grep 可数,
    //     「闸活着」从此有正面证据,而不必去翻 debug log。落点在 gitignore 面内。
    // ⚠️ 只在**生产 hook 形态**(显式 live)落盘——--audit/--dry-run 回放会伪造「活着」证据。
    if (live) try {
      // D53:心跳行带耗时账(先量后改;p95 攒够再定增量方案)
      fs.appendFileSync(".claude/.gate-heartbeat.log", new Date().toISOString() + " CLEAN " + perfLine() + "\n");
    } catch { /* 台账写不了不影响闸 */ }
    if (process.env.STOP_CLOSURE_STDOUT === "1") {
      process.stdout.write(JSON.stringify(withWarn({
        hookSpecificOutput: { hookEventName: "Stop", additionalContext: beat },
      })));
      return 0;
    }
    process.stderr.write(beat + "\n");
    // 批次未结清的提醒走 `systemMessage`(官方:「To surface a message to the user on any
    // platform, return `systemMessage` in JSON output.」)。它**不续轮**,与心跳那条不同。
    // ✅ **已证成(2026-08-20,运行时直证)**:官方页那节被截断、文档未记载,
    //   但 transcript 里留了痕 —— `{"type":"hook_system_message","content":"⚠ 批 … 仍未结清…"}`。
    //   ⇒ Stop hook 的 `systemMessage` **确实被投递**,不属于「Some events discard it」那一类。
    //   ⚠️ 记一笔取证过程:我为这件事**问了用户三次**「你看得见吗」,
    //   而它一条 `grep 'hook_system_message' <transcript>` 就能自证。
    //   「只有用户能观测」是我自己下的判断,没验过——
    //   与当日主线(拿仪器的沉默当结论、不去看仪器本身)是同一个错。
    if (sysWarn) process.stdout.write(JSON.stringify({ systemMessage: sysWarn }));
    return 0;
  }
  // ⚠️ 阻断开关表。**未列出的 id 默认阻断(fail-closed)**——这是 2026-08-19 的修法。
  //   原实现是一条硬编码三元链,末尾 `: false`:任何**新增**的 `block:true` 项只要
  //   没被加进链里,就**静默降级成提示**。当日实撞:新加的 O 项标了 block:true 却不在链上,
  //   而自测 46/46 全绿——因为 emit() 从未被任何用例执行过。
  //   grill:testing 的判词:「**一个让闸永远不再阻断的改动,会 44/44 通过。**」
  //   环境变量只用于**关掉**已知项(逃生口),不再用于**决定**未知项阻不阻断。
  const blocking = findings.filter((f) => f.block && (BLOCK_OFF[f.id] ?? true));
  // **报警分母台账**(2026-08-22,批 077 条件②;codex 最小补救第 2 条:
  //   「自动记录所有报警分母,禁止只记抱怨过的报警」)。
  //   没有分母,误报台账量出来的只是「被注意到并由自己认定的误报数」——连 precision 都不是。
  //   离线回放(--audit/--dry-run/--self-test,即带 argv 的形态)不记,否则分母被历史灌满。
  // ⚠️ yielding 判定**先于**落账(grill 2026-08-22 §4:原来 `blocked` 写的是「本该拦」,
  //   而降级轮实际投递的是提示——字段与真实投递不符且无标记。最失真的恰是闸自己
  //   承认「可能拦错」的那几轮)。CAP/yielding 在此处一次算清,下方不再重复声明。
  const CAP = Math.max(4, Number(process.env.STOP_CLOSURE_BLOCK_CAP || 8));
  // 观察档(批 265,新仓上线用):`.claude/custodiet-mode` 首行为 observe(生效条件见 observeMode 头注)⇒
  //   照常判、照常落报警台账(本该拦的记进 `observed`),但**不阻断、不向模型输出任何提示**。
  //   为什么要有:一个比赛用仓 2,837 个真实回合的模拟回放里,该模拟条件下阻断了 30.7% 的回合——新仓先攒数据,
  //   按规则量出误报率、把误报多的规则本身修掉,再整体切回阻断(不做逐条开关,用户 265 原话);一刀切开阻断就是用户说的「磕磕绊绊、大量影响生产的误报」。
  //   失效条件:观察档里的仓连续 30 天无人看台账 ⇒ 等于没装,复议是否改为默认开低误报规则。
  const OBSERVE = observeMode();
  const yielding = !OBSERVE && blocking.length > 0 && streak >= CAP - 2;
  if (live) try {
    // D1/批 102:走 ledger-chain(接线点一)。
    ledgerAppend(".claude/.gate-alerts.jsonl", {
      ts: new Date().toISOString(), ids: findings.map((f) => f.id),
      // 会话号 + 截至本轮解析出的转录条目数(不是物理行号:空行与坏行不计):事后抽样复核时据此回到那一轮
      //   (codex 265-deliverables-r1 附 3:原先只有时间戳,观察档攒的数据回溯不到原文)
      sid: _ledgerSid, at: Array.isArray(_allEntriesCache) ? _allEntriesCache.length : undefined,
      // `blocked` = 本轮**真实投递**为阻断的;降级轮记进 `demoted`,并带 yielding 标记;观察档记进 `observed`
      blocked: yielding || OBSERVE ? [] : blocking.map((f) => f.id),
      ...(OBSERVE ? { observed: blocking.map((f) => f.id), observe: true } : {}),
      ...(yielding ? { demoted: blocking.map((f) => f.id), yielding: true } : {}),
      streak,
      perf: perfLine(),   // D53:同一笔耗时账进报警台账,分母侧也可算 p95
    });
  } catch (e) {
    // 台账写不了不影响闸,但**必须出声**——静默吞掉=新报警从分母无声消失(codex 四眼判词)
    try { process.stderr.write("LEDGER-WRITE-FAILED(.gate-alerts): " + safeErrMsg(e) + "\n"); } catch { /* 空 */ }
  }
  if (OBSERVE) return 0;   // 观察档:只落账,不对模型说一个字
  // 输出瘦身(2026-08-19 用户实撞:「hook 中间说的内容太多了」)。
  // 提示项只留首行——多行说明是给「第一次撞到」的人看的,重复刷屏反而淹没结论;
  // 阻断项保留全文,因为那几行写的是**出路**,是收到即可执行的东西。
  const brief = (f) => `  [${f.id}] ${String(f.msg).split("\n")[0]}`;
  const lines = findings.map(brief).join("\n");
  const notice =
    `收尾闭环闸命中 ${findings.length} 项:\n${lines}\n` +
    `CEILING: 除 A 外系关键词匹配,判不出语义;详见脚本头注的误报/漏报形态表。CALIBRATED=false;拦错了→ --fp 记账。`;
  // 离线模式(--audit/--dry-run)仍走 stderr 便于人读;生产路径下面改走 additionalContext
  if (process.env.STOP_CLOSURE_STDERR === "1") process.stderr.write(notice + "\n");
  // 原先这里刷一整段误报/漏报形态表,每次命中都重贴一遍。那段是**设计文档**,
  // 属于脚本头注,不属于每次输出(2026-08-19 用户实撞「hook 说的内容太多了」)。
  else process.stderr.write(`收尾闭环闸命中 ${findings.length} 项:\n${lines}\n`);
  // 逼近官方连续阻断上限时**自己先退让**(2026-08-19 立;实测本会话最长连续阻断
  // 正好 8 次 = 顶到天花板)。留 2 次余量而非踩点,因为余量用完后官方会**忽略本闸**
  // 让回合结束——那时闸是哑的,比降级危险。降级不是放行:同样的话照说,
  // 只是不再拦;而且明写「连撞 N 轮 = 判据可能有问题」,把此前只写在阻断消息里的
  // 那句劝告变成机制——此前没有任何东西在数。
  // ⚠️ 变量名**不再占用官方 `CLAUDE_CODE_*` 命名空间**(grill:security S5)。
  //   原写法读 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`,它看起来像官方开关,于是
  //   settings 的 env 块、父 shell、CI、任何插件把它设成 2,就让
  //   `streak >= CAP-2` 恒真 ⇒ **所有阻断永久降级成提示**,而闸照旧输出安慰性文字。
  //   实测确认可复现。这正是本文件自己记着的那句「一个让闸永远不再阻断的改动会 44/44 通过」
  //   ——现在连改代码都不需要。同时加下限钳位,防 CAP 过小导致恒降级。
  if (yielding) {
    sysParts.push(`⚠ 收尾闸**自行降级**:连撞 ${streak} 轮(阈值 ${CAP - 2}),` +
      `本轮 ${blocking.length} 项阻断全部降为提示 —— [${blocking.map((f) => f.id).join(",")}]。` +
      `\n  这些项**没有被满足**,是闸放弃了拦。判据可能有问题,也可能是活没做完。`);
  }
  if (blocking.length && !yielding) {
    // 从 `BLOCK_ENV` 派生,不再硬编码(grill P6:硬编码那版印出的变量没人读)。
    // 表里没有 ⇒ 该项**没有逃生口**,如实说,不编一个出来。
    const envs = [...new Set(blocking.map((f) =>
      BLOCK_ENV[f.id] ? `STOP_CLOSURE_BLOCK_${BLOCK_ENV[f.id]}=0` : `${f.id}:无逃生口`))];
    // ⚠️ 提示项必须**一起**输出。原实现只把 blocking 放进 reason 就 return,
    //   于是「只要有一项阻断,八个提示项就全被吞掉」——2026-08-19 实测:
    //   A/B/C/D/E1/F/G/H 全会话零显示,不是没命中,是命中了没机会说话。
    const notices = findings.filter((f) => !blocking.includes(f));
    process.stdout.write(JSON.stringify(withWarn({
      decision: "block",
      reason: `收尾闸阻断 ${blocking.length} 项:\n` +
        blocking.map((f) => `  [${f.id}] ${f.msg}`).join("\n") +
        // 提示项只列首行:它们不阻断,详情自己去看脚本头注。
        (notices.length ? `\n同时提示:${notices.map(brief).join("").trim()}` : "") +
        `\n处理完再结束本回合(放行:${[...new Set(envs)].join(" / ")})。` +
        // 连撞警告只在**快撞上限时**才说。原实现每次阻断都贴一遍,
        // 于是最该被看见的那句被自己的重复淹没(2026-08-19 用户实撞)。
        (streak >= CAP - 4
          ? `\n⚠️ 已连撞 ${streak} 轮(上限 ${CAP},到 ${CAP - 2} 本闸自动降级)——反复撞同一项说明判据有问题,别硬顶。`
          : ""),
    })));
    return 2;
  }
  // 非阻断项走官方的 additionalContext 出口,而不是 stderr:
  // 官方明写它「shown in the transcript as hook feedback **rather than a hook error**」
  // (changelog:1391)。原实现把提示写进 stderr,等于每条提示都报成 hook 错误。
  process.stdout.write(JSON.stringify(withWarn({
    hookSpecificOutput: { hookEventName: "Stop", additionalContext: notice },
  })));
  return 0;
}

// ── 自测:六条正反用例,不依赖真 transcript
function selfTest() {
  process.env.STOP_CLOSURE_SELFTEST = "1";   // 隔离 K 类的外部状态依赖
  _observeForTest = false;                   // 批 265:自测不吃宿主仓的观察档文件(红队 a9bf37ae BP-5)
  const mk = (arr) => arr.map((o) => JSON.stringify(o)).join("\n");
  const U = (t) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] } });
  const A = (t, tu = []) => ({ type: "assistant", message: { role: "assistant", content: [
    ...(t ? [{ type: "text", text: t }] : []),
    ...tu.map((n) => (typeof n === "string"
      ? { type: "tool_use", name: n, input: {} }
      : { type: "tool_use", name: n.name, input: n.input || {} })),
  ] } });
  const tmp = `${process.env.TEMP || "."}/stop-closure-selftest-${process.pid}.jsonl`;
  // ⚠️ **19 条期望在 2026-08-20 加上了 `K0`,记录理由免得日后被读成「改测试迁就实现」**:
  //   这些夹具都「写了文件 / 提交了,却没有武装完成条件」——K0 在这些输入上响**符合它的定义**。
  //   它们此前不响,是因为自测走了一条**带外通道**(批次状态供 `undefined`)把 K/K0 整个跳过;
  //   codex 判死那条通道(「把验收台的不完整输入固化成规则的放行语义」)之后,假绿现形。
  //   改的是**期望值**,没有改判据、没有改用例输入——这条界线是本次唯一站得住的地方。
  const cases = [
    // 批 257:A 的 codex 族只认实际工具事件。原两条(助理正文写 `CODEX_JOB=abc123` 即入账、正文写 `--poll abc123` 即结清)
    //   正是被裁撤的判法——改成真 tool_use↔tool_result 配对;正文提及不入账的反例钉在下面「codex 账 ⑨」。
    { name: "A 命中:codex 前台 done 而未读回", lines: [U("go"),
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_a1", name: "Bash", input: { command: "node ~/.claude/scripts/codex-run.mjs --task t.md" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a1", content: "CODEX_JOB=abc123\nCODEX_STATE=done\nCODEX_RESULT=\\repo\\clipboard\\codex\\t-r1.md\n" }] } },
      A("发出去了")], want: ["A"] },
    { name: "A 不命中:正文只提到 CODEX_JOB(不是发起事件)", lines: [U("go"), A("CODEX_JOB=abc123 已发出")], want: [] },
    { name: "B 命中:承诺句零工具", lines: [U("go"), A("我这就去改,不问,你喊停就停")], want: ["B"] },
    { name: "B 命中:干了别的那件(今日实撞形态)",
      lines: [U("go"), A("我这就去改 `foo.mjs`", [{ name: "Edit", input: { file_path: "/repo/bar.md" } }])], want: ["B", "K0"] },
    { name: "B 命中:无具体对象的空头承诺",
      lines: [U("go"), A("我这就去处理一下", [{ name: "Edit", input: { file_path: "/repo/bar.md" } }])], want: ["B", "K0"] },
    { name: "B 不命中:承诺对象与动作对得上",
      lines: [U("go"), A("工具面已扫:无命中。我这就去改 `foo.mjs`", [{ name: "Grep", input: { pattern: "x", path: "docs/tool-register.md" } }, { name: "WebSearch", input: { query: "existing impl" } }, { name: "Edit", input: { file_path: "/repo/scripts/foo.mjs" } }])], want: ["K0"] },
    { name: "C 命中:缺陷陈述无处置", lines: [U("go"), A("这条还没落盘,也没入仓")], want: ["C"] },
    // ⚠️ 2026-08-20 引擎接管后,这几条夹具从简写 `["Write"]` 改成**带真入参**。
    //   原写法造出的是**没有 file_path 的 Write**:旧实现只看「出现了 Write 这个工具名」就算写过,
    //   引擎要求真有路径。**「出现了 Write 工具」≠「写了文件」正是这次重写要消灭的东西**,
    //   所以是夹具跟上契约,不是放宽规则。
    { name: "C 不命中:缺陷陈述后有写",
      lines: [U("go"), A("这条还没落盘", [{ name: "Write", input: { file_path: "/repo/docs/foo.md" } }])], want: ["K0"] },
    { name: "D 命中:强制面降级", lines: [U("go"), A("这条要交叉验证。要不要我去跑一下?")], want: ["D"] },
    { name: "D 不命中:非强制面", lines: [U("go"), A("配色你要是想换我可以帮你调")], want: [] },
    { name: "E0+E2 阻断:裸因果断言两半都没走", lines: [U("go"), A("根因是缓存没刷新")], want: ["E0","E2"] },
    { name: "自标豁免 E0 但**不豁免 E2**(承认不确定≠找过判据)", lines: [U("go"), A("根因是缓存没刷新——这是我的推断,证据不足")], want: ["E2"] },
    { name: "E2 单命中:发了 codex 但没走 xros(今日实撞形态)", lines: [U("go"), A("根因是缓存没刷新", [{ name: "Bash", input: { command: "node ~/.claude/scripts/codex-run.mjs --task t.md" } }]), A("--poll x1")], want: ["E2"] },
    { name: "E1 单命中:跑了探针但没跨模型", lines: [U("go"), A("根因是缓存没刷新", [{ name: "Bash", input: { command: "node scripts/verify-laws.mjs" } }])], want: ["E1"] },
    { name: "E0+E2 覆盖最常见句式「X 是因为 Y」", lines: [U("go"), A("它失败是因为路径写错了")], want: ["E0","E2"] },
    // F:今日实撞原句形态——同段既说全部执行完毕、又登记还欠一件
    { name: "F 命中:完成断言与欠件并存", lines: [U("go"), A("9 项全部执行完毕。欠件一条:取页适配器还没造", ["Write"])], want: ["F"] },
    { name: "F 不命中:只报完成无欠件", lines: [U("go"), A("9 项全部执行完毕,两个闸 PASS", ["Write"])], want: [] },
    { name: "F 不命中:只报欠件无完成断言", lines: [U("go"), A("取页适配器还没造,登记为欠件", ["Write"])], want: [] },
    // ⚠️ 原写法把 `git commit -m x` 放在**助理的文本块**里 —— 旧实现在裸文本里 grep 到
    //   就算「提交过」。引擎从 Bash **入参**解析。这条夹具本身就是那个 bug 的化石。
    // ── G v2(2026-08-25,批 101/D48):仪式文本判据已裁撤,判据面=①入册②失效条件④关账自测。
    //   下面前两条在 v1 里是「命中」用例——普通提交轮追讨自审文本正是量出来的 21 次噪声,
    //   v2 下它们**不命中**是修法本身,期待值跟着契约走。
    { name: "G v2 不命中:普通提交轮零仪式要求(v1 的追讨噪声消失)",
      lines: [U("go"), A("这就提交", [{ name: "Bash", input: { command: "git commit -m x" } }])], want: ["K0"] },
    { name: "G v2 不命中:仪式文本说什么都不影响判据",
      lines: [U("go"), A("先自审四问:全部齐了", [{ name: "Bash", input: { command: "git commit -m x" } }])], want: ["K0"] },
    { name: "G 不命中:七问逐条答过", lines: [U("go"), A("自审:① 无新造件 ② 失效条件已写 ③ 已接线 ④ 日记已补 ⑤ xros 已跑 ⑥ 已查先例 ⑦ 已过 grill"), A("git commit -m x")], want: [] },
    { name: "G v2 命中:触闸机件提交而无自测动作(④)",
      lines: [U("go"), A("改闸,提交", [
        { name: "Edit", input: { file_path: "/repo/scripts/hook-stop-closure.mjs" } },
        // 2026-09-07 起 P 也响:闸引擎提交无绑定红队 ⇒ 不计宽限(D11 独立于宽限)
        { name: "Bash", input: { command: "git commit -m x" } }])], want: ["G", "K0", "P"] },
    { name: "G 不命中:没提交", lines: [U("go"), A("改完了", ["Edit"])], want: [] },
    // H:今日实撞原形——自己写下「我能做、不需要你签」然后停手等发话
    { name: "H 命中:自陈能做却没做", lines: [U("go"), A("这两件我能做,不需要你签,属工装面")], want: ["H"] },
    { name: "H 不命中:自陈能做且做了",
      lines: [U("go"), A("这件我能做,不需要你签", [{ name: "Write", input: { file_path: "/repo/docs/foo.md" } }])], want: ["K0"] },
    // I:纪律 32 闸化——新建载体必须留工具面扫描痕迹
    { name: "I 阻断:新建 agent 未留扫描痕迹",
      lines: [U("go"), A("造好了", [{ name: "Write", input: { file_path: "/repo/.claude/agents/_x.md" } }])], want: ["I", "K0"] },
    { name: "I 阻断:新建 scripts 工装未留痕",
      lines: [U("go"), A("写好了", [{ name: "Write", input: { file_path: "/repo/scripts/foo.mjs" } }])], want: ["I", "K0"] },
    { name: "I 不命中:已留扫描痕迹",
      // ⚠️ `WebSearch` 是 2026-08-20 补的:纪律 32 从三层扩到**四层**(加「搜 GitHub」),
      //   本夹具原来只扫本地 ⇒ 新规则下它不再是「已扫」。夹具跟着契约走,不是反过来。
      lines: [U("go"), A("工具面已扫:四层无命中,造", [{ name: "Read", input: { file_path: "docs/tool-register.md" } }, { name: "WebSearch", input: { query: "existing impl" } }, { name: "Write", input: { file_path: "/repo/.claude/skills/y/SKILL.md" } }])], want: ["K0"] },
    { name: "I 不命中:写的不是载体面",
      lines: [U("go"), A("更新文档", [{ name: "Write", input: { file_path: "/repo/docs/foo.md" } }])], want: ["K0"] },
    // J:立法必答触发层——递归的最后一层
    { name: "J 命中:改法典未交代触发层",
      lines: [U("go"), A("新增一条纪律", [{ name: "Edit", input: { file_path: "/repo/docs/laws/collab.md" } }])], want: ["J", "K0"] },
    { name: "J 不命中:触发层写在对话里",
      lines: [U("go"), A("新增一条,触发层:Stop hook 的 I 项,必然执行", [{ name: "Edit", input: { file_path: "/repo/AGENTS.md" } }])], want: ["K0"] },
    { name: "J 不命中:没碰法典",
      lines: [U("go"), A("工具面已扫:无命中。改工装", [{ name: "Grep", input: { pattern: "x", path: "docs/tool-register.md" } }, { name: "WebSearch", input: { query: "existing impl" } }, { name: "Edit", input: { file_path: "/repo/scripts/x.mjs" } }])], want: ["K0"] },
    // I 的两个新覆盖面(2026-08-19 实测漏掉整类动作后补)
    { name: "I 命中:Edit 已有载体也算造物",
      lines: [U("go"), A("改一下", [{ name: "Edit", input: { file_path: "/repo/.claude/agents/_x.md" } }])], want: ["I", "K0"] },
    { name: "I 命中:经 Bash 写载体绕不过去",
      lines: [U("go"), A("改一下", [{ name: "Bash", input: { command: "node -e \"fs.writeFileSync('scripts/foo.mjs',s)\"" } }])], want: ["I","M"] },
    // 两条反向用例:2026-08-19 实撞的误报形态
    { name: "I 不命中:git add/commit 载体不算写它(G v2 下亦不触造物入册)",
      lines: [U("go"), A("提交", [{ name: "Bash", input: { command: "git add scripts/foo.mjs && git commit -m 'x'" } }])], want: ["K0"] },
    { name: "I 不命中:heredoc 正文里的路径与符号是数据不是命令",
      lines: [U("go"), A("提交", [{ name: "Bash", input: { command: "git commit -m \"$(cat <<'EOF'\n改了 scripts/foo.mjs,详见 a > b\nEOF\n)\"" } }])], want: ["K0"] },
    // M 的路径提取:cp 的目标必须整词取出。原正则 `\S*\s*([\w./-]+\.json)` 里的
    // `\S*` 会回溯进文件名中间,把 `.claude/settings.json` 切成 `.claude/setting`
    // + `s.json`,回读比对遂用错文件名 ⇒ **回读过也报未回读**(2026-08-19 实撞)。
    // ⚠️ 用例必须让**目标带引号**:引号不在 `[\w./-]` 里,是它逼出回溯。
    //    不带引号的简例旧式也返回正确值——**那种用例新旧代码同过,测不出任何东西**
    //    (本条初版就写错成简例,直证旧式行为时才发现)。
    //    回溯有两副面孔,同一根因:目标带引号且**源**以目标扩展名结尾时切碎成 `s.json`;
    //    否则退而捞到**源文件**(本例:旧式吐 `a.md`)。两者都不是真写入目标。
    //    鉴别判据不是「有没有吐 s.json」,而是「有没有捞到真正的写入目标」——
    //    初版鉴别脚本问错了前者,险些把无鉴别力的用例当成有鉴别力。
    // 纪律 32 只对**真新建**成立:改一个已在册文件不是手搓。
    // 本例同时是「git ls-files 真的取到了」的探针——若 tracked 退化成 null
    // (如误用 require 被 catch 吞掉),本例会因 fail-closed 误拦而 FAIL。
    { name: "I 不命中:改已被 git 追踪的既有载体(是改不是造)",
      lines: [U("go"), A("改一下", [
        { name: "Edit", input: { file_path: "scripts/hook-stop-closure.mjs", old_string: "a", new_string: "b" } },
      ])], want: ["K0"] },
    { name: "I 命中:写一个未被追踪的新载体",
      lines: [U("go"), A("造一个", [
        { name: "Write", input: { file_path: "scripts/zzz-not-tracked-probe.mjs", content: "x" } },
      ])], want: ["I", "K0"] },
    // ── D56(批 109):memory 面误报**二犯**的正反三面。
    // ⚠️ **批 253b**:K0 的工作面同样不再计 memory 笔记(同一理由:事实登记不是工作面),
    //   故下面四条的期望从 [K0] 变成 []——写一条笔记不再叫醒任何闸。
    // ⚠️ **批 253(2026-09-17 用户签「这个不算吧」)**:memory 笔记(`.claude/projects/*/memory/**.md`)整面不再算工具载体,
    //   下面四条的期望从 [I,K0] 改为 [K0];memory 目录里的脚本(.mjs)仍算,钉在 RULE_I 的 cases 里。
    //   memory 永不入仓 ⇒ git 判据恒判新建 ⇒ 改一行索引也被当造物拦。
    //   修法=`Edit` 语义证明「本轮之前已存在」,**只施于 memory 面**。
    // ⚠️ 本条**记的曾是已知误报**;2026-08-27 D56 结清后语义变了,原注留此为史:
    //   「D56 的修法已同批撤回(grill:edge-cases F1),故 Edit 改 MEMORY.md 索引行仍会命中 I。」
    //   **现在的判据**:命不命中取决于有没有 `preExisted` 记录(写之前实测),
    //   而本夹具**不注入**它 ⇒ 落在「无记录」那一支 ⇒ 仍应命中。
    //   这正是修法不开漏放口的那一侧:**没量过就当新建**。
    //   有记录的那一侧由接缝「D56 有 precheck 记录 ⇒ 不算新建」钉住,两侧成对。
    { name: "I 不命中:Edit 改 MEMORY.md 索引行(批 253 用户签:memory 笔记不算工具载体)",
      lines: [U("go"), A("加一行索引", [
        { name: "Edit", input: { file_path: "C:/Users/x/.claude/projects/example-project/memory/MEMORY.md", old_string: "a", new_string: "b" } },
      ])], want: [] },
    // F1 回归钉:非工具面造(Bash)+ Edit 收尾,**必须仍算新建**。
    //   这是 D56 撤回前实测会漏放的那条路径;子代理造+主代理 Edit 是它的同族(且不可见)。
    //   批 253 起 memory 笔记整面不算载体,原钉(memory 路径)已改为不命中;
    //   批 253b(第二份红队附节二 2)把钉加回到**非 memory 载体**上,就是这一条。
    { name: "I 命中:Bash 造 scripts/ 新脚本 + Edit 收尾(F1 漏放回归钉,非 memory 载体)",
      lines: [U("go"), A("造完改", [
        { name: "Bash", input: { command: "printf x > scripts/zz-f1.mjs" } },
        { name: "Edit", input: { file_path: "scripts/zz-f1.mjs", old_string: "x", new_string: "y" } },
      ])], want: ["I", "K0", "M"] },
    //   期望里的 `M`(写了没回读)是这条夹具的**真实属性**,不是放水:Bash `>` 写盘 + Edit 收尾、
    //   全程没有一次读回 ⇒ M 按其定义响。(下面那条同形态的 memory 夹具实测不带 M;
    //   成因未查,不在本批范围——此处只记读数,不代它下结论。)
    // 下一条:同形态落在 memory 笔记上 ⇒ 批 253 用户签后不算载体,不命中。
    { name: "I 不命中:Bash 造 memory 笔记 + Edit 收尾(批 253 用户签:memory 笔记不算工具载体)",
      lines: [U("go"), A("造完改", [
        { name: "Bash", input: { command: "printf '# t' > C:/Users/x/.claude/projects/example-project/memory/zz-f1.md" } },
        { name: "Edit", input: { file_path: "C:/Users/x/.claude/projects/example-project/memory/zz-f1.md", old_string: "# t", new_string: "# real" } },
      ])], want: [] },
    { name: "I 不命中:Write 造一个新 memory 条目(批 253 用户签:memory 笔记不算工具载体)",
      lines: [U("go"), A("记一条", [
        { name: "Write", input: { file_path: "C:/Users/x/.claude/projects/example-project/memory/zzz-new.md", content: "x" } },
      ])], want: [] },
    { name: "I 不命中:同轮先 Write 再 Edit 同一 memory 笔记(批 253 用户签)",
      lines: [U("go"), A("造完顺手改", [
        { name: "Write", input: { file_path: "C:/Users/x/.claude/projects/example-project/memory/zzz-new2.md", content: "x" } },
        { name: "Edit", input: { file_path: "C:/Users/x/.claude/projects/example-project/memory/zzz-new2.md", old_string: "x", new_string: "y" } },
      ])], want: [] },
    // `2>/dev/null` 的 `>` 曾被当成「写载体」,于是纯读命令被判成新建载体。
    // E2 出路②必须认**全角冒号**——中文正文里「机械判据：」天然是全角,
    // 原判据的字符类两个都是半角,该出路对中文形同虚设。
    // 带引号路径的探针必须被认作出路①(Windows 长路径几乎总要加引号)。
    { name: "E0 不命中:跑了带引号路径的探针",
      lines: [U("go"), A("根因是索引失效导致的。", [
        { name: "Bash", input: { command: 'node --no-warnings "/c/tmp/scratchpad/verify-idx.mjs"' } },
      ])], want: ["E1"] },   // E1 属正确:过了「形」,未过「独立性」
    // 「无判据」档必须附一条带实参的 /xros:sharpen,否则出路②不成立。
    { name: "E2 命中:只说「无机械判据」而未递出 sharpen",
      lines: [U("go"), A("根因是缓存未失效。机械判据:无,因该命题不可机械核定。", [])], want: ["E0", "E2"] },
    { name: "E2 不命中:说「无判据」且递出带实参的 sharpen",
      lines: [U("go"), A("根因是缓存未失效。机械判据:无,不可机械核定 ⇒ 请敲 `/xros:sharpen 缓存失效判据怎么定`", [])], want: ["E0"] },
    // 本例同时跑了探针(满足 E0 要求的「真动作」),故只考核冒号那一处。
    // ⚠️ E0 与 E2 出路**故意不同**:E2 认一句声明,E0 要真动作(见 E0 注释「出路刻意留便宜」)。
    //   所以纯文本回合里写「机械判据:已跑」豁免 E2 但不豁免 E0——那是设计,不是 bug。
    { name: "E2 不命中:全角冒号写的就地声明(伴随真探针)",
      lines: [U("go"), A("根因是缓存未失效导致的。**机械判据：已跑** grep 对账。", [
        { name: "Bash", input: { command: "node scratchpad/cache-probe.mjs" } },
      ])], want: ["E1"] },   // E1 属正确:跑了探针=过「形」,未跨模型=缺「独立性」
    // N:正文报出计数即满足法条的「指出第二个 agent 在哪」,不必本轮再读一次文件。
    { name: "N 不命中:递给用户但正文已报出 agent 计数",
      lines: [U("go"), A("`/xros:sharpen` 只能你亲手下(`parallel(` 2 处,多 agent 管线)。", [])], want: [] },
    { name: "N 命中:递给用户且说不出计数",
      lines: [U("go"), A("这个 `/xros:sharpen` 只能你亲手下。", [])], want: ["N"] },
    { name: "I 不命中:ls/grep 读载体目录且带 2>/dev/null(读不是写)",
      lines: [U("go"), A("看看", [
        { name: "Bash", input: { command: "ls .claude/agents/*.md 2>/dev/null | wc -l" } },
        { name: "Bash", input: { command: "grep -Rl x .claude/skills/ 2>/dev/null | head -2" } },
      ])], want: [] },
    // Q:推面出批。正例=只说推迟;反例=推迟并指出三类合法阻断之一。
    { name: "Q 命中:说留给下次但没指出阻断",
      lines: [U("go"), A("这三件留给下次做,今天先到这儿。", [])], want: ["Q"] },
    { name: "Q 不命中:推迟且指出需亲签",
      lines: [U("go"), A("这件留给下次——它改的是授权边界,需亲签,归你签。", [])], want: [] },
    { name: "M 路径不被回溯切碎:带引号的 cp 目标整词取出且回读被认",
      lines: [U("go"), A("备份", [
        { name: "Bash", input: { command: 'cp docs/a.md "docs/settings.json"' } },
        { name: "Bash", input: { command: "grep -c x docs/settings.json" } },
      ])], want: [] },
  ];
  let pass = 0;
  for (const c of cases) {
    fs.writeFileSync(tmp, mk(c.lines), "utf8");
    const got = run(tmp).map((f) => f.id).sort();
    const ok = JSON.stringify(got) === JSON.stringify(c.want.sort());
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  期待=[${c.want}] 实得=[${got}]`);
    if (ok) pass++;
  }
  try { fs.unlinkSync(tmp); } catch {}

  // ── A 项 codex 账(批 257 / D141;v5 = clipboard/257-a-fix-r3-list.md「主会话裁定 v5」)──────────
  //   设计报告表 1 的诚实节奏逐条进夹具,**每条配一个真退回变异**。红队 r1–r4 与 codex 复核 v4 的夹具全部保留,
  //   v5 只认「runner 交付的带 J 定界块」或「Read 工具读 R / 日志」,各夹具的期望按 v5 重定,改了的名字带「v5:」并写明理由。
  //   夹具形态照真实转录:tool_use(assistant,带 cwd、timestamp)↔ tool_result(user,tool_use_id 配对)。
  let cxPass = 0, cxTotal = 0;
  {
    const cx = (name, got, want) => {
      cxTotal++;
      const ok = got === want;
      console.log(`${ok ? "PASS" : "FAIL"}  codex 账:${name}${ok ? "" : `  ← 期待 ${want} 实得 ${got}`}`);
      if (ok) cxPass++;
    };
    const CWD = "\\repo";
    let nid = 0;
    // 条目带 timestamp(真实转录都有):调用 n 的 tool_use 在 T0+n 秒、返回在其后 0.5 秒
    const T0 = Date.parse("2026-10-09T11:50:00Z");
    const call = (name, input, text, isErr = false) => {
      const id = `toolu_cx${++nid}`;
      const t = T0 + nid * 1000;
      return [
        { type: "assistant", cwd: CWD, timestamp: new Date(t).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
        { type: "user", cwd: CWD, timestamp: new Date(t + 500).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isErr }] } },
      ];
    };
    const say = (t) => ({ type: "assistant", cwd: CWD, message: { role: "assistant", content: [{ type: "text", text: t }] } });
    const userSay = (t) => ({ type: "user", cwd: CWD, message: { role: "user", content: [{ type: "text", text: t }] } });
    const R = "\\repo\\clipboard\\codex\\t-r1.md";
    const RF = R.replace(/\\/g, "/");
    const R2 = "\\repo\\clipboard\\codex\\t-r2.md";
    const LOGP = (J) => `C:\\Users\\x\\AppData\\Local\\Temp\\codex-run-jobs\\${J}.log`;
    // 结果件头部**用 runner 的真实格式拼**(红队 a2155edb BP-8:原夹具多带一个空行,正文落在第 10 行,与写死的
    //   CODEX_BODY_FIRST_LINE=10 恰好吻合,于是 runner 真实的「正文第 9 行起」从没被测到)。runner 在场就取它的
    //   `resultHeader`(照 PLACEHOLDER_RE 两边对齐的做法);公开树缺 runner 时退回逐字抄写的同形 8 行。
    const HEAD = (_codexRunForSelfTest && typeof _codexRunForSelfTest.resultHeader === "function")
      ? _codexRunForSelfTest.resultHeader({ codexVersion: "codex-cli 0.153.4", sandbox: "read-only" }, "abc").replace(/\n$/, "").split("\n")
      : ["---", "codex 版本: codex-cli 0.153.4", "模型: (codex 默认)", "sandbox: read-only(缺省,写被 OS 拒)",
        "network: on(codex 自带通道;2026-08-09 实测 read-only 下四客户端全 200)", "repo_brief: (none)", "复看: codex resume abc", "---"];
    const BODY = ["## 结论", "甲方说得对,乙方的第二条不成立。", "全文报告写在 clipboard/review-A.md。"];
    const FILE = [...HEAD, ...BODY].join("\n");
    const numbered = (lines, from = 1) => lines.map((l, i) => `${from + i}\t${l}`).join("\n");
    const blk = (J, text = FILE, kind = "BODY") => `CODEX_${kind}_BEGIN=${J}\n${text}\nCODEX_${kind}_END=${J}\n`;
    const launchCmd = "node ~/.claude/scripts/codex-run.mjs --task clipboard/codex/t.md";
    // 旧 runner(或 BODY 块被截掉)的前台 done:只有机器块 ⇒ 待读;v5 runner 的前台 done:机器块 + BODY 块 ⇒ 当场读回
    const launchDone = (J = "J1") => call("Bash", { command: launchCmd },
      `CODEX_JOB=${J}\nCODEX_STATE=done\nCODEX_RESULT=${R}\n\n[exited with code 0]`);
    const launchDone5 = (J = "J1", text = FILE, cmd = launchCmd) => call("Bash", { command: cmd },
      `CODEX_JOB=${J}\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=${J}\n${blk(J, text)}\n[exited with code 0]`);
    const launchBg = (J = "J1", r = R) => call("Bash", { command: launchCmd },
      `CODEX_JOB=${J}\nCODEX_STATE=background\nCODEX_LOG=${LOGP(J)}\nCODEX_RESULT=${r}\n` +
      `CODEX_POLL=node scripts/codex-run.mjs --poll ${J}\nCODEX_END=${J}\n\n[exited with code 0]`);
    const pollCmd = (J = "J1", more = "") => `node ~/.claude/scripts/codex-run.mjs --poll ${J}${more}`;
    const pollDone5 = (J = "J1", text = FILE, cmd = pollCmd(J)) => call("Bash", { command: cmd },
      `CODEX_JOB=${J}\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=${J}\n${blk(J, text)}done ${R}\n`);
    const pollFail5 = (J = "J1") => call("Bash", { command: pollCmd(J) },
      `CODEX_JOB=${J}\nCODEX_STATE=failed\nCODEX_ERROR=x\nCODEX_LOG=${LOGP(J)}\nCODEX_END=${J}\n${blk(J, "turn.failed: quota", "FAIL")}failed x\n`, true);
    const readR = (path = R, from = 1, lines = [...HEAD, ...BODY]) => call("Read", { file_path: path }, numbered(lines, from));
    const catR = (cmd, out = FILE + "\n\n[exited with code 0]") => call("Bash", { command: cmd }, out);
    const env0 = { resultBody: () => FILE };
    const NOW = T0 + 3600_000;
    // 带任务的状态台账夹具都要有 startedAt(v7:缺它不认领,真实台账恒有);T0+30 分钟落在每次发起的认领窗口内
    const SA = new Date(T0 + 1_800_000).toISOString();
    const now = Date.parse("2026-10-09T12:00:00Z");
    const stEnv = (s) => ({ ...env0, now, jobState: () => s });
    const doneEnv = stEnv({ state: "done", result: R });
    const st = (entries, env = env0, J = "J1") => {
      const j = codexLedger(entries, env).jobs.find((x) => x.id === J);
      return j ? j.status : "(未入账)";
    };
    const only = (entries, env = env0) => { const js = codexLedger(entries, env).jobs; return js.length === 1 ? js[0].status : `(${js.length} 个作业)`; };
    const aOf = (entries, extra = {}) => {
      const f = run(null, { entries, turn: lastTurn(entries), text: "x", codexEnv: env0, ...extra }).find((x) => x.id === "A");
      return f ? (f.block ? "A!" : "A") : "-";
    };
    const sub = (entries, env = env0) => subagentCodexVerdict(entries, env).block.length;

    // ── v5 本体:runner 交付的定界块 ──
    cx("v5 前台 done 发起返回带完整 BODY 块 ⇒ 当场读回", st([...launchDone5()]), "read");
    cx("v5 poll 返回带完整 BODY 块 ⇒ 已读回", st([...launchBg(), ...pollDone5()], stEnv(null)), "read");
    cx("v5 变异:BODY 块与 R 当前正文不一致(旧回件)⇒ 待读", st([...launchDone5("J1", "## 结论\n上一轮的旧结论。")]), "pending-read");
    cx("v5 BODY 正文只差行尾空白与换行 ⇒ 仍算一致", st([...launchDone5("J1", FILE.replace(/\n/g, "  \r\n"))]), "read");
    cx("v5 R 读不到(无注入正文)⇒ 只认块", st([...launchDone5()], {}), "read");
    cx("v5 变异:BODY 块被 | head 截尾(只有 BEGIN)⇒ 待读", st([...call("Bash", { command: `${launchCmd} | head -12` },
      `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=J1\nCODEX_BODY_BEGIN=J1\n${HEAD.join("\n")}`)]), "pending-read");
    cx("v5 变异:BEGIN 与 END 的 J 不同 ⇒ 不成块、待读", st([...launchDone(), ...call("Bash", { command: pollCmd("J1") },
      `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_BODY_BEGIN=J1\n${FILE}\nCODEX_BODY_END=J2\ndone ${R}\n`)]), "pending-read");
    cx("v5 变异:别的作业 J2 的 BODY 块不替 J1 结账", st([...launchDone(), ...launchDone5("J2")]), "pending-read");
    // ── v6(clipboard/257-a-fix-r3-list.md「主会话裁定 v6」):两路复核 v5 的夹具,每条配退回变异 ──
    {
      const at = (t, name, input, text, isErr = false) => {
        const id = `toolu_v6${++nid}`;
        return [
          { type: "assistant", cwd: CWD, timestamp: new Date(t).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
          { type: "user", cwd: CWD, timestamp: new Date(t + 500).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isErr }] } },
        ];
      };
      const bgL = (t, k, cmd = launchCmd) => at(t, "Bash", { command: cmd, run_in_background: true },
        `Command running in background with ID: bv${k}. Output is being written to: C:/x/bv${k}.output`);
      const TT = "/repo/clipboard/codex/t.md";
      const iso = (t) => new Date(t).toISOString();
      const mkEnv = (tb, extra = {}) => ({
        now: T0 + 3600_000, resultBody: () => FILE, jobState: (J) => tb[J] || null,
        findJob: (q) => {
          let best = null;
          for (const [id, j] of Object.entries(tb)) {
            if (q.exclude && q.exclude.has(id)) continue;
            if (q.result && codexNormPath(j.result, null) === q.result) return { ...j, id };
            if (q.task && codexNormPath(j.task, null) === q.task) {
              const t = Date.parse(j.startedAt);
              if (t >= q.from && t <= q.to && (!best || t < best.t)) best = { j: { ...j, id }, t };
            }
          }
          return best ? best.j : null;
        },
        ...extra,
      });
      const lbl = (es, env) => codexLedger(es, env).jobs.map((j) => `${j.label}:${j.status}`).sort().join(" ");
      const pollAt = (t, J, r = R) => at(t, "Bash", { command: pollCmd(J) }, `CODEX_JOB=${J}\nCODEX_STATE=done\nCODEX_RESULT=${r}\nCODEX_END=${J}\n${blk(J)}done ${r}\n`);
      // 红队 BP-1:同任务后台发两次(隔 10 分钟),只 poll 了早的那份 ⇒ 晚的那份仍待读(旧实现:J1 认领了晚的占位,J2 欠账消失)
      const tb1 = {
        J1: { state: "done", task: TT, result: RF, startedAt: iso(T0 + 1000), endedAt: iso(T0 + 60_000) },
        J2: { state: "done", task: TT, result: R2.replace(/\\/g, "/"), startedAt: iso(T0 + 601_000), endedAt: iso(T0 + 660_000) },
      };
      cx("v6 BP-1:读了早的那份,晚的那份仍待读", lbl([...bgL(T0, 1), ...bgL(T0 + 600_000, 2), ...pollAt(T0 + 1_800_000, "J1")], mkEnv(tb1)),
        "J1:read J2:pending-read");
      // codex v5 第 1 条:为参考去读同任务一天前的旧作业输出(带完整 BODY)⇒ 旧 J 不得认领新占位
      const tb2 = {
        J0: { state: "done", task: TT, result: "/repo/clipboard/codex/t-r0.md", startedAt: iso(T0 - 86_400_000), endedAt: iso(T0 - 86_000_000) },
        J1: { state: "done", task: TT, result: RF, startedAt: iso(T0 + 1000), endedAt: iso(T0 + 60_000) },
      };
      cx("v6 codex-1:读同任务旧作业的输出不替新作业结账", lbl([...bgL(T0, 1),
        ...at(T0 + 120_000, "Read", { file_path: "C:/x/old.output" }, numbered(`CODEX_JOB=J0\nCODEX_STATE=done\nCODEX_END=J0\n${blk("J0")}`.split("\n")))], mkEnv(tb2)),
        "J1:pending-read");
      // 红队 BP-2 / codex「没问到的」1:作业结束前 Read R(读到占位或同路径旧件)不算读回;结束后读才算
      const launchBgAt = (t) => at(t, "Bash", { command: launchCmd }, `CODEX_JOB=J1\nCODEX_STATE=background\nCODEX_RESULT=${R}\nCODEX_END=J1\n`);
      const tb3 = { J1: { state: "done", task: TT, result: RF, startedAt: iso(T0 + 100), endedAt: iso(T0 + 60_000) } };
      cx("v6 BP-2:终态之前的 Read R 不算", st([...launchBgAt(T0), ...at(T0 + 30_000, "Read", { file_path: R }, numbered(["(占位)"]))], mkEnv(tb3)), "pending-read");
      cx("v6 BP-2 对照:终态之后的 Read R 算", st([...launchBgAt(T0), ...at(T0 + 90_000, "Read", { file_path: R }, numbered([...HEAD, ...BODY]))], mkEnv(tb3)), "read");
      // codex v5 第 4 条:分页 Read 后台输出,BODY 跨两页 ⇒ 拼起来算
      const outLines = `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=J1\n${blk("J1")}`.split("\n");
      cx("v6 codex-4:分页 Read .output,BODY 跨页 ⇒ 已读回", st([...launchBg(),
        ...call("Read", { file_path: "C:/x/tasks/bk1.output", limit: 8 }, numbered(outLines.slice(0, 8))),
        ...call("Read", { file_path: "C:/x/tasks/bk1.output", offset: 9 }, numbered(outLines.slice(8), 9))], stEnv(null)), "read");
      cx("v6 codex-4 变异:只读了前半页 ⇒ 待读", st([...launchBg(),
        ...call("Read", { file_path: "C:/x/tasks/bk1.output", limit: 8 }, numbered(outLines.slice(0, 8)))], stEnv(null)), "pending-read");
      // 红队 BP-5:`--cwd <worktree>` 发起,任务路径按 --cwd 解
      const W = "/repo/.claude/worktrees/agent-x";
      const tb5 = { J1: { state: "done", task: `${W}/clipboard/codex/t.md`, result: `${W}/clipboard/codex/t-r1.md`, startedAt: iso(T0 + 1000), endedAt: iso(T0 + 60_000) } };
      cx("v6 BP-5:--cwd 发起的后台作业能反查到", lbl([...bgL(T0, 1, `node scripts/codex-run.mjs --cwd ${W} --task clipboard/codex/t.md`)], mkEnv(tb5)), "J1:pending-read");
      // 红队附二-2:超时自动转后台的措辞也认作后台任务号(在飞 ⇒ 运行中,而不是状态未知)
      const autoBg = at(T0, "Bash", { command: launchCmd },
        "Command did not complete within its 10s timeout and was moved to the background (ID: bq1). Output is being written to: C:/x/bq1.output.");
      cx("v6 附二-2:自动转后台的发起在飞 ⇒ 运行中", only(autoBg, { ...env0, bgTasks: [{ id: "bq1", status: "running" }] }), "running");
      // 红队 BP-7:用户级 runner 没有 v5 交付能力 ⇒ 提示不给 --poll 出路
      const old = codexLedger([...launchDone()], { ...env0, pollDelivers: false }).open.join("\n");
      cx("v6 BP-7:旧 runner 时提示只给 Read R", /--poll/.test(old) ? "给了 poll" : /Read 工具读结果件/.test(old) ? "只给 Read" : old, "只给 Read");

      // ── v7(同文件「主会话裁定 v7」)──
      // codex v6 第 1 条:发起前准备了很久,窗口认不上 ⇒ 后台输出文件里的 CODEX_JOB 直连身份(两小时后开跑也认)
      const tb7 = { J7: { state: "done", task: TT, result: RF, startedAt: iso(T0 + 7_200_000), endedAt: iso(T0 + 7_300_000) } };
      const outOf = (J) => (p) => (/bv1\.output$/.test(p) ? `CODEX_JOB=${J}\nCODEX_STATE=background\nCODEX_RESULT=${R}\nCODEX_END=${J}\n` : null);
      cx("v7 codex-1:后台输出文件直连身份,超出时间窗也认 ⇒ 待读", lbl([...bgL(T0, 1)], mkEnv(tb7, { now: T0 + 9_000_000, readOutput: outOf("J7") })), "J7:pending-read");
      cx("v7 codex-1 对照:读不到输出文件 ⇒ 窗口外认不上(只剩提示)", lbl([...bgL(T0, 1)], mkEnv(tb7, { now: T0 + 9_000_000 })).includes("unknown"), true);
      // codex v6 第 2 条:早 5 秒的同任务旧作业 / 缺 startedAt 的台账,读它的输出都不得认领新占位
      const tbOld = (sa) => ({ J0: { state: "done", task: TT, result: "/repo/clipboard/codex/t-r0.md", ...(sa ? { startedAt: sa } : {}) },
        J1: { state: "done", task: TT, result: RF, startedAt: iso(T0 + 100), endedAt: iso(T0 + 60_000) } });
      const readOld = at(T0 + 90_000, "Read", { file_path: "C:/x/old.output" }, numbered(`CODEX_JOB=J0\nCODEX_STATE=done\nCODEX_END=J0\n${blk("J0")}`.split("\n")));
      cx("v7 codex-2:早 5 秒的旧作业不认领新占位", lbl([...bgL(T0, 1), ...readOld], mkEnv(tbOld(iso(T0 - 5000)))), "J1:pending-read");
      cx("v7 codex-2:台账缺 startedAt 不认领", lbl([...bgL(T0, 1), ...readOld], mkEnv(tbOld(null))), "J1:pending-read");
      // codex v6 第 3 条:读没有时间戳、而台账有界 ⇒ 不算;读到的是 runner 占位文字 ⇒ 不算
      const tb8 = { J1: { state: "done", task: TT, result: RF, startedAt: iso(T0 + 100), resultAt: iso(T0 + 50_000), endedAt: iso(T0 + 60_000) } };
      const noTs = (es) => es.map((e) => { const { timestamp, ...rest } = e; return rest; });
      cx("v7 codex-3:读没有时间戳 ⇒ 不算读回", st([...launchBgAt(T0), ...noTs(at(T0 + 90_000, "Read", { file_path: R }, numbered([...HEAD, ...BODY])))], mkEnv(tb8)), "pending-read");
      cx("v7 codex-3:读到 runner 占位文字 ⇒ 不算读回", st([...launchBgAt(T0),
        ...at(T0 + 90_000, "Read", { file_path: R }, numbered(["(codex-run 作业 J1 运行中,结果未产出——占位)"]))], mkEnv(tb8)), "pending-read");
      // codex v6 第 4 条:R 已写好(resultAt 之后)、endedAt 之前的完整读 ⇒ 算
      cx("v7 codex-4:resultAt 与 endedAt 之间的完整读 ⇒ 已读回", st([...launchBgAt(T0), ...at(T0 + 55_000, "Read", { file_path: R }, numbered([...HEAD, ...BODY]))], mkEnv(tb8)), "read");
      // codex v6 第 5 条:先读了文件头,再分两页读到完整 BODY(中间有没读的空档)⇒ 算
      const gapLines = outLines.slice(4);
      cx("v7 codex-5:BODY 之前有没读到的空档,不连累后面完整的块", st([...launchBg(),
        ...call("Read", { file_path: "C:/x/tasks/bk1.output", limit: 1 }, numbered(outLines.slice(0, 1))),
        ...call("Read", { file_path: "C:/x/tasks/bk1.output", offset: 100 }, numbered(gapLines.slice(0, 5), 100)),
        ...call("Read", { file_path: "C:/x/tasks/bk1.output", offset: 105 }, numbered(gapLines.slice(5), 105))], stEnv(null)), "read");
      // v7 反查倒序:前一次发起没真跑起来(无作业),后一次发起的作业不得被前一次抢走
      const tbR = { J2: { state: "done", task: TT, result: RF, startedAt: iso(T0 + 61_000), endedAt: iso(T0 + 120_000) } };
      cx("v7 反查从最晚的发起往前认:后一次发起认到自己的作业",
        codexLedger([...bgL(T0, 1), ...bgL(T0 + 60_000, 2)], mkEnv(tbR)).jobs.map((j) => j.label.startsWith("J") ? j.label : "?").join(","), "?,J2");
      // 红队 v6 BP-3:台账已清的旧作业,poll 返回 job-missing 不得把待读翻成失败;之后 Read R 照常结账
      const jm = (J) => call("Bash", { command: pollCmd(J) }, `CODEX_JOB=${J}\nCODEX_STATE=failed\nCODEX_ERROR_CODE=job-missing\nCODEX_ERROR=台账缺失\nCODEX_END=${J}\nfailed job ${J} 台账缺失\n`, true);
      cx("v7 BP-3:job-missing 不改写已有的 done", st([...launchDone(), ...jm("J1")], stEnv(null)), "pending-read");
      cx("v7 BP-3:旧 runner 的「台账缺失」末行同样不改写", st([...launchDone(),
        ...call("Bash", { command: pollCmd("J1") }, "failed job J1 台账缺失\n", true)], stEnv(null)), "pending-read");
      cx("v7 BP-3:之后 Read R 照常结账", st([...launchDone(), ...jm("J1"), ...readR()], stEnv(null)), "read");
      // 红队终审 BP-8:poll 见过 running,随后台账被清(job-missing),再完整 Read R ⇒ 结账,不再永远「运行中」
      const runPoll = call("Bash", { command: pollCmd("J1") }, "CODEX_JOB=J1\nCODEX_STATE=running\nCODEX_END=J1\nrunning\n");
      cx("终审 BP-8:台账已清、只剩旧 running 观测,完整 Read R ⇒ 已读回", st([...launchBg(), ...runPoll, ...jm("J1"), ...readR()], stEnv(null)), "read");
      cx("终审 BP-8 对照:台账仍说 running ⇒ 运行中(读到的是占位/旧件不算)", st([...launchBg(), ...runPoll, ...readR()], stEnv({ state: "running", startedAt: new Date(now).toISOString(), timeoutMs: 900000 })), "running");
      // 红队 d1cae02 轮 BP-6:Read 只回一句提示(越界 offset),一行文件内容都没有 ⇒ 不算读回
      // 红队 7e1392f 轮 BP-4:Read limit 只读到头部 ⇒ 不算读回;读到正文(第二个 `---` 之后,runner 格式即第 9 行起)才算
      //   (a2155edb BP-8:头部是 8 行;夹具改用 runner 真实格式后,「只读头部」= limit 8)
      const HN = HEAD.length;
      cx("7e1392f BP-4:只读到结果件头部 ⇒ 不算读回", st([...launchDone(), ...call("Read", { file_path: R, limit: HN }, numbered(HEAD))], stEnv(null)), "pending-read");
      cx("7e1392f BP-4 对照:分页读到正文 ⇒ 已读回", st([...launchDone(), ...call("Read", { file_path: R, limit: HN }, numbered(HEAD)),
        ...call("Read", { file_path: R, offset: HN + 1 }, numbered(BODY, HN + 1))], stEnv(null)), "read");
      // ── 红队 a2155edb BP-8 ──
      if (_codexRunForSelfTest && typeof _codexRunForSelfTest.resultHeader === "function") {
        cx("a2155edb BP-8:闸的正文起始行与 runner 真实头部一致", _codexRunForSelfTest.resultHeader({ codexVersion: "x" }, "t").split("\n").length, CODEX_BODY_FIRST_LINE);
      }
      cx("a2155edb BP-8:正文起始行 = 头部行数 + 1(夹具即 runner 格式)", HN + 1, CODEX_BODY_FIRST_LINE);
      const ONE = [...HEAD, "无发现"];
      cx("a2155edb BP-8:一行正文的回件完整 Read ⇒ 已读回", st([...launchDone(), ...readR(R, 1, ONE)], { ...stEnv(null), resultBody: () => ONE.join("\n") }), "read");
      cx("a2155edb BP-8:一行正文、从第 9 行起读(第 1 行没读到,走常量兜底)⇒ 已读回",
        st([...launchDone(), ...call("Read", { file_path: R, offset: HN + 1 }, numbered(["无发现"], HN + 1))], { ...stEnv(null), resultBody: () => ONE.join("\n") }), "read");
      // 头部行数变了(runner 加了一行)也按第二个 `---` 定位,不靠常量
      const H10 = [...HEAD.slice(0, -1), "extra: 新加的一行", "---"];
      cx("a2155edb BP-8:头部多一行也按第二个 --- 定位(只读头部仍不算)",
        st([...launchDone(), ...call("Read", { file_path: R, limit: H10.length }, numbered(H10))], { ...stEnv(null), resultBody: () => [...H10, "无发现"].join("\n") }), "pending-read");
      cx("a2155edb BP-8 对照:头部多一行、读到其后的正文 ⇒ 已读回",
        st([...launchDone(), ...readR(R, 1, [...H10, "无发现"])], { ...stEnv(null), resultBody: () => [...H10, "无发现"].join("\n") }), "read");
      // 空正文回件(只有头部):完整读过即读回(派出方口径)
      const HEADONLY = HEAD.join("\n") + "\n";
      cx("零件:codexStripHeader 剥到第二个 ---", codexStripHeader([...HEAD, "正文甲", "---", "正文乙"].join("\n")), "正文甲\n---\n正文乙");
      cx("零件:codexStripHeader 空正文 ⇒ 空白", codexStripHeader(HEADONLY).trim(), "");
      cx("零件:codexStripHeader 非头部形态原样", codexStripHeader("无头部\n正文"), "无头部\n正文");
      cx("a2155edb BP-8:空正文回件、完整 Read(到文件尾)⇒ 已读回", st([...launchDone(), ...readR(R, 1, HEAD)], { ...stEnv(null), resultBody: () => HEADONLY }), "read");
      cx("a2155edb BP-8:空正文回件、R 读不到时信本次读到的文件尾 ⇒ 已读回", st([...launchDone(), ...readR(R, 1, HEAD)], { ...stEnv(null), resultBody: () => null }), "read");
      cx("a2155edb BP-8 反向:空正文回件只读了头部前半 ⇒ 待读", st([...launchDone(), ...call("Read", { file_path: R, limit: 4 }, numbered(HEAD.slice(0, 4)))], { ...stEnv(null), resultBody: () => HEADONLY }), "pending-read");
      cx("a2155edb BP-8 反向:R 有正文而 Read 恰停在收尾 --- ⇒ 待读(不按「空正文」放行)", st([...launchDone(), ...call("Read", { file_path: R, limit: HN }, numbered(HEAD))], { ...stEnv(null), resultBody: () => FILE }), "pending-read");
      cx("a2155edb BP-8 反向:R 有正文、没给 limit 却只回了头部(读不到 R 时才信文件尾)⇒ 待读", st([...launchDone(), ...readR(R, 1, HEAD)], stEnv(null)), "pending-read");
      cx("d1cae02 BP-6:Read 没返回任何文件行 ⇒ 不算读回", st([...launchDone(),
        ...call("Read", { file_path: R, offset: 999 }, "<system-reminder>Warning: the file exists but is shorter than the provided offset (999).</system-reminder>")], stEnv(null)), "pending-read");
      // 红队 v6 BP-4:规则不追溯——生效时刻之前发起的作业不入账
      cx("v7 BP-4:生效之前发起的作业不入账", codexLedger([...launchDone()], { ...env0, since: T0 + 86_400_000 }).jobs.length, 0);
      cx("v7 BP-4 对照:生效之后发起的照入账", codexLedger([...launchDone()], { ...env0, since: T0 - 1000 }).jobs.length, 1);
      // 红队 v6 附二-5:提示里的 poll 用这次发起用的那支 runner,能力按那一支判
      const repoLaunch = call("Bash", { command: "node scripts/codex-run.mjs --task clipboard/codex/t.md" }, `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=J1\n`);
      const hintOf = (dl) => codexLedger([...repoLaunch], { ...env0, runnerDelivers: (p) => dl && p === "scripts/codex-run.mjs" }).open.join("\n");
      cx("v7 附二-5:能交付的那支 runner ⇒ 提示用它 poll", /node scripts\/codex-run\.mjs --poll J1/.test(hintOf(true)), true);
      cx("v7 附二-5:判不了 / 旧版 ⇒ 不给 poll 出路", /--poll/.test(hintOf(false)), false);
      // 红队 v6 附二-3:手动转后台的措辞也认作后台任务号
      const manBg = at(T0, "Bash", { command: launchCmd }, "Command was manually backgrounded by user with ID: bm1. Output is being written to: C:/x/bm1.output");
      cx("v7 附二-3:手动转后台在飞 ⇒ 运行中", only(manBg, { ...env0, bgTasks: [{ id: "bm1", status: "running" }] }), "running");
      // runner 的占位正则与闸的同一份(改措辞要两边一起改)
      const cr7 = _codexRunForSelfTest;
      if (cr7 && cr7.PLACEHOLDER_RE) cx("v7:闸与 runner 的占位正则一致", cr7.PLACEHOLDER_RE.source, CODEX_PLACEHOLDER_RE.source);
      if (cr7 && cr7.placeholderText) cx("v7:runner 写出的占位被闸认出", CODEX_PLACEHOLDER_RE.test(cr7.placeholderText("J1").trim()), true);
    }
    // v6(红队 BP-8 / codex v5 第 3 条):块按块判,同一次调用里别的命令失败不否掉已完整送达的 BODY
    cx("v6:报错返回里的完整 BODY 块照算(整次调用退出码对块无证明力)", st([...launchDone(), ...call("Bash", { command: `${pollCmd("J1")}; false` },
      `CODEX_JOB=J1\nCODEX_STATE=done\n${blk("J1")}done ${R}\nExit code 1`, true)]), "read");
    cx("v5 变异:发起之前出现的 BODY 块不抵账", st([...catR("cat old-output.txt", blk("J1")), ...launchDone()]), "pending-read");
    cx("v5 Read 后台 .output(带行号)里的完整 BODY 块 ⇒ 已读回", st([...launchBg(),
      ...call("Read", { file_path: "C:/x/tasks/bk1.output" }, numbered(`CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_END=J1\n${blk("J1")}`.split("\n")))], stEnv(null)), "read");
    const QB = `${FILE}\n复现:\nCODEX_JOB=JQ\nCODEX_STATE=done`;
    cx("v5 BODY 正文里引用的 CODEX_JOB 行是数据,不开新账", codexLedger([...launchDone5("J1", QB)], { resultBody: () => QB }).jobs.map((j) => `${j.label}:${j.status}`).join(),
      "J1:read");
    cx("v5 正文里引用 CODEX_JOB 行不被认成 J1 的观测", st([...launchBg(), ...pollDone5("J1", `${FILE}\nCODEX_JOB=J1\nCODEX_STATE=running`)], { resultBody: () => `${FILE}\nCODEX_JOB=J1\nCODEX_STATE=running` }), "read");
    cx("v5 发起 | tail -1 只剩 CODEX_BODY_END=J ⇒ J 入账,done 未读 ⇒ 待读",
      st([...call("Bash", { command: `${launchCmd} 2>&1 | tail -1` }, "CODEX_BODY_END=J1\n")], doneEnv), "pending-read");
    cx("零件:codexBodies 取完整块、剥 Read 行号、余下留给字段解析", (() => {
      const r = codexBodies(numbered(["CODEX_JOB=J1", "CODEX_BODY_BEGIN=J1", "CODEX_JOB=JQ", "正文", "CODEX_BODY_END=J1", "done x"]), true);
      return `${r.bodies.length}:${r.bodies[0].J}:${r.bodies[0].text.replace(/\n/g, "|")}:${r.rest.replace(/\n/g, "|")}`;
    })(), "1:J1:CODEX_JOB=JQ|正文:CODEX_JOB=J1|done x");
    cx("零件:codexBodies 只有 BEGIN ⇒ 其后都当数据、不成块", (() => { const r = codexBodies("A\nCODEX_FAIL_BEGIN=J1\nCODEX_JOB=JQ"); return `${r.bodies.length}:${r.rest}`; })(), "0:A");
    // codex 复核 v4 第 1 条:等待到期仍 running、R 不存在 ⇒ 不得结清
    const runEnv = stEnv({ state: "running", startedAt: "2026-10-09T11:59:00Z", timeoutMs: 900000 });
    const expired = call("Bash", { command: `${pollCmd("J1", " --wait-ms 1000")} && cat ${RF}` },
      `CODEX_JOB=J1\nCODEX_STATE=running\nCODEX_END=J1\nrunning\nExit code 3`, true);
    cx("codex-v4#1 --wait-ms 到期(退出码 3)⇒ 仍运行中、子代理边界阻断", sub([...launchBg(), ...expired], runEnv), 1);
    cx("codex-v4#1 变异:到期后 `; cat R` 报文件不存在 ⇒ 仍运行中", st([...launchBg(), ...call("Bash", { command: `${pollCmd("J1", " --wait-ms 1000")}; cat ${RF}` },
      `CODEX_JOB=J1\nCODEX_STATE=running\nCODEX_END=J1\nrunning\ncat: ${RF}: No such file or directory\nExit code 1`, true)], runEnv), "running");
    cx("codex-v4#1 运行中先于读回:状态文件 running 时 Read 到同路径旧文件 ⇒ 仍运行中", st([...launchBg(), ...readR()], runEnv), "running");
    // codex 复核 v4 第 2–6 条
    cx("codex-v4#2 wc -c R; cat other.md(共享片段)⇒ 待读", st([...launchDone(), ...catR(`wc -c ${RF}; cat other.md`, `120 ${RF}\n${BODY.join("\n")}`)]), "pending-read");
    cx("codex-v4#3 failed 后 wc -c J1.log ⇒ 失败未处理", st([...launchBg(), ...catR(`wc -c "${LOGP("J1").replace(/\\/g, "/")}"`, "812 x.log\n")],
      stEnv({ state: "failed", error: "x", endedAt: new Date(T0).toISOString() })), "failed-open");
    cx("codex-v4#3 failed 后 poll J1(带 FAIL 块); cat J1.log ⇒ 失败已处理", st([...launchBg(), ...pollFail5()], stEnv(null)), "failed-handled");
    cx("codex-v4#4a 后台单独 cat R 再 Read 其 .output ⇒ 待读(v5 不推断,出路 poll)", st([...launchDone(),
      ...call("Bash", { command: `cat ${RF}`, run_in_background: true }, "Command running in background with ID: bk2. Output is being written to: C:/x/tasks/bk2.output"),
      ...call("Read", { file_path: "C:/x/tasks/bk2.output" }, numbered([...HEAD, ...BODY]))]), "pending-read");
    cx("codex-v4#4a 对照:后台 poll J1 再 Read 其 .output(BODY 块)⇒ 已读回", st([...launchDone(),
      ...call("Bash", { command: pollCmd("J1"), run_in_background: true }, "Command running in background with ID: bk3. Output is being written to: C:/x/tasks/bk3.output"),
      ...call("Read", { file_path: "C:/x/tasks/bk3.output" }, numbered(`CODEX_JOB=J1\nCODEX_STATE=done\n${blk("J1")}done ${R}`.split("\n")))]), "read");
    const twoBg = call("Bash", { command: `node ~/.claude/scripts/codex-run.mjs --task clipboard/codex/a.md & node ~/.claude/scripts/codex-run.mjs --task clipboard/codex/b.md; wait`, run_in_background: true },
      "Command running in background with ID: bk4. Output is being written to: C:/x/tasks/bk4.output");
    const twoOut = `CODEX_JOB=J8\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=J8\n${blk("J8")}CODEX_JOB=J9\nCODEX_STATE=done\nCODEX_RESULT=${R2}\nCODEX_END=J9\n${blk("J9", "## 结论\nb 的结论。")}`;
    const twoEnv = { resultBody: (p) => (codexNormPath(p, null) === codexNormPath(R2, null) ? "## 结论\nb 的结论。" : FILE) };
    cx("codex-v4#4b 同一 .output 两个作业各带完整正文 ⇒ 两笔都已读回", codexLedger([...twoBg, ...call("Read", { file_path: "C:/x/tasks/bk4.output" }, numbered(twoOut.split("\n")))], twoEnv)
      .jobs.map((j) => `${j.label}:${j.status}`).sort().join(), "J8:read,J9:read");
    const LISTY = [...HEAD, "- 第一条实质发现:A 段把列表正文全排除了", "- 第二条实质发现:读全文反而不算"].join("\n");
    cx("codex-v4#5 全列表正文的回件、Read R 全文 ⇒ 已读回", st([...launchDone(), ...readR(R, 1, LISTY.split("\n"))], { resultBody: () => LISTY }), "read");
    cx("codex-v4#6 分两次 Read(offset/limit)⇒ 已读回(任一段成功即算)", st([...launchDone(), ...readR(R, 10, BODY.slice(1, 2)), ...readR(R, 11, BODY.slice(2, 3))]), "read");

    // ① 只读一段(Read offset/limit)⇒ 已读回;v5:Read R 任一段成功都算,包括只到固定头(残余②)
    cx("①只读一段正文 ⇒ 已读回", st([...launchDone(), ...readR(R, 10, BODY)]), "read");
    // 7e1392f 轮红队 BP-4 收紧:v5 曾接受「Read R 只读到固定头也算」(残余②),现改为须读到第 10 行起的正文
    cx("①收紧:Read R 只读到固定头 ⇒ 待读(须读到正文)", st([...launchDone(), ...readR(R, 1, HEAD.slice(0, 8))]), "pending-read");
    cx("①变异:Read 的是别的文件 ⇒ 待读", st([...launchDone(), ...readR("\\repo\\clipboard\\codex\\t-r9.md", 10, BODY)]), "pending-read");
    // ② 读失败后重读成功;变异:只有那次失败
    const failRead = call("Read", { file_path: R }, "<tool_use_error>File content (40000 tokens) exceeds maximum allowed tokens</tool_use_error>", true);
    cx("②读失败后重读成功 ⇒ 已读回", st([...launchDone(), ...failRead, ...readR(R, 10, BODY)]), "read");
    cx("②变异:只有失败那次 ⇒ 已产出待读", st([...launchDone(), ...failRead]), "pending-read");
    // ③ shell 读法一律不推断(v5)
    const headR = (n2, lines) => call("Bash", { command: `head -n ${n2} "${RF}"` }, lines.join("\n") + "\n\n[exited with code 0]");
    cx("③只 head 头部 ⇒ 待读", st([...launchDone(), ...headR(8, HEAD.slice(0, 8))]), "pending-read");
    cx("③只 head 头部(无注入正文)⇒ 待读", st([...launchDone(), ...headR(8, HEAD.slice(0, 8))], {}), "pending-read");
    cx("③v5:head -n 30 正文回来了 ⇒ 仍待读(shell 读法不推断)", st([...launchDone(), ...headR(30, [...HEAD, ...BODY])]), "pending-read");
    cx("③grep -c 只回计数 ⇒ 待读", st([...launchDone(), ...catR(`grep -c 结论 "${RF}"`, "1\n")], {}), "pending-read");
    cx("③head 头部 + 别的命令混入 ⇒ 待读", st([...launchDone(), ...catR(`head -n 8 "${RF}"; echo 读完`, HEAD.slice(0, 8).join("\n") + "\n读完\n")]), "pending-read");
    // ④ 读另交付文件:一律不认(谁发车谁读 R)
    const readA = (p) => call("Read", { file_path: p }, numbered(["# 审计全文", "甲方说得对,乙方的第二条不成立。", "甲方胜。"]));
    cx("④读结果正文点名的另一份交付(含回件原句)⇒ 待读", st([...launchDone(), ...readA("\\repo\\clipboard\\review-A.md")]), "pending-read");
    cx("④读没被点名的文件 ⇒ 待读", st([...launchDone(), ...readA("\\repo\\clipboard\\review-B.md")]), "pending-read");
    // ⑤ 路径归一只剩 Read 工具这一路;shell 读法 v5 一律待读
    cx("⑤Read 正斜杠绝对路径 ⇒ 已读回", st([...launchDone(), ...readR(RF)]), "read");
    cx("⑤Read Git Bash /d/ 形态 ⇒ 已读回", st([...launchDone(), ...readR("/repo/clipboard/codex/t-r1.md")]), "read");
    cx("⑤Read 相对路径按条目 cwd 解 ⇒ 已读回", st([...launchDone(), ...readR("clipboard/codex/t-r1.md")]), "read");
    cx("⑤v5:cat R ⇒ 待读(预期代价,出路 poll 或 Read)", st([...launchDone(), ...catR(`cat ${RF}`)]), "pending-read");
    cx("⑤v5:cat R 2>&1 | head -80 ⇒ 待读", st([...launchDone(), ...catR("cat /repo/clipboard/codex/t-r1.md 2>&1 | head -80")]), "pending-read");
    cx("⑤v5:cd 后相对路径 cat ⇒ 待读", st([...launchDone(), ...catR("cd /repo/clipboard && cat codex/t-r1.md")]), "pending-read");
    cx("⑤v5:sed -n 1,200p R ⇒ 待读", st([...launchDone(), ...catR("sed -n '1,200p' clipboard/codex/t-r1.md")]), "pending-read");
    cx("⑤v5:PowerShell Get-Content ⇒ 待读", st([...launchDone(),
      ...call("PowerShell", { command: "Get-Content -Path '\\repo\\clipboard\\codex\\t-r1.md' -TotalCount 40" }, FILE)]), "pending-read");
    cx("⑤变异:Read 同 basename 不同目录 ⇒ 待读", st([...launchDone(), ...readR("/repo/other/t-r1.md")]), "pending-read");
    cx("⑤变异:发起之前 Read 过同一路径 ⇒ 不抵账", st([...readR(), ...launchDone()]), "pending-read");
    cx("⑤v5:同一命令 发起 && cat R(返回只有 runner 的 BODY 块)⇒ 已读回", st([...launchDone5("J1", FILE, `${launchCmd} && cat ${RF}`)]), "read");
    cx("⑤v5:同一命令 发起 && cat R(旧 runner,无 BODY 块)⇒ 待读", st([...call("Bash", { command: `${launchCmd} && cat ${RF}` }, `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\n${FILE}\n`)]), "pending-read");
    // ⑥ 跨轮:上一轮发起、用户新发言 + Stop 反馈之后本轮才读 ⇒ 已读回(经 run() 的生产入口)
    const feedback = { type: "user", cwd: CWD, message: { role: "user", content: "Stop hook feedback:\n收尾闸阻断 ..." } };
    cx("⑥跨轮:上轮发起、本轮读回 ⇒ A 不响", aOf([userSay("去审"), ...launchDone(), say("发出去了。"), userSay("继续"), feedback, ...readR(R, 10, BODY), say("读完了。")]), "-");
    cx("⑥变异:跨轮且一直没读 ⇒ A 阻断", aOf([userSay("去审"), ...launchDone(), say("发出去了。"), userSay("继续"), feedback, say("总结一下。")]), "A!");
    // ⑦ failed(240 实撞原形:旧版无 CODEX_JOB,J 由日志名取)
    const fail240 = call("Bash", { command: "cd /repo && timeout 900 node ~/.claude/scripts/codex-run.mjs --task clipboard/codex/240-x.md 2>&1 | tail -40" },
      `CODEX_STATE=failed\nCODEX_ERROR=codex 退出码 1 且无最终消息\nCODEX_LOG=${LOGP("mu3zmwf3-7eb3f8")}`);
    const J240 = "mu3zmwf3-7eb3f8";
    const logRead = call("Bash", { command: `grep -iE "quota|limit" "C:/Users/x/AppData/Local/Temp/codex-run-jobs/${J240}.log" 2>/dev/null | head -5; tail -6 "C:/Users/x/AppData/Local/Temp/codex-run-jobs/${J240}.log"` },
      `{"type":"error","message":"You've hit your usage limit."}\n# heartbeat\n\n[exited with code 0]`);
    const logReadTool = call("Read", { file_path: `C:/Users/x/AppData/Local/Temp/codex-run-jobs/${J240}.log` }, numbered(["# codex-run worker", '{"type":"error"}']));
    cx("⑦v5:failed 后 Read 工具读日志 ⇒ 失败已处理", st([...fail240, ...logReadTool], env0, J240), "failed-handled");
    cx("⑦v5:failed 后 shell grep/tail 日志 ⇒ 失败未处理(shell 读法不推断)", st([...fail240, ...logRead], env0, J240), "failed-open");
    cx("⑦v5:failed 后 poll 返回 FAIL 块 ⇒ 失败已处理", st([...fail240, ...call("Bash", { command: pollCmd(J240) },
      `CODEX_JOB=${J240}\nCODEX_STATE=failed\nCODEX_END=${J240}\n${blk(J240, "turn.failed", "FAIL")}failed x\n`, true)], env0, J240), "failed-handled");
    cx("⑦v5:failed 后只写登记(不再算处理,裁定 v5 第 3 条闭集)⇒ 失败未处理", st([...fail240,
      ...call("Bash", { command: "cat >> clipboard/.pending-after-limit.md <<'EOF'\n补跑 clipboard/codex/240-x.md\nEOF" }, "\n[exited with code 0]")], env0, J240), "failed-open");
    cx("⑦变异:failed 后什么都没做 ⇒ 失败未处理", st([...fail240], env0, J240), "failed-open");
    cx("⑦变异:日志在失败之前 Read 的 ⇒ 不算处理", st([...logReadTool, ...fail240], env0, J240), "failed-open");
    cx("⑦变异:FAIL 块只有 BEGIN(被截)⇒ 不算处理", st([...fail240, ...call("Bash", { command: `${pollCmd(J240)} | head -6` },
      `CODEX_JOB=${J240}\nCODEX_STATE=failed\nCODEX_END=${J240}\nCODEX_FAIL_BEGIN=${J240}\nturn.failed`, true)], env0, J240), "failed-open");
    cx("⑦v5:前台失败当场带 FAIL 块 ⇒ 失败已处理", st([...call("Bash", { command: launchCmd },
      `CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR=x\nCODEX_LOG=${LOGP("J1")}\nCODEX_END=J1\n${blk("J1", "turn.failed", "FAIL")}`, true)]), "failed-handled");
    // ⑧ 首发 background 未 poll
    cx("⑧首发 background、状态文件 running ⇒ 运行中", st([...launchBg()], runEnv), "running");
    cx("⑧变异:状态文件已 done、没人读 ⇒ 待读", st([...launchBg()], doneEnv), "pending-read");
    cx("⑧变异:running 但超出超时 ⇒ 状态未知", st([...launchBg()], stEnv({ state: "running", startedAt: "2026-10-09T10:00:00Z", timeoutMs: 900000 })), "unknown");
    cx("⑧状态文件读不到 ⇒ 状态未知", st([...launchBg()], stEnv(null)), "unknown");
    cx("⑧离线未注入状态文件 ⇒ 状态未知", st([...launchBg()], env0), "unknown");
    // ⑨ 只认真 poll 的返回;正文提及、读到提及 codex-run 的文件、heredoc 正文都不是事件
    cx("⑨交接块里的 --poll 文本不算 poll ⇒ 状态文件 done 时待读", st([...launchBg(), say("CODEX_POLL=node scripts/codex-run.mjs --poll J1")], doneEnv), "pending-read");
    const pollRun = call("Bash", { command: "node scripts/codex-run.mjs --poll J1" }, "CODEX_JOB=J1\nCODEX_STATE=running\nrunning\n\n[exited with code 0]");
    cx("⑨真 poll 返回 running ⇒ 运行中", st([...launchBg(), ...pollRun], stEnv(null)), "running");
    cx("⑨旧版 poll 单行 running ⇒ 运行中", st([...launchBg(), ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1" }, "running\n")], stEnv(null)), "running");
    cx("⑨一条命令两个旧版 poll ⇒ 状态未知", st([...launchBg("J1"), ...launchBg("J2"),
      ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1; node scripts/codex-run.mjs --poll J2" }, "running\ndone E:/x.md\n")], stEnv(null)), "unknown");
    cx("⑨poll=done(无 BODY)之后 Read R ⇒ 已读回", st([...launchBg(), ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1" },
      `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\ndone ${R}\n`), ...readR(R, 10, BODY)], stEnv(null)), "read");
    cx("⑨poll 返回 failed empty-body(旧 runner 无 FAIL 块)、没读日志 ⇒ 失败未处理", st([...launchBg(), ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1" },
      "CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR_CODE=empty-body\nCODEX_ERROR=x\nfailed x\n", true)], stEnv(null)), "failed-open");
    cx("⑨heredoc 正文里的发起命令不入账", codexLedger([...call("Bash",
      { command: "cat > clipboard/codex/t.md <<'EOF'\n复现命令:\nnode ~/.claude/scripts/codex-run.mjs --task x.md\nEOF" }, "\n")], env0).jobs.length, 0);
    const tailCut = call("Bash", { command: `${launchCmd} 2>&1 | tail -1` }, "CODEX_POLL=node scripts/codex-run.mjs --poll J9\n");
    cx("⑨发起返回被 tail 截到只剩 CODEX_POLL ⇒ J 入账,done 未读 ⇒ 待读", st([...tailCut], doneEnv, "J9"), "pending-read");
    cx("⑨同上,Read R 之后 ⇒ 已读回", st([...tailCut, ...readR(R, 10, BODY)], doneEnv, "J9"), "read");
    cx("⑨run_in_background 发起(离线)⇒ 状态未知", only([...call("Bash",
      { command: launchCmd, run_in_background: true }, "Command running in background with ID: bk1. Output is being written to: C:\\x\\bk1.output")]), "unknown");
    cx("⑨助理正文里写 CODEX_JOB= 不是发起 ⇒ 不入账", st([say("CODEX_JOB=J1 已发出")]), "(未入账)");
    cx("⑨读了一个提到 codex-run 的文件不是发起 ⇒ 不入账",
      st([...call("Read", { file_path: "/repo/a.md" }, "1\tnode codex-run.mjs --task t.md\n2\tCODEX_JOB=J1\nCODEX_STATE=done")]), "(未入账)");
    // ⑩ 提示门控与 background_tasks
    const oldBg = [userSay("去审"), ...launchBg(), say("等着。"), userSay("说点别的"), say("好的。")];
    cx("⑩旧轮的「未知」不在新一轮重报", aOf(oldBg), "-");
    cx("⑩对照:同一作业本轮有事件 ⇒ 照报", aOf(oldBg.slice(0, 3)), "A");
    const pend = [userSay("去审"), ...launchDone(), say("收工。")];
    cx("⑩background_tasks=[] 时 codex 待读照样阻断", aOf(pend, { bgTasks: [] }), "A!");
    cx("⑩对照:读回之后 background_tasks=[] 不响", aOf([...pend, ...readR(R, 10, BODY)], { bgTasks: [] }), "-");
    // 零件
    cx("零件:codexNormPath 反斜杠与正斜杠同一", codexNormPath("\\repo\\a\\..\\b.md") === codexNormPath("/repo/./b.md"), true);
    cx("零件:codexNormPath 相对且无 cwd ⇒ null", codexNormPath("a/b.md", null), null);
    cx("零件:codexWords 双引号内反斜杠(bash)保留 Windows 路径", codexWords('cat "\\repo\\x.md"')[1], "\\repo\\x.md");
    cx("零件:codexUnwrapSubst 剥 $( 与收尾括号", codexUnwrapSubst(["out=$(node", "x.mjs", "2>&1)"]).join(" "), "node x.mjs 2>&1");
    cx("零件:codexBlocks 两个 JOB 两块", codexBlocks("CODEX_JOB=a\nCODEX_STATE=done\nCODEX_JOB=b\nCODEX_STATE=running").length, 2);
    const live = liveCodexEnv();
    cx("零件:liveCodexEnv 读不到作业 ⇒ null", live.jobState(`selftest-none-${process.pid}`), null);
    cx("零件:liveCodexEnv 非法 J 不读盘 ⇒ null", live.jobState("../../etc/passwd"), null);
    cx("零件:jobDirs 去重不分盘符大小写(附节二 1)", live.roots([live.root.toUpperCase(), `${live.root}/`]).length, 1);

    // ── 红队 r1 ──
    const readSrc = call("Read", { file_path: "/repo/scripts/hook-stop-closure.mjs" }, "1\t#!/usr/bin/env node\n2\t// 收尾闸");
    cx("BP-1 读被审文件(回件点名它)⇒ 待读", st([...launchDone(), ...readSrc]), "pending-read");
    cx("BP-1 后台变体 ⇒ 待读", st([...launchBg(), ...readSrc], doneEnv), "pending-read");
    const pr = call("Bash", { command: "node scripts/codex-run.mjs --poll J1" }, "CODEX_JOB=J1\nCODEX_STATE=running\nrunning\n");
    cx("BP-2 poll=running 后状态文件 done ⇒ 待读", st([...launchBg(), ...pr], doneEnv), "pending-read");
    cx("BP-2 跨轮也拦", aOf([userSay("审"), ...launchBg(), ...pr, say("先干别的"), userSay("继续"), say("收工")], { codexEnv: doneEnv }), "A!");
    const subst = call("Bash", { command: `out=$(${launchCmd}); echo $out` }, `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\n`);
    cx("BP-3 $() 发起入账 ⇒ 待读", st([...subst], doneEnv), "pending-read");
    cx("BP-3 双引号包的 \"$(…)\" 发起入账", st([...call("Bash", { command: `OUT="$(${launchCmd} 2>&1)"; echo "$OUT"` }, `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\n`)], doneEnv), "pending-read");
    cx("BP-3 跨入口:A 阻断", aOf([userSay("审"), ...subst, say("收工")], { codexEnv: doneEnv }), "A!");
    const TASKN = codexNormPath("clipboard/codex/t.md", CWD);
    const rib = call("Bash", { command: `${launchCmd} --wait-ms 100000`, run_in_background: true },
      "Command running in background with ID: bk1. Output is being written to: C:/Users/x/AppData/Local/Temp/claude/tasks/bk1.output");
    const notif = { type: "user", cwd: CWD, message: { role: "user", content: "<task-notification>\n<task-id>bk1</task-id>\n<status>completed</status>\n</task-notification>" } };
    const findEnv = (state) => ({ ...env0, now: NOW,
      findJob: (q) => (q.task === TASKN && Number.isFinite(q.from) && q.to > q.from) || (q.result && q.result === codexNormPath(R, null))
        ? { id: "J7", state, result: R, startedAt: new Date(T0).toISOString() } : null });
    cx("BP-4 后台发起、反查到 J 且已 done、没读 ⇒ 待读", only([...rib], findEnv("done")), "pending-read");
    cx("BP-4 通知轮:没读回件 ⇒ A 阻断", aOf([userSay("审"), ...rib, say("等"), notif, say("收工")], { codexEnv: findEnv("done"), bgTasks: [{ id: "bk1", status: "completed" }] }), "A!");
    cx("BP-4 反查不到、原生载荷说后台仍在飞 ⇒ 运行中", aOf([userSay("审"), ...rib, say("等着")], { codexEnv: env0, bgTasks: [{ id: "bk1", status: "running" }] }), "-");
    cx("BP-5 tail -1 只剩 CODEX_RESULT ⇒ 反查到 J,待读", only([...call("Bash", { command: `${launchCmd} 2>&1 | tail -1` }, `CODEX_RESULT=${R}\n`)], findEnv("done")), "pending-read");
    cx("BP-5 tail -1 只剩 CODEX_END ⇒ J 入账,待读", st([...call("Bash", { command: `${launchCmd} 2>&1 | tail -1` }, "CODEX_END=J1\n")], doneEnv), "pending-read");
    const rd = call("Bash", { command: `${launchCmd} > outputs/206-codex-run.log 2>&1; echo "exit=$?"` }, "exit=0\n");
    cx("BP-6 重定向发起 ⇒ 反查到 J,待读", only([...rd], findEnv("done")), "pending-read");
    cx("BP-6 跨轮也拦", aOf([userSay("审"), ...rd, say("等"), userSay("继续"), say("收工")], { codexEnv: findEnv("done") }), "A!");
    cx("BP-6 v5:反查不到 ⇒ 未知提示给出按任务名找 J 与「输出里的块会认领」", /按任务名[\s\S]*CODEX_JOB 块被读到时也会认领/.test(codexLedger([...rd], env0).unknown[0] || ""), true);
    const ln = call("Edit", { file_path: "/repo/clipboard/257-progress.md", old_string: "## 进度", new_string: "## 进度\n- 已发 codex 外审:clipboard/codex/t.md" }, "ok");
    const failEnv = (endedAt) => stEnv({ state: "failed", errorCode: "empty-body", error: "x", ...(endedAt ? { endedAt } : {}) });
    cx("BP-7 失败前写的进度笔记不算处理(无 endedAt)", st([...launchBg(), ...ln], failEnv()), "failed-open");
    cx("BP-7 失败前写的进度笔记不算处理(endedAt 晚于笔记)", st([...launchBg(), ...ln], failEnv(new Date(T0 + 86_400_000).toISOString())), "failed-open");
    cx("BP-7 v5:失败之后 Read 日志 ⇒ 已处理", st([...launchBg(), ...call("Read", { file_path: LOGP("J1") }, numbered(["turn.failed"]))], failEnv(new Date(T0).toISOString())), "failed-handled");
    cx("BP-7 v5:失败之后 tail 日志(shell)⇒ 未处理", st([...launchBg(), ...catR(`tail -20 "${LOGP("J1").replace(/\\/g, "/")}"`, "turn.failed\n")],
      failEnv(new Date(T0).toISOString())), "failed-open");
    cx("BP-7 v5:无 endedAt 时失败后 Read 日志也不认(不知何时失败)", st([...launchBg(), ...call("Read", { file_path: LOGP("J1") }, numbered(["turn.failed"]))], failEnv()), "failed-open");
    const shortTask = call("Bash", { command: "cd /repo/clipboard/codex && node ~/.claude/scripts/codex-run.mjs --task t.md" },
      `CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR=x\nCODEX_LOG=${LOGP("J1")}\n`);
    cx("BP-7 短任务名 t.md 不被 report.md 的写冒充", st([...shortTask, ...call("Write", { file_path: "/repo/clipboard/report.md", content: "见 report.md" }, "ok")]), "failed-open");
    cx("BP-7 v5:写动作点名同一任务路径 ⇒ 不再算处理(闭集)", st([...shortTask, ...call("Write", { file_path: "/repo/clipboard/pending.md", content: "补跑 clipboard/codex/t.md" }, "ok")]), "failed-open");
    cx("BP-7/BP4-10 对照:cd 后短任务名失败、在别处按全路径重发同一任务 ⇒ 已处理", st([...shortTask, ...call("Bash", { command: launchCmd },
      `CODEX_JOB=J2\nCODEX_STATE=background\nCODEX_RESULT=${R2}\n`)]), "failed-handled");
    const to = call("Bash", { command: `${launchCmd} --wait-ms 560000` }, "Exit code 143\nCommand timed out after 2m 0s", true);
    cx("BP-8 超时被杀 ⇒ 占位入账(离线未知、提示)", aOf([userSay("审"), ...to, say("超时了,收工")], { codexEnv: {} }), "A");
    cx("BP-8 超时被杀、反查到 done ⇒ A 阻断", aOf([userSay("审"), ...to, say("超时了,收工")], { codexEnv: findEnv("done") }), "A!");
    cx("BP-8 对照:参数错误不是发起", codexLedger([...call("Bash", { command: launchCmd }, "任务文件不存在:clipboard/codex/t.md", true)], {}).jobs.length, 0);
    // BP-9 / BP2-2 / BP3-2 / BP3-6 / CX-5 / BP3-3:子代理边界——自己发车就自己读;运行中也阻断;不设按次数放行
    cx("BP-9 子代理边界:自己发了没读 ⇒ 阻断", sub([...launchDone()], doneEnv), 1);
    cx("BP-9 子代理边界:Read 读回了 ⇒ 不阻断", sub([...launchDone(), ...readR(R, 10, BODY)], doneEnv), 0);
    cx("BP-9 v5 子代理边界:poll 带回 BODY 块 ⇒ 不阻断", sub([...launchBg(), ...pollDone5()], doneEnv), 0);
    cx("BP3-2 子代理边界:后台作业仍在跑就收尾 ⇒ 阻断", sub([...launchBg()], runEnv), 1);
    cx("BP2-2 子代理边界:状态未知 ⇒ 只提示不阻断", sub([...launchBg()], env0), 0);
    const markFb = { type: "user", cwd: CWD, message: { role: "user", content: "SubagentStop hook feedback:\n⟦子代理闸·A 阻断⟧ x" } };
    cx("CX-5/BP3-3 已连阻 3 次仍阻断(不设按次数放行)", sub([...launchDone(), markFb, markFb, markFb], doneEnv), 1);
    cx("BP3-6 子代理只发车、留给主会话读 ⇒ 子代理边界阻断", sub([...launchDone(), say("回件留给主会话读。")], doneEnv), 1);
    const throwing = { ...env0, jobState: () => { throw new Error("盘坏了"); } };
    const safe = subagentCodexSafe([...launchBg()], throwing);
    cx("BP3-4 子代理边界账抛错 ⇒ 点名 A 的 UNKNOWN 行,不静默", safe.block.length === 0 && /A:UNKNOWN/.test(safe.notes.join("")), true);
    // BP3-5:主会话不为子代理代发的作业记账(没有本会话发起,转报里的块无占位可认领)
    const ag = call("Agent", { subagent_type: "general-purpose", prompt: "go" }, [{ type: "text", text: `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}` }]);
    cx("BP3-5 主会话收到子代理转报 ⇒ 不入账、不提示", aOf([userSay("审"), ...ag, say("收工")], { codexEnv: doneEnv }), "-");
    cx("BP2-2 主会话转报跨轮 ⇒ 不提示", aOf([userSay("审"), ...ag, say("收到"), userSay("继续"), say("收工")], { codexEnv: doneEnv }), "-");
    // BP-11 / CX-2:复合命令的输出不推断
    cx("BP-11 v5:cat R && grep(非 0 退出但正文已回显)⇒ 待读", st([...launchDone(), ...catR(`cat ${RF} && grep -n BP- ${RF}`, `Exit code 1\n${FILE}`)]), "pending-read");
    cx("BP-11 对照:非 0 退出且只有报错 ⇒ 待读", st([...launchDone(), ...call("Bash", { command: `cat ${RF}` }, "Exit code 1\ncat: no such file", true)]), "pending-read");
    cx("CX-2 cat R > copy.md; cat other.md(输出含回件标题)⇒ 待读", st([...launchDone(), ...catR(`cat ${RF} > copy.md; cat other.md`, "## 结论\n别的文件内容\n")]), "pending-read");
    cx("CX-2 cat R > copy.md(stdout 去向文件)⇒ 待读", st([...launchDone(), ...catR(`cat ${RF} > copy.md`, "")]), "pending-read");
    // BP-12 / BP2-1 / CX-1 / BP3-1 / BP3-7:委派读不认——子代理返回意译、引用、表格都不是 runner 交付
    const ar = call("Agent", { subagent_type: "Explore", prompt: `读 ${R} 并逐条摘要` }, [{ type: "text", text: "回件结论:甲方对。" }]);
    cx("BP2-1 委派读(意译摘要)⇒ 待读", st([...launchDone(), ...ar]), "pending-read");
    cx("BP2-1 待读消息写明谁发车谁读与 poll / Read 出路", /谁发车谁读[\s\S]*--poll J1[\s\S]*Read/.test(codexLedger([...launchDone(), ...ar], env0).open[0] || ""), true);
    const arQ = call("Agent", { subagent_type: "Explore", prompt: `读 ${R},引用原句` }, [{ type: "text", text: "回件原句:\n甲方说得对,乙方的第二条不成立。" }]);
    cx("BP2-1/CX-1 子代理返回引用回件原句 ⇒ 待读", st([...launchDone(), ...arQ]), "pending-read");
    cx("BP3-1 子代理返回只含表格分隔行 ⇒ 待读", st([...launchDone(), ...call("Agent", { subagent_type: "Explore", prompt: "审别的" }, [{ type: "text", text: "|---|---|---|" }])]), "pending-read");
    cx("BP3-7 发车方自己 Read R、返回是引用块形态 ⇒ 已读回", st([...launchDone(), ...call("Read", { file_path: R }, numbered(BODY.map((l) => `> ${l}`), 10))]), "read");
    // BP-13:empty-body 失败当场返回
    const fl = call("Bash", { command: `${launchCmd} 2>&1 | tail -8` },
      `CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR_CODE=empty-body\nCODEX_ERROR=x\nCODEX_LOG=${LOGP("J1")}\nCODEX_RESULT=${R}\n`);
    cx("BP-13 v5:empty-body 失败后 Read R(只有头)⇒ 不算处理(裁定 v5 第 3 条不含 R)", st([...fl, ...readR(R, 1, HEAD)]), "failed-open");
    cx("BP-13 v5 对照:失败后 Read 日志 ⇒ 失败已处理", st([...fl, ...call("Read", { file_path: LOGP("J1") }, numbered(["turn.failed"]))]), "failed-handled");
    cx("BP-13 对照:失败后什么都没做 ⇒ 失败未处理", st([...fl]), "failed-open");
    // CX-3:失败已处理之后再 poll 一次同一 failed ⇒ 不撤销已处理
    cx("CX-3 已处理后再 poll 到 failed ⇒ 仍失败已处理", st([...fl, ...call("Read", { file_path: LOGP("J1") }, numbered(["turn.failed"])),
      ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1" }, "CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR=x\nfailed x\n", true)]), "failed-handled");
    // BP-14:Grep 工具不算读
    cx("BP-14 Grep 目录搜命中 R ⇒ 待读", st([...launchDone(), ...call("Grep", { pattern: "结论", path: "/repo/clipboard/codex", output_mode: "content" },
      "/repo/clipboard/codex/t-r1.md:10:## 结论")]), "pending-read");
    // BP-15 / BP2-3 / BP3-8:取代删除——旧作业 done 就得读一次
    const r2 = call("Read", { file_path: R2 }, numbered(BODY, 10));
    const e2 = { ...env0, now: NOW, jobState: (J) => (J === "J1" ? { state: "done", result: R } : { state: "done", result: R2 }),
      resultBody: (p) => (codexNormPath(p, null) === codexNormPath(R2, null) ? `${FILE}\n本次为 J1 超时后的重跑。` : FILE) };
    const bg2 = call("Bash", { command: launchCmd }, `CODEX_JOB=J2\nCODEX_STATE=background\nCODEX_RESULT=${R2}\n`);
    cx("BP3-8 重发同任务、新作业读过 ⇒ 旧作业仍待读", st([...launchBg("J1"), ...bg2, ...r2], e2), "pending-read");
    cx("BP-15 新作业 ⇒ 已读回", st([...launchBg("J1"), ...bg2, ...r2], e2, "J2"), "read");
    cx("BP-15/BP2-3 旧作业未读 ⇒ A 阻断", aOf([userSay("审"), ...launchBg("J1"), ...bg2, ...r2, say("收工")], { codexEnv: e2 }), "A!");
    cx("BP3-8 对照:旧回件也读一次 ⇒ 不响", aOf([userSay("审"), ...launchBg("J1"), ...bg2, ...r2, ...readR(R, 10, BODY), say("收工")], { codexEnv: e2 }), "-");
    // BP-16 / BP2-5 / BP4-8 / BP4-10:变量读、awk、Select-String、全围栏 cat ——v5 都是 shell 读法 ⇒ 待读
    cx("BP-16/BP4-10 v5:变量读 r=…; sed \"$r\" ⇒ 待读", st([...launchDone(), ...catR(`r=${RF}; sed -n 1,200p "$r"`, FILE)]), "pending-read");
    cx("BP-16/BP4-8 v5:awk 'NR>8' R ⇒ 待读", st([...launchDone(), ...catR(`awk 'NR>8' ${RF}`, BODY.join("\n"))]), "pending-read");
    cx("BP-16 v5:Select-String ⇒ 待读", st([...launchDone(), ...call("PowerShell", { command: `Select-String -Path ${RF} -Pattern .` }, BODY.join("\n"))]), "pending-read");
    cx("BP-16 对照:cat 被审文件(输出含回件原句)⇒ 待读", st([...launchDone(), ...catR("cat /repo/scripts/x.mjs", BODY.join("\n"))]), "pending-read");
    const FENCED = [...HEAD, "```", "if (r.seq <= job.launchSeq) continue;", "return lines.some(Boolean);", "```"].join("\n");
    cx("BP2-5 v5:全围栏正文 cat R ⇒ 待读;Read R ⇒ 已读回", [st([...launchDone(), ...catR(`cat ${RF}`, FENCED)], { resultBody: () => FENCED }),
      st([...launchDone(), ...readR(R, 1, FENCED.split("\n"))], { resultBody: () => FENCED })].join(), "pending-read,read");
    cx("BP2-5 v5:全围栏正文经 runner BODY 块交付 ⇒ 已读回", st([...launchDone5("J1", FENCED)], { resultBody: () => FENCED }), "read");
    // BP2-4:另交付一律不认
    cx("BP2-4 附件含回件原句 ⇒ 仍待读", st([...launchDone(), ...readA("\\repo\\clipboard\\review-A.md")]), "pending-read");
    // CX-4:后台发起的 .output——v5 只看里面有没有完整 BODY 块(块自带 J,不需绑定)
    const OUTP = "C:/Users/x/AppData/Local/Temp/claude/tasks/bk1.output";
    const outText = `CODEX_JOB=J8\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=J8\n${blk("J8")}`;
    const bgDone = { ...env0, now: NOW, jobState: (J) => (J === "J8" ? { state: "done", result: R, task: "/repo/clipboard/codex/t.md", startedAt: SA } : null) };
    cx("CX-4 Read 后台 .output、含 J8 的机器块与 BODY 块 ⇒ 认领占位、已读回", only([...rib, ...call("Read", { file_path: OUTP }, numbered(outText.split("\n")))], bgDone), "read");
    cx("CX-4 v5:cat 后台 .output(返回含完整 BODY 块)⇒ 已读回", only([...rib, ...catR(`cat "${OUTP}"`, outText)], bgDone), "read");
    cx("CX-4 .output 只有 CODEX_ 字段、没有正文 ⇒ 认领 J8,done 未读 ⇒ 待读", only([...rib,
      ...call("Read", { file_path: OUTP }, numbered(`CODEX_JOB=J8\nCODEX_STATE=done\nCODEX_RESULT=${R}`.split("\n")))], bgDone), "pending-read");
    cx("CX-4 v5:.output 里的 R 正文没有定界(旧 runner)⇒ 认领 J8、待读", only([...rib,
      ...call("Read", { file_path: OUTP }, numbered(`CODEX_JOB=J8\nCODEX_STATE=done\nCODEX_RESULT=${R}\n${FILE}`.split("\n")))], bgDone), "pending-read");
    cx("CX-4 v5 对照:块里的任务与占位不同 ⇒ 不认领,占位仍未知", only([...rib, ...call("Read", { file_path: OUTP }, numbered(outText.split("\n")))],
      { ...bgDone, jobState: (J) => (J === "J8" ? { state: "done", result: R, task: "/repo/clipboard/codex/other.md", startedAt: SA } : null) }), "unknown");
    // tmpdir 一致性:hook 端作业目录与 codex-run 同一算法;hook 自己的目录查不到时按 CODEX_LOG 的目录兜底
    {
      const cr = _codexRunForSelfTest;
      cx("tmpdir:hook 端作业目录 = os.tmpdir()/codex-run-jobs", codexNormPath(live.root, null), codexNormPath(`${os.tmpdir()}/codex-run-jobs`, null));
      if (cr && cr.JOB_ROOT) cx("tmpdir:hook 端作业目录与 codex-run 的 JOB_ROOT 同算法同值", codexNormPath(live.root, null), codexNormPath(cr.JOB_ROOT, null));
      const alt = fs.mkdtempSync(`${os.tmpdir()}/stop-closure-altjobs-`).replace(/\\/g, "/");
      try {
        fs.writeFileSync(`${alt}/JALT1.json`, JSON.stringify({ state: "done", result: R }));
        cx("tmpdir:按 CODEX_LOG 目录兜底查到", (liveCodexEnv().jobState("JALT1", [alt]) || {}).state, "done");
        cx("tmpdir:不给兜底目录 ⇒ 查不到", liveCodexEnv().jobState("JALT1"), null);
        const altLaunch = call("Bash", { command: launchCmd }, `CODEX_JOB=JALT1\nCODEX_STATE=background\nCODEX_LOG=${alt}/JALT1.log\nCODEX_RESULT=${R}\n`);
        cx("tmpdir:账里自动带上 CODEX_LOG 目录 ⇒ done、待读", st([...altLaunch], { ...liveCodexEnv(), since: undefined, resultBody: () => FILE }, "JALT1"), "pending-read");
      } finally { fs.rmSync(alt, { recursive: true, force: true }); }
    }
    // ── r3b 钉(v5 期望):shell 读法一律不推断 ⇒ 待读(预期代价) ──
    cx("r3b 112 实撞原形 v5:sed -n '/^## Q5/,$p' R | head -40 ⇒ 待读", st([...launchDone(), ...catR(`sed -n '/^## 结论/,$p' clipboard/codex/t-r1.md | head -40`, BODY.join("\n"))]), "pending-read");
    cx("r3b v5:cat R | tail -n +9 | cut -c1-900 ⇒ 待读", st([...launchDone(), ...catR(`cat ${RF} | tail -n +9 | cut -c1-900`, BODY.join("\n"))]), "pending-read");
    cx("r3b v5:管道后接 | grep ⇒ 待读", st([...launchDone(), ...catR(`cat ${RF} | grep -v xyz`, BODY.join("\n"))]), "pending-read");
    cx("r3b v5:管道后接 | sort ⇒ 待读", st([...launchDone(), ...catR(`cat ${RF} | sort`, BODY.join("\n"))]), "pending-read");
    cx("r3b 裁剪段重定向到文件(返回为空)⇒ 待读", st([...launchDone(), ...catR(`cat ${RF} | head -40 > copy.md`, "")]), "pending-read");
    cx("r3b v5:cat R; head -5 ⇒ 待读", st([...launchDone(), ...catR(`cat ${RF}; head -5`, FILE)]), "pending-read");
    cx("r3b v5:awk '{print}' R ⇒ 待读", st([...launchDone(), ...catR(`awk '{print}' ${RF}`, FILE)]), "pending-read");
    cx("r3b awk 程序带 > 写文件(返回为空)⇒ 待读", st([...launchDone(), ...catR(`awk '{print > "copy.md"}' ${RF}`, "")]), "pending-read");
    cx("零件:codexUnwrapSubst 不拆引号里带空格的普通参数", codexUnwrapSubst(["sed", "-n", "/^## 结论/,$p", "R.md"]).length, 4);
    // ── 红队 r4(审 d7b56d3)钉,v5 期望 ──
    const RX = "E:/tmp/copy-of-review.md";
    cx("BP4-6 v5:cp R X 之后读 X ⇒ 待读(副本不推断)", st([...launchDone(), ...catR(`cp ${RF} ${RX}`, ""), ...catR(`sed -n 1,200p ${RX}`, FILE)]), "pending-read");
    cx("BP4-6 v5:cp R X 之后 Read X ⇒ 待读(只认 Read R 本身)", st([...launchDone(), ...catR(`cp ${RF} ${RX}`, ""), ...readR(RX)]), "pending-read");
    cx("BP4-6 对照:读一个不是 R 副本的文件 ⇒ 待读", st([...launchDone(), ...catR(`sed -n 1,200p E:/tmp/other.md`, FILE)]), "pending-read");
    cx("BP4-6 v5:复合读 wc -c R; sed | cut ⇒ 待读", st([...launchDone(), ...catR(`cd /repo; wc -c ${RF}; sed -n 1,12p ${RF} | cut -c1-120`, `7961 ${RF}\n${FILE}`)]), "pending-read");
    cx("BP4-6 v5:复合读 ls | grep; echo; sed ⇒ 待读", st([...launchDone(), ...catR(`ls clipboard/codex | grep t-r1; echo ===; sed -n 1,80p ${RF}`, `t-r1.md\n===\n${FILE}`)]), "pending-read");
    cx("BP4-5 部分读:Read R 只回两行 ⇒ 已读回(残余②)", st([...launchDone(), ...readR(R, 10, BODY.slice(1, 3))]), "read");
    cx("BP4-5 v5:Read R 只回一行 ⇒ 已读回(Read R 成功即算)", st([...launchDone(), ...readR(R, 10, BODY.slice(1, 2))]), "read");
    cx("BP4-9 v5:cat -n R | sed / head -n -2 R ⇒ 待读", [st([...launchDone(), ...catR(`cat -n ${RF} | sed 's/^/  /'`, numbered(BODY))]),
      st([...launchDone(), ...catR(`head -n -2 ${RF}`, FILE)])].join(), "pending-read,pending-read");
    cx("BP4-9 v5:PowerShell & Get-Content R ⇒ 待读", st([...launchDone(), ...call("PowerShell", { command: `& { Get-Content '${RF}' }` }, FILE)]), "pending-read");
    // BP4-1 / BP4-7:运行中的出路是 --poll J --wait-ms,done 时正文随结果打出
    cx("BP4-1 子代理边界运行中的阻断消息写明 --poll J --wait-ms 与退出码 3", /--poll J1 --wait-ms 600000[\s\S]*退出码 3/.test(subagentCodexVerdict([...launchBg()], runEnv).block.join("")), true);
    cx("BP4-7 v5:poll --wait-ms 等到 done、返回带 BODY 块 ⇒ 子代理边界不再阻断", sub([...launchBg(), ...pollDone5("J1", FILE, pollCmd("J1", " --wait-ms 600000"))], runEnv), 0);
    // BP4-2:终态不被之后无法归属的 poll 改写
    cx("BP4-2 done 之后一条无法归属的 poll ⇒ 仍是已产出待读", st([...launchDone(),
      ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1; node scripts/codex-run.mjs --poll J2" }, "running\ndone E:/x.md\n")]), "pending-read");
    cx("BP4-2 running 不覆盖 failed", st([...launchBg(), ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1" }, "CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR=x\nfailed x\n", true),
      ...call("Bash", { command: "node scripts/codex-run.mjs --poll J1" }, "CODEX_JOB=J1\nCODEX_STATE=running\nrunning\n")], stEnv(null)), "failed-open");
    // BP4-3:一条后台命令并发两次发车 ⇒ 两个占位;.output 里两个 CODEX_JOB 块各认领一个
    const two = `CODEX_JOB=J8\nCODEX_STATE=done\nCODEX_RESULT=${R}\nCODEX_END=J8\nCODEX_JOB=J9\nCODEX_STATE=done\nCODEX_RESULT=${R2}\nCODEX_END=J9\n`;
    cx("BP4-3 .output 里两个 CODEX_JOB 块(无正文)⇒ 两笔都入账、都待读", codexLedger([...twoBg, ...call("Read", { file_path: "C:/x/tasks/bk4.output" }, numbered(two.split("\n")))], { ...env0, now: NOW })
      .jobs.map((j) => `${j.label}:${j.status}`).sort().join(), "J8:pending-read,J9:pending-read");
    cx("BP4-3 v5:两个占位按状态文件任务各认领各的", codexLedger([...twoBg, ...call("Read", { file_path: "C:/x/tasks/bk4.output" }, numbered(two.split("\n")))],
      { ...env0, now: NOW, jobState: (J) => ({ state: "done", result: J === "J8" ? R : R2, task: J === "J8" ? "/repo/clipboard/codex/b.md" : "/repo/clipboard/codex/a.md", startedAt: SA }) })
      .jobs.map((j) => `${j.id.slice(-2)}:${j.label}`).sort().join(), "#0:J9,#1:J8");
    // BP4-4:重定向发车,之后 poll / 读到本账没有的 J ⇒ 认领占位
    const redir = call("Bash", { command: `${launchCmd} > outputs/x.log 2>&1` }, "");
    const claimEnv = { ...env0, jobState: (J) => (J === "J5" ? { state: "done", result: R, task: "/repo/clipboard/codex/t.md", startedAt: SA } : null) };
    const one = (entries, env) => { const j = codexLedger(entries, env).jobs; return j.length === 1 ? `${j[0].label}:${j[0].status}` : `${j.length} 笔`; };
    cx("BP4-4 重定向发车后 poll J5(无 BODY)⇒ 认领占位、done 未读 ⇒ 待读",
      one([...redir, ...call("Bash", { command: "node scripts/codex-run.mjs --poll J5" }, `CODEX_JOB=J5\nCODEX_STATE=done\nCODEX_RESULT=${R}\ndone ${R}\n`)], claimEnv), "J5:pending-read");
    cx("BP4-4 v5:重定向发车后 poll J5 带 BODY 块 ⇒ 认领并已读回", one([...redir, ...pollDone5("J5")], claimEnv), "J5:read");
    cx("BP4-4 旧 runner 的 poll J5(只有末行 done)有状态文件 ⇒ 认领占位、待读", one([...redir, ...call("Bash", { command: "node scripts/codex-run.mjs --poll J5" }, `done ${R}\n`)], claimEnv), "J5:pending-read");
    cx("BP4-4 重定向文件被读到、带 CODEX_JOB 块 ⇒ 认领 J(离线)", one([...redir, ...catR("cat outputs/x.log", `CODEX_JOB=J6\nCODEX_STATE=done\nCODEX_RESULT=${R}\n`)], env0), "J6:pending-read");
    cx("BP4-4 v5 变异对照:块里的 J 在生产态查不到台账 ⇒ 不认领,占位仍无主", (() => { const j = codexLedger([...redir,
      ...catR("cat notes.md", `CODEX_JOB=J6\nCODEX_STATE=done\nCODEX_RESULT=${R}\n`)], { ...env0, jobState: () => null }).jobs; return j.length === 1 && j[0].id.startsWith("@") && j[0].label.startsWith("codex 作业"); })(), true);
    // v4 (b) 的「零特征行读头即算」随特征行一起删除:v5 Read R 成功即算
    cx("v5 回件只回「无发现」⇒ Read R 即已读回", st([...launchDone(), ...readR(R, 1, [...HEAD, "无发现"])], { resultBody: () => [...HEAD, "无发现"].join("\n") }), "read");
    cx("v5 回件只回「无发现」⇒ runner BODY 块即已读回", st([...launchDone5("J1", [...HEAD, "无发现"].join("\n"))], { resultBody: () => [...HEAD, "无发现"].join("\n") }), "read");
    // 回放实撞(某会话):`until … --poll J | grep -q …; do sleep; done; … --poll J | tail -1` 是同一个 J ⇒ 照常归属
    cx("回放 同一命令里两次 poll 同一个 J ⇒ 照常归属,得到结果路径后 Read 读回", st([...call("Bash", { command: `${launchCmd} 2>&1 | tail -1` }, "CODEX_END=J1\n"), ...call("Bash",
      { command: `until node codex-run.mjs --poll J1 | grep -qE "^done"; do sleep 20; done; node codex-run.mjs --poll J1 | tail -1` }, `done ${R}\n`),
      ...readR(R, 10, BODY)], stEnv(null)), "read");
    // 回放实撞(某会话):`--poll $(grep …)` 剥壳得 `grep`,无台账 ⇒ 不认领占位
    cx("回放 --poll $(grep …) 不把 grep 当 J 认领占位", (() => { const j = codexLedger([...redir,
      ...call("Bash", { command: "node scripts/codex-run.mjs --poll $(grep -o J5 outputs/x.log)" }, "done E:/x.md\n")], { ...env0, jobState: () => null }).jobs;
      return j.length === 1 && j[0].label !== "grep" && j[0].id.startsWith("@"); })(), true);
    cx("回放 v5 对照:--poll $(grep …) 的返回带真 J5 的块 ⇒ 按块认领 J5", one([...redir,
      ...call("Bash", { command: "node scripts/codex-run.mjs --poll $(grep -o J5 outputs/x.log)" }, `CODEX_JOB=J5\nCODEX_STATE=done\nCODEX_RESULT=${R}\ndone ${R}\n`)], claimEnv), "J5:pending-read");
    // BP4-10:cd 取第一个非旗标参数,不取最后一个词(经「同任务重发」验)
    cx("BP4-10 cd X 2>/dev/null && 发车 ⇒ 任务路径按 X 解,同路径重发算处理", st([
      ...call("Bash", { command: "cd /repo/clipboard/codex 2>/dev/null && node ~/.claude/scripts/codex-run.mjs --task t.md" }, `CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR=x\n`),
      ...call("Bash", { command: launchCmd }, `CODEX_JOB=J2\nCODEX_STATE=background\nCODEX_RESULT=${R2}\n`)]), "failed-handled");
    cx("BP4-10 变异对照:cd 到别处后同名短任务 ⇒ 不是同一任务", st([
      ...call("Bash", { command: "cd /repo/other 2>/dev/null && node ~/.claude/scripts/codex-run.mjs --task t.md" }, `CODEX_JOB=J1\nCODEX_STATE=failed\nCODEX_ERROR=x\n`),
      ...call("Bash", { command: launchCmd }, `CODEX_JOB=J2\nCODEX_STATE=background\nCODEX_RESULT=${R2}\n`)]), "failed-open");
    // BP4-11:子代理边界的「未知」提示本轮门控
    cx("BP4-11 子代理:旧轮的未知不再提示", subagentCodexVerdict([userSay("审"), ...launchBg(), say("等"), userSay("继续"), say("收尾")], env0).notes.length, 0);
    cx("BP4-11 对照:本轮的未知照提示", subagentCodexVerdict([userSay("审"), ...launchBg(), say("等")], env0).notes.length, 1);
    // BP4-12:bash -c 内层、Monitor 发车都入账
    cx("BP4-12 bash -c 内层发车 ⇒ 入账、待读", st([...call("Bash", { command: `bash -c "${launchCmd}"` }, `CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=${R}\n`)]), "pending-read");
    cx("BP4-12 Monitor 发车 ⇒ 占位入账,反查到 done ⇒ 待读", only([...call("Monitor", { command: `${launchCmd} --wait-ms 600000`, description: "x" }, "Monitor started")], findEnv("done")), "pending-read");
    // BP4-13:子代理转录超预算 ⇒ A 只读尾段
    {
      const tdir = fs.mkdtempSync(`${os.tmpdir()}/stop-closure-tail-`);
      try {
        const p = `${tdir}/agent.jsonl`;
        const rows = [{ type: "user", message: { content: "x".repeat(5000) } }, ...launchDone()];
        fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        const tail = readTranscriptTail(p, 2000);
        cx("BP4-13 readTranscriptTail 只取尾段、残行跳过", tail.length, 2);
        cx("BP4-13 尾段上的 A 账照样阻断", sub(tail, doneEnv), 1);
      } finally { fs.rmSync(tdir, { recursive: true, force: true }); }
    }
    // 头注 6:STOP_CLOSURE_BLOCK_A=0 子代理边界同样生效(注入同一开关)
    const offV = subagentCodexVerdict([...launchDone()], { ...doneEnv, blockOff: true });
    cx("STOP_CLOSURE_BLOCK_A=0:子代理边界阻断降为提示并写明", offV.block.length === 0 && /STOP_CLOSURE_BLOCK_A=0/.test(offV.notes.join("")), true);
    // r1 附节二 5 / 3
    cx("附节二5 v5:rg -L / grep -L 都是 shell 读法 ⇒ 待读", [st([...launchDone(), ...catR(`rg -L 结论 ${RF}`, FILE)], {}),
      st([...launchDone(), ...catR(`grep -L 结论 ${RF}`, RF)], {})].join(), "pending-read,pending-read");
    const anonE = [userSay("审"), ...call("Bash", { command: `${launchCmd} > /tmp/x.log 2>&1` }, ""), say("收工")];
    const anonF = run(null, { entries: anonE, turn: lastTurn(anonE), text: "x", codexEnv: {} }).find((x) => x.id === "A");
    const anonMsg = anonF ? (Array.isArray(anonF.msg) ? anonF.msg.join(" ") : String(anonF.msg)) : "";
    cx("附节二3 无主作业的 A 提示不给挂不上的「poll 一次」", /poll 一次/.test(anonMsg), false);
    cx("附节二3 v5:无主作业的 A 提示给出按任务名找 J(重定向文件不再单独推断)", /按任务名/.test(anonMsg) && anonMsg.includes("clipboard/codex/t.md"), true);
  }

  // ── ranProbe 的回归守卫:正确性 + **不许再变成灾难性回溯** ──────────────────
  // 2026-08-20 实撞:原式 `(?:[^"]|\\")*` 在 400KB 上要 16.7 秒,而 hook 超时 30 秒、
  //   **被超时杀死的 hook 不阻断** ⇒ 一次长工具输出就能静默关掉整道闸。
  //   而那条式子本身是为修「带引号路径漏判」而写的——修一个漏判换来一个全局关闭开关。
  //   故这里两侧都钉死:引号路径必须仍认,且 400KB 必须在 1 秒内跑完。
  let probePass = 0, probeTotal = 0;
  {
    const cs = [
      [String.raw`{"command":"node --no-warnings scripts/verify-laws.mjs"}`, true, "裸路径探针"],
      [String.raw`{"command":"node --no-warnings \"E:/x/scripts/verify-claims.mjs\""}`, true, "带引号路径(08-19 漏判的那个)"],
      [String.raw`{"command":"node -e \"console.log(1)\""}`, false, "普通 node 一行不算探针"],
      // D69(2026-08-27 proj-a 实况):非 node 运行时的探针
      [String.raw`{"command":"cd /d/proj-b && python tests/probe_rate1_determinism.py; echo x"}`,
        true, "python 探针(旧式不认 ⇒ 一句有退出码兜底的话被 E0 误拦)"],
      [String.raw`{"command":"python3 scripts/verify_x.py"}`, true, "python3 整词"],
      // 词界两侧都要钉:放宽运行时表最容易顺手把词界一起放松,那是 fail-open。
      [String.raw`{"command":"pythonic-tool --check"}`, false, "pythonic 不是 python(后界)"],
      [String.raw`{"command":"/opt/mypython verify.py"}`, false, "mypython 不是 python(前界)"],
      [String.raw`{"command":"nodemon --watch check.js"}`, false, "nodemon 不是 node(D7 旧钉,重构后须仍红)"],
      [String.raw`{"command":"/usr/bin/nodejs scripts/verify-laws.mjs"}`, true, "nodejs 整词(092 旧钉)"],
      [String.raw`{"command":"bin/mynode --verify"}`, false, "mynode 不是 node(D7 旧钉)"],
      [String.raw`{"command":"node app.mjs"} {"command":"grep check foo"}`, false, "node 与关键词在不同命令里"],
      [String.raw`{"command":"node a.mjs"}{"file_path":"docs/check-list.md"}`, false, "关键词在别的工具入参里"],
      // ⚠️ 阈值两侧都要钉(codex 复核:「400 与 200KB 都是无业务依据的硬阈值,
      //   而测试没钉住阈值边界、shell 续行、引号内分隔符及反斜杠奇偶」)。
      //   阈值可以拍,但拍完必须让它**可见**:改了阈值就有用例转红,而不是悄悄改变行为。
      ["node " + "a".repeat(PROBE_WINDOW - 20) + " verify", true, `窗口内(${PROBE_WINDOW - 20} 字符处)仍认`],
      ["node " + "a".repeat(PROBE_WINDOW + 50) + " verify", false, `窗口外(${PROBE_WINDOW + 50} 字符处)不认——阈值本身被钉住`],
      ["node --no-warnings \\\n  scripts/verify-laws.mjs", true, "shell 续行接得回来(codex 给的漏判)"],
      // ── D7:node 段逐一验(2026-08-23,朴素切段残余)──────────────────
      [String.raw`{"command":"nodemon --watch scripts/check.js"}`, false, "D7:nodemon 不是 node,子串过配不白给豁免"],
      [String.raw`{"command":"bin/mynode scripts/verify.mjs"}`, false, "D7:mynode 前缀同上"],
      [String.raw`{"command":"node.exe scripts/verify-laws.mjs"}`, true, "D7:node.exe 仍认(边界修法不误伤 Windows 形态)"],
      [String.raw`{"command":"node scripts/a.mjs & grep verify log"}`, false, "D7:单 & 是段界,关键词在别段不归 node"],
      [String.raw`{"command":"nodejs scripts/check.mjs"}`, true, "D7:nodejs 整词仍认(codex 092:Debian 官方包形态)"],
    ];
    for (const [inp, want, why] of cs) {
      probeTotal++;
      const got = ranProbe(inp);
      console.log(`${got === want ? "PASS" : "FAIL"}  ranProbe:${why}  期待=${want} 实得=${got}`);
      if (got === want) probePass++;
    }
    probeTotal++;
    const load = "node abcdefghij ".repeat(Math.floor(400 * 1024 / 14));
    const t0 = Date.now(); ranProbe(load); const ms = Date.now() - t0;
    const fast = ms < 1000;
    console.log(`${fast ? "PASS" : "FAIL"}  ranProbe:400KB 不得灾难性回溯(实测 ${ms}ms,上限 1000ms;旧式 16716ms)`);
    if (fast) probePass++;
  }

  // ── 逃生口对账:凡阻断项,`emit()` 印出的关闭开关必须真的能关 ────────────────
  // 2026-08-20 grill:architecture 5.3 实测:引擎的 Q 是 `blocking: true`,
  //   却不在 `BLOCK_OFF` 里 ⇒ `BLOCK_OFF["Q"] ?? true` 恒 true
  //   ⇒ **闸消息里印的 `STOP_CLOSURE_BLOCK_Q=0` 敲了不起作用**。
  //   这是「阻断项留纯文本出路」的镜像:一条看起来存在、实际不存在的出路。
  //   根因:`BLOCK_OFF` 手工枚举 × 引擎 `blocking` 声明式,两者之间没有对账
  //   —— 正是 gate-registry 头注号称已消灭的「新增 block:true 没进开关链」在逃生口这一侧复发。
  // 本检查让下一条迁进来的阻断规则**不可能**再踩:漏填即转红。
  let escPass = 0, escTotal = 0;
  // ⚠️ **本检查 2026-08-20 被 grill:architecture P6 判为查错了半边**:
  //   它只验「BLOCK_OFF 里有这个键」,**从不验 `emit()` 印出来的那个串指向的就是这个键**。
  //   于是 K0/E2 双双 PASS,而闸印给人的 `STOP_CLOSURE_BLOCK_K0=0` 根本没人读。
  //   ——「下一条迁进来的阻断规则不可能再踩」这句话,在低一层不成立。
  //   现在两边都从 `BLOCK_ENV` 派生,并**逐条验派生关系**,不再只数键。
  for (const r of RULES.filter((x) => x.blocking)) {
    escTotal++;
    // P **无逃生口是用户裁定的刻意设计**(「P:无逃生口」印在放行 footer 里),
    //   在此注册为例外——它不在两表里是**对**的,缺席即 PASS(D39 结案:那格红=例外没登记)。
    const NO_ESCAPE = new Set(["P"]);
    const hasKey = Object.prototype.hasOwnProperty.call(BLOCK_OFF, r.id);
    const hasEnv = Object.prototype.hasOwnProperty.call(BLOCK_ENV, r.id);
    const ok = NO_ESCAPE.has(r.id) ? (!hasKey && !hasEnv) : (hasKey && hasEnv);
    console.log(`${ok ? "PASS" : "FAIL"}  逃生口对账:${r.id} 键与印出的开关同源` +
      (ok ? "" : `  ← ${!hasKey ? "**BLOCK_OFF 无此键,印出的开关是假的**" : "**BLOCK_ENV 无此键,印不出正确开关名**"}`));
    if (ok) escPass++;
  }
  // 反向:BLOCK_OFF 里有、BLOCK_ENV 里没有的键 ⇒ 那条规则一旦阻断就印不出正确开关名
  for (const id of Object.keys(BLOCK_OFF)) {
    escTotal++;
    const ok = Object.prototype.hasOwnProperty.call(BLOCK_ENV, id);
    console.log(`${ok ? "PASS" : "FAIL"}  逃生口对账(反向):${id} 在 BLOCK_ENV 里有键`);
    if (ok) escPass++;
  }

  // ── 接缝用例:47 条里**没有一条**能区分「引擎权威」与「回退旧实现」──────────
  // 2026-08-20 grill:architecture 5.1 实测:`--self-test` 开着关着都是 47/47,
  //   §3 并行 diff 是引擎跟自己比,唯一有鉴别力的 §4 影子流量**不经过缝**
  //   ⇒ **`run()` 里那 16 行缝,从落地起没有任何自动化判据在看它**。
  //   47 条用例**全部**走 `run(tmp)` 这个只给路径的形态,而生产主路径是
  //   `run(path, { text: merged, turn, bgTasks })` —— **那个形态零覆盖**,
  //   于是「缝丢掉 ctx.text」这个 live bug 一直没人发现。
  let seamPass = 0, seamTotal = 0;
  {
    const sc = (name, got, want) => {
      seamTotal++;
      const ok = got === want;
      console.log(`${ok ? "PASS" : "FAIL"}  接缝:${name}${ok ? "" : `  ← 期待 ${want} 实得 ${got}`}`);
      if (ok) seamPass++;
    };
    const ids = (fs2) => fs2.map((f) => f.id + (f.block ? "!" : "")).sort().join(",");

    // ── D71 回显钉(2026-08-27,proj-a 实况)────────────────────────────────
    // 因果族先把引文抹成空格再判,但**回显必须取原文**。缺了这条钉,
    // 有人把 `matchAny` 的第三参去掉、或把 `maskQuoted` 改回不等长,测试照样全绿,
    // 而闸会退回「拦得住但说不清拦的是什么」——实况原样:
    //   「是因为 会让你在 和 之间反复权衡」(引文里的名词全没了)。
    {
      const raw = "不是因为技术——是因为「装 QQNT」会让你在「本地」和「服务器」之间反复权衡。";
      const e0 = RULES.find((r) => r.id === "E0");
      const shown = e0.detect({
        text: raw, actions: [], toolNames: [], skills: [], ranBash: () => false,
      }).join(" ");
      sc("E0 回显保留引文(不拿掩码文本当回显)", shown.includes("「装 QQNT」"), true);
      // 反向钉:判据本身仍跑在掩码上——引文内的因果词不得单独把整句咬出来。
      const quotedOnly = e0.detect({
        text: "问题一句话:「根因是缓存没刷新」。拿它当搜索键扫了三层。",
        actions: [], toolNames: [], skills: [], ranBash: () => false,
      });
      sc("引文内的因果仍不命中(掩码没白做)", quotedOnly.length, 0);
      // 掩码的两条硬性质:等长 + 保行。行号对不上则回显会串行(比抹掉更坏)。
      const ml = "前「跨\n行引文」后";
      sc("maskQuoted 等长", maskQuoted(ml).length, ml.length);
      sc("maskQuoted 保行", maskQuoted(ml).split("\n").length, ml.split("\n").length);

      // D74:R 的回声。引用被拦的原词来**更正**它,更正本身不得再被拦。
      const echoFix = "说了「工具面已扫」,那是转述 D59 台账里批 110 的记载,不是本轮动作。";
      sc("R 不咬更正句里的引文", ids(run(null, { text: echoFix, turn: [] })).includes("R!"), false);
      // 反向钉:引文外的裸完成陈述照拦,否则等于把 R 关掉。
      sc("R 仍拦引文外的裸完成陈述",
        ids(run(null, { text: "工具面已扫,三层都看过了。", turn: [] })).includes("R!"), true);

      // D73:W 的**消息**必须列全法条给的三条通道。旧文案只写子代理一条,
      //   并把「计数不另计」写成「通道不可用」⇒ 照消息找出路会得出错结论(我本人撞过)。
      //   鉴别力:旧文案里既无 `codex-run.mjs` 也无 `battle`,恢复旧文即变红。
      const wMsg = RULES.find((r) => r.id === "W").message(["测试交付物"]);
      sc("W 消息列出 codex 通道", /codex-run\.mjs/.test(wMsg), true);
      sc("W 消息列出 battle 通道", /battle/.test(wMsg), true);
      sc("W 消息不把「不另计数」说成「通道不可用」",
        /不在本项(?![^\n]*不另计)/.test(wMsg), false);

      // ── D56 回归钉(2026-08-27):`preExisted` 是**写之前实测**的注入面。
      //   两侧都要钉:①有记录 ⇒ 不算新建(消除 memory 面的系统性误报);
      //   ②**没记录仍算新建** ⇒ 不开漏放口(2026-08-26 那版正是在这一侧塌的:
      //   它从 transcript 猜「第一个写动作是 Edit ⇒ 已存在」,可被绕过)。
      const memP = "C:/Users/x/.claude/projects/example-project/memory/MEMORY.md";
      const mkNew = (pre) => buildCtx(
        [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: memP } }] } }],
        { tracked: new Set(["scripts/x.mjs"]), ...(pre ? { preExisted: new Set([memP]) } : {}) });
      sc("D56 有 precheck 记录 ⇒ 不算新建", mkNew(true).isNew(memP), false);
      sc("D56 无 precheck 记录 ⇒ 仍算新建(不开漏放口)", mkNew(false).isNew(memP), true);
      // ── 批 255:isNew 生产证据(`isNewEvidence`)——主 Stop 与 SubagentStop 共用 ─────────────
      {
        const ev = isNewEvidence(undefined);
        // ③ SubagentStop 缺证据的钉:共用函数交出的 tracked 必须是非空 Set(原分支拿到的是 undefined)
        sc("255③ isNewEvidence 交出非空 tracked", ev.tracked instanceof Set && ev.tracked.size > 0, true);
        sc("255③ isNewEvidence 交出 checkoutOf/trackedIn", typeof ev.checkoutOf === "function" && typeof ev.trackedIn === "function", true);
        // ③ 接线钉:SubagentStop 分支必须经 isNewEvidence 构造 ctx(退回旧的 `{ tracked: _trackedCache … }` 即红)
        const srcSelf = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
        // lastIndexOf:本行自己的字面量也含这串,分支本体在文件末尾那一处
        const subIdx = srcSelf.lastIndexOf('if (hookInput.hook_event_name === "SubagentStop") {');
        const subBody = subIdx < 0 ? "" : srcSelf.slice(subIdx, srcSelf.indexOf("runRules(", subIdx));
        sc("255③ SubagentStop 分支经 isNewEvidence 取证", /buildCtx\(entries,\s*isNewEvidence\(/.test(subBody), true);
        // checkoutOfFs:逐级上溯找 .git(假 exists,不碰磁盘)
        const fake = (set) => (q) => set.has(q);
        const tree = fake(new Set(["E:/r/.git", "E:/r/.claude/worktrees/w1/.git"]));
        sc("255 checkoutOfFs:worktree 内文件 ⇒ worktree 根", checkoutOfFs("E:\\r\\.claude\\worktrees\\w1\\docs\\a.md", tree), "E:/r/.claude/worktrees/w1");
        sc("255 checkoutOfFs:主树文件 ⇒ 主树根", checkoutOfFs("E:/r/docs/a.md", tree), "E:/r");
        sc("255 checkoutOfFs:新目录下的新文件 ⇒ 仍上溯到根", checkoutOfFs("E:/r/.claude/worktrees/w1/new/deep/x.md", tree), "E:/r/.claude/worktrees/w1");
        sc("255 checkoutOfFs:相对路径 ⇒ null(走原判据)", checkoutOfFs("scripts/x.mjs", tree), null);
        sc("255 checkoutOfFs:无 .git ⇒ null", checkoutOfFs("C:/elsewhere/x.md", tree), null);
        // 真 git:本进程 cwd 所在 checkout 的既有文件,用 cwd 绝对路径问 ⇒ 非新建
        //   (在 worktree 里跑时这正是批 253 实撞形:原判据经 relOf 剥成 `.claude/worktrees/…` ⇒ 判新建)
        const own = `${process.cwd().replace(/\\/g, "/")}/scripts/hook-stop-closure.mjs`;
        sc("255 真 git:trackedInFs 含本文件(--full-name 仓根相对)", (trackedInFs(checkoutOfFs(own)) || new Set()).has("scripts/hook-stop-closure.mjs"), true);
        sc("255 真 git:cwd 绝对路径下的既有文件 ⇒ 非新建", buildCtx([], ev).isNew(own), false);
      }
      // ── D100 消费者侧(codex 复核 2026-09-06「你没问到」①):按会话、按路径**首笔**。
      //   台账改道临时文件;探完把缓存与环境变量复原,不影响本进程后面的真读取。
      {
        // 本文件不 import os/path(刻意保持 import 面不变),临时文件走环境变量拼路径
        const tmp = `${process.env.TEMP || process.env.TMPDIR || process.env.TMP || "."}/gate-precheck-reader-selftest-${process.pid}.jsonl`;
        const rows = [
          { ts: "1", sid: "S", path: "scripts/new181.mjs", existed: false },     // 本会话首次创建前:不存在
          { ts: "2", sid: "S", path: "scripts/new181.mjs", existed: true },      // 第二次追加前:存在(不得覆盖首笔)
          { ts: "3", sid: "OTHER", path: "scripts/old.mjs", existed: true },     // 别的会话的记录
          { ts: "4", sid: "S", path: "C:/u/.claude/projects/example-project/memory/m.md", raw: "~/.claude/projects/example-project/memory/m.md", existed: true },
          { ts: "5", sid: "S", path: "scripts/old2.mjs", existed: true },       // D104(b):先存在……
          { ts: "6", sid: "S", path: "scripts/old2.mjs", existed: false },      // ……rm 后重建前不存在 ⇒ 本会话新建
        ];
        fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        const saveEnv = process.env.GATE_CARRIER_PRECHECK_FILE, saveCache = _preExistedCache;
        process.env.GATE_CARRIER_PRECHECK_FILE = tmp;
        _preExistedCache = undefined; const mine = preExistedSet("S");
        _preExistedCache = undefined; const none = preExistedSet(undefined);
        _preExistedCache = undefined; const stranger = preExistedSet("NOBODY");
        if (saveEnv === undefined) delete process.env.GATE_CARRIER_PRECHECK_FILE; else process.env.GATE_CARRIER_PRECHECK_FILE = saveEnv;
        _preExistedCache = saveCache;
        try { fs.rmSync(tmp, { force: true }); } catch {}
        sc("D100 消费者:本会话首笔 false ⇒ 后续 true 不算已存在", mine.has("scripts/new181.mjs"), false);
        sc("D104(b) 消费者:先 true 后 false(rm+重建)⇒ 判新建", mine.has("scripts/old2.mjs"), false);
        sc("D100 消费者:别的会话的 true 不进本会话集合", mine.has("scripts/old.mjs"), false);
        sc("D100 消费者:raw 原形随首笔一起收", mine.has("~/.claude/projects/example-project/memory/m.md") && mine.has("C:/u/.claude/projects/example-project/memory/m.md"), true);
        sc("D100 消费者:无 sid ⇒ 退回全量旧口径(首笔仍生效)", none.has("scripts/old.mjs") && !none.has("scripts/new181.mjs"), true);
        sc("D100 消费者:本会话零记录 ⇒ 退回全量旧口径", stranger.has("scripts/old.mjs"), true);
      }
    }

    // ⚠️ 核心回归:transcript 读不到(turn=[])、只有官方 last_assistant_message 的形态。
    //   那一刻正是官方字段存在的全部理由,而缝原来在那一刻是瞎的。
    // ⚠️ 切换后(2026-08-22 亲签)对照组已死,这三条测试的**目标换了**:
    //   原来验「引擎与旧实现一致」;现在旧实现不存在,改验引擎自身的两条硬性质——
    //   官方字段可见性(立法动机原样保留)与 engine:false 的**退役语义**。
    const t1 = "根因是缓存没刷新。这三件留给下次做。";
    const on1 = ids(run(null, { text: t1, turn: [] }));
    sc("transcript 读不到时,引擎看得见官方文本(E0/Q 照拦)", on1.includes("E0!") && on1.includes("Q!"), true);
    sc("且确实拦住了(不是两边都空)", on1.includes("E0!") && on1.includes("Q!"), true);

    // 末句只在 last_assistant_message 里(transcript 在但落后)⇒ 引擎必须看得见
    const t2 = "开始干活\n根因是缓存没刷新";
    sc("末句只在官方字段里也看得见",
      ids(run(null, { text: t2, turn: [{ type: "assistant", message: { content: [{ type: "text", text: "开始干活" }] } }] })).includes("E0!"), true);

    // 切换后 engine:false 的语义 = **只剩未迁原生规则**(A/R 族),引擎 21 条一律不产出。
    //   它若还能产出引擎 id,说明内联尸体没删干净。
    sc("engine:false 退役后不再产出引擎 id",
      ids(run(null, { text: t1, turn: [], engine: false })).split(",").filter((x) => x && !/^(A|R|ENGINE)/.test(x)).length === 0, true);

    // ⚠️ **catch 自身不可二次崩溃**(2026-08-22 codex 故障注入逮到后修的,三形态全钉):
    //   ① RULES[0]=null(重算 .id 抛)② 元素 Proxy 一律 throw null ③ 错误对象自身不可读。
    //   修前:三者全部逃逸进外层 main catch 的 fail-open 路 ⇒ exit 0 放行,
    //   「引擎崩溃一律阻断」的全称承诺被打穿。double-fault handler 不得自己 fault。
    {
      const saved = RULES[0];
      const inject = (v) => { RULES[0] = v; try { return ids(run(null, { text: "x", turn: [] })); } catch { return "ESCAPED"; } finally { RULES[0] = saved; } };
      sc("引擎崩(规则表坏)⇒ ENGINE 阻断不逃逸", inject(null).includes("ENGINE!"), true);
      sc("引擎崩(throw null 形态)⇒ 同上", inject(new Proxy({}, { get() { throw null; } })).includes("ENGINE!"), true);
      sc("引擎崩(错误对象不可读)⇒ 同上", inject(new Proxy({}, { get() { throw new Proxy({}, { get() { throw null; } }); } })).includes("ENGINE!"), true);
    }

    // ⚠️ **未迁条目在引擎接管下必须原样阻断**(2026-08-20 用户提出「A 走原来阻断,
    //   其他一律迁引擎」后钉的)。缝是**按条**的:`kept` 只滤掉 `RULES` 里有的 id,
    //   `A` 不在其中 ⇒ 旧实现的 A 照常跑、照常阻断。
    //   钉它是因为**真风险不是它会坏,是它会被「打扫」**——将来有人看见 A 孤零零留在
    //   旧文件里,当成迁移漏网的残渣删掉,而全语料影子比对**发现不了**
    //   (那个台子比的是「新旧是否一致」,两边一起没有就是一致)。
    //   A 迁不了是有原因的,不是欠账:旧 A 的闭环判据 `raw.includes(id)` 读的是
    //   **tool_result**,而那正是重写要消灭的面;「结果回来了」在动作面上没有痕迹。
    //   要迁 A,先补 `taskReceipts` 通道,不要直接搬。
    const bgA = [{ id: "bg_zzz_999", status: "completed", description: "查一下" }];
    const turnA = [{ type: "assistant", message: { content: [
      { type: "text", text: "任务发出去了,收工。" },
      { type: "tool_use", name: "Agent", input: { description: "查一下" } },
    ] } }];
    const aOn = run(null, { text: "任务发出去了,收工。", turn: turnA, bgTasks: bgA });
    const aOff = run(null, { text: "任务发出去了,收工。", turn: turnA, bgTasks: bgA, engine: false });
    const aBlock = (fs2) => fs2.some((f) => f.id === "A" && f.block);
    sc("未迁的 A 在引擎接管下仍阻断", aBlock(aOn), true);
    sc("且与回退旧实现完全一致", aBlock(aOn) === aBlock(aOff), true);

    // ⚠️ **干净通过时 stdout 必须是空的**(2026-08-20 实撞)。
    //   `hookSpecificOutput.additionalContext` 的官方语义是「**keep the turn going**」
    //   (本机 changelog L1391)——把心跳放在那儿,等于每次全过都主动续一轮:
    //   模型回一句 → 停 → 闸再注一次 → 无限。实撞时连转 8 轮全是零信息应答。
    //   而 changelog L1826 的 8 次上限只保护**连续阻断**,干净通过不受它管。
    //   不对称在这里:**提示项会自己消失**(下一轮不再说那句话就不再命中),
    //   **心跳不会**——它对每一次全过无条件触发。所以只有心跳会永动。
    const realWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = (s) => { captured += String(s); return true; };
    try { emit([]); } finally { process.stdout.write = realWrite; }
    // 断言口径 2026-08-20 收窄:守的是**不含 `additionalContext`**(那才是续轮的原因),
    // 不是「stdout 为空」——批次未结清时会走 `systemMessage` 输出一行给用户看,
    // 那条**不续轮**。原口径会把一个正确行为判成失败。
    sc("全过时 stdout 不含 additionalContext(⇒ 不续命)", captured.includes("additionalContext"), false);

    // ⚠️ **泄压阀必须当着用户的面拉**(2026-08-20 用户实撞后加)。
    //   `yielding` 把全部阻断降级成提示,而降级本身此前对用户不可见 ⇒
    //   用户看到的只是「他说不结清,然后回合正常结束了」。grill P7 判出、用户当场撞上。
    //   没有这条用例,那行 systemMessage 下次会被静默删掉,而自测照样全绿。
    const capture = (fn) => {
      const w = process.stdout.write.bind(process.stdout);
      let buf = "";
      process.stdout.write = (s) => { buf += String(s); return true; };
      try { fn(); } finally { process.stdout.write = w; }
      return buf;
    };
    const boom = [{ id: "K", block: true, msg: "x" }];
    const yielded = capture(() => emit(boom, 99));      // streak 99 ⇒ 必降级
    const held = capture(() => emit(boom, 0));          // streak 0 ⇒ 正常阻断
    sc("降级时用户侧看得见(systemMessage 里说明白)", yielded.includes("自行降级"), true);
    sc("降级时确实不再阻断", yielded.includes('"decision":"block"'), false);
    // 批 265 观察档:有阻断项也不阻断、对模型零输出;关掉观察档同一批项照常阻断(注入,不读宿主仓的模式文件)
    let observed = "";
    try { _observeForTest = true; observed = capture(() => emit(boom, 0)); } finally { _observeForTest = false; }
    sc("观察档:有阻断项也不阻断", observed.includes('"decision":"block"'), false);
    sc("观察档:对模型零输出", observed.trim() === "", true);
    sc("观察档关掉后同一批项照常阻断", capture(() => emit(boom, 0)).includes('"decision":"block"'), true);
    sc("未降级时照常阻断", held.includes('"decision":"block"'), true);
    sc("未降级时不谎称降级", held.includes("自行降级"), false);

    // ⚠️ **跨轮窗口必须真的接上**(2026-08-20 实撞:`priorEntries` 从落地起就没被
    //   生产路径喂过 ⇒ `ctx.window()` 恒为 null ⇒ I 项那条「窗口放宽到批」的修法是死代码)。
    //   当日**第三次**「造了机制却不接线」(前两次:`segments()` 零调用、`requires` 生产不可达)。
    //   这条用例的形态就是那次实撞:**上一轮联网、本轮扫本地并造载体**——
    //   窗口没接上时 I 命中,接上了才不命中。
    const winTurns = [
      { type: "user", message: { content: [{ type: "text", text: "去查" }] } },
      { type: "assistant", message: { content: [
        { type: "text", text: "先看看业界怎么做的。" },
        { type: "tool_use", name: "WebSearch", input: { query: "shell quote parser" } },
      ] } },
      { type: "user", message: { content: [{ type: "text", text: "继续" }] } },
      { type: "assistant", message: { content: [
        { type: "text", text: "工具面已扫:无命中。新建了零件。" },
        { type: "tool_use", name: "Grep", input: { path: "docs/tool-register.md", pattern: "shell" } },
        { type: "tool_use", name: "Write", input: { file_path: "/repo/scripts/lib/新零件.mjs", content: "x" } },
      ] } },
    ];
    const idsOf = (fs2) => fs2.map((f) => f.id).join(",");
    const withWin = idsOf(run(null, { entries: winTurns, text: "工具面已扫:无命中。新建了零件。" }));
    // 控制组:**只喂最后一轮**,于是 `_priorWindow` 拿不到前文 ⇒ 窗口为 null。
    // (传 `priorEntries: undefined` 是关不掉的——那正好走 `_priorWindow` 分支,
    //  第一版控制组就栽在这儿,看起来像「修法无效」。)
    const noWin = idsOf(run(null, { entries: winTurns.slice(2),
      text: "工具面已扫:无命中。新建了零件。" }));
    sc("跨轮窗口接上时 I 不误拦(上轮联网+本轮扫本地)", withWin.includes("I"), false);
    sc("窗口取不到时 I 仍拦(证明上一条不是恒不命中)", noWin.includes("I"), true);

    // ── D45:外层 main catch 的子进程级注入(IS_MAIN 生产路)──────────────
    // 三形态故障注入只打到 ENGINE 接缝(经 run()),而决定**真实退出码**的是文件末尾
    // 外层 catch 的 fail-open 路——它只在 IS_MAIN 生产形态可达,进程内 import 测不到。
    // 注入通道:payload 的 transcript_path 指向**目录** ⇒ readTranscript 的裸
    // readFileSync 抛 EISDIR,直达外层 catch。断言三件套:exit 0(fail-open)、
    // additionalContext 求救行(与「全过」可分辨)、systemMessage(到达用户)。
    // 崩点在 emit 之前 ⇒ 不写任何 live 台账,分母纪律不破。
    {
      let out = "", code = 0;
      try {
        out = execFileSync(process.execPath, ["--no-warnings", process.argv[1]], {
          input: JSON.stringify({ last_assistant_message: "x", transcript_path: "scripts" }),
          encoding: "utf8", timeout: 30_000, windowsHide: true,
        });
      } catch (e) { code = e.status ?? -1; out = String(e.stdout || ""); }
      sc("D45:外层 catch fail-open ⇒ 子进程真实退出码 0", code, 0);
      sc("D45:崩溃不隐身(additionalContext 求救行)", out.includes("收尾闸自身未完成"), true);
      sc("D45:崩溃到达用户(systemMessage)", out.includes("自身崩了"), true);
    }
  }

  // ── 零件用例:把审计结果做成**资产**而不是一次性探针 ────────────────────────
  // 2026-08-20:codex 在 `bashWriteTargets` 上一口气找出 6 处失效,而我此前是用
  //   一次性探针验的四条——跑完就丢。下面把两者都钉成永久用例。
  //   便宜的三条已修(heredoc 引号界符 / `--` 参数终止符 / `..` 规格化),
  //   另三条属「分段器不理解引号」族,已在函数头注登记不修。
  let hpPass = 0, hpTotal = 0;
  {
    const hp = (name, got, want) => {
      hpTotal++;
      const ok = JSON.stringify(got) === JSON.stringify(want);
      console.log(`${ok ? "PASS" : "FAIL"}  零件用例:${name}` + (ok ? "" : `  ← 期待 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`));
      if (ok) hpPass++;
    };
    // ── attachBatchLog(批 256):AD 项的提交全文注入 ──
    {
      const g = { batch: "256", conditions: ["甲"], baseCommit: "abc1234" };
      const fake = (out) => () => out;
      hp("batchLog:有基点、无决定 ⇒ 按 NUL 切出每条提交全文",
        attachBatchLog(g, fake("feat: 甲\n\n用户签\n\0fix: 乙\n\0")).batchLog, ["feat: 甲\n\n用户签", "fix: 乙"]);
      hp("batchLog:已登记决定 ⇒ 不跑 git、不加键", attachBatchLog({ ...g, decisions: [{ id: "256-D1" }] }, () => { throw new Error("不该调"); }).batchLog, undefined);
      hp("batchLog:无基点(旧批)⇒ 不加键", attachBatchLog({ batch: "255", conditions: ["x"] }, () => { throw new Error("不该调"); }).batchLog, undefined);
      hp("batchLog:已结清 ⇒ 不加键", attachBatchLog({ ...g, cleared: true }, () => { throw new Error("不该调"); }).batchLog, undefined);
      hp("batchLog:git 失败 ⇒ 原样返回(提示面 fail-open)", attachBatchLog(g, () => { throw new Error("bad revision"); }).batchLog, undefined);
      hp("batchLog:基点不是 sha 形 ⇒ 不进命令行", attachBatchLog({ ...g, baseCommit: "--output=x" }, () => { throw new Error("不该调"); }).batchLog, undefined);
    }
    // ── priorClosedFromJournal(批 253b,红队 BP-14):同轮关旧批→开新批→同号 --force 重开 ──
    {
      const J = (...os) => os.map((o) => JSON.stringify(o));
      const g254 = { batch: "254", conditions: ["丙"] };
      const pc = (rows) => { const r = priorClosedFromJournal(rows, g254); return [r.priorClosedBatch ?? null, (r.priorClosedConditions || []).length]; };
      hp("priorClosed:clear 253 → arm 254 ⇒ 补 253/2 条",
        pc(J({ action: "clear", batch: "253", conditions: ["甲", "乙"] }, { action: "arm", batch: "254" })), ["253", 2]);
      hp("priorClosed:clear 253 → arm 254 → force-over-checks 254 → arm 254 ⇒ 跳过同号仍补(BP-14)",
        pc(J({ action: "clear", batch: "253", conditions: ["甲", "乙"] }, { action: "arm", batch: "254" },
          { action: "force-over-checks", batch: "254", newBatch: "254" }, { action: "arm", batch: "254" })), ["253", 2]);
      hp("priorClosed:clear 253 → arm 252 → arm 254 ⇒ 遇别批 arm 即停,不补",
        pc(J({ action: "clear", batch: "253", conditions: ["甲"] }, { action: "arm", batch: "252" }, { action: "arm", batch: "254" })), [null, 0]);
      hp("priorClosed:clear 254 → arm 254 ⇒ 同号 clear 不补",
        pc(J({ action: "clear", batch: "254", conditions: ["甲"] }, { action: "arm", batch: "254" })), [null, 0]);
      hp("priorClosed:最后 arm 批号≠盘上批 ⇒ 不补",
        pc(J({ action: "clear", batch: "253", conditions: ["甲"] }, { action: "arm", batch: "255" })), [null, 0]);
      hp("priorClosed:台账有坏行 ⇒ 不补(fail-closed)",
        pc([...J({ action: "clear", batch: "253", conditions: ["甲"] }), "{bad", ...J({ action: "arm", batch: "254" })]), [null, 0]);
    }
    // ── lastTurn 边界②′:hook 反馈的**真实形态**是 user+字符串(2026-08-25,D46)──
    //   生产 21717 条实测:边界②认的 `type:"system"+hookCount` 一次都没出现过,
    //   反馈全长成 `type:"user"` + 字符串 content、首行 "Stop hook feedback:"。
    //   三条钉住:反馈排除在证据窗外(i+1)/ 真实用户字符串发言不误伤 / 旧 system 形态仍认。
    {
      const U = (s) => ({ type: "user", message: { content: s } });
      const A2 = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
      const fb = U("Stop hook feedback:\n收尾闸阻断 1 项:\n  [K] …");
      const t1 = lastTurn([U("真用户说话"), A2("回应甲"), fb, A2("对拦截的回应")]);
      hp("lastTurn:反馈后只剩对拦截的回应", t1.length, 1);
      hp("lastTurn:反馈自身不进证据窗(i+1 排除)",
        t1.some((e) => typeof e?.message?.content === "string" && /Stop hook feedback/.test(e.message.content)), false);
      const t2 = lastTurn([A2("旧话"), U("普通的字符串用户发言"), A2("本轮回应")]);
      hp("lastTurn:真实用户字符串发言含首(边界①不误伤)", t2.length, 2);
      const sysFb = { type: "system", hookCount: 1, hookErrors: ["收尾闸阻断 1 项"] };
      const t3 = lastTurn([U("真用户"), A2("回应甲"), sysFb, A2("回应乙")]);
      hp("lastTurn:旧 system+hookCount 形态仍认(排除含首)", t3.length, 1);
    }
    // ── 热修 10-09 + 批 257 v5 红队:lastTurn 按来源认边界、consecutiveBlocks 按一次 Stop 计 ──
    {
      const H = (s) => ({ type: "user", origin: { kind: "human" }, message: { content: s } });
      const A2 = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
      const skill = { type: "user", isMeta: true, message: { content: [{ type: "text", text: "技能正文" }] } };
      const plug = { type: "user", isMeta: true, origin: { kind: "plugin" }, message: { content: "插件消息" } };
      const peer = { type: "user", isMeta: true, origin: { kind: "peer" }, message: { content: "子代理回报" } };
      hp("lastTurn:技能正文(无 origin 的 isMeta)不切窗", lastTurn([H("做"), A2("甲"), skill, A2("乙")]).length, 4);
      hp("lastTurn:插件消息不切窗", lastTurn([H("做"), A2("甲"), plug, A2("乙")]).length, 4);
      hp("lastTurn:peer 回报仍是边界①", lastTurn([H("做"), A2("甲"), peer, A2("乙")]).length, 2);
      // v7(codex v6 接缝 1):用户亲口贴的话以「Stop hook feedback:」开头 ⇒ 是用户发言(含首),不当反馈切掉
      hp("lastTurn:用户亲口以反馈前缀开头的话含首", lastTurn([A2("旧"), H("Stop hook feedback: 这条为什么拦?"), A2("答")]).length, 2);
      const att = (id) => ({ type: "attachment", attachment: { type: "hook_blocking_error", hookEvent: "Stop", toolUseID: id, blockingError: "收尾闸阻断 1 项" } });
      const sum = (id) => ({ type: "system", subtype: "stop_hook_summary", hookCount: 1, hookErrors: [], toolUseID: id });
      hp("lastTurn:已结束的 Stop 从汇总行之后起算", lastTurn([H("做"), A2("甲"), att("s1"), sum("s1"), A2("乙")]).length, 1);
      hp("lastTurn:进行中的附件(无汇总行)不切窗", lastTurn([H("做"), A2("甲"), att("s1"), A2("乙")]).length, 4);
      // a2155edb BP-6:判官型拦截只留 feedback 行(无附件),与补收回扫同用 isBlockedStop ⇒ 起点在汇总行之后(汇总行带判官全文,不进证据窗)
      const jfb = { type: "user", isMeta: true, message: { content: "Stop hook feedback:\n[只查一件事:…]" } };
      hp("lastTurn:feedback 行型拦截从汇总行之后起算(BP-6)", lastTurn([H("做"), A2("甲"), jfb, { ...sum("j1"), hookErrors: ["[只查一件事:…]"] }, A2("乙")]).length, 1);
      const L = (o) => JSON.stringify(o);
      const blk = (id) => [L(att(id)), L({ ...sum(id), hookErrors: ["收尾闸阻断 1 项:x"] })];
      const q = L({ type: "attachment", attachment: { type: "queued_command", prompt: "改做 X", origin: { kind: "human" } } });
      const cb = (...xs) => consecutiveBlocksText(xs.flat().join("\n"));
      hp("连撞:三次标准形态阻断计 3(不按载体重复计)", cb(blk("s1"), blk("s2"), blk("s3")), 3);
      hp("连撞:用户打字清零", cb(blk("s1"), blk("s2"), L(H("停")), blk("s3")), 1);
      hp("连撞:排队消息同样清零(v5 红队 BP-4)", cb(blk("s1"), blk("s2"), blk("s3"), q, blk("s4")), 1);
      hp("连撞:进行中的那次不计", cb(blk("s1"), [L(att("s2"))]), 1);
    }
    // ── 批 257 条件 3:diff 分档事实的读取(git 注入)──
    {
      // 两次 diff:基点..HEAD 与 基点..工作树(后者只多出一个未提交的 D)
      const git = (a) => a[0] === "rev-parse" ? "/repo\n"
        : a[2] === "diff" ? "M\0docs/laws/collab.md\0R100\0scripts/a.mjs\0scripts/b.mjs\0A\0scripts/x.test.mjs\0" + (a.includes("HEAD") ? "" : "D\0AGENTS.md\0")
        : "";
      const f = readDiffFacts("66803b1b2b", git, (p) => !/AGENTS/.test(p));
      hp("diff 事实:两段范围并起来、改名取新路径并留旧路径", f && f.files.map((x) => `${x.status}:${x.path}${x.oldPath ? "<" + x.oldPath : ""}`).join(" "),
        "M:docs/laws/collab.md R100:scripts/b.mjs<scripts/a.mjs A:scripts/x.test.mjs M:docs/laws/collab.md R100:scripts/b.mjs<scripts/a.mjs A:scripts/x.test.mjs D:AGENTS.md");
      hp("diff 事实:带仓根、A/M 记新内容读不读得到", f && `${f.root}|${f.files[2].readable}|${f.files[6].readable}`, "/repo|true|false");
      hp("diff 事实:基点不合法 ⇒ null(不分档)", readDiffFacts("HEAD~1; rm", git), null);
      hp("diff 事实:git 失败 ⇒ null", readDiffFacts("66803b1b2b", () => { throw new Error("x"); }), null);
    }
    // ── 红队 a27628dd:P 的 HEAD 移动事实(git 注入)──
    {
      const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), M = "d".repeat(40), X = "e".repeat(40);
      const RS = "\x1f";
      // 默认:祖先情形,首父链 C(法典)→ M(合回 worktree-agent-x,第二父 X,对第一父带进闸改动)
      const defRev = `${M}${RS}1760000100${RS}${C} ${X}${RS}Merge branch 'worktree-agent-x'——合回\n${C}${RS}1760000000${RS}${A}${RS}改法典\n`;
      const mk = ({ ancestor = true, revlist = defRev, count = "", mb = B, diff = {}, log = {}, pointsAt = "worktree-agent-x\nother\n" } = {}) => {
        const seen = [];
        const git = (a) => {
          seen.push(a.join(" "));
          if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return "/repo\n";
          if (a[0] === "rev-parse" && a[1] === "HEAD") return M + "\n";
          if (a[0] === "rev-parse" && a[1] === "--verify") return A + "\n";
          if (a[0] === "merge-base" && a[1] === "--is-ancestor") { if (!ancestor) throw new Error("1"); return ""; }
          if (a[0] === "merge-base") return mb + "\n";
          if (a[0] === "rev-list") return a.includes("--count") ? count : revlist;
          if (a[0] === "branch") return pointsAt;
          if (a[2] === "diff") {
            const r = a.slice(6, -1).join("..");
            if (r in diff) return diff[r];
            return r === `${C}^1..${C}` ? "M\0docs/laws/collab.md\0"
              : r === `${M}^1..${M}` ? "M\0scripts/lib/gate-rules.mjs\0" : "";     // merge:对第一父的改动
          }
          if (a[0] === "log") return (log[a[4]] ?? "1759999000") + "\n";
          return "";
        };
        return { git, seen };
      };
      const specs = ["scripts/hook-stop-closure.mjs"];
      const { git, seen } = mk();
      const f = readHeadFacts("aaaaaaa", git, specs);
      hp("HEAD 事实:首父链提交按时间正序、merge 取对第一父的改动",
        f && f.commits.map((c) => `${c.sha[0]}@${c.at}:${c.files.map((x) => x.path).join(",")}`).join(" "),
        "c@1760000000000:docs/laws/collab.md d@1760000100000:scripts/lib/gate-rules.mjs");
      hp("HEAD 事实:合回提交带分支名(标题 ∪ 第二父的分支指针)与父提交,普通提交分支名为空(a2a9f58b BP-8)",
        f && f.commits.map((c) => `${c.parents.length}:${c.branches.join("+")}`).join(" "), "1: 2:worktree-agent-x+other");
      hp("HEAD 事实:分支指针查的是第二父", seen.includes(`branch --format=%(refname:short) --points-at ${X}`), true);
      hp("HEAD 事实:head 透传(BP-6 写基点用它)", f && f.head, M);
      hp("HEAD 事实:engineAnchorAt 取范围起点的闸引擎提交时刻(带 pathspec)", f && f.engineAnchorAt, 1759999000000);
      hp("HEAD 事实:engineAnchorAt 的 git log 从基点起、带 pathspec", seen.some((s) => s === `log --first-parent -1 --format=%ct ${A} -- scripts/hook-stop-closure.mjs`), true);
      // ── 非祖先(a2a9f58b BP-9 / BP-3)── merge-base = B;HEAD 上只有 M 一笔新提交
      const nonAnc = (o) => mk({ ancestor: false, revlist: `${M}${RS}1760000200${RS}${B}${RS}x\n`, ...o });
      // BP-9:基点 A 带闸改动,reset --hard 回 B 再提交业务 ⇒ 树差 A..M 里有被撤掉的闸文件,但 M 自己只改了 src
      const rst = readHeadFacts("aaaaaaa", nonAnc({ diff: { [`${M}^1..${M}`]: "M\0src/a.ts\0", [`${A}..${M}`]: "M\0scripts/lib/gate-rules.mjs\0M\0src/a.ts\0" } }).git, specs);
      hp("HEAD 事实 BP-9:reset 后提交业务 ⇒ 只算 merge-base..HEAD 的改动(撤掉的闸文件不算)",
        rst && rst.commits.map((c) => `${c.rewritten}:${c.files.map((x) => x.path).join(",")}`).join(" "), "true:src/a.ts");
      // amend 只改提交信息:M 对其父的改动 = 原闸改动,但 A..M 树差为空 ⇒ 无改动
      const msgOnly = readHeadFacts("aaaaaaa", nonAnc({ diff: { [`${M}^1..${M}`]: "M\0scripts/lib/gate-rules.mjs\0", [`${A}..${M}`]: "" } }).git, specs);
      hp("HEAD 事实:只改信息的 amend ⇒ 提交在、改动为空", msgOnly && msgOnly.commits.map((c) => c.files.length).join(","), "0");
      // BP-3:amend 进新闸改动 ⇒ 改动正好是新那处;切点取 base(A)链上最后一次闸改动与 merge-base 两者较晚
      const am = nonAnc({ diff: { [`${M}^1..${M}`]: "M\0scripts/lib/gate-rules.mjs\0M\0docs/a.md\0", [`${A}..${M}`]: "M\0scripts/lib/gate-rules.mjs\0" },
        log: { [A]: "1760000050", [B]: "1759999000" } });
      const amf = readHeadFacts("aaaaaaa", am.git, specs);
      hp("HEAD 事实 BP-3:amend 进新闸改动 ⇒ 只留与基点真有差的路径", amf && amf.commits.map((c) => c.files.map((x) => x.path).join(",")).join(" "), "scripts/lib/gate-rules.mjs");
      hp("HEAD 事实 BP-3:非祖先时切点取 base 自身链上的闸改动时刻(不因 merge-base 更早而放宽)", amf && amf.engineAnchorAt, 1760000050000);
      hp("HEAD 事实:基点非祖先、无新提交(reset 回退)⇒ 无提交", readHeadFacts("aaaaaaa", mk({ ancestor: false, mb: M }).git, specs)?.commits.length, 0);
      // 红队 a9af71da BP-1:范围超 60 ⇒ 原返回 null(基点永不推进、P 永久退回语法面);现整段当一笔聚合提交
      const big = (first) => Array.from({ length: 61 }, (_, i) => `${i === 0 ? first : String(i % 10).repeat(40)}${RS}1760000300${RS}${RS}x\n`).join("");
      const aggDiff = { [`${A}..${M}`]: "M\0scripts/lib/gate-rules.mjs\0M\0src/a.ts\0" };
      const agg = readHeadFacts("aaaaaaa", mk({ revlist: big(M), count: "75\n", diff: aggDiff }).git, specs);
      hp("HEAD 事实 a9af71da BP-1:范围超 60 ⇒ 不再 null,整段当一笔聚合提交(sha=HEAD、count、at=HEAD、改动=范围净差)",
        agg && agg.commits.map((c) => `${c.sha[0]}:${c.aggregated}:${c.count}:${c.at}:${c.files.map((x) => x.path).join(",")}`).join(" "),
        "d:true:75:1760000300000:scripts/lib/gate-rules.mjs,src/a.ts");
      hp("HEAD 事实 a9af71da BP-1:聚合时 engineAnchorAt 照旧算", agg && agg.engineAnchorAt, 1759999000000);
      hp("HEAD 事实 a9af71da BP-1:count 取不到 ⇒ 按 61(只会多计)",
        readHeadFacts("aaaaaaa", mk({ revlist: big(M), count: "garbage", diff: aggDiff }).git, specs)?.commits[0].count, 61);
      hp("HEAD 事实 a9af71da BP-1:首父链第一行不是 HEAD(读的过程中 HEAD 动了)⇒ null",
        readHeadFacts("aaaaaaa", mk({ revlist: big("0".repeat(40)), count: "75" }).git, specs), null);
      hp("HEAD 事实 a9af71da BP-1:非祖先聚合 ⇒ 净差只留与基点真有差的路径",
        readHeadFacts("aaaaaaa", mk({ ancestor: false, revlist: big(M), count: "70", diff: { [`${B}..${M}`]: "M\0scripts/lib/gate-rules.mjs\0M\0src/a.ts\0", [`${A}..${M}`]: "M\0src/a.ts\0" } }).git, specs)
          ?.commits.map((c) => `${c.rewritten}:${c.files.map((x) => x.path).join(",")}`).join(" "), "true:src/a.ts");
      hp("HEAD 事实:基点不合法 ⇒ null", readHeadFacts("HEAD; rm", git, specs), null);
      hp("HEAD 事实:git 失败 ⇒ null", readHeadFacts("aaaaaaa", () => { throw new Error("x"); }, specs), null);
      hp("HEAD 事实:不给 pathspec ⇒ engineAnchorAt 为 null(不拿基点自身时刻冒充)", readHeadFacts("aaaaaaa", mk().git, [])?.engineAnchorAt, null);
      // 基点:无基点文件 ⇒ 取会话开始时刻的 HEAD(reflog);reflog 起点晚于会话开始且非建立记录 ⇒ 取不到(a2a9f58b BP-2)
      const rl = [];
      const g2 = (a) => { rl.push(a.join(" ")); return B + "\n"; };
      const rfl = (old, ts) => () => `${old} ${B} Some One <a@b.c> ${ts} +0800\tcommit: x`;
      const early = rfl("1".repeat(40), 1700000000), late = rfl("1".repeat(40), 1800000000), born = rfl("0".repeat(40), 1800000000);
      hp("HEAD 基点:无基点文件 ⇒ reflog 取会话开始时的 HEAD", pHeadBase("selftest-no-such-session", [{ type: "x" }, { timestamp: "2026-10-10T08:00:00.123Z" }], g2, early), B);
      hp("HEAD 基点:reflog 查询用会话开始时刻", rl[0], "rev-parse --verify -q HEAD@{2026-10-10 08:00:00 +0000}");
      hp("HEAD 基点 BP-2:reflog 被截断(起点晚于会话开始)⇒ null(-q 会静默给最老记录)",
        pHeadBase("selftest-no-such-session", [{ timestamp: "2026-10-10T08:00:00Z" }], g2, late), null);
      hp("HEAD 基点:reflog 起点是建立记录(旧 sha 全零)⇒ 最老记录就是起点,照用",
        pHeadBase("selftest-no-such-session", [{ timestamp: "2026-10-10T08:00:00Z" }], g2, born), B);
      hp("HEAD 基点:reflog 读不懂 ⇒ null", pHeadBase("selftest-no-such-session", [{ timestamp: "2026-10-10T08:00:00Z" }], g2, () => "garbage"), null);
      // 红队 a9af71da BP-1 附:reflog 那支取不到 ⇒ 退用当前批的 baseCommit(须是 HEAD 祖先),否则维持 null
      const s0 = [{ timestamp: "2026-10-10T08:00:00Z" }];
      hp("HEAD 基点 a9af71da:reflog 被截断、当前批基点是 HEAD 祖先 ⇒ 用批基点", pHeadBase("selftest-no-such-session", s0, g2, late, () => "abc1234"), "abc1234");
      hp("HEAD 基点 a9af71da:reflog 读不懂、批基点在 ⇒ 用批基点", pHeadBase("selftest-no-such-session", s0, g2, () => "garbage", () => "abc1234"), "abc1234");
      hp("HEAD 基点 a9af71da:批基点不是 HEAD 祖先 ⇒ null",
        pHeadBase("selftest-no-such-session", s0, (a) => { if (a[0] === "merge-base") throw new Error("1"); return B + "\n"; }, late, () => "abc1234"), null);
      hp("HEAD 基点 a9af71da:批基点不是 sha 形 ⇒ null(不进命令行)",
        pHeadBase("selftest-no-such-session", s0, () => { throw new Error("不该调"); }, late, () => "--output=x"), null);
      hp("HEAD 基点 a9af71da:reflog 取得到 ⇒ 不看批基点", pHeadBase("selftest-no-such-session", s0, g2, early, () => "abc1234"), B);
      hp("HEAD 基点 a9af71da:无会话 id ⇒ 批基点也不用", pHeadBase(undefined, s0, g2, late, () => "abc1234"), null);
      // 红队 a07e98e9 BP-5:退路批基点必须是**未结清**的批——已结清 ⇒ null(不拿已关批的基点把整批算到新会话头上)
      hp("批基点 a07e98e9 BP-5:批状态已结清 ⇒ null", batchBaseOfGoal({ cleared: true, batch: "257", baseCommit: "abc1234" }), null);
      // 批 258(codex 258-cond2-r1 发现 1):结清态补回本批最早武装时刻,遇到更早的 clear / 别批 arm 即停
      const jr = (o) => JSON.stringify(o);
      hp("结清态武装时刻:取同批最早 arm(跨重放与决定行)",
        clearedArmedAtOf([jr({ action: "clear", batch: "257", at: "T0" }), jr({ action: "arm", batch: "258", at: "T1" }), jr({ action: "decision", batch: "258", at: "T2" }),
          jr({ action: "arm", batch: "258", at: "T3" }), jr({ action: "clear", batch: "258", at: "T4" })], "258"), "T1");
      hp("结清态武装时刻:前面是别批的 arm ⇒ 停在那里", clearedArmedAtOf([jr({ action: "arm", batch: "257", at: "T0" }), jr({ action: "clear", batch: "258", at: "T4" })], "258"), null);
      // 批 258 条件 4:误报率表——撤回按规则扣、待修门槛 ≥20 次且 ≥15%
      {
        const al = [...Array(20)].map(() => ({ ids: ["S"] })).concat([...Array(10)].map(() => ({ ids: ["K"] })));
        const lg = [{ kind: "claimed_fp", id: "S" }, { kind: "claimed_fp", id: "S" }, { kind: "claimed_fp", id: "S" },
          { kind: "confirmed_fp", id: "K" }, { kind: "claimed_fp", id: "K" }, { kind: "claimed_fp", id: "K" }, { kind: "retraction", id: "S" }];
        const tb = fpTable(al, lg), s = tb.find((r) => r.id === "S"), k = tb.find((r) => r.id === "K");
        hp("误报率表:撤回按规则扣(S 3 笔 − 1 撤回 = 2)", s.fp, 2);
        hp("误报率表:S 20 次报警、10% ⇒ 不进待修", s.hot, false);
        hp("误报率表:K 30% 但报警只有 10 次 ⇒ 不进待修", k.hot, false);
        hp("误报率表:报警 20 次、误报 3 笔(15%)⇒ 进待修", fpTable(al, lg.filter((x) => x.kind !== "retraction")).find((r) => r.id === "S").hot, true);
        hp("误报率表:撤回多于误报 ⇒ 不低于 0", fpTable([{ ids: ["V"] }], [{ kind: "retraction", id: "V" }])[0].fp, 0);
        hp("265 误报率表:子代理通道行与 UNKNOWN 不计入分母(红队 a0dfbfce BP-4)",
          JSON.stringify(fpTable([{ ids: ["M"] }, { ids: ["M", "UNKNOWN"], channel: "SubagentStop" }, { ids: ["UNKNOWN"] }], []).map((r) => [r.id, r.alerts])), '[["M",1]]');
        hp("误报率表:按报警量降序", tb.map((r) => r.id).join(","), "S,K");
        // 2026-10-12:confirmed_fp 是对已有自签的加签,不另计一笔(原先 K 会计 3)
        hp("误报率表:加签行不重复计数(K 自签 2 + 加签 1 = 2)", k.fp, 2);
        // 批 259(grill F1 / F8):撤回按笔推导——codex 判拦对了的每笔扣一次;同笔重复判、旧 by:codex 撤回行都不多扣;
        //   已人工撤回的那笔不再被 codex 结论二次扣
        const lg2 = [{ kind: "claimed_fp", id: "V", h: "a" }, { kind: "claimed_fp", id: "V", h: "b" }, { kind: "claimed_fp", id: "V", h: "c" },
          { kind: "fp_audit", ref: "a", id: "V", by: "codex", verdict: "拦对了" }, { kind: "fp_audit", ref: "a", id: "V", by: "codex", verdict: "拦对了" },
          { kind: "retraction", id: "V", by: "codex", ref: "a" },
          { kind: "retraction", id: "V", by: "assistant" }, { kind: "fp_audit", ref: "b", id: "V", verdict: "已人工撤回", by: "fp-audit-migration" },
          { kind: "fp_audit", ref: "b", id: "V", by: "codex", verdict: "拦对了" }];
        hp("误报率表:撤回按笔推导,不双扣(3 − 人工 1 − codex 按笔 1 = 1)", fpNetById(lg2).V, 1);
        // codex 259-final-r1 A3:同笔人工撤两次只扣一次;撤回行写成功、标记行没写成的半截情形不被 codex 结论二次扣
        const c1 = { kind: "claimed_fp", id: "V", h: "h1" }, c2 = { kind: "claimed_fp", id: "V", h: "h2" };
        const rr = { kind: "retraction", id: "V", ref: "h1", by: "assistant" }, mm = { kind: "fp_audit", id: "V", ref: "h1", by: "assistant", verdict: "已人工撤回" };
        const aa = { kind: "fp_audit", id: "V", ref: "h1", by: "codex", verdict: "拦对了" };
        hp("误报率表:同笔人工撤两次只扣一次", fpNetById([c1, c2, rr, mm, rr, mm]).V, 1);
        hp("误报率表:人工撤回半截 + codex 拦对了只扣一次", fpNetById([c1, c2, aa, rr]).V, 1);
      }
      // codex 258-cond2-r2:本轮开始时开着的那批的起点
      const T = (h, m, s = 0) => `2026-10-10T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`, ms = (x) => Date.parse(x);
      const reopen = [jr({ action: "arm", batch: "258", at: T(8, 0) }), jr({ action: "clear", batch: "258", at: T(10, 0) }), jr({ action: "arm", batch: "258", at: T(10, 0, 5) })];
      hp("本轮批起点:同号关账后重开 ⇒ 取本轮开始时开着的那批的起点", turnBatchStartOf(reopen, ms(T(9, 59))), T(8, 0));
      const twoClears = [jr({ action: "arm", batch: "258", at: T(8, 0) }), jr({ action: "clear", batch: "258", at: T(10, 0) }),
        jr({ action: "arm", batch: "259", at: T(10, 0, 5) }), jr({ action: "clear", batch: "259", at: T(10, 0, 9) })];
      hp("本轮批起点:同轮连关两批 ⇒ 第一批的起点", turnBatchStartOf(twoClears, ms(T(9, 59))), T(8, 0));
      hp("本轮批起点:同号原样重放不刷新", turnBatchStartOf([jr({ action: "arm", batch: "258", at: T(8, 0) }), jr({ action: "arm", batch: "258", at: T(9, 0) })], ms(T(9, 30))), T(8, 0));
      hp("本轮批起点:本轮开始时无开着的批 ⇒ 本轮第一次 arm", turnBatchStartOf([jr({ action: "clear", batch: "257", at: T(7, 0) }), jr({ action: "arm", batch: "258", at: T(10, 0) })], ms(T(9, 59))), T(10, 0));
      hp("本轮批起点:取不到本轮开始时刻 ⇒ null", turnBatchStartOf(reopen, NaN), null);
      hp("结清态武装时刻:读不懂的行 ⇒ 停", clearedArmedAtOf(["garbage", jr({ action: "arm", batch: "258", at: "T1" }), jr({ action: "clear", batch: "258" })], "258"), "T1");
      hp("批基点 a07e98e9 BP-5:批状态未结清 ⇒ 用 baseCommit", batchBaseOfGoal({ batch: "257", conditions: ["甲"], baseCommit: "abc1234" }), "abc1234");
      hp("批基点 a07e98e9 BP-5:无批状态 ⇒ null", batchBaseOfGoal(null), null);
      hp("批基点 a07e98e9 BP-5:台账最后一条 arm 之后有 clear ⇒ null",
        batchBaseFromRows([JSON.stringify({ action: "arm", batch: "257", baseCommit: "66803b1" }), JSON.stringify({ action: "decision", batch: "257" }), JSON.stringify({ action: "clear", batch: "257" })]), null);
      hp("批基点 a07e98e9 BP-5:台账 clear 之后又 arm ⇒ 用新批 baseCommit",
        batchBaseFromRows([JSON.stringify({ action: "arm", batch: "257", baseCommit: "66803b1" }), JSON.stringify({ action: "clear", batch: "257" }), JSON.stringify({ action: "arm", batch: "258", baseCommit: "abc1234" })]), "abc1234");
      hp("批基点 a07e98e9 BP-5:台账未结清 ⇒ 用 arm 的 baseCommit",
        batchBaseFromRows([JSON.stringify({ action: "arm", batch: "257", baseCommit: "66803b1" }), "坏行"]), "66803b1");
      hp("HEAD 基点 a07e98e9 BP-5:reflog 截断 + 批已结清 ⇒ null(端到端)",
        pHeadBase("selftest-no-such-session", s0, g2, late, () => batchBaseOfGoal({ cleared: true, baseCommit: "abc1234" })), null);
      hp("HEAD 基点:无会话 id ⇒ null", pHeadBase(undefined, [{ timestamp: "2026-10-10T08:00:00Z" }], g2, early), null);
      hp("HEAD 基点:会话 id 带路径字符 ⇒ null(不拼进文件名)", pHeadBase("../x", [{ timestamp: "2026-10-10T08:00:00Z" }], g2, early), null);
      // ── P 的收尾结算(settleP:hook 计账与基点推进;a2a9f58b BP-1 / BP-2 / BP-6)──
      {
        const P_ = RULES.find((r) => r.id === "P")._p;
        const S1 = "1".repeat(40), S2 = "2".repeat(40), S3 = "3".repeat(40), HD = "9".repeat(40);
        const sc = ({ ledger = { carriers: 0 }, facts, cmd = "git add -A && git commit -m x", extra = [] } = {}) => buildCtx(
          [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }, ...extra] } }],
          { pLedger: ledger, ...(facts === undefined ? {} : { headFacts: () => facts }) });
        const law3 = { root: "/repo", head: HD, commits: [S1, S2, S3].map((sha) => ({ sha, files: ["docs/laws/collab.md"] })) };
        const s1 = settleP(P_, sc({ facts: law3 }), []);
        hp("settleP BP-1:git add -A 带进 3 笔法典提交 ⇒ 账 +3(原命令语法计 0)、记下 sha", JSON.stringify(s1.ledger), JSON.stringify({ carriers: 3, shas: [S1, S2, S3] }));
        hp("settleP BP-6:推进到读事实那一刻的 HEAD", `${s1.advance}:${s1.head}`, `true:${HD}`);
        const s2 = settleP(P_, sc({ ledger: { carriers: 3, shas: [S1, S2, S3] }, facts: law3 }), [{ id: "P" }]);
        hp("settleP 去重:同一批提交再出现(P 欠着、基点没动)⇒ 账不动", s2.ledger, null);
        hp("settleP:P 有命中 ⇒ 不推进基点", s2.advance, false);
        const s3 = settleP(P_, sc({ facts: null }), []);
        hp("settleP BP-2:git 事实取不到、P 无命中 ⇒ 不推进基点", s3.advance, false);
        hp("settleP BP-2:git 事实取不到 ⇒ 回退语法计数(git add -A 计 0 + 触发与否)", JSON.stringify(s3.ledger), "null");
        hp("settleP:git 事实通道没接 ⇒ 不推进基点", settleP(P_, sc({}), []).advance, false);
        const all3 = [{ type: "tool_use", name: "Bash", input: { command: "node ~/.claude/scripts/codex-run.mjs --task t.md" } },
          { type: "tool_use", name: "Agent", input: { subagent_type: "grill:testing" } }, { type: "tool_use", name: "WebSearch", input: { query: "先例" } }];
        hp("settleP:三通道齐 ⇒ 清零(sha 照记)", JSON.stringify(settleP(P_, sc({ ledger: { carriers: 4 }, facts: law3, extra: all3 }), []).ledger),
          JSON.stringify({ carriers: 0, shas: [S1, S2, S3] }));
        // 红队 a9af71da BP-1:基点后 61 笔(readHeadFacts 走聚合)⇒ 事实不再 null;合回带进闸改动
        //   ① 三通道齐(闸引擎面的独立视角 = 绑定红队)且 P 无命中 ⇒ advance=true(原 facts=null ⇒ 永不推进,G2)
        //   ② 无红队 ⇒ P 命中、不推进
        const PR = RULES.find((r) => r.id === "P");
        const M61 = Array.from({ length: 61 }, (_, i) => `${i === 0 ? HD : String((i % 8) + 1).repeat(40)}\x1f1760000300\x1f\x1fx\n`).join("");
        const g61 = (a) => {
          if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return "/repo\n";
          if (a[0] === "rev-parse" && a[1] === "HEAD") return HD + "\n";
          if (a[0] === "rev-parse" && a[1] === "--verify") return "a".repeat(40) + "\n";
          if (a[0] === "merge-base") return "";
          if (a[0] === "rev-list") return a.includes("--count") ? "61\n" : M61;
          if (a[2] === "diff") return "M\0scripts/lib/gate-rules.mjs\0M\0docs/laws/collab.md\0";
          if (a[0] === "log") return "1759999000\n";
          return "";
        };
        const f61 = readHeadFacts("aaaaaaa", g61, P_.ENGINE_PATHSPECS);
        hp("settleP a9af71da BP-1:基点后 61 笔 ⇒ readHeadFacts 不再 null(一笔聚合项)", f61 && `${f61.commits.length}:${f61.commits[0].aggregated}:${f61.commits[0].count}`, "1:true:61");
        const merge = "git merge --no-ff worktree-agent-x -m m";
        const hunter = { type: "tool_use", name: "Agent", input: { subagent_type: "_gate-bypass-hunter", prompt: "红队合回的 scripts/lib/gate-rules.mjs 改动" } };
        // 批 266:闸引擎面要红队与误拦猎手两者都在
        const fbHunter = { type: "tool_use", name: "Agent", input: { subagent_type: "_gate-false-block-hunter", prompt: "回放合回的 scripts/lib/gate-rules.mjs 改动 --base 1234567" } };
        const ok3 = [all3[0], hunter, fbHunter, all3[2]];
        const c1 = sc({ ledger: { carriers: 0 }, facts: f61, cmd: merge, extra: ok3 });
        const h1 = PR.detect(c1);
        const st1 = settleP(P_, c1, h1.length ? [{ id: "P" }] : []);
        hp("settleP a9af71da BP-1:聚合项 + 三通道齐 ⇒ P 无命中、advance=true、推进到 HEAD、账清零",
          `${h1.length}:${st1.advance}:${st1.head === HD}:${st1.ledger && st1.ledger.carriers}`, "0:true:true:0");
        const c2 = sc({ ledger: { carriers: 0 }, facts: f61, cmd: merge, extra: [all3[0], all3[1], all3[2]] });
        const h2 = PR.detect(c2);
        const st2 = settleP(P_, c2, h2.length ? [{ id: "P" }] : []);
        hp("settleP a9af71da BP-1:聚合项带闸改动、无红队(只有 grill)⇒ P 命中(欠独立视角)、不推进、账按 count 计 61",
          `${h2.map((h) => /独立视角/.test(h.ch) ? "hunter" : "other").join(",")}:${st2.advance}:${st2.ledger && st2.ledger.carriers}`, "hunter:false:61");
      }
      // ENGINE_PATHSPECS 与 ENGINE_REL 同一口径(改一处必改另一处)
      const _Pp = RULES.find((r) => r.id === "P")._p;
      const asRe = (s) => new RegExp("^" + s.replace(/^:\(glob\)/, "").replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*") + "$", "i");
      const samples = ["scripts/hook-stop-closure.mjs", "scripts/hook-guard.mjs", "scripts/lib/gate-rules.mjs", "scripts/lib/gate-x-y.mjs",
        "scripts/lib/ledger-chain.mjs", "scripts/gate-migrate-check.mjs", "clipboard/oss/public-repo/scripts/lib/gate-rules.mjs",
        // 批 260(D160⑥):写入效果分析器、盲审、解析依赖清单进闸引擎面
        "scripts/lib/write-effects.mjs", "scripts/fp-audit.mjs", "scripts/gate-deps/package.json", "scripts/gate-deps/node_modules/x.js"];
      hp("ENGINE_PATHSPECS 与 ENGINE_REL 对同一组路径判定一致",
        samples.map((p) => `${_Pp.ENGINE_REL.test(p) ? 1 : 0}${_Pp.ENGINE_PATHSPECS.some((s) => asRe(s).test(p)) ? 1 : 0}`).join(" "),
        "11 11 11 11 00 00 00 11 11 11 00");
      hp("GATE_ENGINE 认写入效果分析器与盲审", ["scripts/lib/write-effects.mjs", "scripts/fp-audit.mjs", "scripts/gate-deps/package.json"].map((p) => _Pp.GATE_ENGINE.test(p) ? 1 : 0).join(""), "111");
      // 批 266:原样装入的闸引擎(安装清单核对)。假 git:按 `<sha>:<path>` 返回树里的内容
      {
        const ENG = "export const x = 1;\r\n", isEng = (p) => _Pp.ENGINE_REL.test(p);
        const tree = (over = {}) => ({ "c1:scripts/lib/gate-rules.mjs": ENG, "c1:scripts/hook-stop-closure.mjs": "h\n",
          [`c1:${CUSTODIET_MANIFEST}`]: JSON.stringify({ sourceClean: true, files: { "scripts/lib/gate-rules.mjs": contentDigest(ENG), "scripts/hook-stop-closure.mjs": contentDigest("h\n") } }), ...over });
        const fg = (t) => (args) => { if (args[0] !== "show" || !(args[1] in t)) throw new Error("no such object"); return t[args[1]]; };
        const c = (files) => ({ sha: "c1", files });
        const two = [{ path: "scripts/lib/gate-rules.mjs", oldPath: null, status: "A" }, { path: "scripts/hook-stop-closure.mjs", oldPath: null, status: "A" }];
        hp("266 原样装入:两件引擎都与清单一致(CRLF 归一后)⇒ vendored", vendoredEngineCommit(fg(tree()), c(two), isEng), true);
        hp("266 一件内容与清单不同 ⇒ 不算", vendoredEngineCommit(fg(tree({ "c1:scripts/lib/gate-rules.mjs": "export const x = 2;\n" })), c(two), isEng), false);
        hp("266 清单缺这条路径 ⇒ 不算", vendoredEngineCommit(fg(tree({ [`c1:${CUSTODIET_MANIFEST}`]: JSON.stringify({ sourceClean: true, files: { "scripts/lib/gate-rules.mjs": contentDigest(ENG) } }) })), c(two), isEng), false);
        hp("266 红队 BP-1:清单标源树不干净 / 没标 ⇒ 不算", [false, undefined].map((v) => vendoredEngineCommit(fg(tree({ [`c1:${CUSTODIET_MANIFEST}`]: JSON.stringify({ sourceClean: v, files: { "scripts/lib/gate-rules.mjs": contentDigest(ENG), "scripts/hook-stop-closure.mjs": contentDigest("h\n") } }) })), c(two), isEng)).join(","), "false,false");
        hp("266 提交树里没有清单 ⇒ 不算", vendoredEngineCommit(fg({ "c1:scripts/lib/gate-rules.mjs": ENG }), c([two[0]]), isEng), false);
        hp("266 删除 / 改名 ⇒ 不算", [vendoredEngineCommit(fg(tree()), c([{ ...two[0], status: "D" }]), isEng),
          vendoredEngineCommit(fg(tree()), c([{ ...two[0], oldPath: "scripts/lib/gate-old.mjs", status: "R100" }]), isEng)].join(","), "false,false");
        hp("266 聚合项 / 提交里没有引擎文件 ⇒ 不算", [vendoredEngineCommit(fg(tree()), { ...c(two), aggregated: true }, isEng),
          vendoredEngineCommit(fg(tree()), c([{ path: "docs/x.md", oldPath: null, status: "M" }]), isEng)].join(","), "false,false");
      }
      // 批 260(红队 a700dedc (b)-10):第四处口径——回退面 ENGINE_PATH_RE 须覆盖 ENGINE_REL 认的一切
      //   (回退面本来就允许前缀目录,`clipboard/oss/public-repo/scripts/lib/…` 也认——偏严,不要求相等)
      hp("ENGINE_PATH_RE 覆盖 ENGINE_REL", samples.filter((p) => _Pp.ENGINE_REL.test(p) && !_Pp.ENGINE_PATH_RE.test(p)).join(","), "");
      // 红队 a700dedc BP-5:只点名新纳入文件的红队也算绑定
      hp("hunterBound 认新纳入的引擎文件名", ["只看 scripts/lib/write-effects.mjs", "审 fp-audit 的改动", "D160 的修补"].map((t) => _Pp.hunterBound({ input: { prompt: t } }) ? 1 : 0).join(""), "111");
    }
    // ── ranClear:参数面 vs 文本面(2026-08-20 实撞,写完当天被自己绊倒)──────────
    //   原写法 `[\s\S]*` 横跨整条命令 ⇒ 把 `--cond "K 的 --clear 阻断…"` 判成跑过结清。
    //   与 L 项 `[^"]*`、M 项 `\S*` 同族第四次:**正则作用域比我以为的宽**。
    //   六条一次性探针在此转成永久资产——这正是本节存在的理由。
    {
      const rc = (cmd) => ranClearRule({ actions: [{ name: "Bash", input: { command: cmd } }] });
      hp("ranClear:真结清", rc("node --no-warnings scripts/batch-goal.mjs --clear"), true);
      hp("ranClear:--arm 但条件文本里含 --clear(实撞形态)",
        rc('node scripts/batch-goal.mjs --arm 072 --cond "K 的 --clear 阻断与 systemMessage"'), false);
      hp("ranClear:纯 --arm", rc('node scripts/batch-goal.mjs --arm 072 --cond "甲"'), false);
      hp("ranClear:只是 grep 到这个命令串", rc('grep -n "batch-goal.mjs --clear" docs/laws/collab.md'), false);
      // D62 钉(2026-08-26):三条**此前判不中**的真结清形态。前两条是 109 批量词封顶造成的
      //   新洞(超界即不命中 ⇒ 关掉 W 与关账族的触发器),第三条是既有致盲
      //   (stripQuoted 抹掉引号内容 ⇒ 带引号的脚本路径整个消失,而 Windows 上加引号是本能)。
      hp("ranClear:长参数后接 --clear(D62:封顶曾使其漏判)",
        rc("node scripts/batch-goal.mjs --note " + "x".repeat(300) + " --clear"), true);
      hp("ranClear:带引号的绝对路径(既有致盲:stripQuoted 抹掉脚本名)",
        rc('node "/repo/scripts/batch-goal.mjs" --clear'), true);
      hp("ranClear:单引号包裹脚本路径", rc("node 'scripts/batch-goal.mjs' --clear"), true);
      // ⚠️ **不带引号的管道/分号形态**(2026-08-20 codex 三条复现,当时全是 true)。
      //   上面那条 grep 用例带引号,`stripQuoted` 就够了;
      //   下面三条不带引号,**必须逐段判**才杀得掉。
      //   我原先六条只测了带引号那半 —— **同一场景挑了容易的那一边**,
      //   于是宣布这一族收口时,目标反例一条都没死。
      hp("ranClear:管道右侧的 --clear(codex 复现①)",
        rc("cat scripts/batch-goal.mjs | grep -- --clear"), false);
      hp("ranClear:分号后另一条命令的 --clear(codex 复现②)",
        rc("node scripts/batch-goal.mjs --status; echo --clear"), false);
      hp("ranClear:前段提到脚本名、后段是别的脚本(codex 复现③)",
        rc("echo scripts/batch-goal.mjs; node scripts/other.mjs --clear"), false);
      hp("ranClear:真结清后面跟别的命令(对照组,证明不是恒 false)",
        rc("node scripts/batch-goal.mjs --clear; echo done"), true);
      hp("ranClear:结清带后续管道", rc("node scripts/batch-goal.mjs --clear | tail -1"), true);
      hp("ranClear:别的脚本的 --clear", rc("node scripts/other.mjs --clear"), false);
    }

    const RE = /scripts\/[\w.-]+\.mjs|\.claude\/agents\//;

    // bashWriteTargets —— 取的必须是**完整路径**,不是派生正则的前缀(本轮那个阻断 bug)
    hp("bashWriteTargets:sed -i 取完整路径",
      bashWriteTargets("sed -i s/a/b/ scripts/hook-stop-closure.mjs", RE), ["scripts/hook-stop-closure.mjs"]);
    hp("bashWriteTargets:writeFileSync 取入参路径",
      bashWriteTargets(`node -e "fs.writeFileSync('scripts/x.mjs',1)"`, RE), ["scripts/x.mjs"]);
    hp("bashWriteTargets:`--` 是参数终止符不是目标(codex)",
      bashWriteTargets("sed -i s/a/b/ -- scripts/x.mjs", RE), ["scripts/x.mjs"]);
    hp("bashWriteTargets:`..` 要消解(codex)",
      bashWriteTargets("sed -i s/a/b/ scripts/lib/../x.mjs", RE), ["scripts/x.mjs"]);
    hp("bashWriteTargets:`>/dev/null` 不算写目标",
      bashWriteTargets("node scripts/a.mjs > /dev/null", RE), []);
    hp("bashWriteTargets:git 子命令段整段跳过",
      bashWriteTargets("git commit -m scripts/x.mjs", RE), []);
    // ── D7:cp/mv 段逐一验(2026-08-23,朴素切段残余)────────────────────
    hp("D7:cp 双参取目标",
      bashWriteTargets("cp scripts/a.mjs scripts/b.mjs", RE), ["scripts/b.mjs"]);
    hp("D7:单 & 不在切段表里,但 cp 捕获止于 & ⇒ 目标仍对",
      bashWriteTargets("cp scripts/a.mjs scripts/b.mjs & node scripts/run.mjs", RE), ["scripts/b.mjs"]);
    hp("D7:子 shell 括号里的 cp 目标仍取到",
      bashWriteTargets("(cp scripts/a.mjs scripts/b.mjs)", RE), ["scripts/b.mjs"]);
    // 引号包分号:旧切段发生在引号解析之前 ⇒ 真目标丢失(原钉现状)。a2155edb 起切段走 gate-cmd `segments()`
    //   (引号外才切)⇒ 真目标取到。这条转红曾是预告「切段器变了」——现按新行为改钉。
    hp("D7:引号包分号——引号感知切段后真目标取到(a2155edb 改钉)",
      bashWriteTargets('cp "scripts/a;x.mjs" scripts/c.mjs', RE), ["scripts/c.mjs"]);
    // ── a2155edb BP-2 / BP-7:引号感知的写目标(ND 的 Bash 面出路改用本函数)──
    {
      const D = /(?:^|\/)docs\/noun-diary\.md$/i;
      const Q = String.fromCharCode(39);   // 单引号
      const P = String.fromCharCode(124);  // 竖线
      // BP-7 真写入(旧式认不出)
      hp("BP-7:sed -i 脚本里带 | 仍取到目标", bashWriteTargets(`sed -i ${Q}$a ${P} wg ${P} 包管理器 ${P}${Q} docs/noun-diary.md`, D), ["docs/noun-diary.md"]);
      hp("BP-7:Add-Content -Path 反斜杠路径", bashWriteTargets(`Add-Content -Path docs\\noun-diary.md -Value ${Q}${P} wg ${P} x ${P}${Q}`, D), ["docs/noun-diary.md"]);
      hp("BP-7:Add-Content 位置参数", bashWriteTargets(`${Q}${P} wg ${P}${Q} ${P} Add-Content E:\\work\\docs\\noun-diary.md`, D), ["E:/work/docs/noun-diary.md"]);
      hp("BP-7:Out-File -Append -FilePath", bashWriteTargets(`${Q}x${Q} ${P} Out-File -Append -FilePath docs/noun-diary.md`, D), ["docs/noun-diary.md"]);
      hp("BP-7:node appendFileSync(表格行带 |)", bashWriteTargets(`node -e "require('fs').appendFileSync('docs/noun-diary.md', '${P} wg ${P} x ${P}\\n')"`, D), ["docs/noun-diary.md"]);
      hp("BP-7:python open(...,'a')", bashWriteTargets(`python -c "open('docs/noun-diary.md','a', encoding='utf-8').write('${P} wg ${P}')"`, D), ["docs/noun-diary.md"]);
      hp("BP-7:cat heredoc 同行 >> 目标", bashWriteTargets(`cat <<${Q}EOF${Q} >> docs/noun-diary.md\n${P} wg ${P} x ${P}\nEOF`, D), ["docs/noun-diary.md"]);
      hp("BP-7:tee -a 在管道下游", bashWriteTargets(`printf x ${P} tee -a docs/noun-diary.md`, D), ["docs/noun-diary.md"]);
      // BP-2 假写入(旧式误认)
      hp("BP-2:awk 引号里的 > 不是重定向", bashWriteTargets(`awk ${Q}NF > 3${Q} docs/noun-diary.md`, D), []);
      hp("BP-2:--cond 引号里的 > 不是重定向", bashWriteTargets(`node scripts/batch-goal.mjs --cond "日志 >1MB" && grep x docs/noun-diary.md`, D), []);
      hp("BP-2:箭头函数不是重定向", bashWriteTargets(`node -e "[1].map(x=>x)" docs/noun-diary.md`, D), []);
      hp("BP-2:重定向写的是别的文件", bashWriteTargets("grep winget docs/noun-diary.md > clipboard/hits.txt", D), []);
      hp("BP-2:heredoc 正文提到日记路径", bashWriteTargets(`cat <<${Q}EOF${Q} > clipboard/note.md\n见 docs/noun-diary.md\nEOF`, D), []);
      hp("BP-2:grep 的参数 tee 不是命令", bashWriteTargets("grep -n tee docs/noun-diary.md", D), []);
      hp("词界:committee / scp 不是 tee / cp", bashWriteTargets("committee docs/noun-diary.md; scp a docs/noun-diary.md", D), []);
      hp("命令位:包装器(sudo / VAR=)之后的 sed -i 认", bashWriteTargets("LC_ALL=C sudo sed -i s/a/b/ docs/noun-diary.md", D), ["docs/noun-diary.md"]);
      hp("sed 无 -i 不是写", bashWriteTargets("sed -n 1,5p docs/noun-diary.md", D), []);
      // 语料对照(HEAD vs 新版,15379 条命令)逮到的两类回退,当批补上:
      hp("语料回退①:git -C 路径 mv 的目标照认", bashWriteTargets("git -C \\repo mv .claude/commands/plan.md .claude/commands/kplan.md", /\.claude\//), [".claude/commands/kplan.md"]);
      hp("语料回退①对照:git add 不是写", bashWriteTargets("git add docs/noun-diary.md", D), []);
      hp("语料回退②:cmd /c 引号里的重定向递归认", bashWriteTargets(`cmd /c "cd /d \\repo && pnpm graph:check > clipboard\\x.log 2>&1"`, /clipboard\//), ["clipboard/x.log"]);
      hp("语料回退②:bash -c 里的追加递归认", bashWriteTargets(`bash -c "printf x >> docs/noun-diary.md"`, D), ["docs/noun-diary.md"]);
      hp("语料回退②对照:bash 跑脚本文件不递归", bashWriteTargets("bash scripts/x.sh docs/noun-diary.md", D), []);

      // ── 红队 a811daae(对 b7ef430)──────────────────────────────────────────────
      //   对照组口径:「旧」= b7ef430 的实现(派出方与本批语料对照实测),「f4b3a9e 正则」= a2155edb 之前的旧式。
      const G = String.fromCharCode(62);   // >
      const GR = /scripts\/lib\/gate-rules\.mjs$/;
      // BP-4 漏放:段首 shell 保留字 / 带值包装器。旧:八条全 [];f4b3a9e 正则认得 `then cp …`(无词界的 `cp\s+`)。
      hp("BP-4:if…then cp(派出方实测形)", bashWriteTargets("if [ -f clipboard/x.mjs ]; then cp clipboard/x.mjs scripts/lib/gate-rules.mjs; fi", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:for…do cp", bashWriteTargets("for f in a b; do cp clipboard/x.mjs scripts/lib/gate-rules.mjs; done", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:else cp", bashWriteTargets("if false; then :; else cp a scripts/lib/gate-rules.mjs; fi", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:{ cp …; } 组命令", bashWriteTargets("{ cp a scripts/lib/gate-rules.mjs; }", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:! cp 取反", bashWriteTargets("! cp a scripts/lib/gate-rules.mjs", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:xargs -I {} cp(带值选项)", bashWriteTargets(`ls ${P} xargs -I {} cp {} scripts/lib/gate-rules.mjs`, GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:nice -n 10 cp", bashWriteTargets("nice -n 10 cp a scripts/lib/gate-rules.mjs", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:sudo -u bob cp", bashWriteTargets("sudo -u bob cp a scripts/lib/gate-rules.mjs", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:sudo -Eu bob(簇尾带值字母取下一词)", bashWriteTargets("sudo -Eu bob cp a scripts/lib/gate-rules.mjs", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:busybox cp", bashWriteTargets("busybox cp a scripts/lib/gate-rules.mjs", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:timeout -s KILL 5 cp(带值选项 + 时长)", bashWriteTargets("timeout -s KILL 5 cp a scripts/lib/gate-rules.mjs", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("BP-4:find -exec cp … \\; 的终止符不是目标(旧取到 `;`)", bashWriteTargets("find . -name x -exec cp {} scripts/lib/gate-rules.mjs \\;", GR), ["scripts/lib/gate-rules.mjs"]);
      hp("语料对照:find -exec mv -t DIR {} + 取 DIR(旧取到 `+`)", bashWriteTargets("find packets -name x -exec mv -t packets/math {} +", /[\s\S]/), ["packets/math"]);
      hp("BP-4:PS if { Copy-Item } 的 `}` 不是参数", bashWriteTargets("if (Test-Path x) { Copy-Item a scripts/lib/gate-rules.mjs }", GR, "ps"), ["scripts/lib/gate-rules.mjs"]);
      // BP-4 对照组(不得因跳保留字/包装器而多认)
      hp("BP-4 对照:for 的变量名不是命令", bashWriteTargets("for cp in a scripts/lib/gate-rules.mjs; do :; done", GR), []);
      hp("BP-4 对照:if 后的 grep 不是写", bashWriteTargets("if grep -q cp scripts/lib/gate-rules.mjs; then :; fi", GR), []);
      hp("BP-4 对照:xargs 的 -I 值 `cp` 不是命令(旧把值当命令名)", bashWriteTargets(`ls ${P} xargs -I cp echo cp scripts/lib/gate-rules.mjs`, GR), []);
      // BP-5 误拦(同根):旧 ND 正则认得、b7ef430 认不出
      hp("BP-5:if ! grep …; then tee -a 日记 <<EOF", bashWriteTargets(`if ! grep -q winget docs/noun-diary.md; then tee -a docs/noun-diary.md <<${Q}EOF${Q}\n${P} winget ${P} pm ${P}\nEOF\nfi`, D), ["docs/noun-diary.md"]);
      // BP-3 漏放:重定向词冒充「最后一个位置参数」。旧:cp 取到 `2>/dev/null`、tee 取到 `>`、`/dev/null`
      const AG = /\.claude\/agents\//;
      hp("BP-3:cp … 2>/dev/null 取真目标", bashWriteTargets(`cp clipboard/a.md .claude/agents/new.md 2${G}/dev/null`, AG), [".claude/agents/new.md"]);
      hp("BP-3:cp … > log 2>&1 取真目标", bashWriteTargets(`cp clipboard/a.md .claude/agents/new.md ${G} clipboard/log 2${G}&1`, /[\s\S]/), ["clipboard/log", ".claude/agents/new.md"]);   // 重定向目标先收、命令目标后收
      hp("BP-3:tee … > /dev/null 只取日记", bashWriteTargets(`printf x ${P} tee -a docs/noun-diary.md ${G} /dev/null`, /[\s\S]/), ["docs/noun-diary.md"]);
      hp("BP-3:mv … &>/dev/null", bashWriteTargets(`mv a .claude/agents/x.md &${G}/dev/null`, AG), [".claude/agents/x.md"]);
      hp("BP-3:sed -i … 2>/dev/null 不把重定向当文件", bashWriteTargets(`sed -i s/a/b/ docs/noun-diary.md 2${G}/dev/null`, /[\s\S]/), ["docs/noun-diary.md"]);
      // BP-6 方言:掩码与分词同一方言
      const PSX = `Set-Location "\\repo\\"; Add-Content docs\\noun-diary.md "${P} winget ${P} pm ${P}"`;
      hp("BP-6:PowerShell `\"\\repo\\\"` 后的 Add-Content(按工具名 ps)", bashWriteTargets(PSX, D, "ps"), ["docs/noun-diary.md"]);
      hp("BP-6:同串不给方言 ⇒ 自判 ps(cmdlet 形)", bashWriteTargets(PSX, D), ["docs/noun-diary.md"]);
      hp("BP-6:Bash `sed -i \"s/a/\\\" b/\"` 目标(旧取成 `b/ docs/…`)", bashWriteTargets(`sed -i "s/a/\\" b/" docs/noun-diary.md`, D, "bash"), ["docs/noun-diary.md"]);
      hp("BP-6:PS 反引号转义的引号不闭合字符串", bashWriteTargets('Add-Content docs/noun-diary.md "a`"b; c"', D, "ps"), ["docs/noun-diary.md"]);
      hp("BP-6:PS here-string 正文里的 > 不是重定向", bashWriteTargets(`$t = @"\nx ${G} scripts/lib/gate-rules.mjs\n"@\nAdd-Content docs/noun-diary.md $t`, /[\s\S]/, "ps"), ["docs/noun-diary.md"]);
      hp("BP-6 对照:方言给错(bash)⇒ 同串仍按 bash 解(不偷换方言)", bashWriteTargets(PSX, D, "bash"), []);
      hp("BP-6:自判——cmdlet 形但 PS 口径不闭合、bash 闭合 ⇒ 换 bash", cmdDialect(`Set-Content x "a\\" b"`), "bash");
      // 复核红队 aaf414b6 BP-2(365fd54 引入,漏放):PS 标记在未掩码原串上测 ⇒ 引号里的 `$env:` / `|Set-Content` 把 bash 判成 ps
      //   ⇒ `\`+换行续行失效 ⇒ 续行后的目标丢。旧实现(365fd54^)给 ["AGENTS.md"],365fd54 给 [];现 ["AGENTS.md"]。
      const SEDENV = `sed -i ${Q}s/$env:A/$env:B/g${Q} \\\n  AGENTS.md`;
      hp("BP-2b:引号里的 $env: 不算 PS 标记(365fd54 判 ps)", cmdDialect(SEDENV), "bash");
      hp("BP-2b:bash 续行后的目标(365fd54 给 [])", bashWriteTargets(SEDENV, /[\s\S]/), ["AGENTS.md"]);
      hp("BP-2b:引号里的 |Set-Content 不算 cmdlet 段首(365fd54 判 ps)", cmdDialect(`grep -n ${Q}x${P}Set-Content y${Q} AGENTS.md`), "bash");
      hp("BP-2b 对照:引号外的 $env: 仍判 ps", cmdDialect(`$env:X = 1; Add-Content docs/noun-diary.md "y"`), "ps");
      hp("BP-2b 对照:段首 cmdlet 仍判 ps", cmdDialect(`Write-Output "a"`), "ps");
      hp("BP-2b 对照:PS 口径引号外有 $env:、bash 口径(\\\" 转义)把它吞进引号且不闭合 ⇒ 取闭合的 ps", cmdDialect(`echo "a\\" $env:X "b"`), "ps");
      hp("BP-2b:bash `\\`+换行续行整对删除(不留 \"\\n\" 词)", codexWords("cp a \\\n  b"), ["cp", "a", "b"]);
      hp("BP-2b:bash 续行不断词", codexWords("ab\\\ncd"), ["abcd"]);
      hp("BP-2b 对照:单引号内的 \\+换行是字面", codexWords(`${Q}a\\\nb${Q}`), ["a\\\nb"]);
      // 复核红队 aaf414b6 BP-3(365fd54 引入,ND 误拦 / P·K0 漏放):重定向算子在分词后判、引号信息已丢 ⇒
      //   `-Value ">"` 的 `">"` 被当裸算子连 `-Path` 一起剔 ⇒ `-Value` 吞掉真路径。365fd54 给 [],旧实现(365fd54^)按 -Path 取到。
      hp("BP-3b:PS -Value \">\" -Path 日记(365fd54 给 [])", bashWriteTargets(`Add-Content -Value "${G}" -Path docs/noun-diary.md`, D, "ps"), ["docs/noun-diary.md"]);
      hp("BP-3b:PS -Value \"<\" -Path AGENTS.md,自判(365fd54 给 [])", bashWriteTargets(`Set-Content -Value "<" -Path AGENTS.md`, /[\s\S]/), ["AGENTS.md"]);
      hp("BP-3b:引号里的 > 是参数", dropRedirWords(codexWordsShaped(`cp a "${G}" b`)), ["cp", "a", G, "b"]);
      hp("BP-3b:引号里的 >x 是参数", dropRedirWords(codexWordsShaped(`cp a "${G}x" b`)), ["cp", "a", G + "x", "b"]);
      hp("BP-3b:bash 转义的 \\> 是参数", dropRedirWords(codexWordsShaped(`cp a \\${G} b`)), ["cp", "a", G, "b"]);
      hp("BP-3b:PS 反引号转义的 `> 是参数", dropRedirWords(codexWordsShaped("cp a `" + G + " b", true)), ["cp", "a", G, "b"]);
      hp("BP-3b 对照:裸 > 连目标照剔", dropRedirWords(codexWordsShaped(`cp a b ${G} log`)), ["cp", "a", "b"]);
      hp("BP-3b 对照:算子在引号外、目标带引号 ⇒ 本词照剔", dropRedirWords(codexWordsShaped(`cp a b ${G}"log x" 2${G}&1`)), ["cp", "a", "b"]);    }

    // bashWrites —— 与上面同源,契约是「有没有写」而非「写了谁」
    hp("bashWrites:执行一个脚本 ≠ 写它",
      bashWrites("node scripts/batch-goal.mjs --arm 1 > /dev/null", RE), false);
    hp("bashWrites:真写入判真",
      bashWrites("sed -i s/a/b/ scripts/x.mjs", RE), true);
    hp("bashWrites:只读命令不算写",
      bashWrites("grep -c x scripts/x.mjs", RE), false);

    // matchAny —— 返回命中的片段数组;每个模式命中首行即停(这是它的已知语义)
    hp("matchAny:命中返回片段", matchAny("我这就去改", [/我这就去改/]), ["我这就去改"]);
    hp("matchAny:不命中返回空", matchAny("无关的话", [/我这就去改/]), []);

    // extractTargets —— 从一句承诺里取出它承诺要动的对象
    hp("extractTargets:反引号路径被取出",
      extractTargets("我这就去改 `scripts/foo.mjs`").includes("scripts/foo.mjs"), true);
    hp("extractTargets:没有对象时不硬造", extractTargets("我这就去办。").length, 0);
  }

  // ── 零件契约:凡闸调用的辅助函数,必须在自测里被引用 ────────────────────────
  // 立此检查的理由(2026-08-20,用户当场问「为什么闸没拦下」「为什么想不到建闸」):
  //   codex 在 `bashWriteTargets` 上一口气找出 6 处失效(与 bashWrites 判据不一致、
  //   `--` 被当目标、`cp -r a/ b/` 取到目录、heredoc 界符只认 \w、`..` 不消解、
  //   分段器不理解引号)。**三层闸一个都够不到它**:
  //     · 自测:该函数的用例 **0 条**——我用一次性探针验过四条,跑完就丢了,
  //       「验证」做成了动作而不是资产;
  //     · 装载期不变量:INV-3/INV-4 的适用对象是**规则数组**,辅助函数不在视野里;
  //     · 迁移验收台:它比新旧引擎的输出,而该函数两边都用 ⇒ diff 恒为空。
  //   本文件当时有 19 个这类函数,**一个契约都没有**。
  // 判据:从源码取出「被闸调用的辅助函数」,断言它在 selfTest 正文里被引用过。
  // CEILING: 只证「有人在自测里提到它」,**不证那条用例有鉴别力**
  //   (鉴别力归变异验收管,而变异验收目前只覆盖新引擎的规则)。
  //   它把「零覆盖」变成「过不去」,不解决「覆盖得浅」。
  let partPass = 0, partTotal = 0;
  {
    let src = "";
    try {
      src = fs.readFileSync(fileURLToPath(new URL(import.meta.url)), "utf8");   // F6:同上,不用 pathname
    } catch { /* 读不到自己 ⇒ 下面按未检查处理 */ }
    if (!src) {
      console.log("SKIP  零件契约:读不到本文件源码 —— **未检查**,不作通过");
    } else {
      // ⚠️ 判据是「出现在**调用位**」(`name(`),不是「名字出现过」。两次踩坑换来的:
      //   ① 原判据「名字在 selfTest 里出现」被**解释性注释**满足 ⇒ 零用例却 PASS。
      //      「提到 ≠ 做过」——今天追了一整天的错型,长在检查这个错型的检查上。
      //   ② 于是我加了剥注释,而剥注释器是**用正则解析语法**:用例里的 glob
      //      `ls scripts/*.mjs` 中那个 `/*` 被当成块注释开头,一路吃到下一个 `*/`
      //      —— body 从 22655 字符缩到 12368,4 个真有用例的零件全被判成零覆盖。
      //   ⇒ 换成不需要解析的判据:散文提及不会带括号,调用才会。
      const body = src.slice(src.indexOf("function selfTest"));
      // 只管**导出**的辅助函数:它们是被别处调用的接口面,最该有契约。
      //   非导出的内部函数留在下一轮(先把口子小的那半堵上,不一次求全)。
      const parts = [...src.matchAll(/^export function (\w+)\(/gm)].map((m) => m[1])
        .filter((n) => !/^(run|emit|selfTest)$/.test(n));
      for (const n of parts) {
        partTotal++;
        // 「被引用」= 在 selfTest 正文里出现(用例、断言、或作为被测对象)
        const ok = new RegExp(`\\b${n}\\s*\\(`).test(body);
        console.log(`${ok ? "PASS" : "FAIL"}  零件契约:${n} 在自测里有用例` +
          (ok ? "" : "  ← **零覆盖**:改坏它没有任何东西会红"));
        if (ok) partPass++;
      }
    }
  }

  // ── 承重面漂移检查 ────────────────────────────────────────────────────────
  // 外部先例(2026-08-20 WebSearch,GitHub CODEOWNERS):枚举白名单的病是**维护**不是设置
  //   ——「写死的文件路径会在被重命名或移动后失去归属」「最难的不是设置,是维护……
  //   那需要一套流程而不只是意愿」;他们的修法是**加一条漂移测试**,断言路径仍被覆盖。
  // 本仓的病史:CARRIER_SURFACE 已经漏过两轮(08-19 漏 batch-goal.mjs,08-20 漏一整套新闸零件,
  //   含决定所有 hook 跑不跑的 `.claude/settings.json`)。两次都靠人事后想起来补。
  // 判据:闸机件清单**从 `.claude/settings.json` 的 hooks 节反推**,不再手抄第二份;
  //   凡被 hook 调用的本仓脚本,必须被承重面覆盖。新增 hook 忘了纳入 ⇒ 当场转红。
  // CEILING: 只覆盖「被 hook 直接调用的脚本」。被它们 import 的库、以及不经 hook 的
  //   承重件(法典、寄存器)仍靠枚举——这条测试缩小了漏面,没有消灭它。
  let driftPass = 0, driftTotal = 0;
  const machinery = gateMachineryFiles();
  if (machinery === null) {
    console.log("SKIP  承重面漂移:读不到 .claude/settings.json —— **未检查**,不作通过");
  } else {
    for (const f of machinery) {
      driftTotal++;
      const ok = isCarrierPathC(CARRIER_SURFACE, f);   // D63+D86
      console.log(`${ok ? "PASS" : "FAIL"}  承重面漂移:${f}${ok ? "" : "  ← 它是 hook 机件却**不在承重面**,P 不会为它响"}`);
      if (ok) driftPass++;
    }
    // 反向:承重面不该宽到把普通业务代码卷进来
    for (const f of ["src/app/page.tsx", "content/private/x.md", "README.md"]) {
      driftTotal++;
      const ok = !isCarrierPathC(CARRIER_SURFACE, f);  // D63+D86
      console.log(`${ok ? "PASS" : "FAIL"}  承重面不误扩:${f}`);
      if (ok) driftPass++;
    }
  }

  // ── law 锚点解析(D14,2026-08-23)────────────────────────────────────
  // 每条规则的 `law:` 必须解析到目标文件的**真实标题或粗体列点句名**
  // (法典义务多以 `- **X**:` 形存在,只认 # 标题会误判 8 条)。
  // 此前 14+ 条锚点指向不存在的标题,阻断消息给人的是死指针——
  // 修完必须有机器判据看着,否则法典改个标题锚点又静默烂掉(自签条件 b 的反向探针)。
  let lawPass = 0, lawTotal = 0, lawSide = 0;
  const lawObserve = (() => { try { return fs.readFileSync(".claude/custodiet-mode", "utf8").split(/\r?\n/)[0].trim() === "observe"; } catch { return false; } })();
  {
    const hnames = (p) => {
      const out = [];
      try {
        for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
          const h = l.match(/^#{1,6}\s+(.+)$/);
          if (h) out.push(h[1].trim());
          const b = l.match(/^\s*-\s+\*\*([^*]+)\*\*/);
          if (b) out.push(b[1].trim());
        }
      } catch { /* 文件读不到 ⇒ out 空 ⇒ 该锚点判红 */ }
      return out;
    };
    const norm = (s) => s.replace(/[-\s、之]/g, "");
    const cacheH = {};
    for (const r of RULES) {
      if (!r.law) continue;
      lawTotal++;
      const [file, anchor] = String(r.law).split("#");
      // 观察档安装把示例宪法落成旁件 `AGENTS.custodiet.md`,目标仓自带宪法时也是旁件 ⇒ 主文件找不到时再看旁件,
      //   但**只在旁件里**的锚点单列 SIDE、不记 PASS:旁件模型不加载,指针仍是死的(红队 a0dfbfce BP-1:原先并入后判 PASS = 假绿)。
      //   SIDE 只在观察档(模式文件首行 observe)下不让自测变红——那是观察档安装的正常形态;阻断档下照旧计失败
      //   (红队 a30a87d8 BP-1:原先不分档,往自带宪法的仓里正常装闸,9 条锚点全死、自测却放行)。
      const side = file.replace(/(\.[^./]+)$/, ".custodiet$1");
      cacheH[file] ??= hnames(file);
      cacheH[side] ??= hnames(side);
      const hit = (hs) => !!anchor && hs.some((h) => norm(h).includes(norm(anchor)) || norm(anchor).includes(norm(h)));
      const ok = hit(cacheH[file]), sideOnly = !ok && hit(cacheH[side]);
      console.log(`${ok ? "PASS" : sideOnly ? "SIDE" : "FAIL"}  law 锚点:${r.id} → ${r.law}` +
        (ok ? "" : sideOnly ? `  ← 只在未加载的旁件 ${side} 里;并进 ${file} 才算接通` : "  ← 目标文件无此标题/句名"));
      if (ok) lawPass++;
      else if (sideOnly) lawSide++;
    }
  }

  // ⚠️ 2026-08-27:把**载体分类自测**接进来。它此前是个孤儿——只在有人手动
  //   `node -e import(...).selfTest()` 时才跑,于是那张分类表(I/P/G 三项共用的地基)
  //   的用例**从不随闸自测执行**。我当天往里加了 9 条 D63 回归钉,加完才发现这一点
  //   (本批第四次「验过而没钉住」)。**孤儿测试比没有测试更坏**:它让人以为有覆盖。
  let carrPass = 0, carrTotal = 0;
  try {
    const r = carriersSelfTest();
    if (r && typeof r === "object") { carrPass = r.pass; carrTotal = r.total; }
  } catch (e) { console.log(`FAIL  载体分类自测跑不起来:${e && e.message}`); carrTotal = 1; }
  // DP 事实源自测(2026-09-12 批 202;红队第五轮附节 1:原是孤儿,gate:accept 从不真读 git)。缺件(公开树)⇒ 不计。
  let dfPass = 0, dfTotal = 0;
  if (typeof debtFactsSelfTest === "function") {
    try { const r = debtFactsSelfTest({ quiet: true }); dfPass = r.pass; dfTotal = r.total; }
    catch (e) { console.log(`FAIL  debt-facts 自测跑不起来:${e && e.message}`); dfTotal = 1; }
  }

  console.log(`\n自测 ${pass}/${cases.length}` +
    (carrTotal ? ` · 载体分类 ${carrPass}/${carrTotal}` : "") +
    (dfTotal ? ` · 欠账事实 ${dfPass}/${dfTotal}` : "") +
    (seamTotal ? ` · 接缝 ${seamPass}/${seamTotal}` : "") +
    (cxTotal ? ` · codex 账 ${cxPass}/${cxTotal}` : "") +
    (escTotal ? ` · 逃生口 ${escPass}/${escTotal}` : "") +
    (probeTotal ? ` · ranProbe ${probePass}/${probeTotal}` : "") +
    (hpTotal ? ` · 零件用例 ${hpPass}/${hpTotal}` : "") +
    (partTotal ? ` · 零件契约 ${partPass}/${partTotal}` : "") +
    (driftTotal ? ` · 承重面漂移 ${driftPass}/${driftTotal}` : "") +
    (lawTotal ? ` · law锚点 ${lawPass}/${lawTotal}${lawSide ? `(另 ${lawSide} 条只在未加载的旁件里${lawObserve ? ",观察档下不计失败" : ",阻断档下计失败"})` : ""}` : ""));
  return (pass === cases.length && driftPass === driftTotal && probePass === probeTotal
    && partPass === partTotal && hpPass === hpTotal && seamPass === seamTotal && escPass === escTotal
    && cxPass === cxTotal
    && lawPass + (lawObserve ? lawSide : 0) === lawTotal && carrPass === carrTotal && dfPass === dfTotal) ? 0 : 1;
}

// ── main
// ⚠️ **主模块守卫**(2026-08-19 加)。此前本文件的顶层主块**无条件执行**:
//   任何 `import` 它的代码都会触发「读 stdin → exit(0)」,进程当场结束。
//   这正是 grill:testing 报的那条「`emit()` 从未被任何用例执行过」的**根因**——
//   不是没人想测,是**这个文件根本不是 import-safe 的,谁也测不了它**。
//   实撞:迁移验收脚本 import 它之后,自己的输出一行都没打出来、退出码 0。
//   守卫之后,`run` / `emit` 才可以被单元测试与并行 diff 直接调用。
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, "/").split("/").pop());
const argv = IS_MAIN ? process.argv.slice(2) : ["--imported-noop"];
if (argv.includes("--self-test")) process.exit(selfTest());

// --audit <transcript> [--from N] [--to M]:**逐轮**扫描,给每一轮输出命中项。
// 为什么要它:--dry-run 只看最后一轮,测不了「留出集」——而评测一个分类器必须在
// **未参与设计的数据**上逐样本比对(2026-08-19 xros:sharpen 指出:自己编用例自测
// 在分类器评测里叫 testing on training data,必然高估)。本模式产出机器判定侧,
// 人工/独立标注侧另出,两者比对才得出漏报率。
// ── 误报台账(2026-08-22,批 077 条件②;仪器形态来自 xros/reason 第 7 节 + codex 四点最小补救)──
// **半张真相表的危险**:只量误报会诱导「误报少 ⇒ 闸很好」——漏报静默,系统会朝「少吵」
// 而不是「少漏」优化(自审六类结构性失效之⑤:可见性偏差)。故本台账强制携带另一半的缺席声明:
//   · 分母 = `.gate-alerts.jsonl`,由 emit() 自动记**每一次**命中(不是只记被抱怨的那些);
//   · 误报判定**自签有效**(2026-08-22 用户亲裁:「没有这回事,我向来允许你自己修改判据」,
//     与宪法窄例外③「判据过重可自签修其判据」同源)。codex 原药方是 claimed/confirmed 分权
//     ——**审计的诊断对 ≠ 药方对,用户签过字的授权赢**,分权撤;
//     2026-10-12 用户:「为什么我会有『拦错了』按钮——我还能帮你按?有问题不应该自己解决嘛」⇒ `--fp-confirm`(用户加签)
//     与 lanes 面板按钮一并撤掉,独立核对改由 `scripts/fp-audit.mjs` 交 codex **盲审**(不给它看我的理由),
//     判「拦对了」的自动记 retraction(by:codex);批次结清时自动跑;
//   · `miss_review` = 抽查未命中回合的记录({sampled,found}),发现漏报即撤涉事规则「已验收」身份;
//   · `--fp-report` 永远打印 RECALL=UNKNOWN:本台账量不了漏报率,「没看到漏报」≠「没有漏报」。
if (["--fp", "--fp-retract", "--fp-miss", "--fp-report"].includes(argv[0])) {
  const LEDGER = ".claude/.gate-fp-ledger.jsonl";
  // D1/批 102:走 ledger-chain(接线点二)。CLI 语境写失败=任务失败,loud 退出不静默。
  const put = (o) => {
    try { ledgerAppend(LEDGER, { ts: new Date().toISOString(), ...o }); }
    catch (e) { console.error("LEDGER-WRITE-FAILED(.gate-fp-ledger): " + safeErrMsg(e)); process.exit(1); }
  };
  // id 白名单:敲错的 id(E0 打成 E)不报错只会被无声吸收进总数,永远查不出对应哪次命中
  //   (grill:error-handling 2026-08-22 §2 尾段)。RULES 就在 :706 的 import 里,直接用。
  const KNOWN_IDS = new Set(RULES.map((r) => r.id));
  const ckId = (id) => {
    if (KNOWN_IDS.has(id)) return;
    console.error(`没有 id 为「${id}」的规则。合法:${[...KNOWN_IDS].join(",")}`); process.exit(2);
  };
  if (argv[0] === "--fp") {
    const [, id, ...why] = argv;
    // ⚠️ 判**内容**不判数组长度:`--fp K ""` 曾绕过校验写出空理由(grill 沙箱实跑复现)
    const reason = why.join(" ").trim();
    if (!id || !reason) { console.error('用法: --fp <规则id> <为什么拦错了>(理由不得为空白)'); process.exit(2); }
    ckId(id);
    put({ kind: "claimed_fp", id, why: reason, by: "assistant" });
    console.log(`已记 误报:${id}(自签有效,2026-08-22 用户亲裁;批次结清时交 codex 盲审,判拦对了自动撤回)`);
  } else if (argv[0] === "--fp-retract") {
    // 批 258 条件 4:撤回一笔自己记错的误报(那次其实拦对了)。台账只追加,撤回是新的一行,报表按规则扣。
    // 批 259(grill F1):撤回必须指明撤的是哪一笔(`--ref <那笔 claimed_fp 的 h 前缀>`)——不带 ref 的撤回只按规则扣,
    //   会被之后的 codex 盲审对同一笔再扣一次。同时补一行 fp_audit「已人工撤回」,那笔不再送审。
    const ri = argv.indexOf("--ref");
    const refPfx = ri > 0 ? String(argv[ri + 1] || "") : "";
    const rest = argv.filter((_, i) => i !== ri && i !== ri + 1 || ri < 0);
    const [, id, ...why] = rest;
    const reason = why.join(" ").trim();
    if (!id || !reason) { console.error('用法: --fp-retract <规则id> --ref <那笔误报的 h 前缀> <为什么那次其实拦对了>(理由不得为空白)'); process.exit(2); }
    ckId(id);
    const claims = (() => { try { return fs.readFileSync(LEDGER, "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.kind === "claimed_fp" && r.id === id && r.h); } catch { return []; } })();
    const hit = refPfx.length >= 6 ? claims.filter((r) => r.h.startsWith(refPfx)) : [];
    if (hit.length !== 1) {
      console.error(`--fp-retract 须带 --ref 指明撤哪一笔(h 前缀 ≥6 位,且只匹配一笔)。规则 ${id} 最近的自签:`);
      for (const r of claims.slice(-6).reverse()) console.error(`  ${r.h.slice(0, 8)}  ${r.ts}  ${String(r.why || "").slice(0, 60)}`);
      process.exit(2);
    }
    put({ kind: "retraction", id, why: reason, by: "assistant", ref: hit[0].h });
    put({ kind: "fp_audit", ref: hit[0].h, id, verdict: "已人工撤回", why: reason, by: "assistant" });
    console.log(`已记 撤回:${id} @ ${hit[0].h.slice(0, 8)}(该笔不再送盲审)`);
  } else if (argv[0] === "--fp-miss") {
    const [, sampled, found, ...note] = argv;
    const s = +sampled, f = +found;
    // 非负整数 + found ≤ sampled:负数会静默拉低分母、found>sampled 是数不出来的账
    //   (grill 沙箱实跑:`--fp-miss -3 2` 原样通过)
    if (!Number.isInteger(s) || !Number.isInteger(f) || s < 0 || f < 0 || f > s) {
      console.error("用法: --fp-miss <抽样数> <发现漏报数> [说明](两者为非负整数且发现数≤抽样数)"); process.exit(2);
    }
    put({ kind: "miss_review", sampled: s, found: f, note: note.join(" ") });
    console.log(`已记 miss_review:抽 ${s} 发现 ${f}${f > 0 ? " ← 有漏报:涉事规则不得再称「已验收」" : ""}`);
  } else {
    // ⚠️ **坏一行只丢一行,且丢了要喊**(grill 沙箱实跑:原 rd() 一行坏 JSON ⇒ 整份返回 []
    //   ⇒ 报表打出「报警分母: 0」——与「还没积数据」不可区分,正是本仪器最该防的假象。
    //   同文件 consecutiveBlocks() 早有逐行容错先例,新代码当时没沿用)。
    const rd = (p) => {
      let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { return { rows: [], bad: 0 }; }
      const rows = []; let bad = 0;
      for (const l of txt.split("\n")) {
        const s2 = l.trim(); if (!s2) continue;
        try { rows.push(JSON.parse(s2)); } catch { bad++; }
      }
      return { rows, bad };
    };
    // D1/批 102:报表前先验链——断链不瞒报,红行打在报表头(完整性告警的默认路径)
    for (const lf of [".claude/.gate-alerts.jsonl", LEDGER]) {
      try {
        const vr = ledgerVerify(lf);
        if (!vr.ok) console.log(`🔴 台账链违例:${lf} ${vr.violations.length} 处(首处 L${vr.violations[0].line} ${vr.violations[0].kind})——下面的数字不可信,先 ledger-chain verify 查`);
      } catch { /* 验不了照出报表,数字按未担保读 */ }
    }
    const A = rd(".claude/.gate-alerts.jsonl"), L = rd(LEDGER);
    if (A.bad || L.bad) console.log(`⚠ 台账坏行:alerts ${A.bad} / ledger ${L.bad}(已跳过)——下面的数字按缺损读`);
    // 链的结构行(genesis/启用标记)不是事件,不进任何分母(批 102)
    const evRows = (rs) => rs.filter((r) => !r.genesis && r.kind !== "chain-enabled");
    const alerts = evRows(A.rows), led = evRows(L.rows);
    const counted = alerts.filter(fpRowCounted);
    const nAlert = counted.reduce((n, a) => n + fpIdsOf(a).length, 0);
    const per = {};
    for (const a of counted) for (const id of fpIdsOf(a)) per[id] = (per[id] || 0) + 1;
    const claimed = led.filter((x) => x.kind === "claimed_fp").length;
    const audits = led.filter((x) => x.kind === "fp_audit");
    const reviews = led.filter((x) => x.kind === "miss_review");
    const sampled = reviews.reduce((n, r) => n + (r.sampled || 0), 0);
    const found = reviews.reduce((n, r) => n + (r.found || 0), 0);
    console.log(`报警分母: ${nAlert} 规则次 / ${counted.length} 轮(主 Stop 通道;子代理行 ${alerts.length - counted.length} 轮不计)` +
      (nAlert ? `(${Object.entries(per).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ")})` : ""));
    // 人工撤回按笔计(codex 259-final2-r1 附节 3:同笔撤两次原先算式里记 2):带 ref 的按 ref 去重,老式无 ref 的逐行
    const manRows = led.filter((x) => x.kind === "retraction" && x.by !== "codex");
    const manualRetracted = new Set(manRows.filter((x) => x.ref).map((x) => x.ref)).size + manRows.filter((x) => !x.ref).length;
    // 总数与 fpTable 同一算法(fpNetById:按规则扣、各自不低于 0 再求和;含报警台账里没出现过的规则)
    const net = Object.values(fpNetById(led)).reduce((n, v) => n + Math.max(0, v), 0);
    // 盲审按笔去重计(grill 259 F12:原数 fp_audit 行数,重试与取证失败都算进「已审」)——每笔取最后一个结论
    const lastByRef = new Map();
    for (const x of audits) if (x.ref) lastByRef.set(x.ref, x.verdict);
    const byV = (v) => [...lastByRef.values()].filter((y) => y === v).length;
    console.log(`误报: ${net}(自签 ${claimed} − 人工撤回 ${manualRetracted} − 盲审判拦对了 ${byV("拦对了")})` +
      (nAlert ? `  (误报/报警 = ${(net / nAlert * 100).toFixed(1)}%)` : ""));
    // 2026-10-12:自签误报的独立核对 = codex 盲审(scripts/fp-audit.mjs);未审的笔数照实印,不让「自签」冒充「已核」
    console.log(`独立盲审(codex): 自签 ${claimed} 笔中已审 ${lastByRef.size}——拦错了 ${byV("拦错了")} / 拦对了 ${byV("拦对了")}(计为撤回)/ 判不出 ${byV("判不出")} / 取证失败 ${byV("取证失败")} / 已人工撤回 ${byV("已人工撤回")}`);
    console.log(`未命中抽查: 已审 ${sampled},发现漏报 ${found}${found > 0 ? " ← 涉事规则不得再称「已验收」" : ""}`);
    console.log(`RECALL=UNKNOWN —— 本台账量不了漏报率;「没看到漏报」≠「没有漏报」`);
    // 批 258 条件 4:按规则的报警量 × 误报率表;误报率 ≥15% 且报警 ≥20 ⇒ 下一批待修(`--hot` 只印待修行,供 batch-goal 开批时列出)
    const tbl = fpTable(alerts, led);
    const hotOnly = argv.includes("--hot");
    if (!hotOnly) console.log("\n规则  报警  误报  误报率  待修");
    for (const r of tbl) if (!hotOnly || r.hot) console.log(`${hotOnly ? "待修 " : ""}${r.id.padEnd(4)}  ${String(r.alerts).padStart(4)}  ${String(r.fp).padStart(4)}  ${(r.rate * 100).toFixed(1).padStart(5)}%  ${r.hot ? "← 下一批待修" : ""}`);
  }
  process.exit(0);
}

if (argv[0] === "--audit") {
  const p = argv[1];
  if (!p || !fs.existsSync(p)) { console.error("用法: --audit <transcript.jsonl> [--from N] [--to M]"); process.exit(2); }
  const all = readTranscript(p);
  // 切分「轮」:每个真实 user 消息开启一轮
  const bounds = [];
  all.forEach((e, i) => {
    if (e.type !== "user") return;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return;
    bounds.push(i);
  });
  const from = Number(argv[argv.indexOf("--from") + 1]) || 1;
  const to = Number(argv[argv.indexOf("--to") + 1]) || bounds.length;
  // ── D46(批 101):逐轮重放与生产 turn 组装**同构** ──────────────────────────
  //   旧实现把轮切片落盘再裸调 run(tmp):entries=切片 ⇒ 窗口只剩本轮、turn 重切错位,
  //   且 batchGoal 从磁盘按**今天**读——重放批 093 的历史轮看到的是批 101 的条件
  //   (scratchpad/d101-replay.mjs 直证)。现改:
  //   · entries = 该轮结束时点前的**全部**条目(生产 _allEntriesCache 的复刻,
  //     窗口经 run() 内同一条 _priorWindow 路取);
  //   · turn = lastTurn(entries)(生产同款,含边界②′);
  //   · batchGoal = 该轮时点的批状态,从只追加台账 .batch-goal.jsonl 折算注入。
  //   已知保真度上限:bgTasks(官方载荷)与 pLedger(状态文件被覆盖)离线拿不到,
  //   A 退回正则配对、P 退回窗口计账——重放结论对这两项只作方向参考。
  const bgJournal = (() => {
    try {
      return fs.readFileSync(".claude/.batch-goal.jsonl", "utf8").split("\n")
        .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return null; }
  })();
  const batchGoalAt = (ts) => {
    // 台账拿不到/时点无 timestamp ⇒ 通道**不供**(undefined):K/K0 走契约层 UNKNOWN,
    // 与「时点之前无行 = 真没武装(null)」严格分开——三态纪律与 readBatchGoal 同。
    if (!bgJournal || !Number.isFinite(ts)) return undefined;
    let g = null;
    for (const row of bgJournal) {
      if (Date.parse(row.at) > ts) break;
      if (row.action === "arm") g = { batch: row.batch ?? null, cleared: false, armedAt: row.at,
        conditions: Array.isArray(row.conditions) ? row.conditions : [] };
      else if (row.action === "clear") g = { batch: row.batch ?? null, cleared: true,
        closedConditions: Array.isArray(row.conditions) ? row.conditions : [] };
    }
    return g;
  };
  console.log(`轮次总数: ${bounds.length};本次扫描 ${from}–${to}` +
    (bgJournal ? "" : "(⚠ 批状态台账读不到 ⇒ K/K0 按 UNKNOWN 报)"));
  const tally = {};
  for (let r = from; r <= Math.min(to, bounds.length); r++) {
    const s = bounds[r - 1], e2 = r < bounds.length ? bounds[r] : all.length;
    const slice = all.slice(s, e2);
    const upto = all.slice(0, e2);
    let roundTs = NaN;
    for (let i = e2 - 1; i >= s; i--) {
      const t = Date.parse(all[i]?.timestamp || "");
      if (Number.isFinite(t)) { roundTs = t; break; }
    }
    const ids = run(null, { entries: upto, turn: lastTurn(upto), batchGoal: batchGoalAt(roundTs) })
      .map((f) => f.id).sort();
    ids.forEach((i2) => { tally[i2] = (tally[i2] || 0) + 1; });
    const uq = slice[0]?.message?.content;
    const qtext = Array.isArray(uq) ? (uq.find((b) => b?.type === "text")?.text || "").slice(0, 42).replace(/\n/g, " ") : "";
    console.log(`  轮 ${String(r).padStart(3)}  [${ids.join(",") || "—"}]  ${qtext}`);
  }
  console.log(`\n各项命中轮数: ${JSON.stringify(tally)}`);
  process.exit(0);
}

if (argv[0] === "--dry-run") {
  const p = argv[1];
  if (!p || !fs.existsSync(p)) { console.error("用法: --dry-run <transcript.jsonl>"); process.exit(2); }
  const f = run(p);
  if (!f.length) console.log("收尾闭环闸: 无命中");
  process.exit(emit(f) === 2 ? 0 : 0); // dry-run 永不阻断
}

// 被 import 时到此为止——下面是 hook 的生产路径,不该在别人 import 它时跑。
if (!IS_MAIN) { /* 仅导出 run/emit 供测试与迁移 diff 使用 */ }
else {
// ── cwd 锚定(2026-08-25 实撞,批 102):本闸全部世界面(.claude/* 台账、批状态、settings)
//   都按**进程 cwd** 相对寻址,而 hook 进程继承会话 shell 的 cwd——shell 停在 OSS 暂存树时,
//   整闸把暂存树当仓审:读暂存树批状态报 K0「从未确认武装」、四项阻断全是审错树的假警报,
//   台账行还写进了暂存树。生产路径一律锚定到**本脚本所属仓根**(scripts/ 的上一级);
//   锚定失败按原 cwd 跑(fail-open:锚不上不该让闸崩)。CLI 模式(--audit/--fp 等)不锚——
//   用户传的相对路径以他的 cwd 为准。
try {
  // ⚠️ 路径归一必须走 fileURLToPath(F6,2026-08-26 grill:edge-cases 审出并机器复证):
  //   `URL.pathname` **保留百分号编码**,`.replace` 只脱盘符不解码 ⇒ 仓路径含空格/中文时
  //   得到 "C:/my%20test%20repo/",chdir 抛 ENOENT ⇒ 被下面的 catch 吞掉 ⇒ **静默退回继承的 cwd**,
  //   正是 2026-08-25 那次「审错树」事故的原状——修 cwd 的这行自己会在带空格的仓上失效。
  //   custodiet 已公开,`C:\Users\Some Name\...` 在 Windows 上是常态,故这条按公开面优先级修。
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
} catch (e) {
  // 锚定失败按原 cwd 跑(fail-open),但要出声(批 261,D110:原先静默——审错树时没人知道)
  console.error(`⚠ 收尾闸锚定仓根失败,按当前目录 ${process.cwd()} 审:${String(e && e.message || e).slice(0, 160)}`);
}
// 自测隔离 env 只属 --self-test 形态:外部把 STOP_CLOSURE_SELFTEST=1 带进生产环境时,
// batch-goal 与 P-ledger 两处真读会被静默跳过(codex 104 复核「没问到的」)——生产段进门即清。
delete process.env.STOP_CLOSURE_SELFTEST;
let payload = "";
try { payload = fs.readFileSync(0, "utf8"); } catch {}
let hookInput = {};
try { hookInput = JSON.parse(payload || "{}"); } catch {}

// ── SubagentStop:在**子代理自己的边界**上判它自己的动作(D60,批 112)────────────
//
// 为什么走这条路而不是「父侧把子代理动作并进 ctx」:两条只读通道独立收敛到同一判词,
// 且给了机器证据——把一份**真实**子代理转录喂进 buildCtx,`didCommit()` 变 true 而
// 那 4 条「提交」全是它写测试夹具时的**字符串字面量**(真实 commit 次数 0)⇒ K0 由提示升阻断。
// 那正是本仓 gate-ctx 头注第 12 行记的事故换了个信使。另一条更根本:`agent-*.jsonl` 是
// **可写文件**,父侧拿它当自己的证据 = 开一个「伪造『我做过 X』」的新洞。
// 在子代理自己的边界上判它自己,则不涉及跨主体归并:被审的和产出证据的是同一方,
// 与主档的信任假设**同级**,不是新增假设。
//
// 地基事实(2026-08-26 一次性探针实测,记 docs/carrier-facts.md;探针用完即拆):
//   本事件的 `transcript_path` 指**父**会话,`agent_transcript_path` 才指子代理那份。
//   照 Stop 的习惯直接用 transcript_path 会**审错对象且不报错**——我本来就要那么写。
//
// 本版刻意**只做两条**(I 造物须先扫工具面 / M 写了须回读),且**非阻断**:
//   · 现有 23 条规则一条不改(两家通道一致要求的规模纪律);
//   · P 的满足侧永不吃后代动作 ⇒ 本分支不碰 P;
//   · 首版走 additionalContext 提示面,先量误报再谈升阻断。
// 失效条件:`agent_transcript_path` 缺席 ⇒ 报 UNKNOWN 提示行,**不得静默跳过**(fail-closed 的提示面版本)。
//   (旧注称该字段「harness 内部、无文档承诺」——已过时:官方 hooks 页 SubagentStop 节已列出该字段,
//    2026-10-09 主会话取页核实。缺字段的兜底照留,防日后改名。)
if (hookInput.hook_event_name === "SubagentStop") {
  const say = (s) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SubagentStop", additionalContext: s },
  }));
  const at = hookInput.agent_transcript_path;
  const who = `${hookInput.agent_type || "?"}/${String(hookInput.agent_id || "?").slice(0, 8)}`;
  // 批 265 观察档同样覆盖子代理通道(红队 a9bf37ae BP-4):不阻断、不输出。**先判观察档再决定说不说话**
  //   (codex 265-deliverables-r1 §10:原先缺字段那条 UNKNOWN 在判观察档之前就输出了)。
  //   会话起点取**父会话**转录的首条时间戳(`transcript_path` 指父会话,见上)——子代理自己的转录起点更晚,用它会让
  //   父会话里写入并提交的模式文件在子代理收尾时被认。读不到父会话起点 ⇒ 不认观察档(照常判)。
  try {
    const fd = fs.openSync(String(hookInput.transcript_path || ""), "r");
    const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const t = buf.toString("utf8", 0, n).split("\n").map((l) => { try { return JSON.parse(l).timestamp; } catch { return null; } })
      .find((x) => typeof x === "string" && Number.isFinite(Date.parse(x)));
    _allEntriesCache = t ? [{ timestamp: t }] : [];
  } catch { _allEntriesCache = []; }
  const SUB_OBSERVE = observeMode();
  const subLedger = (ids, observed) => {
    try {
      ledgerAppend(".claude/.gate-alerts.jsonl", { ts: new Date().toISOString(), ids, blocked: [], observed, observe: true,
        channel: "SubagentStop", sid: String(hookInput.session_id || "") || undefined,
        // 子代理全号 + 它自己的转录路径:事后回到原文用(codex 265-deliverables-r2 §3:原先只有截成 8 位的 who)
        agent: `${hookInput.agent_type || "?"}/${hookInput.agent_id || "?"}`, agentTranscript: typeof at === "string" && at ? at : undefined, streak: 0 });
    } catch (e) {
      // 观察档下这行台账是唯一痕迹 ⇒ 写不了必须出声(红队 a0dfbfce BP-3;与主通道 LEDGER-WRITE-FAILED 同口径)
      try { process.stderr.write("LEDGER-WRITE-FAILED(.gate-alerts,SubagentStop): " + safeErrMsg(e) + "\n"); } catch { /* 空 */ }
    }
  };
  if (typeof at !== "string" || !at) {
    if (SUB_OBSERVE) { subLedger(["UNKNOWN"], []); process.exit(0); }
    say(`⟦子代理闸 UNKNOWN⟧ ${who}:payload 里没有 agent_transcript_path(官方 SubagentStop 字段,可能已改名)。`
      + `本分支全部项(含 A 的 codex 账)判不了 ⇒ 按 fail-closed 报出来,不当作「没问题」。`);
    process.exit(0);
  }
  let out = "";
  let aBlock = [];   // A 的 codex 账在子代理边界上的阻断行(v3:运行中 / 已产出待读 / 失败未处理)
  let hitIds = [];   // I/M/L/B 命中的规则号(观察档落账用)
  let aNote = false;        // A 有提示行(账出错 / 降为提示)
  let subUnknown = false;   // 有项没判成(超预算 / 读转录失败 / A 账出错)——与命中并存时也要记(codex 265-deliverables-r2 §4)
  try {
    const st = fs.statSync(at);
    const CAP = 4_000_000;                       // 字节预算:超了报 UNKNOWN,不截断继续
    if (st.size > CAP) {
      subUnknown = true;
      out = `⟦子代理闸 UNKNOWN⟧ ${who}:转录 ${(st.size / 1e6).toFixed(1)}MB 超预算 `
        + `${CAP / 1e6}MB,I/M/L/B 不截断继续(截断=fail-open)。A 项(codex 账)只读尾段照跑(BP4-13)。`;
      const v = subagentCodexSafe(readTranscriptTail(at, CAP), liveCodexEnv());
      aBlock = v.block;
      if (v.notes.length) out += `\n  · ${v.notes.join("\n  · ")}`;
      if (v.notes.some((n) => /^A:UNKNOWN/.test(n))) subUnknown = true;
      if (v.notes.some((n) => /^A:/.test(n))) aNote = true;
    } else {
      const entries = readTranscript(at);
      // 批 255:原为 `{ tracked: _trackedCache … }`,而本分支跑在 `run()` 之前、缓存从未初始化
      //   ⇒ tracked 恒为 undefined ⇒ isNew 对一切路径判真(红队 BP-3)。现与主 Stop 通道同口径取证。
      const sCtx = buildCtx(entries, isNewEvidence(hookInput.session_id));
      // ── D60 余项裁决(2026-08-27,批 119)。判据=**每条规则的触发门依赖什么**:
      //   · `G`(造物没入册)门是 `didCommit` —— **子代理不提交** ⇒ 那道门永远开不了,
      //     接进来只会制造「跑了但从不响」的假覆盖。**不接入**。
      //   · `K0`(没武装完成条件)门是 `batchGoal` + `didCommit` —— 批目标是**会话级**概念,
      //     子代理不武装批。同上,**不接入**。
      //   · `L`(手工清点工具面而没用现成普查器)与 `B`(承诺必闭环)只吃**本轮动作与文本**,
      //     在子代理边界上语义完整 ⇒ **接入**。
      //   ⇒ 「G/K0 接入」这条余项的答案是**不接**,而且理由不是「以后再说」,
      //     是它们的触发门在这个边界上结构性地开不了。
      // **升阻断的判据**(不再含糊):本项保持**非阻断**,直到子代理面累计出现
      //   ≥10 次命中且 fp 台账零条 —— 有了这个分母才谈得上升档;
      //   在那之前升档等于拿一个没量过误报率的判据去拦人。
      const only = new Set(["I", "M", "L", "B"]);
      const subFindings = runRules(RULES.filter((r) => only.has(r.id)), sCtx);
      hitIds = subFindings.map((f) => f.id);
      const hits = subFindings
        // finding 形状 = `{ id, block, msg }`(gate-registry.mjs:174);msg 是多行数组或字符串。
        .map((f) => {
          const m = Array.isArray(f.msg) ? f.msg.join(" ") : String(f.msg || "");
          return `${f.id}:${m.replace(/\s+/g, " ").trim().slice(0, 110)}`;
        });
      // A 的 codex 账在子代理自己的边界上跑(批 257 v3):子代理自己发车的作业,运行中 / 已产出待读 / 失败未处理
      //   都**阻断**(谁发车谁读;作业没结束不得收尾)。依据 = 用户亲签代价模型「不接受只记录降级」,
      //   不另走 D60 升档门(D60 管 I/M/L/B 的提示面)。账出错 ⇒ 点名 A 的 UNKNOWN 行,不静默(BP3-4)。
      const v = subagentCodexSafe(entries, liveCodexEnv());
      aBlock = v.block;
      hits.push(...v.notes);
      if (v.notes.some((n) => /^A:UNKNOWN/.test(n))) subUnknown = true;
      if (v.notes.some((n) => /^A:/.test(n))) aNote = true;
      if (hits.length) {
        out = `⟦子代理闸⟧ ${who} 收尾时命中 ${hits.length} 项(提示面,不阻断):\n  · `
          + hits.join("\n  · ")
          // ⚠️ 这一行**从 `only` 生成**,不再手写(2026-08-27):原文写死「只跑 I 与 M」,
          //   而我当轮把 L/B 加进 `only` 后它**当场说谎**——消息与判据两处各写一遍,
          //   本会话第十三次同型,这次隔了不到十分钟。凡「消息里列举判据内容」的地方,
          //   都得从判据本身派生,否则下一次改判据的人不会想起来改这句话。
          + `\n本闸在**它自己的**动作面上跑这几项:${[...only].join(" / ")}。`;
      }
    }
  } catch (e) {
    subUnknown = true;
    out = `⟦子代理闸 UNKNOWN⟧ ${who}:读转录失败(${String(e.message).slice(0, 60)})——本分支全部项(含 A 的 codex 账)未跑,报出来不静默。`;
  }
  if (SUB_OBSERVE) {
    // 观察档也要落账(codex 265-r1 附 1:原先直接退出,本该阻断的子代理收尾零记录);
    //   提示项 I/M/L/B 的规则号也记上(codex 265-deliverables-r1 §10:原先只记 A),读转录出错记 UNKNOWN
    // A 的提示行(账出错 / 被 STOP_CLOSURE_BLOCK_A=0 降为提示)也记 A,不让它被同轮的 I/M/L/B 命中吞掉(红队 a0dfbfce BP-2)
    const aNoted = aBlock.length > 0 || aNote;
    const ids = [...(aNoted ? ["A"] : []), ...hitIds, ...(subUnknown ? ["UNKNOWN"] : [])];
    if (ids.length) subLedger(ids, aBlock.length ? ["A"] : []);
    process.exit(0);
  }
  if (aBlock.length) {
    // 阻断形态与主 Stop 通道同口径(stdout decision:block + stderr 同文 + exit 2)。
    const reason = `⟦子代理闸·A 阻断⟧ ${who}:你自己发起的 codex 作业还没闭环,读回再收尾:\n  · ${aBlock.join("\n  · ")}` +
      (out ? `\n同时提示:${out}` : "");
    try { process.stdout.write(JSON.stringify({ decision: "block", reason })); } catch { /* 空 */ }
    try { process.stderr.write(reason + "\n"); } catch { /* 空 */ }
    process.exit(2);
  }
  if (out) say(out);
  process.exit(0);
}

// ⚠️ 官方明写:**优先用 `last_assistant_message`,不要解析 transcript**
// ——「the transcript file isn't guaranteed to include the final message at Stop time
// on all versions」(hooks.md;字段自 changelog:3829 起可用)。
// transcript 仅作 fallback 与 --audit/--dry-run 离线模式之用。
// ⚠️ **载荷键名捕获**(2026-08-20 加):官方 hooks 页在 Stop 的输入 schema 那节被截断,
//   `stop_hook_active` 是否存在**文档未记载**(≠ 不存在)。而这件事有比文档更硬的通道:
//   看闸自己收到了什么。**只记键名不记值**——值里可能有 transcript 路径与正文。
//   落点在 gitignore 面内(冲突表 #3:遥测追加不计写入)。查清后即可拆。
// ⚠️ 2026-08-27(D68 出路①):**扩成通用形态并入册**。
//   立此的教训:2026-08-26 我要查 `SubagentStop` 的载荷长什么样,**新建了一个探针脚本**,
//   被 I 项当场逮到——而这套设施本来就在这儿、落点也现成,我只是**没找到它**。
//   纪律 32 的字面要求是「动手前扫工具面」,我扫的时机是「造完被拦了」。
//   ⇒ 两条修法:①这里改成**按事件名记全部顶层键名**(不只 Stop、不只一个字段),
//     ②写进 `docs/tool-register.md`,让下次的工具面扫描**搜得到它**。
//   **只记键名 + 布尔/数字这类无正文的标量值**——字符串值里可能有 transcript 路径与正文。
//   落点在 gitignore 面内(冲突表 #3:遥测追加不计写入)。
//   开关:`GATE_PAYLOAD_CAPTURE=0` 关闭。默认开,因为成本是一行 append。
//   失效条件:当某事件的键名连续 N 批无新增时,该事件从捕获面移除(手动,无自动裁撤)。
try {
  if (process.env.GATE_PAYLOAD_CAPTURE !== "0") {
    const evt = String(hookInput.hook_event_name || "(无事件名)");
    const keys = Object.keys(hookInput || {}).sort();
    // 标量白名单:只记**不可能含正文/路径**的类型,字符串一律只记键名不记值。
    const scalars = keys
      .filter((k) => typeof hookInput[k] === "boolean" || typeof hookInput[k] === "number")
      .map((k) => `${k}=${JSON.stringify(hookInput[k])}`);
    fs.appendFileSync(".claude/.hook-payload-keys.log",
      `${new Date().toISOString()} ${evt} keys=[${keys.join(",")}]` +
      (scalars.length ? ` ${scalars.join(" ")}` : "") + "\n");
  }
} catch { /* 捕获失败不影响闸本身 */ }

const lastMsg = typeof hookInput.last_assistant_message === "string" ? hookInput.last_assistant_message : "";
const bgTasks = hookInput.background_tasks;
const tp = hookInput.transcript_path || "";
// 2026-10-09 用户裁撤「同一时刻只许一个写会话」的会话判活检查(「没看到这个查写会话带来的任何好处;真正应该解决的是工作树和 branch」):
//   规则 CW 与 Stop 时点的 session-triage 注入一并删除;并发写改由 git 隔离(各写会话在自己的 worktree 与分支上干活),见 docs/laws/collab.md。
try {
  let findings;
  if (lastMsg) {
    // 主路径:官方字段。文本取 last_assistant_message,动作面仍需 transcript 才看得到
    // (官方未在 Stop 输入里给本轮工具调用清单),故两者并用:文本用官方字段,
    // 动作与 job 追踪在 transcript 可读时补齐——读不到就只跑纯文本那几项。
    const turn = tp && fs.existsSync(tp) ? lastTurn(readTranscript(tp)) : [];
    // ⚠️ 文本源必须是「官方字段 + 本轮全部 assistant 文本」的**并集**。
    //   官方建议优先用 last_assistant_message(避免 transcript 在 Stop 时缺最后一条),
    //   但一「轮」里可能说了好几段——自审/扫描声明写在轮内较早那段、最后一段是总结,
    //   只看 last_assistant_message 就判它没写(2026-08-19 实撞,G 项误报)。
    const turnText = assistantText(turn);
    const merged = turnText.includes(lastMsg) ? turnText : `${turnText}\n${lastMsg}`;
    // `sessionId`:写前实测台账按会话过滤(D100,codex 复核逮到「任一次已存在」覆盖「本轮首次不存在」)
    findings = run(tp && fs.existsSync(tp) ? tp : null, { text: merged, turn, bgTasks, live: true, sessionId: hookInput.session_id });
  } else {
    if (!tp || !fs.existsSync(tp)) process.exit(0);   // fail-open:两个来源都没有就放行
    findings = run(tp, { bgTasks, live: true, sessionId: hookInput.session_id });
  }
  process.exit(emit(findings, consecutiveBlocks(tp), { live: true }));
} catch (e) {
  // fail-open:闸自身出错一律放行——会误阻断的收尾闸比没有闸更坏。
  //
  // ⚠️ 但**必须出声**(2026-08-19 grill:error-handling 实测,当日最重的一条发现):
  //   原实现只写一行 stderr 然后 exit 0,而 **exit 0 上的 stderr 不进 `hookErrors`**。
  //   实测结果:「闸跑完无命中」与「闸崩在第一项之前」两种情形的 transcript 记录
  //   **逐字节相同**(hookCount:1 / hookErrors:[] / hasOutput:false)。
  //   于是「没看到 hook feedback」既可能是全过、也可能是闸已经死了,从外面分不出。
  //   这正是本仓自己的判据类型闸禁止的事:null 只能读作「未观测到」,不能读作「没发生」。
  //   修法:走 findings 已经在用、且已被 27 条真实转录证实可达的 `additionalContext` 通道。
  //   方向不变(仍 exit 0、仍不误拦),只是**不再隐身**。
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          `⚠️ 收尾闸自身未完成:${safeErrMsg(e)}\n` +
          `**本轮全部检查未跑,不得读作「无命中」。** 这一行是它唯一的求救信号——` +
          `exit 0 上的 stderr 不进 hookErrors,没有这行就与「全过」无从区分。`,
      },
      // ⚠️ **三态不能共用一个结论**(2026-08-20,codex 075 与 grill:recon Q2 **各自独立**撞上)。
      //   codex 原话:「**未命中、判据不确定、闸自身失效**不能共用一个『放行/阻断』结论」。
      //   现状:①未命中 → exit 0;②判据不确定 → 已在 `runRules` 里按 UNKNOWN 阻断;
      //         ③闸自身失效 → **也是 exit 0** ⇒ ①与③在退出码上不可分辨。
      //   方向不改(仍不阻断:会误阻断的收尾闸比没有闸更坏),
      //   但**闸失效必须到达人**——`additionalContext` 只进模型,
      //   而今天已经证明模型(我)会把它当背景读:那个心跳我连答八轮 Idle 都没看它一眼。
      //   ⇒ 同时走 `systemMessage`(官方给用户看的通道,当日已实测投递)。
      systemMessage: `⚠ 收尾闸**自身崩了**,本轮全部检查一项未跑(${safeErrMsg(e).slice(0, 80)})。` +
        `已放行,但**这不是「全过」**。`,
    }));
  } catch { /* 连这一步都失败就只剩 stderr */ }
  // ⚠️ 「最后求救」这一行自己也不许抛(grill 逐行核出:同款毒 e 在此二次抛 ⇒
  //   逃出整个 catch ⇒ 进程裸崩,exit(0) 永远到不了,退出码语义整个变形)。
  try { process.stderr.write(`收尾闭环闸自身出错(已放行,不阻断): ${safeErrMsg(e)}\n`); } catch { /* 空 */ }
  process.exit(0);
}
}
