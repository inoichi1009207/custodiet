#!/usr/bin/env node
// codex-run.mjs — /codex 通用入口的薄壳(038 批,2026-08-09 用户亲签)。
//
// 定位:直接 spawn `codex exec` 的薄壳,**不经 MCP 桥**——桥无可控超时、长单回复会吊死;
// CLI 子进程可杀、可设截止时间、`--json` 出 JSONL 事件流可当心跳。
// 同理**不复用** cc-suite 锁版 codex-runner.mjs:它住插件缓存的版本号目录下,插件一升级即漂移。
//
// 沙箱缺省 read-only(-C 当前项目根 ⇒ codex 可读仓库、可联网;2026-08-09 实测写入被 OS 拒);2026-09-05 用户裁定后
//   `--sandbox workspace-write` 作显式可选项接受(见下方 FORBIDDEN_FLAGS 注释),其余越权旗标照旧拒。守卫装在被调函数内部而非调用处。
//   ⚠️ 批 285 D141:「read-only 拦写」在本机**已不成立**——2026-10-09 的 256b-final 那次 read-only 运行在 clipboard/ 写出了
//   审计报告与两个探针文件。本壳不做事后写入核对(漏放侧,批 285 按接受风险处理,见欠账 D141),
//   所以任务书要禁写就写明禁写,别指望沙箱兜底。
// 双源:运行权威在 ~/.claude/scripts/(user 级),仓内是版本化副本;改了本文件合回主干后跑
//   `node scripts/codex-entry-sync.mjs --install` 归一(每次发起与 --doctor 都比一次,漂移只打 NOTE / WARN 不阻断)。
//
// 进程分层(>120s 转后台的实现):
//   父进程 = 取号 + 起 worker(detached) + 前台等 --wait-ms;超期则打印交接块后自身退出 0。
//   worker = 真正 spawn codex、写结果件、更新 job 状态。detached 故父退不带走它。
//   ⇒ 见到 CODEX_STATE=background 就 --poll 轮询,**绝不重新 --task 发一次**
//     (重发双份烧配额,且两份结果互相覆盖同一个 r<n> 槽位)。
//
// 返回口径(批 257,收尾闸 A 项按它进账,见 hook-stop-closure.mjs `codexLedger`):
//   **所有返回**(前台 done / 前台 failed / 转后台 / --poll)都带 `CODEX_JOB=<id>` 与 `CODEX_STATE=…`;
//   failed 另带 `CODEX_ERROR_CODE`(有码时)与 `CODEX_ERROR`;机器块末行恒为 `CODEX_END=<id>`(`| tail -1` 也带得出 J)。
//   --poll 先机器块、**整段末行**保持旧口径(`running` / `done <路径>` / `failed <原因>`)。
//   v5(clipboard/257-a-fix-r3-list.md「主会话裁定 v5」):机器块之后,done 时把结果件全文夹在
//   `CODEX_BODY_BEGIN=<id>` / `CODEX_BODY_END=<id>` 之间打出;failed 时把日志尾部夹在 `CODEX_FAIL_BEGIN=<id>` /
//   `CODEX_FAIL_END=<id>` 之间——收尾闸只认这两种带 J 的完整块(或 Read 工具读 R / 日志),不再从 shell 读法推断归属。
//   `--poll J --wait-ms N` 等到期仍 running ⇒ 退出码 3(与 done 的 0 区分,`… && cat R` 不会在未完成时接着跑)。
//   最终消息 `trim()` 为空 ⇒ failed + `CODEX_ERROR_CODE=empty-body`(台账同记 errorCode),不论退出码;
//   **退出码非 0 但正文非空 ⇒ 仍判 done**——现存分支,本批照旧未改(台账记 exitCode,读者自行核)。
//
// 发车前查任务书(批 305):`--task` 发车那一刻读任务书判四条(用途 / 完成标准 / 结论选项里有「不用再审」/ 审设计类不过长),
//   任一条不过 ⇒ 不取号、不占结果件槽位、不起 worker,退出码 4,stderr 写明缺哪条并打出四条要求原文。
//   `--fact-check` 免「不过长」;`--no-taskbook-check` 整体跳过(给脚本生成的任务书用,结果件头部记「任务书检查:跳过」);
//   `--resume` / `--poll` / `--doctor` / `--self-test` 不查。`--skeleton [design|fact]` 出骨架,`--check-taskbook <文件>` 只判不发。
//   第二轮起(结果文件 `<slug>-r<n>.md` 的 n ≥ 2)done 的输出在 BODY 块之后多一行提示:分拣前先派 `_direction-judge`。
//
// 凭据纪律:与 AGENTS.md 恒定条款②同一套,不复述、不放宽。本壳不打印子进程环境,
// 不回显任务文件内容,stdout 与结果件均不得出现凭据。
//
// 自测:node scripts/codex-run.mjs --self-test(全离线,零 codex 调用,含反向用例)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
// 导出:收尾闸自测据此核「hook 端作业目录与本壳同一算法」(批 257 红队 r2 tmpdir 一致性)
export const JOB_ROOT = path.join(os.tmpdir(), "codex-run-jobs");

/** 越权类旗标命令行出现即拒(exit 2);沙箱只认 `--sandbox read-only | workspace-write`。 */
// 2026-09-05 用户裁定「先暂时把沙箱打开」:`--sandbox workspace-write` 作**显式可选项**接受(缺省仍 read-only);
//   -s / 越权旗标照旧拒。workspace-write 在本机笼外写也成功(2026-08-09 实测),所以它等于「给写权限」,只在用户点名时用。
const FORBIDDEN_FLAGS = [
  "-s",
  "--add-dir",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
];

// 缺省 read-only 的由来(2026-08-09 038 批四次实弹;09-05 起 workspace-write 可点名放开,见上)——
//   read-only        :写被 OS 拒(UnauthorizedAccessException)**且网络通**(四客户端全 200);
//   workspace-write  :笼外写**成功**(Windows 沙箱后端未配即静默失效),网络反而更差(schannel 挂)。
// 原本引入 research(workspace-write + 一次性草稿笼)的**唯一动机是联网**,
// 而 read-only 本来就有网 ⇒ 那笔「拿写权限换联网」的交易根本不必做。
// 故 research 已整支移除(2026-08-09 用户裁决「勿增实体」),不留 fail-closed 残桩。
// 实测矩阵留在 docs/prod-facts.md「跨项目工艺与环境事实」节。

const REPO_BRIEF_CANDIDATES = [
  path.join("clipboard", "codex-repo-brief.md"),
  path.join("docs", "repo-brief.md"),
  "AGENTS.md",
];

// ── 纯函数区(自测直接调,不起子进程) ──────────────────────────────────

