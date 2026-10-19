#!/usr/bin/env node
// custodiet-init.mjs —— 把收尾闸装进一个**已有的 git 仓**(拷贝模式;第一刀)
//
// 干什么:从本仓(custodiet)拷出运行期闸件 + 示例宪法 + 示例法典 + 红队 agent 到目标仓,
//        把 Stop / SubagentStop hook 合并进目标的 `.claude/settings.json`,
//        把闸的运行时台账追加进目标的 `.gitignore`。stdout 末行是一行 JSON 清单。
//
// 不变量(改它们之前先想清楚为什么):
//   · **已存在的拷贝件一律不覆盖**(`CLAUDE.md` 例外:托管块追加/替换,除托管块外为空时前置生成件):内容相同 ⇒ unchanged;不同 ⇒ 写旁件 `<名>.custodiet<扩展名>`
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
// 用法:  node scripts/custodiet-init.mjs --target <目标仓根> [--mode copy] [--observe]
// 退出码:0 完成(含有旁件/跳过的情形,看清单)  2 参数错  3 目标不存在或不是 git 仓根  4 node 版本过低
//        5 插件模式尚未实现

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
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
  // 同理:gate-rules.mjs 顶部 import 它(I / J / G / L 的写入效果分析)。解析依赖 tree-sitter 由 gate-deps 清单另装;
  //   没装时它报「解析器缺席」,规则退回旧判法,不崩。
  "scripts/lib/write-effects.mjs",
  "scripts/gate-deps/package.json",
  "scripts/gate-deps/package-lock.json",
  // 自签误报的 codex 盲审;batch-goal --clear 在场才后台发车。它经 scripts/codex-run.mjs 调本机 codex CLI(只读沙箱);
  //   没装 codex 时盲审只出一行 ⚠,不拦结清。
  "scripts/fp-audit.mjs",
  "scripts/codex-run.mjs",
  // 批 265:《闸用语》生成器;装完在目标仓里跑一次,手册挂进 CLAUDE.md,新会话一开始就读到闸认的说法
  "scripts/gate-phrasebook.mjs",
  // 批 266:误拦通道回放器;P 的 D11 在闸引擎面要误拦猎手 `_gate-false-block-hunter` 跑它(改前 / 改后两版规则在真实转录上回放)
  "scripts/gate-replay.mjs",
  ".claude/agents/_gate-false-block-hunter.md",
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
// CLAUDE.md 比较口径:去掉托管块、统一换行、裁首尾空白(红队 a30a87d8 BP-5:原先幂等判断精确相等、前置判断裁空白,
//   两者口径不一 ⇒ 末尾多一个空行或被 git 换成 CRLF 时,第二次重装就写出 CLAUDE.custodiet.md)
const normClaude = (t) => String(t).replace(/\r\n/g, "\n").replace(/<!-- custodiet:begin[\s\S]*?<!-- custodiet:end -->\n?/, "").trim();
const sidecarOf = (rel) => {
  const ext = path.extname(rel);
  return ext ? rel.slice(0, -ext.length) + ".custodiet" + ext : rel + ".custodiet";
};

// ── 参数 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let target = null, mode = "copy", observe = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--target") target = argv[++i];
  else if (a === "--mode") mode = argv[++i];
  else if (a === "--observe") observe = true;   // 批 265:装成观察档(只落账不阻断),新仓先攒数据,按数据修规则后整体切回阻断
  else if (a === "-h" || a === "--help") {
    process.stdout.write("用法: node scripts/custodiet-init.mjs --target <目标仓根> [--mode copy] [--observe]\n" +
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
  const ENGINE = /^scripts\/(?:hook-stop-closure|hook-guard|fp-audit|gate-replay)\.mjs$|^scripts\/lib\/(?:gate-[\w-]+|write-effects)\.mjs$|^scripts\/gate-deps\/package(?:-lock)?\.json$/i;
  const digest = (buf) => crypto.createHash("sha256").update(String(buf).replace(/\r\n/g, "\n"), "utf8").digest("hex");
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version; } catch { /* 无版本 */ }
  // 只记**真正落在原位**的文件(created / unchanged);已有不同版本而写成旁件的不记——那份不是本次装进去的(红队 aa75af79 BP-5)
  const placed = new Set(files.filter((x) => x.status === "created" || x.status === "unchanged").map((x) => x.path));
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
const notInstalled = ["scripts/coverage-check.mjs", "scripts/gate-migrate-check.mjs", "scripts/lib/ledger-anchor.mjs"];
const attention = files.filter((f) => !["created", "unchanged", "prepended"].includes(f.status));
if (observeFile.leftover) process.stderr.write(`⚠ 观察档要求不加载示例宪法,但上次安装留下了:${observeFile.leftover.join("、")}——要观察档不改模型工作方式,自己删掉它们再提交。\n`);
for (const f of files) process.stderr.write(`  ${f.status.padEnd(17)} ${f.path}${f.sidecar ? "  → " + f.sidecar : ""}\n`);
process.stderr.write(`  ${settings.status.padEnd(17)} ${settings.path}\n  ${gitignore.status.padEnd(17)} ${gitignore.path}\n`);
if (attention.length) process.stderr.write(`⚠ ${attention.length} 个文件目标里已有不同版本,未覆盖——看清单里的 sidecar/skipped,自己合并。\n`);
process.stderr.write("未提交任何东西。下一步:在目标仓里跑 `node --no-warnings scripts/hook-stop-closure.mjs --self-test`。\n" +
  "  ⚠ 已知(第一刀实测):自测里有 2 条 I 类用例读的是目标仓**真实的 git 历史**(git ls-files / 末次提交新增的文件)——\n" +
  "    装闸件尚未提交、或装闸那次提交恰好是 HEAD 时,这 2 条会红;装闸提交之后再有一次提交即转绿。\n");
const allOk = phrasebook.status === "generated";
if (!allOk) process.stderr.write(`⚠ 《闸用语》手册没生成(${phrasebook.error || "未知原因"}),CLAUDE.md 未挂引用;闸件已装,手册要另跑 node --no-warnings scripts/gate-phrasebook.mjs\n`);
process.stdout.write(JSON.stringify({
  ok: allOk, mode, target: T, source: { name: "custodiet", version },
  preExisting: pre, changed, files, settings, gitignore, observe: observeFile, phrasebook, manifest, notInstalled,
}) + "\n");
process.exit(allOk ? 0 : 6);
