#!/usr/bin/env node
// custodiet-init.mjs —— 把闸与工作流脚本装进一个**已有的 git 仓**(拷贝模式)
//
// 干什么:从本仓(custodiet)拷出 `scripts/` 下的闸与工作流件 + 示例规矩文件(仓规矩、闸规矩、仍被规则 `law:` 指针引用的归档件)
//        + 红队 / 误拦猎手两个 agent 到目标仓,把 Stop / SubagentStop hook 合并进目标的 `.claude/settings.json`,
//        把闸的运行时台账追加进目标的 `.gitignore`。stdout 末行是一行 JSON 清单。
//
// 不变量(改它们之前先想清楚为什么):
//   · **已存在的拷贝件缺省不覆盖**(`CLAUDE.md` 例外:托管块追加/替换,除托管块外为空时前置生成件):内容相同 ⇒ unchanged;不同 ⇒ 写旁件 `<名>.custodiet<扩展名>`
//     并在清单里标 `sidecar`(旁件也已存在且不同 ⇒ `skipped`,一个字节都不写)。
//     ⚠️ 对 `scripts/` 下的闸件这意味着:目标仓里**旧的那份仍是生效的那份**,清单如实报出。
//   · **覆盖安装(`--overwrite`)只管 `scripts/` 下的闸件**:已存在且内容不同的直接替换,清单里标 `replaced`(带替换前的摘要),
//     另在清单顶层 `overwrite.replaced` 列出全部被替换的路径。替换前逐路径核「git 兜得住」:已跟踪、暂存区与 HEAD 相同、
//     工作区内容与 HEAD 里那份相同(按 git 的换行归一口径比;不读 `git status` 的输出,不受它的显示配置和 assume-unchanged / skip-worktree 标记影响)——
//     改了没提交、暂存了没提交、未跟踪、被忽略,有任何一种 ⇒ 退出 7、逐个列出、**一个字节都不写**(被替换的内容必须能从 git 里拿回来)。
//   · **任何写入位置经过符号链接、或解析后落在目标仓之外 ⇒ 退出 8、列出、一个字节都不写**(普通安装与覆盖安装都管):
//     沿链接写会把仓里别的文件(包括规矩文件)或仓外的东西盖掉。
//   · **目标仓已有 `docs/gate-phrasebook.md` 且不是生成器写的 ⇒ 退出 9、一个字节都不写**:安装器要在这个位置生成《闸用语》,不覆盖别人的文件,也不留半截安装。
//     **规矩文件(`AGENTS.md`、`docs/` 下的)与 `.claude/agents/` 下的不受这个开关影响**,照旧只落旁件:
//     目标仓自己的规矩文件永远不能被安装器覆盖。
//   · `.claude/settings.json` 只做 JSON 合并去重(按命令串去重);解析不了 ⇒ 不碰它,写旁件。
//   · 不提交、不 `git init`:目标不是 git 仓 ⇒ 退出 3 并说明。
//   · 纯 node,无依赖;不联网;不碰用户级 `~/.claude/`。
//   · 「闸引擎文件」的口径(写安装清单用)与规则 P 是**同一份**:从 `scripts/lib/gate-rules.mjs` import 进来的 `ENGINE_REL`,本文件不另抄正则。
//
// 接线只接收尾钩子(Stop / SubagentStop)。其余钩子脚本(hook-start-gate / hook-agent-cwd / hook-precommit-gate /
//   hook-route-hint / hook-tplan-permission)只拷不接——它们各自的头注写了接在哪个事件上,要用的仓自己加进 settings.json。
// 天花板:只管「文件就位 + 接线」;装上之后闸判得对不对,看目标仓里
//   `node --no-warnings scripts/hook-stop-closure.mjs --self-test`。
//   文本类规则的判据是中文句式 ⇒ 目前只适用于中文协作的仓(英文仓里这些规则不误拦,只会全哑)。
//
// 用法:  node scripts/custodiet-init.mjs --target <目标仓根> [--mode copy] [--observe] [--overwrite]
//        node scripts/custodiet-init.mjs --self-test
// 退出码:0 完成(含有旁件/跳过的情形,看清单)  2 参数错  3 目标不存在或不是 git 仓根  4 node 版本过低
//        5 插件模式尚未实现  6 装完但《闸用语》没生成 / 取不到引擎口径  7 覆盖安装被拒(待替换的路径在目标仓里不干净)
//        8 写入位置经过符号链接或落在目标仓之外  9 目标仓已有不是生成器写的 docs/gate-phrasebook.md
//        (7 / 8 / 9 都是预检拒绝:一个字节都没写)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
// 「闸引擎文件」的口径只有一份:规则 P 的 ENGINE_REL。这里 import 进来用,不另抄正则——
//   抄的那份曾比 P 少认 12 个文件:装闸提交里这 12 个不在安装清单里 ⇒ P 认不出「原样装入」,装闸提交被要求过红队。
import { RULES } from "./lib/gate-rules.mjs";

const ENGINE = RULES.find((r) => r.id === "P")?._p?.ENGINE_REL;
const SRC =path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 源→目的同路径。顺序即清单顺序。
//   `scripts/` 下已跟踪的文件除本安装器与私有标识扫描(公开树自己的检查)外**全部在这里**——自测钉着,新搬进来的件漏登即红。
const FILES = [
  // ── 收尾钩子与它静态 import 的一族(缺一件,钩子一加载就崩)──
  "scripts/hook-stop-closure.mjs",
  "scripts/batch-goal.mjs",
  "scripts/lib/gate-rules.mjs",
  "scripts/lib/gate-ctx.mjs",
  "scripts/lib/gate-registry.mjs",
  "scripts/lib/gate-carriers.mjs",
  "scripts/lib/gate-cmd.mjs",
  "scripts/lib/gate-slice.mjs",
  // gate-rules.mjs 顶部 import 它(P 项按 diff 分档的唯一实现);不随包装 ⇒ 新仓一装闸就崩。
  "scripts/lib/gate-difftier.mjs",
  // 同理:gate-rules.mjs 顶部 import 它(I / J / G / L 的写入效果分析)。解析依赖 tree-sitter 由 gate-deps 清单另装;
  //   没装时它报「解析器缺席」,规则退回旧判法,不崩。
  "scripts/lib/write-effects.mjs",
  // 0.9.6:gate-rules.mjs / hook-stop-closure.mjs 顶部 import 它(P 的「修闸 tag」判据)。本包不带记账钩子 ⇒ 账不存在 ⇒ 按「碰过」算,P 行为同前。
  "scripts/lib/gate-touch.mjs",
  // 批 305:收尾钩子与开工钩子都静态 import 它(「只提示」延后到下一条用户消息送达:寄存 / 取走 / 过期记账的唯一实现)。
  //   只接了收尾钩子的仓(安装器缺省)里它不起作用:没有读端在场标记 ⇒ 提示照旧走当轮通道。
  "scripts/lib/gate-hint-relay.mjs",
  // 0.10.0:收尾钩子与开批脚本静态 import 的五件(此前公开树缺它们)+ 写入检查的自测
  "scripts/lib/write-state.mjs",
  "scripts/lib/install-config.mjs",
  "scripts/lib/obligations.mjs",
  "scripts/lib/debt-schema.mjs",
  "scripts/lib/write-checks.mjs",
  "scripts/lib/write-checks.selftest.mjs",
  "scripts/lib/debt-facts.mjs",
  // 批 305:开批脚本静态 import 的主尺 / 指令定位
  "scripts/lib/batch-ruler.mjs",
  "scripts/gate-deps/package.json",
  "scripts/gate-deps/package-lock.json",
  // 自签误报的 codex 盲审;batch-goal --clear 在场才后台发车。它经 scripts/codex-run.mjs 调本机 codex CLI(只读沙箱);
  //   没装 codex 时盲审只出一行 ⚠,不拦结清。
  "scripts/fp-audit.mjs",
  "scripts/codex-run.mjs",
  "scripts/codex-run.selftest.mjs",
  "scripts/codex-entry-sync.mjs",
  // 批 265:《闸用语》生成器;装完在目标仓里跑一次,手册挂进 CLAUDE.md,新会话一开始就读到闸认的说法
  "scripts/gate-phrasebook.mjs",
  // 批 266:误拦通道回放器;P 的 D11 在闸引擎面要误拦猎手 `_gate-false-block-hunter` 跑它(改前 / 改后两版规则在真实转录上回放)
  "scripts/gate-replay.mjs",
  "scripts/lib/ledger-chain.mjs",
  "scripts/lib/ledger-anchor.mjs",
  // ── 0.10.0:其余钩子(只拷不接,见头注)──
  "scripts/hook-start-gate.mjs",
  "scripts/hook-start-gate.selftest.mjs",
  "scripts/hook-agent-cwd.mjs",
  "scripts/hook-precommit-gate.mjs",
  "scripts/hook-route-hint.mjs",
  "scripts/hook-tplan-permission.mjs",
  "scripts/lib/perm-match.mjs",
  "scripts/notify.ps1",
  // ── 0.10.0:验收与工作流工装 ──
  "scripts/gate-migrate-check.mjs",
  "scripts/coverage-check.mjs",
  "scripts/verify-laws.mjs",
  "scripts/check-windows-hide.mjs",
  "scripts/constraint-checkers.mjs",
  "scripts/constraint-events.mjs",
  "scripts/fetch-quote-check.mjs",
  "scripts/gate-dedup-e2e.mjs",
  "scripts/report-gate.mjs",
  "scripts/scan-permission-denials.mjs",
  "scripts/task-brief-check.mjs",
  "scripts/test-freshness.mjs",
  "scripts/tool-usage-census.mjs",
  // 0.12.0:发车脚本(开批 → 无头执行 → 验收 → 回修 → 关账 / 停下交接);静态 import batch-goal、codex-run、lib/install-config
  "scripts/batch-run.mjs",
  "scripts/lib/alloc-prompt-id.mjs",
  "scripts/alloc-prompt-id-selftest.mjs",
  "scripts/lib/exit-watchdog.mjs",
  "scripts/mutation/gate-ctx-fullsuite.stryker.json",
  "scripts/mutation/gate-ctx.stryker.json",
  "scripts/mutation/gate-difftier.stryker.json",
  "scripts/mutation/hook-stop-closure-codexledger.stryker.json",
  // ── agent(不受 --overwrite 影响,已有不同版本时落旁件)──
  ".claude/agents/_gate-false-block-hunter.md",
  // P 在「提交触及闸引擎文件」时,独立视角通道要红队与误拦猎手两者(批 266);不随包装 ⇒ 改闸提交无出路阻断(第一刀 B1 实测)。
  //   原样装入(引擎件与安装清单一致、源树干净)的装闸提交不要两者。
  // ⚠️ 落盘后 Claude Code 不一定在**同一会话**里就列出它(agent 清单的刷新时机未核实:本机 changelog 未检到明确条目);装完最好新开会话再提交。
  ".claude/agents/_gate-bypass-hunter.md",
  // ── 示例规矩文件(不受 --overwrite 影响,已有不同版本时落旁件)──
  //   规则的 `law:` 指针落在这七件上(自测钉着:每条规则的 law 目标文件都在本清单里)。
  "AGENTS.md",                                                // 示例仓规矩:K / K0 / AD / W / DP
  "docs/gate/AGENTS.md",                                      // 闸规矩:P / PF
  // 归档目录里仍被 `law:` 指针引用的三件(其余归档件不装)
  "docs/archive/laws-2026-11/collab.md",
  "docs/archive/laws-2026-11/reporting.md",
  "docs/archive/laws-2026-11/constitution-2026-11-04.md",
  // 名词日记是 ND 项的 law 锚点所在;缺席时 ND 静默退场,但 law 锚点自测会报该锚点无目标。
  "docs/noun-diary.md",
  // 欠账表是 MF / SE 两项的 law 锚点所在(出路之一是往这里登记 D 号行);缺席时锚点自测报无目标。
  "docs/gate-debts.md",
];
// `scripts/` 下不随包装的件:只在公开树里有意义的两件。
const NOT_SHIPPED = ["scripts/custodiet-init.mjs", "scripts/check-private-identifiers.mjs"];
// 生成件(没有源文件):内容即源。
const GENERATED = { "CLAUDE.md": "@AGENTS.md\n" };
const HOOK_CMD = 'node --no-warnings "$CLAUDE_PROJECT_DIR/scripts/hook-stop-closure.mjs"';
const HOOK_EVENTS = ["Stop", "SubagentStop"];
const HOOK_NAME = "hook-stop-closure.mjs";
// 《闸用语》手册的位置与生成件标题(与 scripts/gate-phrasebook.mjs 同一句;自测钉着两处写法相同)
const PHRASEBOOK_REL = "docs/gate-phrasebook.md";
const PHRASEBOOK_HEAD = "# 闸用语(生成件,勿手改)";