export function parseArgs(argv) {
  const out = {
    timeoutMs: 15 * 60 * 1000,
    waitMs: 120 * 1000,
    withRepoBrief: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FORBIDDEN_FLAGS.includes(a)) {
      const err = new Error(
        `拒绝入参 ${a}:越权旗标一律拒(沙箱只认 --sandbox read-only | workspace-write)。\n` +
          "  read-only 已经既拦写又有网(2026-08-09 实测),没有放宽的理由。\n" +
          "  依据:038 批已签决策 2(用户亲签)。要 codex 往仓库/内容/服务器写,另立批。",
      );
      err.exitCode = 2;
      throw err;
    }
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        const err = new Error(`参数 ${a} 缺值`);
        err.exitCode = 1;
        throw err;
      }
      return v;
    };
    switch (a) {
      case "--task": out.task = next(); break;
      case "--slug": out.slug = next(); break;
      case "--out": out.out = next(); break;
      case "--cwd": out.cwd = next(); break;
      case "--model": out.model = next(); break;
      case "--sandbox": { const v = argv[i + 1]; if (v === undefined || /^-/.test(v)) { const err = new Error("--sandbox 缺值:只接受 read-only | workspace-write"); err.exitCode = 2; throw err; } i++; if (!["read-only", "workspace-write"].includes(v)) { const err = new Error(`--sandbox 只接受 read-only | workspace-write,得到「${v}」`); err.exitCode = 2; throw err; } out.sandbox = v; break; }
      case "--effort": out.effort = next(); break;
      case "--timeout-ms": out.timeoutMs = Number(next()); break;
      case "--wait-ms": out.waitMs = Number(next()); out.waitGiven = true; break;
      case "--resume": out.resume = next(); break;
      case "--poll": out.poll = next(); break;
      case "--with-repo-brief": out.withRepoBrief = true; break;
      // 批 305:发车前查任务书(见下方 checkTaskbook)
      case "--fact-check": out.factCheck = true; break;
      case "--no-taskbook-check": out.noTaskbookCheck = true; break;
      case "--check-taskbook": out.checkTaskbook = next(); break;
      case "--skeleton": {
        // 值可省(缺省 design);下一个词是旗标或没有 ⇒ 不吞
        const v = argv[i + 1];
        if (v === undefined || /^-/.test(v)) { out.skeleton = "design"; break; }
        i++;
        if (!SKELETON_KINDS.includes(v)) { const err = new Error(`--skeleton 只接受 design | fact,得到「${v}」`); err.exitCode = 1; throw err; }
        out.skeleton = v;
        break;
      }
      case "--doctor": out.doctor = true; break;
      case "--self-test": out.selfTest = true; break;
      case "--_worker": out.worker = next(); break;
      case "-h":
      case "--help": out.help = true; break;
      default: {
        const err = new Error(`未知参数 ${a}(看 --help)`);
        err.exitCode = 1;
        throw err;
      }
    }
  }
  return out;
}

/** slug 缺省 = 任务文件 basename 去扩展名,非法字符归一为 `-`。 */
/** 没传 --model 时,codex 用配置目录下 `config.toml` **顶层**的 `model`。读出来**只作标签**写进台账(`modelLabel`)
 *  与结果件头部,别再写成含糊的「(codex 默认)」(2026-10-10 用户问「codex 现在的模型是什么?」才发现头部看不出型号)。
 *  ⚠️ 红队 a2155edb 附节二①:首版把它塞进 `job.model`,worker 因此**每次都显式传 -m**,改变了 --resume 线程与
 *   profile 的选模行为——标签与传参必须分开,`job.model` 只放用户显式给的 `--model`。
 *  只读**顶层**(第一个 `[section]` 之前;首版的 `^model` 会抓到 `[profiles.x]` 下的 model);配置目录认 `CODEX_HOME`
 *  (codex 的约定),没设才用 `~/.codex`。读不到 ⇒ null,头部退回「(codex 默认)」。
 *  天花板:不解析 profile 选择、不认 `-c model=…` 覆盖——标签说的是「配置顶层默认」,不是「这次实际用的」。 */
export function codexDefaultModel(opts = {}) {
  const o = typeof opts === "string" ? { home: opts } : opts || {};
  const env = o.env || process.env;
  const dir = o.codexHome || env.CODEX_HOME || path.join(o.home || os.homedir(), ".codex");
  try {
    const text = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;                                        // 第一个表头之后不再是顶层
      const m = /^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
      if (m) return (m[1] ?? m[2]) || null;
    }
    return null;
  } catch { return null; }
}

/** 结果件头部(worker 写 R 用;收尾闸自测拿它拼夹具,核正文起始行与 `CODEX_BODY_FIRST_LINE` 一致)。
 *  形态:`---` + 6 行 + `---`,以换行收尾,正文**紧接其后**(第 9 行起,没有空行)。改行数要两边一起改。 */
export function resultHeader(job, threadId) {
  const model = job.model
    || (job.modelLabel ? `(codex 默认;config 顶层 model=${job.modelLabel},--resume/profile 下实际可能不同)` : "(codex 默认)");
  return [
    "---",
    `codex 版本: ${job.codexVersion}`,
    `模型: ${model}`,
    // 批 285 D141:「写被 OS 拒」在本机已被 10-09 实例推翻,头部别再替沙箱打包票(行数不变,收尾闸按第 9 行认正文)
    `sandbox: ${job.sandbox || "read-only"}(${job.sandbox === "workspace-write" ? "用户点名放开,可写" : "缺省;本机实测未必拦得住写入(D141)"})`,
    "network: on(codex 自带通道;2026-08-09 实测 read-only 下四客户端全 200)",
    `repo_brief: ${job.repoBrief || "(none)"}`,
    `复看: codex resume ${threadId || "(未取到 thread-id)"}`,
    // 批 305:只有 --no-taskbook-check 发起的才多这一行(缺省头部仍是 8 行;收尾闸优先按第二个 `---` 定位正文,
    //   它的「第 9 行」常量只在第 1 行没读到时兜底——跳过检查的结果件正文从第 10 行起)
    ...(job.taskbookCheck === "skipped" ? ["任务书检查:跳过(--no-taskbook-check)"] : []),
    "---",
    "",
  ].join("\n");
}

// ── 批 305:发车前查任务书 / 出骨架 ───────────────────────────────────────
// 病史:任务书只写「找问题」、把漏报的代价写得很重,又没写这次审查拿去干什么、什么算完成 ⇒ 审查者越审越多
//   (同一份稿子审五轮,第五轮报 27 条,事后逐条看 0 条要改);结论选项里没有「不用再审」⇒ 审查者不会说停。
//   改进办法写在备忘里到不了发车的人眼前——发车的人每次都是直接调本脚本,所以检查接在这里(必经点)。
// 只看任务书的**形**(有没有这几段、有多长),不判内容好坏。拿不准偏松:宁可放过一份写得一般的,不拦一份写得对的
//   (拦错了,发车的人要么干不了活,要么学会加 --no-taskbook-check,那就等于没有检查)。
// 天花板:d 的「编号问题」只数**行首带编号且带疑问标记**的行;带编号的祈使句(「1. 核对 X。」)不计,只受行数上限约束。
export const TASKBOOK_CHECK_EXIT = 4;      // 任务书检查不过、没发车(0 成 / 1 出错 / 2 越权旗标 / 3 --wait-ms 到期仍在跑)
export const TASKBOOK_MAX_QUESTIONS = 5;
// 25 的由来(批 305):按新写法写的三份设计类任务书是 14 / 17 / 18 行有内容的行(连空行 22–27 行);
//   越审越多的那几份是 31 / 32 / 37 / 42 行。25 两头都留了余量。
export const TASKBOOK_MAX_LINES = 25;
export const SKELETON_KINDS = ["design", "fact"];
/** 四条要求的原文(检查不过时逐字打出)。 */
export const TASKBOOK_REQUIREMENTS = [
  "a. 写了用途:有以「用途」开头的一段或一行,说明这次审查的结果拿去干什么(英文 Purpose)。",
  "b. 写了完成标准:有以「完成标准」开头的一段(英文 Done when / Completion criteria)。",
  "c. 结论选项里有「不用再审」:全文出现这四个字(英文 no further review needed)。",
  `d. 审设计类的任务书不过长:带编号的问题(行首 1.、2.、(a) 这类,列给审查者回答的)不超过 ${TASKBOOK_MAX_QUESTIONS} 个,` +
    `且有内容的行(不算空行)不超过 ${TASKBOOK_MAX_LINES} 行。核事实类(比副本、核引文、核读数)加 --fact-check 免这一条。`,
];
// 段首:允许 Markdown 前缀(标题 # / 引用 > / 列表 - * + / 加粗 ** __)和一个序号
// 批 305(codex r1 第 2 条):原写法 `^[\s>#*_+\-]*(?:…)?[*_]*` 两段星号量词重叠,长串 `*` 平方级回溯;
//   收尾那段 `[*_]*` 只放在序号之后,前后两段不再能匹配同一个字符。
const TB_LEAD = String.raw`^[\s>#*_+\-]*(?:\d{1,2}[.、)]\s*[*_]*)?`;
const TB_PURPOSE_RE = new RegExp(TB_LEAD + String.raw`(?:用途|purpose\b)`, "i");
const TB_DONE_RE = new RegExp(TB_LEAD + String.raw`(?:完成标准|done[\s-]+when\b|completion\s+criteri(?:a|on)\b)`, "i");
const TB_NO_MORE_RE = /不用再审|no\s+further\s+review\s+(?:is\s+)?needed/i;
// 批 305(codex r1 第 3 条):全角符号一律写转义——源码里的全角字符曾被写成半角,`[??]` 漏认中文问号
const TB_NUMBERED_RE = /^\s*(?:[-*+]\s+)?[*_]*(?:\d{1,2}(?:[.)．）]\s?|、)|[(（][0-9A-Za-z]{1,2}[)）]|[A-Za-z][.)]\s)/;
const TB_QUESTION_RE = /[?？]|是否|有没有|能否|会不会|对不对|吗|\bwhether\b/i;

