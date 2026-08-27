#!/usr/bin/env node
// batch-goal.mjs —— 批级完成条件(命令自带的 goal)
//
// 干什么:让**每条命令在开工时自己写下这一批的完成条件**,收尾闸每轮拿它比,
//        收尾时(有 git commit)未逐条确认即拦。
//
// 为什么不用官方 `/goal`:它是**内建 slash command,模型调不了**——只有用户能敲。
//        而 2026-08-19 用户明示「以后原则上每个命令都必须 goal,而不是我搁那打 goal」。
//        官方 `/goal` 的机制(session 级 prompt Stop hook、另一个模型判、后台任务在跑时跳过)
//        本仓已由 `.claude/settings.json` 的 prompt hook + `hook-stop-closure` 分别覆盖;
//        本文件补的是它**唯一无法自动化的那一半:条件从哪来**。
//
// 判据(全部结构事实,不判语义):
//   - 条件是否**存在**:文件在不在、conditions 非空;
//   - 条件是否**被逐条确认**:助理输出里出现「条件N:达成」或「条件N:未达成」形态;
//   - 谁也不判「条件本身是否真的达成」——那是语义,机器给不出,由跨模型判官与人兜。
//
// 天花板(CEILING):本闸只证「条件写下来了、收尾时被逐条对照过」,
//        **不证条件写得对、更不证它真的达成**。一条写得含糊的条件会顺利通过本闸。
//        与官方 `/goal` 的评估器同限:不跑命令、不读文件。
//
// 用法:
//   node --no-warnings scripts/batch-goal.mjs --arm <批号> --cond "…" [--cond "…"]
//   node --no-warnings scripts/batch-goal.mjs --status
//   node --no-warnings scripts/batch-goal.mjs --clear
//   node --no-warnings scripts/batch-goal.mjs --self-test
// 退出码: 0=正常  2=用法错
//
// ⚠️ **次序:`--clear` 必须是本批的最后一个动作,收尾提交要排在它前面。**
//   反了会命中 K0——因为「已结清 + 本轮又有 commit」按判据即「新批未武装就提交」,
//   而那正是 K0 该拦的形态。2026-08-19 实撞:我先 --clear 再提交日记与寄存器,
//   当场被自己刚修好的 K0 逮住。判据没错,是我的次序错。
//   正确序:武装 → 干活 → 逐条对照 → **提交** → `--clear`。

import fs from "node:fs";
import path from "node:path";
import { ledgerAppend } from "./lib/ledger-chain.mjs";

const FILE = path.join(".claude", ".batch-goal.json");

// ── 「小 git」:原子写 + 只追加日志 + 覆盖保护(2026-08-19,用户提议;当日实撞事故)──
//
// 事故:codex 在后台跑审计时,把 `.batch-goal.json` 整个盖成它自己任务的条件,
//   **批 061 的验收标准就此丢失**,靠我在对话里记得才恢复。发现它只是因为
//   收尾闸报出一个我从没武装过的批号——**否则无声无息**。
// grill:error-handling 早已逐字警告过这个面(已从 transcript 核过原文):
//   「`[RUN]` It is **gitignored** — no version history, no recovery path」
//   「`writeFileSync` directly on the live path — **no temp+rename, no lock, no fsync**」
//
// 三样都补上:
//   ① **原子写**:临时文件 + rename,并发读者不会看到被截断的空文件;
//   ② **只追加日志** `.claude/.batch-goal.jsonl`:每次 arm/clear 追加一行,永不覆盖
//      ——这就是那个「小 git」,任何一次覆盖都能从这儿翻回来;
//   ③ **覆盖保护**:当前已武装且批号不同时,`--arm` 拒绝执行,除非显式 `--force`。
//      这一条直接挡住本次事故的形态。
const JOURNAL = path.join(".claude", ".batch-goal.jsonl");

