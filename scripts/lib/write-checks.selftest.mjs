// write-checks.selftest.mjs —— 批 301 写入类拒绝点的自测(由 `node scripts/lib/write-checks.mjs --self-test` 载入)。
//
// 防的失败(每组用例开头再点一次):
//   ① 写前层 / 关账层判据算错(读错列、MultiEdit 各自套原文、CRLF、路径形态);
//   ② shell / 脚本写入在关账时没被发现(T / MF / J),或被发现了却只是提示、关账照过;
//   ③ M:幂等 / 静默没生效的 shell 写入没人要求回读;失败的读、写完成之前的读被当成回读;
//   ④ 判不了(转录不在、写前哈希没记全、写前写后都不存在、记账失败)被当成清;
//   ⑤ 已清后又改坏不重开、带入义务被当成清;出路要暗号 / 新 CLI;
//   ⑥ Stop 上 T / J / MF / M 只记账化没生效(D195 两形仍阻断),或连账都不记了。
// 全部在系统临时目录的临时仓里跑(带 GIT_CEILING_DIRECTORIES),并打印解析出的义务账目录、断言它不在 /repo 下。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as WC from "./write-checks.mjs";
import * as OB from "./obligations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BG = path.join(HERE, "..", "batch-goal.mjs");

export async function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      实得 ${JSON.stringify(got)}\n      期待 ${JSON.stringify(want)}`}`);
  };

  // ── ① 纯函数 ───────────────────────────────────────────────────────────────────
  t("applyEdits:MultiEdit 依次套(第二个编辑作用在第一个的结果上)", WC.applyEdits("a", "MultiEdit", { edits: [{ old_string: "a", new_string: "bc" }, { old_string: "bc", new_string: "d" }] }).after, "d");
  t("applyEdits:任何一个找不到 ⇒ 算不出", WC.applyEdits("a", "MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "zz", new_string: "y" }] }).after, null);
  t("applyEdits:replace_all 全换", WC.applyEdits("x x x", "Edit", { old_string: "x", new_string: "y", replace_all: true }).after, "y y y");
  t("applyEdits:LF 的 old_string 匹配 CRLF 原文", WC.applyEdits("a\r\nb\r\n", "Edit", { old_string: "a\nb", new_string: "a\nc" }).after, "a\r\nc\r\n");
  t("applyEdits:Write = content", WC.applyEdits("old", "Write", { content: "new" }).after, "new");
  {
    const R = path.resolve("/m");
    t("memoryRootOf:根下 MEMORY.md 是索引,不管", WC.memoryRootOf(path.join(R, "MEMORY.md"), [R]), null);
    t("memoryRootOf:子目录里的 memory 文件照管", !!WC.memoryRootOf(path.join(R, "sub", "x.md"), [R]), true);
    const A = path.resolve("/r/.claude/agent-memory");
    t("memoryRootOf:agent-memory 的 <名>/MEMORY.md 是索引", WC.memoryRootOf(path.join(A, "rev", "MEMORY.md"), [A]), null);
    t("memoryRootOf:非 .md 不管", WC.memoryRootOf(path.join(R, "x.txt"), [R]), null);
    const home = path.resolve("/h"), main = path.resolve("/w/repo");
    t("resolveMemoryDirs:三种写法(@claude-project-memory / ~/ / 相对主 checkout 允许 ..)", WC.resolveMemoryDirs(["@claude-project-memory", "~/x/m", "../dot/memory"], main, home).map((d) => WC.pkey(d)),
      [WC.pkey(path.join(home, ".claude", "projects", WC.projectDirName(main), "memory")), WC.pkey(path.join(home, "x", "m")), WC.pkey(path.resolve(main, "..", "dot", "memory"))]);
    t("lawRelOf:根 AGENTS.md / docs/gate/AGENTS.md / docs/laws/*.md;别的不算", [WC.lawRelOf(path.join(main, "AGENTS.md"), main), WC.lawRelOf(path.join(main, "docs", "gate", "AGENTS.md"), main), WC.lawRelOf(path.join(main, "docs", "laws", "x.md"), main), WC.lawRelOf(path.join(main, "docs", "gate", "x.md"), main)],
      ["AGENTS.md", "docs/gate/AGENTS.md", "docs/laws/x.md", null]);
  }

  // ── 临时仓 ───────────────────────────────────────────────────────────────────
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc301-"));
  const home = path.join(tmpRoot, "home");
  const repo = path.join(tmpRoot, "repo");
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(repo, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CEILING_DIRECTORIES: tmpRoot, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: "selftest-301-session" };
  const g = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env, windowsHide: true, timeout: 30_000 });
  const W = (rel, s) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), s); };
  const R = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
  const commit = (m) => { g("add", "-A"); return g("commit", "-q", "-m", m); };
  const bg = (...a) => spawnSync(process.execPath, ["--no-warnings", BG, ...a], { cwd: repo, encoding: "utf8", env, windowsHide: true, timeout: 120_000 });
  const HD = "| # | 欠账 | 登记批 | 失效期 | 复核来源 | 到期动作 |\n|---|---|---|---|---|---|\n";
  const ROW = "| D900 | 某事 | 300 | **≤303** | codex | 修 |";
  const BODY = "条文。".repeat(80);
  const AG = "# 仓规矩\n闸规矩:`docs/gate/AGENTS.md`。\n" + BODY;
  const ost = () => JSON.parse(fs.readFileSync(path.join(repo, ".claude", ".obligations", "state.json"), "utf8")).obligations;
  const MEM = (body) => `---\nname: n\nmetadata:\n  type: feedback\n---\n${body}`;
  const oldProj = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = repo;   // 进程内调写前层时的「会话项目」= 临时仓(MF 受管目录按它的配置定)
  try {
    g("init", "-q"); g("config", "core.autocrlf", "false");
    W(".gitignore", ".claude/\nclipboard/\n");   // mem/ 不忽略:窄版 MF 的仓内根只看 git 事实(基点 diff + 未跟踪未忽略)   // clipboard/:--clear 收尾的 fp-audit 会写日志进去(同 HostApp 的 gitignore)
    W("gate-install.json", JSON.stringify({ format: "gate-install/v1", debtTable: "docs/gate-debts.md", memoryDirs: ["mem"] }));
    W("docs/gate-debts.md", HD + ROW + "\n");
    W("AGENTS.md", AG); W("docs/gate/AGENTS.md", "# 闸规矩\n" + BODY);
    W("notes.md", "原文 aa\n");
    W("mem/old.md", MEM("回复先给结论,日期 2026-01-01。"));
    commit("init");
    const sd = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8", env, windowsHide: true }).stdout.trim();
    const oblDir = path.join(path.dirname(sd), ".claude", ".obligations");
    console.log(`  义务账目录(临时仓解析出的):${oblDir}`);
    t("自测的义务账目录不在 /repo 下", WC.pkey(oblDir).startsWith(WC.pkey("/repo")), false);

    // ── ② T:批 301 最终裁定退回只记账——shell 改空失效期 ⇒ --clear 放行,只出「T(只提示…)」,不产生义务 ──────────
    let r = bg("--arm", "400", "--cond", "甲");
    t("T 夹具:武装成功", r.status, 0);
    W("docs/gate-debts.md", HD + ROW.replace("**≤303**", "") + "\n"); commit("sed 改空失效期");   // 模拟 sed -i / node 脚本写
    r = bg("--clear");
    t("T 只记账:shell 改空失效期 ⇒ --clear 放行,提示点名 D900,义务账里没有 T", [r.status, /T\(只提示[^\n]*D900/.test(r.stderr), ost().filter((x) => x.type === WC.TYPES.T).length], [0, true, 0]);
    W("docs/gate-debts.md", HD + ROW + "\n"); commit("补上失效期");

    // ── J 照旧:拒绝点实测 + 出路 ─────────────────────────────────────────────────────
    r = bg("--arm", "401", "--cond", "乙");
    W("AGENTS.md", AG.replace("`docs/gate/AGENTS.md`", "闸仓")); commit("改坏 J");
    r = bg("--clear");
    t("J 拒绝点实测:shell 删掉规矩文件里的闸规矩指针 ⇒ --clear 拒(verify-laws FAIL)", [r.status, /write-law-verify/.test(r.stderr)], [2, true]);
    W("AGENTS.md", AG); commit("修 J");
    W("docs/laws/z.md", BODY);   // 未跟踪、未忽略:D116 不拦,改过集合里要有它
    r = bg("--clear");
    t("J:未跟踪的 docs/laws/z.md(退役目录孤儿)⇒ 关账拒", [r.status, /孤儿/.test(r.stderr)], [2, true]);
    fs.rmSync(path.join(repo, "docs", "laws"), { recursive: true });
    r = bg("--clear");
    t("J 出路:删掉孤儿 ⇒ 放行", r.status, 0);

    // ── codex p0-close r3 ⑧:J 关账层不做「只判本批新增」的减法(批 302 FB-3 的处置已退回,D225 ⑪)──────────────
    //   防的失败:减法从问题的展示字符串反解析目标路径,文件名带空格 / # 时把本批新增的问题扣成既有、关账放行(假绿)
    {
      r = bg("--arm", "4011", "--cond", "丁");
      W("AGENTS.md", AG + "\n补一句无关的话。\n"); W("docs/laws/new law.md", BODY); commit("本批新增文件名带空格的孤儿");
      r = bg("--clear");
      t("r3 ⑧:本批新增 docs/laws/new law.md(文件名带空格)+ 无害改规矩文件 ⇒ 关账拒", [r.status, /孤儿/.test(r.stderr)], [2, true]);
      fs.rmSync(path.join(repo, "docs", "laws"), { recursive: true }); W("docs/laws/c#-notes.md", BODY); commit("换成文件名带 # 的孤儿");
      r = bg("--clear");
      t("r3 ⑧:本批新增 docs/laws/c#-notes.md(文件名带 #)⇒ 关账拒", [r.status, /孤儿/.test(r.stderr)], [2, true]);
      fs.rmSync(path.join(repo, "docs", "laws"), { recursive: true }); W("AGENTS.md", AG); commit("复原");
      r = bg("--clear");
      t("r3 ⑧ 出路:删掉孤儿 ⇒ 放行", r.status, 0);
    }

    // ── ② MF:批 301 最终裁定退回只记账——shell 写缺执行面的 memory ⇒ --clear 放行,只出提示 ─────────────────
    r = bg("--arm", "402", "--cond", "丙");
    W("mem/new.md", MEM("以后一律先跑自测。")); commit("shell 写 memory");
    r = bg("--clear");
    t("MF 只记账:shell 写缺执行面的 feedback memory ⇒ --clear 放行,只出「MF(只提示…)」,义务账里没有 MF", [r.status, /MF\(只提示[^\n]*new\.md/.test(r.stderr), ost().filter((x) => x.type === WC.TYPES.MF).length], [0, true, 0]);
    W("mem/new.md", MEM("以后一律先跑自测。\n执行面:scripts/batch-goal.mjs")); commit("补执行面");
    // 判定代码保留(preWriteJudge):改前就缺、全是小改 ⇒ 判定放行并记批准
    const smallIn = { tool_name: "Edit", session_id: "s", tool_use_id: "e1", cwd: repo, tool_input: { file_path: path.join(repo, "mem", "old.md"), old_string: "2026-01-01", new_string: "2026-01-02" } };
    t("MF 判定保留:改前就缺、小改 ⇒ 判定放行", (await WC.preWriteJudge(smallIn, { repoRoot: repo })).deny, null);
    const vMF = await WC.preWriteVerdict({ tool_name: "Write", session_id: "s", cwd: repo, tool_input: { file_path: path.join(repo, "mem", "bad.md"), content: MEM("以后一律先跑自测。") } }, { repoRoot: repo });
    t("MF 写前层只记账:缺执行面 ⇒ 不拒、warn 出声、wouldDeny", [vMF.deny, vMF.warn, vMF.wouldDeny, /MF\(只提示/.test(String(vMF.note))], [null, true, true, true]);
    const vT = await WC.preWriteVerdict({ tool_name: "Edit", session_id: "s", cwd: repo, tool_input: { file_path: path.join(repo, "docs", "gate-debts.md"), old_string: "**≤303**", new_string: "" } }, { repoRoot: repo });
    t("T 写前层只记账:改空失效期 ⇒ 不拒、warn 出声、wouldDeny", [vT.deny, vT.warn, vT.wouldDeny], [null, true, true]);
    const vJ = await WC.preWriteVerdict({ tool_name: "Edit", session_id: "s", cwd: repo, tool_input: { file_path: path.join(repo, "AGENTS.md"), old_string: "# 仓规矩", new_string: "# 仓规矩\n`scripts/no-such.mjs`" } }, { repoRoot: repo });
    t("J 写前层照旧:新增断链 ⇒ 拒", [vJ.kind, !!vJ.deny], ["J", true]);
    {
      // 重开(只剩 J 产生义务,改为对义务账直接验):已清的 J 又不合格 ⇒ 同一条重开,台账 op:reopen
      const dirR = fs.mkdtempSync(path.join(tmpRoot, "oblr-"));
      const keyR = { batch: "600", armedAt: "a" };
      const once = (res) => OB.mutateStore(dirR, (d) => WC.applyWriteChecks(d, { baseCommit: "b" }, { items: [{ type: WC.TYPES.J, path: "AGENTS.md", result: res, why: res }] }, keyR, {}));
      once("open"); once("cleared"); once("open");
      const recsR = OB.readStore(dirR).obligations;
      const ledR = fs.readFileSync(path.join(dirR, "ledger.jsonl"), "utf8");
      t("重开:已清的 J 又不合格 ⇒ 同一条回到 open(台账有 reopen 行),不新建", [recsR.length, recsR[0]?.status, ledR.includes(`"op":"reopen","id":"${recsR[0]?.id}"`)], [1, "open", true]);
      // 已有的 T / MF 义务(撤回前建的)⇒ 一律写清
      const prevX = JSON.parse(fs.readFileSync(path.join(repo, ".claude", ".batch-goal.json"), "utf8"));
      const px = await WC.planWriteChecks(prevX, { cwd: repo, home, conf: { debtTable: "docs/gate-debts.md", memoryDirs: ["mem"] }, transcriptDirs: [],
        existing: [{ type: WC.TYPES.T, status: "open", payload: { path: "docs/gate-debts.md" } }, { type: WC.TYPES.MF, status: "open", payload: { path: path.join(repo, "mem", "x.md") } }] });
      t("撤回:已有的 T / MF 义务一律写清(拒绝撤回,待独立设计复核)", px.items.filter((i) => i.type === WC.TYPES.T || i.type === WC.TYPES.MF).map((i) => i.result), ["cleared", "cleared"]);
    }

    // ── codex 301 r4:异常兜底(①撤回清账先于提前返回;② J 兜底聚合项可恢复)──────────────────────────
    {
      const noGit = fs.mkdtempSync(path.join(tmpRoot, "nogit-"));
      const exR4 = [{ type: WC.TYPES.T, status: "settled", payload: { path: "docs/gate-debts.md" } }, { type: WC.TYPES.MF, status: "unknown", payload: { path: "(memory)" } },
        { type: WC.TYPES.T, status: "settling", payload: { path: "(写入类取证)" } }];
      const pNo = await WC.planWriteChecks({ armedAt: new Date().toISOString(), baseCommit: "x" }, { cwd: noGit, home, existing: exR4 });
      t("r4 ①:找不到工作树的提前返回也先把已有 T / MF(含聚合项、settled / settling / unknown)写清,再放 J 的 UNKNOWN",
        [pNo.items.filter((i) => i.type !== WC.TYPES.J).map((i) => i.result), pNo.items.find((i) => i.type === WC.TYPES.J)?.result], [["cleared", "cleared", "cleared"], "unknown"]);
      t("r4 ①:withdrawnClears 给 batch-goal 取证抛错兜底用,同口径", WC.withdrawnClears(exR4).map((i) => i.result), ["cleared", "cleared", "cleared"]);
      // ② 端到端:故障一次留下 J 兜底聚合项 UNKNOWN ⇒ 恢复后一次 --clear ⇒ 写清、不挡关账
      r = bg("--arm", "403", "--cond", "辛");
      const g403 = JSON.parse(fs.readFileSync(path.join(repo, ".claude", ".batch-goal.json"), "utf8"));
      const k403 = { batch: String(g403.batch), armedAt: g403.armedAt };
      OB.mutateStore(oblDir, (d) => WC.applyWriteChecks(d, { baseCommit: g403.baseCommit }, { items: [{ type: WC.TYPES.J, path: "(写入类取证)", result: "unknown", why: "取证抛错:模拟故障" }] }, k403, {}));
      t("r4 ②前置:故障留下的 J 兜底聚合项是 unknown", ost().find((x) => x.type === WC.TYPES.J && x.payload?.path === "(写入类取证)" && x.batch?.batch === "403")?.status, "unknown");
      r = bg("--clear");
      t("r4 ②:恢复后一次 --clear ⇒ 兜底聚合项写清、不挡关账", [r.status, ost().find((x) => x.type === WC.TYPES.J && x.payload?.path === "(写入类取证)" && x.batch?.batch === "403")?.status], [0, "cleared"]);
    }

    // ── ③④ M:写前哈希 + 回读(转录夹具在临时 home 下)──────────────────────────────────
    const pd = path.join(home, ".claude", "projects", WC.projectDirName(repo));
    fs.mkdirSync(pd, { recursive: true });
    const tr = path.join(pd, "sess.jsonl");
    const iso = (ms) => new Date(ms).toISOString();
    const trLine = (o) => fs.appendFileSync(tr, JSON.stringify(o) + "\n");
    const toolUse = (ts, id, name, input) => trLine({ type: "assistant", timestamp: ts, cwd: repo, message: { content: [{ type: "tool_use", id, name, input }] } });
    const toolRes = (ts, id, isErr = false) => trLine({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isErr, content: "x" }] } });
    r = bg("--arm", "404", "--cond", "戊");
    const rec = (cmd, id) => WC.recordPrehash({ tool_name: "Bash", session_id: "s", tool_use_id: id, cwd: repo, tool_input: { command: cmd } }, { repoRoot: repo });
    await rec("sed -i 's/zz/yy/' notes.md", "w1");                // 没命中:内容不变
    const now = Date.now();
    toolRes(iso(now + 1000), "w1");
    r = bg("--clear");
    // 批 301 主会话裁定(合并前误拦猎手 FB-1/2/3/4/10):M 撤出关账拒绝;codex 合并审 r1 ⑥ 起关账也不再做 M 取证
    t("M 撤出关账拒绝:shell 写后哈希没变、没读过 ⇒ --clear 放行,义务账里没有 M", [r.status, ost().filter((x) => x.type === WC.TYPES.M).length], [0, 0]);
    r = bg("--arm", "405", "--cond", "己");
    const prev = JSON.parse(fs.readFileSync(path.join(repo, ".claude", ".batch-goal.json"), "utf8"));
    t("M 撤出关账取证:planWriteChecks 不再给出任何 M 结论或提示", (await WC.planWriteChecks(prev, { cwd: repo, home, conf: { debtTable: "docs/gate-debts.md" }, transcriptDirs: [pd] })).items.filter((i) => i.type === WC.TYPES.M).length, 0);
    const loc = await WC.locateTargets("cd docs && printf x > example.md; cat > /tmp/probe-m.md; echo y > ../outside.md", "bash", repo);
    // cd docs 跨 `;` 仍生效 ⇒ ../outside.md 落在仓根;/tmp 下(不在任何 git 工作树里)跳过
    t("M 定位:cd 跟踪、../ 保留、系统临时目录跳过(codex 301 设计审 A7 三个反例)", loc.map((x) => x.abs ? WC.pkey(x.abs) : `U:${x.unlocated}`),
      [WC.pkey(path.join(repo, "docs", "example.md")), WC.pkey(path.join(repo, "outside.md"))]);
    const loc2 = await WC.locateTargets("echo y > ../outside2.md", "bash", path.join(repo, "docs"));
    t("M 定位:../ 不被归一吃掉(按工具 cwd 解析)", loc2.map((x) => x.abs && WC.pkey(x.abs)), [WC.pkey(path.join(repo, "outside2.md"))]);

    // ── codex 301 r1 回件的反例(F1–F5)──────────────────────────────────────────────
    {
      const loc3 = await WC.locateTargets("cp /other/docs/x.md docs/x.md", "bash", repo);
      t("r1 F3:源参数与目标同后缀 ⇒ 认等同的那个(仓内 docs/x.md),不认源", loc3.map((x) => x.abs ? WC.pkey(x.abs) : `U:${x.unlocated}`), [WC.pkey(path.join(repo, "docs", "x.md"))]);
      const loc4 = await WC.locateTargets("Set-Content -Value /other/docs/x.md -Path docs/x.md", "ps", repo);
      t("r1 F3:PowerShell -Value 是同后缀的另一路径 ⇒ 仍认 -Path 那个", loc4.map((x) => x.abs ? WC.pkey(x.abs) : `U:${x.unlocated}`), [WC.pkey(path.join(repo, "docs", "x.md"))]);
      // 主会话裁定退回字面去重:同一目标两种写法 ⇒ 定位不了(接受的误拦形);r3 的漏放形 ⇒ 不被跳过(落 unlocated)
      const loc5 = await WC.locateTargets("Set-Content -Value docs/../docs/x.md -Path docs/x.md", "ps", repo);
      t("退回后:同一目标两种字面 ⇒ 定位不了(接受的误拦形,落 UNKNOWN 不当清)", loc5.length === 1 && loc5[0].unlocated !== undefined, true);
      const loc6 = await WC.locateTargets("Set-Content -Path docs/x.md -Value $env:TEMP/../docs/x.md", "ps", repo);
      t("退回后:r3 F1 漏放形(动态候选与真实目标同址)⇒ 不被当临时目录跳过,落 unlocated", loc6.length === 1 && loc6[0].unlocated !== undefined, true);
      // F4:一次写调用写两个目标,写完成之前读了 a ⇒ 不算
      const pd4 = fs.mkdtempSync(path.join(tmpRoot, "tr4-"));
      const a = WC.pkey(path.join(repo, "fa.md")), b2 = WC.pkey(path.join(repo, "fb.md"));
      const L = (o) => fs.appendFileSync(path.join(pd4, "s.jsonl"), JSON.stringify(o) + "\n");
      L({ type: "assistant", timestamp: "2030-01-01T00:00:01.000Z", message: { content: [{ type: "tool_use", id: "ra", name: "Read", input: { file_path: path.join(repo, "fa.md") } }] } });
      L({ type: "user", timestamp: "2030-01-01T00:00:02.000Z", message: { content: [{ type: "tool_result", tool_use_id: "ra", is_error: false }] } });
      L({ type: "user", timestamp: "2030-01-01T00:00:03.000Z", message: { content: [{ type: "tool_result", tool_use_id: "w1", is_error: false }] } });
      const sr = WC.scanReads([pd4], new Map([[a, { after: "2030-01-01T00:00:00.000Z", writeIds: ["w1"] }], [b2, { after: "2030-01-01T00:00:00.000Z", writeIds: ["w1"] }]]), 0);
      t("r1 F4:多目标写调用共享完成时刻,完成之前的读不算回读", [...sr.found], []);
      // 已有的 M 义务(撤回前建的)⇒ 一律写清
      const it5 = (await WC.planWriteChecks({ ...prev, armedAt: new Date(Date.now() + 3600e3).toISOString() }, { cwd: repo, home, conf: { debtTable: "docs/gate-debts.md" }, transcriptDirs: [],
        existing: [{ type: WC.TYPES.M, status: "unknown", payload: { path: "(定位不了的写目标)" }, lastResult: { why: "x" } }] }));
      t("M 撤回:已有的 M 义务一律写清(不再挡关账)", it5.items.find((i) => /定位不了/.test(i.path))?.result, "cleared");
      // F2:本批名下已清的 T,文件回到坏内容且不在净 diff 里 ⇒ 重判 open
      W("docs/gate-debts.md", HD + ROW.replace("**≤303**", "") + "\n"); commit("基点就坏");
      const prevF2 = { ...prev, baseCommit: g("rev-parse", "HEAD").stdout.trim() };
      const it2All = (await WC.planWriteChecks(prevF2, { cwd: repo, home, conf: { debtTable: "docs/gate-debts.md" }, transcriptDirs: [],
        existing: [{ type: WC.TYPES.T, status: "cleared", payload: { path: "docs/gate-debts.md" } }] }));
      const it2 = it2All.items.find((i) => i.type === WC.TYPES.T);
      t("r1 F2(判定保留,只进提示):已清的 T、文件回到坏内容 ⇒ 重判仍点名(提示),不产生 T 义务", [it2?.result ?? null, it2All.hints.some((h) => /^T\(只提示/.test(h))], [null, true]);
      W("docs/gate-debts.md", HD + ROW + "\n"); commit("修回");
      // F1:memory 受管目录按调用方项目配置定(目标在另一个 git 仓里也照查)
      const ext = path.join(tmpRoot, "extmem"); fs.mkdirSync(path.join(ext, ".git"), { recursive: true });
      const gi = R("gate-install.json");
      W("gate-install.json", JSON.stringify({ format: "gate-install/v1", debtTable: "docs/gate-debts.md", memoryDirs: ["mem", "../extmem"] }));
      const v1 = await WC.preWriteJudge({ tool_name: "Write", session_id: "s", cwd: repo, tool_input: { file_path: path.join(ext, "rule.md"), content: MEM("以后一律先跑自测。") } }, { repoRoot: repo });
      t("r1 F1:目标在另一个 git 仓(全局 memory 形)⇒ 按调用方项目的 memoryDirs 照查、拒", v1.kind === "MF" && !!v1.deny, true);
      W("gate-install.json", gi);
    }

    // ── 合并前两猎手回件(主会话处置 B1–B8)的夹具 ─────────────────────────────────────────
    {
      // B3:仓内相对 memoryDirs 同时按当前 checkout 根解析
      const main = path.resolve("/w/main"), wt = path.resolve("/w/main/.claude/worktrees/x");
      t("BP-3:仓内相对 memoryDirs 同时按主树与当前 checkout 解析;.. 起头的只按主树", WC.resolveMemoryDirs([".claude/agent-memory", "../dot/memory"], main, path.resolve("/h"), wt).map(WC.pkey),
        [WC.pkey(path.join(main, ".claude", "agent-memory")), WC.pkey(path.join(wt, ".claude", "agent-memory")), WC.pkey(path.resolve(main, "..", "dot", "memory"))]);
      // B4:改道目录不在系统临时目录下 ⇒ 不认
      const o1 = process.env.GATE_HOOK_GUARD_SELFTEST, o2 = process.env.WRITE_CHECKS_LEDGER_DIR;
      process.env.GATE_HOOK_GUARD_SELFTEST = "1"; process.env.WRITE_CHECKS_LEDGER_DIR = path.resolve("/not-temp/ledger");
      const lfA = WC.ledgerFiles(repo).prehash;
      process.env.WRITE_CHECKS_LEDGER_DIR = path.join(os.tmpdir(), "wc-ok");
      const lfB = WC.ledgerFiles(repo).prehash;
      if (o1 === undefined) delete process.env.GATE_HOOK_GUARD_SELFTEST; else process.env.GATE_HOOK_GUARD_SELFTEST = o1;
      if (o2 === undefined) delete process.env.WRITE_CHECKS_LEDGER_DIR; else process.env.WRITE_CHECKS_LEDGER_DIR = o2;
      t("BP-4:台账改道只在自测标志 + 改道目录在系统临时目录下时生效", [WC.pkey(lfA).startsWith(WC.pkey(path.join(repo, ".claude")) + "/"), WC.pkey(lfB).startsWith(WC.pkey(path.join(os.tmpdir(), "wc-ok")) + "/")], [true, true]);
      // B8:新引入的列数异常行 ⇒ 写前拒,给转义写法
      const v8 = await WC.preWriteJudge({ tool_name: "Edit", session_id: "s", cwd: repo, tool_input: { file_path: path.join(repo, "docs", "gate-debts.md"), old_string: ROW, new_string: ROW + "\n| D959 | 用了 a|b 的描述 | 301 | ≤304 | c | d |" } }, { repoRoot: repo });
      t("FB-8:写前拒新引入的列数异常行,消息给反斜杠竖线 / 反引号写法", [v8.kind, !!v8.deny && /反斜杠竖线/.test(v8.deny)], ["T", true]);
      const v8b = await WC.preWriteJudge({ tool_name: "Edit", session_id: "s", cwd: repo, tool_input: { file_path: path.join(repo, "docs", "gate-debts.md"), old_string: ROW, new_string: ROW + "\n| (待编号) | 新债 | 301 | 待定 | c | d |" } }, { repoRoot: repo });
      t("窄版:「(待编号)」行不查(已知漏放,登债)⇒ 写前不拒", !!v8b.deny, false);
      // B6:J 写前层不管别的 git 仓里的 AGENTS.md
      const other = path.join(tmpRoot, "otherrepo"); fs.mkdirSync(path.join(other, ".git"), { recursive: true });
      fs.writeFileSync(path.join(other, "AGENTS.md"), "# x\n闸规矩:`docs/gate/AGENTS.md`。\n" + BODY);
      const v6 = await WC.preWriteVerdict({ tool_name: "Edit", session_id: "s", cwd: repo, tool_input: { file_path: path.join(other, "AGENTS.md"), old_string: "# x", new_string: "# x\n`scripts/no-such.mjs`" } }, { repoRoot: repo });
      t("FB-6:目标在别的 git 仓的 AGENTS.md ⇒ J 不判", v6.deny, null);
      // B7:没有基点 ⇒ T 按此刻文件判(坏 ⇒ open),仓里没有 AGENTS.md ⇒ J 不判
      fs.mkdirSync(path.join(other, "docs"), { recursive: true }); fs.rmSync(path.join(other, "AGENTS.md"));
      fs.writeFileSync(path.join(other, "docs", "gate-debts.md"), HD + "| D960 | x | 1 |  | c | d |\n");
      const p7 = await WC.planWriteChecks({ armedAt: new Date().toISOString(), baseCommit: null }, { cwd: other, home, conf: { debtTable: "docs/gate-debts.md" }, transcriptDirs: [] });
      t("FB-7:没有基点 ⇒ T 按此刻文件判(只提示、不判 unknown);没有 AGENTS.md ⇒ 没有 J 项", [p7.hints.some((h) => /^T\(只提示[^\n]*D960/.test(h)), p7.items.some((i) => i.type === WC.TYPES.J || i.type === WC.TYPES.T)], [true, false]);
      // B5:仓外 memory 不按 mtime 认领;只认本 checkout 写前层的记录
      const ext2 = path.join(tmpRoot, "extmem2"); fs.mkdirSync(ext2, { recursive: true });
      const conf5 = { debtTable: "docs/gate-debts.md", memoryDirs: ["mem", "../extmem2"] };
      fs.writeFileSync(path.join(ext2, "shell.md"), MEM("以后一律先跑自测。"));   // shell 写,没有写前记录
      const p5 = await WC.planWriteChecks(prev, { cwd: repo, home, conf: conf5, transcriptDirs: [] });
      t("FB-5:仓外 memory 的 shell 写入(无写前记录)⇒ 不产生义务,只提示", [p5.items.some((i) => /extmem2/.test(i.path)), p5.hints.some((h) => /extmem2.*shell\.md|shell\.md/.test(h))], [false, true]);
      const gi5 = R("gate-install.json");
      W("gate-install.json", JSON.stringify({ format: "gate-install/v1", debtTable: "docs/gate-debts.md", memoryDirs: ["mem", "../extmem2"] }));
      const v5 = await WC.preWriteVerdict({ tool_name: "Write", session_id: "s", tool_use_id: "m5", cwd: repo, tool_input: { file_path: path.join(ext2, "tool.md"), content: MEM("以后一律先跑自测。\n执行面:scripts/batch-goal.mjs") } }, { repoRoot: repo });
      fs.writeFileSync(path.join(ext2, "tool.md"), MEM("以后一律先跑自测。"));   // 工具写入后又被 shell 改坏(本 checkout 的写前层留了 seen)
      const p5b = await WC.planWriteChecks(prev, { cwd: repo, home, conf: conf5, transcriptDirs: [] });
      t("窄版 MF:仓外 memory 一律只提示(工具写后又被 shell 改坏也不进义务)", [v5.deny, p5b.items.some((i) => /tool\.md$/.test(i.path)), p5b.hints.some((h) => /tool\.md/.test(h))], [null, false, true]);
      // codex 合并审 r1 ②:失败的尝试(old_string 找不到 / Write 被写前拒)不认领——seen 记了写前哈希,此刻内容没变
      fs.writeFileSync(path.join(ext2, "old.md"), MEM("旧规则,没有执行面。"));
      const futureArm = { ...prev, armedAt: new Date(Date.now() - 1000).toISOString() };
      await WC.preWriteVerdict({ tool_name: "Edit", session_id: "s", tool_use_id: "m6", cwd: repo, tool_input: { file_path: path.join(ext2, "old.md"), old_string: "没有这串", new_string: "x" } }, { repoRoot: repo });
      const v6b = await WC.preWriteJudge({ tool_name: "Write", session_id: "s", tool_use_id: "m7", cwd: repo, tool_input: { file_path: path.join(ext2, "old.md"), content: MEM("以后一律先跑自测。") } }, { repoRoot: repo });
      const p6 = await WC.planWriteChecks(futureArm, { cwd: repo, home, conf: conf5, transcriptDirs: [] });
      t("合并审②:失败的尝试(old_string 找不到、Write 被写前拒)⇒ 不认领仓外 memory、不产生 MF", [!!v6b.deny, p6.items.some((i) => /old\.md$/.test(i.path))], [true, false]);
      // codex 合并审 r1 ③:仓外 memory 目录扫描失败 ⇒ 一条 UNKNOWN,不许返回空
      const extF = path.join(tmpRoot, "extfile"); fs.writeFileSync(extF, "我是文件不是目录");
      const p7b = await WC.planWriteChecks(futureArm, { cwd: repo, home, conf: { debtTable: "docs/gate-debts.md", memoryDirs: ["mem", "../extfile"] }, transcriptDirs: [] });
      t("窄版 MF:仓外 memory 根读不了(是文件)⇒ 只提示、不进义务", [p7b.items.some((i) => i.type === WC.TYPES.MF), p7b.hints.some((h) => /extfile/.test(h))], [false, true]);
      // codex 合并审 r1 ⑤:属于目标且超过 2MB ⇒ 不读、放行并出声(warn)
      const big = HD + ROW + "\n" + ("| D990 | " + "x".repeat(200) + " | 1 | ≤9 | c | d |\n").repeat(12000);
      W("docs/gate-debts.md", big);
      const v9 = await WC.preWriteVerdict({ tool_name: "Edit", session_id: "s", cwd: repo, tool_input: { file_path: path.join(repo, "docs", "gate-debts.md"), old_string: "**≤303**", new_string: "" } }, { repoRoot: repo });
      t("合并审⑤:债表超过 2MB ⇒ 写前不读、放行、warn 出声", [v9.deny, v9.warn, /2MB/.test(String(v9.note))], [null, true, true]);
      W("docs/gate-debts.md", HD + ROW + "\n");
      W("gate-install.json", gi5);
    }

    // ── ④⑤ 义务账落笔:首次 unknown 就建记录、连续判不了可转欠账;带入义务被重判(不因不在改过集合里当清)──────────
    {
      const dir = fs.mkdtempSync(path.join(tmpRoot, "obl-"));
      const key = { batch: "500", armedAt: "a" };
      const pl = { items: [{ type: WC.TYPES.T, path: "(写入类取证)", result: "unknown", why: "x" }] };
      for (let i = 0; i < 3; i++) OB.mutateStore(dir, (d) => WC.applyWriteChecks(d, { baseCommit: "b" }, pl, key, {}));
      const recs = OB.readStore(dir).obligations;
      t("义务账:首次 unknown 就建记录;连续 3 次 ⇒ 可 --settle(转欠账出路走得通)", [recs.length, recs[0].status, recs[0].unknownStreak, OB.settleEligible(recs[0])], [1, "unknown", 3, true]);
      OB.mutateStore(dir, (d) => WC.applyWriteChecks(d, { baseCommit: "b" }, { items: [{ type: WC.TYPES.T, path: "(写入类取证)", result: "cleared", why: "y" }] }, key, {}));
      t("义务账:取证跑成了 ⇒ 已清只由取证写", OB.readStore(dir).obligations[0].status, "cleared");
    }
    {
      // 带入的 T 义务:本批没改债表,但债表此刻仍坏 ⇒ 重判仍 open(不因不在改过集合里就清)
      W("docs/gate-debts.md", HD + ROW.replace("**≤303**", "") + "\n"); commit("坏表进基点");
      const prev2 = { ...prev, baseCommit: g("rev-parse", "HEAD").stdout.trim() };
      const items = (await WC.planWriteChecks(prev2, { cwd: repo, home, conf: { debtTable: "docs/gate-debts.md" }, transcriptDirs: [pd],
        existing: [{ type: WC.TYPES.T, status: "open", payload: { path: "docs/gate-debts.md" } }] })).items;
      t("带入的 T 义务:拒绝撤回 ⇒ 写清(此刻仍坏只进提示)", items.find((i) => i.type === WC.TYPES.T)?.result, "cleared");
      W("docs/gate-debts.md", HD + ROW + "\n"); commit("修好");
    }

    // ── ⑥ Stop 上:T / J / MF / M 四条收尾规则批 308 已删(原先只记账),本层照旧;MF 判据件改从 MF_JUDGE 取 ─────────
    {
      const { RULES, MF_JUDGE } = await import("./gate-rules.mjs");
      t("308:T / J / MF / M 不再是收尾规则(本层的写前 / 关账取证不受影响)", ["T", "J", "MF", "M"].filter((id) => RULES.some((y) => y.id === id)), []);
      t("308:loadMF 取到的是 gate-rules 的 MF_JUDGE", (await WC.loadMF()) === MF_JUDGE, true);
    }
  } catch (e) {
    fail++; console.log(`FAIL  自测抛错:${e && e.stack || e}`);
  } finally {
    if (oldProj === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = oldProj;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清不掉不判 */ }
  }
  console.log(`\n自测 ${pass}/${pass + fail}`);
  return fail ? 1 : 0;
}

{
  const canon = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
  if (process.argv[1] && canon(fileURLToPath(import.meta.url)) === canon(process.argv[1])) process.exit(await selfTest());
}
