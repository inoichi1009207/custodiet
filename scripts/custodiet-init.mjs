#!/usr/bin/env node
// custodiet-init.mjs —— 把收尾闸装进一个**已有的 git 仓**(拷贝模式;第一刀)
//
// 干什么:从本仓(custodiet)拷出运行期闸件 + 示例宪法 + 示例法典 + 红队 agent 到目标仓,
//        把 Stop / SubagentStop hook 合并进目标的 `.claude/settings.json`,
//        把闸的运行时台账追加进目标的 `.gitignore`。stdout 末行是一行 JSON 清单。
//
// 不变量(改它们之前先想清楚为什么):
//   · **已存在的文件一律不覆盖**:内容相同 ⇒ unchanged;不同 ⇒ 写旁件 `<名>.custodiet<扩展名>`
//     并在清单里标 `sidecar`(旁件也已存在且不同 ⇒ `skipped`,一个字节都不写)。
//     ⚠️ 对 `scripts/` 下的闸件这意味着:目标仓里**旧的那份仍是生效的那份**,清单如实报出。
//   · `.claude/settings.json` 只做 JSON 合并去重(按命令串去重);解析不了 ⇒ 不碰它,写旁件。
//   · 不提交、不 `git init`:目标不是 git 仓 ⇒ 退出 3 并说明。
//   · 纯 node,无依赖;不联网;不碰用户级 `~/.claude/`。
//
// 不装的件(开发件或宿主件):coverage-check、gate-migrate-check、ledger-anchor(要 OS 级计划任务)。
// 天花板:只管「文件就位 + 接线」;装上之后闸判得对不对,看目标仓里
//   `node --no-warnings scripts/hook-stop-closure.mjs --self-test`。
//   文本类规则的判据是中文句式 ⇒ 目前只适用于中文协作的仓(英文仓里这些规则不误拦,只会全哑)。
//
// 用法:  node scripts/custodiet-init.mjs --target <目标仓根> [--mode copy]
// 退出码:0 完成(含有旁件/跳过的情形,看清单)  2 参数错  3 目标不存在或不是 git 仓根  4 node 版本过低
//        5 插件模式尚未实现

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 源→目的同路径。顺序即清单顺序。
const FILES = [
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
  "scripts/lib/ledger-chain.mjs",
  "AGENTS.md",
  "docs/laws/collab.md",
  "docs/laws/reporting.md",
  // DP 项的 law 锚点所在(DP 本身在仓里没有欠账探针脚本时沉默,但锚点自测照核)。
  "docs/laws/production.md",
  // 名词日记是 ND 项的 law 锚点所在;缺席时 ND 静默退场,但 law 锚点自测会报该锚点无目标。
  "docs/noun-diary.md",
  // P 在「提交触及闸引擎文件」时,独立视角通道只认这个红队 agent。不随包装 ⇒ 新仓的装闸提交无出路阻断(第一刀 B1 实测)。
  // ⚠️ 落盘后 Claude Code 不一定在**同一会话**里就列出它(agent 清单的刷新时机未核实:本机 changelog 未检到明确条目);装完最好新开会话再提交。
  ".claude/agents/_gate-bypass-hunter.md",
];
// 生成件(没有源文件):内容即源。
const GENERATED = { "CLAUDE.md": "@AGENTS.md\n" };
const HOOK_CMD = 'node --no-warnings "$CLAUDE_PROJECT_DIR/scripts/hook-stop-closure.mjs"';
const HOOK_EVENTS = ["Stop", "SubagentStop"];
const HOOK_NAME = "hook-stop-closure.mjs";

function die(code, msg) {
  process.stderr.write(`custodiet-init: ${msg}\n`);
  process.stdout.write(JSON.stringify({ ok: false, exit: code, error: msg }) + "\n");
  process.exit(code);
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sidecarOf = (rel) => {
  const ext = path.extname(rel);
  return ext ? rel.slice(0, -ext.length) + ".custodiet" + ext : rel + ".custodiet";
};

// ── 参数 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let target = null, mode = "copy";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--target") target = argv[++i];
  else if (a === "--mode") mode = argv[++i];
  else if (a === "-h" || a === "--help") {
    process.stdout.write("用法: node scripts/custodiet-init.mjs --target <目标仓根> [--mode copy]\n");
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

const pre = ["AGENTS.md", "CLAUDE.md", ".claude/settings.json", "package.json", "docs/laws"]
  .filter((p) => fs.existsSync(path.join(T, p)));

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
  place(rel, fs.readFileSync(s), rel);
}
for (const [rel, body] of Object.entries(GENERATED)) place(rel, Buffer.from(body, "utf8"), "(generated)");

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

// ── .gitignore:追加闸的运行时台账 ─────────────────────────────────────
const gitignore = { path: ".gitignore" };
{
  const want = fs.readFileSync(path.join(SRC, ".gitignore"), "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l.startsWith(".claude/"));
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
const notInstalled = ["scripts/coverage-check.mjs", "scripts/gate-migrate-check.mjs", "scripts/lib/ledger-anchor.mjs"];
const attention = files.filter((f) => f.status !== "created" && f.status !== "unchanged");
for (const f of files) process.stderr.write(`  ${f.status.padEnd(17)} ${f.path}${f.sidecar ? "  → " + f.sidecar : ""}\n`);
process.stderr.write(`  ${settings.status.padEnd(17)} ${settings.path}\n  ${gitignore.status.padEnd(17)} ${gitignore.path}\n`);
if (attention.length) process.stderr.write(`⚠ ${attention.length} 个文件目标里已有不同版本,未覆盖——看清单里的 sidecar/skipped,自己合并。\n`);
process.stderr.write("未提交任何东西。下一步:在目标仓里跑 `node --no-warnings scripts/hook-stop-closure.mjs --self-test`。\n" +
  "  ⚠ 已知(第一刀实测):自测里有 2 条 I 类用例读的是目标仓**真实的 git 历史**(git ls-files / 末次提交新增的文件)——\n" +
  "    装闸件尚未提交、或装闸那次提交恰好是 HEAD 时,这 2 条会红;装闸提交之后再有一次提交即转绿。\n");
process.stdout.write(JSON.stringify({
  ok: true, mode, target: T, source: { name: "custodiet", version },
  preExisting: pre, changed, files, settings, gitignore, notInstalled,
}) + "\n");
process.exit(0);