function die(code, msg, extra = {}) {
  process.stderr.write(`custodiet-init: ${msg}\n`);
  process.stdout.write(JSON.stringify({ ok: false, exit: code, error: msg, ...extra }) + "\n");
  process.exit(code);
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// CLAUDE.md 比较口径:去掉托管块、统一换行、裁首尾空白(红队 a30a87d8 BP-5:原先幂等判断精确相等、前置判断裁空白,
//   两者口径不一 ⇒ 末尾多一个空行或被 git 换成 CRLF 时,第二次重装就写出 CLAUDE.custodiet.md)
const normClaude = (t) => String(t).replace(/\r\n/g, "\n").replace(/<!-- custodiet:begin[\s\S]*?<!-- custodiet:end -->\n?/, "").trim();
const sidecarOf = (rel) => {
  const ext = path.extname(rel);
  return ext ? rel.slice(0, -ext.length) + ".custodiet" + ext : rel + ".custodiet";
};

// ── 参数 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--self-test")) process.exit(selfTest());
if (!(ENGINE instanceof RegExp)) die(6, "取不到规则 P 的引擎文件口径(scripts/lib/gate-rules.mjs 的 ENGINE_REL)——安装清单写不了,不装");
let target = null, mode = "copy", observe = false, overwrite = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--target") target = argv[++i];
  else if (a === "--mode") mode = argv[++i];
  else if (a === "--observe") observe = true;   // 批 265:装成观察档(只落账不阻断),新仓先攒数据,按数据修规则后整体切回阻断
  else if (a === "--overwrite") overwrite = true;   // 覆盖安装:scripts/ 下已存在且内容不同的闸件直接替换(见头注)
  else if (a === "-h" || a === "--help") {
    process.stdout.write("用法: node scripts/custodiet-init.mjs --target <目标仓根> [--mode copy] [--observe] [--overwrite]\n" +
      "       node scripts/custodiet-init.mjs --self-test\n" +
      "  --overwrite 覆盖安装:目标仓 scripts/ 下已存在且内容不同的同名闸件直接替换(缺省是写旁件、旧的那份继续生效)。\n" +
      "             替换前逐路径核:已跟踪、暂存区与 HEAD 相同、工作区内容与 HEAD 相同;改了没提交 / 暂存了没提交 / 未跟踪 / 被忽略\n" +
      "             ⇒ 退出 7、逐个列出、一个字节都不写。替换了哪些:清单里 status=replaced,顶层 overwrite.replaced。\n" +
      "             规矩文件(AGENTS.md、docs/ 下的)与 .claude/agents/ 下的不受这个开关影响,照旧只落旁件。\n" +
      "  预检拒绝(都是一个字节不写):写入位置经过符号链接或落在目标仓之外 ⇒ 退出 8;\n" +
      "             目标仓已有不是生成器写的 docs/gate-phrasebook.md ⇒ 退出 9(先改名或挪走)。\n" +
      "  --observe  装成观察档:闸照常判、照常记 .claude/.gate-alerts.jsonl,但不阻断、不对模型输出;\n" +
      "             示例宪法只落旁件 AGENTS.custodiet.md、CLAUDE.md 不引入它(《闸用语》照挂)。\n" +
      "             生效:模式文件提交后**新开的会话**才进观察档;装闸的这个会话照常阻断。\n" +
      "             删掉 .claude/custodiet-mode 立即恢复阻断(提交删除让它持久);再不带 --observe 重跑一次,\n" +
      "             示例宪法才落到根目录、CLAUDE.md 才引入它\n");
    process.exit(0);
  } else die(2, `未知参数 ${a}`);
}
if (!target) die(2, "缺 --target <目标仓根>");
if (mode === "plugin") die(5, "插件模式尚未实现(第一刀只做 copy)");
if (mode !== "copy") die(2, `--mode 只认 copy,收到 ${mode}`);

// ── 预检 ───────────────────────────────────────────────────────────────
const major = Number(process.versions.node.split(".")[0]);
if (!(major >= 20)) die(4, `需要 node ≥ 20,当前 ${process.versions.node}`);
const T = path.resolve(target);
if (!fs.existsSync(T) || !fs.statSync(T).isDirectory()) die(3, `目标不存在或不是目录:${T}`);
// 只认「目标就是仓根」:`.git` 目录(普通仓)或 `.git` 文件(worktree/子模块)。
//   不往上找父仓——装进父仓的子目录会让 hook 的 `$CLAUDE_PROJECT_DIR` 与闸件位置对不上。
if (!fs.existsSync(path.join(T, ".git"))) {
  die(3, `目标不是 git 仓根(没有 ${path.join(T, ".git")})。本脚本不擅自 git init——` +
    `确认要装,先自己在目标里 \`git init\`,再重跑。`);
}
if (path.resolve(T) === path.resolve(SRC)) die(3, "目标就是 custodiet 仓自己");

const pre = ["AGENTS.md", "CLAUDE.md", ".claude/settings.json", "package.json", "docs/gate/AGENTS.md", "docs/archive/laws-2026-11"]
  .filter((p) => fs.existsSync(path.join(T, p)));

