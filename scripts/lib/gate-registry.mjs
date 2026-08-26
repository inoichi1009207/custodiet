// gate-registry.mjs —— 收尾闸的**声明式规则注册表 + 通用引擎**
//
// 存在理由(2026-08-19,三份独立审计收敛 + 外部文献):
//   现行 `hook-stop-closure.mjs` 是一个 ~420 行的 `run()` 内联 17 项检查。
//   `grill:architecture` 判词:「**这是下面几乎所有问题的共同上游**」。
//   联网查得文献把这类做法逐字称为
//   "hand-coded symbolic enforcement that does not scale to the breadth of
//    real policy specifications" —— 对策是**声明式策略 + 通用引擎**
//   (Cedar / OPA 一族),策略与代码一起版本化、先对真实场景测过再上线。
//
// 这个结构一次性消掉的、当日全部实撞过的问题:
//   · 消息说 A 而判据测 B —— message 由 detect 的产物渲染,结构上不可能不一致
//   · 新增 block:true 项没进开关链 ⇒ 静默降级 —— 引擎读 blocking 字段,没有链可漏
//   · 阻断项留纯文本出路(说一句就过) —— 装载期直接拒绝这种规则
//   · 「44/44 全绿」对 40 条行为零信息量 —— 装载期强制每条带正反例
//   · 法条声明了触发层却没实现 —— law 字段与 verify-laws 双向对账
//
// ── 规则 schema ──────────────────────────────────────────────────────────
//   {
//     id:       "M",                      // 唯一;与法条里的「X 项」对得上
//     blocking: true,                     // 引擎据此决定阻断,不再有硬编码开关链
//     law:      "docs/laws/reporting.md#完成靠核对",   // 法条锚点,可被对账
//     detect:   (ctx) => hits[],          // 返回命中项数组;空数组=未命中
//     exempts:  [{ kind:"action"|"text", test:(ctx)=>bool, why:"…" }],
//     message:  (hits, ctx) => string,    // **只能用 detect 的产物渲染**
//     cases:    { pos:[fixture], neg:[fixture] },      // 装载期强制非空
//   }
//
// ── 装载期不变量(违反即拒绝装载,不是警告)────────────────────────────────
//   INV-1  blocking:true 的规则**不得只有 kind:"text" 的豁免**
//          (当日实证:纯文本出路必然吞掉其余出路,自标 8 次 : oracle 1 次)
//   INV-2  每条必须有 law 锚点(否则 verify-laws 无从对账,断链会静默)
//   INV-3  每条必须有 ≥1 正例 + ≥1 反例(否则「全绿」不含信息)
//
// CEILING: 引擎只保证结构性质,不保证某条 detect 写得对。
//   判据对不对仍要靠正反例 + 变异测试 + 外部审计。CALIBRATED=false。

