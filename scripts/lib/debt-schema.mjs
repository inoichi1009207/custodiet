// debt-schema.mjs —— 欠账表整份校验(批 301,287 设计 2.2 T 行;设计稿 clipboard/301-design.md 第 2 节)
//
// 本文件的测试防的失败:①有人把某条在账 D 行的失效期列改空(或新登记一行不写失效期),闸没发现——
//   「Open-ended exceptions are not exceptions; they are undeclared policy changes.」(GRC Copilot,2026-11-08 取页);
//   ②列数切错(代码段里的竖线)导致读错列,把合格行判成空、或把空行判成合格;③判不了(列数异常)被当成合格。
//
// 判据(只证「失效期列非空」,不判期限合不合理——那是模型的事):
//   行 = 第一列是 D 号的表格行(半角 `D<数字>[字母]`,全角 NFKC 归一);二级标题「已销账」或「已结清」(批 308 S1b D-2;批 309 C-4 起须是标题本身,见 isSettledHeading)起到下一个二级标题止不查(窄版,批 301 主会话裁定,
//         codex 合并审 r2 后冻结;非 D 行不查是已知漏放,见设计稿拟登债)。
//   切列:debtRowCells(批 285 D133,原住 batch-goal.mjs,批 301 挪来这里,batch-goal 原名再导出——一份实现);
//         切不出 6 列再按裸竖线试一次(与 batch-goal debtDue 同口径);仍不是 6 列 ⇒ 判不了(unknown)。
//   失效期列(第 4 列)去掉 `*` `~` 反引号与空白后,没有任何字母 / 数字 / 汉字 ⇒ 不合格(空、或只剩 `-` `—` `?` 这类占位);
//   只写了占位词(待定 / 无 / 暂无 / 未定 / 待补 / N/A / NA / TBD / TODO)⇒ 同样不合格(批 301 红队 BP-2,主会话定)。
// 天花板:不判「≤9999」这类形式合格而实际无意义的期限;不判同一 D 号重复(那是 debtTableIssues 的事)。
// CALIBRATED=false。

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 批 285(D133):债表一行切成列。反引号代码段里的 `|` 与转义的 `\|` 不是列分隔(坏行里的竖线几乎都出在代码段里),
 *  先换成占位再切、切完还原。返回去掉首尾空串的各列;列数由调用方判(到期腿要求恰为 6)。
 *  天花板:代码段外的裸竖线(描述里直接写 a|b)仍会把行切多——那种行被点名跳过,不猜。 */
export function debtRowCells(line) {
  const P = "\u0001";
  return String(line || "")
    .replace(/`[^`\n]*`/g, (s) => s.replace(/\|/g, P))
    .replace(/\\\|/g, "\\" + P)
    .split("|").slice(1, -1)
    .map((c) => c.split(P).join("|"));
}

/** 批 286(D193④,grill 285 外审附报):这一行是不是「已撤销 / 待用户裁」而不追到期——只看**失效期列与出路列**。
 *  原来按整行查,描述里随口提到这几个字(D159)整行就永不到期提示。切不出 6 列 ⇒ 退回整行(偏松,同旧口径)。 */
export function debtRowParked(line) {
  let c = debtRowCells(line);
  if (c.length !== 6) { const n = String(line).split("|").slice(1, -1); if (n.length === 6) c = n; }
  return /已撤销|待用户裁/.test(c.length === 6 ? `${c[3]} ${c[5]}` : String(line));
}

/** 第一列是不是 D 号;是就返回 D 号(去掉 markup),否则 null。 */
export function debtRowId(line) {
  if (!/^\s*\|/.test(String(line || ""))) return null;
  const first = String(line).split("|")[1];
  if (first === undefined) return null;
  const s = first.normalize("NFKC").replace(/[~*\s]/g, "");
  const m = s.match(/^(D\d+[a-z]?)(?:-|$)/);
  return m ? m[1] : null;
}

const PLACEHOLDER = /^(?:待定|无|暂无|未定|待补|n\/?a|tbd|todo)$/i;
/** 失效期单元格有没有内容:去掉 markup 后有字母 / 数字 / 汉字,且不只是占位词(比较前去掉首尾标点与空白:`待定?`、`（待定）` 也判空)。 */
export const expiryFilled = (cell) => {
  const s = String(cell ?? "").normalize("NFKC").replace(/[*~`\s]/g, "");
  return /[\p{L}\p{N}]/u.test(s) && !PLACEHOLDER.test(s.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, ""));
};