// ── 预检一:写入路径不得经过符号链接、不得落在目标仓之外(先于任何写入;普通安装与覆盖安装都管)──────────
//   codex 304-sync-review-r1 第 1 条:`scripts/report-gate.mjs` 是指向 `../AGENTS.md` 的符号链接时,覆盖安装沿链接写,
//   把目标仓自己的规矩文件盖掉;`scripts/` 是指到仓外的目录联接时,普通安装把整套脚本写到仓外(本机复现:仓外多出 59 个条目)。
//   判法:本安装器**可能写到**的每个路径(拷贝件、它们的旁件、settings、手册、模式文件、清单、.gitignore),从仓根往下逐级看——
//   任何一级已存在的组成部分是符号链接(Windows 的目录联接也算),或解析后落在仓根之外 ⇒ 整个不装、列出路径、一个字节不写。
//   拿不准(读不了、解析不了)一律算不安全:漏放的代价是盖掉用户的文件,误拒只是让人清一下路径。
{
  const REAL_T = fs.realpathSync(T);
  const inside = (abs) => { const r = path.relative(REAL_T, abs); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const unsafeAt = (rel) => {
    const parts = rel.split("/");
    let cur = T;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      const at = parts.slice(0, i + 1).join("/");
      let st;
      try { st = fs.lstatSync(cur); } catch (e) { if (e && e.code === "ENOENT") return null; return { at, why: `读不了(${e?.code || "未知错误"})` }; }
      if (st.isSymbolicLink()) return { at, why: "是符号链接" };
      let real;
      try { real = fs.realpathSync(cur); } catch (e) { return { at, why: `解析不了(${e?.code || "未知错误"})` }; }
      if (!inside(real)) return { at, why: "解析后落在目标仓之外" };
    }
    return null;
  };
  const targets = FILES.map((rel) => (observe && rel === "AGENTS.md" ? sidecarOf(rel) : rel));
  const writePaths = [...new Set([
    ...targets, ...targets.map(sidecarOf),
    ...Object.keys(GENERATED), ...Object.keys(GENERATED).map(sidecarOf),
    ".claude/settings.json", ".claude/settings.custodiet.json", PHRASEBOOK_REL, "CLAUDE.md",
    ".claude/custodiet-mode", ".claude/custodiet-manifest.json", ".gitignore",
  ])];
  const seen = new Map();   // 出问题的那一级 ⇒ { path, why, affects: 经过它的写入路径 }
  for (const rel of writePaths) {
    const u = unsafeAt(rel);
    if (!u) continue;
    if (!seen.has(u.at)) seen.set(u.at, { path: u.at, why: u.why, affects: [] });
    seen.get(u.at).affects.push(rel);
  }
  if (seen.size) {
    const unsafePaths = [...seen.values()];
    die(8, `安装被拒:${unsafePaths.length} 个写入位置经过符号链接或落在目标仓之外(换成普通文件 / 目录再重跑;什么都没写):` +
      unsafePaths.map((u) => `${u.path}[${u.why};影响 ${u.affects.length} 个写入路径]`).join("、"), { unsafePaths });
  }
}

// ── 预检二:目标仓已有同名《闸用语》手册、且不是生成器写的 ⇒ 不装(先于任何写入)────────────────
//   codex 304-sync-review-r1 第 4 条:原来这个冲突要等脚本拷完、hooks 合并完,生成器才发现(退出 3),安装器最后退出 6——
//   留下一个装了一半的仓。判据与生成器 scripts/gate-phrasebook.mjs 同一句(首行是不是生成件标题;自测钉着两处写法相同)。
{
  const p = path.join(T, PHRASEBOOK_REL);
  if (fs.existsSync(p)) {
    let cur = null, why = null;
    try { cur = fs.readFileSync(p, "utf8"); } catch (e) { why = `读不了(${e?.code || "未知错误"})`; }
    if (cur === null || !cur.startsWith(PHRASEBOOK_HEAD)) {
      die(9, `安装被拒:目标仓已有 ${PHRASEBOOK_REL},且${why || "不是《闸用语》生成器写的(首行不是生成件标题)"}。安装器要在这个位置生成手册、不会覆盖你的文件——` +
        `先把它改名或挪走(提交),再重跑;什么都没写。`, { conflict: PHRASEBOOK_REL });
    }
  }
}

// ── 预检三:覆盖安装(先于任何写入)────────────────────────────────────
//   只管 scripts/ 下的闸件。规矩文件(AGENTS.md、docs/)与 agent 定义永远走旁件——目标仓自己的规矩不能被安装器盖掉。
//   待替换的路径必须「git 兜得住」:已跟踪、暂存区与 HEAD 相同、工作区内容与 HEAD 里那份相同。其余一律拒绝。
//   **不读 `git status` 的输出**(codex 304-sync-review-r1 第 2 条:`status.showUntrackedFiles=no` 让未跟踪 / 被忽略的文件从输出里消失,
//   `assume-unchanged` / `skip-worktree` 让改过的已跟踪文件从输出里消失——本机这几种都复现成「被替换」)。改成逐路径直接比:
//     · 索引里没有这条路径(未跟踪或被忽略)⇒ 拒绝;
//     · 没有 HEAD、HEAD 里没有它、或索引条目与 HEAD 条目不同(暂存了没提交)、或有未合并条目 ⇒ 拒绝;
//     · 工作区内容 vs HEAD:先按 git 自己的入库口径算这份文件的对象号(`git hash-object`,过换行转换与属性过滤,
//       所以 autocrlf 检出的 CRLF 不会误拒;它直接读文件,不看 assume-unchanged / skip-worktree 标记),与 HEAD 的对象号相同 ⇒ 干净;
//       不同再比一次原始字节(HEAD 里本来就存着 CRLF 的文件),相同 ⇒ 干净;都不同 ⇒ 拒绝。
//   任何一步 git 跑不了 ⇒ 证明不了干净 ⇒ 拒绝。
const overwritable = (rel) => rel.startsWith("scripts/");
const replaced = [];
if (overwrite) {
  const cand = FILES.filter((rel) => {
    if (!overwritable(rel)) return false;
    const s = path.join(SRC, rel), d = path.join(T, rel);
    return fs.existsSync(s) && fs.existsSync(d) && sha(fs.readFileSync(d)) !== sha(fs.readFileSync(s));
  });
  if (cand.length) {
    const g = (args, input) => spawnSync("git", ["--literal-pathspecs", "-C", T, ...args], { encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 1 << 28, input });
    const gRaw = (args) => spawnSync("git", ["--literal-pathspecs", "-C", T, ...args], { encoding: "buffer", windowsHide: true, timeout: 60000, maxBuffer: 1 << 28 });
    const cannot = (what, r) => die(7, `覆盖安装被拒:${what}(${String(r.stderr || r.error?.message || "").trim().split("\n")[0] || `退出 ${r.status}`}),证明不了待替换的路径是干净的`,
      { dirty: null, wouldReplace: cand });
    // 索引条目:`<mode> <对象号> <stage>\t<路径>\0`
    const ls = g(["ls-files", "-s", "-z", "--", ...cand]);
    if (ls.status !== 0) cannot("读不到目标仓的索引", ls);
    const index = new Map();
    for (const e of ls.stdout.split("\0").filter(Boolean)) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(e);
      if (!m) cannot("索引条目解析不了", { stderr: e.slice(0, 80) });
      if (!index.has(m[4])) index.set(m[4], []);
      index.get(m[4]).push({ mode: m[1], oid: m[2], stage: m[3] });
    }
    // HEAD 条目:`<mode> <type> <对象号>\t<路径>\0`;没有 HEAD(还没有提交)⇒ 表空
    const head = new Map();
    const hasHead = g(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).status === 0;
    if (hasHead) {
      const lt = g(["ls-tree", "-z", "HEAD", "--", ...cand]);
      if (lt.status !== 0) cannot("读不到 HEAD 的树", lt);
      for (const e of lt.stdout.split("\0").filter(Boolean)) {
        const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(e);
        if (!m) cannot("HEAD 树条目解析不了", { stderr: e.slice(0, 80) });
        head.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
      }
    }
    const dirty = [], toHash = [];
    for (const rel of cand) {
      const ix = index.get(rel);
      if (!ix) {
        // 只为把标签报准(两种都拒):被 .gitignore 忽略的标 ignored,其余标 untracked
        const ig = spawnSync("git", ["-C", T, "check-ignore", "-q", "--", rel], { encoding: "utf8", windowsHide: true, timeout: 60000 });
        dirty.push({ path: rel, status: ig.status === 0 ? "ignored" : "untracked" });
      } else if (ix.length !== 1 || ix[0].stage !== "0") dirty.push({ path: rel, status: "unmerged" });
      else if (!head.has(rel)) dirty.push({ path: rel, status: "staged-not-in-head" });
      else if (head.get(rel).type !== "blob" || head.get(rel).oid !== ix[0].oid || head.get(rel).mode !== ix[0].mode) dirty.push({ path: rel, status: "staged" });
      else toHash.push(rel);
    }
    if (toHash.length) {
      // 一次算完:每行一个路径进,每行一个对象号出(同序)
      const ho = g(["hash-object", "--stdin-paths"], toHash.join("\n") + "\n");
      const oids = ho.status === 0 ? ho.stdout.split("\n").filter(Boolean) : [];
      if (ho.status !== 0 || oids.length !== toHash.length) cannot("算不出工作区文件的对象号", ho);
      toHash.forEach((rel, i) => {
        if (oids[i] === head.get(rel).oid) return;
        const blob = gRaw(["cat-file", "blob", head.get(rel).oid]);
        if (blob.status === 0 && Buffer.compare(blob.stdout, fs.readFileSync(path.join(T, rel))) === 0) return;
        dirty.push({ path: rel, status: "modified" });
      });
    }
    if (dirty.length) {
      dirty.sort((a, b) => cand.indexOf(a.path) - cand.indexOf(b.path));
      die(7, `覆盖安装被拒:${dirty.length} 个待替换的路径在目标仓里有 git 兜不住的内容(已跟踪的先提交或还原,没跟踪的先提交或挪走,再重跑;什么都没写):` +
        dirty.map((d) => `${d.path}[${d.status}]`).join("、"), { dirty, wouldReplace: cand });
    }
  }
}

