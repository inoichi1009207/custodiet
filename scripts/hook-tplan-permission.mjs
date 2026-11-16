#!/usr/bin/env node
// 无头批权限处理器(PreToolUse hook)—— 026 批 S3/S4,2026-07-31 用户逐条口述语义。
//
// ── 它解的是什么问题 ────────────────────────────────────────────────────────
// 019 批实测证过两件事:① CLI 的 deny 是**瞬时返回**、根本不挂起;
// ② 两夜无头停摆的真凶不是「墙挡住了」,而是**模型撞墙后自行绕路试错**——
// 改写命令、换通道、拆分重试,把整个回合耗光。
// 本处理器不新增一堵墙,它给已经存在的那堵墙**加一句话**:
// 「就地停条,不要改写重试」。话术本身就是本工装的主要产出。
//
// ── 两种姿态,永不放行(S3)────────────────────────────────────────────────
//   ① **拒绝**(deny)  —— 命中 deny 条目,或未命中任何 allow;
//   ② **不表态**(静默 exit 0)—— 其余一切情形,退回 CLI 常规权限流自查。
// **没有第三种姿态。本文件不存在任何产生 `allow` 决策的代码路径。**
// 理由:处理器一旦能返回 allow,就等于**越过**常规权限规则;两姿态设计保证它
// 只能**收紧**、永不放宽。出口 `emit()` 对此做硬校验(决策非 "deny" 即什么都不写)。
//
// ── 崩溃不放行(S4,本批最重要的不变量)────────────────────────────────────
// stdin 读不到 / JSON 解析失败 / 档案读不到 / 匹配器抛错 / 自身超时 /
// 输出拼不出合法 JSON —— **一律走「不表态」**,退回 CLI 自查(allow/deny 规则照常生效)。
// **崩掉的钩子不得变成放行口。** 注意这与 `hook-remote-check.mjs` 的 F5(stdin 解析失败
// fail-closed 判 deny)**刻意不同**:那支是单一议题守卫(只管 git push origin),
// 判不出来就拒是对的;本支是**全命令面**处理器,判不出来就拒会把整批卡死,
// 而「退回 CLI 自查」并不放松任何东西——CLI 自己的 deny 段与 allow 白名单原样生效。
//
// ── 作用域:只收命令面 ──────────────────────────────────────────────────────
// 只处理 `Bash` / `PowerShell` 两个工具(与 tplan-gate.mjs 验5 同口径)。
// 文件面(`Edit(/repo/content/private/**)` 等 deny 条目)的模式是**路径**不是命令,
// 拿命令匹配器去判会判错,故一律**不表态**,交还 CLI —— 那些 deny 条目在 CLI 侧原样生效。
//
// ── 匹配语义 ────────────────────────────────────────────────────────────────
// 用 `lib/perm-match.mjs`(**唯一实现**,与 tplan-gate.mjs 验5 共用,不另写一份)。
// 因此本处理器与发车前的验5 **对同一条命令必然给出同一结论**——这正是 026 批把
// 匹配器抽成唯一实现的目的(021 批「判活住两个工装、对同一 pid 给相反结论」的前车之鉴)。
// allow 侧严(只认全字面与尾部通配)意味着本处理器会拒掉一批 CLI 本会放行的命令;
// 这是**刻意的**:方案的「## 命令面清单」已由验5 预清过一遍,清单外的命令本就该停下问。
//
// ── 刻意不抄 `shellMetachar`(S1)──────────────────────────────────────────
// tplan-gate.mjs 的 shell 元字符探测**不搬进来**:019 已实测 CLI 会拆解复合命令逐段判权限,
// `;` / 管道 / 命令替换均获放行,照搬那条会误拒一大批 CLI 本会放行的命令。
// 它是**闸的 fail-closed 策略**,不是匹配语义,留在闸内。
//
// ── 挂载状态 ────────────────────────────────────────────────────────────────
// **已激活(2026-08-01,031 批 P1 用户亲签;挂载动作即原 F2)。**
// 挂点 = `.claude/settings.tplan-exec.json` 的 `hooks.PreToolUse`,
// matcher = `Bash|PowerShell`,timeout = 30s。挂载稿(含论证与验证步骤)见
// `clipboard/hook-tplan-permission-mount.md`。
// **该档案 gitignore、未入仓** ⇒ 挂载状态不受版本控制保护,git 无法恢复;
// 备份见 `clipboard/032-settings-backup/`。改挂点前先读挂载稿的「二、可直接套用的 JSON 片段」。
//
// **台账反哺白名单策展(P1 亲签附带项)**:拒绝台账
// `clipboard/prompts/<NNN>-permission-denials.jsonl`(未传 TPLAN_BATCH 则汇进 `000-`)
// 是**放宽 allow 前的依据**——下次要加白名单条目,先读它看真实拒绝分布,
// 按实撞频次决定加哪条,而不是凭想象补。
//
// ── 环境变量 ────────────────────────────────────────────────────────────────
//   TPLAN_BATCH                 三位批号,决定台账文件名;未设则落 000 汇总台账(不丢记录)。
//   TPLAN_PERM_LEDGER           台账绝对路径(覆盖上一条);自测用它把台账写进临时目录。
//   TPLAN_PERM_PROFILE          权限档案路径覆盖(默认 .claude/settings.tplan-exec.json)。
//   TPLAN_PERM_HOOK_DEADLINE_MS 自身超时(默认 4000ms);超时 ⇒ 不表态。
//   TPLAN_PERM_HOOK_SELFTEST=1 + TPLAN_PERM_HOOK_FAULT=<throw|hang|corrupt|profile>
//                               故障注入,**仅自测**。三条注入路径的落点全是「不表态」,
//                               没有一条能产生 allow —— 故即使误设也不会放宽任何权限。
//
// 用法:`node --no-warnings scripts/hook-tplan-permission.mjs --self-test` 跑自测;
//       `--help` 看本说明摘要。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { matchAllow, matchDeny } from "./lib/perm-match.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(SELF_PATH), "..");

