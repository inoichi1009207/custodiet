// 载体编号原子分配(023 批,决策载体 clipboard/prompts/023-prompt-id-atomic-alloc.md)。
//
// 存在理由:`/kplan` 与 `/tplan` 的步骤 1 是「列目录取最大三位号 +1,然后创建文件」——
// **扫描与创建之间没有互斥**。2026-07-31 实撞:两个并行会话各自扫到最大 020,
// 同时取到 `021`,事后由用户裁决其中一批让号为 `022`。并行会话下这不是偶发,是必然可重现。
//
// ── 契约(不变量,改实现不得改这几条)──
//
//   输入:目标目录 dir、slug、扩展名 ext(默认 `.md`)。
//   输出:{ id: "024", num: 24, path: "<dir>/024-<slug>.md", attempts: n }。
//         path 指向一个**已创建的 0 字节文件**;正文由调用方写(见「只分配不写正文」)。
//
//   I1 原子性 —— 同一号段在任意并发下**至多被一个申请者拿到**。
//   I2 零重号 —— 两个申请者永不拿到同一号。
//   I3 零跳号 —— 一串**成功**的分配在号段上连续,不留空洞。
//   I4 EEXIST 递增重试 —— 号被占则 +1 重试;重试有上限,超限**抛错**,绝不静默返回。
//   I5 audit 件不参与取号 —— 与 `.claude/commands/kplan.md` 步骤 1 同口径。
//   I6 失败不留半占用 —— 任何异常路径都不得留下「占了号没建文件」或「建了文件没占号」。
//
// ── 独占的键**只由号段决定**(本模块的核心,最容易做错的一点)──
//
//   用 O_EXCL 去创建 `024-slug-a.md` **挡不住**另一进程同刻创建 `024-slug-b.md`:
//   文件名不同,两个 O_EXCL 各自都会成功,**重号照旧发生**。
//   ⇒ 互斥体的名字里**不许出现 slug / 扩展名**,只许出现号。
//
// ── 执行面:算法与操作序(住工装头注,不住 AGENTS.md)──
//
//   claimPath(n) = <dir>/.<NNN>.alloc-claim      ← 名字只含号,这就是每个号的互斥体
//
//   1. n = scanMaxNum(dir) + 1                    (只扫一次,之后靠 ++ 推进)
//   2. openSync(claimPath(n), "wx")               EEXIST ⇒ n++,回 2(I1/I4)
//   3. 持 claim 后复查:dir 里已存在 `NNN-*`(非 audit)吗?
//        存在 ⇒ 有人绕过本模块直接建了载体 ⇒ 删 claim,n++,回 2
//   4. linkSync(claim → target);unlinkSync(claim)  ← 把 claim 转成正式载体
//        (linkSync 遇 target 已存在会 EEXIST 而**不覆盖**;不支持硬链接的卷退回
//         renameSync,仅在 EPERM/ENOSYS/EXDEV 等「不支持」错上退,EEXIST **绝不**退——
//         renameSync 在 POSIX 上会静默覆盖同名文件)
//   5. 返回 n
//
//   为什么第 3 步不可省:另一进程可能在**我扫 max 之后、我 claim 之前**已经走完全程。
//   它走完时 claim 已被它自己 unlink,我的第 2 步不会 EEXIST。挡它的是第 3 步看见的载体文件。
//   反过来,「claimPath(n) 存在」与「NNN-*.md 存在」这两件事从某个申请者 claim 成功那刻起
//   **至少恒有一件为真**(第 4 步先 link 后 unlink,两者短暂并存,不留空窗),
//   于是号一旦被摸到就再也回不到「无人占用」态 —— I1/I2 由此成立。
//
// ── 号段占用的扫描口径 ──
//
//   kplan 步骤 1 的字面是「现存 `NNN-*.md`」。本模块扫的是 `NNN-*`(**不限扩展名**),
//   仅排除 audit 件。**这是刻意放宽,不是笔误**:`clipboard/prompts/` 里还住着
//   `NNN-exec.log` / `NNN-exec.err.log`(tplan 无头执行的心跳日志)。只扫 `.md` 时,
//   一个只剩 exec.log 的号会被判为空闲而被重新发放,新批的心跳日志将写进旧批的文件。
//   放宽只会让号**更保守地被保留**,永不导致复用,故与 S5「不改取号语义」不冲突。
//   2026-07-31 现场核验:两种口径在 `clipboard/prompts/` 上给出**同一个** max(023)。
//
// ── 只分配不写正文 ──
//
//   本模块创建的载体是 0 字节占位,正文由调用方写。分配与内容生成解耦,自测才能
//   在不产生真实载体的前提下压测号段。
//
// ── 用法 ──
//
//   import { allocatePromptId, peekNextId } from "./lib/alloc-prompt-id.mjs";
//
//   node --no-warnings scripts/lib/alloc-prompt-id.mjs --peek [--dir clipboard/prompts]
//        → 只读打印「下一个号」,**不创建任何文件**
//   node --no-warnings scripts/lib/alloc-prompt-id.mjs --dir <d> --slug <s> [--ext .md]
//        → 实际分配并创建 0 字节载体,打印 JSON
//
//   并发自测在 scripts/alloc-prompt-id-selftest.mjs(含反向用例)。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_DIR = "clipboard/prompts";
const CARRIER_RE = /^(\d{3})-/;
const AUDIT_RE = /-audit-r/;
const MAX_NUM = 999;