// ── 写文件 ─────────────────────────────────────────────────────────────
const files = [];
let changed = 0;
function place(rel, buf, srcLabel) {
  const dst = path.join(T, rel);
  const srcSha = sha(buf);
  const rec = { path: rel, src: srcLabel, srcSha256: srcSha };
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    changed++;
    files.push({ ...rec, status: "created", sha256: srcSha });
    return;
  }
  const cur = fs.readFileSync(dst);
  if (sha(cur) === srcSha) { files.push({ ...rec, status: "unchanged", sha256: srcSha }); return; }
  // CLAUDE.md:去掉安装器自己的托管块后与生成件相同 ⇒ 就是上次装的那份,不写旁件(批 265:重跑幂等)
  if (rel === "CLAUDE.md" && normClaude(cur) === normClaude(buf)) {
    files.push({ ...rec, status: "unchanged", sha256: sha(cur) }); return;
  }
  // CLAUDE.md 除托管块外是空的(观察档装过、现在不带 --observe 重装)⇒ 把生成件写在托管块前面,不写旁件
  //   (红队 a0dfbfce 附 3:原先写出 CLAUDE.custodiet.md,根宪法仍没被引入)
  if (rel === "CLAUDE.md" && normClaude(cur) === "") {
    fs.writeFileSync(dst, Buffer.concat([buf, cur]));
    changed++;
    files.push({ ...rec, status: "prepended", sha256: sha(fs.readFileSync(dst)) }); return;
  }
  // 目标路径本身就是旁件(观察档把示例宪法定向到 AGENTS.custodiet.md)⇒ 不再套一层旁件,一个字节都不写(codex 265-deliverables-r2 §5)
  if (/\.custodiet(\.[^./]+)?$/.test(rel)) {
    files.push({ ...rec, status: "skipped", sha256: sha(cur), note: "旁件位置已有不同内容,未覆盖;自己合并" }); return;
  }
  // 覆盖安装:scripts/ 下的闸件直接替换(干净与否上面预检过了);清单里带替换前的摘要
  if (overwrite && overwritable(rel)) {
    fs.writeFileSync(dst, buf);
    changed++;
    replaced.push(rel);
    files.push({ ...rec, status: "replaced", sha256: srcSha, previousSha256: sha(cur) }); return;
  }
  const sc = sidecarOf(rel), scAbs = path.join(T, sc);
  if (!fs.existsSync(scAbs)) {
    fs.writeFileSync(scAbs, buf);
    changed++;
    files.push({ ...rec, status: "sidecar", sidecar: sc, sha256: sha(cur) });
  } else if (sha(fs.readFileSync(scAbs)) === srcSha) {
    files.push({ ...rec, status: "sidecar-unchanged", sidecar: sc, sha256: sha(cur) });
  } else {
    files.push({ ...rec, status: "skipped", sidecar: sc, sha256: sha(cur),
      note: "目标与旁件都已存在且都与源不同,一个字节都没写" });
  }
}
for (const rel of FILES) {
  const s = path.join(SRC, rel);
  if (!fs.existsSync(s)) die(3, `源文件缺失:${rel}(custodiet 仓不完整)`);
  // 观察档不改模型的工作方式(codex 265-deliverables-r1 附 1:示例宪法写着「开工 batch-goal --arm」,
  //   装成根目录 AGENTS.md 再经 CLAUDE.md 引入 ⇒ 模型照做、开始走「批」流程,闸没拦人却先改了生产流程;
  //   Codex CLI 也原生读根目录 AGENTS.md)。⇒ 示例宪法只落旁件 AGENTS.custodiet.md(law 锚点自测会回退到旁件),
  //   CLAUDE.md 不生成 `@AGENTS.md`,只挂《闸用语》托管块。
  place(observe && rel === "AGENTS.md" ? sidecarOf(rel) : rel, fs.readFileSync(s), rel);
}
if (!observe) for (const [rel, body] of Object.entries(GENERATED)) place(rel, Buffer.from(body, "utf8"), "(generated)");

// ── settings.json:JSON 合并去重 ───────────────────────────────────────
const settings = { path: ".claude/settings.json" };
{
  const p = path.join(T, ".claude", "settings.json");
  let j = {}, existed = fs.existsSync(p), parsed = true, raw = "";
  if (existed) {
    raw = fs.readFileSync(p, "utf8");
    try { j = JSON.parse(raw.replace(/^﻿/, "")); } catch { parsed = false; }
    if (parsed && (j === null || typeof j !== "object" || Array.isArray(j))) parsed = false;
  }
  if (!parsed) {
    // 解析不了就不碰——写旁件给人合并
    const sc = ".claude/settings.custodiet.json";
    const body = JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((e) =>
      [e, [{ hooks: [{ type: "command", command: HOOK_CMD, timeout: 30 }] }]])) }, null, 2) + "\n";
    if (!fs.existsSync(path.join(T, sc))) { fs.writeFileSync(path.join(T, sc), body); changed++; }
    Object.assign(settings, { status: "sidecar", sidecar: sc, note: "现有 settings.json 解析失败或不是对象,未改动" });
  } else {
    const added = [];
    if (j.hooks === undefined) j.hooks = {};
    if (typeof j.hooks !== "object" || j.hooks === null || Array.isArray(j.hooks)) {
      Object.assign(settings, { status: "skipped", note: "hooks 字段不是对象,未改动" });
    } else {
      for (const ev of HOOK_EVENTS) {
        const arr = Array.isArray(j.hooks[ev]) ? j.hooks[ev] : (j.hooks[ev] = []);
        // 去重口径:该事件下任一 hook 命令里已出现闸脚本名 ⇒ 视为已接线(不论写法)
        const wired = arr.some((g) => Array.isArray(g?.hooks) &&
          g.hooks.some((h) => typeof h?.command === "string" && h.command.includes(HOOK_NAME)));
        if (!wired) {
          arr.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 30 }] });
          added.push(ev);
        }
      }
      if (added.length) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
        changed++;
        Object.assign(settings, { status: existed ? "merged" : "created", addedEvents: added });
      } else Object.assign(settings, { status: "unchanged" });
    }
  }
}

// ── 《闸用语》:在目标仓里跑生成器,手册挂进 CLAUDE.md 的托管块(批 265;用户:「可以让模型学会闸的语言风格」) ──
//   托管块用首尾标记圈住,重跑只换标记之间的内容,标记之外一字不动(先例:mise / Ansible blockinfile)。
//   只有开头没有结尾、或标记重复 ⇒ 不动,标 `malformed` 交人看。
const phrasebook = { path: "docs/gate-phrasebook.md", claudeMd: "CLAUDE.md" };
{
  const gen = spawnSync(process.execPath, ["--no-warnings", path.join(T, "scripts", "gate-phrasebook.mjs")], { cwd: T, encoding: "utf8", windowsHide: true, timeout: 60000 });
  phrasebook.status = gen.status === 0 ? "generated" : "failed";
  if (gen.status !== 0) phrasebook.error = String(gen.stdout || gen.stderr || "").split("\n")[0];
}
// 生成失败 ⇒ 不挂引用(挂了 CLAUDE.md 就指向一个不存在或过期的手册),安装器整体报 ok:false(codex 265-r1 附 5)
if (phrasebook.status === "generated") {
  const BEGIN = "<!-- custodiet:begin(安装器托管,勿手改标记之间) -->", END = "<!-- custodiet:end -->";
  const block = `${BEGIN}\n@docs/gate-phrasebook.md\n${END}\n`;
  const p = path.join(T, "CLAUDE.md");
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const nb = cur.split(BEGIN).length - 1, ne = cur.split(END).length - 1;
  if (nb === 0 && ne === 0) {
    fs.writeFileSync(p, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + block); phrasebook.claudeMdStatus = cur ? "appended" : "created"; changed++;
  } else if (nb === 1 && ne === 1 && cur.indexOf(BEGIN) < cur.indexOf(END)) {
    const next = cur.slice(0, cur.indexOf(BEGIN)) + block.trimEnd() + cur.slice(cur.indexOf(END) + END.length);
    if (next !== cur) { fs.writeFileSync(p, next); changed++; phrasebook.claudeMdStatus = "replaced"; } else phrasebook.claudeMdStatus = "unchanged";
  } else phrasebook.claudeMdStatus = "malformed";
}