function journal(action, payload) {
  try {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    // D1/批 102:改走 ledger-chain(行级 hash 链,完整性告警)。三接线点之一——
    //   本台账独立承担 K0 结清证据补回与 --audit 历史重放(D46),状态文件替代不了它的历史面。
    ledgerAppend(JOURNAL, { at: new Date().toISOString(), action, ...payload });
  } catch (e) {
    // 写失败不阻断主流程(原子写仍要做),但**必须出声**——静默吞错=报警从分母无声消失(四眼判词)
    console.error("JOURNAL-WRITE-FAILED: " + String(e && e.message));
  }
}

/** 读当前版本号。文件不存在或没有 version 字段 ⇒ 0。 */
function currentVersion() {
  try { return Number(JSON.parse(fs.readFileSync(FILE, "utf8"))?.version) || 0; } catch { return 0; }
}

/**
 * 原子写 + **乐观并发控制(CAS)**。
 * 外部先例(2026-08-19 WebSearch,event sourcing / OCC):
 *   「写新事件时断言该聚合的最新 sequence_number 是 N−1」「两个并发写同一版本 ⇒
 *    一个成功、一个拿到冲突并重试」。
 * 为什么需要:上一版的覆盖保护比的是**批号**,而两个进程武装**同一批号**照样互相盖。
 *   版本号才是并发的正确判据——批号是业务标识,不是并发标识。
 * ⚠️ **天花板(实测后改写,不要照先例的话直接信)**:本 CLI 是「读版本 → 立刻写」,
 *   两步相隔微秒,外部进程插不进去 ⇒ **这层 CAS 在本场景里近乎装饰**。
 *   实测:从外部把盘上版本推高再调 --arm,它照样成功,因为 --arm 自己会重新读一遍。
 *   OCC 真正有用的前提是**调用方跨越一段较长的操作持有版本**(交互式流程、跨请求),
 *   我们不是那个形态。
 *   真正挡住本次事故的是**批号覆盖保护**(已实证:模拟 codex 那次覆盖被拒)。
 *   保留 version 字段的理由是它让 --history 能排序、也给将来真持有版本的调用方留口;
 *   **但不要把它当成并发安全的证据**。要真安全得上锁文件或换载体。
 */
