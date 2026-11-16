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
//     另在清单顶层 `overwrite.replaced` 列出全部被替换的路径。替换前先核这些路径在目标仓的 git 工作区是干净的——
//     改了没提交、暂存了没提交、未跟踪、被忽略,有任何一种 ⇒ 退出 7、逐个列出、**一个字节都不写**(被替换的内容必须能从 git 里拿回来)。
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
  // 0.10.0:收尾钩子与开批脚本静态 import 的五件(此前公开树缺它们)+ 写入检查的自测
  "scripts/lib/write-state.mjs",
  "scripts/lib/install-config.mjs",
  "scripts/lib/obligations.mjs",
  "scripts/lib/debt-schema.mjs",
  "scripts/lib/write-checks.mjs",
  "scripts/lib/write-checks.selftest.mjs",
  "scripts/lib/debt-facts.mjs",
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
      "             替换前先核这些路径在目标仓的 git 工作区是干净的;改了没提交 / 暂存了没提交 / 未跟踪 / 被忽略\n" +
      "             ⇒ 退出 7、逐个列出、一个字节都不写。替换了哪些:清单里 status=replaced,顶层 overwrite.replaced。\n" +
      "             规矩文件(AGENTS.md、docs/ 下的)与 .claude/agents/ 下的不受这个开关影响,照旧只落旁件。\n" +
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

// ── 覆盖安装的预检(先于任何写入)──────────────────────────────────────
//   只管 scripts/ 下的闸件。规矩文件(AGENTS.md、docs/)与 agent 定义永远走旁件——目标仓自己的规矩不能被安装器盖掉。
const overwritable = (rel) => rel.startsWith("scripts/");
const replaced = [];
if (overwrite) {
  const cand = FILES.filter((rel) => {
    if (!overwritable(rel)) return false;
    const s = path.join(SRC, rel), d = path.join(T, rel);
    return fs.existsSync(s) && fs.existsSync(d) && sha(fs.readFileSync(d)) !== sha(fs.readFileSync(s));
  });
  if (cand.length) {
    // 待替换的路径在目标仓里有没有 git 兜不住的内容:改了没提交、暂存了没提交、未跟踪、被忽略——有任何一种就整个不装。
    //   git 跑不了 / 退出非零 ⇒ 证明不了干净 ⇒ 同样拒绝。
    const st = spawnSync("git", ["-C", T, "status", "--porcelain=v1", "--ignored", "-z", "--", ...cand], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    if (st.status !== 0) {
      die(7, `覆盖安装被拒:读不到目标仓的 git 状态(${String(st.stderr || st.error?.message || "").trim().split("\n")[0]}),证明不了待替换的路径是干净的`, { dirty: null, wouldReplace: cand });
    }
    const dirty = [];
    const ent = st.stdout.split("\0").filter(Boolean);
    for (let i = 0; i < ent.length; i++) {
      const xy = ent[i].slice(0, 2);
      dirty.push({ path: ent[i].slice(3), status: xy.trim() || xy });
      if (/[RC]/.test(xy)) i++;   // 改名 / 复制:下一项是旧路径,不单算
    }
    if (dirty.length) {
      die(7, `覆盖安装被拒:${dirty.length} 个待替换的路径在目标仓里有未提交的内容(先提交或还原,再重跑):` +
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
  "  ⚠ 已知(第一刀实测):自测里有 2 条 I 类用例读的是目标仓**真实的 git 历史**(git ls-files / 末次提交新增的文件)——\n" +
  "    装闸件尚未提交、或装闸那次提交恰好是 HEAD 时,这 2 条会红;装闸提交之后再有一次提交即转绿。\n");
const allOk = phrasebook.status === "generated";
if (manifest.ignored) process.stderr.write(`⚠ ${manifest.path} 被目标仓的 .gitignore 挡住:装闸提交前先 \`git add -f ${manifest.path}\`,否则闸认不出这次是原样装入\n`);
if (!allOk) process.stderr.write(`⚠ 《闸用语》手册没生成(${phrasebook.error || "未知原因"}),CLAUDE.md 未挂引用;闸件已装,手册要另跑 node --no-warnings scripts/gate-phrasebook.mjs\n`);
process.stdout.write(JSON.stringify({
  ok: allOk, mode, target: T, source: { name: "custodiet", version },
  preExisting: pre, changed, files, settings, gitignore, observe: observeFile, phrasebook, manifest, notInstalled,
  overwrite: { requested: overwrite, replaced },
}) + "\n");
process.exit(allOk ? 0 : 6);

// ── 自测(--self-test)──────────────────────────────────────────────────
//   静态三条(引擎口径同一份、拷贝清单覆盖 scripts/、law 目标文件都在清单里)+ 在系统临时目录里建一次性 git 仓,
//   把本安装器当子进程实跑:普通安装、重装幂等、旁件、覆盖安装、覆盖安装的四种拒绝、规矩文件不受覆盖开关影响。
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
    const refuse = (name, prep) => {
      const d = mk(name, { [TOOL]: OLD, [PS1]: OLD });
      commit(d, "seed");
      const before = prep(d);
      const r = run(d, "--overwrite");
      return [r.code, r.j?.ok, (r.j?.dirty || []).map((x) => `${x.path}[${x.status}]`).sort(), read(d, TOOL) === before, read(d, PS1) === OLD,
        fs.existsSync(path.join(d, "scripts/hook-stop-closure.mjs")), fs.existsSync(path.join(d, ".claude/custodiet-manifest.json")), fs.existsSync(path.join(d, "AGENTS.md"))];
    };
    t("覆盖安装被拒:改了没提交", refuse("dirty-modified", (d) => { fs.writeFileSync(path.join(d, TOOL), "// edited\n"); return "// edited\n"; }),
      [7, false, [`${TOOL}[M]`], true, true, false, false, false]);
    t("覆盖安装被拒:暂存了没提交", refuse("dirty-staged", (d) => { fs.writeFileSync(path.join(d, TOOL), "// staged\n"); git(d, "add", TOOL); return "// staged\n"; }),
      [7, false, [`${TOOL}[M]`], true, true, false, false, false]);
    {
      const d = mk("dirty-untracked", { [TOOL]: OLD });
      const r = run(d, "--overwrite");
      t("覆盖安装被拒:未跟踪的同名文件", [r.code, (r.j?.dirty || []).map((x) => `${x.path}[${x.status}]`), read(d, TOOL), fs.existsSync(path.join(d, "scripts/hook-stop-closure.mjs"))], [7, [`${TOOL}[??]`], OLD, false]);
    }
    {
      const d = mk("dirty-ignored", { ".gitignore": "scripts/report-gate.mjs\n", [TOOL]: OLD });
      commit(d, "seed");
      const r = run(d, "--overwrite");
      t("覆盖安装被拒:被 .gitignore 忽略的同名文件", [r.code, (r.j?.dirty || []).map((x) => `${x.path}[${x.status}]`), read(d, TOOL), fs.existsSync(path.join(d, "scripts/hook-stop-closure.mjs"))], [7, [`${TOOL}[!!]`], OLD, false]);
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
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
  }
  console.log(`custodiet-init 自测 ${pass}/${pass + fail}`);
  return fail ? 1 : 0;
}