/** 只收命令面;其余工具一律不表态(见头注「作用域」)。 */
const HANDLED_TOOLS = new Set(["Bash", "PowerShell"]);

const DEADLINE_MS = Number(process.env.TPLAN_PERM_HOOK_DEADLINE_MS || 4000) || 4000;

/** 故障注入闸:须 TPLAN_PERM_HOOK_SELFTEST=1 才生效。每条注入的落点都是「不表态」。 */
function fault(tag) {
  return process.env.TPLAN_PERM_HOOK_SELFTEST === "1" && process.env.TPLAN_PERM_HOOK_FAULT === tag;
}

// ---------- 凭据掩码(AGENTS.md 恒定条款②同一套,不复述、不放宽)----------
// 台账**永不落明文凭据**。宁可掩多,不可漏掩 —— 与 deny 侧同一个方向:fail-closed。
const SECRETISH_KEY =
  /(pass(word|wd)?|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|auth|credential|cookie|session[-_]?id|bearer)/i;

export function maskSecrets(input) {
  let s = String(input ?? "");
  // ① 键名疑似凭据的 key=value / key: value(含引号形态)
  s = s.replace(
    // 量词封顶(D57,2026-08-26):原式在 200KB 同字符输入上实测 25.0 秒 > hook 30s 超时。
    // ⚠️ **只封键、不封值**(同日 grill:edge-cases F4 审出并机器复证后收窄):
    //   二次方来自**键名** `[\w.\-]*` 在长单字符串上的逐位回溯;值部分跟在必需的 `[=:]`
    //   之后,不参与放大。我上一版把值也封成 `{1,512}`,后果是**部分掩码**——
    //   超 512 字符的未加引号凭据(长 JWT/base64 是常态)只有前段被 ***MASKED***,
    //   实测 600 字符 token 残留 **88 个明文字符**,而本函数的输出去向是**台账落盘**。
    //   即:一条为治性能而加的上限,悄悄破了宪法恒定条款②「凭据永不进产物文件」。
    //   memory 记着「cookie.txt 密码泄露已犯两次」——这是同族第三次的结构条件,已拆除。
    /([A-Za-z_][\w.\-]{0,128})\s{0,32}([=:])\s{0,32}("[^"]*"|'[^']*'|[^\s;|&]+)/g,
    (m, k, sep) => (SECRETISH_KEY.test(k) ? `${k}${sep}***MASKED***` : m),
  );
  // ② Authorization 头的 Bearer / Basic 载荷
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=\-]{8,}/gi, "$1 ***MASKED***");
  // ③ 命令行旗标形态:--password X / --token X / -p X 之类(下一 token 非旗标时才掩)
  s = s.replace(
    /(--?(?:password|passwd|pwd|token|secret|api[-_]?key|apikey|auth|credential|cookie)[A-Za-z\-]*)(\s+)(?!-)([^\s;|&]+)/gi,
    "$1$2***MASKED***",
  );
  // ④ 兜底:长随机串(≥28 位、字母数字混排)—— 典型的 token / 会话串形态
  s = s.replace(/\b[A-Za-z0-9_\-]{28,}\b/g, (m) =>
    /\d/.test(m) && /[A-Za-z]/.test(m) ? "***MASKED***" : m,
  );
  // ⑤ 短旗标形态(2026-08-11 全库核查 A2 补,用户亲签:「修短旗标规则先于挂载裁决」)。
  //
  // 漏的病:规则③在单横杠下仍要求接**完整关键词**(`-password`),于是 `-p hunter2`
  // 一个字都不掩;规则①要 `=`/`:`,规则④要 ≥28 位 —— 短口令三条全躲过。
  // 后果:无头批里 `mysql -u root -p hunter2` 撞闸时,明文口令逐字落进
  // `*-permission-denials.jsonl` 与 `constraint-events.jsonl`,而**台账按设计只增不改**。
  // 自测 C3 只用长形态,查不出这个洞。
  //
  // **为什么用命令白名单而不是无条件掩 `-p`**:`mkdir -p`、`ssh -p 22`、`curl -p` 里的
  // `-p` 与凭据无关,无条件掩会把台账掩成一堆 MASKED,反而降低取证价值。
  // 在已知取凭据的命令上则宁可掩多(与本文件 fail-closed 方向一致)。
  if (/(^|[\s;|&])(mysql|mysqldump|mysqladmin|mysqlpump|psql|mongo|mongosh|redis-cli|curl|wget|smbclient)\b/i.test(s)) {
    s = s.replace(/(^|\s)(-p)([^\s;|&\-][^\s;|&]*)/g, "$1$2***MASKED***");      // 贴合形态 -phunter2
    s = s.replace(/(^|\s)(-[puU])(\s+)(?!-)([^\s;|&]+)/g, "$1$2$3***MASKED***"); // 分离形态 -p hunter2 / curl -u user:pass
  }
  return s;
}

