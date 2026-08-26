#!/usr/bin/env node
// gate-migrate-check.mjs —— 迁移验收:装载期不变量 + 正反例 + 与旧实现并行 diff
//
// 用法: node --no-warnings scripts/gate-migrate-check.mjs
// 退出码: 0=通过  1=有未指名的 diff 或用例失败  2=装载期不变量拒绝
//
// 迁移纪律:每搬一条规则,**diff 必须为空**;非空的每一条都要在 EXPECTED_DIVERGENCE
// 里逐条指名「这正是要修的那个 bug」,不得默认接受。

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
// ⚠️ `diffAgainstLegacy` 会比 `block`,而原实现只比排序后的 id 字符串——
//   把 Q 从阻断改成提示,它照样显示「一致」(codex 060 §4.2 判出,采纳)。
//   会比 block 的比对器一直躺在注册表里没被调用。
import { validateRules, runRules, diffAgainstLegacy } from "./lib/gate-registry.mjs";
import { buildCtx } from "./lib/gate-ctx.mjs";
import { RULES } from "./lib/gate-rules.mjs";
// ⚠️ 别删:DIVERGENCE_DIR.P 的成因谓词用。缺它 ⇒ 谓词 ReferenceError ⇒ 被 fail-closed 的
//   catch 吞成「不放行」⇒ 42 条全报未指名——与四个 RULE_P 候选当年**同一个病**,
//   且同样是 eslint no-undef 一跑就报,我改完没跑(第二次)。
import { CARRIER_SURFACE } from "./lib/gate-carriers.mjs";
// 切边界的**唯一实现**,独立成模块以便复现探针直接 import(见该文件头注)
import { sliceBoundaries } from "./lib/gate-slice.mjs";
// ⚠️ `lastTurn` 必须两边共用。旧 `run()` 内部先切到最后一个回合再判,
//   而我最初把整片 40 行喂给 buildCtx ⇒ **两边看的输入面不同**,
//   比出 25/122 的「分歧」里大半是这个搭错的台子造出来的假分歧
//   (形态:旧=[] 新=[D],新引擎在旧的看不到的文本上响)。
//   并行 diff 的价值正在于此:它逮的是**我的迁移错误**,不是规则错误。
import { run as legacyRun, lastTurn } from "./hook-stop-closure.mjs";

// 已知且**刻意**的行为分歧:key=规则 id,value=为什么。
// 空表示「该条应当与旧实现完全等价」。
// ⚠️ 指名必须**带方向**(codex 060 §4.2:「只按规则 id 白名单,没有绑定方向/旧值/新值,
//   任何输入任何方向的 G 差异都会被视为已指名」)。
//   `dir` 取值:"new-only"=只允许「新有旧无」;"both"=两向都预期。
const DIVERGENCE_DIR = { G: "both", B: "new-only", C: "new-only", N: "new-only", L: "both", M: "both",
  E0: "both", E1: "both", E2: "both",
  // K/K0:验收台现在**注入与旧实现同一份快照**(见 REAL_BATCH_GOAL),两边输入一致。
  // 于是 id 层面本应无分歧,真正的差异落在**阻断性**上 ⇒ 走 EXPECTED_BLOCK_CHANGE。
  // 保留 "both" 是因为 K 的豁免面与旧实现不完全同构(旧的在 cleared 支里做 properClose,
  // 新的把它整支交给 K0),两向都可能出现少量 id 级差异。
  K: "both", K0: "both",
  // S/T/U:迁移期**新立**的规则(S=停工理由 / T=登记须带失效期 / U=Skill 未闭环)。
  // 机器证据(2026-08-22,带正例对照):`grep -cE 'id:\s*"(S|T|U)"' hook-stop-closure.mjs` = **0**
  // (对照:同法 grep K = 2)⇒ 旧实现**没有发射这些 id 的代码路径**,
  // 「新有旧无」按构造成立,无需逐片抽样。反方向若出现即台子有 bug。
  S: "new-only", T: "new-only", U: "new-only",
  // Q:2026-08-22 按全量导出 + 单片直证定性,见 EXPECTED_DIVERGENCE。
  Q: "old-only",
  // P:**谓词指名,逐片验成因**(2026-08-22;方向版 "both" 当天被 codex 撤名,史见下)。
  //   全量分类(96 条):43 条 dc=F + 42 条 dc=T 的「旧有新无」+ 11 条 dc=T 的「新有旧无」。
  //   成因:旧 P 的触发面是 toolRawText(**含 tool_result 与正文**)——提交输出里列着文件名,
  //   承重路径于是从**结果面**漏进触发;新 P 刻意只看入参面(反伪造的立法核心)。
  //   引号修复(isCarrierCommitCmd)只消 1 条 ⇒ 主体不是引号族,是**面收窄**族。
  //   谓词把「刻意面收窄」与「新的真回归」逐片分开:
  //     · 新有旧无 ⇒ 必须有动作面真提交背书(didCommit=true);
  //     · 旧有新无 ⇒ 必须**入参面确实无承重提交**(新式无从触发)且
  //       **结果/文本面确有 commit+承重字样**(旧式因此触发)——
  //       若入参面明明有承重而新没触发,谓词不放行 ⇒ 照报未指名 ⇒ 那才是真回归。
  P: (p) => {
    try {
      if (p.inNew && !p.inOld) return p.ctx.didCommit() === true;
      if (p.inOld && !p.inNew) {
        // dc=false ⇒ **定义上放行**:新 P 的触发门是 didCommit(动作面真提交),无提交时
        //   新式不可能触发;旧式此时响 = 旧的松触发(承重写入/结果面即触发),正是要撤的行为。
        //   该分支的机器锚是 didCommit 本身——它的正确性由 K/P 各自的用例守着。
        if (p.ctx.didCommit() !== true) return true;
        // dc=true ⇒ 新按证据①(本轮承重写入)或证据②(命令参数面承重提交)本该触发:
        //   任一在场而新没响 ⇒ **真回归,不放行**。
        const _P = RULES.find((r) => r.id === "P")._p;
        const ev2 = p.ctx.bashCmds.some((c) => { try { return _P.isCarrierCommitCmd(c); } catch { return false; } });
        const ev1 = (p.ctx.writes || []).some((w) => CARRIER_SURFACE.test(String(w).replace(/\\/g, "/")));
        if (ev1 || ev2) return false;
        // 两证据俱缺 ⇒ 旧的触发只可能来自**松共现**:它的视野(toolRawText:入参∪结果∪正文)里
        //   「git commit」与承重路径**各自出现在任何地方**就算——一条执行闸脚本的命令 +
        //   另一条不带路径的 `git commit`,两个字样凑齐即触发(42/42 全量实测此形态)。
        //   新式要求两者在**同一证据**上(同条命令的参数面,或本轮写动作),这是刻意收窄。
        //   ⚠️ 本支押在 isCarrierCommitCmd 解析器正确上(它坏了,真回归会被误读成松共现)
        //   —— 该解析器自有配对夹具守着(引号暂存 pos / -m 提及 neg),链条写明。
        //   松共现连**旧视野**里都找不到 ⇒ 成因不明 ⇒ 不放行。
        const face = JSON.stringify(p.entries).replace(/\\\\/g, "/");
        return /git\s+[\s\S]{0,40}commit/.test(face) && CARRIER_SURFACE.test(face);
      }
      return false;                                   // 两侧同现的纯阻断翻转不走本表
    } catch { return false; }                          // 谓词崩 ⇒ 不放行(fail-closed)
  } };

