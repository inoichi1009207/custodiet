#!/usr/bin/env node
// 无头执行日志的「权限拒绝」提取器(019 无人值守权限停摆修复批,阶段 A1)。
//
// 存在理由:`clipboard/prompts/NNN-exec.log` 是 stream-json 逐条落盘的无头会话心跳日志。
// 每份日志末尾的 `type=result` 记录带一个 **结构化** 的 `permission_denials` 数组,
// 逐条含 `tool_name` + `tool_use_id` + `tool_input`。这是判断「无头批被什么形态卡住」的
// **唯一权威源**(019 决策单 S5/T-b):
//   规划期实测——按关键词扫正文在 007 日志上命中 19 条噪声(多为 `permissionPolicies`
//   之类的无关词),而本字段精确给出 5 条真拒绝。**不得**回退到关键词猜测。
//
// 本工装 **纯只读**:只读 clipboard/prompts/*-exec.log,不写任何仓库文件(结果走 stdout)。
//
// 用法:
//   node --no-warnings scripts/scan-permission-denials.mjs            # 表格(默认)
//   node --no-warnings scripts/scan-permission-denials.mjs --json     # 机器可读
//   node --no-warnings scripts/scan-permission-denials.mjs --files 007,010,011,014,015
//
// 输出四列(019 A1 规定):日志文件 / 序号 / tool_name / 命令原文。
// 「命令原文」的取法按工具分:Bash→`command`;PowerShell→`command`;其余工具→
// 整个 `tool_input` 的紧凑 JSON(保证不丢信息,便于人工归因)。
//
// 退出码:0=正常(含零命中);2=工具自身错(目录不可读等,fail-closed)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(repoRoot, "clipboard", "prompts");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const filesArg = (() => {
  const i = argv.indexOf("--files");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
})();

/** 从一条 tool_input 里取「命令原文」。取不到就整条 JSON 化——宁可啰嗦也不丢证据。 */
function commandText(toolName, input) {
  if (input && typeof input === "object") {
    if (typeof input.command === "string") return input.command;
    if (typeof input.file_path === "string" && Object.keys(input).length <= 3) {
      return `${toolName}(${input.file_path})`;
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function scanFile(fullPath) {
  const rows = [];
  const raw = fs.readFileSync(fullPath, "utf8");
  let resultRecords = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行(极少数截断尾行)直接跳过,不当错误
    }
    if (obj?.type !== "result") continue;
    resultRecords += 1;
    const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials : [];
    for (const d of denials) {
      rows.push({
        tool_name: d?.tool_name ?? "(missing)",
        tool_use_id: d?.tool_use_id ?? "",
        command: commandText(d?.tool_name, d?.tool_input),
      });
    }
  }
  return { rows, resultRecords };
}

function main() {
  let entries;
  try {
    entries = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /-exec\.log$/.test(f))
      .sort();
  } catch (e) {
    console.error(`TOOLERR 读取日志目录失败:${LOG_DIR} — ${e.message}`);
    process.exit(2);
  }
  if (filesArg) {
    entries = entries.filter((f) => filesArg.some((p) => f.startsWith(p)));
  }

  const out = [];
  const perFile = [];
  for (const f of entries) {
    const { rows, resultRecords } = scanFile(path.join(LOG_DIR, f));
    perFile.push({ file: f, count: rows.length, resultRecords });
    rows.forEach((r, i) => out.push({ file: f, seq: i + 1, ...r }));
  }

  if (asJson) {
    console.log(JSON.stringify({ perFile, total: out.length, rows: out }, null, 2));
    return;
  }

  console.log("=== 逐份计数 ===");
  for (const p of perFile) {
    console.log(`${p.file}\tdenials=${p.count}\tresult记录=${p.resultRecords}`);
  }
  console.log(`合计 = ${out.length} 条(覆盖 ${perFile.length} 份日志)`);
  console.log("");
  console.log("=== 四列明细(日志文件 / 序号 / tool_name / 命令原文)===");
  for (const r of out) {
    console.log(`--- ${r.file} #${r.seq} [${r.tool_name}] ${r.tool_use_id}`);
    console.log(r.command);
  }
}

main();
