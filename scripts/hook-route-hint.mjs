// Claude Code hook:在册直路路标(PreToolUse,matcher "Bash|PowerShell")。039 批 S6。
//
// 治的病:手边有**在册的一步法**,却走了熟悉的间接路——用外部 `rg` 检索(不在 allowlist)、
// 用 `Get-Content -Raw` 读 UTF-8 中文(不报错只给错答案)、把凭据字面值内联进命令行
// (直接违反 AGENTS.md 恒定条款②)。台账早写着这些,仍反复发生 ⇒「台账够用」对本场景已被证伪。
//
// 为什么是 deny 而不是注入:`permissionDecisionReason` **只在 deny 时送到模型**;
// `additionalContext + allow` 进的是下一次 model request,改不了当前这次调用(039 批经官方文档核实)。
//
// 三条硬约束(与 hook-tplan-permission 同一套纪律,不复述、不放宽):
//   1. **永不 allow** —— 只可能 deny 或**沉默**(沉默 = 不表态,退回 CLI 自查)。
//   2. **fail-open** —— 任何异常/超时一律沉默。本 hook 是路标不是闸,崩了不该把人堵死。
//      (注:与 hook-remote-check 的 F5 fail-closed 方向**相反**,因此另立一支文件而不是并进去。)
//   3. 话术与事件流**一律过掩码**,绝不回显凭据体。
//
// ── 模式取舍全部有实测数据背书(2026-08-10,5653 条历史 Bash/PowerShell 调用)──
//   (a) rg / find -exec cat|grep / for-do-cat      命中 0.25%   落
//   (b) node -e 含反斜杠                            命中 8.81%   **不落**
//       收窄成「含正则转义且非 ssh」后仍 3.86%,且样本全是**跑通了的**正当命令
//       (反斜杠主力是 ssh 远端引用与 /\r?\n/ 这类正则字面量)。
//       模式匹配分不出「被壳吃了」与「没被吃」⇒ 登记不落地,病仍在,另寻判据。
//   (c) Get-Content -Raw **且无 -Encoding**          命中 0.16%   落(带 -Encoding 是正确用法,不拦)
//   (d1) 打印凭据文件且无脱敏动作                    命中 0.12%   落
//   (d2) 凭据字面值内联命令行                        命中 0.67%   落 —— 文档未设计,实测发现
//
// ── 工艺:怎么写「描述本规则的文字」而不被本规则拦(2026-08-11 用户亲签,取选项③)──
//   d1/d2 **刻意扫原文**(凭据总写在引号里),所以 stripHeredoc/stripQuoted 那套对它们不适用。
//   后果:commit message、文档、报告里只要**描述**这些规则(出现「打印+凭据文件名」的字样),
//   就会命中 d1 —— 2026-08-11 本批提交时实撞。
//   在 A1 收窄白名单**之前**,这类文字靠「整串里随便一个 ls」意外豁免;那层豁免是巧合不是设计,
//   收窄后消失。**已裁决:不改守卫**(改判据会引入漏检:①剥引号会漏 `cat "…/cookie.txt"`;
//   ②按引号位置判命中要多一层位置计算,复杂度换来的检出提升不成比例)。
//   **工艺**:凡 commit message / 长文本要描述这些规则,一律**写进文件再 `git commit -F <文件>`**
//   ——多行提交信息本来就该这么写,零额外成本。**不要在同通道加转义层重试**(已实证连撞三次)。
//
// 用法:
//   node scripts/hook-route-hint.mjs --self-test   跑自测
//   node scripts/hook-route-hint.mjs --help
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SELF_PATH = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(SELF_PATH), "..");
const DEADLINE_MS = 5000;
const HANDLED_TOOLS = new Set(["Bash", "PowerShell"]);

// ---------- 凭据掩码(恒定条款②同一套语义,不放宽)----------
export function maskSecrets(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/(session_token=)[A-Za-z0-9%._-]{8,}/gi, "$1***MASKED***")
    .replace(/(__Secure-[A-Za-z0-9._-]*=)[A-Za-z0-9%._-]{8,}/gi, "$1***MASKED***")
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1***MASKED***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***MASKED***")
    .replace(/\bsk-ant-[A-Za-z0-9._-]{8,}/g, "sk-ant-***MASKED***")
    .replace(/\bghp_[A-Za-z0-9]{8,}/g, "ghp_***MASKED***");
}