// ── 观察档(--observe):写 .claude/custodiet-mode;已有该文件不动(用户可能已切回阻断档) ──
const observeFile = { path: ".claude/custodiet-mode", status: "not-requested" };
if (observe) {
  const p = path.join(T, ".claude", "custodiet-mode");
  if (fs.existsSync(p)) observeFile.status = "exists-unchanged";
  else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "observe\n"); observeFile.status = "created"; changed++; }
  // 先按阻断档装过、再带 --observe 重装:根目录的示例宪法与 CLAUDE.md 里的 @AGENTS.md 还在,模型照旧读到批流程 ⇒ 报出来,不替人删
  //   (红队 a30a87d8 BP-6)
  const leftover = [];
  const rootA = path.join(T, "AGENTS.md");
  if (fs.existsSync(rootA) && sha(fs.readFileSync(rootA)) === sha(fs.readFileSync(path.join(SRC, "AGENTS.md")))) leftover.push("AGENTS.md(示例宪法)");
  const cmP = path.join(T, "CLAUDE.md");
  if (fs.existsSync(cmP) && /^@AGENTS\.md\s*$/m.test(fs.readFileSync(cmP, "utf8"))) leftover.push("CLAUDE.md 里的 @AGENTS.md");
  if (leftover.length) observeFile.leftover = leftover;
}

// ── 安装清单(批 266):闸引擎文件的发布件内容摘要 ──────────────────────
//   P 的 D11 要求「提交里改了闸引擎 ⇒ 红队」;装闸 / 升级那次提交全是原样拷入的发布件,审它没有意义
//   (用户 10-19:「红队要么设置成可选,要么就把红队体系完善了」)。闸在 git 事实里核「提交树里的引擎文件 = 清单摘要」⇒ 不要红队。
//   摘要 = CRLF 归一为 LF 后的 sha256,与 hook-stop-closure.mjs 的 contentDigest 同一口径。清单每次安装整份重写,随装闸提交一起提交。
const manifest = { path: ".claude/custodiet-manifest.json" };
{
  // 引擎口径 = 文件顶部从规则 P import 进来的 ENGINE(同一份正则对象,不是抄本)
  const digest = (buf) => crypto.createHash("sha256").update(String(buf).replace(/\r\n/g, "\n"), "utf8").digest("hex");
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version; } catch { /* 无版本 */ }
  // 只记**真正落在原位**的文件(created / unchanged / 覆盖安装的 replaced);已有不同版本而写成旁件的不记——那份不是本次装进去的(红队 aa75af79 BP-5)
  const placed = new Set(files.filter((x) => x.status === "created" || x.status === "unchanged" || x.status === "replaced").map((x) => x.path));
  const entries = {};
  for (const rel of FILES) if (ENGINE.test(rel) && placed.has(rel)) entries[rel] = digest(fs.readFileSync(path.join(SRC, rel), "utf8"));
  // 源树干净与否:安装器读的是源树当前内容,改过没提交的源装进来不算原样装入(红队 aa75af79 BP-1)。取不到 git ⇒ 记 null(闸按「不干净」处理)
  let sourceClean = null, sourceCommit = null;
  try {
    const st = spawnSync("git", ["-C", SRC, "status", "--porcelain", "--", ...FILES], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    const hd = spawnSync("git", ["-C", SRC, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (st.status === 0 && hd.status === 0) { sourceClean = st.stdout.trim() === ""; sourceCommit = hd.stdout.trim(); }
  } catch { /* 取不到 ⇒ null */ }
  const body = JSON.stringify({ name: "custodiet", version, sourceCommit, sourceClean, note: "安装器生成;闸据此认「原样装入的闸引擎」,勿手改", files: entries }, null, 2) + "\n";
  const p = path.join(T, manifest.path);
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  if (cur === body) manifest.status = "unchanged";
  else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); changed++; manifest.status = cur === null ? "created" : "replaced"; }
  manifest.engineFiles = Object.keys(entries).length;
  manifest.sourceClean = sourceClean;
  // 误拦猎手回件 FB-3:目标仓 .gitignore 若挡住清单(例如整个忽略 .claude/),`git add -A` 不会把它带进装闸提交,
  //   闸在提交树里找不到清单 ⇒ 原样装入豁免永远不生效。不替人改 .gitignore,报出来并给命令。
  try {
    const ig = spawnSync("git", ["-C", T, "check-ignore", "-q", manifest.path], { windowsHide: true, timeout: 20000 });
    manifest.ignored = ig.status === 0;
  } catch { manifest.ignored = null; }
  if (sourceClean !== true) process.stderr.write(`⚠ 安装源树${sourceClean === false ? "有未提交的改动" : "不是 git 仓或读不到状态"}:清单照写,但闸不会把这次装闸认作原样装入(装闸提交要红队与误拦猎手两者)\n`);
}

