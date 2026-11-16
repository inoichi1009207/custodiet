// install-config.mjs —— 安装方配置接缝(批 298,287 设计 P0 第一批;闸规矩 docs/gate/AGENTS.md 第五节末条)
//
// 干什么:闸代码里凡是**某一个安装方才有**的路径(产品日记、ADR 目录、安装方自己的承重文件),
//   一律从仓根的一份配置文件读,不写死在闸代码里。拆仓以后闸仓不带这份文件 ⇒ 这些核对在闸仓里不启用;
//   HostApp 带一份照现值写的 ⇒ 行为零变化(batch-goal 自测钉住:新旧承重面判法在同一组路径上逐条相等)。
//
// ── 文件 ────────────────────────────────────────────────────────────────────────
//   位置:仓根 `gate-install.json`(相对**当前工作目录**取,与 batch-goal 其余路径同一假设:在仓根跑)。
//   入仓:是(它决定闸在本仓启用哪些核对,本身算承重面,改它会触发「承重面零决定」核对)。
//   格式(JSON,不许注释;未知键 ⇒ 整份判坏,防拼错键名静默关掉一道核对):
//     {
//       "format": "gate-install/v1",            // 必填,固定值
//       "diary": "docs/product-diary.md",       // 产品日记;null 或缺省 ⇒ 不做「登记了成果须有日记行」核对
//       "adrDir": "docs/adr",                   // ADR 目录;null 或缺省 ⇒ 不做 ADR 覆盖与「承重面零决定」核对
//       "debtTable": "docs/gate-debts.md",      // 欠账表;缺省 ⇒ docs/gate-debts.md(欠账表是闸自己的概念,不随安装方关掉)
//       "loadBearingExtra": ["^docs/laws/"],    // 安装方专属承重路径(正则源串,不分大小写,对仓根相对路径 / 分隔);缺省 ⇒ []
//       "deployScripts": ["deploy-prod.ps1"],   // 安装方的部署脚本**文件名**(带扩展名、不带目录);缺省 / [] ⇒ 规则 W 的「部署脚本」那一支不响
//       "privateRepos": ["app-private"],        // 安装方自己的私仓**仓名**(不带属主、不带 .git);缺省 / [] ⇒ 规则 DP 的「点了私仓名就不算推去别仓」短路不生效
//       "_note": "任意说明文字"                  // 可选,读者忽略
//     }
//   路径值:仓根相对、`/` 分隔、不得以 `/` 开头、不得含 `..` 段、不得为空串。
//
// ── 名单键(批 305):deployScripts / privateRepos ─────────────────────────────────────
//   这两个键是**确切名字的名单**,只当数据用(消费方拼进正则前自己转义),由收尾闸读(hook-stop-closure 读一次、注入 ctx.installNames;
//   规则不自读磁盘)。与上面的路径键不同,它们**写错了不判坏整份配置**:
//     缺键 / null ⇒ [];不是数组、含非字符串 / 空串、deployScripts 项带目录分隔符或空白、privateRepos 项带 `/` `:` 或空白
//     ⇒ **该键整个按 [] 处理**(对应的判据不响、不拦),并在返回值的 `warnings` 里记一行;`batch-goal --status` 把它打出来。
//   为什么不判坏:名单写错的后果只是「某一支判据不响」,判坏整份会连带把日记 / ADR 核对一起拒清,得不偿失。
//   privateRepos 项结尾的 `.git` 自动去掉(比较时地址末段也去)。两键都不进义务快照(snapshotConfig)——义务核对不读它们。
//   整份配置坏了(解析失败 / 未知键)或读不了 ⇒ installNames() 给两个空名单(闸不因配置坏而多拦)。
//   天花板:批内把名单改空再收尾 ⇒ 对应那一支当场不响;gate-install.json 是承重面,这是一次看得见的已提交改动,不在本层防。
//
// ── 判定(批 298 r2 现行口径)──────────────────────────────────────────────────────
//   文件不存在(ENOENT)⇒ { found:false },diary / adrDir 为 null(不做日记 / ADR 核对),debtTable 取缺省。
//   读不了(EBUSY / EPERM / EISDIR…)⇒ { error, readError:true }:判不了、可重试,不算本批改坏。
//   解析不了 / 格式不对 ⇒ { error }:batch-goal 一律判 config-broken-in-batch(不看基点有没有配置),
//     直接拒清、不计判不了次数、不能 --settle;出路 = 改回这份文件。
//   **快照冻结**:每条义务建立时把求值配置(snapshotConfig)存进记录,之后按快照求值,不按现行 / 新批配置。
//   **缺即拒**:配置写了日记 / ADR 目录,HEAD 里却没有 ⇒ 按「缺」报(给日记行 / ADR 模板),不跳过、也不当判不了。
//   **改名跟随**:快照里的路径在 HEAD 不存在,而 `git diff -M` 显示它在基点之后被改名,且现行配置也指向新路径 ⇒ 按新路径核。
//
// ── 绕过面(五个问题第 5 问)────────────────────────────────────────────────────────
//   「批内把配置改成 diary:null 再结清」:有快照的批按快照核,改配置无效;没有快照的旧批用 mergeInstallConfig
//   并基点版——diary / adrDir / debtTable 取「现行 ?? 基点」,loadBearingExtra 取并集。
//   天花板:跨批关掉(上一批改配置、结清、下一批生效)照样能关——那是一次已提交、会触发承重面核对的显式改动,不在本层防。
//
// CEILING:只管「读哪份、读成什么」;不判配置里写的路径对不对、那个文件在不在(在不在由各核对自己处理)。

