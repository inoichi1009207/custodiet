// 部署欠账的**事实判据**——收尾闸 DP 项的注入源(2026-09-12 批 202 第四轮红队后改设计)。
//
// 为什么不再解析命令:四轮红队下来,用字符串解析去认「这条 Bash 是不是一次推送」补不完——
//   反斜杠续行、`$'…'`、PowerShell `''` 转义、here-string、嵌套转义引号、进程替换……每修一轮冒一批。
//   先例同向:CC Safety Net 对 shell wrapper 递归展开,guard 类脚本干脆整类拦 wrapper,因为「payload 不可可靠解析」。
//   而推送成功与否本来就有事实记录:git 推送成功后会更新远端跟踪 ref,并在它的 reflog 里记一条 `update by push`
//   (core.logAllRefUpdates 在非裸仓默认开)。用什么 shell 语法推的,对这条记录没有影响。
//
// 两个事实:
//   lastPushTs  = `refs/remotes/<remote>/*` 各 reflog 里最近一条 `update by push` 的 unix 秒(取最大)
//   lastProbeTs = 欠账探针 `scripts/verify-prod.mjs` 每次跑完落的标记 `.claude/.debt-probe-last.json` 里的 ts
//                 (批 285 D134 起落在**共享根**,即主树根——与 reflog 一样各 worktree 共用,见 sharedRoot)
// DP 的判据:lastPushTs 存在且(没有标记,或标记不晚于它——同一秒按没查算)⇒ 推之后没跑过探针。
// ⚠️ **本件是 DP 的补充信号,不是替代**(codex 复核 202-dp-facts-review-r1 判死「替代」版):
//   推 tag、直接推 URL/路径不更新跟踪 ref;reflog 关闭或被 expire 时读取成功但为空,分不清「没推过」与「记录不可用」。
//   所以 DP 取「事实判据 ∪ 命令解析判法」的并集,任一路判出即拦——新判法在构造上不比旧判法松。
//
// 天花板(诚实边界,仅指本件这一路;并集后由命令解析那一路兜):
//   ① 直接推 URL(`git push https://…`)、推 tag 不更新跟踪 ref ⇒ 本路看不见。
//   ② 标记只证「探针**起跑过**」(ts=起跑时刻,由 verify-prod 传入;main 跑完或抛错都落笔),不证跑通、不证欠账已清
//     (与 DP 天花板①同口径);手工伪造标记属蓄意,不防。
//   ④ reflog 条目的时刻可被推送时的 GIT_COMMITTER_DATE / 系统时钟偏差带偏(红队 202 第八轮天花板建议,未实测)。
//   ③ reflog 被 `git reflog expire` 清掉 ⇒ 看不见旧推送(只会少拦,不会多拦)。
// 失效条件:部署改为服务器侧自动完成(生产法三同条)⇒ 本件随 DP 退役。
//
// 用法:
//   node --no-warnings scripts/lib/debt-facts.mjs            # 打印当前事实(JSON)
//   node --no-warnings scripts/lib/debt-facts.mjs --self-test
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PROBE_MARKER = ".claude/.debt-probe-last.json";

const git = (repoRoot, args) =>
  execFileSync("git", args, { windowsHide: true, cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });

/** 最近一次成功推到 <remote> 的时间(unix 秒)与对应 ref;没推过/读不到 ⇒ {ts:null} */
export function lastPush(repoRoot, remote = "private") {
  // ⚠️ 读不到就**抛**(readDebtFacts 归 null ⇒ DP 这一路交白卷、只剩命令解析判法),不能归成「没推过」。
  //   这不是 fail-closed,只是不假装看见(红队 202 第五轮 BP-4 纠正措辞):解析判法看不见的推送形态此时照样漏,见 DP 天花板⑨。
  //   显式关了 reflog(core.logAllRefUpdates 为假)时推送不留痕,同样按「读不到」处理。
  // 布尔值交给 git 自己归一(codex 复核 202-dp-facts-review-r1:字面只认 "false" 时,合法的 `no`/`off`/`0` 漏过)
  let logAll = "";
  try { logAll = git(repoRoot, ["config", "--type=bool", "--get", "core.logAllRefUpdates"]).trim(); } catch { /* 未设 = 非裸仓默认开 */ }
  if (logAll === "false") throw new Error("core.logAllRefUpdates 关闭:推送不留 reflog");
  const refs = git(repoRoot, ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`])
    .split(/\r?\n/).map((s) => s.trim()).filter((r) => r && !r.endsWith("/HEAD"));
  let best = { ts: null, ref: null };
  for (const ref of refs) {
    // 直接按 reflog 主题找最近一条推送,不设条数上限(原「最近 200 条」会漏掉更早的未结清推送,codex 同件)
    const out = git(repoRoot, ["log", "-g", "--grep-reflog=update by push", "-n", "1", "--date=unix", "--format=%gd", ref]).trim();
    const m = /@\{(\d+)\}/.exec(out);
    if (!m) continue;
    const ts = Number(m[1]);
    if (best.ts === null || ts > best.ts) best = { ts, ref: ref.replace(/^refs\/remotes\//, "") };
  }
  return best;
}

// 批 285(D134,误拦):探针标记原按**各工作树自己的根**存,reflog 却是所有工作树共用的 ⇒ worktree 里永远看见「推了没跑探针」,
//   DP 永久阻断(批 246 原型实撞:无头 agent 没有 node 权限跑不了探针,空烧到 max-turns)。改为落在**共享根**
//   (`git rev-parse --git-common-dir` 的父目录,与 session-liveness 的 sharedRootFor 同一取法;本件不 import 它,
//   免得公开树缺判活三件时连带缺件),与 reflog 的作用域一致。取不到 common-dir ⇒ 退回 repoRoot(旧行为)。
//   读时另看一眼本树旧位置的标记、取较晚者:切换前在 worktree 里跑过的探针不因换位置被当成没跑(只会少拦,不会多拦)。
//   代价:任一 worktree 跑过探针,所有 worktree 与主树都算「推后查过」——推送账本来就是共用的,标记同口径。
export function sharedRoot(repoRoot) {
  try {
    const out = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    return out ? path.dirname(path.resolve(repoRoot, out)) : repoRoot;
  } catch { return repoRoot; }
}

const readMarkerAt = (root) => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, PROBE_MARKER), "utf8"));
    return Number.isFinite(+j.ts) ? j : null;
  } catch { return null; }
};

export function readProbeMarker(repoRoot) {
  const shared = readMarkerAt(sharedRoot(repoRoot));
  const local = path.resolve(sharedRoot(repoRoot)) === path.resolve(repoRoot) ? null : readMarkerAt(repoRoot);
  if (!shared) return local;
  if (!local) return shared;
  return +local.ts > +shared.ts ? local : shared;
}

/** 探针跑完调用;调用方应在 info.ts 传**起跑时刻**(不传则取写入时刻)。写失败返回 false,不影响探针退出码。 */
// 批 285 第二轮复核(误拦猎手第 4 份 FB-4):标记落共享根后,多个 worktree 的探针写同一份——先起跑、后跑完的那次(ts=起跑时刻较早)
//   会把别的 worktree 刚写下的较晚标记覆盖回去,「推后查过」随之倒退,DP 误拦。现写入取较大值:已有标记的 ts 更晚 ⇒ 保留旧的不写。
//   代价:较早那次探针的 fail / unknown 信息不落盘(它本就早于已记的那次;只透出不拦)。
export function writeProbeMarker(repoRoot, info = {}) {
  try {
    const p = path.join(sharedRoot(repoRoot), PROBE_MARKER);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const rec = { ts: Math.floor(Date.now() / 1000), ...info };
    const old = readMarkerAt(path.dirname(path.dirname(p)));
    if (old && Number.isFinite(+rec.ts) && +old.ts > +rec.ts) return true;
    fs.writeFileSync(p, JSON.stringify(rec) + "\n");
    return true;
  } catch { return false; }
}

/** hook 注入用:{lastPushTs, pushRef, lastProbeTs};git 不可用等执行故障 ⇒ null(规则退回解析判法) */
export function readDebtFacts(repoRoot = process.cwd(), remote = "private") {
  try {
    const p = lastPush(repoRoot, remote);
    const m = readProbeMarker(repoRoot);
    // probeUnknown / probeFail:只作**信息**透出(CLI 打印、供收尾报告的四级欠账行引用),DP 不据此拦——
    //   第七轮红队证明「据标记里的 FAIL/UNKNOWN 拦」会让整仓所有会话每轮被拦,且 fail 含非欠账项(见 gate-rules DP 注)。
    return { lastPushTs: p.ts, pushRef: p.ref, lastProbeTs: m ? Number(m.ts) : null, probeUnknown: !!(m && m.unknown),
      probeFail: m && Number.isFinite(+m.fail) ? +m.fail : 0 };
  } catch { return null; }
}

// ── 自测(导出给 hook-stop-closure 的 --self-test 调,随 gate:accept 跑;红队 202 第五轮附节:原先是孤儿)──
export function selfTest({ quiet = false } = {}) {
    let ok = 0, bad = 0;
    const chk = (name, got, want) => {
      const pass = JSON.stringify(got) === JSON.stringify(want);
      pass ? ok++ : bad++;
      if (!quiet || !pass) console.log(`${pass ? "PASS" : "FAIL"} debt-facts ${name}${pass ? "" : ` 得 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`}`);
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "debt-facts-"));
    const run = (cwd, args) => execFileSync("git", args, { windowsHide: true, cwd, stdio: "ignore" });
    try {
      const bare = path.join(tmp, "remote.git"), work = path.join(tmp, "work");
      run(tmp, ["init", "-q", "--bare", bare]);
      run(tmp, ["init", "-q", work]);
      for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) run(work, ["config", k, v]);
      run(work, ["remote", "add", "private", bare]);
      chk("没推过 ⇒ lastPushTs=null", readDebtFacts(work).lastPushTs, null);
      fs.writeFileSync(path.join(work, "a.txt"), "a");
      run(work, ["add", "a.txt"]); run(work, ["commit", "-q", "-m", "a"]);
      run(work, ["push", "-q", "private", "HEAD:master"]);
      const f1 = readDebtFacts(work);
      chk("推过 ⇒ lastPushTs 为数字", typeof f1.lastPushTs, "number");
      chk("推过 ⇒ pushRef=private/master", f1.pushRef, "private/master");
      chk("推过、没跑探针 ⇒ lastProbeTs=null", f1.lastProbeTs, null);
      // fetch 也会更新跟踪 ref,但主题是 fetch 不是 push ⇒ 不应改变 lastPushTs
      run(work, ["fetch", "-q", "private"]);
      chk("fetch 不算推送", readDebtFacts(work).lastPushTs, f1.lastPushTs);
      writeProbeMarker(work, { mode: "self-test" });
      const f2 = readDebtFacts(work);
      chk("跑过探针 ⇒ lastProbeTs >= lastPushTs", f2.lastProbeTs >= f2.lastPushTs, true);
      chk("正常标记 ⇒ probeUnknown=false", f2.probeUnknown, false);
      writeProbeMarker(work, { mode: "self-test", pass: 5, fail: 2 });
      chk("标记带 fail ⇒ probeFail 透出", readDebtFacts(work).probeFail, 2);
      writeProbeMarker(work, { mode: "self-test", unknown: 1 });
      chk("取数失败标记 ⇒ probeUnknown=true", readDebtFacts(work).probeUnknown, true);
      // 批 285(D134):worktree 与主树共用 reflog,也必须共用探针标记
      {
        const wt = path.join(tmp, "wt");
        run(work, ["worktree", "add", "-q", "--detach", wt]);
        writeProbeMarker(work, { mode: "self-test", ts: 4000000000 });
        chk("D134 worktree 读到主树的探针标记(与共用的 reflog 同口径)", readDebtFacts(wt).lastProbeTs, 4000000000);
        chk("D134 worktree 与主树看到同一个 lastPushTs", readDebtFacts(wt).lastPushTs, readDebtFacts(work).lastPushTs);
        writeProbeMarker(wt, { mode: "self-test", ts: 4000000100 });
        chk("D134 worktree 里跑的探针落到共享根(主树读得到)", readDebtFacts(work).lastProbeTs, 4000000100);
        chk("D134 worktree 里不再另落一份标记", fs.existsSync(path.join(wt, PROBE_MARKER)), false);
        // 批 285 第二轮复核(误拦猎手第 4 份 FB-4):起跑较早的探针后写完,不得把共享根上较晚的标记覆盖回去
        writeProbeMarker(work, { mode: "self-test", ts: 4000000050 });
        chk("285 二轮 FB-4:较早的标记不覆盖共享根上较晚的(取较大值)", readDebtFacts(work).lastProbeTs, 4000000100);
        // 切换前留在 worktree 旧位置的较晚标记照认(只会少拦)
        fs.mkdirSync(path.join(wt, ".claude"), { recursive: true });
        fs.writeFileSync(path.join(wt, PROBE_MARKER), JSON.stringify({ ts: 4000000200 }));
        chk("D134 本树旧位置的较晚标记照认", readDebtFacts(wt).lastProbeTs, 4000000200);
        fs.writeFileSync(path.join(wt, PROBE_MARKER), JSON.stringify({ ts: 1 }));
        chk("D134 本树旧位置的较早标记不压过共享根", readDebtFacts(wt).lastProbeTs, 4000000100);
        writeProbeMarker(work, { mode: "self-test", ts: 4000000150 });
        chk("285 二轮 FB-4 对照:较晚的标记照写", readDebtFacts(work).lastProbeTs, 4000000150);
      }
      chk("坏标记 ⇒ 当作没跑过", (fs.writeFileSync(path.join(work, PROBE_MARKER), "{oops"), readDebtFacts(work).lastProbeTs), null);
      // GIT_CEILING_DIRECTORIES:系统临时目录的某个祖先本身可能就是 git 仓(2026-10-06 家目录被 git init 成空仓,
      //   本条随即误红)⇒ 把向上查找挡在 tmp 的父目录,保证「非 git 目录」这个前提成立。
      const ceil = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = path.dirname(tmp);
      try { chk("非 git 目录 ⇒ 整体 null(执行故障,规则退回解析判法;不抛)", readDebtFacts(tmp), null); }
      finally { if (ceil === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceil; }
      run(work, ["config", "core.logAllRefUpdates", "false"]);
      chk("显式关 reflog(false)⇒ 整体 null(不当成没推过)", readDebtFacts(work), null);
      run(work, ["config", "core.logAllRefUpdates", "no"]);
      chk("显式关 reflog(no)⇒ 整体 null", readDebtFacts(work), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { pass: ok, total: ok + bad };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) {
    const r = selfTest();
    console.log(`\n${r.pass} PASS / ${r.total - r.pass} FAIL`);
    process.exitCode = r.pass === r.total ? 0 : 1;
  } else {
    console.log(JSON.stringify(readDebtFacts(process.cwd())));
  }
}
