#!/usr/bin/env node
// hook-precommit-gate.mjs —— 提交前闸(`PreToolUse`,matcher `Bash|PowerShell`)
//
// 立此文件的理由(2026-08-20,codex 裁决 + 用户「codex 裁了的就按 codex 来」):
//
// tdd-guardian 插件的 `pretool_guard.js` 第 80 行是:
//     if (payload.tool_name !== "Bash") return;
// 而本机 primary shell 是 **PowerShell**(系统提示明写),本项目自己的 hook matcher
// 早就写成 `"Bash|PowerShell"` —— **插件不知道**。
// ⇒ 用 PowerShell 工具跑 `git commit`,那道 lane 新鲜度闸从头到尾不被唤醒。
// 已核实:`git ls-files` 无法证伪这一点,但插件源码那一行是直接读到的;
// 且 proj-c 侧同样有这个洞,只是它的 commit 闸本来就关着(config 里 false),撞不上。
//
// codex 裁「**自己补一道**」而不是打插件补丁,理由:
//   「补丁插件缓存会被升级覆盖;项目 hook 已证明支持 PowerShell matcher,
//     本地补闸的控制权和可持续性更高。」
// 失效条件(codex 给的):**上游版本实测已原生拦截 PowerShell 且判定与本闸一致时,
//   删除本闸**,避免双重执行。
//
// D58 免锚理由(2026-08-26 批 109 逐 hook 审,机器复核:全文件零路径字面量):
//   本件不按 cwd 相对寻址任何东西——输入只有 stdin,下游插件路径由 require 解析,
//   故 hook 进程继承 shell cwd 这件事对它无副作用,无需 import.meta.url 锚。
//   失效条件:本文件一旦出现相对路径的 read/write/exists,此豁免立即作废,按同款补锚。
//
// ⚠️ 形态是**薄适配器**,不是重写:
//   它不复制插件的任何判断逻辑,只把 payload 的 `tool_name` 归一成 `Bash`,
//   再把整包转交给插件**自己的** `pretool_guard.js`,原样透传它的裁决。
//   理由就是今天反复吃亏的那条:手搓一个已有实现,只会得到一个更差的版本
//   (ReDoS 守卫那次:我造了个动态计时,而业界有静态检查器)。
//
// CEILING: 它只补「工具名」这一个洞。插件本身的其余局限(例如 `blockCommitWithoutFreshGate`
//   为 false 时它整个不响)照旧适用——本闸不替它做决定,只保证它**被叫到**。
// CALIBRATED=false。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 找到插件自己的判断器。**不写死版本号**:cache 目录带版本,升级后路径会变。 */
function findPluginGuard() {
  const base = path.join(process.env.USERPROFILE || process.env.HOME || "",
    ".claude", "plugins", "cache", "xiaolai", "tdd-guardian");
  let versions;
  try { versions = fs.readdirSync(base).sort(); } catch { return null; }
  // 取字典序最大的版本目录(cache 里通常只有一个)
  for (const v of versions.reverse()) {
    const p = path.join(base, v, "scripts", "tdd-guardian", "pretool_guard.js");
    try { fs.accessSync(p); return p; } catch { /* 试下一个 */ }
  }
  return null;
}

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }   // 读不到 stdin ⇒ 放行
let payload;
try { payload = JSON.parse(raw || "{}"); } catch { process.exit(0); }

// 只管 PowerShell —— Bash 那条路插件自己已经挂着了,重复调用会产生两条 deny
if (payload.tool_name !== "PowerShell") process.exit(0);

const guard = findPluginGuard();
if (!guard) process.exit(0);        // 插件不在场 ⇒ 无事可做(不是本闸的职责)

// 归一成插件认得的形状,原样转交
const adapted = JSON.stringify({ ...payload, tool_name: "Bash" });
const r = spawnSync(process.execPath, [guard], { windowsHide: true, input: adapted, encoding: "utf8" });

// 透传它的裁决。它没话说 ⇒ 本闸也没话说。
const out = String(r.stdout || "").trim();
if (out) process.stdout.write(out);
