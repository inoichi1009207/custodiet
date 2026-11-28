#!/usr/bin/env node
// verify-laws.mjs —— 规矩文件装载完整性闸(改 AGENTS.md / docs/gate/AGENTS.md 必跑)
//
// 被索引的规矩文件 = `AGENTS.md`(HostApp 仓规矩)+ `docs/gate/AGENTS.md`(闸规矩,拆仓前的临时住处)。
// 2026-11-05 宪法大改后 `docs/laws/` 五部法典与两份寄存器头部章程退役进 `docs/archive/laws-2026-11/`,
// 本件随之由「宪法 + 法典」两层结构改成上面这两份文件。
//
// 干什么:① 两份规矩文件必须在场且非空;AGENTS.md 必须有指向 docs/gate/AGENTS.md 的指针;
//           两份规矩文件里反引号包着、以 docs/ scripts/ .claude/ 开头的路径(文件或目录)必须在场,
//           .md 文件还须非空(指针能解析);闸规矩明写尚未落地的 docs/error-list.md、docs/receipt.md 豁免;
//           闸的源头仓里(安装器脚本在场),仓规矩引用的五处安装方自备路径**不在场**时不报(SOURCE_REPO_MISSING_OK);
//           带锚的指针还核锚:`file:行(-行)` / `:L行` 不得越界(D196 ⑭ BP-13);`#节名` 只剥掉用于定位文件,不核标题。
//        ② 退役目录 docs/laws/ 下不得再出现 .md(没有任何规矩文件索引它 ⇒ 孤儿法)。
//        ④ 触发层对照:规矩文件里声明的「hook-stop-closure 的 X 项」必须在闸实现里有 `id: "X"`;
//           ④之二:声明的「verify-laws 第 N 项」必须是本件已实现的项。
// 退役不检(2026-11-05):③ 寄存器章程标记(章程已移入存档,寄存器只留清单表);
//        ⑤ 宪法形状(≤3 行 / 判据词带法典指针——判据源立法法第二节已退役,新宪法没有对应条款)。
//        项号不复用,免得存档里的旧声明被误对账。
// 为什么:规矩下沉/搬家制造「指针还在、保护已空」的静默失败(2026-08-17 codex 048-v2-audit-r1 Q3)。
//        fail-closed:任何一项取不到 ⇒ 非零退出,不得读作「大概没事」。
//
// 用法: node --no-warnings scripts/verify-laws.mjs [--root <仓根>] | --self-test
// 退出码: 0=全绿  2=有缺失/孤儿/断链  3=用法错
//
// CEILING: 本闸只证「文件在场、指针能解析、触发层项名存在」,不证规矩内容正确或彼此一致;
//   路径指针只认反引号里带 docs/ scripts/ .claude/ 前缀的写法(见 extractPathRefs 天花板);
//   docs/gate/AGENTS.md 明写尚未落地的 `docs/error-list.md`、`docs/receipt.md` 豁免(PATH_EXEMPT);
//   源头仓里仓规矩的五处安装方自备路径只豁免「缺失」(SOURCE_REPO_MISSING_OK;认源头仓靠安装器脚本在场,安装方的仓不豁免);
//   `#节名` 不核(批 292 两轮复核手写解析不收敛,停止;两份规矩文件当前零处节名锚)——只剥掉后缀定位文件,
//   不读目标文件,只拦「锚指进目录」(如 `docs/gate/#todo.md` 剥成目录);
//   `:行:列` 的列、通配路径上的锚都不核;
//   闸规则 `law:` 锚点的解析由 `hook-stop-closure.mjs --self-test` 负责,本件不重复实现。CALIBRATED=false。
//   可被 import(主模块判定,见 isMainModule):import 时只给导出,不跑主流程、不退出。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * 本工装**已实现**的检查项号——唯一真相源。新增一项检查必须同时加进这里,
 * 否则规矩文件里指向它的触发层声明会被判断链(见 ④之二)。③ ⑤ 已退役,不在清单里。
 */
const IMPLEMENTED_ITEMS = new Set(["①", "②", "④"]);

/** 被索引的规矩文件(相对仓根)。 */
export const RULE_FILES = ["AGENTS.md", "docs/gate/AGENTS.md"];

/**
 * 路径指针豁免(按规矩文件分)。只收规矩文件**自己明写尚未落地**的路径;
 * 新增豁免必须同时能在该文件正文里指到「尚未落地」的原句。
 */
