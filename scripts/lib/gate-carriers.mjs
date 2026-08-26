// gate-carriers.mjs —— 「什么算载体」的**唯一分类表**
//
// 立此文件的理由(2026-08-20,用户当场质问「为什么要让我去管这个」后自签落地):
//   此前有**两张各自演化的枚举**:
//     · `CARRIER_RE`(I 项用):造新载体前必须扫工具面;
//     · `CARRIER_SURFACE`(P 项用):改承重件的批次必须跑三通道。
//   `git log -G` 实测:`CARRIER_SURFACE` 在 4 次提交里被改过,`CARRIER_RE` **1 次**(引入后没动)。
//   后果实撞:我把一条新规则写进 memory,`I` 一声不吭——memory 不在它的载体面里;
//   同日 `CARRIER_SURFACE` 却已被加宽三次。**两张「什么算载体」的清单互相不知道对方漏了什么。**
//
// codex 裁决(2026-08-20,用户把闸门语义裁决权授权给它):
//   「**应合并为一份唯一的分类表,但不能合并成一个正则**。每类路径独立标两个属性:
//     `creation`(新建时触发 I) / `loadBearing`(修改并提交时触发 P)。
//    动作状态另算,不能写进路径分类。」
//   ——因为两者问的**不是同一个问题**:
//     I 问「这个动作是不是**造物**」(造物前该先看有没有现成的);
//     P 问「这个动作是不是**改承重件**」(改承重件该跑三通道)。
//   「改一个已有法典条文」是后者不是前者;「新建一份 memory」是前者不是后者。
//
// ── grill:error-handling 2026-08-20 审计的逐条处置 ────────────────────────────
// (条件写的是「每条 findings 写明修/登记不修」,故落在这里而不是对话里——对话易失。)
//   ① **已修**:`m[0]` 是前缀不是路径 ⇒ isNew 恒判新建 ⇒ 经 Bash 改既有承重文件被阻断。
//      改用 `bashWriteTargets()` 解析真目标,四条反向核实(见 hook-stop-closure 零件用例)。
//   ② **已修**:每条 `re` 不许带 `$` 锚(拼接后锚到整串结尾),注释 + 自测双钉。
//   ③ **登记不修**:`join()` 在空表时产出 `new RegExp("")` **匹配一切**。
//      触发条件是「某天全表某属性都为 false」,当前不可能(表里两个属性各有多条真);
//      修法(空表即 throw)一行,但会让「临时注释掉全部某类」的调试变成崩溃。**优先级低,已知**。
//   ④ **登记不修**:类上的 flags(`/i`、`/g`)被 `new RegExp(c.re.source)` 静默丢弃
//      ⇒ 谓词面与派生正则面可给出**相反答案**。当前表里无一条带 flags;
//      正解是禁止带 flags 并在 selfTest 里断言,**下一轮做**。
//   ⑤ **登记不修**:属性冲突时 `some()` 是无优先级的 OR。当前表上结果恰好都对
//      (方向 fail-closed),但**无法表达例外**(说不出「scripts/lib/README.mjs 不算承重」)。
//      要 specificity 就要重做数据结构,**等真出现例外再说**。
//   ⑥ **登记不修**:`package\.json` 等未加路径边界 ⇒ `node_modules/foo/package.json`、
//      `mypackage.json`、`xAGENTS.md` 均误命中。方向是 fail-closed(多算承重),
//      代价是 P 多响;加边界是一行,但要先量误报率,**下一轮做**。
//   ⑦ **已修**:memory 相对路径逃逸 —— 见下面该条 `re` 的注释与自测。
//   ⑧ **已核实-不成立**:分类表的正则无 ReDoS(128KB 载荷 1ms)。
//   ⑨ **登记不修**:selfTest 只测三个谓词,而生产**只用派生正则**——测的和用的是两套。
//      正解是让 selfTest 同时对派生正则跑同一张契约矩阵,**下一轮做**。
//
// CEILING: 这仍是**枚举**,只是枚举的对象从「文件名」变成了「载体类别」,
//   且两条语义共用一份事实 ⇒ 加一类只需改一处,不会再出现「一张改了另一张没改」。
//   新增一**类**载体仍要人来加(见 `docs/laws/collab.md` 造物那节)。

/**
 * 载体分类表。每行:{ re, creation, loadBearing, why }
 *  - creation    = true ⇒ **新建**它属于「造物」,I 项要求先扫工具面
 *  - loadBearing = true ⇒ **改动并提交**它属于承重面,P 项要求跑三通道
 */