/** **阻断性语义变化**必须单独登记,不得折进 `EXPECTED_DIVERGENCE`。
 *  理由:那张表按 id 放行,一放就把「新旧都命中但阻断性反了」一起放了——
 *  grill:testing §4 逮到过同一形态(把 G 的 blocking 一翻,§3 照样 PASS)。
 *  于是 `named3` 里有一条硬规则:纯阻断性变化**永不算已指名**。本表是它唯一的出口。 */
// 2026-08-22 起,值为 `{ allow: {方向: null|谓词}, note }`:
//   · `allow` 的键显式列出放行的翻转方向("block->prompt" / "prompt->block");
//   · 值为 **null = 无条件放行**,为**谓词函数 `(ctx)=>bool` = 逐片验成因**——
//     方向级 blanket 会放行未来同方向的**真回归**(codex 2026-08-22 判词,采纳:
//     「不能保留方向级永久放行;未来任何 K prompt->block 真回归都会自动通过」)。
//   · **漏填 = 全不放行**,与 DIVERGENCE_DIR 的「不再 both 兜底」同一纪律。
// ⚠️ 本表首版的归因写错过一次并被跨模型全量分类纠正,原文留此为戒:
//   我把 13 条 prompt->block 全归给「批漂移」——而**影子台不传 priorEntries ⇒
//   `batchDrifting` 在回放里恒 false**,我本该自己想到。实际 13/13 全是
//   `didCommit()` 分支:提交命令是 `git -C …`/`git -c …` 形态,旧正则
//   `/git\s+commit/` 咬不上 ⇒ 旧提示;新式在动作面认出真提交 ⇒ 新阻断。
//   **抽样 2/13 定性没能逮住我自己的归因错,全量分类才逮住** —— 这就是谓词版的立法动机。
const EXPECTED_BLOCK_CHANGE = {
  K: {
    allow: {
      // 旧 rawText 假阳(读到提及 git commit 的文档即升阻断)⇒ 新降级。无条件放行:
      // 该方向的语义是「新更不吵」,风险面是漏拦,由 K 的迁移用例与变异守着。
      "block->prompt": null,
      // 新升级**必须**由动作面的真提交背书——13/13 已验全是此因。
      // 未来若出现 didCommit=false 的 prompt->block,谓词不放行 ⇒ 照报未指名 ⇒ 人来看。
      "prompt->block": (ctx) => { try { return ctx.didCommit() === true; } catch { return false; } },
    },
    note: "block->prompt:旧 K 的 rawText 含 tool_result,提及即升阻断,新走 didCommit();" +
      "prompt->block:旧正则 /git\\s+commit/ 漏 `git -C/-c` 形态的真提交,新在动作面认出(13/13 全量验证)。",
  },
};

