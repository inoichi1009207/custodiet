#!/usr/bin/env node
// codex-entry-sync.mjs — /codex 入口的双源漂移闸(038 批,2026-08-09)。
//
// 归属已由用户裁定:**user 级(~/.claude/scripts/)为运行权威**,仓内 scripts/ 为版本化副本。
// 双源必然漂移,故这里补的是**可检测性**,不改归属:
//   --check   只读比对两侧 sha256;不一致即非零退出并打印两边哈希(不改任何文件)
//   --install 单向推送 仓内 → user 级(**只此一个方向**,永不反向回吸)
//
// 命令文件 ~/.claude/commands/codex.md 只有 user 级一份、不入仓(用户只签了「脚本副本入库」),
// 故不在本闸的比对面内;它的存在靠 docs/prod-facts.md 的登记让未来会话可发现。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const USER_SCRIPTS = path.join(os.homedir(), ".claude", "scripts");

/** 受管文件集:运行权威侧必须与仓内逐字节一致的那几支。 */
const MANAGED = ["codex-run.mjs", "codex-run.selftest.mjs"];

const sha = (p) =>
  fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null;

function check() {
  let drift = 0;
  for (const name of MANAGED) {
    const a = sha(path.join(REPO_SCRIPTS, name));
    const b = sha(path.join(USER_SCRIPTS, name));
    if (a === null) {
      process.stdout.write(`MISSING repo   ${name}\n`);
      drift++;
    } else if (b === null) {
      process.stdout.write(`MISSING user   ${name}(跑 --install 安装)\n`);
      drift++;
    } else if (a !== b) {
      process.stdout.write(`DRIFT   ${name}\n  repo=${a.slice(0, 12)}\n  user=${b.slice(0, 12)}\n`);
      drift++;
    } else {
      process.stdout.write(`OK      ${name}  ${a.slice(0, 12)}\n`);
    }
  }
  process.stdout.write(drift === 0 ? "SYNC=OK\n" : `SYNC=DRIFT(${drift} 项)\n`);
  return drift === 0 ? 0 : 1;
}

function install() {
  fs.mkdirSync(USER_SCRIPTS, { recursive: true });
  for (const name of MANAGED) {
    const src = path.join(REPO_SCRIPTS, name);
    if (!fs.existsSync(src)) {
      process.stderr.write(`仓内副本缺失,拒绝安装:${name}\n`);
      return 2;
    }
    fs.copyFileSync(src, path.join(USER_SCRIPTS, name));
    process.stdout.write(`INSTALLED ${name} -> ~/.claude/scripts/\n`);
  }
  return check();
}

const arg = process.argv[2];
if (arg === "--check") process.exit(check());
else if (arg === "--install") process.exit(install());
else {
  process.stdout.write(
    "用法: node scripts/codex-entry-sync.mjs --check | --install\n" +
      "  --check   只读比对 仓内 vs ~/.claude/scripts/,漂移即非零退出\n" +
      "  --install 单向推送 仓内 → user 级(运行权威)\n",
  );
  process.exit(1);
}
