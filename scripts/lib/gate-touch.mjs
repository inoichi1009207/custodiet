// 「本会话碰过闸」自动 tag(批 279;用户 2026-10-27:「能不能做一个东西,一个会话开始修闸时给自己打上修闸 tag,只有有修闸 tag 时 P 才算数」)。
//
// 为什么要它:P 的 D11 按「本会话上次 P 结清以来进仓的提交」计,不分哪个会话提交的;两个会话共用一个 checkout 时,
//   别的会话的改闸提交落进本会话范围,零改闸的会话也被要求起两个猎手(交接单 20261027 追加节:另一会话被 6423cb4 连拦 5 轮)。
//   git 字段分不出会话(全仓一个 author),批 278 / 279 两轮「按 sha 认账」都没解决(停止出口①)。
// 为什么自动打、不让会话自己声明:自己声明 ⇒ 不打 tag 就永不被 P 查,开关在被审方手里。
//   改成 PreToolUse 钩子按**动作**记:本会话(含它派的子代理——子代理的 PreToolUse 载荷带父会话 session_id,
//   2026-09-07 / 09-17 探针实录在 .claude/.carrier-precheck.jsonl 的 keys 字段)做了下面任一件 ⇒ 记一行:
//     ① Edit / Write / MultiEdit 的目标是闸引擎文件;
//     ② Bash / PowerShell 的写目标里有闸引擎文件;
//     ③ git 带进别处改动的子命令:merge / cherry-pick / pull / rebase / am / apply / revert / checkout / switch / restore / reset / stash;
//     ④ 以可写沙箱起 codex(`--sandbox workspace-write` / `danger-full-access`)——它的写在钩子视野外;
//     ⑤ 解析失败 ⇒ 记(偏严:多记一个 tag 只会多拦一次,不会放过真欠账)。
//   P 侧另有兜底(gate-rules.mjs RULE_P._p.selfTouched):本会话窗口里看得见的闸写入 / 合并命令,以及「提交命令后 300 秒内
//   落进范围的改闸提交」也算——两者是并集,任一成立即算碰过。
// CEILING:钩子视野外的写(本会话跑的 node 脚本写闸文件、外部进程)只靠 P 侧「提交时刻邻近」兜底;
//   **脚本在子进程里写闸并自己提交**(命令行里既无闸路径也无 git commit)两头都看不见——红队 279 复审 BP-1,登记为残余:
//   要拦就得「本会话跑过任何脚本、300 秒内进了改闸提交即算碰过」,两个忙会话并行时会把别人的提交算到自己头上,
//   正是本设计要消掉的误拦;诚实写法极少,故意绕属伪造族。PF 提示措辞不断言「是别人的」,让诚实执行者自己认领;
//   账在 gitignore 面,能写盘的人可伪造(故意伪造族)。账不存在或读不了 ⇒ 按碰过算(没装记账钩子的仓退回旧判法)。
// 失效条件:出现一次「改了闸却没 tag、P 因此放行」的实例 ⇒ 复议。
import fs from "node:fs";
import path from "node:path";

export const TOUCH_GIT_SUBS = /^(?:merge|cherry-pick|pull|rebase|am|apply|revert|checkout|switch|restore|reset|stash)$/;

/** 一段 git 命令算不算碰闸(唯一实现;P 侧 selfTouched ② 同用)。返回理由串或 null。
 *  误拦猎手 279 终版 FB-3:只认会移动 HEAD 或把内容写进闸文件的形态——`stash list` / `restore --staged` / `checkout -- 非闸文件` /
 *  `checkout -b` / `switch -c` / `reset <非闸路径>`(撤暂存)/ `apply --check` 不记;FB-4:作用在别的仓(`-C` / 段内 cd 落在仓外)不记。
 *  g = gate-ctx `gitArgs` 的结果;dir = 该段执行时所在目录(可为 null = 会话当前目录);underRoot(dir) 判是否本仓;isEngine(path) 判闸文件。 */