/** 号段占用扫描:返回目录内已占用的最大三位号(空目录返回 0)。audit 件不参与(I5)。 */
export function scanMaxNum(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  let max = 0;
  for (const name of entries) {
    if (AUDIT_RE.test(name)) continue;
    const m = CARRIER_RE.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/** 只读查询:下一个会被发放的号。**不创建任何文件、不落任何 claim**。 */
export function peekNextId(dir = DEFAULT_DIR) {
  const num = scanMaxNum(dir) + 1;
  return { num, id: fmt(num) };
}

function fmt(n) {
  return String(n).padStart(3, "0");
}

function claimPath(dir, n) {
  // 互斥体的名字**只含号**——不含 slug、不含扩展名(见头注)。
  // 点号前缀使其不被 CARRIER_RE 认成载体。
  return path.join(dir, `.${fmt(n)}.alloc-claim`);
}

/** 该号是否已有载体(非 audit)。持 claim 之后复查用。 */
function carrierExists(dir, n) {
  const prefix = `${fmt(n)}-`;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  return entries.some((name) => name.startsWith(prefix) && !AUDIT_RE.test(name));
}

/** claim → 正式载体。不覆盖已存在的 target(见头注第 4 步)。 */
function promoteClaim(from, to) {
  try {
    fs.linkSync(from, to);
  } catch (err) {
    // EEXIST 绝不退回 renameSync —— 那会在 POSIX 上静默覆盖别人的载体。
    if (err.code === "EEXIST") throw err;
    if (["EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "EMLINK"].includes(err.code)) {
      fs.renameSync(from, to); // 不支持硬链接的卷:退回 rename(target 已由复查证明不存在)
      return;
    }
    throw err;
  }
  fs.unlinkSync(from);
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* 清理尽力而为,不掩盖原始错误 */
  }
}

/**
 * 原子分配一个三位号并创建 0 字节载体文件。
 *
 * @param {object} opts
 * @param {string} [opts.dir]        目标目录(默认 clipboard/prompts;不存在则创建)
 * @param {string}  opts.slug        主题 kebab-case
 * @param {string} [opts.ext]        扩展名(默认 ".md")
 * @param {number} [opts.maxRetries] 递增重试上限(默认 1000);超限抛错(I4)
 * @returns {{id:string,num:number,path:string,attempts:number}}
 */
export function allocatePromptId({ dir = DEFAULT_DIR, slug, ext = ".md", maxRetries = 1000 } = {}) {
  if (typeof slug !== "string" || !slug.trim()) {
    throw new Error("allocatePromptId: slug 必填且不得为空");
  }
  if (/[\\/]/.test(slug)) {
    throw new Error(`allocatePromptId: slug 不得含路径分隔符:${slug}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  let n = scanMaxNum(dir) + 1;
  for (let attempts = 1; attempts <= maxRetries; attempts++, n++) {
    if (n > MAX_NUM) {
      throw new Error(`allocatePromptId: 号段耗尽(> ${MAX_NUM}),三位号不变量已到顶,须人工裁决`);
    }
    const claim = claimPath(dir, n);
    let fd;
    try {
      fd = fs.openSync(claim, "wx"); // O_CREAT|O_EXCL —— 每个号唯一的互斥体
    } catch (err) {
      if (err.code === "EEXIST") continue; // 号在被别人处理中(I4)
      throw err;
    }
    try {
      fs.writeSync(fd, `pid=${process.pid} slug=${slug}\n`); // 便于诊断遗留 claim
    } finally {
      fs.closeSync(fd);
    }

    try {
      if (carrierExists(dir, n)) {
        // 有人绕过本模块直接建了该号的载体(或某申请者已走完全程)
        unlinkQuiet(claim);
        continue;
      }
      const target = path.join(dir, `${fmt(n)}-${slug}${ext}`);
      promoteClaim(claim, target);
      return { id: fmt(n), num: n, path: target, attempts };
    } catch (err) {
      unlinkQuiet(claim); // I6:异常路径不留半占用
      throw err;
    }
  }
  throw new Error(
    `allocatePromptId: 递增重试超过上限 ${maxRetries}(dir=${dir});号段异常密集或目录有残留 .NNN.alloc-claim,须人工排查`,
  );
}

// ---------- 复议节拍(036 批;N=10,用户 2026-08-03 亲签)----------
//
// **「上次复议」不落可手改的单值**(r1 次要 3):改个标记就能让提醒永久消失,
// 那等于给自己留了个静音键。改为**指向一份实际的复议产物**。
//
// **且不能只看文件名**(r2 次要 6):本模块取号时会先创建 **0 字节载体**,
// 于是一个失败或弃置的空文件就足以静音提醒 —— 判据必须含**完成状态**。
// 现取:文件非空(>200 字节)且正文出现「复议单」字样。
//
// 从没复议过 ⇒ lastNum=0 ⇒ 一到第 10 批就开始提示。这是对的:一次都没复议过,
// 正是最该被提醒的状态。
const REVIEW_INTERVAL = 10;

export function reviewDue(dir, currentNum) {
  let lastNum = 0;
  let lastLabel = "从未复议";
  try {
    for (const f of fs.readdirSync(dir)) {
      // **`review` 必须是 slug 的首段**,不能只是「文件名里出现 review」——
      // 2026-08-03 实撞:宽判据把方案本身 `036-constraint-standing-review.md` 认成了复议产物,
      // 于是 gap=1、提醒被静音。方案里出现「复议单」三字是家常便饭,内容判据挡不住它,
      // 必须靠**命名约定**把复议产物与谈论复议的方案分开。
      const m = /^(\d{3})-review-.*\.md$/i.exec(f);
      if (!m) continue;
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size <= 200) continue;                       // 0 字节载体 / 空壳:不算完成
      let body = "";
      try { body = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (!body.includes("复议单")) continue;              // 内容判据,不只看文件名
      const n = Number(m[1]);
      if (n > lastNum) { lastNum = n; lastLabel = m[1]; }
    }
  } catch { /* 目录读不到:按「从未复议」办,fail-closed 方向=多提示 */ }
  const gap = currentNum - lastNum;
  return { due: gap >= REVIEW_INTERVAL, gap, lastNum, lastLabel };
}

// ---------- CLI ----------
// Windows 坑:`file://${argv[1]}` 拼不出 import.meta.url(盘符前少一道斜杠),
// 直接入口判定会静默失真 —— CLI 一声不吭地什么都不做。一律走 pathToFileURL。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const dir = flag("--dir", DEFAULT_DIR);
  if (argv.includes("--help") || argv.length === 0) {
    console.log(
      [
        "载体编号原子分配(023 批)",
        "",
        "  --peek [--dir <d>]              只读:打印下一个号,不创建任何文件",
        "  --dir <d> --slug <s> [--ext .md] 分配并创建 0 字节载体,打印 JSON",
        "",
        "并发自测:node --no-warnings scripts/alloc-prompt-id-selftest.mjs",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (argv.includes("--peek")) {
    const { id, num } = peekNextId(dir);
    console.log(`PEEK dir=${dir} max=${fmt(num - 1)} next=${id}`);
    process.exit(0);
  }
  const slug = flag("--slug");
  if (!slug) {
    console.error("缺 --slug(或用 --peek 只读查询)");
    process.exit(2);
  }
  const alloc = allocatePromptId({ dir, slug, ext: flag("--ext", ".md") });
  const due = reviewDue(dir, alloc.num);
  // **stdout 只许有那一行 JSON**:已有调用方直接 `JSON.parse(整个 stdout)`,
  // 追加第二行会打破契约(r1 次要 2)。故 NOTICE 一律走 stderr,
  // 程序化调用方读 JSON 里的 `review_due` 字段。
  console.log(JSON.stringify({ ...alloc, review_due: due.due }));
  if (due.due) {
    console.error(
      `NOTICE 距上次复议已 ${due.gap} 批(上次=${due.lastLabel}),建议本批附「能力补偿型条款复议单」。` +
        `——只提示不阻断(阻断式设计会在最忙时挡路 → 被加 flag 绕过 → 最后没人看,那是 C25 的死法)。`,
    );
  }
}