// ── .gitignore:追加闸的运行时台账 ─────────────────────────────────────
const gitignore = { path: ".gitignore" };
{
  // 运行时台账 + 解析依赖的安装目录 + P 的会话基点目录(批 265 比赛用仓预演:原先只加 .claude/ 台账,
  //   `npm --prefix scripts/gate-deps install` 装出的 node_modules 与 .claude/.p-head/ 会被一起提交)
  const want = [...fs.readFileSync(path.join(SRC, ".gitignore"), "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l.startsWith(".claude/")), ".claude/.p-head/", ".claude/.gate-replay/", "scripts/gate-deps/node_modules/"]
    .filter((l, i, a) => a.indexOf(l) === i);
  const p = path.join(T, ".gitignore");
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = want.filter((l) => !have.has(l));
  if (add.length) {
    const sep = cur && !cur.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(p, cur + sep + "# custodiet 收尾闸的运行时台账(按机器演化,不入仓)\n" + add.join("\n") + "\n");
    changed++;
  }
  Object.assign(gitignore, { status: add.length ? (cur ? "appended" : "created") : "unchanged", added: add });
}

// ── 报告 ───────────────────────────────────────────────────────────────
let version = null;
try { version = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version; } catch { /* 无版本 */ }
const notInstalled = NOT_SHIPPED;   // 0.10.0 起 scripts/ 下的闸与工作流件全装,只剩公开树自己用的两件不装
const attention = files.filter((f) => !["created", "unchanged", "prepended", "replaced"].includes(f.status));
if (observeFile.leftover) process.stderr.write(`⚠ 观察档要求不加载示例宪法,但上次安装留下了:${observeFile.leftover.join("、")}——要观察档不改模型工作方式,自己删掉它们再提交。\n`);
for (const f of files) process.stderr.write(`  ${f.status.padEnd(17)} ${f.path}${f.sidecar ? "  → " + f.sidecar : ""}\n`);
process.stderr.write(`  ${settings.status.padEnd(17)} ${settings.path}\n  ${gitignore.status.padEnd(17)} ${gitignore.path}\n`);
if (replaced.length) process.stderr.write(`覆盖安装:替换了 ${replaced.length} 个已存在且内容不同的闸件(清单里 status=replaced,带替换前的摘要;顶层 overwrite.replaced 是全表)。\n`);
if (attention.length) process.stderr.write(`⚠ ${attention.length} 个文件目标里已有不同版本,未覆盖——看清单里的 sidecar/skipped,自己合并` +
  `${overwrite ? "(规矩文件与 agent 定义不受 --overwrite 影响)" : "(scripts/ 下的闸件可以加 --overwrite 直接替换)"}。\n`);
process.stderr.write("未提交任何东西。下一步:在目标仓里跑 `node --no-warnings scripts/hook-stop-closure.mjs --self-test`。\n" +
  "  ⚠ 已知(0.10.0 在临时仓里实测):自测里有几条用例读的是目标仓**真实的 git 历史**(I、G 各 1 条,「接缝」组至多 3 条)——\n" +
  "    装闸件尚未提交时红 4 到 5 条(空仓 5 条);装闸提交之后剩 3 条,要等之后有一次**新增了文件**的提交才全绿\n" +
  "    (判据取的是「最近一次新增过文件的提交」,只改不增的提交不算)。\n" +
  "    没装解析依赖(npm --prefix scripts/gate-deps install)时,「写入三态」组另有 2 条红。\n");
// 阻断档下,规矩文件留在旁件里 ⇒ 落在它上面的法条指针是死的,自检的「law 锚点」把它们标 SIDE 并计失败——
//   这类红不随提交转绿(codex 304-sync-review-r1 第 3 条;本机复现:目标仓自带 AGENTS.md 时 5 条持续红)。这里把条件和出路报出来,不改判据。
const lawSidecars = [];
if (!observe) {
  for (const f of files.filter((x) => ["sidecar", "sidecar-unchanged", "skipped"].includes(x.status))) {
    const hit = RULES.filter((r) => String(r.law || "").split("#")[0] === f.path);
    if (hit.length) lawSidecars.push({ file: f.path, sidecar: f.sidecar || sidecarOf(f.path), rules: hit.map((r) => r.id), anchors: [...new Set(hit.map((r) => String(r.law).split("#")[1]))] });
  }
}
for (const s of lawSidecars) {
  process.stderr.write(`⚠ 目标仓已有自己的 ${s.file}:示例规矩落在旁件 ${s.sidecar} 里(模型不加载旁件)。规则 ${s.rules.join(" / ")} 的法条指针落在这份文件上——\n` +
    `    你自己的 ${s.file} 里没有对应的标题 / 列点句名时,自检的「law 锚点」把这 ${s.rules.length} 条标成 SIDE 并计失败(自检退出码非零),提交多少次都不会转绿。\n` +
    `    出路二选一:①把旁件里这几处并进自己的 ${s.file}:${s.anchors.map((a) => `「${a}」`).join("、")};\n` +
    `              ②用观察档:带 --observe 重跑一次安装器(观察档下 SIDE 不计失败;注意观察档下闸只记账、不阻断)。\n`);
}
const allOk = phrasebook.status === "generated";
if (manifest.ignored) process.stderr.write(`⚠ ${manifest.path} 被目标仓的 .gitignore 挡住:装闸提交前先 \`git add -f ${manifest.path}\`,否则闸认不出这次是原样装入\n`);
if (!allOk) process.stderr.write(`⚠ 《闸用语》手册没生成(${phrasebook.error || "未知原因"}),CLAUDE.md 未挂引用;闸件已装,手册要另跑 node --no-warnings scripts/gate-phrasebook.mjs\n`);
process.stdout.write(JSON.stringify({
  ok: allOk, mode, target: T, source: { name: "custodiet", version },
  preExisting: pre, changed, files, settings, gitignore, observe: observeFile, phrasebook, manifest, notInstalled,
  overwrite: { requested: overwrite, replaced }, lawSidecars,
}) + "\n");
process.exit(allOk ? 0 : 6);

// ── 自测(--self-test)──────────────────────────────────────────────────
//   静态三条(引擎口径同一份、拷贝清单覆盖 scripts/、law 目标文件都在清单里)+ 在系统临时目录里建一次性 git 仓,
//   把本安装器当子进程实跑:普通安装、重装幂等、旁件、覆盖安装、覆盖安装的拒绝(含不读 git status 输出的几种状态与换行反例)、
//   规矩文件不受覆盖开关影响、写入位置经过符号链接 / 落在仓外的拒绝、已有同名手册的拒绝、自带规矩文件时的 lawSidecars。
//   文件符号链接在 Windows 上要特权:建不了就打一行 SKIP、不计数(目录联接的几条照跑)。
//   不碰本仓、不联网;临时目录用完即删。
function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.log(`FAIL  ${name}\n      got =${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`); }
  };
  const self = fileURLToPath(import.meta.url);

  // —— 静态 ——
  const P = RULES.find((r) => r.id === "P");
  t("引擎口径:与规则 P 的 ENGINE_REL 是同一个正则对象", [ENGINE instanceof RegExp, ENGINE === P?._p?.ENGINE_REL], [true, true]);
  // 本文件里不得再有一份抄来的引擎正则(样例串拼接而成:本自测自己也在被查的文本里)
  const copied = ["scripts", "\\/(?:hook-stop-closure"].join("");
  t("引擎口径:本文件里没有抄来的引擎正则", fs.readFileSync(self, "utf8").includes(copied), false);
  const engineInList = FILES.filter((f) => ENGINE.test(f));
  t("引擎口径:拷贝清单里有引擎文件,且 P 新认的件(开批脚本 / 写入检查)算在内",
    [engineInList.length > 0, ENGINE.test("scripts/batch-goal.mjs"), ENGINE.test("scripts/lib/write-checks.mjs"), ENGINE.test("scripts/report-gate.mjs")], [true, true, true, false]);
  t("拷贝清单:源文件都在", FILES.filter((f) => !fs.existsSync(path.join(SRC, f))), []);
  t("拷贝清单:没有重复项", FILES.filter((f, i) => FILES.indexOf(f) !== i), []);
  {
    // scripts/ 下有什么:优先 git 已跟踪的;不在 git 里就走目录(跳过依赖安装目录)
    let tracked = null;
    const ls = spawnSync("git", ["-C", SRC, "ls-files", "-z", "--", "scripts"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (ls.status === 0 && ls.stdout) tracked = ls.stdout.split("\0").filter(Boolean);
    if (!tracked) {
      tracked = [];
      const walk = (rel) => { for (const e of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        if (e.isDirectory()) walk(`${rel}/${e.name}`); else tracked.push(`${rel}/${e.name}`);
      } };
      walk("scripts");
    }
    const known = new Set([...FILES, ...NOT_SHIPPED]);
    t("拷贝清单:scripts/ 下每个文件要么在清单里、要么在「不随包装」的两件里", tracked.filter((f) => !known.has(f)), []);
  }
  t("拷贝清单:每条规则的 law 目标文件都在清单里",
    [...new Set(RULES.map((r) => String(r.law || "").split("#")[0]).filter(Boolean))].filter((f) => !FILES.includes(f)), []);
  t("拷贝清单:旧结构 docs/laws/ 不再出现", FILES.filter((f) => f.startsWith("docs/laws/")), []);

  // —— 实跑 ——
  const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "custodiet-init-selftest-"));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpRoot };
  const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, "-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid",
    "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", windowsHide: true, timeout: 60000, env });
  const mk = (name, seed = {}) => {
    const d = path.join(tmpRoot, name);
    fs.mkdirSync(d, { recursive: true });
    git(d, "init", "-q");
    for (const [rel, body] of Object.entries(seed)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), body); }
    return d;
  };
  const commit = (d, msg) => { git(d, "add", "-A"); return git(d, "commit", "-q", "-m", msg).status; };
  const run = (d, ...extra) => {
    const r = spawnSync(process.execPath, ["--no-warnings", self, "--target", d, ...extra], { encoding: "utf8", windowsHide: true, timeout: 180000, env });
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim().split("\n").at(-1)); } catch { /* 末行不是 JSON ⇒ j=null,断言自然红 */ }
    return { code: r.status, j };
  };
  const read = (d, rel) => { try { return fs.readFileSync(path.join(d, rel), "utf8"); } catch { return null; } };
  const src = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
  const st = (j, rel) => (j?.files || []).find((f) => f.path === rel)?.status ?? null;
  const OLD = "// old\n", TOOL = "scripts/report-gate.mjs", PS1 = "scripts/notify.ps1", ENG = "scripts/lib/gate-cmd.mjs";
  try {
    // ① 空仓普通安装
    const a = mk("plain");
    const r1 = run(a);
    t("普通安装(空仓):退出 0、ok", [r1.code, r1.j?.ok], [0, true]);
    t("普通安装(空仓):清单里每一件都是 created", (r1.j?.files || []).filter((f) => f.status !== "created").map((f) => `${f.path}:${f.status}`), []);
    t("普通安装(空仓):清单覆盖拷贝清单全部 + 生成件 CLAUDE.md", (r1.j?.files || []).map((f) => f.path), [...FILES, "CLAUDE.md"]);
    t("普通安装(空仓):安装清单的引擎文件数 = 拷贝清单里被 P 认作引擎的件数", r1.j?.manifest?.engineFiles, engineInList.length);
    t("普通安装(空仓):安装清单逐条就是这些路径", Object.keys(JSON.parse(read(a, ".claude/custodiet-manifest.json") || "{}").files || {}).sort(), [...engineInList].sort());
    t("普通安装:没要覆盖 ⇒ overwrite.requested=false、replaced 空", r1.j?.overwrite, { requested: false, replaced: [] });
    t("普通安装:装进去的内容与源逐字节相同(抽两件)", [read(a, ENG) === src(ENG), read(a, "docs/gate/AGENTS.md") === src("docs/gate/AGENTS.md")], [true, true]);
    // ② 重装幂等
    const r2 = run(a);
    t("重装:每一件都是 unchanged", [r2.code, (r2.j?.files || []).filter((f) => f.status !== "unchanged").map((f) => `${f.path}:${f.status}`)], [0, []]);
    // ③ 普通安装遇到已存在且不同的闸件 ⇒ 旁件,原件不动
    const b = mk("sidecar", { [TOOL]: OLD });
    commit(b, "seed");
    const r3 = run(b);
    t("普通安装(已有不同版本):写旁件、原件一字不动", [r3.code, st(r3.j, TOOL), read(b, TOOL), read(b, "scripts/report-gate.custodiet.mjs") === src(TOOL)], [0, "sidecar", OLD, true]);
    // ④ 覆盖安装:scripts/ 下的直接替换;规矩文件与 agent 定义照旧只落旁件
    const RULEFILES = ["AGENTS.md", "docs/gate/AGENTS.md", "docs/gate-debts.md", ".claude/agents/_gate-bypass-hunter.md"];
    const c = mk("overwrite", Object.fromEntries([TOOL, PS1, ENG, ...RULEFILES].map((f) => [f, OLD])));
    commit(c, "seed");
    const r4 = run(c, "--overwrite");
    t("覆盖安装:退出 0、ok", [r4.code, r4.j?.ok], [0, true]);
    t("覆盖安装:scripts/ 下三件标 replaced、内容换成源", [TOOL, PS1, ENG].map((f) => [st(r4.j, f), read(c, f) === src(f)]), [["replaced", true], ["replaced", true], ["replaced", true]]);
    t("覆盖安装:末行 JSON 的 overwrite.replaced 列出被替换的路径(按清单顺序)", r4.j?.overwrite, { requested: true, replaced: FILES.filter((f) => [TOOL, PS1, ENG].includes(f)) });
    t("覆盖安装:replaced 条目带替换前的摘要", (r4.j?.files || []).find((f) => f.path === TOOL)?.previousSha256, sha(Buffer.from(OLD)));
    t("覆盖安装:规矩文件与 agent 定义不受开关影响——原件一字不动、落旁件",
      RULEFILES.map((f) => [st(r4.j, f), read(c, f) === OLD, read(c, sidecarOf(f)) === src(f)]), RULEFILES.map(() => ["sidecar", true, true]));
    t("覆盖安装:被替换的引擎文件进安装清单", Object.hasOwn(JSON.parse(read(c, ".claude/custodiet-manifest.json") || "{}").files || {}, ENG), true);
    // ⑤ 覆盖安装的拒绝:待替换的路径不干净 ⇒ 退出 7、列出、一个字节都不写
    const dirtyOf = (r) => (r.j?.dirty || []).map((x) => `${x.path}[${x.status}]`).sort();
    const untouched = (d) => [fs.existsSync(path.join(d, "scripts/hook-stop-closure.mjs")), fs.existsSync(path.join(d, ".claude/custodiet-manifest.json")), fs.existsSync(path.join(d, "AGENTS.md"))];
    const refuse = (name, prep) => {
      const d = mk(name, { [TOOL]: OLD, [PS1]: OLD });
      commit(d, "seed");
      const before = prep(d);
      const r = run(d, "--overwrite");
      return [r.code, r.j?.ok, dirtyOf(r), read(d, TOOL) === before, read(d, PS1) === OLD, ...untouched(d)];
    };
    t("覆盖安装被拒:改了没提交", refuse("dirty-modified", (d) => { fs.writeFileSync(path.join(d, TOOL), "// edited\n"); return "// edited\n"; }),
      [7, false, [`${TOOL}[modified]`], true, true, false, false, false]);
    t("覆盖安装被拒:暂存了没提交", refuse("dirty-staged", (d) => { fs.writeFileSync(path.join(d, TOOL), "// staged\n"); git(d, "add", TOOL); return "// staged\n"; }),
      [7, false, [`${TOOL}[staged]`], true, true, false, false, false]);
    {
      const d = mk("dirty-untracked", { [TOOL]: OLD });
      const r = run(d, "--overwrite");
      t("覆盖安装被拒:未跟踪的同名文件", [r.code, dirtyOf(r), read(d, TOOL), ...untouched(d)], [7, [`${TOOL}[untracked]`], OLD, false, false, false]);
    }
    {
      const d = mk("dirty-ignored", { ".gitignore": "scripts/report-gate.mjs\n", [TOOL]: OLD });
      commit(d, "seed");
      const r = run(d, "--overwrite");
      t("覆盖安装被拒:被 .gitignore 忽略的同名文件", [r.code, dirtyOf(r), read(d, TOOL), ...untouched(d)], [7, [`${TOOL}[ignored]`], OLD, false, false, false]);
    }
    // —— 回修 2(codex 304-sync-review-r1):预检不读 git status 的输出;回件里的三个最小状态各一例,另补同族 ——
    {
      const d = mk("r2-untracked-hidden", { [TOOL]: OLD });
      git(d, "config", "status.showUntrackedFiles", "no");
      const r = run(d, "--overwrite");
      t("回修2:status.showUntrackedFiles=no + 未跟踪的同名文件 ⇒ 拒、原文件不动", [r.code, dirtyOf(r), read(d, TOOL), ...untouched(d)], [7, [`${TOOL}[untracked]`], OLD, false, false, false]);
    }
    {
      const d = mk("r2-ignored-hidden", { ".gitignore": "scripts/report-gate.mjs\n", [TOOL]: OLD });
      commit(d, "seed");
      git(d, "config", "status.showUntrackedFiles", "no");
      const r = run(d, "--overwrite");
      t("回修2:被忽略的同名文件 + status.showUntrackedFiles=no ⇒ 拒、原文件不动", [r.code, dirtyOf(r), read(d, TOOL), ...untouched(d)], [7, [`${TOOL}[ignored]`], OLD, false, false, false]);
    }
    t("回修2:assume-unchanged 后再改 ⇒ 拒、改动还在", refuse("r2-assume-unchanged", (d) => { git(d, "update-index", "--assume-unchanged", TOOL); fs.writeFileSync(path.join(d, TOOL), "// edited\n"); return "// edited\n"; }),
      [7, false, [`${TOOL}[modified]`], true, true, false, false, false]);
    t("回修2:skip-worktree 后再改 ⇒ 拒、改动还在", refuse("r2-skip-worktree", (d) => { git(d, "update-index", "--skip-worktree", TOOL); fs.writeFileSync(path.join(d, TOOL), "// edited\n"); return "// edited\n"; }),
      [7, false, [`${TOOL}[modified]`], true, true, false, false, false]);
    {
      // 首次提交之后才 git add、从没提交过:HEAD 里没有这份内容
      const d = mk("r2-staged-new", { "README.md": "x\n" });
      commit(d, "seed");
      fs.mkdirSync(path.join(d, "scripts"), { recursive: true }); fs.writeFileSync(path.join(d, TOOL), OLD); git(d, "add", TOOL);
      const r = run(d, "--overwrite");
      t("回修2:已暂存但 HEAD 里没有(从没提交过)⇒ 拒", [r.code, dirtyOf(r), read(d, TOOL)], [7, [`${TOOL}[staged-not-in-head]`], OLD]);
    }
    {
      const d = mk("r2-unborn", { [TOOL]: OLD });
      git(d, "add", "-A");
      const r = run(d, "--overwrite");
      t("回修2:还没有任何提交、文件只在暂存区 ⇒ 拒", [r.code, dirtyOf(r), read(d, TOOL)], [7, [`${TOOL}[staged-not-in-head]`], OLD]);
    }
    {
      // 只改了换行:autocrlf 关着时 git 也认它是改动 ⇒ 拒
      const d = mk("r2-eol-only", { [TOOL]: "// a\n// b\n" });
      commit(d, "seed");
      git(d, "config", "core.autocrlf", "false");
      fs.writeFileSync(path.join(d, TOOL), "// a\r\n// b\r\n");
      const r = run(d, "--overwrite");
      t("回修2:只改了换行、仓里关着 autocrlf(git 也认它是改动)⇒ 拒", [r.code, dirtyOf(r)], [7, [`${TOOL}[modified]`]]);
    }
    {
      // 反例:HEAD 里是 LF,工作区是 autocrlf 检出的 CRLF ⇒ git 眼里没改 ⇒ 不误拒
      const d = mk("r2-autocrlf", { [TOOL]: "// a\n// b\n" });
      commit(d, "seed");
      git(d, "config", "core.autocrlf", "true");
      fs.writeFileSync(path.join(d, TOOL), "// a\r\n// b\r\n");
      const r = run(d, "--overwrite");
      t("回修2 反例:autocrlf 检出的 CRLF(HEAD 里是 LF)不误拒 ⇒ 照常替换", [r.code, st(r.j, TOOL), read(d, TOOL) === src(TOOL)], [0, "replaced", true]);
    }
    {
      // 反例:HEAD 里本来就存着 CRLF,工作区逐字节相同,仓里开着 autocrlf ⇒ 不误拒
      const d = mk("r2-crlf-in-head", { [TOOL]: "// a\r\n// b\r\n" });
      commit(d, "seed");
      git(d, "config", "core.autocrlf", "true");
      const r = run(d, "--overwrite");
      t("回修2 反例:HEAD 里本来就是 CRLF、工作区逐字节相同 ⇒ 照常替换", [r.code, st(r.j, TOOL)], [0, "replaced"]);
    }
    {
      const d = mk("r2-assume-clean", { [TOOL]: OLD });
      commit(d, "seed");
      git(d, "update-index", "--assume-unchanged", TOOL);
      const r = run(d, "--overwrite");
      t("回修2 反例:标了 assume-unchanged 但没改 ⇒ 照常替换", [r.code, st(r.j, TOOL)], [0, "replaced"]);
    }
    {
      // 不干净的是**不在待替换之列**的文件 ⇒ 不拦(只核要被替换的那些路径)
      const d = mk("dirty-elsewhere", { [TOOL]: OLD, "README.md": "x\n" });
      commit(d, "seed");
      fs.writeFileSync(path.join(d, "README.md"), "y\n");
      const r = run(d, "--overwrite");
      t("覆盖安装:别的文件不干净不拦", [r.code, st(r.j, TOOL), read(d, "README.md")], [0, "replaced", "y\n"]);
    }
    {
      // 同一份脏文件,不带开关 ⇒ 老行为(旁件),不拒
      const d = mk("dirty-plain", { [TOOL]: OLD });
      const r = run(d);
      t("普通安装不受干净检查约束(未跟踪的同名文件照旧落旁件)", [r.code, st(r.j, TOOL), read(d, TOOL)], [0, "sidecar", OLD]);
    }
    {
      const d = mk("overwrite-empty");
      const r = run(d, "--overwrite");
      t("覆盖安装(空仓,没有可替换的):等同普通安装", [r.code, r.j?.overwrite, (r.j?.files || []).filter((f) => f.status !== "created").length], [0, { requested: true, replaced: [] }, 0]);
    }

    // —— 回修 1(codex 304-sync-review-r1):写入位置经过符号链接 / 落在仓外 ⇒ 退出 8、列出、一个字节不写 ——
    //   目录用联接(Windows 上不要特权;别的系统上就是目录符号链接);文件符号链接在 Windows 上要特权,建不了就打 SKIP、不计数。
    const countAll = (dir) => { try { return fs.readdirSync(dir, { recursive: true }).length; } catch { return -1; } };
    const unsafeOf = (r) => (r.j?.unsafePaths || []).map((u) => `${u.path}[${u.why}]`);
    for (const flag of [[], ["--overwrite"]]) {
      const label = flag.length ? "覆盖安装" : "普通安装";
      const out = path.join(tmpRoot, `outside-${flag.length}`); fs.mkdirSync(out);
      const d = mk(`r1-scripts-junction-${flag.length}`, { "README.md": "x\n" });
      commit(d, "seed");
      fs.symlinkSync(out, path.join(d, "scripts"), "junction");
      const r = run(d, ...flag);
      t(`回修1:scripts/ 是指到仓外的目录联接 ⇒ ${label}拒(退出 8)、仓外一个字节不写、仓里也没装`,
        [r.code, r.j?.ok, unsafeOf(r), countAll(out), fs.existsSync(path.join(d, ".claude")), fs.existsSync(path.join(d, "AGENTS.md"))], [8, false, ["scripts[是符号链接]"], 0, false, false]);
    }
    {
      // 链接指向仓内另一处也拒:沿它写会盖掉仓里别的文件
      const d = mk("r1-docs-junction-inside", { "mydocs/keep.md": "mine\n" });
      commit(d, "seed");
      fs.symlinkSync(path.join(d, "mydocs"), path.join(d, "docs"), "junction");
      const r = run(d);
      t("回修1:docs/ 是指到仓内另一个目录的联接 ⇒ 拒、那个目录里什么都没多", [r.code, unsafeOf(r), countAll(path.join(d, "mydocs")), fs.existsSync(path.join(d, "scripts"))], [8, ["docs[是符号链接]"], 1, false]);
    }
    {
      const out = path.join(tmpRoot, "outside-claude"); fs.mkdirSync(out);
      const d = mk("r1-claude-junction");
      fs.symlinkSync(out, path.join(d, ".claude"), "junction");
      const r = run(d);
      t("回修1:.claude/ 是目录联接(settings / 清单 / agent 的写入位置)⇒ 拒、列出受影响的写入路径数", [r.code, (r.j?.unsafePaths || []).map((u) => [u.path, u.affects.length > 0]), countAll(out), fs.existsSync(path.join(d, "scripts"))], [8, [[".claude", true]], 0, false]);
    }
    {
      // 目标路径**本身**是链接(不是父目录):这里用目录联接顶替——文件符号链接在本类机器上建不了(见下一条的 SKIP),走的是同一个判断
      const d = mk("r1-leaf-junction", { "keep/a.md": "mine\n" });
      commit(d, "seed");
      fs.mkdirSync(path.join(d, "scripts"));
      fs.symlinkSync(path.join(d, "keep"), path.join(d, TOOL), "junction");
      fs.symlinkSync(path.join(d, "keep"), path.join(d, "AGENTS.custodiet.md"), "junction");
      const r = run(d, "--overwrite");
      t("回修1:写入路径本身是链接(scripts/ 下的拷贝件、规矩文件的旁件位置各一)⇒ 拒、链接指向的目录不动",
        [r.code, unsafeOf(r).sort(), countAll(path.join(d, "keep")), fs.existsSync(path.join(d, "scripts/hook-stop-closure.mjs"))], [8, ["AGENTS.custodiet.md[是符号链接]", `${TOOL}[是符号链接]`], 1, false]);
    }
    {
      // 回件的最小状态:已提交、干净的 scripts/report-gate.mjs 是指向 ../AGENTS.md 的符号链接,AGENTS.md 有未提交内容,跑 --overwrite
      const d = mk("r1-file-symlink", { "AGENTS.md": "# mine\n" });
      fs.mkdirSync(path.join(d, "scripts"));
      let made = null;
      try { fs.symlinkSync("../AGENTS.md", path.join(d, TOOL), "file"); } catch (e) { made = e?.code || String(e); }
      if (made) console.log(`SKIP  回修1:文件符号链接 scripts/report-gate.mjs → ../AGENTS.md(本机建不了文件符号链接:${made};目录联接的几条照跑)`);
      else {
        git(d, "-c", "core.symlinks=true", "add", "-A"); git(d, "commit", "-q", "-m", "seed");
        fs.writeFileSync(path.join(d, "AGENTS.md"), "# mine\nuncommitted\n");
        for (const flag of [["--overwrite"], []]) {
          const r = run(d, ...flag);
          t(`回修1:scripts/report-gate.mjs 是指向 ../AGENTS.md 的符号链接 ⇒ ${flag.length ? "覆盖安装" : "普通安装"}拒、AGENTS.md 一字不动`,
            [r.code, unsafeOf(r), read(d, "AGENTS.md"), fs.existsSync(path.join(d, "scripts/hook-stop-closure.mjs"))], [8, [`${TOOL}[是符号链接]`], "# mine\nuncommitted\n", false]);
        }
      }
    }

    // —— 回修 4(codex 304-sync-review-r1):已有不是生成器写的同名手册 ⇒ 预检就拒(退出 9),不留半截安装 ——
    t("回修4:判据与生成器同一句(生成器源码里是同一个标题串)", fs.readFileSync(path.join(SRC, "scripts/gate-phrasebook.mjs"), "utf8").includes(`startsWith(${JSON.stringify(PHRASEBOOK_HEAD)})`), true);
    for (const flag of [[], ["--overwrite"], ["--observe"]]) {
      const d = mk(`r4-own-phrasebook-${flag.join("") || "plain"}`, { [PHRASEBOOK_REL]: "# 我自己的手册\n" });
      commit(d, "seed");
      const r = run(d, ...flag);
      t(`回修4:已有自己写的 ${PHRASEBOOK_REL}(${flag.join(" ") || "普通安装"})⇒ 退出 9、什么都没写、手册不动`,
        [r.code, r.j?.ok, r.j?.conflict, read(d, PHRASEBOOK_REL), fs.existsSync(path.join(d, "scripts")), fs.existsSync(path.join(d, ".claude")), fs.existsSync(path.join(d, "CLAUDE.md")), fs.existsSync(path.join(d, ".gitignore"))],
        [9, false, PHRASEBOOK_REL, "# 我自己的手册\n", false, false, false, false]);
    }
    {
      const d = mk("r4-generated-phrasebook", { [PHRASEBOOK_REL]: `${PHRASEBOOK_HEAD}\n\n旧的一版\n` });
      commit(d, "seed");
      const r = run(d);
      t("回修4 反例:已有的是生成器写的旧版 ⇒ 照常装、手册重新生成", [r.code, r.j?.phrasebook?.status, (read(d, PHRASEBOOK_REL) || "").includes("旧的一版")], [0, "generated", false]);
    }

    // —— 回修 3(codex 304-sync-review-r1):目标仓自带规矩文件 ⇒ 法条指针留在旁件里,清单与提示把条件报出来(判据不动)——
    {
      const lawOn = (file) => RULES.filter((r) => String(r.law || "").split("#")[0] === file).map((r) => r.id);
      const d = mk("r3-own-agents", { "AGENTS.md": "# Project guidelines\n" });
      commit(d, "seed");
      const r = run(d);
      t("回修3:目标仓已有自己的 AGENTS.md、普通安装 ⇒ 清单 lawSidecars 报出文件、旁件、落在上面的规则",
        [r.code, st(r.j, "AGENTS.md"), (r.j?.lawSidecars || []).map((s) => [s.file, s.sidecar, s.rules, s.anchors.length > 0]), lawOn("AGENTS.md").length > 0],
        [0, "sidecar", [["AGENTS.md", "AGENTS.custodiet.md", lawOn("AGENTS.md"), true]], true]);
      const o = mk("r3-own-agents-observe", { "AGENTS.md": "# Project guidelines\n", "docs/gate/AGENTS.md": "# 我的闸规矩\n" });
      commit(o, "seed");
      const ro = run(o, "--observe");
      t("回修3 反例:自带两份规矩文件的仓用 --observe 装 ⇒ 不报(观察档下旁件里的指针不计失败)", [ro.code, st(ro.j, "docs/gate/AGENTS.md"), ro.j?.lawSidecars], [0, "sidecar", []]);
      t("回修3 反例:空仓普通安装 ⇒ 不报", r1.j?.lawSidecars, []);
      const g2 = mk("r3-own-gate-rules", { "docs/gate/AGENTS.md": "# 我的闸规矩\n" });
      commit(g2, "seed");
      t("回修3:自带的是 docs/gate/AGENTS.md ⇒ 同样报出", (run(g2).j?.lawSidecars || []).map((s) => [s.file, s.rules]), [["docs/gate/AGENTS.md", lawOn("docs/gate/AGENTS.md")]]);
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
  }
  console.log(`custodiet-init 自测 ${pass}/${pass + fail}`);
  return fail ? 1 : 0;
}