/** 判一份任务书(纯函数)。返回 { ok, items:[{key,name,ok,exempt,detail,fix}], lines, questions:[行号] }。
 *  detail / fix 里只出现行号与计数,不回显任务书内容(本壳的凭据纪律:不回显任务文件)。 */
export function checkTaskbook(text, { factCheck = false } = {}) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const at = (re) => { const k = lines.findIndex((l) => re.test(l)); return k < 0 ? 0 : k + 1; };
  const a = at(TB_PURPOSE_RE), b = at(TB_DONE_RE), c = at(TB_NO_MORE_RE);
  const content = lines.filter((l) => l.trim()).length;
  const questions = [];
  lines.forEach((l, k) => { if (TB_NUMBERED_RE.test(l) && TB_QUESTION_RE.test(l)) questions.push(k + 1); });
  const tooMany = questions.length > TASKBOOK_MAX_QUESTIONS, tooLong = content > TASKBOOK_MAX_LINES;
  const dParts = [
    `编号问题 ${questions.length} 个(上限 ${TASKBOOK_MAX_QUESTIONS}${tooMany ? `;计入的是第 ${questions.join("、")} 行` : ""})`,
    `有内容的行 ${content} 行(上限 ${TASKBOOK_MAX_LINES})`,
  ];
  const items = [
    { key: "a", name: "用途", ok: !!a, detail: a ? `第 ${a} 行` : "没有以「用途」开头的一段",
      fix: "加一行「用途:<这次审查的结果拿去干什么>」" },
    { key: "b", name: "完成标准", ok: !!b, detail: b ? `第 ${b} 行` : "没有以「完成标准」开头的一段",
      fix: "加一行「完成标准:<一句可判真假的话>」(只在句子中间提到不算)" },
    { key: "c", name: "不用再审", ok: !!c, detail: c ? `第 ${c} 行` : "全文没有「不用再审」",
      fix: "结论选项里加一档,例:最后一行三选一:`可以用,不用再审` / `有会翻转的,要改` / `判不了`" },
    { key: "d", name: "不过长", ok: factCheck || (!tooMany && !tooLong), exempt: factCheck,
      detail: (factCheck ? "豁免(--fact-check);" : "") + dParts.join(";"),
      fix: [tooMany ? `把编号问题收到 ${TASKBOOK_MAX_QUESTIONS} 个以内(改成一个是非题「完成标准成立吗?」;不是问题的清单把行里的疑问词去掉或不编号)` : "",
        tooLong ? `压到 ${TASKBOOK_MAX_LINES} 行有内容的行以内` : "",
        "若这是核事实类(比副本、核引文、核读数),发车时加 --fact-check"].filter(Boolean).join(";") },
  ];
  return { ok: items.every((i) => i.ok), items, lines: content, questions };
}

/** 逐条判定表(--check-taskbook 打到 stdout;发车被拦时进 stderr)。 */
export function formatTaskbookReport(res, { file = "", factCheck = false } = {}) {
  const out = [`任务书检查:${file || "(未给文件名)"}(${factCheck ? "按核事实类判,--fact-check" : "按审设计类判"})`];
  for (const i of res.items) out.push(`  ${i.key} ${i.name}:${i.ok ? "过" : "不过"}(${i.detail})`);
  out.push(`结论:${res.ok ? "过" : "不过"}`);
  return out.join("\n") + "\n";
}

/** 不过时的说明:缺哪条、怎么补、四条要求原文、骨架命令。**不提跳过旗标**——报错里递绕过办法,检查就等于没有。 */
export function taskbookFailText(res) {
  const out = [];
  for (const i of res.items) if (!i.ok) out.push(`  缺 ${i.key} ${i.name}:${i.detail}。补法:${i.fix}。`);
  out.push("任务书的四条要求:");
  for (const r of TASKBOOK_REQUIREMENTS) out.push(`  ${r}`);
  out.push("现成骨架:node scripts/codex-run.mjs --skeleton design(核事实类:--skeleton fact,发车时加 --fact-check)");
  out.push("只判不发:node scripts/codex-run.mjs --check-taskbook <文件> [--fact-check]");
  return out.join("\n") + "\n";
}

/** 这次调用查不查任务书:`--resume` 续跑不查(任务文件是追问,不是任务书);`--no-taskbook-check` 整体豁免。 */
export function taskbookMode(opts) {
  if (opts.resume) return "resume";
  if (opts.noTaskbookCheck) return "skipped";
  return "check";
}

