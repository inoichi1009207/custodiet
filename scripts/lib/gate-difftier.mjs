// gate-difftier.mjs —— 承重面改动按 git diff 事实分档(批 257 条件 3)的**唯一实现**
//
// 要解决的事:P 项(承重面三通道)对「只改了测试」的批次照样要跨模型与联网。条件 3 原文:
//   「只改注释、文案、测试的提交免跨模型与联网」。分档只看**事实**(git 的改动文件清单),不看提交信息、不看正文怎么说。
//
// 只有「测试」一类分档(注释与文案两类按用户 10-10 裁定不分档):
//   ① 「注释」:Q1-A 不分档——本仓宪法把判据与执行细节放在**工装头注**里,改头注就是改规则。
//   ② 「文案」:Q2-B 先签后撤——按同音混用字对查表的实现被红队实测打穿(AGENTS.md「不得凭记忆施工」→「不的…」
//      判成错别字),单字替换分不出笔误与改规则;用户裁定撤销(「其实不可能有错别字,因为都是 ai 写的」,D144)。
//
// 轻档 = 承重面里**每个**改动文件都是测试文件:文件名为 `*.test.*` / `*.spec.*` / `*.selftest.mjs`,或在 `.nlpm-test/` 下;
//   只认新增与修改,且新内容读得到。目录名(tests/、fixtures/)不算——目录证明不了用途(codex c3 L5)。
//   删除、改名、复制、类型变更一律重档;改名的新旧路径任一端在承重面就参与判档(codex c3 L6)。
// 其余一律重档。误拦与漏放同价:重档的每一类都写在呈签单里,裁了就补成轻档。
// 轻档只免「跨模型」与「联网」两条;独立视角(grill / 闸引擎面的红队)照欠,D11 不受影响。

export const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$|\.selftest\.mjs$|(^|\/)\.nlpm-test\/[^/]+$/i;

/**
 * 分档。facts = { files: [{ path, oldPath?, status, readable }] } | null;isCarrier(path) 判承重面(注入,避免循环依赖)。
 *   status:git --name-status 的状态串(A/M/D/R100/C…);readable = 新内容读得到。
 * 返回 { light: boolean, reasons: [{ path, tier, why }] };facts 缺失或承重面一个文件都没改 ⇒ light=false。
 */
export function classifyDiffTier(facts, isCarrier = () => true) {
  const reasons = [];
  if (!facts || !Array.isArray(facts.files)) return { light: false, reasons: [{ path: "*", tier: "heavy", why: "diff 事实取不到" }] };
  const norm = (p) => String(p || "").replace(/\\/g, "/");
  const files = facts.files.filter((f) => f && typeof f.path === "string" && (isCarrier(norm(f.path)) || (f.oldPath && isCarrier(norm(f.oldPath)))));
  if (!files.length) return { light: false, reasons: [{ path: "*", tier: "heavy", why: "承重面无改动(不分档)" }] };
  for (const f of files) {
    const p = norm(f.path);
    const st = String(f.status || "").charAt(0).toUpperCase();
    if (st !== "A" && st !== "M") reasons.push({ path: p, tier: "heavy", why: `状态 ${f.status || "?"}(删除/改名/复制/类型变更)` });
    else if (TEST_NAME.test(p)) reasons.push(f.readable === true ? { path: p, tier: "light", why: "测试文件" } : { path: p, tier: "heavy", why: "内容读不到" });
    else reasons.push({ path: p, tier: "heavy", why: "不是测试文件" });
  }
  return { light: reasons.every((r) => r.tier === "light"), reasons };
}

/** 分档事实要覆盖本批全部承重写入(红队 c3 BP-7):写在别的 checkout(worktree / 别的仓)的承重件,
 *  不在 hook 所在 checkout 的 diff 里 ⇒ 事实不全 ⇒ 不分档。writes = 绝对或相对路径;root = 事实所属仓根。 */
export function coversWrites(facts, writes, isCarrier = () => true) {
  if (!facts || !facts.root) return false;
  // 路径归一:分隔符、/d/ 形、大小写、重复斜杠、`.` 与 `..` 段(codex 终审 F2:`lib/../lib/x` 与 `//` 曾被当成另一个文件)
  const lc = (s) => {
    const t = String(s || "").replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/").toLowerCase();
    const lead = /^([a-z]:)?\//.exec(t)?.[0] ?? "";
    const parts = [];
    for (const seg of t.slice(lead.length).split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { parts.pop(); continue; }
      parts.push(seg);
    }
    return lead + parts.join("/");
  };
  const root = lc(facts.root).replace(/\/+$/, "");
  const have = new Set((facts.files || []).map((f) => `${root}/${lc(f.path)}`));
  for (const w of writes || []) {
    const n = lc(w);
    const abs = /^([a-z]:)?\//.test(n) ? n : `${root}/${n.replace(/^\.\//, "")}`;
    const inside = abs.startsWith(root + "/");
    if (!isCarrier(inside ? abs.slice(root.length + 1) : n)) continue;
    if (!inside) return false;                          // 别的 checkout
    if (!have.has(abs)) return false;                   // 本 checkout 的 diff 里没有这次写入(已还原?)
  }
  return true;
}