const EXPECTED_DIVERGENCE = {
  S: "**新立规则**(2026-08-20,停工理由闸):旧实现无此 id 的发射路径(grep 直证,见 DIVERGENCE_DIR 注)。" +
     "全部分歧必为「新有旧无」——引擎在历史切片上回放出的命中,是这条规则**假如当时存在**会拦的位置。",
  T: "**新立规则**(2026-08-20,登记须带失效期):同 S,旧实现无发射路径,新有旧无按构造成立。",
  U: "**新立规则**(2026-08-20,Skill 未闭环):同 S。另注:U 依赖窗口通道,历史切片多数无窗口 ⇒ 命中天然稀少。",
  // ⚠️ P 的首版条目 2026-08-22 当天写入、当天被撤:两句机制描述**与源码不符**
  //   (codex 逐行核出:旧 P 触发面是 toolRawText(turn) 不是「整个窗口 JSON」;
  //   旧计数已遍历结构化 tool_use)——**引用自己三天前的记忆写白名单,没回源码重核**,
  //   与「审计认版本不认任务」同族。留此为戒。现行指名走 DIVERGENCE_DIR.P 的**逐片成因谓词**。
  P: "**谓词指名**(见 DIVERGENCE_DIR.P):新有旧无须动作面真提交背书;旧有新无须机器验" +
     "「入参面无承重提交 ∧ 结果/文本面有 commit+承重字样」——旧式从结果面触发是它的伪造洞," +
     "新式刻意不看结果面(反伪造立法核心)。入参面有承重而新没触发的片**不放行**,那是真回归。",
  Q: "**旧有新无,全量恰 1 条**(1227c702#445,已单片直证):旧 Q 的 defer 词表咬住「留待」,而它在" +
     "**引号里**——`按提示词\"库内同类留待后批…\"` 是在**转述正在执行的指令**,不是我在推面出批。" +
     "新 Q 剥引文后不响(窄例外③自签修复,记录在其 detect 注释)。与 E0 的回声修复同族,是修好的证据。",
  // ⚠️ **此处原写着「K/K0 在语料上不可影子比对」,2026-08-20 经 codex 判定不成立,已推翻。**
  //   原论证:旧实现自读磁盘,回放历史切片时读到的是今天的状态 ⇒ 输入不可重建 ⇒ 不可比对。
  //   codex 的反驳(采纳):这把「无法还原**历史真相**」扩大成了「无法做**差分比对**」。
  //   影子台从来不是在证「当年那一刻该不该拦」,而是**同一输入下新旧是否等价**——
  //   而同一输入造得出来:旧实现读哪份快照,验收台就往新引擎注哪份(见 REAL_BATCH_GOAL)。
  //   更要命的半句:**「不可比对」有一部分是验收台自己制造的**——`realCtx` 当时压根没注入
  //   这条通道,我再把由此产生的全部 old-only 差异整体列进白名单。
  //   **先弄瞎比较器,再拿它瞎了当证据。** 这个形态值得单独记住。
  //   (乙方提的「从 git log 重建历史快照」codex 也判不成立:`.batch-goal.jsonl` 被 gitignore。
  //    所以能做的是「同输入等价性」,不是「历史真相」——两者别再混。)
  K: "两向少量 id 级分歧:旧实现在 `cleared` 支里自己做 properClose,新实现把整支交给 K0," +
     "豁免面不同构。**阻断性差异另行登记在 EXPECTED_BLOCK_CHANGE**,不走本表。",
  K0: "同 K:承接了旧实现 `cleared` 支的判定,故两向都可能出现少量 id 级差异。",
  B: "**新有旧无**方向的刻意分歧:旧 B 把承诺的对象拿去比对 `toolRawText(turn)`,而那坨文本" +
     "**含工具输出**——「我要改 foo.mjs」+ 读到一个提到 foo.mjs 的文件就算兑现(grill:security S2)。" +
     "新实现只比对**工具入参**,于是那类假兑现不再豁免 ⇒ 新的多报。反方向(旧有新无)**不预期**。",
  C: "**新有旧无**方向的刻意分歧:旧 C 的 `logged` 扫 `rawText(turn)`,里面含工具输出" +
     "**以及闸自己上一轮消息**——而那条消息里就有「未覆盖」三个字,于是 C 被自己的回声豁免" +
     "(grill:testing 实测:F 一旦命中过,C 此后永久豁免)。新实现只看我说的与我写的。" +
     "反方向**不预期**。",
  N: "**新有旧无**方向的刻意分歧:旧 N 的 `readDef` 扫含**工具输出**的裸文本 ⇒ " +
     "读到一个内容里提及 `commands/` 或 `SKILL.md` 的文件,就算「读过该命令的定义」;" +
     "新实现只看工具入参。与 B/C/G 同一族。反方向**不预期**。",
  L: "**两向**刻意分歧,根因是同一个字符类 `[^\"]*`,它同时造出假阳与假阴——" +
     "这条分歧是 2026-08-20 grill:testing 在**全语料 6604 片**上量出来的(20 条,双向)," +
     "而当时 65 片的采样看到 **0 条**;撤销采样正是为了让它现形。\n" +
     "① **旧有新无(假阳)**:`/ls\\s+[^\"]*scripts/` 里的 `[^\"]*` 横跨整条序列化命令 ⇒ " +
     "`ls clipboard/reader-capture-030/; …; node -e \"…'./scripts/baselines/…'\"` 命中 L," +
     "而那条 `ls` 根本没在清点 scripts/。新实现**先按 `&&|;|\\||换行` 切段再匹配**,不再命中。\n" +
     "② **新有旧无(假阴)**:`/grep\\s+-c[^\"]*(tool-register|repo-brief)/` 的 `[^\"]*` " +
     "**跨不过引号** ⇒ `grep -c \"fetch-quote-check\" …/tool-register.md` 旧的**不**命中," +
     "去掉引号才命中(已直接探针核实:带引号 false、不带 true)。这是真手工清点却被放过。\n" +
     "与 M 的 `\\S*` 回溯吃掉 `s.json`、E0 的 `[^\"]*` 跨不过转义引号是**同一族第三次**:" +
     "**正则的作用域比我以为的宽/窄,而两个方向可以同时发生**。",
  M: "**新有旧无**方向的刻意分歧,成因已在全语料上定位到具体命令:\n" +
     "旧 M 有一道**写动作预筛**——命令必须先命中 " +
     "`writeFileSync|appendFileSync|sed -i|tee|cat >>|重定向` 才进入目标提取循环,\n" +
     "而 **`cp` / `mv` 不在这张清单里** ⇒ 一条纯 `cp a.md docs/b.md` 根本进不了循环,旧 M 对它完全失明\n" +
     "(实例:`cp clipboard/…/merged-candidates.md clipboard/…/merged-candidates-v1.md`,旧=[] 新=[M])。\n" +
     "新实现没有这道预筛,`cp`/`mv`/PowerShell `Set-Content` 一并纳入 ⇒ 新的多报。**反方向不预期**。\n" +
     "⚠️ 反方向(旧有新无)在第一版里确实出现过 —— 那是**我自己引入的 bug**,不是刻意分歧:\n" +
     "回读证据面收了含 `cat` 的命令,而 `cat >> x.md` 本身就含 `cat` ⇒ **写命令成了自己的回读凭证**。\n" +
     "已按段判定修掉(见 gate-rules.mjs 里 `readCmdsFor` 的头注),并加了配对用例钉住。\n" +
     "**旧有新无**方向 2026-08-20 已单独查清并登记为刻意(全语料仅 1 条,a891142e#186):\n" +
     "命令是 `sed -i 's/const payload = { node_ids/…/' s3.mjs`。旧 M 的 sed 提取按**位置数 token**\n" +
     "(`sed\\s+-i[^\\s]*\\s+[^\\s]+\\s+([\\w./-]+)`),而这条 sed 脚本**含空格** ⇒ `[^\\s]+` 只吃到 `'s/const`,\n" +
     "捕获组抓到的是 **`payload`** —— sed 脚本内部的一个变量名。旧 M 于是要求回读一个**不存在的文件**。\n" +
     "这正是 grill M-5(`sed -i 's/a b/c/' docs/x.md` 捞到 `b/c/`),迁移时已修:改成取最后一个带扩展名的 token。\n" +
     "⇒ 这一条「旧有新无」是**修好的证据**,不是回归。\n" +
     "附:我最初以为它是「探针与验收台切法不同」造成的假分歧,于是把切边界抽成唯一实现\n" +
     "(`lib/gate-slice.mjs`)。抽完**分歧依然在** ⇒ 那个假设被证伪,才逼出这次真正的定性。\n" +
     "抽取本身仍是净收益(顺带修掉「只有一个观察点时 user 边界被追加而非重置 ⇒ 数组乱序」)。",
  E0: "见 E2 条目——E0/E1/E2 是同一次原子迁移的三面,三种机制共用一份说明。",
  E1: "见 E2 条目。",
  E2: "**两向**刻意分歧,三种机制并存,全部是这次重写的目的,已在全语料上逐形态取样核实:\n" +
     "① `旧=[E1] 新=[E0,E2]` —— `shaped`(形那一半)从扫 `toolRawText`(**含工具输出**)\n" +
     "   改成**只看动作面**。旧实现里,读到一个提及 `verify/check/probe` 的文件就算「跑过机械探针」,\n" +
     "   于是判「形过了、只缺独立性」⇒ E1;新实现要求真跑过 ⇒ 判两半都没做 ⇒ E0+E2。**新的更严**。\n" +
     "② `旧=[] 新=[E1]` —— `PAT.causal` 2026-08-20 扩召回(用户亲签)。原表对六条最自然的\n" +
     "   中文因果句漏 4 条(「X 导致 Y」「这导致…」「使得…」「改坏了因为…」)。\n" +
     "   全语料实测代价:命中 337→369(+32,相对 +9%),抽 5 条人工看至少 4 条是真因果句\n" +
     "   ⇒ 扩的是**召回不是噪声**。多认出的那些回合恰好形过了、独立性没过 ⇒ E1。\n" +
     "③ `旧=[B,E1] 新=[B]` —— `crossChecked` 补了 `mcp__codex-cli__codex`。\n" +
     "   codex 在本机有**两条通路**(脚本 / MCP 工具),旧式只认脚本那条 ⇒ 我真跑过 MCP codex 的回合\n" +
     "   被判「没做独立性复核」;新实现认得出 ⇒ 正确豁免。与 P 项当日修的是同一个漏报。\n" +
     "⇒ 三者叠加使 E 三条**两向都有分歧**,而每一向都指向「新实现更准」。",
  G: "两向刻意分歧,均已核实:" +
     "① 旧 committed 用 /git\\s+commit/ 扫**含工具输出**的裸文本 ⇒ 引用一句含该串的文档也算已提交" +
     "(grill:security 实测);新实现从 Bash 入参解析——**这正是要修的 bug**。" +
     "② 新解析器识别 `git --no-pager commit` / `git -C … commit` 这类带全局参数的形态,旧的不识别" +
     "(codex 060 §1.1 给出可复现输入)——扩的是识别面,方向是**更准**,故登记为刻意。",
};

