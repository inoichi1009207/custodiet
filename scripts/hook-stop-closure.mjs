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
//   A  委派/后台任务未闭环   —— 发起过的 job/task 此后再没被提过。       【阻断】
//   E0 裸因果断言            —— 下了因果断言且三条出路一条没走。         【阻断】
//   I  新建载体未扫工具面     —— 写了 agents/skills/commands/scripts 而无扫描痕迹。【阻断】
//   J  立/改法未交代触发层   —— 动了 AGENTS.md 或 docs/laws/ 而没说它靠什么触发。【阻断】
//   E2 缺「形」那一半      —— 没问过有没有机械判据;自标「推断」不豁免本项。【阻断】
//   K  完成条件未逐条对照   —— 已提交而条件没逐条写达成/未达成。      【阻断】
//   K0 动了工作面未武装条件 —— 已提交则拦,未提交则提示。            【阻断/提示】
//   B 承诺未兑现 / C 缺陷陈述无处置 / D 强制项被降级成征询
//   E1 缺独立性那一半 / F 完成断言与欠件并存 / G 提交前无自审 / H 自陈「能做」却无落地动作【提示】
//
// 天花板(CEILING):除 A 外全部是关键词匹配,**判不出语义**。
//   已知误报:①「X 没有 Y」可能只是在回答提问 ②引用/复盘一句断言与说出它同样命中
//            ③讨论某条纪律时会撞上该纪律的关键词。
//   已知漏报:C/H 的豁免看「本轮有没有写动作」而非「写的是不是那件事」——
//            **一次无关的 Edit 即可豁免整项**;判「这个写动作是否对应那个自陈」需要语义。
//   A 只证发起与取回未配对,不证结果被读懂或被采纳。
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
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
      }
    } catch { /* 台账读不到 ⇒ 维持现状,fail-closed 那侧 */ }
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
  K: "K", K0: "K", M: "M", R: "R", Q: "Q", S: "S", T: "T", U: "U", ND: "ND", X: "X" };

// ⚠️ **由 BLOCK_ENV 计算得出,不再是第二张手写表**(D21 结案,codex 072 裁决原话:
//   「对账只能发现漂移,不能阻止漂移」——一份表按构造不漂)。
//   E1 刻意不在 BLOCK_ENV(非阻断);P 刻意不在(**无逃生口**,用户裁定,对账测试同步注册例外)。
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

