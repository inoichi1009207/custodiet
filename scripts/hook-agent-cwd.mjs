#!/usr/bin/env node
// PreToolUse(matcher: Agent):派 `isolation: "worktree"` 子代理时,会话当前目录必须在**本仓**里(D153)。
//
// 为什么:会话 `cd` 进项目里的嵌套仓(本仓的公开暂存树 `clipboard/oss/public-repo` 是一个独立 git 仓)没切回,
//   隔离子代理就被建进了那个仓:找不到本仓提交、被隔离守卫拦着改不了本仓,白跑一次,还在嵌套仓留下一个 locked worktree。
//   2026-10-11 实撞 1 次(批 257)。相近的外部报告:GitHub issue #83454(会话在 repo-a、任务要改旁边的 repo-b,
//   "it creates a git worktree of the repo my main session is running in")——方向一致,但不是「先 cd 进嵌套仓」这一形。
//   本机 changelog 未检索到「按项目根建」的开关;`WorktreeCreate` 事件是**接管**创建(hook 返回 worktreePath),不是拦截点。
//
// 判据:会话 cwd 与 `CLAUDE_PROJECT_DIR` **是不是同一个仓**——比 `git rev-parse --path-format=absolute --git-common-dir`
//   (子目录、本仓的 linked worktree、8.3 短名 / subst / 长路径前缀等写法差异都认作同一仓;复核红队 BP-7/8/9)。
//   不同仓 ⇒ deny,提示先切回。只管 Agent 工具且 `tool_input.isolation === "worktree"`。
//   放行(fail-open,有意):非 Agent、非 worktree 隔离、缺 cwd / 项目根、git 取不到任一边的仓身份(cwd 不在仓里时
//   隔离本身就会报错)。每次放行不记账,只记 deny。
// 让出面(登记 D153,复核红队 BP-1/2/3/6):Workflow 脚本里的 agent({isolation}) 不经过本 hook;agent 定义 frontmatter
//   写的 isolation 若不进 tool_input 则看不见;`tool_input.cwd` 覆盖参数不看(harness 按哪个目录建 worktree 未实测);
//   `/cd` 换项目后本仓 hook 是否仍加载未实测。
// 失效条件:Claude Code 改为始终按项目根建隔离 worktree,或本仓不再有嵌套仓 ⇒ 删本 hook。
// 计数:每次 deny 追加一行 `.claude/.agent-cwd-deny.jsonl`(gitignore 面),复议时看命中次数。
//
// 用法:作 hook 由 stdin 读 JSON;`node scripts/hook-agent-cwd.mjs --self-test` 跑自测(须打印计数行)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

/** 仓身份:该目录所属仓的公共 git 目录(linked worktree 与主检出相同)。取不到 ⇒ null。 */
export function liveRepoId(dir) {
  // Windows 上 git 认不得 Git Bash 写法 `/repo`(转录里两种写法都出现过)⇒ 先转成 `/repo`
  if (process.platform === "win32") dir = String(dir).replace(/^\/([a-z])(\/|$)/i, (_, d, t) => `${d.toUpperCase()}:${t || "/"}`);
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    if (!out) return null;
    let p = out;
    try { p = fs.realpathSync.native(out); } catch { /* 取不到真实路径就用原样 */ }
    p = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? p.toLowerCase() : p;
  } catch { return null; }
}