export const CARRIERS = [
  { re: /\.claude\/(agents|skills|commands)\//, creation: true, loadBearing: true,
    why: "指令文件:既是造物面(可能手搓已有实现),也是规范载体" },
  // `coverage-check` 于 2026-08-20 加入:它一进 `package.json` 的 `gate:*` 命令,
  //   漂移测试当场转红(22/23)——**这正是那条测试该干的事**,不是它误报。
  // `task-brief-check` 于 2026-08-20 加入:`gate:lint` 一进 package.json,
  //   采样面自动纳入它,漂移检查当场转红(24/25)——**第三次在真实新增上生效**。
  { re: /scripts\/(hook-|verify-laws|batch-goal|session-triage|tool-usage-census|test-freshness|gate-migrate-check|coverage-check|task-brief-check|report-gate|lib\/)/,
    creation: true, loadBearing: true,
    why: "闸自身的机件:改它就改了闸的行为" },
  // ⚠️ **不许带 `$` 锚**(2026-08-20 自测当场逮到):派生正则是把各类 `source` 用 `|` 拼起来的,
  //   `$` 会把那一支锚到**整串结尾**,于是「命令串里出现 scripts/foo.mjs」不再命中
  //   ⇒ I 的「经 Bash 写载体绕不过去」用例转红。分类表的每条都必须是**可嵌入**的片段。
  { re: /scripts\/[\w.-]+\.(mjs|ts|js)\b/, creation: true, loadBearing: false,
    why: "普通脚本:新建算造物,但改它不必然触及承重语义" },
  { re: /AGENTS\.md|CLAUDE\.md|docs\/laws\//, creation: false, loadBearing: true,
    why: "宪法与法典:**改**它是承重动作;它不是「造物」——不存在手搓一部已有的法" },
  { re: /docs\/(tool-register|constraint-register|prod-facts|repo-brief|carrier-facts)/,
    creation: false, loadBearing: true,
    why: "寄存器与事实文档:行内义务句以宪法法律索引为规范来源" },
  { re: /\.claude\/settings[\w.-]*\.json|\.claude\/tdd-guardian\/|package\.json/,
    creation: false, loadBearing: true,
    why: "开关面:settings 决定所有 hook 跑不跑,package.json 定义 gate:* 命令" },
  // ⚠️ memory:`creation` 真、`loadBearing` **假**,且额外标 `illegalRuleHome`。
  //   codex 原话:「把它加入 P 反而会暗示『跑完三通道即可合法』,
  //   且 P 以 commit 为触发点,实际上永远看不见它(memory 不入仓)」。
  //   真正该管它的是**另一道**判据:承重规则不得**仅**落在这里。
  // ⚠️ **不要求前导分隔符**(2026-08-20 grill 报出、我先误标「已修」再真修):
  //   原式 `[/\\]\.claude[/\\]…` 要求路径前面有个 `/` 或 `\`,于是**相对路径逃逸**——
  //   `.claude/projects/D--test/memory/y.md` 判 false,而 Write/Edit 的 `file_path`
  //   完全可以是相对路径。⇒「写 memory 时 I 一声不吭」这个本次合并的直接动因,
  //   在相对路径下**原样成立**,而自测只放了绝对路径一个样例。
  //   也**不能**改用 `(?:^|[/\\])`:`^` 在拼接后的交替支里会锚到整串开头,
  //   与 `$` 那个坑是镜像的同一族。这串本身够特异,去掉前导要求即可。
  { re: /\.claude[/\\]projects[/\\][^/\\]+[/\\]memory[/\\]/, creation: true, loadBearing: false,
    illegalRuleHome: true,
    why: "memory:不入仓 + 按需加载 ⇒ 宪法《承重规则的载体门槛》禁止它**独自**承载承重规则" },
];

// ── 四眼面(2026-08-22 用户亲签 A′,法条=reporting.md#交付物四眼)────────────────
//   交付物=方法论/教程/报告类 .md 产出。**台账与日记类刻意排除**(审台账行=纯税);
//   clipboard 在 gitignore 面、永不提交 ⇒ commit 触发的 P 天生看不见它,
//   故 W 项挂在 --clear 上——这正是本面单列、不并入 loadBearing 的理由。
const DELIVERABLE_INCLUDE = /clipboard\/[\w./ -]*\.md\b|docs\/[\w.-]+\.md\b/;
const DELIVERABLE_EXCLUDE = /docs\/(laws\/|gate-debts|noun-diary|product-diary|tool-register|tool-index|prod-facts|repo-brief)/;
/** 生产内容写入命令(W′ 修正案的判据面,2026-08-22 亲签):
 *  ai-note/feed/bulk 管线全部经这些脚本走生产——动作面上可见,单源在此。 */
export const CONTENT_WRITE_RE = /write-node\.mjs|prod-lib\.mjs|bulk[-_]?create|deploy-prod/;