/** 装载期校验:返回 problems 数组,空数组=可装载。 */
export function validateRules(rules) {
  const problems = [];
  const seen = new Set();
  for (const r of rules) {
    const at = `规则 ${r?.id ?? "(无 id)"}`;
    if (!r?.id) { problems.push("有规则缺 id"); continue; }
    if (seen.has(r.id)) problems.push(`${at}: id 重复`);
    seen.add(r.id);
    if (typeof r.detect !== "function") problems.push(`${at}: detect 必须是函数`);
    if (typeof r.message !== "function") problems.push(`${at}: message 必须是函数`);
    // INV-6(2026-08-22,D4 收尾):`requires` 若在,必须是字符串数组——runRules 的契约层
    //   在 per-rule try **之外**对它做 `.filter()`,类型错会炸整轮(切换后=全体 UNKNOWN 一轮,
    //   fail-closed 但代价大);在装载期拦住比在运行期炸便宜。
    if (r.requires !== undefined && (!Array.isArray(r.requires) || r.requires.some((x) => typeof x !== "string")))
      problems.push(`${at}: requires 必须是字符串数组(现在是 ${typeof r.requires})`);

    // INV-2
    if (!r.law || typeof r.law !== "string") {
      problems.push(`${at}: 缺 law 锚点 —— verify-laws 无从对账,断链会静默(INV-2)`);
    }
    // INV-1
    const ex = Array.isArray(r.exempts) ? r.exempts : [];
    // ⚠️ INV-1 原写法 `ex.every(e => e.kind === "text")` **可被一条假 action 豁免绕过**:
    //   附加一条永不成立的 action 标签,`every` 即为 false,而运行期用 `.some()`,
    //   那条纯文本出路照样能放行(codex 060 §3 提出、062 §2 复现确认「已核实-成立,即未修」)。
    //   改为不可绕的形态:**阻断项一条 text 豁免都不许有**。
    //   要留文本出路,就把它写进 detect 的判据里(那样它是判据的一部分,会被正反例与变异管住),
    //   而不是挂成一条谁都能满足的旁路。
    if (r.blocking && ex.some((e) => e.kind === "text")) {
      problems.push(
        `${at}: 阻断项挂了 text 豁免 —— 说一句话就能过闸。阻断项**一条都不许有**;` +
        `要留文本条件请写进 detect(受正反例与变异约束),不要挂成旁路(INV-1)`);
    }
    for (const e of ex) {
      if (!["action", "text"].includes(e?.kind)) problems.push(`${at}: 豁免的 kind 必须是 action|text`);
      if (typeof e?.test !== "function") problems.push(`${at}: 豁免缺 test 函数`);
    }
    // INV-3
    const pos = r.cases?.pos ?? [], neg = r.cases?.neg ?? [];
    if (!Array.isArray(pos) || !pos.length) problems.push(`${at}: 缺正例 —— 「全绿」不含信息(INV-3)`);
    if (!Array.isArray(neg) || !neg.length) problems.push(`${at}: 缺反例(INV-3)`);
    // INV-4:每条规则至少两条变异(2026-08-19 加)。
    //   为什么:外部先例(mutation testing)明写「算子应选到**检出即满足语句/分支/数据流覆盖**」,
    //   而一条规则只配一个变异,只证明**一条分支**被用例覆盖。
    //   我此前把这件事写成一句「已知缺口」——那是声明,不是闸。改成装载期拒绝。
    //   ⚠️ 天花板:它只数条数,不判那两条变异是不是打在**不同分支**上;
    //   要判那个得做覆盖率插桩,现在给不出。
    const muts = Array.isArray(r.mutations) ? r.mutations : [];
    if (muts.length < 2) {
      problems.push(`${at}: 变异只有 ${muts.length} 条 —— 一条只能证明一条分支被覆盖,` +
        `先例要求算子选到「检出即满足分支覆盖」;至少两条(INV-4)`);
    }
  }
  return problems;
}

/**
 * 引擎:对一个 ctx 跑全部规则,返回 findings。
 * 形状与旧 `run()` 的 findings 一致(`{id, block, msg}`),以便**并行 diff** 比对。
 */