// ---------- 规则集 ----------
// 每条:id / 判定 / 一步法。**全字面窄模式**,宁可漏不可宽——S6-d1-credfile 例外:凭据打印漏放收不回、误拦当场可见,
// 批 266e 起它的脱敏白名单按「宁可误拦」收(D167㉟,语料代价 2/1002 条诚实误拦)。
// 脱敏/非打印动作白名单:命中即视为「不是在整行打印凭据」,不拦。
// `ls` 刻意不锚行首 —— 实测 `cd X && ls -la clipboard/cookie.txt` 会被行首锚漏掉而误拦(2026-08-10 重放发现)。
// 批 266 ㉟(grill:security 第十五轮,用户 2026-10-20「改啊」):过滤 ≠ 脱敏——`Select-String` / `-match` / `sed -n p`
// 输出的正是含明文的整行,撤出白名单;sed 只认带替换命令的形(`s` 后接任意分隔符,`s/` `s@` `s|`…,codex 266-r18);
// mask / redact 须在词首(`unmasked` 不算);`cut -c` 只认闭区间(`cut -c 1-` 原样输出整行,r18)。
// 残余(登记不修,D167㉟):白名单只看字样不验效果——注释里的 `# grep -c`、`cat .env ls`、`s/UNLIKELY/X/` 这类仍会被当成脱敏。
// r19:sed 段与 cut 段都限长(防长命令上回溯成平方级);cut 认可带引号的闭区间**列表**,且同句不得有 `--complement`;
// sed 分隔符认非词非空白非反斜杠字符与 `_`(字母 / 空格作分隔符的罕见形登记不认,D167㉟)。
// grill:edge-cases(266e 回归核查):`s` 前不得是反斜杠——正则转义 `\s*` / `\s+` 不是替换命令(`sed '/^\s*#/d'` 曾被当成脱敏);
// cut 区间里出现 `$` 的(`1-$n`、`"$cols"`)静态判不出,维持 50bf270 放行
const REDACT_HINT = /\bmask|\bredact|\bsed\b[^|;\n]{0,200}?(?<!\\)\bs(?:[^\w\s\\]|_)|cut -c\s*['"]?(?:\d+-\d+|-\d+|\d+)(?:,(?:\d+-\d+|-\d+|\d+))*['"]?(?![\d,-])(?![^|;\n]{0,200}--complement)|cut -c\s*['"]?[\d,-]*\$|loadCookieFile|grep -c|\bwc\b|(?:^|[\s;&|])ls\b|Get-ChildItem|no values/i;

/** S6-d1-credfile 的命中起点(线性实现,codex 266-r18:回退续找的正则版在 100 KB 命令上要 1 秒)。
 *  语义 = `/VERB\b[^|;]*FILE\b/gi` 从**每个**动词起点各试一次:动词之后、下一个 `|` / `;` 之前出现凭据文件名即命中。
 *  返回命中动词的起点数组,与 `credfileHitsRegex`(慢的参照实现,只给自测与语料对照用)逐条等价。 */
// r19:后顾里的选项名限长 40(变长后顾在 `x-cat-cat-…` 上回扫成平方级);超长选项名后的动词不豁免(偏严)
const CRED_VERB = () => /(?<!(?:^|\s)--\w[\w-]{0,40}-)\b(?:echo|cat|type|Get-Content)\b/gi;
const CRED_FILE = () => /(?:cookie\.txt|COOKIE_FILE|\.env)\b/gi;
export function credfileHits(c) {
  const files = [], bounds = [], out = [];
  const F = CRED_FILE(); let m;
  while ((m = F.exec(c)) !== null) { files.push(m.index); F.lastIndex = m.index + 1; }
  for (let i = 0; i < c.length; i++) if (c[i] === "|" || c[i] === ";") bounds.push(i);
  const V = CRED_VERB(); let bi = 0, fi = 0;
  while ((m = V.exec(c)) !== null) {
    const end = m.index + m[0].length;
    while (bi < bounds.length && bounds[bi] < end) bi++;
    while (fi < files.length && files[fi] < end) fi++;
    if (fi < files.length && files[fi] < (bi < bounds.length ? bounds[bi] : Infinity)) out.push(m.index);
  }
  return out;
}
export function credfileHitsRegex(c) {
  const re = /(?<!(?:^|\s)--\w[\w-]{0,40}-)\b(echo|cat|type|Get-Content)\b[^|;]*(cookie\.txt|COOKIE_FILE|\.env)\b/gi;
  const out = []; let m;
  while ((m = re.exec(c)) !== null) { out.push(m.index); re.lastIndex = m.index + 1; }
  return out;
}