/** 任务书骨架(`--skeleton [design|fact]`)。尖括号处由发车的人填;其余句子稳定逐字,自测钉住「骨架自己能过检查」。 */
export function taskbookSkeleton(kind = "design") {
  const fact = kind === "fact";
  return [
    fact ? "# 核事实:<核什么>(只读;禁止写任何文件,结果只作为你的最终回复)"
      : "# 审<什么>:<一句话说清对象与范围>(只读;禁止写任何文件,结果只作为你的最终回复)",
    "",
    "用途:<这次审查的结果拿去干什么——合并 / 发布 / 给人看 / 当后续工作的依据;之后谁会照着它做>",
    "",
    fact ? "完成标准:**<一句可判真假的话,例:文档里写的事实和各自的出处一致 / 副本和原件除下列差异外逐行相同>**"
      : "完成标准:**<一句可判真假的话:什么成立,这件东西就算可以用>**",
    "",
    fact ? "请直接比对 <被核文件> 与 <出处>,先回答一个是非题:**完成标准成立吗?**"
      : "请读 <文件 / 提交 / diff 范围>,先回答一个是非题:**完成标准成立吗?**",
    "",
    fact ? "- 成立:一句话说你怎么验的(核了哪几项)。" : "- 成立:一句话说你怎么验的。",
    fact ? "- 不成立:列出会让答案翻转的发现,**至多 5 条**,每条给文件与行、写的是什么、出处实际是什么。"
      : "- 不成立:列出会让答案翻转的发现,**至多 5 条**,每条给文件、行号、一个最小的反例或复现。",
    "",
    fact ? "只收会翻转答案的。只核事实,不审内容;措辞、结构、还能补充什么都不算,不要报。取不到的出处写「取页失败」,不要拿记忆顶替。"
      : "只收会翻转答案的。「可以做得更好」类的建议不算发现,不要报。下面这些我已经知道,不用报:",
    ...(fact ? [] : ["- <已知的局限或有意的取舍;没有就连上一句的后半句一起删掉>"]),
    "",
    fact ? "两类错的代价:漏掉一处<写错的事实>,<后果:谁会照着错的做>;多报一条其实对得上的,<我要花的核对成本>。拿不准的报出来,并写明拿不准在哪。"
      : "两类错的代价:漏掉一处<真会出事的是什么>,<后果>;多报一条不成立的,<我要花的核对成本>。拿不准的报出来,并写明拿不准在哪。",
    "",
    fact ? "最后一行三选一:`事实对得上,不用再审` / `有对不上的,要改` / `核不了`。"
      : "最后一行三选一:`可以用,不用再审` / `有会翻转的,要改` / `判不了`。",
    "",
  ].join("\n");
}