export function runRules(rules, ctx) {
  const findings = [];
  for (const r of rules) {
    // ── 必需通道缺席 ⇒ UNKNOWN,走与「判据抛错」**同一条**路径 ────────────────
    // ⚠️ 2026-08-20 codex 判死我的原写法(规则内 `if (g === undefined) return []`):
    //   「`undefined` 表示**测量通道缺席**,不表示『已确认没有欠账』」;
    //   「『旧自测 47 条全崩』只能证明旧夹具没提供新通道,**不能证明生产语义应当 fail-open**
    //     ——这里把验收台的不完整输入,**固化成了规则的放行语义**」。
    //   外部先例同向:OPA 里「所有同名规则都没匹配上」恒为 undefined,而 `default` 关键字
    //   的存在正是为了让你**显式声明**那种情况下取什么值,而不是让调用方去解释 undefined。
    //   出处:https://www.openpolicyagent.org/docs/policy-language/#default-keyword
    //   ——「Without the default definition, the `allow` document would be undefined」(已取页核实)。
    //   我原来的做法就是一个**藏在规则内部、且选了放行那一侧**的隐式 default。
    // 现在把它抬到契约层:规则声明 `requires`,缺了就报 UNKNOWN,阻断项按阻断算。
    const missing = (r.requires ?? []).filter((k) => ctx[k] === undefined);
    if (missing.length) {
      findings.push({
        id: r.id,
        block: typeof r.blocking === "function" ? true : !!r.blocking,
        msg: `[必需通道缺席,该项本轮**未能判定**] 缺:${missing.join(", ")}\n` +
             `      ${r.blocking ? "本项是阻断项 ⇒ 按 **UNKNOWN 阻断**处理:没有输入不等于没有欠账。" : "本项非阻断,记为提示。"}\n` +
             `      调用方须显式供值(可以是 null = 「查过了,没有」),**不供**与**供 null 是两件事**。`,
      });
      continue;
    }
    let hits;
    try { hits = r.detect(ctx) ?? []; }
    catch (e) {
      // 单条判据抛错**不让整闸陪葬**(当日实撞:一个文件名带 `[` 关掉全部 14 项)。
      // 但也不静默:降级成一条提示,让失效可见。
      //
      // ⚠️ **阻断项抛错要保持阻断**(2026-08-20 codex 复核 + grill:testing §1(e) 双路判出)。
      //   原实现一律 `block: false` ⇒ 一条阻断规则只要**抛错就等于被关掉**,而且看起来像
      //   「跑过了、只是提示」。两条具体路径:
      //     ① `ctx.window()` 可能返回 null,规则写 `ctx.window().commits` 直接 TypeError;
      //     ② grill 实测:让 B 在长输入上抛错,验收台把异常记成「命中」,
      //        真实流量命中数从 8 跳到 42、分歧率涨 6.7 倍,而整台全绿。
      //   fail-closed 的正确形态是 **UNKNOWN ⇒ 按阻断处理**:判据没跑成,
      //   就不能读作「没命中」——这与本仓「法典装载 fail-closed」是同一条。
      findings.push({
        id: r.id,
        // 条件阻断项在 UNKNOWN 路径上**一律按阻断算**,不去问那个条件函数:
        // 判据都没跑成,凭什么信「本轮不该阻断」这个判断能跑成。fail-closed 只有一个方向。
        block: typeof r.blocking === "function" ? true : !!r.blocking,
        msg: `[判据异常,该项本轮**未能判定**] ${e.message}\n` +
             `      ${r.blocking ? "本项是阻断项 ⇒ 按 **UNKNOWN 阻断**处理:判据没跑成不等于没命中。" : "本项非阻断,记为提示。"}`,
      });
      continue;
    }
    if (!hits.length) continue;
    // ⚠️ **能力边界,不是输入过滤**(2026-08-19,codex 060 §1.2 + 外部先例)。
    //   先例原话:「输入净化作用于文本内容,检测不了语义编码的对抗内容」;
    //   「能力约束与其过滤所有可能的输入(不可能),不如**限制代码能做什么,无论输入是什么**」。
    //   结构化 ctx 只是输入面收窄——它决定规则**看得见什么**,不决定规则**能用什么下判**。
    //   故:`kind:"action"` 的豁免拿到的是**剥掉文本面的 ctx**,它在结构上
    //   **不可能**被一句话满足;想用文本豁免就必须显式声明 kind:"text",
    //   而 INV-1 不允许阻断项只有 text 豁免。两条合起来才是边界。
    const actionOnly = { ...ctx, text: "", says: () => false };
    // 纵深防御:即便装载期被绕过,阻断项在**运行期**也不认 text 豁免。
    const usable = (r.exempts ?? []).filter((e) => !(r.blocking && e.kind === "text"));
    const exempted = usable.some((e) => {
      try { return e.test(e.kind === "action" ? actionOnly : ctx); } catch { return false; }
    });
    if (exempted) continue;
    // ⚠️ `r.message()` 也要进单条隔离(2026-08-20 grill:architecture A4,实测)。
    //   原写法把它放在 try **之外** ⇒ 一条规则的 message 抛错会冒出 runRules、
    //   落到接缝的 catch ⇒ **15 条全体退回旧实现**。
    //   这与上面那个 catch 自己写的「单条判据抛错**不让整闸陪葬**」是同一个承诺,
    //   而 message 那一半从未兑现——**隔离只做了一半**。
    let msg;
    try { msg = r.message(hits, ctx); }
    catch (e) {
      msg = `[消息渲染失败,判据本身已命中] ${e.message}\n` +
            `      命中 ${hits.length} 处。**不得读作「未命中」**——判据成立,只是消息渲染坏了。`;
    }
    findings.push({ id: r.id, block: isBlocking(r, ctx), msg });
  }
  return findings;
}

/** `blocking` 允许两种形态:静态布尔,或 `(ctx) => bool` 的**条件阻断**。
 *  K 需要后者——「完成条件没逐条对照」平时是提示,**本轮已提交**时才升阻断
 *  (收尾那一刻没有验收标准,等于没有验收)。静态布尔表达不了这件事,
 *  而此前旧实现是靠 `findings.push({ block: committed })` 绕开引擎自己算的。
 *
 *  ⚠️ 两条纪律:
 *   ① **装载期一律按「可能阻断」对待**(`!!r.blocking`,函数恒真)⇒ INV-1 照样
 *     要求它有非 text 豁免。宁可管严:一条有时阻断的规则,和一条一直阻断的规则,
 *     在「能不能被一句话说服放行」这件事上没有区别。
 *   ② 条件函数**自己抛错也算阻断**。它是阻断判据的一部分,不是可选修饰。 */
