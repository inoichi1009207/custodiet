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
    illegalRuleHome: true, memoryHome: true,
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
/** 路径归一。**只此一份**——本文件的立身之本就是「分类表只此一份」,
 *  而归一是分类的前置,散落成各处的 `String(p).replace(/\\/g,"/")` 就是它的碎片形态。
 *
 *  ⚠️ 2026-08-27 结清 D63(≤113,逾期)。实测绕过形态(NTFS 上指向**同一个真实文件**):
 *    `.claude/Agents/foo.md`(大小写)、`.CLAUDE/agents/…`、`Scripts/lib/…`、
 *    `scripts/./lib/…`(点段)、`scripts\lib\…`(反斜杠)——**分类表一条都不认**。
 *  方向是**漏放**:I 项连 carriers 都收集不到就 `return []`,P 项也不会为它响。
 *  NTFS 大小写不敏感而正则大小写敏感,这条缝在 Windows 上是常态不是边角。
 *  故:①这里做**分隔符 + 点段 + 重复斜杠**归一;②派生正则一律带 `i`。
 *  天花板:不解 `..`(会牵涉真实文件系统语义),也不解符号链接与 8.3 短名。 */
export function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")          // Windows 反斜杠
    .replace(/^\.\//, "")         // 开头的 ./
    .replace(/\/\.\//g, "/")      // 中间的 /./
    .replace(/\/{2,}/g, "/");     // 重复斜杠
}

// 派生正则一律带 `i`:NTFS 大小写不敏感,而正则默认敏感 ⇒ 大小写变体整片漏放(D63)。
const join = (pred) => new RegExp(CARRIERS.filter(pred).map((c) => c.re.source).join("|"), "i");

// ⚠️ 2026-08-27 当轮试过「锚到路径开头」并**当场撤掉**:它要求全部调用方先把
//   绝对路径转成仓相对形,而现存夹具与 `ctx.writes` 都是绝对路径 ⇒ 一改打红 8 条自测。
//   记在这以免有人再想一遍;真要走那条路,得连调用方一起改(D86 的失效条件写着)。
/** 非本仓载体区:命中即**不算**载体路径,不论后半段长得多像。
 *  `clipboard/`=暂存与外发面(外发暂存树就在这儿),`node_modules/`=依赖,
 *  `.git/`=版本库内部,`dist|build|coverage/`=产物。
 *  天花板:这是**枚举**,漏一类就漏一类;但比锚定路径开头稳——后者要求全部调用方
 *  先转成仓相对形,而现存夹具与 ctx.writes 都用绝对路径(当轮实测:锚定打红 8 条自测)。
 *  失效条件:再撞到第三类不在表内的误命中,改为「先转仓相对形再锚定」那条路。 */
export const NON_CARRIER_AREA = /(^|\/)(clipboard|node_modules|\.git|dist|build|coverage)\//i;

/** 「这是不是一个载体**路径**」。与 `*_SURFACE` 的分工:
 *  `*_SURFACE` 扫**命令串**(`git add scripts/x.mjs` 里那段不在开头,故不能锚也不能排除);
 *  本谓词判**路径**,要把非本仓载体区剔掉。选错哪边都有代价,故在此写明。 */
export function isCarrierPath(re, p) {
  const s = normPath(p);
  return re.test(s) && !NON_CARRIER_AREA.test(s);
}

/** 「新建它算造物」的合并正则(I 项用)。 */
/** memory 面单挑(D56 用)。**取自上表同一条 `re`,不另抄一份正则**——
 *  本文件的立身之本就是「分类表只此一份」,为一个新判据再抄一遍等于当场复发那个病。 */
export const MEMORY_SURFACE = (() => {
  const re = CARRIERS.find((c) => c.memoryHome)?.re;
  return re ? new RegExp(re.source, "i") : /(?!)/;   // 同 join:大小写不敏感(D63)
})();

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

  // ── D63 回归钉(2026-08-27,逾期结清):NTFS 上这些**指向同一个真实文件**,
  //   而分类正则原来一条都不认 ⇒ I 收集不到 carriers 就 return [],P 也不响(漏放)。
  //   钉两侧:五种绕过写法必须全认;三种业务文件仍不许误扩。
  for (const p of [".claude/Agents/foo.md", ".CLAUDE/agents/foo.md", "Scripts/lib/gate-rules.mjs",
    "scripts/./lib/gate-rules.mjs", "scripts\\lib\\gate-rules.mjs", "scripts//lib/gate-rules.mjs"]) {
    chk(`D63 归一后仍认  ${p}`, CARRIER_SURFACE.test(normPath(p)), true);
  }
  for (const p of ["src/app/page.tsx", "README.md", "content/private/x.md"]) {
    chk(`D63 不误扩      ${p}`, CARRIER_SURFACE.test(normPath(p)), false);
  }

  // ── D86 回归钉(2026-08-27,I 项当场误报逼出来的):**路径面必须锚到开头**。
  //   不锚 ⇒ 任何**含有** `scripts/*.mjs` 或 `.claude/agents/` 的路径都算载体:
  //   外发暂存树(`clipboard/oss/<公开仓暂存目录>/…`,当轮实撞)、`node_modules/…` 全中招。
  //   同时钉反向:命令串面**不许**锚(`git add scripts/x.mjs` 里那段不在开头),
  //   否则把 P 的命令面判据打瞎 ⇒ 漏放。两个用途、两条判据,钉子也分两侧。
  for (const [p, want] of [
    ["scripts/lib/x.mjs", true], [".claude/agents/a.md", true],
    ["clipboard/oss/<公开仓暂存目录>/scripts/lib/x.mjs", false],
    ["clipboard/oss/<公开仓暂存目录>/.claude/agents/a.md", false],
    ["node_modules/a/scripts/b.mjs", false],
  ]) {
    chk(`D86 路径面排除非载体区  ${p.padEnd(40)}`, isCarrierPath(CREATION_SURFACE, p), want);
  }
  chk("D86 命令串面**不**排除(否则 P 的命令判据被打瞎)",
    CARRIER_SURFACE.test(normPath("git add scripts/lib/gate-rules.mjs")), true);

  let pass = 0;
  for (const [r, n, extra] of t) { if (r === "FAIL") console.log(`  FAIL  ${n}  ← ${extra}`); if (r === "PASS") pass++; }
  console.log(`载体分类自测 ${pass}/${t.length}`);
  // ⚠️ 2026-08-27:返回值由 `boolean` 改为 `{pass,total}`。原因是本自测**没有任何调用方**
  //   ——它只在有人手动 `node -e import(...).selfTest()` 时才跑。我当天往里加了 9 条
  //   D63 回归钉,加完才发现**它们永远不会被跑到**(本批第四次「验过而没钉住」)。
  //   现已接进 `hook-stop-closure --self-test`,计数并入总行,需要 pass/total 两个数。
  //   布尔返回值当前无调用方,故此改动不破坏任何东西(已 grep 核实)。
  return { pass, total: t.length, ok: pass === t.length };
}

// ⚠️ **必须判是不是主模块**(2026-08-20,同一个 bug 今天第四次)。
// 原写法只看 argv:被 `import` 时,`--self-test` 是**导入方**的参数,
// 于是本模块在被导入的瞬间就跑自测并 `process.exit` —— 把导入方的自测整个劫持掉
// (实撞:`hook-stop-closure --self-test` 打印的是本文件的计数)。
// 前三次:hook-stop-closure.mjs、batch-goal.mjs、gate-migrate-check.mjs(导出 sliceBoundaries 时)。
const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
if (IS_MAIN && process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