export function deriveSlug(taskPath, explicit) {
  const raw = explicit || path.basename(taskPath || "task", path.extname(taskPath || ""));
  const s = String(raw).trim().replace(/[^\w一-龥.-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "task";
}

/**
 * 落点:<cwd>/clipboard/codex/<slug>-r<n>.md,n 按同名文件自动递增。
 * clipboard/ 不在场则**不创建**,退回系统临时目录(路径由调用方打印到 stdout)。
 */
/** 发起占位行。收尾闸按同一个正则认它(Read 到占位永不算读回),改措辞要两边一起改。 */
export const placeholderText = (id) => `(codex-run 作业 ${id || "?"} 运行中,结果未产出——占位)\n`;
export const PLACEHOLDER_RE = /^\(codex-run 作业 \S+ 运行中,结果未产出——占位\)\s*$/;
export const isPlaceholder = (s) => PLACEHOLDER_RE.test(String(s));

export function resolveResultPath({ cwd, slug, explicitOut, id }) {
  if (explicitOut) return { file: path.resolve(cwd, explicitOut), fellBack: false };
  const clipboard = path.join(cwd, "clipboard");
  const dir = fs.existsSync(clipboard)
    ? path.join(clipboard, "codex")
    : path.join(os.tmpdir(), "codex-run-out");
  const fellBack = !fs.existsSync(clipboard);
  fs.mkdirSync(dir, { recursive: true });
  // 发起时就用 `wx` 占住 r<n>(批 257 v6,红队 BP-2/9):原先 R 到 done 才写盘,同 slug 并发发起会拿到同一个 n,
  //   后完成的覆盖先完成的。占位行在 done / failed 时被整件覆盖。
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${slug}-r${n}.md`);
    try { fs.writeFileSync(file, placeholderText(id), { encoding: "utf8", flag: "wx" }); }
    catch (e) { if (e && e.code === "EEXIST") continue; throw e; }
    return { file, fellBack };
  }
}

/** 仓库简报三级探测:取第一个在场者,只回**指针**不注全文(复盘 3.6)。 */
export function resolveRepoBrief(cwd) {
  for (const rel of REPO_BRIEF_CANDIDATES) {
    if (fs.existsSync(path.join(cwd, rel))) return rel;
  }
  return null;
}

/** 从 JSONL 事件流里捞 thread id(键名随版本漂移,故三名都认)。 */
export function extractThreadId(jsonlText) {
  const m = /"(?:thread_id|session_id|conversation_id)"\s*:\s*"([^"]+)"/.exec(jsonlText || "");
  return m ? m[1] : null;
}

/** 组装 codex exec 的参数向量。沙箱缺省 read-only,只有显式 --sandbox workspace-write 才放开。 */
export function buildCodexArgs({ cwdForCodex, model, effort, resume, lastMsgFile, sandbox }) {
  const args = ["exec"];
  if (resume) args.push("resume", resume);
  args.push("-s", sandbox === "workspace-write" ? "workspace-write" : "read-only");
  args.push("-C", cwdForCodex);
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push("--json", "-o", lastMsgFile, "-");
  return args;
}

/**
 * 作业收尾判定(批 257)。判的是**拼头之前的原始最终消息** `body`,不重新拆 Markdown 头尾。
 *   · `body.trim()` 为空(空串 / 纯空白 / 仅 BOM)⇒ failed + errorCode=empty-body,不论退出码;
 *     「只回一句『无发现』」不空,照常 done——不按字数、行数或「像不像报告」判空。
 *   · **现存分支照旧**:退出码非 0 但正文非空 ⇒ done(exitCode 记进台账,不在本批改)。
 *     这条与空正文是两件事,别被空正文的修正掩盖(D141 复核「3」)。
 */
export function classifyOutcome({ code, body }) {
  if (!String(body ?? "").trim()) {
    return {
      state: "failed",
      errorCode: "empty-body",
      error: code !== 0 ? `codex 退出码 ${code} 且无最终消息` : "codex 退出码 0 但最终消息为空",
    };
  }
  return { state: "done" };
}

/**
 * 机器可读返回块。**所有返回都以 `CODEX_JOB=<id>` 开头**(批 257):前台立即 done / failed、
 * 转后台、--poll 三种形态同一口径,收尾闸据此把作业进账、把 poll 归属到 J。
 *   kind = "launch"(前台结束或转后台)| "poll"
 */
/** `--poll J --wait-ms N`(批 257 v4):每秒读一次台账,到终态或超时(上限 10 分钟)为止,返回最后读到的台账。
 *  读不到台账(null)立即返回——缺失不是「还在跑」。纯函数,读与睡注入,自测直接调。 */
export const POLL_WAIT_CAP_MS = 10 * 60 * 1000;
export async function waitForTerminal({ read, waitMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const deadline = now() + Math.max(0, Math.min(Number(waitMs) || 0, POLL_WAIT_CAP_MS));
  for (;;) {
    const job = read();
    if (!job || job.state !== "running" || now() >= deadline) return job;
    await sleep(1000);
  }
}

/** 批 285 D131②:codex 的 hooks 配置解析失败时**整份作废**(批 240 实撞:一个多余顶层键让 hook-guard /
 *  hook-remote-check 在 codex 会话里零加载),运行照常、只在日志里留一行 error ⇒ 不读日志就永远看不见。
 *  worker 跑完扫一遍日志,命中就记进台账 `warn`,机器块多一行 `CODEX_WARN=`(收尾闸按键名取字段,多一键不影响解析)。
 *  只提示不阻断:作业本身照常 done / failed。返回提示串或 null(纯函数,自测直接调)。 */
export const HOOKS_PARSE_FAIL_RE = /failed to parse hooks config\s+(\S+?):?\s/i;
export function hooksConfigWarn(logText) {
  const m = HOOKS_PARSE_FAIL_RE.exec(String(logText || ""));
  if (!m) return null;
  return `codex 的 hooks 配置解析失败(${m[1]}):该文件里注册的钩子本次全部未加载,查日志里 failed to parse hooks config 那行`;
}

export function formatJobBlock(job, { kind = "launch", log } = {}) {
  const lines = [`CODEX_JOB=${job.id}`];
  const st = job.state === "running" ? (kind === "launch" ? "background" : "running") : job.state;
  lines.push(`CODEX_STATE=${st}`);
  if (st === "failed") {
    if (job.errorCode) lines.push(`CODEX_ERROR_CODE=${job.errorCode}`);
    lines.push(`CODEX_ERROR=${job.error || "(未记录)"}`);
  }
  if (job.warn) lines.push(`CODEX_WARN=${job.warn}`);
  if (log || job.log) lines.push(`CODEX_LOG=${log || job.log}`);
  if (job.result) lines.push(`CODEX_RESULT=${job.result}`);
  if (st === "background") lines.push(`CODEX_POLL=node scripts/codex-run.mjs --poll ${job.id}`);
  // 机器块末行恒为带 J 的 CODEX_END(批 257 红队 BP-5):发车命令常带 `2>&1 | tail -1/-2`,
  //   原先末行是 CODEX_RESULT / CODEX_POLL,截尾后 J 就丢了,收尾闸只能记成无主作业。
  lines.push(`CODEX_END=${job.id}`);
  return lines.join("\n") + "\n";
}

/** 带 J 的定界块(v5):kind = "BODY"(结果件全文)| "FAIL"(日志尾部)。正文原样,不改写一个字。 */
export function formatDelimited(kind, id, text) {
  const s = String(text ?? "");
  return `CODEX_${kind}_BEGIN=${id}\n${s}${s.endsWith("\n") || !s ? "" : "\n"}CODEX_${kind}_END=${id}\n`;
}

export const POLL_EXPIRED_EXIT = 3;
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

/** 批 305:结果文件名 `<slug>-r<n>.md` 里的轮次 n ≥ 2(同一个 slug 的第二轮及以后)⇒ 一行固定提示;否则空串。
 *  只读代理 `_direction-judge` 专判「不改它,完成标准还成立吗」,原先只靠人想起来才调;取回件是必经点,提示接在这里。
 *  提示行**不以 `CODEX_` 开头**(收尾闸按该前缀解析机器字段),由 `renderOutcome` 放进 `note`、`emit` 写到 **stderr 且先于 stdout**:
 *  stdout 与改前逐字相同,`| tail -1` 与 `2>&1 | tail -1` 的末行都不变。显式 `--out` 的文件名不带 r<n> ⇒ 不提示。 */
export function roundHint(resultPath) {
  const m = /-r(\d+)\.md$/i.exec(String(resultPath || ""));
  const n = m ? Number(m[1]) : 0;
  if (!(n >= 2)) return "";
  return `这是同一份东西的第 ${n} 轮回件:分拣之前先派 \`_direction-judge\`,只给它用户原话、完成标准、现状、回件,不写你的倾向。\n`;
}

/**
 * 一次发起结束 / 一次 --poll 的完整 stdout 与退出码(v5,纯函数,读文件注入)。
 *   done   ⇒ 机器块 + BODY 块(结果件全文)[+ poll 末行 `done <路径>`],0;第 2 轮起另带 `note`(走 stderr);结果件读不到 ⇒ 不打 BODY、err 说明、1
 *   failed ⇒ 机器块 + FAIL 块(日志末 40 行)[+ poll 末行 `failed <原因>`],1
 *   running⇒ 机器块 [+ poll 末行 `running`];waitExpired(--wait-ms 到期)⇒ 3,否则 0
 *   台账缺失(poll)⇒ failed job-missing 机器块 + 末行,1;不打 FAIL 块(没有日志可给)。
 */
export function renderOutcome(job, { kind = "poll", id, log, waitExpired = false, readFile = readText } = {}) {
  const poll = kind === "poll";
  if (!job) {
    return { out: formatJobBlock({ id, state: "failed", errorCode: "job-missing", error: "台账缺失" }, { kind }) +
      `failed job ${id} 台账缺失\n`, code: 1 };
  }
  let out = formatJobBlock(job, { kind, log });
  if (job.state === "running") return { out: out + (poll ? "running\n" : ""), code: waitExpired ? POLL_EXPIRED_EXIT : 0 };
  if (job.state === "done") {
    const body = job.result ? readFile(job.result) : null;
    if (body == null) return { out: out + (poll ? `done ${job.result}\n` : ""), code: 1, err: `结果件读不到:${job.result}` };
    const note = roundHint(job.result);
    return { out: out + formatDelimited("BODY", job.id, body) + (poll ? `done ${job.result}\n` : ""), code: 0, ...(note ? { note } : {}) };
  }
  const lg = log || job.log;
  const raw = lg ? readFile(lg) : null;
  const last = poll ? `failed ${job.error || "(未记录原因)"}\n` : "";
  // 日志读不到 ⇒ 不发 FAIL 块(v6,codex v5 复核第 2 条):FAIL 块在收尾闸那边等于「日志已送达」,不能拿占位说明冒充
  if (raw == null) return { out: out + last, code: 1, err: `日志读不到:${lg || "未记录"}` };
  out += formatDelimited("FAIL", job.id, raw.split(/\r?\n/).slice(-41).join("\n"));
  return { out: out + last, code: 1 };
}

// ── codex 定位 ──────────────────────────────────────────────────────────

/** Windows 上 npm 垫片不可直接 spawn ⇒ 优先找原生 vendor bin(battle.md 步骤 3 括注)。 */
//   批 302(D205 ②):另返回结构化来源 `source` ∈ env / vendor / path,worker 写进作业记录 `binSource`;
//   收尾闸 P 只读这个字段(`binSource=env` 的记录不计),不再看日志头 `# bin=…`。
export function resolveCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return { bin: process.env.CODEX_BIN, shell: false, how: "env CODEX_BIN", source: "env" };
  }
  const roots = [
    path.join(path.dirname(process.execPath), "node_modules", "@openai", "codex"),
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "node_modules", "@openai", "codex")
      : null,
  ].filter(Boolean);
  for (const root of roots) {
    const vendorRoot = path.join(root, "node_modules", "@openai");
    if (!fs.existsSync(vendorRoot)) continue;
    for (const pkg of fs.readdirSync(vendorRoot)) {
      if (!pkg.startsWith("codex-")) continue;
      const vendor = path.join(vendorRoot, pkg, "vendor");
      if (!fs.existsSync(vendor)) continue;
      for (const triple of fs.readdirSync(vendor)) {
        for (const name of ["codex.exe", "codex"]) {
          const cand = path.join(vendor, triple, "bin", name);
          if (fs.existsSync(cand)) return { bin: cand, shell: false, how: "native vendor bin", source: "vendor" };
        }
      }
    }
  }
  return { bin: "codex", shell: true, how: "PATH(shell)", source: "path" };
}