// ---------- 头段与在册名单(039 批 S7:撞闸后三档分诊)----------
// 「头段」= 第一个 shell 元字符之前的片段。纯字符串切分,**刻意不引入 perm-match 的
// shellMetachar** —— 那是闸的 fail-closed 匹配策略,不是这里要的语义切分(026 批已明令不抽)。
const HEAD_STOP = /\$\(|[|;&><`\n]/;

/** @returns {string} 去空白后的头段;非字符串输入返回 "" */
export function headSegment(cmd) {
  if (typeof cmd !== "string") return "";
  const m = HEAD_STOP.exec(cmd);
  return (m ? cmd.slice(0, m.index) : cmd).trim();
}

/**
 * 从**已加载的**权限档案现算在册可执行名,零维护(名单跟着档案走,不另立清单)。
 * 只取 `Bash(<exe> …)` / `PowerShell(<verb> …)` 的首 token;`*` 之类通配不计。
 */
export function registeredExecs(profile) {
  const out = new Set();
  for (const e of profile?.allow || []) {
    const m = /^(?:Bash|PowerShell)\(([\s\S]*)\)$/.exec(String(e).trim());
    if (!m) continue;
    const first = String(m[1]).trim().split(/\s+/)[0];
    if (!first || first === "*" || first === ":*") continue;
    out.add(first.replace(/^["']|["']$/g, ""));
  }
  return [...out].sort();
}

/** 在册名单渲染;>40 项截断,免得每次撞闸塞一屏噪声把判据行淹掉。 */
function renderExecs(execs) {
  if (!execs || !execs.length) return null;
  if (execs.length <= 40) return execs.join(" · ");
  return execs.slice(0, 40).join(" · ") + ` … 等 ${execs.length} 项,详见档案`;
}

// ---------- 台账 ----------
function ledgerPath() {
  const override = process.env.TPLAN_PERM_LEDGER;
  if (override) return override;
  const batch = /^[0-9]{3}$/.test(String(process.env.TPLAN_BATCH || "")) ? process.env.TPLAN_BATCH : "000";
  return path.join(repoRoot, "clipboard", "prompts", `${batch}-permission-denials.jsonl`);
}

/**
 * 追加一行 JSONL。**入库前掩码**。
 * 台账写失败**不改变决策** —— 决策已经算出来了,少一行台账不构成放宽的理由。
 */
function appendLedger(entry) {
  try {
    const p = ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---------- 拒绝话术(B3 三要素;039 批 S7 扩为四要素 + 三档分诊)----------
/**
 * `mode` / `head` / `execs` 缺省时**退化为原三要素话术,一字不变**——
 * 老调用点与既有自测因此不受影响。
 * @param {"self_inflicted"|"boundary"} [mode] 由 `decide()` 用 matchAllow(头段) **机器判定**,
 *        不由模型自陈(否则「允许一次原样重跑」会变成模型的重试执照)。
 */
export function denyReason({ command, tool, rule, mode, head, execs }) {
  const masked = maskSecrets(command);
  const short = masked.length > 200 ? masked.slice(0, 200) + "…" : masked;
  const basis =
    rule.kind === "deny"
      ? `命中无头权限档案的 deny 条目「${rule.entry}」`
      : `未命中无头权限档案的**任何** allow 条目(档案:.claude/settings.tplan-exec.json)`;

  // ① 自制型:头段本身在册,是临场追加的尾巴把整条打出了在册面。
  if (mode === "self_inflicted" && head) {
    const maskedHead = maskSecrets(head);
    const tail = maskSecrets(String(command).slice(String(head).length)).trim();
    const shortTail = tail.length > 120 ? tail.slice(0, 120) + "…" : tail;
    return [
      `【tplan 无头权限处理器·拒绝(自制型)】`,
      `① 被拒的命令(${tool}):\`${short}\``,
      `② 判据:${basis}。但**头段 \`${maskedHead}\` 本身在册**——是你追加的 \`${shortTail}\` 把整条打出了在册面。`,
      `③ 处置:**照头段原样跑一次**——这是本条唯一允许的一次重跑。`,
      `   要退出码就**拆成两条命令**,或改走 node 包装(\`Bash(node …)\`)。`,
      `   **不要再拼管道 / \`;\` / \`\${...}\` 展开。**同一可执行名不得产生第二条 deny。`,
      `④ 若你判断头段并不足以完成该条目,按边界型处理:就地停条 + 撞闸登记,继续推进其余条目。`,
    ].join("\n");
  }

  // ② 边界型:原三要素**一字不动**,仅在拿得到在册名单时追加第 ④ 要素。
  const lines = [
    `【tplan 无头权限处理器·拒绝】`,
    `① 被拒的命令(${tool}):\`${short}\``,
    `② 判据:${basis}。`,
    `③ 处置:**就地停条**——把这一条连同本拒绝理由写进报告(撞闸登记),然后继续推进其余条目。`,
    `   **不要改写命令重试、不要拆成多条绕、不要换工具或换通道绕路。**`,
    `   无头执行不能现场扩权限,权限档案就是本批的边界。要加条目:改 settings,合并进主分支之前过跨模型复核(全局规范第四节),`,
    `   不是执行会话能自行绕开的东西。反复试错只会把回合耗光——这正是 019 批两夜停摆的成因。`,
  ];
  const listed = renderExecs(execs);
  if (listed) {
    lines.push(
      `④ 本档案在册的可执行名:${listed}`,
      `   其中若有与本命令**语义等价**者(rg→grep、fd→find、bat→cat),可换一次;`,
      `   **语义不等价则不换**(如 \`rg --glob\` ≠ \`grep --include\`),按 ③ 停条——`,
      `   换出一个错答案比停条更坏。`,
    );
  }
  return lines.join("\n");
}