/** 写它算「产出交付物」吗(W 项的判据面)。 */
export function isDeliverable(p) {
  const s = String(p).replace(/\\/g, "/");
  return DELIVERABLE_INCLUDE.test(s) && !DELIVERABLE_EXCLUDE.test(s);
}

/** 新建它算「造物」吗(I 项的判据面)。 */
export function isCreationCarrier(p) {
  const s = String(p).replace(/\\/g, "/");
  return CARRIERS.some((c) => c.creation && c.re.test(s));
}

/** 改动并提交它算「触及承重面」吗(P 项的判据面)。 */
export function isLoadBearing(p) {
  const s = String(p).replace(/\\/g, "/");
  return CARRIERS.some((c) => c.loadBearing && c.re.test(s));
}

/** 它是不是「承重规则不得独自落脚」的地方(将来那道判据用)。 */
export function isIllegalRuleHome(p) {
  const s = String(p).replace(/\\/g, "/");
  return CARRIERS.some((c) => c.illegalRuleHome && c.re.test(s));
}

// ── 派生正则 ────────────────────────────────────────────────────────────────
// ⚠️ 这两条是从**同一张表**派生的,不是第二份手工清单——加一类仍然只改 `CARRIERS`。
//   派生的理由:有调用点要 `str.match(re)` 取出**命中的那段路径**(不只是真假),
//   例如 I 项要在消息里报出「本轮新建了哪个载体」。谓词给不了这个。
const join = (pred) => new RegExp(CARRIERS.filter(pred).map((c) => c.re.source).join("|"));

/** 「新建它算造物」的合并正则(I 项用)。 */
export const CREATION_SURFACE = join((c) => c.creation);
/** 「改动并提交它算触及承重面」的合并正则(P 项用)。历史上 P 就用一条大正则,保持同形。 */
export const CARRIER_SURFACE = join((c) => c.loadBearing);

export function selfTest() {
  const t = [];
  const chk = (n, got, want) => t.push([got === want ? "PASS" : "FAIL", n, `实得 ${got}`]);

  // ⚠️ 这张表是**契约矩阵**(codex 第 2 条:「必须增加双向契约矩阵,而非要求二者相等」)。
  //   四类样例各自断言 I/P 的期望值——否则现有测试对 I 完全失明,漂移仍会重演。
  const M = [
    // 路径,                              creation, loadBearing,  说明
    [".claude/agents/_x.md",                true,  true,  "新建 agent:造物 + 规范载体"],
    ["scripts/hook-foo.mjs",                true,  true,  "闸机件"],
    ["scripts/one-off.mjs",                 true,  false, "普通脚本:算造物,不算承重"],
    ["docs/laws/collab.md",                 false, true,  "**改法典**:承重但不是造物"],
    ["AGENTS.md",                           false, true,  "改宪法:同上"],
    [".claude/settings.json",               false, true,  "开关面:决定所有 hook 跑不跑"],
    ["package.json",                        false, true,  "定义 gate:* 命令"],
    ["docs/prod-facts.md",                  false, true,  "事实文档,义务句以索引为准"],
    ["C:/Users/x/.claude/projects/D--test/memory/y.md", true, false, "**写 memory**(绝对路径)"],
    // ⚠️ 相对路径是 grill 报出的逃逸形态,自测原来只有上面那条绝对路径。
    //   Write/Edit 的 `file_path` 完全可以是相对的。
    [".claude/projects/D--test/memory/y.md", true, false, "**写 memory**(相对路径,原来逃逸)"],
    ["docs/memory-notes.md", false, false, "名字里有 memory 但不是那个目录(防误扩)"],
    ["src/app/page.tsx",                    false, false, "业务代码:两者都不是"],
    ["content/private/x.md",                false, false, "正文:两者都不是"],
    ["README.md",                           false, false, "普通文档"],
  ];
  for (const [p, wantC, wantL, why] of M) {
    chk(`creation  ${p.slice(-38).padEnd(38)} ${why}`, isCreationCarrier(p), wantC);
    chk(`loadBear  ${p.slice(-38).padEnd(38)}`, isLoadBearing(p), wantL);
  }
  // memory 的第三个属性
  chk("memory 被标为「承重规则不得独自落脚」",
    isIllegalRuleHome("C:/Users/x/.claude/projects/D--test/memory/y.md"), true);
  chk("法典**不**是非法落脚处(对照)", isIllegalRuleHome("docs/laws/collab.md"), false);

  let pass = 0;
  for (const [r, n, extra] of t) { if (r === "FAIL") console.log(`  FAIL  ${n}  ← ${extra}`); if (r === "PASS") pass++; }
  console.log(`载体分类自测 ${pass}/${t.length}`);
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