// ── 批 302(D205 ①④):从**完整事件流**写结构化字段 ───────────────────────────────
// 病史(D205 ①):「通道不可用」原由收尾闸从日志**尾窗**里抽失败行再分类,三轮各冒新形态——尾窗切点恰在行首、
//   来源前缀挤占字数预算、stdout 的 item 行写到一半插进 stderr 被标成 stderr。都是「事后从日志拼回结构」的病。
// 现在:worker 自己逐行读子进程的 stdout / stderr(跨 chunk 拼成整行再判),只看
//   ① stdout 里 codex 的**顶层** `error` / `turn.failed` 事件(item 事件——codex 读到的文件内容——一律不看,
//      债表里引用的 429 原文不会冒充失败);② stderr 的完整行(`codex_models_manager` 刷新模型列表的报错不算,成功作业里也常见)。
// 分类(外部工具报错串的分类,不是模型措辞;沿用 ADR 0039 的 UNAVAIL 口径,唯一实现在这里):
//   rate-limit = 429 / rate limit / too many requests;quota = usage limit / quota;network = 网络终态 errno。
//   配置告警(unrecognized configuration / configuration setting)不算;超时不算(任务太大也会超时)。
//   BP-5(Rust 版 codex 的断网报错串对不上 Node errno 名)是词表覆盖问题,不在本层结构里解决。
// 只有作业最终 failed 或退出码非 0 时才写 `unavailable`(中途 429 重试成功的作业不算不可用);否则 null。
export const UNAVAIL_RULES = [
  ["rate-limit", /rate.?limit|too many requests|\b429\b/i],
  ["quota", /usage limit|quota/i],
  ["network", /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo/i],
];
const UNAVAIL_SKIP = /unrecognized configuration|configuration setting/i;
/** 不带原因的传输层失败事件(真因在 stderr)。 */
const GENERIC_TRANSPORT = /^\s*(?:stream error|stream disconnected|error sending request|connection (?:closed|reset|error)|transport error|request failed)\b/i;
/** 一行报错串 ⇒ reason 或 null。 */
export function classifyUnavailable(text) {
  const s = String(text || "");
  if (!s.trim() || UNAVAIL_SKIP.test(s)) return null;
  for (const [reason, re] of UNAVAIL_RULES) if (re.test(s)) return reason;
  return null;
}

/** 子进程输出的逐行扫描器:stdout / stderr 各自缓冲半行,`end()` 冲掉残行。 */
export function makeStreamScanner() {
  const buf = { out: "", err: "" };
  const cands = [];          // { source, text } 不可用候选(顶层错误事件 / stderr 行)
  const nonItem = [];        // hooks 告警的扫描面:stderr 全部行 + stdout 里不是 JSON 事件的行(D205 ④)
  const onLine = (kind, raw) => {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;
    if (kind === "err") {
      if (nonItem.length < 2000) nonItem.push(line);
      if (!/codex_models_manager/.test(line)) cands.push({ source: "stderr", text: line });
      return;
    }
    let o = null;
    if (line.trimStart().startsWith("{")) { try { o = JSON.parse(line); } catch { o = null; } }
    if (!o || typeof o !== "object") { if (nonItem.length < 2000) nonItem.push(line); return; }
    if (o.type === "error" || o.type === "turn.failed") {
      const msg = String(o.message || (o.error && o.error.message) || "");
      cands.push({ source: "event", text: msg });
      if (nonItem.length < 2000) nonItem.push(msg);   // 顶层错误事件不是 item,hooks 解析失败报在这里也要认
    }
  };
  const skip = { out: false, err: false };   // 正在丢一条超长行的剩余部分
  const feed = (kind, chunk) => {
    buf[kind] += String(chunk);
    let k;
    while ((k = buf[kind].indexOf("\n")) >= 0) {
      if (skip[kind]) skip[kind] = false; else onLine(kind, buf[kind].slice(0, k));
      buf[kind] = buf[kind].slice(k + 1);
    }
    // 超长无换行(>4 MB):丢弃这段、不判(批 302 r1 外审第 7 条:不完整的行不能拿来分类),直到下一个换行再接着收,防内存涨
    if (buf[kind].length > 4 * 1024 * 1024) { buf[kind] = ""; skip[kind] = true; }
  };
  return {
    out: (c) => feed("out", c),
    err: (c) => feed("err", c),
    end() { for (const k of ["out", "err"]) { if (buf[k] && !skip[k]) onLine(k, buf[k]); buf[k] = ""; skip[k] = false; } },
    /** 作业失败时才给:第一个命中的候选 ⇒ { reason, source, text≤200 }。
     *  timedOut(worker 的硬截止杀掉了 codex)⇒ 一律 null:超时不算不可用,哪怕更早出现过一次 429 重试(r1 外审第 7 条)。 */
    unavailable(failed, timedOut = false) {
      if (!failed || timedOut) return null;
      // 2026-11-08(红队 p0-close BP-4):codex 自己的顶层错误事件优先——有事件就只看事件,
      //   stderr 里 codex 内部 exec 子命令留下的 ENOTFOUND / 429(与本次失败无关)不再冒充通道不可用;没有事件才看 stderr
      // 2026-11-16(红队 b302 增量 BP-1,误拦):「有个配置项不认识」这类告警事件不算「事件明说了别的原因」——
      //   本机 28 份作业日志里 25 份带它,不剔掉的话下面两条看 stderr 的路都走不到,真断网 / 限流时判不出通道不可用。
      const events = cands.filter((c) => c.source === "event" && !UNAVAIL_SKIP.test(c.text));
      const pick = (list) => { for (const c of list) { const reason = classifyUnavailable(c.text); if (reason) return { reason, source: c.source, text: c.text.slice(0, 200) }; } return null; };
      if (!events.length) return pick(cands);
      const ev = pick(events);
      if (ev) return ev;
      // codex p0-close r2 ③:事件只是泛化的传输层失败(stream error / disconnected / error sending request …)、本身不带原因
      //   ⇒ 真因多半在 stderr(先打网络错、再发泛化 turn.failed),回退看 stderr;事件明说了别的原因(配置错误等)⇒ 仍不看 stderr(BP-4)
      if (events.every((c) => GENERIC_TRANSPORT.test(c.text) || !c.text.trim())) return pick(cands.filter((c) => c.source === "stderr"));
      return null;
    },
    nonItemText: () => nonItem.join("\n") + (nonItem.length ? "\n" : ""),
  };
}

// ── job 台账 ────────────────────────────────────────────────────────────

function jobFile(id) {
  return path.join(JOB_ROOT, `${id}.json`);
}

function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), "utf8"));
  } catch {
    return null;
  }
}

function writeJob(job) {
  fs.mkdirSync(JOB_ROOT, { recursive: true });
  fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2), "utf8");
}

// ── worker:真正跑 codex 的那一层 ──────────────────────────────────────