/**
 * 取「包含 index 的那一条**语句**」——以 `;` / `&&` / `||` / 换行 为语句边界,
 * **管道 `|` 不算边界**(管道是同一条语句的下游,`cat x | sed …` 里 sed 真的在脱敏)。
 *
 * 立此函数的原因(2026-08-11 全库核查 A1,实跑证据):
 * 白名单原先对**整条命令**求值 —— `decide()` 实测
 *   `cat clipboard/cookie.txt`      → deny  ✅
 *   `cat clipboard/cookie.txt; ls`  → SILENT ❌   ← 分号后随便接个 `ls` 就把闸关了
 * 因为 `ls` 命中了 REDACT_HINT,而它跟前半句的打印动作**毫无关系**。
 * 自测 A5 只测裸 `cat`,所以闸「看上去」在工作。
 *
 * **为什么不直接按分号切开整条命令**:规则 S6-a-search 的 `for…;\s*do…cat` 判据
 * **故意跨分号**,全局切分会当场打断它。故只收窄白名单的求值范围,不动匹配范围。
 */
export function statementAt(cmd, index) {
  if (typeof cmd !== "string") return "";
  const SEP = /\|\||&&|;|\n/g;
  let start = 0, end = cmd.length, m;
  SEP.lastIndex = 0;
  while ((m = SEP.exec(cmd)) !== null) {
    if (m.index + m[0].length <= index) start = m.index + m[0].length;
    else if (m.index >= index) { end = m.index; break; }
  }
  return cmd.slice(start, end);
}

export const RULES = [
  {
    id: "S6-a-search",
    test: (c) => /^\s*rg\b/.test(c) || /\bfind\b[^|;]*-exec\s+(cat|grep)\b/.test(c) || /\bfor\b[^;]*;\s*do\b[^;]*\bcat\b/.test(c),
    hint: "仓内检索请用 **Grep / Glob 工具**(已在 allow 首段,一步到位)。`rg` 不在 allowlist,且它的 `--pre` 是任意执行口,不该为此补条目;`find -exec cat` / `for…do cat` 同样是多步且易错的绕法。",
  },
  {
    id: "S6-c-rawread",
    test: (c) => /Get-Content\b[^|;]*-Raw\b/.test(c) && !/-Encoding\b/.test(c),
    hint: "读文件请用 **Read 工具**;若必须走 PowerShell,请写 `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)` 或给 `Get-Content` 补 `-Encoding UTF8`。裸 `-Raw` 读 UTF-8 中文**不报错、只给错答案**(IndexOf 返回 -1),是已登记的环境坑。",
  },
  {
    id: "S6-d1-credfile",
    scanRaw: true,
    // 白名单只对**命中所在的那条语句**求值,不对整串(2026-08-11 A1 修:分号绕过)。
    // **遍历全部命中**,任一处所在语句无脱敏动作即 deny(2026-08-11 F1 修)。
    // 原实现用 `.exec()` 只取**第一处**命中 ⇒ 把顺序反过来就绕开了:
    //   `<打印> <凭据文件> | sed …; <打印> <凭据文件>` —— 首句脱敏、次句裸打印,整条判 false。
    // A1 落地时补的三条反向用例(A7/A8/A9)**全是「第一句就是裸打印」的形态**,
    // 测的是我想到的那个绕法,不是绕法本身 ⇒ 判据类型闸,这次落在自测设计上。
    // 批 266 ㉝(误拦猎手第十四轮):动词紧贴在 `--长选项名-` 之后,它只是选项名的一截(`--input-type=module`),不是命令。
    // 只豁免这一形。codex 266-r13 / r14 两轮实证:再放宽 `=` 前缀、豁免 `process.env` 字样、排除 JS 键 `type:`、
    // 不跨换行,每一处都放过了真打印(`cat config/process.env`、PowerShell 开括号后换行读 `.env` 等),已全撤(D167㉞ 登记残余误拦)。
    test: (c) => {
      // 两个构件各管一类(grill:security 第十五轮核):`--` 后**至少一个词字符**再接 `-`——挡 `--cat`、`x ---cat`(A30);
      // `--` 须在**行首或空白**之后(r15 / r16)——挡 `READER=--x-cat`、`(--x-cat`、`a:--x-cat`、引号里的 `'--x-cat'`(A31 / A32)
      // ㉟:每个动词起点各判一次(原从整段匹配窗口末尾续找,首句白名单词会令换行 / `&&` 后的裸打印漏判);
      // 同一语句的白名单结论只算一次(按语句起点缓存),整体线性
      // 语句边界与 statementAt 同口径(`;` / `&&` / `||` / 换行),一次切好,命中起点递增 ⇒ 指针推进
      const SEP = /\|\||&&|;|\n/g, seps = []; let s;
      while ((s = SEP.exec(c)) !== null) seps.push([s.index, s.index + s[0].length]);
      const seen = new Map(); let si = 0, start = 0;
      for (const i of credfileHits(c)) {
        while (si < seps.length && seps[si][1] <= i) start = seps[si++][1];
        if (!seen.has(start)) seen.set(start, REDACT_HINT.test(c.slice(start, si < seps.length ? seps[si][0] : c.length)));
        if (!seen.get(start)) return true;
      }
      return false;
    },
    hint: "凭据文件**永不整行打印**(AGENTS.md「一、红线」凭据条)。取字段请走 `scripts/prod-lib.mjs` 的 `loadCookieFile(file)`,它只交出你要的那个字段。",
  },
  {
    id: "S6-d2-inlinecred",
    scanRaw: true, // 扫原文:凭据总写在引号里,不给「写进引号/heredoc」这条绕法
    test: (c) =>
      /session_token=[A-Za-z0-9%._-]{20,}/.test(c)
      || /__Secure-[A-Za-z0-9._-]*=[A-Za-z0-9%._-]{20,}/.test(c)
      || /\b(password|passwd|pwd)=[^\s'"]{6,}/i.test(c)
      || /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i.test(c)
      || /\bsk-ant-[A-Za-z0-9._-]{16,}/.test(c)
      || /\bghp_[A-Za-z0-9]{20,}/.test(c),
    hint: "**凭据字面值不得内联命令行**(AGENTS.md「一、红线」凭据条直禁)——命令行会进日志、进 transcript、进报告。请改走 `scripts/prod-lib.mjs`(它从 cookie 文件按字段读取),或让脚本自己去读文件,不要把值搬到命令里。",
  },
];

/**
 * 剥掉 heredoc 正文后再匹配。
 * 起因(2026-08-10 落地首用即实撞):往文档里追加**描述本规则的文字**时,
 * 正文里的 `find -exec cat` 字样命中了规则 a —— 规则被自己的说明书触发。
 * heredoc 正文是**数据不是命令**,不该参与命令形态判定。
 * (历史重放测不出这一类:此前没人写过描述这些规则的文档。)
 */
export function stripHeredocBodies(cmd) {
  if (typeof cmd !== "string" || !/<</.test(cmd)) return cmd;
  // 匹配 <<TAG / <<'TAG' / <<"TAG" / <<-TAG,吃掉直到独占一行的 TAG
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, "<<HEREDOC_BODY_STRIPPED");
}