export function isBlocking(r, ctx) {
  if (typeof r.blocking !== "function") return !!r.blocking;
  try { return !!r.blocking(ctx); } catch { return true; }
}

/**
 * 并行 diff:同一个 ctx 上跑「旧实现」与「新规则集」,返回差异。
 * 迁移纪律:每搬一条规则,diff 必须为空才算搬完——这是整个迁移的风险控制所在。
 * 当日教训:我改坏过两次文件,都是因为没有这一层。
 */
export function diffAgainstLegacy(legacyFindings, newFindings) {
  const key = (f) => `${f.id}`;
  const a = new Map(legacyFindings.map((f) => [key(f), f]));
  const b = new Map(newFindings.map((f) => [key(f), f]));
  const diff = [];
  for (const [k, f] of a) {
    if (!b.has(k)) diff.push(`旧有新无: ${k}`);
    else if (!!f.block !== !!b.get(k).block) diff.push(`阻断性不同: ${k} 旧=${!!f.block} 新=${!!b.get(k).block}`);
  }
  for (const [k] of b) if (!a.has(k)) diff.push(`新有旧无: ${k}`);
  return diff;
}

// ── 自测:证明三条不变量**真的会拒**,以及异常隔离与 diff 有鉴别力 ──────────
// 判据纪律(当日血的教训):新装的闸必须过「把它该抓的东西移除,看它红不红」。
// 故每条不变量都配一个**该被拒**的规则 + 一个**该被放行**的对照。
export function selfTest() {
  // ⚠️ `mutations` 是 2026-08-20 补的。此前这个夹具**不带变异**,于是 INV-4 先把它拒掉,
  //   「合规规则 ⇒ 放行」与「INV-1 对照:非阻断项只有文本出路 ⇒ 放行」这两条**长期是红的**,
  //   而红的原因与它们要测的东西无关 —— 也就是说 INV-1 的**放行方向**从来没被测过,
  //   只测了拒绝方向。一条只测单向的不变量测试,证不了它不是「一律拒」。
  //   (我上一轮还把它报成「12/12」,那是凭印象;实测 HEAD 上就是 10/12。)
  const ok = { id: "X", blocking: true, law: "docs/laws/x.md#a",
    detect: () => ["h"], exempts: [{ kind: "action", test: () => false }],
    message: (h) => `hit ${h.length}`,
    mutations: [{ name: "m1", apply: (r) => r }, { name: "m2", apply: (r) => r }],
    cases: { pos: [1], neg: [1] } };
  const t = [];
  const chk = (name, rules, wantFail) => {
    const p = validateRules(rules);
    const bad = wantFail ? p.length === 0 : p.length > 0;
    t.push([bad ? "FAIL" : "PASS", name, p.join(" | ")]);
  };
  // ⚠️ 这一条是**全部不变量共用的唯一「接受侧」证人**。
  //   外部先例(2026-08-20 WebSearch,arXiv 2210.01047《Testing by Dualization》)把校验器
  //   的正确性拆成两半:**rejection-sound**=只拒不合规的;**rejection-complete**=能拒掉
  //   全部不合规的。下面 INV-2/3/4/id 重复各自只有「⇒ 拒」用例,量的全是 rejection-complete;
  //   rejection-sound 这一侧,整份自测**只靠这一条**撑着。
  //   后果已实撞:INV-4 上线后这条变红(夹具没带 mutations),于是**所有不变量的接受侧
  //   同时失去覆盖**,而自测只显示「10/12」,看不出丢的是一整个方向。
  //   ⇒ 它红了不是「12 条里错 1 条」,是「一半的正确性没人测了」。故单独喊出来。
  chk("合规规则 ⇒ 放行(全部不变量的唯一接受侧证人)", [ok], false);
  if (t[t.length - 1][0] === "FAIL") {
    t.push(["FAIL", "⚠️ 接受侧全线失守:上一条是唯一证明「不变量不是一律拒」的用例", ""]);
  }
  chk("INV-1 阻断项只有文本出路 ⇒ 拒",
    [{ ...ok, exempts: [{ kind: "text", test: () => false }] }], true);
  // codex 062 §2 的最小复现:加一条假 action 标签保住纯文本出路。原 every() 写法会放行。
  chk("INV-1 假 action + 真 text 出路 ⇒ 仍拒(不可用 every 绕)",
    [{ ...ok, exempts: [{ kind: "action", test: () => false }, { kind: "text", test: () => true }] }], true);
  chk("INV-1 对照:非阻断项只有文本出路 ⇒ 放行",
    [{ ...ok, blocking: false, exempts: [{ kind: "text", test: () => false }] }], false);
  chk("INV-2 缺 law 锚点 ⇒ 拒", [{ ...ok, law: undefined }], true);
  chk("INV-3 缺正例 ⇒ 拒", [{ ...ok, cases: { pos: [], neg: [1] } }], true);
  chk("INV-3 缺反例 ⇒ 拒", [{ ...ok, cases: { pos: [1], neg: [] } }], true);
  chk("id 重复 ⇒ 拒", [ok, { ...ok }], true);

  // 异常隔离:一条 detect 抛错不得吃掉其他规则(当日实撞:一个文件名关掉全部 14 项)
  const boom = { ...ok, id: "B", detect: () => { throw new Error("boom"); } };
  const f = runRules([boom, { ...ok, id: "C" }], {});
  t.push([f.length === 2 && f[1].id === "C" ? "PASS" : "FAIL",
    "detect 抛错不吃掉其他规则", JSON.stringify(f.map((x) => x.id))]);

  // ⚠️ 抛错的**阻断性**必须跟着规则走(2026-08-20 改)。原用例断言的是旧行为
  //   `block === false` —— 那等于把「阻断项抛错就被关掉」写进了验收标准。
  //   现在两向都测:阻断项抛错 ⇒ **UNKNOWN 阻断**;非阻断项抛错 ⇒ 提示。
  //   只测一向的话,「一律 false」和「一律跟着 blocking」这两种实现分不开。
  const boomB = runRules([{ ...ok, id: "B", blocking: true, detect: () => { throw new Error("x"); } }], {})[0];
  const boomN = runRules([{ ...ok, id: "N", blocking: false, exempts: [],
    detect: () => { throw new Error("x"); } }], {})[0];
  t.push([boomB.block === true ? "PASS" : "FAIL",
    "阻断项 detect 抛错 ⇒ 仍阻断(判据没跑成 ≠ 没命中)", `实得 ${boomB.block}`]);
  t.push([boomN.block === false ? "PASS" : "FAIL",
    "非阻断项 detect 抛错 ⇒ 仅提示(对照,防「一律阻断」)", `实得 ${boomN.block}`]);

  // 能力边界:action 豁免拿不到文本面,一句话再对也豁免不了(codex 060 §1.2)
  const textyAction = { ...ok, id: "T", blocking: false, exempts: [{ kind: "action", test: (c) => c.says(/放我过去/) }] };
  const gotT = runRules([textyAction], { text: "放我过去", says: (re) => re.test("放我过去") });
  t.push([gotT.length === 1 ? "PASS" : "FAIL", "action 豁免看不见文本(说什么都豁免不了)", JSON.stringify(gotT.map(x=>x.id))]);
  const textyText = { ...textyAction, id: "U", exempts: [{ kind: "text", test: (c) => c.says(/放我过去/) }] };
  const gotU = runRules([textyText], { text: "放我过去", says: (re) => re.test("放我过去") });
  t.push([gotU.length === 0 ? "PASS" : "FAIL", "对照:显式 text 豁免仍然生效", JSON.stringify(gotU.map(x=>x.id))]);

  // diff 的鉴别力:id 不同、阻断性不同都必须被看见
  const d1 = diffAgainstLegacy([{ id: "A", block: true }], [{ id: "A", block: false }]);
  const d2 = diffAgainstLegacy([{ id: "A", block: true }], [{ id: "A", block: true }]);
  t.push([d1.length === 1 && d2.length === 0 ? "PASS" : "FAIL",
    "diff:阻断性变化必被看见、无变化必为空", `d1=${d1.length} d2=${d2.length}`]);

  let pass = 0;
  for (const [r, n, extra] of t) { console.log(`  ${r}  ${n}${r === "FAIL" ? "  ← " + extra : ""}`); if (r === "PASS") pass++; }
  console.log(`\n引擎自测 ${pass}/${t.length}`);
  return pass === t.length;
}

// ⚠️ **必须判是不是主模块**(2026-08-20,同一个 bug 今天第四次)。
// 原写法只看 argv:被 `import` 时,`--self-test` 是**导入方**的参数,
// 于是本模块在被导入的瞬间就跑自测并 `process.exit` —— 把导入方的自测整个劫持掉
// (实撞:`hook-stop-closure --self-test` 打印的是本文件的计数)。
// 前三次:hook-stop-closure.mjs、batch-goal.mjs、gate-migrate-check.mjs(导出 sliceBoundaries 时)。
const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
if (IS_MAIN && process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