// 本「轮」= 最后一条 user 行之后的全部条目。找不到 user 行则取全文件。
// 「本轮」= 最后一个**轮次边界**之后的全部条目。边界有两种:
//   ① 真实用户发言;② **本闸自己上一次输出**(hook feedback,落在 type:"system" 的 hookErrors)。
// 为什么要 ②:连续几轮都是 system reminder 时,只认 ① 会让「本轮」无限增长,
//   于是**已经纠正过的旧句被反复重判**(2026-08-19 实撞:同一句完成断言被 F 项连判三轮)。
//   hook feedback 天然是轮次边界——它之后的输出才是「对上次拦截的回应」。
export function lastTurn(entries) {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
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
    if (typeof c === "string" && c.startsWith("Stop hook feedback:")) { start = i + 1; break; }
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

function checkA(entries) {
  const raw = rawText(entries);
  const started = new Set();
  const closed = new Set();
  // 两种发起形态:codex-run 打印的 CODEX_JOB=,与后台 Bash 的 task id
  for (const m of raw.matchAll(/CODEX_JOB=([A-Za-z0-9_-]+)/g)) started.add(m[1]);
  for (const m of raw.matchAll(/running in background with ID:\s*([A-Za-z0-9_-]+)/g)) started.add(m[1]);
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
const REDIRECT_TARGET_RE = new RegExp(String.raw`(?<![=\-])>>?\s*['"]?(${PATH_TOK})`, "g");
export function bashWriteTargets(rawCmd, pathRe) {
  // ⚠️ heredoc 界符要认**引号形式**(codex 2026-08-20:原式只认 `<<'X'` 与 `<<X`,
  //   而 `cat <<"EOF"` 剥不掉 ⇒ **正文被当命令**,产生假写入)。
  const noHeredoc = String(rawCmd).replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ");
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
  const out = [];
  for (const s of noHeredoc.split(/&&|\|\||;|\n/)) {
    const seg = s.trim().replace(/\\/g, "/");
    if (/^git\s+(add|commit|push|status|log|diff|show|stash|fetch|pull|branch|tag)\b/.test(seg)) continue;
    for (const m of seg.matchAll(/(?:writeFileSync|appendFileSync)\s*\(\s*['"]([^'"]+)/g)) out.push(m[1]);
    // ⚠️ `(?<![=\-])`:**箭头函数不是重定向**(2026-08-22 实撞,--fp 台账第 3 笔):
    //   `node -e '….map(r=>r.ts)'` 的 `=>r.ts` 被当成 `> r.ts` ⇒ M 要求回读一个不存在的文件。
    //   箭头在 node -e 内联脚本里是日常形态,不修则天天复发。`->`(如 clang 参数)一并排除;
    //   合法的 `2>`/`&>`/`>>` 不受影响(前导是数字/&/空白,不在排除集里)。
    // ⚠️ D100(2026-09-06):路径类原来是 `[\w./-]+`,**吃不下盘符与 `~`**——
    //   `cat >> C:/Users/…/memory/x.md` 只取到 `C`,`>> ~/.claude/…` 一个字都取不到
    //   ⇒ 目标解不出 ⇒ 调用点按「未解出目标」兜底成命中(fail-closed),既有文件的追加也被判新建。
    //   路径类见 `PATH_TOK`(单源)。
    for (const m of seg.matchAll(REDIRECT_TARGET_RE)) { if (!/^\/dev\//.test(m[1])) out.push(m[1]); }
    // ⚠️ `--` 是**参数终止符**,取目标时要跳过它(codex 2026-08-20:
    //   `sed -i 's/x/y/' -- 既有文件` 会把 `--` 取成目标 ⇒ 过滤后 targets 为空
    //   ⇒ 调用点报「未解出目标」⇒ **阻断一次改既有文件的正常操作**)。
    //   故这一支不再按位置数 token,改成:取该段里最后一个**像路径**的 token。
    for (const m of seg.matchAll(/(?:^|[\s;&|(])sed\s+-i[^\s]*\s([^;&|\n]*)/g)) {
      const toks = m[1].split(/\s+/)
        .filter((x) => x && x !== "--" && !x.startsWith("-") && !/^['"]/.test(x));
      const last = toks[toks.length - 1];
      if (last) out.push(last.replace(/^["'`]|["'`]$/g, ""));
    }
    for (const m of seg.matchAll(/(?:tee|cp|mv)\s+([^;&|)\n]+)/g)) {
      const toks = m[1].trim().split(/\s+/)
        // ⚠️ `--` 是**参数终止符**不是目标(codex:`sed -i 's/x/y/' -- 既有文件` 会被取成 `--`,
        //   过滤后 targets 为空 ⇒ 调用点报「未解出目标」⇒ **阻断一次改既有文件的正常操作**)。
        .filter((x) => !x.startsWith("-"))
        .map((x) => x.replace(/^["'`]|["'`]$/g, ""));
      if (toks.length) out.push(toks[toks.length - 1]);
    }
  }
  // ⚠️ 规格化 `./` 与 `..`(codex:`scripts/../scripts/x.mjs` 实际是既有文件,
  //   而 `isNew` 只做字符串裁剪、不消解 `..` ⇒ 误判新建)。
  const norm = (p) => {
    const parts = [];
    for (const seg of p.replace(/^\.\//, "").split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === ".." ) { parts.pop(); continue; }
      parts.push(seg);
    }
    return parts.join("/");
  };
  // ⚠️【已登记未修】codex 另报三条,均属**分段器不理解引号**这一族,修它要引入小状态机:
  //   ① `node a.mjs | tee scripts/new.mjs` —— `bashWrites` 的 execForm 分支不识别 tee ⇒
  //      本函数根本不被调用(缺陷在 bashWrites 侧,不在这里);
  //   ② `cp -r a/ b/` 取到目录 `b/`,无从知道实际写的是 `b/a`;
  //   ③ `cp a ".claude/agents/new agent.md"` —— 含空格的引号路径被按空白拆碎。
  //   当前取舍:宁可漏这三类,不为它们引入一个会自己出 bug 的解析器。
  return [...new Set(out.map(norm))].filter((p) => p && pathRe.test(p));
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
 *  —— 2026-08-27 astrbot 实况:拦截消息显示成「是因为 会让你在 和 之间反复权衡」,
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
    return { carriers: Number.isFinite(+j.carriers) ? Math.max(0, Math.floor(+j.carriers)) : 0 };
  } catch { return null; }
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

/** D95/CW 注入面的解析(顶层定义,主路径与自测共用)。红灯(FAIL/UNKNOWN,退出码 3)带着完整 stdout,
 *  照样解析;真超时/无 JSON ⇒ UNKNOWN,不沉默。机理与撞坑记在文件末尾主路径的注里。 */
export function triageResultFrom(stdoutText) {
  let j;
  try { j = JSON.parse(String(stdoutText || "")); } catch { return { status: "UNKNOWN", detail: "session-triage 无 JSON 输出(超时或执行故障)" }; }
  const r1 = (Array.isArray(j.results) ? j.results : []).find((r) => r && (r.id === "①" || /唯一写会话/.test(String(r.name || ""))));
  return r1 ? { status: String(r1.status || "UNKNOWN").toUpperCase(), detail: String(r1.detail || "").slice(0, 400) }
    : { status: "UNKNOWN", detail: "session-triage 输出里没有①行" };
}

/** `git log -1 --diff-filter=A` 的进程内缓存(同 _trackedCache 的理由)。 */
let _justAddedCache;

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
import { buildCtx } from "./lib/gate-ctx.mjs";
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

  // A 项数据源:官方 background_tasks[] 优先,拿不到才退回正则配对
  const a = Array.isArray(ctx.bgTasks)
    ? checkAFromPayload(ctx.bgTasks, rawText(turn), text)
    : checkA(turn);

  const findings = [];
  if (a.open.length) {
    findings.push({
      id: "A", block: true,
      msg: `后台/委派任务未闭环:${a.open.join(", ")} —— 发起了但没有取回动作(poll 或读结果)。`,
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
  {
    let tracked = _trackedCache;
    if (tracked === undefined) try {
      tracked = new Set(execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: process.cwd() })
        .split("\n").map((s2) => s2.trim()).filter(Boolean));
    } catch { tracked = null; }
    _trackedCache = tracked;
    let justAdded = _justAddedCache;
    if (justAdded === undefined) try {
      justAdded = new Set(execFileSync("git", ["log", "-1", "--diff-filter=A", "--name-only", "--format="],
        { encoding: "utf8", cwd: process.cwd() }).split("\n").map((s2) => s2.trim()).filter(Boolean));
    } catch { justAdded = null; }
    _justAddedCache = justAdded;
  }
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
        tracked: _trackedCache instanceof Set ? _trackedCache : undefined,
        // `justAdded` 同样要传:少了它,今天亲签的「取证时机前移」在接管后原样失效(grill A3)
        justAdded: _justAddedCache instanceof Set ? _justAddedCache : undefined,
        // D56:写之前实测的「已存在」集合(仓外/未跟踪文件唯一说得上话的证据)
        preExisted: preExistedSet(ctx.sessionId) || undefined,
        // D95:收尾时点三查①,由文件末尾主路径跑一次注入。三态(红队 182 BP-12):
        //   live 且没注入 ⇒ 保持 undefined ⇒ CW 的 requires 契约报「必需通道缺席」(hook 忘了注入是缺陷,不是没有);
        //   离线回放/自测/dry-run 本来就探不了 ⇒ 归 null(「查过了,没有」),免得每轮回放都刷一条契约提示。
        concurrentWriters: ctx.concurrentWriters !== undefined ? ctx.concurrentWriters : (ctx.live ? undefined : null),
        lastAssistantMessage: typeof ctx.text === "string" ? ctx.text : undefined,
        bgTasks: ctx.bgTasks,
        // 批次状态**在这里读一次、注入进去**,不让规则自己读磁盘 ——
        //   规则自读的代价已实测过:同一条用例在「当前批 arm 过」与「没 arm」下结果不同,
        //   自测从 34/34 掉到 13/34,而代码一行没改。
        //   自测隔离(STOP_CLOSURE_SELFTEST)靠的也是这个:注入 undefined 即可,不必改判据。
        batchGoal: ctx.batchGoal !== undefined ? ctx.batchGoal : readBatchGoal(),
        // P 的跨批持久计账(2026-08-22 亲签「改吧」):同 batchGoal 的注入纪律——
        //   hook 读一次、规则纯函数;账文件在 gitignore 面;夹具经 ctx.pLedger 精确控制。
        pLedger: ctx.pLedger !== undefined ? ctx.pLedger : readPLedger(),
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
      // P 计账落盘(只在生产形态 `live`;离线/自测/回放不落——分母纪律同 .gate-alerts):
      //   三通道齐(动作面)⇒ 清零;否则累加本轮承重提交数。规则纯函数,账只在这儿动。
      if (live) try {
        const _P = RULES.find((r) => r.id === "P")?._p;
        if (_P) {
          const prior = (eCtx.pLedger && eCtx.pLedger.carriers) || 0;
          const mine = _P.carrierCommitCount(eCtx);
          // ⚠️ **补账面必须与规则面同一张脸**(2026-08-22 用户追问「搜索结果打算干啥」逼出的反思
          //   当场逮到:规则认「窗口∪本轮」,补账原来只认「单轮三通道齐」⇒ 通道分散跑时
          //   账永不清零,爬满后窗口一滑走就全额讨税——教科书 reset 病长在自己刚写的代码里)。
          //   天花板写明:窗口里的旧一轮通道在滑出前可能多次抵账(有界宽松,上限=400 条窗口),
          //   方向是少收税;反向(原 bug)是无界多收。
          const scope = _P.scopeActions(eCtx);
          // codex 185「你没问到」3:这里原来 `ch.test(a)` 不带 ctx ⇒ 计账侧按通用口径认 grill 充分、判据侧却欠红队,
          //   台账被清零而义务未兑现。计账与判据必须同一张脸:带 eCtx。
          const allThree = _P.CH.every((ch) => scope.some((a) => { try { return ch.test(a, eCtx); } catch { return false; } }));
          const next = allThree ? 0 : prior + mine;
          if (next !== prior || allThree) {
            // D52(批 104):裸 writeFileSync=截断后写,崩在中间读者见半文件;换 tmp+rename 原子写
            //   (同 batch-goal atomicWrite 的形)。读-改-写竞态半条:并发 Stop 仅在双写会话违规时
            //   存在,姿态见 104 威胁模型呈签件;此处只修「写不半截」这一确定收益。
            const tmpP = `.claude/.p-ledger.json.${process.pid}.tmp`;
            try {
              fs.writeFileSync(tmpP, JSON.stringify({ carriers: next, at: new Date().toISOString() }));
              fs.renameSync(tmpP, ".claude/.p-ledger.json");
            } finally { try { if (fs.existsSync(tmpP)) fs.unlinkSync(tmpP); } catch { /* 残骸不阻断 */ } }
          }
        }
      } catch { /* 账写不了不影响闸;规则侧下轮读到旧值只会更严 */ }
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
              { encoding: "utf8", timeout: 15000 });
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
  let run = 0;
  try {
    for (const line of fs.readFileSync(tp, "utf8").split("\n")) {
      if (!line.includes("hookCount")) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "system" || o.hookCount === undefined) continue;
      const blocked = /收尾闸阻断/.test(JSON.stringify(o.hookErrors || []));
      run = blocked ? run + 1 : 0;
    }
  } catch { return 0; }
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
  const yielding = blocking.length > 0 && streak >= CAP - 2;
  if (live) try {
    // D1/批 102:走 ledger-chain(接线点一)。
    ledgerAppend(".claude/.gate-alerts.jsonl", {
      ts: new Date().toISOString(), ids: findings.map((f) => f.id),
      // `blocked` = 本轮**真实投递**为阻断的;降级轮记进 `demoted`,并带 yielding 标记
      blocked: yielding ? [] : blocking.map((f) => f.id),
      ...(yielding ? { demoted: blocking.map((f) => f.id), yielding: true } : {}),
      streak,
      perf: perfLine(),   // D53:同一笔耗时账进报警台账,分母侧也可算 p95
    });
  } catch (e) {
    // 台账写不了不影响闸,但**必须出声**——静默吞掉=新报警从分母无声消失(codex 四眼判词)
    try { process.stderr.write("LEDGER-WRITE-FAILED(.gate-alerts): " + safeErrMsg(e) + "\n"); } catch { /* 空 */ }
  }
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
    { name: "A 命中:发起未取回", lines: [U("go"), A("CODEX_JOB=abc123 已发出")], want: ["A"] },
    { name: "A 不命中:发起且已 poll", lines: [U("go"), A("CODEX_JOB=abc123"), A("跑 --poll abc123")], want: [] },
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
    //   memory 永不入仓 ⇒ git 判据恒判新建 ⇒ 改一行索引也被当造物拦。
    //   修法=`Edit` 语义证明「本轮之前已存在」,**只施于 memory 面**。
    // ⚠️ 本条**记的曾是已知误报**;2026-08-27 D56 结清后语义变了,原注留此为史:
    //   「D56 的修法已同批撤回(grill:edge-cases F1),故 Edit 改 MEMORY.md 索引行仍会命中 I。」
    //   **现在的判据**:命不命中取决于有没有 `preExisted` 记录(写之前实测),
    //   而本夹具**不注入**它 ⇒ 落在「无记录」那一支 ⇒ 仍应命中。
    //   这正是修法不开漏放口的那一侧:**没量过就当新建**。
    //   有记录的那一侧由接缝「D56 有 precheck 记录 ⇒ 不算新建」钉住,两侧成对。
    { name: "I 命中:Edit 改 MEMORY.md 索引行(**无 precheck 记录 ⇒ 按新建**,D56 结清后语义)",
      lines: [U("go"), A("加一行索引", [
        { name: "Edit", input: { file_path: "C:/Users/x/.claude/projects/D--test/memory/MEMORY.md", old_string: "a", new_string: "b" } },
      ])], want: ["I", "K0"] },
    // F1 回归钉:非工具面造(Bash)+ Edit 收尾,**必须仍算新建**。
    //   这是 D56 撤回前实测会漏放的那条路径;子代理造+主代理 Edit 是它的同族(且不可见)。
    { name: "I 命中:Bash 造 memory 文件 + Edit 收尾(F1 漏放回归钉)",
      lines: [U("go"), A("造完改", [
        { name: "Bash", input: { command: "printf '# t' > C:/Users/x/.claude/projects/D--test/memory/zz-f1.md" } },
        { name: "Edit", input: { file_path: "C:/Users/x/.claude/projects/D--test/memory/zz-f1.md", old_string: "# t", new_string: "# real" } },
      ])], want: ["I", "K0"] },
    { name: "I 命中:Write 造一个新 memory 条目(修 D56 不许把这面一并放掉)",
      lines: [U("go"), A("记一条", [
        { name: "Write", input: { file_path: "C:/Users/x/.claude/projects/D--test/memory/zzz-new.md", content: "x" } },
      ])], want: ["I", "K0"] },
    { name: "I 命中:同轮先 Write 再 Edit 同一 memory 文件(首个动作是 Write,洗不掉触发)",
      lines: [U("go"), A("造完顺手改", [
        { name: "Write", input: { file_path: "C:/Users/x/.claude/projects/D--test/memory/zzz-new2.md", content: "x" } },
        { name: "Edit", input: { file_path: "C:/Users/x/.claude/projects/D--test/memory/zzz-new2.md", old_string: "x", new_string: "y" } },
      ])], want: ["I", "K0"] },
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

  // ── ranProbe 的回归守卫:正确性 + **不许再变成灾难性回溯** ──────────────────
  // 2026-08-20 实撞:原式 `(?:[^"]|\\")*` 在 400KB 上要 16.7 秒,而 hook 超时 30 秒、
  //   **被超时杀死的 hook 不阻断** ⇒ 一次长工具输出就能静默关掉整道闸。
  //   而那条式子本身是为修「带引号路径漏判」而写的——修一个漏判换来一个全局关闭开关。
  //   故这里两侧都钉死:引号路径必须仍认,且 400KB 必须在 1 秒内跑完。
  let probePass = 0, probeTotal = 0;
  {
    const cs = [
      [String.raw`{"command":"node --no-warnings scripts/verify-laws.mjs"}`, true, "裸路径探针"],
      [String.raw`{"command":"node --no-warnings \"D:/x/scripts/verify-claims.mjs\""}`, true, "带引号路径(08-19 漏判的那个)"],
      [String.raw`{"command":"node -e \"console.log(1)\""}`, false, "普通 node 一行不算探针"],
      // D69(2026-08-27 astrbot 实况):非 node 运行时的探针
      [String.raw`{"command":"cd /d/bqbot && python tests/probe_rate1_determinism.py; echo x"}`,
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

    // ── D71 回显钉(2026-08-27,astrbot 实况)────────────────────────────────
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
      // ── D100 消费者侧(codex 复核 2026-09-06「你没问到」①):按会话、按路径**首笔**。
      //   台账改道临时文件;探完把缓存与环境变量复原,不影响本进程后面的真读取。
      {
        // 本文件不 import os/path(刻意保持 import 面不变),临时文件走环境变量拼路径
        const tmp = `${process.env.TEMP || process.env.TMPDIR || process.env.TMP || "."}/gate-precheck-reader-selftest-${process.pid}.jsonl`;
        const rows = [
          { ts: "1", sid: "S", path: "scripts/new181.mjs", existed: false },     // 本会话首次创建前:不存在
          { ts: "2", sid: "S", path: "scripts/new181.mjs", existed: true },      // 第二次追加前:存在(不得覆盖首笔)
          { ts: "3", sid: "OTHER", path: "scripts/old.mjs", existed: true },     // 别的会话的记录
          { ts: "4", sid: "S", path: "C:/u/.claude/projects/D--test/memory/m.md", raw: "~/.claude/projects/D--test/memory/m.md", existed: true },
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
        // ── D95/CW 适配层三态(codex 182 Q4②:首版把退出码 3 的 FAIL/UNKNOWN 吞成 null,规则永远收不到红灯)
        const mk = (status) => JSON.stringify({ results: [{ id: "①", name: "唯一写会话", status, detail: "x" }], verdict: "-" });
        sc("CW 适配:PASS 解析", triageResultFrom(mk("PASS")).status, "PASS");
        sc("CW 适配:FAIL 照样解析(退出码 3 带 stdout)", triageResultFrom(mk("FAIL")).status, "FAIL");
        sc("CW 适配:UNKNOWN 照样解析", triageResultFrom(mk("UNKNOWN")).status, "UNKNOWN");
        sc("CW 适配:无 JSON ⇒ UNKNOWN(不沉默)", triageResultFrom("").status, "UNKNOWN");
        sc("CW 适配:缺①行 ⇒ UNKNOWN", triageResultFrom(JSON.stringify({ results: [] })).status, "UNKNOWN");
        sc("D100 消费者:别的会话的 true 不进本会话集合", mine.has("scripts/old.mjs"), false);
        sc("D100 消费者:raw 原形随首笔一起收", mine.has("~/.claude/projects/D--test/memory/m.md") && mine.has("C:/u/.claude/projects/D--test/memory/m.md"), true);
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
          encoding: "utf8", timeout: 30_000,
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
    // 引号包分号:切段发生在引号解析之前 ⇒ 真目标 scripts/c.mjs 落进无动词的后段而**丢失**。
    // 属函数头注已登记的「分段器不理解引号」族(修法试过、会弄坏主写入通道,不修)。
    // 钉住现状让取舍**可见**:哪天有人改切段器,这条转红即知行为变了。
    hp("D7:引号包分号——真目标丢失(已知取舍,钉现状)",
      bashWriteTargets('cp "scripts/a;x.mjs" scripts/c.mjs', RE), []);

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
  let lawPass = 0, lawTotal = 0;
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
      cacheH[file] ??= hnames(file);
      const ok = !!anchor && cacheH[file].some((h) =>
        norm(h).includes(norm(anchor)) || norm(anchor).includes(norm(h)));
      console.log(`${ok ? "PASS" : "FAIL"}  law 锚点:${r.id} → ${r.law}${ok ? "" : "  ← 目标文件无此标题/句名"}`);
      if (ok) lawPass++;
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

  console.log(`\n自测 ${pass}/${cases.length}` +
    (carrTotal ? ` · 载体分类 ${carrPass}/${carrTotal}` : "") +
    (seamTotal ? ` · 接缝 ${seamPass}/${seamTotal}` : "") +
    (escTotal ? ` · 逃生口 ${escPass}/${escTotal}` : "") +
    (probeTotal ? ` · ranProbe ${probePass}/${probeTotal}` : "") +
    (hpTotal ? ` · 零件用例 ${hpPass}/${hpTotal}` : "") +
    (partTotal ? ` · 零件契约 ${partPass}/${partTotal}` : "") +
    (driftTotal ? ` · 承重面漂移 ${driftPass}/${driftTotal}` : "") +
    (lawTotal ? ` · law锚点 ${lawPass}/${lawTotal}` : ""));
  return (pass === cases.length && driftPass === driftTotal && probePass === probeTotal
    && partPass === partTotal && hpPass === hpTotal && seamPass === seamTotal && escPass === escTotal
    && lawPass === lawTotal && carrPass === carrTotal) ? 0 : 1;
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
//     ——**审计的诊断对 ≠ 药方对,用户签过字的授权赢**,分权撤;`--fp-confirm` 保留为
//     用户可选的加签通道,不再是生效条件;
//   · `miss_review` = 抽查未命中回合的记录({sampled,found}),发现漏报即撤涉事规则「已验收」身份;
//   · `--fp-report` 永远打印 RECALL=UNKNOWN:本台账量不了漏报率,「没看到漏报」≠「没有漏报」。
if (["--fp", "--fp-confirm", "--fp-miss", "--fp-report"].includes(argv[0])) {
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
    console.log(`已记 误报:${id}(自签有效,2026-08-22 用户亲裁;--fp-confirm 是可选加签,非生效条件)`);
  } else if (argv[0] === "--fp-confirm") {
    // 用户可选加签通道(非生效条件)。天花板照旧:进程判不出敲键盘的是谁,靠纪律不靠机制。
    const [, id, ...why] = argv;
    if (!id) { console.error("用法: --fp-confirm <规则id> [说明] —— 约定只由用户敲"); process.exit(2); }
    ckId(id);
    put({ kind: "confirmed_fp", id, why: why.join(" ").trim(), by: "user" });
    console.log(`已记 confirmed_fp:${id}`);
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
    const nAlert = alerts.reduce((n, a) => n + ((a.ids || []).length), 0);
    const per = {};
    for (const a of alerts) for (const id of (a.ids || [])) per[id] = (per[id] || 0) + 1;
    const claimed = led.filter((x) => x.kind === "claimed_fp").length;
    const confirmed = led.filter((x) => x.kind === "confirmed_fp").length;
    const reviews = led.filter((x) => x.kind === "miss_review");
    const sampled = reviews.reduce((n, r) => n + (r.sampled || 0), 0);
    const found = reviews.reduce((n, r) => n + (r.found || 0), 0);
    console.log(`报警分母: ${nAlert} 规则次 / ${alerts.length} 轮` +
      (nAlert ? `(${Object.entries(per).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ")})` : ""));
    console.log(`误报: ${claimed + confirmed}(自签 ${claimed} + 用户加签 ${confirmed})` +
      (nAlert ? `  (误报/报警 = ${((claimed + confirmed) / nAlert * 100).toFixed(1)}%)` : ""));
    console.log(`未命中抽查: 已审 ${sampled},发现漏报 ${found}${found > 0 ? " ← 涉事规则不得再称「已验收」" : ""}`);
    console.log(`RECALL=UNKNOWN —— 本台账量不了漏报率;「没看到漏报」≠「没有漏报」`);
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
  //   得到 "D:/my%20test%20repo/",chdir 抛 ENOENT ⇒ 被下面的 catch 吞掉 ⇒ **静默退回继承的 cwd**,
  //   正是 2026-08-25 那次「审错树」事故的原状——修 cwd 的这行自己会在带空格的仓上失效。
  //   custodiet 已公开,`C:\Users\Some Name\...` 在 Windows 上是常态,故这条按公开面优先级修。
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
} catch { /* 锚定失败按原 cwd 跑 */ }
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
// 失效条件:`agent_transcript_path` 是 harness 内部字段、无文档承诺;缺字段 ⇒ 报 UNKNOWN
//   提示行,**不得静默跳过**(fail-closed 的提示面版本)。
if (hookInput.hook_event_name === "SubagentStop") {
  const say = (s) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SubagentStop", additionalContext: s },
  }));
  const at = hookInput.agent_transcript_path;
  const who = `${hookInput.agent_type || "?"}/${String(hookInput.agent_id || "?").slice(0, 8)}`;
  if (typeof at !== "string" || !at) {
    say(`⟦子代理闸 UNKNOWN⟧ ${who}:payload 里没有 agent_transcript_path——该字段是 harness 内部实现、`
      + `无文档承诺,可能已改名。判不了 ⇒ 按 fail-closed 报出来,不当作「没问题」。`);
    process.exit(0);
  }
  let out = "";
  try {
    const st = fs.statSync(at);
    const CAP = 4_000_000;                       // 字节预算:超了报 UNKNOWN,不截断继续
    if (st.size > CAP) {
      out = `⟦子代理闸 UNKNOWN⟧ ${who}:转录 ${(st.size / 1e6).toFixed(1)}MB 超预算 `
        + `${CAP / 1e6}MB,不截断继续(截断=fail-open)。`;
    } else {
      const entries = readTranscript(at);
      const sCtx = buildCtx(entries, { tracked: _trackedCache instanceof Set ? _trackedCache : undefined });
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
      const hits = runRules(RULES.filter((r) => only.has(r.id)), sCtx)
        // finding 形状 = `{ id, block, msg }`(gate-registry.mjs:174);msg 是多行数组或字符串。
        .map((f) => {
          const m = Array.isArray(f.msg) ? f.msg.join(" ") : String(f.msg || "");
          return `${f.id}:${m.replace(/\s+/g, " ").trim().slice(0, 110)}`;
        });
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
    out = `⟦子代理闸 UNKNOWN⟧ ${who}:读转录失败(${String(e.message).slice(0, 60)})——报出来不静默。`;
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
// ── D95(2026-09-06 用户亲签「7 签吧」):**收尾面**也查一次并发写会话。────────────
//   宪法恒定条款①「同一时刻只许一个写会话」的触发层原来只有开工,「跑一次只能证明那一刻
//   没人在写」——2026-08-28 两个写会话并发一整天、互相扫进对方的半成品,全程零闸响。
//   这里跑一次三查①(`session-triage --json`,实测 1.2 s,Stop 预算 30 s),只取①那行注入 ctx,
//   判据在规则 CW 里(首批**提示不阻断**,先量误报;三笔样本 1 误报 2 干净,误报成因已被进程亡短路盖住)。
//   自身会话经 CLAUDE_CODE_SESSION_ID 传给探针,免得把自己判成并发者。探测失败 ⇒ null ⇒ CW 不响
//   (提示面 fail-open,与「没窗口≠窗口空」同一口径;若日后升阻断须改为 UNKNOWN 也报)。
//   ⚠️ codex 182 复核逮到的**确定缺陷**(首版):`session-triage` 在任一检查非 PASS 时**退出码 3**,
//   `execFileSync` 对非零退出码抛错,首版 catch 直接返回 null ⇒ **正常检出并发写会话时 CW 正好收不到**——
//   只有 PASS 才注入得进来,规则等于永远不响。现:抛错时取 `err.stdout` 照样解析(红灯是业务结果不是执行故障);
//   真超时/无 JSON ⇒ 注入 UNKNOWN(提示面仍不阻断,但不再沉默)。解析抽成 `triageResultFrom()`,接缝自测钉住三态。
//   副作用照实说:session-triage 会写 `.claude/.session-pid-*.json`(sidecar)与 heartbeat——都在 gitignore 面,
//   按冲突表 #3「gitignore 面遥测不计写入」口径;只读会话的零写入证明以 git 管辖面为准,不受影响。
//   (`triageResultFrom` 定义在 `preExistedSet` 旁的顶层——这里是主路径的块作用域,放这儿自测够不着。)
const concurrentWriters = (() => {
  if (!hookInput.session_id) return null;
  // ⚠️ 超时 2026-09-07 当轮实撞:首版 8 s,而 session-triage 在 48 个遗留会话+两个 codex 进程在活时实测 8.8 s
  //   ⇒ 第一次生产触发就报 UNKNOWN「无 JSON 输出」。现 15 s(Stop 预算 30 s,本 hook 自身 <5 s);
  //   仍超时的话 detail 里带 ETIMEDOUT 与耗时,别再让「超时」与「坏 JSON」混成一句。
  const t0 = Date.now();
  const opts = {
    encoding: "utf8", timeout: 15000, cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: String(hookInput.session_id) },
    stdio: ["ignore", "pipe", "ignore"],
  };
  try {
    // `--fast`(D105(a),批 187):进程表吃缓存、跳 sidecar/heartbeat/anchor;批 188 起枚举器走 Toolhelp32 不走 WMI
    //   (~1.5 s),快路前台枚举上限 8 s;其余耗时(git rev-parse、活跃转录读取)无统一截止,见 D108 天花板
    return triageResultFrom(execFileSync(process.execPath, ["--no-warnings", "scripts/session-triage.mjs", "--json", "--fast"], opts));
  } catch (e) {
    // 非零退出码(FAIL/UNKNOWN ⇒ 3)也带着完整 stdout;拿不到 stdout 才是执行故障
    const r = triageResultFrom(e && e.stdout ? String(e.stdout) : "");
    if (r.status === "UNKNOWN" && !(e && e.stdout && String(e.stdout).trim())) {
      r.detail += `(${e && (e.code || e.signal) ? String(e.code || e.signal) : "exit " + (e && e.status)};${Date.now() - t0} ms)`;
    }
    return r;
  }
})();

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
    findings = run(tp && fs.existsSync(tp) ? tp : null, { text: merged, turn, bgTasks, live: true, sessionId: hookInput.session_id, concurrentWriters });
  } else {
    if (!tp || !fs.existsSync(tp)) process.exit(0);   // fail-open:两个来源都没有就放行
    findings = run(tp, { bgTasks, live: true, sessionId: hookInput.session_id, concurrentWriters });
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