function atomicWrite(obj, expectVersion) {
  const now = currentVersion();
  if (expectVersion !== undefined && now !== expectVersion) {
    throw new Error(`并发冲突:期待版本 ${expectVersion},盘上已是 ${now}——` +
      `有别的进程在你读取之后写过。历史见 --history,重试前先 --status 看当前状态`);
  }
  // ⚠️ tmp 必须**每进程唯一**。原实现用固定名 `FILE + ".tmp"`,于是机器上每个进程
  //   都往**同一个缓冲文件**里写。grill:edge-cases F2 实测 16 路并发:
  //   **10 个报成功、版本只到 9、盘上是某一个进程的条件**——
  //   一个进程写了共享 tmp,却被**另一个进程**把它 rename 到位。
  //   「报成功的那个,不一定是条件落盘的那个」——正是原事故的损坏形状,
  //   而且不需要批号不同就能发生。
  const tmp = `${FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...obj, version: now + 1 }, null, 2), "utf8");
    fs.renameSync(tmp, FILE);   // 同卷 rename 是原子的
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 残骸清不掉不阻断 */ }
  }
}

/**
 * 读状态。**必须区分「没有」与「读不了」**——这是 F1 的根:
 * 原实现两种情况都返回 null,而覆盖保护写的是 `if (cur && …)`,
 * 于是**零字节/损坏的状态文件让保护整个跳过**,`--arm` 成功退出 0。
 * 而零字节正是修复前那个裸 writeFileSync 留下的产物 —— 事故的那一类状态,
 * 恰恰关掉了唯一挡住事故的机制(grill:edge-cases F1,已实测复现)。
 * 现在:文件不存在 ⇒ `null`(真的没武装);存在但解析不了 ⇒ 抛,由调用方 fail-closed。
 */
export function load(file = FILE) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw new Error(`状态文件读不了(${e.code}):${file}`); }
  if (!raw.trim()) throw new Error(`状态文件为空 —— 可能是被中断的写留下的残骸:${file}`);
  try { return JSON.parse(raw); }
  catch { throw new Error(`状态文件解析失败(${raw.length} 字节)—— 不得当作「没武装」处理:${file}`); }
}

// 从助理输出里认「逐条对照」的痕迹。刻意只认带编号的形态,
// 因为无编号的「都达成了」正是本闸要防的那种笼统完成断言。
export function confirmedIndices(text) {
  const hit = new Set();
  // ⚠️ 冒号类必须含全角 U+FF1A。这份**曾与 hook 里的那份分叉**:hook 已修、本份没修,
  //   而自测 7/7 全绿——因为它测的正是这份**没人 import 的死代码**(grill:edge-cases F22)。
  //   分叉的根是 F23(本文件不是 import-safe,hook 只好抄一份正则),已一并修。
  for (const m of String(text || "").matchAll(/条件\s*(\d+)\s*[:：]\s*(达成|未达成|已达成|不适用)/g)) {
    hit.add(Number(m[1]));
  }
  return hit;
}

export function evaluate(goal, text) {
  if (!goal || !Array.isArray(goal.conditions) || !goal.conditions.length) return null;
  const done = confirmedIndices(text);
  const pending = goal.conditions
    .map((c, i) => ({ n: i + 1, text: typeof c === "string" ? c : c?.text || "" }))
    .filter((c) => !done.has(c.n));
  return { batch: goal.batch || "?", total: goal.conditions.length, pending };
}

function selfTest() {
  const cases = [];
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    cases.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };
  const goal = { batch: "053", conditions: ["九项落地", "逐文件提交", "工作树为空"] };
  t("零确认 ⇒ 三条全 pending", evaluate(goal, "干完了").pending.map((p) => p.n), [1, 2, 3]);
  t("逐条确认 ⇒ 无 pending", evaluate(goal, "条件1:达成\n条件2:达成\n条件3:达成").pending.length, 0);
  t("部分确认", evaluate(goal, "条件1:达成 条件3:不适用").pending.map((p) => p.n), [2]);
  t("笼统完成断言不算确认", evaluate(goal, "三项全部完成").pending.length, 3);
  t("未达成也算对照过", evaluate(goal, "条件1:未达成,原因是…").pending.map((p) => p.n), [2, 3]);
  t("无 goal ⇒ null", evaluate(null, "x"), null);
  t("空条件 ⇒ null", evaluate({ conditions: [] }, "x"), null);
  // ⚠️ **「结清后再武装」这条序列此前零覆盖**(2026-08-20 实撞后补)。
  //   为修 grill E6 我让 `--clear` 把批号写进状态文件 ⇒ 结清后是 `{cleared:true, batch:"073"}`;
  //   而 `--arm` 的守卫只判 `cur.batch` 存在,于是**结清之后再 --arm 当场崩**
  //   (`cur.conditions` 是 undefined,读 `.length` 抛 TypeError)。
  //   而自测**修前修后都是 7/7** —— 它从没走过这条路。
  //   本组三条把守卫的判据本身钉住,而不只是钉 `evaluate`。
  const blocks = (cur, batch) => !!(cur && cur.batch && !cur.cleared && cur.batch !== batch);
  t("已结清 + 换批号 ⇒ **放行**(不是拒绝)", blocks({ cleared: true, batch: "073" }, "074"), false);
  t("未结清 + 换批号 ⇒ 拒绝", blocks({ batch: "073", conditions: ["x"] }, "074"), true);
  t("未结清 + 同批号 ⇒ 放行(重武装同一批)", blocks({ batch: "073", conditions: ["x"] }, "073"), false);
  const pass = cases.filter(Boolean).length;
  console.log(`\n自测 ${pass}/${cases.length}`);
  return pass === cases.length ? 0 : 1;
}

// ⚠️ **主模块守卫**(grill:edge-cases F23):本文件 export 了 load/confirmedIndices/evaluate,
//   而下面的 CLI 段原先**无条件执行** ⇒ 任何 import 它的进程当场退出(0 或 2),
//   调用方代码一行都不跑。**这正是 hook 当初抄一份正则而不 import 的原因**,
//   也就是说那条双半角冒号的分叉(F22)是本条的**后果**。
const IS_MAIN = !!process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
const argv = IS_MAIN ? process.argv.slice(2) : ["--imported-noop"];
if (argv.includes("--self-test")) process.exit(selfTest());

if (argv.includes("--clear")) {
  // 写「已结清」标记而**不删文件**:直接删会让同一轮的 K0 立刻抱怨「未武装」
  // ——清账动作自己触发未武装告警(2026-08-19 实撞三次,第三次的根因是修复代码
  // 用 node -e 替换、字符串没匹配上而它**静默不报错**,我只看 echo 就当改完了)。
  // 标记在下次 --arm 时被整体覆盖。
  try {
    const prev = load();
    journal("clear", { batch: prev?.batch ?? null, conditions: prev?.conditions ?? null,
      armedAt: prev?.armedAt ?? null });
    // ⚠️ **批号要留在状态文件里**(2026-08-20,grill:edge-cases E6)。
    //   闸判「这次关账是真的」靠台账末行,但  的 catch 会把写失败整个吞掉
    //   (Windows 上文件被占用即触发),而 atomicWrite 照常成功、CLI 照常 exit 0
    //   ⇒ **三天前另一批的 clear 行会顶替成本轮证据**,且没有任何一处会说出来。
    //   留下批号,闸就能要求「台账末行的批号 == 状态文件的批号」——写失败时对不上。
    atomicWrite({ cleared: true, batch: prev?.batch ?? null });
    console.log("已结清批级完成条件(留结清标记,下次 --arm 覆盖;条件已存入 .batch-goal.jsonl)");
  } catch (e) {
    // ⚠️ 失败必须走 stderr + 非零退出。原实现打 stdout 且 exit 0,
    //   调用方检查 $? 会以为清账成功,而陈旧条件还留在盘上(grill:error-handling 报出)。
    console.error("结清失败:", e.message); process.exit(1);
  }
  process.exit(0);
}

if (argv.includes("--status")) {
  const g = load();
  if (!g || g.cleared || !Array.isArray(g.conditions)) {
    // F25: 之后状态是 {cleared:true},truthy 但没有 conditions ⇒ 原实现在
    //   **每两批之间那个必然存在的状态**上崩溃。--status 是文档写明的检视口。
    console.log(g?.cleared ? "已结清:上一批已关账,尚未武装新批" : "未武装:本批没有完成条件(开工时应 --arm)");
    process.exit(0);
  }
  console.log(`批 ${g.batch} · ${g.conditions.length} 条完成条件:`);
  g.conditions.forEach((c, i) => console.log(`  条件${i + 1}: ${typeof c === "string" ? c : c.text}`));
  process.exit(0);
}

if (argv.includes("--arm")) {
  const batch = argv[argv.indexOf("--arm") + 1];
  const conds = [];
  argv.forEach((a, i) => { if (a === "--cond" && argv[i + 1]) conds.push(argv[i + 1]); });
  if (!batch || !conds.length) { console.error("用法: --arm <批号> --cond \"条件\" [--cond \"条件\"]"); process.exit(2); }
  // ⚠️ 覆盖保护:当前已武装且批号不同 ⇒ 拒绝,除非 --force。
  //   本次事故的形态就是这个:后台 codex 用它自己的批号 --arm,把 061 的条件盖没了。
  // load() 现在对**损坏/空**状态会抛(F1 的 fail-closed)。在这里接住并给人话:
  // 直接让栈打出来等于把 fail-closed 变成 fail-noisy,操作者读不懂就会去 --force。
  let cur;
  try { cur = load(); }
  catch (e) {
    console.error(`拒绝武装:${e.message}`);
    console.error(`  这类状态**不得当作「没武装」**——它可能是被中断的写留下的残骸,`);
    console.error(`  盖上去会把真实批次的验收标准无声抹掉(2026-08-19 实撞过一次)。`);
    console.error(`  先看 --history 确认上一批是什么,再决定 --force。`);
    process.exit(2);
  }
  const seenVersion = Number(cur?.version) || 0;
  // ⚠️ **必须先看 `cleared`**(2026-08-20 实撞,而且是我自己上一批造的)。
  //   为修 grill E6(台账写失败时陈旧行顶替本轮证据),我让 `--clear` 把批号写进状态文件
  //   ⇒ 结清后状态是 `{cleared:true, batch:"073"}`。而本守卫只判 `cur.batch` 存在,
  //   于是**结清之后再 --arm 会当场崩**:`cur.conditions` 是 undefined,读 `.length` 抛 TypeError。
  //   两个教训:①「已结清」与「有批号」不是一回事,守卫得判前者;
  //   ②我改的是 clear 那一侧,崩的是 arm 那一侧 —— **同一状态文件的两个读者,只改了一个**。
  if (cur && cur.batch && !cur.cleared && cur.batch !== batch && !argv.includes("--force")) {
    console.error(`拒绝:批 ${cur.batch} 尚未结清(${(cur.conditions || []).length} 条条件),不能直接武装批 ${batch}。`);
    console.error(`  正常序:先把批 ${cur.batch} 逐条对照并 --clear,再武装新批。`);
    console.error(`  确需覆盖(会丢失当前条件,但可从 .claude/.batch-goal.jsonl 翻回):加 --force`);
    process.exit(2);
  }
  journal("arm", { batch, conditions: conds, overwrote: cur?.batch ?? null });
  // ⚠️ `armedAt` 是 2026-08-20 加的:开工面闸要判「**本批**跑过哪几条通道」,
  //   而状态文件此前**不记武装时刻**,于是那个窗口起点取不到 ⇒ 闸只能闭嘴。
  //   台账 .jsonl 里有时间,但让读者去 join 两份文件是把简单的事做复杂了。
  try { atomicWrite({ batch, conditions: conds, armedAt: new Date().toISOString() }, seenVersion); }
  catch (e) { console.error(e.message); process.exit(2); }
  console.log(`已武装批 ${batch} 的 ${conds.length} 条完成条件;收尾时须逐条写「条件N:达成/未达成/不适用」`);
  // ── 到期债强制腿(2026-08-22,用户逼出:「失效期是装饰品——D34/D35 ≤080 早到期,没人查」)──
  //   立法史:词表路线(Q 的 defer 正则)已判死(B 扩表实败 + xros non-goal + Q「确无结构判据」),
  //   「推迟」的结构载体 = 批条件 + 带失效期的债表;失效期没有执行腿 ⇒ 装饰品。
  //   本腿在**开工时刻**(--arm = 唯一必经的结构点)机械列出到期未结的债,不靠散文不靠词表。
  //   一期只警不拦(拦会把「开工」堵死在还债上——比例归人判);连续多批仍列 ⇒ 升级另议。
  try {
    const rows = fs.readFileSync("docs/gate-debts.md", "utf8").split(/\r?\n/)
      .filter((l) => /^\| D\d+ \|/.test(l) && !/已撤销|待用户裁/.test(l));
    const cur = parseInt(batch, 10);
    // 分诊(2026-08-23 批 099,用户点破「到期腿跑出一堆我看不懂的」):
    //   行含亲签/呈签/归用户/用户裁 ⇒ 【需你裁】,其余 ⇒ 【我做】——用户只须看前一列。
    //   判据是关键词面,天花板:亲签字样写在方案叙述里也会归到【需你裁】(宁多勿漏,
    //   错归方向=多请示一次,反向=漏请示,代价不对称选这边)。
    // ⚠️ 2026-08-27 改为**按列解析**(D88,批 118 关账后当场撞到)。两个毛病叠在一起:
    //   ① 排除词表认 `已结` **不认 `已修`** —— 又一次措辞白名单(本族第十二次);
    //   ② `≤` 取的是**整行第一个**匹配,而已结清的行里同时有 `~~≤113~~`(旧,划掉)
    //      与 `**已修 118**`(新)⇒ 抓到旧的那个 ⇒ 判成逾期。
    //   合起来:我一批清掉七条债,下一批 `--arm` **照样把它们全列成到期未结**。
    //   **假欠账比没有欠账清单更坏**:它让人对整张清单脱敏,真到期的那几条就淹在里面。
    //   ⇒ 失效期只从**第 4 列**取(表头:`| # | 欠账 | 批 | 失效期 | 复核来源 | 出路 |`),
    //   并按**结构**判已结:该列被 `~~` 划掉,或含 已修/已结/已销 之一。
    //   天花板:仍依赖表格列序;列序若变,本腿会静默失准 ⇒ 下面加了列数断言。
    const mine = [], yours = [];
    let colWarn = 0;
    for (const l of rows) {
      const id = (l.match(/^\| (D\d+) \|/) || [])[1];
      const cells = l.split("|").slice(1, -1);           // 去掉首尾空串
      if (cells.length < 6) { colWarn++; continue; }      // 列数不对 ⇒ 不猜,计数后跳过
      const expiryCell = cells[3];
      if (/~~[^~]*≤/.test(expiryCell) || /已(修|结|销)/.test(expiryCell)) continue;  // 已结
      const m = expiryCell.match(/≤\s*0?(\d+)/);
      if (!(m && Number.isFinite(cur) && cur > +m[1])) continue;
      (/亲签|呈签|归用户|用户裁/.test(l) ? yours : mine).push(`${id}(≤${m[1]})`);
    }
    if (colWarn) console.log(`⚠ 到期腿:${colWarn} 行列数异常已跳过 —— 表格列序可能变了,本腿会失准`);
    const due = [...mine, ...yours];
    if (due.length) {
      console.log(`⚠ **到期未结的债 ${due.length} 条**(本批号已超过其失效期):`);
      if (mine.length) console.log(`  【我做】${mine.join(" ")} —— 不需要你看懂,按到期语义自动进批,我协调`);
      if (yours.length) console.log(`  【需你裁】${yours.join(" ")} —— 含亲签面,会摊全文给你`);
      console.log(`  到期语义:自动回 active——本批要么办掉,要么在收尾对照里写明为什么还不办。`);
    }
  } catch { console.log("⚠ 债表读不到,到期检查跳过(fail-open,仅提示层)"); }
  process.exit(0);
}

