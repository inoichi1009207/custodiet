#!/usr/bin/env node
// codex-run.mjs — /codex 通用入口的薄壳(038 批,2026-08-09 用户亲签)。
//
// 定位:直接 spawn `codex exec` 的薄壳,**不经 MCP 桥**——桥无可控超时、长单回复会吊死;
// CLI 子进程可杀、可设截止时间、`--json` 出 JSONL 事件流可当心跳。
// 同理**不复用** cc-suite 锁版 codex-runner.mjs:它住插件缓存的版本号目录下,插件一升级即漂移。
//
// 沙箱缺省 read-only(-C 当前项目根 ⇒ codex **可读仓库、可联网、但写入被 OS 拒**);2026-09-05 用户裁定后
//   `--sandbox workspace-write` 作显式可选项接受(见下方 FORBIDDEN_FLAGS 注释),其余越权旗标照旧拒。守卫装在被调函数内部而非调用处。
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
    `sandbox: ${job.sandbox || "read-only"}(${job.sandbox === "workspace-write" ? "用户点名放开,可写" : "缺省,写被 OS 拒"})`,
    "network: on(codex 自带通道;2026-08-09 实测 read-only 下四客户端全 200)",
    `repo_brief: ${job.repoBrief || "(none)"}`,
    `复看: codex resume ${threadId || "(未取到 thread-id)"}`,
    "---",
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

export function formatJobBlock(job, { kind = "launch", log } = {}) {
  const lines = [`CODEX_JOB=${job.id}`];
  const st = job.state === "running" ? (kind === "launch" ? "background" : "running") : job.state;
  lines.push(`CODEX_STATE=${st}`);
  if (st === "failed") {
    if (job.errorCode) lines.push(`CODEX_ERROR_CODE=${job.errorCode}`);
    lines.push(`CODEX_ERROR=${job.error || "(未记录)"}`);
  }
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

/**
 * 一次发起结束 / 一次 --poll 的完整 stdout 与退出码(v5,纯函数,读文件注入)。
 *   done   ⇒ 机器块 + BODY 块(结果件全文)[+ poll 末行 `done <路径>`],0;结果件读不到 ⇒ 不打 BODY、err 说明、1
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
    return { out: out + formatDelimited("BODY", job.id, body) + (poll ? `done ${job.result}\n` : ""), code: 0 };
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
export function resolveCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return { bin: process.env.CODEX_BIN, shell: false, how: "env CODEX_BIN" };
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
          if (fs.existsSync(cand)) return { bin: cand, shell: false, how: "native vendor bin" };
        }
      }
    }
  }
  return { bin: "codex", shell: true, how: "PATH(shell)" };
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
    const { bin, shell, how } = resolveCodexBin();
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
    child.stdout.on("data", (d) => {
      jsonl += d.toString();
      logStream.write(d);
    });
    child.stderr.on("data", (d) => logStream.write(d));
    child.stdin.write(stdinPayload);
    child.stdin.end();

    const heartbeat = setInterval(() => {
      logStream.write(`# heartbeat ${new Date().toISOString()}\n`);
    }, 30 * 1000);

    const deadline = setTimeout(() => {
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

    const outcome = classifyOutcome({ code, body });
    if (outcome.state === "failed") {
      finish("failed", { threadId, exitCode: code, errorCode: outcome.errorCode, error: outcome.error });
    }
    finish("done", { threadId, exitCode: code });
  } catch (e) {
    // 写 R 之前就失败 ⇒ R 还是发起时的占位行:删掉,别在 clipboard 留一份写着「运行中」的残件(v7,红队附二-6)
    try { if (job.result && isPlaceholder(fs.readFileSync(job.result, "utf8"))) fs.rmSync(job.result, { force: true }); } catch { /* 读不到就不动 */ }
    finish("failed", { error: String(e && e.message ? e.message : e) });
  }
}

// ── 父进程 ──────────────────────────────────────────────────────────────

function codexVersion() {
  const { bin, shell } = resolveCodexBin();
  const r = spawnSync(bin, ["--version"], { shell, encoding: "utf8" });
  return (r.stdout || r.stderr || "").trim() || "(未取到)";
}

function doctor(cwd) {
  const { bin, how } = resolveCodexBin();
  const ver = codexVersion();
  const found = ver !== "(未取到)";
  process.stdout.write(`codex 定位: ${found ? "在场" : "缺席"}(${how})\n`);
  process.stdout.write(`codex 版本: ${ver}\n`);
  const { bin: b2, shell } = resolveCodexBin();
  const login = spawnSync(b2, ["login", "status"], { shell, encoding: "utf8" });
  const loginLine = ((login.stdout || login.stderr || "").trim().split("\n")[0] || "(未取到)");
  process.stdout.write(`认证状态: ${loginLine}\n`);

  // 双源漂移检查(只提示不阻断——阻断会在最忙时挡路)
  const repoCopy = path.join(cwd, "scripts", "codex-run.mjs");
  if (fs.existsSync(repoCopy) && path.resolve(repoCopy) !== path.resolve(SELF)) {
    const h = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
    const a = h(SELF);
    const b = h(repoCopy);
    process.stdout.write(
      a === b ? "副本一致: 运行权威 == 仓内副本\n" : `WARN drift: 运行=${a} 仓内=${b}(跑 codex-entry-sync.mjs --install 归一)\n`,
    );
  }
  void bin;
  return found && !/not logged in|未登录/i.test(loginLine) ? 0 : 1;
}

// 批 257:poll 先打机器块(带 J 的 CODEX_JOB / CODEX_STATE,收尾闸据此把 poll 归属到作业),
// **末行保持旧口径**(`running` / `done <路径>` / `failed <原因>`)——现成的轮询循环写的是
// `--poll "$job" 2>&1 | tail -1` 再 `case "$s" in running)…`(本会话转录实见),机器块放在后面会把它们打断。
// 输出组装在 `renderOutcome`(纯函数,自测直接调)。
function emit(r) {
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
  --resume <thread>      续跑
  --poll <job-id>        幂等只读查询:先 CODEX_JOB/CODEX_STATE 机器块,done 时结果件全文夹在
                         CODEX_BODY_BEGIN/END=<id> 之间、failed 时日志尾部夹在 CODEX_FAIL_BEGIN/END=<id> 之间,
                         末行 running / done <路径> / failed <原因>(前台立即结束的发起同样带 BODY / FAIL 块)
  --doctor               只探不发:PATH / 认证 / 版本 / 副本漂移
  --self-test            全离线自测(含反向用例)

  沙箱缺省 read-only:codex 可读仓库、可联网,但写入被 OS 拒;--sandbox workspace-write 放开写(只在用户点名时用)。
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

  const cwd = path.resolve(opts.cwd || process.cwd());

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