async function runWorker(jobId) {
  const job = readJob(jobId);
  if (!job) {
    process.stderr.write(`worker: job ${jobId} 台账缺失\n`);
    process.exit(2);
  }

  const finish = (state, extra = {}) => {
    writeJob({ ...readJob(jobId), ...extra, state, endedAt: new Date().toISOString() });
    process.exit(state === "done" ? 0 : 1);
  };

  try {
    const taskText = fs.readFileSync(job.task, "utf8");
    let stdinPayload = taskText;
    if (job.repoBrief) {
      stdinPayload =
        `前言(仓库熟悉件指针,自行读取,勿等投喂):${job.repoBrief}\n\n` + taskText;
    }

    const lastMsgFile = path.join(JOB_ROOT, `${jobId}.last.txt`);
    const { bin, shell, how, source: binSource } = resolveCodexBin();
    writeJob({ ...readJob(jobId), binSource });   // 批 302(D205 ②):来源进记录,P 只读字段
    const args = buildCodexArgs({
      cwdForCodex: job.cwd,
      model: job.model,
      effort: job.effort,
      resume: job.resume,
      lastMsgFile,
      sandbox: job.sandbox,
    });

    const logStream = fs.createWriteStream(job.log, { flags: "a" });
    logStream.write(`# codex-run worker ${jobId}\n# bin=${how} sandbox=${job.sandbox || "read-only"}\n`);

    const child = spawn(bin, args, {
      cwd: job.cwd,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, // shell:true 会起 cmd.exe,不加这条会闪控制台窗口
    });

    let jsonl = "";
    const scan = makeStreamScanner();   // 批 302(D205 ①④):完整事件流逐行扫,不再事后从日志尾窗拼
    child.stdout.on("data", (d) => {
      jsonl += d.toString();
      scan.out(d.toString());
      logStream.write(d);
    });
    child.stderr.on("data", (d) => {
      scan.err(d.toString());
      logStream.write(d);
    });
    child.stdin.write(stdinPayload);
    child.stdin.end();

    let timedOut = false;   // 批 302:硬截止杀掉 codex ⇒ 不写 unavailable(超时不算通道不可用)
    const heartbeat = setInterval(() => {
      logStream.write(`# heartbeat ${new Date().toISOString()}\n`);
    }, 30 * 1000);

    const deadline = setTimeout(() => {
      timedOut = true;
      logStream.write(`# TIMEOUT ${job.timeoutMs}ms — SIGTERM\n`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, job.timeoutMs);

    const code = await new Promise((resolve) => child.on("close", resolve));
    clearInterval(heartbeat);
    clearTimeout(deadline);
    logStream.end();

    const threadId = extractThreadId(jsonl);
    const body = fs.existsSync(lastMsgFile) ? fs.readFileSync(lastMsgFile, "utf8") : "";

    const header = resultHeader(job, threadId);

    fs.mkdirSync(path.dirname(job.result), { recursive: true });
    // resultAt 记在写 R **之前**(v7,codex v6 第 4 条):闸认「这一刻之后的 Read R」;R 先于 endedAt 落盘,
    //   拿 endedAt 当界会把夹缝里的完整读判掉
    writeJob({ ...readJob(jobId), resultAt: new Date().toISOString() });
    fs.writeFileSync(job.result, header + body, "utf8");
    scan.end();

    const outcome = classifyOutcome({ code, body });
    // 批 285 D131②:hooks 配置解析失败只提示、不改判定;没命中就不写 warn 键(台账形状照旧)
    //   批 302(D205 ④):只扫 stderr 与 stdout 里不是 JSON 事件的行 + 顶层错误事件——item 事件里 codex 读到的
    //   文件原文(例:债表引用的「failed to parse hooks config」)不再触发误报
    const warn = hooksConfigWarn(scan.nonItemText());
    const warnExtra = warn ? { warn } : {};
    const failed = outcome.state === "failed" || code !== 0;
    const structured = { binSource, unavailable: scan.unavailable(failed, timedOut) };
    if (outcome.state === "failed") {
      finish("failed", { threadId, exitCode: code, errorCode: outcome.errorCode, error: outcome.error, ...warnExtra, ...structured });
    }
    finish("done", { threadId, exitCode: code, ...warnExtra, ...structured });
  } catch (e) {
    // 写 R 之前就失败 ⇒ R 还是发起时的占位行:删掉,别在 clipboard 留一份写着「运行中」的残件(v7,红队附二-6)
    try { if (job.result && isPlaceholder(fs.readFileSync(job.result, "utf8"))) fs.rmSync(job.result, { force: true }); } catch { /* 读不到就不动 */ }
    finish("failed", { error: String(e && e.message ? e.message : e) });
  }
}

// ── 父进程 ──────────────────────────────────────────────────────────────

function codexVersion() {
  const { bin, shell } = resolveCodexBin();
  // windowsHide:shell:true 起 cmd.exe;从 detached 链(fp-audit)调进来时不加这条会闪窗口(2026-10-17 用户报)
  const r = spawnSync(bin, ["--version"], { shell, encoding: "utf8", windowsHide: true });
  return (r.stdout || r.stderr || "").trim() || "(未取到)";
}

function doctor(cwd) {
  const { bin, how } = resolveCodexBin();
  const ver = codexVersion();
  const found = ver !== "(未取到)";
  process.stdout.write(`codex 定位: ${found ? "在场" : "缺席"}(${how})\n`);
  process.stdout.write(`codex 版本: ${ver}\n`);
  const { bin: b2, shell } = resolveCodexBin();
  const login = spawnSync(b2, ["login", "status"], { shell, encoding: "utf8", windowsHide: true });
  const loginLine = ((login.stdout || login.stderr || "").trim().split("\n")[0] || "(未取到)");
  process.stdout.write(`认证状态: ${loginLine}\n`);

  // 双源漂移检查(只提示不阻断——阻断会在最忙时挡路)
  const d = copyDrift(SELF, cwd);
  if (d) process.stdout.write(d.same ? "副本一致: 运行权威 == 仓内副本\n" : `WARN ${d.text}\n`);
  void bin;
  return found && !/not logged in|未登录/i.test(loginLine) ? 0 : 1;
}

/** 双源漂移(运行的这支 vs <cwd>/scripts/codex-run.mjs)。不是两支不同文件(就是仓内那支在跑、或仓内没有)⇒ null。
 *  批 285 D141:原来只在 --doctor 里比,用户级副本缺 6a5ea8e 的 windowsHide 很久无人发现 ⇒ 每次发起也比一次,
 *  漂移时在 stdout 打一行 NOTE(不进 CODEX_ 机器块、不改退出码;只提示不阻断——worktree 分支改了本文件
 *  还没合回主干时也会提示,那时不该 --install,提示语写明「合回后」)。 */
export function copyDrift(self, cwd) {
  try {
    const repoCopy = path.join(cwd, "scripts", "codex-run.mjs");
    if (!fs.existsSync(repoCopy) || path.resolve(repoCopy) === path.resolve(self)) return null;
    const h = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
    const a = h(self), b = h(repoCopy);
    return { same: a === b, text: `drift: 运行=${a} 仓内=${b}(仓内版合回主干后跑 node scripts/codex-entry-sync.mjs --install 归一)` };
  } catch { return null; }
}

// 批 257:poll 先打机器块(带 J 的 CODEX_JOB / CODEX_STATE,收尾闸据此把 poll 归属到作业),
// **末行保持旧口径**(`running` / `done <路径>` / `failed <原因>`)——现成的轮询循环写的是
// `--poll "$job" 2>&1 | tail -1` 再 `case "$s" in running)…`(本会话转录实见),机器块放在后面会把它们打断。
// 输出组装在 `renderOutcome`(纯函数,自测直接调)。
function emit(r) {
  // 批 305(codex 305-taskbook r1 第 1 条):第二轮提示走 stderr 且**先于** stdout 写——
  //   这样 stdout 与改前逐字相同,`2>&1 | tail -1` 合流时末行也还是原来那一行。
  if (r.note) process.stderr.write(r.note);
  process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err + "\n");
  process.exit(r.code);
}

const HELP = `codex-run.mjs — /codex 通用入口薄壳(沙箱缺省 read-only;--sandbox workspace-write 需用户点名)

  node scripts/codex-run.mjs --task <文件> [选项]

  --slug/--out/--cwd     结果件命名与落点(缺省 <cwd>/clipboard/codex/<slug>-r<n>.md)
  --model/--effort       透传 codex
  --timeout-ms <n>       硬截止,缺省 900000
  --wait-ms <n>          前台等待上限,缺省 120000;超期转后台并打印交接块。
                         与 --poll 同用:等到终态或超时再报(上限 600000);到期仍 running ⇒ 退出码 3
  --with-repo-brief      附仓库简报**指针**(不注全文)
  --resume <thread>      续跑(不查任务书)
  --poll <job-id>        幂等只读查询:先 CODEX_JOB/CODEX_STATE 机器块,done 时结果件全文夹在
                         CODEX_BODY_BEGIN/END=<id> 之间、failed 时日志尾部夹在 CODEX_FAIL_BEGIN/END=<id> 之间,
                         末行 running / done <路径> / failed <原因>(前台立即结束的发起同样带 BODY / FAIL 块)。
                         结果文件是 <slug>-r<n>.md 且 n ≥ 2 时,done 的 BODY 块之后多一行提示:先派 _direction-judge
  --doctor               只探不发:PATH / 认证 / 版本 / 副本漂移
  --self-test            全离线自测(含反向用例)

  发车前查任务书(只看形,不判内容;不过 ⇒ 不发车,退出码 ${TASKBOOK_CHECK_EXIT},stderr 写明缺哪条):
${TASKBOOK_REQUIREMENTS.map((r) => "    " + r).join("\n")}
  --skeleton [design|fact]   只打印一份任务书骨架(缺省 design),不发车
  --check-taskbook <文件>    只判不发:逐条打印过没过(可叠 --fact-check);不过 ⇒ 退出码 ${TASKBOOK_CHECK_EXIT}
  --fact-check               核事实类任务(比副本、核引文、核读数):免 d,a、b、c 照查
  --no-taskbook-check        整体跳过(给脚本生成的任务书用);结果件头部会记一行「任务书检查:跳过」

  沙箱缺省 read-only:codex 可读仓库、可联网;本机实测 read-only 未必拦得住写入(D141),要禁写就在任务书里写明;
  --sandbox workspace-write 放开写(只在用户点名时用)。
  见到 CODEX_STATE=background 就 --poll 轮询,绝不重新 --task 发一次。
`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(String(e.message) + "\n");
    process.exit(e.exitCode || 1);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (opts.worker) return runWorker(opts.worker);
  // 批 305:出骨架——只打印,不发车
  if (opts.skeleton) {
    process.stdout.write(taskbookSkeleton(opts.skeleton));
    process.exit(0);
  }

  const cwd = path.resolve(opts.cwd || process.cwd());
  // 批 305:只判不发——逐条打印过没过;不过 ⇒ 退出 4(与发车被拦同码)
  if (opts.checkTaskbook) {
    const file = path.resolve(cwd, opts.checkTaskbook);
    if (!fs.existsSync(file)) {
      process.stderr.write(`任务文件不存在:${opts.checkTaskbook}\n`);
      process.exit(1);
    }
    const res = checkTaskbook(fs.readFileSync(file, "utf8"), { factCheck: !!opts.factCheck });
    process.stdout.write(formatTaskbookReport(res, { file: path.basename(file), factCheck: !!opts.factCheck }));
    if (!res.ok) process.stderr.write(taskbookFailText(res));
    process.exit(res.ok ? 0 : TASKBOOK_CHECK_EXIT);
  }

  if (opts.selfTest) {
    const { runSelfTest } = await import("./codex-run.selftest.mjs");
    process.exit(await runSelfTest({ self: SELF }));
  }
  if (opts.doctor) process.exit(doctor(cwd));
  if (opts.poll) {
    const job = opts.waitGiven ? await waitForTerminal({ read: () => readJob(opts.poll), waitMs: opts.waitMs }) : readJob(opts.poll);
    emit(renderOutcome(job, { kind: "poll", id: opts.poll, waitExpired: !!(opts.waitGiven && job && job.state === "running") }));
  }

  if (!opts.task) {
    process.stderr.write("缺 --task <文件>(看 --help)\n");
    process.exit(1);
  }
  const taskPath = path.resolve(cwd, opts.task);
  if (!fs.existsSync(taskPath)) {
    process.stderr.write(`任务文件不存在:${opts.task}\n`);
    process.exit(1);
  }

  // 批 305:发车前查任务书。必须在取号、占结果件槽位、起 worker **之前**——不过就什么都不留下。
  const tbMode = taskbookMode(opts);
  if (tbMode === "check") {
    const res = checkTaskbook(fs.readFileSync(taskPath, "utf8"), { factCheck: !!opts.factCheck });
    if (!res.ok) {
      process.stderr.write(`任务书检查不过,没有发车(退出码 ${TASKBOOK_CHECK_EXIT}):${path.basename(taskPath)}\n` + taskbookFailText(res));
      process.exit(TASKBOOK_CHECK_EXIT);
    }
  }

  const slug = deriveSlug(taskPath, opts.slug);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const { file: result, fellBack } = resolveResultPath({ cwd, slug, explicitOut: opts.out, id });
  const repoBrief = opts.withRepoBrief ? resolveRepoBrief(cwd) : null;

  fs.mkdirSync(JOB_ROOT, { recursive: true });
  const log = path.join(JOB_ROOT, `${id}.log`);
  writeJob({
    id, state: "running", startedAt: new Date().toISOString(),
    task: taskPath, cwd, slug, result, log, repoBrief,
    // job.model 只放用户显式给的 --model(worker 据它传 -m);默认模型另存 modelLabel 只作标签(a2155edb 附节二①)
    model: opts.model || null, modelLabel: opts.model ? null : codexDefaultModel(),
    effort: opts.effort, resume: opts.resume, sandbox: opts.sandbox || "read-only",
    timeoutMs: opts.timeoutMs, codexVersion: codexVersion(),
    // 批 305:只有 --no-taskbook-check 才多这一键(worker 据它在结果件头部记「任务书检查:跳过」);其余发起记录形状照旧
    ...(tbMode === "skipped" ? { taskbookCheck: "skipped" } : {}),
  });

  // worker 起成 detached:父进程退出不带走它,这样「转后台」才真的成立。
  const worker = spawn(process.execPath, [SELF, "--_worker", id], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    // Windows 上 detached 走 CREATE_NEW_CONSOLE ⇒ 会弹出一个控制台窗口,
    // 且 worker 要活到 codex 跑完(可达 15 分钟),那个窗口就一直杵在屏幕上。
    // windowsHide 让 libuv 带上 UV_PROCESS_WINDOWS_HIDE_CONSOLE,窗口不再出现;
    // 进程本身照旧 detached、照旧不被父进程带走。
    windowsHide: true,
  });
  worker.unref();

  if (fellBack) {
    process.stdout.write(`NOTE clipboard/ 不在场,结果件退回临时目录:${result}\n`);
  }
  // 批 285 D141:每次发起比一次双源(见 copyDrift);只打 NOTE,不进机器块
  const drift = copyDrift(SELF, cwd);
  if (drift && !drift.same) process.stdout.write(`NOTE ${drift.text}\n`);

  // 前台等 --wait-ms,轮询 job 台账(worker 已 detached,轮询是唯一的观察面)。
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    const job = readJob(id);
    // 前台立即结束也打印 CODEX_JOB(批 257):否则快速 done/failed 的作业进不了收尾闸的账;v5 另带 BODY / FAIL 块。
    if (job && job.state !== "running") emit(renderOutcome(job, { kind: "launch", log }));
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 超期 ⇒ 不杀进程,打印固定交接块后自身退出 0。
  process.stdout.write(formatJobBlock({ id, state: "running", result }, { kind: "launch", log }));
  process.exit(0);
}

if (path.resolve(process.argv[1] || "") === path.resolve(SELF)) {
  main();
}