if (argv.includes("--history")) {
  // 「小 git」的 log:任何一次覆盖都能从这儿翻回来
  let lines = [];
  try { lines = fs.readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean); } catch { lines = []; }
  if (!lines.length) { console.log("无历史(.claude/.batch-goal.jsonl 不存在或为空)"); process.exit(0); }
  const n = Number(argv[argv.indexOf("--history") + 1]) || 10;
  for (const l of lines.slice(-n)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o.action) continue;               // genesis/非事件行(ledger-chain 链首)不进历史视图
    const when = String(o.at).slice(11, 19);
    const extra = o.overwrote ? `  ⚠️ 覆盖了批 ${o.overwrote}` : "";
    console.log(`  ${when}  ${o.action.padEnd(5)} 批 ${o.batch ?? "—"}  ${(o.conditions || []).length} 条${extra}`);
    for (const c of (o.conditions || [])) console.log(`           · ${typeof c === "string" ? c : c.text}`);
  }
  process.exit(0);
}

// ⚠️ 被 import 时到此**什么都不做**。原实现在这里无条件 `exit(2)`,
//   于是守卫算对了也没用——调用方照样被这句用法错误杀掉(实测复现)。
if (IS_MAIN) {
  console.error("用法: --arm <批号> --cond \"…\" [--force] | --status | --clear | --history [n] | --self-test");
  process.exit(2);
}