//   批 279 收窄版内存探针(红队两次被安全分类器截断后自跑):别名 / 未知子命令认不出 ⇒ 不在下面这张「不碰闸」清单里的子命令一律记(偏严)
export const GIT_SAFE_SUBS = /^(?:status|log|diff|show|add|commit|push|fetch|branch|tag|remote|config|rev-parse|ls-files|ls-tree|grep|blame|describe|shortlog|reflog|cat-file|ls-remote|rev-list|merge-base|notes|for-each-ref|symbolic-ref|check-ignore|check-attr|hash-object|show-ref|name-rev|whatchanged|archive|count-objects|fsck|gc|help|version|var|worktree|init|clone|bisect|range-diff|format-patch|request-pull|verify-commit|verify-tag|show-branch|cherry|difftool|credential|maintenance|sparse-checkout|submodule|lfs)$/;

export function gitSegWhy(g, dir, underRoot, isEngine) {
  if (!g) return null;
  const where = g.cdir ? (dir && !/^([A-Za-z]:)?\//.test(String(g.cdir).replace(/\\/g, "/")) ? `${dir}/${g.cdir}` : g.cdir) : dir;
  if (where && !underRoot(where)) return null;
  const args = (g.args || []).map(String);
  const flags = args.filter((a) => a.startsWith("-")), pos = args.filter((a) => !a.startsWith("-"));
  const dd = args.indexOf("--");
  const paths = dd >= 0 ? args.slice(dd + 1) : [];
  // 路径参数是闸文件,或是**覆盖了**闸文件的目录 / 「.」/ 通配(`checkout <ref> -- scripts/lib`、`-- .` 能整目录带回旧闸;同上内存探针)
  //   覆盖闸文件的目录只有这一小组:仓根(「.」/ 空)、scripts、scripts/lib、scripts/git-hooks、scripts/gate-deps(与 ENGINE_REL 同步改);
  //   不拼探测路径——P 侧闸路径判定不带仓根时按后缀匹配,拼出来的 `docs/a.md/scripts/x.mjs` 也会命中(首版实撞:撤暂存被误记)
  // codex 279-r2 附 3:路径参数按该段作用目录拼(`git -C /repo/scripts/lib restore gate-touch.mjs` 原拿裸名判)
  const J = (p) => { const s = String(p).replace(/\\/g, "/"); return where && !/^([A-Za-z]:)?\/|^~/.test(s) ? `${String(where).replace(/\\/g, "/").replace(/\/+$/, "")}/${s}` : s; };
  // 是不是仓根:本身在仓内、上一级不在
  const isRoot = (s) => underRoot(s) && !underRoot(s.replace(/\/[^/]+$/, "") || "/");
  const covers = (p) => {
    const raw = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
    if (/[*?[]/.test(raw) || /^:\//.test(raw)) return true;
    const s = J(raw).replace(/(?:\/\.)+$/, "").replace(/^(?:\.\/)+/, "");
    if (s === "" || s === ".") return true;                       // 作用目录未知时按仓根算
    if (/^([A-Za-z]:)?\//.test(s) && isRoot(s)) return true;      // 仓根整体
    if (/(?:^|\/)scripts(?:\/(?:lib|git-hooks|gate-deps))?$/i.test(s)) return true;
    return isEngine(s);
  };
  // 像路径:含 / 、扩展名、或就是 . / ..(误拦猎手收窄版 FB-1 / FB-2:不带 -- 的路径模式)
  const pathy = (p) => /[\\/]|\.\w{1,6}$|^\.\.?$/.test(String(p));
  const anyCovers = (xs) => xs.some(covers);
  if (/^(?:rm|mv|clean)$/.test(g.sub)) return anyCovers(pos) || g.sub === "clean" && pos.length === 0 ? `git-${g.sub}` : null;
  if (!TOUCH_GIT_SUBS.test(g.sub)) return GIT_SAFE_SUBS.test(g.sub) ? null : `git-unknown:${g.sub}`;
  const why = `git-${g.sub}`;
  // 位置参数里的引用 / 路径拆分:有 `--` ⇒ 前为引用、后为路径;没有 ⇒ 第一个像路径之前的是引用
  const split = () => {
    if (dd >= 0) return { refs: args.slice(0, dd).filter((a) => !a.startsWith("-")), ps: paths };
    const k = pos.findIndex(pathy);
    return k < 0 ? { refs: pos, ps: [] } : { refs: pos.slice(0, k), ps: pos.slice(k) };
  };
  switch (g.sub) {
    case "merge": case "cherry-pick": case "pull": case "rebase": case "am": case "revert":
      return flags.some((f) => /^--(?:abort|quit)$/.test(f)) ? null : why;
    case "apply": return flags.some((f) => /^--(?:check|stat|numstat|summary)$/.test(f)) ? null : why;
    case "stash": return /^(?:pop|apply)$/.test(pos[0] || "") ? why : null;
    case "switch": {
      // codex 279-r2 附 1:`switch -c 新分支 <起点>` 带起点 ⇒ HEAD 换到起点,记;不带起点只是从当前 HEAD 开分支,不记
      const create = flags.some((f) => /^(?:-c|-C|--create|--force-create|--orphan)$/.test(f));
      return create ? (pos.length >= 2 ? why : null) : (pos.length ? why : null);
    }
    case "restore": {
      // 只有带 --source 才可能带进别处内容;从暂存区 / HEAD 还原只是丢弃自己的改动(误拦猎手收窄版 FB-2 同理)
      const si = args.findIndex((a) => /^(?:-s|--source)$/.test(a));
      const srcVal = si >= 0 ? args[si + 1] : null;
      const src = si >= 0 || flags.some((f) => /^--source=/.test(f));
      return src && anyCovers(pos.filter((p) => p !== srcVal)) ? why : null;
    }
    case "checkout": {
      if (flags.some((f) => /^-[bB]$|^--orphan$/.test(f))) return pos.length >= 2 ? why : null;   // codex 279-r2 附 1:带起点才记
      const { refs, ps } = split();
      // 路径模式:无引用 / 引用是 HEAD = 从暂存区或 HEAD 还原(丢弃自己的改动),不记(末笔附节二 4)
      if (ps.length) return refs.some((r) => !/^HEAD$/i.test(r)) && anyCovers(ps) ? why : null;
      return refs.length ? why : null;                                    // checkout <ref>:切 HEAD
    }
    case "reset": {
      if (flags.some((f) => /^--(?:hard|keep|merge)$/.test(f))) return why;
      const { refs, ps } = split();
      // 路径模式(只动暂存区):引用是 HEAD 或没给 = 撤暂存,不记(末笔附节二 4:`reset .`);从别的提交重置闸路径才记
      if (ps.length) return refs.some((r) => !/^HEAD$/i.test(r)) && anyCovers(ps) ? why : null;
      // 余下只有引用:`reset` / `reset HEAD` 是撤暂存(误拦猎手收窄版 FB-1);别的引用(HEAD~1、sha、分支名)⇒ 移 HEAD,记
      return refs.some((r) => !/^HEAD$/i.test(r)) ? why : null;
    }
    default: return why;
  }
}

/** 只读猎手的调用不记账:它们按 hook-guard D105c 不许写,探针串里提到闸词只是在审(误拦猎手 279 终版 FB-1:实录两行假 tag)。 */
export const READONLY_AGENTS = /^_gate-(?:bypass|false-block)-hunter$/;

/** 闸引擎路径判定:只认本仓根下、按仓相对形命中 ENGINE_REL 的(别的仓的同名文件不算;worktree 里的改动经合并命令记)。
 *  路径归一走注入的 `resolve`(P 的唯一实现:分隔符、/d/ 形、`.` 与 `..`);不注入时只做分隔符归一。 */
export function engineUnder(root, engineRel, resolve = null) {
  const norm = (x) => (resolve ? resolve(null, x) : String(x || "").replace(/\\/g, "/"));
  const r = norm(root).replace(/\/+$/, "").toLowerCase();
  return (p) => {
    const s = norm(p);
    if (!r || !s.toLowerCase().startsWith(r + "/")) return false;
    return engineRel.test(s.slice(r.length + 1));
  };
}

/** 路径是否在本仓根下(git 段的作用仓判定;误拦猎手 279 终版 FB-4)。 */
export function rootUnder(root, resolve = null) {
  const norm = (x) => (resolve ? resolve(null, x) : String(x || "").replace(/\\/g, "/"));
  const r = norm(root).replace(/\/+$/, "").toLowerCase();
  //   `.claude/worktrees/` 下是别的 checkout(子代理 worktree):在那里切 HEAD 不动主树 P 范围,按仓外算(批 279 末笔 FB-1);
  //   合回主树那一步的 merge 照记
  return (p) => {
    const s = norm(p).replace(/\/+$/, "").toLowerCase();
    if (!r || !(s === r || s.startsWith(r + "/"))) return false;
    return !/^\.claude\/worktrees(?:\/|$)/.test(s.slice(r.length + 1));
  };
}

/** 这次工具调用算不算碰闸;算 ⇒ 返回理由串,不算 ⇒ null。deps 注入解析零件(本模块不拖规则引擎)。 */
export function touchWhy(input, deps) {
  const tool = String(input?.tool_name || "");
  const ti = input?.tool_input || {};
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd.replace(/\\/g, "/") : null;
  const abs = (p) => {
    const s = String(p || "").replace(/\\/g, "/");
    // `~` / `$HOME` 开头 ⇒ 原样(按仓外算;误拦猎手收窄版 FB-4:原被拼到仓根下)
    //   裸盘符 `D:` 也是绝对形(判「是不是仓根」要取上一级;原被拼回仓内)
    return /^([A-Za-z]:)?\/|^[A-Za-z]:$|^~|^\$/.test(s) || !cwd ? s : `${cwd.replace(/\/+$/, "")}/${s}`;
  };
  if (READONLY_AGENTS.test(String(input?.agent_type || ""))) return null;
  try {
    if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
      const fp = ti.file_path || ti.notebook_path;
      return fp && deps.isEnginePath(abs(fp)) ? `write:${String(fp).replace(/\\/g, "/")}` : null;
    }
    if (tool !== "Bash" && tool !== "PowerShell") return null;
    const cmd = String(ti.command || "");
    if (!cmd.trim()) return null;
    const d = tool === "PowerShell" ? "ps" : "bash";
    // 写目标走 P 的唯一实现(writeTargets:跟踪段内 cd、resolve 处理 .. 与 /d/ 形;红队 279 终版附注 2 / 3)
    for (const t of deps.writeTargets(cmd, d)) {
      if (deps.isEnginePath(abs(t))) return `cmd-write:${String(t).replace(/\\/g, "/")}`;
    }
    const underRoot = (where) => deps.underRoot(abs(where));
    for (const { seg, cwd: segCwd } of deps.walk(cmd, d)) {
      const s = String(seg).trim().replace(/^(?:\w+=\S*\s+)+/, "");
      // 红队 279 复审 BP-1 + 误拦猎手终版 FB-1:按段判,命令头真是 codex(裸 codex / node …codex-run.mjs)才看可写沙箱参数;
      //   提交信息、echo、grep 源码、探针串里提到这些词不算
      //   命令头前允许启动器(npx / env / & / call / pnpm dlx / npm exec 等;收窄版内存探针:`npx codex`、`& codex`、`env codex` 原认不出)
      const LAUNCH = /^(?:(?:npx|bunx|env|&|call|exec|command|nohup|time|start|pnpm\s+(?:dlx|exec)|npm\s+exec|yarn\s+dlx)\s+(?:-\S+\s+)*)*/i;
      const s2 = s.replace(LAUNCH, "");
      if (/^["']?(?:\S*[\\/])?codex(?:\.exe|\.cmd|\.ps1)?["']?\s/i.test(s2) || /^node(?:\.exe)?\s+(?:--\S+\s+)*\S*codex-run\.mjs\b/i.test(s2)) {
        if (/(?:^|\s)(?:--sandbox[\s=]+(?:workspace-write|danger-full-access)|--full-auto|--yolo|--dangerously-bypass\S*)/.test(s)) return "codex-writable";
      }
      // 写目标是变量 / 命令替换展开(解析不出路径)且本段出现闸相关字样 ⇒ 按碰过记(偏严;红队 279 复审 BP-1)
      if (/(?:>>?|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|Set-Content|Out-File|Add-Content)\s*[^|;&\n]*\$[({\w]/.test(s) && /scripts|gate|hook/i.test(s)) return "dynamic-target";
      const g = deps.gitArgs(s);
      const w = gitSegWhy(g, segCwd ? abs(segCwd) : cwd, underRoot, (p) => deps.isEnginePath(abs(p)));
      if (w) return w;
    }
    return null;
  } catch (e) {
    return `parse-failed:${String(e && e.message || e).slice(0, 60)}`;
  }
}

/** 追加一行账。写失败不抛(不影响放行;P 侧兜底仍在)。 */
export function recordTouch(file, input, why) {
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), sid: String(input?.session_id || ""), why,
      ...(input?.agent_type || input?.agent_id ? { agent: String(input.agent_type || input.agent_id) } : {}) }) + "\n");
  } catch { /* 记账失败不影响放行 */ }
}

/** 本会话有没有 tag:true / false;账不存在 / 读不了 / 会话 id 缺 ⇒ null(调用方按碰过算)。 */
export function readTouched(file, sid) {
  if (typeof sid !== "string" || !sid) return null;
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  // 账不存在 ⇒ null(按碰过算):没装记账钩子的仓(custodiet 公开包没有 hook-guard)里账永远不存在,
  //   读成 false 会让 P 的 D11 在别人的仓里静默放宽;只有账存在(记账钩子在跑)时「没有本会话」才算没碰过
  catch { return null; }
  for (const l of raw.split("\n")) {
    if (!l.includes(sid)) continue;
    try { if (JSON.parse(l).sid === sid) return true; } catch { /* 坏行跳过 */ }
  }
  return false;
}

// ── 自测 ──(由 hook-stop-closure.mjs --self-test 调用并注入零件:本文件被它静态导入,自己再回头 import 它会循环、顶层 await 永不落地,进程以 13 退出——批 279 实撞)
export function selfTest(deps0, os, log = console.log) {
  const deps = { ...deps0, isEnginePath: engineUnder("/repo", deps0.engineRel, deps0.resolve), underRoot: rootUnder("/repo", deps0.resolve) };
  let pass = 0, fail = 0;
  const t = (n, got, want) => { const ok = (got === null) === (want === null) && (want === null || String(got).startsWith(want)); ok ? pass++ : fail++; log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : `  ← 实得 ${got}`}`); };
  const call = (tool_name, tool_input, extra = {}) => touchWhy({ tool_name, tool_input, cwd: "/repo", session_id: "s1", ...extra }, deps);
  t("Edit 闸引擎文件 ⇒ 记", call("Edit", { file_path: "/repo/scripts/lib/gate-rules.mjs" }), "write:");
  t("Edit 相对路径闸文件 ⇒ 记", call("Write", { file_path: "scripts/hook-stop-closure.mjs" }), "write:");
  t("Edit 普通文件 ⇒ 不记", call("Edit", { file_path: "/repo/docs/x.md" }), null);
  t("Edit 别的仓同名文件 ⇒ 不记", call("Edit", { file_path: "E:/cbot/scripts/lib/gate-rules.mjs" }), null);
  t("Bash 重定向写闸文件 ⇒ 记", call("Bash", { command: "echo x > scripts/lib/gate-ctx.mjs" }), "cmd-write:");
  t("Bash 先 cd 再写(无 scripts/ 字样)⇒ 记", call("Bash", { command: "cd scripts && cd lib && echo x > gate-rules.mjs" }), "cmd-write:");
  t("Edit 带 .. 的路径 ⇒ 记", call("Edit", { file_path: "/repo/docs/../scripts/lib/gate-rules.mjs" }), "write:");
  t("Edit /d/ 形路径 ⇒ 记", call("Edit", { file_path: "/repo/scripts/lib/gate-rules.mjs" }), "write:");
  t("Bash git merge ⇒ 记", call("Bash", { command: "git merge --no-ff worktree-agent-x" }), "git-merge");
  t("Bash git cherry-pick ⇒ 记", call("Bash", { command: "cd /repo && git cherry-pick abc1234" }), "git-cherry-pick");
  t("PowerShell git pull ⇒ 记", call("PowerShell", { command: "git pull private master" }), "git-pull");
  t("Bash 只读 git ⇒ 不记", call("Bash", { command: "git log --oneline -5 && git status --short" }), null);
  t("Bash git commit ⇒ 不记(P 侧按时刻邻近兜底)", call("Bash", { command: "git add -A && git commit -m x" }), null);
  t("codex 可写沙箱 ⇒ 记", call("Bash", { command: "node ~/.claude/scripts/codex-run.mjs --task t.md --sandbox workspace-write" }), "codex-writable");
  t("codex 只读 ⇒ 不记", call("Bash", { command: "node ~/.claude/scripts/codex-run.mjs --task t.md" }), null);
  t("红队复审 BP-1:裸 codex exec 可写沙箱 ⇒ 记", call("Bash", { command: "codex exec --sandbox workspace-write \"fix it\"" }), "codex-writable");
  t("红队复审 BP-1:命令替换写目标 + 闸字样 ⇒ 记", call("Bash", { command: "printf x >> $(printf scripts/lib/gate-rules.mjs)" }), "dynamic-target");
  t("变量写目标但与闸无关 ⇒ 不记", call("Bash", { command: "echo x > $TMPDIR/out.txt" }), null);
  // 误拦猎手 279 终版 FB-1 / FB-3 / FB-4
  t("FB-1:提交信息里提到 codex 可写 ⇒ 不记", call("Bash", { command: "git commit -m \"docs: codex-run.mjs --sandbox workspace-write 用法\"" }), null);
  t("FB-1:node -e 探针串里提到 ⇒ 不记", call("Bash", { command: "node -e \"s='codex-run.mjs --sandbox workspace-write'\"" }), null);
  t("FB-1:只读猎手的调用 ⇒ 不记", call("Bash", { command: "git merge x" }, { agent_type: "_gate-false-block-hunter" }), null);
  t("FB-3:git stash list ⇒ 不记", call("Bash", { command: "git stash list" }), null);
  t("FB-3:git stash pop ⇒ 记", call("Bash", { command: "git stash pop" }), "git-stash");
  t("FB-3:git restore --staged 非闸文件 ⇒ 不记", call("Bash", { command: "git restore --staged docs/a.md" }), null);
  t("FB-3:git checkout -- 非闸文件 ⇒ 不记", call("Bash", { command: "git checkout -- docs/x.md" }), null);
  t("FB-3:git checkout <ref> -- 闸文件 ⇒ 记", call("Bash", { command: "git checkout 6423cb4 -- scripts/lib/gate-rules.mjs" }), "git-checkout");
  t("FB-3:git checkout -b ⇒ 不记", call("Bash", { command: "git checkout -b feat" }), null);
  t("FB-3:git checkout 分支(切 HEAD)⇒ 记", call("Bash", { command: "git checkout main" }), "git-checkout");
  t("FB-3:git switch -c ⇒ 不记", call("Bash", { command: "git switch -c feat" }), null);
  t("FB-3:git reset 撤暂存 ⇒ 不记", call("Bash", { command: "git reset docs/a.md" }), null);
  t("FB-3:git reset --hard ⇒ 记", call("Bash", { command: "git reset --hard HEAD~1" }), "git-reset");
  t("FB-3:git reset HEAD~1(移 HEAD)⇒ 记", call("Bash", { command: "git reset HEAD~1" }), "git-reset");
  t("FB-3:git apply --check ⇒ 不记", call("Bash", { command: "git apply --check p.diff" }), null);
  t("FB-4:git -C 别的仓 merge ⇒ 不记", call("Bash", { command: "git -C E:/cbot merge origin/main" }), null);
  t("FB-4:cd 别的仓再 pull ⇒ 不记", call("Bash", { command: "cd E:/cbot && git pull" }), null);
  t("FB-4:git -C 本仓 merge ⇒ 记", call("Bash", { command: "git -C /repo merge x" }), "git-merge");
  // 收窄版内存探针(红队两次被截断后自跑)
  t("探针:checkout <ref> -- . ⇒ 记", call("Bash", { command: "git checkout HEAD~3 -- ." }), "git-checkout");
  t("探针:checkout <ref> -- scripts/lib ⇒ 记", call("Bash", { command: "git checkout HEAD~3 -- scripts/lib" }), "git-checkout");
  t("探针:restore --source <ref> scripts/lib ⇒ 记", call("Bash", { command: "git restore --source HEAD~3 scripts/lib" }), "git-restore");
  t("探针:reset <sha> -- scripts/lib ⇒ 记", call("Bash", { command: "git reset abc1234 -- scripts/lib" }), "git-reset");
  t("探针:checkout -- docs(不含闸)⇒ 不记", call("Bash", { command: "git checkout -- docs" }), null);
  t("探针:别名 git co ⇒ 记", call("Bash", { command: "git co main" }), "git-unknown");
  t("探针:-c alias 临时别名 ⇒ 记", call("Bash", { command: "git -c alias.mm=merge mm x" }), "git-unknown");
  t("探针:git rm 闸文件 ⇒ 记", call("Bash", { command: "git rm scripts/lib/gate-x.mjs" }), "git-rm");
  t("探针:npx codex 可写 ⇒ 记", call("Bash", { command: "npx codex exec --sandbox workspace-write x" }), "codex-writable");
  t("探针:PowerShell & codex 可写 ⇒ 记", call("PowerShell", { command: "& codex exec --sandbox workspace-write x" }), "codex-writable");
  t("探针:env codex 可写 ⇒ 记", call("Bash", { command: "env codex exec --sandbox workspace-write x" }), "codex-writable");
  // 误拦猎手收窄版 FB-1~4 与 codex 279-r2 附 1 / 3
  t("收窄版 FB-1:git reset HEAD <文件> 撤暂存 ⇒ 不记", call("Bash", { command: "git reset HEAD docs/a.md" }), null);
  t("收窄版 FB-1:git reset HEAD ⇒ 不记", call("Bash", { command: "git reset HEAD" }), null);
  t("收窄版 FB-2:git checkout <非闸文件> ⇒ 不记", call("Bash", { command: "git checkout docs/x.md" }), null);
  t("收窄版 FB-2:git checkout .(从暂存区还原)⇒ 不记", call("Bash", { command: "git checkout ." }), null);
  t("收窄版 FB-2:git checkout HEAD docs/x.md ⇒ 不记", call("Bash", { command: "git checkout HEAD docs/x.md" }), null);
  t("收窄版 FB-2 对照:git checkout HEAD~3 scripts/lib ⇒ 记", call("Bash", { command: "git checkout HEAD~3 scripts/lib" }), "git-checkout");
  t("收窄版 FB-3:PowerShell Set-Location 别的仓再 pull ⇒ 不记", call("PowerShell", { command: "Set-Location E:\\cbot; git pull" }), null);
  t("收窄版 FB-4:子 shell cd 别的仓 ⇒ 不记", call("Bash", { command: "(cd E:/cbot && git pull)" }), null);
  t("收窄版 FB-4:cd ~/proj ⇒ 不记", call("Bash", { command: "cd ~/proj && git pull" }), null);
  t("收窄版 FB-4:cd 带空格的引号路径 ⇒ 不记", call("Bash", { command: "cd \"E:/my repo\" && git pull" }), null);
  t("codex r2 附 1:checkout -b 新分支 <起点> ⇒ 记", call("Bash", { command: "git checkout -b new other-branch" }), "git-checkout");
  t("codex r2 附 1:switch -c 新分支 <起点> ⇒ 记", call("Bash", { command: "git switch -c new other-branch" }), "git-switch");
  t("codex r2 附 3:-C 闸目录 restore --source 闸文件 ⇒ 记", call("Bash", { command: "git -C /repo/scripts/lib restore --source HEAD~1 gate-touch.mjs" }), "git-restore");
  // 末笔误拦猎手 FB-1 / FB-2、附节二 1
  t("末笔 FB-1:worktree 里 checkout -B 到基点 ⇒ 不记", call("Bash", { command: "git checkout -B b 668dc6f" }, { cwd: "/repo/.claude/worktrees/agent-x" }), null);
  t("末笔 FB-1:cd 进 worktree 再 switch -c ⇒ 不记", call("Bash", { command: "cd /repo/.claude/worktrees/agent-x && git switch -c w master" }), null);
  t("末笔 FB-1 对照:主树 merge worktree 分支 ⇒ 记", call("Bash", { command: "git merge worktree-agent-x" }), "git-merge");
  t("末笔附节二 1:子 shell cd 他仓后回本仓 pull ⇒ 记", call("Bash", { command: "(cd E:/cbot && git pull) && git pull" }), "git-pull");
  t("末笔附节二 1:Push/Pop-Location 后本仓 pull ⇒ 记", call("PowerShell", { command: "Push-Location E:/cbot; git pull; Pop-Location; git pull" }), "git-pull");
  t("末笔附节二 4:git reset . ⇒ 不记", call("Bash", { command: "git reset ." }), null);
  t("末笔附节二 4:git checkout HEAD -- . ⇒ 不记", call("Bash", { command: "git checkout HEAD -- ." }), null);
  t("末笔 FB-2:子 shell cd 他仓后本仓写闸 ⇒ 记", call("Bash", { command: "(cd E:/cbot && git pull); echo x >> scripts/lib/gate-rules.mjs" }), "cmd-write");
  t("Read ⇒ 不记", call("Read", { file_path: "/repo/scripts/lib/gate-rules.mjs" }), null);
  t("解析抛错 ⇒ 记", touchWhy({ tool_name: "Bash", tool_input: { command: "x" } }, { ...deps, writeTargets: () => { throw new Error("boom"); } }), "parse-failed");
  const f = path.join(os.tmpdir(), `gate-touch-selftest-${process.pid}.jsonl`);
  try { fs.unlinkSync(f); } catch { /* 无 */ }
  t("账不存在(没装记账钩子)⇒ null(按碰过算)", String(readTouched(f, "s1")), "null");
  recordTouch(f, { session_id: "s1", agent_type: "general-purpose" }, "write:x");
  t("记过 ⇒ true", String(readTouched(f, "s1")), "true");
  t("别的会话 ⇒ false", String(readTouched(f, "s2")), "false");
  t("会话 id 缺 ⇒ null", String(readTouched(f, "")), "null");
  try { fs.unlinkSync(f); } catch { /* 无 */ }
  return { pass, fail };
}