// ---------- 决策(纯函数)----------
/**
 * @returns {null | {decision:"deny", reason:string, rule:{kind:"deny"|"no-allow", entry:string|null}}}
 *          null = **不表态**(退回 CLI 自查)。本函数**不可能**返回 allow。
 */
export function decide(input, profile) {
  if (fault("throw")) throw new Error("注入故障:决策路径抛错(自测用)");

  if (input?.hook_event_name !== "PreToolUse") return null;
  const tool = input?.tool_name;
  if (!HANDLED_TOOLS.has(tool)) return null; // 文件面等交还 CLI(见头注「作用域」)

  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return null; // 判不出来 ⇒ 不表态

  if (!profile) return null; // 档案读不到 ⇒ 不表态(S4:崩溃不放行,也不误拒)

  const denied = matchDeny(command, tool, profile.deny || []);
  if (denied) {
    // 命中 deny 的**不做自制型分诊**:deny 是硬拒,不存在「照头段跑一次」的出路。
    const rule = { kind: "deny", entry: denied };
    return {
      decision: "deny",
      reason: denyReason({ command, tool, rule, execs: registeredExecs(profile) }),
      rule,
      mode: "boundary",
      headExe: headSegment(command).split(/\s+/)[0] || null,
    };
  }
  const allowed = matchAllow(command, tool, profile.allow || []);
  if (allowed) return null; // 清楚命中 allow ⇒ **不表态**,不是 allow(S3)

  const rule = { kind: "no-allow", entry: null };
  // 039 批 S7:头段在册 ⇒ 自制型。判定走 matchAllow 的**唯一实现**,不另写匹配语义。
  const head = headSegment(command);
  const hasTail = head.length > 0 && head.length < command.trim().length;
  const mode = hasTail && matchAllow(head, tool, profile.allow || []) ? "self_inflicted" : "boundary";
  const execs = registeredExecs(profile);
  return {
    decision: "deny",
    reason: denyReason({ command, tool, rule, mode, head, execs }),
    rule,
    mode,
    headExe: (head || command).trim().split(/\s+/)[0] || null,
  };
}