/** 判定:返回 null(放行)或 deny 理由串。`repoId` 可注入(自测)。 */
export function decide(input, projectDir, repoId = liveRepoId) {
  if (!input || input.tool_name !== "Agent") return null;
  const ti = input.tool_input || {};
  if (ti.isolation !== "worktree") return null;
  if (!projectDir || typeof input.cwd !== "string" || !input.cwd) return null;
  const a = repoId(input.cwd), b = repoId(projectDir);
  if (!a || !b || a === b) return null;
  return `派 worktree 隔离子代理前,会话当前目录须在本仓里(D153):现在在 ${input.cwd},它属于另一个仓(${a})。` +
    `子代理会被建进那个仓。先 \`cd ${projectDir.replace(/\\/g, "/")}\` 切回,再原样重派。`;
}

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`FAIL ${name}: 得 ${JSON.stringify(got)} 期 ${JSON.stringify(want)}`); } };
  // 注入的仓身份表:/repo 及其子目录、linked worktree ⇒ 本仓;gate-repo ⇒ 嵌套仓;/tmp ⇒ 不在仓里
  const id = (d) => {
    const s = String(d).replace(/\\/g, "/").toLowerCase();
    if (s.startsWith("/repo/clipboard/oss/public-repo")) return "/repo/clipboard/oss/public-repo/.git";
    if (s.startsWith("/repo") || s.startsWith("/repo~1")) return "/repo/.git";
    return null;
  };
  const A = (cwd, iso = "worktree", tool = "Agent") => ({ tool_name: tool, cwd, tool_input: { subagent_type: "x", prompt: "y", ...(iso ? { isolation: iso } : {}) } });
  t("在项目根 ⇒ 放行", decide(A("\\repo"), "\\repo", id), null);
  t("在嵌套仓 ⇒ 拦", typeof decide(A("\\repo\\clipboard\\oss\\public-repo"), "\\repo", id), "string");
  t("在嵌套仓子目录 ⇒ 拦", typeof decide(A("/repo/clipboard/oss/public-repo/scripts"), "/repo", id), "string");
  t("在本仓普通子目录 ⇒ 放行(复核 BP-7)", decide(A("/repo/clipboard/books"), "/repo", id), null);
  t("在本仓的 linked worktree ⇒ 放行(复核 BP-8)", decide(A("/repo/.claude/worktrees/agent-x"), "/repo", id), null);
  t("项目根写成 8.3 短名 ⇒ 按仓身份同一仓,放行(复核 BP-9)", decide(A("/repo"), "/REPO~1", id), null);
  t("cwd 不在任何仓 ⇒ 放行(隔离自会报错)", decide(A("C:/tmp"), "/repo", id), null);
  t("不带 isolation ⇒ 放行", decide(A("/repo/clipboard/oss/public-repo", null), "/repo", id), null);
  t("isolation 不是 worktree ⇒ 放行", decide(A("/repo/clipboard/oss/public-repo", "remote"), "/repo", id), null);
  t("不是 Agent ⇒ 放行", decide(A("/repo/clipboard/oss/public-repo", "worktree", "Bash"), "/repo", id), null);
  t("缺项目根 ⇒ 放行", decide(A("/repo/clipboard/oss/public-repo"), "", id), null);
  t("缺 cwd ⇒ 放行", decide({ tool_name: "Agent", tool_input: { isolation: "worktree" } }, "/repo", id), null);
  t("拦词里带切回命令", /cd \/repo/.test(decide(A("/repo/clipboard/oss/public-repo"), "\\repo", id) || ""), true);
  // 入口判定(复核 BP-4):含空格 / 中文的路径下 fileURLToPath 仍与 argv 对得上
  //   (import.meta.url 由 Node 按 pathToFileURL 同法生成,`#`、空格、中文都已编码)
  for (const p of ["E:/my proj/scripts/x.mjs", "E:/项目/scripts/x.mjs", "E:/a#b/x.mjs"]) {
    t(`入口判定:${p}`, path.resolve(fileURLToPath(pathToFileURL(p).href)) === path.resolve(p), true);
  }
  console.log(`hook-agent-cwd 自测 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.includes("--self-test")) selfTest();
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
  let input; try { input = JSON.parse(raw); } catch { process.exit(0); }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  const reason = decide(input, projectDir);
  if (!reason) process.exit(0);
  try {
    fs.appendFileSync(path.join(projectDir, ".claude", ".agent-cwd-deny.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), cwd: input.cwd, session: input.session_id ?? null }) + "\n");
  } catch { /* 计数写不了不影响拦 */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}