/**
 * 再剥掉**引号内部**,然后才判命令形态。
 * 起因(2026-08-10 落地首用即实撞**第二次**):`git commit -m "…find -exec cat…"` ——
 * commit message 里描述本规则的文字,又一次命中了规则自己。
 *
 * 判据上的道理:规则 a / c 判的是「**这条命令要执行什么**」,而**引号内部是数据**
 * ——`rg` 要真的跑起来,必须处在命令位置,不可能在引号里。
 * 剥掉引号不削弱检出:`find . -name '*.md' -exec cat {} \;` 里,
 * `find` 与 `-exec cat` 本来就在引号之外。
 *
 * **凭据规则 d1/d2 不走这一步**(它们扫原文):凭据恰恰总是写在引号里。
 */
export function stripQuoted(cmd) {
  if (typeof cmd !== "string") return cmd;
  return stripHeredocBodies(cmd)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

// ---------- 决策(纯函数;不可能返回 allow)----------
/** @returns {null | {rule:string, reason:string}} null = 不表态 */
export function decide(input) {
  if (input?.hook_event_name !== "PreToolUse") return null;
  if (!HANDLED_TOOLS.has(input?.tool_name)) return null;
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return null;

  // heredoc 正文与引号内部都是**数据不是命令**,先剥掉再判命令形态。
  // **凭据类规则(d1/d2)例外,扫原文**:凭据恰恰总是写在引号里,
  // 「写进引号/heredoc」不能成为绕开凭据闸的写法。
  let probe;
  try { probe = stripQuoted(command); } catch { probe = command; }

  for (const r of RULES) {
    const subject = r.scanRaw ? command : probe;
    let hit = false;
    try { hit = r.test(subject); } catch { hit = false; } // 单条规则抛错 ⇒ 当未命中(fail-open)
    if (!hit) continue;
    const masked = maskSecrets(command);
    const short = masked.length > 200 ? masked.slice(0, 200) + "…" : masked;
    return {
      rule: r.id,
      reason: [
        `【在册直路·路标】规则 ${r.id}`,
        `① 被拦的命令(${input.tool_name}):\`${short}\``,
        `② 更短的在册直路:${r.hint}`,
        `③ **换通道,不要在同一通道加转义层重试**——已实证同通道重试会连撞三次。`,
        `   若你判断本条确有正当理由必须这么跑,**停条并写进报告**(撞闸登记),由用户裁决是否放宽,`,
        `   不要自行改写绕过。本路标只在真撞时出现一次,不常驻。`,
      ].join("\n"),
    };
  }
  return null;
}

// ---------- 出口:写之前自校验 ----------
function emit(payload) {
  let s;
  try {
    s = JSON.stringify(payload);
    const back = JSON.parse(s);
    if (back?.hookSpecificOutput?.permissionDecision !== "deny") return false;
  } catch {
    return false;
  }
  process.stdout.write(s);
  return true;
}

async function readStdin() {
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const watchdog = setTimeout(() => process.exit(0), DEADLINE_MS);
  try {
    const input = JSON.parse(await readStdin());
    const verdict = decide(input);
    if (!verdict) return; // 沉默
    const written = emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason,
      },
    });
    if (!written) return;
    // 原始事实进束缚面事件流(只记 deny,**不自判真拦/误拦** —— 裁决层另行追加)。
    const cev = process.env.CONSTRAINT_EVENTS_LEDGER || null;
    try {
      spawnSync("node", [
        "--no-warnings", path.join(repoRoot, "scripts", "constraint-events.mjs"),
        "--record-raw", "--kind", "deny",
        "--tool", String(input?.tool_name ?? "?"),
        "--target", String(maskSecrets(input?.tool_input?.command) ?? "?").slice(0, 200),
        "--session", typeof input?.session_id === "string" ? input.session_id.slice(0, 8) : "?",
        "--source", "hook-route-hint",
        "--evidence", verdict.rule,
      ], { windowsHide: true,
        encoding: "utf8", cwd: repoRoot, timeout: 5000,
        env: cev ? { ...process.env, CONSTRAINT_EVENTS_LEDGER: cev } : process.env,
      });
    } catch {}
  } catch {
    // fail-open:任何异常 ⇒ 沉默,退回 CLI 自查。**此处绝不产生放行决策。**
  } finally {
    clearTimeout(watchdog);
  }
}