const PATH_EXEMPT = {
  "docs/gate/AGENTS.md": new Set(["docs/error-list.md", "docs/receipt.md"]),
};

/**
 * 只在**闸的源头仓**里、且只对**缺失**生效的豁免(批 308 实撞)。
 * 随仓的示例仓规矩引用了五处要安装方自己提供的路径——决策记录目录与它的索引(「要你自己建」)、产品日记
 * (「这个文件要你自己建」)、闸用语手册(「安装器生成」)、欠账探针脚本(「是你自己的脚本」)。源头仓故意不带它们,
 * 原先本核对在源头仓恒 FAIL:凡是改过规矩文件的批,关账时写入层的 J 项留下一条清不掉的义务,`batch-goal --clear` 被拒。
 * 两条限定(第一版豁免写宽了,红队逐条复现后收窄):
 *   · 认源头仓的标志是安装器脚本在场——它是唯一不随包拷给安装方的闸脚本。安装方的仓里没有它 ⇒ 一条都不豁免:
 *     安装方把决策记录写成必经流程、文件却丢了,照报;
 *   · 只豁免「路径不在场」。文件在场就照常核近空与行号锚。
 */
const SOURCE_REPO_MARK = "scripts/custodiet-init.mjs";
const SOURCE_REPO_MISSING_OK = {
  "AGENTS.md": new Set(["docs/adr/", "docs/adr/README.md", "docs/product-diary.md", "docs/gate-phrasebook.md", "scripts/verify-prod.mjs"]),
};

/**
 * 提取反引号里以 docs/、scripts/、.claude/ 开头、内部无空白的路径(文件或目录都算)。
 * 带通配或占位(`*` `<` `{`)的,只查第一个通配段之前的目录前缀。
 * 天花板:反引号外的裸路径、带命令前缀的(如 `node scripts/x.mjs`)、相对简称(如 `gate-replay.mjs`)都不提取。
 */
export function extractPathRefs(text) {
  const out = new Map();
  for (const m of text.matchAll(/`((?:docs|scripts|\.claude)\/[^`\s]*)`/g)) {
    // 批 290 合并后误拦猎手 FB-18:`file#节名`、`file:行(:列)(-行)` 是指向在场文件的锚,豁免比对用剥掉后缀的路径;
    //   复核 FB-27/28:原样路径先 stat(文件名可以自带 `#`),不在才 stat 剥后缀的;`:行:列` 两段都剥。
    //   D196 ⑭ BP-13:剥下来的锚记进 anchor,由 checkAnchor 核(`:行号` 核不越界;`#节名` 不核标题,见头注 CEILING)。
    const raw = m[1];
    const hash = raw.indexOf("#");
    const noHash = hash < 0 ? raw : raw.slice(0, hash);
    const lm = noHash.match(/:L?(\d+)(?::\d+)?(?:-(\d+))?$/);
    const ref = (lm ? noHash.slice(0, lm.index) : noHash) || raw;
    let anchor = null;
    if (hash >= 0) anchor = { kind: "section", name: raw.slice(hash + 1) };
    else if (lm) anchor = { kind: "line", start: Number(lm[1]), end: lm[2] === undefined ? Number(lm[1]) : Number(lm[2]) };
    const g = ref.search(/[*<{]/);
    const probe = g < 0 ? ref : ref.slice(0, ref.lastIndexOf("/", g) + 1);
    out.set(raw, { ref, probe, raw, anchor });
  }
  return [...out.values()];
}

/**
 * 核锚点:返回失效原因,核到返回 null。
 * `#节名`:不核标题(批 292 两轮复核手写 Markdown 标题解析不收敛,停止),只拦「锚指进目录」;**不读文件**。
 * `:行(-行)` / `:L行`:核不越界(零字节文件算 0 行,末尾换行不多算一行);`:行:列` 只核行不核列。
 * 天花板:通配路径上的锚不核(调用方跳过)。
 */
export function checkAnchor(file, st, anchor, read = (p) => fs.readFileSync(p, "utf8")) {
  if (!st.isFile()) return "目标是目录,锚指不进去";
  if (anchor.kind === "section") return null;   // 读之前返回:读不到不得把 PASS 变 UNKNOWN(292-c-review-r1 ④)
  let text;
  try { text = read(file); } catch { return "目标读不到 —— UNKNOWN"; }
  const n = text === "" ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
  if (anchor.start < 1 || anchor.end < anchor.start || anchor.end > n) return `行号越界(文件共 ${n} 行)`;
  return null;
}