import fs from "node:fs";

export const INSTALL_CONFIG_FILE = "gate-install.json";
export const INSTALL_CONFIG_FORMAT = "gate-install/v1";
export const DEFAULT_DEBT_TABLE = "docs/gate-debts.md";
const KEYS = new Set(["format", "diary", "adrDir", "debtTable", "loadBearingExtra", "memoryDirs", "deployScripts", "privateRepos", "_note"]);
// 批 301(MF 两层,设计稿 clipboard/301-design.md 1.2):"memoryDirs": [...] —— 要查「以后都这样做」类 memory 执行面的目录。
//   每项:"@claude-project-memory"(本项目 Claude Code memory 目录,由主 checkout 路径换算)/ "~/…"(家目录相对)/
//   其余相对主 checkout 解析(**允许 ..**,如 "../my-dotfiles/memory")/ 绝对路径。缺省 / null ⇒ 不做 MF(无配置的仓不做)。
//   解析在 scripts/lib/write-checks.mjs resolveMemoryDirs。

/** 名单键的单项校验(批 305)。返回归一后的名字,不合格 ⇒ null。 */
const NAME_LIST_KEYS = {
  // 部署脚本:文件名整体(不带目录;W 按整名、不分大小写认)
  deployScripts: { what: "文件名(带扩展名、不带目录)", norm: (v) => (/[\\/\s"'`]/.test(v) ? null : v) },
  // 私仓:仓名(不带属主 / 地址;结尾 .git 去掉)
  privateRepos: { what: "仓名(不带属主、不带地址)", norm: (v) => { const n = v.replace(/\.git$/i, ""); return !n || /[\\/:\s"'`]/.test(n) ? null : n; } },
};
function parseNameList(o, key, label, warnings) {
  const v = o[key];
  if (v === undefined || v === null) return [];
  const spec = NAME_LIST_KEYS[key];
  const bad = () => { warnings.push(`${label} 的 ${key} 必须是字符串数组,每项是${spec.what}——现按空名单处理(对应的判据不响)`); return []; };
  if (!Array.isArray(v)) return bad();
  const out = [];
  for (const x of v) {
    const n = typeof x === "string" && x.trim() ? spec.norm(x.trim()) : null;
    if (!n) return bad();
    if (!out.some((y) => y.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}
/** 批 305:从一份配置读数(parse / read / absent 的返回值,含 error 形)取两份名单。坏配置 / 没有配置 ⇒ 两个空名单。纯函数。 */
export function installNames(conf) {
  const list = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === "string" && s) : []);
  if (!conf || conf.error) return { deployScripts: [], privateRepos: [] };
  return { deployScripts: list(conf.deployScripts), privateRepos: list(conf.privateRepos) };
}

const badPath = (v) => typeof v !== "string" || !v.trim() || /^[/\\]/.test(v) || /^[A-Za-z]:/.test(v) || v.split(/[/\\]/).includes("..");

/** 解析一份配置正文。返回 { found:true, diary, adrDir, debtTable, loadBearingExtra:RegExp[], loadBearingSrc:string[], deployScripts:string[], privateRepos:string[], warnings:string[] } 或 { error }。纯函数。 */
export function parseInstallConfig(text, label = INSTALL_CONFIG_FILE) {
  let o;
  let src = String(text);
  // 批 298 r1(误拦猎手 FB-2):Windows 编辑器常写 UTF-8 BOM ⇒ 剥掉;UTF-16 按 utf8 读出来是 � / NUL ⇒ 给可读报错
  if (src.startsWith("��") || src.includes(String.fromCharCode(0))) return { error: `${label} 像是 UTF-16 编码——存成 UTF-8(可带 BOM)` };
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  try { o = JSON.parse(src); } catch (e) { return { error: `${label} 不是合法 JSON(${e.message})` }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: `${label} 顶层必须是对象` };
  const unknown = Object.keys(o).filter((k) => !KEYS.has(k));
  if (unknown.length) return { error: `${label} 有未知键 ${unknown.join("、")}(合法:${[...KEYS].join(" ")})——拼错的键会静默关掉核对,整份判坏` };
  if (o.format !== INSTALL_CONFIG_FORMAT) return { error: `${label} 的 format 必须是 "${INSTALL_CONFIG_FORMAT}"(得到 ${JSON.stringify(o.format)})` };
  const out = { found: true, diary: null, adrDir: null, debtTable: DEFAULT_DEBT_TABLE, debtTableExplicit: false, loadBearingExtra: [], loadBearingSrc: [] };
  // 批 305:两份名单(写错不判坏,按空名单 + 告警;见头注「名单键」)
  out.warnings = [];
  out.deployScripts = parseNameList(o, "deployScripts", label, out.warnings);
  out.privateRepos = parseNameList(o, "privateRepos", label, out.warnings);
  for (const k of ["diary", "adrDir", "debtTable"]) {
    if (o[k] === undefined || o[k] === null) continue;
    // 批 298 r1(FB-3):`./docs/x.md` 与 `docs/x.md` 同义 ⇒ 先归一再判
    const v = typeof o[k] === "string" ? o[k].replace(/\\/g, "/").replace(/^(?:\.\/)+/, "") : o[k];
    if (badPath(v)) return { error: `${label} 的 ${k} 不是仓根相对路径(得到 ${JSON.stringify(o[k])})` };
    out[k] = String(v).replace(/\/+$/, "");
    if (k === "debtTable") out.debtTableExplicit = true;
  }
  out.memoryDirs = null;
  if (o.memoryDirs !== undefined && o.memoryDirs !== null) {
    if (!Array.isArray(o.memoryDirs) || o.memoryDirs.some((s) => typeof s !== "string" || !s.trim() || s.includes("\0")))
      return { error: `${label} 的 memoryDirs 必须是非空字符串数组` };
    out.memoryDirs = o.memoryDirs.map((s) => s.trim());
  }
  if (o.loadBearingExtra !== undefined && o.loadBearingExtra !== null) {
    if (!Array.isArray(o.loadBearingExtra)) return { error: `${label} 的 loadBearingExtra 必须是正则源串数组` };
    for (const s of o.loadBearingExtra) {
      if (typeof s !== "string" || !s.trim()) return { error: `${label} 的 loadBearingExtra 里有空项或非字符串` };
      try { out.loadBearingExtra.push(new RegExp(s, "i")); out.loadBearingSrc.push(s); }
      catch (e) { return { error: `${label} 的 loadBearingExtra 项 ${JSON.stringify(s)} 不是合法正则(${e.message})` }; }
    }
  }
  return out;
}

/** 没有配置文件时的取值:日记 / ADR 核对不做,欠账表取缺省。 */
export function absentInstallConfig() {
  return { found: false, diary: null, adrDir: null, debtTable: DEFAULT_DEBT_TABLE, debtTableExplicit: false, loadBearingExtra: [], loadBearingSrc: [], memoryDirs: null, deployScripts: [], privateRepos: [], warnings: [] };
}

/** 批 298 r1(配置冻结):义务建立时把求值要用的配置快照进记录(纯 JSON),之后按快照求值,不按现行 / 新批配置。 */
export function snapshotConfig(c) {
  if (!c || c.error) return null;
  return { found: !!c.found, diary: c.diary ?? null, adrDir: c.adrDir ?? null, debtTable: c.debtTable || DEFAULT_DEBT_TABLE, debtTableExplicit: !!c.debtTableExplicit, loadBearingSrc: [...(c.loadBearingSrc || [])],
    ...(Array.isArray(c.memoryDirs) ? { memoryDirs: [...c.memoryDirs] } : {}) };   // 批 301:没有就不带键(旧快照与自测比对不变)
}
export function configFromSnapshot(s) {
  if (!s || typeof s !== "object") return null;
  try { return { ...s, loadBearingExtra: (s.loadBearingSrc || []).map((x) => new RegExp(x, "i")) }; } catch (e) { return { error: `快照里的承重正则坏了(${e.message})` }; }
}

/** 读仓根(cwd)那份。readFile 可注入(自测)。 */
export function readInstallConfig(readFile = (f) => fs.readFileSync(f, "utf8"), file = INSTALL_CONFIG_FILE) {
  let text;
  try { text = readFile(file); }
  catch (e) {
    if (e && e.code === "ENOENT") return absentInstallConfig();
    // 批 298 r2(猎手 FB-6):读错误 ≠ 解析坏;前者判不了、可重试,不算「本批改坏」
    return { error: `${file} 读不了(${e?.code || e?.message})`, readError: true };
  }
  return parseInstallConfig(text, file);
}

/** 现行版并上基点版(见头注「绕过面」):diary / adrDir 取现行 ?? 基点,loadBearingExtra 取并集,debtTable 取现行。
 *  base 为 null / 有 error ⇒ 原样返回 head(基点版坏了不拿它放宽或收紧,只出声由调用方决定)。 */
export function mergeInstallConfig(head, base) {
  if (!base || base.error || !base.found) return head;
  if (!head || head.error) return head;
  const src = [...new Set([...(head.loadBearingSrc || []), ...(base.loadBearingSrc || [])])];
  const debtFromBase = !head.debtTableExplicit && base.debtTableExplicit;   // 批 298 r1:debtTable 同样并基点版
  return {
    ...head,
    found: true,
    diary: head.diary ?? base.diary ?? null,
    adrDir: head.adrDir ?? base.adrDir ?? null,
    debtTable: debtFromBase ? base.debtTable : head.debtTable,
    debtTableExplicit: head.debtTableExplicit || base.debtTableExplicit,
    memoryDirs: head.memoryDirs ?? base.memoryDirs ?? null,   // 批 301:批内删掉 memoryDirs 关不掉 MF(同 diary / adrDir)
    loadBearingSrc: src,
    loadBearingExtra: src.map((s) => new RegExp(s, "i")),
    mergedFromBase: (head.diary == null && base.diary != null) || (head.adrDir == null && base.adrDir != null) || debtFromBase || src.length > (head.loadBearingSrc || []).length,
  };
}