// ---------- --help ----------
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write([
    "hook-route-hint.mjs —— 在册直路路标(PreToolUse hook,039 批 S6)",
    "",
    "  只可能 deny 或沉默,永不 allow;任何异常 fail-open(沉默)。",
    `  现行规则:${RULES.map((r) => r.id).join(" · ")}`,
    "  刻意不含的规则:node -e 含反斜杠(实测误拦 3.86%,样本全为跑通的正当命令)",
    "",
    "  node scripts/hook-route-hint.mjs --self-test",
    "",
  ].join("\n"));
  process.exit(0);
}

// ---------- --self-test ----------
if (process.argv.includes("--self-test")) {
  let pass = 0, fail = 0;
  const t = (name, cond, detail = "") => {
    if (cond) { pass++; process.stdout.write(`PASS ${name}${detail ? " — " + detail : ""}\n`); }
    else { fail++; process.stdout.write(`FAIL ${name}${detail ? " — " + detail : ""}\n`); }
  };
  const pre = (command, tool = "Bash") => ({
    hook_event_name: "PreToolUse", tool_name: tool, session_id: "selftest",
    tool_input: { command },
  });
  const run = (input, env = {}) => {
    const r = spawnSync(process.execPath, ["--no-warnings", SELF_PATH], { windowsHide: true,
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, CONSTRAINT_EVENTS_LEDGER: path.join(os.tmpdir(), "route-hint-selftest-events.jsonl"), ...env },
    });
    let json = null;
    if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch { json = "UNPARSEABLE"; } }
    return { status: r.status, stdout: r.stdout ?? "", json };
  };
  const decision = (r) => (r.json && r.json !== "UNPARSEABLE" ? r.json.hookSpecificOutput?.permissionDecision : null);

  // A 命中面
  t("A1 rg 检索 ⇒ deny 且指向 Grep 工具", decision(run(pre("rg -n foo ."))) === "deny" && /Grep/.test(run(pre("rg -n foo .")).stdout));
  t("A2 find -exec cat ⇒ deny", decision(run(pre("find . -name '*.md' -exec cat {} \\;"))) === "deny");
  t("A3 裸 -Raw ⇒ deny", decision(run(pre("$c = Get-Content E:/x.txt -Raw", "PowerShell"))) === "deny");
  t("A4 -Raw 带 -Encoding ⇒ **沉默**(那是正确用法,不拦)", decision(run(pre("$c = Get-Content E:/x.txt -Raw -Encoding UTF8", "PowerShell"))) === null);
  t("A5 整行打印 cookie.txt ⇒ deny", decision(run(pre("cat clipboard/cookie.txt"))) === "deny");
  t("A6 对 cookie.txt 做计数/列目录 ⇒ 沉默(有脱敏动作,不拦)", decision(run(pre("wc -l clipboard/cookie.txt"))) === null);
  // ── A7–A9:2026-08-11 A1 修的反向用例(分号绕过)。缺这三条,重构会原地再犯 ──
  t("A7 打印 cookie.txt 后接无关命令 ⇒ 仍 deny(白名单不得跨语句)",
    decision(run(pre("cat clipboard/cookie.txt; ls"))) === "deny");
  t("A8 打印 cookie.txt 后接 && 无关命令 ⇒ 仍 deny",
    decision(run(pre("cat clipboard/cookie.txt && ls -la"))) === "deny");
  t("A9 管道到脱敏动作 ⇒ 沉默(管道是同一条语句的下游,不得因 A7 修法而误拦)",
    decision(run(pre("cat clipboard/cookie.txt | sed 's/token=.*/token=***/'"))) === null);
  // ── A10–A11:2026-08-11 F1 的反向用例(**反序**绕过)。A7–A9 全是「首句裸打印」形态,
  //    测不出「首句脱敏、次句裸打印」——那恰是取凭据时最自然的写法(先看一眼再 dump)。
  t("A10 首句脱敏 + 次句裸打印 ⇒ 仍 deny(白名单不得因首处命中合规就放过后续)",
    decision(run(pre("cat clipboard/cookie.txt | sed 's/a/b/'; cat clipboard/cookie.txt"))) === "deny");
  t("A11 && 反序同形 ⇒ 仍 deny",
    decision(run(pre("cat clipboard/cookie.txt | wc -l && cat clipboard/cookie.txt"))) === "deny");
  // ── A12–A17:批 266 ㉝ 的正反用例(node 探针读 process.env 被当成打印 .env 文件)──
  t("A12 node --input-type=module 读 process.env ⇒ 沉默",
    decision(run(pre("node --input-type=module -e \"console.log(Object.keys(process.env).length)\""))) === null);
  t("A13 对照:node -e 里 cat 字样与 process.env 被分号隔开 ⇒ 沉默(修前也沉默)",
    decision(run(pre("node -e \"const cat=1; console.log(process.env.HOME)\""))) === null);
  // ── A18–A20:codex 266-r13 的回归钉(首版修法曾放过这三形)──
  t("A18 cat config/process.env ⇒ 仍 deny(文件名里的 process 不豁免)", decision(run(pre("cat config/process.env"))) === "deny");
  t("A19 Get-Content -Path config/Deno.env ⇒ 仍 deny", decision(run(pre("Get-Content -Path config/Deno.env", "PowerShell"))) === "deny");
  t("A20 env READER=cat sh -c '$READER .env' ⇒ 仍 deny(`=` 前缀不豁免)",
    decision(run(pre("env READER=cat sh -c '$READER .env'"))) === "deny");
  // ── A21–A27:codex 266-r14 的回归钉(第二版修法曾放过)与续行对照 ──
  t("A21 ${x-cat} .env(单连字符前缀)⇒ 仍 deny", decision(run(pre("${x-cat} .env"))) === "deny");
  t("A22 READER=cat: 间接读 .env ⇒ 仍 deny",
    decision(run(pre("env READER=cat: bash -c '\"${READER%:}\" .env'"))) === "deny");
  t("A26 PowerShell 开括号后换行读 .env ⇒ 仍 deny", decision(run(pre("Get-Content (\n'.env'\n)", "PowerShell"))) === "deny");
  t("A27 cat \"$(\\n printf .env)\" ⇒ 仍 deny", decision(run(pre("cat \"$(\nprintf .env\n)\""))) === "deny");
  t("A28 READER=cat= 间接读 .env(r14)⇒ 仍 deny",
    decision(run(pre("env READER=cat= bash -c '\"${READER%=}\" .env'"))) === "deny");
  t("A29 cat heredoc 里 $(<.env)(r14)⇒ 仍 deny", decision(run(pre("cat <<EOF\n$(<.env)\nEOF"))) === "deny");
  t("A30 READER=--cat / --cat 前缀(r15)⇒ 仍 deny",
    decision(run(pre("env READER=--cat bash -c '\"${READER#--}\" .env'"))) === "deny" && decision(run(pre("x --cat .env"))) === "deny");
  t("A31 引号里的 '--x-cat' 经参数展开读 .env(r16)⇒ 仍 deny",
    decision(run(pre("env READER='--x-cat' bash -c '\"${READER##*-}\" .env'"))) === "deny");
  t("A32 起点锚:=--x-cat / (--x-cat / a:--x-cat / ---cat 读 .env ⇒ 仍 deny",
    ["env READER=--x-cat bash -c '\"${READER#--x-}\" .env'", "(--x-cat .env)", "a:--x-cat .env", "x ---cat .env"]
      .every((c) => decision(run(pre(c))) === "deny"));
  // ── A33–A35:批 266 ㉟(窗口跳过 / 过滤词冒充脱敏)──
  t("A33 首句含白名单词、换行或 && 后裸打印 ⇒ deny",
    ["echo \"== ls ==\"\ncat .env", "echo ls\ncat .env", "# cat the masked copy later\ncat .env", "echo sed-check && cat clipboard/cookie.txt"]
      .every((c) => decision(run(pre(c))) === "deny"));
  t("A34 过滤不是脱敏:Select-String / -match / sed -n p / unmasked ⇒ deny",
    [["Get-Content .env | Select-String TOKEN", "PowerShell"], ["(Get-Content .env) -match 'TOKEN'", "PowerShell"],
      ["cat .env | sed -n p", "Bash"], ["cat .env > /tmp/unmasked-copy", "Bash"]]
      .every(([c, tool]) => decision(run(pre(c, tool))) === "deny"));
  t("A35 真脱敏照放:sed 替换 / mask 管道 ⇒ 沉默",
    ["cat clipboard/cookie.txt | sed -E 's/=.*/=***/'", "cat .env | node scripts/mask.mjs"]
      .every((c) => decision(run(pre(c))) === null));
  // ── A36–A38:codex 266-r18(sed 任意分隔符 / cut -c 开区间 / 线性实现)──
  t("A36 sed 's@=.*@=***@' 是真脱敏 ⇒ 沉默;cut -c 1- 原样输出 ⇒ deny;cut -c1-12 ⇒ 沉默",
    decision(run(pre("cat .env | sed 's@=.*@=***@'"))) === null && decision(run(pre("cat .env | cut -c 1-"))) === "deny"
      && decision(run(pre("cat .env | cut -c1-12"))) === null);
  {
    const sample = ["cat .env", "echo ls\ncat .env", "echo a | b; cat x.env", "--input-type=x cat .env", "type cookie.txt | sed 's/x/y/'",
      "echo mask\necho mask .env", "cat a; cat b | c .env", "Get-Content ;.env", "cat\n.env", "x cat.env"];
    t("A37 线性 credfileHits 与正则参照实现逐条等价", sample.every((x) => JSON.stringify(credfileHits(x)) === JSON.stringify(credfileHitsRegex(x))));
    const big = "echo mask\n".repeat(10000) + "echo mask .env";
    const t0 = Date.now(); const rule = RULES.find((r) => r.id === "S6-d1-credfile"); rule.test(big); const ms = Date.now() - t0;
    t("A38 100 KB 命令判定 < 100 ms(r18 实测回退正则版约 1 秒)", ms < 100, `${ms} ms`);
    const slow = ["cat .env " + "sed x ".repeat(16000), "x-" + "cat-".repeat(16000) + " .env"].map((x) => { const a = Date.now(); rule.test(x); return Date.now() - a; });
    t("A39 r19 两条平方级输入(重复 sed、连字符动词串,各约 64–96 KB)< 100 ms", slow.every((x) => x < 100), slow.join(" / ") + " ms");
  }
  t("A40 cut -c 列表 / 补集 / 引号(r19):1-2,3- 与 --complement ⇒ deny;'1-3' ⇒ 沉默;sed s_ ⇒ 沉默",
    decision(run(pre("cat .env | cut -c1-2,3-"))) === "deny" && decision(run(pre("cat .env | cut -c999 --complement"))) === "deny"
      && decision(run(pre("cat .env | cut -c '1-3'"))) === null && decision(run(pre("cat .env | sed 's_=.*_=***_'"))) === null
      && decision(run(pre("cols=1-3; cat .env | cut -c \"$cols\""))) === null);   // r20:变量区间静态判不出,维持 50bf270 行为
  t("A41 sed 正则转义 \\s 不是替换命令(grill:edge-cases)⇒ deny;cut -c1-$n 变量上界 ⇒ 沉默",
    ["cat .env | sed '/^\\s*#/d'", "cat .env | sed -n '/^\\s*KEY=/p'", "cat clipboard/cookie.txt | sed '/^\\s*$/d'"]
      .every((x) => decision(run(pre(x))) === "deny")
      && ["cat .env | cut -c1-$n", "cat .env | cut -c \"1-$n\""].every((x) => decision(run(pre(x))) === null));
  t("A23 cat 后反斜杠续行到 .env ⇒ 仍 deny", decision(run(pre("cat \\\n  .env"))) === "deny");
  t("A24 echo 换行后真 cat .env ⇒ 仍 deny", decision(run(pre("echo hi\ncat .env"))) === "deny");
  t("A25 PowerShell 反引号续行 Get-Content 到 .env ⇒ 仍 deny",
    decision(run(pre("Get-Content `\r\n  -Path .env", "PowerShell"))) === "deny");
  t("A14 cat .env ⇒ 仍 deny", decision(run(pre("cat .env"))) === "deny");
  t("A15 type .env.local(PowerShell)⇒ 仍 deny", decision(run(pre("type .env.local", "PowerShell"))) === "deny");
  t("A16 cat config/prod.env ⇒ 仍 deny(文件名里的 .env 不豁免)", decision(run(pre("cat config/prod.env"))) === "deny");
  t("A17 node 探针后接 cat .env ⇒ 仍 deny",
    decision(run(pre("node --input-type=module -e \"1\"; cat .env"))) === "deny");

  // B 内联凭据(核心新增)
  {
    const tok = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
    const r = run(pre(`export APP_COOKIE='__Secure-better-auth.session_token=${tok}'`));
    t("B1 凭据字面值内联 ⇒ deny", decision(r) === "deny");
    t("B2 话术**不回显凭据体**(掩码生效)", !r.stdout.includes(tok), `泄露=${r.stdout.includes(tok)}`);
    t("B3 话术指向 prod-lib.mjs", /prod-lib\.mjs/.test(r.stdout));
  }

  // C 不表态面(fail-open / 永不 allow)
  t("C1 普通命令 ⇒ 沉默", decision(run(pre("git status --short"))) === null);
  t("C2 node -e 含反斜杠 ⇒ **沉默**(该模式实测误拦 3.86%,刻意不落)", decision(run(pre("node -e \"const s='a'.split(/\\r?\\n/)\""))) === null);
  t("C3 非 Bash/PowerShell 工具 ⇒ 沉默", decision(run({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } })) === null);
  t("C4 非 PreToolUse 事件 ⇒ 沉默", decision(run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rg foo" } })) === null);
  {
    const r = run("这不是 JSON");
    t("C5 stdin 非法 ⇒ fail-open 沉默(不是 deny,也不是 allow)", r.status === 0 && r.stdout.trim() === "");
  }
  t("C6 源码层:无 permissionDecision allow 字面量",
    !/permissionDecision"?\s*:\s*"allow"/.test(fs.readFileSync(SELF_PATH, "utf8")));

  // D heredoc 正文剥离(2026-08-10 落地首用即实撞的误拦类)
  {
    const doc = "cat >> docs/x.md <<'EOF'\n表格里写着 find -exec cat 与 rg 两条规则\nEOF";
    t("D1 heredoc 正文里出现规则字样 ⇒ **沉默**(正文是数据不是命令)", decision(run(pre(doc))) === null);
  }
  t("D2 heredoc 之外真的跑 find -exec cat ⇒ 仍然 deny",
    decision(run(pre("find . -name '*.md' -exec cat {} \\; ; cat <<'EOF'\nhi\nEOF"))) === "deny");
  {
    const tok = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
    t("D3 凭据写进 heredoc ⇒ 仍然 deny(不给这条绕法)",
      decision(run(pre(`cat > /tmp/x <<'EOF'\nexport K='__Secure-better-auth.session_token=${tok}'\nEOF`))) === "deny");
  }

  process.stdout.write(`\nPASS=${pass} FAIL=${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------- 常态入口 ----------
if (!process.argv.includes("--self-test") && !process.argv.includes("--help")) {
  main();
}