/** 债表里要查失效期的行:[{ line, n, id, label }]。**窄版(批 301 主会话裁定退回并冻结,codex 合并审 r2 后)**:
 *  只认第一列是 D 号的行(半角 `D<数字>[字母]`,全角先 NFKC 归一);一个**二级**标题本身是「已销账」或「已结清」(isSettledHeading)开始、到下一个**二级**标题为止都不判
 *  (子标题不重置,codex 合并审 r2 F2)。第一列不是 D 号的行(「(待编号)」等)不查——已知漏放,登债(主会话合并登债时一律给 D 号)。 */
export function dataRows(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let parked = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) { parked = isSettledHeading(line); continue; }   // 只有二级标题切换豁免区;### 等子标题不重置(批 308 S1b D-2:「已结清」也认;批 309 C-4 起整词)
    if (parked) continue;
    const did = debtRowId(line);
    if (!did) continue;
    out.push({ line, n: i + 1, id: did, label: did });
  }
  return out;
}

/** 结清区的二级标题:「已销账」与「已结清」都认(批 308 S1b D-2:随仓示例表、安装器带到目标仓的那份用的是「已结清」)。 */
export const SETTLED_HEADING = /已销账|已结清/;
/** 批 309 C-4:这一行是不是结清区的二级标题——**标题本身**就是「已销账」或「已结清」才算(原先 SETTLED_HEADING 子串匹配,
 *  「在账(不含已结清的)」这种在账表被当成结清区,里面的欠账不再追)。比较前去掉:加粗等 markup、前导符号(✅ / - 等)、
 *  前导编号(`3.` / `三、` / `(二)` / `第四节`)、尾部括注(半角 / 全角括号,可多段)与尾部冒号句号;
 *  剩下的须恰为两词之一,可带「欠账 / 的欠账 / 债 / 条目 / 项」后缀。不是 `## ` 起头 ⇒ false。 */