let fail = 0;
const say = (ok, s) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${s}`); if (!ok) fail++; };

// ⚠️ **并行 diff 与影子流量必须注入真实的 git 追踪集**,否则两边看的世界不同。
//   实撞(2026-08-20 迁 I 时):旧实现自己跑 `git ls-files` 判「新建 vs 改既有」,
//   而新引擎在 ctx 侧 fail-closed —— 夹具不注入 ⇒ **每个既有文件都被当成新建** ⇒
//   I 在 65 个真实切片里报出 17 处「未指名分歧」,长得像规则写错了,实为**台子搭错**。
//   这与之前 `lastTurn` 那次是同一族错:比对两边的输入面必须一致。
const REAL_TRACKED = (() => {
  try {
    return new Set(execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: process.cwd() })
      .split("\n").map((s) => s.trim()).filter(Boolean));
  } catch { return null; }     // 取不到 ⇒ 两边都 fail-closed,仍然一致
})();
/** 旧实现在 `run()` 里读的那份批次快照。验收台**注入同一份**给引擎。
 *
 *  ⚠️ 我原先据此宣布「K/K0 在语料上不可影子比对」,codex 判**不成立**,判得对:
 *  那句话把「无法还原历史真相」扩大成了「无法做差分比对」。影子台要证的从来不是
 *  「当年那一刻该不该拦」,而是**同一输入下新旧是否等价**——而同一输入是造得出来的:
 *  旧实现读哪份快照,就往新引擎注哪份。历史真相不可还原是真的,但那证伪的是另一件事。
 *  更要命的是 codex 那半句:**「不可比对」有一部分是验收台自己制造的**——
 *  `realCtx` 压根没注入这条通道,然后把由此产生的全部 old-only 差异整体列进白名单。
 *  那是我先弄瞎了比较器,再拿它瞎了当作「这两条不可比」的证据。 */
const REAL_BATCH_GOAL = (() => {
  try { return JSON.parse(fs.readFileSync(".claude/.batch-goal.json", "utf8")); }
  catch { return null; }        // 文件不在 ⇒ null(= 真没武装),两边同样看到 null
})();
const realCtx = (entries) => buildCtx(entries, {
  ...(REAL_TRACKED ? { tracked: REAL_TRACKED } : {}),
  batchGoal: REAL_BATCH_GOAL,
});

/** 旧实现里到底有几项 —— 从源码数,不写死(见 CUTOVER 第①条的注释)。 */
function legacyRuleCount() {
  try {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "hook-stop-closure.mjs"), "utf8");
    return new Set([...src.matchAll(/id:\s*"([A-Z]\d?)"/g)].map((m) => m[1])).size;
  } catch { return Infinity; }   // 数不出来 ⇒ 判据不成立 ⇒ NO-GO(fail-closed)
}

// ── 1. 装载期不变量 ────────────────────────────────────────────────
const problems = validateRules(RULES);
console.log(`装载期校验(${RULES.length} 条规则):`);
if (problems.length) { problems.forEach((p) => console.log("  拒 " + p)); process.exit(2); }
console.log("  PASS  三条不变量全过\n");

// ── 2. 每条规则的正反例 ───────────────────────────────────────────
console.log("正反例:");
// ⚠️ **键必须白名单校验**(2026-08-20 grill:testing §5(e))。原来无法识别的键被静默丢弃:
//   把 `write` 打成 `writes`,反例从 0 命中变成 1 命中 —— 报出来的红是「规则坏了」,
//   而真相是「夹具写错了」。同一机制在 L 身上已经害我调过一轮(见下面 `bash` 的头注),
//   机制却一直没堵。拼错键 ⇒ **当场抛**,不给它伪装成规则缺陷的机会。
// ⚠️ `grep` 是 2026-08-20 加的,**第三次**因为夹具支持面不足让规则测不出来:
//   M 要证明「用 Grep 工具回读也算数」(grill M-6:系统提示明写 Content search: Use Grep,
//   而旧 M 只认 file_path 或字面 grep ⇒ 按规矩用工具的人被罚)。夹具只有 `read`(=Read 工具),
//   于是那条变异**在这组用例上是等价变异**、逮不住——它长得像规则写错了。
//   前两次:`bash`(L 的手工清点无法写正例)、`written`(J 的写入面判据)。
// ⚠️ `web` 是 2026-08-20 加的,**第四次**因为夹具支持面不足让规则测不出来:
//   纪律 32 从三层扩到四层(加「搜 GitHub / 读实现 / 判能不能直接装」),
//   于是 I 的「已扫」反例必须带一个联网动作,而夹具只有 read/grep(本地面)。
//   前三次:`bash`(L)、`written`(J)、`grep`(M 的 Grep 工具回读)。
//   第五次:`batchGoal`(K/K0)—— 这次是**注入通道**而非动作,与前四次不同一族:
//   它不进 entries,而是走 buildCtx 的第二参数。加它时顺手把 mkCtx 的转发一并接上,
//   否则夹具写了、通道空着,K 的正例会全灭而看起来像判据写错了。
//   第八次:`mcp`(2026-08-20,P 落盘当轮)—— 四套独立夹具**一致地**漏掉同一种真调用形态:
//   走 MCP 工具(`mcp__codex-cli__codex`)而非 `node codex-run.mjs` 的跨模型调用。
//   判别实验(剥掉通道动作看规则是否翻面)测得 16 条反例里只有 7 条真检验了计数器,
//   且四套的形态覆盖齐齐停在 3/4,缺的都是这一种。规则本身判得对(探针 3/3),
//   **漏的是夹具**——这正是「四份候选互打全绿」证不了的那类洞:一致地少测。
const FIXTURE_KEYS = new Set(["name", "text", "commit", "write", "written", "bash", "read", "grep", "web", "agent", "mcp", "skill", "tracked", "batchGoal", "pLedger", "prior"]);
//   第六次:`prior`(K 的批漂判据)—— 与 `batchGoal` 同族,也是**注入通道**而非动作。
//   值是「上几轮的 assistant 文本/动作」简写,由 mkEntries 拼成 entries 再交 priorEntries。
const mkEntries = (c) => {
  for (const k of Object.keys(c)) {
    if (!FIXTURE_KEYS.has(k)) throw new Error(`夹具键不认识:「${k}」—— 拼错的键会被静默丢弃并伪装成规则缺陷。合法键:${[...FIXTURE_KEYS].join(", ")}`);
  }
  const blocks = [{ type: "text", text: c.text }];
  if (c.commit) blocks.push({ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } });
  // `written` = 写进文件的**正文**(J 需要:触发层声明写进法条正文同样算数)。
  //   有 written 就发 Edit(带 new_string),否则发 Write。
  if (c.write && c.written) blocks.push({ type: "tool_use", name: "Edit", input: { file_path: c.write, new_string: c.written } });
  else if (c.write) blocks.push({ type: "tool_use", name: "Write", input: { file_path: c.write } });
  // ⚠️ `bash` 是 2026-08-19 加的:原夹具只认 commit/write,于是任何**以命令为判据**的规则
  //   (L 的手工清点、将来 M 的回读)都无法写正例——L 的正例当场因此不命中。
  //   夹具支持面不足会让规则「测不出来」,而它长得像规则写错了。
  // `bash` 可以是一条命令,也可以是**一个数组**(2026-08-20 加:M 的「一条命令不能当自己的
  //   回读凭证」必须用两条独立命令才写得出反例——写在一条里就是同一个 bashCmd,测不出来)。
  if (c.bash) for (const cmd of (Array.isArray(c.bash) ? c.bash : [c.bash])) {
    blocks.push({ type: "tool_use", name: "Bash", input: { command: cmd } });
  }
  if (c.read) blocks.push({ type: "tool_use", name: "Read", input: { file_path: c.read } });
  if (c.grep) blocks.push({ type: "tool_use", name: "Grep", input: { pattern: "x", path: c.grep } });
  if (c.web) blocks.push({ type: "tool_use", name: "WebSearch", input: { query: String(c.web) } });
  // `agent` 可为字符串(只给 type)或对象 {type, prompt}(W 项要验「入参提及交付物名」的绑定)
  if (c.agent) blocks.push({ type: "tool_use", name: "Agent",
    input: typeof c.agent === "object" ? { subagent_type: c.agent.type, prompt: c.agent.prompt } : { subagent_type: c.agent } });
  // `skill` = 本轮 Skill 调用(W′ 的 battle 外审要用)。
  if (c.skill) blocks.push({ type: "tool_use", name: "Skill", input: { skill: String(c.skill) } });
  // `mcp` = 走 MCP 工具的调用,值即工具名(如 "mcp__codex-cli__codex")。
  if (c.mcp) blocks.push({ type: "tool_use", name: String(c.mcp), input: { prompt: "x" } });
  return [{ type: "assistant", message: { content: blocks } }];
};
// ⚠️ `tracked` 必须**从夹具注入**,不能让规则自己去 execFileSync git。
//   注不进来 ⇒ ctx 侧 fail-closed 当「新建」——于是 I 的「改既有载体」这一支
//   在旧架构里**根本写不出反例**(那正是 2026-08-19 连拦三次的那个 bug 测不出来的原因)。
//   夹具不给 tracked 就传 null(保持 fail-closed),给了就精确控制。
// ⚠️ 用例里声明的**注入通道**必须真的转发进去,否则用例跑在「该通道为空」的世界里
//   ——那正是今天逮到过的假绿族(验收台把两边都变成引擎、于是分歧恒为 0)。
//   `batchGoal` 尤其:不转发的话 K 的全部用例都在「无批次状态」下跑,
//   而 K 在那个状态下**按设计就是不响**,于是正例全灭而看起来像判据写错了。
// ── 窗口内动作的夹具通道 ────────────────────────────────────────────────────
//   立此函数的理由(2026-08-20,**第七次**同族失败,由 oracle 跑 P 项时撞出):
//   `prior` 原先只拼得出 text / Write / Skill 三种块。而 P 数的是**窗口里**
//   有没有真的跑过 codex(Bash)、子代理(Agent)、联网(WebSearch)——
//   于是「真调用在窗口里发生过」这件事**在夹具里根本写不出来**,
//   P 的四条反例无论规则怎么写都必然失败。四条独立路线的候选一齐栽在同一格:
//   反例 1/4、1/4、0/4、1/4,而装载期与正例全过。
//
//   前六次同族(本文件上方各有记档):`bash`→L、`written`→J、`grep`→M、
//   `batchGoal`→K、`prior`→K、`skill`→U。本文件早就写着那句预言:
//   **「夹具支持面不足会让规则『测不出来』,而它长得像规则写错了」**。
//   第七次仍是照着这句话栽的,故这次连**键名校验**一起补上(下面 PRIOR_KEYS):
//   静默丢弃拼错的键正是这一族的传播机制。
const PRIOR_KEYS = new Set(["text", "write", "skill", "bash", "agent", "web", "read", "grep", "commit", "mcp"]);
const mkPriorEntry = (x) => {
  for (const k of Object.keys(x)) {
    if (!PRIOR_KEYS.has(k)) throw new Error(`prior 夹具键不认识:「${k}」—— 拼错的键会被静默丢弃并伪装成规则缺陷。合法键:${[...PRIOR_KEYS].join(", ")}`);
  }
  const b = [{ type: "text", text: String(x.text || "") }];
  if (x.write) b.push({ type: "tool_use", name: "Write", input: { file_path: x.write, content: "x" } });
  if (x.skill) b.push({ type: "tool_use", name: "Skill", input: { skill: x.skill } });
  // `bash` 同顶层:可以是一条命令,也可以是数组(两条独立命令才写得出某些反例)。
  if (x.commit) b.push({ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } });
  if (x.bash) for (const cmd of (Array.isArray(x.bash) ? x.bash : [x.bash])) {
    b.push({ type: "tool_use", name: "Bash", input: { command: cmd } });
  }
  if (x.agent) b.push({ type: "tool_use", name: "Agent",
    input: typeof x.agent === "object" ? { subagent_type: x.agent.type, prompt: x.agent.prompt } : { subagent_type: x.agent } });
  if (x.web) b.push({ type: "tool_use", name: "WebSearch", input: { query: String(x.web) } });
  if (x.read) b.push({ type: "tool_use", name: "Read", input: { file_path: x.read } });
  if (x.grep) b.push({ type: "tool_use", name: "Grep", input: { pattern: "x", path: x.grep } });
  if (x.mcp) b.push({ type: "tool_use", name: String(x.mcp), input: { prompt: "x" } });
  return { type: "assistant", message: { content: b } };
};
const mkCtx = (c) => buildCtx(mkEntries(c), {
  ...(c.tracked ? { tracked: new Set(c.tracked) } : {}),
  ...("batchGoal" in c ? { batchGoal: c.batchGoal } : {}),
  // `pLedger` = P 的跨批持久账注入(2026-08-22 亲签)。与 batchGoal 同族:注入通道非动作。
  ...("pLedger" in c ? { pLedger: c.pLedger } : {}),
  // `prior` = [{text, write?, …}, …] ⇒ 拼成 assistant entries 交给 priorEntries。
  // 没写 `prior` 就**不传**(window() 保持 null),与生产上「取不到窗口」一致。
  ...(Array.isArray(c.prior) ? { priorEntries: c.prior.map(mkPriorEntry) } : {}),
});
// ── `--migrate-check <id>`:**单条规则**的迁移标准(秒级)────────────────────────
// 立此模式的理由(2026-08-20,用户问「迁移和切换的具体标准是什么」):
//   **切换标准**有明文(下面的 `CUTOVER`,5 条,定于迁移开始之前);
//   **迁移标准**此前**没有明文** —— 于是我一直拿切换标准当每搬一条的门槛:
//   每条都跑一遍 4 分钟的全语料、要求零未指名分歧才继续。
//   实测代价:一天一夜 19 个提交,真·迁规则只有 2 个。
//
// 两者的差别**只在一条**:
//   切换要求「**全语料**零未指名分歧」;迁移只要求「**这一条**的分歧我说得清」。
//   全语料 diff 每搬三四条统一跑一次,不是每条一次。
// CEILING: 它不看真实流量(那是切换判定第③条),所以过了本检查**不等于**这条规则对;
//   它只保证「这条规则的用例、变异、装载期契约齐备」。
// D43①(grill Q3):EXPECTED_*/DIVERGENCE_DIR 是裸对象查表,原型链键(constructor/toString)
// 会被读成登记项;此前不炸仅因上游 id 正则收窄到 [A-Z]\d?。查表一律走 hasOwn,不赌上游。
const own = (tbl, k) => (Object.hasOwn(tbl, k) ? tbl[k] : undefined);
if (process.argv.includes("--migrate-check")) {
  const id = process.argv[process.argv.indexOf("--migrate-check") + 1];
  const r = RULES.find((x) => x.id === id);
  if (!r) { console.error(`没有 id 为 ${id} 的规则。已迁:${RULES.map((x) => x.id).join(",")}`); process.exit(3); }
  console.log(`迁移标准 · 规则 ${id}(≠ 可切换,见 --cutover-check):`);
  // D43③:DIVERGENCE_DUMP 只接在全量运行路径上,本模式在 exit 前根本走不到那里——
  // 设了不喊一声就是静默无操作。
  if (process.env.DIVERGENCE_DUMP) console.log("  (注:DIVERGENCE_DUMP 仅全量运行生效,单规则模式不导出)");
  const crit = [
    ["装载期不变量过", () => validateRules([r]).length === 0,
      () => validateRules([r]).join(" | ")],
    ["正例 ≥1 且全命中", () => r.cases.pos.length >= 1 && r.cases.pos.every((c) => runRules([r], mkCtx(c)).length === 1),
      () => `${r.cases.pos.filter((c) => runRules([r], mkCtx(c)).length === 1).length}/${r.cases.pos.length}`],
    ["反例 ≥1 且全放行", () => r.cases.neg.length >= 1 && r.cases.neg.every((c) => runRules([r], mkCtx(c)).length === 0),
      () => `${r.cases.neg.filter((c) => runRules([r], mkCtx(c)).length === 0).length}/${r.cases.neg.length}`],
    ["≥2 变异且各有证人", () => {
      const ms = r.mutations || [];
      if (ms.length < 2) return false;
      const sig2 = (rule, c) => JSON.stringify(runRules([rule], mkCtx(c)).map((x) => [x.id, !!x.block, String(x.msg)]));
      const all = [...r.cases.pos, ...r.cases.neg];
      return ms.every((m) => all.some((c) => sig2(r, c) !== sig2(m.apply({ ...r }), c)));
    }, () => `${(r.mutations || []).length} 条变异`],
    // 第五条不是机器判据,是**声明**:分歧必须已定性。写不出成因就是没定性。
    ["分歧已定性(在 EXPECTED_DIVERGENCE 里,或声明预期为空)",
      () => own(EXPECTED_DIVERGENCE, id) !== undefined || own(DIVERGENCE_DIR, id) === undefined,
      () => "既没登记刻意分歧,也没声明「应与旧实现等价」"],
  ];
  let go = true;
  for (const [name, test, why] of crit) {
    const ok = (() => { try { return !!test(); } catch { return false; } })();
    if (!ok) go = false;
    console.log(`  ${ok ? "过  " : "未过"}  ${name}${ok ? "" : "  ← " + (typeof why === "function" ? why() : why)}`);
  }
  console.log(`\n结论:${go ? `规则 ${id} **可算搬完**(全语料 diff 每三四条统一跑一次)` : `规则 ${id} **未搬完**`}`);
  process.exit(go ? 0 : 1);
}

for (const r of RULES) {
  for (const c of r.cases.pos) {
    const f = runRules([r], mkCtx(c));
    say(f.length === 1, `${r.id} 正例应命中:${c.text.slice(0, 24)}…`);
  }
  for (const c of r.cases.neg) {
    const f = runRules([r], mkCtx(c));
    say(f.length === 0, `${r.id} 反例应放行:${c.text.slice(0, 24)}…`);
  }
}

// ── 2b. 变异验收:每条规则必须存在一条能把它的用例打红的变异 ────────────
// 理由(当日实测):97 条变异里 40 条在「44/44 全绿」下存活;
// 「用例通过」不等于「用例有鉴别力」。凡新增规则,必须证明**至少有一种改坏它的方式
// 会被用例逮住**,否则那条用例是装饰。
// ⚠️ 原实现是**构造性恒真**,已被 codex 060 判死并采纳:
//   把 detect 换成 `() => []` 再断言「不命中」,结果由变异函数本身保证;
//   即使 fixture 与判据毫无关系,它照样 PASS。它只证明 runRules 调用了 detect,
//   抓不到分支删除、边界/否定错误、豁免错配、blocking 降级、ctx 解析、异常策略。
//   ——这正是当日追了一整天的「用例无鉴别力」,长在了验收台自己身上。
//
// 正确形态:变异必须动**判据内部**,然后跑**原用例**,断言原用例**转红**。
//   每条规则自带 mutations(它知道自己哪根筋可以被拧断);没有 mutations 的规则不许上线。
console.log("\n变异验收(拧断判据内部,原用例必须转红):");
// ⚠️ 杀伤判据从**二值**升级(codex 063 §2.2:「『12/12 被逮住』在当前二值 oracle 下
//   只是窄成立;对完整行为不够」)。原实现只比「命中/不命中」,于是**变异改了消息内容、
//   阻断标志或命中条数**却让命中与否不变时,用例会「通过」——那是假绿。
//   现在比的是**完整签名**:命中条数 + 阻断标志 + 消息正文。
const sig = (rule, c) => {
  const f = runRules([rule], mkCtx(c));
  return JSON.stringify(f.map((x) => [x.id, !!x.block, String(x.msg)]));
};
for (const r of RULES) {
  const muts = r.mutations || [];
  if (!muts.length) { say(false, `${r.id} **未声明任何变异** —— 无法证明其用例有鉴别力`); continue; }
  for (const m of muts) {
    const mutated = m.apply({ ...r });
    const all = [...r.cases.pos, ...r.cases.neg];
    // 逮住 = 存在某条原用例,其**完整签名**在变异前后不同
    const witness = all.find((c) => sig(r, c) !== sig(mutated, c));
    say(!!witness, `${r.id} 变异「${m.name}」被原用例逮住` +
      (witness ? `(证人:${String(witness.text).slice(0, 18)}…)` : ""));
  }
}

// ── [切换 2026-08-22 亲签] §3 并行 diff / §4 影子流量 / §5-6 切换判定 **退役** ──
//   对照组(内联旧实现)已随第二刀删除,`engine:false` 现在只产出未迁原生规则(A/R)
//   ——再跑这几节只会拿死人当对照、报满屏假分歧。
//   史料:五条切换判定最后一次真实通过 = 4/5 GO + K0/U 亲签例外(cutover6,commit 21b0152 前后);
//   365/365 分歧全部逐片指名。本件余下的活面 = 装载期校验 + §2 正反例 + --migrate-check
//   (纯引擎回归套件,失效条件照旧:变异验收若从未拒过任何规则 ⇒ 空文,复议)。
console.log("\n[已切换] §3–§6 退役(对照组已删,史料见 git);活面 = 装载期校验 + 正反例 + 变异验收 + --migrate-check。");
process.exit(fail ? 1 : 0);
// ── §3 并行 diff / §4 影子流量 / §5-6 切换判定:退役段已迁出(2026-08-25,批 101/D54)──
//   上一行 process.exit 起原有 325 行不可达代码,agent 对着死代码学契约(codex 对抗审 §4)。
//   快照:docs/archive/gate-migrate-check-retired.md;演化史:git 21b0152 前后。
