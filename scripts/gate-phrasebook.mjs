#!/usr/bin/env node
// gate-phrasebook.mjs — 从规则代码生成《闸用语》手册(批 265;方案见批 256 开工单第八节,用户 10-19:「可以让模型学会闸的语言风格」)。
//
// 为什么从代码生成:每条规则的 `escapes` 字段写着「怎么说 / 怎么做」与样例,`gate:accept` 的「出路自证」真跑过样例、证明能过闸。
//   手写手册会出现「手册写了、闸不认」;生成的手册改了规则重跑即同步。没有出路字段的规则单列,当欠账。
// 判的是动作还是说法:手册每条标出——能靠动作过的(回读、跑探针)优先写动作;只能靠说法过的,写原样可用的句式。
// 用法:node --no-warnings scripts/gate-phrasebook.mjs [--out docs/gate-phrasebook.md] [--check]
//   --check:与盘上已有手册比对,不一致退出 1(规则改了、手册没重生成)。
// 失效条件:规则改为全部按动作判、不再看措辞 ⇒ 本手册只剩动作清单,复议是否并入 README。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outRel = args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/gate-phrasebook.md";
const check = args.includes("--check");
const { RULES } = await import(pathToFileURL(path.join(HERE, "lib", "gate-rules.mjs")).href);

const firstLine = (r) => {
  try { return String(r.message(["…"]) || "").split("\n")[0].replace(/\*\*/g, "").replace(/\s+$/, ""); } catch { return ""; }
};
const kind = (s) => (/node |git |Read|Grep|回读|跑|起 `|取页|WebFetch|WebSearch|codex|--clear|--arm/.test(s) ? "动作" : "说法");
const lines = [];
lines.push("# 闸用语(生成件,勿手改)", "");
lines.push("> 由 `scripts/gate-phrasebook.mjs` 从 `scripts/lib/gate-rules.mjs` 的 `escapes` 字段生成;每条出路的样例都在 `gate:accept` 里真跑过、能过闸。",
  "> 收尾时被闸拦下,先看这里对应规则的出路;**能做动作就做动作**(回读、跑探针、真取页),动作比说法可靠。", "");
lines.push("## 收尾时的几句标准说法", "",
  "- 推断没核过:就地写「这是推断」或「未核实」;核过的写「⟪机械判据⟫:已跑 <命令>」。",
  "- 要停下等用户:写「⏸ 需要你确认」,并写清属哪一类:不可逆 / 需你亲签 / 实打实阻断(缺凭据、站点不可达、只有用户能触发)。",
  "- 没停、还要接着做:说出下一步具体做什么(「接下来把剩下四条迁完」)。",
  "- 后台任务没回:只说「本轮尚未读到 X 的结果」,不对它的内容或成败下结论。",
  "- 用 Bash / 脚本改了文件:改完用 Read / grep / cat / git diff 回读同一路径。", "");
lines.push("## 逐条出路", "");
const noEsc = [];
for (const r of RULES) {
  const es = r.escapes || [];
  if (!es.length) { noEsc.push(r); continue; }
  lines.push(`### ${r.id} ${r.blocking ? "(阻断)" : "(提示)"}`, "");
  const fl = firstLine(r);
  if (fl) lines.push(`拦什么:${fl}`, "");
  for (const e of es) lines.push(`- 〔${kind(e.say)}〕${e.say}`);
  if (r.law) lines.push("", `法条:\`${r.law}\``);
  lines.push("");
}
lines.push("## 没有写出路字段的规则(欠账:被拦时按拦截文本里的说明办)", "");
for (const r of noEsc) lines.push(`- **${r.id}** ${r.blocking ? "(阻断)" : "(提示)"}:${firstLine(r) || "(拦截文本需具体命中才生成)"}`);
lines.push("");
const body = lines.join("\n");

const out = path.resolve(HERE, "..", outRel);
if (check) {
  let cur = null; try { cur = fs.readFileSync(out, "utf8"); } catch { /* 没有 */ }
  if (cur !== body) { console.log(`闸用语手册与规则不同步:${outRel}(重跑 node --no-warnings scripts/gate-phrasebook.mjs)`); process.exit(1); }
  console.log(`闸用语手册同步:${outRel}`); process.exit(0);
}
// 盘上已有同名文件但不是本生成器写的 ⇒ 不覆盖(codex 265-r1 附 5:原先直接覆盖用户自己的文件)
try {
  const cur = fs.readFileSync(out, "utf8");
  if (!cur.startsWith("# 闸用语(生成件,勿手改)")) { console.log(`${outRel} 已存在且不是生成件,未覆盖`); process.exit(3); }
} catch { /* 不存在 ⇒ 照写 */ }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body);
console.log(`写出 ${outRel}:${RULES.length - noEsc.length} 条规则有出路,${noEsc.length} 条无出路字段`);