export function isSettledHeading(line) {
  const m = /^##\s+(.*)$/.exec(String(line ?? ""));
  if (!m) return false;
  let s = m[1].normalize("NFKC").replace(/[*_`~]/g, "").trim();
  s = s.replace(/^[^\p{L}\p{N}(]+/u, "");
  s = s.replace(/^(?:\([0-9一二三四五六七八九十]+\)|第[0-9一二三四五六七八九十百]+[节章部分]?|[0-9一二三四五六七八九十百]+(?=[\s.、:)\-]))[\s.、:)\-]*/u, "");
  for (;;) {
    const t = s.replace(/\s*\([^()]*\)\s*$/, "").replace(/[\s:.。]+$/, "");
    if (t === s) break;
    s = t;
  }
  return /^(?:已销账|已结清)(?:的?(?:欠账|债|条目|项))?$/.test(s.trim());
}

/** 到期腿(batch-goal --arm / --handoff)取的行:`| Dnn |` 起头、未停放(debtRowParked)、且不在结清区段里的行。
 *  区段口径与 dataRows 相同:二级标题过 isSettledHeading 开始、到下一个二级标题为止;子标题不重置。
 *  批 308 S1b D-2 从 batch-goal 抽来并补上区段判断——原先不看区段,结清区里 4 列的行被点名「列数异常、看不见到期」。 */
export function liveDebtRows(text) {
  const out = [];
  let parked = false;
  for (const l of String(text ?? "").split(/\r?\n/)) {
    if (/^##\s/.test(l)) { parked = isSettledHeading(l); continue; }
    if (!parked && /^\| D\d+ \|/.test(l) && !debtRowParked(l)) out.push(l);
  }
  return out;
}

/** 整份校验。返回 { rows, bad:[{id,label,line,n,why}], unknown:[…] }。纯函数。 */
export function checkDebtTable(text) {
  const out = { rows: 0, bad: [], unknown: [] };
  for (const r of dataRows(text)) {
    const { line, n, id, label } = r;
    out.rows++;
    let c = debtRowCells(line);
    if (c.length !== 6) { const nv = String(line).split("|").slice(1, -1); if (nv.length === 6) c = nv; }
    if (c.length !== 6) { out.unknown.push({ id, label, line, n, why: `切出 ${c.length} 列(应为 6),失效期列定位不了` }); continue; }
    if (!expiryFilled(c[3])) out.bad.push({ id, label, line, n, why: `失效期列为空或只是占位(得到 ${JSON.stringify(c[3].trim())})` });
  }
  return out;
}

/** 新引入的坏行:按 D 号认(改前这个 D 号就坏 ⇒ 不算,改它的描述也不算;不按个数抵扣,修一行改空另一行照拦)。 */
export function introducedBad(before, after) {
  const was = new Set(checkDebtTable(before).bad.map((b) => b.id));
  return checkDebtTable(after).bad.filter((b) => !was.has(b.id));
}
/** 写前层用:改后**新引入**的列数异常 D 行(批 301 误拦 FB-8:新写的坏行当场拒并给转义写法;既有的不追溯)。 */
export function introducedUnknown(before, after) {
  const was = new Set(checkDebtTable(before).unknown.map((b) => b.id));
  return checkDebtTable(after).unknown.filter((b) => !was.has(b.id));
}

// ── 自测 ─────────────────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      实得 ${JSON.stringify(got)}\n      期待 ${JSON.stringify(want)}`}`);
  };
  const H = "| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |\n|---|---|---|---|---|---|\n";
  const ok = "| D900 | 某事 | 300 | **≤303** | codex | 修 |";
  t("合格行 ⇒ 零命中", checkDebtTable(H + ok).bad.length, 0);
  t("表头 / 分隔行不算 D 行", checkDebtTable(H).rows, 0);
  t("失效期列空 ⇒ 不合格", checkDebtTable(H + "| D901 | 某事 | 300 |  | codex | 修 |").bad.map((b) => b.id), ["D901"]);
  t("失效期列只剩加粗 markup ⇒ 不合格", checkDebtTable(H + "| D902 | 某事 | 300 | **** | codex | 修 |").bad.map((b) => b.id), ["D902"]);
  t("失效期列只剩占位符 — ⇒ 不合格", checkDebtTable(H + "| D903 | 某事 | 300 | — | codex | 修 |").bad.map((b) => b.id), ["D903"]);
  t("已撤销 / 待用户裁 / 已结清(有字)⇒ 合格", checkDebtTable(H + "| D904 | x | 1 | **已撤销** | c | d |\n| D905 | x | 1 | ~~≤2~~ **已结清 9** | c | d |").bad.length, 0);
  t("描述列代码段里的竖线不切列(D133)", checkDebtTable(H + "| D906 | 改 `Edit|Write` 那段 | 300 | ≤303 | c | d |").bad.length + checkDebtTable(H + "| D906 | 改 `Edit|Write` 那段 | 300 | ≤303 | c | d |").unknown.length, 0);
  t("代码段里的竖线 + 空失效期 ⇒ 仍判不合格(不读错列)", checkDebtTable(H + "| D907 | `a|b` | 300 |  | c | d |").bad.map((b) => b.id), ["D907"]);
  t("裸竖线把行切多 ⇒ 判不了,不当合格", checkDebtTable(H + "| D908 | a|b|c | 300 | ≤303 | c | d |").unknown.map((u) => u.id), ["D908"]);
  t("划掉的 D 号也是 D 行", debtRowId("| ~~D73-原文~~ | x |"), "D73");
  t("非 D 行不算", debtRowId("| — | grill P7 | 073 | x |"), null);
  t("CRLF 原文", checkDebtTable((H + "| D909 | x | 1 |  | c | d |").replace(/\n/g, "\r\n")).bad.map((b) => b.id), ["D909"]);
  t("新引入:改前已有同一坏行 ⇒ 不算新引入", introducedBad(H + "| D910 | x | 1 |  | c | d |", H + "| D910 | x | 1 |  | c | d |\n" + ok).length, 0);
  t("新引入:把已有行的失效期改空 ⇒ 算", introducedBad(H + ok, H + ok.replace("**≤303**", "")).map((b) => b.id), ["D900"]);
  t("新引入:改前就空的行只改描述 ⇒ 不算(按 D 号认)", introducedBad(H + "| D911 | 旧描述 | 1 |  | c | d |", H + "| D911 | 新描述 | 1 |  | c | d |").length, 0);
  t("新引入:补好一行、改空另一行 ⇒ 算(不按个数抵扣)", introducedBad(H + "| D912 | x | 1 |  | c | d |\n" + ok, H + "| D912 | x | 1 | ≤305 | c | d |\n" + ok.replace("**≤303**", "")).map((b) => b.id), ["D900"]);
  t("新引入:新增一行空失效期 ⇒ 算", introducedBad(H + ok, H + ok + "\n| D999 | x | 301 |  | y | z |").map((b) => b.id), ["D999"]);
  t("首列写法 **D12a** / |D13| 也认", checkDebtTable(H + "| **D12a** | x | 1 |  | c | d |\n|D13| x | 1 |  | c | d |").bad.map((b) => b.id), ["D12a", "D13"]);
  t("一行列数异常不连累别的行:另一行空失效期照判不合格", (() => { const r = checkDebtTable(H + "| D914 | a|b|c | 1 | ≤3 | c | d |\n| D915 | x | 1 |  | c | d |"); return [r.unknown.map((u) => u.id), r.bad.map((b) => b.id)]; })(), [["D914"], ["D915"]]);
  t("失效期只剩 ~~ ~~ / **≤** 以外的标点 ⇒ 不合格;「下批」「305」合格", ["~~ ~~", "-", "?", "下批", "305"].map((x) => expiryFilled(x)), [false, false, false, true, true]);
  // 窄版(批 301 主会话裁定退回):非 D 行不查(已知漏放);全角 Ｄ 归一;二级「已销账」区段到下一个二级标题为止,子标题不重置
  t("窄版:第一列「(待编号)」的行不查(已知漏放,登债)", checkDebtTable(H + "| (待编号) | 新债 | 301 |  | c | d |").rows, 0);
  t("BP-1:全角「Ｄ955」按 D 号认、同样要失效期", checkDebtTable(H + "| Ｄ955 | 新债 | 301 |  | c | d |").bad.map((b) => b.id), ["D955"]);
  t("已销账区段:二级标题「已销账」下的 D 行不追", checkDebtTable("## 已销账\n\n" + H + "| D969 | 某事 | 073 |  | c | d |").rows, 0);
  t("合并审 r2 F2:已销账区段里的子标题(###)不重置豁免", checkDebtTable("## 已销账\n### 某年\n" + H + "| D972 | x | 1 |  | c | d |").rows, 0);
  t("下一个二级标题回到在账区照追", checkDebtTable("## 已销账\n| D973 | x | 1 | 已结清 | c | d |\n## 在账欠账\n" + H + "| D956 | x | 1 |  | c | d |").bad.map((b) => b.id), ["D956"]);
  t("BP-2:失效期只写占位词(待定 / 无 / N/A / TBD / TODO / 暂无)⇒ 不合格", ["**待定**", "无", "N/A", "TBD", "todo", "暂无"].map((x) => expiryFilled(x)), [false, false, false, false, false, false]);
  t("BP-2:真期限不受占位词判据影响(「≤303」「已结清 290」「下一批必修」)", ["≤303", "~~≤280~~ **已结清 290**", "下一批必修"].map((x) => expiryFilled(x)), [true, true, true]);
  t("FB-8:新引入的列数异常行 ⇒ introducedUnknown 点名;既有的不算", [introducedUnknown(H + ok, H + ok + "\n| D957 | a|b | 1 | ≤3 | c | d |").map((u) => u.id), introducedUnknown(H + "| D958 | a|b | 1 | ≤3 | c | d |", H + "| D958 | a|b | 1 | ≤3 | c | d |\n" + ok).length], [["D957"], 0]);
  t("合并审④:占位词去首尾标点(待定? / TBD? / （待定） / 无。)⇒ 判空", ["待定?", "TBD?", "（待定）", "无。"].map((x) => expiryFilled(x)), [false, false, false, false]);
  t("合并审④:合法写法不误伤(≤304(⑩ ≤302) / 到期未办 ⇒ 展期)", ["≤304(⑩ ≤302)", "到期未办 ⇒ 展期"].map((x) => expiryFilled(x)), [true, true]);
  // 批 308 S1b D-2:随仓示例表(安装器原样带到目标仓)的结清区标题是「已结清」,表头 4 列;只认「已销账」时它被算成判不了、到期腿点名列数异常
  const H4 = "| # | 欠账 | 结清批 | 怎么结的 |\n|---|---|---|---|\n";
  t("308 S1b D-2:二级标题「已结清」下的 D 行同样不查", (() => { const r = checkDebtTable("## 已结清\n\n" + H4 + "| D2 | 某事 | 307 | 补审了 |"); return [r.rows, r.unknown.length]; })(), [0, 0]);
  t("308 S1b D-2:到期腿取行同口径——已结清 / 已销账区段的行不取,在账区照取", liveDebtRows(
    "## 在账欠账\n" + H + "| D7 | x | 1 | **≤2** | c | d |\n\n## 已结清\n" + H4 + "| D2 | y | 307 | z |\n## 已销账\n| D9 | w | 1 | v |\n"), ["| D7 | x | 1 | **≤2** | c | d |"]);
  t("308 S1b D-2 对照:已结清区段之后回到别的二级标题照取", liveDebtRows("## 已结清\n| D2 | y | 307 | z |\n## 在账欠账\n| D8 | x | 1 | **≤2** | c | d |\n"), ["| D8 | x | 1 | **≤2** | c | d |"]);
  // 批 309 C-4:结清区标题改成整词——标题里只是顺带出现「已结清」的在账表不再被当成结清区
  t("309 C-4:「在账(不含已结清的)」是在账区,里面的空失效期照判", checkDebtTable("## 在账(不含已结清的)\n" + H + "| D960 | x | 1 |  | c | d |").bad.map((b) => b.id), ["D960"]);
  t("309 C-4:到期腿同口径——「在账(不含已结清的)」下的行照取", liveDebtRows("## 在账(不含已结清的)\n" + H + "| D961 | x | 1 | **≤2** | c | d |\n").length, 1);
  t("309 C-4:顺带提到的说法都不算结清区", ["## 关于已结清", "## 尚未已结清的欠账说明", "## 在账欠账(已销账的见下)", "## 待已结清"].map(isSettledHeading), [false, false, false, false]);
  t("309 C-4:标题本身是那两个词(允许编号、前导符号、加粗、括注、「欠账 / 的欠账」后缀)⇒ 算",
    ["## 已结清", "## 已销账", "## 3. 已结清", "## 三、已销账", "## (二)已结清", "## 第四节 已结清", "## 已结清(2026-11)", "## **已结清**", "## ✅ 已结清", "## 已结清的欠账", "## 已销账欠账", "## 已结清：", "## 已结清 (批 300 起)"].map(isSettledHeading),
    [true, true, true, true, true, true, true, true, true, true, true, true, true]);
  t("309 C-4:非二级标题不算(### 已结清 不切换区段)", [isSettledHeading("### 已结清"), isSettledHeading("已结清")], [false, false]);
  t("debtRowParked 只看失效期列与出路列(D193④ 原用例)", [debtRowParked("| D901 | 原判据已撤销,但新问题仍在 | 285 | **≤280** | 来源 | 出路 |"), debtRowParked("| D902 | 某事 | 285 | **已撤销** | 来源 | 出路 |")], [false, true]);
  console.log(`\n自测 ${pass}/${pass + fail}`);
  return fail ? 1 : 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const canon = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
  try { return canon(fileURLToPath(import.meta.url)) === canon(process.argv[1]); } catch { return false; }
})();
if (isMain && process.argv.includes("--self-test")) process.exit(selfTest());
export { selfTest };
