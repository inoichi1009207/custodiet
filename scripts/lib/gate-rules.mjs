import { CARRIER_SURFACE, isDeliverable, CONTENT_WRITE_RE, normPath, isCarrierPath, NON_CARRIER_AREA } from "./gate-carriers.mjs";
import { classifyDiffTier, coversWrites } from "./gate-difftier.mjs";
// gate-rules.mjs —— 声明式规则集(迁移中)
//
// 迁移纪律(2026-08-19 立,当日两次改坏文件的直接教训):
//   **每搬一条,与旧实现的 diff 必须为空**——除非该条的旧行为本身就是要修的 bug,
//   那种情况下 diff 非空是预期的,但**必须逐条指名**「这正是要修的那个」,不得默认接受。
//
// ⚠️ 迁移期有一类 diff 是**结构上不可避免**的:旧实现的若干判据扫的是
//   `rawText(turn)`(含工具输出、被读文件内容),而新 ctx **刻意不暴露那坨文本**。
//   于是「读到一个含 `git commit` 的文档就判已提交」这种旧行为**在新架构里写不出来**。
//   这不是迁移失误,正是重写的目的——见 gate-ctx.mjs 头注与 grill:security 的实测。

import { quoteUntrusted, gitArgs, isCommitSeg } from "./gate-ctx.mjs";
import fs from "node:fs";

/** 那个件在本仓在不在?**消息里凡是让人去跑某个脚本的,都要先问这一句。**
 *
 *  ⚠️ 2026-08-27 立:本闸已开源(custodiet),而若干本仓专有件(普查器、取页核实件)
 *  **不随开源仓发布**。消息若写死路径,在别人的仓里就是让人去跑一个不存在的命令——
 *  正是本仓一整天在修的那族「**出路指向不存在的东西**」,只不过换成了跨仓形态。
 *  运行期判定而非写死字符串:件被删、或没随仓走,消息跟着变。
 *  天花板:只看文件在不在,不看它能不能跑、版本对不对。 */
export function toolPresent(rel) {
  try { return fs.existsSync(rel); } catch { return false; }
}

/** Q:推面出批而无实打实阻断。法条早有、触发层 2026-08-19 才建。 */
export const RULE_Q = {
  id: "Q",
  blocking: true,
  law: "AGENTS.md#执行共识",
  detect: (ctx) => {
    const defer = /留给下次|留到下(次|批)|下一批(再|做)|下次(再)?(做|办|处理)|后续(再)?(做|办|处理)|改天|以后再|另立(一)?批|留待/;
    const realBlock = /缺凭据|凭据(未|没)|站点不可达|不可达|需亲签|归你签|归用户|待你签|配额(已)?耗尽|只有用户能触发|不可逆/;
    // ⚠️ **引号内的内容不算我在推面出批**(2026-08-20 实撞，窄例外③ 自签)。
    //   实撞形态：Q 报「命中：留给下次」，而我那一轮唯一出现这四个字的地方，
    //   正是我在**引用它自己的报告**。已登记过的回声族的另一向：
    //   C 项曾被自己的回声**豁免**，Q 现在被自己的回声**触发**。
    //   代价：真在引号里推面出批会漏报——极少，而误抦每次引用闸的报告都会发生。
    const noQuote = String(ctx.text || "").replace(/「[^」]*」|«[^»]*»|“[^”]*”|"[^"]*"/g, " ");
    if (!defer.test(noQuote) || realBlock.test(noQuote)) return [];
    return [(noQuote.match(defer) || ["(推迟句)"])[0]];
  },
  // ⚠️ **豁免已撤回**(codex 060 §1.1):我在迁移时**凭空加了**「有写动作 + 有提交即豁免」,
  //   旧实现根本没有这条,而且那个动作与被推迟的事项**毫无关联**——
  //   「推迟句 + 任意 Write + git commit」就能过闸。迁移期不得偷偷加宽豁免。
  //   文本面的「我写明了理由」已内建在 detect 的 realBlock 里。
  exempts: [],
  // 出路即数据(批 117)。①「当场做掉」是**减法型**出路(把推迟句拿掉),
  //   自证机制接不上去——见 D79 盲区①,故只给 say 不给可自证 sample,用②的 sample 兜。
  escapes: [
    // 减法型:出路是**把推迟句拿掉**(当场做掉),故整轮换成一段已做完的正文。
    { say: "**当场做掉**",
      sample: { replaceText: "那三件已经做完并验证,不再往后推。" } },
    { say: "写明推迟的是哪一类阻断、具体缺什么(缺凭据 / 站点不可达 / 需亲签)",
      sample: { text: "推迟的原因是缺凭据——那把钥匙只有用户能取。" } },
  ],
  message: (hits) =>
    `推面出批但未指出实打实的阻断(命中:${quoteUntrusted(hits[0], 40)})。\n` +
    `      宪法《执行共识》:「归另一入口/另一批」**不构成**推面出批的理由——\n` +
    `      只有**缺凭据 / 站点不可达 / 需亲签**三类才算。工作量大**不在其中**。\n` +
    `      出路:\n${renderEscapes(RULE_Q.escapes)}`,
  mutations: [
    { name: "去掉 realBlock 豁免", apply: (r) => ({ ...r, detect: (ctx) => (/留给下次|留到下(次|批)|下一批(再|做)|下次(再)?(做|办|处理)|后续(再)?(做|办|处理)|改天|以后再|另立(一)?批|留待/.test(ctx.text) ? ["x"] : []) }) },
    // 另一分支:不看推迟模式,只要没写阻断理由就报 ⇒ 中性反例应当反而命中
    { name: "不看推迟模式(只看有无阻断理由)", apply: (r) => ({ ...r, detect: (ctx) => (/缺凭据|需亲签|归你签|归用户|站点不可达|配额(已)?耗尽|不可逆/.test(ctx.text) ? [] : ["x"]) }) },
  ],
  cases: {
    pos: [
      { text: "这三件留给下次做,今天先到这儿。" },
      // ⚠️ **引号里含推迟词、正文里真推迟** ⇒ 仍须拦。
      //   这是「剥引号」那个修法的**控制组**:没它的话,把推迟句包进引号就能绕闸。
      { text: "闸说「留给下次」不算理由。所以这条我下一批再做。" },
    ],
    neg: [
      // ⚠️ **引用闸自己的报告不算推面出批**(2026-08-20 实撞)。
      //   Q 报「命中：留给下次」，而那四个字唯一的出处就是我在引用它。
      //   已登记过的**回声族**的另一向：C 曾被自己的回声豁免，Q 被自己的回声触发。
      { text: "Q 报命中「留给下次」——但我上一条消息里没有这四个字。" },
      { text: "这件留给下次——它改的是授权边界,需亲签,归你签。" },
      { text: "今天把三条规则迁完了,验收全过。" },   // 中性:既无推迟也无阻断理由
    ],
  },
};

/** D:强制项疑被降级成征询。 */
export const RULE_D = {
  id: "D",
  blocking: false,
  // codex 092 复审逮到:D14 首修按旧锚**字符串**机械重指到「完成靠核对」,语义归属错——
  // collab.md 四之二明写「观测仪器=D 项(强制项被降级成征询)」,法源是那条。
  // 锚点自测的天花板也由此写明:它只证**可解析**,不证**语义归属**(语义要人/跨模型核)。
  law: "docs/laws/collab.md#授权内直接做,不请示",
  detect: (ctx) => {
    // ⚠️ 用 `PAT.downgrade` 而不是手抄。原实现我手打了三条模式,**漏了
    //   `/需要(我)?(的话|再)/`**(codex 060 §1.1 给出可复现输入「交叉验证需要的话再做。」
    //   旧命中 D、新不命中)。B/C/H 我特意 import PAT 就是为了避免这个,D 却手打了。
    const MANDATORY = /(交叉验证|独立复核|开工两查|验证默认|亲签|codex\s*复核)/;
    if (!MANDATORY.test(ctx.text)) return [];
    return matchAny(ctx.text, PAT.downgrade);
  },
  exempts: [],
  message: (hits) => `强制项疑被降级成征询:\n    · ${hits.map((h) => quoteUntrusted(h, 40)).join("\n    · ")}`,
  // 拧断:删掉「要不要我」这条征询模式 ⇒ 正例应当不再命中
  mutations: [
    { name: "删掉「要不要我」征询模式", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!/(交叉验证|独立复核|开工两查|验证默认|亲签|codex\s*复核)/.test(ctx.text)) return [];
      return [/你要是(要|想)/, /我可以(帮你|去)?(跑|做|核|查)/].map((p) => ctx.text.match(p)).filter(Boolean).map((m) => m[0]);
    } }) },
    // 另一分支:去掉「必须先提到强制项」这道前置闸 ⇒ 普通征询也会被误报
    { name: "去掉 MANDATORY 前置闸", apply: (r) => ({ ...r, detect: (ctx) => matchAny(ctx.text, PAT.downgrade) }) },
  ],
  cases: {
    pos: [{ text: "这条要交叉验证。要不要我去跑一下?" }],
    // 2026-10-09 曾加「开工查路由」入强制词,红队(0726e92 BP-5)实测每份开工报告配一句可选事就误报,已撤;漏放面登记 D140。
    neg: [
      { text: "这条要交叉验证,已发 codex。" },
      { text: "要不要我顺手把这个 README 也改了?" },   // 有征询、无强制项 ⇒ 不该报
    ],
  },
};

/** G v2:关账自审的**可核半动作面化**(2026-08-25,批 101/D48)。
 *
 *  v1 的判据 = 数正文里的圆圈编号(said && answered>=4)——「写『⑤已跑』即满足」,
 *  与 P 项旧病同型:拿文本声明当结构义务的履行。前置量(fp 台账):G 报警 22 次、
 *  自签误报 1 笔(编号计数把正文其他 ①②③ 一并计入报 16/7),其余 21 次命中里
 *  绝大多数是普通提交轮被追讨仪式文本——命中≠有效。
 *  七问里 ⑤xros ⑥最佳实践 ⑦交叉验证已被 P/W 两项动作面接管;③接线无机器判据
 *  (「谁调用它」要语义)。可核的 ①②④ 各立动作面判据,仪式计数整个裁撤:
 *    ① 入册:本轮提交了**新建**的造物面载体 ⇒ 本轮∪批窗口须有对 tool-register 的写动作;
 *    ② 失效条件:本轮写入 tool-register 的正文须含「失效条件」字样(从第一天带,不得后补);
 *    ④ 关账义务:本轮提交触及闸机件 ⇒ 本轮∪批窗口须真跑过自测/验收命令。
 *  证据一律取动作面(ctx.writes/written/bashCmds),不取文本——「我说我入册了」不算。 */
// G 的三条动作面判据抽成共享零件:变异体**只删分支、消息逐字一致**——
//   验收台的杀伤判据是完整签名(含消息正文),变异体若自造短消息,会被「消息不同」
//   平凡逮住,证人归属失真(本次首版实撞:三个变异全被 pos① 逮住而非各自目标证人)。
const G_CHECK = {
  wroteRegister: (c) => !!c && c.wroteAny(/tool-register\.md/),
  // ① 入册(取证窗=本轮∪批窗口,同 I 项的理由:造与入册可以不同轮)
  reg(ctx, win) {
    const created = touched(ctx, CARRIER_RE, true);
    if (!created.length || this.wroteRegister(ctx) || this.wroteRegister(win)) return null;
    return `① 入册:新建并提交了造物面载体(${created.slice(0, 2).join("、")}),而本轮∪批窗口没有对 docs/tool-register.md 的写动作`;
  },
  // ② 失效条件(只在本轮真写了 register 时判——判的是写进去的**正文**,不是说了什么)
  expiry(ctx) {
    if (!this.wroteRegister(ctx) || /失效条件/.test(ctx.written)) return null;
    return "② 失效条件:本轮写入 tool-register 的正文里没有「失效条件」——从第一天带,不得后补(造物两约束二)";
  },
  // ④ 关账义务:触闸机件的提交须有自测动作(gate 面=hook-*/lib/gate-*/gate-* 三形态)
  accept(ctx, win) {
    const touchedGate = ctx.writes.some((w) => /scripts\/(hook-|lib\/gate-|gate-)/.test(String(w).replace(/\\/g, "/")));
    const ran = (c) => !!c && c.ranBash(/--self-test|gate:self-test|gate:accept|gate-migrate-check/);
    if (!touchedGate || ran(ctx) || ran(win)) return null;
    return "④ 关账义务:本轮提交触及闸机件,而本轮∪批窗口没有自测/验收动作(--self-test 或 gate:accept)";
  },
};
const gWin = (ctx) => { try { return ctx.window(); } catch { return null; } };

export const RULE_G = {
  id: "G",
  blocking: false,
  law: "docs/laws/reporting.md#关账前自审一遍",
  detect: (ctx) => {
    if (!ctx.didCommit()) return [];
    const win = gWin(ctx);
    return [G_CHECK.reg(ctx, win), G_CHECK.expiry(ctx), G_CHECK.accept(ctx, win)].filter(Boolean);
  },
  exempts: [],
  message: (hits) =>
    `关账自审的可核项未过(动作面判据,v2;③接线无机器判据仍归人审):\n    · ${hits.join("\n    · ")}`,
  mutations: [
    // 拧断①:不查入册联动 ⇒ 造完不入册无人拦(v1 的实况:coverage-check 漏册 5 天没人发现)
    { name: "① 不查造物入册", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!ctx.didCommit()) return [];
      const win = gWin(ctx);
      return [G_CHECK.expiry(ctx), G_CHECK.accept(ctx, win)].filter(Boolean);
    } }) },
    // 拧断②:不查失效条件字样 ⇒ 「零使用≠可裁」的前提(有计数有失效条件)塌一半
    { name: "② 不查失效条件字样", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!ctx.didCommit()) return [];
      const win = gWin(ctx);
      return [G_CHECK.reg(ctx, win), G_CHECK.accept(ctx, win)].filter(Boolean);
    } }) },
    // 拧断④:不查关账自测 ⇒ 改闸机件不跑套件静默过关(修宪必跑件自身漂移的同族)
    { name: "④ 不查关账自测", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!ctx.didCommit()) return [];
      const win = gWin(ctx);
      return [G_CHECK.reg(ctx, win), G_CHECK.expiry(ctx)].filter(Boolean);
    } }) },
    // 拧断⑤:去掉 didCommit 前置闸 ⇒ 没提交的工作轮也被追讨(v1 已修对的那半,钉住)
    { name: "去掉 didCommit 前置闸", apply: (r) => ({ ...r, detect: (ctx) => {
      const win = gWin(ctx);
      return [G_CHECK.reg(ctx, win), G_CHECK.expiry(ctx), G_CHECK.accept(ctx, win)].filter(Boolean);
    } }) },
  ],
  cases: {
    pos: [
      // ① 新建造物面载体并提交,本轮与窗口都没写 register ⇒ 命中(杀「① 不查造物入册」)
      { text: "新零件写完,提交。", commit: true, write: "scripts/zzz-new-widget.mjs" },
      // ② 写 register 行但正文无「失效条件」⇒ 命中(杀「② 不查失效条件字样」)。
      //   tracked 供上=改既有行,不触 ①。
      { text: "入册了。", commit: true, write: "docs/tool-register.md",
        written: "| `zzz.mjs` | 2026-08-25 | 用途 | 自测过 | 在用 |",
        tracked: ["docs/tool-register.md"] },
      // ④ 改闸机件并提交而无自测动作 ⇒ 命中(杀「④ 不查关账自测」)。tracked 供上不触 ①。
      { text: "改好了,提交。", commit: true, write: "scripts/lib/gate-rules.mjs",
        tracked: ["scripts/lib/gate-rules.mjs"] },
    ],
    neg: [
      // 新建载体但**没提交** ⇒ 不追(杀「去掉 didCommit 前置闸」)
      { text: "写了个新零件,还没提交。", write: "scripts/zzz-new-widget.mjs" },
      // 普通提交轮:不触造物面/register/闸机件 ⇒ 一个字的仪式文本都不要求(v1 的 21 次噪声消失)
      { text: "文档改完,提交。", commit: true, write: "docs/notes.md", tracked: ["docs/notes.md"] },
      // ① 的窗口豁免:造物在本轮、入册在窗口里 ⇒ 放行(取证窗=批,同 I 项)
      { text: "零件提交。", commit: true, write: "scripts/zzz-new-widget.mjs",
        prior: [{ text: "先入册。", write: "docs/tool-register.md" }] },
      // ② 满足:register 正文带「失效条件」⇒ 放行
      { text: "入册,带失效条件。", commit: true, write: "docs/tool-register.md",
        written: "| `zzz.mjs` | … | 失效条件:连续 20 批零调用复议 |",
        tracked: ["docs/tool-register.md"] },
      // ④ 满足:改闸机件且本轮跑了自测 ⇒ 放行
      { text: "改好,套件绿,提交。", commit: true, write: "scripts/lib/gate-rules.mjs",
        tracked: ["scripts/lib/gate-rules.mjs"],
        bash: "node --no-warnings scripts/hook-stop-closure.mjs --self-test" },
    ],
  },
};



// ── B / C / H:「说了却没做」一族 ────────────────────────────────────────
// 迁移要点:旧实现把承诺的对象拿去比对 `toolRawText(turn)`,而那坨文本**含工具输出**
// ——于是「我要改 foo.mjs」+ 读到一个提到 foo.mjs 的文件,就算兑现了(grill:security S2)。
// 新实现只比对**工具入参**(ctx.actions),这是刻意分歧,已在 EXPECTED_DIVERGENCE 指名。
// ⚠️ `bashWriteTargets` 漏在这行之外整整一天(2026-08-20 定性 4 条「分歧」时才发现)。
//   `touched()` 调用它 ⇒ RULE_I/RULE_J 一碰到 Bash 写路径就 `is not defined` 抛错。
//   而我同日刚把「阻断项抛错保持阻断」改对 ⇒ **崩溃以阻断的形式生效**,成了活的误拦。
//   全语料上它伪装成「4 条未指名分歧」,方向一致(新有旧无)——我差点当成刻意分歧去登记。
//   `node --check` 抓不到这类:它是**运行期**的引用错误,不是语法错。
//   抓它的正确工具是 eslint 的 `no-undef` —— 而我今天**装了 eslint 却从没配过、跑过**。
import { PAT, extractTargets, matchAny, bashWrites, bashWriteTargets, ranProbe } from "../hook-stop-closure.mjs";

/** 只由**工具入参**拼成的证据面。工具输出一律不进——那是别人说的话。 */
// 红队 191 BP-6(codex 191 同指):原来整体序列化 `ctx.actions`,每个元素都带 `at:<13 位毫秒>`,
//   于是「我这就去改 `889`」这类指向短数字的承诺,会因某个动作的时间戳恰好含子串 `889` 而被判「已兑现」
//   (红队实测:同一输入加 timestamp 即由 HIT 变 PASS)。时间戳是元数据不是证据,只序列化 {name,input}。
const actionText = (ctx) => JSON.stringify((ctx.actions || []).map((a) => ({ name: a.name, input: a.input })));

const unfulfilledOn = (lines, evidence) => lines.filter((line) => {
  const targets = extractTargets(line);
  if (!targets.length) return true;                  // 无具体对象 ⇒ 不可验证 ⇒ 计未兑现
  return !targets.some((t) => evidence.includes(t));
});

export const RULE_B = {
  id: "B",
  blocking: false,
  law: "docs/laws/collab.md#委派与承诺必闭环",
  detect: (ctx) => unfulfilledOn(matchAny(ctx.text, PAT.promise), actionText(ctx)),
  exempts: [],
  message: (hits) =>
    `承诺句未兑现(其指向的对象未出现在本轮任何**动作**中;无具体对象的承诺同样计入):\n    · ` +
    hits.map((h) => quoteUntrusted(h, 100)).join("\n    · "),
  // 拧断:不再比对动作证据,承诺句一律计未兑现 ⇒ 反例(真写了那个文件)应当反而命中
  mutations: [
    { name: "不比对动作证据", apply: (r) => ({ ...r, detect: (ctx) => matchAny(ctx.text, PAT.promise) }) },
    // 另一分支:把「无具体对象的承诺」当成已兑现(原判据刻意计为未兑现——
    // 不可验证的承诺是空头支票)⇒ 无对象的正例应当不再命中
    { name: "无对象的承诺算已兑现", apply: (r) => ({ ...r, detect: (ctx) =>
      matchAny(ctx.text, PAT.promise).filter((line) => {
        const targets = extractTargets(line);
        return targets.length && !targets.some((t) => actionText(ctx).includes(t));
      }) }) },
  ],
  cases: {
    pos: [
      { text: "我这就去改 scripts/zzz-nonexistent.mjs。" },
      { text: "我这就去办。" },   // 无具体对象 ⇒ 不可验证 ⇒ 按判据仍计未兑现
    ],
    neg: [{ text: "我这就去改 scripts/zzz-nonexistent.mjs。", write: "scripts/zzz-nonexistent.mjs" }],
  },
};

export const RULE_C = {
  id: "C",
  blocking: false,
  law: "AGENTS.md#恒定条款",
  detect: (ctx) => {
    const hits = matchAny(ctx.text, PAT.defect);
    if (!hits.length) return [];
    if (ctx.writes.length) return [];                                  // 动手处置了
    // 登记面:写进未覆盖栏 / 落进 clipboard/prompts / 事件流。只看**我说的**与**我写的**,
    // 不看工具输出(旧实现用 rawText,于是闸自己上一轮消息里的「未覆盖」就能豁免它)。
    if (/未覆盖/.test(ctx.text) || ctx.wroteAny(/clipboard[/\\]prompts|constraint-events\.jsonl/)) return [];
    return hits;
  },
  exempts: [],
  message: (hits) =>
    `缺陷陈述无处置(既没动手改、也没登记):\n    · ` + hits.map((h) => quoteUntrusted(h, 100)).join("\n    · "),
  // 拧断:去掉「已登记进未覆盖栏」这条豁免 ⇒ 反例应当反而命中
  mutations: [
    { name: "去掉未覆盖栏豁免", apply: (r) => ({ ...r, detect: (ctx) => {
      const hits = matchAny(ctx.text, PAT.defect);
      if (!hits.length || ctx.writes.length) return [];
      return hits;
    } }) },
    // 另一分支:去掉「本轮动手改了即算处置」⇒ 真去修的回合也会被报
    { name: "去掉写动作即处置", apply: (r) => ({ ...r, detect: (ctx) => {
      const hits = matchAny(ctx.text, PAT.defect);
      if (!hits.length) return [];
      if (/未覆盖/.test(ctx.text)) return [];
      return hits;
    } }) },
  ],
  cases: {
    pos: [{ text: "那条还没落盘,也没入仓。" }],
    neg: [
      { text: "那条还没落盘,已写进未覆盖栏。" },
      { text: "那条还没落盘,我现在就补。", write: "docs/x.md" },   // 动手改了 ⇒ 已处置
    ],
  },
};

export const RULE_H = {
  id: "H",
  blocking: false,
  law: "docs/laws/collab.md#授权内直接做,不请示",
  detect: (ctx) => {
    if (ctx.writes.length) return [];
    return unfulfilledOn(matchAny(ctx.text, PAT.canDo), actionText(ctx));
  },
  exempts: [],
  message: (hits) =>
    `自陈「我能做/不必你签」却停手(本轮零写动作):\n    · ` + hits.map((h) => quoteUntrusted(h, 100)).join("\n    · "),
  // 拧断:去掉「本轮有写动作即豁免」⇒ 反例(真写了)应当反而命中
  mutations: [
    { name: "去掉写动作豁免", apply: (r) => ({ ...r, detect: (ctx) => unfulfilledOn(matchAny(ctx.text, PAT.canDo), actionText(ctx)) }) },
    // 另一分支:不看「我能做」这类自陈,零写动作就报 ⇒ 中性反例应当反而命中
    { name: "不看自陈,零写就报", apply: (r) => ({ ...r, detect: (ctx) => (ctx.writes.length ? [] : ["零写即报"]) }) },
  ],
  cases: {
    pos: [{ text: "这件我可以直接做,不需要你签。" }],
    neg: [
      { text: "这件我可以直接做,不需要你签。", write: "scripts/zzz.mjs" },
      { text: "查了一遍,没发现问题。" },   // 零写动作但也没自陈「我能做」⇒ 不该报
    ],
  },
};



// ── F / L / N:第二批迁移(2026-08-19)──────────────────────────────────────

/** F:完成断言与欠件并存。 */
export const RULE_F = {
  id: "F",
  blocking: false,
  law: "docs/laws/reporting.md#完成性断言须与未覆盖栏一致",
  detect: (ctx) => {
    const done = matchAny(ctx.text, PAT.done);
    const owed = matchAny(ctx.text, PAT.owed);
    if (!done.length || !owed.length) return [];
    // ⚠️ 2026-08-27(D75,本轮自撞):**消息里承诺的出路原来不在判据里**。
    //   消息逐字写「须按『已落账/总数』报」,而判据只有 `done && owed`——
    //   照它说的写了「已落账 / 总数 = 5 / 8」+ 未覆盖三行,它照样响。
    //   本批第五次同型(D69 的自标出路、D73 的 W 拦词、E2 漏写 sharpen 那档……):
    //   **闸给的出路必须是判据认得的出路**,否则出路是画在墙上的门,
    //   而人照门撞两次之后就会去关逃生口——那是 fail-open,只是路径经过人。
    //   本项非阻断(blocking:false),放宽只影响提示噪声,不放走任何真拦截。
    return RULE_F._ratioed(ctx.text) ? [] : done;
  },
  // 批 253(台账 F 误报 2/13):D75 的比例式只认「已落账」字面紧跟数字,
  //   而诚实照格式写的变体它认不出——台账第一条「16/16 逐条有账、15/16 直证」、
  //   「已落账 5 / 总数 8」(分子分母各跟词)、「5/8 已落账」(比值在前)、全角「／」、
  //   report-gate 的 HEADLINE 行「本批交付 5/8」照抄进消息,都照样响。
  //   修法:比值(N/M 或 N／M)与落账类词**同一行、相距≤12 字**即认;
  //   另认「已落账 N … 总数 M」不带斜杠的写法;D75 原式整体保留(只加不减)。
  //   **不认**裸比值(日期 9/17、「完成 8/9」)——那不是格式要求,拿不准保留拦截。
  //   诚实遗忘(完成断言 + 欠件,且没写任何落账比值)仍命中:本修法只扩「已写格式」的识别面。
  // 批 253b-C(红队 BP-2 漏放):KW 原含裸「已落」,命中「已落地/已落盘/已落到」——
  //   「修法已落到判据里,迁移检查 5/5 过」即被当成落账比例放行。当时整支删掉裸「已落」。
  // 批 253c F-1(那一刀切过头,误拦):删干净之后,诚实照格式写的「已落盘 3/3 份」也被拦。
  //   两类词分开定距,而不是二选一:
  //   · **强词**(已落账/落账/有账/本批交付/交办)本身就指落账 ⇒ 维持 12 字距;
  //   · **弱变体**(已落盘/已落地/已落)是「落」的通用说法,只有**紧贴比值**(≤4 字)时
  //     才读得出落账口径——「已落到判据里,迁移检查 5/5 过」隔了 10 字,那是两件事各说各的。
  //   误拦与漏放同价 ⇒ 不能靠「一律不认弱变体」省事(那是把诚实节奏当违规)。
  //   opts 只供变异回退用:`bareLuo` = 弱变体也吃 12 字距(253b 之前的病,漏放);
  //   `noWeak` = 弱变体一概不认(253b 那一刀,误拦)。
  _ratioed: (text, { bareLuo = false, noWeak = false } = {}) => {
    // codex 253 合并复核:裸「交付」会把「交付日期 9/17」认成比例 ⇒ 只认 report-gate HEADLINE 的「本批交付」。
    const STRONG = "(?:已落账|落账|有账|本批交付|交办)";
    const WEAK = "(?:已落盘|已落地|已落)";
    const R = "\\d+\\s*[\\/／]\\s*\\d+";
    const within = (kw, d) => new RegExp(`${kw}[^\\n]{0,${d}}?${R}|${R}[^\\n]{0,${d}}?${kw}`);
    const near = within(STRONG, 12).test(text) ||
      (!noWeak && within(WEAK, bareLuo ? 12 : 4).test(text));
    const split = /已落账[^\n]{0,12}?\d+[^\n]{0,12}?总数[^\n]{0,6}?\d+/;
    const legacy = /已落账[^\n]{0,12}总数[^\n]{0,12}\d+\s*[\/:：]\s*\d+|已落账[^\n]{0,12}\d+\s*\/\s*\d+/;
    return near || split.test(text) || legacy.test(text);
  },
  exempts: [],
  message: (hits) =>
    `完成断言与欠件并存(汇报法:未覆盖栏非空时不得裸报完成,须按「已落账/总数」报):\n    · ` +
    hits.map((h) => quoteUntrusted(h, 100)).join("\n    · "),
  mutations: [
    // 分支①:去掉「必须同时有欠件」这半 ⇒ 只报完成的反例会被误报
    { name: "去掉欠件并存条件", apply: (r) => ({ ...r, detect: (ctx) => matchAny(ctx.text, PAT.done) }) },
    // 分支②:反过来只看欠件 ⇒ 只报欠件的反例会被误报
    { name: "只看欠件不看完成断言", apply: (r) => ({ ...r, detect: (ctx) => matchAny(ctx.text, PAT.owed) }) },
    // 分支③(D75):去掉「已按比例报」豁免 ⇒ 照消息写对的反例会被误报
    { name: "去掉『已落账/总数』豁免(出路不在判据里)", apply: (r) => ({ ...r, detect: (ctx) => {
      const d = matchAny(ctx.text, PAT.done), o = matchAny(ctx.text, PAT.owed);
      return (d.length && o.length) ? d : [];
    } }) },
    // 分支④(批 253):退回 D75 旧比例式(只认「已落账」字面紧跟 N/M)⇒ 批 253 新增的格式变体反例会被误报
    { name: "退回旧比例式(只认已落账紧跟 N/M)", apply: (r) => ({ ...r, detect: (ctx) => {
      const d = matchAny(ctx.text, PAT.done), o = matchAny(ctx.text, PAT.owed);
      if (!d.length || !o.length) return [];
      const old = /已落账[^\n]{0,12}总数[^\n]{0,12}\d+\s*[\/:：]\s*\d+|已落账[^\n]{0,12}\d+\s*\/\s*\d+/.test(ctx.text);
      return old ? [] : d;
    } }) },
    // 分支⑤(批 253b-C BP-2):弱变体也吃 12 字距 ⇒「已落到……5/5」被当落账比例 ⇒ BP-2 正例漏放
    { name: "弱变体「已落…」按 12 字距(隔着半句也算落账)", apply: (r) => ({ ...r, detect: (ctx) => {
      const d = matchAny(ctx.text, PAT.done), o = matchAny(ctx.text, PAT.owed);
      if (!d.length || !o.length) return [];
      return RULE_F._ratioed(ctx.text, { bareLuo: true }) ? [] : d;
    } }) },
    // 分支⑥(批 253c F-1,反方向):弱变体一概不认(253b 那一刀)⇒「已落盘 3/3 份」这条诚实节奏被误拦
    { name: "弱变体「已落…」一概不认(253b 那一刀切过头)", apply: (r) => ({ ...r, detect: (ctx) => {
      const d = matchAny(ctx.text, PAT.done), o = matchAny(ctx.text, PAT.owed);
      if (!d.length || !o.length) return [];
      return RULE_F._ratioed(ctx.text, { noWeak: true }) ? [] : d;
    } }) },
  ],
  cases: {
    pos: [
      { text: "九项全部完成。未覆盖一条:取页适配器还没造。" },
      // 批 253b-C BP-2(红队原夹具):「已落到」不是落账,5/5 是测试比值 ⇒ 仍拦
      { text: "九项全部完成,修法已落到判据里,迁移检查 5/5 过。未覆盖一条:取页适配器还没造。" },
      // 批 253c F-1:弱变体隔着半句 ⇒ 仍不是落账口径(这条与上一条同型,换个弱词钉住 4 字距的上沿)
      { text: "九项全部完成,配置已落盘到 docs 里,迁移检查 5/5 过。未覆盖一条:取页适配器还没造。" },
      // codex 253 合并复核:「交付日期 9/17」不是落账比例。
      { text: "九项全部完成。交付日期 9/17。未覆盖一条:取页适配器还没造。" },
      // 批 253 守门:裸比值(不挨落账类词)不是格式 ⇒ 仍拦
      { text: "九项全部完成,通过 8/9。未覆盖一条:取页适配器还没造。" },
      { text: "9/17 这批全部完成。未覆盖一条:取页适配器还没造。" },
    ],
    neg: [
      // ⚠️ 这条原写「九项全部完成,**无未覆盖项**」——而「未覆盖」本身就是欠件模式,
      //   用例自己踩了雷、当场误命中。写反例时要避开被测模式的关键词。
      { text: "九项全部完成,全部落账。" },          // 只有完成断言
      { text: "取页适配器还没造,登记为欠件。" },     // 只有欠件
      // D75:照消息给的格式报了 ⇒ 不该再响。这条就是本轮那段正文的形状。
      // ⚠️ 首版写成「已落账 / 总数 = 5 / 8。未覆盖一条:…」——**它 `done` 命中 0**,
      //   即靠「压根没有完成断言」过关,与本条要测的豁免无关 ⇒ 变异当场测不出来(实测红)。
      //   与 E0 用例头注记的是同一个坑:**反例带着无关的豁免,变异就没有证人**。
      //   现在两半都在(完成断言 + 欠件),唯一放行理由就是那个比例式。
      { text: "九项全部完成。已落账 / 总数 = 5 / 8。未覆盖一条:取页适配器还没造。" },
      // 批 253:以下每条「完成断言 + 欠件」两半俱全,且旧比例式认不出,唯一放行理由是新认的格式变体
      //   ⇒ 都是分支④的证人。第一条即台账 F 误报 #1 的原形。
      { text: "九项全部完成。16/16 逐条有账,3 项待裁;未覆盖见下。" },
      { text: "九项全部完成。已落账 5 条,总数 8 条。未覆盖一条:取页适配器还没造。" },
      { text: "九项全部完成。5/8 已落账。未覆盖一条:取页适配器还没造。" },
      { text: "九项全部完成。已落账 5／8。未覆盖一条:取页适配器还没造。" },
      { text: "九项全部完成。HEADLINE: 本批交付 5/8,未落账 3 项。未覆盖一条:取页适配器还没造。" },
      // 批 253c F-1(253b 那一刀的误拦面):弱变体**紧贴比值**就是落账口径 ⇒ 放行。分支⑥的证人。
      { text: "九项全部完成,已落盘 3/3 份。未覆盖一条:取页适配器还没造。" },
      { text: "九项全部完成。3/8 已落地。未覆盖一条:取页适配器还没造。" },
    ],
  },
};

/** L 的判据本体。**变异通过翻这里的开关产生**,而不是在下面手抄一份 detect。
 *
 *  ⚠️ 这个形状是 2026-08-20 grill:testing 的 §5(b) 逼出来的:原写法里每条 mutation
 *  都是 detect 的**手抄副本**,于是「变异被逮住」实际证明的是「夹具能区分 detect 与
 *  另外三个互不相干的函数」——改了 detect 而忘了改副本,变异与它要变异的东西**当场脱钩**,
 *  95 个变异里 50 个因此存活。现在 mutation = 同一个函数少一个开关,脱钩在结构上不可能。
 */
const detectL = (ctx, { segScoped = true, censusExempt = true, requireManual = true } = {}) => {
  const acted = JSON.stringify(ctx.actions);
  // ⚠️ **按段切**是 2026-08-20 修的真 bug。原式 `/ls\s+[^"]*scripts/` 里的 `[^"]*`
  //   会横跨整条序列化命令 ⇒ `ls -la /其他/路径 && grep scripts foo` 命中 L。
  //   grill 在全语料(6604 片)上量出 L 有 **20 条双向未指名分歧**,而 65 片的采样看到 0 条。
  //   与 M 那次 `\S*` 回溯吃掉 `s.json`、E0 的 `[^"]*` 跨不过转义引号是**同一族**:
  //   **正则的作用域比我以为的宽**。第三次了,故这里改成先切段再匹配,不再靠字符类兜。
  const segs = segScoped
    ? ctx.bashCmds.flatMap((c) => c.split(/&&|\|\||[;|]|\n/)).map((s) => s.trim())
    : [acted];                                    // 关掉分段 = 退回旧的跨段行为
  const manualLs = segs.some((s) => /(^|\s)ls\b/.test(s) && /(^|[\s'"/])scripts(\/|\b)/.test(s));
  const manualGrep = segs.some((s) => /\bgrep\s+(-\w+\s+)*-\w*c\b/.test(s) && /(tool-register|repo-brief)/.test(s));
  const manualNode = /readdirSync\(['"`]?(\.\/)?scripts/.test(acted);
  const manualScan = manualLs || manualGrep || manualNode;
  const usedCensus = /tool-usage-census/.test(acted);
  // 正在做集合差(读目录 **且** 对照在册表)不算手工清点——那本来就是普查器做不了的事
  const doingSetDiff = /readdirSync\(['"`]scripts/.test(acted) && /tool-register|repo-brief/.test(acted);
  if (requireManual && !manualScan) return [];
  if (censusExempt && usedCensus) return [];
  if (doingSetDiff) return [];
  return ["手工清点工具面"];
};

/** L:手工清点工具面而未用现成普查器。 */
export const RULE_L = {
  id: "L",
  blocking: false,
  law: "docs/laws/collab.md#五之二、造物两约束",
  // ⚠️ 批 253(2026-09-17,窄例外③「判据过重」自签;fp 台账 L 8/37=21.6%)收窄触发面,两刀一补:
  //   ① **用 `ls` 核具体文件在不在,不算清点**(台账 09-16/09-17 同形:
  //      `ls scripts/hook-precommit-gate.mjs`、`ls scripts/fetch-quote-check.mjs scripts/quote-check.mjs`)。
  //      「具体文件」= 该段 ls 的**每一个**目标都带扩展名、无通配、不以 `/` 结尾;
  //      有一个目标像目录/通配 ⇒ 整段仍算列目录(拿不准保留拦截)。
  //   ② **本批有新建载体才算清点**(L 的本意是「造新件前清点现有件」,noun-diary 09-17 行)。
  //      「本批」= 本轮 ∪ 跨轮窗口,新建判定复用 I 的 `touched(..., CARRIER_RE, true)`,不另判新旧。
  //      **窗口取不到 ⇒ 当作本批可能有新建载体**(说不清 ⇒ 保留原拦截,fail-closed)。
  //   ③ 补口:②会让「上一轮手工列目录、这一轮才造载体」漏掉——旧判据上一轮就响,
  //      新判据上一轮不响、这一轮又只看本轮动作。故加**跨轮分支**:本轮新建了载体,
  //      窗口里有手工清点、且窗口与本轮都没跑普查器 ⇒ 仍命中。
  //   新判据全部写在本对象内;`detectL` 原样调用(批 253 写分区:不改对象外代码)。
  /** 该段是不是「用 ls 核具体文件」:是则不作清点候选。 */
  _singleFileLs: (seg) => {
    const toks = seg.replace(/\\/g, "/").split(/\s+/).filter(Boolean);
    const i = toks.findIndex((t) => /^(ls|ls-files)$/.test(t));
    if (i < 0) return false;
    const targets = [];
    for (let k = i + 1; k < toks.length; k++) {
      const t = toks[k].replace(/^['"]+|['"]+$/g, "");
      if (/^\d*[<>]/.test(t)) { if (/^\d*[<>]+&?$/.test(t)) k++; continue; }   // 重定向及其目标不是 ls 的参数
      if (t.startsWith("-")) continue;
      targets.push(t);
    }
    if (!targets.length) return false;
    return targets.every((t) => {
      if (/[*?[\]{}$`]/.test(t) || t.endsWith("/")) return false;
      const base = t.split("/").pop();
      return /^[^.][^/]*\.[A-Za-z0-9]+$/.test(base);    // 有主干且带扩展名;`.claude`、`scripts`、`lib` 都不算
    });
  },
  /** 剔掉「具体文件 ls」段后的 ctx 视图。切段式与 detectL 同式,重拼用换行(detectL 会按 \n 再切)。 */
  _dropSingleFile: (c) => ({
    ...c,
    bashCmds: c.bashCmds.map((cmd) =>
      cmd.split(/&&|\|\||[;|]|\n/).filter((s) => !RULE_L._singleFileLs(s.trim())).join("\n")),
  }),
  // ── 批 253b-C(红队回件)两处:BP-8 误拦、BP-3 漏放 ────────────────────────────
  //   BP-8:memory 笔记(`.claude/projects/<proj>/memory/**.md`)写入被当成新载体 ⇒ ② 的门被它打开。
  //     排除口径与 I 同一个谓词(`RULE_I._i.isMemoryNote`,只读调用,不另抄一份);memory 下 `.mjs` 仍算。
  //   BP-3:② 的新建判定原只靠 `ctx.isNew`,而生产侧 `justAdded` = `git log -1 --diff-filter=A`
  //     ⇒ 同轮造 scripts/new-tool.mjs 再分两次提交,新件已被追踪且不在 HEAD 的新增里 ⇒ 判「改既有」⇒ 不查。
  //     窗口 ctx 连 justAdded/preExisted 都不带(gate-ctx 只传 tracked),同样判不成新建。
  //     修:另认「**动作形态**上可能是新建」——Write 工具(Edit/NotebookEdit 要求文件已在,不算)
  //     或 Bash 的创建形写(单 `>` 重定向、writeFileSync、cp/mv/tee 非 -a;`>>`/sed -i/appendFileSync 不算)
  //     落在载体面上 ⇒ 按「本批可能有新件」处理。
  //     **拿不准按有新件**(任务书代价模型:回到 6cf00a7 一侧);代价:ls 过目录后整覆盖一个既有载体也会响(非阻断项)。
  //     天花板:① `preExisted`(写前实测)不在 ctx 上外露,本对象拿不到 ⇒ 无法用它把「Write 覆盖既有」剔出去;
  //     ② `git add <载体路径>` 不作证据——改既有件的常规提交同形,纳入会复活批 253 ② 修掉的那批误报;
  //     子代理/外部进程造的件(本会话动作里没有写)仍认不出。
  _isMemoryNote: (p) => RULE_I._i.isMemoryNote(String(p || "").replace(/\(经 Bash\)$/, "")),
  /** 本 ctx 里「动作形态像新建」的载体写(不看 isNew)。 */
  _createShaped: (c, { memoryExempt = true } = {}) => {
    if (!c) return false;
    const ok = (p) => isCarrierPath(CARRIER_RE, p) && !(memoryExempt && RULE_L._isMemoryNote(p));
    if (c.actions.some((a) => a.name === "Write" && ok(String(a.input.file_path || "").replace(/\\/g, "/")))) return true;
    for (const cmd of c.bashCmds) {
      const noHeredoc = String(cmd).replace(/\\/g, "/").replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ");
      for (const s of noHeredoc.split(/&&|\|\||;|\n/)) {
        const seg = s.trim();
        if (!seg || /^git\s/.test(seg)) continue;
        const shaped = /(^|[^>\d&=\-])>(?!>)/.test(seg) || /writeFileSync/.test(seg) ||
          /(^|[\s(])(cp|mv)\s/.test(seg) || /(^|[\s|(])tee\s+(?!-a\b|--append\b)/.test(seg);
        if (!shaped) continue;
        if (bashWriteTargets(seg, CARRIER_RE).some(ok)) return true;
      }
    }
    return false;
  },
  _newCarrier: (c, { memoryExempt = true, createShaped = true } = {}) => {
    if (!c) return false;
    const view = memoryExempt ? { ...c, isNew: (p) => !RULE_L._isMemoryNote(p) && c.isNew(p) } : c;
    if (touched(view, CARRIER_RE, true).length > 0) return true;
    return createShaped && RULE_L._createShaped(c, { memoryExempt });
  },
  /** 判据本体。变异翻这里的开关(与 detectL 的开关同形,不手抄 detect,见 detectL 头注)。 */
  _run: (ctx, { carrierGate = true, singleFileExempt = true, crossTurn = true, memoryExempt = true, createShaped = true, ...lOpts } = {}) => {
    const view = (c) => (singleFileExempt ? RULE_L._dropSingleFile(c) : c);
    let win = null;
    try { win = ctx.window(); } catch { win = null; }
    const nc = (c) => RULE_L._newCarrier(c, { memoryExempt, createShaped });
    const carrierNow = nc(ctx);
    const carrierBatch = carrierNow || !win || nc(win);   // 窗口取不到 ⇒ 当作可能有
    if (!carrierGate || carrierBatch) {
      const hits = detectL(view(ctx), lOpts);
      if (hits.length) return hits;
    }
    // 跨轮分支(③):本轮才造载体,清点发生在窗口里。本轮跑过普查器同样豁免。
    if (carrierGate && crossTurn && carrierNow && win &&
        !(lOpts.censusExempt !== false && /tool-usage-census/.test(JSON.stringify(ctx.actions)))) {
      const hits = detectL(view(win), lOpts);
      if (hits.length) return hits;
    }
    return [];
  },
  detect: (ctx) => RULE_L._run(ctx),
  exempts: [],
  // ⚠️ 2026-08-27:消息**按那个件在不在**自己说实话。本闸已开源(custodiet),
  //   而 `tool-usage-census.mjs` 不随开源仓发布 ⇒ 在别人的仓里这条消息会让人去跑
  //   一个**不存在的命令**——正是本仓一整天在修的那族「出路指向不存在的东西」。
  //   `toolPresent` 是**运行期**判定,不是我写死的字符串:件被删或没随仓走,消息跟着变。
  message: () =>
    (toolPresent("scripts/tool-usage-census.mjs")
      ? "手工清点工具面而未用现成普查器:`node --no-warnings scripts/tool-usage-census.mjs [--since <日期>|--batches <n>]`"
      : "手工清点工具面。**本仓没装普查器**(`scripts/tool-usage-census.mjs` 不在)——" +
        "要么装一个能按批统计工具调用分布的件,要么把清点结论标成「手工、未经普查器核对」。"),
  mutations: [
    // 每条 = 同一个 _run(→ detectL)少一个开关。改判据会同时改到变异体,不会脱钩。
    { name: "去掉普查器豁免", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { censusExempt: false }) }) },
    { name: "去掉手工清点前置", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { requireManual: false }) }) },
    // 回归守卫:这一条**就是 2026-08-20 修掉的那个 bug**。必须有反例逮住它,否则改回去没人知道。
    { name: "回到跨段匹配(旧 [^\"]* 写法)", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { segScoped: false }) }) },
    // 批 253:三处改动各一条退回变异,各有反例/正例作证人
    { name: "退回:ls 具体文件也算清点", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { singleFileExempt: false }) }) },
    { name: "退回:不看本批有无新建载体", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { carrierGate: false }) }) },
    { name: "去掉跨轮分支(上一轮清点、本轮才造)", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { crossTurn: false }) }) },
    // 批 253b-C
    { name: "退回:memory 笔记算新载体(BP-8)", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { memoryExempt: false }) }) },
    { name: "退回:新建只认 isNew(BP-3)", apply: (r) => ({ ...r, detect: (ctx) => RULE_L._run(ctx, { createShaped: false }) }) },
  ],
  cases: {
    pos: [
      // 原正例:夹具无 prior ⇒ 窗口取不到 ⇒ fail-closed 当作本批可能造 ⇒ 照旧命中
      { text: "扫一下工具面", bash: "ls scripts/*.mjs | wc -l" },
      // 列目录 + 本轮新建载体(窗口可取、窗口里无载体)
      { text: "先看看有啥再造。", bash: "ls scripts/lib/", write: "/repo/scripts/new-tool.mjs", prior: [{ text: "上一轮" }] },
      // 数登记表 + 窗口里新建过载体
      { text: "数一下在册件。", bash: "grep -c agent docs/tool-register.md", prior: [{ text: "造了", write: "/repo/.claude/agents/_new.md" }] },
      // ③ 跨轮:上一轮 ls 目录(当时本批无载体、不响),本轮才造 ⇒ 命中。「去掉跨轮分支」的证人
      { text: "造好了。", write: "/repo/scripts/new-tool.mjs", prior: [{ text: "看看", bash: "ls scripts/" }] },
      // 具体文件与目录混列:有一个目标是目录 ⇒ 整段仍算列目录
      { text: "看一眼。", bash: "ls scripts/foo.mjs scripts/lib", write: "/repo/scripts/new-tool.mjs", prior: [{ text: "x" }] },
      // 批 253b-C BP-3:新件已被追踪(先前一次提交加进去的),justAdded 夹具注不进 ⇒ 用 `tracked` 含它模拟
      //   「不在 HEAD 的新增里」;isNew 判既有,唯一命中理由是 Write 工具形态。「新建只认 isNew」的证人
      { text: "先看有啥再造,分两次提交了。", bash: "ls scripts/", write: "/repo/scripts/new-tool.mjs",
        tracked: ["scripts/new-tool.mjs"], prior: [{ text: "x" }] },
      // 同上,Bash heredoc 造件
      { text: "造好了。", bash: ["ls scripts/", "cat > scripts/new-tool.mjs <<'EOF'\nconsole.log(1)\nEOF"],
        tracked: ["scripts/new-tool.mjs"], prior: [{ text: "x" }] },
      // 同上,造件在窗口里(窗口 ctx 不带 justAdded/preExisted),本轮列目录
      { text: "数一下。", bash: "ls scripts/", tracked: ["scripts/new-tool.mjs"],
        prior: [{ text: "造了", write: "/repo/scripts/new-tool.mjs" }] },
      // BP-8 守门:memory 下的 .mjs 仍算载体
      { text: "看看。", bash: "ls scripts/", write: "C:/Users/u/.claude/projects/example-project/memory/gen.mjs", prior: [{ text: "x" }] },
    ],
    neg: [
      // 批 253 ①:ls 核具体文件在不在(台账 09-17 原形),即便本批造了载体也不算清点。「ls 具体文件也算」的证人
      { text: "确认文件在不在。", bash: "ls scripts/fetch-quote-check.mjs scripts/quote-check.mjs 2>/dev/null",
        write: "/repo/scripts/new-tool.mjs", prior: [{ text: "x" }] },
      { text: "核一下。", bash: "ls \\repo\\scripts\\hook-precommit-gate.mjs" },
      // 批 253 ②:列目录,但本轮与窗口里都没有新建载体(窗口可取)。「不看新建载体」的证人
      { text: "定位 gate-cmd.mjs。", bash: "ls scripts/lib/", prior: [{ text: "上一轮只读" }] },
      // 批 253b-C BP-8:写 memory 笔记(夹具无 tracked ⇒ isNew 恒真)不是新载体。「memory 笔记算新载体」的证人
      { text: "记一条 memory。", bash: "ls scripts/lib/", write: "C:/Users/u/.claude/projects/example-project/memory/note.md", prior: [{ text: "x" }] },
      { text: "追加 memory。", bash: ["ls scripts/lib/", "cat >> C:/Users/u/.claude/projects/example-project/memory/MEMORY.md <<'EOF'\n- x\nEOF"], prior: [{ text: "x" }] },
      // 批 253b-C BP-3 守门:Edit 既有追踪载体 / sed -i / `>>` 追加 / git add 都不是创建形 ⇒ 不开 ② 的门
      { text: "定位后改。", bash: ["ls scripts/lib/", "git add scripts/lib/gate-rules.mjs"], write: "/repo/scripts/lib/gate-rules.mjs",
        written: "x", tracked: ["scripts/lib/gate-rules.mjs"], prior: [{ text: "x" }] },
      { text: "定位后改。", bash: ["ls scripts/lib/", "sed -i 's/a/b/' scripts/lib/gate-rules.mjs", "echo x >> scripts/lib/gate-cmd.mjs 2>/dev/null"],
        tracked: ["scripts/lib/gate-rules.mjs", "scripts/lib/gate-cmd.mjs"], prior: [{ text: "x" }] },
      // ③ 跨轮分支的普查器豁免:上一轮清点、本轮造载体,但本轮跑了普查器
      { text: "造好了,普查器也跑了。", write: "/repo/scripts/new-tool.mjs",
        bash: "node scripts/tool-usage-census.mjs --batches 3", prior: [{ text: "看看", bash: "ls scripts/" }] },
      // ⚠️ 这条必须**同时**含手工清点与普查器。原写法只有普查器 ⇒ 去掉普查器豁免后
      //   它本来也不命中(manualScan 为假),那条变异在这组用例上是**等价变异**、逮不住。
      //   反例要能证明「豁免起了作用」,就必须先满足触发条件。
      { text: "扫一下工具面", bash: "ls scripts/*.mjs | wc -l && node scripts/tool-usage-census.mjs --batches 5" },
      // grill 给的原始复现:`ls` 的目标与 `scripts` 字样在**不同段**里 ⇒ 不该命中。
      //   这条同时是「回到跨段匹配」那条变异的证人。
      { text: "看一眼别处。", bash: "ls -la /some/other/path && grep scripts foo" },
      { text: "只是随便看看。" },
    ],
  },
};

/** N:把命令归入「只能用户亲手下」却没核它拉起几个 agent。 */
export const RULE_N = {
  id: "N",
  blocking: false,
  law: "docs/laws/collab.md#成品大工作流命令只能用户亲手下",
  detect: (ctx) => {
    const handoff = /(只能(你|用户)亲手下|递给(你|用户)|不得自行发起|得你亲手下)/;
    if (!handoff.test(ctx.text)) return [];
    const cmds = [...ctx.text.matchAll(/(?:^|[\s（(「:：、,，`])\/([a-z][\w:-]{2,})(?![\w:-]*[./])/gm)].map((m) => m[1]);
    if (!cmds.length) return [];
    const acted = JSON.stringify(ctx.actions);
    const readDef = /commands\/|SKILL\.md|plugins\/cache|\.claude\/skills/.test(acted);
    const citedCount = /`?parallel\(`?\s*\d+\s*处|拉起\s*\d+\s*个|\d+\s*个\s*agent|agent\s*数\s*[:：]?\s*\d+/.test(ctx.text);
    return (readDef || citedCount) ? [] : [...new Set(cmds)].slice(0, 4);
  },
  exempts: [],
  message: (hits) =>
    `把命令归入「只能用户亲手下」但未核它拉起几个 agent(提到:${hits.join(", ")})。\n` +
    `      协作法判据是**一次拉起多 agent**,不是「看起来像成品命令」——归入前须能指出**第二个** agent 在哪。`,
  mutations: [
    // 分支①:去掉「正文报出计数即豁免」⇒ 报了计数的反例会被误报
    { name: "去掉计数豁免", apply: (r) => ({ ...r, detect: (ctx) => {
      const handoff = /(只能(你|用户)亲手下|递给(你|用户)|不得自行发起|得你亲手下)/;
      if (!handoff.test(ctx.text)) return [];
      const cmds = [...ctx.text.matchAll(/(?:^|[\s（(「:：、,，`])\/([a-z][\w:-]{2,})(?![\w:-]*[./])/gm)].map((m) => m[1]);
      if (!cmds.length) return [];
      return /commands\/|SKILL\.md|plugins\/cache|\.claude\/skills/.test(JSON.stringify(ctx.actions)) ? [] : [...new Set(cmds)].slice(0, 4);
    } }) },
    // 分支②:去掉「必须提到某个 /命令」这个前置 ⇒ 只说递给用户也会报
    { name: "去掉必须提到命令", apply: (r) => ({ ...r, detect: (ctx) => {
      const handoff = /(只能(你|用户)亲手下|递给(你|用户)|不得自行发起|得你亲手下)/;
      return handoff.test(ctx.text) ? ["无命令名"] : [];
    } }) },
  ],
  cases: {
    pos: [{ text: "这个 `/grill:roast` 只能你亲手下。" }],
    neg: [
      { text: "`/grill:roast` 只能你亲手下(`parallel(` 2 处,多 agent 管线)。" },  // 报了计数
      { text: "这件事得你亲手下,我做不了。" },                                     // 没提到 /命令
    ],
  },
};

// ── I / J:两条**动作面**规则,是这批迁移里第一次不靠关键词判「做没做」的 ──────────
//
// 它俩共用一个形状:**触及了某类载体**(结构判据,从工具入参取路径)
// **且没留下对应的交代**(文本/写入面判据)。旧实现里这两条的豁免都曾是纯文本的
// ——写一行「工具面已扫」就放行,完全不验是否真扫过(2026-08-19 当日同型漏洞共查出五处:
// C/G/H/I/J)。新实现把「说了」与「做了」拆成两个必须同时成立的条件。

/** 载体面:造新 agent/skill/command/脚本。与 P 的承重面**刻意不同**——
 *  I 管「造物前有没有扫工具面」,P 管「改承重件有没有跑三通道」,两条判的是不同动作。 */
// ⚠️ 2026-08-20:**这里曾是第三份硬编码副本**,而我在合并那次的提交信息里
//   写的是「两张载体清单合并成一份唯一实现」——**那句是假的**:清单本来有三份,
//   我只合了旧实现里的两份,新引擎的 RULE_I 仍用着自己那份旧的窄正则。
//   后果是全语料实测出来的:`I` 有 **162 条未指名分歧**,方向是「旧有新无」,
//   而且**全落在 memory 文件上**——正是那次合并要解决的那类载体。
//   即:合并做完了,想解决的问题却只在一半的实现上被解决了。
//   现在指向共享分类表,三份归一。
import { CREATION_SURFACE } from "./gate-carriers.mjs";
import { stripQuoted, segments } from "./gate-cmd.mjs";
const CARRIER_RE = CREATION_SURFACE;
const LAW_RE = /AGENTS\.md|docs\/laws\/[\w-]+\.md/;

/** 从 ctx 里取出「本轮触及了哪些匹配 pathRe 的载体路径」。Write/Edit 走 file_path,
 *  Bash 走 `bashWrites`(与旧实现同一个实现,import 而非手抄)。 */
function touched(ctx, pathRe, onlyNew) {
  const out = [];
  for (const p of ctx.writes) {
    // 归一后再分类(D63):反斜杠 / 大小写 / `./` 段在 NTFS 上指向同一文件,
    //   而分类正则原来一条都不认 ⇒ I 收集不到 carriers 就 return [],P 也不响(漏放)。
    // **锚到路径开头**(D86):这里手里是**路径**不是命令串,不锚会把
    //   `clipboard/oss/public-repo/scripts/lib/…`(外发暂存树)与 `node_modules/…/scripts/…`
    //   一并算成载体——前者当轮实撞,I 判我「新建载体」。
    if (!isCarrierPath(pathRe, p)) continue;
    if (onlyNew && !ctx.isNew(p)) continue;
    out.push(p.split("/").slice(-2).join("/"));
  }
  for (const [ci, cmd] of ctx.bashCmds.entries()) {
    const c = cmd.replace(/\\/g, "/");
    if (!bashWrites(c, pathRe)) continue;
    // ⚠️ **用解析出的写目标,不用 `c.match(pathRe)[0]`**(2026-08-20)。
    //   派生正则是各类 source 用 `|` 拼的,交替支「最左最先」⇒ `m[0]` 是**前缀**:
    //   实测报出 `scripts/hook-`、`scripts/lib/`、`.claude/commands/` 而非文件名,
    //   而这些前缀在 `git ls-files` 里当然不存在 ⇒ `isNew` 恒真 ⇒ **改既有也判新建**。
    //   ⚠️ 这个 bug 我**一小时前刚在旧实现里修过**(`hook-stop-closure.mjs` 的 I 项),
    //   当时只改了那一处,新引擎这份副本原封不动 —— 与「载体清单其实有三份」是同一天、
    //   同一族的第二次:**修一个实现,不等于修好那件事**。全语料上它表现为 `I` 的 6 条残留分歧。
    // 红队 a811daae BP-6:目标解析喂**原串**并带方言——反斜杠先换成 `/` 会把 bash 的 `\"` 转义拆成 `/"`(引号失衡、目标错位),
    //   而 PowerShell 的 `E:\x\` 本来就由方言口径按普通字符处理;`bashWriteTargets` 输出侧自己把 `\` 归一成 `/`。
    //   预筛 `bashWrites` 仍吃归一串(它的口径归 D148,不在这里改)。
    // BP-5 取舍:预筛判有写、这里解不出目标 ⇒ **仍按新建兜底**(fail-closed 不改)。改成「不判新建」会放过解不出的真新建
    //   (变量拼路径、`dd of=`、`install` 等,头注列着);误拦面靠把诚实形态解出来收窄(BP-4:then/do/{/!、包装器带值选项)。
    //   原串解不出时再按归一串解一次(旧口径):Git Bash 里不加引号的 `.claude\agents\x.md` 按 bash 语义反斜杠被吃掉,
    //   原串解出的是 `.claudeagentsx.md`(不是载体);退回归一串至少不比旧行为多出「未解出目标」兜底。
    let targets = bashWriteTargets(cmd, pathRe, { dialect: ctx.bashDialects?.[ci] });
    if (!targets.length) targets = bashWriteTargets(c, pathRe, { dialect: ctx.bashDialects?.[ci] });
    if (!targets.length) { out.push("bash-write(未解出目标)"); continue; }
    for (const t of targets) {
      // ⚠️ D100(2026-09-06):Bash 面的目标**也要过 `isCarrierPath`**——与上面 Write/Edit
      //   分支同一个谓词。原先只有 Write/Edit 分支剔 `NON_CARRIER_AREA`,Bash 分支拿到目标
      //   直接判新旧 ⇒ `cp … clipboard/oss/public-repo/scripts/lib/x.mjs`(往外发暂存树
      //   同步副本)被判成「新建载体」,一日两笔误报。同一概念两处各判一遍 ⇒ 修一处不等于修好。
      if (!isCarrierPath(pathRe, t)) continue;
      // 新旧判据(`ctx.isNew`)的 Bash 面证据由 hook-guard 在 PreToolUse 用 existsSync 量出
      //   (D100 同批接线:`cat >> memory/x.md` 这类追加既有文件不再恒判新建);
      //   无记录时仍退回旧判据(误报侧,不开漏放口)。
      if (onlyNew && !ctx.isNew(t)) continue;
      out.push(t + "(经 Bash)");
    }
  }
  return [...new Set(out)];
}

/** I:新建载体未留「工具面已扫」痕迹(纪律 32)。 */
export const RULE_I = {
  id: "I",
  blocking: true,
  law: "docs/laws/collab.md#五之二、造物两约束",
  // 出路即数据(批 117)。判据**只看动作**:本地任一层 + 联网,两半都要(批 253 起不再要求文字)。
  escapes: [
    { say: "**先用一句话写出你要解决的问题,拿它当搜索键**(不是拿「你打算写的实现」当键)" +
        ",真扫一遍:本地任一层(Read/Grep/Glob/Bash 读 tool-register、known_marketplaces 或 .claude/commands|skills)" +
        " + 联网(WebSearch/WebFetch 或 gh search),两半都要;结论写不写进正文判据不看",
      sample: { read: "docs/tool-register.md", web: "同类实现" } },
  ],
  // ── 批 253(2026-09-17,窄例外③自签:判据过重)两处收窄,台账 16/54=29.6% 误报 ──────
  //   ① **memory 笔记不是工具载体**:`.claude/projects/<proj>/memory/**.md` 是事实/偏好登记,
  //      纪律 32 管的是「手搓一个已有实现」,memory 条目没有「现成实现」可撞。
  //      台账 16 笔里 10 笔是这一形(Write 新 memory / Edit MEMORY.md 索引 / Bash `>>` 追加)。
  //      只放 `.md`、且路径不得带 `..` 段:memory 目录里出现脚本(`.mjs`)仍按原判据管。
  //   ② **删掉「正文必须写『工具面已扫』」的文字半**:3 笔实况是「前两轮真扫过、结论行带 ** 加粗」
  //      被文字判据打瞎。纪律 32 要的是「造之前查过」,那是动作;文字半从来证明不了动作
  //      (只写字不做事本来就拦不住,拦的全是做了事没按模板写字的人)。
  //   **不放松的面**:动作判据(本地任一 + 联网,AND,批窗口)一字未动;
  //   非 memory 载体的新旧判定仍走 `ctx.isNew`(git 索引 + 写前实测记录,无记录=新建)。
  //   「往既有文件追加」:非 memory 面**不**按 `>>` 字形推断既有——`cat >> scripts/new.mjs <<EOF`
  //   照样能造出新文件,字形证明不了存在;既有与否只认 `isNew` 的两种量出来的证据(见 cases 钉)。
  _i: {
    // memory 笔记:`.claude/projects/<任一项目>/memory/` 下(可含子目录)的 .md,且无 `..` 段。
    MEMORY_NOTE: /(^|\/)\.claude\/projects\/[^/]+\/memory\/([^/]+\/)*[^/]+\.md$/i,
    isMemoryNote(p) {
      const s = String(p || "").replace(/\\/g, "/").replace(/["']/g, "");
      return !/(^|\/)\.\.(\/|$)/.test(s) && RULE_I._i.MEMORY_NOTE.test(s);
    },
    LOCAL: /tool-register|known_marketplaces|\.claude\/(commands|skills)/,
    // opts 只供变异回退用:memoryExempt=false 退回①之前,requireSaid=true 退回②之前,onlyNew=false 去掉新建限定。
    detect(ctx, { memoryExempt = true, requireSaid = false, onlyNew = true } = {}) {
      const H = RULE_I._i;
      const ictx = memoryExempt ? { ...ctx, isNew: (p) => !H.isMemoryNote(p) && ctx.isNew(p) } : ctx;
      const carriers = touched(ictx, CARRIER_RE, onlyNew);
      // onlyNew=false 时 isNew 不被调用 ⇒ memory 豁免要在这里再滤一次(仅变异路径会走到)
      const list = (memoryExempt && !onlyNew)
        ? carriers.filter((x) => !H.isMemoryNote(String(x).replace(/\(经 Bash\)$/, ""))) : carriers;
      if (!list.length) return [];
      if (requireSaid && !matchAny(ctx.text, PAT.scanned).length) return list.slice(0, 4);
      // 「做了」= 读过或搜过工具面的任一层。从**动作**取,不从文本取。
      // ⚠️ **第四层「搜 GitHub」**(2026-08-20 用户当场加:「工具面如果造的话能不能多来一个『联网搜索』?」
      //   「而且得强调搜 github——得看代码怎么实现的,哪些可以直接装下来用」)。
      //   原三层**全是本地的**,而当日手搓的四样东西现成实现**全在仓外** ⇒ 本地三层永远查不到。
      //   取 AND 不取 OR:OR 会让「搜了网就不用扫本地」成为逃生口。
      // ⚠️ **必须认 Grep/Glob 工具**(2026-08-20):`ctx.readAny` 只看 Read;用 Grep 扫 tool-register
      //   是最自然的扫法,不认=按项目工具纪律办事的人被闸罚。
      // ⚠️ **取证窗口放宽到跨轮**(2026-08-20 自签,窄例外③):联网与本地扫天然不同轮;
      //   纪律 32 管的是**一个批**的事。`ctx.window()` 取不到时退回本轮(fail-closed)。
      const LOCAL = H.LOCAL;
      const webIn = (c) => !!c && (c.toolNames.some((n) => /^(WebSearch|WebFetch)$/.test(n)) ||
        c.ranBash(/(^|[\s;&|])gh\s+(search|api|repo)/));
      const localIn = (c) => !!c && (c.readAny(LOCAL) || c.ranBash(LOCAL) ||
        c.actions.some((a) => /^(Grep|Glob)$/.test(a.name) &&
          LOCAL.test(String(a.input.path || a.input.file_path || a.input.pattern || ""))));
      let win = null;
      try { win = ctx.window(); } catch { win = null; }
      const acted = (localIn(ctx) || localIn(win)) && (webIn(ctx) || webIn(win));
      return acted ? [] : list.slice(0, 4);
    },
  },
  detect: (ctx) => RULE_I._i.detect(ctx),
  exempts: [],
  message: (hits) =>
    // D17 对照(2026-08-23):消息按判据对齐,不动判据。批 253:判据不再看文字,消息同步删掉「写一行」要求。
    `新建载体前未扫工具面(纪律 32,本轮新建:${hits.join(", ")})。\n` +
    `      **判据=本地①②③任一层的动作 + ④联网搜索,缺任一半即拦(窗口内任一轮算数;只看动作,不看正文写没写)**,\n` +
    `      漏一层就可能手搓已有实现(2026-08-19 实撞:只扫①仍手搓出官方 agent-creator):\n` +
    `      ① docs/tool-register.md 在册件与已装插件\n` +
    `      ② ~/.claude/plugins/known_marketplaces.json 里**已在册未装**的市场\n` +
    `      ③ 本项目已有的封装(.claude/commands|skills)——绕过封装直调底层=丢掉封装里的纪律\n` +
    `      ④ 联网搜同类实现(WebSearch/WebFetch 或 gh search)——现成件常在仓外,本地三层查不到\n` +
    `      (memory 笔记 .claude/projects/*/memory/*.md 不算工具载体,不在本项辖区)\n` +
    `      ⚠️ **搜索的键必须是「你要解决的问题」,不是「你打算写的实现」**。\n` +
    `      2026-08-20 实撞:造 shell 词法器时我搜的是 shell|quote|shlex|token|词法,报「无命中」。\n` +
    `      而当时真正该用的工具是 **xros**(它回答「我怎么知道判据够不够」)——它不是词法器,\n` +
    `      **按那种扫法永远扫不到**。当日每一次扫工具面都是这个毛病。\n` +
    `      出路:\n${renderEscapes(RULE_I.escapes)}`,
  mutations: [
    // 分支①:动作判据松成「只要本地一半」⇒ 只读了 tool-register 没联网的正例会被放过
    { name: "AND 松成只要本地一半(不联网也放)", apply: (r) => ({ ...r, detect: (ctx) => {
      const carriers = touched({ ...ctx, isNew: (p) => !r._i.isMemoryNote(p) && ctx.isNew(p) }, CARRIER_RE, true);
      if (!carriers.length) return [];
      return (ctx.readAny(r._i.LOCAL) || ctx.ranBash(r._i.LOCAL)) ? [] : carriers.slice(0, 4);
    } }) },
    // 分支②:去掉 isNew ⇒ 改既有载体也会被拦(这正是 2026-08-19 连拦三次的那个 bug)
    { name: "去掉「新建」限定(改既有也算造)", apply: (r) => ({ ...r,
      detect: (ctx) => r._i.detect(ctx, { onlyNew: false }) }) },
    // 批 253 修法①的回退:memory 笔记重新算载体 ⇒ 「写 memory」三条反例必须变红
    { name: "批253①回退:memory 笔记重新算新建载体", apply: (r) => ({ ...r,
      detect: (ctx) => r._i.detect(ctx, { memoryExempt: false }) }) },
    // 批 253 修法②回退:重新要求正文写「工具面已扫」⇒ 「真扫了没写字」反例必须变红
    { name: "批253②回退:重新要求正文写『工具面已扫』", apply: (r) => ({ ...r,
      detect: (ctx) => r._i.detect(ctx, { requireSaid: true }) }) },
  ],
  cases: {
    pos: [
      { text: "新建了一个 agent。", write: "/repo/.claude/agents/_foo.md" },
      // 只说不做:写了「工具面已扫」但没有任何读取/联网动作 ⇒ 仍应命中(文字从来不是证据)
      { text: "工具面已扫:无命中。", write: "/repo/.claude/agents/_bar.md" },
      // 只扫本地没联网 ⇒ 仍命中(AND 不松)
      { name: "只扫本地一半 ⇒ 仍命中", text: "看过在册件。", write: "/repo/scripts/new-tool.mjs",
        tracked: ["scripts/x.mjs"], read: "/repo/docs/tool-register.md" },
      // 批 253 修法①的边界:memory 目录里的**脚本**不是笔记 ⇒ 仍按载体管
      { name: "批253① 边界:memory 目录里新写 .mjs 仍算新建", text: "放了个脚本。", tracked: ["scripts/x.mjs"],
        write: "C:/Users/u/.claude/projects/example-project/memory/helper.mjs" },
    ],
    neg: [
      // 说了且做了
      { text: "工具面已扫:四层无命中。", write: "/repo/.claude/agents/_baz.md",
        read: "/repo/docs/tool-register.md", web: "existing agent-builder impl" },
      // 批 253 修法②:真扫了(Grep 本地 + WebSearch)但正文没写那七个字 ⇒ 放行
      { name: "批253②:真扫了四层、正文没写『工具面已扫』⇒ 放行",
        text: "按问题键查过在册件与同类实现,没有现成的,自己写。", write: "/repo/scripts/debt-facts.mjs",
        tracked: ["scripts/x.mjs"], grep: "/repo/docs/tool-register.md", web: "debt ledger facts parser" },
      // 改的是**既有**载体(tracked 注入),不是造物
      { text: "改了一行既有脚本的注释。", write: "/repo/scripts/hook-stop-closure.mjs",
        tracked: ["scripts/hook-stop-closure.mjs"] },
      { text: "今天只写了报告,没碰载体。" },
      // ── D100 回归钉(2026-09-06)────────────
      //   ① 经 Bash 往**外发暂存树**拷副本:`clipboard/` 是 NON_CARRIER_AREA。
      { name: "D100①:Bash 往暂存树拷副本不算造物",
        text: "同步了一份副本到外发暂存树。", tracked: ["scripts/lib/ledger-anchor.mjs"],
        bash: "cp scripts/lib/ledger-anchor.mjs clipboard/oss/public-repo/scripts/lib/ledger-anchor.mjs" },
      //   ② 经 Bash **追加既有**(非 memory)载体,写前实测记录证明它本来就在 ⇒ 不算新建。
      //      批 253 前本钉用 memory 文件;memory 已整面豁免后改用脚本,继续钉住 preExisted 这条证据链。
      { name: "D100②:Bash 追加既有未入仓脚本(有写前记录)不算新建",
        text: "给脚本追加了一行。", tracked: ["scripts/x.mjs"],
        preExisted: ["scripts/local-helper.mjs"],
        bash: "cat >> scripts/local-helper.mjs <<'EOF'\n// 新行\nEOF" },
      // ── 批 253 修法①:memory 笔记三种实况形态(台账 10 笔)────────────
      { name: "批253①:Write 新建 memory 笔记不算工具载体",
        text: "记了一条反馈记忆。", tracked: ["scripts/x.mjs"],
        write: "C:/Users/u/.claude/projects/example-project/memory/feedback-x.md" },
      { name: "批253①:Edit MEMORY.md 索引行(无写前记录)不算新建载体",
        text: "改了一行索引。", tracked: ["scripts/x.mjs"],
        write: ".claude/projects/example-project/memory/MEMORY.md" },
      { name: "批253①:Bash >> 追加 memory(无写前记录,~ 路径)不算新建载体",
        text: "给 memory 追加了两行用户原话。", tracked: ["scripts/x.mjs"],
        bash: "cat >> ~/.claude/projects/example-project/memory/act-within-granted-authority.md <<'EOF'\n- 原话\nEOF" },
    ],
  },
};
// D100 的反向钉:与反例②**同一条** Bash 追加命令、只是**没有**写前实测记录 ⇒ 仍按新建拦
//   (无记录退回旧判据是误报侧,这条钉住「接线没把口子开大」;批 253 起改钉非 memory 载体)。
RULE_I.cases.pos.push({
  name: "D100 反向钉:Bash >> 追加脚本且无写前记录 ⇒ 仍算新建(字形 >> 证明不了既有)",
  text: "给脚本追加了一行。", tracked: ["scripts/x.mjs"],
  bash: "cat >> scripts/local-helper.mjs <<'EOF'\n// 新行\nEOF",
}, {
  // grill 复核(2026-09-06,High):`bashWrites` 的 execForm 支是路径类的**第三处**,首版漏改 ⇒
  //   解释器在执行位 + 重定向到 `~`/盘符路径 对 I 隐形。批 253 起改钉 `~` 下的 commands(非 memory)。
  name: "D100 反向钉:node 脚本重定向到 ~ 路径的新 command 仍算新建",
  text: "生成了一个命令。", tracked: ["scripts/gen.mjs"],
  bash: "node scripts/gen.mjs > ~/.claude/commands/new-cmd.md",
});
RULE_I.cases.neg.push({
  // grill 复核 Q2:在外发暂存树里**直接新写**一个闸脚本,I 不管——D86/NON_CARRIER_AREA 的
  //   既定天花板(by design),钉在这里是为了让它成为**有记录的**取舍而不是无人知晓的口子。
  name: "by design:暂存树内直接新写不在 I 的辖区(D86 天花板,有记录的取舍)",
  text: "在暂存树里起草了一个新脚本。", tracked: ["scripts/x.mjs"],
  bash: "cat > clipboard/oss/public-repo/scripts/lib/brand-new.mjs <<'EOF'\nexport {};\nEOF",
}, {
  // 红队 a811daae BP-5(误拦,与 BP-4 同根):预筛 `bashWrites` 判有写、b7ef430 的 `bashWriteTargets` 把 `then` 当命令名给 [] ⇒
  //   兜底「bash-write(未解出目标)」判新建。BP-4 修好后取到既有的 foo.md ⇒ 不算新建。(兜底本身保持 fail-closed,见 touched 注。)
  name: "a811daae BP-5:if…then cp 覆盖既有 agent 不算新建",
  text: "从暂存区覆盖了既有 agent。", tracked: [".claude/agents/foo.md"],
  bash: "if [ -f clipboard/a.md ]; then cp clipboard/a.md .claude/agents/foo.md; fi",
});
// ⚠️ BP-3(`cp … .claude/agents/new.md 2>/dev/null`)在 I 面**写不成正例**:预筛 `bashWrites` 的 cp 支同样取「最后一个词」
//   = `2>/dev/null` ⇒ 判无写 ⇒ 根本不调 `bashWriteTargets`。预筛归 D148(与五份旧 heredoc 剥法统一),本批只修
//   `bashWriteTargets` 侧(P/K0/ND/L 直接消费它,已修);零件用例钉在 hook-stop-closure 自测「BP-3:」各条。
RULE_I.cases.pos.push({
  // BP-4 漏放形:包装器带值选项后的 cp 造新件
  name: "a811daae BP-4:sudo -u bob cp 新 agent ⇒ 仍算新建",
  text: "拷了个新 agent。", tracked: ["scripts/x.mjs"],
  bash: "sudo -u bob cp clipboard/a.md .claude/agents/new.md",
});

/** J:立/改法未交代触发层。 */
export const RULE_J = {
  id: "J",
  blocking: true,
  law: "AGENTS.md#承重规则的载体门槛",
  // ⚠️ 声明写进**法条正文**同样算数(ctx.written),不只认对话——
  //   对话是易失的,法条才是权威载体。旧实现只扫 assistant 文本,于是
  //   「写进文件了但没在对话里复述」被判违规(2026-08-19 实撞)。
  detect: (ctx) => {
    const laws = touched(ctx, LAW_RE, false);
    if (!laws.length) return [];
    if (matchAny(ctx.text, PAT.triggerLayer).length) return [];
    if (matchAny(ctx.written, PAT.triggerLayer).length) return [];
    return laws.slice(0, 4);
  },
  exempts: [],
  message: (hits) =>
    // D17 对照(2026-08-23):原示范句「挂在 X 事件的 hook」带空格时穿不过收窄后的
    // `挂在\S{0,10}事件` 判据 ⇒ 照消息写仍被拦。示范句改成必然匹配的三种字面形,不动判据。
    `立/改法未交代**触发层**(本轮触及:${hits.join(", ")})。\n` +
    `      每条新规则须答一句:什么时候它必然进入上下文或被执行?\n` +
    `      三种合法答案都便宜(照字面写,判据认这三形):「每会话加载(宪法/法典层)」/\n` +
    `      「触发层=挂在 Stop 事件的 hook」/「靠人记得——已知风险,登记在案」。**不许跳过不答**。\n` +
    `      **落位**=动笔前先过 \`_rule-placement-judge\`(只读判官:该落哪层/拆几段/哪档审批级);\n` +
    `      不告诉它你打算放哪——判官的价值全在不知道调用方结论。(2026-08-23 补格,agent 08-19 已建未挂):\n` +
    `      纪律 32(2026-08-17 立)三天内复发三次,根因不是条文不对,是它只是纪律没有闸;\n` +
    `      而「把纪律升级成闸」这件事本身也是纪律,所以每次都得靠人推。本项就是那一层。`,
  mutations: [
    // 分支①:只认对话不认写入 ⇒ 「写进法条正文」的反例会被误报(旧实现的那个 bug)
    { name: "只扫对话不扫写入正文", apply: (r) => ({ ...r, detect: (ctx) => {
      const laws = touched(ctx, LAW_RE, false);
      if (!laws.length) return [];
      return matchAny(ctx.text, PAT.triggerLayer).length ? [] : laws.slice(0, 4);
    } }) },
    // 分支②:去掉法典路径限定 ⇒ 任何写动作都会被当成立法
    { name: "去掉法典路径限定", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!ctx.writes.length) return [];
      if (matchAny(ctx.text, PAT.triggerLayer).length) return [];
      if (matchAny(ctx.written, PAT.triggerLayer).length) return [];
      return ["任意写"];
    } }) },
  ],
  cases: {
    pos: [{ text: "给协作法加了一条新规则。", write: "/repo/docs/laws/collab.md" }],
    neg: [
      // 对话里交代了触发层
      { text: "加了一条新规则,触发层:挂在 Stop 事件的 hook,每回合必跑。",
        write: "/repo/docs/laws/collab.md" },
      // 只写进了法条正文,对话里没复述 —— 旧实现在这里误报
      { text: "改完了。", write: "/repo/docs/laws/collab.md",
        written: "本条触发层:每会话加载(法典层),`/nlpm:check` 关账必跑。" },
      { text: "只改了一个脚本,没碰法典。", write: "/repo/scripts/foo.mjs" },
    ],
  },
};

// ── M:经 Bash/PowerShell 改文件却没回读验证 ────────────────────────────────
//
// 迁移时**逐条修掉** grill:edge-cases 2026-08-20 报的 8 条(M-1..M-8),不原样搬。
// 存在理由不变:`node -e` / `sed -i` / 重定向 在替换失败时**静默成功**——
// 脚本照常退出 0、照常打印你写的 echo,而文件一字未动(当日已因此吃两次亏)。

/** 剥掉 heredoc 正文(M-4)。`git commit -F - <<'EOF' … EOF` 的正文里若含
 *  `writeFileSync('docs/fake.md')`,旧 M 会把一个只存在于提交信息里的路径当成写目标。 */
const stripHeredoc = (c) => c.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?^\s*\1\s*$/gm, " ");

/** 从一条命令里提取**写目标**。只取写动作的目标参数,不是命令里出现的所有路径。 */
function writeTargets(rawCmd) {
  const cmd = stripHeredoc(String(rawCmd)).replace(/\\/g, "/");
  const out = [];
  const EXT = /\.(?:md|mjs|ts|tsx|js|json|txt|ya?ml)$/;
  for (const m of cmd.matchAll(/(?:write|append)FileSync\s*\(\s*['"`]([^'"`]+)/g)) out.push(m[1]);
  // ⚠️ `(?<![=\-])`:**箭头函数不是重定向**(2026-08-22 实撞,与 hook 侧 bashWriteTargets :507 同修):
  //   `node -e '….map(r=>r.ts)'` 的 `=>r.ts` 被当成 `> r.ts`,而 `.ts` 恰在扩展名单里。
  for (const m of cmd.matchAll(/(?<![=\-])>>?\s*['"]?([\w./-]+\.(?:md|mjs|ts|tsx|js|json|txt|ya?ml))/g)) out.push(m[1]);
  // M-5:`sed -i` 原式按位置数 token,`sed -i 's/a b/c/' docs/x.md` 捞到 `b/c/`,
  //   `sed -i -e 's/a/b/' docs/x.md` 直接漏。改成:取该段里**最后一个像路径的 token**。
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])sed\s+(-\w*i\w*[^\s]*\s[^;&|\n]*)/g)) {
    const toks = m[1].split(/\s+/).filter((t) => !t.startsWith("-") && !/^['"]/.test(t));
    const last = toks[toks.length - 1];
    if (last && EXT.test(last)) out.push(last.replace(/^["'`]|["'`]$/g, ""));
  }
  // M-3:`cp/mv/tee` 的参数段**必须排除换行**。原式 `[^;&|)]+` 会跨行捞到下一条命令的路径:
  //   `cp a.md b.md\nnode scripts/foo.mjs` ⇒ 真目标 b.md 丢了,还凭空指控一个只读脚本。
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])(?:tee|cp|mv)\s+([^;&|)\n]+)/g)) {
    const toks = m[1].trim().split(/\s+/)
      .filter((t) => !t.startsWith("-") && !/^\d?>/.test(t))
      .map((t) => t.replace(/^["'`]|["'`]$/g, ""));
    const dest = toks[toks.length - 1];
    if (dest && EXT.test(dest)) out.push(dest);
  }
  // M-8:PowerShell 写入习语。本机 primary shell 就是 PowerShell,而旧 M 的写动作模式
  //   **全是 Bash 习语** ⇒ `Set-Content` / `Out-File` / `Add-Content` 一个都不认。
  //   grill 判这是 M 在这台机器上最大的漏面。
  for (const m of cmd.matchAll(/(?:Set-Content|Add-Content|Out-File)\s+(?:-(?:Path|FilePath|LiteralPath)\s+)?['"]?([\w./-]+)/gi)) {
    if (EXT.test(m[1])) out.push(m[1]);
  }
  return out;
}

export const RULE_M = {
  id: "M",
  blocking: true,
  law: "docs/laws/reporting.md#「完成」靠核对不靠断言",
  detect: (ctx) => {
    const targets = [];
    for (const cmd of ctx.bashCmds) {
      // M-2:原实现见到 `--self-test` 就 `continue` **整条命令** ⇒
      //   「命令里带上 --self-test 就能关掉 M」。改成只剔除**看起来是用例字面量**的那些目标,
      //   命令的其余写入照常计入。夹具上下文的排除仍然需要:改自测用例时,
      //   用例文本里的路径是被替换的字符串字面量,不是真写入目标。
      const fixtureCtx = /want:\s*\[|lines:\s*\[|cases:\s*\{|name:\s*"[A-Z]\d?\s/.test(cmd);
      for (const t of writeTargets(cmd)) {
        if (fixtureCtx && /^(scripts|docs)\/(foo|bar|x|a|b)\./.test(t)) continue;   // 明显的示例名
        targets.push(t);
      }
    }
    const uniq = [...new Set(targets)].filter((p) => !/\/(tmp|temp)\//i.test(p) && !/^\.claude\/\./.test(p));
    if (!uniq.length) return [];

    // 回读证据面。M-6:**必须认 Grep 工具**——它的入参是 `{pattern, path}`,
    //   既没有 `file_path` 也没有字面 `grep`,而系统提示明写「Content search: Use Grep」。
    //   按规矩用工具的人被这条闸罚,是最坏的一类误拦。同理认 `rg`。
    // M-7:优先比**全路径**,basename 只作兜底——`a/config.json` 写、`b/config.json` 读
    //   在原实现里会被判成已回读。
    const readPaths = [
      ...ctx.reads,
      ...ctx.actions.filter((a) => /^(Grep|Glob)$/.test(a.name))
        .map((a) => String(a.input.path || a.input.file_path || "")),
    ].filter(Boolean).map((p) => p.replace(/\\/g, "/"));
    // ⚠️ **一条命令不能当自己的回读凭证**(2026-08-20 全语料并行 diff 逮到,我自己引入的)。
    //   `cat >> report.md <<'EOF' … EOF` 里含 `cat`,于是它落进回读证据面、把自己豁免掉——
    //   旧实现命中而新实现放行,30 条未指名分歧里的「旧有新无」那一半全是这个。
    //   判据:某条命令若其写目标里含 p,它对 p 就不算回读(对别的路径仍可算)。
    //   同族第 N 次:判据落在「命令串里出现了什么词」,而不是「那条命令做了什么」。
    //   ⚠️ 判定单位是**段**不是整条命令。第一版按整条排除,结果
    //   `node -e "...writeFileSync..." && grep -c x docs/real.md` 这种
    //   「同一条命令里先写后回读」被误拦——那个 `grep` 是**另一个段**。
    //   切段这件事今天已经是第四次(L 的 ls、ranProbe 的 node、writeTargets 的 cp/mv):
    //   **凡是「A 和 B 是否属于同一条命令」的判断,都必须先切段**。
    const SEG = /&&|\|\||[;|]|\n/;
    const readCmdsFor = (p) => ctx.bashCmds
      .flatMap((c) => stripHeredoc(c).split(SEG))
      .map((s) => s.trim().replace(/\\/g, "/"))
      .filter((s) => /\b(grep|rg|cat|head|tail|sed\s+-n|git\s+diff|Get-Content|Select-String)\b/i.test(s))
      // 该段自己就是写这个文件的段 ⇒ 它不是回读(`cat >> x.md` 含 cat 却是写)
      .filter((s) => !writeTargets(s).some((t) => t === p || t.endsWith("/" + p.split("/").pop())));

    return uniq.filter((p) => {
      const full = p.replace(/^\.\//, "");
      const base = full.split("/").pop();
      const hitPath = readPaths.some((r) => r.endsWith(full) || r.endsWith("/" + base) || r === full);
      const hitCmd = readCmdsFor(p).some((c) => c.includes(full) || c.includes(base));
      return !(hitPath || hitCmd);
    });
  },
  // ⚠️ M-1:**纯文本豁免已删除**。原实现 `declared = /回读(验证|确认)|已回读/.test(text)`
  //   挂在一条**阻断**规则上 ⇒ 写一句「回读验证:OK」即通过,零回读动作。
  //   这正是本仓已登记的那族(当日在 C/G/H/I/J 上一次查出五处)。
  //   INV-1 也不允许阻断规则带 text 类豁免。要放行只有一条路:**真回读**。
  exempts: [],
  // 出路即数据(批 117)。本条只有一条出路且是**动作面**,sample 就是那个动作本身。
  escapes: [
    // forPos:样例读的是 pos[0]/[1] 写的 `docs/real.md`;pos[2..4] 写的是别的路径,
    //   出路本身要求「指向**同一**路径」,故样例天然只对写同一文件的正例成立。
    //   这是探针的适用面,不是闸的毛病——写出来,别悄悄只测第一条。
    { say: "**真回读**:Read / Grep / grep / cat / git diff 指向同一路径",
      forPos: [0, 1], sample: { read: "docs/real.md" } },
  ],
  message: (hits) =>
    `经 Bash 改文件但未回读验证:${hits.join(", ")}\n` +
    `      **node -e / sed -i / 重定向 替换失败时静默成功**——脚本照常退出 0、照常打印你写的 echo,而文件一字未动。\n` +
    `      出路:\n${renderEscapes(RULE_M.escapes)}\n` +
    `      写一句「回读验证:OK」不再放行——那是纯文本豁免,2026-08-20 已撤。`,
  mutations: [
    { name: "退回纯文本豁免(说一句就放行)", apply: (r) => ({ ...r,
      detect: (ctx) => (ctx.says(/回读(验证|确认)|已回读/) ? [] : r.detect(ctx)) }) },
    { name: "不认 Grep 工具回读(M-6 回归)", apply: (r) => ({ ...r, detect: (ctx) => {
      const targets = ctx.bashCmds.flatMap(writeTargets);
      const uniq = [...new Set(targets)].filter((p) => !/\/(tmp|temp)\//i.test(p));
      const readCmds = ctx.bashCmds.filter((c) => /\b(grep|cat|head|git\s+diff)\b/.test(c));
      return uniq.filter((p) => !ctx.reads.some((x) => x.endsWith(p.split("/").pop())) &&
        !readCmds.some((c) => c.includes(p.split("/").pop())));
    } }) },
    { name: "只比 basename(M-7 回归)", apply: (r) => ({ ...r, detect: (ctx) => {
      const uniq = [...new Set(ctx.bashCmds.flatMap(writeTargets))].filter((p) => !/\/(tmp|temp)\//i.test(p));
      const all = [...ctx.reads, ...ctx.bashCmds].join(" ").replace(/\\/g, "/");
      return uniq.filter((p) => !all.includes(p.split("/").pop()));
    } }) },
  ],
  cases: {
    pos: [
      { text: "改完了。", bash: `node -e "fs.writeFileSync('docs/real.md','x')"` },
      // M-1 的回归守卫:只说不做 ⇒ 仍须命中
      { text: "回读验证:OK。", bash: `node -e "fs.writeFileSync('docs/real.md','x')"` },
      // M-8:PowerShell 写入必须进写目标面
      { text: "写了一份。", bash: `Set-Content -Path docs/ps-written.md -Value x` },
      // 全语料并行 diff 逮到的自引缺陷:`cat >>` 里含 `cat`,曾把自己当成回读凭证
      { text: "追加了一段。", bash: "cat >> docs/report.md <<EOF\nx\nEOF" },
      // 旧 M 的写动作预筛清单里**没有 cp/mv** ⇒ 纯 cp 完全失明。新实现必须命中
      { text: "复制了一份。", bash: "cp a/src.md docs/dest.md" },
    ],
    neg: [
      // 真回读(Bash 面)
      { text: "改完并回读。", bash: `node -e "fs.writeFileSync('docs/real.md','x')" && grep -c x docs/real.md` },
      // **箭头函数不是重定向**(2026-08-22 实撞,--fp 第 3 笔的回归证人):
      //   `=>r.ts` 曾被 bashWriteTargets 当成 `> r.ts` ⇒ M 要求回读不存在的文件。
      //   本条是纯读命令,零写入目标 ⇒ M 不响。谁把 :507 的 lookbehind 撤了,这条就红。
      { text: "查了台账。", bash: `node -e 'rows.filter(r=>(r.ids||[]).includes("K0")).map(r=>r.ts)'` },
      // M-6:用 **Grep 工具**回读 —— 按项目工具纪律办事的人不该被罚。
      //   ⚠️ 这里必须是 `grep:`(Grep 工具)不能是 `read:`(Read 工具):
      //   变异体照样看 `ctx.reads`,用 Read 写这条反例会让「不认 Grep」变成等价变异、逮不住。
      { text: "改完并用 Grep 回读。", bash: `node -e "fs.writeFileSync('docs/real.md','x')"`,
        grep: "/repo/docs/real.md" },
      // 用 Read 工具回读同样算数(对照,防「只认 Grep」)
      { text: "改完并用 Read 回读。", bash: `node -e "fs.writeFileSync('docs/real.md','x')"`,
        read: "/repo/docs/real.md" },
      // 另起**一条独立命令**真回读 ⇒ 放行。与上面那条正例配对:
      //   同一条 `cat >>` 不算,另一条 `grep` 才算。这一对才证明「自引豁免」被堵住了。
      { text: "追加后回读。", bash: ["cat >> docs/report.md <<EOF\nx\nEOF", "grep -c x docs/report.md"] },
      { text: "复制后回读。", bash: ["cp a/src.md docs/dest.md", "cat docs/dest.md"] },
      { text: "本轮没有经 Bash 写文件。" },
    ],
  },
};

// ── X:「文件已落盘」的断言必须绑一次以该路径为入参的直接探针(D98-①,2026-09-04)──────
//
// 实撞:一条后台命令先打印 v7 的 `ffmpeg exit 0 / yuv420p / 218.83`,再开始渲染 v7b;
// 我 `grep -E "exit|pix_fmt|duration"` 日志取到的是 v7 的行,据此宣布 v7b 已出并结清批,
// 实际 v7b 还在写(用户打开报「被占用」)。M 管「写后回读」,这条管「说它在,就得探它本身」。
//
// 判据(grill:edge-cases 首审 20 条后重写,2026-09-04 当日):
//   · 断言 = 正文里媒体/二进制文件名(mp4/mp3/wav/png/zip/pth…)前后 40 字内有「已落盘/出来了/渲染完成…」;
//     否定句(还没/未/尚未/没 + 落盘)、代码围栏、「」引文、`--fp X` 记账行里的文件名、占位符(单字母/foo/bar)不算断言。
//     文本类扩展名(md/json/txt)**不归 X 管**——那是 M 的写后回读面,放进来只会制造 --fp 洪水。
//   · 探针 = 某个**命令段**(按 shell 分隔符切、剥引号与 heredoc 后)以探针动词**开头**,且该段原文里
//     以**整词**形式含该路径(全路径优先,basename 兜底);媒体文件只认**读内容**的动词
//     (ffprobe / ffmpeg -i <它> / md5|sha / mediainfo / soxi / file / Get-FileHash),`ls`/`stat`/`Test-Path`
//     对半写的 mp4 照样成功,不算。图片另认 Read 工具(路径以该文件结尾;Grep 的 pattern 不是路径)。
//   · 次序:探针段必须在该文件**最后一次产出段**之后——先 ls 再 ffmpeg 不算探过。
//   天花板:只证「探针被发出」,不证探针结果(那是 batch-goal --check 的事);文件名含空格/中文认不出;
//   `&` 不切段。
import { stripQuoted as xStripQuoted, segments as xSegments } from "./gate-cmd.mjs";
// 完成词表(codex r1 #10 补了 13 个漏报说法;`已出` 后面排除「发/口/路/现/门」这些常见连字,JS 的 \b 对中文不起作用)
const X_DONE = /(?<!还没|尚未|没有|未|没|不|并未)(已落盘|落盘了|落盘|已出(?![发口路现门])|已经产出|产出完成|产出了|出来了|渲染完成|渲染完了|渲染成功|已生成|生成了|生成完毕|已写完|写完了|写好了|已导出|导出了|导出完成|做好了|已完成|完成了|已保存|保存了|已输出|输出了|就绪|交付完成)/;
const X_EXT = "mp4|mkv|webm|mov|mp3|wav|flac|ogg|m4a|png|jpe?g|gif|webp|zip|7z|tar\\.gz|pdf|docx|xlsx|pth|exe";
const X_FILE = new RegExp(`((?:[\\p{L}\\p{N}_.\\-]+[\\\\/])*[\\p{L}\\p{N}_.\\-]+\\.(?:${X_EXT}))(?![\\p{L}\\p{N}.])`, "giu");
const X_IMG = /\.(?:png|jpe?g|gif|webp)$/i;
const X_PROBE_MEDIA = /^(?:\S+=\S+\s+)*(?:sudo\s+)?(ffprobe|md5sum|sha256sum|sha1sum|md5|Get-FileHash|mediainfo|soxi|file)\b/i;
const X_WRITER = /^(?:\S+=\S+\s+)*(?:sudo\s+)?(ffmpeg|cp|mv|rsync|curl|wget|python(?:3|\.exe)?|node|bash|sh|cat|tee|touch|make|dd|zip|tar|7z|magick|convert|sox)\b/i;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 路径身份:全路径或 basename 作为整词出现;前面允许 `/`(绝对路径探针 `/abs/…/pv/out.mp4` 也算探到 `pv/out.mp4`),但 `notout.mp4` 不算 `out.mp4`
const xHasToken = (seg, p) => new RegExp(`(?:^|[\\s=:"'(/])${reEsc(p)}(?=$|[\\s"')])`).test(seg.replace(/\\/g, "/"));
/** 正文里的断言文件:返回 [{full, base}];已剥围栏/引文/--fp 行。 */
function xClaims(text, fpBases) {
  const t = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/「[^」]*」/g, " ")
    .replace(/(如果|若|假如|要是)[^,，。;\n]*/g, " ")            // 条件句不是断言(r2)
    .replace(/(原话|他说|她说|你说|对方说|朋友说)[:：]?[^。\n]*/g, " ");   // 无「」的引语
  const out = new Map();
  for (const m of t.matchAll(X_FILE)) {
    const full = m[0].replace(/\\/g, "/"); const base = full.split("/").pop();
    if (/^(?:[A-Za-z]|foo|bar|baz|xxx|example|placeholder)\.[a-z0-9]+$/i.test(base)) continue;   // 占位符
    if (fpBases.has(base)) continue;                                                            // --fp 记账行里的名字
    const around = t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    if (X_DONE.test(around)) out.set(base, full);
  }
  return [...out].map(([base, full]) => ({ base, full }));
}
/** 命令段流:按 ctx.bashCmds 顺序,每段 {raw, masked};heredoc 正文先剥掉。 */
function xSegs(ctx) {
  const out = [];
  for (const c of ctx.bashCmds) for (const s of xSegments(stripHeredoc(c))) out.push({ raw: s.replace(/\\/g, "/"), masked: xStripQuoted(s).trim() });
  return out;
}
function xProbed(ctx, segs, { base, full }) {
  const hit = (s) => xHasToken(s.raw, full) || xHasToken(s.raw, base);
  const isProbe = (s) => X_PROBE_MEDIA.test(s.masked) ||
    (/^(?:\S+=\S+\s+)*ffmpeg\b/i.test(s.masked) && new RegExp(`-i\\s+["']?[^\\s"']*${reEsc(base)}`).test(s.raw));
  const isWriter = (s) => !isProbe(s) && X_WRITER.test(s.masked);
  let lastWrite = -1, lastProbe = -1;
  segs.forEach((s, i) => { if (!hit(s)) return; if (isProbe(s)) lastProbe = i; else if (isWriter(s)) lastWrite = i; });
  if (lastProbe > lastWrite) return true;
  if (X_IMG.test(base)) {   // 图片:Read 工具直接看图也算(路径须以断言的**全路径**结尾;只给了 basename 的断言才退到 basename;Grep 的 pattern 不是路径)
    const p = (a) => String(a.input.file_path || a.input.path || "").replace(/\\/g, "/");
    const ok = (q) => q.endsWith("/" + full) || q === full || (!full.includes("/") && q.endsWith("/" + base));
    if (ctx.actions.some((a) => /^(Read|Grep)$/.test(a.name) && ok(p(a)))) return true;
  }
  return false;
}
export const RULE_X = {
  id: "X",
  blocking: true,
  law: "docs/laws/reporting.md#「完成」靠核对不靠断言",
  detect: (ctx) => {
    const fpBases = new Set();
    for (const c of ctx.bashCmds) if (/--fp\s+X\b/.test(c)) for (const m of String(c).matchAll(X_FILE)) fpBases.add(m[0].replace(/\\/g, "/").split("/").pop());
    const claims = xClaims(ctx.text, fpBases);
    if (!claims.length) return [];
    const segs = xSegs(ctx);
    return claims.filter((c) => !xProbed(ctx, segs, c)).map((c) => c.base);
  },
  exempts: [],
  escapes: [
    // forPos:样例探的是 pos[0..6] 那个 mp4;pos[7] 是图片(另一路径),出路本身要求「指向同一文件」,样例天然不覆盖它
    { say: "**直接探针**:ffprobe / ffmpeg -i / md5 / mediainfo / file 以该文件路径为入参,且在最后一次产出之后(ls·stat·grep 日志·产出它的那条 ffmpeg 都不算)",
      forPos: [0, 1, 2, 3, 4, 5, 6], sample: { bash: "ffprobe -v error -show_entries format=duration -of csv=p=0 pv/draft_pv_v7b.mp4" } },
  ],
  message: (hits) =>
    `「已落盘」断言未绑直接探针:${hits.join(", ")}\n` +
    `      断言对象是这个文件,本轮却没有一条读它内容的探针——2026-09-04 实撞:拿别的文件的核对行当证据,宣布还在写的 mp4 已出。\n` +
    `      出路:\n${renderEscapes(RULE_X.escapes)}`,
  mutations: [
    { name: "任何提及即证据(不看探针动词)", apply: (r) => ({ ...r, detect: (ctx) => {
      const claims = xClaims(ctx.text, new Set()); const all = ctx.bashCmds.join("\n").replace(/\\/g, "/");
      return claims.filter((c) => !all.includes(c.base)).map((c) => c.base);
    } }) },
    { name: "纯文本豁免(说「已核对」就放行)", apply: (r) => ({ ...r, detect: (ctx) => (ctx.says(/已核对|核过了/) ? [] : r.detect(ctx)) }) },
    { name: "产出它的 ffmpeg 也算探针(写目标当凭证)", apply: (r) => ({ ...r, detect: (ctx) => {
      const claims = xClaims(ctx.text, new Set()); const segs = xSegs(ctx);
      return claims.filter((c) => !segs.some((s) => xHasToken(s.raw, c.base) && (X_PROBE_MEDIA.test(s.masked) || /\bffmpeg\b/i.test(s.masked)))).map((c) => c.base);
    } }) },
    { name: "探针动词在段内任意位置即算(flag 名、引号里都算)", apply: (r) => ({ ...r, detect: (ctx) => {
      const claims = xClaims(ctx.text, new Set());
      const raw = ctx.bashCmds.flatMap((c) => String(c).split(/&&|\|\||[;|]|\n/)).map((s) => s.replace(/\\/g, "/"));
      return claims.filter((c) => !raw.some((s) => s.includes(c.base) && /\b(ffprobe|md5sum|sha256sum|md5|mediainfo|soxi|file)\b/i.test(s))).map((c) => c.base);
    } }) },
  ],
  cases: {
    pos: [
      // 实撞原型:证据是 grep 日志,不是探文件
      { text: "v7b 已落盘:`pv/draft_pv_v7b.mp4`,批 163 结清。", bash: 'grep -c "draft_pv_v7b" pv/build_pv7.log' },
      // 纯文本豁免必须无效
      { text: "`pv/draft_pv_v7b.mp4` 渲染完成,已核对。" },
      // 产出它的那条命令不能当凭证
      { text: "出来了:`pv/draft_pv_v7b.mp4`。", bash: "ffmpeg -y -loglevel error -i leadB.wav -i inst.wav -c:v libx264 pv/draft_pv_v7b.mp4" },
      // 探针动词只是 flag 名 / 在引号里 ⇒ 不是探针(grill r1 #1/#2)
      { text: "`pv/draft_pv_v7b.mp4` 已落盘。", bash: "python render.py --file pv/draft_pv_v7b.mp4" },
      { text: "`pv/draft_pv_v7b.mp4` 已落盘。", bash: "echo 'ffprobe pv/draft_pv_v7b.mp4'" },
      // ls 对半写的 mp4 照样成功 ⇒ 媒体文件不认 ls(grill r1 #6)
      { text: "`pv/draft_pv_v7b.mp4` 渲染完成。", bash: "ls -la pv/draft_pv_v7b.mp4" },
      // 先探后写 ⇒ 探的是旧文件
      { text: "`pv/draft_pv_v7b.mp4` 出来了。", bash: "ffprobe -v error pv/draft_pv_v7b.mp4 && ffmpeg -y -i a.wav pv/draft_pv_v7b.mp4" },
      { text: "`pv/draft_pv_v7b.mp4` 出来了。", bash: "ffprobe -v error pv/draft_pv_v7b.mp4 && touch pv/draft_pv_v7b.mp4" },
      // notout.mp4 不是 out.mp4
      { text: "`pv/out.mp4` 已生成。", bash: "ffprobe -v error pv/notout.mp4" },
      // 同名不同目录的图片 Read 不算(grill r1 #5)
      { text: "封面 `pv/final/cover.png` 已生成。", read: "/other/cover.png" },
    ],
    neg: [
      { text: "v7b 已落盘:`pv/draft_pv_v7b.mp4`。", bash: "ffprobe -v error -show_entries format=duration -of csv=p=0 pv/draft_pv_v7b.mp4" },
      { text: "`pv/draft_pv_v7b.mp4` 已生成。", bash: "md5sum pv/draft_pv_v7b.mp4" },
      { text: "封面 `pv/cover.png` 已生成。", read: "/repo/clipboard/proj/pv/cover.png" },
      // 产出 + 另起一段探针(在产出之后)⇒ 放行
      { text: "出来了:`pv/draft_pv_v7b.mp4`。", bash: "ffmpeg -y -i a.wav pv/draft_pv_v7b.mp4 && ffprobe -v error -show_entries format=duration -of csv=p=0 pv/draft_pv_v7b.mp4" },
      // 没有落盘断言 / 否定句 / 引文 / 记账行 / 占位符 ⇒ 不管
      { text: "渲染中,`pv/draft_pv_v7b.mp4` 还在写,先别打开。" },
      { text: "`pv/draft_pv_v7b.mp4` 还没落盘,别打开。" },
      { text: "你说「out.mp4 出来了」,我这边还没核。" },
      { text: "如果 pv/out.mp4 已落盘,再发布;现在还没。" },
      { text: "对方原话: pv/out.mp4 已落盘,但我尚未核实。" },
      // 绝对路径探针也算探到相对路径的断言(路径身份)
      { text: "`pv/draft_pv_v7b.mp4` 已生成。", bash: "ffprobe -v error /repo/clipboard/proj/pv/draft_pv_v7b.mp4" },
      { text: "记了误报:X。", bash: 'node --no-warnings scripts/hook-stop-closure.mjs --fp X "pv/draft_pv_v7b.mp4 已落盘 是引用"' },
      { text: "规则:正文里出现「X.mp4 已落盘/出来了」时,本轮必须有探针。" },
      // 文本文件不归 X 管(M 的面)
      { text: "`docs/noun-diary.md` 登记已完成。", write: "docs/noun-diary.md" },
      { text: "本轮没有产物断言。" },
    ],
  },
};

// ── E0 / E1 / E2:因果断言的两半复核 ────────────────────────────────────────
//
// 纪律 32② 明写「一个管**形**、一个管**独立性**,**不互斥**」——两半都要做,不是二选一。
// 旧实现把豁免写成「发了 codex 即通过」,等于给 xros 那一半留了永久逃逸口。
// 三条原子迁移(codex 2026-08-20 判「它们共享 eHits/hedged/shaped/crossChecked,
// 宜原子迁移」),因为拆开搬会让共享事实的口径漂移。
//
// ⚠️ 迁移时的**唯一实质改动**:`crossChecked` 与 `shaped` 从「扫含工具输出的裸文本」
//   改成**只看动作面**。旧实现用 `toolRawText(turn)`,于是**读到一个提及
//   `codex-run.mjs` 的文件**就算跑过跨模型复核(gate-ctx 头注里逐字记着这条实测)。
//   顺带补 `mcp__codex-cli__codex` ——codex 在本机有两条通路,旧式只认脚本那条
//   (与 P 项 2026-08-20 修的是同一个漏报)。

// ⚠️【已登记未修 · 召回缺口】`PAT.causal` 漏掉大量最自然的中文因果句。
//   2026-08-20 实测六条,**漏 4 条**:
//     **漏** 路径写错导致整闸失效。          ← `导致` 后 20 字内没有「这/该/它/我」
//     **漏** 这导致整闸失效。                ← 「这」在 `导致` **之前**
//     **漏** 改坏了因为路径写错。            ← `(是|系)因为` 要求前面是「是/系」
//     **漏** 正则跨段匹配使得目标取错。      ← 同第一条
//     认    根因是路径写错。
//     认    因为超时被杀,所以不阻断。
//   memory `causal-claim-threshold` 早记着 E0 在真实数据上**召回 3/20**,与此一致。
//
//   ⚠️ 这条登记有它自己的来历,值得写下来:我最初给 E0/E2 写的正例就是
//   「路径写错导致整闸失效」,用例不命中,我**把句子改成「根因是…」让它变绿**。
//   用户当场逮到:「牛魔的这个就是有逻辑问题啊——故意迎合闸门?」——**他是对的**。
//   那是拿测试去迁就实现,把召回缺口盖住了,正是我此前转述过的 poka-yoke 告诫
//   (「目标能以多种方式达成,常导致与本意相反的行为」)的实例。
//   现在的处置:用例仍用命中形态(否则测不到规则本身),但缺口**逐条写在这里**,
//   下一个动 PAT.causal 的人第一眼就看得见。修它要扩 `PAT.causal`,
//   而扩召回必然抬误报率,**须先在全语料上量误报再动**——那是独立一批的事。

/** 引文掩码:把 `「…」«…»“…”"…"` 的内容抹成空格。**等长、且保留换行**。
 *
 *  为什么等长保行(2026-08-27,D71):`matchAny` 按行判、回显整行。掩码若不等长不保行,
 *  剥过的文本与原文行号就对不上,回显只能拿剥过的那份 ⇒ 拦截消息里引文内的名词全没了
 *  (实况:「是因为 会让你在 和 之间反复权衡」)。**闸拦得住但说不清拦的是什么,等于没拦。**
 *
 *  与旧式(整段替换成单个空格)的差异:引文两侧的距离由 1 变成 N。`PAT.causal` 全是
 *  `.{0,20}` 这类**有界**间隔 ⇒ 距离变大只会让跨引文咬合**更不容易**,方向与
 *  2026-08-22 那次修法(取放行侧:引文=提及不是使用)一致,不是反向放松。
 *  ⚠️ 这是论证不是证明:真正的判据是全套夹具与变异验收在改前改后**逐条同绿**。
 *
 *  口径只此一份:`eFacts` 与 `RULE_E2` 原先各抄了一遍同样的字面量,是漂移预备役。 */
export function maskQuoted(s) {
  // 红队 182 BP-6 附:『』(内层引号,本仓正文里与「」混用)原不在集合 ⇒ 引闸拦词『别外审』不被剥。
  return String(s || "").replace(/「[^」]*」|『[^』]*』|«[^»]*»|“[^”]*”|"[^"]*"/g,
    (m) => m.replace(/[^\n]/g, " "));
}

/** 三条共用的事实。抽出来是刻意的:口径只写一处,拆开写必漂移。 */
function eFacts(ctx) {
  // ⚠️ **因果匹配跑在剥掉引文之后**(2026-08-22 实撞两连响修的):
  //   E2 的声明检查早就剥 `「…」«…»“…”"…"`,E0 的因果匹配却一直跑在原文上,
  //   于是 `PAT.causal` 的「让…它」跨过引号边界咬合(「让」在引文里、「它」在引文外),
  //   **引用一句被拦的话来处置它 ⇒ 处置本身再被拦** —— 回声族,与 S/E2 同修法。
  //   机械证据:probe 实测 #4 咬住『…让未来会话能召回」。拿它』这个跨界片段。
  //   方向说明:引文=提及不是使用;真因果断言写在引号里当强调的形态,按代价不对称
  //   (漏这一形态的代价是少拦一句,误拦回声的代价是处置循环)取放行侧。
  const eTxt = maskQuoted(ctx.text);
  // 判据跑在掩码文本上,**回显取原文同号行**——否则拦截消息会把引文里的名词全抹掉(D71)。
  const acted = JSON.stringify(ctx.actions);

  // ── 自标的**就近绑定**(D72 最小步,codex 114-fourEyes Q3 判「整体后移是过强结论」)──
  //  原来 `hedged` 是**整轮布尔**:一处自标豁免整轮所有因果命中。四眼给的反例——
  //  「根因是鉴权中间件被绕过。另一个问题是缓存默认值,文档未记载。」——后半句的自标
  //  只针对缓存那条,却把前半句的鉴权断言一并豁免。**本批扩了词表,正好把这个口子放大。**
  //  最小步的刻意边界:**只绑 `hedged`,不动 `crossChecked`/`shaped`/E2 声明**,
  //  也**不碰 `PAT.causal` 的适用面**(那是 D70,亲签面)——故不预判任何未决之争。
  //
  //  ⚠️ **四眼给的那个具体反例,本步修不掉,而且是原理性的**(实测后确认,非偷懒):
  //    它举的  「根因是鉴权中间件被绕过。另一个问题是缓存默认值,文档未记载。」
  //    与本批要修的实况原话
  //         「根因是硬闸拦下的,未跑的原因是…。在跑出来之前,这条只是我的猜测。」
  //    **结构上完全同形**——都是「若干因果断言 + 行尾一处自标」。
  //    差别纯在语义(自标指向前一句还是后一句),**没有任何位置规则能把两者分开**:
  //    取行级 ⇒ 漏放前者;取分句级 ⇒ 拦死后者(而后者正是本批立案的那条硬误报)。
  //    故取**放行侧**,理由=代价不对称:误拦且出路不通是本批一路在修的病,
  //    而漏放一句「自标指错了对象」的断言,E2 仍在正面拦它。
  //    ⇒ 这条残留**只能靠语义绑定(D72 主体)消除,不是粒度调参能解决的**。
  //    所以四眼 Q3 的诊断成立(整轮太粗),它的**药方在这一例上不成立**——
  //    诊断对 ≠ 药方对,分开判,这里是第二问输了。
  //  粒度=**行**。`matchAny` 本就按行判、按行回显,行在本仓的 markdown 输出里≈自然段,
  //  比「同分句」宽、比「整轮」窄。取宽侧的理由:E0 是阻断规则,粒度过细会造新误拦,
  //  而误拦的终局是有人去关逃生口。**天花板**:跨行自标(断言一行、自标下一行)判不出。
  //  失效条件:若 fp 台账出现「自标就在紧邻下一行却被拦」≥2 次,粒度改为「命中行 ± 1 行」。
  const HEDGE_RE = new RegExp([
    "UNVERIFIED",
    "(未|没)(经)?(核实|核过|验证|验过|证实)",
    "证据不足", "存疑", "待(验证|核实|证实)",
    "(我|尚|仍)不确定",
    "我猜", "(别|不要|勿)当(成)?结论",
    // 出处侧自标——用的是全局规范 §1.1/§1.3 自己的词(「取页失败」「文档未记载」),
    //   而词表里原来一个都没有。proj-a #13 实撞:「(搜索摘要,未逐字取页。」被 E0 拦。
    "(未|没)(有)?(逐字)?取页", "取页失败", "文档未记载",
    // 「这/该/以上…(只)是…推断/推测/猜测」——中间留空档以吃「这条只是我的猜测」,
    // 但不跨句读(`[^。;;\\n]`),免得跨句咬合成假豁免。
    "(这|该|此|以上|上面|以下|下面|本条|该条)[^。;;\\n]{0,8}(只|仅)?是[^。;;\\n]{0,6}(推断|推测|猜测|臆测|假设)",
    "标注?为(推断|推测|未核实)",
  ].join("|"));
  // **总括声明**仍认整轮(codex 建议保留的块级标记):「以下均为推断」这类是真自标,
  //   若逼人逐行重复反而制造噪声。它必须自成一句、且明写「均/都/全部」,不与就近绑定混淆。
  const HEDGE_BLOCK = /(以下|下面|本节|本段|本轮)[^\n。]{0,8}(均|都|全部|一律)[^\n。]{0,8}(是)?[^\n。]{0,6}(推断|推测|未核实|未验证|猜测)/;
  const eLines = eTxt.split("\n");
  const oLines = String(ctx.text || "").split("\n");

  // ── 叙事性因果整类排除(2026-08-27 用户亲签,法条 reporting.md 同批改口径)────
  //  实况分类:另一条会话 15 次 E0 拦截里,**只有 3 句是可证伪判断**;
  //  5 句在讲「我做没做 / 我错没错」——「未跑的原因是插件还不存在」
  //  「我上一轮说错了,原因是我盯着一个行项看」。这类没有可验证内容,
  //  三条出路(跨模型/探针/自标)对它全不适用,唯一走得通的是花一句话自标 ⇒ 纯噪声。
  //
  //  ⚠️ **切分线刻意不是「技术 vs 产品」**(用户裁决原话采纳):产品成本与路线取舍
  //  同样可证伪、同样承重。当日实证——被拦的那句「DeepSeek 便宜 2–4 倍」
  //  几轮后被作者自己推翻(「总账反过来,GLM 全部更便宜」)⇒ 按话题切会切错。
  //  切的是**被解释的东西是什么**:是「系统/世界的状态」还是「本方的动作与对错」。
  //
  //  判据刻意窄:只认「效果侧是本方的动作没发生 / 本方判断出错」这一形态。
  //  故意**不**排除「根因是我把路径写错了」——那是系统状态的成因,该管。
  //  天花板:措辞近似,判不出语义;两类边缘句都会分错。失效条件=fp 台账出现
  //  「真断言被当叙事放走」一次,即回收本项(方向:漏放比误拦贵)。
  const NARRATIVE = /(未|没|还没|尚未|来不及)[^\n。]{0,6}(跑|做|改|查|写|修|走到|来得及|落地)|(我|我们)[^\n。]{0,8}(说|判|想|搞|记|算)错|停在[^\n。]{0,8}那里/;

  const hitIdx = [];
  for (const re of PAT.causal) {
    for (let i = 0; i < eLines.length; i++) {
      if (!re.test(eLines[i])) continue;
      if (NARRATIVE.test(eLines[i])) continue;   // 叙事行整行不进因果面
      hitIdx.push(i);
    }
  }
  // 判据跑在掩码文本上,**回显取原文同号行**(D71)。叙事行已在上面被整行排除,
  // 故 `hits` 与 `unhedgedHits` 同源——E1/E2 吃全量 `hits`,但那个「全量」
  // 也不含叙事行:法条改的是**本条的适用面**,三条规则一起收(2026-08-27 亲签)。
  const hits = [...new Set(
    [...new Set(hitIdx)].map((i) => (oLines[i] ?? eLines[i]).trim().slice(0, 120)))];
  const blockHedged = HEDGE_BLOCK.test(eTxt);
  const unhedgedIdx = blockHedged ? []
    : [...new Set(hitIdx)].filter((i) => !HEDGE_RE.test(eLines[i]));
  const unhedgedHits = [...new Set(
    unhedgedIdx.map((i) => (oLines[i] ?? eLines[i]).trim().slice(0, 120)))];

  return {
    hits,
    /** E0 专用:**去掉已就近自标的那些**之后还剩的命中。E1/E2 仍吃全量 `hits`
     *  ——E2 的立法原话就是「自标不豁免形」,把它改成吃 `unhedgedHits` 会当场塌掉。 */
    unhedgedHits,
    // 自标:只豁免「独立性」,**不豁免「形」**——「我不确定」与「有没有办法确定」是两件事。
    //
    // ⚠️ 2026-08-27 实撞(D69):旧式几乎**只认闸自己模板里那句「这是推断」一字不差**。
    //   另一条会话原话「在跑出来之前,这条**只是我的猜测**,别当结论。」——标得比模板还清楚,
    //   E0 照拦,并在拦词里继续教人「用出路③就地自标」。**出路的判据比出路的说明窄**,
    //   等于给了一扇画在墙上的门。当日 7 条自然自标实测 6 条不认。
    //   这里的匹配是措辞匹配,且**理应**是措辞匹配——被判的行为本身就是「说一句话给自己贴标」,
    //   与 D67 那种「拿措辞白名单顶替行为判据」不同型;缺陷在覆盖面,不在手段。
    // 方向:本项是**出路**不是闸口。太窄 ⇒ 误拦且无处可逃;太宽 ⇒ 只是躲过 E0,
    //   仍要正面撞 E2(自标不豁免「形」,见 RULE_E2)。故按覆盖面从宽。
    // 失效条件:若 fp 台账出现「靠一句『我猜』批量躲 E0 而 E2 也没拦住」的形态,回收本次放宽。
    // ⚠️ 跑在 **eTxt(已剥引文)** 而非原文上(D72,codex 114 Q3,已机器复现):
    //   原来 `hits` 剥引文、`hedged` 不剥,两边口径不一致 ⇒
    //   「对方原话:『我猜缓存可能过期』。根因是鉴权中间件把匿名用户映射成管理员。」
    //   ——引文里**别人**那句「我猜」把引文外**我自己**那条鉴权断言整轮豁免掉。
    //   自标是「给自己的话贴标」,引用别人的犹疑不是自标;与 E0/E2 早已确立的
    //   「引文=提及不是使用」同一条口径。
    hedged: new RegExp([
      "UNVERIFIED",
      "(未|没)(经)?(核实|核过|验证|验过|证实)",
      "证据不足", "存疑", "待(验证|核实|证实)",
      "(我|尚|仍)不确定",
      "我猜", "(别|不要|勿)当(成)?结论",
      // 出处侧自标——用的是全局规范 §1.1/§1.3 自己的词(「取页失败」「文档未记载」),
      //   而词表里原来一个都没有。proj-a #13 实撞:「(搜索摘要,未逐字取页。」被 E0 拦。
      "(未|没)(有)?(逐字)?取页", "取页失败", "文档未记载",
      // 「这/该/以上…(只)是…推断/推测/猜测」——中间留空档以吃「这条只是我的猜测」,
      // 但不跨句读(`[^。;;\n]`),免得跨句咬合成假豁免。
      "(这|该|此|以上|上面|以下|下面|本条|该条)[^。;;\\n]{0,8}(只|仅)?是[^。;;\\n]{0,6}(推断|推测|猜测|臆测|假设)",
      "标注?为(推断|推测|未核实)",
    ].join("|")).test(eTxt) && unhedgedIdx.length === 0,
    // 独立性那一半:**动作面**。三条通路都认(脚本 / MCP / battle)。
    crossChecked: ctx.ranBash(/codex-run\.mjs|CODEX_JOB=/) ||
      ctx.toolNames.some((n) => /mcp__codex-cli__codex/.test(n)) ||
      ctx.skills.some((s) => /battle/.test(s)),
    // 形那一半:真跑了 xros,或真跑了机械探针。同样只看动作。
    shaped: ctx.skills.some((s) => /^xros[:-]/.test(s)) || ranProbe(acted),
  };
}

/** 出路即数据 → 渲染成消息里的那几行。**只此一处渲染**,规则不再手写出路清单。
 *
 *  为什么(2026-08-27,批 117):本批一天内撞到**七次**同一个错型——
 *  闸的消息承诺一条出路,而判据不认那个写法。根因不是七个 bug,
 *  是**出路清单与判据两处各写一遍**:改判据的人不会想起去改散文,反之亦然。
 *  现在消息由 `escapes` 生成,而 `escapes[i].sample` 每次自测都要真的跑一遍必须放行
 *  ⇒ **说的和做的漂了,当场变红**,不必等下一个人撞上去。
 *  天花板:它保证「消息里印的那条出路能过」,**不保证同义的自然变体也能过**——
 *  D69 那类(自标只认模板七字、变体不认)得靠 `cases.neg` 里的自然变体覆盖,两者互补不互替。 */
export function renderEscapes(escapes, { indent = "      " } = {}) {
  const mark = ["①", "②", "③", "④", "⑤", "⑥"];
  return escapes.map((e, i) => `${indent}${mark[i] ?? "·"} ${e.say}`).join("\n");
}

/** E2(阻断):没问过「有没有机械判据」。自标不豁免本项。 */
export const RULE_E2 = {
  id: "E2",
  blocking: true,
  law: "docs/laws/reporting.md#未被机器直证的因果断言过独立复核",
  detect: (ctx) => {
    const f = eFacts(ctx);
    if (!f.hits.length) return [];
    // ⚠️ 冒号类必须写死全角 `：`。旧实现写的是 `[::]`,**看起来**一半一全,
    //   实际两个都是半角 U+003A(源码字节 5b 3a 3a 5d)⇒ 中文里最自然的
    //   「机械判据：已跑」从来没被认出来过,出路②形同虚设。全角字符靠码位不靠肉眼。
    // ⚠️ 否定前瞻不可省:没有它,`\S` 会把「机械判据:**无**」也算成「有判据」,
    //   于是「无」那一档走不到下面的 sharpen 必填检查。
    // ⚠️ **剥引号**（grill:error-handling §4.3，跑代码复现）：
    //   E2 的阻断消息里就写着「机械判据:已跑X」，
    //   把它原样引用一遍 ⇒ `declHasOracle` 命中 ⇒ **E2 对本轮永久静默**。
    //   与 S 同族（回声豁免，fail-open），而 Q/T 先修的是回声触发（fail-closed）。
    const eTxt = maskQuoted(ctx.text);   // 口径只此一份,见 maskQuoted 头注
    // ⚠️ 2026-08-27(D72,codex 114 判词 Q1,已机器复现):否定档原来是**两处各自枚举**——
    //   `declHasOracle` 的前瞻写 `(?!无|没有|不可|未)`,`declNoOracle` 写 `(无|没有)`。
    //   同一个概念枚举两遍,必漂移;且**漏一个否定词的后果是方向性的**:
    //   「机械判据:**不存在**」不在那四条里 ⇒ 被判成「有判据」⇒ E2 放行,
    //   还顺带绕过「无判据档必须递 /xros:sharpen」那道要求。实测「不存在/没了/缺」三形态
    //   均使 E0+E2 **双双放行**,一句「我猜根因是 X;机械判据:不存在」即可通关两条阻断规则。
    //   修法两条:①否定词表**只此一份**,两个分支共用;
    //   ②未知措辞的落点改成 fail-closed —— `declHasOracle` 从「不是否定词就算有」
    //   改为**必须出现肯定形态**(有/已跑/已核/跑过/见…)。理由:这是**豁免**判据,
    //   宪法「fail-closed 默认」属承重八族;而误拦的代价只是按 E2 消息里写好的两种形态重写一句。
    const NEG_ORACLE = /^\s*(无(?!法核对)|没有|没了|不存在|不可|不能|未|缺|欠|难以|无法|N\/?A|待定|不清楚)/;
    const declVal = eTxt.match(/机械判据\s*[:：]\s*([^\n。;;]{0,40})/)?.[1] ?? "";
    // ⚠️ 四眼回件当场逮到(codex 114-fourEyes Q2):首版肯定形态只有「有/已跑/已核/跑过/见/`」,
    //   而 `机械判据:node scripts/x.mjs`、`机械判据:退出码为 0`、`机械判据:scripts/verify-laws.mjs`
    //   这三种**直接给命令或路径**的合法声明一条都不认 ⇒ 新误拦。
    //   **这是本批 D69 那个病(出路太窄)在一小时内的二犯,且是我修 D69 时自己造的**:
    //   把 fail-closed 写成一张短白名单,等于把「未知即拦」偷换成「不在我列举里即拦」。
    //   现补:路径样(含 / 或 .)、命令样(字母开头带参数)、退出码/exit code。
    //   **天花板照实说**:`机械判据:待补,见 D72` 这类**假声明**仍会通过——
    //   本项判的是「有没有给出可核的东西」,判不了「给的是不是真判据」;
    //   要判后者只能靠 D72 的断言—证据绑定,那是另一件事。
    const declHasOracle = /^\s*(有|已跑|已核|跑过|跑了|见\s*\S|`|退出码|exit\s*code|\S*[/.]\S|[A-Za-z][\w-]{2,}[\s(])/i
      .test(declVal);
    const declNoOracle = NEG_ORACLE.test(declVal) ||
      /判据(为|是)\s*[:：]?\s*(无|没有)|不可机械核定|无可跑的检验/.test(eTxt);
    // 「无判据」那一档要附一条**能接手的动作**,不能是句号。
    //   sharpen 是多 agent 管线只能用户下,故做成**必填后续**而非独立出路——
    //   一条「这个得你去跑」的一句话出路会变成最便宜的逃生口,吞掉其余出路
    //   (当日实测过同型塌方:自标 8 次 : xros 1 次)。
    const handedSharpen = /\/xros:sharpen\s+\S/.test(ctx.text);
    if (f.shaped || declHasOracle || (declNoOracle && handedSharpen)) return [];
    return f.hits;
  },
  exempts: [],
  // 出路即数据(批 117)。第三条**刻意单列**:2026-08-20 我照消息答、连撞四轮才发现
  //   判据在要 sharpen 而消息没写——那正是本族最早的一例。现在它有 sample 兜着。
  escapes: [
    { say: "真去找:能造机械判据→跑探针或 xros:compile+run;造不出→xros:reason 出结构",
      sample: { bash: "node scripts/verify-laws.mjs" } },
    // forPos:判据取**第一个**「机械判据:」声明。pos[2..6] 本身已带一条否定/未知声明,
    //   在后面再补一条肯定的**不应**把前一条洗白(fail-closed,刻意)。故样例只对
    //   尚无声明的正例成立。
    { say: "**就地声明**:⟪机械判据⟫:已跑X / 有但未跑,因…",
      forPos: [0, 1], sample: { text: "机械判据：已跑 verify-laws，退出码 0。" } },
    { say: "**机械判据:无** ——「因该命题不可机械核定」⚠️ **这一档不能只说一句**,判据额外要求你" +
        " **递出 `/xros:sharpen <这条怎么验>`**(理由:「没有判据」最容易被当成万能出路;" +
        "要说它,就得先真去找过)",
      sample: { text: "机械判据：无，不可机械核定。已递 `/xros:sharpen 这条该怎么验`" } },
  ],
  message: (hits) =>
    `因果断言未过**形**那一半:没问过「有没有机械判据」。**自标「这是推断」不豁免本项**` +
    `——承认不确定 ≠ 找过判据。出路:\n` +
    `${renderEscapes(RULE_E2.escapes)}\n` +
    `    · ${hits.slice(0, 3).join("\n    · ")}`,
  mutations: [
    { name: "冒号退回全半角混写(`[::]` 那个字节级 bug)", apply: (r) => ({ ...r, detect: (ctx) => {
      const f = eFacts(ctx);
      if (!f.hits.length) return [];
      if (f.shaped || /机械判据\s*[::]\s*(?!无|没有|不可|未)\S/.test(ctx.text)) return [];
      return f.hits;
    } }) },
    { name: "让 hedged 也豁免 E2(最便宜出路吞掉其余)", apply: (r) => ({ ...r, detect: (ctx) => {
      const f = eFacts(ctx);
      if (!f.hits.length || f.hedged) return [];
      return r.detect(ctx);
    } }) },
    { name: "去掉否定前瞻(「机械判据:无」被当成有判据)", apply: (r) => ({ ...r, detect: (ctx) => {
      const f = eFacts(ctx);
      if (!f.hits.length) return [];
      if (f.shaped || /机械判据\s*[:：]\s*\S/.test(ctx.text)) return [];
      return f.hits;
    } }) },
  ],
  cases: {
    pos: [
      { text: "根因是路径写错，整闸因此失效。" },
      // 自标不豁免 E2 —— 这条是「最便宜出路吞掉其余」那个塌方的回归守卫
      { text: "根因是路径写错。这是我的推断。" },
      // 「无判据」但没递出 sharpen ⇒ 仍命中
      { text: "根因是路径写错。机械判据：无。" },
      // ── D72 回归钉(2026-08-27,codex 114 Q1 给的绕闸句,已机器复现)──────────
      // 「不存在」不在旧那张四词否定表里 ⇒ 被判成「有判据」⇒ E0+E2 **双双放行**。
      // 一句话通关两条阻断规则,是本族至今最便宜的一条逃生口。
      { text: "我猜根因是鉴权分支写反了；机械判据：不存在。" },
      { text: "根因是路径写错。机械判据：没了。" },
      { text: "根因是路径写错。机械判据：缺。" },
      // 未知措辞落 fail-closed 侧:既非肯定形态也非否定词 ⇒ 不豁免(旧式会豁免)。
      { text: "根因是路径写错。机械判据：待定。" },
    ],
    neg: [
      { text: "根因是路径写错。机械判据：已跑 verify-laws，退出码 0。" },
      // ⚠️ **全角冒号**那一档:旧实现在这里漏了整整一天
      { text: "根因是路径写错。机械判据：有但未跑，因配额耗尽。" },
      { text: "根因是路径写错。机械判据：无，不可机械核定。已递 `/xros:sharpen 这条该怎么验`" },
      // ⚠️ 四眼(codex 114-fourEyes Q2)点名的三种**直接给命令或路径**的合法声明。
      //   我修 D72 时把 declHasOracle 改成肯定形态白名单,这三种一条都不认 ⇒ 新误拦
      //   ——**D69「出路太窄」在同一批内的二犯,且是我修 D69 时自己造的**。
      //   当时只用一次性探针验过就过去了:**验过而没钉住,等于没修**(本批第三次栽在这)。
      { text: "根因是路径写错。机械判据：node scripts/x.mjs。" },
      { text: "根因是路径写错。机械判据：退出码为 0。" },
      { text: "根因是路径写错。机械判据：scripts/verify-laws.mjs。" },
      { text: "今天没有下任何因果断言。" },
      // 回声(与 E0 同修):因果形态只在引文里 ⇒ E2 也不响(共享 eFacts 的剥引文)
      { text: "问题一句话：「把跨项目的教训持久化，让未来会话能召回」。拿它当搜索键把工具面扫了三层。" },
    ],
  },
};

/** E0(阻断):裸因果断言——既没复核、也没自标。 */
export const RULE_E0 = {
  id: "E0",
  blocking: true,
  law: "docs/laws/reporting.md#未被机器直证的因果断言过独立复核",
  detect: (ctx) => {
    const f = eFacts(ctx);
    if (!f.hits.length || f.hedged) return [];
    if (f.crossChecked || f.shaped) return [];
    // 就近绑定(D72 最小步):只报**没有就近自标**的那些命中;全都标过 ⇒ 无 finding。
    return f.unhedgedHits;
  },
  exempts: [],
  // 出路即数据(批 117)。每条 `sample` 会被接在**本规则自己的正例**后面跑一遍,
  //   必须放行——即「照消息做真的能过」由机器每次自测证明,不靠人核对散文。
  escapes: [
    { say: "跨模型复核:codex / battle",
      sample: { bash: "node ~/.claude/scripts/codex-run.mjs --task t.md" } },
    { say: "先问有没有机械判据:能造→跑探针或 xros:compile+run;造不出→xros:reason(产物标 UNVERIFIED)",
      sample: { bash: "node scripts/verify-laws.mjs" } },
    // forPos:出路是「**就地**自标」,批 117 起自标按**行**就近绑定 ⇒ 在末尾补一句
    //   救不了前面几行的断言。pos[5] 是两行两断言、只标了第二行的形态,
    //   它**应该**仍被拦——那正是就近绑定要的效果,不是探针失败。
    { say: "**就地自标** ⟪这是推断⟫(或「证据不足」「未核实」)——成本一句话,且比前两条更常是正确答案",
      forPos: [0, 1, 2, 3, 4], sample: { text: "这是推断。" } },
  ],
  message: (hits) =>
    `裸因果断言:未复核且未自标(${hits.length} 处)。三条出路任选其一——\n` +
    `${renderEscapes(RULE_E0.escapes)}\n` +
    `    · ${hits.slice(0, 3).join("\n    · ")}`,
  mutations: [
    { name: "去掉自标出路(最便宜那条)", apply: (r) => ({ ...r, detect: (ctx) => {
      const f = eFacts(ctx);
      if (!f.hits.length) return [];
      return (f.crossChecked || f.shaped) ? [] : f.hits;
    } }) },
    { name: "crossChecked 退回扫裸文本(读到提及 codex 的文件即豁免)",
      apply: (r) => ({ ...r, detect: (ctx) => {
        const f = eFacts(ctx);
        if (!f.hits.length || f.hedged) return [];
        if (/codex-run\.mjs|CODEX_JOB=/.test(ctx.text) || f.crossChecked || f.shaped) return [];
        return f.hits;
      } }) },
    // 回声族回归:因果匹配退回**不剥引文**的原文 ⇒ 「引用被拦的话来处置它」再被拦。
    //   证人 = neg 的引文用例。2026-08-22 实撞两连响,probe 证实「让…它」跨引号边界咬合。
    { name: "因果匹配不剥引文(回声族)", apply: (r) => ({ ...r, detect: (ctx) => {
      const hits = matchAny(ctx.text, PAT.causal);
      if (!hits.length || /UNVERIFIED|未核实|证据不足|这(仍)?是(我的)?推断|标注?为推断/.test(ctx.text)) return [];
      const crossChecked = ctx.ranBash(/codex-run\.mjs|CODEX_JOB=/) ||
        ctx.toolNames.some((n) => /mcp__codex-cli__codex/.test(n)) ||
        ctx.skills.some((s) => /battle/.test(s));
      const shaped = ctx.skills.some((s) => /^xros[:-]/.test(s)) || ranProbe(JSON.stringify(ctx.actions));
      return (crossChecked || shaped) ? [] : hits;
    } }) },
  ],
  cases: {
    pos: [
      { text: "根因是路径写错，整闸因此失效。" },
      // ⚠️ 只是**提到** codex-run.mjs 不算跑过(旧实现在这里被文件内容骗:
      //   读到一个提及该脚本的文件就算复核过)。**这条必须是正例**——
      //   我第一版把它写成反例并加了「我这是推断」,结果它被 hedged 豁免,
      //   于是「crossChecked 退回扫裸文本」那条变异**没有证人**、成了等价变异。
      //   反例带着无关的豁免 ⇒ 变异测不出来,这是本仓第 N 次同型。
      { text: "根因是路径写错。回头可以用 codex-run.mjs 复核。" },
      // D78 反向钉:**切分线不是「技术 vs 产品」**。这条是产品成本判断,
      //   而它在实况里几轮后被作者自己推翻(「总账反过来」)⇒ 必须照拦。
      { text: "理由是我们的负载形状很特殊，成本几乎全压在这一项上，而那一项 DeepSeek 反而便宜 2-4 倍。" },
      // D78 反向钉:主语带「我」但解释的是**系统状态的成因** ⇒ 不是叙事,照拦。
      { text: "根因是我把路径写错了，于是加载的是副本。" },
      // D72:引文里**别人**那句「我猜」不得豁免引文外**我自己**的鉴权断言。
      //   旧式 `hedged` 跑在未剥引文的原文上 ⇒ 整轮放行(codex 114 Q3,已复现)。
      { text: "对方原话：「我猜缓存可能过期」。根因是鉴权中间件把匿名用户映射成管理员。" },
      // D72 最小步(四眼 Q3):两条断言分行,只标了下面那条 ⇒ 上面那条仍须报。
      //   旧的整轮布尔在这里会把两条一起豁免。
      { text: "根因是鉴权被绕过。\n根因是缓存没刷新，这条只是我的猜测。" },
    ],
    neg: [
      { text: "根因是路径写错。这是我的推断。" },
      // 真跑过跨模型 —— **动作面**,不是嘴上说
      { text: "根因是路径写错。", bash: "node ~/.claude/scripts/codex-run.mjs --task t.md" },
      { text: "今天没有下任何因果断言。" },
      // **回声**:因果形态整个在引文里,引文外只有任务陈述 ⇒ 放行。
      //   2026-08-22 实撞:「让」在 「」 内、「它」在 「」 外,#4 跨引号边界咬合,
      //   于是**引用被拦的话来处置它 ⇒ 处置本身再被拦**,连响两轮。
      { text: "问题一句话：「把跨项目的教训持久化，让未来会话能召回」。拿它当搜索键把工具面扫了三层。" },
      // ── D69 回归钉(2026-08-27,proj-a 会话实况取样)────────────────────────
      // 这两条是**另一条会话里被真的拦下来**的原话,逐字钉在这。旧判据两条都不认。
      { text: "根因是硬闸拦下的，未跑的原因是插件还不存在。在跑出来之前，这条只是我的猜测，别当结论。" },
      // ⚠️ 反向钉(D72,codex 114 Q3):**引文里别人的「我猜」不算我自标**。
      //   这条必须留在 pos(见下),此处只声明它不该被误当反例——真正的用例在 pos。
      { text: "根因是配置写错导致它没生效。我不确定，没核过。" },
      // D72 最小步:总括声明仍认整轮(块级标记),否则逼人逐行重复自标 ⇒ 噪声。
      { text: "以下均为推断。\n根因是路径写错。\n另一处根因是缓存没刷新。" },
      // ── D78 叙事性因果整类排除(2026-08-27 用户亲签)。三条都是实况原话。────────
      { text: "未跑的原因是插件还不存在，不是我不想跑。" },
      { text: "我上一轮说错了。原因是我盯着一个行项看，没算总数。" },
      { text: "这不是撞闸也不是阻断，纯粹是我停在了那里。" },
      // 探针的运行时不是 node ⇒ 旧 `ranProbe` 不认 ⇒ 一句有退出码兜底的话被 E0 拦。
      //   注意这条走的是 `shaped`(动作面)而非 `hedged`——嘴上说「有退出码」永远不算数,
      //   真正让它放行的是本轮**确实执行过**那个 probe 脚本。
      {
        text: "根因是 rate=1.0 时走的是硬闸分支，这句话现在有退出码兜着。",
        bash: "cd /d/proj-b && python tests/probe_rate1_determinism.py; echo \"退出码=$?\"",
      },
    ],
  },
};

/** E1(提示):过了形、缺独立性。 */
export const RULE_E1 = {
  id: "E1",
  blocking: false,
  law: "docs/laws/reporting.md#未被机器直证的因果断言过独立复核",
  detect: (ctx) => {
    const f = eFacts(ctx);
    if (!f.hits.length || f.hedged) return [];
    // E0 与 E1 互斥:E0 管「两半都没做」,E1 管「做了形、缺独立性」
    if (f.crossChecked) return [];
    if (!f.shaped) return [];          // 形也没过 ⇒ 归 E0,不归本项
    return f.hits;
  },
  exempts: [],
  message: (hits) =>
    `因果断言已过形、未过**独立性**那一半(跨模型复核 codex 或 battle):\n    · ${hits.slice(0, 3).join("\n    · ")}`,
  mutations: [
    { name: "与 E0 不再互斥(形没过也报 E1)", apply: (r) => ({ ...r, detect: (ctx) => {
      const f = eFacts(ctx);
      if (!f.hits.length || f.hedged || f.crossChecked) return [];
      return f.hits;
    } }) },
    { name: "去掉 crossChecked 豁免(跑过跨模型也报)", apply: (r) => ({ ...r, detect: (ctx) => {
      const f = eFacts(ctx);
      if (!f.hits.length || f.hedged || !f.shaped) return [];
      return f.hits;
    } }) },
  ],
  cases: {
    pos: [
      // 跑了探针(形过了)但没跑跨模型
      { text: "根因是路径写错。", bash: "node --no-warnings scripts/verify-laws.mjs" },
    ],
    neg: [
      // 两半都做了
      { text: "根因是路径写错。",
        bash: ["node --no-warnings scripts/verify-laws.mjs", "node ~/.claude/scripts/codex-run.mjs --task t.md"] },
      // 形没过 ⇒ 归 E0 不归 E1
      { text: "根因是路径写错，整闸因此失效。" },
      { text: "今天没有下任何因果断言。" },
    ],
  },
};

// ── K / K0:批次完成条件 ─────────────────────────────────────────────────────
// 迁移时一并修掉的旧缺陷(每条都在旧实现上实撞过或被审计逐字节验出):
//  ① **阻断判据从裸文本改动作面**。旧实现 `/git\s+commit/.test(rawText(turn))` ——
//     `rawText` 含 tool_result,于是**读一份提到 `git commit` 的文档就把 K 升成阻断**。
//     现在走 `ctx.didCommit()`(真发生过提交动作)。这是本次迁移收益最大的一条。
//  ② **批次状态由缝注入**,规则不自己读磁盘。旧实现在 `run()` 里 readFileSync,
//     于是自测结果取决于跑它时磁盘上碰巧有什么(2026-08-19 当场从 34/34 掉到 13/34),
//     还得靠 `STOP_CLOSURE_SELFTEST` 这个未登记的环境变量绕开——那个开关本身
//     就是 grill 逮到的「未登记的双闸关闭开关」。注入之后它不再需要存在。
//  ③ **`properClose` 不再 stringify 整个 input 再正则**。旧实现 `/batch-goal\.mjs[^"]*--clear/`
//     打在 `JSON.stringify(input)` 上,路径里只要有引号就断(grill K0-3)。
//     现在直接读 `actions[].input.command`,顺序也来自 `actions` 的天然次序。
//
// 考虑过但**不修**的两条,连同理由一起登记(免得下次有人当漏网):
//  ④ 编号形态只认阿拉伯数字,`条件一`/`条件①` 不算数。**不放宽**——放宽的方向是
//     让 K **更容易被满足**(命中更少),那是 fail-open 那一侧。一道阻断闸的召回
//     只能往严了调;真要放宽得先有证据说明我确实在用那些写法。
//  ⑤ 只扫对话 `ctx.text`,不扫 `ctx.written`。同理由:把「写进文件的逐条对照」算数
//     是 fail-open,而模板文件里一句示例 `条件1: 达成` 就能顶掉整道闸。J 项能扫
//     written 是因为它的方向相反(扫得越多命中越少 ⇒ 但 J 非阻断)。

/** 从对话里取出「已给出裁决」的条件编号。冒号**必须含全角 U+FF1A**——
 *  同型 bug 在 E2 上 2026-08-19 上午修过,K 这处当天下午才被逐字节验出。 */
function confirmedConditions(text) {
  const done = new Set();
  for (const m of String(text || "").matchAll(/条件\s*(\d+)\s*[:：]\s*(达成|未达成|已达成|不适用)/g)) {
    done.add(Number(m[1]));
  }
  return done;
}

/** 被裁成「**未达成**」的条件编号。与上面那个分开,是 2026-08-20 用户点破的洞:
 *
 *  > 「你没做完本来就不应该拦。哪条闸又错了?」
 *
 *  K 原本只问「有没有逐条对照」——**写一句「条件1: 未达成」就放行**。
 *  那是拿**文本声明**当**结构义务**的履行,与 P 的纯文本豁免同病(P 那条 08-20 已撤)。
 *  K 要的是「交代」,而批要的是「完成」,我一直把这两件事混着用。
 *
 *  修法不是「未达成一律拦死」——用户此前已裁定「一个开着的批不该每轮都拦,
 *  因为确实有些要跟我讨论的情况」。修法是**区分两种未达成**:
 *    · 未达成 **且**本轮标了 `⏸`(宪法唯一通用等待标识,S 项同锚)⇒ 正当停工,放行;
 *    · 未达成 **且**没标 ⇒ 就是「干着干着停了」,拦。
 *  代价不对称:多拦一轮=我多干一轮;漏放=批无限期挂着而没人再提。 */
function unmetConditions(text) {
  const bad = new Set();
  for (const m of String(text || "").matchAll(/条件\s*(\d+)\s*[:：]\s*未达成/g)) bad.add(Number(m[1]));
  return bad;
}

/** **真正了结**的条件编号 = 逐条对照过的,**减去**被自己判成「未达成」的(除非本轮标了 ⏸)。
 *
 *  ⚠️ 2026-08-27(D85,用户当轮第三次逮到同一形态)。此前这段逻辑**抄了两遍**(K 里两处),
 *  而 **S 的第三入口用的是没减过的原始计数** ⇒ 出现一条谁都没设计过的缝:
 *    K 只要求「逐条对照」,写一句「条件2:未达成」就算交代 ⇒ K 满意;
 *    S 拿 `confirmedConditions` 的**原始 size** 判「是不是跑完了」,那句也被算进去 ⇒
 *    条数凑满 ⇒ S 判我在 C 态(跑完了)⇒ 整条跳过。
 *  **于是:诚实地写「未达成」并停下,两道闸同时放行。** 我 2026-08-27 就是这么溜掉的,
 *  当天被用户连问三次「为什么停下来了」。
 *  根因不是判据写错,是**同一个概念在三处各写一遍**——与 D72① 的否定词表、
 *  D73 的消息-法条、D83 的 S 双份理由检查完全同型,本批第四次。
 *  ⇒ 口径只此一份,三处都调它。 */
function settledConditions(ctx) {
  const done = confirmedConditions(ctx.text);
  if (!declaredPause(ctx)) for (const n of unmetConditions(ctx.text)) done.delete(n);
  return done;
}
/** 本轮是否显式声明了停工(宪法:停下等确认必标 `⏸`,三家 CLI 唯一通用等待标识)。
 *  ⚠️ 天花板写在明处:`⏸` 是文本面,我能敲出来。但它是**刻意、可见、留痕**的动作,
 *  且 S 项本身就在审「停工理由站不站得住」。这里不追求不可伪造,只要求**把停工说出口**。 */
function declaredPause(ctx) { return /⏸/.test(String((ctx && ctx.text) || "")); }

/** 批在漂:窗口内写了好几轮,却一条完成条件都没裁过。
 *
 *  为什么按「有写动作的回合数」而不按「回合数」:纯讨论轮不该计数——
 *  用户明确要保留「我要跟你讨论」的空间(2026-08-20 亲裁)。
 *  为什么零裁决才算漂:只要裁过一条,就说明这个批还活着、还在被跟进。
 *  CEILING:它看的是窗口(条数封顶),窗口滚出去的历史看不见 ⇒ 超长批可能漏判;
 *  且它判不出「裁了但裁得敷衍」。 */
const DRIFT_WRITE_TURNS = 3;
function batchDrifting(ctx) {
  const g = ctx.batchGoal;
  if (!g || g.cleared || !Array.isArray(g.conditions) || !g.conditions.length) return false;
  let win = null;
  try { win = ctx.window(); } catch { win = null; }
  // ⚠️ **本轮也必须在写才升级**(第一版漏了,实测当场暴露)。
  //   漏了它的话:窗口里连写三轮零裁决之后,**连纯讨论轮也被阻断** ——
  //   你问一句「这个字段干嘛的」,闸就把我拦住,正好违背用户「要留讨论空间」那条裁定。
  //   漂是「**还在继续堆活却不裁**」,不是「历史上堆过活」。
  if (!ctx.writes.length && !ctx.didCommit()) return false;
  if (!win) return false;                       // 没窗口 ⇒ 不判(与接线前一致)
  if (confirmedConditions(win.text).size > 0) return false;   // 窗口内裁过 ⇒ 不算漂
  if (confirmedConditions(ctx.text).size > 0) return false;
  // 窗口里有写动作的回合数。`window()` 是同形状 ctx,拿不到逐轮切分 ⇒
  // 用写动作条数作下界近似,并写明这是近似。
  return (win.writes.length + (win.commits?.length || 0)) >= DRIFT_WRITE_TURNS;
}

/** 本回合是否跑过 `batch-goal --arm`(动作面)。
 *
 *  ⚠️ 用途:识破**现造的关账证据**(grill:edge-cases E5)。
 *  豁免只问「关掉的那批有几条条件」,不问那批何时武装、干过什么 ⇒
 *  同一轮里敲 `--arm 999 --cond x` 再 `--clear`,台账立刻多一行「关掉了一个有 1 条条件的批」,
 *  **证据是两条命令现造的**,而闸认。门槛从「空 clear」抬到「一个字母的条件」而已。
 *  判据不取时间戳:**现造的那行时间戳也是新的**,时间戳挡不住这个。
 *  取动作面——**同一轮内既武装又结清,那份证据就不算数**。
 *  代价:会误伤「真的一轮做完的小批」。按本仓代价不对称(误报当场可见可人工放行,
 *  漏放进下游难发现),这是便宜的那一侧;且「一轮武装完立刻结清」本来就该被看一眼。 */
/** 批 253(红队审 K/K0 再修:BP-4 / BP-7):本轮 batch-goal 状态改动**按执行顺序**的序列。
 *  只认执行:剥掉开头的 `VAR=值`(值可带引号)后,段首若是读命令(cat/grep/sed…)就不算;其余含 batch-goal.mjs 的段一律当执行
 *  (带引号的 node 全路径、`env X=1 node` 都算)。批号在原串上取再剥引号。解析失败抛出,由调用方 fail-closed。
 *  返回 `[{op:"clear"} | {op:"arm", id}]`。 */
// codex 253 合并复核:打印类段头(echo/printf/Write-Host…)同样不是执行。
const BG_READ_HEAD = /^(?:cat|grep|egrep|fgrep|rg|sed|head|tail|less|more|wc|type|get-content|select-string|echo|printf|write-host|write-output)$/i;
function batchGoalOps(ctx) {
  const ops = [];
  for (const a of (ctx.actions || [])) for (const seg of segments(a.input?.command)) {
    if (typeof seg !== "string" || !seg.includes("batch-goal.mjs")) continue;
    const rest = seg.replace(/^\s*(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, "");
    const head = ((rest.match(/^\s*("[^"]*"|'[^']*'|\S+)/) || [])[1] || "").replace(/^["']|["']$/g, "");
    if (BG_READ_HEAD.test(head.replace(/^.*[\\/]/, ""))) continue;
    const bare = stripQuoted(seg);
    if (/(^|\s)--clear(\s|$)/.test(bare)) ops.push({ op: "clear" });
    else if (/(^|\s)--arm(\s|$)/.test(bare)) {
      const m = seg.match(/(?:^|\s)--arm\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
      ops.push({ op: "arm", id: m ? (m[1] ?? m[2] ?? m[3]) : "?" });
    }
  }
  return ops;
}

function ranArm(ctx) {
  return (ctx.actions || []).some((a) =>
    segments(a.input?.command).some((s) =>
      /batch-goal\.mjs[^"']*--arm\b/.test(stripQuoted(s))));
}

/** 本回合是否跑过 `batch-goal --clear`(动作面,不认文本里提到这串)。
 *
 *  ⚠️ **先剥引号再匹配**(2026-08-20 实撞,写完当天就被自己绊倒)。
 *  原写法 `/batch-goal\.mjs\b[\s\S]*--clear/` 的 `[\s\S]*` **横跨整条命令**,于是
 *    `batch-goal.mjs --arm 072 --cond "K 的 --clear 阻断与…"`
 *  被判成「跑过 --clear」—— 我武装批次时把 `--clear` 写进了条件文本,当场把自己拦住。
 *  与本文件已登记的 L 项 `[^"]*`、M 项 `\S*` 是**同一族第四次**:
 *  **正则的作用域比我以为的宽**。剥掉引号串之后,参数面与文本面才真正分开。 */
export function ranClear(ctx) {
  // ⚠️ **必须逐段判,不能整条判**(2026-08-20 codex 判出,三条复现全部实测复现):
  //   我造了 `segments()` 却**在生产代码里零调用**,只用了 `stripQuoted`,
  //   于是正则照样跨 `|` 和 `;` 拼接,P2 的原始反例**一条都没死**:
  //     `cat scripts/batch-goal.mjs | grep -- --clear`        ⇒ 曾判 true
  //     `node scripts/batch-goal.mjs --status; echo --clear`  ⇒ 曾判 true
  //     `echo scripts/batch-goal.mjs; node scripts/other.mjs --clear` ⇒ 曾判 true
  //   而我那六条零件用例测的是**带引号**的形态(`grep -n "…--clear"`),
  //   不带引号的管道/分号形态一条没测 —— **同一场景我挑了容易的那半**。
  //   错的推理步骤(codex 原话):把「造出了共享切段器、两处用了共享去引号器」
  //   当成「命令作用域已经统一」。**目标反例没死就不算收口。**
  // ⚠️ **判词方向:遇到解析不确定必须 fail-closed**(D62,2026-08-26 落定)。
  //   立此判据的三步实撞,都记下来:
  //   ① 原式 `[^;|]*` 等无上限量词,200KB 斜杠路径输入实测 **12.3 秒** > hook 30s 超时的量级,
  //      而被超时杀死的 hook **不阻断** ⇒ 整闸静默失效。
  //   ② 我改成 `{0,512}/{0,256}` 封顶 —— 方向错了:超界即返回「不命中」,
  //      等价于把真实的 `--clear` 当成没发生 ⇒ **关掉下游六处规则的触发器**
  //      (W 交付物四眼、关账族)。实测 `--note <300字符> --clear` 由命中变不命中。
  //      跨模型判词:「不能在『超时导致整闸 fail-open』和『封顶导致触发器 fail-open』之间二选一」。
  //   ③ 另有一条既有致盲:`stripQuoted` 把引号内容抹成等长空格,于是
  //      `node "/repo/scripts/batch-goal.mjs" --clear` 里**脚本名整个消失** ⇒ 判不中。
  //      而 Windows 上给带盘符路径加引号是本能动作。
  //   现改为**不用长正则**:两个独立的 O(n) 存在性判定 + 原串与去引号串**并集**。
  //   没有回溯面(纯 includes 与短正则),没有长度上限(不会因命令长而漏判),
  //   且并集使加引号的形态照样命中。方向:宁可多命中(误拦=多跑一轮)。
  //   ④ **方向在这条判词上是反的**(改完首跑被自己的用例逮住,记下来):
  //      `ranClear` 为真 = 闸认为「本批已结清」⇒ 不再要求逐条对照 ⇒ **误命中是漏放**,不是误拦。
  //      我按「宁可多命中」写了一版,当场被既有用例
  //      「--arm 但条件文本里含 --clear」判负——旧式的 `[^"']*` 正是为堵这个而存在。
  //      ⇒ 「承重判词遇不确定性 fail-closed」这条原则**必须先判清哪个方向才是 closed**,
  //      不能默认「多命中=保守」。同一条原则在 W/I 上是多命中,在本条上是少命中。
  //   最终形态:**两个面分开取**,各取所长,都不含无界回溯。
  const hasClearTok = (s) => typeof s === "string" && /(^|\s)--clear(\s|$)/.test(s);
  // ⑤ **clear 意图 ≠ clear 成功**(2026-09-04 codex/grill 双审逮到,D98-③ 让 --clear 可以合法拒清退出 2):
  //   batch-goal 拒清时把 `clearRefusedAt` 写进状态文件;盘上未结清且带此痕迹 ⇒ 这次 --clear 没成 ⇒ false。
  //   (不能只看「盘上未结清」:同轮「关旧批 + 开新批」盘上也是武装态,那是合法的,E9 三分支就靠它。)
  //   方向:本条为真 = 「已结清」⇒ 下游关账族放行 ⇒ 误真是漏放 ⇒ 拿不准取 false。
  const g = ctx.batchGoal;
  if (g && g.cleared !== true && g.clearRefusedAt) return false;
  return (ctx.actions || []).some((a) =>
    segments(a.input?.command).some((seg) => {
      if (typeof seg !== "string" || !seg) return false;
      // 脚本名认**原串**:带引号的绝对路径(`node "/abs/…/batch-goal.mjs" --clear`)照样算数
      //   ——stripQuoted 会把它整个抹掉,这是既有致盲(Windows 上加引号是本能动作)。
      if (!seg.includes("batch-goal.mjs")) return false;
      // `--clear` 只认**去引号后**的:引号里的条件文本提到 --clear 不算数(用例④)。
      return hasClearTok(stripQuoted(seg));
    }));
}

/** 回合内 `--clear` 是否出现在**最后一次写动作之后**(= 正常关账,不是新批未武装)。
 *  只看回合终态会让**每次正确关账都误报**——2026-08-19 实撞两次,第二次我次序
 *  是对的仍被拦,因为判据看不见回合内的先后。 */
function properClose(ctx) {
  const seq = [];
  for (const a of ctx.actions || []) {
    const cmd = String(a.input?.command || "");
    // ⚠️ **逐段判**——与 `ranClear` 同一零件(grill:edge-cases E3:上一轮我只把 `ranClear`
    //   接了 `segments()`,`properClose` 仍在整条命令上匹配,而注释却写着「同一零件」)。
    //   后果是**被修的是收紧那一侧,漏掉的是放松那一侧**:末尾跑一条纯只读的
    //   `cat scripts/batch-goal.mjs | grep -- --clear`,K0 当场被豁免。
    // ⚠️ **一条命令里的每一段都要入列,不能只记一个标记**(grill:edge-cases E4)。
    //   原写法 `if (clear) … else if (write) …` 对一条命令只记一个,且 clear 分支优先 ⇒
    //     `batch-goal.mjs --clear && git add -A && git commit -m x`
    //   只入列 `clear`,**同一条命令里的提交在序列上根本不存在** ⇒ 次序反了也判成正常关账。
    //   `batch-goal.mjs` 头注明写「`--clear` 必须是最后一个动作,反了会命中 K0」——
    //   **那条法此前只在分开两条命令时成立,合成一行即失效**。
    const segs = segments(cmd);
    if (segs.length) {
      for (const s of segs) {
        const q = stripQuoted(s);
        if (/batch-goal\.mjs[^"']*--clear\b/.test(q)) seq.push("clear");
        else if (/\bgit\s+commit\b/.test(q)) seq.push("write");
      }
    }
    if (/^(Write|Edit|NotebookEdit)$/.test(a.name)) seq.push("write");
  }
  const lastClear = seq.lastIndexOf("clear");
  return lastClear >= 0 && lastClear > seq.lastIndexOf("write");
}

// ⚠️ **已登记未修的误报形态**(2026-08-20 发现,批 069 处理):
//   `--arm` 完成的**同一轮**,K 立刻命中「N/N 条未确认」——而开工那一刻当然还没对照。
//   判据缺一个时点条件:`armedAt` 落在本回合内 ⇒ 不追。
//   现在能忍是因为它只在本轮有提交时才升阻断(武装与提交同轮的情况少),
//   但这是**运气不是设计**:哪天有人 arm 完顺手提交,就会被自己刚立的条件拦住。
//   不当场改的理由:同一文件当日已改多轮,攒批处理;条件已写进批 069。
const RULE_K = {
  id: "K",
  // ═══ 批 250 瘦身(用户 2026-09-17 签:「K 我们做的有点过头了——没人主观上会这样,但是不少好人被拦了」)═══
  // 瘦身前 K 每轮对照「条件N:达成」字样:09-16~17 命中 173 次、阻断 11 次、其余 162 次是提醒,
  //   提醒走续轮,每次叫醒模型空回一轮;S 再把空回合判停工,误报台账 K 69 笔、S 40 笔(34 笔是这种空转)。
  // 现在 K **只管一件事**:本轮跑过 `batch-goal --clear`,盘上却仍是未结清状态——结清被拒,
  //   或结清半路崩了没留拒清痕迹(红队 250 BP-2)。这一轮才响,响即阻断;其余轮次一律不响。
  // 交出去的职责:
  //   · 关账时条件是否逐条对照 ⇒ K0(批 249 修、批 250 把检查前移到早退之前,两轮关账也管);
  //   · 做一半停下 ⇒ S 的批内判据(未改);
  //   · 连写几轮不裁决(原 `batchDrifting` 阻断)⇒ **刻意放弃**,只剩 hook 给用户看的「批仍未结清」提示。
  // 刻意放弃的还有:批中途提交不要求逐条对照(一批多次提交是常态);「未达成」不再须配 ⏸。
  // 复核:codex `clipboard/codex/250-k-slim-review-r1.md`、_gate-bypass-hunter 红队(本批),口径写明误拦诚实行为同等计价。
  blocking: true,
  law: "AGENTS.md#恒定条款",
  requires: ["batchGoal"],
  detect: (ctx) => RULE_K._detect(ctx),
  _detect: (ctx) => {
    const g = ctx.batchGoal;
    if (!g || g.cleared) return [];                       // 已结清 ⇒ 结清成功了,关账对照归 K0
    const conds = Array.isArray(g.conditions) ? g.conditions : [];
    if (!conds.length) return [];                         // 从未武装 ⇒ K0
    // 「尝试过结清」看动作面,**不走 ranClear 的拒清例外**:ranClear 在带拒清痕迹时恒返回 false,
    //   那正是本项要抓的状态。判不了按尝试过算(fail-closed)。
    // 批 253(红队审 ffbdef8:BP-6 / BP-8 / BP-7):
    //   ①按执行顺序取本轮最后一次 batch-goal 状态改动,是 --clear 才算;--clear 之后又 --arm ⇒ 关旧开新,不响;
    //   ②只认执行:由 batchGoalOps 判——剥掉 VAR=值 前缀后段首是读或打印命令(grep/cat/sed/echo…)不算,其余含 batch-goal.mjs 的段一律当执行;
    //   ③本轮标了 ⏸ 并写明三类合法停工理由之一 ⇒ 不响。⏸ 与理由这两项与 S 的 marked 同口径
    //     (⏸ 查剥过引号的全文、理由查原文全文,都不分段)。批 253e 起 K 与 S 的 marked **完全同口径**,不再多查任何一项。
    //   批 253 二修(红队审再修方案):
    //   ④ --clear 之后的 --arm **没生效**(结清被拒、或 && 短路没跑)⇒ 仍算结清没成(BP-1);
    //   ⑤ --clear 之后的 --arm 生效了(关旧开新)⇒ 查**刚关掉那批**是否逐条对照,条数由 hook 从台账补(BP-2)。
    //   ⑥(已撤,批 253e 汇总侧裁定,窄例外③ 判据过重)原先 ⏸ 豁免还要求正文「交代这次结清被拒」。
    //     253b→253d 四轮里这处每改一次词表/字距/段落,红队就在另一侧挖出阻断误拦或漏放
    //     (裸未、裸没、⏸ 标题行加空行、拒因超 6 字、「结清后没有遗留」)⇒ 字面判「有没有交代被拒」本身判不准。
    //     现:本轮跑过 --clear、盘上仍武装、正文有 ⏸ 且写明停工类别 ⇒ 放行。
    //     **接受的漏放**:⏸ 为别的事停下、同时以为结清成功(codex 253 合并复核那条夹具,已翻 neg)。
    //     接受理由:结清被拒时盘上批仍武装,K/S 下轮照常盯着;后果是用户看着一个未关的批停在 ⏸ 上,方向安全;
    //     而字面判据误拦的是如实交代拒清的阻断,每次白耗一轮。
    let ops;
    try { ops = batchGoalOps(ctx); } catch { ops = [{ op: "clear" }]; }   // 判不了按尝试过结清算(fail-closed)
    if (!ops.some((o) => o.op === "clear")) return [];
    const text = String(ctx.text || "");
    const last = ops[ops.length - 1];
    if (last.op === "arm" && !g.clearRefusedAt && String(g.batch ?? "") === String(last.id)) {
      const n = g.priorClosedCount;
      if (!(n > 0) || g.priorClosedBatch === g.batch) {
        return ["本轮关旧批、开新批,但从台账取不到刚关掉那批的条件数(无法核对是否逐条对照)"];
      }
      const done = confirmedConditions(text);
      let win = null;
      try { win = ctx.window(); } catch { win = null; }
      if (win) for (const k of confirmedConditions(win.text)) done.add(k);
      for (let i = 1; i <= n; i++) {
        if (!done.has(i)) return [`本轮关旧批、开新批,但刚关掉的批 ${g.priorClosedBatch} 有 ${n} 条完成条件,本轮与窗口缺条件${i} 的对照`];
      }
      return [];
    }
    const sTxtK = text.replace(/「[^」]*」|«[^»]*»|“[^”]*”|"[^"]*"/g, " ");
    if (matchAny(sTxtK, PAT.waitMark).length && matchAny(text, PAT.stopReason).length) return [];   // 与 S 的 marked 同口径(批 253e)
    return [g.clearRefusedAt
      ? `本轮跑了 --clear,但结清被拒(拒清痕迹 ${g.clearRefusedAt})`
      : "本轮跑了 --clear,但盘上仍是未结清状态,也没有拒清痕迹(结清可能半路出错)"];
  },
  exempts: [],
  message: (hits, ctx) => {
    const g = ctx.batchGoal || {};
    if (/^本轮关旧批、开新批/.test(String(hits[0] || ""))) {
      return `批 ${g.batch || "?"}:${hits[0]}。\n` +
        `      出路:在本轮逐条补写刚关掉那批的「条件N:达成/未达成/不适用」+ 一句证据。`;
    }
    return `批 ${g.batch || "?"}:${hits[0]}。\n` +
      `      出路:看这次 batch-goal --clear 的输出找拒因(可执行判据未过 / 有未提交的已跟踪改动 / 判不了工作树 / ` +
      `adr-missing 登记的决定还没有 ADR / diary-missing 登记的成果在产品日记里没有本批行 / ` +
      `obligation-unknown 判不了决定或成果的核对),` +
      `修好后重跑 --clear;登记错了的决定或成果用 batch-goal --withdraw <编号> --reason "<理由>" 撤回;` +
      `真要放弃本批,明说并留痕;要停下问用户,标 ⏸ 并写明停工类别。`;
  },
  mutations: [
    // 退回瘦身前:批开着就每轮报 ⇒ 空转回来。证人 = neg「武装批、只说话」。
    { name: "恢复每轮提醒(批开着就报)", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared || !(g.conditions || []).length) return [];
      return ["批开着"];
    } }) },
    // 拒清状态下每轮都报 ⇒ 修判据的讨论轮与中途提交被拦(红队 250 BP-6)。证人 = neg「拒清后讨论」「拒清后中途提交」。
    { name: "拒清状态下每轮都报", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared || !(g.conditions || []).length) return [];
      return g.clearRefusedAt ? ["拒清"] : r.detect(ctx);
    } }) },
    // 只认拒清痕迹 ⇒ 结清崩溃无痕的那一轮没人管(红队 250 BP-2)。证人 = pos「结清无痕」。
    { name: "只认拒清痕迹", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      return g && !g.cleared && g.clearRefusedAt ? r.detect(ctx) : [];
    } }) },
    // 批 253 二修:关旧开新不查旧批对照 ⇒ 旧批零对照放行。证人 = pos「同轮关旧开新、旧批零对照」。
    { name: "关旧开新不查旧批对照", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (g && !g.cleared && (g.priorClosedCount || 0) > 0) return r.detect({ ...ctx, batchGoal: { ...g, priorClosedCount: 0 } }).filter((h) => !/^本轮关旧批/.test(h));
      return r.detect(ctx);
    } }) },
    // 批 253 二修:不看 --arm 是否生效 ⇒ 结清被拒后接着 arm 被当成关旧开新。证人 = pos「结清被拒,&& 后 arm 没生效」。
    { name: "不看 arm 是否生效", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      let ops = [];
      try { ops = batchGoalOps(ctx); } catch { ops = []; }
      return ops.length && ops[ops.length - 1].op === "arm" ? [] : r.detect(ctx);
    } }) },
    // 退回批 250 的判定:不看执行顺序、不分读与执行 ⇒ 关旧开新与 grep 源码被误拦。证人 = 批 253 的两条 neg。
    { name: "退回批 250 的「跑过结清」判定(不看顺序、不分读与执行)", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared || !(g.conditions || []).length) return [];
      let t;
      try { t = ranClear({ actions: ctx.actions, batchGoal: null }); } catch { t = true; }
      return t ? ["结清没成"] : [];
    } }) },
    // 批 253e 真退回:⏸ 豁免重新要求「结清交代措辞」(253d 的紧贴判据:结清词后 0–6 字内失败词,或「拒清」/「无法结清」)。
    //   证人 = neg「253e:红队 253d BP-3——拒因超 6 字的如实交代」(真判据放行、变异体阻断)。
    { name: "豁免要求结清交代措辞(253d 紧贴判据)", apply: (r) => ({ ...r, detect: (ctx) => {
      const t = String(ctx.text || "").replace(/「[^」]*」|«[^»]*»|“[^”]*”|"[^"]*"/g, " ");
      const gap = "[^,\\uFF0C\\u3002;\\uFF1B:\\uFF1A!\\uFF01?\\uFF1F\\u3001\\n]";
      const fw = "没|不了|无法|未成功|未成|未通过|未过|未果|未能|拒|挡|失败|不通过|退出码\\s*[1-9]";
      const said = /拒清/.test(t)
        || new RegExp(`(?:--clear|结清|batch-goal\\s*clear)${gap}{0,6}?(?:${fw})`).test(t)
        || new RegExp(`无法${gap}{0,4}?(?:--clear|结清)`).test(t);
      return said ? r.detect(ctx) : r.detect({ ...ctx, text: String(ctx.text || "").replace(/⏸/g, "") });
    } }) },
    // ⏸ 不算合法停工 ⇒ 拒清后停下问用户被拦。证人 = 批 253 的 ⏸ neg。
    { name: "⏸ 不算合法停工", apply: (r) => ({ ...r, detect: (ctx) => r.detect({ ...ctx, text: String(ctx.text || "").replace(/⏸/g, "") }) }) },
    // 降成提示 ⇒ 结清没成那一轮不再逼模型处理(codex 250 实现复核第 5 条)。证人 = 两条 pos 的阻断标志。
    { name: "降成提示(blocking=false)", apply: (r) => ({ ...r, blocking: false }) },
    // 改看正文里的 --clear ⇒ 说一句「接下来 --clear」就报、真跑了反而不报。证人 = pos「拒清」与 neg「正文提到 --clear」。
    { name: "看正文不看动作", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared || !(g.conditions || []).length) return [];
      return /--clear/.test(String(ctx.text || "")) ? ["正文"] : [];
    } }) },
  ],
  cases: {
    pos: [
      // requires 契约分支的证人(2026-10-09 红队:CW 删除后全库再无夹具走到「必需通道缺席 ⇒ 未能判定」;
      //   本例刻意不供 batchGoal,K 声明了 requires ⇒ 契约层报未能判定并阻断。删掉那一分支本例即转红)
      { name: "K:batchGoal 未供 ⇒ 契约层未能判定", text: "收工。" },
      // 结清被拒:batch-goal 已留拒清痕迹,盘上仍武装。
      { text: "关账。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 批 253 二修(红队 BP-2):同轮关旧批、开新批,但旧批零对照。
      { text: "关账,开下一批。",
        bash: "git commit -m x\nnode --no-warnings scripts/batch-goal.mjs --clear\nnode --no-warnings scripts/batch-goal.mjs --arm 254 --cond 丙",
        batchGoal: { batch: "254", conditions: ["丙"], priorClosedBatch: "253", priorClosedConditions: ["甲", "乙"] } },
      // 批 253 二修(红队 BP-1):结清被拒,&& 后的 --arm 没生效,盘上仍是旧批。
      { text: "关账,开批 254。接下来改 scripts/y.mjs。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear && node --no-warnings scripts/batch-goal.mjs --arm 254 --cond 丙",
        batchGoal: { batch: "253", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 批 253 二修(红队 BP-4):带引号的环境变量前缀仍是执行。
      { text: "关账。", bash: 'BATCH_GOAL_BASH="C:/Program Files/Git/bin/bash.exe" node scripts/batch-goal.mjs --clear',
        batchGoal: { batch: "253", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // ⏸ 提到了结清被拒,但没写停工类别 ⇒ 不算合法停工(钉「⏸ 必须配理由」)。
      { text: "⏸ 需要你确认:结清被拒了。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "253", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 结清无痕:跑了 --clear,盘上仍武装且无拒清痕迹。
      { text: "提交并结清。", commit: true, bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"] } },
    ],
    neg: [
      // 武装批、只说话(瘦身前每轮提醒的主形态)。
      { text: "这个字段存的是批号。", batchGoal: { batch: "250", conditions: ["甲", "乙"] } },
      // 武装批、中途提交、零对照。
      { text: "第一部分已提交。", commit: true, batchGoal: { batch: "250", conditions: ["甲", "乙"] } },
      // 拒清后讨论拒因。
      { text: "判据失败是因为输出多了一行空白。",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 拒清后修一半先提交。
      { text: "修了一半先提交。", commit: true,
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 正文提到 --clear 但没跑。
      { text: "接下来跑 batch-goal --clear 关账。", batchGoal: { batch: "250", conditions: ["甲", "乙"] } },
      // 批 253(红队 BP-6):同轮关旧批、开新批——最后一次状态改动是 --arm,不算结清没成。
      { text: "条件1: 达成。条件2: 达成。关账,开下一批。",
        bash: "git commit -m x\nnode --no-warnings scripts/batch-goal.mjs --clear\nnode --no-warnings scripts/batch-goal.mjs --arm 251 --cond 丙",
        batchGoal: { batch: "251", conditions: ["丙"], priorClosedBatch: "250", priorClosedConditions: ["甲", "乙"] } },
      // 批 253(红队 BP-8):grep 读工装源码不是执行。
      { text: "看一下 clear 的实现。", bash: "grep -n -- --clear scripts/batch-goal.mjs",
        batchGoal: { batch: "250", conditions: ["甲", "乙"] } },
      // 批 253(红队 BP-7):结清被拒后标 ⏸ 并写明理由,属合法停工。
      { text: "⏸ 需要你确认:工作树里有不是本批做的改动,--clear 因此被拒;属『需你亲签』类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 批 253b(第二份红队 BP-3):三条诚实说法——闭集外的措辞、超 24 字的理由、退出码写法。
      { name: "253b:「结清没过」+ 分类名",
        text: "⏸ 需要你确认:结清没过,可执行判据 T2 挂了;属实打实阻断类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      { name: "253b:「batch-goal clear 被拒」+ 理由超 24 字",
        text: "⏸ 需要你确认:batch-goal clear 被拒,因为工作树里还留着上一批没提交的两处改动,要先处置;属『需你亲签』类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      { name: "253b:「--clear 退出码 2」+ 不可逆",
        text: "⏸ 需要你确认:--clear 退出码 2,要不要改判据?改判据这步不可逆。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // ── 批 253c(K-1):删裸「未」之后,八条诚实说法逐条钉住(三条已在上面,补齐余下五条)──
      { name: "253c K-1:「结清不了」",
        text: "⏸ 需要你确认:结清不了,工作树里有别人的改动;属实打实阻断类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      { name: "253c K-1:「无法结清」",
        text: "⏸ 需要你确认:无法结清,判据脚本读不到台账;属实打实阻断类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      { name: "253c K-1:「结清被挡」",
        text: "⏸ 需要你确认:结清被挡,要先处置未提交的改动;属『需你亲签』类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      { name: "253c K-1:「--clear 没通过」",
        text: "⏸ 需要你确认:--clear 没通过,可执行判据红了;属实打实阻断类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 保留的「未」完整说法(未成/未通过/未过/未果/未能):删掉它们同样是误拦,单钉一条。
      { name: "253c K-1:「结清未通过」——保留的「未」完整说法仍算交代",
        text: "⏸ 需要你确认:结清未通过,判据 T2 挂了;属实打实阻断类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // ── 批 253d(第三份红队 BP-7,阻断式误拦):不再按段落切,⏸ 与结清交代可以分段写 ──
      { name: "253d BP-7a:⏸ 单独成段,结清被拒写在下一段",
        text: "**⏸ 需要你确认**\n\n--clear 被拒:工作树里有两处不是本批做的改动;属『需你亲签』类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "253", conditions: ["甲"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      { name: "253d BP-7b:先交代结清被拒,后一段再标 ⏸",
        text: "结清被拒:工作树里有两处不是本批做的改动。\n\n⏸ 需要你确认:这两处保留还是丢弃?属『需你亲签』类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "253", conditions: ["甲"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 原 253b pos「结清失败写在 ⏸ 之外的另一段」:253d 起分段交代属诚实排版,翻为放行(与 BP-7b 同族)。
      { name: "253d:原 253b 段落 pos 翻面——结清没成写在另一段",
        text: "⏸ 需要你确认:发布是否翻 public,属不可逆。\n\n另:本批结清没成,回头再说。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "253", conditions: ["甲"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // ── 批 253e 汇总侧裁定(窄例外③ 判据过重):⏸ 豁免不再读「结清交代」措辞,与 S 的 marked 同口径 ──
      // 原 pos「为别的事标的 ⏸」翻面:有 ⏸ 且写了停工类别(不可逆)⇒ 放行。盘上批仍武装,K/S 下轮照常盯着。
      { name: "253e 裁定:为别的事标的 ⏸(原 pos 翻面)",
        text: "⏸ 需要你确认:clipboard/old 要不要删(不可逆)。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "253", conditions: ["甲", "乙"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // codex 253 合并复核那条漏放夹具(⏸ 为别的事 + 以为本轮结清成功)**翻 neg,接受**:
      //   后果是用户看着一个未关的批停在 ⏸ 上(方向安全);字面判据误拦的是如实交代拒清的阻断,四轮修不稳。
      //   253c K-1「尚未决定…本轮结清」、253d BP-1「本轮结清,没动 …」两条同族 pos 一并删去(同一接受面)。
      { name: "253e 裁定:⏸ 为别的事 + 顺口「本轮结清」(接受的漏放,原 pos 翻面)",
        text: "⏸ 需要你确认:发布是否翻 public,属不可逆。本轮结清。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "253", conditions: ["甲"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // 红队 253d BP-3(阻断误拦):拒因写在 --clear 与「被拒」之间超 6 字 ⇒ 253d 紧贴判据拦;253e 起放行。
      //   本条是变异「豁免要求结清交代措辞」的证人。
      { name: "253e:红队 253d BP-3——拒因超 6 字的如实交代",
        text: "⏸ 需要你确认:--clear 因为工作树有两处未提交改动被拒;属需你亲签类。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "253", conditions: ["甲"], clearRefusedAt: "2026-09-17T01:00:00Z" } },
      // codex 253 合并复核:echo 打印一行结清命令不是执行。
      { text: "命令长这样。", bash: "echo node scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "250", conditions: ["甲", "乙"] } },
      // 结清成功(盘上已结清)⇒ 归 K0。
      { text: "条件1: 达成。条件2: 达成。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲", "乙"] } },
    ],
  },
};

/** K0 的关账/未武装判定尾段(共享零件):真 detect 与簿记豁免的两支变异共用,
 *  保证变异体消息逐字一致、只 differ 豁免那一行(G 项验收台教训)。 */
function k0Core(ctx) {
  const g = ctx.batchGoal;
  if (g?.cleared && g.closedCount > 0 && properClose(ctx) && !ranArm(ctx)) {
    const done = confirmedConditions(ctx.text);
    let win = null;
    try { win = ctx.window(); } catch { win = null; }
    if (win) for (const n of confirmedConditions(win.text)) done.add(n);
    const covers = (set, n) => { for (let i = 1; i <= n; i++) if (!set.has(i)) return false; return true; };
    if (covers(done, g.closedCount)) return [];        // 正常关账,放行
  }
  if (g?.cleared && properClose(ctx) && !(g.closedCount > 0)) {
    return ["**关账证据取不到**(台账末行不是本批的 clear 行,或读不出)"];
  }
  return [g?.cleared ? "已结清后又动工作面(= 新批未武装)" : "从未武装"];
}
/** 簿记面判定(共享):写面仅触债务台账。 */
// ⚠️ 2026-08-27(D90):**并入 Bash 面的写目标**。原式只看 `ctx.writes`,而 `ctx.writes`
//   **只收 Write/Edit/NotebookEdit**(尽管它的头注写着「加上 Bash 里可判定的写目标」——
//   注释在说谎,同批已改正)。后果:我用 node heredoc 改 `docs/gate-debts.md` 时
//   `writes` 是**空的** ⇒ 簿记豁免够不着 ⇒ 落进「零写面纯提交不豁免」那一支
//   ⇒ **每次「改台账 + 提交」都撞 K0**。而改台账正是这套验收机制自身的簿记,
//   逼它为此开新批 = 纯 arm/clear churn(这条豁免的立法动机原话)。
//   判据只在**豁免侧**并入 Bash 目标(窄):不动 `ctx.writes` 本身,避免一次性改变
//   I/P/K0 三条规则的触发面——那属另一件事,已登记 D90 的余项。
/** 任意像路径的东西。给 `bashWriteTargets` 用:本豁免要的是**全部**写目标
 *  (才谈得上 `every`),不是「只挑我关心的那些」——后者会让
 *  「同时改了台账和判据」的一轮看起来像纯簿记。 */
const ANY_PATH_RE = /[\w./-]+\.[A-Za-z0-9]+$/;

/** 「整提交」判定(批 253b,第二轮红队 BP-4):正则版漏掉 `git add -u`、`git commit --all`、
 *  `git add -v -A`、`git -C "带空格 路径" add -A`、`git add :/`,又会把 `-m "fix -a bug"` 的**正文**
 *  当成 `-a`(BP-13,阻断式误拦)。根因同一条:**拿正则读命令行的旗标语法**。
 *  改为分词后按 git 的选项文法走一遍:引号里的 token 一律当**值**(永远不是旗标),
 *  短旗标簇逐字符判,取值旗标(`-m/-F/-C/-c/-t/-S`)吃掉下一个 token。
 *  批 253c(codex K0-1,阻断式误拦):见 `-u`/`-A` 就判整提交、见 `:/…` 一律当仓根,于是
 *  `git add -u docs/product-diary.md`、`git add :/docs/product-diary.md` 这种**定向**补日记被阻断。
 *  旗标不是 pathspec:`-u`/`-A` 说的是「按什么口径挑」,**挑哪些**由后面的 pathspec 决定;
 *  给了具体 pathspec 就是定向,与 `git add <目录>`(CEILING ①)同族。`:/` 只有**单独成 token**
 *  才是仓根,`:/path/to/file` 是从仓根起算的**定向** pathspec。
 *  CEILING:①`git add <目录>`(如 `git add scripts/`)不算整提交——它是定向的,与 `.`/`:/` 不同族;
 *  ②别名/`-c alias.x=!cmd` 不解析(蓄意形态);③只看 git 自己,不追 `xargs git add -A` 这类外壳;
 *  ④批 253c 新增:`git add -u <宽目录>`(如 `git add -u docs/`)按定向算 ⇒ 若那个目录下还压着
 *    前几轮的改动,簿记豁免够得着——与 CEILING ① 同一残余(缺「暂存区里到底有啥」的证据),
 *    要分辨得让 ctx 带 `git diff --cached --name-only`,归下一批;
 *  ⑤`:(glob)`/`:(top)` 等魔法 pathspec 解析不了,一律仍当整提交(fail-closed)。
 *  批 253d(第三轮红队 BP-4,漏放):`git add -A ':!clipboard'`、`git add -A -- ':^scripts/lib'` 被算成定向——
 *  排除式 pathspec(`:!x` / `:^x` / `:(exclude)x`)说的是「**除了**哪些」,不是「挑哪些」;只有排除式时
 *  git 按「全部减去排除」暂存 ⇒ 整提交。现:排除式不计入定向 pathspec 个数;只有排除式(无论带不带 -A/-u)⇒ 整提交。
 *  `:(exclude)` 原先落进「魔法 ⇒ 整提交」,口径不变;`:(top,exclude)` 这类组合魔法仍走 fail-closed。
 *  批 253d(BP-8,阻断式误拦):heredoc **正文**里写着「git add -u」被分词当成命令。现:分词前剥掉 heredoc 正文
 *  (`<<X`/`<<'X'`/`<<"X"`/`<<-X` 标记之后的下一行起,到独立一行 `X` 为止)。标记行本身**保留**——
 *  `cat > f <<EOF && git add -A` 的尾巴是真命令;共享的 `stripHeredoc` 会连标记行尾一起吞,故这里不复用它。
 *  找不到独立一行的结束符 ⇒ 不剥(fail-closed:宁可照旧分词)。
 *  CEILING ⑥:引号串里恰好出现 `<<X` 字样(如 `-m "a <<EOF"`)且后面真有一行 `X`,中间的行会被剥——蓄意形态,不管。
 *  @param opts.directed 默认 true=认「给了 pathspec 就是定向」;变异体传 false 退回旧口径。
 *  @param opts.excludeAware 默认 true=排除式不算定向;false 退回 253c 口径(排除式按普通路径计数)。
 *  @param opts.heredocAware 默认 true=剥 heredoc 正文;false 退回 253c 口径。
 *  @param opts.interpAware 默认 true=只剥数据 heredoc、解释器属主的正文照常分词(批 253e BP-2);false 退回 253d 口径(一律剥)。
 *  @param opts.shellOnly 默认 true=只有**壳**属主的正文照常分词(批 253f BP-2);false 退回 253e 口径(node/python 等语言解释器也算)。
 *  @param opts.wrapAware 默认 true=壳属主判定前跳过包装头(env/sudo/timeout…);false 时包装头本身当属主(变异体专用)。
 *  `gitWholeCommit.legacy`:变异体专用的**默认口径覆盖**(同步设、finally 复原)。簿记豁免 `k0Bookkeeping`
 *  在 K0 写分区之外、按默认口径调本函数——变异要真退回旧判据(两个方向都作证),只能从默认值这一侧拧。 */
const gitWholeCommit = (cmd, opts = {}) => {
  const { directed = true, excludeAware = true, heredocAware = true, interpAware = true, shellOnly = true, wrapAware = true } = { ...(gitWholeCommit.legacy || {}), ...opts };
  const base = (t) => String(t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
  // heredoc 正文剥离:保留标记行(含其尾巴),删掉**数据** heredoc 的正文行与结束符行。
  // 批 253e(第四份红队 BP-2,漏放):253d 一律剥 ⇒ `bash <<'EOF'\ngit add -A\ngit commit -m debt\nEOF` 整提交认不出。
  //   现:属主(标记所在行、`<<` 之前最后一段的段头,剥 VAR=值 前缀、取 basename 去 .exe)是**壳**,
  //   或标记行尾巴经单管道 `|` 喂给壳(`cat <<EOF | bash`)⇒ 正文照常 shell 分词;其余一律按数据剥。
  //   壳正文里再嵌的数据 heredoc 递归照剥(`bash <<A` 里的 `cat >> f <<B`)。
  // 批 253f(第五份红队 BP-2,阻断式误拦):253e 的属主表取的是 W 的「会执行」全集(含 node/python/ruby/perl…),
  //   而那些是**另一门语言**:`// D141 讲的是 git commit -a`、`# D141: git commit -a 形态` 是注释/字符串,
  //   拿 shell 分词读就成了整提交,簿记轮被阻断。现:只有壳(SHELL_HEAD)属主的正文按 shell 分词;
  //   node/bun/deno/python/ruby/perl/php 等语言解释器的正文一律按数据剥。
  //   壳前的包装头(env/sudo/nohup/time/timeout/exec/command/xargs/wsl)连同其旗标与时长参数先跳过——
  //   `env X=1 bash <<EOF`、`cat <<EOF | timeout 30 sh` 属主仍是壳。
  //   本函数自带属主表,**不再引用 RULE_W._w**(W 的段头表与本判据语义不同:W 问「会不会执行」,这里问「正文是不是 shell」)。
  //   方向:两向同价——认错成壳 ⇒ 注释/字符串被当命令 ⇒ 簿记轮被误拦;认错成数据 ⇒ 真整提交漏认 ⇒ 簿记豁免漏放。
  //   CEILING ⑦:属主写在上一行续行(`bash \`换行`<<EOF`)判不出,按数据剥——罕见排版,不管。
  //   CEILING ⑧(批 253f 残余):`node <<EOF` 正文里用 execSync/child_process 跑 `git add -A` 看不见——
  //     要从另一门语言里读出 shell 调用,罕见且近蓄意(诚实写法是直接在壳里敲),不管。
  const SHELL_HEAD = /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)$/i;
  const LEGACY_INTERP_HEAD = /^(?:node|bun|deno|tsx|ts-node|bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|command|eval|exec|source|ssh|wsl|env|nohup|time|timeout|watch|xargs|iex|invoke-expression|start-process|sudo|su|npx|python\d*(?:\.\d+)?|py|perl|ruby|php|osascript)$/i;   // 253e 口径快照(变异体专用)
  const WRAP_HEAD = /^(?:env|sudo|nohup|time|timeout|exec|command|xargs|wsl)$/i;
  const isInterp = (seg) => {
    const toks = stripQuoted(String(seg || "")).trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^\w+=/.test(toks[i])) i++;
    if (!shellOnly) return LEGACY_INTERP_HEAD.test(base(toks[i] || ""));
    while (wrapAware && i < toks.length && WRAP_HEAD.test(base(toks[i]))) {
      i++;
      while (i < toks.length && (/^-/.test(toks[i]) || /^\w+=/.test(toks[i]) || /^\d+(?:\.\d+)?[smhd]?$/.test(toks[i]))) i++;
    }
    return SHELL_HEAD.test(base(toks[i] || ""));
  };
  const dropHeredoc = (s) => s.replace(/(<<-?[ \t]*(['"]?)(\w+)\2([^\n]*))\n([\s\S]*?^[ \t]*\3[ \t]*$)/gm,
    (m, head, _q, _tag, tail, rest, offset, str) => {
      if (!interpAware) return head;
      const lineStart = str.lastIndexOf("\n", offset) + 1;
      const ownerSegs = segments(str.slice(lineStart, offset));
      const owner = ownerSegs.length ? ownerSegs[ownerSegs.length - 1] : "";
      const pipedTo = stripQuoted(tail).split(/(?<!\|)\|(?!\|)/).slice(1);
      if (isInterp(owner) || pipedTo.some(isInterp)) return head + "\n" + dropHeredoc(rest);
      return head;
    });
  const tok = (s) => {
    const out = []; let cur = "", has = false, q = false, quote = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && quote !== "'" && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
      if (quote) { if (c === quote) quote = null; else cur += c; has = true; continue; }
      if (c === '"' || c === "'") { quote = c; q = true; has = true; continue; }
      if (/\s/.test(c)) { if (has) out.push({ t: cur, q }); cur = ""; has = false; q = false; continue; }
      cur += c; has = true;
    }
    if (has) out.push({ t: cur, q });
    return out;
  };
  const VALUE_LONG = /^--(?:message|file|reuse-message|reedit-message|fixup|squash|author|date|template|cleanup|trailer|pathspec-from-file|gpg-sign|chmod|pathspec-file-nul)$/;
  const fromGit = (toks) => {
    let i = 0;
    while (i < toks.length) {                       // 全局选项:-C <路径> / -c <k=v> / --git-dir <p> / --no-pager
      const x = toks[i];
      if (x.q) break;
      if (/^-[Cc]$/.test(x.t) || /^--(?:git-dir|work-tree|namespace|exec-path|config-env|super-prefix)$/.test(x.t)) { i += 2; continue; }
      if (/^-/.test(x.t)) { i++; continue; }
      break;
    }
    const sub = toks[i]; if (!sub || sub.q) return false;
    const rest = toks.slice(i + 1);
    if (sub.t === "add") {
      // 批 253c:先分「旗标」与「pathspec 操作数」,再一次性判——旧写法在循环里见旗标就 return,
      //   于是后面跟不跟 pathspec 根本没机会被看见。
      let broad = false;      // -A / -u / --all / --update:全量口径旗标
      let root = false;       // . / ./ / :/ / * :落到仓根的 pathspec
      let magic = false;      // :(glob) 之类解析不了的魔法 pathspec ⇒ fail-closed
      let colonPath = false;  // :/path:旧口径当根、新口径算定向(变异体靠它退回)
      let paths = 0;          // 具体 pathspec 的个数
      let excludes = 0;       // 排除式 pathspec(:!x / :^x / :(exclude)x)的个数(批 253d BP-4)
      let dashdash = false;
      for (let j = 0; j < rest.length; j++) {
        const x = rest[j];
        if (!dashdash && !x.q) {                    // 引号里的一律是**值**(路径),永远不是旗标
          if (x.t === "--") { dashdash = true; continue; }
          if (/^--(?:all|no-ignore-removal|update)$/.test(x.t)) { broad = true; continue; }
          if (/^-[A-Za-z]*[AuU][A-Za-z]*$/.test(x.t)) { broad = true; continue; }   // -A / -u / -vA / -v -A
          if (VALUE_LONG.test(x.t)) { j++; continue; }                              // --pathspec-from-file <f> 等取值旗标
          if (/^-/.test(x.t) && x.t !== "-") continue;                              // 其余旗标(-v/-n/--dry-run…)
        }
        if (x.t === "." || x.t === "./" || x.t === ":/" || x.t === "*") { root = true; continue; }
        if (excludeAware && /^:(?:[!^]|\(exclude\))/.test(x.t)) { excludes++; continue; }   // 批 253d BP-4:排除式不算定向
        if (/^:\(/.test(x.t)) { magic = true; continue; }
        if (/^:\//.test(x.t)) colonPath = true;
        paths++;
      }
      if (root || magic) return true;
      if (excludes > 0 && paths === 0) return true; // 只有排除式 ⇒ 「全部减去排除」= 整提交
      if (!directed) return broad || colonPath;     // 旧口径:见 -u/-A 或 :/… 即判整提交
      if (broad) return paths === 0;                // `-u`/`-A` 后没给 pathspec ⇒ 全量;给了 ⇒ 定向
      return false;
    }
    if (sub.t === "commit") {
      for (let j = 0; j < rest.length; j++) {
        const x = rest[j];
        if (x.q) continue;                       // 引号里的是 -m 正文之类的**值**,不是旗标(BP-13)
        if (x.t === "--") break;
        if (/^--(?:all|patch)$/.test(x.t)) return /^--all$/.test(x.t);
        if (VALUE_LONG.test(x.t)) { j++; continue; }
        if (/^--/.test(x.t)) continue;
        if (/^-/.test(x.t)) {
          const chars = x.t.slice(1);
          for (let k = 0; k < chars.length; k++) {
            const ch = chars[k];
            if (ch === "a") return true;
            if ("mFCctSu".includes(ch)) { if (k === chars.length - 1) j++; break; }   // 取值旗标:其后是值
          }
        }
      }
      return false;
    }
    return false;
  };
  for (const seg of segments(heredocAware ? dropHeredoc(String(cmd)) : String(cmd))) {
    const toks = tok(seg);
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].q || !/^git$/i.test(base(toks[i].t))) continue;
      if (fromGit(toks.slice(i + 1))) return true;     // 一段里可能有多个 git(`git status & git add -A`)
    }
  }
  return false;
};
gitWholeCommit.legacy = null;   // 只给变异体用;生产恒为 null

const k0Bookkeeping = (ctx) => {
  // 批 253 二修(红队 BP-5):本轮用 `git add -A / --all / -u / .` 或 `git commit -a/--all` 提交
  //   ⇒ 提交里可能夹带前几轮的非簿记改动,不豁免。判据见 `gitWholeCommit`(批 253b 从正则换成分词)。
  if ((ctx.bashCmds || []).some((c) => gitWholeCommit(c))) return false;
  const norm = (w) => String(w).replace(/\\/g, "/");
  // 批 253b(第二轮红队 BP-5):memory 笔记(`.claude/projects/*/memory/**.md`,与 I 同口径)不是工作面,
  //   自然也不占簿记豁免的名额——否则「补 memory + 记债表」会因为混入 memory 而落回拦截侧。
  const fromTools = (ctx.writes || []).map(norm).filter((w) => !RULE_I._i.isMemoryNote(w));
  // ⚠️ 头两版都写错,记在这:①第一版传了 `JSON.stringify(ctx.actions)`,而本函数要的是
  //   **单条命令串**;②同时漏了第二参 `pathRe` ⇒ 函数内 `pathRe.test` 抛 TypeError
  //   ⇒ **被我自己的 catch 吞成空数组**,豁免安静地不工作、还看不出来。
  //   「catch 吞掉真错」比缺功能贵:它把「坏了」伪装成「没命中」。
  //   故此处 catch 只兜**单条命令**的解析失败,不整体吞;且失败 ⇒ 不豁免(fail-closed)。
  const fromBash = [];
  for (const [ci, cmd] of (ctx.bashCmds || []).entries()) {
    try { for (const t of bashWriteTargets(cmd, ANY_PATH_RE, { dialect: ctx.bashDialects?.[ci] })) { const p = norm(t); if (!RULE_I._i.isMemoryNote(p)) fromBash.push(p); } }
    catch { return false; }   // 解析不了就不豁免,而不是当成「没写」
  }
  const all = [...fromTools, ...fromBash];
  // 批 253(红队 BP-10):产品日记与名词日记同属收尾簿记,关账后补一行不算未武装动工;混入其他路径照拦。
  return all.length > 0 && all.every((w) => /docs\/(gate-debts|product-diary|noun-diary)\.md$/.test(w));
};

const RULE_K0 = {
  id: "K0",
  _k0: {
    /** 工作面写入 = `ctx.writes` 去掉 memory 笔记(批 253b;口径与 I 项 `isMemoryNote` 同一实现)。 */
    workWrites(ctx, { memoryExempt = true } = {}) {
      const ws = (ctx.writes || []).map((w) => String(w).replace(/\\/g, "/"));
      return memoryExempt ? ws.filter((w) => !RULE_I._i.isMemoryNote(w)) : ws;
    },
  },
  // 批 250:关账轮也阻断——分两轮关账时,只结清的那一轮没有提交,原判据只认提交就只剩提示。
  blocking: (ctx) => ctx.didCommit() || (() => { try { return ranClear(ctx); } catch { return false; } })(),
  law: "AGENTS.md#恒定条款",
  requires: ["batchGoal"],
  // 判据取**最结构化的近似**:本轮动了工作面(写文件/提交)就该先有完成条件。
  // 纯问答、纯调查没有写动作 ⇒ 不触发,本项不会退化成仪式。
  detect: (ctx) => {
    const g = ctx.batchGoal;
    const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
    if (armed) return [];                                  // 已武装 ⇒ 不归 K0(批 250 后 K 只管「结清没成」,做一半停下归 S)
    // ⚠️ **批 250:关账覆盖检查前移到「没动工作面」与「债表簿记」两个早退之前**(codex 250 复核实指)。
    //   批 249 把覆盖检查放在两个早退之后 ⇒ 两条诚实遗忘照样无人管:
    //   ①分两轮关账——上一轮提交、本轮只 `--clear`、零对照:本轮无写无提交,第一个早退直接放行;
    //   ②本轮只改债表 + 提交 + 结清、零对照:簿记豁免先放行(D135 残余⑤)。
    //   覆盖检查只在「确实关掉一个带条件的批、且本轮非同轮武装」时生效;其余关账轮仍走下方原流程。
    const clearing = (() => { try { return ranClear(ctx); } catch { return false; } })();
    // 批 253(红队 BP-11):同批号重武装(例如改判据时 `--arm 250 --force`,或一轮做完的小批)不算现造证据;
    //   只有本轮 --arm 了**别的**批号,才回落原判。
    //   批 253 二修:批号在原串上取再剥引号(红队 BP-7);本轮第一次 --arm 之前已经 --clear 过 ⇒ 「先零对照结清、再同号重开」,
    //   不认同号重武装(BP-6)。
    let ops = [];
    try { ops = batchGoalOps(ctx); } catch { ops = [{ op: "arm", id: "?" }]; }
    const firstArm = ops.findIndex((o) => o.op === "arm");
    const clearBeforeArm = firstArm > 0 && ops.slice(0, firstArm).some((o) => o.op === "clear");
    const armedOther = clearBeforeArm || ops.some((o) => o.op === "arm" && o.id !== String(g?.batch ?? ""));
    // 批 253(红队 BP-4):结清了却从台账补不出条数 ⇒ 不论本轮有没有写,都报证据取不到。
    if (clearing && g?.cleared && !(g.closedCount > 0) && !armedOther) {
      return ["**关账证据取不到**(台账末行不是本批的 clear 行,或读不出)"];
    }
    if (clearing && g?.cleared && g.closedCount > 0 && !armedOther) {
      const done = confirmedConditions(ctx.text);
      let win = null;
      try { win = ctx.window(); } catch { win = null; }
      if (win) for (const n of confirmedConditions(win.text)) done.add(n);
      for (let i = 1; i <= g.closedCount; i++) {
        if (!done.has(i)) return [`关账但批 ${g.batch ?? "?"} 的 ${g.closedCount} 条完成条件未逐条对照(本轮与批窗口内缺条件${i})`];
      }
      return [];
    }
    // ⚠️ `ctx.writes`(写**动作**)不是 `ctx.written`(写进去的**正文**)——
    //   我第一版写成了后者,于是「改了个文件但没往里写字」判为没动工作面。
    //   两个名字差一个字母而语义完全不同,迁移时值得每次确认一遍。
    // 批 253b(第二轮红队 BP-5):**memory 笔记不算工作面**。用户 2026-09-17 已签「memory 笔记不是工具载体」
    //   (I 项同口径,`.claude/projects/<proj>/memory/**.md`,带 `..` 段不放行;memory 下的 `.mjs` 仍算)。
    //   同一条理由在 K0 上成立:把一句用户原话记进 memory 不是「动工作面」,逼它为此开批 = 纯 arm/clear churn。
    //   只挪工作面判据,不碰 `didCommit`——提交里有什么无从核,照旧 fail-closed。
    if (!RULE_K0._k0.workWrites(ctx).length && !ctx.didCommit()) return []; // 没动工作面 ⇒ 不管
    // ⚠️ **债表簿记豁免**(2026-08-26,批 106;fp 台账「批间补救」形态四犯的兑现修法):
    //   本轮写面**仅**触 docs/gate-debts.md(债务台账)⇒ 不算未武装动工——
    //   给已发生的事登记欠账正是验收机制自身的簿记,逼它开新批=纯 arm/clear churn
    //   (08-23 两笔 claimed_fp + 08-26 两撞,四犯)。边界:任何其他路径混入写面即照拦
    //   (「顺手把修法也做了」不属簿记);零写面纯提交不豁免(commit 内容无从核,fail-closed)。
    if (k0Bookkeeping(ctx)) return [];
    // ⚠️ **关账轮豁免**(2026-08-27,连撞 5 轮后闸自己提示「反复撞同一项说明判据有问题」)。
    //   机械成因:正常关账的序列是 `--clear` **然后** `git commit`(把关账写入提交),
    //   于是这一轮「已结清 + 动了工作面」⇒ K0 必响。**两种顺序都躲不掉**:
    //   先提交后清,K 又要逐条对照。⇒ 这不是我每次都犯错,是**判据把关账本身算成了违规**。
    //   判据用**动作面**:本轮真跑过 `batch-goal --clear`(`ranClear`,W 项一直在用的那条)
    //   ⇒ 这是关账轮,随行的提交就是关账提交,不该要求它先武装新批。
    //   **残余(照实写)**:同一轮在 `--clear` 之后再干别的活会一并被豁免;
    //   但下一轮只要有写动作且无武装批,K0 照样响 ⇒ 残余窗口是**一轮**。
    //   代价不对称:现状是**每次关账都误报**(高频误报的终局是有人去关逃生口),
    //   换来的漏放窗口只有一轮且下轮自愈。
    // ⚠️ **批 249:关账轮不再直接放行**(codex 249 v2 复核实指,会话内探针实跑坐实;证人即下方 pos「批 249 漏洞证人」)。
    //   原写法「本轮跑过 --clear ⇒ return []」为修「每次正常关账都误报」而加,却把下面 k0Core 的
    //   「条件必须逐条裁过」在关账轮整段短路 ⇒ 开批、零对照、同轮提交 + 结清,K/K0/S 三项全放行。
    //   **后一个修复让前一个失效**;反例表里那条「关账。+ --clear + commit ⇒ 放行」把漏洞写成了预期,
    //   所以自测一直绿。那次误报的根因(结清后 conditions 被清空)已由台账补 closedConditions 解决,
    //   早退不再需要。现改为关账轮照走 k0Core:确实关掉一个带条件的批且本轮 ∪ 窗口逐条裁过才放行。
    //   天花板:k0Bookkeeping 在本行之前,「只改债表 + 提交 + 零对照结清」仍被簿记豁免放过。
    //   **不走 k0Core 的 properClose**:2026-08-27 那 5 轮误报的关账序是「先 --clear、再 git commit」,
    //   提交排在结清之后,次序判据不认——这正是当年加早退的原因。(批 243 起 batch-goal 在有未提交改动时
    //   拒清,常态已变成先提交再结清;但工作树干净时「先结清再提交」仍走得通,故仍不依赖次序。)
    //   关账轮里结清本身就是关账动作,直接查覆盖;拿不到条数或同轮又武装,才回落 k0Core 原判。比旧早退严格。
    //   批 249 复核(codex 与红队)确认的**既有**残余,均修前即放行、本修法未引入,已登记债表:
    //   窗口裁决不带批号(上一批的「条件N:达成」能顶替本批)、提交写法藏在子壳里 didCommit 看不见、
    //   否定句与围栏里的判据词也算裁决、关账轮的「未达成」无 ⏸ 也算、阻断是事后的。
    //   (批 250:覆盖检查已前移到本函数开头;走到这里的关账轮是拿不到条数或同轮武装,回落原判。)
    if (clearing) return k0Core(ctx);
    // ⚠️ 「已结清」**不等于**此后无需武装。旧实现 cleared ⇒ K 与 K0 双双不跑,
    //   而 `--clear` 正是每批收尾动作 ⇒ 此后每批都在「零验收标准且无闸」下提交,
    //   静默到有人重新 --arm 为止(grill:edge-cases 与 codex 055 独立同时报出)。
    // ⚠️ **正常关账才放行,而「正常」必须包含「条件真的被逐条裁过」**(grill E1)。
    //   三个条件缺一不可:①确实关掉过一个**有条件**的批(closedCount,来自只追加台账,
    //   因为 `--clear` 会把 conditions 清空);②`--clear` 在最后一次写之后(次序对);
    //   ③正文里给出的裁决**覆盖**那批的条数。
    //   缺③的代价实测过:标准关账序走完,K 因 `cleared` 直接返回空、K0 被豁免
    //   ⇒ 整族静默,而「零对照关账」与「逐条对照后关账」的输出**逐字节相同**。
    //   裁决取「本轮 ∪ 批窗口」——逐条对照通常写在关账**前一轮**。
    // `!ranArm(ctx)`:同一轮既武装又结清 ⇒ 关账证据是现造的,不认(见 ranArm 头注)。
    // 判定尾段(逐一验 1..N / 「关账证据取不到」单列措辞)已抽 k0Core——
    // 与簿记豁免的两支变异共用,保证变异只 differ 目标行;史注随零件上移。
    return k0Core(ctx);
  },
  // ⚠️ **豁免必须要求「真有过一个带条件的批,且它现在关了」**(grill:architecture P1,实测)。
  //   原写法只问 `properClose`(本轮 `--clear` 在最后一次写之后),不问有没有批 ⇒
  //     `从未武装 + 写文件 + --clear` ⇒ **K0 被豁免、K 本就不响 ⇒ 整族静默**。
  //   也就是说:在最后一次写之后随手跟一句 `--clear`,从来不用武装、一条条件都不用裁,
  //   全闸闭嘴。这把「新增 --clear 阻断」那条修法从另一侧整个绕开了。
  //   ⇒ 现在要求 `cleared === true` **且** `conditions.length > 0`:确实存在过一个
  //     有验收标准的批,而不是拿一句空 `--clear` 当万能钥匙。
  // 【已登记未修】grill P1 的第 5 行(`已结清 + 又写 + 再 --clear`)仍被豁免:
  //   它与「合法的重复关账」在现有状态里**不可区分**(都是 cleared + conditions 非空)。
  //   要分开得记住「这些条件是哪一轮裁的」,那是给 batch-goal 加时点字段的事,另立一批。
  // ⚠️ **证据取自台账,不取自被清空的状态**(2026-08-20 二次实撞)。
  //   我第一版写 `conditions.length > 0`,而 `--clear` 会把 conditions **整个丢掉**
  //   ⇒ 豁免永远不成立 ⇒ 每次正常关账都误报。
  //   而它没被测出来,是因为 grill 的矩阵和我的复测都用了
  //   `{conditions:["甲"], cleared:true}` —— **真实系统永远不会产生的状态**。
  //   夹具与现实不符,「验证通过」就是假的;这比判据写错更隐蔽。
  //   现在改用 `closedCount`(由只追加台账 `.batch-goal.jsonl` 的 clear 行补回):
  //   它证明「确实关掉过一个**有条件的**批」,而空 `--clear` 造不出这个证据。
  // ⚠️⚠️ **豁免必须要求「条件真的被逐条裁过」**(2026-08-20 grill:edge-cases E1,实测)。
  //   我上一版只要求「确实关掉过一个有条件的批 + 次序正确」,于是标准关账序
  //   (`--arm 3 条` → 改文件 → `commit` → `--clear`,正文里**一条裁决都不写**)
  //   走完之后:盘上已 cleared ⇒ **K 的 detect 第一行直接返回空**;
  //   而 K0 被这条豁免放行 ⇒ **整族静默**。实测两种输入输出**逐字节相同**:
  //     零对照关账     ⇒ G
  //     逐条对照后关账 ⇒ G
  //   **这道闸在关账那一刻鉴别力为零**,而它存在的全部理由就是防「干着干着就宣布做完」。
  //   grill 的判词更狠:修 `bbbe1a2` 之前那个「每次关账都误报」的 bug,
  //   **同时是唯一在拦这个形态的东西**——豁免一修好,遮羞布就被掀了。
  //   ⇒ 现在第三个条件:正文里给出的裁决条数必须**覆盖**被关掉那批的条数。
  //     裁决取「本轮 ∪ 批窗口」(窗口是同批刚接上的 `ctx.window()`),
  //     因为逐条对照通常写在关账**前一轮**。
  //   ⚠️ 判据**必须放在 `detect` 里,不能放在豁免里**:注册表给 `kind:"action"` 豁免的是
  //   **剥掉文本面的 ctx**(`{...ctx, text: ""}`),那是「阻断项不认文本豁免」的纵深防御。
  //   我第一版把裁决计数写进豁免 ⇒ text 恒空 ⇒ 豁免恒不成立 ⇒ 每次关账都拦,又反了。
  //   而对 K/K0 来说,**逐条裁决的正文本身就是交付物**,不是「一句话开脱」——
  //   这是它与 B/C/N 那族「拿文本冒充动作」的关键区别,故放进 detect 是对的。
  exempts: [],
  message: (hits, ctx) => /^关账但/.test(String(hits[0] || ""))
    // 批 249 红队 BP-6:关账漏对照这一支原样套用「去 --arm」的出路,照做会让盘上变武装态、K0 反而放行。
    ? `${hits[0]}${ctx.didCommit() ? "——**且已提交**" : ""}。\n` +
      `      出路:在本轮逐条补写「条件N:达成/未达成/不适用」+ 一句证据(上一批的裁决不算数)。\n` +
      `      **不要**为了消掉本条去 --arm 新批——那只是换一个状态让本项看不见,条件照样没对照。`
    : `本轮动了工作面却**未武装完成条件**(${hits[0]})` +
    `${ctx.didCommit() ? "——**且已提交,收尾无验收标准**" : ""}。\n` +
    `      开工时先立,收尾时逐条对照:\n` +
    `      node --no-warnings scripts/batch-goal.mjs --arm <批号> --cond "…" --cond "…"\n` +
    `      依据:当日多次「干着干着就宣布做完」,而从未在开工时定义过什么算完成。\n` +
    `      (官方 /goal 是内建 UI 命令、模型调不了——2026-08-19 实测,故由本仓等价物承担)`,
  mutations: [
    // 分支①:cleared 也算已武装 ⇒ 每批收尾之后整闸静默(旧实现的真 bug)
    { name: "已结清算作已武装", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (g && Array.isArray(g.conditions) && g.conditions.length) return [];
      if (!ctx.writes.length && !ctx.didCommit()) return [];
      return ["从未武装"];
    } }) },
    // 分支③:去掉 properClose ⇒ 豁免退化成「盘上 cleared 且上批有条件」,
    //   而那是**上一批关账后一直为真的常驻状态** ⇒ K0 对此后每个未武装会话永久闭嘴。
    //   grill E2 实测这在补正例之前是**等价变异**(全套夹具零反应)。
    { name: "去掉正常关账的次序判据", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (g === undefined) return [];
      const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
      if (armed) return [];
      if (!ctx.writes.length && !ctx.didCommit()) return [];
      if (g?.cleared && g.closedCount > 0) {
        const done = confirmedConditions(ctx.text);
        if (done.size >= g.closedCount) return [];
      }
      return [g?.cleared ? "已结清后又动工作面(= 新批未武装)" : "从未武装"];
    } }) },
    // 分支⑥(批 249):恢复「关账轮直接放行」的早退 ⇒ 零对照关账整族静默。证人 = pos「批 249 漏洞证人」。
    { name: "关账轮直接放行(批 249 前的早退)", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
      if (armed) return [];
      if (!ctx.writes.length && !ctx.didCommit()) return [];
      if (k0Bookkeeping(ctx)) return [];
      if ((() => { try { return ranClear(ctx); } catch { return false; } })()) return [];
      return k0Core(ctx);
    } }) },
    // 批 253b(第二轮红队 BP-4):整提交只认正则老口径 ⇒ `git add -u`/`commit --all`/`add -v -A`/
    //   `-C "带空格 路径"`/`add :/` 全漏认。证人 = pos「253b 整提交五形」。
    { name: "253b BP-4 退回:整提交判据用旧正则(add -u / commit --all / -v -A / 带空格路径 / :/ 漏认)",
      apply: (r) => ({ ...r, detect: (ctx) => {
        const OLD = /\bgit\s+(?:-[Cc]\s+\S+\s+|--\S+\s+)*(?:add\s+(?:-A|--all|\.)(?:\s|$)|commit\s+(?:[^\n;&|]*\s)?-[A-Za-z]*a[A-Za-z]*(?:\s|$))/;
        const whole = (ctx.bashCmds || []).some((c) => OLD.test(String(c)));
        const ws = RULE_K0._k0.workWrites(ctx);
        if (!whole && ws.length && ws.every((w) => /docs\/(gate-debts|product-diary|noun-diary)\.md$/.test(w))) return [];
        return r.detect(ctx);
      } }) },
    // 批 253c(codex K0-1):整提交判据退回「见 -u/-A 即整提交、见 :/… 即仓根」⇒ 定向补日记被阻断。
    //   证人 = neg「253c K0-1:git add -u <日记路径>」「253c K0-1:git add :/<日记路径>」。
    { name: "253c K0-1 退回:-u/-A 后跟 pathspec 仍算整提交、:/path 当仓根",
      apply: (r) => ({ ...r, detect: (ctx) => {
        if ((ctx.bashCmds || []).some((c) => gitWholeCommit(c, { directed: false }))) {
          const g = ctx.batchGoal;
          const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
          if (armed) return [];
          if (!RULE_K0._k0.workWrites(ctx).length && !ctx.didCommit()) return [];
          return k0Core(ctx);                       // 簿记豁免够不着 ⇒ 落回未武装判定
        }
        return r.detect(ctx);
      } }) },
    // 批 253d(第三轮红队 BP-4):排除式 pathspec 退回按普通路径计数 ⇒ `git add -A ':!clipboard'` 算定向、簿记豁免放行。
    //   **真退回**:整条 detect(含 K0 分区外的 k0Bookkeeping)都在旧口径下跑,两个方向同时作证——
    //   证人 = pos「253d BP-4 ①②③」(旧口径放行)与 neg「253d BP-4 反向钉:正向 pathspec + 排除式」(新旧都放行,守住不外溢)。
    { name: "253d BP-4 退回:排除式 pathspec(:!/:^/:(exclude))算定向",
      apply: (r) => ({ ...r, detect: (ctx) => {
        const prev = gitWholeCommit.legacy;
        gitWholeCommit.legacy = { ...(prev || {}), excludeAware: false };
        try { return r.detect(ctx); } finally { gitWholeCommit.legacy = prev; }
      } }) },
    // 批 253d(BP-8):heredoc 正文不剥 ⇒ 台账正文里写着「git add -u」被当成整提交,簿记豁免失效(阻断式误拦)。
    //   真退回同上。证人 = neg「253d BP-8:heredoc 正文里的 git add -u」;反向 = pos「253d BP-8 反向钉」。
    { name: "253d BP-8 退回:heredoc 正文不剥,正文里的 git 命令字样照分词",
      apply: (r) => ({ ...r, detect: (ctx) => {
        const prev = gitWholeCommit.legacy;
        gitWholeCommit.legacy = { ...(prev || {}), heredocAware: false };
        try { return r.detect(ctx); } finally { gitWholeCommit.legacy = prev; }
      } }) },
    // 批 253e(第四份红队 BP-2,漏放):解释器属主的 heredoc 正文也剥 ⇒ `bash <<'EOF'` 里的 git add -A 认不出、簿记豁免放行。
    //   真退回同上(从默认口径拧)。证人 = pos「253e BP-2」三形;反向 = neg「253e BP-2 反向钉:tee 数据 heredoc」与 253d BP-8 neg(新旧都放行)。
    { name: "253e BP-2 退回:解释器 heredoc(bash/sh/pwsh/node…)正文也剥",
      apply: (r) => ({ ...r, detect: (ctx) => {
        const prev = gitWholeCommit.legacy;
        gitWholeCommit.legacy = { ...(prev || {}), interpAware: false };
        try { return r.detect(ctx); } finally { gitWholeCommit.legacy = prev; }
      } }) },
    // 批 253f(第五份红队 BP-2,阻断式误拦):属主表退回 253e 的「会执行」全集 ⇒ node/python 正文里的注释被 shell 分词成整提交。
    //   真退回同上。证人 = neg「253f BP-2 ①②③」;反向 = pos「253e BP-2」三形与「253f BP-2 反向钉」(新旧都命中)。
    { name: "253f BP-2 退回:语言解释器(node/python…)属主的 heredoc 正文也按 shell 分词",
      apply: (r) => ({ ...r, detect: (ctx) => {
        const prev = gitWholeCommit.legacy;
        gitWholeCommit.legacy = { ...(prev || {}), shellOnly: false };
        try { return r.detect(ctx); } finally { gitWholeCommit.legacy = prev; }
      } }) },
    // 批 253f:收窄到壳后不跳包装头 ⇒ `env X=1 bash <<EOF`、`cat <<EOF | timeout 30 sh` 的属主被认成 env/timeout
    //   ⇒ 正文按数据剥、整提交漏认。证人 = pos「253f BP-2 反向钉」。
    { name: "253f BP-2 包装头不跳:env/timeout 挂在壳前时属主认成包装头",
      apply: (r) => ({ ...r, detect: (ctx) => {
        const prev = gitWholeCommit.legacy;
        gitWholeCommit.legacy = { ...(prev || {}), wrapAware: false };
        try { return r.detect(ctx); } finally { gitWholeCommit.legacy = prev; }
      } }) },
    // 批 253b(第二轮红队 BP-5):memory 笔记重新算工作面 ⇒ 只记一条 memory 也要开批。证人 = neg「只写 memory 笔记」。
    { name: "253b BP-5 退回:memory 笔记算 K0 工作面", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
      if (armed) return [];
      if (!RULE_K0._k0.workWrites(ctx, { memoryExempt: false }).length && !ctx.didCommit()) return [];
      if (k0Bookkeeping(ctx)) return [];
      return k0Core(ctx);
    } }) },
    // 批 253 二修:整提交(add -A)仍豁免 ⇒ 夹带前几轮代码。证人 = pos「写日记 + git add -A」。
    { name: "整提交仍豁免(批 253 二修前)", apply: (r) => ({ ...r, detect: (ctx) => {
      const ws = (ctx.writes || []).map((w) => String(w).replace(/\\/g, "/"));
      if (ws.length && ws.every((w) => /docs\/(gate-debts|product-diary|noun-diary)\.md$/.test(w))) return [];
      return r.detect(ctx);
    } }) },
    // 批 253 二修:同号重开不看结清先后 ⇒ 先零对照结清再同号重开被放过。证人 = pos「先结清再同号重开」。
    { name: "同号重开不看结清先后", apply: (r) => ({ ...r, detect: (ctx) => {
      let ops = [];
      try { ops = batchGoalOps(ctx); } catch { ops = []; }
      const g = ctx.batchGoal;
      const onlySameId = ops.some((o) => o.op === "arm") && ops.filter((o) => o.op === "arm").every((o) => o.id === String(g?.batch ?? ""));
      if (onlySameId && g?.cleared && g.closedCount > 0) {
        const done = confirmedConditions(ctx.text);
        for (let i = 1; i <= g.closedCount; i++) if (!done.has(i)) return r.detect(ctx);
        return [];
      }
      return r.detect(ctx);
    } }) },
    // 批 253:同批号重武装也不认 ⇒ 一轮做完的小批被拦。证人 = neg「单轮小批」。
    { name: "同批号重武装也不认(批 253 前)", apply: (r) => ({ ...r, detect: (ctx) => ranArm(ctx) ? k0Core(ctx) : r.detect(ctx) }) },
    // 批 253:簿记豁免不含日记类 ⇒ 关账后补日记被拦。证人 = neg「补产品日记」。
    { name: "簿记豁免不含日记类(批 253 前)", apply: (r) => ({ ...r, detect: (ctx) => {
      const ws = (ctx.writes || []).map((w) => String(w).replace(/\\/g, "/"));
      if (ws.length && ws.every((w) => /docs\/(product-diary|noun-diary)\.md$/.test(w))) return k0Core(ctx);
      return r.detect(ctx);
    } }) },
    // 批 253:证据取不到只在本轮有写或提交时才报 ⇒ 台账写失败时只结清的轮次静默。证人 = pos「只结清、补不出条数」。
    { name: "证据取不到只在有写时报(批 253 前)", apply: (r) => ({ ...r, detect: (ctx) => (!ctx.writes.length && !ctx.didCommit()) ? [] : r.detect(ctx) }) },
    // 分支⑦(批 250):覆盖检查排回两个早退之后(批 249 的位置)⇒ 分两轮关账、只改债表关账两条零对照照样放行。
    //   证人 = pos「批 250 证人①②」。
    { name: "关账覆盖检查排在早退之后(批 250 前)", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
      if (armed) return [];
      if (!ctx.writes.length && !ctx.didCommit()) return [];
      if (k0Bookkeeping(ctx)) return [];
      return r.detect(ctx);
    } }) },
    // 分支⑧(批 250):关账轮不阻断,只认提交 ⇒ 分两轮关账时只结清的那一轮只剩提示。证人 = pos「批 250 证人①」。
    { name: "关账轮不阻断(只认提交)", apply: (r) => ({ ...r, blocking: (ctx) => ctx.didCommit() }) },
    // 分支②:不看写动作 ⇒ 纯问答也报,本项退化成仪式
    { name: "不看是否动了工作面", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length) return [];
      return ["从未武装"];
    } }) },
    // 分支④:簿记豁免撤销(还原 2026-08-26 之前)⇒ 债表登记轮照拦,churn 复活。证人=neg 簿记条
    { name: "撤销债表簿记豁免", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
      if (armed) return [];
      if (!ctx.writes.length && !ctx.didCommit()) return [];
      return k0Core(ctx);
    } }) },
    // 分支⑤:簿记豁免放宽到全部 docs ⇒ 「顺手改法典也算簿记」——fail-open 那侧。证人=pos 混入条
    { name: "簿记豁免放宽到任意 docs", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
      if (armed) return [];
      if (!ctx.writes.length && !ctx.didCommit()) return [];
      if (ctx.writes.length &&
          ctx.writes.every((w) => /docs\//.test(String(w).replace(/\\/g, "/")))) return [];
      return k0Core(ctx);
    } }) },
  ],
  cases: {
    pos: [
      // `batchGoal: null` 是**必须显式写**的:null = 读了、文件不在(真没武装),
      // 而省略 = undefined = 通道没接(不判)。夹具里省略它会让本条静默不响。
      { text: "改完了。", write: "scripts/x.mjs", batchGoal: null },
      // D90 反向钉:台账与判据**同批**改 ⇒ 混入即照拦。
      //   簿记豁免的边界原话是「任何其他路径混入写面即照拦(『顺手把修法也做了』不属簿记)」,
      //   本条钉住它在 **Bash 写面**上同样成立——否则新豁免会顺手把「顺手」也放过去。
      { text: "登记并顺手修了。", batchGoal: { cleared: true },
        bash: `node -e "fs.writeFileSync('docs/gate-debts.md','x')"\nnode -e "fs.writeFileSync('scripts/lib/gate-rules.mjs','x')"\ngit commit -m x` },
      // ⚠️ **缺失的那条正例**(grill:edge-cases E2 点名):已结清、本轮**没跑 --clear**、
      //   却又动了工作面 —— 这是「关账后开新批却没武装」,K0 现在的主力职责。
      //   缺它的后果:去掉豁免里的 `properClose` 成为**等价变异**(全套夹具零反应),
      //   于是下一个「简化」这条豁免的人会让 K0 对此后每个未武装会话永久放行,
      //   而 `--migrate-check K0` 照样 5 项全过。
      { text: "接着改。", write: "scripts/x.mjs",
        batchGoal: { cleared: true, batch: "072", closedConditions: ["甲", "乙"] } },
      // ⚠️ 次序判据的**唯一证人**:已结清、正文里还留着上一批的逐条裁决、
      //   但本轮**没跑 --clear** —— 这是「关账之后又开新批」的真实形态
      //   (我每轮复述逐条对照时就长这样)。
      //   去掉 properClose 的变异会把它误判成「正常关账」而放行;真规则要拦。
      { text: "条件1: 达成。条件2: 达成。(上一批的)现在接着改别的。", write: "scripts/x.mjs",
        batchGoal: { cleared: true, batch: "072", closedConditions: ["甲", "乙"] } },
      // 旧形状保留:`{conditions:[…], cleared:true}` 真实系统不产生,但它是
      // 「去掉 closedCount」那条变异的证人(grill E11 指出这是唯一证人,已知薄弱)。
      { text: "接着改。", write: "scripts/x.mjs", batchGoal: { batch: "099", conditions: ["甲"], cleared: true } },
      // **簿记豁免不外溢**(杀分支⑤「放宽到任意 docs」):写的是法典不是债表 ⇒ 照拦。
      //   「顺手把修法也做了」不属簿记——豁免面就债表一个文件,寸步不让。
      { text: "登记之余顺手改了条法,提交。", write: "docs/laws/collab.md", commit: true,
        batchGoal: { cleared: true, batch: "105", closedConditions: ["甲"] } },
      // ⚠️ **批 249 漏洞证人**:开批、一条都不对照、同轮结清 + 提交。批 249 前 K0 在关账轮早退 ⇒
      //   K(已结清直接返回空)、K0、S 三项全静(scratchpad/clear-leak-probe.mjs 实跑)。
      { text: "关账。", bash: "node scripts/batch-goal.mjs --clear\ngit commit -m x",
        batchGoal: { cleared: true, batch: "249", closedConditions: ["甲", "乙"] } },
      // 只裁一半也不放行。
      { text: "条件1: 达成。关账。", bash: "node scripts/batch-goal.mjs --clear\ngit commit -m x",
        batchGoal: { cleared: true, batch: "249", closedConditions: ["甲", "乙"] } },
      // 编号错位:凑够两条但缺条件2(红队 BP-9:「用条数 ≥ N 代替逐号覆盖」的证人)。
      { text: "条件1: 达成。条件3: 达成。关账。", bash: "git commit -m x\nnode scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "249", closedConditions: ["甲", "乙"] } },
      // 批 253 二修(红队 BP-5):写日记 + `git add -A` 提交,可能夹带前几轮的代码 ⇒ 不豁免。
      { text: "补日记,提交。", write: "docs/product-diary.md", bash: "git add -A\ngit commit -m x",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // 批 253 二修(红队 BP-6):先零对照结清,再同号重开、结清 ⇒ 不认同号重武装。
      { text: "条件1: 达成。",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear\nnode --no-warnings scripts/batch-goal.mjs --arm 253 --cond 丁\ngit commit -m x\nnode --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "253", closedConditions: ["丁"] } },
      // codex 253 合并复核:`git -C <路径> add -A` 同样是整提交,不按簿记豁免。
      { text: "补日记,提交。", write: "docs/product-diary.md", bash: "git -C /repo add -A\ngit commit -m x",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253b(第二轮红队 BP-4):正则老口径漏认的五种整提交写法,逐形钉 ──────────
      { name: "253b 整提交①:git add -u", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add -u\ngit commit -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253b 整提交②:git commit --all", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git commit --all -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253b 整提交③:git add -v -A(旗标分开写)", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add -v -A\ngit commit -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253b 整提交④:git -C \"带空格 路径\" add -A", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: 'git -C "E:/My Dir" add -A\ngit commit -m x', batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253b 整提交⑤:git add :/(pathspec 从仓根起)", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add :/\ngit commit -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253b 整提交⑥:git commit -am(短旗标簇里的 a 仍要认,BP-13 修法不许把它一起放掉)",
        text: "补日记,提交。", write: "docs/product-diary.md",
        bash: 'git commit -am "补日记"', batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // 批 253c(K0-1 的反向钉):`-u` 后跟的 pathspec 是仓根 `.` ⇒ 仍是整提交,「给了 pathspec 就算定向」不外溢到根。
      { name: "253c K0-1 反向钉:git add -u .(pathspec 是仓根)仍算整提交", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add -u .\ngit commit -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253d(第三轮红队 BP-4):只有排除式 pathspec ⇒ 「全部减去排除」= 整提交,不按簿记豁免 ──────
      { name: "253d BP-4 ①:git add -A ':!clipboard'(只有排除式)仍算整提交", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add -A ':!clipboard'\ngit commit -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253d BP-4 ②:git add -A -- ':^scripts/lib'(-- 之后的排除式)仍算整提交", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add -A -- ':^scripts/lib'\ngit commit -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253d BP-4 ③:不带 -A 的 git add ':!clipboard' 同样是全量减排除", text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add ':!clipboard'\ngit commit -m x", batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // 批 253d BP-8 反向钉:剥的只是 heredoc **正文**——结束符之后的真 `git add -A`、标记行尾巴上的 `git add -A` 照认。
      { name: "253d BP-8 反向钉①:heredoc 结束后的真 git add -A 仍算整提交", text: "登记一笔,提交。",
        bash: "cat >> docs/gate-debts.md <<'EOF'\n| D140 | x\nEOF\ngit add -A\ngit commit -m debt",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253d BP-8 反向钉②:heredoc 标记行尾巴上的 git add -A 仍算整提交", text: "登记一笔,提交。",
        bash: "cat >> docs/gate-debts.md <<EOF && git add -A\n| D140 | x\nEOF\ngit commit -m debt",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253e(第四份红队 BP-2,漏放):属主是解释器/壳的 heredoc 正文是**要执行的命令**,不剥 ──
      { name: "253e BP-2 ①:bash <<'EOF' 正文里的 git add -A 仍算整提交", text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: "bash <<'EOF'\ngit add -A\ngit commit -m debt\nEOF",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253e BP-2 ②:带 VAR= 前缀与绝对路径的 sh.exe <<-EOF", text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: "GIT_PAGER=cat C:/Git/bin/sh.exe <<-EOF\n\tgit add -u\n\tgit commit -m debt\n\tEOF",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253e BP-2 ③:cat <<'EOF' | bash(数据经管道喂给壳)", text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: "cat <<'EOF' | bash\ngit add -A\ngit commit -m debt\nEOF",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // 批 253f BP-2 反向钉:壳前面挂了包装头(sudo/env/timeout…)仍是壳属主——收窄到壳时不许把这几形一起放掉。
      { name: "253f BP-2 反向钉:env GIT_PAGER=cat bash <<EOF 与 cat <<EOF | timeout 30 sh 仍算整提交", text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: ["env GIT_PAGER=cat bash <<EOF\ngit add -A\nEOF", "cat <<'EOF' | timeout 30 sh\ngit commit -am debt\nEOF"],
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253b BP-5 的边界:memory 豁免只及于 .md,且路径不得带 `..` ──────────────
      { name: "253b BP-5 边界:memory 目录里的 .mjs 仍算工作面", text: "放了个小脚本。",
        write: "C:/Users/u/.claude/projects/example-project/memory/helper.mjs", batchGoal: null },
      { name: "253b BP-5 边界:带 `..` 段的 memory 路径不放行", text: "写了个文件。",
        write: "C:/Users/u/.claude/projects/example-project/memory/../../../scripts/x.md", batchGoal: null },
      // 批 253(红队 BP-4):只结清、台账补不出条数 ⇒ 报「关账证据取不到」,不因本轮没写就放过。
      { text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "253" },
        prior: [{ text: "提交了。", commit: true }] },
      // ⚠️ **批 250 证人①:分两轮关账**——上一轮提交、本轮只结清、零对照(codex 250 复核实指)。
      { text: "收工。", bash: "node scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲", "乙"] },
        prior: [{ text: "提交了,下一步结清。", commit: true }] },
      // ⚠️ **批 250 证人②:只改债表 + 提交 + 结清、零对照**——原先被簿记豁免先放行(D135 残余⑤)。
      { text: "登记,关账。", write: "docs/gate-debts.md", bash: "git commit -m x\nnode scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲", "乙"] } },
      // 同轮先 arm 新批再结清:关账证据是现造的,不认(红队 BP-9:「关账分支去掉 !ranArm」的证人)。
      { text: "条件1: 达成。条件2: 达成。", bash: "node scripts/batch-goal.mjs --arm 250 --cond z\ngit commit -m x\nnode scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "249", closedConditions: ["甲", "乙"] } },
    ],
    neg: [
      // 纯问答,没动工作面
      { text: "这个字段是干嘛的?", batchGoal: null },
      // ⚠️ D90 回归钉:簿记豁免要够得着 **Bash 面**的写(我改台账几乎都走 node heredoc)。
      { text: "登记。", batchGoal: { cleared: true },
        bash: `node -e "fs.writeFileSync('docs/gate-debts.md','x')"\ngit commit -m x` },
      // ⚠️ 关账轮豁免的回归钉(2026-08-27,连撞 5 轮逼出):正常关账序列是
      //   `--clear` 然后 `git commit`,旧判据把这一轮算成「已结清后又动工作面」⇒ 必响。
      //   **判据把关账本身算成了违规**,不是人每次都犯错。
      //   批 249 拆开:原钉子的形状是「零对照」,**恰好也是漏洞形状**,已移入正例当证人;
      //   这里换成真实的正常关账——裁决在本轮 / 裁决在上一轮(批窗口),两条都必须放行。
      { text: "条件1: 达成。条件2: 达成。关账。", bash: "node scripts/batch-goal.mjs --clear\ngit commit -m x",
        batchGoal: { cleared: true, batch: "249", closedConditions: ["甲", "乙"] } },
      { text: "关账。", bash: "node scripts/batch-goal.mjs --clear\ngit commit -m x",
        batchGoal: { cleared: true, batch: "249", closedConditions: ["甲", "乙"] },
        prior: [{ text: "条件1: 达成。条件2: 达成。" }] },
      // 已武装 ⇒ 归 K
      { text: "改完了。", write: "scripts/x.mjs", batchGoal: { batch: "099", conditions: ["甲"] } },
      // ⚠️ **真实的结清后状态**——`--clear` 会把 conditions 整个丢掉,只剩 `{cleared:true}`,
      //   条件由只追加台账补成 `closedConditions`。此前夹具里**根本没有这个形状**,
      //   用的是 `{conditions:["甲"], cleared:true}` 这种真实系统永远不会产生的状态,
      //   于是我加的豁免变成死代码、每次正常关账都误报,而矩阵和自测双双看不见。
      //   **夹具与现实不符时,「验证通过」是假的。**
      { text: "条件1: 达成。条件2: 达成。关账。", write: "scripts/x.mjs",
        bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "072", closedConditions: ["甲", "乙"] } },
      // 批 253 二修:关账后补名词日记,同属收尾簿记(钉住 noun-diary 这一半)。
      { text: "补名词日记。", write: "docs/noun-diary.md", commit: true,
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲", "乙"] } },
      // 批 253 二修(红队 BP-7):批号带引号的一轮小批。
      { text: "条件1: 达成。", write: "scripts/z.mjs",
        bash: 'node --no-warnings scripts/batch-goal.mjs --arm "252" --cond 戊\ngit commit -m x\nnode --no-warnings scripts/batch-goal.mjs --clear',
        batchGoal: { cleared: true, batch: "252", closedConditions: ["戊"] } },
      // 批 253(红队 BP-10):关账后补产品日记,同属收尾簿记。
      { text: "补上产品日记。", write: "docs/product-diary.md", commit: true,
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲", "乙"] } },
      // 批 253(红队 BP-11):一轮做完的小批——同批号 arm、改、提交、对照、结清。
      { text: "条件1: 达成。", write: "scripts/z.mjs",
        bash: "node --no-warnings scripts/batch-goal.mjs --arm 252 --cond 戊\ngit commit -m x\nnode --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "252", closedConditions: ["戊"] } },
      // 批 253(红队 BP-12):只结清,裁决写在上一轮。
      { text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲", "乙"] },
        prior: [{ text: "条件1: 达成。条件2: 达成。", commit: true }] },
      // **债表簿记豁免**(2026-08-26,批 106;fp「批间补救」四犯的兑现修法;杀分支④):
      //   结清后给已发生的事在 docs/gate-debts.md 登记一笔并提交 ⇒ 不算未武装动工。
      { text: "把这笔实斑登进债表,提交。", write: "docs/gate-debts.md", commit: true,
        batchGoal: { cleared: true, batch: "105", closedConditions: ["甲"] } },
      // ── 批 253b(第二轮红队 BP-5):只写 memory 笔记不算动工作面(未武装 / 已结清两态都要放行)──
      { name: "253b BP-5:只写一条 memory 笔记(从未武装)⇒ 不算动工作面",
        text: "把用户这句原话记进 memory。", batchGoal: null,
        write: "C:/Users/u/.claude/projects/example-project/memory/act-within-granted-authority.md" },
      { name: "253b BP-5:已结清后补 memory 笔记 ⇒ 同样放行",
        text: "补一条 memory。",
        write: ".claude/projects/example-project/memory/MEMORY.md",
        batchGoal: { cleared: true, batch: "253", closedConditions: ["甲", "乙"] } },
      // ── 批 253b(BP-13,阻断式误拦):`-m` 正文里的 `-a` 是**消息**不是旗标 ──────────
      { name: "253b BP-13:git commit -m \"fix -a bug\" 不是 `-a` 整提交",
        text: "补日记,提交。", write: "docs/product-diary.md",
        bash: 'git commit -m "fix -a bug"', batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253b BP-13:定向 git add <债表路径> 仍是簿记",
        text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: 'git add docs/gate-debts.md\ngit commit -m "debt: D140"',
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253c(codex K0-1,阻断式误拦):`-u`/`-A` 后跟了具体 pathspec ⇒ 是**定向**暂存,
      //    不是整提交;`:/` 只有单独成 token 才是仓根,`:/path` 是定向 pathspec ──────────
      { name: "253c K0-1:git add -u <日记路径> 是定向暂存,不是整提交",
        text: "补日记,提交。", write: "docs/product-diary.md",
        bash: 'git add -u docs/product-diary.md\ngit commit -m "docs: 日记"',
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253c K0-1:git add :/<日记路径> 是定向 pathspec,不是仓根",
        text: "补日记,提交。", write: "docs/product-diary.md",
        bash: 'git add :/docs/product-diary.md\ngit commit -m "docs: 日记"',
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253d BP-4 反向钉:给了正向 pathspec 再加排除式 ⇒ 仍是定向(排除式只是不计数,不把定向翻成整提交)──
      { name: "253d BP-4 反向钉:git add -A <日记路径> ':!clipboard' 仍是定向",
        text: "补日记,提交。", write: "docs/product-diary.md",
        bash: "git add -A docs/product-diary.md ':!clipboard'\ngit commit -m x",
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253d(第三轮红队 BP-8,阻断式误拦):heredoc 正文里的「git add -u」是台账文字,不是命令 ──
      { name: "253d BP-8:heredoc 正文里写着 git add -u,不是整提交",
        text: "登记一笔,提交。",
        bash: ["cat >> docs/gate-debts.md <<'EOF'\n| D140 | 整提交形态补认 git add -u\nEOF", "git add docs/gate-debts.md\ngit commit -m debt"],
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // 批 253e BP-2 反向钉:数据 heredoc 的属主是 tee(不是解释器)⇒ 正文照剥(正文里连「bash <<EOF」字样都有,也不被当成解释器属主)。
      { name: "253e BP-2 反向钉:tee 数据 heredoc 正文里的 git add -A 不是整提交",
        text: "登记一笔,提交。",
        bash: ["tee -a docs/gate-debts.md <<'EOF'\n| D141 | bash <<EOF 里 git add -A 认不出\nEOF", "git add docs/gate-debts.md\ngit commit -m debt"],
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      // ── 批 253f(第五份红队 BP-2,阻断式误拦):语言解释器(node/python…)属主的 heredoc 正文是**另一门语言**,
      //    里面的注释/字符串写着 git commit -a 不是 shell 命令 ⇒ 按数据剥 ──
      { name: "253f BP-2 ①:node <<'EOF' 正文注释里写着 git commit -a,不是整提交",
        text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: ["node <<'EOF'\n// D141 讲的是 git commit -a\nconsole.log(1)\nEOF", "git add docs/gate-debts.md\ngit commit -m debt"],
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253f BP-2 ②:python3 <<'EOF' 正文注释里写着 git commit -a,不是整提交",
        text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: ["python3 <<'EOF'\n# D141: git commit -a 形态\nprint(1)\nEOF", "git add docs/gate-debts.md\ngit commit -m debt"],
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
      { name: "253f BP-2 ③:cat <<'EOF' | node(经管道喂给语言解释器)同样按数据剥",
        text: "登记一笔,提交。", write: "docs/gate-debts.md",
        bash: ["cat <<'EOF' | node\n// git add -A 与 git commit -a 两形\nEOF", "git add docs/gate-debts.md\ngit commit -m debt"],
        batchGoal: { cleared: true, batch: "250", closedConditions: ["甲"] } },
    ],
  },
};

// ── S:把决定推回给用户,但不属于三类合法停工理由 ────────────────────────────
// **本条是为管我自己而立的**,而它此前只存在于一条消息里。
// 2026-08-20 用户问「不可逆、需你亲签、实打实阻断——这个事情不是已经上闸了吗?闸无效?」
// 一查:`grep '需要你确认' gate-rules.mjs` ⇒ **0**。
// 我在几轮前把判据完整设计好了(等待类表述 + 无 ⏸ 标记 + 无对应动作),
// 然后写「我现在不动手,理由具体:grill 正在只读审计」——**再没回来**。
// 这是当日**第五次「设计了没造」**(前四:`segments()` 零调用、`requires` 生产不可达、
// `priorEntries` 从未传入、`conditionCount` 死字段)。而这一条恰恰是管这个毛病的。
//
// 判据形态取**结构锚**不取语义:宪法写着「停下等确认必标『⏸ 需要你确认』
// ——三家 CLI 唯一通用等待标识,**不得省略**」。所以第一问不是「理由对不对」,
// 而是「**你到底有没有按规矩停**」。没标记就停 = 已经违规,与理由无关。
// 这与仓里那个零误报的例子(「发起过的 job 有没有被再提过」)同形:
// **拿一个必须出现的字面标记做锚,而不是拿语义。**
//
// CEILING(说在前面):它抓不到「不说等待、直接少做」那一族——闷声缩范围没有字面痕迹。
// 那一族本闸管不了,别指望。

/** A 态痕迹:「说出下一步做什么」。**只此一份**——原先同一条正则在 S 的两个分支各抄一遍
 *  (D96 那支是照抄的),同一概念两处各写 ⇒ 补词补一处不等于补好(D72①/D83/D85 同型)。
 *  ⚠️ D99(2026-09-06,用户 09-05 原话「下一个批可以考虑把英语的问题也加入进去」):
 *    动词表原来**只有中文**。等待后台渲染的轮次我用英文写「next: run --clear / make 720p / send」,
 *    S 按「零动作且未说下一步」拦,换成中文同形态即放——**语言不该是闸的判据**。
 *    英文支要求「引导词 + 动词 + 宾语」形态(动词后须跟一个非标点 token),
 *    免得 "then" 一个词就算说了下一步;中文支沿用既有形态不动。
 *  天花板:仍是措辞表——两种语言的动词表都是枚举,下一个没列的动词照样被拦;
 *    而它守的是**出路**不是闸口,窄 ⇒ 误拦且无处可逃。失效条件同 D87:再撞到未列动词,
 *    改判为「引导词 + 任意动宾」。 */
// 2026-09-06 当轮又撞一个未列动词(「回件到齐后我接着**判**」被拦,fp 已记)——这是 D87 写明的
//   失效条件第三次触发;补「判|裁|派」止血,**方向问题**(措辞面 → 动作面)登记在 gate-debts D104 归用户裁。
const SAID_NEXT_ZH = /(下一步|接下来|接着|继续|随后|然后)[^。\n]{0,24}(做|办|干|修|迁|跑|查|补|写|验|证|核|审|测|试|量|调|清|结|读|扫|推|发|建|改|加|删|候|等|盯|守|收|判|裁|派)/;
// ⚠️ 首版英文支被 grill 复核判 CRITICAL(2026-09-06 当轮):引导词含裸 `then`/`will`/`going to`/`plan to`,
//   动词表 50 个常用词,窗口不辨否定与时态 ⇒ 「The hook then runs the check and exits 0.」
//   「I will not run the check until you confirm.」「I then ran the check」全算「说了下一步」——
//   等于**写两句英文就能过 S**。现收紧为:引导词只认承诺形(`next:`/`next step:`/`next I`/`I'll`/`we'll`/
//   `after that I`),窗口内不得出现否定,动词表只留推进类动作,动词后须跟宾语 token。
//   `wait/watch/poll/monitor` 保留——与中文 `候|等`(D97,用户放行)对等;是否算 A 态归用户。
const SAID_NEXT_EN = new RegExp(
  "(?:^|[\\s(\\[])(?:next(?:\\s+steps?|\\s+up)?\\s*[:,]|next\\s+(?:i|we)\\b|after(?:wards|\\s+that)\\s*,?\\s*(?:i|we)\\b|i'll|i\\s+will|we'll|we\\s+will)" +
  "(?:(?!\\bnot\\b|\\bnever\\b|n't\\b)[^.\\n]){0,40}?" +
  "\\b(?:run|re-?run|verify|check|send|probe|make|build|rebuild|test|measure|clear|fix|write|read|scan|push|deploy|redeploy|" +
  "wait|watch|poll|monitor|review|render|encode|upload|merge|commit|retry|inspect|compare|kick\\s+off|sync|migrate)" +
  "\\b\\s+[^\\s.,;:!?\\n]", "i");
/** 措辞面**跑在剥引文的文本上**(grill 复核:原先读 `ctx.text`,引用闸自己的拦词「next: run --clear」
 *  即可过关——回声豁免正是 S 头注点名的贵方向;剥引文只减少文本命中,不放松任何真拦截)。 */
/** **动作面**的「在跑」证据(D104(a),2026-09-06 用户裁「动作面吧」):官方 `background_tasks[]` 里有在飞任务
 *  ⇒ 零动作轮不是停工,是**等**——等待后台渲染/codex 回件时被 K 的提示轮逼出的空回合,原先只能靠措辞面
 *  (saidNext)救,一次没写对就拦(2026-09-05 一日 6 轮)。状态词表与 `checkAFromPayload` 同口径。
 *  措辞面动词表自此**冻结**:再撞未列动词不再补词,改看这里(D87 失效条件的归宿)。 */
// ⚠️ codex 182 复核(Q1):首版「有在飞任务即放行」**无上限**——挂一个永不结束的无关任务,S 永远不响,
//   A 项也跳过 running 状态,不兜底;且子串匹配让 `inactive` 命中 `active`。现:①状态用**整词枚举**;
//   ②「等」有上限——上一窗也零动作(同样只靠在飞任务撑)⇒ 本窗不再豁免,与 D96 的跨窗判据同口径:
//   一个真在等的执行者两窗内总会有一次轮询/读文件之类的真动作。天花板:仍不绑定任务与批条件的关系。
// 导出:hook-stop-closure 的 A 项(`checkAFromPayload`)与本条共用**这一份**状态枚举(红队 182 附节二 7:
//   原来两处各写一份同一正则,下次补词只会补一处——D72①/D83/D85 同型)。
export const BG_RUNNING_STATUS = /^(running|pending|in[_-]?progress|queued|active|started)$/;
function bgRunning(ctx) {
  const tasks = Array.isArray(ctx && ctx.bgTasks) ? ctx.bgTasks : [];
  if (!tasks.some((t) => BG_RUNNING_STATUS.test(String((t && t.status) || "").toLowerCase().trim()))) return false;
  const prior = typeof ctx.window === "function" ? (() => { try { return ctx.window(); } catch { return null; } })() : null;
  if (prior && !(prior.actions || []).length) return false;   // 连续两窗零动作 ⇒ 不再算「等」
  return true;
}
function saidNextIn(text) {
  // 与 E0/E2/R 同一份剥引文实现(D71/D74),不用 gate-cmd 的 shell 引号版(会吃掉 I'll 的撇号);
  //   围栏代码块整块抹掉——粘贴闸拦词/命令样例不算「说了下一步」。
  const s = maskQuoted(String(text || "").replace(/```[\s\S]*?```/g, " "));
  return SAID_NEXT_ZH.test(s) || SAID_NEXT_EN.test(s);
}
const RULE_S = {
  id: "S",
  blocking: true,          // 用户常设授权:「新增阻断项一律授权自动化」
  law: "AGENTS.md#执行共识",
  detect: (ctx) => {
    // ⚠️ **剥引号**(2026-08-20 grill:error-handling §4.3,它跑代码复现了):
    //   把 S 自己的阻断消息原样引用一遍,就能**把 S 对本轮永久关掉**
    //   —— 它的消息里同时含 `⏸` 与「不可逆 / 需你亲签」,两段判据一起被满足。
    //   Q(当日)与 T 已各自有剥引号,S/E2 漏了。而那两次修的是**回声触发**
    //   (fail-closed、便宜),这两条是**回声豁免**(fail-open、昂贵)——
    //   **先被修的是便宜的那个方向**。同族第三、第四例。
    const sTxt = String(ctx.text || "").replace(/「[^」]*」|«[^»]*»|“[^”]*”|"[^"]*"/g, " ");
    // ── 第三条入口(2026-08-26 用户点破,D67 的根因半):
    //   「模型不知道你要不要裁用户,但因为你没加 ⏸ 就把你放走了」。
    //   原来的两条入口——`handoff` 措辞白名单、`waitMark` 的 ⏸ 标记——**都在被审那一方手里**:
    //   不标、或换个没被枚举的说法(实况:「要我现在接着办 X,还是先停在这里?」),
    //   判据连评估都进不去。宪法要求「停下等确认必标 ⏸」,于是 S 只逮得住
    //   **已经遵守了标记约定的人**,这是循环。
    //   故补一条**不问措辞、不问标记**的入口,信号取自我控制不了的地方:
    //     ① 批目标处于武装态且未结清(来自磁盘台账,不是我说了算);
    //     ② 条件尚未逐条裁决(与 K 同一个 confirmedConditions);
    //     ③ 本轮**以问句收尾**(取最后一个非空行,不是全文含问号);
    //     ④ 未声明三类合法停工理由。
    //   四条同时成立 ⇒ 拦。误拦成本=多跑一轮且有逃生口;漏放成本=带着未完成的活走人。
    //   CEILING:它仍抓不到「不问、闷声少做」那一族(原头注已声明),只把「问一句就走」这条堵上。
    //   判据取**用户 2026-08-26 给的三态模型**(原话):
    //     A. 不需要我裁 ⇒ 那就继续跑
    //     B. 需要我裁   ⇒ 那就得标 ⏸
    //     C. 跑完了
    //   **没有第四态。**「问一句然后停下、但不标 ⏸」不是新的一类,是 B 做错了。
    //   于是判据里**不含任何措辞面**——问不问、怎么问,都不相干:
    //     · C ⇒ 批目标条件已逐条裁完(或没武装) ⇒ 放行
    //     · B ⇒ 标了 ⏸ 且给了三类合法理由之一 ⇒ 放行
    //     · 否则即 A,而 A 的正确动作是继续跑 ⇒ 本轮零推进就收尾 = 违规
    //   「零推进」取动作面:本轮既没写文件、没提交、也没委派出去。
    //   这一条**不问我用了什么词、也不问我标没标**,信号来自磁盘台账与动作面,
    //   都不在被审那一方手里——原来的两条入口(措辞白名单 / ⏸ 标记)恰恰都在。
    const bg = ctx.batchGoal;
    // 「非 C」用 `settledConditions`(已减掉自判「未达成」的),不用原始 confirmed ——
    //   否则写一句「条件2:未达成」就把自己算成跑完了。见 settledConditions 头注(D85)。
    // ⚠️ D67④ 结清(2026-08-27):**C 态改认动作面**。
    //   原来「跑完了」只看正文里的裁决词 ⇒ 写两行「条件N:达成」就满足(当轮实测确认),
    //   那条腿**根本不独立**——被审方自己写的字,判它自己过关。
    //   `ranClear` 是现成的**动作面**判据(W 项一直在用):真跑过 `batch-goal --clear` 才算。
    //   于是 C 态的证据从「我说完了」变成「我按了那个按钮」。
    //   保留文本面作为**兼容支**:两者取或。理由=有些轮次先逐条对照、下一轮才 --clear,
    //   全砍会造误拦;而文本面那一半的天花板已在此写明,不再假装它独立。
    //   ⚠️ 第一版把动作面 **AND** 进旧的文本面判据 —— 当轮实测**没堵住**:
    //   文本面先满足(写两行「达成」⇒ settled==count)就整支跳过,动作面根本走不到。
    //   **加一个更强的条件进 AND,不会让判据变强**,只会让它更容易被绕过的那一支胜出。
    //   ⇒ C 态**只认动作面**:真跑过 `batch-goal --clear` 才算跑完了。
    //   代价:先逐条对照、下一轮才关账的轮次会被拦一次,出路是 A 态那句「接下来关账」。
    const ranClearNow = (() => { try { return ranClear(ctx); } catch { return false; } })();
    if (bg && !bg.cleared && !ranClearNow && bg.conditionCount > 0) {          // 非 C(动作面)
      // ⚠️ 2026-08-27(D77 的**漏修半边**,出路自证逐正例跑之后逮到):
      //   理由面必须查**原文**,不查剥过引文的 `sTxt`——人会很自然地把分类名写引号里
      //   (「属『不可逆』类」),剥引文会把它整个抹掉 ⇒ 一次合规到位的停工被判成没写理由。
      //   上午修 D77 时只改了**第二问**的 stopReason,**这条第三入口自带一份**、漏了。
      //   同一概念在两处各查一遍 ⇒ 修一处不等于修好——与 D72① 的否定词表同型。
      const marked = matchAny(sTxt, PAT.waitMark).length &&
        matchAny(String(ctx.text || ""), PAT.stopReason).length;
      // A 态的痕迹=「说出下一步」。⚠️ 2026-09-02(D97):此判据原先只在**第二分支**查,
      //   而第一分支(零动作)排在它前面 ⇒ 纯文本轮写了「接下来把剩下两条迁完」照样被拦,
      //   出路②在零动作轮**结构性不可达**(探针 T5 复现)。现提前计算、两个分支共用。
      const saidNext = saidNextIn(ctx.text);
      // 「继续跑」= **本轮有任何工具动作**,不是「写了文件」。
      //   首版把它编成 writes||commits||agents,实测三个候选四态全被误拦:
      //   「等 codex 回件」「只读了一堆文件」「发现条件错了」——前两个本来就是 A 且确实在跑
      //   (轮询、读文件都是继续跑),第三个折回 C(裁决词里本就有 `不适用`)。
      //   ⇒ **没有第四态,但我的编码错了**:把"推进"窄化成"产出",于是调查与等待都被当成停工。
      // D104(a):动作面优先——后台任务在飞的零动作轮是「等」不是「停」,不看措辞。
      const running = bgRunning(ctx);
      if (!marked && !saidNext && !running && !(ctx.actions || []).length) {   // 非 B、未声明下一步、无在飞任务、且**纯说话**
        return ["批目标尚有未裁条件、本轮一个动作都没有,却既没继续跑也没标 ⏸ 说明属哪一类合法停工"];
      }
      // ── D96 结清(2026-09-02,批 145):出路②的**跨轮兑现核查**。
      //   D96 的形态:每轮说一句「接下来验收 X」然后什么都不做,可以无限过闸——
      //   出路②把「说了」当「做了」收下,正是 R 项要消灭的形态换了个时态。
      //   判据取**结构信号**:上一窗(`ctx.window()`,本轮之前若干轮的聚合)零动作且已含
      //   「下一步」承诺,本轮又零动作、又只靠 saidNext 撑 ⇒ 承诺连续两窗未兑现,出路②失效。
      //   窗口为 null(夹具/旧路径未喂 priorEntries)⇒ 不判,保持原语义(「没窗口」≠「窗口空」)。
      //   代价不对称:误拦=多做一次真实轮询/读文件(便宜);漏放=空转轮无限续(D96 实录 5+ 轮)。
      //   天花板:只看「零动作+承诺句」的结构,判不出承诺的对象是否同一件事;
      //   且 ⏸+三类理由(B 态)仍照常放行——等待用户是合法停工,本条只收「假装在跑」。
      const prior = typeof ctx.window === "function" ? ctx.window() : null;
      if (!marked && saidNext && !running && !(ctx.actions || []).length && prior &&
          !(prior.actions || []).length && saidNextIn(prior.text)) {
        return ["上一窗已说过「接下来做 X」且零动作,本窗又零动作只靠「下一步」句——承诺连续未兑现,出路②失效(D96);要么真做一次,要么标 ⏸ 说明属哪一类合法停工"];
      }
      // ── D67③ 补齐(2026-08-27,批 117;用户当轮第三次逮到同一形态)────────────
      //   旧版只逮「纯说话就收尾」。真实逃脱形态是「**做了活、然后停下**」——
      //   动作面非空 ⇒ 旧版放行。2026-08-27 我本人再犯:写完一份工整的逐条对照,
      //   批还武装着、条件明写「未达成」、没有任何阻断,就收工了。
      //   **两道闸各守一半,缝正好够走过去**:K 只要求「逐条对照」(写一句『未达成』就满意),
      //   S 又不看 K 的状态 ⇒ 诚实地写「未达成」并停下,两边都过。
      //
      //   判据不能要求「本轮把批干完」——那会让每一轮都变红(多轮批是常态)。
      //   能要求的是**三态各自留下痕迹**:C=结清 / B=⏸+三类理由 / A=**说出下一步是什么**。
      //   A 态那句话成本一句,而它把「我还在跑」与「我停下了」区分开——
      //   这正是旧编码想用「有没有动作」去近似、却近似错了的东西。
      //   代价不对称:误拦=多写一句「接下来做 X」;漏放=带着未结清的批走人,此后无人再查。
      //   **天花板照实说**:它只验「有没有声明下一步」,验不了那个声明是否兑现——
      //   兑现要跨轮账本,是另一件事(D67 余项)。且措辞面可被一句空话满足。
      // ⚠️ 动词表 2026-08-27 当轮扩过一次(D87):首版是 `做|办|干|修|迁|跑|查|补|写`,
      //   我写「下一步:接着**验** D56」当场被拦——「验」不在表内。
      //   **这是「出路的判据比出路的说明窄」在我当天新写的判据上二犯**
      //   (说明只说「说出下一步做什么」,没说「且必须用这九个动词之一」)。
      //   现补齐工程语境常用的收尾/推进动词。**天花板照实说**:这仍是措辞表,
      //   下一个没列的动词照样被拦;而它守的是**出路**不是闸口,窄 ⇒ 误拦且无处可逃。
      //   失效条件:再撞到第三个未列动词,改判为「只要出现『下一步/接下来』+ 任意动宾」。
      //   (`saidNext` 已提前到第一分支之前计算——2026-09-02 D97;动词表同轮补入
      //   候|等|盯|守|收——「接下来我候你的耳裁」是等待轮的自然写法,原表不认。)
      // D104(a):做了活(或后台在飞)且没说下一步——后台在飞的轮次是「等」,不是「做了活然后停下」。
      if (!marked && !saidNext && !running) {
        return ["批目标尚有未裁条件,却既没结清、没标 ⏸ 说明属哪一类合法停工、也没说出下一步做什么"];
      }
    }
    // ⚠️ 2026-08-27(D91,当轮自撞):**否定式盲区**。我写「**不构成**需要你裁的取舍」
    //   ——一句明确说「这不用你管」的话——被判成「把决定推回给用户」。
    //   判据认的是**措辞**不是**行为**,同一族第十四次;而这次尤其别扭:
    //   本项的出路①正是「自己定并写明依据,不回问」,**照做了反而被拦**。
    //   修法:命中前先把**带否定前缀**的推决定词消掉(`不/不构成/无须/毋须/不必/无需`)。
    //   窄:只消「否定词紧贴推决定词」这一形态,不做句法分析。
    //   天花板:「不是我要推给你,但你看看?」这类**先否定后又问**的句子仍会漏——
    //   那种句子的后半截会被 `askMark` 与别的 handoff 形态接住,不靠本条。
    const sTxtNeg = sTxt.replace(
      /(不构成|不需要|无需|无须|毋须|不必|不)\s*(需要你裁|需你裁|归你裁|要你(决定|裁)|由你(决定|裁))/g, " ");
    const asks = matchAny(sTxtNeg, PAT.handoff);
    if (!asks.length) return [];
    // **「陈述某事归你」≠「停下来等你」**——还得真的在问(问号 / 显式等待动词)。
    // 缺这一条会误伤合法的推迟(Q 的地盘),当日实撞过一次。
    if (!matchAny(sTxt, PAT.askMark).length) return [];
    // 第一问:按规矩停了吗(结构锚)
    if (!matchAny(sTxt, PAT.waitMark).length) return ["把决定推回给用户,却没标 ⏸"];
    // 第二问:标了 ⇒ 理由须落在三类之内。标记本身罕见,这里误报成本低。
    // 意图命中后**先验凭证形态、再问理由**(跨模型 Q4 判「方向只对了一半」):
    //   收紧凭证是对的,但把它同时当成唯一的意图入口就是**放松闸**——
    //   只写裸 `⏸` 的停工会从「该被拦」变成「完全不审」。故分两问。
    if (!matchAny(sTxt, PAT.waitMarkStrict).length) {
      return ["停下等确认但没用规范形态「⏸ 需要你确认」——宪法写的是三家 CLI 唯一通用等待标识,不得省略"];
    }
    // ⚠️ 2026-08-27(D77,本轮自撞第四轮):**理由面查原文,不查剥过引文的 sTxt**。
    //   剥引文是**防回声**的措施,对「闸口」(handoff/askMark:你是不是在推决定)是对的;
    //   但对**理由声明**是错的——人会很自然地给分类名加引号:
    //   「属『需你亲签』类」⇒ 引号内容被抹 ⇒ `stopReason` 看不见「亲签」⇒
    //   **一次合规到位的停工被判成没写理由**。实测:同一句去掉引号即放行,加引号即拦。
    //   与 D76 同一个方向(凭证面被格式打瞎),**同族第七次**。
    //   fail-open 面:标了 ⏸ 之后引用闸自己的三类清单即可满足本问——
    //   但本问本来就只验「你有没有声明一个分类」,分类真假闸无从核(天花板早已写明),
    //   且它排在 waitMarkStrict 之后(人已真写了 ⏸ 需要你确认)。
    //   代价不对称:误拦=合法停工被判违规(贵,且人照宪法原文写却过不去);
    //   漏放=一个自称的分类没被追问(闸本来也追问不了)。取放行侧。
    if (!matchAny(String(ctx.text || ""), PAT.stopReason).length) {
      return ["标了 ⏸ 但未说明属哪一类合法停工理由"];
    }
    return [];
  },
  // 无豁免:阻断项不认文本豁免(INV-1),而「我这次问得有道理」正是文本豁免。
  exempts: [],
  message: (hits) =>
    `${hits[0]}。合法停工只有三类:**不可逆 / 需你亲签 / 实打实阻断**(缺凭据、站点不可达、只有用户能触发)。\n` +
    `      「工作量大」「拿不准要不要做」「这是产品取舍吧」都**不在其中**——\n` +
    `      多数时候答案已经写在代价不对称里:误报当场可见可人工放行,漏放进下游难发现,\n` +
    `      **拿不准按「太松」报**。按这条,绝大多数「要不要做 X」根本不用问。\n` +
    // 出路①「自己定」是**减法型**(把问句拿掉),原先自证机制接不上去(D79 盲区①);
    //   批 117 当轮给自证补了 `sample.replaceText`(整轮换成这样说)⇒ 该盲区已消解,
    //   本条现在也每次真跑一遍。
    `      出路:\n${renderEscapes(RULE_S.escapes)}`,
  // 出路即数据(批 117)。三条 sample 逐字对应本批咬过我的三种写法:
  //   规范形态 / 短语加粗(D76)/ 分类名加引号(D77)——它们现在每次自测都要真跑一遍。
  escapes: [
    // 减法型:出路是**把问句拿掉**,自己定并写依据,故整轮换成一段自决的正文。
    // forPos:本条对应的是「把问句拿掉、自己决定」那几支。pos[6] 是**另一支**——
    //   批目标未结清且本轮零动作——对它而言「自己定」的意思不是写一句话,是**去干活**,
    //   故另立下面那条出路。**漏了这一支等于消息对该形态没给出路**,自证逐正例跑才逮到。
    { say: "自己定并写明依据(按代价不对称站边,不回问)",
      forPos: [0, 1, 2, 3, 4, 5],
      sample: { replaceText: "按代价不对称,误报当场可见可人工放行、漏放进下游难发现,故按「太松」报,直接选 B,已实现并验证。" } },
    // ⚠️ 判据 2026-08-27 改过(D67③/D85):A 态的凭证从「本轮有动作」换成「**说出下一步**」。
    //   理由:旧编码只逮得住「纯说话就收尾」,而真实逃脱形态是「做了活、然后停下」——
    //   动作面非空就放行,等于把最常见的那种早退整个漏掉。出路说明同步改,否则又是画在墙上的门。
    { say: "(批目标未结清时)**说出下一步做什么** —— 「接下来把剩下四条迁完」这样一句即可;" +
        "光有动作不算,因为「做了活然后停下」正是要拦的形态",
      forPos: 6, sample: { text: "接下来把剩下四条迁完。", read: "docs/gate-debts.md" } },
    // D87 回归钉:动词表首版没有「验」,我写「接着验 D56」当场被自己的判据拦。
    //   出路说明只说「说出下一步做什么」,没说「且必须用那九个动词之一」。
    { say: "(同上)动词不限于「做/办/修」——「接着**验** X」「随后**核** Y」一样算",
      forPos: 6, sample: { text: "接着验 D56 的真成因。", read: "docs/gate-debts.md" } },
    // D67④ 回归钉:C 态只认**动作面**。写两行「达成」不再算跑完了。
    { say: "(C 态)真跑 `batch-goal --clear` —— 写两行「条件N:达成」**不算**,那是被审方自己写的字",
      forPos: 6, sample: { text: "条件1:达成。条件2:达成。", bash: "node scripts/batch-goal.mjs --clear" } },
    { say: "标 ⟪⏸ 需要你确认⟫ 并写清属三类中的哪一类(不可逆 / 需你亲签 / 实打实阻断);标「需你亲签」前先核:用户若已给过方向,跟随性改动随方向落笔,不算亲签(D142)",
      sample: { text: "⏸ **需要你确认**：这条改的是法条语义，需你亲签。" } },
    { say: "标 ⏸ 时**分类名写在引号里也认**:「⏸ 需要你确认:属『不可逆』类」",
      sample: { text: "⏸ 需要你确认：属「不可逆」类，翻 public 撤不回来。" } },
  ],
  mutations: [
    // 分支①:只看有没有问句,不看标记 ⇒ 标了 ⏸ 的合法停工也被拦
    { name: "不认 ⏸ 标记", apply: (r) => ({ ...r, detect: (ctx) =>
      (matchAny(ctx.text, PAT.handoff).length ? ["推回给用户"] : []) }) },
    // 分支②:标了就放行,不问理由 ⇒ 「标记当免死金牌」
    { name: "标了就放行", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!matchAny(ctx.text, PAT.handoff).length) return [];
      return matchAny(ctx.text, PAT.waitMark).length ? [] : ["没标 ⏸"];
    } }) },
  ],
  cases: {
    pos: [
      // 当日实撞的两种形态:光问、不标记
      { text: "E7–E11 收不收？你说一声我就接着做。" },
      { text: "选 A / B / C，还是先不做？归你裁。" },
      // 标了但理由不在三类内
      { text: "⏸ 需要你确认：这个要不要现在做？我拿不准工作量。" },
      // ⚠️ **第三次漏网的实况句**(2026-08-26,用户逮到:「为什么你说了个事、没完成、闸没拦住你?」)。
      //   同一个行为换第一人称说法,原 11 条 handoff 一条不中 ⇒ S 整条跳过,
      //   连「标没标 ⏸」都没走到。这条钉的是**措辞白名单的漏网面**,不是新行为。
      { text: "要我现在接着办 D60，还是先停在这里？" },
      { text: "需不需要我把这条也一并改了？还是先放着。" },
      { text: "继续修下去还是先停？" },
      // 三态模型的 A 态漏网面(2026-08-26 用户给的模型):不问措辞、不问标记。
      //   批目标未裁完 + 本轮零推进 + 没标 ⏸ ⇒ 你本该继续跑,停下就是违规。
      //   本例**连问号都没有**,原判据(措辞白名单 + ⏸)两条入口全不命中。
      { name: "A 态:零推进就收尾,且一个字的问句都没有",
        text: "这批还剩两条没办。我先看看情况。",
        batchGoal: { armedAt: "2026-08-26T00:00:00Z", conditions: ["甲", "乙"] } },
      // D96 回归钉(2026-09-02):上一窗说了「接下来验收 X」且零动作,本窗又零动作再说一遍
      //   ——「验收中」式空转,承诺连续两窗未兑现,出路②失效。
      { name: "D96:连续两窗只说下一步、零动作",
        text: "接下来我核 stems 双 FLAC 与退出码,到件即验。",
        prior: [{ text: "接下来我验收 stems 产物,到件即核。" }],
        batchGoal: { armedAt: "2026-09-02T00:00:00Z", conditions: ["甲", "乙"] } },
      // D99 回归钉(2026-09-06):英文**纯空转**(零动作、没有「引导词+动词+宾语」)仍拦——
      //   钉住「认英文」没把口子开成「写英文就放」。
      { name: "D99 反向钉:英文空转、零动作",
        text: "Still waiting on the background render. Nothing to report yet.",
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      // D99 × D96:英文承诺连续两窗未兑现,同样失效(跨语言同一判据)。
      { name: "D99×D96:英文承诺连续两窗零动作",
        text: "Next I'll verify the 720p output and send it.",
        prior: [{ text: "Next: run --clear, then make the 720p version." }],
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      // grill 复核(2026-09-06,CRITICAL)给的三种「写两句英文就过」形态,首版全放行:
      { name: "D99 反向钉:否定句不是下一步",
        text: "I will not run the check until you confirm.",
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      { name: "D99 反向钉:解释既有行为的 then 不是下一步",
        text: "The hook then runs the check and exits 0. I then ran the check and it passed.",
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      { name: "D99 反向钉:引用闸自己的拦词不算说了下一步(回声)",
        text: "The gate said \"next: run --clear\" but I disagree.\n```\nnext: run --clear\n```",
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      // codex 复核(2026-09-06)另给的三句,首版全放行:否定 / 过去式 / 引用措辞示例
      // codex 182 Q1 反向钉:①永不结束的无关任务 + 连续两窗零动作 ⇒ 拦(「等」有上限);②`inactive` 不算在飞(整词枚举)。
      { name: "codex-182 Q1:永驻后台任务撑不过第二个零动作窗",
        text: "Still waiting.",
        prior: [{ text: "Still waiting." }],
        bgTasks: [{ id: "forever", status: "running" }],
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      { name: "codex-182 Q1:inactive 不是在飞",
        text: "还在渲染。",
        bgTasks: [{ id: "b9", status: "inactive" }],
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      // D104(a) 反向钉:后台任务**已完成**(不在飞)+ 零动作 + 无下一步 ⇒ 仍拦——动作面只认在飞。
      { name: "D104(a) 反向钉:后台任务已完成的零动作轮照拦",
        text: "渲染早完了。",
        bgTasks: [{ id: "b1", status: "completed" }, { id: "b3", status: "failed" }],
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      { name: "D99 反向钉(codex):过去式与引用示例都不是下一步",
        text: "I will not run any commands. Back then we would run the checks manually. The phrase \"I will run the tests\" is only an example.",
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
    ],
    neg: [
      // D99 回归钉(2026-09-06;fp 台账 2026-09-05T05:17Z 那笔的实况措辞):
      //   零动作、英文写出下一步(动词+宾语)⇒ A 态痕迹成立,放行。**样本不含中文动词**。
      { name: "D99:英文说出下一步(零动作)",
        text: "Render is still going. Next: run --clear, then make the 720p version and send it.",
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      // D104(a) 动作面(2026-09-06 用户裁「动作面吧」):后台任务在飞 + 零动作 + 一个字的下一步都没说 ⇒ 放行——
      //   这就是 2026-09-05 被 K 提示轮逼出的空回合的实况形态;**样本不含任何引导词/动词**,证的是动作面。
      { name: "D104(a):后台任务在飞的零动作轮不算停工",
        text: "还在渲染。",
        bgTasks: [{ id: "b1", status: "running", description: "ffmpeg 720p" }],
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      // 与 D96 交叉(codex 182 Q1 后改向):上窗**有过真动作**(轮询)、本窗零动作但后台在飞 ⇒ 放行(等,不是假装在跑)
      { name: "D104(a)×D96:上窗有轮询动作,本窗零动作、后台在飞 ⇒ 放行",
        text: "接下来我核 stems 双 FLAC。",
        prior: [{ text: "轮询一次。", bash: "node ~/.claude/scripts/codex-run.mjs --poll x" }],
        bgTasks: [{ id: "b2", status: "pending" }],
        batchGoal: { armedAt: "2026-09-06T00:00:00Z", conditions: ["甲", "乙"] } },
      // 合法停工:标了且属亲签面
      { text: "⏸ 需要你确认：这一行要不要加进冲突表——改宪法需你亲签。" },
      // 合法停工:实打实阻断
      { text: "⏸ 需要你确认：这条通道只有用户能触发（缺凭据），我这边站点不可达。" },
      // D91 回归钉(2026-08-27 当轮自撞):**否定式不算推决定**。
      //   我写「不构成需要你裁的取舍」——一句明确说「这不用你管」的话——被判成推回给用户。
      //   尤其别扭的是:本项出路①正是「自己定并写明依据,不回问」,**照做了反而被拦**。
      { text: "保留。依据是代价不对称。既不涉及不可逆、也不涉及安全面,不构成需要你裁的取舍。" },
      { text: "这条我自己定了,不需要你裁。" },
      // D76 回归钉(2026-08-27,本轮自撞第三轮):**把短语加粗是最自然的写法**,
      //   而 `\s*` 吃不下 `**` ⇒ 凭证面判瞎 ⇒ 合法停工被判成违规停工。连撞三轮。
      // ⚠️ **首版这两条是废的**(D77 当轮实测发现):它们没有 handoff/askMark 形态,
      //   `detect` 在前两问就 return 了,**根本走不到凭证面**——又一次「反例靠无关理由过关」。
      //   本批第三次栽在同一个坑(D75 的 F 反例、这里、E0 那条),
      //   故现在两条都带上真实的推回形态(疑问句 + 指向我),逼它走完全程。
      { text: "这条要不要现在做？⏸ **需要你确认 —— 属「需你亲签」类**：改的是法条语义。" },
      { text: "要我接着办还是先停？**⏸ 需要你确认**：这一行要改宪法，需你亲签。" },
      // D77:分类名加引号(最自然的写法)不得因防回声的剥引文而失效。
      { text: "这条要不要现在做？⏸ 需要你确认：属「不可逆」类，翻 public 撤不回来。" },
      // 根本没推回给用户:自己定了
      { text: "按代价不对称，误报便宜，直接选 B，已实现并验证。" },
      // 等机器不算停工
      { text: "codex 回件还没到，等它回来我逐条读。" },
      // D97 回归钉(2026-09-02;一夜 30+ 笔误报台账的两种实况形态):
      //   ① 第三类分类名本身「实打实阻断」——闸消息明写三类名,原 stopReason 表却不认它。
      { name: "D97①:属实打实阻断类(第三类分类名本身)",
        // ⚠️ 样本**不得含旧词表已认的词**(只有你能/缺凭据/不可逆/亲签),否则证明不了新词生效
        //   (codex 复核 audit-145 逮到首版正是这么写的)。
        text: "候三选一,到即续。\n\n⏸ 需要你确认:属『实打实阻断』类——三选一等你回。",
        bash: "node scripts/hook-stop-closure.mjs --fp S x",
        batchGoal: { armedAt: "2026-09-02T00:00:00Z", conditions: ["甲", "乙"] } },
      //   ② 零动作轮但声明了下一步——出路②原先在零动作分支结构性不可达。
      { name: "D97②:零动作但说出下一步(A 态痕迹)",
        text: "接下来把剩下两条迁完。",
        batchGoal: { armedAt: "2026-09-02T00:00:00Z", conditions: ["甲", "乙"] } },
      { name: "D97②':零动作、等待动词『候』",
        // 同上:去掉「结批」——「结」在旧动词表里,留着就证明不了「候」生效。
        text: "接下来我候你对 v3 的耳裁。",
        batchGoal: { armedAt: "2026-09-02T00:00:00Z", conditions: ["甲", "乙"] } },
      // D96 的边界:上一窗空转承诺,本窗**真做了一次**(有动作)⇒ 放行——判据只收「假装在跑」。
      { name: "D96 边界:上窗空承诺,本窗有真动作",
        text: "上轮说要核,这轮核了:退出码 0,双 FLAC 在。接下来做混音。",
        bash: "ls stems/",
        prior: [{ text: "接下来我验收 stems 产物,到件即核。" }],
        batchGoal: { armedAt: "2026-09-02T00:00:00Z", conditions: ["甲", "乙"] } },
    ],
  },
};

// ── T：把「登记」当成处置，却不给失效期 ────────────────────────
// 立法动机（2026-08-20 实撞，用户两次点名）：
//   grill 报了 P7，我工工整整登记成「已登记未修 + 理由」，**然后用户当场撞上那个洞**。
//   而本仓对「处置」的定义是「改了**或**登记了」（C 项判据），
//   所以「登记」满足验收条件 ⇒ **我用一个允许这种结局的标准，判定自己达标**。
//
// 外部先例（已取页逐字核实）：
//   「No expiry date means it is a **silent policy change**, not an exception.」
//   「The approver must be **the person who bears the consequence**, not the person who wants the exception.」
//   ── 前一句就是本条；后一句（承重八族的登记归用户签）动的是授权关系，**属亲签面，不在本条**。
//
// 与 Q 的分工：Q 管「把活推出批」；本条管「声称已处置但没有回收机制」。
// CEILING：它只看有没有**写**失效期，判不了那个失效期到时会不会真的被执行
//   —— 那需要跨会话的欠账账本，本条不假装自己能代替它。
const RULE_T = {
  id: "T",
  blocking: true,          // 用户常设授权：「新增阻断项一律授权自动化」
  law: "AGENTS.md#执行共识",
  detect: (ctx) => {
    // 引号内不算（同 Q：引用闸自己的报告不该触发它）
    const t = String(ctx.text || "").replace(/「[^」]*」|«[^»]*»|"[^"]*"/g, " ");
    if (!matchAny(t, PAT.registered).length) return [];
    if (!matchAny(t, PAT.expiry).length) {
      return [(matchAny(t, PAT.registered)[0] || "(登记句)") + " —— **没给失效期**"];
    }
    // ② **不得自签**。外部先例原话禁的是「申请豁免的人自己批」，
    //   而不是「所以得用户批」—— 那中间一步是我自己加的，用户当场驳回（2026-08-20）：
    //   「这怎么又哪门子归我签了？」。
    //   正解：过一次**独立复核**（跨模型 codex / 只读子代理 / 联网先例）——
    //   既满足「批的人不是想要豁免的人」，又不给用户加一件事。
    //   取证面：本轮 ∪ 批窗口（跟 I 项同一条理由：复核与登记天然不同轮）。
    const reviewed = (c) => !!c && (
      c.toolNames.some((n) => /^(WebSearch|WebFetch|Agent|Task)$/.test(n)) ||
      c.agents.length > 0 ||
      c.ranBash(/codex-run\.mjs|codex\s+exec|battle/) ||
      c.toolNames.some((n) => /codex/i.test(n)));
    let win = null;
    try { win = ctx.window(); } catch { win = null; }
    if (reviewed(ctx) || reviewed(win)) return [];
    return [(matchAny(t, PAT.registered)[0] || "(登记句)") + " —— **自签**（本批无独立复核）"];
  },
  exempts: [],
  // 出路即数据(批 117)。②的 sample 必须**同时**带失效期与一次真实的独立复核动作
  //   ——判据要的就是这两半,少一半就不放行,而这正是 codex 092 当年指出的老毛病。
  escapes: [
    // 减法型:出路本身要求**别复述登记句**,故用 replaceText 给一整段应放行的正文。
    { say: "**当场修掉**,且别在正文复述登记句(要提就用「」引号引用——判据剥引号)",
      sample: { replaceText: "那五条已经修完并验证,原话「已登记未修」不再成立。" } },
    { say: "写明失效期(「下一批必修」/「N 批内复议」/具体日期)**并且本批过一次独立复核**" +
        "(codex / 子代理 / 联网任一)",
      sample: { text: "失效期:下一批必修。",
        bash: "node ~/.claude/scripts/codex-run.mjs --task clipboard/codex/t.md" } },
  ],
  message: (hits) =>
    // D24 复测逮到(2026-08-23):hits[0] 自带成因(「没给失效期」或「自签」),
    // 原消息头把两种命中一律说成「没给失效期」——判据对、消息错,与 D17 同族。
    `「登记」不算处置（命中：${hits[0]}）。
` +
    `      外部先例：「No expiry date means it is a **silent policy change**, not an exception.」
` +
    `      实撞：grill 报的 P7 我登记成「已登记未修 + 理由」，随后用户**当场撞上那个洞**。
` +
    // codex 092 复审逮到:原「出路二选一」两条都过不了判据——「当场修掉」若复述登记句照样命中,
    // 「写明失效期」还差独立复核那一半。出路句按判据**逐字**对齐,判据不动。
    // 批 117:改为从 escapes 渲染,且两条都有 sample 每次真跑一遍(D79)。
    `      出路:\n${renderEscapes(RULE_T.escapes)}\n` +
    `      （批的人不能是想要豁免的人）。仅写「已登记」等于静默改规矩。`,
  mutations: [
    { name: "不看失效期（登记就报）", apply: (r) => ({ ...r, detect: (ctx) =>
      (matchAny(ctx.text, PAT.registered).length ? ["x"] : []) }) },
    { name: "不剥引号", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!matchAny(ctx.text, PAT.registered).length) return [];
      return matchAny(ctx.text, PAT.expiry).length ? [] : ["x"];
    } }) },
  ],
  cases: {
    pos: [
      { text: "这五条已登记未修，理由写在提交信息里。" },
      { text: "先挂着，下次再说。" },
      // ② 给了失效期，但**本批没过任何独立复核** ⇒ 自签，仍须拦。
      { text: "已登记未修，失效条件：下一批必修。" },
    ],
    neg: [
      // 给了失效期
      { text: "已登记未修，**失效条件：下一批必修**，否则自动转红。", agent: "grill:edge-cases" },
      { text: "登记在案，20 批内复议。", web: true },
      // D84:台账 `docs/gate-debts.md` 全表用的就是 `失效期 ≤NNN` 这个记法,
      //   而原词表不认 ⇒ 照台账写法交代失效期,T 判「没给失效期」。第十次同型。
      { text: "已登记未修，失效期 ≤118。", agent: "grill:edge-cases" },
      // 引用闸的报告不算（回声族，同 Q）
      { text: "闸说「已登记未修」不算处置。所以我当场修掉了。" },
      // 根本没提登记
      { text: "三条都当场修掉了，验收全过。" },
    ],
  },
};

// ── U：Skill 调用未闭环 ───────────────────────────────────
// 立法动机（2026-08-20 用户实撞）：我 `Skill(xros:sharpen)` 把指令载进上下文，
// 随即被一条新消息打断、转头去改别的，**那次调用就此消失**。
// 用户原话：「要不是刚才我问一下现在根本没得管」。
//
// 为什么既有的闸接不住：`A` 管的是**后台任务**（走 `background_tasks[]`，有 id 可对账）；
// 而 Skill 调用只是把指令载进来，**无 id、无回执、无任何追踪**。
// 法条早就有：`docs/laws/collab.md` 「四之三、委派与承诺必闭环」——
// 「**发起即欠账**：凡委派出去的任务，发起那一刻就成为本批欠账」。
// **法有、闸无** —— 又一次「规则写在法条里，不写在判据里」。
//
// CEILING：它判不了「跟完了没有」，只判「还提不提它」。
//   写一句「xros 跑了」就能过 —— 但那至少把它重新提到台面上，
//   而当前的失败形态是**完全静默消失**。两者不同量级。
const RULE_U = {
  id: "U",
  blocking: true,          // 用户常设授权：「新增阻断项一律授权自动化」
  law: "docs/laws/collab.md#四之三",
  detect: (ctx) => {
    // 本轮调用的 skill 不算——它正在跑。管的是**窗口里发过、至今无下文**的。
    let win = null;
    try { win = ctx.window(); } catch { win = null; }
    if (!win) return [];                       // 没窗口 ⇒ 不判（与接线前一致）
    const past = [...new Set(win.skills || [])].filter(Boolean);
    if (!past.length) return [];
    const t = String(ctx.text || "");
    // 闭环证据（任一即可）：本轮又调了它 / 正文里提了它的名字 / 写了它声明的产物目录
    const artifact = /xros[\/]|clipboard[\/]mapgen[\/]|\.nlpm-test[\/]/;
    // ⚠️ **闭环证据必须也在窗口里找**（2026-08-20 实撞，当日第二次同形）。
    //   第一版只在**本轮**找证据（正文提到 / 本轮写了产物），
    //   而窗口里那次 Skill 调用一直在 ⇒ **只要哪一轮不提它，就再响一次**。
    //   实撞：`xros/sharpen/gate-recall-2026-08-20.md` 两轮前已写并提交，
    //   U 仍然报「至今无下文」。这跟 K 那个「永动」是同一个形状：
    //   **证据天然跨轮，而判据只看本轮**。
    //   ⇒ 已关就是已关（sticky）：窗口内出现过证据即算数。
    const wt = String(win.text || "");
    const closed = (sk) => {
      const bare = sk.split(":").pop();
      const named = (x) => x.includes(sk) || (bare.length > 3 && x.includes(bare));
      if ((ctx.skills || []).includes(sk)) return true;      // 本轮又调了
      if (named(t) || named(wt)) return true;                // 本轮或窗口里交代过
      if (ctx.writes.some((w) => artifact.test(String(w)))) return true;
      if ((win.writes || []).some((w) => artifact.test(String(w)))) return true;  // 窗口里写过产物
      return false;
    };
    const open = past.filter((sk) => !closed(sk));
    return open.slice(0, 3);
  },
  exempts: [],
  // 出路即数据(批 117)。①是动作面(重调),②③是文本面(交代结果 / 说明为何不跑)。
  escapes: [
    { say: "**把它跑完**(重新调起同一个 skill)", sample: { skill: "xros:sharpen" } },
    { say: "正文里**点名**交代它结果如何 —— 判据要的是**写出那个 skill 名**(如 `xros:sharpen`),泛泛说「那次调用」不算",
      sample: { text: "xros:sharpen 的结果:出了三条判据,已并入方案。" } },
    { say: "明写为何不跑了 —— 同样须**点名**(写出 skill 名,如 `xros:sharpen`)",
      sample: { text: "xros:sharpen 不跑了——它是多 agent 管线,只有用户能下。" } },
  ],
  message: (hits) =>
    `批窗口内调过 Skill 却**至今无下文**：${hits.join(", ")}。
` +
    `      法条：「**发起即欠账** —— 凡委派出去的任务，发起那一刻就成为本批欠账」（collab 四之三）。
` +
    `      实撞：我 Skill(xros:sharpen) 把指令载进来，被一条新消息打断、转头改别的，
` +
    `      **那次调用就此消失**；用户原话「要不是刚才我问一下现在根本没得管」。
` +
    `      出路:\n${renderEscapes(RULE_U.escapes)}\n` +
    `      不得静默丢掉 —— 丢掉的代价是一整天的手工重推。`,
  mutations: [
    { name: "不看正文提及（只看有无重调）", apply: (r) => ({ ...r, detect: (ctx) => {
      let w = null; try { w = ctx.window(); } catch { w = null; }
      if (!w) return [];
      return [...new Set(w.skills || [])].filter((sk) => !(ctx.skills || []).includes(sk)).slice(0, 3);
    } }) },
    { name: "不看窗口（只看本轮）", apply: (r) => ({ ...r, detect: () => [] }) },
  ],
  cases: {
    pos: [
      // 实撞形态：上轮调了 xros，本轮去改别的了，一字未提
      { text: "把 I 项的消息改了。",
        prior: [{ text: "发 skill", skill: "xros:sharpen" }] },
    ],
    neg: [
      // 正文里交代了
      { text: "xros:sharpen 没跑——我加载了然后被打断，现在补上。",
        prior: [{ text: "发 skill", skill: "xros:sharpen" }] },
      // ⚠️ **已关就是已关**：窗口里交代过了，本轮不提也不该再响。
      //   缺这条，U 会在每一轮不提它的消息上重复命中（实撞过）。
      { text: "接着改别的了。",
        prior: [{ text: "xros:sharpen 跑完了，产物已落盘。", skill: "xros:sharpen" }] },
      // 窗口里没调过 skill
      { text: "改完了。", prior: [{ text: "改", write: "scripts/a.mjs" }] },
      // 没窗口 ⇒ 不判
      { text: "改完了。" },
    ],
  },
};

// ===== RULE_P BEGIN =====
// ⚠️ **这一行 import 必须一起进**(gate-rules.mjs 现有的 import 里没有 `CARRIER_SURFACE`,
//   只有 412 行的 `CREATION_SURFACE`)。ESM 的 import 声明会被提升,放在文件任意顶层位置都合法;
//   与 412 行那条从同一模块导入不同的名字,不构成重复绑定。
//   `stripQuoted` / `segments` 已由 413 行导入,本条不重复导。
// [hoisted] import { CARRIER_SURFACE } from "./gate-carriers.mjs";

// ── P(**阻断**):承重面批次三通道未跑够 ─────────────────────────────────────
//
// 从 `hook-stop-closure.mjs` 的内联块搬进引擎。搬的动机是**结构性的**,不是整洁:
//   INV-1..4 只对 `RULES` 数组里的规则生效,而 P 在数组外 ⇒
//   「阻断项不得只挂 kind:"text" 豁免」这条不变量**从来没管过 P**。
//   实测后果(2026-08-20):P 的纯文本豁免 `/配额耗尽|站点不可达|通道不可用/.test(text)`
//   一句话一次关掉三条通道,连**引用 P 自己的报错**都能关掉它(回声族)——
//   因为 P 的 message 正文里就写着「通道不可用」四个字。
//
// 本次搬迁只做两件事,**不动判据语义**(阈值 REARM_EVERY、窗口起点、需跑几遍照旧):
//   ① 计数面从「窗口 JSON 拉平成字符串」收到**结构化动作面**(ctx.actions / window().actions);
//   ② 豁免从文本面改成 `kind:"action"`,且**只认真实失败痕迹**:
//      必须存在一次**真的通道调用**,且**那一次调用的入参**里留着限流/配额/429/DNS 痕迹。
//      拿不到动作证据 ⇒ 不豁免(fail-closed)。
//
// ── 为什么「只收窄输入面」还不够,必须再收一层 ──────────────────────────────
// 旧式 `JSON.stringify(input)` 匹配 `codex-run.mjs`:全语料 **306 次通道①命中里只有 16 次是真调用**,
//   290 条(94.8%)是 `head -60 …codex-run.mjs`、`grep -n usage …codex-run.mjs`、
//   `Read {"file_path": "…codex-run.mjs"}` —— **只是读了一眼那个脚本**。
//   这些全在**工具入参**上,所以「换成结构化 ctx」并不能消灭它们。
//   故本条再收一层:**只认工具名 + 命令的参数面段首**。
//     · `codex` 那条:工具名含 codex(MCP 通路),或某个**段首是 node/npx** 的段
//       把 `codex-run.mjs` 当**脚本参数**执行且带 `--task|--poll|--resume`。
//       段用 `segments()` 切、用 `stripQuoted()` 只留参数面 ⇒
//       `echo "node codex-run.mjs --task t.md"`(引号内)与 `node -e "…"`(`-e` 不是脚本参数)
//       双双落空。已逐条探针核实。
//     · 子代理那条:`agents` 来自 `subagent_type` 入参,再要求 `grill:` / `_` 前缀。
//     · 联网那条:只认工具名 `WebSearch|WebFetch`。
//
// ── 承重面判据 ─────────────────────────────────────────────────────────────
// ⚠️ 2026-10-10(红队 a27628dd)起以 **git 事实**为主(`ctx.headFacts`,见 `_p` 里「触发面」那段头注);
//   本段描述的命令语法证据降为**回退面**(git 事实取不到时)与「别的 checkout」补充面。
// 旧式 `/git\s+commit/.test(toolRawText(turn)) && CARRIER_SURFACE.test(toolRawText(turn))`
//   扫的是**含工具输出**的裸文本 ⇒ 读到一份提到 `git commit` 与某承重路径的文档就触发。
// 新式两条证据,任一成立:
//   ① 本轮**真提交过**(`ctx.didCommit()`,gate-ctx 已排除 `echo git commit` / `--dry-run`)
//      且本轮 `Write/Edit` 的 file_path 里有承重件;
//   ② 某条 Bash 命令里既有真 commit 段,又有 `git add|commit` 段在**参数面**上带承重路径。
// CEILING(已实测并接受):`git commit -m "改了 docs/laws/collab.md"` —— 承重路径**只在引号里**
//   ⇒ 本条不算它是承重提交。这是 `stripQuoted` 的直接代价,方向是漏触发。
//   常态形态(同轮 Edit 承重件 → `git add -A && git commit`)由证据①接住,所以实际漏面很窄。
//   旧实现在这一点上更宽,代价是引用一句提交信息就能触发。**两害相权取漏触发**——
//   P 是阻断项,误触发的代价是每次都得手工放行,那正是「闸太吵会被绕过」的来路。
//
// ── 窗口 ───────────────────────────────────────────────────────────────────
// 旧实现的窗口是 `entries.slice(winStart)`,**含本轮**;引擎侧 `ctx.window()` 只有本轮之前。
//   故取值域 = **窗口 ∪ 本轮**,与旧实现同构。
//   `window()` 为 null(夹具/验收台不给 priorEntries)⇒ 值域退化成本轮 ⇒ 通道计数只会更少、
//   承重提交数只会更小(而 needRuns 有下限 1)⇒ **只会更严**,方向是 fail-closed,
//   与 registry 的 UNKNOWN 纪律同向。故不声明 `requires`(`window` 恒是函数,声明了也永不触发)。
//
// CEILING(照旧,搬迁不改):只证「该通道被调用过几次」,不证调用得对、不证结论被采纳;
//   只数承重面提交次数,不看每次改了多少、是否同一文件反复改。
// CEILING(引擎侧,搬迁时才看清):`kind:"action"` 豁免拿到的 ctx 被剥掉了 `text`,
//   但 `window()` 是同一个闭包,**window 那一层的 text 没有被剥**。本条的豁免因此
//   刻意只碰 `.actions`,一个字的文本面都不读——这条纪律靠注释与用例守着,不靠引擎。
/** P 的变异工具:临时把 `_p` 里的若干零件换成 `patch[k](原件)` 的返回值,跑原 detect,跑完还原。
 *  拧的是**判据内部**的零件(codex 060:不许换成恒真/恒假的外壳)。 */
const swapP = (patch) => (r) => ({ ...r, detect: (ctx) => {
  const H = RULE_P._p, save = {};
  for (const k of Object.keys(patch)) { save[k] = H[k]; H[k] = patch[k](save[k]); }
  try { return r.detect(ctx); } finally { Object.assign(H, save); }
} });

const RULE_P = {
  id: "P",
  blocking: true,          // 用户常设授权:「新增阻断项一律授权自动化」
  law: "docs/laws/reporting.md#承重面三通道必跑",

  /** 判据零件。挂在规则对象上而不是模块作用域,是为了让 `mutations` 的
   *  `apply: (r) => ({...r, detect})` 能复用同一批零件——变异要拧的是**判据内部**,
   *  不是把整条判据换成一个恒真/恒假的壳(那种变异构造性恒真,已被 codex 060 判死)。 */
  _p: {
    GIT: /^(\w+=\S+\s+)*git\b/,
    /** `codex-run.mjs` 必须是**脚本参数**:node/npx 之后、只允许 `--flag` 形式的前置参数。
     *  `-e` / `-p` 是单横杠 ⇒ 匹配不上 ⇒ `node -e "…codex-run.mjs --task…"` 落空。 */
    NODE_CODEX: /^(\w+=\S+\s+)*(node|npx|bun|pnpm)\s+(--[\w-]+(=\S+)?\s+)*[^\s]*codex-run\.mjs(\s|$)/,
    CODEX_ARG: /\s--(task|poll|resume)(\s|=|$)/,
    /** 真实失败痕迹。**只在通道调用自己的入参上**看,不在别处看(见 exempts 头注)。 */
    FAIL_MARK: /rate.?limit|quota|\b429\b|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|配额(已)?耗尽|限流/i,

    rearm() { return Number(process.env.STOP_CLOSURE_P_REARM || 5) || 5; },

    /** 切段 + 只留参数面。引号里的东西一律不算参数(gate-cmd 的唯一实现)。 */
    segs(cmd) { return segments(cmd).map(stripQuoted); },

    // ══ 触发面(红队 a27628dd 轮重写:git 事实为主,命令语法为回退与补充)════════════════════
    //   动机:「本轮有没有承重提交 / 带没带进闸引擎改动」原来**从命令语法逐个补洞**——merge/cherry-pick 合回、
    //   bashWriteTargets 不认的写法(scratchpad 脚本、node -e 变量路径、perl -pi、git apply、checkout br -- f)、
    //   `cd docs/laws && sed -i … collab.md`、提交信息含 --dry-run、写入滑出 400 条窗口——红队一次给出七族,
    //   3f5aa7b 已是第 N 次补洞。这一族靠枚举收不完。
    //   现以 **git 事实**为准:hook 记下本会话上次 P 结清时的 HEAD(`.claude/.p-head/<会话>.json`,读写在 hook 侧),
    //   Stop 时取 `基点..HEAD` 首父链上被带进的提交及各自对第一父的改动文件(merge 同理)⇒ `ctx.headFacts()`,
    //   再按 CARRIER_SURFACE / ENGINE_REL / NON_CARRIER_AREA 归类。改文件用什么写法、在哪一轮写、谁写的(子代理/worktree),
    //   一概不问——问的是「本仓 HEAD 上落了什么」。
    //   失效条件(任一 ⇒ 事实为 null ⇒ 回退下面的命令语法判据,fail-closed,不静默放行):
    //     无会话 id、基点文件缺且 reflog 查不到会话开始时的 HEAD(含 reflog 被截断、起点晚于会话开始,a2a9f58b BP-2)、
    //     git 失败/超时。
    //   基点之后首父链提交 > 60 条(readHeadFacts 的 CAP)**不再是失效条件**(红队 a9af71da BP-1:原返回 null ⇒ 基点永不推进 ⇒
    //     本会话此后恒回退语法面,merge 合回的闸改动看不见):hook 把整段当一笔聚合提交(`aggregated:true`、`count`、改动=范围净差),
    //     计账按 `count`(`tally`),P 结清即推进基点。基点文件缺且 reflog 取不到时,退用当前批的 baseCommit(须是 HEAD 祖先)。
    //   取不到时 hook **不推进基点**(a2a9f58b BP-2):否则回退面沉默的那一轮会把之前欠的范围吃掉。
    //   已知天花板:同一 checkout 里**别的会话**的提交也会算进本会话范围(宪法要求并行写各开 worktree,故按违规处理);
    //   基点不是 HEAD 祖先(amend/reset/换分支)时取 merge-base..HEAD 的首父链提交,各自改动只留「基点与 HEAD 之间真有差」的路径
    //   (a2a9f58b BP-9:reset 撤掉的承重改动不再算成本次改动;只改信息的 amend ⇒ 无改动);红队切点至少取基点自身那条链上
    //   最后一次闸改动的时刻(BP-3:不因 merge-base 更早而放宽)。
    //   命令语法判据只在三处还活着:① git 事实取不到时的回退;② git 事实看不见的**别的 checkout** 的提交(他仓宪法照样算);
    //   ③ 本轮有提交命令、而本仓范围里没有本轮的提交 ⇒ 提交落在别处(同一调用内先 `cd` 到他仓、后续用相对路径,a2a9f58b BP-4),
    //     此时按**本轮**的命令语法判(只看本轮,不看窗口:窗口里早已提交过的承重写入不得被一次空提交重新翻出来)。
    //     「落在别处」须有正向证据(红队 a9af71da BP-5),且**只认同一次调用内**的证据(跨调用 cwd 跟踪 2026-10-11 删除,
    //     理由与让出面见 commitOutsideRoot 头注):该调用内提交前 cwd 已在本仓根外,或提交段带 `git -C <根外>` / git-dir / work-tree 根外;
    //     没有 ⇒ 视为本仓提交失败(未暂存 / pre-commit 失败 / 权限被拒),不计。
    //     同调用内去向解不出(UNK_PARSE:变量、命令替换、`~user` 等)⇒ 按 0aa11fd 之前语义算别处;
    //     「cd 本身失败」(结果正文带 cd 失败特征)⇒ 该调用的 cd 按原地(红队 a07e98e9 BP-1/BP-2、ad3e4f93 BP-1;详 commitOutsideRoot 头注)。
    //   计数(a2a9f58b BP-1):宽限账与 detect 同取 `tally`——git 事实在 ⇒ 范围内带承重改动、且账上没记过 sha 的提交数;
    //     取不到 ⇒ 命令语法。原来计数仍是命令语法:`git add -A` / `commit -am` / merge 合回计 0 ⇒ 宽限账永不涨。

    /** 本仓闸引擎(仓相对路径,锚定)。git 事实只用它;外发暂存树(clipboard/,gitignore)与 worktree 本就不在 diff 里。 */
    ENGINE_REL: /^scripts\/(?:hook-stop-closure|hook-guard)\.mjs$|^scripts\/lib\/gate-[\w-]+\.mjs$/i,
    /** 与 ENGINE_REL 同一口径的 git pathspec(hook 取「上一次带闸改动的提交」时用;改一处必改另一处,自测钉着)。 */
    ENGINE_PATHSPECS: ["scripts/hook-stop-closure.mjs", "scripts/hook-guard.mjs", ":(glob)scripts/lib/gate-*.mjs"],
    /** 聚合项(readHeadFacts 范围超 CAP=60)缺 `count` 时的计数下限 = CAP+1(范围至少这么多笔)。 */
    AGG_MIN: 61,
    /** 语法回退面的闸引擎路径:锚定文件名结尾,裸名只在路径**开头**认(`cd scripts/lib` 之后的相对形)。
     *  派出方裁定(a27628dd):`clipboard/oss/public-repo/**` 与 `.claude/worktrees/**` 下的闸副本不算本仓闸引擎。 */
    ENGINE_PATH_RE: /(?:^|\/)scripts\/(?:hook-stop-closure|hook-guard)\.mjs$|(?:^|\/)scripts\/lib\/gate-[\w-]+\.mjs$|^(?:hook-stop-closure|hook-guard|gate-(?:rules|ctx|carriers|registry|cmd|slice|difftier))\.mjs$/i,
    WORKTREE_AREA: /(^|\/)\.claude\/worktrees\//i,
    /** root = hook 所在 checkout 根(ctx.hookCheckout):落在它下面的绝对路径先化成仓相对形再判区域——
     *  在 worktree 里开的会话,自己的闸文件路径本就含 `.claude/worktrees/`,不得当成别人的副本。 */
    isEnginePath(p, root) {
      const H = RULE_P._p;
      let s = H.resolve(null, p);
      if (root) {
        const r = H.resolve(null, root).replace(/\/+$/, "");
        if (r && s.toLowerCase().startsWith(r.toLowerCase() + "/")) s = s.slice(r.length + 1);
      }
      if (!s || NON_CARRIER_AREA.test(s) || H.WORKTREE_AREA.test(s)) return false;
      return H.ENGINE_PATH_RE.test(s);
    },
    isCarrierOrEngine(p, root) { return isCarrierPath(CARRIER_SURFACE, p) || RULE_P._p.isEnginePath(p, root); },

    /** git 事实;null = 取不到或没接(⇒ 回退语法判据)。 */
    facts(ctx) {
      if (!ctx || typeof ctx.headFacts !== "function") return null;
      try { return ctx.headFacts() || null; } catch { return null; }
    },
    touches(c, pred) { return (c.files || []).some((f) => pred(normPath(f.path)) || (!!f.oldPath && pred(normPath(f.oldPath)))); },
    gitCarrierCommits(f) {
      const H = RULE_P._p;
      return f.commits.filter((c) => H.touches(c, (p) => isCarrierPath(CARRIER_SURFACE, p) || H.ENGINE_REL.test(p)));
    },
    gitEngineCommits(f) { const H = RULE_P._p; return f.commits.filter((c) => H.touches(c, (p) => H.ENGINE_REL.test(p))); },

    // ── 命令语法零件(回退与补充;唯一实现)──────────────────────────────────────
    stripHeredoc(cmd) { return String(cmd || "").replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " "); },
    /** 路径归一:分隔符、/d/ 形、`.` 与 `..` 段。 */
    resolve(cwd, p) {
      const fix = (s) => String(s || "").replace(/\\/g, "/").replace(/^\/([a-z])(\/|$)/i, "$1:/");
      const t = fix(p);
      const abs = /^([A-Za-z]:)?\//.test(t) || t.startsWith("~");
      const full = abs || !cwd ? t : `${fix(cwd)}/${t}`;
      const lead = /^([A-Za-z]:)?\//.exec(full)?.[0] ?? "";
      const parts = [];
      for (const seg of full.slice(lead.length).split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") { parts.pop(); continue; }
        parts.push(seg);
      }
      return lead + parts.join("/");
    },
    /** 按段走一遍(heredoc 正文先剥掉,不当命令),跟踪 `cd`/`pushd`:交出 [{seg, cwd}]。cwd=null=沿用会话当前目录。
     *  红队 a27628dd BP-3:`cd docs/laws && sed -i … collab.md` 原来取到裸名 `collab.md` ⇒ 不算承重。 */
    //   红队 aaf414b6 BP-1:P 的各调用点**按工具名传方言**(`d` = "ps" / "bash";取自 `bashDialects` 或动作 name)——
    //   不传时 bashWriteTargets 靠 cmdDialect 自判,PowerShell 里的别名 / 裸重定向 + 不加引号的反斜杠路径没有「动词-名词」cmdlet
    //   ⇒ 判成 bash ⇒ 反斜杠被当转义吃掉(`cp clipboard\x.md docs\laws\collab.md` ⇒ `docslawscollab.md`)。d 缺 ⇒ 照旧自判。
    dOf(a) { return String((a && a.name) || "") === "PowerShell" ? "ps" : "bash"; },
    walk(cmd, d) {
      const H = RULE_P._p, out = [];
      const ps = d === "ps";
      let cwd = null;
      for (const seg of segments(ps ? String(cmd || "") : H.stripHeredoc(cmd), ps)) {
        const m = /^(?:cd|pushd)\s+(?:-[LP]\s+)?(["']?)([^"'\s;&|]+)\1\s*$/.exec(seg);
        if (m) { cwd = H.resolve(cwd, m[2]); continue; }
        out.push({ seg, cwd });
      }
      return out;
    },
    /** cd 解析后的 Bash 写目标(写目标识别仍是 `bashWriteTargets` 唯一实现),过谓词。 */
    writeTargets(cmd, pred, d) {
      const H = RULE_P._p, out = [];
      for (const { seg, cwd } of H.walk(cmd, d)) {
        let ts = [];
        try { ts = bashWriteTargets(seg, /[\s\S]/, { dialect: d }); } catch { ts = []; }
        for (const t of ts) { const r = H.resolve(cwd, t); if (pred(r)) out.push(r); }
      }
      return out;
    },
    /** `git add|stage|commit` 段的路径参数(子命令位判定与载荷剥离走 gate-ctx `gitArgs` 唯一实现;cd 与 -C 解析后)。
     *  红队 a27628dd BP-6:原式「git 段任意位置出现 add/commit」⇒ `git log -S commit -- 闸文件` 也算。 */
    gitPathArgs(cmd, d) {
      const H = RULE_P._p, out = [];
      for (const { seg, cwd } of H.walk(cmd, d)) {
        const g = gitArgs(seg);
        if (!g || !/^(add|stage|commit)$/.test(g.sub)) continue;
        const base = g.cdir ? H.resolve(cwd, g.cdir) : cwd;
        for (const a of g.args) if (a && !a.startsWith("-")) out.push(H.resolve(base, a));
      }
      return out;
    },
    /** 这条命令里有没有一次提交(gate-ctx `isCommitSeg` 唯一实现:子命令位 + 先剥载荷再判 --dry-run;红队 a27628dd BP-4)。 */
    hasCommit(cmd, d) { return (d === "ps" ? segments(String(cmd || ""), true) : segments(RULE_P._p.stripHeredoc(cmd))).some((s) => isCommitSeg(s)); },

    /** 这条命令是不是**一次承重面提交**:有真 commit 段 + add/stage/commit 段的路径参数里有承重件。
     *  `-m/-F` 载荷不算路径(提交信息里提到路径=提及不是暂存,头注 CEILING);引号路径照认(2026-08-22 真回归)。 */
    isCarrierCommitCmd(cmd, d) {
      const H = RULE_P._p;
      if (!H.hasCommit(cmd, d)) return false;
      return H.gitPathArgs(cmd, d).some((p) => H.isCarrierOrEngine(p));
    },
    carrierCommitCount(c) {
      if (!c || !Array.isArray(c.bashCmds)) return 0;
      return c.bashCmds.filter((cmd, i) => RULE_P._p.isCarrierCommitCmd(cmd, c.bashDialects?.[i])).length;
    },
    /** 本轮(withWin 时 ∪ 窗口)的 [命令, 方言] 对:bashCmds 与 bashDialects 等长同序,拼接时同步拼(aaf414b6 BP-1)。 */
    cmdPairs(ctx, withWin) {
      const w = withWin ? RULE_P._p.win(ctx) : null;
      const pairs = (c) => (c && Array.isArray(c.bashCmds) ? c.bashCmds.map((cmd, i) => [cmd, c.bashDialects?.[i]]) : []);
      return [...pairs(ctx), ...pairs(w)];
    },

    /** 本次 Stop 新增的承重提交数(a2a9f58b BP-1;**hook 计账与 detect 的唯一取值**)。返回 `{ n, shas }`:
     *  · 未触发 ⇒ 0;
     *  · git 事实在 ⇒ 范围内带承重 / 闸引擎改动、且 `pLedger.shas` 里没有的提交数(P 欠着时基点不推进 ⇒ 同一批提交下次还在,
     *    按 sha 去重,一笔只计一次),加上别处补充面(他仓 / 提交落在别处)的笔数;`shas` = 本次新计的提交,hook 落账;
     *  · 取不到 ⇒ 命令语法(参数面承重提交数,触发了至少计 1——写在前几轮、本轮 `git add -A` 的形态参数面是 0)。
     *  失效条件:git 事实为 null 的那几轮按语法计,之后事实恢复时同一批提交会按 sha 再计一次(只会多计,方向偏严)。 */
    tally(ctx) {
      const H = RULE_P._p;
      if (!ctx || !H.triggered(ctx)) return { n: 0, shas: [] };
      const f = H.facts(ctx);
      if (!f) return { n: Math.max(H.carrierCommitCount(ctx), 1), shas: [] };
      const seen = new Set(((ctx.pLedger && ctx.pLedger.shas) || []).map((s) => String(s).toLowerCase()));
      // 去重键(codex 257-p-agg-r1 断言 2 证伪「HEAD sha 去重」):聚合项代表「基点..HEAD」整段,只按 HEAD sha 去重时,
      //   基点回退再前进到同一 HEAD,范围变大却被整项吞掉(61 笔历史实测最后一步计 0)。改按范围 `agg:<基点>..<HEAD>` 去重;
      //   取不到基点 ⇒ 不去重(重计,偏严)。普通提交仍按自身 sha。
      const key = (c) => (c.aggregated ? (f.base && c.sha ? `agg:${f.base}..${c.sha}`.toLowerCase() : null) : (c.sha ? String(c.sha).toLowerCase() : null));
      const fresh = H.gitCarrierCommits(f).filter((c) => { const k = key(c); return !(k && seen.has(k)); });
      const away = H.elsewhereHit(ctx, f) ? (H.commitsElsewhere(ctx, f) ? Math.max(H.carrierCommitCount(ctx), 1) : 1) : 0;
      // 红队 a9af71da BP-1:聚合项(范围超 CAP,整段当一笔)带承重改动 ⇒ 按范围提交数 `count` 计(其中几笔带承重改动取不到,
      //   按全数计);count 缺 ⇒ 61——是下界不是上界(实际 75 笔取不到总数时计 61),仍远超宽限门槛 5,方向上照拦。
      //   去重按范围键(见上):同一段范围不重计;范围变了(HEAD 前移或基点变)⇒ 整段再计一次(偏严)。
      const weight = (c) => (c.aggregated ? (Number.isInteger(c.count) && c.count > 0 ? c.count : H.AGG_MIN) : 1);
      return { n: fresh.reduce((s, c) => s + weight(c), 0) + away, shas: fresh.map(key).filter((s) => typeof s === "string" && s) };
    },

    /** a2a9f58b BP-4:本轮有提交命令,而本仓范围里**没有本轮的提交** ⇒ 这些提交落在别处(同一调用内
     *  `cd E:/elsewhere && … && git commit`;只认同一调用内证据,跨调用不跟踪,见 commitOutsideRoot 头注)。
     *  「本轮的提交」= 提交时刻不早于本轮第一条提交命令的那一秒;时刻缺(夹具 / 本轮动作无时间戳)⇒ 范围里任一提交都算本轮的。
     *  红队 a9af71da BP-5(误拦):原把「本仓范围里没有本轮提交」直接判成落在别处 ⇒ 本仓 `git commit` 因未暂存 / pre-commit 失败 /
     *  权限被拒没落盘时也计 1 笔别处。现须**正向证据**(`commitOutsideRoot`):本轮某次提交执行时 cwd 在本仓根外
     *  (同一调用内按序追踪 cd 类段,每次调用起点 = 本仓根),或提交段自带 `git -C <根外>`。没有 ⇒ 视为本仓提交失败,不计别处。 */
    commitsElsewhere(ctx, f) {
      const H = RULE_P._p;
      const own = (Array.isArray(ctx.actions) ? ctx.actions : []).filter((a) => /^(Bash|PowerShell)$/.test(String((a && a.name) || ""))
        && H.hasCommit(String((a.input && a.input.command) || ""), H.dOf(a)));
      if (!own.length) return false;
      const ats = own.map((a) => a.at).filter(Number.isFinite);
      const start = ats.length ? Math.floor(Math.min(...ats) / 1000) * 1000 : null;
      if (f.commits.some((c) => start === null || !Number.isFinite(c.at) || c.at >= start)) return false;
      return H.commitOutsideRoot(ctx, f.root || ctx.hookCheckout || null);
    },
    /** cd 类段的去向(只给 `commitOutsideRoot` 的 cwd 追踪用)。bash `cd`/`pushd`/`chdir`,PowerShell `Set-Location`/`sl`/`Push-Location`
     *  (`-Path`/`-LiteralPath` 取值,其余 `-x` 选项跳过)。返回 null(不是 cd 段)/ {to:路径} / {home:剩余段} / {back:true}(`cd -`)/
     *  {pop:true}(popd / Pop-Location)/ {dyn:true}(变量、命令替换等解不出的目标)/ {stay:true}(PowerShell 无参)。 */
    //   红队 a07e98e9 BP-2:PowerShell 冒号形 `-Path:E:\x` / `-LiteralPath:X`(原当未知选项跳过 ⇒ 无参 ⇒ stay)、
    //   `-Path: X`(冒号后空格)照取值;PowerShell 段恰为盘符 `E:` ⇒ 切盘,交 {to:"E:"}(盘符相对,解析在 commitOutsideRoot)。
    //   段首子 shell / 大括号组的 `(` / `{` 由调用方剥(commitOutsideRoot 的 `scope`),本函数只看剥后的正文。
    cdOf(seg, ps) {
      const s = String(seg || "").trim();
      if (ps && /^[A-Za-z]:$/.test(s)) return { to: s };
      if (/^(?:popd|pop-location)(?:\s+-\S+(?:\s+\S+)?)*\s*$/i.test(s)) return { pop: true };
      const m = /^(cd|pushd|chdir|set-location|sl|push-location)(?:\s+([\s\S]*))?$/i.exec(s);
      if (!m) return null;
      const toks = String(m[2] || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
      let target = null;
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const cm = /^-(?:path|literalpath):([\s\S]*)$/i.exec(t);
        if (cm) { target = cm[1] !== "" ? cm[1] : (toks[i + 1] ?? null); break; }
        if (/^-(?:path|literalpath|stackname)$/i.test(t)) { if (/^-(?:path|literalpath)$/i.test(t)) { target = toks[i + 1] ?? null; break; } i++; continue; }
        if (t === "-") { target = "-"; break; }
        if (t === "--") { target = toks[i + 1] ?? null; break; }
        if (/^-/.test(t)) continue;
        target = t; break;
      }
      if (target === null) return ps ? { stay: true } : { home: "" };
      if (target === "-") return { back: true };
      const u = target.replace(/^(["'])([\s\S]*)\1$/, "$2");
      if (/[$`%(]/.test(u)) return { dyn: true };
      const hm = /^~(?:[\\/](.*))?$/.exec(u);
      if (hm) return { home: hm[1] || "" };
      if (/^~/.test(u)) return { dyn: true };                    // ~user 形
      return { to: u };
    },
    /** 段的作用域外壳(a07e98e9 BP-1):剥段首 `(` / `{ ` 与段尾 `)` / ` }`(只认引号外),交出
     *  `{ body, open, close }`——`open` = 段首子 shell 开符数,`close` = 本段净收掉的层数(段尾 `)` 减去段内未配对的 `(`,
     *  如 `echo $(pwd))` 只收 1 层)。段内净开(`echo $(cd /x` 切段后)⇒ `open` 另加该数(命令替换也是子 shell)。
     *  大括号组 `{ …; }` 不开层(bash 语义:组内 cd 持久)。 */
    scope(seg, ps) {
      const raw = String(seg || "");
      let m = raw;
      try { m = stripQuoted(raw, ps); } catch { m = raw; }
      // 手扫(不用带嵌套量词的尾锚正则:长空白串上会退化成平方回溯)
      //   空白按 **raw** 判(掩码把引号内容抹成空格:按掩码判会把段尾的 `'\repo'` 当空白剥掉),
      //   括号按**掩码**判(只认引号外的;掩码与 raw 等长同下标)。
      const sp = (c) => c === " " || c === "\t" || c === "\r" || c === "\n";
      if (m.length !== raw.length) m = raw;
      let a = 0, lopen = 0;
      for (;;) {
        while (a < raw.length && sp(raw[a])) a++;
        if (m[a] === "(") { lopen++; a++; continue; }
        if (m[a] === "{" && (a + 1 >= raw.length || sp(raw[a + 1]))) { a++; continue; }
        break;
      }
      let b = raw.length, tclose = 0;
      for (;;) {
        while (b > a && sp(raw[b - 1])) b--;
        if (b > a && m[b - 1] === ")") { tclose++; b--; continue; }
        if (b > a && m[b - 1] === "}" && (b - 1 === a || sp(raw[b - 2]))) { b--; continue; }
        break;
      }
      const body = raw.slice(a, b).trim();
      const inner = m.slice(a, b);
      let bal = 0;
      for (const c of inner) { if (c === "(") bal++; else if (c === ")") bal--; }
      const open = lopen + Math.max(0, bal - tclose);
      const close = Math.max(0, tclose - Math.max(0, bal)) + Math.max(0, -bal);
      return { body, open, close };
    },
    /** 本轮某次提交执行时是否在本仓根外(BP-5 的正向证据)。**只认同一次调用(同一个 Bash / PowerShell tool_use)内的证据**:
     *  本轮动作逐次走,**每次调用起点一律是本仓根**(`callStart`;Bash 与 PowerShell 同),调用内按段跟踪 cwd。算「别处」的形态(任一即是):
     *    · 本次调用内 `cd` / `pushd` / `chdir` / `Set-Location` / `sl` / `Push-Location` 到根外之后的提交段(去向由 `cdOf` 解:
     *      子 shell `( … )` / 命令替换 `$( … )` 里的 cd 只作用到该层结束(`scope` 给层数;调用结束未闭合的层一律弹回);
     *      大括号组 `{ …; }` 的 cd 持久(bash 语义);PowerShell 的 `( … )` 不是作用域 ⇒ 只剥符号、不开层;`-Path:` 冒号形照取值;
     *      PowerShell 裸盘符 `E:` / 盘符相对 `E:sub` 回到该盘本次调用内上次所在,没见过的他盘 ⇒ 根外;
     *      `cd ~` 类:本仓根在 Users|home/<名> 下 ⇒ 按该家目录解,否则视为根外);
     *    · 提交段的 `git -C <根外>`(按序叠加,含 `~`)、`--work-tree` / `--git-dir` / `GIT_WORK_TREE=` / `GIT_DIR=`
     *      (前缀,或同一调用内 `export` / 裸赋值 / `$env:`)——**任一**落在根外即算(`commitTargets`;提交进的是 git-dir 那个仓:
     *      `--git-dir=../x/.git --work-tree=.` 只看 work-tree 会漏);
     *    · 同一调用内去向解不出(UNK_PARSE:变量 / 命令替换 / `~user` / popd 栈空 / `cd -` 无前值 / 相对路径接在根外或解不出的位置后 /
     *      bash 下同盘的裸盘符)之后的提交段 ⇒ 按 0aa11fd 之前语义**算可能在别处**(0aa11fd~ba5c9c2 视为本仓 ⇒ `git -C ~/notes` 等一律漏放)。
     *  同一调用内 cd 本身失败:Bash `cd X && git commit` 的 `&&` 链 cd 失败则提交不跑,无需特判;结果报错且正文带 cd 失败特征
     *    (`CD_FAIL`,codex 257-p-agg-r1「没问到」②)⇒ 该调用里的 cd **一律按原地**(没生效),两种 shell 同一处置——PowerShell 的
     *    Set-Location 失败本就不改位置;bash 原记「未知」只在跨调用跟踪里与原地有别,跨调用删掉后原地更简单,且其后 `-C` 相对路径照常按根解。
     *    其余失败(管道尾 grep 退 1 / push 失败 / 超时 / 打断)不抹 cd(红队 ad3e4f93 BP-1)。
     *  **为什么不做跨调用跟踪**(2026-10-11 派出方裁定,删掉 Bash 调用边界回置 / 回置声明采信 / PS·Bash 分账 / 未知跨调用 /
     *    认不出的 cd 外壳 / PS cd 失败原地 / pushd 栈跨调用整套):本批为它连修五轮(0aa11fd、afdd279、52779ec、620e556、f7306ec),
     *    每轮复核红队都在跨调用边界上找出新形态,而这些形态在语料里全是 0 次(派出方自统计,本机 182 份主转录:PS 1346 次调用、
     *    变量形 cd 0、Push/Pop-Location 0、回置声明 825 条里命令无 cd 类词 0 条、PS「上一次切目录、下一次不带 cd 提交」1 次);
     *    52779ec 的语料回放显示「只靠跨调用状态判别处」的提交修后 0 个,真实他仓提交都是同一调用形(`cd /d/dotfiles-claude && … git commit`)。
     *  让出的面(登记):
     *    · PowerShell 在一次调用里 `Set-Location` 他仓、下一次调用不带 cd 直接提交 ⇒ 判本仓(PS 跨调用若保持 cwd 即漏放;语料 1 次);
     *    · Bash 上一次调用 cd 进根内子目录(CC 对根内 cd 跨调用保持)、本次 `cd ..` 后本仓提交失败 ⇒ 起点按根算、`..` 解出根外 ⇒
     *      计别处(诚实误拦;pos「已知残余」夹具钉着);
     *    · 非交互会话(`-p` / SDK / 云端)里 Bash cd 跨轮保持(本机 changelog 第 2408 行)⇒ 上一次 cd 他仓、本次相对路径提交 ⇒ 判本仓(漏放);
     *    · 会话从仓内子目录启动时真实起点是该子目录不是根 ⇒ 相对 `cd ..` 差一层;窗口(上几轮)里的 cd 一律不看。
     *  兜底:git 事实层(本仓 `基点..HEAD` 范围,`facts` / `tally`)不依赖 cwd 跟踪,仍独立兜住**本仓**提交;本函数只在
     *    「本轮有提交命令、本仓范围里却没有本轮提交」时判那笔提交是不是落在别处(`commitsElsewhere`)。
     *  CEILING:`cd "$(git rev-parse --show-toplevel)"` 后同一调用内本仓提交失败 ⇒ UNK_PARSE ⇒ 计别处(诚实误拦,与漏放同价);
     *  一调用多个 cd、正文只说有一个失败 ⇒ 全部按原地 ⇒ 成功的出仓 cd 被抹(漏放)/ 成功的回仓 cd 被抹(误拦)两向都有;
     *  `CD_FAIL` 特征词宽(`No such file or directory` 也可能出自同一调用里别的命令)⇒ 那种调用里的 cd 按原地(偏放);
     *  正文缺(老转录 / 结果被截)⇒ 视为非 cd 失败、cd 照常生效(偏严);
     *  PS 内建 `cd..` / `cd\` / `cd~`(无空格的函数形,changelog 第 4856 行)与 `if …; then cd X; fi` / `do cd …` 等 cdOf 认不出的
     *  cd 外壳 ⇒ 当非 cd 段(漏放,登记);walk 的 cd 识别仍是 bash 专用、与本函数两套 cd 模型(BP-3)未动。 */
    CD_FAIL: /No such file or directory|Not a directory|Cannot find path|找不到路径|does not exist|(?:^|[\s:])(?:cd|pushd|popd|chdir): |(?:Set|Push|Pop)-Location\s*:/im,
    commitOutsideRoot(ctx, root) {
      const H = RULE_P._p;
      if (!root) return false;
      const R = H.resolve(null, root).replace(/\/+$/, "");
      if (!/^([A-Za-z]:)?\//.test(R)) return false;
      const home = /^((?:[A-Za-z]:)?\/(?:users|home)\/[^/]+)(?:\/|$)/i.exec(R)?.[1] ?? null;
      const OUT = "\0out", UNK = "\0unk-parse";
      const isPath = (l) => l !== OUT && l !== UNK;
      const fix = (p) => String(p).replace(/\\/g, "/").replace(/^\/([a-z])(\/|$)/i, "$1:/");
      const abs = (p) => /^([A-Za-z]:)?\//.test(fix(p));
      const driveOf = (l) => (isPath(l) ? (/^([A-Za-z]):/.exec(l)?.[1] || "").toLowerCase() : "");
      let st = null;                                 // 本次调用的 cwd 状态 {loc, prev, stack, lastOn};每次调用由 callStart 重起
      /** 一个去向串解成 loc(cd 目标、-C、work-tree、git-dir 共用)。 */
      const dest = (base, raw, ps) => {
        const u = String(raw ?? "").replace(/^(["'])([\s\S]*)\1$/, "$2");
        if (!u || /[$`%(]/.test(u)) return UNK;
        const hm = /^~(?:[\\/](.*))?$/.exec(u);
        if (hm) return home ? H.resolve(home, hm[1] || ".") : OUT;
        if (/^~/.test(u)) return UNK;                // ~user 形
        const dm = /^([A-Za-z]):(?![\\/])([\s\S]*)$/.exec(u);
        if (dm) {                                    // 盘符相对:`E:` / `E:sub`
          const d = dm[1].toLowerCase(), rd = driveOf(R), cur = st.lastOn.get(d);
          if (!ps || cur === undefined) return d === rd ? UNK : OUT;   // bash 下同盘裸盘符语义不定
          return dm[2] ? H.resolve(cur, dm[2]) : cur;
        }
        if (abs(u)) return H.resolve(null, u);
        if (base === OUT) return UNK;
        if (!isPath(base)) return base;              // 未知之后的相对路径:沿用未知
        return H.resolve(base, u);
      };
      const isOut = (l) => !isPath(l) || H.outside(l, R);
      for (const a of Array.isArray(ctx.actions) ? ctx.actions : []) {
        const name = String((a && a.name) || "");
        if (!/^(Bash|PowerShell)$/.test(name) || typeof (a.input && a.input.command) !== "string") continue;
        const ps = name === "PowerShell";
        let segs = [];
        try { segs = segments(ps ? a.input.command : H.stripHeredoc(a.input.command), ps); } catch { continue; }
        st = H.callStart(st, R);
        // 结果报错且正文带 cd 失败特征 ⇒ 本调用的 cd 一律按原地(见头注;其余失败不抹 cd,红队 ad3e4f93 BP-1)
        const cdFailed = !!(a.err && H.CD_FAIL.test(String(a.errText || "")));
        let { loc, prev, stack } = st;
        const frames = [];                           // 子 shell 层:进入前的 {loc, prev, stack, env}
        let env = {};                                // 本调用内设过的 GIT_DIR / GIT_WORK_TREE(原始串,提交时按当时 cwd 解)
        const enter = (n) => { for (let k = 0; k < n; k++) frames.push({ loc, prev, stack: [...stack], env: { ...env } }); };
        const leave = (n) => { for (let k = 0; k < n && frames.length; k++) { const f = frames.pop(); loc = f.loc; prev = f.prev; stack = f.stack; env = f.env; } };
        for (const seg of segs) {
          const sc = H.scope(seg, ps);
          if (!ps) enter(sc.open);
          const body = sc.body;
          const cd = body ? H.cdOf(body, ps) : null;
          if (cd) {
            if (!cdFailed) {
              const was = loc;
              if (cd.pop) { loc = stack.length ? stack.pop() : UNK; prev = was; }
              else if (!cd.stay) {                   // PowerShell 无参:原地
                if (cd.back) loc = prev === null ? UNK : prev;
                else if (cd.dyn) loc = UNK;
                else if ("home" in cd) loc = home ? H.resolve(home, cd.home || ".") : OUT;
                else loc = dest(loc, cd.to, ps);
                if (/^(pushd|push-location)\b/i.test(body)) stack.push(was);
                prev = was;
              }
              const d = driveOf(loc);
              if (d) st.lastOn.set(d, loc);
            }
          } else if (body) {
            const em = ps ? /^\$env:(GIT_DIR|GIT_WORK_TREE)\s*=\s*([\s\S]+)$/i.exec(body)
              : /^(?:export\s+)?(GIT_DIR|GIT_WORK_TREE)=(\S*)$/.exec(body);
            if (em) env[em[1].toUpperCase()] = em[2].trim();
            const um = ps ? /^remove-item\s+(?:-path\s+)?env:(GIT_DIR|GIT_WORK_TREE)\s*$/i.exec(body) : /^unset\s+(GIT_DIR|GIT_WORK_TREE)\s*$/.exec(body);
            if (um) delete env[um[1].toUpperCase()];
            if (isCommitSeg(body) && H.commitTargets(gitArgs(body), env, loc, (b, x) => dest(b, x, ps)).some(isOut)) return true;
          }
          if (!ps) leave(sc.close);
        }
        leave(frames.length);                        // 调用结束:未闭合的子 shell 层一律弹回
        Object.assign(st, { loc, prev, stack });
      }
      return false;
    },
    /** 每次调用的 cwd 起点:**一律本仓根 R**(Bash 与 PowerShell 同;不做跨调用跟踪,理由与让出面见 commitOutsideRoot 头注)。
     *  `prev` = 上一次调用结束时的状态,刻意不用(变异「每次调用起点不回根」把它接回来,证人 = 两条「上一次调用 cd 他仓」反例)。 */
    callStart(prev, R) {
      const s = { loc: R, prev: null, stack: [], lastOn: new Map() };
      const d = (/^([A-Za-z]):/.exec(R)?.[1] || "").toLowerCase();
      if (d) s.lastOn.set(d, R);
      return s;
    },
    /** 提交段的全部去向候选:当时 cwd 依次叠 `git -C`,再加 `--work-tree` / `--git-dir`(段内参数优先,否则本调用设过的
     *  `GIT_WORK_TREE` / `GIT_DIR`,段首前缀并入 `g.env`)按叠完的目录解。`res(base, raw)` = 去向解析。任一在根外 ⇒ 别处。 */
    commitTargets(g, env, loc, res) {
      let dir = loc;
      for (const c of (g && g.cdirs) || []) dir = res(dir, c);
      const e = { ...env, ...((g && g.env) || {}) };
      const wt = (g && g.workTree) ?? e.GIT_WORK_TREE ?? null, gd = (g && g.gitDir) ?? e.GIT_DIR ?? null;
      return [dir, ...[wt, gd].filter((x) => typeof x === "string").map((x) => res(dir, x))];
    },
    /** 本轮(不含窗口)的命令语法承重证据:参数面承重提交 / 本轮 Write·Edit 承重件 / 本轮 Bash 写目标(cd 解析后)落承重件。 */
    ownSyntaxCarrier(ctx) {
      const H = RULE_P._p, isC = (p) => H.isCarrierOrEngine(p, ctx.hookCheckout || null);
      if (H.carrierCommitCount(ctx) > 0) return true;
      if ((ctx.writes || []).some(isC)) return true;
      return H.cmdPairs(ctx, false).some(([cmd, d]) => { try { return H.writeTargets(cmd, isC, d).length > 0; } catch { return false; } });
    },
    /** git 事实在时的补充面是否命中(他仓绝对路径 / 提交落在别处)。只在本轮真提交过时看。 */
    elsewhereHit(ctx, f) {
      const H = RULE_P._p;
      if (!(typeof ctx.didCommit === "function" && ctx.didCommit())) return false;
      if (H.elsewhereCarrier(ctx, f.root)) return true;
      return H.commitsElsewhere(ctx, f) && H.ownSyntaxCarrier(ctx);
    },

    /** 红队 agent 且入参绑定闸文件/规则 id/diff(D11 + 红队 182 BP-9)。 */
    isBoundHunter(a) {
      if (!a || !/^(Agent|Task)$/.test(String(a.name || ""))) return false;
      const t = String((a.input && (a.input.subagent_type || a.input.agentType)) || "");
      return /^_gate-bypass-hunter$/.test(t) && RULE_P._p.hunterBound(a);
    },
    /** 红队 182 BP-9:起一次空 prompt 的 `_gate-bypass-hunter` 也满足收紧 ⇒ 与 W 的 reviewedOne 同法,
     *  入参须提及闸引擎文件名 / 规则 id / diff 文件——只证发起,不证采纳(与另两通道同一 CEILING)。 */
    hunterBound(a) {
      const p = JSON.stringify((a && a.input) || {});
      return /hook-stop-closure|hook-guard|gate-[\w-]+\.mjs|\.diff\b|规则 ?id|rule ids?|\bRULE_[A-Z0-9]+\b|批 ?\d{3}/i.test(p);
    },
    /** 旧整串正则(hook-start-gate 按名引用它判「本批碰没碰闸引擎」,口径与本条同源;P 自己改用上面三件)。 */
    GATE_ENGINE: /scripts\/(hook-stop-closure|hook-guard)\.mjs|scripts\/lib\/gate-[\w-]+\.mjs|(?:^|[\s/"'=])(?:hook-stop-closure|hook-guard|gate-(?:rules|ctx|carriers|registry|cmd|slice|difftier))\.mjs\b/i,

    /** 本批提交是否**带进了闸引擎改动**(D11 收紧的适用面)。
     *  · git 事实在 ⇒ **只认** `基点..HEAD` 上被带进的提交里有没有本仓闸引擎文件(派出方 a27628dd 口径①:
     *    不认 400 窗口里任意一次闸写入——那是 BP-7 / 量化 a00051d 14/26 误拦的成因之一)。
     *  · 取不到 ⇒ 回退语法判据:窗口 ∪ 本轮里**最后一次绑定红队之后**的闸写入 / 暂存(BP-7:红队之前的改动已被它覆盖)。
     *  结果按 ctx 缓存(独立视角通道的谓词对每个动作都调它)。 */
    _engMemo: new WeakMap(),
    gateEngineTouched(ctx) {
      const H = RULE_P._p;
      if (!ctx || typeof ctx !== "object") return false;
      if (H._engMemo.has(ctx)) return H._engMemo.get(ctx);
      const f = H.facts(ctx);
      const v = f ? H.gitEngineCommits(f).length > 0 : H.engineBySyntax(ctx);
      H._engMemo.set(ctx, v);
      return v;
    },
    engineBySyntax(ctx) {
      const H = RULE_P._p, w = H.win(ctx), root = ctx.hookCheckout || null;
      const acts = [...((w && Array.isArray(w.actions)) ? w.actions : []), ...(Array.isArray(ctx.actions) ? ctx.actions : [])];
      let last = -1;
      acts.forEach((a, i) => { if (H.isBoundHunter(a)) last = i; });
      const eng = (p) => H.isEnginePath(p, root);
      for (const a of acts.slice(last + 1)) {
        const name = String((a && a.name) || ""), inp = (a && a.input) || {};
        const fp = inp.file_path || inp.notebook_path;
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name) && typeof fp === "string" && eng(fp)) return true;
        if (/^(Bash|PowerShell)$/.test(name) && typeof inp.command === "string") {
          try {
            if (H.writeTargets(inp.command, eng, H.dOf(a)).length) return true;
            if (H.gitPathArgs(inp.command, H.dOf(a)).some(eng)) return true;
          } catch { /* 解析失败不算证据(回退面;git 事实面不受影响) */ }
        }
      }
      return false;
    },

    /** 绝对路径且不在本 checkout 下(他仓 / 别的 checkout)。worktree 在仓根之内 ⇒ 不算「外」(派出方裁定:不算本仓)。 */
    outside(p, root) {
      const H = RULE_P._p, n = H.resolve(null, p).toLowerCase();
      if (!/^([a-z]:)?\//.test(n)) return false;
      if (!root) return true;
      const r = H.resolve(null, root).toLowerCase().replace(/\/+$/, "");
      return !(n === r || n.startsWith(r + "/"));
    },
    /** git 事实在时的补充面:git 看不见的**别的 checkout** 的承重提交(他仓宪法照样算,D93′)。
     *  只认绝对路径落在本仓根之外的承重写入 / 暂存;相对路径默认在本 checkout,由 git 事实负责。 */
    elsewhereCarrier(ctx, root) {
      const H = RULE_P._p, w = H.win(ctx);
      const isOut = (p) => H.outside(p, root) && H.isCarrierOrEngine(p);
      if ([...(ctx.writes || []), ...((w && w.writes) || [])].some(isOut)) return true;
      return H.cmdPairs(ctx, true).some(([cmd, d]) => {
        try { return H.writeTargets(cmd, isOut, d).length > 0 || (H.hasCommit(cmd, d) && H.gitPathArgs(cmd, d).some(isOut)); } catch { return false; }
      });
    },

    /** 触发面。 */
    // ⚠️ 2026-08-27(D92)回退面的证据①放宽到「窗口 ∪ 本轮」:「干几轮活 → 最后 `git add -A && git commit`」
    //   这一最自然的节奏下两条证据都结构性为空(实撞 120 轮 0 次响)。git 事实面上这件事不再成立(看的是落了什么),
    //   回退面照旧保留它。
    triggered(ctx) {
      if (!ctx) return false;
      const H = RULE_P._p, f = H.facts(ctx);
      const committed = typeof ctx.didCommit === "function" && ctx.didCommit();
      if (f) {
        if (H.gitCarrierCommits(f).length) return true;
        return H.elsewhereHit(ctx, f);
      }
      if (!committed) return false;
      return H.triggeredBySyntax(ctx);
    },
    /** 回退面(git 事实取不到):本轮真提交过 且(参数面承重提交 / 窗口∪本轮承重写入 / cd 解析后的 Bash 承重写目标 / 闸引擎被动过)。 */
    triggeredBySyntax(ctx) {
      const H = RULE_P._p;
      if (H.carrierCommitCount(ctx) > 0) return true;
      const w = H.win(ctx);
      if ([...(ctx.writes || []), ...((w && w.writes) || [])].some((p) => isCarrierPath(CARRIER_SURFACE, p))) return true;   // D86
      // codex 185「你没问到」2:承重件经 Bash 改 + `git add -A` ⇒ writes 空、参数面无路径。Bash 写目标与 I/D11 同一实现。
      if (H.cmdPairs(ctx, true).some(([cmd, d]) => { try { return H.writeTargets(cmd, (p) => isCarrierPath(CARRIER_SURFACE, p), d).length > 0; } catch { return false; } })) return true;
      // 红队 3112024 轮 BP-1:两个判据对同一命令不得相反——已提交且闸引擎被动过 ⇒ 触发。
      return H.gateEngineTouched(ctx);
    },

    win(c) { try { return c && typeof c.window === "function" ? c.window() : null; } catch { return null; } },

    /** 取值域 = 窗口 ∪ 本轮,且**只取动作面**。窗口那层的 text 一个字都不读。 */
    scopeActions(c) {
      const own = Array.isArray(c && c.actions) ? c.actions : [];
      const w = RULE_P._p.win(c);
      const prior = w && Array.isArray(w.actions) ? w.actions : [];
      return prior.concat(own);
    },

    /** 段是否被**短路守卫**保护:`false && X` / `true || X` 里的 X 根本不执行。
     *  2026-08-20 codex 报、本机实测:`false && node …codex-run.mjs --task` 当时判「跑过」⇒
     *  **三个字符就能关掉这条闸**。切段器只按 `&&`/`||` 切,丢掉了控制流语义。
     *  静态判不出真假 ⇒ **凡带条件连接符的段一律不计数**(fail-closed:
     *  代价是 `X && echo done` 这种真调用也不算,我白重跑一次;反向的代价是闸恒不响)。 */
    guarded(cmd, idx) { return idx > 0 && /(\&\&|\|\|)/.test(String(cmd)); },

    /** 剥掉**引号字符**(不是引号内容),只用于「这条命令的头是不是 node」这类判断。
     *  与 `segs` 的 stripQuoted 分工:那个防的是 `echo '…'` 把正文当参数;
     *  这个救的是 `node "C:/…/codex-run.mjs" --task`——真调用却因带引号而判不出。 */
    unquote(s) { return String(s).replace(/["']/g, ""); },

    /** 拆包装器:`bash -lc "node … --task"` / `sh -c '…'` 里真正跑的是引号里那条。
     *  2026-08-20 实测:包装器形态当时被判「没跑」⇒ 真调用误拦。 */
    unwrap(cmd) {
      const m = String(cmd).match(/^(\w+=\S+\s+)*(ba|z|k)?sh\s+(-[a-z]*c[a-z]*)\s+(['"])([\s\S]*)\4\s*$/);
      return m ? m[5] : null;
    },

    execsCodexRun(input) {
      const H = RULE_P._p;
      const cmd = String((input && input.command) || "");
      if (!cmd) return false;
      const inner = H.unwrap(cmd);
      if (inner) return H.execsCodexRun({ command: inner });
      // ⚠️ 这里**不能**用 `segs`(它的 stripQuoted 把引号内容整段删掉,
      //   `node "C:/…/codex-run.mjs" --task` 会变成 `node  --task`,路径没了)。
      //   用**原始段**,只去掉引号**字符**。安全性由 NODE_CODEX 的 `^` 锚提供:
      //   `echo 'node …codex-run.mjs --task'` 去引号后头仍是 `echo`,锚不上 ⇒ 不算。
      return segments(cmd).some((s, i) => {
        if (H.guarded(cmd, i)) return false;
        const u = H.unquote(s).trim();
        return H.NODE_CODEX.test(u) && H.CODEX_ARG.test(u);
      });
    },

    /** 三条通道。谓词的入参是**一次工具调用**(`{name, input}`),不是文本。 */
    CH: [
      { key: "跨模型(codex:判「我说的对不对」)",
        test: (a) => /codex/i.test(String(a.name || "")) ||
          (/^(Bash|PowerShell)$/.test(String(a.name || "")) && RULE_P._p.execsCodexRun(a.input)) },
      // ⚠️ D11 收紧(2026-09-06 用户亲签;法条 reporting.md#承重面三通道必跑 同批改):本批提交触及
      //   **闸引擎文件**时,本通道只认红队 agent `_gate-bypass-hunter`——181 批双审证明闸修法的自测
      //   全绿证明不了不漏放,而 grill 的通用视角没有「怎样绕过这条判据」这一专门问法。
      //   第二参 ctx 可缺省(变异里的旧调用形态不带 ctx ⇒ 退回 grill/_ 通用口径)。
      //   红队 182 BP-9:名字对了还不够——入参须绑定闸文件/规则 id/diff(`hunterBound`),空 prompt 起一次不算。
      { key: "独立视角(只读子代理:判「我漏了什么」)",
        test: (a, ctx) => {
          if (!/^(Agent|Task)$/.test(String(a.name || ""))) return false;
          const t = String((a.input && (a.input.subagent_type || a.input.agentType)) || "");
          if (ctx && RULE_P._p.gateEngineTouched(ctx)) return /^_gate-bypass-hunter$/.test(t) && RULE_P._p.hunterBound(a);
          return /^(grill:|_)/.test(t);
        } },
      { key: "外部先例(WebSearch/WebFetch:判「业界踩过没有」)",
        test: (a) => /^(WebSearch|WebFetch)$/.test(String(a.name || "")) },
    ],
    // (`attempted(a)` 已删:红队 182 附节二 1 逮到它全仓零调用,而 D11 注释还把它列为「旧调用形态」——死零件不留。)

    /** 按 diff 事实分档(批 257 条件 3,判据唯一实现在 `lib/gate-difftier.mjs`):本批承重面改动**全是测试文件**
     *  ⇒ 免「跨模型」与「外部先例」两条;独立视角照欠(D11 不受影响)。注释与文案不分档(用户 10-10 裁:Q1-A、Q2 撤,D144)。
     *  法条 = docs/laws/reporting.md「按 diff 事实分档」。
     *  只在这两条真欠着时才取事实(要跑 git);事实取不到、未接通道(夹具不给)、或事实没覆盖本批全部承重写入
     *  (写在别的 checkout,红队 c3 BP-7)⇒ 不分档,原样返回。 */
    SOFT_CH: /跨模型|外部先例/,
    tierFilter(ctx, out) {
      const H = RULE_P._p;
      if (!out.some((h) => H.SOFT_CH.test(String(h.ch))) || typeof ctx.diffTier !== "function") return out;
      let facts = null;
      try { facts = ctx.diffTier(); } catch { facts = null; }
      const isC = (p) => isCarrierPath(CARRIER_SURFACE, p);
      if (!classifyDiffTier(facts, isC).light) return out;
      // 写入取**整个窗口**,不按批武装时刻切(红队 d1cae02 轮 BP-3/4/5):P 的义务按 `.p-ledger.json` 跨批累计,
      //   上一批没过三通道的承重改动也在这笔义务里——只看本批会把累计来的义务一并免掉;按时间切还会被「晚武装」
      //   「缺时间戳」绕开。代价:上一批改过法典、本批只改测试的批次拿不到分档(codex 终审 F1 的误拦,接受:偏严)。
      const w = H.win(ctx);
      const wa = (w && Array.isArray(w.actions)) ? w.actions : [];
      const acts = [...wa, ...(ctx.actions || [])];
      const writes = [];
      for (const a of acts) {
        const name = String(a && a.name || ""), inp = (a && a.input) || {};
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name) && typeof (inp.file_path || inp.notebook_path) === "string") writes.push(inp.file_path || inp.notebook_path);
        if (/^(Bash|PowerShell)$/.test(name) && typeof inp.command === "string") {
          try { writes.push(...bashWriteTargets(inp.command, CARRIER_SURFACE, { dialect: H.dOf(a) })); } catch { return out; }
        }
      }
      if (w && Array.isArray(w.writes)) writes.push(...w.writes);
      return coversWrites(facts, writes, isC) ? out.filter((h) => !H.SOFT_CH.test(String(h.ch))) : out;
    },

    hunterCh() { return RULE_P._p.CH.find((c) => /独立视角/.test(c.key)); },

    /** 红队凭证池:闸引擎面上独立视角通道只认这里面的动作。
     *  codex 185「你没问到」1(High):红队凭证得绑**本批**——上一批的红队调用不能抵本批。
     *  ── git 事实在(红队 a27628dd / 量化 a00051d 之后,派出方口径②③)────────────────────────────
     *    切点 = max(批武装时刻, **比本次范围更早的最后一次带闸引擎改动的提交**时刻),只在「本仓、按 git 事实带闸改动」
     *    的提交处切——他仓提交、`--amend`、只改法典/ADR/src 的提交都不切(a00051d:26 次 D11 阻断里 14 次是这样切出来的误拦)。
     *    宽松口径(派出方定):「红队 → 按回件修闸 → 提交」里的修闸提交在本次范围内,不切 ⇒ 这一轮红队抵账。
     *    窗口动作须有有效时间戳且不晚于本轮最晚动作(同下面 191 ②③);本轮动作恒在池内。
     *  ── 取不到 git 事实(回退,保持现状,fail-closed)──────────────────────────────────────────
     *    主路径:动作带转录时间戳且 `batchGoal.armedAt` 在 ⇒ 切点 = max(武装时刻, 窗口最后一次**任意**提交);
     *    再退:窗口里最后一次任意提交之后。「任何提交都切」的代价是「红队 → 记台账提交 → 关账」会被拦一次。
     *    (191 两队红队:① 切点取 max 而非只取武装时刻;② 窗口动作**必须**有有效 at 才入池;③ 上界=本轮最晚动作;
     *     ④ armedAt 按有限性判,epoch 不被真值兜底吞掉。红队 186:提交判定剥载荷后再看 --dry-run——现走 isCommitSeg。) */
    armedAt(ctx) {
      const parsedArm = Date.parse(String((ctx && ctx.batchGoal && ctx.batchGoal.armedAt) || ""));
      return Number.isFinite(parsedArm) ? parsedArm : null;
    },
    /** 窗口里时刻 ≥ cutAt(且有有效时间戳、不晚于本轮最晚动作)的动作 ∪ 本轮动作。cutAt=null ⇒ 整窗 ∪ 本轮。 */
    poolAfter(ctx, cutAt) {
      const H = RULE_P._p, w = H.win(ctx);
      const wa = (w && Array.isArray(w.actions)) ? w.actions : [];
      const own = Array.isArray(ctx.actions) ? ctx.actions : [];
      if (cutAt === null || cutAt === undefined) return [...wa, ...own];
      const upper = own.map((a) => a.at).filter(Number.isFinite).sort((x, y) => y - x)[0] ?? null;
      return [...wa.filter((a) => Number.isFinite(a.at) && a.at >= cutAt && (upper === null || a.at <= upper)), ...own];
    },
    hunterPool(ctx) {
      const H = RULE_P._p, w = H.win(ctx);
      const wa = (w && Array.isArray(w.actions)) ? w.actions : [];
      const own = Array.isArray(ctx.actions) ? ctx.actions : [];
      const armedAt = H.armedAt(ctx);
      const after = (cutAt) => H.poolAfter(ctx, cutAt);
      const f = H.facts(ctx);
      if (f) {
        const cuts = [armedAt, f.engineAnchorAt].filter((x) => Number.isFinite(x));
        return cuts.length ? after(Math.max(...cuts)) : [...wa, ...own];
      }
      const isCommitAction = (a) => /^(Bash|PowerShell)$/.test(String(a.name || "")) && H.hasCommit(String((a.input && a.input.command) || ""), H.dOf(a));
      if (armedAt !== null && wa.some((a) => Number.isFinite(a.at))) {
        let lastCommitAt = null;
        for (const a of wa) if (isCommitAction(a) && Number.isFinite(a.at)) lastCommitAt = a.at;
        return after(lastCommitAt !== null ? Math.max(armedAt, lastCommitAt) : armedAt);
      }
      let cut = -1;
      wa.forEach((a, i) => { if (isCommitAction(a)) cut = i; });
      return [...wa.slice(cut + 1), ...own];
    },
    /** 某条通道的取值池:闸引擎面上的独立视角 = 红队凭证池,其余 = 窗口 ∪ 本轮。
     *  hook 侧计账清零与 detect **同一张脸**(派出方 a27628dd 口径⑤:原来计账用整窗、判据用凭证池,注释说一致实际不是)。 */
    channelPool(ctx, ch) {
      const H = RULE_P._p;
      return (ch === H.hunterCh() && H.gateEngineTouched(ctx)) ? H.hunterPool(ctx) : H.scopeActions(ctx);
    },

    // ── 合回分支的点名抵账(a2a9f58b BP-8)——2026-10-11 已撤 ──
    //   codex 257-p-gitfacts-r2 断言 6 证伪:「红队 prompt 点名了分支名」可被只在背景里提到、明说不审的 prompt 满足 ⇒ 放过真欠账。
    //   commitNames / namesAny / namedCover 三个函数随之删除(史料见 git 4c1b04b);BP-8 误拦退回残余 D149④,待非文本判据。
    /** 闸引擎面的红队凭证是否已在(detect、计账清零同一取值):时刻切点池里有绑定红队(点名覆盖已撤,见上)。 */
    hunterMet(ctx) {
      const H = RULE_P._p, ch = H.hunterCh();
      // 点名覆盖(namedCover)已撤:codex 257-p-gitfacts-r2 断言 6 实证——prompt 只在背景里列了分支名、且明说不在审查范围,
      //   照样抵掉该分支带进的闸改动 ⇒ 它会放过真欠账,不是单纯收紧误拦,不属窄例外③;BP-8 误拦退回为残余(D149④)。
      return H.hunterPool(ctx).some((a) => { try { return ch.test(a, ctx); } catch { return false; } });
    },
    /** 三条通道各自是否已有凭证(与 detect 同一取值池、同一谓词)。 */
    channelsMet(ctx) {
      const H = RULE_P._p;
      return H.CH.map((ch) => (ch === H.hunterCh() && H.gateEngineTouched(ctx)) ? H.hunterMet(ctx)
        : H.channelPool(ctx, ch).some((a) => { try { return ch.test(a, ctx); } catch { return false; } }));
    },

    /** 每累计 K 次承重面提交,义务重新武装一次 ⇒ 各需 ceil(承重提交数 / K) 遍。
     *  本轮至少算 1 次(触发时已确认本轮有承重提交,只是路径可能只落在 writes 上)。
     *  git 事实在 ⇒ 范围本身就跨轮,计数取 `tally`(不再加窗口的命令语法计数,否则同一笔算两次)。 */
    needRuns(ctx) {
      const H = RULE_P._p;
      const n = H.facts(ctx) ? Math.max(H.tally(ctx).n, 1) : H.carrierCommitCount(H.win(ctx)) + Math.max(H.carrierCommitCount(ctx), 1);
      return { commits: n, need: Math.max(1, Math.ceil(n / H.rearm())) };
    },
  },

  detect: (ctx) => {
    const H = RULE_P._p;
    if (!H.triggered(ctx)) return [];
    // ── 跨批持久计账(2026-08-22 用户亲签「改吧」;税因 = PRIOR_WINDOW_ENTRIES=400 的
    //    条数窗口把几轮前的通道调用挤出视野,不是 armedAt——机制以此注为准)──
    //    `ctx.pLedger` 三态:undefined=通道没接 ⇒ 走下面的窗口式老路(夹具兼容);
    //    null=首跑无账 ⇒ 计 0;{carriers:n}=自上轮三通道后累计承重提交数。
    //    语义:**每 5 次承重提交欠一轮三通道**——累计+本轮 < 5 ⇒ 宽限放行;
    //    ≥ 5 ⇒ 各通道欠 1 遍,照旧只认动作面。计数落账在 hook 侧(规则纯函数)。
    // ── D11 独立于宽限(2026-09-07 用户「你自行判断」,我判:独立)────────────────
    //   举例:宽限=每 5 次承重提交武装一次三通道;承重面多数是法典/agent/文档,四次里漏一次审代价可控。
    //   闸引擎不同:181/182 两批**四轮复核每轮都抓出 High**(两句英文就过 S、目录记成已存在、退出码 3 吞成 null、
    //   裸词 audit 免了公开仓教程),且全在自测全绿状态下——按宽限口径这两批 4/5 的闸引擎提交可以一次红队都不跑。
    //   漏放贵于误拦:多跑一次红队≈10 分钟;漏一次=闸看起来在守而实际是装饰,且没人再撞。
    //   ⇒ 触及闸引擎的提交,红队**每批必跑**,不计入宽限;另两通道仍按宽限。
    const engine = H.gateEngineTouched(ctx);
    const hunterCh = H.hunterCh();
    const hunterPool = engine ? H.hunterPool(ctx) : [];
    // 红队凭证:时刻切点池(与计账清零同一取值 `hunterMet`;点名覆盖已撤,D149④)
    const hunterMissing = engine && !H.hunterMet(ctx);
    const hunterHit = (commits) => ({ ch: hunterCh.key + "——闸引擎面每批必跑(D11 独立于宽限)", got: 0, need: 1, commits, every: H.rearm() });
    if (ctx.pLedger !== undefined) {
      const prior = ctx.pLedger ? ctx.pLedger.carriers : 0;
      // a2a9f58b BP-1:计数从 git 事实取(范围内带承重改动、未记过账的提交数),取不到再退回命令语法——与 hook 计账同一份 `tally`
      const effective = prior + H.tally(ctx).n;
      if (effective < H.rearm()) return hunterMissing ? [hunterHit(effective)] : [];
      const acts = H.scopeActions(ctx);
      const out = [];
      for (const ch of H.CH) {
        if (engine && ch === hunterCh) {   // 红队凭证只认本批(见 hunterPool 注)
          if (hunterMissing) out.push({ ch: ch.key, got: 0, need: 1, commits: effective, every: H.rearm() });
          continue;
        }
        const chActs = acts.filter((a) => { try { return ch.test(a, ctx); } catch { return false; } });   // 带 ctx:D11 闸引擎面收紧
        if (chActs.length >= 1) continue;
        out.push({ ch: ch.key, got: 0, need: 1, commits: effective, every: H.rearm() });
      }
      return H.tierFilter(ctx, out);
    }
    const { commits, need } = H.needRuns(ctx);
    const acts = H.scopeActions(ctx);
    const out = [];
    for (const ch of H.CH) {
      const pool = (engine && ch === hunterCh) ? hunterPool : acts;   // 红队凭证只认本批
      const mine = pool.filter((a) => { try { return ch.test(a, ctx); } catch { return false; } });   // 带 ctx:D11 闸引擎面收紧
      const got = mine.length;
      if (got >= need) continue;
      // **豁免按通道分账**(2026-08-20 修,grill:testing 报 CRITICAL、本机实测复现):
      //   原来豁免是**规则级的一个布尔**——任一条通道的一次垃圾调用只要入参里带失败词,
      //   就把三条通道一起关掉。实测 `WebSearch({query:"限流"})` **两个字**放行全部。
      //   那正是这条闸当初要治的病(「一句话能一次关掉三条通道」):
      //   我把它从文本面搬到动作面,**搬了个家,病没治**——因为 `.some()` 不分通道。
      //   现在:某条通道要豁免,失败痕迹必须落在**它自己**那次调用的入参上。
      const excused = mine.some((a) => H.FAIL_MARK.test(JSON.stringify((a && a.input) || {})));
      if (!excused) out.push({ ch: ch.key, got, need, commits, every: H.rearm() });
    }
    return H.tierFilter(ctx, out);
  },

  // ⚠️ **唯一合法豁免:通道本身不可用,且有动作证据。**
  //   `kind:"action"` ⇒ 引擎把 ctx 的 text 剥空、says 恒假,**结构上不可能被一句话满足**;
  //   INV-1 另外禁止阻断项挂 text 豁免,两条合起来才是边界。
  //   判据比旧实现更紧一格:失败痕迹必须落在**那一次通道调用自己的入参**上,
  //   而不是「本轮任何一个入参里出现过 429」——否则 `echo "HTTP 429"` 就是一张免死金牌
  //   (旧实现正是这么写的:`toolUses.some(b => /rate.?limit|quota|429|…/.test(input))`)。
  //   代价写在明处:tool_result 不在 ctx 的可见面上,所以**只有把痕迹带进入参**
  //   (重试命令里注明、poll 的 job 带错误码)才豁免得掉。**拿不到动作证据即不豁免。**
  //   ⚠️ **2026-08-20:规则级 exempts 已撤,豁免下沉进 detect 按通道分账。**
  //   撤它的理由是实测出的绕过:规则级豁免是**一个布尔**,引擎命中即 `continue` 丢掉全部 hits
  //   ⇒ 任一条通道的一次垃圾调用(`WebSearch({query:"限流"})`,两个字)关掉三条通道,
  //   包括压根没跑过的那两条。这与本条闸当初要治的病是同一个,只是从文本面搬到了动作面。
  //   **一个规则级布尔天生管不了「哪条通道短了」——这不是判据写松了,是位置放错了。**
  exempts: [],

  message: (hits) => {
    const h0 = hits[0];
    // codex 185 Q5:只欠红队(闸引擎面、宽限内)时,消息按实际缺项说,别再念「三通道各需 1 遍」
    const hunterOnly = hits.length === 1 && /闸引擎面每批必跑/.test(String(h0.ch));
    if (hunterOnly) {
      return `**闸引擎面提交,红队未跑**(D11,独立于「每 ${h0.every} 次武装一次」的宽限;本批累计 ${h0.commits} 次承重提交,另两通道仍在宽限内)。\n` +
        `      处置只有一条:起 \`_gate-bypass-hunter\`,prompt 里带上本批闸文件名 / 规则 id / diff 文件(空 prompt 不算,` +
        `上一批的红队调用不抵账),回件处置后再提交或关账。grill 在此格**不充分**。`;
    }
    return `承重面批次三通道未跑够(本批 ${h0.commits} 次承重面提交 ⇒ 各需 ${h0.need} 遍,` +
      `每 ${h0.every} 次重新武装一次)。缺:${hits.map((h) => `${h.ch} ${h.got}/${h.need}`).join(" / ")}\n` +
      (hits.some((h) => /闸引擎面每批必跑|独立视角/.test(String(h.ch))) && RULE_P._p ?
        `      （闸引擎面的「独立视角」只认 \`_gate-bypass-hunter\` 且入参绑定闸文件/规则 id;grill 在该格不充分——D11。）\n` : "") +
      `      **「本轮不需要」不是豁免**——当日自审第⑤⑥⑦问六次全答「不需要」、零次触发行动,\n` +
      `      而同日一跑三通道:codex 判死我 4/5 条诊断,grill 报出 97 条变异里 40 条在「全绿」下存活。\n` +
      `      (本批承重面改动若**全是测试文件**——*.test.* / *.spec.* / *.selftest.mjs / .nlpm-test/——跨模型与联网两条自动免,\n` +
      `      独立视角照欠;注释与文案不分档;法条 reporting.md「按 diff 事实分档」,只认 git 改动清单,不认说法。)\n` +
      `      除此之外唯一合法豁免=**通道本身不可用**,且须有动作证据:真发起过那条通道,\n` +
      `      且那次调用的入参里留着限流/配额/429/站点不可达的痕迹。**说一句不算**\n` +
      `      (纯文本豁免 2026-08-20 已撤:一句话曾能一次关掉三条通道,连引用本报错都行)。\n` +
      `      计数只认动作面:正文、写进文件的正文、被读文件的内容、提交信息里写出这些字面量,\n` +
      `      **一次都不算**(全语料实测:306 次旧命中里只有 16 次是真调用)。\n` +
      `      grill 六个单 agent(architecture/security/testing/error-handling/edge-cases/recon)\n` +
      `      属只读子代理,宪法恒定条款 8 已常设授权,**不必用户点名**。`;
  },

  // ⚠️ 变异必须动**判据内部**再跑原用例,不能换成恒真/恒假的壳(codex 060 判死过那种)。
  //   这四条各自复现一种「历史上真出现过或差点写成」的错法,证人已逐条核实。
  mutations: [
    // ── 红队 a27628dd 轮的新分支各钉一条(swapP:临时换掉 _p 里的零件,跑完还原)────────────────────
    { name: "git 事实不接(恒回退语法判据:merge/cherry-pick 合回看不见)", apply: swapP({ facts: () => () => null }) },
    { name: "git 面切点退回「任意提交都切」(不看 engineAnchorAt)", apply: swapP({ hunterPool: (orig) => (ctx) => {
      const H = RULE_P._p, save = H.facts;
      H.facts = () => null;
      try { return orig(ctx); } finally { H.facts = save; }
    } }) },
    { name: "回退面闸引擎证据取整窗(不按最后一次绑定红队切,回到 e23bdd8)", apply: swapP({ isBoundHunter: () => () => false }) },
    { name: "闸副本不过 NON_CARRIER_AREA / worktree 剔除", apply: swapP({ isEnginePath: () => (p) => RULE_P._p.ENGINE_PATH_RE.test(normPath(p)) }) },
    { name: "提交判定回到原始段测 --dry-run(提交信息含 --dry-run 即隐形)", apply: swapP({ hasCommit: () => (cmd) =>
      segments(String(cmd)).some((s) => /^(\w+=\S+\s+)*git\b/.test(s) && /\bcommit\b/.test(s) && !/--dry-run/.test(s)) }) },
    { name: "不按 hook checkout 化相对形(worktree 会话自己的闸文件被当成副本)", apply: swapP({ isEnginePath: (orig) => (p) => orig(p, null) }) },
    { name: "git 面不认别的 checkout 的承重提交", apply: swapP({ elsewhereCarrier: () => () => false }) },
    { name: "路径参数不限子命令位(git 段里任意位置的路径都算暂存)", apply: swapP({ gitPathArgs: () => (cmd) =>
      segments(String(cmd)).filter((s) => /^(\w+=\S+\s+)*git\b/.test(s)).flatMap((s) => s.split(/\s+/).slice(2).filter((t) => t && !t.startsWith("-"))) }) },
    { name: "cd 不解析(walk 丢掉 cwd)", apply: swapP({ walk: (orig) => (cmd, d) => orig(cmd, d).map((x) => ({ ...x, cwd: null })) }) },
    // ── 红队 a2a9f58b 轮的新分支各钉一条 ────────────────────────────────────────────────────────────
    { name: "计数退回命令语法(git add -A / merge 合回计 0,BP-1)", apply: swapP({ tally: () => (ctx) => {
      const H = RULE_P._p;
      return H.triggered(ctx) ? { n: Math.max(H.carrierCommitCount(ctx), 1), shas: [] } : { n: 0, shas: [] };
    } }) },
    { name: "计数不按 sha 去重(同一批提交每次 Stop 再计一遍)", apply: swapP({ tally: (orig) => (ctx) =>
      orig(Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { pLedger: ctx.pLedger ? { ...ctx.pLedger, shas: [] } : ctx.pLedger })) }) },
    { name: "提交落在别处不补语法(先 cd 他仓、后续相对路径,BP-4)", apply: swapP({ commitsElsewhere: () => () => false }) },
    // ── 红队 a9af71da / aaf414b6 轮的新分支各钉一条 ──────────────────────────────────────────────────
    { name: "落在别处不要正向证据(本仓提交未落盘也计别处,a9af71da BP-5)", apply: swapP({ commitOutsideRoot: () => () => true }) },
    // 2026-10-11 删跨调用跟踪(commitOutsideRoot 头注):原「不并窗口 / Bash 调用边界回置 ×4 / 分账 / PS cd 失败 / PS UNK_PARSE / 认不出的外壳 ×2」
    //   十条变异钉的零件已不存在,一并删除;只钉同调用判据与「起点一律回根」:
    { name: "每次调用起点不回根(cwd 跨调用保持;证人 = 「上一次调用 cd 他仓、本次本仓提交失败」两条反例)", apply: swapP({ callStart: (orig) => (p, R) => p || orig(p, R) }) },
    { name: "同调用内 cd 根外不认(cdOf 一律认不出;证人 = 同调用 cd 他仓再提交诸正例)", apply: swapP({ cdOf: () => () => null }) },
    { name: "git -C 根外不认(提交段的 -C 不叠;证人 = git -C ../elsewhere / ~/notes 正例)", apply: swapP({ commitTargets: (orig) => (g, env, loc, res) => orig(g ? { ...g, cdirs: [] } : g, env, loc, res) }) },
    { name: "段首 ( / { 不剥(cdOf 认不出子 shell 与大括号组里的 cd,a07e98e9 BP-1)", apply: swapP({ scope: () => (seg) => ({ body: String(seg || "").trim(), open: 0, close: 0 }) }) },
    { name: "子 shell 不开层(子 shell 里的 cd 当持久,a07e98e9 BP-1 反)", apply: swapP({ scope: (orig) => (seg, ps) => ({ ...orig(seg, ps), open: 0, close: 0 }) }) },
    { name: "任何报错都抹 cd(不看结果正文的 cd 失败特征,ad3e4f93 BP-1)", apply: swapP({ CD_FAIL: () => /[\s\S]?/ }) },
    { name: "结果正文不看(cd 失败也当生效,codex agg-r1 ② 反)", apply: swapP({ CD_FAIL: () => /(?!)/ }) },
    { name: "聚合项按 1 笔计(不按范围提交数 count,a9af71da BP-1)", apply: swapP({ facts: (orig) => (ctx) => {
      const f = orig(ctx);
      return f ? { ...f, commits: f.commits.map((c) => ({ ...c, aggregated: false })) } : f;
    } }) },
    { name: "P 调用点不传方言(PowerShell 别名 + 反斜杠路径被自判成 bash,aaf414b6 BP-1)", apply: swapP({ dOf: () => () => undefined,
      cmdPairs: (orig) => (ctx, w) => orig(ctx, w).map(([c]) => [c, undefined]) }) },
    { name: "提交落在别处时取整窗语法(窗口里已提交过的承重写入被空提交翻出来)", apply: swapP({ ownSyntaxCarrier: () => (ctx) => RULE_P._p.triggeredBySyntax(ctx) }) },
    // 批 257 条件 3 分档两向各钉一条(证人 = 「改普通承重脚本」pos 与「只改测试文件」neg);写入覆盖另钉一条(证人 = 「别的 checkout」pos):
    { name: "分档不核写入覆盖(别的 checkout 的承重写入也免)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p, save = H.tierFilter;
      H.tierFilter = (c, out) => { let f = null; try { f = c.diffTier(); } catch { f = null; }
        return typeof c.diffTier === "function" && classifyDiffTier(f, (p) => isCarrierPath(CARRIER_SURFACE, p)).light ? out.filter((h) => !H.SOFT_CH.test(String(h.ch))) : out; };
      try { return r.detect(ctx); } finally { H.tierFilter = save; }
    } }) },
    { name: "分档恒轻(不看 diff 事实就免跨模型与联网)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p, save = H.tierFilter;
      H.tierFilter = (c, out) => out.filter((h) => !H.SOFT_CH.test(String(h.ch)));
      try { return r.detect(ctx); } finally { H.tierFilter = save; }
    } }) },
    { name: "分档不生效(轻档也要跨模型与联网)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p, save = H.tierFilter;
      H.tierFilter = (c, out) => out;
      try { return r.detect(ctx); } finally { H.tierFilter = save; }
    } }) },
    // 跨批计账两向各钉一条(2026-08-22 亲签「改吧」;证人 = pLedger 宽限 neg 与账满 pos):
    { name: "宽限不生效(有账也退回每次欠)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!H.triggered(ctx)) return [];
      const acts = H.scopeActions(ctx);
      return H.CH.map((ch) => ({ ch: ch.key, got: acts.filter((a) => { try { return ch.test(a); } catch { return false; } }).length, need: 1, commits: 1, every: H.rearm() }))
        .filter((h) => h.got < h.need);
    } }) },
    { name: "永远宽限(账满也不欠)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!H.triggered(ctx)) return [];
      if (ctx.pLedger !== undefined) return [];
      return r.detect(ctx);
    } }) },
    // D34 结案(2026-08-22,grill 报「两通道判据零变异」到期后补):两通道各钉一条放宽向。
    { name: "任意 Agent 都算独立视角(不限只读白名单)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!H.triggered(ctx)) return [];
      if (ctx.pLedger !== undefined) {
        const prior = ctx.pLedger ? ctx.pLedger.carriers : 0;
        if (prior + H.tally(ctx).n < H.rearm()) return [];
        const acts = H.scopeActions(ctx);
        const CH2 = [H.CH[0], { key: H.CH[1].key, test: (a) => /^(Agent|Task)$/.test(String(a.name || "")) }, H.CH[2]];
        return CH2.filter((ch) => !acts.some((a) => { try { return ch.test(a); } catch { return false; } }))
          .map((ch) => ({ ch: ch.key, got: 0, need: 1, commits: 0, every: H.rearm() }));
      }
      return r.detect(ctx);
    } }) },
    { name: "外部先例也认 Read/Grep(本地读冒充联网)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!H.triggered(ctx)) return [];
      if (ctx.pLedger !== undefined) {
        const prior = ctx.pLedger ? ctx.pLedger.carriers : 0;
        if (prior + H.tally(ctx).n < H.rearm()) return [];
        const acts = H.scopeActions(ctx);
        const CH2 = [H.CH[0], H.CH[1], { key: H.CH[2].key, test: (a) => /^(WebSearch|WebFetch|Read|Grep)$/.test(String(a.name || "")) }];
        return CH2.filter((ch) => !acts.some((a) => { try { return ch.test(a); } catch { return false; } }))
          .map((ch) => ({ ch: ch.key, got: 0, need: 1, commits: 0, every: H.rearm() }));
      }
      return r.detect(ctx);
    } }) },
    // D35 结案:窗口合并删除向——scopeActions 只看本轮。证人 = 「上几轮跑完三条通道」那条 neg。
    { name: "scopeActions 不并窗口(只看本轮)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!H.triggered(ctx)) return [];
      const acts = Array.isArray(ctx.actions) ? ctx.actions : [];
      if (ctx.pLedger !== undefined) {
        const prior = ctx.pLedger ? ctx.pLedger.carriers : 0;
        if (prior + H.tally(ctx).n < H.rearm()) return [];
        return H.CH.filter((ch) => !acts.some((a) => { try { return ch.test(a); } catch { return false; } }))
          .map((ch) => ({ ch: ch.key, got: 0, need: 1, commits: 0, every: H.rearm() }));
      }
      const { commits, need } = H.needRuns(ctx);
      return H.CH.map((ch) => ({ ch: ch.key, got: acts.filter((a) => { try { return ch.test(a); } catch { return false; } }).length, need, commits, every: H.rearm() }))
        .filter((h) => h.got < h.need);
    } }) },
    // ① 回到「拿窗口 JSON 去正则」的年代 ⇒ 纯文本即可刷计数。证人:正文写三个字面量那条正例。
    { name: "通道计数改回扫正文(纯文本即可刷计数)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!H.triggered(ctx)) return [];
      const { commits, need } = H.needRuns(ctx);
      const t = String(ctx.text || "");
      const got = [(t.match(/codex/gi) || []).length,
        (t.match(/grill:|subagent_type/gi) || []).length,
        (t.match(/WebSearch|WebFetch/gi) || []).length];
      return H.CH.map((ch, i) => ({ ch: ch.key, got: got[i], need, commits, every: H.rearm() }))
        .filter((h) => h.got < h.need);
    } }) },
    // ② 回到旧实现的宽松豁免:任何入参出现失败字样即豁免。证人:`echo "HTTP 429"` 那条正例。
    { name: "豁免放宽:任何入参出现失败字样即豁免(不要求真发起过通道)", apply: (r) => ({ ...r,
      exempts: [{ kind: "action", why: "变异:宽松豁免", test: (c) =>
        RULE_P._p.scopeActions(c).some((a) => RULE_P._p.FAIL_MARK.test(JSON.stringify((a && a.input) || {}))) }] }) },
    // ③ 丢掉承重面这一半 ⇒ 任何提交都触发。证人:提交业务代码那条反例(该放行的转成命中)。
    { name: "触发只看有没有提交(不看承重面)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!(typeof ctx.didCommit === "function" && ctx.didCommit())) return [];
      const { commits, need } = H.needRuns(ctx);
      const acts = H.scopeActions(ctx);
      return H.CH.map((ch) => ({ ch: ch.key, got: acts.filter((a) => ch.test(a)).length, need, commits, every: H.rearm() }))
        .filter((h) => h.got < h.need);
    } }) },
    // ④ 跨模型通道回到「入参里提到就算」⇒ 读一眼脚本即可喂饱它。证人:head/grep/echo 那条正例(缺项从 3 变 2)。
    { name: "跨模型通道改回扫入参字面量(读一眼脚本就算跑过)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_P._p;
      if (!H.triggered(ctx)) return [];
      const { commits, need } = H.needRuns(ctx);
      const acts = H.scopeActions(ctx);
      const cnt = (i) => i === 0
        ? acts.filter((a) => /codex-run\.mjs|codex/i.test(JSON.stringify(a.input || {}) + String(a.name || ""))).length
        : acts.filter((a) => H.CH[i].test(a)).length;
      return H.CH.map((ch, i) => ({ ch: ch.key, got: cnt(i), need, commits, every: H.rearm() }))
        .filter((h) => h.got < h.need);
    } }) },
  ],

  cases: {
    // 正例 = **四种已知文本伪造形态**各一条(全部必须照拦)+ 一条写入面伪造。
    pos: [
      // ⚠️ D92 回归钉:**跨轮**形态——承重写入在前几轮,本轮只 `git add -A && git commit`。
      //   旧 `triggered` 只看**本轮**写入与提交命令的参数面,这形态下**两者都空**
      //   ⇒ P 从不触发。实撞:另一条会话 120 轮里「同轮既写又提交」= 0,
      //   提交命令带承重路径 = 0,于是 P 在 258 次闸触发里**一次没响**。
      //   这不是罕见形态,是「干几轮活、最后提交一次」的自然节奏。
      { name: "P:跨轮——写在前几轮、本轮只提交(D92)",
        text: "收工提交。",
        prior: [{ text: "改判据", write: "scripts/lib/gate-rules.mjs" }],
        bash: ["cd /repo && git add -A && git commit -m x"],
        pLedger: { carriers: 9 } },
      // 伪造①:正文里写出三条通道的字面量。实测过:纯文本曾刷出「跨模型 1 / 独立视角 2」。
      { text: "已跑跨模型 mcp__codex-cli__codex,起了 grill:architecture 只读子代理,并用 WebSearch 查了外部先例。",
        bash: ["git add -A scripts/hook-stop-closure.mjs && git commit -m x"] },
      // **账满而通道缺 ⇒ 照拦**(跨批计账的拦截侧证人,与 neg 的宽限/通道齐两条配对):
      //   持久账 4 + 本轮 1 = 5 ≥ 5,零通道 ⇒ 三条全欠。
      { text: "第五笔提交。", pLedger: { carriers: 4 },
        bash: ["git add -A scripts/hook-stop-closure.mjs && git commit -m x"] },
      // D34 证人①:通用子代理**不算**独立视角(白名单=grill:/_ 前缀的只读件)⇒ 仍欠。
      //   变异「任意 Agent 都算」在此翻面。
      { text: "第五笔,子代理是通用的。", pLedger: { carriers: 4 },
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A scripts/hook-stop-closure.mjs && git commit -m x"],
        agent: "general-purpose", web: "先例" },
      // D11 收紧(2026-09-06 亲签):提交触及**闸引擎文件**时,独立视角只认 `_gate-bypass-hunter`——
      //   grill 在场也算欠(与 neg 里换成红队 agent 即放行的那条配对)。
      { name: "D11:闸引擎提交,独立视角只有 grill ⇒ 仍欠",
        text: "第五笔,闸引擎批。", pLedger: { carriers: 4 },
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        agent: "grill:edge-cases", web: "先例" },
      // 红队 186 BP-6/BP-7(回退路径):提交信息含 --dry-run 仍是提交 ⇒ 切;`git stage` 视同 add
      { name: "BP-6:提交信息含 --dry-run 的旧批提交仍切边界 ⇒ 旧红队不抵账",
        text: "本批新改动,提交。", pLedger: { carriers: 0 },
        write: "scripts/lib/gate-rules.mjs", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x",
        prior: [{ text: "上批红队", agent: { type: "_gate-bypass-hunter", prompt: "红队批 184 的 scripts/lib/gate-rules.mjs 改动" } },
                { text: "提交", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m \"fix: drop --dry-run flag\"" }] },
      // 派出方 a27628dd 口径④:取不到 git 事实时 fail-closed 回退现状——红队之后**任何**提交都切。
      //   (原同形 pos「回退路径 fail-closed:红队之后的 docs-only 提交也切」已按宽松口径翻成 neg 的 git 面版本;
      //    这里留下的是同一输入、**不给 git 事实**的那一半。)
      { name: "a27628dd 口径④:取不到 git 事实 ⇒ 回退现状,红队之后的 docs-only 提交也切",
        text: "本批收尾提交。", pLedger: { carriers: 0 },
        write: "scripts/lib/gate-rules.mjs", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x",
        prior: [{ text: "本批红队", agent: { type: "_gate-bypass-hunter", prompt: "红队本批 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "记台账", bash: "git add docs/gate-debts.md docs/product-diary.md && git commit -m x" }] },
      // ══ 红队 a27628dd 的拦截侧(漏放族;git 事实面)══════════════════════════════════════════════
      // BP-1:worktree 子代理改闸,父侧 merge --no-ff / cherry-pick 合回 ⇒ 不是 commit 命令,原判据不触发
      { name: "a27628dd BP-1:merge --no-ff 带进闸引擎(SUB 形态)⇒ 欠红队",
        text: "合回子代理。", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-x -m merge"],
        headFacts: { root: "/repo", commits: [{ files: [{ path: "scripts/lib/gate-rules.mjs", status: "M" }] }] } },
      { name: "a27628dd BP-1:cherry-pick 带进闸引擎 ⇒ 欠红队",
        text: "摘过来。", pLedger: { carriers: 0 },
        bash: ["git cherry-pick abc1234"],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/hook-stop-closure.mjs"] }] } },
      { name: "a27628dd BP-1:merge 带进闸引擎、合回前子代理在 worktree 里跑的红队父侧看不见 ⇒ 仍欠",
        text: "子代理说它红队过了。", pLedger: { carriers: 0 },
        bash: ["git merge --squash worktree-agent-x", "git commit -m squash"],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-ctx.mjs", "docs/laws/reporting.md"] }] } },
      // BP-2:bashWriteTargets 不认的写法改闸(scratchpad 脚本)+ `git add -A` ⇒ git 事实照样看得见
      { name: "a27628dd BP-2:scratchpad 脚本改闸 + git add -A ⇒ 欠红队",
        text: "用脚本批量改。", pLedger: { carriers: 0 },
        bash: ["node C:/Users/x/AppData/Local/Temp/scratch/edit.mjs", "git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"] }] } },
      // BP-3:`cd docs/laws && sed -i … collab.md` 再 `git add -A`(两个面都钉:回退面靠 cd 解析,git 面靠事实)
      { name: "a27628dd BP-3(回退面):cd docs/laws 后 sed 改法典 + git add -A ⇒ 承重提交",
        text: "第五笔。", pLedger: { carriers: 4 },
        bash: ["cd docs/laws && sed -i s/a/b/ collab.md", "git add -A && git commit -m x"] },
      { name: "a27628dd BP-3(git 面):同上,事实里有 docs/laws/collab.md",
        text: "第五笔。", pLedger: { carriers: 4 },
        bash: ["cd docs/laws && sed -i s/a/b/ collab.md", "git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: [{ files: ["docs/laws/collab.md"] }] } },
      // 复核红队 aaf414b6(两条均 365fd54 引入,回退面):
      //   BP-2:方言自判在未掩码原串上找 PS 标记 ⇒ 引号里的 `$env:` 把 bash 判成 ps ⇒ `\`+换行续行失效、续行后的宪法目标丢
      { name: "aaf414b6 BP-2:bash 续行 + 引号里 $env: 改宪法", text: "第五笔。", pLedger: { carriers: 4 },
        bash: ["sed -i 's/$env:A/$env:B/g' \\\n  AGENTS.md", "git add -A && git commit -m x"] },
      //   BP-3:引号里的单个 `<` 被当裸重定向算子、连 `-Path` 一起剔 ⇒ `-Value` 吞掉 AGENTS.md
      { name: "aaf414b6 BP-3:PS Set-Content -Value \"<\" -Path 宪法", text: "第五笔。", pLedger: { carriers: 4 },
        ps: "Set-Content -Value \"<\" -Path AGENTS.md", bash: ["git add -A && git commit -m x"] },
      // BP-4:提交信息里含 --dry-run ⇒ 原 isCarrierCommitCmd 在原始段上判,整笔不算承重提交 ⇒ 宽限多给一笔
      { name: "a27628dd BP-4:提交信息含 --dry-run 的法典提交仍算承重提交",
        text: "第五笔。", pLedger: { carriers: 4 },
        bash: ["git add -A docs/laws/collab.md && git commit -m \"drop --dry-run flag\""] },
      // BP-5:写入早已滑出 400 条窗口,本轮只 `git add -A && git commit` ⇒ git 事实照样看得见
      { name: "a27628dd BP-5:写入滑出窗口 + 本轮只 git add -A ⇒ 欠红队",
        text: "收工提交。", pLedger: { carriers: 0 },
        bash: ["git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/hook-guard.mjs"] }] } },
      // BP-6 的漏放半边:`git stage` 闸文件(原第三支只认 add|commit)
      { name: "a27628dd BP-6:git stage 闸文件 + 提交 ⇒ 欠红队",
        text: "提交。", pLedger: { carriers: 0 },
        bash: ["git stage scripts/lib/gate-rules.mjs && git commit -m x"] },
      // 口径的反面:**在 worktree 里开的会话**改自己的闸文件(路径含 `.claude/worktrees/`)⇒ 仍是闸引擎(回退面)
      { name: "a27628dd 口径反面:worktree 里的会话改自己的闸文件 + git add -A ⇒ 欠红队",
        text: "在自己的 worktree 里改闸。", pLedger: { carriers: 0 }, hookCheckout: "/repo/.claude/worktrees/w1",
        write: "/repo/.claude/worktrees/w1/scripts/lib/gate-rules.mjs", bash: ["git add -A && git commit -m x"] },
      // git 事实在、本仓无提交,但承重提交落在**别的 checkout**(他仓宪法照样算)⇒ 语法补充面接住
      { name: "a27628dd 补充面:git 事实在,他仓承重提交照样触发",
        text: "第五笔,在别的仓改宪法。", pLedger: { carriers: 4 }, write: "E:/elsewhere/AGENTS.md",
        bash: ["cd E:/elsewhere && git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: [] } },
      // 同上,但本轮另有一笔本仓业务提交(范围里有本轮的提交 ⇒ 「提交落在别处」那支不成立)⇒ 只靠绝对路径的他仓补充面接住
      //   (a2a9f58b 轮加:BP-4 那支与本支在上一条里同时成立,单靠上一条钉不住本支)
      { name: "a27628dd 补充面:本仓业务提交 + 同轮他仓绝对路径改宪法并提交 ⇒ 照样触发",
        text: "第五笔,两边各提交一次。", pLedger: { carriers: 4 }, write: "E:/elsewhere/AGENTS.md",
        bash: ["git add -A src/app/page.tsx && git commit -m x", "cd E:/elsewhere && git add -A && git commit -m y"],
        headFacts: { root: "/repo", commits: [{ files: ["src/app/page.tsx"] }] } },
      // git 面切点:比本次范围更早的最后一次带闸改动的提交晚于红队 ⇒ 红队不抵本次(单变量:与 a00051d BP-2 neg 只差 engineAnchorAt)
      { name: "a27628dd git 面切点:上一次带闸改动的提交晚于红队 ⇒ 仍欠",
        text: "再改一版判据,提交。", at: "2026-10-10T10:30:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-10-10T08:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", at: "2026-10-10T10:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "他仓提交", at: "2026-10-10T10:10:00Z", bash: "cd /d/dotfiles-claude && git add -A && git commit -m x" },
                { text: "改提交信息", at: "2026-10-10T10:20:00Z", bash: "git commit --amend --no-edit" }],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"], at: "2026-10-10T10:30:00Z" }], engineAnchorAt: "2026-10-10T10:15:00Z" } },
      // ══ 红队 a2a9f58b 的拦截侧 ═══════════════════════════════════════════════════════════════════
      // codex 257-p-agg-r1 断言 2:账上只记过 HEAD sha(范围更小的那一次),这次同一 HEAD 代表的范围变大 ⇒ 仍按聚合项计
      //   (旧口径按 HEAD sha 整项去重 ⇒ 计 0、放行)
      { name: "codex agg-r1 ②:聚合项范围变大、账上只有同一 HEAD sha ⇒ 仍计,三通道全欠",
        text: "收工。", pLedger: { carriers: 0, shas: ["e".repeat(40)] }, bash: ["git add -A && git commit -m x"],
        headFacts: { root: "/repo", base: "b".repeat(40), commits: [{ sha: "e".repeat(40), aggregated: true, count: 61, files: ["AGENTS.md"] }] } },
      // BP-1:计数从 git 事实取。`git add -A` 的参数面没有路径 ⇒ 旧计数恒 0、宽限账永不涨;现在 10 笔法典提交在 pLedger=0 时
      //   照样越过宽限上限 ⇒ 三通道全欠(原 BP-3 git 面正例预置 pLedger:4 遮住了这个洞)
      { name: "a2a9f58b BP-1:pLedger=0、git add -A 带进 10 笔法典提交 ⇒ 越过宽限,三通道全欠",
        text: "收工。", pLedger: { carriers: 0 }, bash: ["git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: Array.from({ length: 10 }, () => ({ files: ["docs/laws/collab.md"] })) } },
      // BP-4:`cd E:/elsewhere` 后相对路径改宪法并提交 ⇒ 本仓范围里没有本轮的提交 ⇒ 按本轮语法判。
      //   a084a536 BP-6 改形:原写「上一次 Bash 调用 cd、本次提交」——真实 Bash 调用结束根外 cwd 被回置,那是错的期望 ⇒ 改同一调用内
      //   (PowerShell 跨调用形见下方 Set-Location -Path: / 裸盘符两条)
      //   写入单独一次调用(根内相对路径)、cd 与提交同一调用:写入若也跟在 cd 后,walk 会解到他仓 ⇒ elsewhereCarrier 抢先命中,cd 追踪没被钉住
      { name: "a2a9f58b BP-4:同一调用内先 cd 他仓再相对提交(承重写入在本轮)⇒ 提交落在别处,照样计承重提交",
        text: "第五笔,在他仓改宪法。", pLedger: { carriers: 4 },
        bash: ["sed -i s/a/b/ AGENTS.md", "cd E:/elsewhere && git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: [] } },
      // 红队 a9af71da BP-5 修后的拦截侧:正向证据的另两种形态(相对 cd 解出根外 / 提交段自带 git -C 根外)仍算别处
      //   a084a536 BP-6 改形:原为上一次 Bash 调用 cd(跨调用,真实语义下被回置)⇒ 改同一调用内
      //   写入单独一次调用(根内相对路径)、cd 与提交同一调用:写入若也跟在 cd 后,walk 会解到他仓 ⇒ elsewhereCarrier 抢先命中,cd 追踪没被钉住
      { name: "a9af71da BP-5:同一调用内 cd ../elsewhere(相对,解出在本仓根外)再相对提交 ⇒ 别处,照样计",
        text: "第五笔,在隔壁仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ AGENTS.md", "cd ../elsewhere && git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: [] } },
      { name: "a9af71da BP-5:提交段自带 git -C ../elsewhere(根外)⇒ 别处,照样计",
        text: "第五笔,在隔壁仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ ../elsewhere/AGENTS.md", "git -C ../elsewhere commit -am x"],
        headFacts: { root: "/repo", commits: [] } },
      // 红队 a07e98e9 BP-1(0aa11fd 引入的漏放):段首 `(` / `{` 让 cdOf 认不出 cd ⇒ 提交段 cwd 仍判本仓根
      { name: "a07e98e9 BP-1:子 shell 里 cd 他仓改宪法并提交 ⇒ 别处",
        text: "第五笔,在隔壁仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["(cd ../elsewhere && sed -i s/a/b/ AGENTS.md && git commit -am x)"],
        headFacts: { root: "/repo", commits: [] } },
      { name: "a07e98e9 BP-1:大括号组里 cd 他仓改宪法并提交 ⇒ 别处",
        text: "第五笔,在隔壁仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["{ cd E:/elsewhere && sed -i s/a/b/ AGENTS.md && git commit -am x; }"],
        headFacts: { root: "/repo", commits: [] } },
      // 红队 a07e98e9 BP-2(0aa11fd 引入的漏放):去向解不出 / 只认 -C 的绝对形 ⇒ 判在根内
      { name: "a07e98e9 BP-2:git -C ~/notes(本仓根不在家目录下)改宪法并提交 ⇒ 别处",
        text: "第五笔,在笔记仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ ~/notes/AGENTS.md", "git -C ~/notes commit -am x"],
        headFacts: { root: "/repo", commits: [] } },
      { name: "a07e98e9 BP-2:--git-dir + --work-tree 指他仓提交 ⇒ 别处",
        text: "第五笔,在隔壁仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ ../x/AGENTS.md", "git --git-dir=../x/.git --work-tree=../x commit -am x"],
        headFacts: { root: "/repo", commits: [] } },
      { name: "a07e98e9 BP-2:GIT_DIR= / GIT_WORK_TREE= 前缀指他仓提交 ⇒ 别处",
        text: "第五笔,在隔壁仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ ../x/AGENTS.md", "GIT_DIR=../x/.git GIT_WORK_TREE=../x git commit -am x"],
        headFacts: { root: "/repo", commits: [] } },
      { name: "a07e98e9 BP-2:PS Set-Location -Path:E:\\x(冒号形)后相对路径改宪法并提交 ⇒ 别处",
        text: "第五笔,在隔壁仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        // 2026-10-11 改形(删跨调用跟踪):原为上一次 PS 调用切仓、本次 PS 提交(跨调用形)⇒ 改同一次 PS 调用内,保住冒号形取值判据;
        //   写入单独一次 Bash 调用(根内相对路径),同下方 BP-4 系的写法
        bash: ["sed -i s/a/b/ AGENTS.md"], ps: ["Set-Location -Path:E:\\x; git add -A; git commit -m x"],
        headFacts: { root: "/repo", commits: [] } },
      { name: "a07e98e9 BP-2:PS 裸盘符 E: 切盘后相对路径改宪法并提交 ⇒ 别处",
        text: "第五笔,在 E 盘改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        // 2026-10-11 改形:同上一条(跨调用 ⇒ 同一次 PS 调用内)
        bash: ["sed -i s/a/b/ AGENTS.md"], ps: ["E:; git add -A; git commit -m x"],
        headFacts: { root: "/repo", commits: [] } },
      // 2026-10-11 新增:PS 同一调用内 `Set-Location ~`(本仓根不在家目录下 ⇒ 根外)再相对 `Set-Location notes` ⇒ 解不出(UNK_PARSE)⇒ 别处
      { name: "PS 同一调用内 Set-Location ~; Set-Location notes 后提交 ⇒ 别处",
        text: "第五笔,在笔记仓改宪法。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ AGENTS.md"], ps: ["Set-Location ~; Set-Location notes; git add -A; git commit -m x"],
        headFacts: { root: "/repo", commits: [] } },
      //   a084a536 BP-6 改形:原为上一次 Bash 调用 cd 变量(跨调用,真实语义下被回置)⇒ 改同一调用内
      //   写入单独一次调用(根内相对路径)、cd 与提交同一调用:写入若也跟在 cd 后,walk 会解到他仓 ⇒ elsewhereCarrier 抢先命中,cd 追踪没被钉住
      { name: "a07e98e9 BP-2:同一调用内 cd 到变量(去向解不出,UNK_PARSE)后相对提交 ⇒ 按旧语义算别处",
        text: "第五笔。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ AGENTS.md", "cd \"$NOTES_REPO\" && git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: [] } },
      // 红队 ad3e4f93 BP-1(ba5c9c2 引入的漏放):is_error 只说明某一段失败,不说明 cd 失败(管道尾 grep 无匹配退 1)
      //   a084a536 BP-6 改形:原为「失败调用里 cd、下一次 Bash 调用提交」(跨调用,真实语义下被回置)⇒ 改同一调用内:
      //   cd 成功、提交成功、尾段 grep 无匹配退 1 ⇒ 整调用 is_error,正文无 cd 失败特征 ⇒ cd 照常生效
      //   写入单独一次调用(根内相对路径)、cd 与提交同一调用:写入若也跟在 cd 后,walk 会解到他仓 ⇒ elsewhereCarrier 抢先命中,cd 追踪没被钉住
      { name: "ad3e4f93 BP-1:同一调用内 cd 成功、提交后尾段 grep 失败(报错无 cd 失败特征)⇒ 仍算别处",
        text: "第五笔,在他仓改宪法。", pLedger: { carriers: 4 }, bash: ["sed -i s/a/b/ AGENTS.md"],
        then: [{ text: "提交并看一眼", bash: "cd E:/elsewhere && git add -A && git commit -m x && git log --oneline -1 | grep foo", failed: true }],
        headFacts: { root: "/repo", commits: [] } },
      // 2026-10-11 删跨调用跟踪:原此处五条跨调用正例删除——「a084a536 BP-6 对照(回置声明指向他仓)」「a56d53db BP-1(PS 切他仓、插 Bash、PS 提交)」
      //   及其变体、「复核 620e556 BP-2(认不出的 cd 外壳 + 真回置声明)」只钉跨调用行为(回置声明 / 分账 / opaque),该行为已不存在;
      //   「复核 620e556 BP-1(PS 切仓失败、插 Bash、PS 相对切他仓)」钉的「cd 失败 ⇒ 原地(不是未知)」改成同一调用形保住(下一条)。
      // cd 失败 ⇒ 原地(两种 shell 同):同一调用内 Set-Location 失败(正文带 cd 失败特征)⇒ 仍在根 ⇒ 其后 `git -C ../elsewhere` 解出根外 ⇒ 别处
      //   (原记「未知」时 -C 相对路径沿用未知、不算证据 ⇒ 漏放;「结果正文不看」变异下 cd 当生效 ⇒ -C 解到 /repo/elsewhere 根内 ⇒ 本条转红)
      { name: "cd 失败按原地:同一 PS 调用内切仓失败、其后 git -C ../elsewhere 提交 ⇒ 别处",
        text: "第五笔。", pLedger: { carriers: 4 }, hookCheckout: "/repo", bash: ["sed -i s/a/b/ AGENTS.md"],
        then: [{ text: "切了提交", ps: "Set-Location /repo/nope; git -C ../elsewhere add AGENTS.md; git -C ../elsewhere commit -m x",
          failed: "Set-Location : Cannot find path '\\repo\\nope' because it does not exist." }],
        headFacts: { root: "/repo", commits: [] } },
      // 已知残余(2026-10-11 删跨调用跟踪让出的诚实误拦,原为反例「a084a536 BP-6:上一次 Bash cd 进根内子目录、本次 cd .. 回根后提交失败」,
      //   改判期望):真实 Bash 对根内 cd 跨调用保持 ⇒ 第二次调用的 `cd ..` 回到根;本实现每次调用起点 = 根 ⇒ `..` 解出根外 ⇒ 计别处。
      //   修掉它要重新引入跨调用跟踪(见 commitOutsideRoot 头注「让出的面」);本条转绿 = 有人又加回了跨调用状态,须复核。
      { name: "已知残余:上一次 Bash cd docs、本次 cd .. 后本仓提交失败 ⇒ 起点按根算,计别处(诚实误拦)",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        bash: ["cd docs", "cd .. && git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      // 同调用内 UNK_PARSE 照旧算根外:PS 变量形 Set-Location 与提交在同一次调用
      { name: "复核 620e556 BP-4 对照:同一次 PS 调用内 Set-Location 到变量后提交 ⇒ 按旧语义算别处",
        text: "第五笔。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        bash: ["sed -i s/a/b/ AGENTS.md"], ps: ["Set-Location $notes; git add -A; git commit -m x"], headFacts: { root: "/repo", commits: [] } },
      // 红队 a9af71da BP-1:范围超 CAP(60)时 hook 给聚合项(原返回 null ⇒ 恒回退语法面,merge 合回的闸改动看不见)
      { name: "a9af71da BP-1:聚合项(61 笔,净差带闸改动)、merge 合回、无红队 ⇒ 欠",
        text: "合回。", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-x -m m"],
        headFacts: { root: "/repo", head: "9".repeat(40), commits: [{ sha: "9".repeat(40), aggregated: true, count: 61, files: ["scripts/lib/gate-rules.mjs", "src/app/page.tsx"] }] } },
      { name: "a9af71da BP-1:聚合项(61 笔)净差只带法典、pLedger=0 ⇒ 按 61 笔计,越过宽限,三通道全欠",
        text: "收工。", pLedger: { carriers: 0 }, bash: ["git add -A && git commit -m x"],
        headFacts: { root: "/repo", head: "9".repeat(40), commits: [{ sha: "9".repeat(40), aggregated: true, count: 61, files: ["docs/laws/collab.md"] }] } },
      // 红队 aaf414b6 BP-1:P 调 bashWriteTargets 不传方言 ⇒ PowerShell 别名 / 裸重定向 + 反斜杠路径被自判成 bash、反斜杠被吃
      { name: "aaf414b6 BP-1:PS 别名反斜杠路径改法典(回退面)⇒ 承重写入",
        text: "第五笔。", pLedger: { carriers: 4 }, ps: "cp clipboard\\x.md docs\\laws\\collab.md", bash: ["git add -A && git commit -m x"] },
      { name: "aaf414b6 BP-1:PS 裸重定向写他仓宪法(git 面补充面)⇒ 照样触发",
        text: "第五笔,两边各提交一次。", pLedger: { carriers: 4 }, ps: "\"| x |\" >> E:\\elsewhere\\AGENTS.md",
        bash: ["git add -A src/app/page.tsx && git commit -m x", "cd E:/elsewhere && git add -A && git commit -m y"],
        headFacts: { root: "/repo", commits: [{ files: ["src/app/page.tsx"] }] } },
      // BP-8 已知残余(点名覆盖已撤,D149④):两个 worktree 并行改闸、各自红队,依次合回;第一次合回(10:30)晚于
      //   B 的红队(10:00)⇒ 第二次合回仍按时刻切点、要求重跑红队。红队 a12212b9 问 2 论证这是**应拦**:B 的红队审的是
      //   A 合回之前的状态,A+B 合起来的状态从没被红队过 ⇒ 补跑是未满足的要求,不是误拦(D149④ 已据此重新归类)。
      { name: "a2a9f58b BP-8:并行 worktree 依次合回,B 的红队早于 A 的合回 ⇒ 合起来的状态仍欠红队(点名不抵账)",
        text: "合回第二个 worktree。", at: "2026-10-10T11:00:00Z", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-b -m m"],
        prior: [{ text: "并行红队 B", at: "2026-10-10T10:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 worktree-agent-b 的 scripts/lib/gate-rules.mjs 改动" } }],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"], at: "2026-10-10T11:00:00Z" }], engineAnchorAt: "2026-10-10T10:30:00Z" } },
      // codex 257-p-gitfacts-r2 断言 6 的反例:prompt 只在背景列表里提到 feature/b、明说不在审查范围 ⇒ 不得抵账(点名覆盖撤回的理由)
      { name: "codex r2 ⑥:红队 prompt 背景里列了合回分支、明说不审它 ⇒ 仍欠",
        text: "合回 feature/b。", at: "2026-10-10T11:00:00Z", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff feature/b -m m"],
        prior: [{ text: "红队 K0", at: "2026-10-10T10:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队规则 K0 的判据。背景:在途分支 feature/a、feature/b(不在本次审查范围)" } }],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"], at: "2026-10-10T11:00:00Z", branches: ["feature/b"] }], engineAnchorAt: "2026-10-10T10:30:00Z" } },
      // BP-8 的拦截半边:红队点名的分支不是这次合回的分支(整词比对:b2 ≠ b)⇒ 仍按时刻切点,欠红队
      { name: "a2a9f58b BP-8 反:红队点名 worktree-agent-b2,合回的是 worktree-agent-b ⇒ 仍欠",
        text: "合回第二个 worktree。", at: "2026-10-10T11:00:00Z", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-b -m m"],
        prior: [{ text: "并行红队 B2", at: "2026-10-10T10:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 worktree-agent-b2 的 scripts/lib/gate-rules.mjs 改动" } }],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"], at: "2026-10-10T11:00:00Z" }], engineAnchorAt: "2026-10-10T10:30:00Z" } },
      // BP-8:git 事实给了分支名 ⇒ 以它为准(命令面写的分支不算)
      { name: "a2a9f58b BP-8 反:git 事实说合回的是 worktree-agent-a,红队点名 b ⇒ 仍欠",
        text: "合回。", at: "2026-10-10T11:00:00Z", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-b -m m"],
        prior: [{ text: "并行红队 B", at: "2026-10-10T10:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 worktree-agent-b 的 scripts/lib/gate-rules.mjs 改动" } }],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"], at: "2026-10-10T11:00:00Z", branches: ["worktree-agent-a"] }], engineAnchorAt: "2026-10-10T10:30:00Z" } },
      // codex 185「你没问到」1(High):上一批的红队调用(之后已有一次提交)不能抵本批
      { name: "codex-185 ①:旧批红队调用不抵本批 ⇒ 仍欠",
        text: "批 185 新改动。", pLedger: { carriers: 0 },
        write: "scripts/lib/gate-rules.mjs", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x",
        prior: [{ text: "批 184", agent: { type: "_gate-bypass-hunter", prompt: "红队批 184 的 gate-rules.mjs 改动" } },
                { text: "批 184 结束", commit: true }] },
      // D107 主路径证人(191):凭证池的**主路径**按 `batchGoal.armedAt` 切动作时间戳,而在此之前
      //   夹具条目没有 `timestamp` ⇒ 所有用例都走回退路径(任何提交都切),主路径零机器证人。
      //   这两条(pos 早于武装 ⇒ 仍欠 / neg 晚于武装 ⇒ 放行)钉住那条过滤,变量只有时间戳一个。
      { name: "D107 主路径:红队调用早于本批武装时刻 ⇒ 不在凭证池,仍欠",
        text: "本批闸引擎改动,提交。", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-09-09T10:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", at: "2026-09-09T09:00:00Z",
                  agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } }] },
      // ── 191 两队红队补的四格(它们「写得出却没写」正是 D107 那一族:夹具能表达而没人写)──────
      //   四条都是 pos(应拦),各钉一处修法;把 `at` 挪一挪就能让它们互相翻面,故都是单变量证人。
      { name: "红队一/二 BP-1(量词):红队条目无时间戳 + 窗口另有带 at 的动作 ⇒ 不得白拿凭证",
        text: "本批闸引擎改动,提交。", at: "2026-09-09T12:00:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-09-09T10:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "别的活", at: "2026-09-09T11:00:00Z", bash: "echo x" }] },
      { name: "红队二 BP-4(上界):红队时间戳在未来 ⇒ 不得在池内",
        text: "本批闸引擎改动,提交。", at: "2026-09-09T12:00:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-09-09T10:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", at: "2030-01-01T00:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } }] },
      { name: "红队一 BP-1/BP-2(切点):红队晚于武装时刻,但其后又有一次承重提交 ⇒ 该次提交之后的改动仍欠红队",
        text: "再改一版判据,提交。", at: "2026-09-09T13:00:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-09-09T10:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", at: "2026-09-09T11:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "按回件改判据并提交", at: "2026-09-09T11:30:00Z", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x" }] },
      { name: "红队二 BP-3(epoch):armedAt=1970 是合法时刻,主路径不得因真值兜底整条关闭",
        text: "本批闸引擎改动,提交。", at: "2026-09-09T13:00:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "1970-01-01T00:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", at: "1970-01-01T00:00:01Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "其后的承重提交", at: "2026-09-09T11:00:00Z", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x" }] },
      // codex 185「你没问到」2(High):闸引擎经 Bash 写 + `git add -A` ⇒ 原 triggered 看不见,红队检查走不到
      { name: "codex-185 ②:Bash 写闸文件 + git add -A ⇒ P 触发且欠红队",
        text: "第一笔。", pLedger: { carriers: 0 },
        bash: ["node -e \"require('fs').writeFileSync('scripts/lib/gate-rules.mjs','x')\"", "git add -A && git commit -m x"] },
      // D11 独立于宽限(2026-09-07):计数不足 5(pLedger 0)也要红队——闸引擎面每批必跑
      { name: "D11 独立于宽限:pLedger=0 的闸引擎提交,只 grill ⇒ 仍欠红队",
        text: "第一笔,闸引擎批。", pLedger: { carriers: 0 },
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        agent: "grill:edge-cases", web: "先例" },
      // 红队 182 BP-7:闸引擎经 **Bash** 改(writes 里没有)+ `git add -A`(参数面无路径)⇒ 首版收紧看不见
      { name: "BP-7:闸引擎经 Bash 改、只 grill ⇒ 仍欠",
        text: "第五笔。", pLedger: { carriers: 4 }, write: "docs/laws/collab.md",
        bash: ["node -e \"require('fs').appendFileSync('scripts/lib/gate-rules.mjs','//x')\"",
               "node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A && git commit -m x"],
        agent: "grill:testing", web: "先例" },
      // 红队 182 BP-8:`cd scripts/lib && git add gate-rules.mjs` 的相对形 ⇒ 裸文件名也认
      { name: "BP-8:cd 后相对路径提交闸文件、只 grill ⇒ 仍欠",
        text: "第五笔。", pLedger: { carriers: 4 }, write: "docs/laws/collab.md",
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "cd scripts/lib && git add gate-rules.mjs && cd ../.. && git commit -m x"],
        agent: "grill:testing", web: "先例" },
      // 红队 182 BP-9:起一次空 prompt 的红队 agent 不算独立视角(入参须绑定闸文件/规则 id/diff)
      { name: "BP-9:红队 agent 空 prompt ⇒ 仍欠",
        text: "第五笔。", pLedger: { carriers: 4 },
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        agent: { type: "_gate-bypass-hunter", prompt: "hi" }, web: "先例" },
      // D34 证人②:本地读**不算**外部先例 ⇒ 仍欠。变异「Read/Grep 也算联网」在此翻面。
      { text: "第五笔,只本地读了页面缓存。", pLedger: { carriers: 4 },
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A docs/laws/collab.md && git commit -m x"],
        agent: "grill:testing", read: "C:/cache/page.html" },
      // **引号路径的暂存是真承重提交**(2026-08-22 修的真回归的证人,与 neg 的 -m 提及配对):
      //   `git add -A "闸文件"` 引号被旧式 stripQuoted 剥瞎 ⇒ 判成非承重 ⇒ P 不触发 ⇒ 漏拦。
      //   codex 全量分类:86 条「旧有新无」分歧里 43 条 didCommit=true 属此族。
      { text: "提交了。", bash: ["git add -A \"docs/laws/reporting.md\" && git commit -m x"] },
      // 伪造②③:入参里出现字面量——读一眼脚本(head/Read/Grep)、把调用串 echo 出来。
      //   这是全语料里 290/306 的那一族,**它在工具入参上**,所以光靠结构化 ctx 拦不住。
      { text: "三通道都复核过了。",
        bash: ["head -60 ~/.claude/scripts/codex-run.mjs --task", "echo \"node codex-run.mjs --task t.md\"",
               "git add -A docs/laws/collab.md && git commit -m x"],
        read: "C:/Users/x/.claude/scripts/codex-run.mjs", grep: "scripts/codex-run.mjs" },
      // 伪造④:文本豁免——一句话关掉三条通道(含引用闸自己的报错)。已撤,必须照拦。
      { text: "三条通道本轮不可用:配额已耗尽、站点不可达(rate-limit / 429 / ENOTFOUND)。",
        bash: ["git add -A .claude/settings.json && git commit -m x"] },
      // 伪造④′:把失败字样搬到动作面但**没真发起过通道**(`echo 429`)。旧实现在这里放行。
      { text: "复核受限。",
        bash: ["echo \"HTTP 429 rate-limit quota exceeded\"", "git add -A package.json && git commit -m x"] },
      // 伪造⑥(2026-08-20 补,grill:testing 报 CRITICAL 的回归证人):
      //   **跨通道借豁免**——codex 那条真限流了,但 agent / web 一次没跑。
      //   旧写法的豁免是规则级布尔 ⇒ 这里**放行**;按通道分账后只豁免 codex 那条 ⇒ 照拦。
      { text: "codex 限流了,先提交。",
        bash: ["node ~/.claude/scripts/codex-run.mjs --poll --job J1 # 上次 429 rate-limit 退回",
               "git add -A AGENTS.md && git commit -m x"] },
      // 伪造⑦:一次**垃圾**调用带失败词就想关掉三条通道。实测两个字「限流」曾经放行全部。
      { text: "先提交。", web: "限流",
        bash: ["git add -A scripts/hook-stop-closure.mjs && git commit -m x"] },
      // 伪造⑧:短路守卫——`false &&` 后面那段**根本不执行**,不得计作真调用。
      //   codex 2026-08-20 报、本机实测:三个字符就能关掉这条闸。
      { text: "跑过了。", agent: "grill:testing", web: "先例",
        bash: ["false && node ~/.claude/scripts/codex-run.mjs --task t.md",
               "git add -A docs/laws/reporting.md && git commit -m x"] },
      // 伪造⑤:写进**文件正文**的字面量(`written` 面)。改法典的提交,diff 自己就带着这些字。
      { text: "改完了。", write: "docs/laws/collab.md",
        written: "本条要求跑 mcp__codex-cli__codex 与 grill:security,并 WebSearch 查先例。",
        bash: ["git commit -m x -- docs/laws/collab.md"] },
      // 批 257 条件 3 分档的拦截侧证人:改的是测试文件旁边的普通承重脚本 ⇒ 重档 ⇒ 跨模型与联网照欠。
      //   与 neg 里「只改测试文件」那条只差 diff 事实一处(单变量对照)。
      { name: "条件3:改普通承重脚本 ⇒ 重档,跨模型与联网照欠",
        text: "第五笔,改脚本。", pLedger: { carriers: 4 },
        bash: ["git add -A scripts/lib/ledger-chain.mjs && git commit -m x"], agent: "grill:edge-cases",
        diffFacts: { root: "/repo", files: [{ path: "scripts/lib/ledger-chain.mjs", status: "M", readable: true }] } },
      // 红队 c3 BP-7:主树 diff 只有测试文件,但承重件写在别的 checkout(worktree / 别的仓)⇒ 事实不全 ⇒ 不分档,照欠
      // 红队 d1cae02 轮 BP-3/4:义务跨批累计 ⇒ 窗口里武装之前的承重写入(上一批 / 晚武装)同样要覆盖,不能按武装时刻切掉
      // 红队 3112024 轮 BP-1:cd 相对形 Bash 改闸引擎 + `git add -A` 提交 ⇒ 仍触发,且欠红队
      { name: "cd 相对形 Bash 改闸引擎 + git add -A ⇒ 触发",
        text: "收工。", pLedger: { carriers: 0 },
        bash: ["cd scripts/lib && sed -i s/a/b/ gate-rules.mjs", "git add -A && git commit -m x"] },
      // 红队 3112024 轮 BP-2:裸名 gate-difftier.mjs 也是闸引擎 ⇒ 独立视角只认红队,grill 不顶
      { name: "cd 相对改 gate-difftier、只 grill ⇒ 仍欠红队",
        text: "第五笔。", pLedger: { carriers: 4 }, write: "docs/laws/collab.md",
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "cd scripts/lib && sed -i s/a/b/ gate-difftier.mjs",
               "cd scripts/lib && git add gate-difftier.mjs && cd ../.. && git commit -m x"], agent: "grill:testing", web: "先例" },
      // 红队 3112024 轮 BP-5:P 这一层要有「只改法典 ⇒ 重档」的证人
      { name: "条件3:只改法典 ⇒ 重档",
        text: "第五笔,改法典。", pLedger: { carriers: 4 },
        bash: ["git add -A docs/laws/collab.md && git commit -m x"], agent: "grill:edge-cases",
        diffFacts: { root: "/repo", files: [{ path: "docs/laws/collab.md", status: "M", readable: true }] } },
      { name: "条件3:武装之前的承重写入也算,不分档",
        text: "第五笔,改测试。", pLedger: { carriers: 4 },
        batchGoal: { armedAt: "2026-10-10T08:00:00Z", conditions: ["甲"] },
        prior: [{ text: "武装前在 worktree 改宪法", write: "/repo/.claude/worktrees/w1/AGENTS.md", at: "2026-10-10T07:50:00Z" }],
        bash: ["git add -A scripts/lib/ledger-chain.test.mjs && git commit -m x"], agent: "grill:edge-cases",
        diffFacts: { root: "/repo", files: [{ path: "scripts/lib/ledger-chain.test.mjs", status: "M", readable: true }] } },
      { name: "条件3:承重写入在别的 checkout ⇒ 不分档",
        text: "第五笔,在 worktree 改宪法。", pLedger: { carriers: 4 }, write: "E:/elsewhere/AGENTS.md",
        bash: ["cd E:/elsewhere && git add -A && git commit -m x"], agent: "grill:edge-cases",
        diffFacts: { root: "/repo", files: [{ path: "scripts/lib/ledger-chain.test.mjs", status: "M", readable: true }] } },
    ],
    neg: [
      // ══ 红队 a9af71da 的接受侧 ═════════════════════════════════════════════════════════════════
      // BP-5(误拦):本仓 `git commit` 没落盘(未暂存 / pre-commit 失败 / 权限被拒)⇒ 范围里无本轮提交,但没有任何离开本仓根的证据
      //   ⇒ 不是「落在别处」(原三通道全命中;b7ef430 上放行)
      { name: "a9af71da BP-5:本仓提交未落盘、无离开本仓根的证据 ⇒ 放行",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        bash: ["git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      // 2026-10-11 改形(删跨调用跟踪):下两条原为「上一次调用 cd、本次提交」跨调用形(现起点一律回根 ⇒ 空证人)⇒ 改同一调用内
      { name: "a9af71da BP-5:cd 进本仓子目录后提交未落盘 ⇒ 仍在本仓,放行",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        bash: ["cd docs/laws && git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      { name: "a9af71da BP-5:PS 切他仓后又 Set-Location 回本仓根,提交未落盘 ⇒ 放行",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        ps: ["Set-Location E:/elsewhere; Set-Location -Path '\\repo'; git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      // 2026-10-11 新增(删跨调用跟踪的接受侧,Bash / PS 各一):上一次调用 cd 他仓、本次调用本仓 `git commit` 失败 ⇒ 每次调用起点回根,不计别处
      //   (两条都在本轮,是「每次调用起点不回根」变异的证人;PS 一条正是让出面——PS 跨调用若保持 cwd、且那笔真提交进了他仓,这里会漏)
      { name: "上一次 Bash 调用 cd 他仓、本次调用本仓提交失败 ⇒ 起点回根,不计别处",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        bash: ["cd E:/elsewhere && ls", "git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      { name: "上一次 PS 调用 Set-Location 他仓、本次调用本仓提交失败 ⇒ 起点回根,不计别处",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        ps: ["Set-Location E:/elsewhere", "git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      // BP-5 修后「落在别处」那支须有 cd 证据才走到 `ownSyntaxCarrier`;原证人(下方「本次范围无提交、窗口里有已提交过的承重写入」)
      //   不再走到它 ⇒ 补一条带 cd 的:窗口里早已提交过的法典写入,本轮在他仓做一笔非承重提交 ⇒ 只看本轮,不得翻出窗口里的写入
      //   a084a536 BP-6 改形:原为上一次 Bash 调用 cd 他仓(真实语义下被回置 ⇒ 走不到 ownSyntaxCarrier,空证人)⇒ 改同一调用内
      { name: "a9af71da BP-5:同一调用内 cd 他仓做非承重提交、窗口里有本仓早已提交过的法典写入 ⇒ 不触发(只看本轮语法)",
        text: "在他仓提交业务改动。", pLedger: { carriers: 4 }, hookCheckout: "/repo",
        prior: [{ text: "上批改法典", write: "docs/laws/collab.md" }],
        bash: ["cd E:/elsewhere && git add -A && git commit -m x"], headFacts: { root: "/repo", commits: [] } },
      // BP-1 接受侧:聚合项净差只带业务码 ⇒ 不触发(聚合不等于一律越限)
      { name: "a9af71da BP-1:聚合项(61 笔)净差只有 src/ ⇒ 不触发",
        text: "合回。", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-x -m m"],
        headFacts: { root: "/repo", head: "9".repeat(40), commits: [{ sha: "9".repeat(40), aggregated: true, count: 61, files: ["src/app/page.tsx"] }] } },
      // ══ 红队 a2a9f58b 的接受侧 ═════════════════════════════════════════════════════════════════
      //   (BP-8「点名覆盖」已撤,该夹具移到 pos 作已知残余的钉子,见 D149④)
      // codex 257-p-agg-r1 断言 2 的接受侧:账上已记同一范围键 `agg:<基点>..<HEAD>` ⇒ 不重计、宽限内放行
      { name: "codex agg-r1 ②反:账上已记同一聚合范围 ⇒ 不重计",
        text: "收工。", pLedger: { carriers: 0, shas: [`agg:${"b".repeat(40)}..${"e".repeat(40)}`] }, bash: ["git add -A && git commit -m x"],
        headFacts: { root: "/repo", base: "b".repeat(40), commits: [{ sha: "e".repeat(40), aggregated: true, count: 61, files: ["AGENTS.md"] }] } },
      // codex 257-p-agg-r1「没问到」②:切仓失败(is_error + cd 失败特征)、本仓 `git commit` 也失败 ⇒ 不是别处提交
      //   2026-10-11 改形(删跨调用跟踪):原为前轮 PS 切仓失败、本轮 PS 提交(跨调用形,起点回根后成空证人)⇒ 改同一次 PS 调用内
      { name: "codex agg-r1 ②:同一 PS 调用内切仓失败、其后本仓提交失败 ⇒ 不计别处承重提交",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        then: [{ text: "切了再提交", ps: "Set-Location E:/elsewhere; git commit -m law", failed: "Set-Location : Cannot find path 'E:\\elsewhere' because it does not exist." }],
        headFacts: { root: "/repo", commits: [] } },
      // ad3e4f93 BP-1 接受侧(bash 形):cd 本身失败的正文 ⇒ 该调用的 cd 按原地、不算证据
      //   (原另有一条「上一次 bash cd 失败、本轮提交」跨调用形,2026-10-11 删跨调用跟踪后删除:起点一律回根,cd 失败与否无关)
      { name: "ad3e4f93 BP-1 反:同一调用内 bash cd 失败(No such file)、其后本仓提交失败 ⇒ 不计别处",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        then: [{ text: "切了再提交", bash: "cd E:/elsewhere ; git commit -m law", failed: "/usr/bin/bash: line 1: cd: E:/elsewhere: No such file or directory" }],
        headFacts: { root: "/repo", commits: [] } },
      // a07e98e9 BP-1 接受侧:子 shell 里的 cd 只作用到子 shell 结束 ⇒ 其后本仓提交失败不算别处
      { name: "a07e98e9 BP-1 反:子 shell 里 cd 他仓、子 shell 后本仓提交失败 ⇒ 不计别处",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        bash: ["(cd E:/elsewhere && ls) ; git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      // 照实:这条是**空证人**——`$( … )` 里的 cd 根本认不出(段首是 echo,见 D149),不是「认出了、按子 shell 弹回」
      { name: "a07e98e9 BP-1 反:命令替换里 cd 他仓(cd 在 $( ) 里认不出,见 D149)、其后本仓提交失败 ⇒ 不计别处",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "/repo", write: "/repo/AGENTS.md",
        bash: ["echo $(cd E:/elsewhere && pwd) && git commit -m law"], headFacts: { root: "/repo", commits: [] } },
      // a07e98e9 BP-2 接受侧:git -C ~ 解在本仓根内(本仓根在家目录下)⇒ 本仓提交失败,不计别处
      { name: "a07e98e9 BP-2 反:git -C ~/repo(根就在家目录下)⇒ 仍是本仓,不计别处",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "C:/Users/me/repo", write: "C:/Users/me/repo/AGENTS.md",
        bash: ["git -C ~/repo commit -m law"], headFacts: { root: "C:/Users/me/repo", commits: [] } },
      { name: "a07e98e9 BP-2 反:PS 切到 E: 再切回本仓所在盘 后本仓提交失败 ⇒ 回到本仓,不计别处",
        text: "x", pLedger: { carriers: 4 }, hookCheckout: "C:/w/repo", write: "C:/w/repo/AGENTS.md",
        // 2026-10-11 改形(删跨调用跟踪):原为两次 PS 调用切盘、第三次提交 ⇒ 改同一次 PS 调用内(钉「裸盘符回到该盘上次所在」)
        ps: ["E:; C:; git commit -m law"], headFacts: { root: "C:/w/repo", commits: [] } },
      // 2026-10-11 删跨调用跟踪:原此处「复核红队 a084a536 BP-6」四条(上一次 Bash cd 变量 / cd ~ / 回置声明指向本仓根 / 根内子目录跨调用保持)、
      //   「a56d53db BP-2」(根内输出末行恰似声明)、「复核 620e556 BP-4」两条(PS 跨调用 UNK_PARSE 回根)只钉跨调用行为 ⇒ 删除;
      //   其中「根内子目录跨调用保持」那条按新语义改判为 pos「已知残余」(起点一律回根 ⇒ `cd ..` 解出根外)。
      //   「起点回根」本身由上方两条「上一次调用 cd 他仓、本次调用本仓提交失败」新反例钉着。
      // BP-1 边界:pLedger=0、4 笔法典提交 ⇒ 仍在宽限内(与 10 笔那条 pos 配对,钉住「按提交数计」而不是「一律越限」)
      { name: "a2a9f58b BP-1 边界:pLedger=0、git add -A 带进 4 笔法典提交 ⇒ 宽限内放行",
        text: "收工。", pLedger: { carriers: 0 }, bash: ["git add -A && git commit -m x"],
        headFacts: { root: "/repo", commits: Array.from({ length: 4 }, () => ({ files: ["docs/laws/collab.md"] })) } },
      // BP-1 去重:P 欠着时基点不推进 ⇒ 已记过账的两笔下次还在范围里;账上有其 sha ⇒ 不再计(3 + 0 < 5)
      { name: "a2a9f58b BP-1 去重:范围里两笔已记过账(sha 在账上)⇒ 不重复计,宽限内放行",
        text: "上轮已计账的两笔,本轮没有新提交。", pLedger: { carriers: 3, shas: ["1".repeat(40), "2".repeat(40)] },
        headFacts: { root: "/repo", commits: [{ sha: "1".repeat(40), files: ["docs/laws/collab.md"] }, { sha: "2".repeat(40), files: ["AGENTS.md"] }] } },
      // ══ 红队 a27628dd / 量化 a00051d 的接受侧(误拦族)═════════════════════════════════════════
      // BP-1 反:merge 带进的只有业务码 ⇒ 不触发(git 事实只认承重面)
      { name: "a27628dd BP-1 反:merge 只带进 src/ ⇒ 不触发",
        text: "合回子代理的业务改动。", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-x -m merge"],
        headFacts: { root: "/repo", commits: [{ files: ["src/app/page.tsx"] }] } },
      // BP-1 反:merge 带进闸引擎,其后父侧跑过绑定的红队 ⇒ 放行
      { name: "a27628dd BP-1 反:merge 带进闸引擎 + 合回后跑了绑定红队 ⇒ 放行",
        text: "合回并红队。", pLedger: { carriers: 0 },
        bash: ["git merge --no-ff worktree-agent-x -m merge"],
        agent: { type: "_gate-bypass-hunter", prompt: "红队合回的 scripts/lib/gate-rules.mjs 改动" },
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"] }] } },
      // BP-6 反(回退面):闸副本在外发暂存树 / cp 备份进 clipboard / git log -S / heredoc 提交信息 / grep "tee "
      //   ——之后一笔无关提交不得被要求红队(派出方裁定:暂存树与 worktree 下的副本不算本仓闸引擎)
      { name: "a27628dd BP-6 反:改外发暂存树里的闸副本 + 无关提交 ⇒ 不要求红队",
        text: "同步公开仓。", pLedger: { carriers: 0 }, write: "/repo/clipboard/oss/public-repo/scripts/lib/gate-rules.mjs",
        bash: ["git add -A src/app/page.tsx && git commit -m x"] },
      { name: "a27628dd BP-6 反:cp 备份闸文件到 clipboard + 无关提交 ⇒ 不要求红队",
        text: "先备份。", pLedger: { carriers: 0 },
        bash: ["cp scripts/lib/gate-rules.mjs clipboard/bak/gate-rules.mjs", "git add -A src/app/page.tsx && git commit -m x"] },
      { name: "a27628dd BP-6 反:cd 进暂存树改闸副本 + 无关提交 ⇒ 不要求红队",
        text: "改副本。", pLedger: { carriers: 0 },
        bash: ["cd clipboard/oss/public-repo/scripts/lib && sed -i s/a/b/ gate-rules.mjs", "git add -A src/app/page.tsx && git commit -m x"] },
      { name: "a27628dd BP-6 反:改 worktree 里的闸副本 + 本仓无关提交 ⇒ 不要求红队",
        text: "看一眼子代理的改动。", pLedger: { carriers: 0 }, write: "/repo/.claude/worktrees/w1/scripts/lib/gate-rules.mjs",
        bash: ["git add -A src/app/page.tsx && git commit -m x"] },
      { name: "a27628dd BP-6 反:git log -S commit -- 闸文件(只读)+ 无关提交 ⇒ 不要求红队",
        text: "查历史。", pLedger: { carriers: 0 },
        bash: ["git log -S commit -- scripts/lib/gate-rules.mjs", "git add -A src/app/page.tsx && git commit -m x"] },
      { name: "a27628dd BP-6 反:heredoc 提交信息里提到 git add 闸文件 ⇒ 不要求红队",
        text: "提交。", pLedger: { carriers: 0 },
        bash: ["git add -A src/app/page.tsx && git commit -F - <<'EOF'\nfix: 页面\ngit add scripts/lib/gate-rules.mjs 那一步留给下批\nEOF"] },
      { name: "a27628dd BP-6 反:grep -c \"tee \" 闸文件(只读)+ 无关提交 ⇒ 不要求红队",
        text: "数一下。", pLedger: { carriers: 0 },
        bash: ["grep -c \"tee \" scripts/lib/gate-rules.mjs", "git add -A src/app/page.tsx && git commit -m x"] },
      // BP-7 反(回退面):上一批改闸 → 提交 → 绑定红队 → 无关提交;本批再做一笔无关承重提交 ⇒ 不要求重跑红队
      { name: "a27628dd BP-7 反(回退面):闸改动全在最后一次绑定红队之前 ⇒ 不要求重跑",
        text: "改法典,提交。", pLedger: { carriers: 0 },
        bash: ["git add -A docs/laws/collab.md && git commit -m x"],
        prior: [{ text: "改闸", write: "scripts/lib/gate-rules.mjs" },
                { text: "提交闸", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x" },
                { text: "红队", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "记台账", bash: "git add docs/gate-debts.md && git commit -m x" }] },
      { name: "a27628dd BP-7 反(git 面):本次范围只带进法典 ⇒ 窗口里旧的闸写入不算",
        text: "改法典,提交。", pLedger: { carriers: 0 },
        bash: ["git add -A docs/laws/collab.md && git commit -m x"],
        prior: [{ text: "改闸", write: "scripts/lib/gate-rules.mjs" },
                { text: "提交闸", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x" }],
        headFacts: { root: "/repo", commits: [{ files: ["docs/laws/collab.md"] }] } },
      // git 面:范围空(已提交过的承重写入还在窗口里)+ 一笔空提交 ⇒ 不触发(承重面的 BP-7 同形)
      { name: "a27628dd git 面:本次范围无提交、窗口里有已提交过的承重写入 ⇒ 不触发",
        text: "再提交一次(无改动)。", pLedger: { carriers: 4 },
        bash: ["git commit -m x"], prior: [{ text: "上批改法典", write: "docs/laws/collab.md" }],
        headFacts: { root: "/repo", commits: [] } },
      // 量化 a00051d BP-1:改闸 → 提交 → 绑定红队 → 只改文档的提交;本轮只提交宪法 ⇒ 放行(两个面各一条)
      { name: "a00051d BP-1(git 面):红队之后只有宪法/文档提交 ⇒ 放行",
        text: "提交宪法。", at: "2026-10-10T09:33:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-10-10T08:00:00Z", conditions: ["甲"] },
        bash: ["git add AGENTS.md && git commit -m x"],
        prior: [{ text: "改闸", at: "2026-10-10T09:28:00Z", write: "scripts/lib/gate-rules.mjs" },
                { text: "提交闸", at: "2026-10-10T09:29:00Z", bash: "git add scripts/lib/gate-rules.mjs && git commit -m x" },
                { text: "红队", at: "2026-10-10T09:29:20Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "提交文档", at: "2026-10-10T09:30:00Z", bash: "git add docs/e.md && git commit -m x" }],
        headFacts: { root: "/repo", commits: [{ files: ["AGENTS.md"], at: "2026-10-10T09:33:00Z" }], engineAnchorAt: "2026-10-10T09:29:00Z" } },
      { name: "a00051d BP-1(回退面):红队之后只有宪法/文档提交 ⇒ 放行",
        text: "提交宪法。", at: "2026-10-10T09:33:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-10-10T08:00:00Z", conditions: ["甲"] },
        bash: ["git add AGENTS.md && git commit -m x"],
        prior: [{ text: "改闸", at: "2026-10-10T09:28:00Z", write: "scripts/lib/gate-rules.mjs" },
                { text: "提交闸", at: "2026-10-10T09:29:00Z", bash: "git add scripts/lib/gate-rules.mjs && git commit -m x" },
                { text: "红队", at: "2026-10-10T09:29:20Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "提交文档", at: "2026-10-10T09:30:00Z", bash: "git add docs/e.md && git commit -m x" }] },
      // 量化 a00051d BP-2:他仓提交与 --amend 不切凭证池(git 面切点只在本仓带闸改动的提交)
      { name: "a00051d BP-2(git 面):红队 → 他仓提交 → amend → 本仓闸修复提交 ⇒ 红队仍抵账",
        text: "按回件修闸并提交。", at: "2026-10-10T10:30:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-10-10T08:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", at: "2026-10-10T10:00:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "他仓提交", at: "2026-10-10T10:10:00Z", bash: "cd /d/dotfiles-claude && git add -A && git commit -m x" },
                { text: "改提交信息", at: "2026-10-10T10:20:00Z", bash: "git commit --amend --no-edit" }],
        headFacts: { root: "/repo", commits: [{ files: ["scripts/lib/gate-rules.mjs"], at: "2026-10-10T10:30:00Z" }], engineAnchorAt: "2026-10-10T09:00:00Z" } },
      // 量化 a00051d BP-3:上一批改闸并红队,新批武装后只提交 src/ ⇒ 不触发(两个面)
      { name: "a00051d BP-3(git 面):新批只提交 src/ ⇒ 不欠红队",
        text: "新批业务改动。", at: "2026-10-10T10:30:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-10-10T10:00:00Z", conditions: ["甲"] },
        bash: ["git add -A src/app/page.tsx && git commit -m x"],
        prior: [{ text: "改闸", at: "2026-10-10T09:00:00Z", write: "scripts/lib/gate-rules.mjs" },
                { text: "提交闸", at: "2026-10-10T09:01:00Z", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x" },
                { text: "红队", at: "2026-10-10T09:02:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } }],
        headFacts: { root: "/repo", commits: [{ files: ["src/app/page.tsx"] }], engineAnchorAt: "2026-10-10T09:01:00Z" } },
      { name: "a00051d BP-3(回退面):新批只提交 src/ ⇒ 不欠红队",
        text: "新批业务改动。", at: "2026-10-10T10:30:00Z", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-10-10T10:00:00Z", conditions: ["甲"] },
        bash: ["git add -A src/app/page.tsx && git commit -m x"],
        prior: [{ text: "改闸", at: "2026-10-10T09:00:00Z", write: "scripts/lib/gate-rules.mjs" },
                { text: "提交闸", at: "2026-10-10T09:01:00Z", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x" },
                { text: "红队", at: "2026-10-10T09:02:00Z", agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } }] },
      // 量化 a00051d BP-4 / 派出方口径③:原 pos「回退路径 fail-closed:红队之后的 docs-only 提交也切」**翻成放行**——
      //   与原 neg「codex-185 ① 边界」只差中间一笔文档提交、一拦一放,自相矛盾。宽松口径:红队之后按回件修闸再提交
      //   算这一轮红队的处置。git 事实在 ⇒ 文档提交不切。(取不到 git 事实时的「任何提交都切」另有 pos 钉着。)
      { name: "a00051d BP-4(原 pos 翻面):git 事实在 ⇒ 红队之后的 docs-only 提交不切,修闸提交抵账",
        text: "本批收尾提交。", pLedger: { carriers: 0 },
        write: "scripts/lib/gate-rules.mjs", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x",
        prior: [{ text: "本批红队", agent: { type: "_gate-bypass-hunter", prompt: "红队本批 scripts/lib/gate-rules.mjs 的改动" } },
                { text: "记台账", bash: "git add docs/gate-debts.md docs/product-diary.md && git commit -m x" }],
        headFacts: { root: "/repo", commits: [{ files: ["docs/gate-debts.md", "docs/product-diary.md"] }, { files: ["scripts/lib/gate-rules.mjs"] }] } },
      // 批 257 条件 3 分档的接受侧证人:只改测试文件 ⇒ 轻档 ⇒ 只欠独立视角,grill 在场即放行。
      { name: "条件3:只改测试文件 ⇒ 轻档,免跨模型与联网",
        text: "第五笔,改测试。", pLedger: { carriers: 4 },
        bash: ["git add -A scripts/lib/ledger-chain.test.mjs && git commit -m x"], agent: "grill:edge-cases",
        diffFacts: { root: "/repo", files: [{ path: "scripts/lib/ledger-chain.test.mjs", status: "M", readable: true }] } },
      // 真调用集:三条通道各真跑一遍 ⇒ 放行。**这是唯一的接受侧证人**,
      //   它红了不是「少过一条」,是「本条判据是不是一律拦」没人测了。
      //   D11 收紧后(2026-09-06):这条提交的是**闸引擎文件**,独立视角须是红队 agent;grill 的接受侧证人
      //   挪到下一条(法典提交)——两条合起来才证「收紧只作用于闸引擎面」。
      { text: "承重面改完并提交,三通道各跑一遍。",
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A scripts/hook-stop-closure.mjs && git commit -m x"],
        agent: { type: "_gate-bypass-hunter", prompt: "红队本批对 scripts/hook-stop-closure.mjs 的改动,规则 id K/S" }, web: "业界先例" },
      // D107 主路径证人的接受侧(191):同一形态,红队调用**晚于**武装时刻 ⇒ 在凭证池内 ⇒ 放行。
      //   与 pos 那条**只差一个时间戳**(正文同为「红队」,codex 191 指出原来正文不同 ⇒ 不是单变量对照)。
      //   ⚠️ 注意:主路径失效时本条**仍放行**(变异实测 neg 前后同为 hits=0),故它不是变异的证人——杀变异的是 pos。
      { name: "D107 主路径:红队调用晚于本批武装时刻 ⇒ 在凭证池内 ⇒ 放行",
        text: "本批闸引擎改动,提交。", pLedger: { carriers: 0 },
        batchGoal: { armedAt: "2026-09-09T10:00:00Z", conditions: ["甲"] },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        prior: [{ text: "红队", at: "2026-09-09T11:00:00Z",
                  agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } }] },
      // D11 独立于宽限的另一半:计数不足时**只**要求红队,另两通道仍按宽限 ⇒ 只有红队在场也放行
      { name: "D11 独立于宽限:pLedger=0、只有绑定的红队在场 ⇒ 放行(另两通道仍按宽限)",
        text: "第一笔,闸引擎批,红队跑过。", pLedger: { carriers: 0 },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"],
        agent: { type: "_gate-bypass-hunter", prompt: "红队 scripts/lib/gate-rules.mjs 的改动" } },
      // codex 185 ① 的边界:红队调用在窗口里**最后一次提交之后**(同一批内、隔轮跑的)⇒ 认
      { name: "codex-185 ① 边界:本批内隔轮跑的红队(晚于上次提交)⇒ 放行",
        text: "本批收尾提交。", pLedger: { carriers: 0 },
        write: "scripts/lib/gate-rules.mjs", bash: "git add -A scripts/lib/gate-rules.mjs && git commit -m x",
        prior: [{ text: "批 184 结束", commit: true },
                { text: "本批红队", agent: { type: "_gate-bypass-hunter", prompt: "红队本批 scripts/lib/gate-rules.mjs 的改动" } }] },
      { name: "D11 边界:非闸引擎的承重提交,grill 仍充分",
        text: "法典改完并提交,三通道各跑一遍。",
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A docs/laws/collab.md && git commit -m x"],
        agent: "grill:testing", web: "业界先例" },
      // 同上,但跨模型走的是 **MCP 工具**而非 `node codex-run.mjs` ⇒ 同样放行。
      //   2026-08-20 补:产它的四套独立夹具**一致地**漏掉这一种形态(覆盖齐停在 3/4)。
      //   判别实验(剥掉通道动作看规则是否翻面)测得 16 条反例只有 7 条真检验了计数器。
      //   规则本身判得对(探针 3/3),漏的是夹具 —— 这正是「四份互打全绿」证不了的洞。
      { text: "承重面改完并提交,跨模型走 MCP。",
        bash: ["git add -A docs/laws/reporting.md && git commit -m x"],
        mcp: "mcp__codex-cli__codex", agent: "grill:testing", web: "业界先例" },
      // 提交的不是承重面 ⇒ 不触发(变异③的证人)
      { text: "改的是业务代码。", bash: ["git add -A src/app/page.tsx && git commit -m x"] },
      // 改了承重件但**没提交** ⇒ 不触发(P 的触发点是提交,不是修改)
      { text: "改了闸的机件,还没提交。", write: "scripts/hook-stop-closure.mjs" },
      // 合法豁免:**真发起过** codex 且那次调用的入参留着限流痕迹,**且另两条通道真跑了** ⇒ 放行。
      //   ⚠️ 2026-08-20 改:原写法只有 codex 一条(另两条一次没跑)却期望放行
      //   —— 那**编码的是刚修掉的 bug**(规则级豁免关掉三条通道)。同一输入已挪进 pos 当回归证人。
      { text: "codex 通道限流了,另两条照跑。",
        bash: ["node ~/.claude/scripts/codex-run.mjs --poll --job J1 # 上次 429 rate-limit 退回",
               "git add -A AGENTS.md && git commit -m x"],
        agent: "grill:testing", web: "业界先例" },
      // 真调用在**窗口**里(上几轮跑的),本轮只提交 ⇒ 放行。
      //   2026-08-20 补,grill:testing 报:`scopeActions` 的「窗口 ∪ 本轮」合并
      //   **零变异零用例**——把合并整个删掉,9 条用例一条都不翻面。
      //   夹具的 `prior` 通道是为这件事加的(第六次同族),却从没在 P 自己的用例里用过。
      //   「看着像修好了、其实从没被跑过」比坏掉更危险。
      { text: "上几轮跑完了三条通道,本轮收尾提交。",
        bash: ["git add -A docs/laws/collab.md && git commit -m x"],
        prior: [{ text: "跨模型", bash: "node ~/.claude/scripts/codex-run.mjs --task t.md" },
                { text: "独立视角", agent: "grill:testing" },
                { text: "外部先例", web: "先例" }] },
      // 真调用带引号路径 / 包装器 ⇒ 仍须计数(codex 2026-08-20 报的误报族)。
      { text: "路径带引号地跑。", agent: "grill:testing", web: "先例",
        bash: ["node \"C:/Users/x/.claude/scripts/codex-run.mjs\" --task t.md",
               "git add -A docs/laws/lawmaking.md && git commit -m x"] },
      // **提交信息里提到承重路径 ≠ 承重提交**(CEILING 的回归证人,与下面 pos 的引号暂存配对):
      //   真提交的是业务码,-m 里顺嘴提了闸文件 ⇒ 不触发。谁把 message 剥离撤了,这条就红。
      { text: "提交业务代码。",
        bash: ["git add -A src/app/page.tsx && git commit -m \"顺手记一句 scripts/hook-stop-closure.mjs 的事\""] },
      // **跨批宽限**(2026-08-22 亲签「改吧」的正面证人):持久账累计 3 + 本轮 1 = 4 < 5
      //   ⇒ 零通道也放行。谁把计账支路撤了(退回窗口式每次欠),这条就红。
      //   2026-09-07(D11 独立于宽限):证人改提交**法典**——闸引擎提交在宽限内也要红队,不再是零通道放行的例子。
      { text: "小修提交。", pLedger: { carriers: 3 },
        bash: ["git add -A docs/laws/collab.md && git commit -m x"] },
      // 账满且通道齐 ⇒ 放行(与 pos 的「账满无通道 ⇒ 拦」配对)
      { text: "第五笔,通道跑齐。", pLedger: { carriers: 4 },
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md",
               "git add -A docs/laws/collab.md && git commit -m x"],
        agent: "grill:testing", web: "先例" },
    ],
  },
};
// ===== RULE_P END =====
// RULES += RULE_P

// ===== RULE_W BEGIN =====(2026-08-22 用户亲签 A′;法条=docs/laws/reporting.md#交付物四眼)
// 「写文章出来写错了没人负责的?」—— four-eyes principle:无人可独自发布。
// 触发:收尾动作(ranClear)+ 批窗口∪本轮有交付物写入。
// 满足:窗口∪本轮里有一次**只读子代理**(grill:/_ 前缀)调用,且其入参提及某个交付物的文件名。
// 为什么挂 clear 不挂 commit:clipboard 在 gitignore 面永不提交,commit 触发面天生看不见它。
// CEILING:①只证「审读被真实发起且入参绑定该文件」,不证审得对、不证意见被采纳(与 P 同款);
//   ②窗口按条数封顶(400 entries),更早轮次的交付物写入会滑出视野 ⇒ 方向是漏放,
//   常态节奏(写完当批收)不受影响;③「提及文件名」可被空跑刷(派个 agent 提一嘴不看内容)
//   ——但那是一次真实的、有产出回件的调用,伪造成本≈真做成本,接受。
export const RULE_W = {
  id: "W",
  blocking: (ctx) => { try { return ranClear(ctx); } catch { return true; } },
  law: "docs/laws/reporting.md#交付物四眼",
  // 出路即数据(批 117)。三条通路逐字取自法条 reporting.md:161-163。
  //   ⚠️ 本条的 sample 必须**同时**带上交付物名——法条要求「入参须提及交付物名」,
  //   所以 sample 里的命令行里就写着 pos[0] 那个交付物,这本身就是自证的一部分。
  // ⚠️ **本表第一次跑就逮到一条我自己造的假出路**(2026-08-27,D80):
  //   我在 D73 重写本条消息时写成「出路(三选一)……③ 只读子代理」,
  //   把子代理列成了与 codex/battle **平级**的选项。**法条不是这么写的**:
  //   `reporting.md:161` =「**battle/codex 在场即充分**;仅 grill 不充分,须补 battle」
  //   ⇒ 子代理**从来不是独立出路**,它只是**绑定载体**(入参带交付物名),
  //   充分性仍须 battle/codex 在场。判据(`H.battleOrCodex`)一直是对的,漂的是消息。
  //   即:我**在修「消息承诺判据不认的出路」这个错型的过程中,又犯了一次同样的错**。
  //   自证机制第一次跑就把它打红——这正是立它的理由。
  escapes: [
    { say: "**codex**:node ~/.claude/scripts/codex-run.mjs --task <任务文件>(入参须含交付物名)",
      forPos: 0, sample: { bash: "node ~/.claude/scripts/codex-run.mjs --task clipboard/gate-playbook.md" } },
    // ⚠️ battle **能满足充分性,但自己带不了绑定**:`Skill` 调用的入参只有 skill 名,
    //   交付物文件名进不去。故绑定须另有一个外审动作把文件名写进入参(codex 命令行
    //   或 agent prompt)。这不是文档瑕疵——照旧文案「battle:方案审计专线(同样须带
    //   交付物名)」去做,做不到,又是一条画在墙上的门。出路自证逐正例跑之后逮到。
    { say: "**battle**:方案审计专线(充分性够);⚠️ 但 battle 自己**带不了文件名**," +
        "绑定须另有一个外审动作(codex 命令行 / agent prompt)把交付物名写进入参",
      forPos: 0, sample: { skill: "battle",
        agent: { type: "_source-verifier", prompt: "审读 clipboard/gate-playbook.md" } } },
    { say: "只读子代理(grill:* 或 _*)**不是独立出路**——它只作绑定载体," +
        "**充分性仍须 battle/codex 在场**(用户 2026-08-22 裁定:仅 grill 不充分)",
      forPos: 0, sample: { agent: { type: "_source-verifier", prompt: "审读 clipboard/gate-playbook.md" },
        bash: "node ~/.claude/scripts/codex-run.mjs --task clipboard/gate-playbook.md" } },
  ],
  _w: {
    deliverablesOf(ctx) {
      const out = new Set();
      const eat = (c) => { for (const p of (c?.writes || [])) if (isDeliverable(p)) out.add(String(p).replace(/\\/g, "/").split("/").pop()); };
      eat(ctx);
      try { const w = ctx.window(); if (w) eat(w); } catch { /* 窗口取不到 ⇒ 只看本轮(漏放向) */ }
      return [...out];
    },
    // ── 批 253(D130,窄例外③判据过重):生产写判据分清「读」与「执行」 ─────────────
    //   旧判据对整条命令串跑 `CONTENT_WRITE_RE` 子串 ⇒ `grep -n … scripts/deploy-prod.ps1`、
    //   `sed -n '1,40p' scripts/deploy-prod.ps1` 这类**读脚本**被当成生产写入(批 240 实撞)。
    //   **修法是「只豁免可证的纯读」,不是「只认段头为脚本名」**——后者会让本仓写正文的唯一调用形
    //   `node scripts/write-node.mjs --apply x` 漏判(D130 红队 BP-2)。故:含脚本名的命令**默认仍算写入**,
    //   只有同时满足下列四条才豁免:
    //   ① 用 `gate-cmd.mjs` 的 `segments()` 切段(不手搓),**每个**含脚本名的段,段头(跳过 `VAR=` 前缀)
    //      都在读类白名单 `readHead` 里(cat/grep/rg/sed/head/tail/less/more/wc/Get-Content/Select-String);
    //      段头是 node/pwsh/bash/xargs/&/路径 等一律不豁免——`bash -c '…'`、`pwsh -File`、`xargs -I{} node`
    //      天然留在命中侧,**不剥壳**(剥壳只会多出豁免机会,不会多出命中)。
    //   ② 该段掩码后**不含 `(`/`{`/反引号**——逐字照抄 DP 守卫 `!/[({`]/`(DP_IS_PUSH),
    //      防复刻 `ca7b33b` 那个洞:`cat <(node scripts/write-node.mjs --apply p.json)` 段头是 cat 但 write-node 真跑(BP-3)。
    //   ③ `sed` 带 `-i`/`--in-place` 不算读。
    //   ④ 命令里有管道 `|` 时,**所有**段头都须在管道安全白名单 `pipeHead` 里——
    //      否则 `grep -l x scripts/write-node.mjs | xargs -I{} node {} --apply p`、`cat x.ps1 | pwsh -Command -`、
    //      `Get-Content x.ps1 | iex` 会被读类段头带着放行。
    //   切段后找不到含脚本名的段(跨段形)⇒ 保守计写入。
    //   CEILING:①白名单外的读法(`git grep`、`git show`、`type`、带路径的 `/usr/bin/grep`)照拦——误拦残余,走 fp;
    //   ②GNU sed 的 `e` 命令 / `s///e` 与 `rg --pre` 能在「读类段头」下执行命令——属蓄意形态,按代价口径不计;
    //   ③D132 的 ssh 段(直接 ssh 敲部署步)**本批不碰**:它今天就不命中,本修法不改变它。
    //   ── 批 253b(第二轮红队)三处 ────────────────────────────────────────────
    //   · BP-6(漏放):`segments()` **不切后台 `&`**(它只切 `&& || ; | 换行`)⇒
    //     `tail -f logs/x.log & node scripts/write-node.mjs --apply p.json` 整段的段头是 `tail`
    //     ⇒ 读类豁免把真跑的那一半一起放了。修:段内出现**单个 `&`**(非 `&&`、非 `2>&1`/`&>` 重定向)
    //     ⇒ 该段不享受读类豁免,也不算「惰性段」。
    //   · BP-12(误拦,阻断):脚本名**只出现在引号里**(`git commit -m "…write-node.mjs…"`、
    //     `--cond "write-node.mjs 预览通过"`)或**只作为 git 的参数路径**(`git add/diff scripts/write-node.mjs`)、
    //     或 `node --check <脚本>`,都不是执行 ⇒ 判为**惰性段**(`inertSeg`),不算生产写。
    //     ⚠️ 「只在引号里出现就放行」**会开新洞**:`bash -c 'node scripts/write-node.mjs --apply p'`、
    //     `node "scripts/write-node.mjs" --apply p`(本仓真实调用形,引号包路径)都是执行。
    //     故惰性判定必须先过 `execsQuoted`:段头是 shell/解释器壳(bash/sh/pwsh/cmd/eval/ssh/xargs/iex…),
    //     或 `node -e/-p`,或**引号里的那个串就是被执行的命令/首个位置参数** ⇒ 照算执行。
    //   CEILING(残余,照实写):①`git -c <别名/pager>=…` 能借 git 执行命令,本条把 git 段整体判惰性
    //     ⇒ 该形漏放(属蓄意形态,按代价口径不计,已在头注留痕);②`git bisect run` / `--exec` / `-x`
    //     已排除在惰性之外;③`git add ./somedir` 这类整目录参数不在本条辖区(那是 K0 的事)。
    //   ── 批 253d(第三轮红队)两处 ────────────────────────────────────────────
    //   · BP-3(漏放):`cross-env DRY=0 node "…/write-node.mjs" --apply`、`pnpm exec node "…"`、
    //     `node --env-file .env "…"` 被判惰性——包装头不在 EXEC_HEAD、取值旗标的值被当首个位置参数。
    //     修:不再追着包装头/旗标表补洞,改收窄「只在引号里 ⇒ 惰性」本身——**某个引号串整串就是
    //     以脚本名结尾的路径**(`QUOTED_PATH`)⇒ 一律算执行,不看段头。只有脚本名夹在引号串里的
    //     其它词中间(提交信息、`--cond "write-node.mjs 预览通过"`)才惰性。
    //     注意顺序:整串路径只是撤掉「引号惰性」这一条;其后的 git 参数路径 / `node --check`
    //     两条惰性照旧(`git add "scripts/write-node.mjs"` 仍放行)。
    //   · BP-2(漏放):`node --input-type=module <<'EOF'\nimport … from "file:///…/prod-lib.mjs";…` 的
    //     heredoc 正文按行切段,段头 import 不在执行表 ⇒ 惰性。整串路径规则已兜住这一形;另补:
    //     **解释器/壳吃进的 heredoc 正文**(属主段头为 NODEISH/EXEC_HEAD/python 等)里的段,不享受
    //     「只在引号里」的惰性(`const r = execSync("node scripts/write-node.mjs --apply p")`)。
    //     收窄理由(代价口径:误拦与漏放同价):`cat >> docs/x.md <<'EOF'` 这类**数据** heredoc 的正文
    //     不被执行,照旧享受惰性——否则登记债务时写一句「"write-node.mjs 预览通过"」就被拦。
    //   CEILING(残余,照实写):①`QUOTED_PATH` 里的脚本名表是 `CONTENT_WRITE_RE` 的手抄同步件(改那边须改这边);
    //     ②`echo "scripts/write-node.mjs"` 这类只打印整串路径的形态会误拦(罕见,走 fp);
    //     ③heredoc 正文未加引号地提到脚本名本来就算执行(与本批前一致),数据 heredoc 的该形误拦不在本批。
    //   ── 批 253e(第四轮红队)BP-4(误拦,阻断)────────────────────────────────
    //   253d 的「整串路径 ⇒ 一律算执行,不看段头」过头:`ls -la "scripts/write-node.mjs"`、
    //   `diff "scripts/write-node.mjs" "clipboard/205/write-node.mjs"`、`pnpm exec eslint "scripts/write-node.mjs"`、
    //   `node scripts/gate-migrate-check.mjs --file "scripts/prod-lib.mjs"` 全被阻断。
    //   修:整串路径**只在执行位**才撤引号惰性(`execPosTok`)——剥 `X=1` 与包装头(cross-env / npx / sudo / env /
    //   `pnpm|npm|yarn exec|x|dlx`)后,段头是 node 类且该 token 是跳过旗标(`--env-file`/`-r`/`--require`/
    //   `--import`/`--loader` 各吃一个值)后的**首个位置参数**;或段头是 bash/sh/pwsh 类且它是首个位置参数。
    //   其它段头不撤。253d BP-3 三条 pos(cross-env / pnpm exec node / node --env-file)仍命中。
    //   CEILING(残余,照实写):①`EXEC_HEAD` 里的 npx/env/sudo 仍是「整段算执行」(253b 口径,本批不碰)
    //     ⇒ `npx eslint "scripts/write-node.mjs"` 仍误拦,走 fp;②包装头带取值旗标(`sudo -u x node "…"`)时
    //     剥不到 node ⇒ 但 sudo 在 EXEC_HEAD 里照算执行,方向安全;③取值旗标表外的 node 旗标
    //     (`--experimental-loader x`)的值会被当首个位置参数 ⇒ 漏放向,诚实调用形罕见;
    //   ④`node x.mjs --file "scripts/prod-lib.mjs"` 若 x.mjs 真的去 import 该路径,本条看不见(与 BP-5 不同:
    //     那形是 heredoc 正文,由 execHeredocBodies 兜住并登记 D136)。
    //   ── 批 253f(第五轮红队)BP-1(漏放,阻断)──────────────────────────────────
    //   253e 的执行位**白名单**(剥包装头后段头须是 node 类/壳才撤引号惰性)留了缝:
    //   `npm exec -- node`、`pnpm exec -- node`、`pnpm tsx`、`yarn node`、`bun run`、`deno run -A`、
    //   `pnpm --silent exec node`、`dotenv -- node`、`nodemon` 九形包 `"scripts/write-node.mjs"` 全部放行
    //   (253d 时拦)。包装头与运行器永远列不全,白名单方向注定漏。
    //   修:方向反过来——段里有引号整串脚本路径时,**只有**剥 `X=1` 与已知包装头(`WRAP_HEAD`/`WRAP_SUBCMD`
    //   + exec|x|dlx,其后旗标与 `--` 一并跳过)后的段头落在**非执行段头表**里才惰性(`inertHead`):
    //   读类(即 `readHead`,不另抄)∪ `INERT_HEAD_EXTRA`(type/ls/dir/stat/file/diff/cmp/fc/eslint/prettier/
    //   tsc/biome/git/code/notepad);git 另须 `gitMayExec` 不成立(与 inertSeg 同一判据);
    //   或段头是 node/bun/deno/tsx 且执行位(跳过取值旗标与 run/watch 子命令)上是**别的**脚本
    //   (带脚本扩展名、非内容写脚本;`-e/-p/--input-type` 或取值旗标的值本身是内容写脚本 ⇒ 执行)。
    //   其余一律按执行,判不出也按执行。段掩码后含 `(`/`{`/反引号 ⇒ 不惰性(`cat <(node "…")`,ca7b33b 同形)。
    //   两张段头表(253e 的执行位白名单 NODEISH∪SHELL_HEAD 与本批的非执行表)合成一张:只剩非执行表。
    //   CEILING(残余,照实写;两个方向同价):
    //   ①表外的非执行头(`echo`/`printf`/`Test-Path`/`code-insiders`/带路径的 `/usr/bin/ls`…)包引号整串路径 ⇒ 误拦,走 fp;
    //   ②node 取值旗标表外的旗标(`tsx --tsconfig x.ts "…"` 这类值恰带脚本扩展名)⇒ 值被当成「别的脚本」⇒ 漏放,诚实形罕见;
    //   ③执行位是别的脚本、但那个脚本自己去跑引号里的内容写脚本(`node runner.mjs "scripts/write-node.mjs"`)⇒ 漏放,
    //     与 253e CEILING ④ 同族(本条只看段头,不看被跑脚本的内部);
    //   ④包装头带取值旗标(`sudo -u me cat "…"`)剥不到读类头 ⇒ 按执行,误拦向,罕见。
    //   ── 批 253g(第六份红队,只剩阻断误拦)三处 ─────────────────────────────────
    //   ①数据 heredoc 正文是数据:属主(标记行 `<<` 前最后一段,剥 `X=1`/包装头)落在**数据属主表**
    //     (读类 ∪ 非执行表 ∪ tee/Set-Content/Add-Content/Out-File;git 另须 `gitMayExec` 不成立)时,
    //     `stripDataHeredocs` 把正文与结束行整段剥掉,W 不对其切段判段头(`git commit -F - <<'EOF'`、
    //     `cat >> docs/x.md <<'EOF'`、`tee` 里的散文行)。表外属主(壳/解释器/判不出)正文照 253d/253f 判。
    //     三道收窄,各有证人:标记行尾巴经管道喂给非 pipeHead 段(`cat <<EOF | bash`)⇒ 非数据;
    //     属主或尾巴里有带脚本扩展名的目标(`cat > run.sh <<EOF` 随后 `bash run.sh`)⇒ 非数据;
    //     定界符不带引号且正文含 `$(`/反引号(正文会展开执行)⇒ 非数据;未闭合 ⇒ 不剥。
    //   ②分组与命令替换:`SUBSHELL` 收窄为进程替换 `<(`/`>(`、`{`、反引号(照旧撤惰性);
    //     `( … )` 与 `$( … )` 由 `unwrapGroups` 取**内层**逐段再判一次 `inertHead`,内层全是非执行头
    //     才换成占位符,外层再判(外层只剩赋值/占位符 ⇒ 惰性)。
    //   ③段头补全:`leadToks` 另剥 PowerShell `$var =` 赋值与 `do/then/else/if/while/until` 控制词;
    //     `for x in …` 段本身惰性(只是列表);非执行表补 Get-Item/Get-ChildItem/Test-Path/Copy-Item/
    //     Move-Item/cp/mv/echo/printf/Write-Output/Write-Host;`pnpm|npm|yarn` 后跟 eslint/prettier/tsc/biome
    //     按该段头判;`npm|pnpm|yarn run <脚本名>`(脚本名无路径分隔、无脚本扩展名、不带引号)惰性。
    //     `pnpm tsx`、`pnpm exec node`、`npm exec -- node`、`bun run "…"` 不受影响(仍命中)。
    //   CEILING(残余,照实写):①数据属主表外的属主(`python - <<EOF` 之外的罕见数据消费者,如 `wc <<EOF`
    //     不在读类表)正文照旧切段 ⇒ 误拦,走 fp;②`npm run <脚本>` 的 package.json 脚本本身若去跑引号里的
    //     内容写脚本 ⇒ 漏放(与 253f CEILING ③ 同族,只看段头);③不带引号的脚本路径(`cp scripts/write-node.mjs x`、
    //     `(Get-Content scripts/write-node.mjs).Count`)走 `isReadSeg` 读类表,本批不动 ⇒ 仍误拦,走 fp;
    //     ④PowerShell 方法调用括号(`.Replace("a","b")`)内层判不出段头 ⇒ 按执行,误拦向;
    //     ⑤数据 heredoc 写进无扩展名文件再由壳执行(`cat > runme <<EOF` 后 `bash runme`)⇒ 漏放,罕见。
    QUOTED_PATH: /^[^\s"']*(?:write-node|prod-lib|bulk[-_]?create[\w-]*|deploy-prod)\.(?:mjs|cjs|js|ts|ps1)$/i,
    HEREDOC_EXEC_HEAD: /^(?:python\d*(?:\.\d+)?|py|perl|ruby|php|osascript)$/i,
    /** 引号串内容列表(与 `tok` 同一套引号/转义口径)。 */
    quotedSpans(seg) {
      const s = String(seg || ""); const out = []; let quote = null, cur = "";
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "\\" && quote !== "'" && i + 1 < s.length) { if (quote) cur += s[i + 1]; i++; continue; }
        if (quote) { if (c === quote) { out.push(cur); cur = ""; quote = null; } else cur += c; continue; }
        if (c === '"' || c === "'") { quote = c; cur = ""; }
      }
      return out;
    },
    /** 被解释器/壳吃进去的 heredoc 正文(`<<'X'`/`<<X`/`<<-X` 到独立一行 X)。数据 heredoc(cat/tee…)不收。 */
    execHeredocBodies(cmd) {
      const raw = String(cmd || ""); const masked = stripQuoted(raw); const bodies = [];
      const RE = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/g;
      let m;
      while ((m = RE.exec(raw))) {
        if (masked[m.index] !== "<" || raw[m.index + 2] === "<") continue;   // 在引号里 / here-string `<<<`
        const lineStart = raw.lastIndexOf("\n", m.index) + 1;
        const nl = raw.indexOf("\n", m.index);
        if (nl < 0) break;
        const ownerLine = raw.slice(lineStart, m.index);
        const ownerSegs = segments(ownerLine);
        const owner = ownerSegs.length ? ownerSegs[ownerSegs.length - 1] : "";
        const h = String(this.segHead(owner)).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
        const lines = raw.slice(nl + 1).split("\n");
        const endIdx = lines.findIndex((l) => l.replace(/\r$/, "").replace(/^\t+/, "") === m[2]);
        const body = (endIdx < 0 ? lines : lines.slice(0, endIdx)).join("\n");
        if (this.NODEISH.test(h) || this.EXEC_HEAD.test(h) || this.HEREDOC_EXEC_HEAD.test(h)) bodies.push(body);
        if (endIdx < 0) break;
        RE.lastIndex = nl + 1 + (endIdx > 0 ? body.length + 1 : 0) + lines[endIdx].length;   // 跳过正文与结束行
      }
      return bodies;
    },
    readHead: /^(?:cat|grep|egrep|fgrep|rg|sed|head|tail|less|more|wc|get-content|select-string)$/i,
    pipeHead: /^(?:cat|grep|egrep|fgrep|rg|sed|head|tail|less|more|wc|sort|uniq|nl|cut|get-content|select-string|select-object|measure-object)$/i,
    /** 后台 `&`:单个 `&`,且不是 `&&`、不是 `2>&1`/`&>` 这类重定向。 */
    BG_AMP: /(?<![&<>])&(?![&>])/,
    /** 会把引号里的内容当命令执行的段头(取 basename、去 .exe)。 */
    EXEC_HEAD: /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|command|eval|exec|source|ssh|wsl|env|nohup|time|timeout|watch|xargs|iex|invoke-expression|start-process|sudo|su|npx)$/i,
    NODEISH: /^(?:node|bun|deno|tsx|ts-node)$/i,
    segHead(seg) {
      return stripQuoted(seg).trim().split(/\s+/).find((t) => t && !/^\w+=/.test(t)) || "";
    },
    /** 极简 shell 分词:认引号与反斜杠,返回 `{t, q}`(q=该 token 有引号成分)。
     *  要的是「这个 token 是不是**被引号包着的值**」——判「只在引号里出现」必须逐 token 看,
     *  拿 `stripQuoted` 的掩码串反推会把 `node "scripts/write-node.mjs"` 也抹成「只在引号里」。 */
    tok(seg) {
      const s = String(seg || "");
      const out = []; let cur = "", has = false, q = false, quote = null;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "\\" && quote !== "'" && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
        if (quote) { if (c === quote) quote = null; else cur += c; has = true; continue; }
        if (c === '"' || c === "'") { quote = c; q = true; has = true; continue; }
        if (/\s/.test(c)) { if (has) out.push({ t: cur, q }); cur = ""; has = false; q = false; continue; }
        cur += c; has = true;
      }
      if (has) out.push({ t: cur, q });
      return out;
    },
    /** 脚本名**只**出现在引号里(掩掉引号后就不见了)。 */
    quotedOnly(seg) {
      return CONTENT_WRITE_RE.test(String(seg)) && !CONTENT_WRITE_RE.test(stripQuoted(seg));
    },
    /** 引号里的东西会被执行吗?段头是壳/解释器,或引号串本身就在执行位。 */
    // ── 253f BP-1:方向反过来——**非执行段头表**(唯一一张)。段里有引号整串脚本路径时,
    //   只有剥 `X=1` 与已知包装头后的段头落在这张表里(或 node 类段头但执行位是别的脚本)才惰性;
    //   其余一律按执行,判不出也按执行。读类成员**就是** `readHead`(不另抄一份),本表只补读类以外的非执行头。
    INERT_HEAD_EXTRA: /^(?:type|ls|dir|stat|file|diff|cmp|fc|eslint|prettier|tsc|biome|git|code|notepad|get-item|get-childitem|test-path|copy-item|move-item|cp|mv|echo|printf|write-output|write-host)$/i,
    WRAP_HEAD: /^(?:cross-env|npx|sudo|env|dotenv)$/i,
    WRAP_SUBCMD: /^(?:pnpm|npm|yarn|bun)$/i,
    // ── 253g ③:包管理器直跑 lint 类(`pnpm eslint "…"`)按 lint 头判;`run <脚本名>` 跑的是 package.json 脚本
    LINT_HEAD: /^(?:eslint|prettier|tsc|biome)$/i,
    LINT_PM: /^(?:pnpm|npm|yarn)$/i,
    RUN_PM: /^(?:pnpm|npm|yarn)$/i,
    RUN_NAME: /^[\w:.@-]+$/,
    /** PowerShell 赋值 `$var =` / `$var=` 前缀。 */
    PS_ASSIGN: /^\$[\w:.]+=?$/,
    /** 控制结构关键词(剥掉后露出真段头)。 */
    CTRL_KW: /^(?:do|then|else|elif|if|while|until)$/,
    FOR_HEAD: /^for$/,
    // ── 253g ①:数据 heredoc
    DATA_OWNER_EXTRA: /^(?:tee|set-content|add-content|out-file)$/i,
    SCRIPT_TARGET: /\.(?:sh|bash|zsh|ps1|psm1|cmd|bat|mjs|cjs|js|ts|mts|cts|py|rb|pl|php)$/i,
    HEREDOC_EXPANDS: /\$\(|`/,
    /** 属主段头是数据消费者(读类 ∪ 非执行表 ∪ tee 类;git 须不借子命令执行)。 */
    ownerDataHead(owner) {
      const toks = this.leadToks(owner);
      if (!toks.length) return false;
      const h = String(toks[0].t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
      if (/^git$/i.test(h)) return !this.gitMayExec(owner);
      return this.readHead.test(h) || this.INERT_HEAD_EXTRA.test(h) || this.DATA_OWNER_EXTRA.test(h);
    },
    /** 标记行尾巴经单管道喂给的段头有不在 pipeHead/tee 类里的 ⇒ true(`cat <<EOF | bash`)。 */
    pipedToExec(tail) {
      const pieces = stripQuoted(String(tail || "")).split(/(?<!\|)\|(?!\|)/).slice(1);
      return pieces.some((p) => {
        const h = String(this.segHead(segments(p)[0] || "")).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
        return !(this.pipeHead.test(h) || this.DATA_OWNER_EXTRA.test(h));
      });
    },
    /** 数据 heredoc 正文与结束行整段剥掉(见头注 253g ①)。 */
    stripDataHeredocs(cmd) {
      let out = String(cmd || ""); let from = 0;
      for (let guard = 0; guard < 64; guard++) {
        const masked = stripQuoted(out);
        const RE = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/g; RE.lastIndex = from;
        const m = RE.exec(out);
        if (!m) break;
        from = m.index + m[0].length;
        if (masked[m.index] !== "<" || out[m.index + 2] === "<" || out[m.index - 1] === "<") continue;
        const lineStart = out.lastIndexOf("\n", m.index) + 1;
        const nl = out.indexOf("\n", m.index);
        if (nl < 0) break;
        const ownerSegs = segments(out.slice(lineStart, m.index));
        const owner = ownerSegs.length ? ownerSegs[ownerSegs.length - 1] : "";
        const tail = out.slice(m.index + m[0].length, nl);
        const lines = out.slice(nl + 1).split("\n");
        const endIdx = lines.findIndex((l) => l.replace(/\r$/, "").replace(/^\t+/, "") === m[2]);
        if (endIdx < 0) continue;                                             // 未闭合 ⇒ 不剥
        const body = lines.slice(0, endIdx).join("\n");
        if (!m[1] && this.HEREDOC_EXPANDS.test(body)) continue;               // 正文会展开执行
        if (!this.ownerDataHead(owner) || this.pipedToExec(tail)) continue;
        if (this.tok(owner + " " + tail).some((x) => this.SCRIPT_TARGET.test(x.t.replace(/^[\d&]*>+/, "")))) continue;
        const cut = nl + 1 + (endIdx > 0 ? body.length + 1 : 0) + lines[endIdx].length;
        out = out.slice(0, nl) + out.slice(cut);
        from = nl;
      }
      return out;
    },
    /** 253g ②:`( … )`/`$( … )` 内层逐段判非执行头;全惰性 ⇒ 换占位符返回外层,否则 null。进程替换 `<(`/`>(` 不在此收。 */
    groupInert(inner) {
      return segments(inner).every((s) => this.inertHead(s));
    },
    unwrapGroups(seg) {
      const raw = String(seg || ""); const masked = stripQuoted(raw);
      let out = "", at = 0, n = 0;
      for (let i = 0; i < masked.length; i++) {
        if (masked[i] === "\\") { i++; continue; }
        if (masked[i] !== "(" || /[<>]/.test(masked[i - 1] || "")) continue;
        let depth = 1, j = i + 1;
        for (; j < masked.length && depth; j++) {
          if (masked[j] === "\\") { j++; continue; }
          if (masked[j] === "(") depth++; else if (masked[j] === ")") depth--;
        }
        const end = depth ? masked.length : j - 1;
        const inner = raw.slice(i + 1, end);
        if (inner.trim() && !this.groupInert(inner)) return null;
        const start = masked[i - 1] === "$" ? i - 1 : i;
        out += raw.slice(at, start) + "__W_GRP__";
        at = depth ? masked.length : j; n++; i = at - 1;
      }
      return { outer: out + raw.slice(at), n };
    },
    NODE_VALUE_FLAG: /^(?:--env-file|-r|--require|--import|--loader|--experimental-loader|-C|--conditions)$/,
    /** node 类段头下的子命令(不是脚本):`bun run` / `deno run` / `tsx watch`。 */
    NODE_SUBCMD: /^(?:run|watch)$/,
    SCRIPT_EXT: /\.(?:mjs|cjs|js|ts|mts|cts|jsx|tsx)$/i,
    /** 掩码后含这些字符 ⇒ 段里另有命令在跑(进程替换/子壳/命令替换),段头不作数。 */
    //   253g ②:`(` 与 `$(` 不再一律撤,交 `unwrapGroups` 取内层再判;进程替换 `<(`/`>(`、`{`、反引号照旧撤。
    SUBSHELL: /[<>]\(|[{`]/,
    /** 取值旗标(`--import`/`-r`…)的值若是内容写脚本 ⇒ 它被加载执行。 */
    VALUE_RUNS: CONTENT_WRITE_RE,
    /** 剥 `X=1` 与包装头(包装头后的旗标与 `--` 一并跳过)后的 token 序列。 */
    leadToks(seg) {
      const base = (t) => String(t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
      let toks = this.tok(seg);
      const dropLead = () => { while (toks.length && (/^\w+=/.test(toks[0].t) || /^-/.test(toks[0].t))) toks = toks.slice(1); };
      // 253g ③:前导 `X=1`、PowerShell `$var =`、控制词(do/then/…)一并剥
      for (let guard = 0; guard < 16 && toks.length; guard++) {
        const x = toks[0];
        if (/^\w+=/.test(x.t)) { toks = toks.slice(1); continue; }
        if (!x.q && this.PS_ASSIGN.test(x.t)) {
          if (/=$/.test(x.t)) { toks = toks.slice(1); continue; }
          if (toks[1] && !toks[1].q && toks[1].t === "=") { toks = toks.slice(2); continue; }
        }
        if (!x.q && this.CTRL_KW.test(x.t)) { toks = toks.slice(1); continue; }
        break;
      }
      for (let guard = 0; guard < 8 && toks.length; guard++) {
        const h = base(toks[0].t);
        if (this.WRAP_HEAD.test(h)) { toks = toks.slice(1); dropLead(); continue; }
        if (this.WRAP_SUBCMD.test(h)) {
          let j = 1; while (toks[j] && /^-/.test(toks[j].t)) j++;
          if (toks[j] && /^(?:exec|x|dlx)$/.test(toks[j].t)) { toks = toks.slice(j + 1); dropLead(); continue; }
          if (toks[j] && !toks[j].q && this.LINT_PM.test(h) && this.LINT_HEAD.test(toks[j].t)) { toks = toks.slice(j); continue; }
        }
        break;
      }
      return toks;
    },
    /** git 段会借子命令/旗标执行别的命令吗(bisect run / --exec / -x …)。 */
    gitMayExec(seg) {
      const masked = stripQuoted(seg);
      return /\b(?:bisect|filter-branch|rebase|submodule)\b/.test(masked) || /(?:^|\s)(?:-x|--exec)(?:[=\s]|$)/.test(masked);
    },
    /** 253f BP-1:段头属于明确的非执行类 ⇒ true;其余(含判不出)⇒ false。 */
    inertHead(seg) {
      if (this.SUBSHELL.test(stripQuoted(seg))) return false;   // `cat <(node "…")`:段头是读类但里面真跑(ca7b33b 同形)
      // 253g ②:`( … )`/`$( … )` 内层逐段再判;有执行类内层 ⇒ 不惰性
      const g = this.unwrapGroups(seg);
      if (!g) return false;
      seg = g.outer;
      const toks = this.leadToks(seg);
      if (!toks.length) return g.n > 0;                          // 只剩赋值 + 分组(`n=$(wc -l < "…")`)
      if (/^__W_GRP__/.test(toks[0].t)) return true;             // 分组打头的表达式(`(Get-Content "…").Count`)
      const h = String(toks[0].t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
      if (this.FOR_HEAD.test(h) && toks[2] && !toks[2].q && toks[2].t === "in") return true;   // `for f in "…" "…"`:只是列表
      if (/^git$/i.test(h)) return !this.gitMayExec(seg);
      if (this.readHead.test(h) || this.INERT_HEAD_EXTRA.test(h)) return true;
      // 253g ③:`npm run <脚本名> -- "…"` / `pnpm run <脚本名> "…"` 跑的是 package.json 脚本
      if (this.RUN_PM.test(h)) {
        const rest = toks.slice(1).filter((x) => !/^-/.test(x.t));
        if (rest[0] && !rest[0].q && /^(?:run|run-script)$/.test(rest[0].t) && rest[1] && !rest[1].q &&
            this.RUN_NAME.test(rest[1].t) && !this.SCRIPT_EXT.test(rest[1].t) && !CONTENT_WRITE_RE.test(rest[1].t)) return true;
      }
      if (!this.NODEISH.test(h)) return false;
      // node 类:执行位上是**别的**脚本才惰性
      const rest = toks.slice(1);
      let sub = false;
      for (let i = 0; i < rest.length; i++) {
        const x = rest[i];
        if (/^-/.test(x.t)) {
          if (!x.q && /^(?:-e|--eval|-p|--print|--input-type)(?:=|$)/.test(x.t)) return false;
          if (this.NODE_VALUE_FLAG.test(x.t)) { if (rest[i + 1] && this.VALUE_RUNS.test(rest[i + 1].t)) return false; i++; }
          continue;
        }
        if (!sub && this.NODE_SUBCMD.test(x.t)) { sub = true; continue; }
        return this.SCRIPT_EXT.test(x.t) && !CONTENT_WRITE_RE.test(x.t);
      }
      return false;
    },
    execsQuoted(seg) {
      // 253d BP-3 → 253e BP-4 → 253f BP-1:引号整串路径在场 ⇒ 除非段头明确非执行,一律算执行(见头注 253f 节)
      if (this.quotedSpans(seg).some((q) => this.QUOTED_PATH.test(q))) return !this.inertHead(seg);
      const toks = this.tok(seg).filter((x) => !/^\w+=/.test(x.t));
      if (!toks.length) return true;                      // 认不出 ⇒ 保守算执行
      const base = (t) => String(t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
      const head = toks[0];
      if (head.q && CONTENT_WRITE_RE.test(head.t)) return true;   // `"…/deploy-prod.ps1" -Apply`
      if (/^&$/.test(head.t)) return true;                        // PowerShell 调用运算符
      const h = base(head.t);
      if (this.EXEC_HEAD.test(h)) return true;
      if (this.NODEISH.test(h)) {
        const rest = toks.slice(1);
        if (rest.some((x) => !x.q && /^(?:-e|--eval|-p|--print|--input-type|-r|--require)$/.test(x.t))) return true;
        const first = rest.find((x) => !/^-/.test(x.t));           // 首个位置参数 = 被跑的脚本
        if (first && CONTENT_WRITE_RE.test(first.t)) return true;  // 路径带引号也是执行
      }
      return false;
    },
    /** `node --check <脚本>`:语法检查,不执行。 */
    isNodeCheck(seg) {
      const toks = this.tok(seg).filter((x) => !/^\w+=/.test(x.t));
      if (!toks.length) return false;
      const h = String(toks[0].t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
      if (!this.NODEISH.test(h)) return false;
      const flags = [];
      for (const x of toks.slice(1)) { if (/^-/.test(x.t)) flags.push(x.t); else break; }
      return flags.some((f) => /^(?:--check|-c)$/.test(f)) && !flags.some((f) => /^(?:-e|--eval|-p|--print)$/.test(f));
    },
    /** 惰性段:段里提到脚本名,但这一段不会执行它。 */
    inertSeg(seg) {
      const s = String(seg);
      if (!CONTENT_WRITE_RE.test(s)) return false;          // 没提到 ⇒ 本判定不适用
      if (this.BG_AMP.test(stripQuoted(s))) return false;    // BP-6:后台 `&` 藏着另一条真命令
      if (this.quotedOnly(s) && !this.execsQuoted(s)) return true;   // 文本面提及(commit message / --cond)
      const head = this.segHead(s);
      if (/^git$/i.test(String(head).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "")) &&
          !this.gitMayExec(s)) return true;   // 脚本名只作参数路径
      if (this.isNodeCheck(s)) return true;
      return false;
    },
    isReadSeg(seg) {
      const masked = stripQuoted(seg);
      const head = this.segHead(seg);
      if (this.BG_AMP.test(masked)) return false;   // BP-6:`tail -f x & node write-node --apply`
      if (!this.readHead.test(head)) return false;
      if (/[({`]/.test(masked)) return false;
      if (/^sed$/i.test(head) && /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)/.test(masked)) return false;
      return true;
    },
    cmdWrites(c) {
      if (!CONTENT_WRITE_RE.test(String(c))) return false;
      // 253g ①:数据 heredoc(属主 cat/tee/git commit -F - …)正文不切段判段头
      const s = this.stripDataHeredocs(String(c));
      if (!CONTENT_WRITE_RE.test(s)) return false;
      const segs = segments(s);
      const hitSegs = segs.filter((seg) => CONTENT_WRITE_RE.test(seg));
      if (!hitSegs.length) return true;
      // 253d BP-2:解释器吃进的 heredoc 正文里,「只在引号里」不构成惰性
      const bodies = this.execHeredocBodies(s);
      const inExecBody = (seg) => bodies.some((b) => b.includes(seg));
      //   只撤「引号惰性」这一条:git 参数路径 / node --check 在正文里照旧惰性
      const inertBeyondQuote = (seg) => this.inertSeg.call(Object.assign(Object.create(this), { execsQuoted: () => true }), seg);
      const live = hitSegs.filter((seg) => !this.inertSeg(seg) ||   // BP-12:惰性段不算生产写
        (inExecBody(seg) && this.quotedOnly(seg) && !inertBeyondQuote(seg)));
      if (live.some((seg) => !this.isReadSeg(seg))) return true;
      // 管道守卫同样跳过惰性段——否则 `node batch-goal --cond "write-node.mjs 过了" | tail -1`
      // 会被「段头 node 不在 pipeHead」带着命中(BP-12 的同族误拦)。
      if (/(?<!\|)\|(?!\|)/.test(stripQuoted(s)) &&
          segs.some((seg) => !this.pipeHead.test(this.segHead(seg)) && !this.inertSeg(seg))) return true;
      return false;
    },
    contentWrote(ctx) {
      const cmds = [...(ctx.bashCmds || [])];
      try { const w = ctx.window(); if (w) cmds.push(...(w.bashCmds || [])); } catch { /* 空 */ }
      return cmds.some((c) => this.cmdWrites(c));
    },
    anyExternalReview(ctx) {
      const acts = [...(ctx.actions || [])], skills = [...(ctx.skills || [])];
      try { const w = ctx.window(); if (w) { acts.push(...(w.actions || [])); skills.push(...(w.skills || [])); } } catch { /* 空 */ }
      if (skills.some((sk) => /battle/.test(String(sk)))) return true;
      return acts.some((a) => {
        const n = String(a.name || "");
        if (/codex/i.test(n)) return true;
        if (/^(Bash|PowerShell)$/.test(n) && /codex-run\.mjs/.test(String(a.input?.command || ""))) return true;
        return /^(Agent|Task)$/.test(n) && /^(grill:|_)/.test(String((a.input && a.input.subagent_type) || ""));
      });
    },
    /** 用户豁免入口(D101②,2026-09-06 亲签):用户**自己的消息**(本轮或窗口内)明示免外审。
     *  只认用户话,不认我转述的「用户说过别外审」——转述是措辞面,可被自己写出来。
     *  措辞形态:别/不用/不必/无需/免/不要 + (再)?+ 外审/四眼/battle/codex/审读/审。
     *  剥引文后判(用户引用闸的拦词「须外审」不算)。天花板:只认这一族措辞;没说到的写法照拦,走 fp。 */
    // ⚠️ codex 182 复核(Q2)后收窄:①首版认窗口内的用户话 ⇒ 上一批的「别外审」能盖过本批「必须外审」
    //   (窗口不分批、不认撤销顺序)⇒ 现**只认本轮** `ctx.userText`(条件原文就是「用户本轮原话」);
    //   ②裸 `审` 让「别审太久」「不要审错」「不用审核旧稿」全被免 ⇒ 去掉裸 `审`,免审词只留完整名词,
    //   且其后必须是句读/语气词/行尾(「别外审了」「不需要外审。」),后面还跟别的字(太久/错/旧稿)不算;
    //   ③补「不需要」「免于」「无需进行」三形。
    userExempt(ctx) {
      const t = maskQuoted(String(ctx.userText || ""));
      // 红队 182 BP-4:「不要跳过外审」「不能免审」是**要求外审**——豁免词前面带否定的一律不算(否定-否定)。
      const RE = /(?<!不要|不能|不许|不得|不可|别|避|请勿|勿)(别|不用|不必|不需要|无需|无须|毋须|免于?|不要|不做|跳过)\s*(再|进行)?\s*(外审|外部审查|四眼|battle|codex|审读|复核)\s*(了|吧|啦|的)?\s*(?=[,，。;;!！?？)\)\]\s]|$)/i;
      return RE.test(t);
    },
    /** 充分核(2026-08-22 用户裁定):battle/codex 在场即充分;仅 grill 不充分。 */
    battleOrCodex(ctx) {
      const acts = [...(ctx.actions || [])], skills = [...(ctx.skills || [])];
      try { const w = ctx.window(); if (w) { acts.push(...(w.actions || [])); skills.push(...(w.skills || [])); } } catch { /* 空 */ }
      if (skills.some((sk) => /battle/.test(String(sk)))) return true;
      return acts.some((a) => {
        const n = String(a.name || "");
        if (/codex/i.test(n)) return true;
        return /^(Bash|PowerShell)$/.test(n) && /codex-run\.mjs/.test(String(a.input?.command || ""));
      });
    },
    reviewedOne(ctx, names) {
      const acts = [];
      const grab = (c) => { for (const a of (c?.actions || [])) acts.push(a); };
      grab(ctx);
      try { const w = ctx.window(); if (w) grab(w); } catch { /* 同上 */ }
      return names.some((n) => {
        const stem = n.replace(/\.md$/, "");
        return acts.some((a) => {
          const nm = String(a.name || "");
          // ⚠️ 2026-08-27(D82,出路自证逐正例跑之后逮到):原式只认两种载体——
          //   `Agent` 工具(grill:/_ 开头)与**工具名**含 codex 的(即 MCP `mcp__codex-cli__codex`)。
          //   **薄壳跑 codex(`Bash` 执行 `codex-run.mjs`)不算**,而那正是本仓 `/codex`
          //   唯一的调用方式(skill 原话:薄壳 = `~/.claude/scripts/codex-run.mjs`,
          //   直接 spawn `codex exec`,不经 MCP 桥)。于是:**充分性认它、绑定不认它**
          //   ⇒ 照消息跑 codex、命令里带着交付物名,W 照样拦,且拦词说「未绑定文件名」
          //   ——本会话我反复撞,还据此登记过一条不存在的阻塞(D73 首版)。
          //   法条 `docs/laws/reporting.md:163` 原文:「codex prompt **或** agent prompt 皆可」。
          //   ⇒ 判据与法条不一致,漂的是判据。补 Bash/PowerShell 面的薄壳调用。
          //   **方向自认**:这**会让更多轮次通过**(不是纯收紧),故不走窄例外④,
          //   按「判据与法条不一致的纠正」处理并在报告里明示,用户可随时驳回。
          const viaShell = /^(Bash|PowerShell)$/.test(nm) &&
            /codex-run\.mjs|CODEX_JOB=/.test(String((a.input && a.input.command) || ""));
          const isReviewer = (/^(Agent|Task)$/.test(nm) && /^(grill:|_)/.test(String((a.input && (a.input.subagent_type || a.input.agentType)) || ""))) || /codex/i.test(nm) || viaShell;
          return isReviewer && (JSON.stringify(a.input || {}).includes(n) || JSON.stringify(a.input || {}).includes(stem));
        });
      });
    },
  },
  // 第二参只给 mutations 注入变异版 `_w`(引擎只传 ctx,默认值即真判据)
  detect: (ctx, H = RULE_W._w) => {
    if (!ranClear(ctx)) return [];
    const out = [];
    // 支① 交付物(docs/clipboard 文章):须只读子代理审读且入参绑定文件名
    // D101②(2026-09-06 用户亲签「1 做」):**用户本轮原话**明示免外审 ⇒ 支①放行。
    //   证据取 `ctx.userText`(用户自己的消息,不是我转述的「用户说过」),窗口内的用户话也认;
    //   只免交付物支,不免支②(生产内容写入的外审是 W′ 修正案另签的)。
    const names = H.userExempt(ctx) ? [] : H.deliverablesOf(ctx);
    if (names.length) {
      // 2026-08-22 用户裁定:充分性=battle/codex 在场;绑定=某外审入参提及文件名(codex/grill 皆可作载体)。
      if (!H.battleOrCodex(ctx)) out.push(`本批交付物外审不充分(仅 grill 或全无——须 battle/codex 在场):${names.slice(0, 4).join(", ")}`);
      else if (!H.reviewedOne(ctx, names)) out.push(`本批交付物审读未绑定文件名:${names.slice(0, 4).join(", ")}`);
    }
    // 支② 内容批(W′ 修正案,2026-08-22 亲签):动作面出现生产内容写入 ⇒ 三选一外审
    //   (battle skill / codex / grill 类子代理)。语义=把 ai-note 内建的 battle 步
    //   从「希望跑了」变成「没跑就拦」。CEILING:只证外审被发起,不证意见被采纳。
    if (H.contentWrote(ctx) && !H.battleOrCodex(ctx)) {
      out.push("本批有生产内容写入(write-node/prod 管线),缺 battle/codex 外审(仅 grill 不充分——用户裁定)");
    }
    return out;
  },
  exempts: [],
  message: (hits) =>
    `${hits[0]}\n` +
    `      法条=交付物四眼(用户亲签 A′):**无人可独自发布**。\n` +
    // ⚠️ 2026-08-27(D73)按法条重写。旧文只列子代理一条出路,并写「跨模型/联网两通道
    //   **不在本项**」——法条里那半句指的是**计数归属**(并入 P 的跨批累计,不另计),
    //   旧文把它写成了**通道不可用**。后果不是误拦是**误导**:照消息找出路会得出
    //   「唯一出路是子代理」的错结论——我本人 2026-08-27 就照它登记了一个不存在的阻塞
    //   (会话禁用 Agent 工具 ⇒ 判为无解),而 codex 通道一直开着。
    //   法条原文 `docs/laws/reporting.md:161-163`:「**battle/codex 在场即充分**;
    //   仅 grill 不充分,须补 battle……入参须提及交付物名(**codex prompt 或 agent prompt 皆可**)」。
    `      出路(**法条 reporting.md#交付物四眼**;①② 二选一即充分,③ 只是载体):\n` +
    `${renderEscapes(RULE_W.escapes)}\n` +
    `      **任一通道都须在入参里带上交付物文件名**(codex prompt 或 agent prompt 皆可),回件处置后再收工。\n` +
    `      注:跨模型/联网两通道的**计数**并入 P 的跨批累计、本项不另计——这是计数归属,不是通道不可用。`,
  mutations: [
    // 批 253 三条:把 D130 修法逐块退回,各自的证人在 cases 里
    { name: "生产写判据退回整串子串(读脚本也算写,D130 误拦复活)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, cmdWrites: (c) => CONTENT_WRITE_RE.test(String(c)) }) }) },
    { name: "读类段头去掉 `[({`]` 守卫(复刻 ca7b33b:cat <(node write-node …) 放行)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, isReadSeg(seg) {
        const masked = stripQuoted(seg), head = this.segHead(seg);
        return this.readHead.test(head) && !(/^sed$/i.test(head) && /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)/.test(masked));
      } }) }) },
    { name: "去掉管道守卫(grep 脚本名 | xargs node 放行)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, cmdWrites(c) {
        const s = String(c);
        if (!CONTENT_WRITE_RE.test(s)) return false;
        const hitSegs = segments(s).filter((seg) => CONTENT_WRITE_RE.test(seg));
        return !hitSegs.length || hitSegs.some((seg) => !this.isReadSeg(seg));
      } }) }) },
    // 批 253b 三条:BP-6 / BP-12 的修法各自留退回变异,证人在 cases 里
    { name: "253b BP-6 退回:不看后台 `&`(tail -f x & node write-node --apply 被当读)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, isReadSeg(seg) {
        const masked = stripQuoted(seg), head = this.segHead(seg);
        if (!this.readHead.test(head)) return false;
        if (/[({`]/.test(masked)) return false;
        return !(/^sed$/i.test(head) && /(?:^|\s)(?:-[a-zA-Z]*i|--in-place)/.test(masked));
      } }) }) },
    { name: "253b BP-12 退回:引号里/git 参数里的脚本名也算生产写(阻断式误拦复活)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, inertSeg: () => false }) }) },
    { name: "253b BP-12 过头:只要脚本名在引号里就放行(bash -c / node \"脚本\" 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, execsQuoted: () => false }) }) },
    // 批 253d 两处修法:各自真退回(逐字取修前判据,不回落到现 detect),证人在 cases 里
    { name: "253d BP-3 退回:引号整串路径不算执行(cross-env/pnpm exec/--env-file 包 node \"脚本\" 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, execsQuoted(seg) {
        const toks = this.tok(seg).filter((x) => !/^\w+=/.test(x.t));
        if (!toks.length) return true;
        const base = (t) => String(t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
        const head = toks[0];
        if (head.q && CONTENT_WRITE_RE.test(head.t)) return true;
        if (/^&$/.test(head.t)) return true;
        const h = base(head.t);
        if (this.EXEC_HEAD.test(h)) return true;
        if (this.NODEISH.test(h)) {
          const rest = toks.slice(1);
          if (rest.some((x) => !x.q && /^(?:-e|--eval|-p|--print|--input-type|-r|--require)$/.test(x.t))) return true;
          const first = rest.find((x) => !/^-/.test(x.t));
          if (first && CONTENT_WRITE_RE.test(first.t)) return true;
        }
        return false;
      } }) }) },
    { name: "253d BP-2 退回:解释器 heredoc 正文照享「只在引号里」惰性(node <<EOF 里 execSync(\"node write-node …\") 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, execHeredocBodies: () => [] }) }) },
    { name: "253d BP-2 过头:数据 heredoc(cat >> 文件 <<EOF)正文也不享惰性(登记债务误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, HEREDOC_EXEC_HEAD: /./ }) }) },
    { name: "253d BP-2 过头:解释器 heredoc 正文里 git 参数/提交信息也算执行", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, cmdWrites(c) {
        const s = String(c);
        if (!CONTENT_WRITE_RE.test(s)) return false;
        const segs = segments(s);
        const hitSegs = segs.filter((seg) => CONTENT_WRITE_RE.test(seg));
        if (!hitSegs.length) return true;
        const bodies = this.execHeredocBodies(s);
        const live = hitSegs.filter((seg) => !this.inertSeg(seg) || (bodies.some((b) => b.includes(seg)) && this.quotedOnly(seg)));
        if (live.some((seg) => !this.isReadSeg(seg))) return true;
        return /(?<!\|)\|(?!\|)/.test(stripQuoted(s)) &&
          segs.some((seg) => !this.pipeHead.test(this.segHead(seg)) && !this.inertSeg(seg));
      } }) }) },
    // 批 253e BP-4:执行位收窄的真退回(逐字取 253d 判据:整串路径不看段头)与两处过头
    { name: "253e BP-4 退回:引号整串路径不看段头一律算执行(ls/diff/eslint/--file 参数误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, inertHead: () => false }) }) },
    // 批 253f BP-1:方向反转的真退回(逐字取 253e 执行位白名单判据)与各处过头
    { name: "253f BP-1 退回:执行位白名单(npm exec -- / pnpm tsx / yarn node / bun run / deno run / dotenv / nodemon 包 \"脚本\" 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, execsQuoted(seg) {
        const base = (t) => String(t).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
        const execPosTok = () => {
          let toks = this.tok(seg);
          const dropAssign = () => { while (toks.length && /^\w+=/.test(toks[0].t)) toks = toks.slice(1); };
          dropAssign();
          for (let guard = 0; guard < 8 && toks.length; guard++) {
            const h = base(toks[0].t);
            if (/^(?:cross-env|npx|sudo|env)$/i.test(h)) { toks = toks.slice(1); dropAssign(); continue; }
            if (/^(?:pnpm|npm|yarn)$/i.test(h) && toks[1] && /^(?:exec|x|dlx)$/.test(toks[1].t)) { toks = toks.slice(2); dropAssign(); continue; }
            break;
          }
          if (!toks.length) return null;
          const h = base(toks[0].t);
          const nodeish = this.NODEISH.test(h);
          if (!nodeish && !/^(?:bash|sh|zsh|dash|ksh|pwsh|powershell)$/i.test(h)) return null;
          const rest = toks.slice(1);
          for (let i = 0; i < rest.length; i++) {
            const x = rest[i];
            if (/^-/.test(x.t)) { if (nodeish && /^(?:--env-file|-r|--require|--import|--loader)$/.test(x.t)) i++; continue; }
            return x;
          }
          return null;
        };
        { const x = execPosTok(); if (x && x.q && this.QUOTED_PATH.test(x.t)) return true; }
        return RULE_W._w.execsQuoted.call(Object.assign(Object.create(this), { QUOTED_PATH: /(?!)/ }), seg);
      } }) }) },
    { name: "253f BP-1 过头:node 类段头不认执行位上的别的脚本(node gate-migrate-check --file \"…\" 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, NODEISH: /(?!)/ }) }) },
    { name: "253f BP-1 过头:不剥包装头(pnpm exec eslint / npx eslint \"脚本\" 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, WRAP_HEAD: /(?!)/, WRAP_SUBCMD: /(?!)/ }) }) },
    { name: "253f BP-1 过头:不跳取值旗标(node --env-file .env 别的脚本 --file \"…\" 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, NODE_VALUE_FLAG: /(?!)/ }) }) },
    { name: "253f BP-1 过头:不认 bun/deno 的 run 子命令(bun run 别的脚本 --file \"…\" 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, NODE_SUBCMD: /(?!)/ }) }) },
    { name: "253f BP-1 松:执行位上任意位置参数都算「别的脚本」(tsx --tsconfig tsconfig.json \"脚本\" 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, SCRIPT_EXT: /./ }) }) },
    { name: "253f BP-1 松:取值旗标的值是内容写脚本也跳过(node --import \"…prod-lib.mjs\" 别的脚本 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, VALUE_RUNS: /(?!)/ }) }) },
    { name: "253f BP-1 松:非执行段头不看 `(`/`{`/反引号(cat <(node \"脚本\") 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, SUBSHELL: /(?!)/ }) }) },
    { name: "253f BP-1 松:git 段头不看 bisect/--exec(git bisect run node \"脚本\" 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, gitMayExec: () => false }) }) },
    // 批 253g 三处:真退回(逐字取 253f 判据)与各道收窄的过头,证人在 cases 里
    { name: "253g ① 退回:数据 heredoc 正文照切段判段头(git commit -F - / cat >> / tee 散文行误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, stripDataHeredocs: (c) => String(c) }) }) },
    { name: "253g ① 过头:不看属主,任何 heredoc 正文都当数据剥(bash <<EOF 里 node \"脚本\" 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, ownerDataHead: () => true }) }) },
    { name: "253g ① 过头:不看尾巴管道(cat <<EOF | bash 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, pipedToExec: () => false }) }) },
    { name: "253g ① 过头:不看脚本扩展名目标(cat > run.sh <<EOF 再 bash run.sh 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, SCRIPT_TARGET: /(?!)/ }) }) },
    { name: "253g ① 过头:不看无引号定界符的展开(cat >> x.md <<EOF 里 $(node \"脚本\") 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, HEREDOC_EXPANDS: /(?!)/ }) }) },
    { name: "253g ② 退回:`(`/`$(` 一律撤惰性((Get-Content \"…\").Count / n=$(wc -l < \"…\") 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, SUBSHELL: /[({`]/ }) }) },
    { name: "253g ② 过头:不判分组内层($n = (node \"脚本\") / x=$(node \"脚本\") 漏放)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, groupInert: () => true }) }) },
    { name: "253g ③ 退回:不剥 PowerShell `$var =` 赋值($x = Test-Path \"…\" 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, PS_ASSIGN: /(?!)/ }) }) },
    { name: "253g ③ 退回:不剥循环外壳(for f in \"…\"; do wc -l … 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, CTRL_KW: /(?!)/, FOR_HEAD: /(?!)/ }) }) },
    { name: "253g ③ 退回:非执行表不含 Get-Item/cp/mv/echo/Write-Host 等(误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, INERT_HEAD_EXTRA: /^(?:type|ls|dir|stat|file|diff|cmp|fc|eslint|prettier|tsc|biome|git|code|notepad)$/i }) }) },
    { name: "253g ③ 退回:pnpm/npm/yarn 后跟 eslint 等不按 lint 头判(pnpm eslint \"…\" 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, LINT_HEAD: /(?!)/ }) }) },
    { name: "253g ③ 退回:npm run <脚本名> -- \"…\" 按执行(误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, RUN_PM: /(?!)/ }) }) },
    { name: "253d BP-3 过头:引号整串路径压过 git 参数惰性(git add \"scripts/write-node.mjs\" 误拦)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, inertSeg(seg) {
        if (this.quotedSpans(seg).some((q) => this.QUOTED_PATH.test(q))) return false;
        return RULE_W._w.inertSeg.call(this, seg);
      } }) }) },
    { name: "按段头判(段头须是脚本名才算写,D130 红队 BP-2:node write-node.mjs 漏判)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_W.detect(ctx, { ...RULE_W._w, cmdWrites(c) {
        return segments(String(c)).some((seg) => CONTENT_WRITE_RE.test(this.segHead(seg)));
      } }) }) },
    { name: "任意 Agent 都算审读(去只读白名单)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_W._w;
      if (!ranClear(ctx)) return [];
      const names = H.deliverablesOf(ctx);
      if (!names.length) return [];
      const acts = [...(ctx.actions || [])];
      try { const w = ctx.window(); if (w) acts.push(...(w.actions || [])); } catch { /* 空 */ }
      const ok = names.some((n) => acts.some((a) => /^(Agent|Task)$/.test(String(a.name || "")) &&
        JSON.stringify(a.input || {}).includes(n.replace(/\.md$/, ""))));
      return ok ? [] : [`本批交付物未经四眼审读:${names.slice(0, 4).join(", ")}`];
    } }) },
    { name: "不要求绑定文件名(空跑 agent 即过)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_W._w;
      if (!ranClear(ctx)) return [];
      const names = H.deliverablesOf(ctx);
      if (!names.length) return [];
      const acts = [...(ctx.actions || [])];
      try { const w = ctx.window(); if (w) acts.push(...(w.actions || [])); } catch { /* 空 */ }
      const ok = acts.some((a) => /^(Agent|Task)$/.test(String(a.name || "")) &&
        /^(grill:|_)/.test(String((a.input && a.input.subagent_type) || "")));
      return ok ? [] : [`本批交付物未经四眼审读:${names.slice(0, 4).join(", ")}`];
    } }) },
    { name: "任意 skill 都算外审(W′ 放宽向)", apply: (r) => ({ ...r, detect: (ctx) => {
      const H = RULE_W._w;
      if (!ranClear(ctx)) return [];
      const out = [];
      const names = H.deliverablesOf(ctx);
      if (names.length && !H.reviewedOne(ctx, names)) out.push(`本批交付物未经四眼审读:${names.slice(0, 4).join(", ")}`);
      const skills = [...(ctx.skills || [])];
      if (H.contentWrote(ctx) && !skills.length && !H.anyExternalReview(ctx)) out.push("内容未外审");
      return out;
    } }) },
    { name: "台账也算交付物(去排除面)", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!ranClear(ctx)) return [];
      const out = new Set();
      for (const p of (ctx.writes || [])) { const s = String(p).replace(/\\/g, "/"); if (/\.md\b/.test(s) && /docs\/|clipboard\//.test(s)) out.add(s.split("/").pop()); }
      const names = [...out];
      if (!names.length) return [];
      if (RULE_W._w.reviewedOne(ctx, names)) return [];
      return [`本批交付物未经四眼审读:${names.slice(0, 4).join(", ")}`];
    } }) },
  ],
  cases: {
    pos: [
      // 有交付物、零审读 ⇒ 拦
      { text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "clipboard/gate-playbook.md" },
      // 通用子代理不算四眼(白名单=只读件) ⇒ 拦
      { text: "审过了。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "clipboard/mapgen/tdd/README.md",
        agent: { type: "general-purpose", prompt: "读一下 clipboard/mapgen/tdd/README.md" } },
      // **仅 grill(哪怕绑定了)⇒ 拦**——用户裁定「仅有 grill 的需加上 battle」的正面证人
      { text: "只派了 grill,收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "clipboard/gate-playbook.md",
        agent: { type: "grill:recon", prompt: "审读 clipboard/gate-playbook.md" } },
      // grill 但入参没绑交付物 ⇒ 拦(空跑刷不过)
      { text: "派了 grill。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "clipboard/gate-playbook.md",
        agent: { type: "grill:testing", prompt: "随便看看仓库" } },
      // W′ 内容支:生产写入 + 零外审 ⇒ 拦
      { text: "注写完,收工。",
        bash: ["node scripts/write-node.mjs --preview payload.json", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // W′ 内容支:mapgen 不算外审(三选一白名单=battle/codex/grill)——变异「任意 skill 都算」在此翻面
      { text: "跑了个 mapgen,收工。", skill: "mapgen",
        bash: ["node scripts/write-node.mjs --preview payload.json", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253(D130)真调用形态钉:读/执行分离后这些**一个都不许漏** ──
      { name: "D130 BP-2:本仓写正文唯一调用形 node write-node --apply 仍命中(变异「按段头判」在此翻面)",
        text: "写完收工。",
        bash: ["node scripts/write-node.mjs --apply clipboard/payload.json", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "D130 BP-3 回归钉(ca7b33b):cat <(node write-node …) 段头是 cat 但真跑 ⇒ 命中",
        text: "收工。",
        bash: ["cat <(node scripts/write-node.mjs --apply p.json)", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "D130:grep 脚本名 | xargs node 真跑 ⇒ 命中(管道守卫证人)",
        text: "收工。",
        bash: ["grep -l apply scripts/write-node.mjs | xargs -I{} node {} --apply p.json", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "D130:pwsh -File 跑部署脚本(段头 pwsh 不是读)⇒ 命中",
        text: "部署完收工。",
        bash: ["pwsh -File scripts/deploy-prod.ps1", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "D130:bash -c 包一层 write-node ⇒ 命中",
        text: "收工。",
        bash: ["bash -c 'node scripts/write-node.mjs --apply p.json'", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "D130:先 grep 读脚本再 && 真跑 ⇒ 命中",
        text: "收工。",
        bash: ["grep -n apply scripts/write-node.mjs && node scripts/write-node.mjs --apply p.json", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "D130:Get-Content 脚本 | iex ⇒ 命中",
        text: "收工。",
        bash: ["Get-Content scripts/deploy-prod.ps1 | iex", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253b(第二轮红队)────────────────────────────────────────────────
      { name: "253b BP-6:后台 `&` 把真跑的那一半藏在读类段头后面 ⇒ 命中",
        text: "收工。",
        bash: ["tail -f logs/x.log & node scripts/write-node.mjs --apply p.json", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253b BP-12 边界:脚本路径带引号仍是执行(本仓真实调用形)⇒ 命中",
        text: "写完收工。",
        bash: ['node --no-warnings "/repo/scripts/write-node.mjs" --apply p.json', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253b BP-12 边界:echo 一串再管道给 bash ⇒ 命中(惰性段不掩护下游壳)",
        text: "收工。",
        bash: ['echo "node scripts/write-node.mjs --apply p.json" | bash', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253d(第三轮红队)────────────────────────────────────────────────
      { name: "253d BP-2 红队原形:node --input-type=module <<'EOF' 里 import prod-lib 再 post ⇒ 命中",
        text: "收工。",
        bash: ["node --input-type=module <<'EOF'\nimport { post } from \"file:////repo/scripts/prod-lib.mjs\";\nawait post(1)\nEOF",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253d BP-2:node <<'EOF' 正文里 execSync(\"node write-node … --apply\")(引号串非整串路径)⇒ 命中",
        text: "收工。",
        bash: ["node --input-type=module <<'EOF'\nimport { execSync } from \"node:child_process\";\nconst r = execSync(\"node scripts/write-node.mjs --apply p.json\");\nEOF",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253d BP-3:cross-env DRY=0 node \"…/write-node.mjs\" --apply ⇒ 命中",
        text: "收工。",
        bash: ['cross-env DRY=0 node "/repo/scripts/write-node.mjs" --apply p.json', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253d BP-3:pnpm exec node \"scripts/write-node.mjs\" --apply ⇒ 命中",
        text: "收工。",
        bash: ['pnpm exec node "scripts/write-node.mjs" --apply p.json', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253d BP-3:node --env-file .env \"scripts/write-node.mjs\" --apply(取值旗标)⇒ 命中",
        text: "收工。",
        bash: ['node --env-file .env "scripts/write-node.mjs" --apply p.json', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253f BP-1(第五轮红队):九形包装/运行器 + 引号整串路径 ⇒ 全部命中 ──
      ...[
        'npm exec -- node "scripts/write-node.mjs" --apply p.json',
        'pnpm exec -- node "scripts/write-node.mjs" --apply p.json',
        'pnpm tsx "scripts/write-node.mjs" --apply p.json',
        'yarn node "scripts/write-node.mjs" --apply p.json',
        'bun run "scripts/write-node.mjs" --apply p.json',
        'deno run -A "scripts/write-node.mjs" --apply p.json',
        'pnpm --silent exec node "scripts/write-node.mjs" --apply p.json',
        'dotenv -- node "scripts/write-node.mjs" --apply p.json',
        'nodemon "scripts/write-node.mjs" --apply p.json',
      ].map((cmd) => ({ name: `253f BP-1 红队九形:${cmd} ⇒ 命中`, text: "收工。",
        bash: [cmd, "node --no-warnings scripts/batch-goal.mjs --clear"] })),
      { name: "253f BP-1:cat <(node \"scripts/write-node.mjs\" …)——段头读类但进程替换里真跑 ⇒ 命中",
        text: "收工。",
        bash: ['cat <(node "scripts/write-node.mjs" --apply p.json)', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253f BP-1:git bisect run node \"scripts/write-node.mjs\"(git 借子命令执行)⇒ 命中",
        text: "收工。",
        bash: ['git bisect run node "scripts/write-node.mjs" --apply p.json', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253f BP-1:node --import \"scripts/prod-lib.mjs\" 别的脚本(取值旗标的值被加载)⇒ 命中",
        text: "收工。",
        bash: ['node --import "scripts/prod-lib.mjs" scripts/post-once.mjs', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253f BP-1:tsx --tsconfig tsconfig.json \"scripts/write-node.mjs\"(表外取值旗标的值不是脚本)⇒ 命中",
        text: "收工。",
        bash: ['tsx --tsconfig tsconfig.json "scripts/write-node.mjs" --apply p.json', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253g:三处放宽的命中边界(各为一条收窄的证人)──
      { name: "253g ①:bash <<'EOF' 壳 heredoc 正文里 node \"…write-node.mjs\" 照判 ⇒ 命中(属主表过头证人)",
        text: "收工。",
        bash: ["bash <<'EOF'\nnode \"scripts/write-node.mjs\" --apply p.json\nEOF", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ①:cat <<'EOF' | bash(尾巴管道喂壳)⇒ 非数据,命中",
        text: "收工。",
        bash: ["cat <<'EOF' | bash\nnode \"scripts/write-node.mjs\" --apply p.json\nEOF", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ①:cat > run.sh <<'EOF' 再 bash run.sh(写的是脚本文件)⇒ 非数据,命中",
        text: "收工。",
        bash: ["cat > run.sh <<'EOF'\nnode \"scripts/write-node.mjs\" --apply p.json\nEOF\nbash run.sh", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ①:定界符不带引号、正文 $(node \"…\") 会展开执行 ⇒ 非数据,命中",
        text: "收工。",
        bash: ["cat >> docs/x.md <<EOF\n$(node \"scripts/write-node.mjs\" --apply p.json)\nEOF", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ②:$n = (node \"…\") / x=$(node \"…\")(内层段头是执行类)⇒ 命中",
        text: "收工。",
        bash: ['$n = (node "scripts/write-node.mjs" --apply p.json)', 'x=$(node "scripts/write-node.mjs" --apply p.json)',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ②:反引号命令替换照旧撤惰性(echo `node \"…\"`)⇒ 命中",
        text: "收工。",
        bash: ['echo `node "scripts/write-node.mjs" --apply p.json`', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ③:for … ; do node \"…\"(剥 do 露出真段头)与 $n = node \"…\"(剥赋值)⇒ 命中",
        text: "收工。",
        bash: ['for f in a b; do node "scripts/write-node.mjs" --apply $f; done', '$n = node "scripts/write-node.mjs" --apply p.json',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
    ],
    neg: [
      // 真审过:grill 绑定文件名 + codex 在场(仅 grill 不充分——用户 2026-08-22 裁定) ⇒ 放行
      { text: "审毕收工。", bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "node --no-warnings scripts/batch-goal.mjs --clear"],
        write: "clipboard/gate-playbook.md",
        agent: { type: "grill:recon", prompt: "审读 clipboard/gate-playbook.md,找漏洞与断链" } },

      // 台账类写入不触发(排除面证人,变异③在此翻面)
      { text: "记账收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "docs/gate-debts.md" },
      // 收尾但无交付物 ⇒ 不触发
      { text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear" },
      // 有交付物但不在收尾 ⇒ 不触发(批中写作自由,义务只挂收尾)
      { text: "继续写。", write: "clipboard/gate-playbook.md" },
      // W′:battle 外审 ⇒ 放行
      { text: "battle 裁完,收工。", skill: "battle",
        bash: ["node scripts/write-node.mjs --preview payload.json", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // W′:codex 外审 ⇒ 放行
      { text: "codex 复核完,收工。",
        bash: ["node scripts/write-node.mjs --preview payload.json",
               "node ~/.claude/scripts/codex-run.mjs --task t.md",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // W′:内容写入但不在收尾 ⇒ 不触发
      { text: "先写着。", bash: "node scripts/write-node.mjs --preview payload.json" },
      // ── 批 253(D130 误拦实撞):读脚本不是执行(变异「退回整串子串」在此翻面) ──
      { name: "D130 实撞:grep/sed -n 读 deploy-prod.ps1 查操作序 ⇒ 不算生产写",
        text: "docs-only 快车道,收工。",
        bash: ["grep -n ff-only scripts/deploy-prod.ps1", "sed -n '1,40p' scripts/deploy-prod.ps1",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "D130:cat 读 write-node 并 | head、Get-Content | Select-Object ⇒ 不算生产写",
        text: "只读了脚本,收工。",
        bash: ["cat scripts/write-node.mjs | head -50", "Get-Content scripts/deploy-prod.ps1 | Select-Object -First 40",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253b BP-12(阻断式误拦):文本面提及 / git 参数路径 / node --check 都不是执行 ──
      { name: "253b BP-12:提交信息与 --cond 文本里提到 write-node.mjs ⇒ 不算生产写",
        text: "改完提交,收工。",
        bash: ['git commit -m "docs: 更新 write-node.mjs 的说明"',
               'node --no-warnings scripts/batch-goal.mjs --arm 253 --cond "write-node.mjs 预览通过"',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253b BP-12:git add/diff 脚本 + node --check 语法检查 ⇒ 不算生产写",
        text: "只是加进索引并查了语法,收工。",
        bash: ["git add scripts/write-node.mjs", "git diff scripts/write-node.mjs",
               "node --check scripts/write-node.mjs", "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253b BP-12:`--cond \"…write-node.mjs…\"` 后接管道 ⇒ 惰性段不被管道守卫带红",
        text: "收工。",
        bash: ['node --no-warnings scripts/batch-goal.mjs --arm 253 --cond "write-node.mjs 预览通过" | tail -1',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253d:两处修法的放行边界 ──
      { name: "253d BP-2 边界:数据 heredoc(cat >> 债务表)正文引号里提到 write-node.mjs ⇒ 不算生产写",
        text: "登记一笔,收工。",
        bash: ["cat >> docs/gate-debts.md <<'EOF'\n- D141 修 \"write-node.mjs 预览通过\" 的判词\nEOF",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // 253g ① 起数据属主表内的 heredoc 正文先被剥掉,上一条不再能区分 253d 的「解释器 heredoc 才撤引号惰性」;
      //   表外、非解释器属主(jq)的正文仍走 253d 判据,本条接任该变异的证人
      { name: "253d BP-2 边界(253g 接任证人):jq <<'EOF' 正文引号里提到 write-node.mjs(属主非解释器、不在数据表)⇒ 不算生产写",
        text: "拼了个 JSON,收工。",
        bash: ["jq . <<'EOF'\n{\"note\": \"write-node.mjs 预览通过\"}\nEOF",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253d BP-2 边界:bash <<'EOF' 正文里 git commit -m \"…write-node.mjs…\" ⇒ git 惰性照旧",
        text: "提交,收工。",
        bash: ["bash <<'EOF'\ngit commit -m \"docs: 更新 write-node.mjs 的说明\"\nEOF",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253d BP-3 边界:git add \"scripts/write-node.mjs\"(引号整串路径但段头 git)⇒ 不算生产写",
        text: "加进索引,收工。",
        bash: ['git add "scripts/write-node.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253e BP-4(阻断式误拦):整串路径不在执行位 ⇒ 惰性 ──
      { name: "253e BP-4:ls -la / diff 两个引号整串路径 ⇒ 不算生产写",
        text: "对了一下两份副本,收工。",
        bash: ['ls -la "scripts/write-node.mjs"', 'diff "scripts/write-node.mjs" "clipboard/205/write-node.mjs"',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253e BP-4:pnpm exec eslint \"scripts/write-node.mjs\"(包装头剥后段头不是 node)⇒ 不算生产写",
        text: "lint 过了,收工。",
        bash: ['pnpm exec eslint "scripts/write-node.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253e BP-4:node 跑别的脚本、整串路径只是 --file 的值 ⇒ 不算生产写",
        text: "迁移核过了,收工。",
        bash: ['node scripts/gate-migrate-check.mjs --file "scripts/prod-lib.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253f BP-1:方向反转后的放行边界(非执行段头表 + node 类执行位是别的脚本)──
      { name: "253f BP-1:npx eslint / npx --yes prettier --check 引号整串路径(剥包装头与其旗标后是非执行头)⇒ 不算生产写",
        text: "lint 过了,收工。",
        bash: ['npx eslint "scripts/write-node.mjs"', 'npx --yes prettier --check "scripts/write-node.mjs"',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253f BP-1:node --env-file .env 别的脚本 --file \"…prod-lib.mjs\"(跳过取值旗标后执行位是别的脚本)⇒ 不算生产写",
        text: "迁移核过了,收工。",
        bash: ['node --env-file .env scripts/gate-migrate-check.mjs --file "scripts/prod-lib.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253f BP-1:bun run 别的脚本 --file \"…prod-lib.mjs\"(run 是子命令不是脚本)⇒ 不算生产写",
        text: "迁移核过了,收工。",
        bash: ['bun run scripts/gate-migrate-check.mjs --file "scripts/prod-lib.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253f BP-1:type / code 引号整串路径(非执行头)⇒ 不算生产写",
        text: "看了一眼,收工。",
        bash: ['type "scripts\\deploy-prod.ps1"', 'code "scripts/write-node.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // ── 批 253g(第六份红队,阻断式误拦)──
      { name: "253g ① 红队 BP:git commit -F - <<'EOF' 正文散文行带引号整串脚本路径 ⇒ 不算生产写",
        text: "提交,收工。",
        bash: ["git commit -F - <<'EOF'\nfix(gate): 批 253f——九形(bun run / nodemon 包 \"scripts/write-node.mjs\")\nEOF",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ① 红队 BP:cat >> docs/gate-debts.md / tee -a 的 heredoc 散文行 ⇒ 不算生产写",
        text: "登记一笔,收工。",
        bash: ["cat >> docs/gate-debts.md <<'EOF'\n- D136 九形(bun run / nodemon 包 \"scripts/write-node.mjs\")\nEOF",
               "tee -a docs/gate-debts.md <<'EOF'\n- 九形(bun run / nodemon 包 \"scripts/write-node.mjs\")\nEOF",
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ② 红队 BP:(Get-Content \"…\").Count / $n = (Get-Content \"…\" -Raw).Length / n=$(wc -l < \"…\") ⇒ 不算生产写",
        text: "数了行数,收工。",
        bash: ['(Get-Content "scripts/write-node.mjs").Count', '$n = (Get-Content "scripts/prod-lib.mjs" -Raw).Length',
               'n=$(wc -l < "scripts/write-node.mjs")', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ③ 附节二:$x = Test-Path \"…\"(PowerShell 赋值前缀)⇒ 不算生产写",
        text: "查了一下在不在,收工。",
        bash: ['$x = Test-Path "scripts/write-node.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ③ 附节二:for f in \"…\" \"…\"; do wc -l \"$f\"; done(循环外壳)⇒ 不算生产写",
        text: "数了行数,收工。",
        bash: ['for f in "scripts/write-node.mjs" "scripts/prod-lib.mjs"; do wc -l "$f"; done', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ③ 附节二:Get-Item/Get-ChildItem/Copy-Item/Move-Item/cp/mv/echo/printf/Write-Output/Write-Host 引号整串路径 ⇒ 不算生产写",
        text: "挪了个副本,收工。",
        bash: ['Get-Item "scripts/write-node.mjs"', 'Get-ChildItem "scripts/write-node.mjs"', 'Copy-Item "scripts/write-node.mjs" clipboard/205/',
               'Move-Item "clipboard/205/write-node.mjs" clipboard/206/', 'cp "scripts/write-node.mjs" clipboard/205/', 'mv "clipboard/205/write-node.mjs" clipboard/206/',
               'echo "scripts/write-node.mjs"', 'printf "%s\\n" "scripts/prod-lib.mjs"', 'Write-Output "scripts/write-node.mjs"', 'Write-Host "scripts/write-node.mjs"',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ③ 附节二:pnpm eslint / npm prettier --check / yarn tsc 引号整串路径(按 lint 头判)⇒ 不算生产写",
        text: "lint 过了,收工。",
        bash: ['pnpm eslint "scripts/write-node.mjs"', 'npm prettier --check "scripts/write-node.mjs"', 'yarn tsc --noEmit "scripts/write-node.mjs"',
               "node --no-warnings scripts/batch-goal.mjs --clear"] },
      { name: "253g ③ 附节二:npm run lint -- \"…\" / pnpm run lint \"…\"(跑 package.json 脚本)⇒ 不算生产写",
        text: "lint 过了,收工。",
        bash: ['npm run lint -- "scripts/write-node.mjs"', 'pnpm run lint "scripts/write-node.mjs"', "node --no-warnings scripts/batch-goal.mjs --clear"] },
      // 窗口里审过(隔轮审、本轮收) ⇒ 放行
      { text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "clipboard/mapgen/tdd/README.md",
        prior: [{ text: "审读轮", bash: "node ~/.claude/scripts/codex-run.mjs --task t.md",
                  agent: { type: "grill:edge-cases", prompt: "审 clipboard/mapgen/tdd/README.md" } }] },
      // D101②(2026-09-06 亲签):**用户本轮原话**免外审 ⇒ 交付物支放行(证据是 userText,不是我的转述)
      { name: "D101②:用户原话免外审 ⇒ 放行",
        user: "这份 README 别外审了,直接关账。",
        text: "按你说的不外审,收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "clipboard/oss/public-repo/README.md" },
    ],
  },
};
// D101② 的两条反向钉(pos):①我**转述**「用户说别外审」但用户话里没有 ⇒ 照拦(措辞面伪造);
//   ②用户话里的「外审」是在**引用闸拦词**(剥引文后不剩豁免形态)⇒ 照拦。
RULE_W.cases.neg.push({
  // codex 182 Q2 给的三句「是免审却不命中」之一,现认
  name: "D101②:「这次不需要外审。」也是免审",
  user: "这次不需要外审。",
  text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
  write: "clipboard/oss/public-repo/README.md",
}, {
  // 红队 a2155edb BP-6(真实语料有连拦链):判官型拦截只留 feedback 行、无拦截附件,连拦两次;
  //   回扫曾把它当「已放行」截断,轮开口的免审丢失 ⇒ 误拦。「被拦」改由 gate-ctx `isBlockedStop`(与 lastTurn 共用)判。
  name: "a2155edb BP-6:feedback 行型拦截连拦两次,轮开口的免审仍认",
  text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
  write: "clipboard/oss/public-repo/README.md",
  prior: [{ user: "这份 README 别外审了,直接关账。", text: "在写", stop: "blocked-fb" }, { text: "补了一处", stop: "blocked-fb" }],
});
RULE_W.cases.pos.push({
  // 红队 a2155edb BP-3:回扫遇到打断行不停,会走到打断之前那一轮的开口、把旧免审带进来 ⇒ 打断行是轮边界
  name: "a2155edb BP-3:打断行之前那一轮的「别外审」不带进打断之后",
  text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
  write: "clipboard/oss/public-repo/README.md",
  prior: [{ user: "这份 README 别外审了,直接关账。", text: "在写" }, { interrupt: true, text: "接着写" }, { text: "补了一处", stop: "blocked" }],
});
RULE_W.cases.pos.push({
  // 红队 182 BP-4:否定-否定形态是**要求外审**
  name: "BP-4:「不要跳过外审」「不能免于复核」是要求外审,不是免审",
  user: "这份 README 不要跳过外审,也不能免于复核。",
  text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
  write: "clipboard/oss/public-repo/README.md",
}, {
  // codex 182 Q2 给的三句「不是免审却命中」,首版全免:限制耗时 / 要求审对 / 改审查对象
  name: "codex-182 Q2:「别审太久」「不要审错」「不用审核旧稿」都不是免审",
  user: "别审太久。不要审错。不用审核旧稿,只审新版。",
  text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
  write: "clipboard/oss/public-repo/README.md",
}, {
  name: "D101② 反向钉:转述用户免审不算(userText 里没有)",
  text: "用户说过别外审,收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
  write: "clipboard/oss/public-repo/README.md",
}, {
  name: "D101② 反向钉:用户引用闸拦词「须外审」不是豁免",
  user: "闸刚才说「本批交付物须外审」,这是什么意思?",
  text: "名词日记:不适用,因这是对闸拦词的追问。收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
  write: "clipboard/oss/public-repo/README.md",
});
// ===== RULE_W END =====

/** V:呈签清单缺「免签例外已核」痕迹(绊线,2026-08-25 批 102)。
 *
 *  立法动机(当日实撞,用户两连击):我把一份「修已登记债、已过跨模型四眼」的设计稿
 *  按亲签面摊给用户,用户先问「显然要签的能不能不要丢给我」;落位判官核出
 *  **宪法窄例外④当时就该适用——规则在,我没核**;我说「记为个人行为纪律」,
 *  用户第二击:「合着规则中的东西都没有被落实过?」——「靠人记得」正是本仓判死的形态。
 *  本条把「摊给用户前核一遍免签例外①–④」挂上必然执行面。
 *
 *  判据(文本面绊线,D47 学说:打中算赚,不承诺覆盖):
 *  本轮文本出现呼签词(需你裁/呈签/请亲签/待你亲签)而全文无「免签例外已核」字样 ⇒ 提示。
 *  天花板:①判不出核得对不对(写一行就过——但那一行把「核过没有」变成可追责的记录,
 *  与 I 的「工具面已扫」同形);②K/S 的 ⏸ 停工语不触发(锚定呼签词,不锚 ⏸)。 */
export const RULE_V = {
  id: "V",
  blocking: false,
  law: "AGENTS.md#决策边界",
  detect: (ctx) => {
    if (!/需你裁|呈签|请亲签|待你亲签|需要你亲签/.test(ctx.text)) return [];
    if (/免签例外已核/.test(ctx.text)) return [];
    if (RULE_V._fourEach(ctx.text)) return [];
    return ["呈签/裁决请求未附「免签例外已核」行"];
  },
  // 批 253(窄例外③,fp 9/56):台账里数笔是**真核过、写的是同义改写**
  //   (「①不适用…②…③…④…」逐条带理由),只因没写那六个字被拦(D113 史)。
  //   现在也认:「例外」字样之后 400 字内 ①②③④ **按序全出现**,且**每段**
  //   都带适用性判词(适用/不沾/不覆盖/不涉及/不及于/排除/撞)并有理由(去标点 ≥5 字)。
  //   刻意不认:「①–④均不适用」(没逐条理由)、无「例外」锚的 ①②③④ 事项清单(那是待签清单本身)。
  // 批 253b(第二轮红队,窄例外③):
  //   · BP-5 漏放:待签清单「①发布授权——适用亲签 ②…排除 ③…不涉及 ④…撞不可逆」、复述宪法四条窄例外、
  //     codex-V「①不适用于此项×4」都能过旧判据 ⇒ 现在**每段须判词 + 该条窄例外的特征词**
  //     (①纠错/指向性/路径/指针 ②入册/复议/章程/免签条件 ③过重/闸/判官 ④可逆/机械),
  //     且**至少一段**去掉判词、特征词、标点后仍 ≥4 字(有针对本事项的理由)。
  //     每段 ≥5 字的旧要求撤掉:「①否,纠错」这类短答由「至少一段有理由」兜。
  //   · BP-11 误拦:判词加「否/不属/不是」;④ 段延伸到下一个空行或文末(理由换行写);锚加「免签核过/免签已核」。
  //   · 第二份 BP-8:「任意两段相同即拒」改为**四段全同**才拒(照裁定放宽)。**没删**:
  //     四段各写「不适用(不涉及纠错、入册、过重、可逆)」这类**一段含全部特征词的套话**,
  //     在只有特征词要求时能全过 ⇒ 这一条仍有独立拦截面(pos 夹具「四段全同的套话」钉住)。
  //   残余:①判不出理由写得对不对(「④撞不可逆」与真核过同形);②复述宪法窄例外原文(①…纠错…②…入册…)
  //     若每段恰带判词(如「不适用于 AGENTS.md」)仍会过——蓄意形态不计。
  // 批 253c(codex 跨模型复核,窄例外③):
  //   · V-1 漏放:253b 把 ④ 段延伸到「下一个空行或文末」⇒ ④ 后紧跟的**任意后续正文**被吃进 ④ 段,
  //     正文里随便一个「可逆/机械」就补齐了 ④ 的特征词(codex 夹具「④否。\n后续方案是可逆机械调整…」)。
  //     现在 ④ 段 = **自身行 + 真续行**:缩进行 / 以「理由|因为|原因|依据」开头的行 /
  //     上一行以悬挂连接符(: : , , 、 ; ; — –)结尾的行;遇空行或普通新句即止。
  //     悬挂连接符这一支是为保住 BP-11 的诚实写法(`④撞:\n对外发布不可逆…`)——
  //     那一行以冒号结尾,语法上就要求下一行接着读;而 V-1 的 `④否。` 是句号收尾,吃不到下一行。
  //   · V-2 误拦:特征词表只认了宪法原文的字面词,同义改写的逐条核查被拦
  //     (codex 夹具「①…只是文字更正 ②…旧条尚未登记 ③…检查并不沉重 ④…改动能够撤回」)。
  //     四条特征词各加同义面(见 `_FEATURE`);`_FEATURE_OLD` 留作变异证人。
  //   残余:①特征词放宽后,正文里出现「登记/判据/机械」等常用词的段更容易凑齐特征词
  //     ——仍由「至少一段有针对本事项的理由」与「四段全同即拒」兜底;
  //     ②「④ 段续行」判据认的是排版形状,把理由写成不缩进、不带理由词、上行句号收尾的
  //     新起一行仍会被判成「④ 段没理由」(误拦方向,fp 台账见到再收);
  //     ③悬挂连接符这一支的代价:`④否,\n后续方案是可逆机械调整。` 仍放行(实测)——
  //     逗号收尾在语法上就是「下一行接着读」,与 BP-11 的诚实写法同形,分不开;
  //     只留冒号一支能堵上它,但会误拦「④撞,\n对外发布不可逆」这类诚实换行。按等价代价保留宽支。
  // 批 253d(第三份红队 BP-6,漏放):裸「否」命中「是否/与否」里的否 ⇒
  //   `例外逐条:①是否属纠错,待定 ②是否已入册,待查 …` 这种**只列问题、没下判断**的清单被当成逐条核过。
  //   修:「否」前一字是「是/与」时不算判词。残余:「能否/可否」同为疑问形,未收(红队未报,见到再收)。
  _VERDICT: /不适用|适用|不沾|不覆盖|不涉及|不及于|排除|撞|不属|不是|(?<![是与])否/g,
  _VERDICT_253C: /不适用|适用|不沾|不覆盖|不涉及|不及于|排除|撞|不属|不是|否/g,
  // 批 253c V-2:每条各加同义面——①更正/改正/笔误/错别字/指向 ②登记/备案 ③沉重/判据 ④撤回/回滚/改得回。
  _FEATURE: [
    /纠错|指向性|指向|路径|指针|更正|改正|笔误|错别字/g,
    /入册|登记|备案|复议|章程|免签条件/g,
    /过重|沉重|判据|闸|判官/g,
    /可逆|机械|撤回|回滚|改得回/g,
  ],
  _FEATURE_OLD: [/纠错|指向性|路径|指针/g, /入册|复议|章程|免签条件/g, /过重|闸|判官/g, /可逆|机械/g],
  /** ④ 段取法(批 253c V-1)。`opt.fourthOld` = 253b 之前「到句号/换行即止」;
   *  `opt.fourthBlank` = 253b 的「延伸到下一个空行」——两者都留作变异证人。 */
  _fourthSeg: (rest, opt = {}) => {
    if (opt.fourthOld) { const r = rest.search(/[。\n]/); return r < 0 ? rest : rest.slice(0, r); }
    if (opt.fourthBlank) { const r = rest.search(/\n[ \t　]*\n/); return r < 0 ? rest : rest.slice(0, r); }
    const lines = rest.split("\n");
    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) break;
      const prev = out[out.length - 1].replace(/\s+$/, "");
      const cont = /^[ \t　]/.test(ln) || /^[ \t　]*(理由|因为|原因|依据)/.test(ln) || /[:：,，、;；—–]$/.test(prev);
      if (!cont) break;
      out.push(ln);
    }
    return out.join("\n");
  },
  _fourEach: (text, opt = {}) => {
    const t = String(text || "");
    const nums = ["①", "②", "③", "④"];
    const anchor = opt.anchorOld ? /例外/g : /例外|免签核过|免签已核/g;
    const verdictSrc = opt.verdictOld ? /不适用|适用|不沾|不覆盖|不涉及|不及于|排除|撞/g
      : opt.verdictBareFou ? RULE_V._VERDICT_253C : RULE_V._VERDICT;
    const has = (re, s) => new RegExp(re.source).test(s);
    const strip = (s) => s.replace(/[\s、,，;；:：.。()（）「」—\-–!！?？]/g, "");
    for (const m of t.matchAll(anchor)) {
      const w = t.slice(m.index, m.index + 400);
      const idx = [];
      let from = 0;
      for (const n of nums) {
        const k = w.indexOf(n, from);
        if (k < 0) break;
        idx.push(k);
        from = k + 1;
      }
      if (idx.length < 4) continue;
      let ok = true;
      let reasoned = false;
      const bares = [];
      for (let i = 0; i < 4; i++) {
        const feats = opt.featureOld ? RULE_V._FEATURE_OLD : RULE_V._FEATURE;
        const seg = i < 3
          ? w.slice(idx[i] + 1, idx[i + 1])
          : RULE_V._fourthSeg(t.slice(m.index + idx[3] + 1), opt);
        if (!has(verdictSrc, seg)) { ok = false; break; }
        if (!opt.noFeature && !has(feats[i], seg)) { ok = false; break; }
        bares.push(strip(seg));
        const rest = strip(seg.replace(verdictSrc, "").replace(feats[i], ""));
        if (rest.length >= 4) reasoned = true;
      }
      if (ok && !opt.noReason && !reasoned) ok = false;
      // 第二份 BP-8:四段**全同**才拒(原为任意两段相同)。
      if (ok && !opt.noAllSame && bares.length === 4 && new Set(bares).size === 1) ok = false;
      if (ok) return true;
    }
    return false;
  },
  exempts: [],
  // 出路即数据(批 117)。本条只有一条出路,且是**纯文本痕迹**——判据就是找那一行。
  escapes: [
    { say: "核完写一行 ⟪免签例外已核⟫:<各为什么不适用,或:适用④已自签留痕>",
      sample: { text: "免签例外已核:①不适用(不是指向性纠错)、②不适用(未入册)、③不沾(三形态闭集)、④撞 (c) 会放松阻断。" } },
    { say: "或不写那六个字,直接逐条写窄例外 ①②③④ 各自为何不适用(四个编号都要有,各带理由;「①–④均不适用」不算)",
      sample: { text: "窄例外核过:①不适用(不是指向性纠错)②不适用(该条未入册)③不沾(不是判据过重)④撞 (c):对外发布不可逆。" } },
  ],
  message: () =>
    `摊给用户前先核宪法窄例外①–④(纠错自签/复议裁撤/判据过重/可逆机械):能自签的别摊,\n` +
    `      真取舍才上桌。出路:\n${renderEscapes(RULE_V.escapes)}\n` +
    `      立法动机:2026-08-25 把④该接的活摊给了用户,被连问两句逮住——规则在,没人核=没有规则。`,
  mutations: [
    { name: "写了核查行也照报(豁免失效)", apply: (r) => ({ ...r, detect: (ctx) =>
      /需你裁|呈签|请亲签|待你亲签|需要你亲签/.test(ctx.text) ? ["硬报"] : [] }) },
    { name: "去掉呼签前置(任何文本都追讨)", apply: (r) => ({ ...r, detect: (ctx) =>
      /免签例外已核/.test(ctx.text) ? [] : ["无呼签也报"] }) },
    { name: "退回只认字面串(批 253 逐条核形态失效)", apply: (r) => ({ ...r, detect: (ctx) =>
      !/需你裁|呈签|请亲签|待你亲签|需要你亲签/.test(ctx.text) || /免签例外已核/.test(ctx.text)
        ? [] : ["只认字面"] }) },
    { name: "逐条核不查每段理由(只要四个编号出现)", apply: (r) => ({ ...r, detect: (ctx) =>
      !/需你裁|呈签|请亲签|待你亲签|需要你亲签/.test(ctx.text) || /免签例外已核/.test(ctx.text)
        || /例外[\s\S]{0,400}①[\s\S]*②[\s\S]*③[\s\S]*④/.test(ctx.text) ? [] : ["放宽"] }) },
    // 批 253b:以下五条各钉一处本批改动,detect 只换 _fourEach 的一个开关。
    ...[
      ["每段不绑窄例外特征词(BP-5 / codex-V 漏放回来)", { noFeature: true }],
      ["不要求至少一段有针对本事项的理由", { noReason: true }],
      ["判词不认「否/不属/不是」(BP-11 误拦回来)", { verdictOld: true }],
      ["④ 段到句号/换行即止(BP-11 理由换行被拦)", { fourthOld: true }],
      ["锚只认「例外」(BP-11「免签核过:」被拦)", { anchorOld: true }],
      ["四段全同的套话也放行(第二份 BP-8)", { noAllSame: true }],
      // 批 253c:两条各钉本批一处改动。
      ["④ 段延伸到下一个空行(253c V-1 漏放回来)", { fourthBlank: true }],
      ["特征词退回 253b 窄表(253c V-2 误拦回来)", { featureOld: true }],
      // 批 253d:判词退回 253c 的裸「否」表。
      ["判词认裸「否」(253d BP-6「是否」漏放回来)", { verdictBareFou: true }],
    ].map(([name, opt]) => ({ name, apply: (r) => ({ ...r, detect: (ctx) =>
      !/需你裁|呈签|请亲签|待你亲签|需要你亲签/.test(ctx.text) || /免签例外已核/.test(ctx.text)
        || r._fourEach(ctx.text, opt) ? [] : ["变异"] }) })),
  ],
  cases: {
    pos: [
      { text: "两件需你裁:①设计稿呈签 ②发布授权。" },
      // codex 253 合并复核:四段一模一样的套话不算逐条核过。
      { text: "需你裁。窄例外核过:①不适用于此项②不适用于此项③不适用于此项④不适用于此项。" },
      // 批 253 正例:四个编号在但没逐条理由 / 没有「例外」锚的事项清单,照拦
      { text: "需你裁:发布授权。窄例外①②③④均不适用。" },
      { text: "四件需你裁:①设计稿 ②发布授权 ③产品定位 ④版权取舍。" },
      // 批 253b BP-5:待签清单每项恰好带判词(适用/排除/不涉及/撞),但不绑窄例外特征词 ⇒ 照拦。
      { name: "BP-5:待签清单带判词不绑特征词", text: "需你裁,例外情形如下:①发布授权——适用亲签 ②旧稿删除排除在外 ③版权不涉及 ④翻 public 撞不可逆。" },
      // 批 253b:特征词与判词都在,但四段都只是「判词+特征词」,没有一段针对本事项 ⇒ 照拦。
      { name: "每段只有判词+特征词、无理由", text: "需你裁。窄例外:①不适用纠错②不适用入册③不适用过重④不适用可逆。" },
      // 第二份 BP-8:四段写成同一句「什么都不涉及」的套话(每段都含全部特征词) ⇒ 全同即拒。
      { name: "四段全同的套话",
        text: "需你裁。窄例外核过:①不适用(不涉及纠错、入册、过重、可逆)②不适用(不涉及纠错、入册、过重、可逆)③不适用(不涉及纠错、入册、过重、可逆)④不适用(不涉及纠错、入册、过重、可逆)" },
      // 批 253c V-1(codex 夹具):④ 是句号收尾的裸判词,后续正文是新起一句的方案说明,
      //   253b 的「延伸到空行」把它吃进 ④ 段、借正文里的「可逆机械」凑齐特征词 ⇒ 现在照拦。
      { name: "V-1:④ 裸判词 + 吃后续正文凑特征词",
        text: "需你裁。免签核过:①否纠错 ②否入册 ③否过重 ④否。\n后续方案是可逆机械调整,不是本次例外理由。" },
      // 批 253d BP-6(第三份红队):逐条只列「是否…」问题、没下判断 ⇒「是否」里的否不算判词,照拦。
      { name: "253d BP-6:「是否」里的否不是判词",
        text: "需你裁:发布授权。例外逐条:①是否属纠错,待定 ②是否已入册,待查 ③是否闸过重,待查 ④是否可逆,待查。" },
    ],
    neg: [
      // 批 253b BP-11:「否,不是纠错」、④ 理由换到下一行、锚写「免签核过:」
      { name: "BP-11:否/不是 + ④ 理由换行 + 免签核过锚",
        text: "需你裁:发布授权。\n免签核过:①否,不是纠错 ②不属已入册条款 ③不是闸判据过重 ④撞:\n对外发布不可逆,不是机械改动。" },
      { name: "BP-11:锚写「免签已核」", text: "需你裁:发布授权。免签已核:①不适用(不是指向性纠错)②不适用(该条未入册)③不沾(不是判据过重)④撞 (c):对外发布不可逆。" },
      // 批 253 反例:没写那六个字,但窄例外逐条写了为何不适用
      { text: "需你裁:发布授权。窄例外核过:①不适用(不是指向性纠错)②不适用(该条未入册)③不沾(不是判据过重)④撞 (c):对外发布不可逆。" },
      { text: "需你裁:发布授权(真取舍)。免签例外已核:①–④均不适用——对外不可逆面。" },
      // 批 253c V-2(codex 夹具):四段全是同义改写,一个宪法原文字面词都没用 ⇒ 须放行。
      { name: "V-2:四段同义改写的逐条核查",
        text: "需你裁:发布授权。窄例外核过:①不适用,只是文字更正 ②不适用,旧条尚未登记 ③不适用,检查并不沉重 ④不适用,改动能够撤回。" },
      // 批 253c V-1 反向钉:④ 的理由缩进换行写 / 以「理由:」开头,仍算 ④ 段自己的话。
      { name: "V-1 反向钉:④ 理由缩进续行",
        text: "需你裁:发布授权。免签核过:①否,不是纠错 ②不属已入册条款 ③不是闸判据过重 ④不适用。\n  理由:对外发布不可逆,不是机械改动。" },
      { text: "普通汇报:三件全绿,已提交。" },
    ],
  },
};

/** O(提示):外部引文未过取页核实(D55 结清,2026-08-27)。
 *
 *  **不是新立法**:出处属宪法《永久红线》里已亲签的**承重八族**之一
 *  (「承重八族永不免签:**出处** / 不可逆 / …」),而全局规范 §1.2 写着
 *  「汇总方从子代理给出的 URL 里**随机挑 1–2 条自己重新取一遍**」。
 *  法条早就在,缺的是**触发层**——窄例外④明写「把已亲签的法条实现出来,
 *  建它的触发层属执行不属立法」,故本项自签落地。
 *
 *  为什么现在做:当天 D66 就是实证——一条挂在**公开仓**上的断言,出处只到「摘要级」,
 *  真取页逐字核后判**已核实-不成立**。而 `scripts/fetch-quote-check.mjs`(取页适配器)
 *  **早就造好了**,只是没有任何东西会提醒你用它。
 *
 *  判据:本轮正文把某个 http(s) URL **当依据用**(出现「出处/原文/逐字/见 <url>/引自」这类词),
 *  而动作面上**既没跑 fetch-quote-check、也没 WebFetch** ⇒ 提示。
 *  **只看动作面**,不认「我核过了」这类自陈(纯文本豁免是本仓已撤过的病)。
 *
 *  刻意**非阻断**:它的误报面还没量过——转述他人回件里的 URL、引用文档地址而非引文,
 *  都会命中。**先当提示跑,攒够分母再谈升档**(与子代理闸同一条纪律)。
 *  失效条件:①连续 20 批零命中 ⇒ 复议是否还需要它;②fp 台账出现 3 条 ⇒ 收窄判据。 */
export const RULE_O = {
  id: "O",
  blocking: false,
  law: "AGENTS.md#永久红线",
  // ── 批 253 改判据(窄例外③,判据过重自签;D117);批 253b 按红队第二轮回件重修 ─────────
  //   旧判据(b9986f7 之前):本轮**任意一次** WebFetch / 动作面提到 fetch-quote-check ⇒ 全文 URL 全豁免;
  //   Bash `curl` 真取页却不认(fp 台账 08-29、09-16 两笔)。头注「判据」段描述的是旧判据,以本段为准。
  //   现判据:**逐网址配对**——被当依据用的**每个** URL,都要在「本轮 ∪ `ctx.window()` 窗口」的
  //   取页集合里(归一后)出现;差一个就报那一个。
  //   b9986f7 的**抽样口径**(引了几个、取过其中一个即全放行)已于 253b 撤回(用户裁定):
  //   全局规范 §1.1 是**发送端**规则(只认本次真取到的 URL),§1.2 的抽样重取是**汇总方**义务,
  //   不能拿接收端的宽度去放松发送端。依据段一个 URL 都没有 ⇒ 退回全文所有 URL,同样逐网址。
  //   取页通道三条:WebFetch 的 `url`;段头为 node 且**首个位置参数**的 basename 为
  //   `fetch-quote-check.mjs`(BP-9:脚本名在**原串**上认——整条路径住在引号里时,
  //   去引号串上它会整个消失,那是误拦);段头为 curl/wget/Invoke-WebRequest 族的取页命令。
  //   **不算取页**的形态(BP-1:短旗标组**逐字符拆**,不再只认字母在组尾):
  //   ① 组内含 `I`(curl)/ `--head` / `--spider` / `-Method Head` ⇒ 只取响应头;
  //   ② 组内 `o`(curl)/ `O`(wget)/ `--output(-document)=` / `-OutFile` 的**值**是空设备 ⇒ 输出被丢弃;
  //   ③ 重定向 `> /dev/null|NUL|$null`;
  //   ④ 管道**下游**只数字节或只取状态(`wc`、`Select-Object/ForEach-Object <只含状态属性>`、`Out-Null`);
  //   ⑤ 改方法 / 上传 / 提交表单(`-X <非 GET>`、`-T/-F`、`-d/--data-*`)——但 `-G/--get` 把
  //      `-d/--data-urlencode` 拼进**查询串**,那是真取页(红队第二份 BP-7),不排除。
  //   **归一**(BP-10;批 253c O-1 收窄):去 `www.`、片段、userinfo、默认端口、尾斜杠;
  //      **查询串保留**——`?id=1` 与 `?id=2` 是两页,抹掉它等于「取过其一即认全部」(漏放,
  //      承重八族·出处)。只把参数按 key 排序归一,因为 `?a=1&b=2` 与 `?b=2&a=1` 是同一页。
  //   **窗口**(BP-10):取页集合 = 本轮 ∪ `ctx.window()`;窗口取不到(null)⇒ 只用本轮。
  //      `wild`(取页了但读不出网址)**只认本轮**:窗口有 400 条,窗口里一条 `--json` 就会把
  //      此后 400 条里的一切引文全豁免——那是把漏放面拉长,不是消误拦。
  //   **不放松的论证**:触发条件与旧判据逐字相同;本轮零取页时,被引 URL 集非空 ⇒ 照旧命中。
  //   天花板:①判不出「API 基址 vs 出处页」(09-12 那笔 fp 仍会响);②`fetch-quote-check --json spec`
  //   读不到 spec 里的网址 ⇒ 按旧口径视作通配;③段头不是取页命令的包装形态(`bash -c "curl …"`、
  //   `$(curl …)`、`$r = iwr …; $r.Content`)不认,仍会误报(方向是多拦不是漏放);④转录里 WebFetch
  //   必带 `url`,读不到 url 的 WebFetch 只出现在夹具(`mcp: "WebFetch"`),按旧口径视作通配;
  //   ⑤`false && curl <url>` 这类蓄意形态不防(用户裁定:蓄意规避不计)。
  _URL_RE: /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g,
  _CUE_RE: /出处|原文|逐字|引自|依据[:：]|见\s*https?:\/\//,
  _DEVNULL_RE: /^(?:\/dev\/null|nul:?|\$null)$/i,
  // 短旗标里**吃值**的字母。curl 与 wget **不合并**:同一个字母两边含义不同
  //   (`-o` 在 curl 是输出文件、在 wget 是**日志**文件;`-O` 在 wget 才是输出文件)。
  _CURL_VAL: "AbcCdDeEFhHKmoPQrtTuUwxXyYz",
  _WGET_VAL: "aBDeIilnoOpPQRtTUwX",
  // 管道下游只取这些属性 ⇒ 没读到页面内容(`iwr <url> | Select-Object StatusCode`)。
  _NOCONTENT_PROP: /^(?:StatusCode|StatusDescription|Headers|RawContentLength|BaseResponse)$/i,
  _FETCH_HEAD_RE: /^(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)$/,
  _clean: (u) => String(u).replace(/[.,;:!?*]+$/, ""),
  /** 归一:同一页的不同写法要落到同一个键。
   *  `opt.oldNorm` = 变异用的旧式(不去 www、不去默认端口);
   *  `opt.noQuery` = 变异用的 253c 之前那式(连查询串一起抹掉 ⇒ `?id=1` 冒充 `?id=2`);
   *  `opt.rawQuery` = 变异用的「查询串不排序」(参数换个顺序就被当另一页 ⇒ 误拦)。 */
  _norm: (u, opt = {}) => {
    const s0 = RULE_O._clean(u);
    if (opt.oldNorm) {
      const s = s0.replace(/#.*$/, "");
      const m = s.match(/^https?:\/\/([^/?#]+)(.*)$/i);
      return m ? m[1].toLowerCase() + (m[2] || "").replace(/\/+$/, "") : s;
    }
    // 片段恒去(`#sec` 指的是同一页的一段);查询串恒留(它是页面身份的一部分)。
    const s = s0.replace(/#.*$/, "");
    const qi = s.indexOf("?");
    const base = qi < 0 ? s : s.slice(0, qi);
    const rawQ = qi < 0 ? "" : s.slice(qi + 1);
    const m = base.match(/^(https?):\/\/([^/?#]+)(.*)$/i);
    if (!m) return s;
    const scheme = m[1].toLowerCase();
    const host = m[2].toLowerCase().replace(/^[^@]*@/, "").replace(/^www\./, "")
      .replace(scheme === "http" ? /:80$/ : /:443$/, "");
    const path = host + (m[3] || "").replace(/\/+$/, "");
    if (opt.noQuery) return path;
    const parts = rawQ.split("&").filter(Boolean);
    const q = (opt.rawQuery ? parts : parts.slice().sort()).join("&");
    return q ? `${path}?${q}` : path;
  },
  _urls: (s) => String(s || "").match(RULE_O._URL_RE) || [],
  /** 被当依据用的 URL(原样,已剥尾标点)。 */
  _cited: (t) => {
    const paras = t.split(/\n\s*\n/);
    const inCue = paras.filter((p) => RULE_O._CUE_RE.test(p)).flatMap(RULE_O._urls);
    const pick = inCue.length ? inCue : RULE_O._urls(t);
    return [...new Set(pick.map(RULE_O._clean))];
  },
  /** 命令切词:引号内的空白不切,引号本身剥掉(BP-9:引号里的脚本路径必须仍看得见)。 */
  _argv: (s) => {
    const out = []; let cur = "", q = null, had = false;
    for (const ch of String(s || "")) {
      if (q) { if (ch === q) q = null; else cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; had = true; continue; }
      if (/\s/.test(ch)) { if (cur || had) out.push(cur); cur = ""; had = false; continue; }
      cur += ch;
    }
    if (cur || had) out.push(cur);
    return out;
  },
  /** 一条命令 ⇒ [[段, 段…], …]:外层按 `&& || ; \n` 切链,内层按 `|` 切管道级。
   *  与共享 helper `segments()` 同一套掩码/转义规则,但**保留管道结构**(BP-1 要看下游)。 */
  _chains: (cmd) => {
    const raw = String(cmd || "");
    const masked = stripQuoted(raw);
    const cuts = [];
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] === "\\") { i++; continue; }
      const two = masked.slice(i, i + 2);
      if (two === "&&" || two === "||") { cuts.push([i, i + 2, "chain"]); i++; continue; }
      const c = masked[i];
      if (c === ";" || c === "\n") cuts.push([i, i + 1, "chain"]);
      else if (c === "|") cuts.push([i, i + 1, "pipe"]);
    }
    const chains = []; let cur = []; let at = 0;
    for (const [a, b, kind] of cuts) {
      cur.push(raw.slice(at, a)); at = b;
      if (kind === "chain") { chains.push(cur); cur = []; }
    }
    cur.push(raw.slice(at)); chains.push(cur);
    return chains.map((st) => st.map((s) => s.trim()).filter(Boolean)).filter((st) => st.length);
  },
  /** 下游只数字节/只取状态 ⇒ 上游那次取页没把页面内容读进来。 */
  _pipeDiscards: (stage) => {
    if (!stage) return false;
    const toks = RULE_O._argv(String(stage).replace(/^(?:\w+=\S*\s+|sudo\s+)+/, ""));
    if (!toks.length) return false;
    const head = toks[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    if (head === "wc" || head === "out-null" || head === "measure-object") return true;
    if (["select-object", "select", "foreach-object"].includes(head)) {
      const props = toks.slice(1).filter((t) => !t.startsWith("-"))
        .flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
      return props.length > 0 && props.every((p) => RULE_O._NOCONTENT_PROP.test(p));
    }
    return false;
  },
  /** 一个管道级 ⇒ `null`(不是取页命令)/ `{urls, wild}`。`next` = 它的下游级。 */
  _fetchStage: (stage, next, opt = {}) => {
    const bare = String(stage).replace(/^(?:\w+=\S*\s+|sudo\s+|command\s+|timeout\s+\d+\s+)+/, "");
    const toks = RULE_O._argv(bare);
    if (!toks.length) return null;
    const head = toks[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    const args = " " + toks.slice(1).join(" ");
    // ── 通道二:取页适配器 ────────────────────────────────────────────────
    if (head === "node") {
      if (opt.quotedOnly) {   // 变异:脚本名只在去引号串上认(BP-9 的病)
        if (!/fetch-quote-check\.mjs/.test(stripQuoted(bare))) return null;
        if (/\s--json\b/.test(args)) return { urls: [], wild: true };
        const u = RULE_O._urls(bare.slice(bare.search(/fetch-quote-check\.mjs/)))[0];
        return { urls: u ? [u] : [], wild: false };
      }
      const NO_EXEC = /^(?:-e|--eval|-p|--print|-c|--check|-h|--help|-v|--version|-i|--interactive)$/;
      const TAKES = /^(?:-r|--require|--import|--loader|--conditions|-C)$/;
      let i = 1, script = null;
      for (; i < toks.length; i++) {
        const t = toks[i];
        if (NO_EXEC.test(t)) return null;     // 语法检查/内联求值:不是跑取页脚本
        if (TAKES.test(t)) { i++; continue; }
        if (t.startsWith("-")) continue;
        script = t; break;
      }
      if (!script || !/(^|[\\/])fetch-quote-check\.mjs$/i.test(script)) return null;
      const rest = toks.slice(i + 1);
      if (rest.includes("--json")) return { urls: [], wild: true };
      const u = rest.map((t) => RULE_O._urls(t)[0]).find(Boolean);
      return { urls: u ? [u] : [], wild: false };
    }
    // ── 通道三:curl / wget / Invoke-WebRequest 族 ─────────────────────────
    if (!RULE_O._FETCH_HEAD_RE.test(head)) return null;
    const isCurl = head === "curl", isWget = head === "wget";
    let headOnly = false, discard = false, getMode = false, hasData = false, nonGet = false, upload = false;
    if (/\s--head\b|\s--spider\b/.test(args)) headOnly = true;
    if (/\s--get\b/i.test(args)) getMode = true;
    if (/\s-method(?:\s+|=)head\b/i.test(args)) headOnly = true;
    if (/\s-method(?:\s+|=)(?!get\b)\S+/i.test(args)) nonGet = true;
    if (/\s(?:-X|--request)(?:\s+|=)(?!GET\b)\S+/i.test(args)) nonGet = true;
    if (/\s(?:--upload-file|--form)(?:\s|=|$)/i.test(args)) upload = true;
    if (/\s--data(?:-[\w-]+)?(?:\s|=|$)/i.test(args)) hasData = true;
    const outM = args.match(/\s(?:--output|--output-document|-{1,2}outfile)(?:\s+|=)(\S+)/i);
    if (outM && RULE_O._DEVNULL_RE.test(outM[1])) discard = true;
    if (/(?:^|[^2])>{1,2}\s*(?:\/dev\/null|nul|\$null)(?![\w/])/i.test(bare)) discard = true;
    if (opt.noGroup) {
      // 变异:短旗标组不拆——只认 I 在组尾、`-o` 单独成词(BP-1 的病)
      if (/\s-[A-Za-z]{0,8}I(?=\s|$)/.test(args)) headOnly = true;
      if (/\s-o\s*(?:\/dev\/null|nul|\$null)(?![\w/])/i.test(args)) discard = true;
    } else {
      const VAL = isCurl ? RULE_O._CURL_VAL : isWget ? RULE_O._WGET_VAL : "";
      let skip = false;
      for (let k = 1; k < toks.length; k++) {
        const t = toks[k];
        if (skip) { skip = false; continue; }
        if (!/^-[^-]/.test(t)) continue;          // 只拆单横线短旗标组
        const body = t.slice(1);
        for (let j = 0; j < body.length; j++) {
          const ch = body[j];
          if (isCurl && ch === "I") { headOnly = true; continue; }
          if (isCurl && ch === "G") { getMode = true; continue; }
          if (!VAL.includes(ch)) continue;
          let val = body.slice(j + 1);
          if (!val) { val = toks[k + 1] || ""; skip = true; }
          if (isCurl && ch === "o" && RULE_O._DEVNULL_RE.test(val)) discard = true;
          // wget 的 `-O` 是输出文件、`-o` 是**日志**文件;`-o /dev/null` 严格说只丢日志、
          //   页面仍落到盘上。但改前(6cf00a7 侧)判它「没取页」⇒ 拿不准时留在**多拦**那一侧。
          if (isWget && (ch === "O" || ch === "o") && RULE_O._DEVNULL_RE.test(val)) discard = true;
          if (isCurl && ch === "X" && !/^get$/i.test(val)) nonGet = true;
          if (isCurl && (ch === "T" || ch === "F")) upload = true;
          if (isCurl && ch === "d") hasData = true;
          break;                                   // 值之后的字符是值不是旗标
        }
      }
    }
    if (headOnly || discard || nonGet || upload) return { urls: [], wild: false };
    if (hasData && !getMode) return { urls: [], wild: false };   // 提交表单不是取页;`-G` 例外(BP-7)
    if (!opt.noPipe && RULE_O._pipeDiscards(next)) return { urls: [], wild: false };
    return { urls: RULE_O._urls(bare), wild: false };
  },
  /** 某一个 ctx(本轮或窗口)里真取过的网址。 */
  _fetchedIn: (c, opt = {}) => {
    const got = new Set();
    let wild = false;
    for (const a of (c?.actions || [])) {
      if (a?.name !== "WebFetch") continue;
      const u = a.input?.url;
      if (typeof u === "string" && /^https?:\/\//i.test(u)) got.add(RULE_O._norm(u, opt));
      else wild = true;
    }
    for (const cmd of (c?.bashCmds || [])) {
      const outNull = !opt.noPipe && /\|\s*out-null\b/i.test(String(cmd));
      for (const stages of RULE_O._chains(cmd)) {
        for (let i = 0; i < stages.length; i++) {
          const r = RULE_O._fetchStage(stages[i], stages[i + 1], opt);
          if (!r) continue;
          if (r.wild) { wild = true; continue; }
          if (outNull) continue;
          for (const u of r.urls) got.add(RULE_O._norm(u, opt));
        }
      }
    }
    return { got, wild };
  },
  /** 取页集合 = 本轮 ∪ 窗口(BP-10);`wild` 只认本轮(见头注)。 */
  _fetched: (ctx, opt = {}) => {
    const here = RULE_O._fetchedIn(ctx, opt);
    if (!opt.noWindow) {
      const w = typeof ctx?.window === "function" ? ctx.window() : null;
      if (w) for (const u of RULE_O._fetchedIn(w, opt).got) here.got.add(u);
    }
    return here;
  },
  _detect: (ctx, opt = {}) => {
    const t = String(ctx.text || "");
    if (!/https?:\/\//.test(t)) return [];
    if (!RULE_O._CUE_RE.test(t)) return [];
    const { got, wild } = RULE_O._fetched(ctx, opt);
    if (wild) return [];
    const cited = RULE_O._cited(t);
    // 变异用的抽样口径(253b 已撤回):取过其中一个就全放行。
    if (opt.sample) return cited.some((u) => got.has(RULE_O._norm(u, opt))) ? [] : cited;
    return cited.filter((u) => !got.has(RULE_O._norm(u, opt)));
  },
  escapes: [
    // ⚠️ 2026-08-27 四眼逮到:此处**只在 say 里加了「本仓装了…时」的限定语,却没真去判**
    //   ——而同批 CHANGELOG 已经把「凡让人跑脚本的消息都先判文件在不在」写成了已实现。
    //   **限定语不是判据**:加一句「如果你有的话」既没让消息变准,也骗过了我自己。
    //   现改为真调 `toolPresent()`,与 L 项同一条口径。
    // `forPos`:样例只取 `https://x.test/a` 一个网址,而 pos[15..17] 引的是**两个**网址
    //   ——逐网址口径下,取一个当然清不掉另一个。缩小适用面写在明处,不是悄悄只测第一条。
    { forPos: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      say: toolPresent("scripts/fetch-quote-check.mjs")
        ? "真取页核实**那一个网址**:node --no-warnings scripts/fetch-quote-check.mjs <url> \"引文\""
        : "真取页核实——**本仓没装取页核实件**(`scripts/fetch-quote-check.mjs` 不在)," +
          "用下面的 WebFetch / curl 那条,或自己装一个「给 URL + 引文、取页后逐字比对」的件",
      sample: { bash: "node --no-warnings scripts/fetch-quote-check.mjs https://x.test/a \"某句\"" } },
    // ⚠️ 样例用 `mcp`(= 造一个该名字的 tool_use)而不是 `web`——夹具的 `web:` 造的是
    //   **WebSearch**,而本判据**刻意只认 WebFetch**:搜索返回的是**摘要**,不是那一页。
    //   D66 就是实证:出处只到「摘要级」,真取页逐字核后判**已核实-不成立**。
    //   ⇒ 「搜过了」不算「取过页」,这条区分不放宽。
    //   批 253:夹具造的 WebFetch 不带 url ⇒ 此样例走通配分支(天花板④);按网址配对由「取了别的网址」正例钉。
    { say: "或用 **WebFetch** 亲自取**同一网址**(注意:**WebSearch 不算**——搜索给的是摘要不是页面)",
      sample: { mcp: "WebFetch" } },
    { forPos: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      say: "或用 curl 真取**同一网址**的页面内容(`curl -sL <url>`;只取响应头 `-I`(含 `-sIL` 这类组合)、" +
        "输出丢进空设备、下游只 `wc`/`Select-Object StatusCode` 都不算)",
      sample: { bash: "curl -sL https://x.test/a | grep -c 某句" } },
  ],
  detect: (ctx) => RULE_O._detect(ctx),
  exempts: [],
  message: (hits) =>
    `外部引文当依据用,但本轮**没取过那一页**(${hits.slice(0, 3).join("、")}${hits.length > 3 ? ` 等 ${hits.length} 个` : ""})。` +
    `出处属承重八族,不得免签;**逐个网址**都要取,取了别的页、只取响应头、输出丢空设备都不算。
` +
    `${renderEscapes(RULE_O.escapes)}
` +
    `      天花板:取页闸只证「这串字符在取到的页面文本里出现/未出现」,不证该页权威、不证它支持结论。`,
  mutations: [
    { name: "去掉动作面要求(说一句『已核』就放行)", apply: (r) => ({ ...r, detect: (ctx) => {
      const t = String(ctx.text || "");
      if (!/https?:\/\//.test(t)) return [];
      return /已核|核过/.test(t) ? [] : ["x"];
    } }) },
    { name: "只要有 URL 就报(不看是否当依据用)", apply: (r) => ({ ...r, detect: (ctx) =>
      (/https?:\/\//.test(String(ctx.text || "")) ? ["x"] : []) }) },
    // 批 253 修法退回:旧判据(任意取页动作全豁免、不认 curl)⇒ curl 反例与「取了别的网址」正例变红
    { name: "退回旧判据(不按网址配对、不认 curl)", apply: (r) => ({ ...r, detect: (ctx) => {
      const t = String(ctx.text || "");
      if (!/https?:\/\//.test(t)) return [];
      if (!/出处|原文|逐字|引自|依据[:：]|见\s*https?:\/\//.test(t)) return [];
      if (/fetch-quote-check\.mjs/.test(JSON.stringify(ctx.actions || []))) return [];
      if ((ctx.toolNames || []).some((n) => /^WebFetch$/.test(n))) return [];
      return ["x"];
    } }) },
    // 批 253 修法的另一半退回:认 curl 但不看段头与旗标 ⇒ `-sI` / `-o /dev/null` / `echo curl` 正例变红
    { name: "命令里出现过该网址就算取页(不看段头与旗标)", apply: (r) => ({ ...r, detect: (ctx) => {
      const t = String(ctx.text || "");
      if (!/https?:\/\//.test(t) || !RULE_O._CUE_RE.test(t)) return [];
      const got = new Set((ctx.bashCmds || []).flatMap(RULE_O._urls).map((u) => RULE_O._norm(u)));
      return RULE_O._cited(t).filter((u) => !got.has(RULE_O._norm(u)));
    } }) },
    // ── 批 253b(红队第二轮)四条新判据各留一条退回 ────────────────────────────
    { name: "短旗标组不拆(只认 I 在组尾、-o 单独成词)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { noGroup: true }) }) },
    { name: "管道下游不看(只数字节/只取状态也算取页)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { noPipe: true }) }) },
    { name: "脚本名只在去引号串上认(引号里的路径看不见)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { quotedOnly: true }) }) },
    { name: "只看本轮(不算跨轮窗口)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { noWindow: true }) }) },
    { name: "归一不去 www 与默认端口", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { oldNorm: true }) }) },
    // ── 批 253c O-1:查询串是页面身份的一部分 ──────────────────────────────
    { name: "归一抹掉查询串(取过 ?id=1 就算取过 ?id=2)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { noQuery: true }) }) },
    { name: "查询串不排序(参数换个顺序就算另一页)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { rawQuery: true }) }) },
    { name: "抽样口径(引几个、取过一个就全放行)", apply: (r) => ({ ...r,
      detect: (ctx) => RULE_O._detect(ctx, { sample: true }) }) },
  ],
  cases: {
    // ⚠️ pos 的**下标被 escapes 的 forPos 引用**:0–14 只引一个网址(样例取得动),
    //   15–17 引两个网址(逐网址口径下样例天然清不掉)。往中间插用例要同步改 forPos。
    pos: [
      { text: "出处:https://x.test/a 里写着那句话。" },                                       // 0
      // codex 253 合并复核:curl 改方法或上传,不是取页。
      { text: "出处:https://x.test/a 里写着那句话。", bash: "curl -X DELETE https://x.test/a" }, // 1
      { text: "逐字引自 https://x.test/a —— 「某句」。" },                                      // 2
      // 批 253:取了**别的**网址不算(旧判据:任意一次取页全豁免)
      { text: "出处:https://x.test/a。", bash: "node --no-warnings scripts/fetch-quote-check.mjs https://x.test/other \"某句\"" }, // 3
      // 批 253:D117 批 231 更正列的形态——只取响应头 / 丢弃输出 / 打印一个 curl 字符串
      { text: "出处:https://x.test/a。", bash: "curl -sI https://x.test/a" },                   // 4
      { text: "出处:https://x.test/a。", bash: "curl -s -o /dev/null -w \"%{http_code}\" https://x.test/a" }, // 5
      { text: "出处:https://x.test/a。", bash: "echo curl https://x.test/a" },                  // 6
      // ── 批 253b 红队 BP-1:短旗标组里的 I / o 逐字符认 ─────────────────────
      { text: "出处:https://x.test/a 原文写着「某句」。", bash: "curl -sIL https://x.test/a" },  // 7
      { text: "出处:https://x.test/a。", bash: "curl -Is https://x.test/a" },                   // 8
      { text: "出处:https://x.test/a。", bash: "curl -sLo /dev/null https://x.test/a" },        // 9
      { text: "出处:https://x.test/a。", bash: "wget -qO /dev/null https://x.test/a" },         // 10
      // BP-1:管道下游只取状态 / 只数字节 ⇒ 页面内容没读进来
      { text: "出处:https://x.test/a。", bash: "iwr https://x.test/a | Select-Object StatusCode" }, // 11
      { text: "出处:https://x.test/a。", bash: "curl -s https://x.test/a | wc -c" },            // 12
      // 天花板③:包装形态(整条被括号包住取属性)段头不是取页命令 ⇒ 不认(多拦一侧)
      { text: "出处:https://x.test/a。", bash: "(Invoke-WebRequest https://x.test/a -UseBasicParsing).StatusCode" }, // 13
      // BP-9 的反向:`node --check` 是语法检查,不是跑取页脚本
      { text: "出处:https://x.test/a。", bash: "node --check scripts/fetch-quote-check.mjs https://x.test/a" }, // 14
      // ── 253b 用户裁定:撤回抽样口径,**逐网址** ────────────────────────────
      { text: "出处:https://x.test/a 与 https://x.test/b 都这么写。", bash: "curl -sL https://x.test/a" }, // 15
      // 依据段一个 URL 都没有 ⇒ 退回全文,同样逐网址
      { text: "出处见下表。\n\nhttps://x.test/a 与 https://x.test/b 都这么写。", bash: "curl -sL https://x.test/a" }, // 16
      // BP-10 的原场景在逐网址口径下**仍命中**:窗口取过 a、本轮取的是 c,b 从没取过
      { text: "出处:https://x.test/a 与 https://x.test/b。", bash: "curl -sL https://x.test/c",
        prior: [{ text: "上一轮", bash: "curl -sL https://x.test/a" }] },                       // 17
      // ── 批 253c O-1:查询串是页面身份的一部分,`?id=1` 不是 `?id=2` ────────────
      { text: "出处:https://x.test/a?id=2 里写着那句话。", bash: "curl -sL \"https://x.test/a?id=1\"" }, // 18
    ],
    neg: [
      // 真取过页
      { text: "出处:https://example.test/paper。", bash: "node scripts/fetch-quote-check.mjs https://example.test/paper \"某句\"" },
      // 批 253b BP-9:整条脚本路径住在引号里(去引号串上脚本名会整个消失)
      { text: "出处:https://x.test/a。", bash: "node --no-warnings \"/repo/scripts/fetch-quote-check.mjs\" https://x.test/a \"某句\"" },
      // 批 253:curl 真取同一网址(fp 台账 09-16 jirka.org 那笔的形态;反引号包 URL)
      { text: "出处:`https://www.jirka.org/ra/html/`,逐字核过。", bash: "curl -sL https://www.jirka.org/ra/html/ | head -50" },
      // 批 253:curl 取页后 grep 计数(fp 台账 08-29 example.org 那笔的形态);尾斜杠差异视作同一页
      { text: "评价以实测为准,出处见 https://example.org", bash: "curl -s https://example.org/ | grep -c 知识" },
      // 批 253:两个依据 URL 各自取过(锚点差异视作同一页;fetch-quote-check 的网址带引号)
      { text: "出处:https://x.test/a#sec 与 https://x.test/b。", bash: ["curl -sL https://x.test/a", "node --no-warnings scripts/fetch-quote-check.mjs \"https://x.test/b\" \"某句\""] },
      // 批 253b BP-10:上一轮取过 a、本轮取 b ⇒ 两个都在「本轮 ∪ 窗口」里
      { text: "出处:https://x.test/a 与 https://x.test/b。", bash: "curl -sL https://x.test/b",
        prior: [{ text: "上一轮", bash: "curl -sL https://x.test/a" }] },
      // 批 253b BP-10:www 前缀、默认端口、尾斜杠、片段都不是「另一页」
      //   253c O-1:查询串改为**保留**,故这条两侧同带 `?utm=1`——变的仍只有 www/端口/斜杠/片段。
      { text: "出处:https://www.x.test:443/a/?utm=1#sec", bash: "curl -sL \"https://x.test/a?utm=1\"" },
      // 批 253c O-1:只差片段 / 只差尾斜杠 ⇒ 同一页,放行(查询串保留后这两条仍须放行)
      { text: "出处:https://x.test/a#sec2,逐字核过。", bash: "curl -sL https://x.test/a/" },
      // 批 253c O-1:查询串参数换个顺序是同一页 ⇒ 按 key 排序后放行
      { text: "出处:https://x.test/a?b=1&a=2 里写着那句话。", bash: "curl -sL \"https://x.test/a?a=2&b=1\"" },
      // 批 253b BP-7:`-G` 把 --data-urlencode 拼进查询串,那是真取页
      { text: "出处:https://x.test/a。", bash: "curl -sG --data-urlencode \"q=某句\" https://x.test/a" },
      // `-qO-` 是写到标准输出再读,不是丢进空设备
      { text: "出处:https://x.test/a。", bash: "wget -qO- https://x.test/a | grep 某句" },
      // 只是给了个地址,没当依据用
      { text: "仓库在 https://example.test/repo,回头看。" },
      { text: "今天没有引任何外部页面。" },
    ],
  },
};

/** ND:名词日记漏记。约定正文在 `docs/noun-diary.md` 头部(2026-08-23 用户立):
 *  「用户问『这是什么』或点名 mapgen 时,AI 当场追加一行」。
 *  触发层 2026-08-31 用户亲签「加了吧」后才建——此前靠模型自觉,当日实撞:
 *  用户问「winget 到底是啥」,答了没记,用户事后问「进日记了吗」才补。
 *  「记了但没看」族(memory `nlpm-check-standing-auth` 同型):规则在,触发层空缺。
 *  判据:本轮用户消息含名词提问句式,而日记未动、且未就地声明不适用 ⇒ 拦。
 *  失效条件:`docs/noun-diary.md` 不在盘 ⇒ 本项静默退场——守的是便利性约定,
 *  非承重八族;载体没了先修载体,不拿闸顶(与 O 项 toolPresent 同一口径)。
 *  天花板:① 句式白名单只认「是什么/是啥/什么意思」族,「为什么 X」类机制问抓不到
 *  (当日 PATH 一词就是靠判断补的,这类靠自觉);② 判不出问的词是否已在册
 *  (同名词二次出现按约定不重记——那是合法的不动日记,走声明出路);
 *  ③ 判不出追加的那一行质量够不够;④(红队 a2155edb BP-1 附带)**一条消息里问两个名词、只补一行**判不出——
 *  出路按「晚于最近一次名词提问」切,同一条消息里的两问共用一个时点;要逮它得核行内容,归③,不在本判据里假装。
 *  出路时序(a2155edb):动作与声明只认晚于本轮最近一次名词提问的(时间线 `ctx.turnLog`,含被拦链上窗口前那段);
 *  失效条件:gate-ctx 不再给 `turnLog`(退回不切的旧口径,BP-1 复活)/ `bashWriteTargets` 改回手写正则(BP-2/7 复活)
 *  ——两者各有变异证人(「不按最近一次提问切」「Bash 面提到日记即算」)。 */
const RULE_ND = {
  id: "ND",
  blocking: true,   // 2026-08-31 用户亲签:「日记要不要加闸项——加了吧」
  law: "docs/noun-diary.md#名词日记",
  requires: ["userText"],
  escapes: [
    { say: "真追加一行进 docs/noun-diary.md(表尾追加,表体不留空行,一句话够下次自己搜,深挖件挂链接)",
      sample: { write: "/repo/docs/noun-diary.md" } },
    { say: "就地声明 ⟪名词日记:不适用,因⟫ + 理由——合法理由如:不是名词问 / 同名词已在册(改原行补「再遇」)/ 纯闲聊",
      sample: { text: "名词日记:不适用,因这是对上文指代的追问,不是名词问。" } },
  ],
  // 第二参只给 mutations 注入变异开关(引擎只传 ctx,默认值即真判据)——变异与真判据共用这一份实现,
  //   不再各抄一份旧判据(红队 a2155edb 附节二②:「不剥引文」变异抄的是旧版出路,新判据改了它还在测旧的)。
  detect: (ctx, V = {}) => {
    if (!toolPresent("docs/noun-diary.md")) return [];
    const Q = /(是什么|是啥|什么意思|啥意思|到底是啥|什么东西)/;
    const mask = V.noMask ? (s) => String(s || "") : (s) => maskQuoted(String(s || ""));
    const m = mask(ctx.userText).match(Q);
    if (!m) return [];
    if (V.noEscapes) return [m[1]];
    // 出路只认**晚于本轮最近一次名词提问**的动作与声明(红队 a2155edb BP-1:窗口内补了 winget 的日记、
    //   后又排队问 scoop,旧实现拿那次写入替两问一起结账;7e1392f BP-3 只在窗口前回扫里切过,窗口内没切)。
    //   时间线 `ctx.turnLog` 由 gate-ctx 按转录顺序给出(含被拦链上窗口前那段);「哪句算提问」在这里判、
    //   与上面触发用**同一个**句式与剥引文——非提问的排队消息(「顺便把 K 补上」)不切(BP-5)。
    //   没有时间线(旧调用方)⇒ 退回本轮全部动作与话(不切),与 a2155edb 之前窗口内的口径相同。
    const log = Array.isArray(ctx.turnLog) ? ctx.turnLog : null;
    let after;
    if (log) {
      let last = -1;
      if (!V.noCut) for (let i = 0; i < log.length; i++) if (log[i].k === "ask" && Q.test(mask(log[i].v))) last = i;
      after = log.slice(last + 1);
    } else {
      after = [...(ctx.writes || []).map((v) => ({ k: "write", v })), ...(ctx.bashCmds || []).map((v, i) => ({ k: "bash", v, d: ctx.bashDialects?.[i] })), { k: "say", v: ctx.text || "" }];
    }
    // 出路1(动作面):真写了日记——Write/Edit 面,或 Bash 面的**写目标**是日记。
    //   Bash 面的写目标取自 `bashWriteTargets()`(唯一实现,引号感知;红队 a2155edb BP-2/BP-7:旧手写正则把
    //   `=>`、`awk 'NF > 3'`、写别的文件的重定向、heredoc 正文当成写日记,又把 `sed -i '$a | … |'`、Add-Content、
    //   node appendFileSync、python open(…,'a') 的真写入漏掉)。只读地 grep 一下日记不算(7e1392f BP-5)。
    const DIARY = /(?:^|\/)docs\/noun-diary\.md$/i;
    const touched = after.some((x) =>
      (x.k === "write" && DIARY.test(String(x.v).replace(/\\/g, "/"))) ||
      (x.k === "bash" && (V.bashMention ? /noun-diary\.md/i.test(x.v) : (() => { try { return bashWriteTargets(x.v, DIARY, { dialect: x.d }).length > 0; } catch { return false; } })())));
    if (touched) return [];
    // 出路2(文本出路,按 INV-1 写进判据受正反例与变异约束):就地声明不适用+理由。
    //   被拦链上先前说过的声明同样认(a2155edb BP-4),同样只认提问之后说的。
    const said = after.filter((x) => x.k === "say").map((x) => x.v).join("\n").slice(-200_000);
    if (/名词日记[:：][^\n]{0,80}(不适用|已在册|已记|已补|非名词|同名词)/.test(mask(said))) return [];
    return [m[1]];
  },
  exempts: [],
  message: (hits) =>
    `**用户问了「${hits[0]}」型的问题,而名词日记没动**(约定见 docs/noun-diary.md 头部:问「这是什么」当场追加一行)。\n` +
    `${renderEscapes(RULE_ND.escapes)}\n` +
    `      天花板:句式白名单只认「是什么/是啥/什么意思」族;「为什么 X」类机制问抓不到,那半仍靠自觉。`,
  mutations: [
    { name: "去掉两条出路(动了日记/声明了也照拦)", apply: (r) => ({ ...r, detect: (ctx) => RULE_ND.detect(ctx, { noEscapes: true }) }) },
    { name: "不剥引文(用户引用一句含「是什么」的话也拦)", apply: (r) => ({ ...r, detect: (ctx) => RULE_ND.detect(ctx, { noMask: true }) }) },
    // a2155edb 附节二②:「Bash 只认写入」的变异证人——退回「命令里提到日记就算动过」必须被 grep 正例逮住
    { name: "Bash 面提到日记即算动过(不看写入目标)", apply: (r) => ({ ...r, detect: (ctx) => RULE_ND.detect(ctx, { bashMention: true }) }) },
    // a2155edb BP-1:不按「最近一次名词提问」切 ⇒ 问 1 的日记替问 2 结账,必须被 `then` 正例逮住
    { name: "不按最近一次提问切(旧写入替新问题结账)", apply: (r) => ({ ...r, detect: (ctx) => RULE_ND.detect(ctx, { noCut: true }) }) },
  ],
  cases: {
    pos: [
      { user: "winget 到底是啥?", text: "winget 是 Windows 官方包管理器。" },
      // 提了日记但既没动也没按格式声明 ⇒ 照拦(光嘴上说不算)
      { user: "SVC 是什么?", text: "SVC 是歌声音色转换。名词日记我回头再补。" },
      // 红队 7e1392f 轮 BP-5:只读地 grep 一下日记(没查到)不算动过 ⇒ 照拦
      { user: "winget 是什么?", text: "winget 是 Windows 包管理器。", bash: "grep -n winget docs/noun-diary.md" },
      // 红队 a2155edb BP-1:**窗口内**先补了 winget 的日记、后又排队问 scoop ⇒ 旧写入不替新问题结账
      { name: "a2155edb BP-1:窗口内 [问1, 写日记, 排队问2, 说] ⇒ 拦",
        user: "winget 是什么?", text: "winget 是 Windows 包管理器,已补日记。", write: "/repo/docs/noun-diary.md",
        then: [{ queued: "scoop 又是什么?" }, { text: "scoop 也是包管理器。" }] },
      // 红队 a2155edb BP-2:命令里有 `>` 也提到日记,但都不是写日记
      { name: "a2155edb BP-2:awk 引号里的 > 不是写", user: "winget 是什么?", text: "winget 是包管理器。", bash: "awk 'NF > 3' docs/noun-diary.md" },
      { name: "a2155edb BP-2:--cond 引号里的 > 不是写", user: "winget 是什么?", text: "winget 是包管理器。",
        bash: "node scripts/batch-goal.mjs --cond \"日志 >1MB 要压\" && grep winget docs/noun-diary.md" },
      { name: "a2155edb BP-2:箭头函数不是重定向", user: "winget 是什么?", text: "winget 是包管理器。", bash: "node -e \"[1].map(r=>r)\" docs/noun-diary.md" },
      { name: "a2155edb BP-2:重定向写的是别的文件", user: "winget 是什么?", text: "winget 是包管理器。", bash: "grep winget docs/noun-diary.md > clipboard/hits.txt" },
      { name: "a2155edb BP-2:heredoc 正文提到日记路径", user: "winget 是什么?", text: "winget 是包管理器。",
        bash: "cat <<'EOF' > clipboard/note.md\n回头补 docs/noun-diary.md\nEOF" },
      // 红队 a811daae BP-6 对照:**同一串**走 Bash 工具 ⇒ 按 bash 口径 `\"` 是转义、引号吞到行尾,Git Bash 里这条也写不进日记 ⇒ 照拦
      //   (证明方言跟工具名走,不是「两种口径取并集」)
      { name: "a811daae BP-6 对照:同串走 Bash 工具 ⇒ 不算写日记", user: "winget 是什么?", text: "winget 是包管理器。",
        bash: "Set-Location \"\\repo\\\"; Add-Content docs\\noun-diary.md \"| winget | pm |\"" },
      // BP-4 对照:if 条件里的 grep 读日记不算写(跳保留字不能把条件命令当写)
      { name: "a811daae BP-4 对照:if grep 日记; then … 不算写日记", user: "winget 是什么?", text: "winget 是包管理器。",
        bash: "if grep -q winget docs/noun-diary.md; then echo ok; fi" },
    ],
    neg: [
      // 动作面出路:真追加了日记
      { user: "RVC 是什么?", text: "RVC 是检索式声音转换,已补日记。", write: "/repo/docs/noun-diary.md" },
      // Bash 追加写进日记同样算
      { user: "scoop 是什么?", text: "scoop 是 Windows 的命令行包管理器,已补日记。", bash: "printf '%s\\n' '| scoop | 包管理器 |' >> docs/noun-diary.md" },
      // 文本出路:就地声明不适用+理由
      { user: "你刚说的到底是啥意思?", text: "名词日记:不适用,因这是对上文指代的追问,不是名词问。" },
      // 全角冒号(2026-09-11 红队 202 附节二②:与 DP BP-11 同一个 `[::]` 半角重复 bug)
      { user: "RVC 是什么?", text: "名词日记：不适用，因同名词已在册。" },
      // 引文形态:用户引的是话不是问 ⇒ maskQuoted 剥掉不拦
      { user: "你上一条说「这是什么」那个判据有问题。", text: "收到,我去看那条判据。" },
      // 无名词问
      { user: "继续吧。", text: "好,接着跑。" },
      // 红队 a2155edb BP-7:真写了日记、旧手写正则认不出的四种写法
      { name: "a2155edb BP-7:sed -i 追加表格行", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        bash: "sed -i '$a | winget | Windows 包管理器 |' docs/noun-diary.md" },
      // a811daae BP-6 起改走 PowerShell 工具(`ps`):Add-Content 是 PowerShell cmdlet,夹具原只能发 Bash;
      //   方言跟工具名走后,Bash 工具里这条按 bash 口径 `docs\noun-diary.md` 的反斜杠被吃掉(Git Bash 里也确实写不进日记)。
      { name: "a2155edb BP-7:Add-Content -Path 反斜杠路径", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        ps: "Add-Content -Path docs\\noun-diary.md -Value '| winget | Windows 包管理器 |'" },
      { name: "a2155edb BP-7:node appendFileSync", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        bash: "node -e \"require('fs').appendFileSync('docs/noun-diary.md', '| winget | 包管理器 |\\n')\"" },
      { name: "a2155edb BP-7:python open(…,'a')", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        bash: "python -c \"open('docs/noun-diary.md', 'a', encoding='utf-8').write('| winget | 包管理器 |\\n')\"" },
      // 红队 a811daae BP-5(误拦):`then` 被当命令名 ⇒ 认不出写日记(f4b3a9e 前的旧 ND 正则认得,b7ef430 认不出)
      { name: "a811daae BP-5:if ! grep …; then tee -a 日记 <<EOF", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        bash: "if ! grep -q winget docs/noun-diary.md; then tee -a docs/noun-diary.md <<'EOF'\n| winget | pm |\nEOF\nfi" },
      // 红队 a811daae BP-6(误拦):PowerShell 工具里 `"\repo\"` 的 `\"` 不是转义;b7ef430 用 POSIX 掩码 ⇒ 引号不闭合、Add-Content 被吞
      { name: "a811daae BP-6:PowerShell Set-Location \"\\repo\\\"; Add-Content 日记", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        ps: "Set-Location \"\\repo\\\"; Add-Content docs\\noun-diary.md \"| winget | pm |\"" },
      // BP-6 Bash 侧反向同族:`\"` 在 bash 双引号里是转义,目标是日记(b7ef430 解成 `b/ docs/noun-diary.md`)
      { name: "a811daae BP-6:Bash sed -i \"s/a/\\\" b/\" 日记", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        bash: "sed -i \"s/a/\\\" b/\" docs/noun-diary.md" },
      // 复核红队 aaf414b6 BP-3(误拦,365fd54 引入):引号里的单个 `>` 被当裸重定向算子、连 `-Path` 一起剔 ⇒ `-Value` 吞掉真路径
      { name: "aaf414b6 BP-3:PS Add-Content -Value 单个 > 再 -Path 日记", user: "winget 是什么?", text: "winget 是包管理器,已补日记。",
        ps: "Add-Content -Value \">\" -Path docs/noun-diary.md" },
      // 红队 a2155edb BP-5:被拦后排队的是**非提问**消息 ⇒ 不切掉之前的日记写入
      { name: "a2155edb BP-5:非提问的排队消息不切先前的日记写入", text: "补了 K,收工。",
        prior: [{ user: "winget 是什么?", text: "winget 是包管理器,已补日记。", write: "/repo/docs/noun-diary.md", stop: "blocked" },
          { queued: "顺便把 K 也补上。" }] },
      // 红队 a2155edb BP-4:被拦链上已就地声明过不适用 ⇒ 续跑时认
      { name: "a2155edb BP-4:被拦链上的文本声明续跑时认", text: "补了 K,收工。",
        prior: [{ user: "RVC 是什么?", text: "RVC 是检索式声音转换。名词日记:不适用,因同名词已在册。", stop: "blocked" }] },
      // 同上,判官型拦截(只留 feedback 行,BP-6 形态)同样认作同一用户轮
      { name: "a2155edb BP-4/6:feedback 行型拦截后续跑,先前的日记写入仍认", text: "收工。",
        prior: [{ user: "winget 是什么?", text: "已补日记。", write: "/repo/docs/noun-diary.md", stop: "blocked-fb" }] },
    ],
  },
};

/** DP:推了 private 却没跑欠账探针(生产法三「收尾清账」的触发层;2026-09-11 批 202 装)。
 *  立法动机:服务器工作副本自 08-19 起再没 pull,静默落后 365 个提交三周——法条早写「会话收尾必查」四级,
 *  但 S4 只在 verify-prod 里,而工装/闸批不跑 verify-prod ⇒ 无人触发。用户同日签「能清即清、只报结果」
 *  (呈签单 clipboard/prompts/202-auto-deploy-sign.md)——本项即该条的「装好」。
 *  先例:GitOps 漂移检测「Drift usually becomes harder to solve the longer it exists, so scan on a schedule
 *  rather than waiting for something to break.」(https://spacelift.io/blog/gitops-best-practices,2026-09-11 取页逐字核)。
 *  判据(动作面,不看文本):把**上文窗口 + 本轮**的命令按发出顺序拼起来(红队 202 BP-1:只看本轮时,
 *  被拦一次后什么都不做、直接再结束一次即解除——推送那一轮已落到窗口外),找最后一次 push;
 *  其后没有一段是真的在跑 `node … verify-prod.mjs`(带不带 --debt-only 都认)⇒ 拦。
 *  切段走唯一实现 `segments`/`stripQuoted` + `stripHeredoc`(红队 BP-13/5/6:朴素切段在引号、heredoc、注释里照切,
 *  `git commit -m "fix; git push later"` 被当成推、写在注释里的探针被当成跑过)。
 *  push 识别不锚段首(BP-3):段内任意位置的 git 可执行名 + push 子命令都算,`bash -c "…"`/`sh -c`/`pwsh -Command` 剥一层再判;
 *  bare `git push` 因 pushDefault=private 也算;远端名取第一个非选项参数,整词等于 origin 才排除(origin 已置 no-push://);
 *  `--dry-run` / `-n` 只在参数面上认(BP-6/14)。
 *  探针识别同样不锚段首(BP-12:PowerShell `if ($?) { node … }`、`timeout 120 node …` 原被误拦),
 *  但 node 必须在引号外、且带 `--check`/`-e`/`-p` 的不算(BP-5)。
 *  (原「文本出路:就地声明『不适用,因…』」已于第六轮撤销,本闸不读正文——现形态见 DP_FACTS 上方注释。)
 *  失效条件:本仓没有 scripts/verify-prod.mjs(如 custodiet 公开树)⇒ 静默退场,与 O/ND 的 toolPresent 同口径。
 *  天花板(已声明,**批 205 前复议**):① 只证「发起过一次探针」,不证跑通、不证欠账已清(退出码不在入参面);
 *  ② `false && node … verify-prod.mjs` 这类短路写法仍被当成跑过(按段判,不求值);
 *  ③ 只提交不推时本项不响(BP-2)——扩到「有提交就要探针」要改法条触发层句;
 *  ④ 子代理代推(BP-7):SubagentStop 分支不跑本项;⑤ 引擎把单条命令截在前 8000 字(BP-8,引擎级,影响所有 Bash 规则);
 *  ⑥ 窗口取不到(priorEntries 为 null)时退回只看本轮;
 *  ⑦ (已消解)文本出路是自证(红队 202 第二轮 BP-C)——第六轮撤销文本出路后不复存在;
 *  ⑧ 窗口封顶 400 条(BP-D,PLAUSIBLE):推送滚出窗口后本项再也看不到它——要根治得改持久台账(推一笔、探针销账)。
 *  第二轮修法(BP-A/B/E/F,2026-09-11,lawmaking 四之二自签):
 *  剥壳不再要求闭引号后直到行尾(`bash -c "git push …" 2>&1` / `&` / `> log` 原来整段漏识别),也不再要求 wrapper 在段首;
 *  push 段的**头命令**是 echo/printf/Write-Host 等打印类时不算推(`echo foo git push` 原被误拦),但 `$(`/反引号里的照算;
 *  探针改为「node 之后第一个非选项实参就是 verify-prod.mjs」,选项走**白名单**(`node -v verify-prod.mjs`、
 *  引号里提到文件名原被当成跑过;`--check-debt` 这类脚本自身参数原被 `--check\b` 误吃)。 */
const DP_WRAP = /(?:^|[\s(&{])(?:\S*[\\/])?(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\b.*?\s-(?:c|Command)\s+(["'])((?:\\[\s\S]|(?!\1)[\s\S])*)\1/i;
// 第二轮之前的形态,只给 mutations 用(反向探针:换回它套件必须变红)
const DP_WRAP_R1 = /^(?:\S*[\\/])?(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\b.*?\s-(?:c|Command)\s+(["'])([\s\S]*)\1\s*$/i;
// 注释要在**切段之前**逐行剥掉:segments 不认 `#`,先切的话 `git push x # ; node probe` 的注释后半截会变成独立一段。
const DP_UNCOMMENT = (cmd) => String(cmd).split("\n").map((line) => {
  const m = stripQuoted(line).search(/(?:^|\s)#/);
  return m < 0 ? line : line.slice(0, m);
}).join("\n");
// 剥壳递归,封顶 10 层——先例:CC Safety Net「unwraps and re-analyzes nested commands up to 10 levels deep」
// (https://ccsafetynet.com/docs/guides/how-it-works,2026-09-11 取页核)。只剥一层时 `bash -c "sh -c 'git push'"` 整段漏。
// wrapper 本身必须在引号外(红队第三轮 BP-G3:`git commit -m "switch CI to sh -c 'git push' step"` 里的
// 文档句曾被剥出来当命令,每轮误拦)。在原始段上找匹配、再用掩码段核它的起点是不是被引号吞掉的位置。
const DP_WRAP_AT = (seg, wrap) => {
  const masked = stripQuoted(seg);
  const re = new RegExp(wrap.source, wrap.flags.includes("g") ? wrap.flags : wrap.flags + "g");
  for (const m of seg.matchAll(re)) {
    const idx = m.index + (/^[\s(&{]/.test(m[0]) ? 1 : 0);
    if (/\S/.test(masked[idx] || "")) return m;
  }
  return null;
};
const DP_UNWRAP = (seg, wrap, depth = 0) => {
  const w = depth < 10 ? DP_WRAP_AT(seg, wrap) : null;
  return w ? segments(DP_UNCOMMENT(w[2])).flatMap((s) => DP_UNWRAP(s.trim(), wrap, depth + 1)) : [seg];
};
const DP_SEGS = (cmds, wrap = DP_WRAP) => (cmds || []).flatMap((c) =>
  segments(DP_UNCOMMENT(stripHeredoc(String(c)))).flatMap((seg) => DP_UNWRAP(seg, wrap)))
  .map((s) => s.trim()).filter(Boolean);
// 前导锚含反引号(BP-G2:`` echo `git push …` `` 反引号命令替换原完全认不出,段头 guard 里的反引号判断成了死码)
const DP_PUSH_RE = /(?:^|[\s(&{`])(?:\S*[\\/])?git(?:\.exe)?(?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace)(?:\s+\S+)?|\s+--?[\w-]+(?:=\S+)?)*\s+push\b(.*)$/i;
// 段头是打印/写文本类命令 ⇒ 后面的 `git push` 只是它的参数(BP-E);`VAR=x` 前缀跳过
const DP_PRINT_HEAD = /^(?:echo|printf|write-host|write-output|out-file|set-content|add-content|cat|grep|rg|select-string)$/i;
const DP_IS_PUSH = (seg, { headCheck = true } = {}) => {
  const masked = stripQuoted(seg);
  const hit = masked.match(DP_PUSH_RE);
  if (!hit) return false;
  if (headCheck) {
    // hit.index 指向 DP_PUSH_RE 吃进去的前导字符(可能正是 `$(` 的那个 `(`),所以判替换要多看一位。
    // ⚠️ 只防 `$(`/反引号是第一版的洞(codex 复核 202-dp-r2-crosscheck-r1 逮到):
    //   `cat <(git push …)` 进程替换、PowerShell `Write-Output (git push …)` 子表达式里的 push 都会真执行。
    //   现在只要 push 之前出现任何 `(`/`{`/反引号,就不认打印类豁免——宁可误拦,不放真推。
    // ⚠️ 保守判法:push 之前只要出现任何 `(`/`{`/反引号就不给打印豁免。
    //   曾改为「只看未闭合开符」以消第四轮红队 BP-7 的误拦(`printf '%s' {a,b} git push`),
    //   codex 复核(202-dp-facts-review-r2-r1)当即给出反例:Bash 里转义的 `\)` 被当成闭括号,
    //   `echo $(printf x \) \) $(<直接路径推送>))` 的真推送被放过——又一次「解析补不完」。退回保守版;
    //   BP-7 的误拦按代价不对称接受(跑一次探针即解除),记天花板⑪。
    const before = masked.slice(0, hit.index);
    const head = before.trim().split(/\s+/).find((t) => t && !/^\w+=/.test(t));
    if (head && DP_PRINT_HEAD.test(head) && !/[({`]/.test(masked.slice(0, hit.index + 1))) return false;
  }
  const args = hit[1].trim().split(/\s+/).filter(Boolean);
  if (args.some((a) => a === "--dry-run" || a === "-n")) return false;
  let remote = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(-o|--push-option|--receive-pack|--exec)$/.test(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    remote = a; break;
  }
  return remote !== "origin";   // 省略远端 = pushDefault=private
};
// node 自身的旗只认白名单(BP-B:黑名单挡不住 -v/--help 这类「不执行脚本」的旗);白名单外一律不算探针
const DP_NODE_OK_FLAG = /^--(?:no-[\w-]+|experimental-[\w-]+|enable-source-maps|max-old-space-size=\d+|stack-size=\d+|env-file=\S+|unhandled-rejections=[\w-]+|trace-[\w-]+)$/;
const DP_TOKENS = (s) => (s.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^(["'])([\s\S]*)\1$/, "$2"));
// 取值的预加载旗(BP-G4):空格形跳过其后一个值,`=` 形整体放行;须先于 OK_FLAG 判(`--experimental-loader` 也命中 OK_FLAG)
const DP_NODE_VAL_FLAG = /^(?:-r|--require|--loader|--experimental-loader|--import)$/;
const DP_NODE_VAL_EQ = /^--(?:require|loader|experimental-loader|import)=\S+$/;
const DP_IS_PROBE = (seg) => {
  const masked = stripQuoted(seg);
  // node 可带路径(BP-G5:原来 push 面认 `/usr/bin/git`、探针面不认 `/usr/bin/node`,不对称)
  const at = masked.search(/(?:^|[\s(&{])(?:\S*[\\/])?node(?:\.exe)?(?=\s)/i);
  if (at < 0) return false;
  const toks = DP_TOKENS(seg.slice(at).replace(/^[\s(&{]/, ""));
  for (let i = 1; i < toks.length; i++) {          // toks[0] = node
    const t = toks[i];
    if (DP_NODE_VAL_FLAG.test(t)) { i++; continue; }
    if (t.startsWith("-")) { if (DP_NODE_OK_FLAG.test(t) || DP_NODE_VAL_EQ.test(t)) continue; return false; }
    // 第一个非选项实参 = 被执行的脚本;之后的是脚本自己的参数(BP-F)。
    // 要求 `scripts/verify-prod.mjs` 这一段路径,不只认文件名(红队第三轮附节:`node ./scratch/verify-prod.mjs` 原被当成跑过)
    return /(?:^|[\\/])scripts[\\/]verify-prod\.mjs$/.test(t);
  }
  return false;
};
// 第二轮之前的形态,只给 mutations 用
const DP_IS_PROBE_R1 = (seg) => {
  const masked = stripQuoted(seg);
  const at = masked.search(/(?:^|[\s(&{])node(?:\.exe)?(?=\s)/i);
  if (at < 0) return false;
  if (/\s(?:--check|-c|-e|--eval|-p|--print)\b/.test(masked.slice(at))) return false;
  return /verify-prod\.mjs\b/.test(seg.slice(at));
};
// 文本出路「欠账探针:不适用,因 push 被拒…」**整个撤掉**(红队 202 第六轮 BP-1;第五轮已先删「不是 private」三支):
//   推 URL/tag 时事实一路看不见,解析一路就只剩这句声明把关,而它无从核真——「被拒」可以是谎。
//   推送真被拒时的出路 = 照样跑一次欠账探针(几十秒);法条的「推送非零退出即停」不妨碍先跑探针再停。
//   按代价不对称:多跑一次探针远比放过一次真欠账便宜。天花板⑦(文本自证)随之在两条路上都消解。
// **事实判据优先**(2026-09-12 批 202 第四轮红队后改设计;权威实现 lib/debt-facts.mjs 头注):
//   hook 注入 `ctx.debtFacts = {lastPushTs, pushRef, lastProbeTs}`——reflog 里最后一次 `update by push` 的时刻
//   vs 欠账探针标记的时刻。推之后没有更晚的探针标记 ⇒ 拦。**不看命令怎么写**,于是四轮红队的全部语法类漏放
//   (续行 / `$'…'` / PS `''` / here-string / 嵌套转义 / 进程替换 / 别处同名脚本)在事实路径上不存在;
//   文本出路在事实路径上也不认——推没成功就不会有 reflog 记录,无需声明;推成功了,声明「被拒」就是假话。
//   推 URL/tag 不更新跟踪 ref,只有解析判法看得见;第六轮起解析判法也不再认文本声明(DP_ESCAPE 已删),
//   两条路上的出路都只剩「真跑探针」——天花板⑦(文本自证)就此消解。
//   ⚠️ 事实路径**只判「推后有没有发起探针」**,与生产法三触发层原文一致(「最后一次推之后没发起欠账探针即拦」)。
//   曾加过「探针 UNKNOWN / 报 FAIL 也拦,须写固定停下句」两支(第五轮 BP-3、第六轮 BP-2 的修法),
//   第七轮红队证明它们弊大于利:标记是整仓持久状态、停下句只认本轮正文 ⇒ 一次没清的 FAIL/UNKNOWN 让**所有会话每轮**被拦
//   (含从不推送的只读会话);fail 还把 S1/S6/角色矩阵这类非欠账 FAIL 计入;而「跑探针+停下句」又成了跳过部署的捷径。
//   两支已删:探针查到什么、清没清,归收尾报告的四级欠账行(生产法三观测仪器),不归本闸——天花板①原文如此。
//   事实读不到(git 故障、reflog 关闭、公开树缺件)时,事实这一路交白卷,只剩解析判法——这不是 fail-closed,
//   是「退回较弱判法」(BP-4 纠正);已声明为天花板⑨。伪造一个时刻靠后的标记能压住事实这一路(BP-1),属蓄意,天花板⑩。
// ⚠️ 事实与解析取**并集**(codex 复核 202-dp-facts-review-r1:「事实替代解析」会放过推 tag / 推 URL /
//   reflog 关闭或过期——这些旧解析判法会拦)。并集下新判法在构造上不比旧判法松;事实这一路补的是解析看不见的写法。
//   比较用严格 `>`:reflog 只有秒精度,同一秒里「探针→推送」无从区分,按没查算(宁可多跑一次探针)。
const DP_FACTS = (f) => {
  if (!f.lastPushTs) return [];
  if (f.lastProbeTs !== null && f.lastProbeTs > f.lastPushTs) return [];
  const at = new Date(f.lastPushTs * 1000).toISOString().replace("T", " ").slice(0, 16);
  return [`${f.pushRef || "private"} 于 ${at}Z 推送(reflog);其后无欠账探针标记`];
};
const DP_DETECT = (ctx, { ordered = true, useWindow = true, wrap = DP_WRAP, probe = DP_IS_PROBE, headCheck = true, useFacts = true, facts = DP_FACTS } = {}) => {
  if (!toolPresent("scripts/verify-prod.mjs")) return [];
  const byFacts = useFacts && ctx.debtFacts && typeof ctx.debtFacts === "object" ? facts(ctx.debtFacts) : [];
  if (byFacts.length) return byFacts;   // 事实这一路判出即拦,文本声明不认
  const w = useWindow && typeof ctx.window === "function" ? ctx.window() : null;
  const segs = DP_SEGS([...((w && w.bashCmds) || []), ...(ctx.bashCmds || [])], wrap);
  let lastPush = -1;
  segs.forEach((s, i) => { if (DP_IS_PUSH(s, { headCheck })) lastPush = i; });
  if (lastPush < 0) return [];
  if ((ordered ? segs.slice(lastPush + 1) : segs).some(probe)) return [];
  return [segs[lastPush].slice(0, 60)];
};
const RULE_DP = {
  id: "DP",
  blocking: true,   // 生产法三新条款明写「触发层:收尾闸……即拦」;实现已签法条属窄例外④明确适用
  law: "docs/laws/production.md#三、部署欠账",
  escapes: [
    // 跑探针 ⇒ 探针自己刷新标记(事实路径)/ 命令里出现真探针(解析路径);样例两面都表达
    { say: "推完跑欠账探针:node --no-warnings scripts/verify-prod.mjs --debt-only(不需要任何 session),查到欠账按生产法三即清只报",
      sample: { bash: "node --no-warnings scripts/verify-prod.mjs --debt-only", debtFacts: { lastProbeTs: 9999999999 } } },
    // 「就地声明 ⟪欠账探针:不适用,因⟫」已撤(第六轮 BP-1):两条路都不认文本声明,推送被拒也要跑一次探针。
  ],
  detect: (ctx) => DP_DETECT(ctx),
  exempts: [],
  message: (hits) =>
    `**推了 private(\`${hits[0]}\`),之后却没跑欠账探针**——生产法三:收尾逐级查,查到即清、只报结果。\n` +
    `${renderEscapes(RULE_DP.escapes)}\n` +
    `      判据:reflog 最后一次推送 vs 欠账探针标记(lib/debt-facts.mjs),并上命令解析;文本声明不认,推送被拒也要跑探针。\n` +
    `      天花板:只证「推之后发起过探针」——探针查出 FAIL/UNKNOWN 后是清是停,归收尾报告的四级欠账行(生产法三);只提交不推本项不响(批 205 前复议)。`,
  mutations: [
    { name: "不看先后(推之前跑过探针也放行)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { ordered: false }) }) },
    { name: "只看本轮(BP-1:被拦一次后直接再结束即解除)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { useWindow: false }) }) },
    { name: "按字符串出现判 push(echo/提交信息里提到 git push 也拦)", apply: (r) => ({ ...r, detect: (ctx) => {
      if (!toolPresent("scripts/verify-prod.mjs")) return [];
      const all = (ctx.bashCmds || []).join("\n");
      if (!/git push/.test(all)) return [];
      if (/verify-prod\.mjs/.test(all.slice(all.lastIndexOf("git push")))) return [];
      return ["x"];
    } }) },
    // 第二轮反向探针:换回修前形态,新增用例必须抓住
    { name: "剥壳锚到行尾且只认段首 wrapper(BP-A 修前)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { wrap: DP_WRAP_R1 }) }) },
    { name: "探针按黑名单旗 + 原始段里出现文件名即算(BP-B/F 修前)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { probe: DP_IS_PROBE_R1 }) }) },
    { name: "不看段头命令(BP-E 修前:echo 里的 git push 也算推)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { headCheck: false }) }) },
    // 事实路径的反向探针
    { name: "不用事实(有 reflog 事实也照走命令解析)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { useFacts: false }) }) },
    { name: "事实路径只看推没推(不比探针时刻)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { facts: (f) => (f.lastPushTs ? ["x"] : []) }) }) },
    { name: "事实替代解析(有事实就不再跑命令解析;codex 复核判死的形态)", apply: (r) => ({ ...r, detect: (ctx) => (ctx.debtFacts && typeof ctx.debtFacts === "object" ? DP_FACTS(ctx.debtFacts) : DP_DETECT(ctx)) }) },
    { name: "同秒放行(`>=`)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { facts: (f) => (!f.lastPushTs || (f.lastProbeTs !== null && f.lastProbeTs >= f.lastPushTs) ? [] : ["x"]) }) }) },
    { name: "事实路径时刻比反(探针早于推送也放行)", apply: (r) => ({ ...r, detect: (ctx) => DP_DETECT(ctx, { facts: (f) => (!f.lastPushTs || (f.lastProbeTs !== null && f.lastProbeTs <= f.lastPushTs) ? [] : ["x"]) }) }) },
  ],
  cases: {
    pos: [
      { text: "推上去了。", bash: "git push private master" },
      // bare push:pushDefault=private
      { text: "推了。", bash: "git add docs/x.md && git commit -m y && git push" },
      // 探针在推之前跑的 ⇒ 量的是推之前的世界,不算
      { text: "先查后推。", bash: ["node --no-warnings scripts/verify-prod.mjs --debt-only", "git push private master"] },
      { text: "推了。", bash: "git -C /repo push private master" },
      // BP-1:推送在上文窗口,本轮什么都没做
      { text: "收到。", prior: [{ bash: "git push private master" }] },
      // BP-3:包装器与不在段首
      { text: "推了。", bash: "timeout 60 git push private master" },
      { text: "推了。", bash: "bash -c \"git push private master\"" },
      // BP-5:探针只写在注释里 / 只做语法检查
      { text: "推完查了。", bash: ["git push private master # ; node scripts/verify-prod.mjs"] },
      { text: "推完查了。", bash: ["git push private master", "node --check scripts/verify-prod.mjs"] },
      // BP-6:注释里的 --dry-run 不算 dry-run
      { text: "推了。", bash: "git push private master # --dry-run" },
      // 第二轮 BP-A:wrapper 后挂重定向/后台尾巴,或 wrapper 不在段首
      { text: "推了。", bash: "bash -c \"git push private master\" 2>&1" },
      { text: "推了。", bash: "sh -c 'git push private master' &" },
      { text: "推了。", bash: "pwsh -Command \"git push private master\" > log.txt" },
      { text: "推了。", bash: "timeout 60 bash -c \"git push private master\"" },
      // 第二轮 BP-B:假探针——node 不执行脚本的旗 / 文件名只在引号参数里
      { text: "推完查了。", bash: ["git push private master", "node -v verify-prod.mjs"] },
      { text: "推完查了。", bash: ["git push private master", "node other.js --note \"see verify-prod.mjs\""] },
      // 打印类段头豁免不外溢到命令替换
      { text: "推了。", bash: "echo $(git push private master)" },
      // 第三通道 codex 复核(202-dp-r2-crosscheck-r1):进程替换 `<(…)`/`>(…)` 与 PowerShell 子表达式 `(…)` 里的 push 会真执行
      { text: "推了。", bash: "bash -c 'cat <(git push private master)'" },
      { text: "推了。", bash: "echo <(git push private master)" },
      { text: "推了。", bash: "Write-Output (git push private master)" },
      // 外部先例(CC Safety Net:wrapper 递归展开至 10 层):两层包装
      { text: "推了。", bash: "bash -c \"sh -c 'git push private master'\"" },
      // 第三轮 BP-G2:反引号命令替换
      { text: "推了。", bash: "echo `git push private master`" },
      // 第三轮附节:别处的同名文件不是那个探针
      { text: "推完查了。", bash: ["git push private master", "node ./scratch/verify-prod.mjs"] },
      // ── 事实路径(2026-09-12):reflog 有推送、其后无探针标记 ⇒ 拦,不论命令怎么写 ──
      { text: "推了。", debtFacts: { lastPushTs: 2000, pushRef: "private/master", lastProbeTs: null } },
      { text: "推了。", debtFacts: { lastPushTs: 2000, pushRef: "private/master", lastProbeTs: 1000 } },
      // 第四轮红队 BP-1:续行推送(今天的解析判法已认得出;事实路径两边都拦)
      { text: "推了。", bash: "git push \\\nprivate master", debtFacts: { lastPushTs: 2000, lastProbeTs: 1000 } },
      // 事实路径不认文本自证(推成功了还说「被拒」)
      { text: "欠账探针:不适用,因 push 被拒(非快进)。", debtFacts: { lastPushTs: 2000, lastProbeTs: null } },
      // 别处同名假探针:只有真探针才落标记,命令里「跑过」不算
      { text: "推完查了。", bash: ["git push private master", "node other/scripts/verify-prod.mjs"], debtFacts: { lastPushTs: 2000, lastProbeTs: 1000 } },
      // 同一秒:reflog 只有秒精度,分不清先后 ⇒ 按没查算(codex 复核:原 `>=` 放过「探针→推送」同秒)
      { text: "同一秒。", debtFacts: { lastPushTs: 2000, lastProbeTs: 2000 } },
      // 并集:直接推 URL 不更新跟踪 ref,事实一路看着干净,命令解析一路照拦(codex 复核反例)
      { text: "推了。", bash: "git push https://github.com/x/app-private.git master", debtFacts: { lastPushTs: 1000, lastProbeTs: 1500 } },
      // 打印类豁免只在推送前有未闭合开符时作废:`$( git push )` 带空格形
      { text: "推了。", bash: "echo $( git push private master )" },
      // 第五轮红队 BP-2:推 URL 进私仓 + 「不是 private」假声明——该支已从闭集删去
      { text: "欠账探针:不适用,因推的不是 private,是仓库 URL。", bash: "git push https://github.com/x/app-private.git master", debtFacts: { lastPushTs: 1000, lastProbeTs: 1500 } },
      // 第六轮红队 BP-1:文本声明撤掉后,「被拒」声明(全半角)不再放行——推 URL 进私仓 + 谎称被拒
      { text: "欠账探针:不适用,因 push 被拒(非快进),已按生产法三停下。", bash: "git push private master" },
      { text: "欠账探针：不适用，因 push 被拒(非快进),已按生产法三停下。", bash: "git push https://github.com/x/app-private.git master", debtFacts: { lastPushTs: 1000, lastProbeTs: 1500 } },
      // codex 复核 r2:转义闭括号不关闭外层命令替换;直接路径推送事实一路看不见
      { text: "推了。", bash: "echo $(printf x \\) \\) $(git push /srv/app-private.git master))", debtFacts: { lastPushTs: 1000, lastProbeTs: 1500 } },
    ],
    neg: [
      { text: "推完查了欠账。", bash: ["git push private master", "node --no-warnings scripts/verify-prod.mjs --debt-only"] },
      { text: "推完跑全套。", bash: "git push private master 2>&1 | tail -3; node --no-warnings scripts/verify-prod.mjs > x.log" },
      // 窗口里推、窗口里也查过
      { text: "收工。", prior: [{ bash: "git push private master" }, { bash: "node --no-warnings scripts/verify-prod.mjs --debt-only" }] },
      // 窗口里推、本轮查
      { text: "查了。", prior: [{ bash: "git push private master" }], bash: "node --no-warnings scripts/verify-prod.mjs --debt-only" },
      // BP-12:条件执行的探针
      { text: "推完查了。", bash: ["git push private master", "timeout 120 node --no-warnings scripts/verify-prod.mjs --debt-only"] },
      { text: "推完查了。", bash: "git push private master; if ($?) { node --no-warnings /repo/scripts/verify-prod.mjs --debt-only }" },
      // 只提到 git push、并未推(BP-13)
      { text: "没推。", bash: "echo 'git push private master' > note.txt" },
      { text: "只本地提交。", bash: "git commit -m \"fix; git push later\"" },
      { text: "只本地提交。", bash: "git commit -q -F - <<'EOF'\ngit push private master 之前先做 X\nEOF" },
      // 推的是 origin(公开壳,push 已废)
      { text: "推公开壳。", bash: "git push origin showcase-public" },
      { text: "试推。", bash: "git push --dry-run private master" },
      { text: "试推。", bash: "git push -n private master" },
      { text: "今天没推。" },
      // 第二轮 BP-E:裸词提到 git push,并未推
      { text: "没推。", bash: "echo foo git push" },
      { text: "没推。", bash: "echo running git push private master now" },
      // 第二轮 BP-F:脚本自己的 --check* 参数不是 node 的 --check
      { text: "推完查了。", bash: ["git push private master", "node scripts/verify-prod.mjs --check-debt"] },
      // 引号包住的探针路径照认
      { text: "推完查了。", bash: ["git push private master", "node --no-warnings \"/repo/scripts/verify-prod.mjs\" --debt-only"] },
      // 第三轮 BP-G3:引号里的文档句提到 sh -c 'git push',并未推
      { text: "只本地提交。", bash: "git commit -m \"switch CI to sh -c 'git push private' step\"" },
      { text: "没推。", bash: "echo \"docs: run bash -c 'git push private master' in CI\"" },
      // 第三轮 BP-G4:带预加载旗的真探针
      { text: "推完查了。", bash: ["git push private master", "node --require ./instrument.js scripts/verify-prod.mjs --debt-only"] },
      { text: "推完查了。", bash: ["git push private master", "node -r x --experimental-loader ./l.mjs scripts/verify-prod.mjs"] },
      { text: "推完查了。", bash: ["git push private master", "node --import=./x.mjs scripts/verify-prod.mjs"] },
      // 第三轮 BP-G5:带路径的 node
      { text: "推完查了。", bash: ["git push private master", "/usr/bin/node scripts/verify-prod.mjs --debt-only"] },
      { text: "推完查了。", bash: ["git push private master", "E:/n/node.exe scripts/verify-prod.mjs"] },
      // ── 事实路径 ──
      // 推之后跑过探针(标记晚于推送)⇒ 放,不论命令里写没写探针
      { text: "推完查了。", debtFacts: { lastPushTs: 2000, pushRef: "private/master", lastProbeTs: 2100 } },
      // 从没推过
      { text: "没推。", debtFacts: { lastPushTs: null, lastProbeTs: null } },
      // 第七轮红队后定型:本闸只判「推后发起过探针」。探针报 FAIL / UNKNOWN 照放——是清是停归收尾报告的四级欠账行,
      //   否则整仓持久的标记会让所有会话每轮被拦(第七轮 BP-2)。这两条是语义说明:gate-ctx 本就不转发
      //   probeFail/probeUnknown,只在 DP 里加回那两支它们仍绿;要连 gate-ctx 转发一起恢复才会变红(第八轮附节 3)。
      { text: "探针报了 S4 落后,正在走部署。", debtFacts: { lastPushTs: 2000, lastProbeTs: 2100, probeFail: 1 } },
      { text: "只读调查结论如下。", debtFacts: { lastPushTs: 2000, lastProbeTs: 2100, probeUnknown: true } },
      // 推被拒:reflog 无新推送,命令里 push 之后跑了探针 ⇒ 放(文本声明已不是出路,跑探针是)
      { text: "推被拒了,已停下。", bash: ["git push private master", "node --no-warnings scripts/verify-prod.mjs --debt-only"], debtFacts: { lastPushTs: 1000, lastProbeTs: 1500 } },
      // 事实通道读取故障(null)⇒ 退回解析判法:推后跑了真探针照放
      { text: "推完查了。", bash: ["git push private master", "node --no-warnings scripts/verify-prod.mjs --debt-only"], debtFacts: null },
    ],
  },
};

// 2026-10-09 用户裁撤「同一时刻只许一个写会话」的会话判活检查(「没看到这个查写会话带来的任何好处;真正应该解决的是工作树和 branch」):
//   规则 CW 与 Stop 时点的 session-triage 注入一并删除;并发写改由 git 隔离(各写会话在自己的 worktree 与分支上干活),见 docs/laws/collab.md。

/** AD 的签字词探测(批 256)。在一条提交信息里找「用户 …(≤16 字,不跨行)… [亲]签/裁/批」,返回命中片段或 null。
 *  排除:「用户」前 2 字内有 待/须/需/未/呈/归/等(待用户签、需要用户裁、归用户裁);
 *        动词(含前置「亲」)紧前一字是这些字(用户尚未亲签);「批 <数字>」(批号)与「批注」。
 *  opts 只给变异用(各关掉一条排除或放宽窗口),生产路径不传。 */
const AD_NEG = /[待须需未呈归等]/;
export function findSignPhrase(msg, opts = {}) {
  const s = String(msg || "");
  const win = opts.win ?? 16;
  for (const m of s.matchAll(/用户/g)) {
    const u = m.index, start = u + 2;
    if (!opts.noUserPre && AD_NEG.test(s.slice(Math.max(0, u - 2), u))) continue;
    for (let k = 0; k <= win && start + k < s.length; k++) {
      const pos = start + k, ch = s[pos];
      if (ch === "\n") break;
      if (ch !== "签" && ch !== "裁" && ch !== "批") continue;
      if (!opts.noBatchNum && ch === "批" && /^批(\s*\d|注)/.test(s.slice(pos, pos + 6))) continue;
      const vStart = pos - 1 >= start && s[pos - 1] === "亲" ? pos - 1 : pos;
      if (!opts.noVerbPre && vStart > start && AD_NEG.test(s[vStart - 1])) continue;
      return s.slice(Math.max(0, u - 6), pos + 6);
    }
  }
  return null;
}
const adDetect = (opts = {}) => (ctx) => {
  const g = ctx.batchGoal;
  if (!g || typeof g !== "object" || g.cleared || !Array.isArray(g.batchLog)) return [];
  if (!opts.ignoreDecisions && g.decisionCount > 0) return [];
  const hits = g.batchLog.map((m) => findSignPhrase(m, opts)).filter(Boolean);
  return hits.length ? [hits[0] + (hits.length > 1 ? `」等 ${hits.length} 条提交` : "」")] : [];
};

/** AD(批 256,开工单「三之二」第 4 条):本批提交信息里像有已签决定,而决定清单为空 ⇒ **只提示,不阻断**。
 *  硬闸在 `batch-goal --clear`:那里只核**已登记**的决定(`--decision`)有没有 ADR;本条只负责「发现候选」。
 *  为什么不阻断:签字词判不出「新决定 / 执行授权 / 引用旧决定」(codex 256 回件:79 个标题命中里至少 10 个无需新 ADR),
 *  硬拦会把诚实节奏卡在一个语义判断上;用户签的代价模型下误拦与漏放同价,拿不准选不拦。
 *  数据面:`ctx.batchGoal.batchLog` = `git log <baseCommit>..HEAD` 的提交全文(hook 读提交对象注入,不读命令段);
 *  旧批没有基点、离线回放、验收台快照 ⇒ 没有 batchLog ⇒ 本条沉默。
 *  残余:每次 Stop 都会重复提示直到登记决定或结清(宁可吵);签字词写在正文其他语境(「用户签字词」这类元叙述)也会响;
 *  「用户」与动词超过 16 字或跨行会漏;决定清单非空即整条沉默,不逐条对应。 */
const RULE_AD = {
  id: "AD",
  blocking: false,
  law: "docs/laws/reporting.md#开工先立完成条件",
  detect: adDetect(),
  exempts: [],
  message: (hits) =>
    `**本批提交信息里像是有已签的决定,而本批决定清单为空**(${quoteUntrusted(String(hits[0] || ""), 80)})。\n` +
    `      是新决定 ⇒ \`node --no-warnings scripts/batch-goal.mjs --decision "<一句话>"\` 登记(--clear 时会要求对应 ADR 写着该编号);` +
    `只是执行或引用旧决定 ⇒ 忽略本条。只提示,不阻断;误报 → --fp AD 记账。`,
  mutations: [
    { name: "去掉动词前的待/须/未排除", apply: (r) => ({ ...r, detect: adDetect({ noVerbPre: true }) }) },
    { name: "去掉「用户」前的待/须/归排除", apply: (r) => ({ ...r, detect: adDetect({ noUserPre: true }) }) },
    { name: "不看决定清单(登记了也照报)", apply: (r) => ({ ...r, detect: adDetect({ ignoreDecisions: true }) }) },
    { name: "16 字窗口放宽到 60", apply: (r) => ({ ...r, detect: adDetect({ win: 60 }) }) },
    { name: "「批 <数字>」不排除", apply: (r) => ({ ...r, detect: adDetect({ noBatchNum: true }) }) },
  ],
  cases: {
    pos: [
      { name: "AD:用户签", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", decisions: [], batchLog: ["feat(gate): 批 243——K 瘦身(用户签)"] } },
      { name: "AD:夹日期的「用户 2026-09-17 签」(原词表漏的那种)", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", batchLog: ["fix: memory 笔记不算载体\n\n用户 2026-09-17 签"] } },
      { name: "AD:用户裁定(写在正文第二段,heredoc 形提交也看得见)", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", batchLog: ["fix: 判活放宽\n\n背景……\n用户裁定:零对话会话不算活"] } },
      { name: "AD:用户已批准", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", batchLog: ["chore: 无关", "feat: O 改回逐网址(用户已批准)"] } },
    ],
    neg: [
      { name: "AD:待用户亲签不算已签", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", batchLog: ["docs: 呈签单,待用户亲签"] } },
      { name: "AD:用户尚未亲签不算已签", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", batchLog: ["docs: 方案已摊,用户尚未亲签"] } },
      { name: "AD:已登记决定 ⇒ 沉默", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", decisions: [{ id: "256-D1" }], batchLog: ["feat: K 瘦身(用户签)"] } },
      { name: "AD:「用户」与「签」隔 16 字以上 ⇒ 不算", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", batchLog: ["fix: 用户反馈的那条误拦现在已经按照新的判据全部修完并且回归通过,另补签名校验"] } },
      { name: "AD:「批 <数字>」是批号不是批准", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"], baseCommit: "abc1234", batchLog: ["fix: 用户反馈误拦,批 255 修"] } },
      { name: "AD:已结清 ⇒ 沉默", text: "收工。",
        batchGoal: { batch: "256", cleared: true, baseCommit: "abc1234", batchLog: ["feat: 用户签"] } },
      { name: "AD:没有提交全文(旧批无基点/离线回放)⇒ 沉默", text: "收工。",
        batchGoal: { batch: "256", conditions: ["x"] } },
    ],
  },
};

export const RULES = [RULE_O, RULE_V, RULE_W, RULE_Q, RULE_D, RULE_G, RULE_B, RULE_C, RULE_H, RULE_F, RULE_L, RULE_N, RULE_I, RULE_J, RULE_M,
  RULE_E0, RULE_E1, RULE_E2, RULE_K, RULE_K0, RULE_S, RULE_T, RULE_U, RULE_P, RULE_ND, RULE_DP, RULE_X, RULE_AD];