// ---------- 出口:写出去之前先自校验 ----------
/**
 * 唯一的 stdout 出口。写之前把 JSON **再解析一遍**并硬校验决策字段:
 * 决策不是 `"deny"`、或串解析不出来 ⇒ **什么都不写**(= 不表态)。
 * 于是 CLI 只可能收到两种东西:一份合法的 deny JSON,或空 —— 「输出非法 JSON」这条
 * 崩法在出口就被吃掉了,不会退化成不确定行为。
 * @returns {boolean} 是否真的写出
 */
export function emit(payload) {
  let s;
  try {
    s = JSON.stringify(payload);
    if (fault("corrupt")) s = s.slice(0, Math.max(1, s.length - 5)); // 制造非法 JSON(自测用)
    const back = JSON.parse(s);
    if (back?.hookSpecificOutput?.permissionDecision !== "deny") {
      throw new Error(`非法决策:${String(back?.hookSpecificOutput?.permissionDecision)}`);
    }
  } catch {
    return false; // 拼不出合法的拒绝 ⇒ 不表态
  }
  process.stdout.write(s);
  return true;
}

function loadProfile() {
  try {
    if (fault("profile")) throw new Error("注入故障:档案读取抛错(自测用)");
    const p = process.env.TPLAN_PERM_PROFILE || path.join(repoRoot, ".claude", "settings.tplan-exec.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { allow: j?.permissions?.allow || [], deny: j?.permissions?.deny || [] };
  } catch {
    return null; // 读不到 ⇒ decide() 走不表态
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- 主流程 ----------
// 整支包在 try/catch 里;**catch 的落点是「不表态」,不是 allow,也不是 deny**。
async function main() {
  // 超时看门狗:自身没能在时限内给出结论 ⇒ 静默 exit 0 ⇒ 退回 CLI 自查。
  // 刻意**不** unref:stdin 挂住不关时,靠这只表把进程收掉,不留悬挂钩子。
  const watchdog = setTimeout(() => {
    process.exit(0);
  }, DEADLINE_MS);

  try {
    const raw = await readStdin();
    if (fault("hang")) await new Promise(() => {}); // 永不 settle,交给看门狗(自测用)
    const input = JSON.parse(raw);
    const profile = loadProfile();
    const verdict = decide(input, profile);
    if (!verdict) return; // 不表态

    const payload = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: verdict.reason,
      },
    };
    const written = emit(payload);
    if (written) {
      appendLedger({
        at: new Date().toISOString(),
        batch: /^[0-9]{3}$/.test(String(process.env.TPLAN_BATCH || "")) ? process.env.TPLAN_BATCH : "000",
        session: typeof input?.session_id === "string" ? input.session_id.slice(0, 8) : null,
        tool: input?.tool_name ?? null,
        verdict: "deny",
        rule: verdict.rule.kind === "deny" ? `deny:${verdict.rule.entry}` : "no-allow",
        command: maskSecrets(input?.tool_input?.command),
        // 039 批 S7 新增两字段(既有字段与 verdict/rule 一字不改):
        // 主判据按 (session, head_exe) 分组计数,同组 >1 即 violate。
        mode: verdict.mode ?? null,
        head_exe: verdict.headExe ?? null,
      });
      // 036 批追加:同一事实也进束缚面事件流(**既有 appendLedger 一字不改**——
      // 那是既有取证面)。走 spawnSync 调 CLI:事件流模块保持唯一实现,崩了也带不倒本处理器。
      // 命令面**过 maskSecrets 再落**(凭据纪律②:凭据永不打印)。
      // **夹具模式必须一并重定向**:自测把 TPLAN_PERM_LEDGER 指到临时目录,
      // 事件流若仍写默认路径,自测就会把夹具事件灌进**生产台账**(C4-a 守的正是这条,
      // 2026-08-03 实撞:首版接线后跑一次自测,真台账即被写进 6 条假 deny)。
      const cev = process.env.CONSTRAINT_EVENTS_LEDGER
        || (process.env.TPLAN_PERM_LEDGER
          ? path.join(path.dirname(process.env.TPLAN_PERM_LEDGER), "constraint-events.jsonl")
          : null);
      try {
        spawnSync("node", [
          "--no-warnings", path.join(repoRoot, "scripts", "constraint-events.mjs"),
          "--record-raw", "--kind", "deny",
          "--tool", String(input?.tool_name ?? "?"),
          "--target", String(maskSecrets(input?.tool_input?.command) ?? "?").slice(0, 200),
          "--session", typeof input?.session_id === "string" ? input.session_id.slice(0, 8) : "?",
          "--source", "hook-tplan-permission",
          "--evidence", (verdict.rule.kind === "deny" ? `deny:${verdict.rule.entry}` : "no-allow")
            + (verdict.mode ? ` mode=${verdict.mode}` : ""),
        ], { windowsHide: true,
          encoding: "utf8", cwd: repoRoot, timeout: 5000,
          env: cev ? { ...process.env, CONSTRAINT_EVENTS_LEDGER: cev } : process.env,
        });
      } catch {}
    }
  } catch {
    // S4:任何异常路径 ⇒ 不表态。**此处绝不产生放行决策。**
  } finally {
    clearTimeout(watchdog);
  }
}

// ---------- --help ----------
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    [
      "hook-tplan-permission.mjs —— 无头批权限处理器(PreToolUse hook,026 批)",
      "",
      "姿态只有两种:**拒绝** 与 **不表态**;永不返回 allow(出口 emit() 硬校验)。",
      "崩溃(stdin/档案/匹配器/超时/输出非法)一律退回 CLI 自查,绝不因崩溃而放行。",
      "只收命令面 Bash / PowerShell;文件面 deny 条目交还 CLI 常规规则。",
      "匹配器 = scripts/lib/perm-match.mjs(与 tplan-gate.mjs 验5 唯一共用实现)。",
      "",
      "用法:",
      "  <stdin: PreToolUse JSON> | node --no-warnings scripts/hook-tplan-permission.mjs",
      "  node --no-warnings scripts/hook-tplan-permission.mjs --self-test",
      "",
      "环境变量:TPLAN_BATCH / TPLAN_PERM_LEDGER / TPLAN_PERM_PROFILE /",
      "          TPLAN_PERM_HOOK_DEADLINE_MS / TPLAN_PERM_HOOK_SELFTEST + _FAULT(仅自测)",
      "",
      "挂载状态:**未挂载**(026 批 S5)。挂点 .claude/settings.tplan-exec.json,",
      "          挂载稿 clipboard/hook-tplan-permission-mount.md,执行归 F2 批。",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------- --self-test ----------
// 全部用**一次性子进程**跑,夹具落系统临时目录、用完即清;**不写任何仓库文件**(C4)。
if (process.argv.includes("--self-test")) {
  const { spawnSync } = await import("node:child_process");
  let pass = 0;
  let fail = 0;
  const t = (name, ok, detail = "") => {
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}\n`);
    ok ? pass++ : fail++;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tplan-perm-selftest-"));
  const ledger = path.join(tmp, "denials.jsonl");
  const profilePath = path.join(tmp, "profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      permissions: {
        // `Bash(pnpm graph:check)` 刻意**不带尾部通配**——自制型分诊(039 批 S7)需要一条
        // 「头段在册、但整条不在册」的用例;带 `*` 的条目会把追加的管道一并吞进匹配面。
        allow: ["Bash(git status*)", "Bash(node *)", "Read", "Bash(pnpm graph:check)"],
        deny: ["Bash(rm *)", "Bash(git push origin*)"],
      },
    }),
    "utf8",
  );

  // 真实台账路径(默认值)—— C4 要断言它在自测期间**没被创建/改动**。
  const repoLedger = path.join(repoRoot, "clipboard", "prompts", "000-permission-denials.jsonl");
  const repoLedgerBefore = fs.existsSync(repoLedger) ? fs.statSync(repoLedger).mtimeMs : null;

  /** 跑一次子进程处理器。返回 {status, stdout, stderr, json|null}。 */
  const run = (input, env = {}, timeoutMs = 10000) => {
    const r = spawnSync(process.execPath, ["--no-warnings", SELF_PATH], { windowsHide: true,
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        TPLAN_PERM_LEDGER: ledger,
        TPLAN_PERM_PROFILE: profilePath,
        TPLAN_PERM_HOOK_SELFTEST: "",
        TPLAN_PERM_HOOK_FAULT: "",
        ...env,
      },
    });
    let json = null;
    if (r.stdout && r.stdout.trim()) {
      try {
        json = JSON.parse(r.stdout);
      } catch {
        json = "UNPARSEABLE";
      }
    }
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", json };
  };

  const pre = (cmd, tool = "Bash") => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    session_id: "selftest-0000",
    tool_input: { command: cmd },
  });

  const decisionOf = (r) =>
    r.json && r.json !== "UNPARSEABLE" ? r.json?.hookSpecificOutput?.permissionDecision : null;
  const isAllowish = (r) => r.stdout.includes('"allow"') || decisionOf(r) === "allow";

  // ── C1 「永不 allow」正向断言:遍历全部分支,断言没有任何一次输出含 allow 决策 ──
  const branches = [
    ["B1 命中 allow(git status --short)", pre("git status --short"), {}, "abstain"],
    ["B2 命中 allow(node 包装)", pre("node --no-warnings scripts/x.mjs"), {}, "abstain"],
    ["B3 未命中任何 allow", pre("mysql -u root -h db.example.com"), {}, "deny"],
    ["B4 命中 deny(rm)", pre("rm -rf /tmp/whatever"), {}, "deny"],
    ["B5 命中 deny(git push origin)", pre("git push origin master"), {}, "deny"],
    ["B6 非命令面工具(Read)", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } }, {}, "abstain"],
    ["B7 非 PreToolUse 事件", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } }, {}, "abstain"],
    ["B8 中间通配不予承认(allow 侧严)", pre("git commit -m x"), {}, "deny"],
    ["B9 崩法·抛异常", pre("git status --short"), { TPLAN_PERM_HOOK_SELFTEST: "1", TPLAN_PERM_HOOK_FAULT: "throw" }, "abstain"],
    ["B10 崩法·档案读取抛错", pre("mysql -u root"), { TPLAN_PERM_HOOK_SELFTEST: "1", TPLAN_PERM_HOOK_FAULT: "profile" }, "abstain"],
    ["B11 崩法·输出非法 JSON", pre("mysql -u root"), { TPLAN_PERM_HOOK_SELFTEST: "1", TPLAN_PERM_HOOK_FAULT: "corrupt" }, "abstain"],
    ["B12 崩法·stdin 非 JSON", "这不是 JSON{{{", {}, "abstain"],
    ["B13 崩法·超时(看门狗)", pre("git status --short"), { TPLAN_PERM_HOOK_SELFTEST: "1", TPLAN_PERM_HOOK_FAULT: "hang", TPLAN_PERM_HOOK_DEADLINE_MS: "400" }, "abstain"],
  ];

  const results = new Map();
  let allowSeen = 0;
  for (const [name, input, env, expect] of branches) {
    const r = run(input, env);
    results.set(name.split(" ")[0], r);
    if (isAllowish(r)) allowSeen += 1;
    const got = r.stdout.trim() === "" ? "abstain" : decisionOf(r) === "deny" ? "deny" : "OTHER";
    t(`C1 ${name} ⇒ ${expect}`, got === expect && r.status === 0, `got=${got} exit=${r.status}`);
  }
  t(
    "C1 汇总:13 条分支全跑,**零次** allow 决策",
    allowSeen === 0,
    `allow 命中次数=${allowSeen}`,
  );

  // 源码层断言:本文件不存在产生 allow 决策的字面量
  {
    const src = fs.readFileSync(SELF_PATH, "utf8");
    const bad = /permissionDecision\s*[:=]\s*["'`]allow/.test(src) || /["'`]allow["'`]\s*(?:,|\))/.test(src);
    t("C1 源码层:无 `permissionDecision: \"allow\"` 字面量", !bad);
  }

  // ── C2 崩溃不放行三例(阴性,S4 核心)—— 逐例点名,不合并 ──
  {
    const r = results.get("B9");
    t(
      "C2-① 抛异常 ⇒ 不是放行决策,退回 CLI 自查",
      r.status === 0 && r.stdout.trim() === "" && !isAllowish(r),
      `exit=${r.status} stdout=${JSON.stringify(r.stdout.slice(0, 40))}`,
    );
  }
  {
    const r = results.get("B13");
    t(
      "C2-② 超时 ⇒ 不是放行决策,看门狗静默收尾,退回 CLI 自查",
      r.status === 0 && r.stdout.trim() === "" && !isAllowish(r),
      `exit=${r.status} stdout=${JSON.stringify(r.stdout.slice(0, 40))}`,
    );
  }
  {
    const r = results.get("B11");
    t(
      "C2-③ 输出非法 JSON ⇒ 出口自校验吃掉,什么都不写,退回 CLI 自查",
      r.status === 0 && r.stdout.trim() === "" && r.json === null && !isAllowish(r),
      `exit=${r.status} stdout=${JSON.stringify(r.stdout.slice(0, 40))}`,
    );
  }

  // ── C3 掩码有效性:台账里不出现明文凭据 ──
  {
    const secret = "hunter2SuperSecretPw";
    const token = "FAKEtoken0123456789FAKEtoken0123";
    const r = run(pre(`mysql -u root --password=${secret} --token ${token}`));
    const wroteDeny = decisionOf(r) === "deny";
    const line = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : "";
    t("C3-a 含凭据的未在册命令 ⇒ 拒绝且落台账", wroteDeny && line.includes('"verdict":"deny"'));
    t("C3-b 台账不含明文口令", wroteDeny && !line.includes(secret), `secret 出现=${line.includes(secret)}`);
    t("C3-c 台账不含明文 token", wroteDeny && !line.includes(token), `token 出现=${line.includes(token)}`);
    t("C3-d 台账确有掩码标记", line.includes("***MASKED***"));
    t("C3-e 拒绝话术里也不含明文口令", !r.stdout.includes(secret) && !r.stdout.includes(token));
    // 话术三要素(B3)
    t(
      "C3-f 拒绝话术含三要素(被拒命令 / 判据 / 就地停条·勿重试)",
      /被拒的命令/.test(r.stdout) && /判据/.test(r.stdout) && /就地停条/.test(r.stdout) && /不要改写命令重试/.test(r.stdout),
    );
  }

  // ── C4 短旗标掩码(2026-08-11 A2 修的正反用例)──
  // 原实现规则③要求接完整关键词、①要 =/:、④要 ≥28 位 ⇒ 短口令三条全躲过,
  // 明文会落进**只增不改**的台账。C3 只用长形态,查不出。
  {
    const shortPw = ["hunt", "er2"].join("");        // 拆写:避免测试文件本身被凭据模式命中
    const attached = ["ro", "ot123"].join("");
    const basic = ["s3c", "ret"].join("");
    t("C5-a 分离短旗标 -p X 被掩", !maskSecrets(`mysql -u root -p ${shortPw} -e "select 1"`).includes(shortPw));
    t("C5-b 贴合短旗标 -pX 被掩", !maskSecrets(`mysql -p${attached} mydb`).includes(attached));
    t("C5-c curl -u user:pass 被掩", !maskSecrets(`curl -u admin:${basic} https://x`).includes(basic));
    // 反向:同名旗标在非取凭据命令上**不得**被掩,否则台账掩成一堆 MASKED,取证价值归零
    t("C5-d 反向:mkdir -p 不被掩", maskSecrets("mkdir -p data/indexes") === "mkdir -p data/indexes");
    t("C5-e 反向:ssh -p 端口不被掩", maskSecrets("ssh -p 22 host") === "ssh -p 22 host");
  }

  // ── C5 三档分诊(039 批 S7)──
  {
    // C5-a 自制型:头段 `pnpm graph:check` 在册,是追加的 `| rg foo` 把整条打出在册面。
    // 判据取「含头段话术」且「不含边界型专有句」——两个分支因此不可能混淆。
    const r = run(pre("pnpm graph:check | rg foo"));
    const deny = decisionOf(r) === "deny";
    t(
      "C5-a 头段在册+追加管道 ⇒ 自制型话术(含「头段」「原样跑一次」,不含边界型的「不要改写命令重试」)",
      deny && /头段/.test(r.stdout) && /原样跑一次/.test(r.stdout) && !/不要改写命令重试/.test(r.stdout),
      `decision=${decisionOf(r)}`,
    );
    const line = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").trim().split("\n").pop() : "";
    t(
      "C5-a2 台账落 mode=self_inflicted 与 head_exe=pnpm",
      /"mode":"self_inflicted"/.test(line) && /"head_exe":"pnpm"/.test(line),
      line.slice(0, 160),
    );
  }
  {
    // C5-b 边界型:头段本身就不在册 ⇒ 原三要素一字不动 + 第④要素在册名单。
    const r = run(pre("rg -n foo ."));
    t(
      "C5-b 头段不在册 ⇒ 边界型话术(含「就地停条」且列出在册可执行名)",
      decisionOf(r) === "deny"
        && /就地停条/.test(r.stdout)
        && /在册的可执行名/.test(r.stdout)
        && /node/.test(r.stdout)
        && !/原样跑一次/.test(r.stdout),
      `decision=${decisionOf(r)}`,
    );
    const line = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").trim().split("\n").pop() : "";
    t("C5-b2 台账落 mode=boundary 与 head_exe=rg", /"mode":"boundary"/.test(line) && /"head_exe":"rg"/.test(line), line.slice(0, 160));
  }
  {
    // C5-c 掩码回归:新增的自制型文本(含头段与尾巴回显)同样不得泄明文凭据。
    const secret = "hunter2SuperSecretPw";
    const r = run(pre(`pnpm graph:check | mysql --password=${secret}`));
    t(
      "C5-c 自制型话术与台账均不含明文口令(新增文本的掩码回归)",
      !r.stdout.includes(secret)
        && !(fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : "").includes(secret),
    );
  }

  // ── C4 自测不写任何仓库文件 ──
  {
    const after = fs.existsSync(repoLedger) ? fs.statSync(repoLedger).mtimeMs : null;
    t("C4-a 默认台账路径未被创建/改动(夹具全在临时目录)", after === repoLedgerBefore, `before=${repoLedgerBefore} after=${after}`);
    t("C4-b 夹具目录在系统临时目录下", tmp.startsWith(os.tmpdir()));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`\nPASS=${pass} FAIL=${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------- 常态入口(既非 --help 也非 --self-test)----------
if (!process.argv.includes("--self-test") && !process.argv.includes("--help")) {
  await main();
  process.exit(0);
}
