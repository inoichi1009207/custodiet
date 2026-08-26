import { CARRIER_SURFACE, isDeliverable, CONTENT_WRITE_RE } from "./gate-carriers.mjs";
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

import { quoteUntrusted } from "./gate-ctx.mjs";

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
  message: (hits) =>
    `推面出批但未指出实打实的阻断(命中:${quoteUntrusted(hits[0], 40)})。\n` +
    `      宪法《执行共识》:「归另一入口/另一批」**不构成**推面出批的理由——\n` +
    `      只有**缺凭据 / 站点不可达 / 需亲签**三类才算。工作量大**不在其中**。\n` +
    `      出路二选一:① **当场做掉**;② 写明推迟的是哪一类阻断、具体缺什么。`,
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
 *  七问里 ⑤oracle ⑥最佳实践 ⑦交叉验证已被 P/W 两项动作面接管;③接线无机器判据
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
const actionText = (ctx) => JSON.stringify(ctx.actions);

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
    return (done.length && owed.length) ? done : [];
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
  ],
  cases: {
    pos: [{ text: "九项全部完成。未覆盖一条:取页适配器还没造。" }],
    neg: [
      // ⚠️ 这条原写「九项全部完成,**无未覆盖项**」——而「未覆盖」本身就是欠件模式,
      //   用例自己踩了雷、当场误命中。写反例时要避开被测模式的关键词。
      { text: "九项全部完成,全部落账。" },          // 只有完成断言
      { text: "取页适配器还没造,登记为欠件。" },     // 只有欠件
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
  detect: (ctx) => detectL(ctx),
  exempts: [],
  message: () =>
    `手工清点工具面而未用现成普查器:\`node --no-warnings scripts/tool-usage-census.mjs [--since <日期>|--batches <n>]\``,
  mutations: [
    // 每条 = 同一个 detectL 少一个开关。改 detectL 会同时改到变异体,不会脱钩。
    { name: "去掉普查器豁免", apply: (r) => ({ ...r, detect: (ctx) => detectL(ctx, { censusExempt: false }) }) },
    { name: "去掉手工清点前置", apply: (r) => ({ ...r, detect: (ctx) => detectL(ctx, { requireManual: false }) }) },
    // 回归守卫:这一条**就是今天修掉的那个 bug**。必须有反例逮住它,否则改回去没人知道。
    { name: "回到跨段匹配(旧 [^\"]* 写法)", apply: (r) => ({ ...r, detect: (ctx) => detectL(ctx, { segScoped: false }) }) },
  ],
  cases: {
    pos: [{ text: "扫一下工具面", bash: "ls scripts/*.mjs | wc -l" }],
    neg: [
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
    if (!pathRe.test(p)) continue;
    if (onlyNew && !ctx.isNew(p)) continue;
    out.push(p.split("/").slice(-2).join("/"));
  }
  for (const cmd of ctx.bashCmds) {
    const c = cmd.replace(/\\/g, "/");
    if (!bashWrites(c, pathRe)) continue;
    // ⚠️ **用解析出的写目标,不用 `c.match(pathRe)[0]`**(2026-08-20)。
    //   派生正则是各类 source 用 `|` 拼的,交替支「最左最先」⇒ `m[0]` 是**前缀**:
    //   实测报出 `scripts/hook-`、`scripts/lib/`、`.claude/commands/` 而非文件名,
    //   而这些前缀在 `git ls-files` 里当然不存在 ⇒ `isNew` 恒真 ⇒ **改既有也判新建**。
    //   ⚠️ 这个 bug 我**一小时前刚在旧实现里修过**(`hook-stop-closure.mjs` 的 I 项),
    //   当时只改了那一处,新引擎这份副本原封不动 —— 与「载体清单其实有三份」是同一天、
    //   同一族的第二次:**修一个实现,不等于修好那件事**。全语料上它表现为 `I` 的 6 条残留分歧。
    const targets = bashWriteTargets(c, pathRe);
    if (!targets.length) { out.push("bash-write(未解出目标)"); continue; }
    for (const t of targets) {
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
  // 判据两半都要成立才放行:**说过**「工具面已扫」**且真的读/搜过**在册面。
  detect: (ctx) => {
    const carriers = touched(ctx, CARRIER_RE, true);
    if (!carriers.length) return [];
    const said = matchAny(ctx.text, PAT.scanned).length > 0;
    // 「做了」= 本轮读过或搜过工具面的任一层。从**动作**取,不从文本取。
    // ⚠️ **第四层「搜 GitHub」**(2026-08-20 用户当场加,两句原话:
    //   「工具面如果造的话能不能多来一个『联网搜索』?——要不然联网搜索拿什么闸来防?」
    //   「而且得强调搜 github——得看代码怎么实现的,哪些可以直接装下来用」)。
    //   他指出的是纪律 32 的结构性缺陷:原三层**全是本地的**,而当日手搓的四样东西
    //   现成实现**全在仓外**(redos-detector / @bcoe/v8-coverage / 社区 PreToolUse 先例)
    //   ⇒ **本地三层永远查不到它们**,纪律 32 按原写法防不住那四次。
    //   取 AND 不取 OR:OR 会让「搜了网就不用扫本地」成为逃生口。
    //   代价不对称:误拦=多跑一次搜索;漏放=手搓一个已有实现(当日四次)。
    const LOCAL = /tool-register|known_marketplaces|\.claude\/(commands|skills)/;
    // ⚠️ **必须认 Grep/Glob 工具**(2026-08-20 缝接上后当场暴露):
    //   `ctx.readAny` 只看 `ctx.reads`,而那只收 **Read** 工具的 file_path。
    //   用 Grep 扫 tool-register(最自然的扫法)在引擎里不算「扫过本地」⇒ 误拦。
    //   与 M-6 是同一个病:**按项目工具纪律办事的人被闸罚**
    //   (系统提示明写 Content search: Use Grep)。旧实现扫 `toolRawText` 反而覆盖到了。
    const scannedLocal = ctx.readAny(LOCAL) || ctx.ranBash(LOCAL) ||
      ctx.actions.some((a) => /^(Grep|Glob)$/.test(a.name) &&
        LOCAL.test(String(a.input.path || a.input.file_path || a.input.pattern || "")));
    // ⚠️ **取证窗口放宽到跨轮**(2026-08-20 自签,窄例外③「闸判据过重」)。
    //   实撞:造 `lib/gate-cmd.mjs` 时,联网那层发生在**决定要不要引 shell-quote 的那一轮**,
    //   本地三层扫在**后面一轮**——两件事天然不同轮,而判据要求它们同轮出现,
    //   于是连撞 5 轮,闸自己都在提示「反复撞同一项说明判据有问题,别硬顶」。
    //   纪律 32 管的是「造之前有没有查过」,那是**一个批**的事,不是一个回合的事。
    //   ⇒ 四层证据在**批窗口**内任一轮出现即算数;`ctx.window()` 取不到时退回本轮(fail-closed)。
    //   仍取 AND 不取 OR:OR 会让「搜了网就不用扫本地」成为逃生口。
    const webIn = (c) => !!c && (c.toolNames.some((n) => /^(WebSearch|WebFetch)$/.test(n)) ||
      c.ranBash(/(^|[\s;&|])gh\s+(search|api|repo)/));
    const localIn = (c) => !!c && (c.readAny(LOCAL) || c.ranBash(LOCAL) ||
      c.actions.some((a) => /^(Grep|Glob)$/.test(a.name) &&
        LOCAL.test(String(a.input.path || a.input.file_path || a.input.pattern || ""))));
    let win = null;
    try { win = ctx.window(); } catch { win = null; }
    const searchedWeb = webIn(ctx) || webIn(win);
    const acted = (scannedLocal || localIn(win)) && searchedWeb;
    return (said && acted) ? [] : carriers.slice(0, 4);
  },
  exempts: [],
  message: (hits) =>
    // D17 对照(2026-08-23):原消息列**三层**而判据要求**四层 AND**(本地任一 + 联网),
    // 出路句也只说「写一行」而判据是「说了且做了」——消息按判据对齐,不动判据。
    `新建载体未留「工具面已扫」痕迹(纪律 32,本轮新建:${hits.join(", ")})。\n` +
    `      **判据=本地①②③任一层的动作 + ④联网搜索,缺任一半即拦(窗口内任一轮算数)**,\n` +
    `      漏一层就可能手搓已有实现(2026-08-19 实撞:只扫①仍手搓出官方 agent-creator):\n` +
    `      ① docs/tool-register.md 在册件与已装插件\n` +
    `      ② ~/.claude/plugins/known_marketplaces.json 里**已在册未装**的市场\n` +
    `      ③ 本项目已有的封装(.claude/commands|skills)——绕过封装直调底层=丢掉封装里的纪律\n` +
    `      ④ 联网搜同类实现(WebSearch/WebFetch 或 gh search)——现成件常在仓外,本地三层查不到\n` +
    `      ⚠️ **搜索的键必须是「你要解决的问题」,不是「你打算写的实现」**。\n` +
    `      2026-08-20 实撞:造 shell 词法器时我搜的是 shell|quote|shlex|token|词法,报「无命中」。\n` +
    `      而当时真正该用的工具是 **oracle**(它回答「我怎么知道判据够不够」)——它不是词法器,\n` +
    `      **按那种扫法永远扫不到**。当日每一次扫工具面都是这个毛病。\n` +
    `      出路:**先用一句话写出你要解决的问题,拿它当搜索键**,\n` +
    `      真扫一遍(本地任一层 + 联网,两半都要),再写一行「工具面已扫:命中 X / 无命中」——只写不扫不放行`,
  mutations: [
    // 分支①:把「说了且做了」松成「说了就行」⇒ 只写一行字的正例会被放过
    { name: "豁免退回纯文本(说了就行)", apply: (r) => ({ ...r, detect: (ctx) => {
      const carriers = touched(ctx, CARRIER_RE, true);
      if (!carriers.length) return [];
      return matchAny(ctx.text, PAT.scanned).length ? [] : carriers.slice(0, 4);
    } }) },
    // 分支②:去掉 isNew ⇒ 改既有载体也会被拦(这正是 2026-08-19 连拦三次的那个 bug)
    { name: "去掉「新建」限定(改既有也算造)", apply: (r) => ({ ...r, detect: (ctx) => {
      const carriers = touched(ctx, CARRIER_RE, false);
      if (!carriers.length) return [];
      const said = matchAny(ctx.text, PAT.scanned).length > 0;
      const acted = ctx.readAny(/tool-register|known_marketplaces|\.claude\/(commands|skills)/) ||
                    ctx.ranBash(/tool-register|known_marketplaces|\.claude\/(commands|skills)/);
      return (said && acted) ? [] : carriers.slice(0, 4);
    } }) },
  ],
  cases: {
    pos: [
      { text: "新建了一个 agent。", write: "/repo/.claude/agents/_foo.md" },
      // 只说不做:写了「工具面已扫」但本轮没有任何读取动作 ⇒ 仍应命中
      { text: "工具面已扫:无命中。", write: "/repo/.claude/agents/_bar.md" },
    ],
    neg: [
      // 说了且做了
      // ⚠️ `web:` 是四层扩容后必须的:只扫本地不再算「已扫」。
      { text: "工具面已扫:四层无命中。", write: "/repo/.claude/agents/_baz.md",
        read: "/repo/docs/tool-register.md", web: "existing agent-builder impl" },
      // 改的是**既有**载体(tracked 注入),不是造物
      { text: "改了一行既有脚本的注释。", write: "/repo/scripts/hook-stop-closure.mjs",
        tracked: ["scripts/hook-stop-closure.mjs"] },
      { text: "今天只写了报告,没碰载体。" },
    ],
  },
};

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
        written: "本条触发层:每会话加载(法典层),`/consistency-check` 关账必跑。" },
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
  message: (hits) =>
    `经 Bash 改文件但未回读验证:${hits.join(", ")}\n` +
    `      **node -e / sed -i / 重定向 替换失败时静默成功**——脚本照常退出 0、照常打印你写的 echo,而文件一字未动。\n` +
    `      出路只有一条:**真回读**(Read / Grep / grep / cat / git diff 指向同一路径)。\n` +
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

// ── E0 / E1 / E2:因果断言的两半复核 ────────────────────────────────────────
//
// 纪律 32② 明写「一个管**形**、一个管**独立性**,**不互斥**」——两半都要做,不是二选一。
// 旧实现把豁免写成「发了 codex 即通过」,等于给 oracle 那一半留了永久逃逸口。
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

/** 三条共用的事实。抽出来是刻意的:口径只写一处,拆开写必漂移。 */
function eFacts(ctx) {
  // ⚠️ **因果匹配跑在剥掉引文之后**(2026-08-22 实撞两连响修的):
  //   E2 的声明检查早就剥 `「…」«…»“…”"…"`,E0 的因果匹配却一直跑在原文上,
  //   于是 `PAT.causal` 的「让…它」跨过引号边界咬合(「让」在引文里、「它」在引文外),
  //   **引用一句被拦的话来处置它 ⇒ 处置本身再被拦** —— 回声族,与 S/E2 同修法。
  //   机械证据:probe 实测 #4 咬住『…让未来会话能召回」。拿它』这个跨界片段。
  //   方向说明:引文=提及不是使用;真因果断言写在引号里当强调的形态,按代价不对称
  //   (漏这一形态的代价是少拦一句,误拦回声的代价是处置循环)取放行侧。
  const eTxt = String(ctx.text || "").replace(/「[^」]*」|«[^»]*»|“[^”]*”|"[^"]*"/g, " ");
  const hits = matchAny(eTxt, PAT.causal);
  const acted = JSON.stringify(ctx.actions);
  return {
    hits,
    // 自标:只豁免「独立性」,**不豁免「形」**——「我不确定」与「有没有办法确定」是两件事。
    hedged: /UNVERIFIED|未核实|证据不足|这(仍)?是(我的)?推断|标注?为推断/.test(ctx.text),
    // 独立性那一半:**动作面**。三条通路都认(脚本 / MCP / battle)。
    crossChecked: ctx.ranBash(/codex-run\.mjs|CODEX_JOB=/) ||
      ctx.toolNames.some((n) => /mcp__codex-cli__codex/.test(n)) ||
      ctx.skills.some((s) => /battle/.test(s)),
    // 形那一半:真跑了 oracle,或真跑了机械探针。同样只看动作。
    shaped: ctx.skills.some((s) => /^oracle[:-]/.test(s)) || ranProbe(acted),
  };
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
    const eTxt = String(ctx.text || "").replace(/「[^」]*」|«[^»]*»|“[^”]*”|"[^"]*"/g, " ");
    const declHasOracle = /机械判据\s*[:：]\s*(?!无|没有|不可|未)\S/.test(eTxt);
    const declNoOracle = /判据(为|是)?\s*[:：]?\s*(无|没有)|不可机械核定|无可跑的检验/.test(eTxt);
    // 「无判据」那一档要附一条**能接手的动作**,不能是句号。
    //   sharpen 是多 agent 管线只能用户下,故做成**必填后续**而非独立出路——
    //   一条「这个得你去跑」的一句话出路会变成最便宜的逃生口,吞掉其余出路
    //   (当日实测过同型塌方:自标 8 次 : oracle 1 次)。
    const handedSharpen = /\/oracle:sharpen\s+\S/.test(ctx.text);
    if (f.shaped || declHasOracle || (declNoOracle && handedSharpen)) return [];
    return f.hits;
  },
  exempts: [],
  message: (hits) =>
    `因果断言未过**形**那一半:没问过「有没有机械判据」。**自标「这是推断」不豁免本项**` +
    `——承认不确定 ≠ 找过判据。两条出路:\n` +
    `      ① 真去找:能造机械判据→跑探针或 oracle:compile+run;造不出→oracle:reason 出结构\n` +
    `      ② **就地声明**:「机械判据:已跑X」/「有但未跑,因…」\n` +
    `         ⚠️ **「无,因该命题不可机械核定」这一档不能只说一句**——判据额外要求你\n` +
    `         **递出 \`/oracle:sharpen <这条怎么验>\`**(理由:「没有判据」这句话本身最容易被\n` +
    `         当成万能出路;要说它,就得先真去找过)。消息此前没写这一条,而判据一直在要,\n` +
    `         于是照消息答的人被反复阻断 —— 2026-08-20 我自己连撞四轮才发现\n` +
    `         (grill:error-handling §2③ 早报过,我登记了没修)。\n` +
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
    ],
    neg: [
      { text: "根因是路径写错。机械判据：已跑 verify-laws，退出码 0。" },
      // ⚠️ **全角冒号**那一档:旧实现在这里漏了整整一天
      { text: "根因是路径写错。机械判据：有但未跑，因配额耗尽。" },
      { text: "根因是路径写错。机械判据：无，不可机械核定。已递 `/oracle:sharpen 这条该怎么验`" },
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
    return f.hits;
  },
  exempts: [],
  message: (hits) =>
    `裸因果断言:未复核且未自标(${hits.length} 处)。三条出路任选其一——\n` +
    `      ① 跨模型复核:codex / battle\n` +
    `      ② 先问有没有机械判据:能造→跑探针或 oracle:compile+run;造不出→oracle:reason(产物标 UNVERIFIED)\n` +
    `      ③ **就地自标**「这是推断 / 证据不足 / 未核实」——成本一句话,且比前两条更常是正确答案\n` +
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
      const shaped = ctx.skills.some((s) => /^oracle[:-]/.test(s)) || ranProbe(JSON.stringify(ctx.actions));
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
  return (ctx.actions || []).some((a) =>
    segments(a.input?.command).some((seg) =>
      /(^|[\s/\\])(node\s+[^;|]*)?[\w./\\-]*batch-goal\.mjs[^"']*--clear\b/.test(stripQuoted(seg))));
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
  // 条件阻断:平时提示,**收尾动作发生时**升阻断——那一刻没有验收标准,等于没有验收。
  // ⚠️ **两个收尾动作,不是一个**(2026-08-20 用户问「不结清为什么 hook 还过了」时补的)。
  //   原判据只认 `didCommit()`,于是有一个洞,实测三场景坐实:
  //     ① 一条验收标准都不对照、直接跑 `--clear` ⇒ K 只**提示**,拦不住;
  //     ② `--clear` 生效之后再回看 ⇒ **零命中**,连痕迹都不剩。
  //   ⇒ **可以一条条件都不兑现就把批关掉,全程无人拦。**
  //   本项的出路文本自己写着「全部办完后 `--clear`」,而那句话此前没有任何闸兜着——
  //   又一次「规则写在消息里,不写在判据里」。
  //   `ranClear` 走**动作面**:文本里提到 `--clear` 不算数(同 didCommit 那次的修法)。
  // ⚠️ **第三个升阻断的时机:批在漂**(2026-08-20 用户裁定后补)。
  //   用户原话:「一个开着的批该不该每轮都拦——实际上不该,因为确实有些我要跟你讨论的情况。」
  //   ⇒ 该判的不是「批开着没」,是「**本轮有没有推进这个批**」。三种回合分开:
  //     · 纯讨论(无写无提交)⇒ 提示 + systemMessage 提醒,**不拦**(讨论空间在这里);
  //     · 有提交/结清而条件没对照 ⇒ 拦(上面两条);
  //     · **连着几轮在写东西却一条条件都没裁** ⇒ 这一格此前没人管,
  //       而「干着干着就散了」正是批机制存在的理由。
  //   判据用刚接上的批窗口:窗口内**有写动作的回合数** ≥ 阈值且**全窗口零裁决** ⇒ 升阻断。
  //   纯讨论轮不计数,所以不影响正常对话。
  blocking: (ctx) => ctx.didCommit() || ranClear(ctx) || batchDrifting(ctx),
  law: "AGENTS.md#恒定条款",
  requires: ["batchGoal"],
  detect: (ctx) => {
    const g = ctx.batchGoal;
    // 三态区分保留;`undefined` 的处置**已上移到契约层**(registry 的 requires):
    //   规则不再自己把「通道缺席」判成「没命中」——那是 codex 判死的 fail-open。
    if (!g || g.cleared) return [];                       // 无状态 / 已结清 ⇒ K0 的地盘
    const conds = Array.isArray(g.conditions) ? g.conditions : [];
    if (!conds.length) return [];                         // ⇒ K0
    // ⚠️ **裁决在批窗口内给过就算数,不必每轮重写**(2026-08-20 实撞,codex P4)。
    //   原判据只看**本轮文本** ⇒ 逐条对照写过一次之后,下一轮说句别的它又报,
    //   而提示走 `additionalContext`(官方语义「keep the turn going」)⇒ 每轮空烧一轮。
    //   我上一条消息还把这个形态登记成「P4 未修」然后继续 —— **当场演示了它自己**,
    //   也正是用户批评过的「登记当处置」。
    //   修法用的就是同批刚接上的 `ctx.window()`:窗口取不到时退回本轮(fail-closed)。
    // ⚠️ **同一轮里武装了新批 ⇒ 本轮的裁决不算数**(grill:edge-cases E9)。
    //   条件编号按下标对齐(条件1/2/3),而「关旧批 + 开新批」同轮发生时,
    //   正文里裁的是**旧批**的 1-3,盘上却已是新批 ⇒ 新批开工当轮即被判「已全部对照」。
    //   台账实况就是这个节奏(08:49 clear 072 / 08:52 arm 073)。
    //   不取「裁决必须带批号」那条更彻底的修法:它会改变一个每天都在用的书写格式,
    //   且旧写法会全部失效 ⇒ 一段时间内对所有人误报。这条只在同轮 arm 时收紧,面窄得多。
    const armedNow = ranArm(ctx);
    // ⚠️ **E9 收窄为三分支**(2026-08-25,批 101/D46;fp 台账 K 一笔=七连撞 090…096)。
    //   E9 原判「同轮 arm ⇒ 本轮裁决全不认」,防的是「关旧批+开新批同轮,正文裁的是
    //   旧批的 1-3、盘上已是新批」的编号错位。但它把 **solo arm**(开工武装本批、
    //   当轮办完、当轮裁本批)一并误伤:此时裁决指向的就是刚 arm 的批,错位无从发生。
    //   探针(scratchpad/d101-replay.mjs)对 01:01/02:07 两撞轮直证:armedNow=真、
    //   裁决行在末条文本块、同轮无 --clear——文本侧从来没缺,缺的是这一格判据。
    //   三分支:
    //     · 同轮 arm+clear(关旧开新/现造证据)⇒ 裁决全不认(E9 原样保留);
    //     · solo arm ⇒ 只认**本轮**裁决——窗口裁决属旧批,认了就是 E9 要防的错位;
    //     · 无 arm ⇒ 本轮+窗口(现行)。
    const closedToo = armedNow && ranClear(ctx);
    const done = closedToo ? new Set() : confirmedConditions(ctx.text);
    if (!armedNow) {
      let win = null;
      try { win = ctx.window(); } catch { win = null; }
      if (win) for (const n of confirmedConditions(win.text)) done.add(n);
    }
    // ⚠️ **「未达成」不再是出门证**(2026-08-20 用户点破:「你没做完本来就不应该拦」)。
    //   裁成「未达成」而**本轮没标 `⏸`** ⇒ 视同没裁,照报。标了 ⏸ 即正当停工,放行。
    //   见 `unmetConditions` / `declaredPause` 头注。
    if (!declaredPause(ctx)) for (const n of unmetConditions(ctx.text)) done.delete(n);
    return conds.map((t, i) => ({ n: i + 1, t: String(t || "") })).filter((c) => !done.has(c.n));
  },
  // **无豁免,而且是对的**。我第一版给它挂了个 `properClose` 动作豁免,是凭空加的:
  //   旧实现的 properClose 只用在 `cleared` 那一支(K0 的地盘),K 自己从来没有。
  //   K 在正常关账那一刻本来就不响——`--clear` 跑完磁盘已是 cleared,
  //   `detect` 第一行直接返回空。挂个永远轮不到的豁免只会让人以为它在挡什么。
  //   发现方式:变异「去掉正常关账豁免」**找不到证人**——一条谁都杀不死的豁免,
  //   通常不是测试没写好,是它本来就没在工作。
  exempts: [],
  message: (hits, ctx) => {
    const g = ctx.batchGoal || {};
    // 用 `conditionCount` 而非 `conditions.length`:该字段存在的理由就是
    // 「中和不改变计数」,而它此前**全仓零消费**(grill E10)——注释宣称的消费者不存在。
    // 与其删字段,不如让宣称成真:这里就是它的消费者。
    const total = g.conditionCount || (Array.isArray(g.conditions) ? g.conditions.length : hits.length);
    const committed = ctx.didCommit();
    return `批 ${g.batch || "?"} 的完成条件未逐条对照(${hits.length}/${total} 条未确认)` +
      `${committed ? "——**本轮已提交,收尾前必须逐条写明**" : ""}:\n` +
      hits.map((c) => `      条件${c.n}: ${c.t}`).join("\n") +
      `\n      出路:逐条写「条件N:达成/未达成/不适用」+ 一句证据;全部办完后 ` +
      `node --no-warnings scripts/batch-goal.mjs --clear`;
  },
  mutations: [
    // 分支①:退回裸文本判提交 ⇒ 读到含 `git commit` 的文档就升阻断(旧实现的真 bug)
    { name: "阻断判据退回裸文本", apply: (r) => ({ ...r, blocking: (ctx) => /\bgit\s+commit\b/.test(ctx.text) }) },
    // 分支④:只认提交、不认 --clear ⇒ 一条条件都不对照就能把批关掉(2026-08-20 实撞的洞)
    { name: "收尾动作只认提交", apply: (r) => ({ ...r, blocking: (ctx) => ctx.didCommit() }) },
    // 分支②:去掉全角冒号 ⇒ 「条件1:达成」这种全角写法不算数,正常收尾被误拦
    { name: "冒号只认半角", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared) return [];
      const conds = Array.isArray(g.conditions) ? g.conditions : [];
      if (!conds.length) return [];
      const done = new Set();
      for (const m of String(ctx.text || "").matchAll(/条件\s*(\d+)\s*:\s*(达成|未达成|已达成|不适用)/g)) done.add(Number(m[1]));
      return conds.map((t, i) => ({ n: i + 1, t: String(t || "") })).filter((c) => !done.has(c.n));
    } }) },
    // 分支⑤:「未达成」重新算数(还原 2026-08-20 之前的行为)⇒ 写一句「未达成」就能出门。
    //   证人 = pos ㈣㈤(未达成无 ⏸)。没有这条变异,本次收紧改回去也没人发现。
    { name: "未达成也算已裁", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared) return [];
      const conds = Array.isArray(g.conditions) ? g.conditions : [];
      if (!conds.length) return [];
      const armedNow = ranArm(ctx);
      const done = armedNow ? new Set() : confirmedConditions(ctx.text);
      if (!armedNow) {
        let win = null;
        try { win = ctx.window(); } catch { win = null; }
        if (win) for (const n of confirmedConditions(win.text)) done.add(n);
      }
      return conds.map((t, i) => ({ n: i + 1, t: String(t || "") })).filter((c) => !done.has(c.n));
    } }) },
    // 分支⑥:⏸ 不再放行 ⇒ 正当停工也被拦死(收紧过头的那一侧,证人 = neg 第一条)
    { name: "⏸ 不算正当停工", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared) return [];
      const conds = Array.isArray(g.conditions) ? g.conditions : [];
      if (!conds.length) return [];
      const done = confirmedConditions(ctx.text);
      for (const n of unmetConditions(ctx.text)) done.delete(n);
      return conds.map((t, i) => ({ n: i + 1, t: String(t || "") })).filter((c) => !done.has(c.n));
    } }) },
    // 分支⑦:solo arm 也清空本轮裁决(还原 2026-08-25 之前的 E9 全宽形态)⇒
    //   小批当轮办完照样被判「全未确认」——七连撞原样复活。证人 = neg「solo arm 当轮裁本批」。
    { name: "solo arm 也清空本轮裁决", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared) return [];
      const conds = Array.isArray(g.conditions) ? g.conditions : [];
      if (!conds.length) return [];
      const armedNow = ranArm(ctx);
      const done = armedNow ? new Set() : confirmedConditions(ctx.text);
      if (!armedNow) {
        let win = null;
        try { win = ctx.window(); } catch { win = null; }
        if (win) for (const n of confirmedConditions(win.text)) done.add(n);
      }
      if (!declaredPause(ctx)) for (const n of unmetConditions(ctx.text)) done.delete(n);
      return conds.map((t, i) => ({ n: i + 1, t: String(t || "") })).filter((c) => !done.has(c.n));
    } }) },
    // 分支⑧:solo arm 连窗口裁决也认(fail-open 那一侧)⇒ 旧批的裁决行还留在窗口里,
    //   新批开工当轮即被判「已全部对照」——E9 立法要防的错位复活。证人 = pos「solo arm 窗口旧裁决不算」。
    { name: "solo arm 连窗口裁决也认", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g || g.cleared) return [];
      const conds = Array.isArray(g.conditions) ? g.conditions : [];
      if (!conds.length) return [];
      const done = confirmedConditions(ctx.text);
      let win = null;
      try { win = ctx.window(); } catch { win = null; }
      if (win) for (const n of confirmedConditions(win.text)) done.add(n);
      if (!declaredPause(ctx)) for (const n of unmetConditions(ctx.text)) done.delete(n);
      return conds.map((t, i) => ({ n: i + 1, t: String(t || "") })).filter((c) => !done.has(c.n));
    } }) },
    // 分支③:不看 cleared ⇒ 已结清的批还在被 K 追着要对照,而那是 K0 的地盘
    { name: "无视已结清", apply: (r) => ({ ...r, detect: (ctx) => {
      const g = ctx.batchGoal;
      if (!g) return [];
      const conds = Array.isArray(g.conditions) ? g.conditions : [];
      if (!conds.length) return [];
      const done = confirmedConditions(ctx.text);
      return conds.map((t, i) => ({ n: i + 1, t: String(t || "") })).filter((c) => !done.has(c.n));
    } }) },
  ],
  cases: {
    pos: [
      { text: "干完了,提交。", batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // ⚠️ 下面两条是**成对**的,分别钉住「裸文本判提交」这个旧 bug 的两个方向。
      //   缺任何一条,`blocking` 改成读文本都测不出来(两边签名相同 ⇒ 变异无证人),
      //   而那正是本次迁移收益最大的一处修复。
      //   ㈠ 真提交了 ⇒ 必须阻断(文本里一个字都没提 commit)
      { text: "都办完了。", commit: true, batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      //   ㈡ 只是**读到/引用**了 `git commit` 这串字 ⇒ 只提示不阻断
      { text: "文档里给的命令是 git commit -m x,先不跑。", batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      //   ㈢ **一条都没对照就跑 `--clear`** ⇒ 必须阻断。缺这条,分支④那个洞测不出来。
      { text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // 只对照了一条,另一条仍欠
      { text: "条件1: 达成。", batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // 全角冒号必须算数 ⇒ 这里只认了 1,2 仍欠 ⇒ 仍命中
      { text: "条件1：达成。", batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // ㈣ **裁成「未达成」却没标 ⏸ ⇒ 照拦**(2026-08-20 用户点破的洞,回归证人)。
      //   旧行为:写一句「未达成」就放行 ⇒ 拿文本声明当结构义务的履行,与 P 的纯文本豁免同病。
      { text: "条件1: 达成。条件2：未达成。", batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // ㈤ 全部「未达成」且无 ⏸ ⇒ 照拦(两条都欠,不是只欠一条)
      { text: "条件1: 未达成。条件2: 未达成。下次再说。",
        batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // ㈥ **solo arm 时窗口里的旧裁决不算数**(2026-08-25 E9 收窄的守住那半):
      //   旧批的「条件1: 达成」还留在窗口文本里,本轮 arm 了新批且没给任何本轮裁决 ⇒ 照拦。
      //   杀分支⑧;缺这条,「solo arm 连窗口也认」改回去没人发现。
      { text: "开工,已武装,先干活。", commit: true,
        bash: 'node --no-warnings scripts/batch-goal.mjs --arm 095 --cond "丙"',
        prior: [{ text: "条件1: 达成。上批收工。" }],
        batchGoal: { batch: "095", conditions: ["丙"] } },
      // ㈦ **同轮 arm+clear ⇒ 裁决全不认**(E9 原防线保留的回归证人):
      //   关账证据现造(同轮既武装又结清),裁决行写得再全也照拦。
      { text: "条件1: 达成。收工。",
        bash: ['node --no-warnings scripts/batch-goal.mjs --arm 096 --cond "丁"',
               'node --no-warnings scripts/batch-goal.mjs --clear'],
        batchGoal: { batch: "096", conditions: ["丁"] } },
    ],
    neg: [
      // 两条都给了裁决(半角 + 全角混用),**且未达成那条标了 ⏸** ⇒ 正当停工,放行。
      //   ⚠️ 2026-08-20 改:原写法没有 ⏸ 却期望放行——**它编码的正是用户当天点破的洞**
      //   (「你没做完本来就不应该拦」)。同一输入已挪进 pos 当回归证人。
      { text: "条件1: 达成。条件2：未达成。⏸ 需要你确认:乙要不要做。",
        batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // **solo arm 当轮裁本批 ⇒ 放行**(2026-08-25,D46 七连撞的修法证人;杀分支⑦):
      //   开工武装本批、当轮办完、当轮逐条裁——裁决指向的就是刚 arm 的批,编号错位无从发生。
      //   探针 scratchpad/d101-replay.mjs 对真实撞轮(01:01/02:07)直证此形态被旧判据误拦。
      { text: "条件1: 达成。已提交。", commit: true,
        bash: 'node --no-warnings scripts/batch-goal.mjs --arm 093 --cond "甲"',
        batchGoal: { batch: "093", conditions: ["甲"] } },
      // 全部达成 ⇒ 放行(「达成」这一侧不受本次收紧影响,钉住它)
      { text: "条件1: 达成。条件2：不适用。", batchGoal: { batch: "099", conditions: ["甲", "乙"] } },
      // 已结清 ⇒ 归 K0 判,K 不响
      { text: "干完了。", batchGoal: { batch: "099", conditions: ["甲"], cleared: true } },
      // 「查过了,没有批次状态」⇒ 归 K0。**必须显式供 null**:
      // 省略这条通道现在是 UNKNOWN 阻断(契约层),不再是静默放行。
      { text: "干完了。", batchGoal: null },
      // ⚠️ **纯讨论轮不算漂**(用户 2026-08-20 亲裁:「确实有些我要跟你讨论的情况」)。
      //   窗口里连写三轮零裁决,但本轮只是回答问题、没动工作面 ⇒ 不该升阻断。
      //   第一版漏了「本轮也得在写」这个条件,于是漂了之后**连纯讨论轮都被拦**:
      //   用户问一句「这个字段干嘛的」,闸把回答挡住。实测当场暴露,这条钉住它。
      { text: "条件1: 达成。条件2: 达成。这个字段是干嘛的?",
        prior: [{ text: "改", write: "scripts/a.mjs" }, { text: "改", write: "scripts/b.mjs" },
                { text: "改", write: "scripts/c.mjs" }],
        batchGoal: { batch: "073", conditions: ["甲", "乙"] } },
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
const k0Bookkeeping = (ctx) => ctx.writes.length &&
  ctx.writes.every((w) => /docs\/gate-debts\.md$/.test(String(w).replace(/\\/g, "/")));

const RULE_K0 = {
  id: "K0",
  blocking: (ctx) => ctx.didCommit(),
  law: "AGENTS.md#恒定条款",
  requires: ["batchGoal"],
  // 判据取**最结构化的近似**:本轮动了工作面(写文件/提交)就该先有完成条件。
  // 纯问答、纯调查没有写动作 ⇒ 不触发,本项不会退化成仪式。
  detect: (ctx) => {
    const g = ctx.batchGoal;
    const armed = g && !g.cleared && Array.isArray(g.conditions) && g.conditions.length > 0;
    if (armed) return [];                                  // 已武装 ⇒ K 的地盘
    // ⚠️ `ctx.writes`(写**动作**)不是 `ctx.written`(写进去的**正文**)——
    //   我第一版写成了后者,于是「改了个文件但没往里写字」判为没动工作面。
    //   两个名字差一个字母而语义完全不同,迁移时值得每次确认一遍。
    if (!ctx.writes.length && !ctx.didCommit()) return []; // 没动工作面 ⇒ 不管
    // ⚠️ **债表簿记豁免**(2026-08-26,批 106;fp 台账「批间补救」形态四犯的兑现修法):
    //   本轮写面**仅**触 docs/gate-debts.md(债务台账)⇒ 不算未武装动工——
    //   给已发生的事登记欠账正是验收机制自身的簿记,逼它开新批=纯 arm/clear churn
    //   (08-23 两笔 claimed_fp + 08-26 两撞,四犯)。边界:任何其他路径混入写面即照拦
    //   (「顺手把修法也做了」不属簿记);零写面纯提交不豁免(commit 内容无从核,fail-closed)。
    if (k0Bookkeeping(ctx)) return [];
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
  message: (hits, ctx) =>
    `本轮动了工作面却**未武装完成条件**(${hits[0]})` +
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
    ],
    neg: [
      // 纯问答,没动工作面
      { text: "这个字段是干嘛的?", batchGoal: null },
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
      // **债表簿记豁免**(2026-08-26,批 106;fp「批间补救」四犯的兑现修法;杀分支④):
      //   结清后给已发生的事在 docs/gate-debts.md 登记一笔并提交 ⇒ 不算未武装动工。
      { text: "把这笔实斑登进债表,提交。", write: "docs/gate-debts.md", commit: true,
        batchGoal: { cleared: true, batch: "105", closedConditions: ["甲"] } },
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
    const asks = matchAny(sTxt, PAT.handoff);
    if (!asks.length) return [];
    // **「陈述某事归你」≠「停下来等你」**——还得真的在问(问号 / 显式等待动词)。
    // 缺这一条会误伤合法的推迟(Q 的地盘),当日实撞过一次。
    if (!matchAny(sTxt, PAT.askMark).length) return [];
    // 第一问:按规矩停了吗(结构锚)
    if (!matchAny(sTxt, PAT.waitMark).length) return ["把决定推回给用户,却没标 ⏸"];
    // 第二问:标了 ⇒ 理由须落在三类之内。标记本身罕见,这里误报成本低。
    if (!matchAny(sTxt, PAT.stopReason).length) return ["标了 ⏸ 但未说明属哪一类合法停工理由"];
    return [];
  },
  // 无豁免:阻断项不认文本豁免(INV-1),而「我这次问得有道理」正是文本豁免。
  exempts: [],
  message: (hits) =>
    `${hits[0]}。合法停工只有三类:**不可逆 / 需你亲签 / 实打实阻断**(缺凭据、站点不可达、只有用户能触发)。\n` +
    `      「工作量大」「拿不准要不要做」「这是产品取舍吧」都**不在其中**——\n` +
    `      多数时候答案已经写在代价不对称里:误报当场可见可人工放行,漏放进下游难发现,\n` +
    `      **拿不准按「太松」报**。按这条,绝大多数「要不要做 X」根本不用问。\n` +
    `      出路:要么自己定并写明依据,要么标 ⏸ 并写清属三类中的哪一类。`,
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
    ],
    neg: [
      // 合法停工:标了且属亲签面
      { text: "⏸ 需要你确认：这一行要不要加进冲突表——改宪法需你亲签。" },
      // 合法停工:实打实阻断
      { text: "⏸ 需要你确认：这条通道只有用户能触发（缺凭据），我这边站点不可达。" },
      // 根本没推回给用户:自己定了
      { text: "按代价不对称，误报便宜，直接选 B，已实现并验证。" },
      // 等机器不算停工
      { text: "codex 回件还没到，等它回来我逐条读。" },
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
    `      出路：① **当场修掉**,且别在正文复述登记句(要提就用「」引号引用——判据剥引号)；
` +
    `      ② 写明失效期（「下一批必修」/「N 批内复议」/具体日期）**并且本批过一次独立复核**
` +
    `      （codex / 子代理 / 联网任一——批的人不能是想要豁免的人）。仅写「已登记」等于静默改规矩。`,
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
      // 引用闸的报告不算（回声族，同 Q）
      { text: "闸说「已登记未修」不算处置。所以我当场修掉了。" },
      // 根本没提登记
      { text: "三条都当场修掉了，验收全过。" },
    ],
  },
};

// ── U：Skill 调用未闭环 ───────────────────────────────────
// 立法动机（2026-08-20 用户实撞）：我 `Skill(oracle:sharpen)` 把指令载进上下文，
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
//   写一句「oracle 跑了」就能过 —— 但那至少把它重新提到台面上，
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
    const artifact = /oracle[\/]|clipboard[\/]mapgen[\/]|\.consistency-suite-test[\/]/;
    // ⚠️ **闭环证据必须也在窗口里找**（2026-08-20 实撞，当日第二次同形）。
    //   第一版只在**本轮**找证据（正文提到 / 本轮写了产物），
    //   而窗口里那次 Skill 调用一直在 ⇒ **只要哪一轮不提它，就再响一次**。
    //   实撞：`oracle/sharpen/gate-recall-2026-08-20.md` 两轮前已写并提交，
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
  message: (hits) =>
    `批窗口内调过 Skill 却**至今无下文**：${hits.join(", ")}。
` +
    `      法条：「**发起即欠账** —— 凡委派出去的任务，发起那一刻就成为本批欠账」（collab 四之三）。
` +
    `      实撞：我 Skill(oracle:sharpen) 把指令载进来，被一条新消息打断、转头改别的，
` +
    `      **那次调用就此消失**；用户原话「要不是刚才我问一下现在根本没得管」。
` +
    `      出路：① **把它跑完**；② 正文里交代它结果如何；③ 明写为何不跑了。
` +
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
      // 实撞形态：上轮调了 oracle，本轮去改别的了，一字未提
      { text: "把 I 项的消息改了。",
        prior: [{ text: "发 skill", skill: "oracle:sharpen" }] },
    ],
    neg: [
      // 正文里交代了
      { text: "oracle:sharpen 没跑——我加载了然后被打断，现在补上。",
        prior: [{ text: "发 skill", skill: "oracle:sharpen" }] },
      // ⚠️ **已关就是已关**：窗口里交代过了，本轮不提也不该再响。
      //   缺这条，U 会在每一轮不提它的消息上重复命中（实撞过）。
      { text: "接着改别的了。",
        prior: [{ text: "oracle:sharpen 跑完了，产物已落盘。", skill: "oracle:sharpen" }] },
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

    /** 这条命令是不是**一次承重面提交**:有真 commit 段 + 有带承重路径的 git 段。
     *  ⚠️ 2026-08-22 改(codex 全量分类逼出的真回归):原式整段走 stripQuoted ⇒
     *  `git add -A "scripts/x.mjs"` 的**引号路径被剥瞎**,真承重提交判成不是(86 条
     *  「旧有新无」分歧里 43 条 didCommit=true 的主嫌)。
     *  修法分两半,**方向相反**,不许合并:
     *    · `-m/-F` 的 message 载荷**先剥掉**——提交信息里提到路径=提及不是暂存,
     *      这是已写明并接受的 CEILING(见上方头注),必须保住;
     *    · 其余只去引号**字符**——引号路径的 add/commit 是真暂存,必须认。 */
    isCarrierCommitCmd(cmd) {
      const H = RULE_P._p, raw = segments(cmd);
      const committed = raw.some((s) => H.GIT.test(s) && /\bcommit\b/.test(s) && !/--dry-run/.test(s));
      if (!committed) return false;
      return raw.some((s) => {
        const noMsg = s.replace(/(?:-m|--message|-F|--file)(?:\s+|=)(?:"[^"]*"|'[^']*'|\S+)/g, " ");
        const u = H.unquote(noMsg);
        return H.GIT.test(u) && /\b(add|commit)\b/.test(u) && CARRIER_SURFACE.test(u);
      });
    },
    carrierCommitCount(c) {
      if (!c || !Array.isArray(c.bashCmds)) return 0;
      return c.bashCmds.filter((cmd) => RULE_P._p.isCarrierCommitCmd(cmd)).length;
    },

    /** 触发面 = 本轮真提交过 且(本轮写过承重件 或 提交命令的参数面上有承重路径)。 */
    triggered(ctx) {
      if (!ctx || typeof ctx.didCommit !== "function" || !ctx.didCommit()) return false;
      if (RULE_P._p.carrierCommitCount(ctx) > 0) return true;
      return (ctx.writes || []).some((p) => CARRIER_SURFACE.test(String(p).replace(/\\/g, "/")));
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
      { key: "独立视角(只读子代理:判「我漏了什么」)",
        test: (a) => /^(Agent|Task)$/.test(String(a.name || "")) &&
          /^(grill:|_)/.test(String((a.input && (a.input.subagent_type || a.input.agentType)) || "")) },
      { key: "外部先例(WebSearch/WebFetch:判「业界踩过没有」)",
        test: (a) => /^(WebSearch|WebFetch)$/.test(String(a.name || "")) },
    ],
    attempted(a) {
      return RULE_P._p.CH.some((ch) => { try { return ch.test(a); } catch { return false; } });
    },

    /** 每累计 K 次承重面提交,义务重新武装一次 ⇒ 各需 ceil(承重提交数 / K) 遍。
     *  本轮至少算 1 次(触发时已确认本轮有承重提交,只是路径可能只落在 writes 上)。 */
    needRuns(ctx) {
      const H = RULE_P._p;
      const n = H.carrierCommitCount(H.win(ctx)) + Math.max(H.carrierCommitCount(ctx), 1);
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
    if (ctx.pLedger !== undefined) {
      const prior = ctx.pLedger ? ctx.pLedger.carriers : 0;
      const mine = Math.max(H.carrierCommitCount(ctx), 1);
      const effective = prior + mine;
      if (effective < H.rearm()) return [];
      const acts = H.scopeActions(ctx);
      const out = [];
      for (const ch of H.CH) {
        const chActs = acts.filter((a) => { try { return ch.test(a); } catch { return false; } });
        if (chActs.length >= 1) continue;
        out.push({ ch: ch.key, got: 0, need: 1, commits: effective, every: H.rearm() });
      }
      return out;
    }
    const { commits, need } = H.needRuns(ctx);
    const acts = H.scopeActions(ctx);
    const out = [];
    for (const ch of H.CH) {
      const mine = acts.filter((a) => { try { return ch.test(a); } catch { return false; } });
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
    return out;
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
    return `承重面批次三通道未跑够(本批 ${h0.commits} 次承重面提交 ⇒ 各需 ${h0.need} 遍,` +
      `每 ${h0.every} 次重新武装一次)。缺:${hits.map((h) => `${h.ch} ${h.got}/${h.need}`).join(" / ")}\n` +
      `      **「本轮不需要」不是豁免**——当日自审第⑤⑥⑦问六次全答「不需要」、零次触发行动,\n` +
      `      而同日一跑三通道:codex 判死我 4/5 条诊断,grill 报出 97 条变异里 40 条在「全绿」下存活。\n` +
      `      唯一合法豁免=**通道本身不可用**,且须有动作证据:真发起过那条通道,\n` +
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
        if (prior + Math.max(H.carrierCommitCount(ctx), 1) < H.rearm()) return [];
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
        if (prior + Math.max(H.carrierCommitCount(ctx), 1) < H.rearm()) return [];
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
        if (prior + Math.max(H.carrierCommitCount(ctx), 1) < H.rearm()) return [];
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
    ],
    neg: [
      // 真调用集:三条通道各真跑一遍 ⇒ 放行。**这是唯一的接受侧证人**,
      //   它红了不是「少过一条」,是「本条判据是不是一律拦」没人测了。
      { text: "承重面改完并提交,三通道各跑一遍。",
        bash: ["node ~/.claude/scripts/codex-run.mjs --task t.md", "git add -A scripts/hook-stop-closure.mjs && git commit -m x"],
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
      { text: "小修提交。", pLedger: { carriers: 3 },
        bash: ["git add -A scripts/lib/gate-rules.mjs && git commit -m x"] },
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
  _w: {
    deliverablesOf(ctx) {
      const out = new Set();
      const eat = (c) => { for (const p of (c?.writes || [])) if (isDeliverable(p)) out.add(String(p).replace(/\\/g, "/").split("/").pop()); };
      eat(ctx);
      try { const w = ctx.window(); if (w) eat(w); } catch { /* 窗口取不到 ⇒ 只看本轮(漏放向) */ }
      return [...out];
    },
    contentWrote(ctx) {
      const cmds = [...(ctx.bashCmds || [])];
      try { const w = ctx.window(); if (w) cmds.push(...(w.bashCmds || [])); } catch { /* 空 */ }
      return cmds.some((c) => CONTENT_WRITE_RE.test(String(c)));
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
          const isReviewer = (/^(Agent|Task)$/.test(nm) && /^(grill:|_)/.test(String((a.input && (a.input.subagent_type || a.input.agentType)) || ""))) || /codex/i.test(nm);
          return isReviewer && (JSON.stringify(a.input || {}).includes(n) || JSON.stringify(a.input || {}).includes(stem));
        });
      });
    },
  },
  detect: (ctx) => {
    const H = RULE_W._w;
    if (!ranClear(ctx)) return [];
    const out = [];
    // 支① 交付物(docs/clipboard 文章):须只读子代理审读且入参绑定文件名
    const names = H.deliverablesOf(ctx);
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
    `      出路:派一个只读子代理(grill:* 或 _*)审读该交付物——**入参里带上文件名**,\n` +
    `      回件处置后再收工。跨模型/联网两通道不在本项(并入 P 的跨批累计)。`,
  mutations: [
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
      // 窗口里审过(隔轮审、本轮收) ⇒ 放行
      { text: "收工。", bash: "node --no-warnings scripts/batch-goal.mjs --clear",
        write: "clipboard/mapgen/tdd/README.md",
        prior: [{ text: "审读轮", bash: "node ~/.claude/scripts/codex-run.mjs --task t.md",
                  agent: { type: "grill:edge-cases", prompt: "审 clipboard/mapgen/tdd/README.md" } }] },
    ],
  },
};
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
    return ["呈签/裁决请求未附「免签例外已核」行"];
  },
  exempts: [],
  message: () =>
    `摊给用户前先核宪法窄例外①–④(纠错自签/复议裁撤/判据过重/可逆机械):能自签的别摊,\n` +
    `      真取舍才上桌;核完写一行「免签例外已核:<各为什么不适用,或:适用④已自签留痕>」。\n` +
    `      立法动机:2026-08-25 把④该接的活摊给了用户,被连问两句逮住——规则在,没人核=没有规则。`,
  mutations: [
    { name: "写了核查行也照报(豁免失效)", apply: (r) => ({ ...r, detect: (ctx) =>
      /需你裁|呈签|请亲签|待你亲签|需要你亲签/.test(ctx.text) ? ["硬报"] : [] }) },
    { name: "去掉呼签前置(任何文本都追讨)", apply: (r) => ({ ...r, detect: (ctx) =>
      /免签例外已核/.test(ctx.text) ? [] : ["无呼签也报"] }) },
  ],
  cases: {
    pos: [{ text: "两件需你裁:①设计稿呈签 ②发布授权。" }],
    neg: [
      { text: "需你裁:发布授权(真取舍)。免签例外已核:①–④均不适用——对外不可逆面。" },
      { text: "普通汇报:三件全绿,已提交。" },
    ],
  },
};

export const RULES = [RULE_V, RULE_W, RULE_Q, RULE_D, RULE_G, RULE_B, RULE_C, RULE_H, RULE_F, RULE_L, RULE_N, RULE_I, RULE_J, RULE_M,
  RULE_E0, RULE_E1, RULE_E2, RULE_K, RULE_K0, RULE_S, RULE_T, RULE_U, RULE_P];