/** 批 301:问题的稳定键(写前层比「改后新增了哪些问题」用)——字节数、行数这类随正文变的数字抹掉,同一个问题不因字数变化算新增。 */
export const problemKey = (p) => String(p).replace(/\(\d+B\)/g, "(nB)").replace(/文件共 \d+ 行/g, "文件共 n 行");

/**
 * overrides(批 301,J 跑在结果文件上):{ "AGENTS.md" | "docs/gate/AGENTS.md" | "docs/laws/<x>.md": 正文 } —— 按给的正文当作盘上内容核
 * (写前钩子用来核「改完以后的整份文件」);不传时行为不变。
 */
export function checkLaws(root, overrides = {}) {
  const problems = [];
  const texts = {};
  const ov = overrides && typeof overrides === "object" ? overrides : {};
  for (const f of RULE_FILES) {
    if (typeof ov[f] === "string") { texts[f] = ov[f]; continue; }
    try { texts[f] = fs.readFileSync(path.join(root, f), "utf8"); }
    catch { problems.push(`${f} 读不到 —— UNKNOWN,阻断`); }
  }
  if (texts["AGENTS.md"] === undefined) return { ok: false, problems, triggerMap: [] };
  const text = texts["AGENTS.md"];

  // ① 在场且非空;宪法指向闸规矩;两份规矩文件里的 docs/ scripts/ .claude/ 路径指针能解析
  for (const f of RULE_FILES) {
    if (texts[f] !== undefined && Buffer.byteLength(texts[f]) < 200) {
      problems.push(`规矩文件近空(${Buffer.byteLength(texts[f])}B): ${f}`);
    }
  }
  if (!text.includes("docs/gate/AGENTS.md")) {
    problems.push("AGENTS.md 里未检出指向 docs/gate/AGENTS.md 的指针 —— 索引缺失或格式漂移,UNKNOWN 阻断");
  }
  let isSourceRepo = false;
  try { isSourceRepo = typeof ov[SOURCE_REPO_MARK] === "string" || fs.statSync(path.join(root, SOURCE_REPO_MARK)).isFile(); } catch { isSourceRepo = false; }
  for (const f of RULE_FILES) {
    if (texts[f] === undefined) continue;
    for (const { ref, probe, raw, anchor } of extractPathRefs(texts[f])) {
      if ((PATH_EXEMPT[f] || new Set()).has(ref)) continue;
      let st = null, used = null;
      // 批 301:被引用的路径若在 overrides 里(规矩文件互相引用、带行号锚),按覆盖正文取大小与行数
      const ovSt = (p) => (typeof ov[p] === "string" ? { isFile: () => true, size: Buffer.byteLength(ov[p]) } : null);
      if (raw !== ref) { st = ovSt(raw); if (st) used = raw; else { try { st = fs.statSync(path.join(root, raw)); used = raw; } catch { /* 再试剥后缀的 */ } } }
      if (!st) { st = ovSt(probe); if (st) used = probe; else { try { st = fs.statSync(path.join(root, probe)); used = probe; } catch { /* 缺失走下面统一报 */ } } }
      // D196 ⑮ BP-17:原样路径 stat 成功时它就是目标文件,近空判据按原样路径判(不再拿剥过的 probe 判 `.md` 结尾)
      if (!st) {
        // 源头仓、且确实不在场 ⇒ 不报(见头注)。批 309:通配 / 占位写法(`docs/adr/*.md`、`docs/adr/<编号>-<题>.md`)按本工具
        //   实际核的那个目录(剥掉通配段的 probe)查名单;具体文件名(probe === ref)照旧拿原写法比,不放宽
        if (isSourceRepo && (SOURCE_REPO_MISSING_OK[f] || new Set()).has(probe !== ref ? probe : ref)) continue;
        problems.push(`${f} 引用的路径缺失: ${ref}`);
      }
      else if (st.isFile() && used.endsWith(".md") && st.size < 200) problems.push(`${f} 引用的文件近空(${st.size}B): ${used}`);
      else if (anchor && used !== raw && probe === ref) {
        const why = checkAnchor(path.join(root, ref), st, anchor, typeof ov[ref] === "string" ? () => ov[ref] : undefined);
        if (why) problems.push(`${f} 锚点失效: ${raw}(${why})`);
      }
    }
  }

  // ② 退役目录不得复活:docs/laws/ 下有 .md ⇒ 孤儿法(没有任何规矩文件索引它)
  const lawsDir = path.join(root, "docs", "laws");
  const orphans = new Set(fs.existsSync(lawsDir) ? fs.readdirSync(lawsDir).filter((f) => f.endsWith(".md")) : []);
  for (const k of Object.keys(ov)) { const m = String(k).replace(/\\/g, "/").match(/^docs\/laws\/([^/]+\.md)$/i); if (m && typeof ov[k] === "string") orphans.add(m[1]); }
  for (const f of orphans) {
    problems.push(`孤儿法典(docs/laws/ 已于 2026-11-05 退役,未被任何规矩文件索引): docs/laws/${f}`);
  }

  // ④ 触发层对照:规矩文件里声明的触发层必须指向**真实存在的执行设备**。
  // 判据:形如「…hook-stop-closure 的 X 项」的声明,X 必须在 hook-stop-closure.mjs 或 gate-rules.mjs 里有 `id: "X"`。
  // 天花板:只证「这个项名存在」,不证它真的拦得住那条规矩。
  //   声明提取依赖自然语言写法(先框出含 hook-stop-closure 的空行段,再在段内收「X 项」),只能证「声明写过」。
  const implSrcs = ["scripts/hook-stop-closure.mjs", "scripts/lib/gate-rules.mjs"].map((p) => path.join(root, p));
  let implIds = null;
  try {
    let all = "";
    for (const p of implSrcs) all += fs.readFileSync(p, "utf8");
    // D196 ⑫ BP-9①:项名按完整 id 取(ND、K0、E2 …),id 清单直接从实现件的 `id: "X"` 取,不手抄
    implIds = new Set([...all.matchAll(/\bid:\s*"([A-Z][A-Z0-9]*)"/g)].map((m) => m[1]));
  } catch { /* 任一实现件不在场:下面按 UNKNOWN 处理 */ }

  const declared = new Map();   // 项名 -> 声明它的文件
  const ID_TOK = "(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?![a-z0-9_])";
  const DECL_RE = new RegExp(`((?:\\*{0,2}${ID_TOK}\\*{0,2}\\s*[\\/、·与]?\\s*)+)(?:[一二三四五六七八九十两]|\\d+)?\\s*项`, "g");
  for (const f of RULE_FILES) {
    const t = texts[f];
    if (t === undefined) continue;
    for (const seg of t.split(/\n\s*\n/)) {
      if (!seg.includes("hook-stop-closure")) continue;
      // 两字母项号是一个 id(「ND 项」核 ND,不拆成 N 与 D;「PQ 项」核 PQ)
      for (const m of seg.matchAll(DECL_RE)) {
        for (const id of m[1].matchAll(new RegExp(ID_TOK, "g"))) declared.set(id[0], f);
      }
    }
  }
  if (implIds === null) {
    if (declared.size) problems.push("规矩文件声明了 hook 触发层,但 scripts/hook-stop-closure.mjs 或 gate-rules.mjs 读不到 —— UNKNOWN,阻断");
  } else {
    for (const [id, where] of declared) {
      if (!implIds.has(id)) problems.push(`触发层断链: ${where} 声明「${id} 项」,但 hook 实现里没有该项`);
    }
  }

  // ④之二:指向本工装自己项号的触发层声明,同样要对账(显式清单判,不扫注释——扫注释两版都自指失败过)。
  for (const f of RULE_FILES) {
    const t = texts[f];
    if (t === undefined) continue;
    for (const seg of t.split(/\n\s*\n/)) {
      if (!/verify-laws/.test(seg)) continue;
      for (const m of seg.matchAll(/第?\s*([①②③④⑤⑥⑦⑧⑨]|\d+)\s*项/g)) {
        if (!IMPLEMENTED_ITEMS.has(m[1])) {
          problems.push(`触发层断链: ${f} 声明「verify-laws 第 ${m[1]} 项」,但本工装里没有该项`);
        }
      }
    }
  }

  return { ok: problems.length === 0, problems, triggerMap: [...declared].map(([id, w]) => `${id}←${w}`) };
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-"));
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), c); };
  const BODY = "条文。".repeat(80);
  const K = "# Project Instructions\n闸规矩:`docs/gate/AGENTS.md`;生产事实:`docs/prod-facts.md`。\n" + BODY;
  const G = "# 闸仓规矩\n出错清单住 `docs/error-list.md`(尚未落地,不查)。\n" + BODY;
  // DOC 共 21 行:290 FB-18/28 的 `:12-14`、`:12:5`、`:L12` 锚在 BP-13 行号越界核下要真能核到(`#一节` 不核标题,DOC 里刻意没有这个标题)。
  const DOC = "# 事实\n" + ("条文。".repeat(8) + "\n").repeat(20);
  let pass = 0, fail = 0;
  const t = (name, want) => {
    const got = checkLaws(tmp).ok;
    if (got === want) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name} 期望 ok=${want} 实得 ${got}:`, checkLaws(tmp).problems.join(" | ")); }
  };
  const tm = (name, okay, detail) => { if (okay) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}:`, detail); } };
  const fresh = () => { w("AGENTS.md", K); w("docs/gate/AGENTS.md", G); w("docs/prod-facts.md", DOC); };
  fresh(); t("全在场 ⇒ 过(闸规矩明写未落地的 docs/error-list.md 豁免)", true);
  fs.rmSync(path.join(tmp, "docs/gate/AGENTS.md")); t("闸规矩读不到 ⇒ 拒(UNKNOWN)", false); fresh();
  w("docs/gate/AGENTS.md", "太短"); t("闸规矩近空 ⇒ 拒", false); fresh();
  w("AGENTS.md", K.replace("`docs/gate/AGENTS.md`", "闸仓")); t("宪法丢了闸规矩指针 ⇒ 拒", false); fresh();
  fs.rmSync(path.join(tmp, "docs/prod-facts.md")); t("宪法引用的文件缺失 ⇒ 拒", false); fresh();
  w("docs/prod-facts.md", "短"); t("宪法引用的文件近空 ⇒ 拒", false); fresh();
  w("AGENTS.md", K + "\n工装:`scripts/no-such-tool.mjs`。\n"); t("宪法里写一个不存在的反引号脚本路径 ⇒ 拒", false); fresh();
  w("AGENTS.md", K + "\n设置:`.claude/no-such.json`。\n"); t("宪法里写一个不存在的 .claude/ 路径 ⇒ 拒", false); fresh();
  w("AGENTS.md", K + "\n工装:`scripts/prod-lib.mjs`;skill:`.claude/skills/x/`;命令面 `.claude/commands/**`。\n");
  w("scripts/prod-lib.mjs", "export {};"); w(".claude/skills/x/SKILL.md", DOC); w(".claude/commands/a.md", DOC);
  t("宪法里的脚本(小文件不查大小)、目录、通配前缀都在场 ⇒ 过", true);
  fs.rmSync(path.join(tmp, ".claude/commands"), { recursive: true }); t("通配前缀目录缺失 ⇒ 拒", false);
  fs.rmSync(path.join(tmp, ".claude/skills"), { recursive: true }); fs.rmSync(path.join(tmp, "scripts"), { recursive: true }); fresh();
  w("docs/gate/AGENTS.md", G + "\n判据工装:`scripts/no-such-gate.mjs`。\n"); t("闸规矩里不在豁免表的缺失路径 ⇒ 拒", false); fresh();
  w("AGENTS.md", K + "\n出错清单:`docs/error-list.md`。\n"); t("豁免只对闸规矩生效,宪法引未落地的 docs/error-list.md ⇒ 拒", false); fresh();
  // 批 308:源头仓(安装器脚本在场)里,仓规矩引用的五处安装方自备路径不在场 ⇒ 过;只豁免缺失、只在源头仓、只对仓规矩
  { const FIVE = K + "\n决策记录:`docs/adr/`,先翻 `docs/adr/README.md`;产品日记:`docs/product-diary.md`;闸认的说法:`docs/gate-phrasebook.md`;欠账探针:`scripts/verify-prod.mjs`。\n";
    const mark = () => w("scripts/custodiet-init.mjs", "// 安装器(源头仓才有)\n");
    const unmark = () => fs.rmSync(path.join(tmp, "scripts"), { recursive: true, force: true });
    w("AGENTS.md", FIVE); t("308:安装方的仓(没有安装器脚本)里这五处缺失 ⇒ 照拒(不豁免)", false);
    mark(); t("308:源头仓里这五处都不在场 ⇒ 过", true);
    w("docs/adr/README.md", "#\n"); t("308:源头仓里被豁免的文件在场但近空 ⇒ 照拒(只豁免缺失)", false); fs.rmSync(path.join(tmp, "docs/adr"), { recursive: true, force: true });
    w("docs/adr/README.md", "# 决策记录\n" + "一页记一个决定。".repeat(40) + "\n"); w("AGENTS.md", FIVE + "见 `docs/adr/README.md:90-95`。\n"); t("308:源头仓里被豁免的文件在场、行号锚越界 ⇒ 照拒", false); fs.rmSync(path.join(tmp, "docs/adr"), { recursive: true, force: true });
    w("AGENTS.md", K + "\n决策记录:`docs/adr/`;另见 `docs/no-such-file.md`。\n"); t("308:源头仓里不在名单上的缺失路径 ⇒ 照拒", false);
    w("AGENTS.md", K + "\n决策记录住 `docs/adr`,必须在场。\n"); t("308:不带斜杠的写法不在名单上 ⇒ 照拒", false);
    w("AGENTS.md", K); w("docs/gate/AGENTS.md", G + "\n欠账探针:`scripts/verify-prod.mjs`。\n"); t("308:这张名单不对闸规矩生效 ⇒ 拒", false);
    // 批 309:通配 / 占位写法按剥过通配段的目录查名单(本工具核的本就是那个目录);具体文件名不放宽
    fresh(); const WILD = K + "\n决策记录一页一个:`docs/adr/<编号>-<题>.md`、`docs/adr/*.md`。\n";
    w("AGENTS.md", WILD); t("309:源头仓里 docs/adr/ 下的通配 / 占位写法、目录不在场 ⇒ 过", true);
    w("AGENTS.md", K + "\n例子:`docs/adr/0001-例子.md`。\n"); t("309:源头仓里 docs/adr/ 下的具体文件名不在场 ⇒ 照拒(不放宽)", false);
    w("AGENTS.md", K + "\n别处:`docs/other/*.md`。\n"); t("309:源头仓里不在名单上的目录的通配写法 ⇒ 照拒", false);
    unmark(); w("AGENTS.md", WILD); t("309:同一通配写法在安装方的仓(没有安装器脚本)⇒ 照拒", false);
    unmark(); fresh(); }
  // 批 290 合并后误拦猎手 FB-18
  w("docs/gate/AGENTS.md", G + "\n锚点:`docs/prod-facts.md#一节`、`docs/prod-facts.md:12-14`。\n"); t("290 FB-18:在场文件带 #节名 / :行号 ⇒ 过", true); fresh();
  w("docs/gate/AGENTS.md", G + "\n锚点:`docs/no-such.md#一节`。\n"); t("290 FB-18 对照:缺失文件带 #节名 照样拒", false); fresh();
  w("docs/gate/AGENTS.md", G + "\n见 `docs/error-list.md#字段`。\n"); t("290 FB-18:豁免件带锚仍豁免", true); fresh();
  w("docs/c#-notes.md", DOC); w("docs/gate/AGENTS.md", G + "\n见 `docs/c#-notes.md`。\n"); t("290 FB-27:文件名自带 # 的在场文件 ⇒ 过", true); fresh();
  w("docs/gate/AGENTS.md", G + "\n见 `docs/prod-facts.md:12:5`、`docs/prod-facts.md:L12`。\n"); t("290 FB-28:行:列 与 :L行 锚 ⇒ 过", true); fresh();
  // D196 ⑭ BP-13:`:行号` 核不越界;`#节名` 不核标题(批 292 两轮复核后停止,见头注 CEILING)
  const GA = (s) => { w("docs/gate/AGENTS.md", G + `\n锚点:${s}。\n`); };
  GA("`docs/prod-facts.md#没有这节`"); t("292 停止规则:`#节名` 不核标题,在场 .md 带任意节名 ⇒ 过(CEILING 钉住)", true); fresh();
  // 292-c-review-r1 ④:`#` 后缀一律读文件之前返回(读不到也不 UNKNOWN),.md 与非 .md 同
  { const fileSt = { isFile: () => true }, boom = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    tm("r1④:#节名 不读文件(.md 与非 .md,读会 EACCES 也不 UNKNOWN)",
      checkAnchor("scripts/opaque.mjs", fileSt, { kind: "section", name: "x" }, boom) === null
      && checkAnchor("docs/opaque.md", fileSt, { kind: "section", name: "x" }, boom) === null, "返回了失效原因"); }
  // 292-c-review-r1 ⑤:零字节文件行数按 0 算
  w("scripts/empty.mjs", ""); GA("`scripts/empty.mjs:1`"); t("r1⑤:零字节文件的 :1 ⇒ 拒(越界)", false);
  fs.rmSync(path.join(tmp, "scripts"), { recursive: true }); fresh();
  GA("`docs/prod-facts.md:99`"); t("BP-13::行号 越界 ⇒ 拒(锚点失效)", false); fresh();
  GA("`docs/prod-facts.md:12-99`"); t("BP-13::行-行 尾越界 ⇒ 拒", false); fresh();
  GA("`docs/prod-facts.md:L0`"); t("BP-13::L0 不是合法行号 ⇒ 拒", false); fresh();
  GA("`docs/gate/#todo.md`"); t("D196 ⑮附带:`docs/gate/#todo.md` 剥成目录 ⇒ 拒(锚不能指进目录)", false); fresh();
  // D196 ⑮ BP-17:文件名自带 # 的空文件,近空判据用原样路径判
  w("docs/c#-empty.md", ""); GA("`docs/c#-empty.md`"); t("BP-17:文件名自带 # 的空 .md ⇒ 拒(近空)", false);
  fs.rmSync(path.join(tmp, "docs/c#-empty.md")); fresh();
  w("docs/laws/orphan.md", DOC); t("退役目录复活出 .md ⇒ 拒", false);
  fs.rmSync(path.join(tmp, "docs/laws"), { recursive: true }); fresh();
  fs.mkdirSync(path.join(tmp, "docs/laws"), { recursive: true }); t("退役目录空着在场 ⇒ 过", true);
  fs.rmSync(path.join(tmp, "docs/laws"), { recursive: true });
  w("scripts/hook-stop-closure.mjs", 'const R = { id: "Q" };'); w("scripts/lib/gate-rules.mjs", 'const S = { id: "P" };');
  w("docs/gate/AGENTS.md", G + "\n\n触发层:hook-stop-closure 的 P 项。\n"); t("触发层声明的项存在 ⇒ 过", true);
  w("docs/gate/AGENTS.md", G + "\n\n触发层:hook-stop-closure 的 Z 项。\n"); t("触发层声明的项不存在 ⇒ 拒", false); fresh();
  // D196 ⑫ BP-9①:两字母项号按完整 id 核,不拆成单字母
  w("docs/gate/AGENTS.md", G + "\n\n触发层:hook-stop-closure 的 PQ 项。\n"); t("BP-9①:PQ 不存在(P、Q 各自存在)⇒ 拒", false);
  w("scripts/lib/gate-rules.mjs", 'const S = { id: "P" }; const N = { id: "N" }; const D = { id: "D" };');
  w("docs/gate/AGENTS.md", G + "\n\n触发层:hook-stop-closure 的 ND 项。\n"); t("BP-9①:ND 不存在(N、D 各自存在)⇒ 拒", false);
  w("scripts/lib/gate-rules.mjs", 'const S = { id: "P" };\nexport const RULE_ND = {\n  id: "ND",\n};\nconst K = { id: "K0" };');
  t("BP-9①:ND 在实现件里 ⇒ 过", true);
  w("docs/gate/AGENTS.md", G + "\n\n触发层:hook-stop-closure 的 **K0 项**、P/Q 两项。\n"); t("BP-9①:K0 与 P/Q 分隔写法 ⇒ 过", true);
  w("docs/gate/AGENTS.md", G + "\n\n触发层:hook-stop-closure 的 **K1 项**。\n"); t("BP-9①:K1 不存在(K0 存在)⇒ 拒", false);
  w("scripts/lib/gate-rules.mjs", 'const S = { id: "P" };'); fresh();
  fs.rmSync(path.join(tmp, "scripts"), { recursive: true });
  w("AGENTS.md", K + "\n\n触发层:hook-stop-closure 的 P 项。\n"); t("声明了 hook 项而实现件读不到 ⇒ 拒(UNKNOWN)", false); fresh();
  w("AGENTS.md", K + "\n\n触发层=`verify-laws` 第⑤项。\n"); t("声明已退役的 verify-laws 第⑤项 ⇒ 拒", false); fresh();
  w("AGENTS.md", K + "\n\n触发层=`verify-laws` 第②项。\n"); t("声明已实现的 verify-laws 第②项 ⇒ 过", true); fresh();
  // D196 ⑬附带:主模块判定——被 import 不得执行主流程并 process.exit;直接跑(含 Windows 盘符小写 / 相对路径)照常出判词
  const self = fileURLToPath(import.meta.url);
  const run = (args, cwd) => spawnSync(process.execPath, ["--no-warnings", ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vl-imp-"));
  const imp = run(["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(self).href)}); console.log("IMPORTED", typeof m.checkLaws, typeof m.extractPathRefs);`], emptyDir);
  tm("主模块判定:被 import ⇒ 不跑主流程、不退出,导出可用",
    imp.status === 0 && /IMPORTED function function/.test(imp.stdout) && !/verify-laws:/.test(imp.stdout), JSON.stringify({ status: imp.status, out: imp.stdout, err: imp.stderr }));
  const forms = [path.relative(path.dirname(path.dirname(self)), self)];
  if (process.platform === "win32" && /^[A-Z]:/.test(self)) forms.push(self[0].toLowerCase() + self.slice(1));
  for (const form of forms) {
    const r = run([form, "--root", tmp], path.dirname(path.dirname(self)));
    tm(`主模块判定:直接跑(${form === forms[0] ? "相对路径" : "盘符小写"})⇒ 照常出判词`, /verify-laws: (PASS|FAIL)/.test(r.stdout), JSON.stringify({ status: r.status, out: r.stdout, err: r.stderr }));
  }
  fs.rmSync(emptyDir, { recursive: true, force: true });
  // 批 301:overrides 按给的正文核(J 写前层核改后全文),盘上文件不动
  fresh();
  tm("301 overrides:改后宪法丢了闸规矩指针 ⇒ 拒(盘上原文仍过)", !checkLaws(tmp, { "AGENTS.md": K.replace("`docs/gate/AGENTS.md`", "闸仓") }).ok && checkLaws(tmp).ok, "判反了");
  tm("301 overrides:改后宪法引了不存在的路径 ⇒ 拒", checkLaws(tmp, { "AGENTS.md": K + "\n工装:`scripts/no-such.mjs`。\n" }).problems.some((p) => /no-such/.test(p)), "没报");
  tm("301 overrides:写 docs/laws/x.md(盘上没有)⇒ 孤儿", checkLaws(tmp, { "docs/laws/x.md": DOC }).problems.some((p) => /孤儿法典.*docs\/laws\/x\.md/.test(p)), "没报");
  tm("301 overrides:合法改动 ⇒ 过", checkLaws(tmp, { "docs/gate/AGENTS.md": G + "\n补一句。\n" }).ok, "误拒");
  fs.rmSync(path.join(tmp, "AGENTS.md")); t("宪法读不到 ⇒ 拒(UNKNOWN)", false);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

/**
 * 主模块判定(D196 ⑬附带):被别的脚本 import 时不跑主流程、不 process.exit。
 * 比的是 import.meta.url 解出的本机路径与 process.argv[1]:两边都 realpath(符号链接 / 8.3 短名),
 * Windows 上不分大小写(盘符大小写、`file:///E:/…` 与 `E:\…` 两种形)。
 */
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  const canon = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* 解不了就用 resolve 结果 */ }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  let self;
  try { self = fileURLToPath(metaUrl); } catch { return false; }
  return canon(self) === canon(argv1);
}

const argv = process.argv.slice(2);
if (!isMainModule(import.meta.url, process.argv[1])) {
  // 被 import:只提供导出
} else if (argv.includes("--self-test")) {
  selfTest();
} else {
  const i = argv.indexOf("--root");
  if (i >= 0 && !argv[i + 1]) { console.log("用法: node --no-warnings scripts/verify-laws.mjs [--root <仓根>] | --self-test"); process.exit(3); }
  const root = i >= 0 ? argv[i + 1] : process.cwd();
  const res = checkLaws(root);
  console.log("CEILING: 本闸只证规矩文件在场/指针能解析/触发层项名存在,不证内容正确;CALIBRATED=false。");
  if (res.ok) { console.log(`verify-laws: PASS(${RULE_FILES.join(" + ")})`); process.exit(0); }
  console.log("verify-laws: FAIL");
  for (const p of res.problems) console.log(`  - ${p}`);
  process.exit(2);
}