export function selfTest() {
  const t = [];
  const chk = (n, got, want) => t.push([JSON.stringify(got) === JSON.stringify(want) ? "PASS" : "FAIL", n, `实得 ${JSON.stringify(got)}`]);
  const tier = (files) => classifyDiffTier({ files }).light;
  const M = (path, extra = {}) => ({ path, status: "M", readable: true, ...extra });

  chk("测试文件改动 ⇒ 轻", tier([M("scripts/codex-run.selftest.mjs")]), true);
  chk("新增测试文件 ⇒ 轻", tier([{ path: ".nlpm-test/x.spec.md", status: "A", readable: true }]), true);
  chk("*.test.mjs ⇒ 轻", tier([M("scripts/lib/a.test.mjs")]), true);
  chk("fixtures/ 目录下的模块 ⇒ 重(目录证明不了用途)", tier([M("scripts/lib/fixtures/policy.mjs")]), false);
  chk("tests/ 目录下的普通文件 ⇒ 重", tier([M(".claude/skills/x/tests/run.mjs")]), false);
  chk("测试文件读不到 ⇒ 重", tier([M("scripts/a.test.mjs", { readable: false })]), false);
  chk("测试文件删除 ⇒ 重", tier([{ path: "scripts/a.test.mjs", status: "D", readable: false }]), false);
  chk("改名 ⇒ 重", tier([{ path: "scripts/b.test.mjs", oldPath: "scripts/a.test.mjs", status: "R100", readable: true }]), false);
  chk("代码文件只改注释 ⇒ 重(头注即规则,待裁)", tier([M("scripts/hook-x.mjs")]), false);
  chk("法典只动标点 ⇒ 重(待裁)", tier([M("docs/laws/collab.md")]), false);
  chk("一轻一重 ⇒ 整批重", tier([M("scripts/x.selftest.mjs"), M("docs/laws/collab.md")]), false);

  chk("文档改动一律重档(用户 10-10 裁:文案类撤销)", tier([M("docs/laws/collab.md", { old: "认真的读", new: "认真地读" })]), false);
  chk("facts 缺失 ⇒ 重", classifyDiffTier(null).light, false);
  const carrier = (p) => !/^src\//.test(p);
  chk("承重面无改动 ⇒ 不分档(重)", classifyDiffTier({ files: [M("src/a.ts")] }, carrier).light, false);
  chk("非承重文件不参与判档", classifyDiffTier({ files: [M("src/a.ts"), M("scripts/x.selftest.mjs")] }, carrier).light, true);
  chk("改名移出承重面:旧路径在承重面 ⇒ 参与判档(重)",
    classifyDiffTier({ files: [{ path: "src/gate-policy.mjs", oldPath: "scripts/lib/gate-policy.mjs", status: "R100", readable: true }, M("scripts/x.selftest.mjs")] }, carrier).light, false);

  const facts = { root: "/repo", files: [M("scripts/x.selftest.mjs")] };
  chk("写入覆盖:本仓测试文件写入在 diff 里 ⇒ 覆盖", coversWrites(facts, ["\\repo\\scripts\\x.selftest.mjs"]), true);
  chk("写入覆盖:相对路径也认", coversWrites(facts, ["scripts/x.selftest.mjs"]), true);
  chk("写入覆盖:`..` 与重复斜杠归一后同一文件", coversWrites(facts, ["/repo/scripts/lib/../x.selftest.mjs", "/repo//scripts/x.selftest.mjs", "/repo/scripts/x.selftest.mjs"]), true);
  chk("写入覆盖:worktree 里的承重写入 ⇒ 不覆盖", coversWrites(facts, ["/repo/.claude/worktrees/w1/AGENTS.md"].map((x) => x.replace("/repo/.claude/worktrees/w1", "E:/elsewhere")), () => true), false);
  chk("写入覆盖:本仓写过但 diff 里没有(已还原)⇒ 不覆盖", coversWrites(facts, ["/repo/AGENTS.md"]), false);
  chk("写入覆盖:非承重写入不管", coversWrites(facts, ["/repo/src/a.ts"], carrier), true);
  chk("写入覆盖:事实没有仓根 ⇒ 不覆盖", coversWrites({ files: [] }, []), false);

  let pass = 0;
  for (const [r, n, extra] of t) { console.log(`  ${r}  ${n}${r === "FAIL" ? "  ← " + extra : ""}`); if (r === "PASS") pass++; }
  console.log(`\n分档自测 ${pass}/${t.length}`);
  return pass === t.length;
}

const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
if (IS_MAIN && process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
