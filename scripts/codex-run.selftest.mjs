// codex-run.selftest.mjs — codex-run.mjs 的离线自测集(038 批)。
//
// 全部离线,**零 codex 调用**。硬要求:必须含反向用例——只测正向等于没测
// (memory prompt-id-atomic-alloc-023 的实撞教训)。
// 反向用例 = ③④⑤(沙箱旗标 / --add-dir / 非法 mode 必须被拒且退出码正确)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  parseArgs,
  deriveSlug,
  resolveResultPath,
  resolveRepoBrief,
  extractThreadId,
  buildCodexArgs,
  classifyOutcome,
  formatJobBlock,
  codexDefaultModel,
  resultHeader,
  hooksConfigWarn,
  copyDrift,
} from "./codex-run.mjs";
import { pathToFileURL } from "node:url";

export async function runSelfTest({ self }) {
  let pass = 0;
  const fails = [];
  const t = (name, fn) => {
    try {
      fn();
      pass++;
    } catch (e) {
      fails.push(`${name}: ${e && e.message ? e.message : e}`);
    }
  };
  const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || "不等"} — 实得 ${JSON.stringify(a)},期望 ${JSON.stringify(b)}`);
  };
  const run = (args) => spawnSync(process.execPath, [self, ...args], { windowsHide: true, encoding: "utf8" });

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-selftest-"));
  // 被测副本本身(变异验收改的是 self;静态 import 拿到的是原件)。批 257 起新增用例一律走它
  const selfMod = await import(pathToFileURL(self).href);

  // ① --task 缺失 ⇒ 非零退出且文案可读
  t("① --task 缺失", () => {
    const r = run([]);
    if (r.status === 0) throw new Error("应非零退出");
    if (!/缺 --task/.test(r.stderr)) throw new Error(`文案不可读:${r.stderr}`);
  });

  // ② 任务文件不存在 ⇒ 非零退出
  t("② 任务文件不存在", () => {
    const r = run(["--task", path.join(sandbox, "没有这个文件.md")]);
    if (r.status === 0) throw new Error("应非零退出");
    if (!/任务文件不存在/.test(r.stderr)) throw new Error(`文案不可读:${r.stderr}`);
  });

  // ③ 2026-09-05 用户裁定「先暂时把沙箱打开」:`--sandbox workspace-write` 是显式可选项,须被**接受**
  //   (接受后照常走到「任务文件不存在」⇒ exit 1);非法值与短形态 -s 照旧 exit 2。
  t("③ --sandbox workspace-write 被接受(走到任务文件检查)", () => {
    const r = run(["--sandbox", "workspace-write", "--task", "x.md"]);
    eq(r.status, 1, "退出码应为 1(任务文件不存在)");
    if (!/任务文件不存在/.test(r.stderr)) throw new Error(`文案不可读:${r.stderr}`);
  });
  t("③c【反向】--sandbox 非法值被拒", () => {
    eq(run(["--sandbox", "danger", "--task", "x.md"]).status, 2, "退出码应为 2");
  });
  t("③d【反向】--sandbox 缺值被拒(不吞下一个旗标)", () => {
    eq(run(["--sandbox", "--task", "x.md"]).status, 2, "退出码应为 2");
  });
  t("③b【反向】-s 短形态同样被拒", () => {
    eq(run(["-s", "read-only", "--task", "x.md"]).status, 2, "退出码应为 2");
  });

  // ④【反向】--add-dir ⇒ exit 2(笼外零暴露)
  t("④【反向】--add-dir 被拒", () => {
    const r = run(["--add-dir", sandbox, "--task", "x.md"]);
    eq(r.status, 2, "退出码应为 2");
  });
  t("④b【反向】--dangerously-* 被拒", () => {
    eq(run(["--dangerously-bypass-approvals-and-sandbox", "--task", "x.md"]).status, 2, "退出码应为 2");
  });

  // ⑤【反向】research 已整支移除 ⇒ --mode 现在必须是**未知参数**,不得被静默吞掉。
  // 这条封的是「删功能时删了实现却留了入口」那个缺口:入口还在就等于功能还在。
  t("⑤【反向】--mode 已不再是合法参数", () => {
    const r = run(["--mode", "research", "--task", "x.md"]);
    if (r.status === 0) throw new Error("应非零退出");
    if (!/未知参数 --mode/.test(r.stderr)) throw new Error(`拒因不对:${r.stderr}`);
  });
  t("⑤b【反向】旧背书环境变量不再有任何效力", () => {
    const r = spawnSync(process.execPath, [self, "--mode", "research", "--task", "x.md"], { windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, CODEX_RESEARCH_CAGE_ATTESTED: "1" },
    });
    if (r.status === 0) throw new Error("设了旧变量也不该放行");
    if (!/未知参数 --mode/.test(r.stderr)) throw new Error(`拒因不对:${r.stderr}`);
  });

  // ⑥ --slug 缺省推导
  t("⑥ slug 缺省推导", () => {
    eq(deriveSlug("/a/b/probe-audit.md"), "probe-audit");
    eq(deriveSlug("/a/b/probe-audit.md", "自定 名"), "自定-名");
  });

  // ⑦ r<n> 递增
  t("⑦ r<n> 递增", () => {
    const cwd = path.join(sandbox, "proj");
    fs.mkdirSync(path.join(cwd, "clipboard"), { recursive: true });
    const a = resolveResultPath({ cwd, slug: "s", id: "JA" });
    eq(path.basename(a.file), "s-r1.md");
    // v6(红队 BP-2/9):发起即占位——不等 done 写盘,紧接着的同 slug 发起也拿不到同一个 n
    if (!/JA/.test(fs.readFileSync(a.file, "utf8"))) throw new Error("r1 未被占位");
    const b = resolveResultPath({ cwd, slug: "s", id: "JB" });
    eq(path.basename(b.file), "s-r2.md");
    eq(a.fellBack, false);
  });

  // ⑧ clipboard/ 不在场 ⇒ 退回临时目录并被标记
  t("⑧ clipboard 缺席时落点回退", () => {
    const cwd = path.join(sandbox, "bare");
    fs.mkdirSync(cwd, { recursive: true });
    const r = resolveResultPath({ cwd, slug: "s" });
    eq(r.fellBack, true, "应标记为回退");
    fs.rmSync(r.file, { force: true });                     // 占位落在系统临时目录,自测不留垃圾
    if (r.file.startsWith(cwd)) throw new Error("回退落点不该在项目内");
  });

  // ⑩ repo-brief 三级探测 + 全缺席
  t("⑩ repo-brief 三级探测", () => {
    const mk = (rel) => {
      const cwd = fs.mkdtempSync(path.join(sandbox, "rb-"));
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), "x");
      return cwd;
    };
    eq(resolveRepoBrief(mk(path.join("clipboard", "codex-repo-brief.md"))), path.join("clipboard", "codex-repo-brief.md"));
    eq(resolveRepoBrief(mk(path.join("docs", "repo-brief.md"))), path.join("docs", "repo-brief.md"));
    eq(resolveRepoBrief(mk("AGENTS.md")), "AGENTS.md");
    eq(resolveRepoBrief(fs.mkdtempSync(path.join(sandbox, "empty-"))), null, "全缺席应回 null 且不抛错");
  });

  // ⑪ 优先序:三者同在时取 clipboard/codex-repo-brief.md
  t("⑪ repo-brief 优先序", () => {
    const cwd = fs.mkdtempSync(path.join(sandbox, "rb-all-"));
    for (const rel of [path.join("clipboard", "codex-repo-brief.md"), path.join("docs", "repo-brief.md"), "AGENTS.md"]) {
      fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), "x");
    }
    eq(resolveRepoBrief(cwd), path.join("clipboard", "codex-repo-brief.md"));
  });

  // ⑫ 缺省沙箱 read-only:不点名 workspace-write 时,参数向量里不得出现写/越权旗标
  t("⑫ 缺省沙箱 read-only", () => {
    const args = buildCodexArgs({ cwdForCodex: "/p", lastMsgFile: "/t" }).join(" ");
    if (!/-s read-only/.test(args)) throw new Error("应为 read-only");
    if (/workspace-write|network_access|--add-dir|dangerously/.test(args)) {
      throw new Error(`不得带写/越权旗标:${args}`);
    }
    // 反向:即使调用方硬塞一个 mode 字段进来,也不该改变沙箱
    const forced = buildCodexArgs({ mode: "research", cwdForCodex: "/p", lastMsgFile: "/t" }).join(" ");
    if (!/-s read-only/.test(forced) || /workspace-write/.test(forced)) {
      throw new Error("函数签名已不认 mode,塞了也不该生效");
    }
  });
  t("⑫b 用户点名 --sandbox workspace-write ⇒ 参数向量才带它;其余值一律回落 read-only", () => {
    const ww = selfMod.buildCodexArgs({ cwdForCodex: "/p", lastMsgFile: "/t", sandbox: "workspace-write" }).join(" ");
    if (!/-s workspace-write/.test(ww) || /-s read-only/.test(ww)) throw new Error(`应为 workspace-write:${ww}`);
    const odd = selfMod.buildCodexArgs({ cwdForCodex: "/p", lastMsgFile: "/t", sandbox: "danger-full-access" }).join(" ");
    if (!/-s read-only/.test(odd)) throw new Error(`非法值应回落 read-only:${odd}`);
    eq(selfMod.parseArgs(["--sandbox", "workspace-write", "--task", "a.md"]).sandbox, "workspace-write");
  });

  // ⑬ thread-id 三名都认
  t("⑬ thread-id 提取", () => {
    eq(extractThreadId('{"thread_id":"abc"}'), "abc");
    eq(extractThreadId('{"session_id":"def"}'), "def");
    eq(extractThreadId('{"conversation_id":"ghi"}'), "ghi");
    eq(extractThreadId("{}"), null);
  });

  // ⑭ parseArgs 缺值不静默
  t("⑭ 参数缺值", () => {
    let threw = false;
    try { parseArgs(["--task"]); } catch { threw = true; }
    if (!threw) throw new Error("--task 缺值应抛错");
  });

  // ⑮ 批 257:空正文判失败——判原始 body 的 trim(),不看退出码、不按字数
  t("⑮ 空正文 ⇒ failed empty-body(退出码 0 也算)", () => {
    for (const body of ["", "  \n\t", "﻿", "\r\n"]) {
      const o = classifyOutcome({ code: 0, body });
      eq(o.state, "failed", `body=${JSON.stringify(body)}`);
      eq(o.errorCode, "empty-body", `body=${JSON.stringify(body)}`);
    }
    eq(classifyOutcome({ code: 1, body: "" }).errorCode, "empty-body", "非零退出 + 空正文同码");
  });
  t("⑮b【反向】一句「无发现」不空 ⇒ done", () => {
    eq(classifyOutcome({ code: 0, body: "无发现" }).state, "done");
    eq(classifyOutcome({ code: 0, body: "报告见 clipboard/review.md" }).state, "done");
  });
  t("⑮c 现存分支照旧:退出码非 0 但正文非空 ⇒ done", () => {
    eq(classifyOutcome({ code: 1, body: "部分结论……" }).state, "done");
  });

  // ⑯ 批 257:所有返回都以 CODEX_JOB=<id> 开头(收尾闸按它进账/归属 poll)
  t("⑯ 四种返回形态都带 CODEX_JOB 与 CODEX_STATE", () => {
    const forms = [
      [formatJobBlock({ id: "J1", state: "done", result: "/r.md" }), "done"],
      [formatJobBlock({ id: "J1", state: "failed", errorCode: "empty-body", error: "x" }, { log: "/l.log" }), "failed"],
      [formatJobBlock({ id: "J1", state: "running", result: "/r.md" }, { kind: "launch", log: "/l.log" }), "background"],
      [formatJobBlock({ id: "J1", state: "running" }, { kind: "poll" }), "running"],
    ];
    for (const [s, st] of forms) {
      if (!s.startsWith("CODEX_JOB=J1\n")) throw new Error(`首行不是 CODEX_JOB:${JSON.stringify(s)}`);
      if (!s.includes(`\nCODEX_STATE=${st}\n`)) throw new Error(`缺 CODEX_STATE=${st}:${JSON.stringify(s)}`);
    }
    if (!forms[1][0].includes("CODEX_ERROR_CODE=empty-body")) throw new Error("failed 缺 CODEX_ERROR_CODE");
    if (!forms[2][0].includes("CODEX_POLL=")) throw new Error("background 缺 CODEX_POLL 交接行");
    if (forms[0][0].includes("CODEX_POLL=")) throw new Error("done 不该带 CODEX_POLL");
    // 批 257 红队 BP-5:`| tail -1` 截尾后仍要带得出 J ⇒ 每种形态的末行都是 CODEX_END=<id>
    for (const [s] of forms) {
      const last = s.trim().split("\n").pop();
      if (last !== "CODEX_END=J1") throw new Error(`末行不是 CODEX_END=J1:${JSON.stringify(last)}`);
    }
  });
  // 批 285 D131②:hooks 配置解析失败 ⇒ 台账 warn + 机器块 CODEX_WARN;末行仍是 CODEX_END
  t("285 D131② 日志里 hooks 配置解析失败 ⇒ 给提示(JSONL 转义路径与 stderr 明文两形)", () => {
    const j = '{"type":"error","message":"failed to parse hooks config E:\\\\test\\\\.codex\\\\hooks.json: unknown field `_cc_bridge_version`"}';
    const w1 = hooksConfigWarn(j);
    if (!w1 || !/hooks\.json/.test(w1)) throw new Error(`JSONL 形未认出:${w1}`);
    const w2 = hooksConfigWarn("ERROR failed to parse hooks config /home/x/.codex/hooks.json: expected value at line 1\n");
    if (!w2 || !/\/home\/x\/\.codex\/hooks\.json\)/.test(w2)) throw new Error(`stderr 形未认出:${w2}`);
  });
  t("285 D131②【反向】没有该错 ⇒ null;块里不出现 CODEX_WARN", () => {
    eq(hooksConfigWarn('{"type":"item.completed"}\nhooks loaded\n'), null);
    eq(hooksConfigWarn(""), null);
    if (formatJobBlock({ id: "J1", state: "done", result: "/r.md" }).includes("CODEX_WARN=")) throw new Error("无 warn 不该出 CODEX_WARN");
  });
  t("285 D131② 台账带 warn ⇒ 机器块有 CODEX_WARN 行、末行仍是 CODEX_END", () => {
    const s = formatJobBlock({ id: "J1", state: "done", result: "/r.md", warn: "hooks 坏了" });
    if (!s.includes("\nCODEX_WARN=hooks 坏了\n")) throw new Error(s);
    eq(s.trim().split("\n").pop(), "CODEX_END=J1");
  });
  t("285 D141 双源漂移:不同 ⇒ same=false;相同 ⇒ same=true;就是仓内那支 / 仓内没有 ⇒ null", () => {
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), "codex-drift-"));
    try {
      const runFile = path.join(lab, "user-copy.mjs");
      fs.writeFileSync(runFile, "// a\n");
      eq(copyDrift(runFile, lab), null, "仓内没有副本");
      fs.mkdirSync(path.join(lab, "scripts"));
      const repoFile = path.join(lab, "scripts", "codex-run.mjs");
      fs.writeFileSync(repoFile, "// b\n");
      const d1 = copyDrift(runFile, lab);
      if (!d1 || d1.same !== false || !/--install/.test(d1.text)) throw new Error(JSON.stringify(d1));
      fs.writeFileSync(repoFile, "// a\n");
      eq(copyDrift(runFile, lab).same, true, "内容相同");
      eq(copyDrift(repoFile, lab), null, "运行的就是仓内那支");
    } finally { fs.rmSync(lab, { recursive: true, force: true }); }
  });
  t("285 D141 结果件头部不再替 read-only 打「写被 OS 拒」的包票", () => {
    const h = resultHeader({ codexVersion: "v", sandbox: "read-only" }, null);
    if (/写被 OS 拒/.test(h)) throw new Error(h);
    if (!/未必拦得住写入/.test(h)) throw new Error(h);
  });
  t("⑯b【反向】源码里不得再有绕过 formatJobBlock 的 CODEX_STATE 直写", () => {
    const src = fs.readFileSync(self, "utf8");
    // 认字符串字面量开头的 CODEX_STATE=(旧直写形态 `"CODEX_STATE=background"` / `` `CODEX_STATE=done\n…` ``);
    //   注释里的散文提及以「…」结尾,不算
    const n = (src.match(/["'`]CODEX_STATE=[^…]/g) || []).length;
    eq(n, 1, "CODEX_STATE= 模板只许出现在 formatJobBlock 一处");
  });
  t("⑯c --poll 台账缺失:CODEX_JOB 机器块 + 末行旧口径(`| tail -1` 的轮询循环不被打断),退出 1", () => {
    const id = `selftest-nonexistent-${process.pid}`;
    const r = run(["--poll", id]);
    eq(r.status, 1, "退出码应为 1");
    if (!r.stdout.startsWith(`CODEX_JOB=${id}\nCODEX_STATE=failed`)) throw new Error(`缺机器块:${r.stdout}`);
    const ls = r.stdout.trim().split(/\r?\n/);
    const last = ls.pop();
    if (!last.startsWith(`failed job ${id}`)) throw new Error(`末行不是旧口径:${JSON.stringify(last)}`);
    // 机器块末行恒为 CODEX_END(批 257 红队 BP-5);这里经子进程验,改坏运行副本本身也会红
    if (ls.pop() !== `CODEX_END=${id}`) throw new Error(`机器块末行不是 CODEX_END:${r.stdout}`);
  });

  // ⑰ 批 257 v4:--poll J --wait-ms N 等到终态(BP4-1/BP4-7)。读与睡注入,假时钟,不碰真台账。
  //   从 self 动态导入:变异验收改的是 self 副本,静态 import 拿到的是原件,会让变异逃过
  const { waitForTerminal, POLL_WAIT_CAP_MS } = selfMod;
  const waitCase = async (states, waitMs) => {
    let i = 0, t = 0, reads = 0;
    const job = await waitForTerminal({ read: () => { reads++; return states[Math.min(i++, states.length - 1)]; },
      waitMs, sleep: async (ms) => { t += ms; }, now: () => t });
    return { job, reads, t };
  };
  const w1 = await waitCase([{ state: "running" }, { state: "running" }, { state: "done" }], 60000);
  t("⑰ --wait-ms:running 两次后 done ⇒ 等到 done", () => { eq(w1.job.state, "done"); eq(w1.reads, 3); });
  const w2 = await waitCase([{ state: "running" }], 3000);
  t("⑰【反向】一直 running ⇒ 到时限返回 running,不死等", () => { eq(w2.job.state, "running"); if (w2.t > 3000) throw new Error(`睡过头:${w2.t}`); });
  const w3 = await waitCase([null], 60000);
  t("⑰【反向】台账缺失 ⇒ 立即返回,不当作还在跑", () => { eq(w3.job, null); eq(w3.reads, 1); });
  const w4 = await waitCase([{ state: "running" }], 99 * 60 * 1000);
  t("⑰ --wait-ms 上限 10 分钟", () => { if (w4.t > POLL_WAIT_CAP_MS) throw new Error(`超上限:${w4.t}`); });
  t("⑰ --poll 缺失作业带 --wait-ms ⇒ 立即返回 failed(子进程,不碰真台账写)", () => {
    const id = `selftest-wait-${process.pid}`;
    const t0 = Date.now();
    const r = run(["--poll", id, "--wait-ms", "5000"]);
    eq(r.status, 1, "退出码应为 1");
    if (Date.now() - t0 > 4000) throw new Error("缺失作业不该等满 --wait-ms");
  });

  // ⑱ 批 257 v5:runner 交付正文。done ⇒ 结果件全文夹在带 J 的 BODY 块里;failed ⇒ 日志尾部夹在 FAIL 块里;
  //   --wait-ms 到期仍 running ⇒ 退出码 3。读文件注入,不碰真台账;同样从 self 动态导入。
  const { renderOutcome, POLL_EXPIRED_EXIT } = selfMod;
  const files = { "/r.md": "---\n模型: x\n---\n## 结论\n甲方对。\n", "/l.log": Array.from({ length: 60 }, (_, i) => `log${i + 1}`).join("\n") + "\n" };
  const rf = (p) => (p in files ? files[p] : null);
  t("⑱ poll done ⇒ 机器块 + BODY 块(全文原样)+ 末行 done,退出 0", () => {
    const r = renderOutcome({ id: "J1", state: "done", result: "/r.md" }, { kind: "poll", readFile: rf });
    eq(r.code, 0);
    if (!r.out.startsWith("CODEX_JOB=J1\n")) throw new Error(`首行不是 CODEX_JOB:${r.out}`);
    if (!r.out.includes(`\nCODEX_END=J1\nCODEX_BODY_BEGIN=J1\n${files["/r.md"]}CODEX_BODY_END=J1\n`)) throw new Error(`BODY 块不对:${JSON.stringify(r.out)}`);
    eq(r.out.trim().split("\n").pop(), "done /r.md", "末行保持旧口径");
  });
  t("⑱ 前台 done 发起 ⇒ 同样带 BODY 块(无末行)", () => {
    const r = renderOutcome({ id: "J1", state: "done", result: "/r.md" }, { kind: "launch", readFile: rf });
    eq(r.code, 0);
    eq(r.out.trim().split("\n").pop(), "CODEX_BODY_END=J1");
  });
  t("⑱【反向】结果件读不到 ⇒ 不打 BODY 块、退出 1、stderr 说明", () => {
    const r = renderOutcome({ id: "J1", state: "done", result: "/gone.md" }, { kind: "poll", readFile: rf });
    eq(r.code, 1);
    if (/CODEX_BODY_BEGIN/.test(r.out)) throw new Error("读不到正文就不该有 BODY 块");
    if (!/结果件读不到/.test(r.err || "")) throw new Error(`缺 stderr 说明:${r.err}`);
  });
  t("⑱ failed ⇒ FAIL 块装日志末 40 行,退出 1", () => {
    const r = renderOutcome({ id: "J1", state: "failed", error: "x", log: "/l.log" }, { kind: "poll", readFile: rf });
    eq(r.code, 1);
    const m = /CODEX_FAIL_BEGIN=J1\n([\s\S]*?)CODEX_FAIL_END=J1\n/.exec(r.out);
    if (!m) throw new Error(`缺 FAIL 块:${r.out}`);
    if (!m[1].startsWith("log21\n") || !m[1].includes("log60")) throw new Error(`尾部不对:${JSON.stringify(m[1].slice(0, 40))}`);
    eq(r.out.trim().split("\n").pop(), "failed x");
  });
  // v6(codex v5 复核第 2 条):FAIL 块在收尾闸那边等于「日志已送达」,日志读不到就不能发
  t("⑱ failed 日志读不到 ⇒ 不打 FAIL 块,stderr 写明", () => {
    const r = renderOutcome({ id: "J1", state: "failed", error: "x", log: "/none.log" }, { kind: "launch", readFile: rf });
    if (/CODEX_FAIL_BEGIN/.test(r.out)) throw new Error(r.out);
    if (!/日志读不到:\/none\.log/.test(r.err || "")) throw new Error(String(r.err));
    eq(r.code, 1);
  });
  t("⑱ running:普通 poll 退出 0;--wait-ms 到期退出 3;都不打 BODY", () => {
    const a = renderOutcome({ id: "J1", state: "running" }, { kind: "poll", readFile: rf });
    const b = renderOutcome({ id: "J1", state: "running" }, { kind: "poll", readFile: rf, waitExpired: true });
    eq(a.code, 0); eq(b.code, POLL_EXPIRED_EXIT); eq(POLL_EXPIRED_EXIT, 3);
    if (/CODEX_BODY|CODEX_FAIL/.test(a.out + b.out)) throw new Error("running 不该带 BODY/FAIL 块");
    eq(b.out.trim().split("\n").pop(), "running");
  });
  t("⑱ 台账缺失 ⇒ failed job-missing、退出 1、不打 FAIL 块", () => {
    const r = renderOutcome(null, { kind: "poll", id: "JX", readFile: rf });
    eq(r.code, 1);
    if (/CODEX_FAIL_BEGIN/.test(r.out) || !/CODEX_ERROR_CODE=job-missing/.test(r.out)) throw new Error(r.out);
  });

  // ── 红队 a2155edb 附节二①:默认模型只作标签,不参与传参;只读 config 顶层;认 CODEX_HOME ──
  {
    const ch = path.join(sandbox, "codex-home");
    fs.mkdirSync(ch, { recursive: true });
    const cfg = (s) => fs.writeFileSync(path.join(ch, "config.toml"), s, "utf8");
    t("⑲ 默认模型:读 config 顶层 model", () => {
      cfg('model = "gpt-top"\n\n[profiles.fast]\nmodel = "gpt-prof"\n');
      eq(codexDefaultModel({ codexHome: ch }), "gpt-top");
    });
    t("⑲【反向】顶层没有 model ⇒ null(不抓 [profiles.*] 下的)", () => {
      cfg('approval_policy = "never"\n[profiles.fast]\nmodel = "gpt-prof"\n');
      eq(codexDefaultModel({ codexHome: ch }), null);
    });
    t("⑲ 认 CODEX_HOME(没给 codexHome 时取环境变量)", () => {
      cfg("model = 'gpt-env'\n");
      eq(codexDefaultModel({ env: { CODEX_HOME: ch }, home: path.join(sandbox, "nohome") }), "gpt-env");
    });
    t("⑲ 没有 CODEX_HOME ⇒ <home>/.codex", () => {
      const h = path.join(sandbox, "h2");
      fs.mkdirSync(path.join(h, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(h, ".codex", "config.toml"), 'model = "gpt-home"\n', "utf8");
      eq(codexDefaultModel({ env: {}, home: h }), "gpt-home");
    });
    t("⑲ 默认模型不进参数向量(job.model 为空 ⇒ 不传 -m)", () => {
      const a = buildCodexArgs({ cwdForCodex: sandbox, model: null, lastMsgFile: "x" });
      if (a.includes("-m")) throw new Error(a.join(" "));
    });
    t("⑲【反向】源码里 job.model 不得再取 codexDefaultModel()", () => {
      const src = fs.readFileSync(self, "utf8");
      if (/model:\s*opts\.model\s*\|\|\s*codexDefaultModel\(/.test(src)) throw new Error("job.model 又混进了默认模型");
      if (!/modelLabel:\s*opts\.model\s*\?\s*null\s*:\s*codexDefaultModel\(\)/.test(src)) throw new Error("modelLabel 未按「只作标签」写入台账");
    });
    // 结果件头部:收尾闸按「第二个 `---` 之后是正文、第 9 行起」认读回(a2155edb BP-8),行数改了两边一起改
    t("⑳ 结果件头部 8 行、以换行收尾、正文紧接(第 9 行起)", () => {
      const h = resultHeader({ codexVersion: "codex-cli 0", sandbox: "read-only" }, "tid");
      const lines = (h + "BODY").split("\n");
      eq(lines[0], "---"); eq(lines[7], "---"); eq(lines[8], "BODY");
    });
    t("⑳ 头部模型行:显式 model 原样;否则带默认标签", () => {
      const a = resultHeader({ codexVersion: "v", model: "gpt-x" }, null);
      const b = resultHeader({ codexVersion: "v", model: null, modelLabel: "gpt-top" }, null);
      const c = resultHeader({ codexVersion: "v" }, null);
      if (!/模型: gpt-x\n/.test(a)) throw new Error(a);
      if (!/模型: \(codex 默认;config 顶层 model=gpt-top/.test(b)) throw new Error(b);
      if (!/模型: \(codex 默认\)\n/.test(c)) throw new Error(c);
    });
  }

  // ── 批 302(D205 ①②④)────────────────────────────────────────────────────────
  // 防的失败:①「通道不可用」靠日志尾窗事后拼——切在行首 / 来源前缀挤占 / item 半行混进 stderr(D205 ① 三轮形态);
  //   ② `CODEX_BIN` 替身写出完整合格记录而 P 认不出(D205 ②);③ hooks 告警扫到 codex 读到的文件原文(D205 ④)。
  //   (作业记录双写公共目录、发起即建义务两项已按主会话裁定删掉:记录只写 tmpdir,写法同 1781e63。)
  {
    const S = selfMod;
    // 防的失败:codex 内部 exec 子命令在 stderr 留下 ENOTFOUND,而本次失败的真因(顶层事件)与通道无关 ⇒ 不得判不可用(红队 p0-close BP-4)
    t("p0-close BP-4:有顶层失败事件时只看事件,stderr 的 exec 报错不冒充 network", () => {
      const sc = S.makeStreamScanner();
      sc.err("ERROR codex_core::exec: curl: getaddrinfo ENOTFOUND example.invalid\n");
      sc.out('{"type":"turn.failed","error":{"message":"invalid model: gpt-x"}}\n');
      sc.end();
      eq(sc.unavailable(true), null);
    });
    t("p0-close BP-4 对照:没有顶层事件时 stderr 的网络报错照认", () => {
      const sc = S.makeStreamScanner();
      sc.err("ERROR: getaddrinfo ENOTFOUND api.openai.com\n");
      sc.end();
      const u = sc.unavailable(true);
      eq(u && u.reason, "network"); eq(u.source, "stderr");
    });
    // 防的失败:codex 先在 stderr 打真实网络错,再发一个不带原因的泛化 turn.failed("stream error") ⇒ 事件优先把 stderr 整路丢掉、判 null(codex p0-close r2 ③)
    t("p0-close r2 ③:顶层事件只是泛化 stream error ⇒ 回退看 stderr,真网络错照认", () => {
      const sc = S.makeStreamScanner();
      sc.err("ERROR: getaddrinfo ENOTFOUND api.openai.com\n");
      sc.out('{"type":"turn.failed","error":{"message":"stream error: stream disconnected before completion"}}\n');
      sc.end();
      const u = sc.unavailable(true);
      eq(u && u.reason, "network"); eq(u.source, "stderr");
    });
    t("p0-close r2 ③【反向】泛化事件 + 明说原因的事件(配置错)同在 ⇒ 不回退 stderr", () => {
      const sc = S.makeStreamScanner();
      sc.err("ERROR codex_core::exec: curl: getaddrinfo ENOTFOUND example.invalid\n");
      sc.out('{"type":"error","message":"stream error: retrying"}\n{"type":"turn.failed","error":{"message":"invalid model: gpt-x"}}\n');
      sc.end();
      eq(sc.unavailable(true), null);
    });
    t("b302 BP-1:只有配置告警事件 + stderr 网络错 ⇒ 回退 stderr,判 network(告警不算「明说了别的原因」)", () => {
      const sc = S.makeStreamScanner();
      sc.err("ERROR: getaddrinfo ENOTFOUND api.openai.com\n");
      sc.out('{"type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}\n');
      sc.end();
      const u = sc.unavailable(true);
      eq(u && u.reason, "network"); eq(u.source, "stderr");
    });
    t("b302 BP-1:配置告警 + 泛化 turn.failed + stderr 429 ⇒ rate-limit(stderr)", () => {
      const sc = S.makeStreamScanner();
      sc.err("ERROR: exceeded retry limit, last status: 429 Too Many Requests\n");
      sc.out('{"type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}\n{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}\n');
      sc.end();
      const u = sc.unavailable(true);
      eq(u && u.reason, "rate-limit"); eq(u.source, "stderr");
    });
    t("b302 BP-1【反向】配置告警 + 明说原因的事件(模型名错)+ stderr 网络噪声 ⇒ 仍是 null", () => {
      const sc = S.makeStreamScanner();
      sc.err("ERROR codex_core::exec: curl: getaddrinfo ENOTFOUND example.invalid\n");
      sc.out('{"type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}\n{"type":"turn.failed","error":{"message":"invalid model: gpt-x"}}\n');
      sc.end();
      eq(sc.unavailable(true), null);
    });
    t("302 D205①:turn.failed 里 429 ⇒ unavailable.rate-limit(source=event)", () => {
      const sc = S.makeStreamScanner();
      sc.out('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.failed","error":{"message":"exceeded retry limit, last status: 429 Too Many Requests"}}\n');
      sc.end();
      const u = sc.unavailable(true);
      eq(u && u.reason, "rate-limit"); eq(u.source, "event");
    });
    t("302 D205①【反向】429 只出现在 item 事件(codex 读到的债表原文)⇒ null", () => {
      const sc = S.makeStreamScanner();
      sc.out('{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"D205 429 Too Many Requests rate limit"}}\n');
      sc.end();
      eq(sc.unavailable(true), null);
    });
    t("302 D205①:stdout 事件行跨 chunk 拆开、stderr 半行跨 chunk ⇒ 拼好再判(不把 item 半截当 stderr)", () => {
      const sc = S.makeStreamScanner();
      sc.out('{"type":"item.completed","item":{"type":"agent_message","text":"see 4');
      sc.err("ERROR: getaddrinfo ENOT");
      sc.out('29 rate limit"}}\n');
      sc.err("FOUND api.openai.com\n");
      sc.end();
      const u = sc.unavailable(true);
      eq(u && u.reason, "network"); eq(u.source, "stderr");
    });
    t("302 D205①【反向】作业没失败 ⇒ 不写 unavailable(中途 429 重试成功)", () => {
      const sc = S.makeStreamScanner();
      sc.out('{"type":"error","message":"429 Too Many Requests, retrying"}\n'); sc.end();
      eq(sc.unavailable(false), null);
    });
    t("302 r1:超过 4 MB 还没换行的半行不拿来分类(直到换行都丢弃)", () => {
      const sc = S.makeStreamScanner();
      sc.err("x".repeat(4 * 1024 * 1024 + 10) + " rate limit");
      eq(sc.unavailable(true), null, "未换行的超长半行");
      sc.err(" 仍是那一行的尾巴 429\nERROR: getaddrinfo ENOTFOUND api.openai.com\n"); sc.end();
      eq((sc.unavailable(true) || {}).reason, "network", "换行之后的完整行照判");
    });
    t("302 r1:作业被硬截止杀掉(timedOut)⇒ 早先出现过 429 也不写 unavailable", () => {
      const sc = S.makeStreamScanner();
      sc.out('{"type":"error","message":"429 Too Many Requests, retrying"}\n'); sc.end();
      eq(sc.unavailable(true, true), null);
      eq((sc.unavailable(true, false) || {}).reason, "rate-limit");
    });
    t("302 D205①【反向】配置告警 / 超时不算不可用", () => {
      eq(S.classifyUnavailable("Codex is ignoring 1 unrecognized configuration setting `rate_limit`"), null);
      eq(S.classifyUnavailable("command timed out after 10000ms"), null);
      eq(S.classifyUnavailable("You've hit your usage limit"), "quota");
    });
    t("302 D205④:hooks 告警只扫 stderr / 非 JSON 行;item 里的原文不触发", () => {
      const a = S.makeStreamScanner();
      a.out('{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"failed to parse hooks config E:/x/hooks.json: bad"}}\n'); a.end();
      eq(S.hooksConfigWarn(a.nonItemText()), null);
      const b = S.makeStreamScanner();
      b.err("ERROR failed to parse hooks config E:/x/hooks.json: expected value\n"); b.end();
      if (!S.hooksConfigWarn(b.nonItemText())) throw new Error("stderr 形未认出");
    });
    t("302 D205②:CODEX_BIN 指向在场文件 ⇒ source=env;否则不是 env", () => {
      const save = process.env.CODEX_BIN;
      try {
        process.env.CODEX_BIN = self; eq(S.resolveCodexBin().source, "env");
        delete process.env.CODEX_BIN; if (S.resolveCodexBin().source === "env") throw new Error("没设 CODEX_BIN 却报 env");
      } finally { if (save === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = save; }
    });
    // 端到端:临时仓(带闸库标记)里真发起一次,CODEX_BIN 指向 node 本身(必失败、零 codex 调用)
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-302-"));
    const repo = path.join(lab, "repo");
    const g = (args, cwd = repo) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: lab } });
    fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
    g(["init", "-q"]);
    const libSrc = path.join(path.dirname(self), "lib");
    for (const f of ["obligations.mjs", "ledger-chain.mjs"]) fs.copyFileSync(path.join(libSrc, f), path.join(repo, "scripts", "lib", f));   // 装了闸的仓:旧版会在这里双写公共目录
    // 批 305:发车前查任务书 ⇒ 这里的任务书用骨架本身(顺带钉住「骨架能过真实发车那道检查」)
    fs.writeFileSync(path.join(repo, "task.md"), typeof S.taskbookSkeleton === "function" ? S.taskbookSkeleton("design") : "x\n");
    const env = { ...process.env, CODEX_BIN: process.execPath, GIT_CEILING_DIRECTORIES: lab };
    const r = spawnSync(process.execPath, [self, "--task", path.join(repo, "task.md"), "--out", path.join(lab, "r.md"), "--cwd", repo, "--wait-ms", "60000"], { encoding: "utf8", windowsHide: true, env, cwd: repo });
    const J = (/CODEX_JOB=(\S+)/.exec(r.stdout || "") || [])[1];
    process.stdout.write(`  [302] 自测临时仓 = ${repo}(须在系统临时目录下、不在 /repo 下)\n`);
    t("302 自测仓不在 /repo 下", () => { if (/^[\\/]repo([\\/]|$)/i.test(repo)) throw new Error(repo); });
    t("302 D205②:CODEX_BIN 替身发起 ⇒ tmpdir 作业记录 binSource=env、终态 failed、unavailable=null", () => {
      if (!J) throw new Error(`没拿到 J:${(r.stdout || "") + (r.stderr || "")}`);
      const rec = JSON.parse(fs.readFileSync(path.join(S.JOB_ROOT, `${J}.json`), "utf8"));
      eq(rec.binSource, "env"); eq(rec.state, "failed"); eq(rec.unavailable, null);
    });
    t("302【反向】作业记录只写 tmpdir:装了闸的仓里也没有 .claude/.codex-jobs、没有义务账", () => {
      for (const d of [".codex-jobs", ".obligations"]) if (fs.existsSync(path.join(repo, ".claude", d))) throw new Error(`临时仓里出现了 .claude/${d}`);
    });
    t("302 --poll 读 tmpdir 那份", () => {
      const p = spawnSync(process.execPath, [self, "--poll", J], { encoding: "utf8", windowsHide: true, env, cwd: repo });
      if (!/CODEX_STATE=failed/.test(p.stdout || "")) throw new Error(p.stdout + p.stderr);
    });
    // 批 305:--no-taskbook-check 整体豁免——不合格的任务书照发;跳过只记在作业台账,结果件头部仍是 8 行
    //   (codex 305-int r1 第 1 条:多一行会让收尾闸「第 9 行起是正文」的兜底把头部分隔符当成读过的正文)
    fs.writeFileSync(path.join(repo, "bare.md"), "x\n");
    const r2 = spawnSync(process.execPath, [self, "--task", path.join(repo, "bare.md"), "--no-taskbook-check", "--out", path.join(lab, "skip.md"), "--cwd", repo, "--wait-ms", "60000"], { encoding: "utf8", windowsHide: true, env, cwd: repo });
    t("305 --no-taskbook-check:不合格的任务书照发(有 CODEX_JOB);结果件头部 8 行、第 9 行起是正文", () => {
      if (!/^CODEX_JOB=\S+/m.test(r2.stdout || "")) throw new Error(`没发车:${(r2.stdout || "") + (r2.stderr || "")}`);
      const head = fs.readFileSync(path.join(lab, "skip.md"), "utf8");
      if (/任务书检查/.test(head)) throw new Error(`头部不该多行:${JSON.stringify(head.slice(0, 400))}`);
      eq(head.split("\n")[7], "---", "第 8 行是头部收尾的 ---");
    });
    t("305【反向】正常过检的发起:结果件头部没有「任务书检查」行(头部仍是 8 行)", () => {
      const head = fs.readFileSync(path.join(lab, "r.md"), "utf8");
      if (/任务书检查/.test(head)) throw new Error(JSON.stringify(head.slice(0, 400)));
      eq(head.split("\n")[7], "---", "第 8 行应是收尾的 ---");
    });
    // 批 305 回修:每次发车的检查结果记进作业台账(过 / 跳过);--no-taskbook-check 连提醒也不要
    const recOf = (out) => { const j = (/CODEX_JOB=(\S+)/.exec(out || "") || [])[1]; return j ? JSON.parse(fs.readFileSync(path.join(S.JOB_ROOT, `${j}.json`), "utf8")) : null; };
    t("305 回修 台账:过检的发车记 taskbookCheck=pass、不带 taskbookFailed;stderr 没有提醒", () => {
      const rec = recOf(r.stdout); if (!rec) throw new Error("没拿到作业记录");
      eq(rec.taskbookCheck, "pass"); eq("taskbookFailed" in rec, false);
      if (/任务书检查/.test(r.stderr || "")) throw new Error(r.stderr);
    });
    t("305 回修 台账:--no-taskbook-check 记 taskbookCheck=skipped;连提醒也不打", () => {
      const rec = recOf(r2.stdout); if (!rec) throw new Error("没拿到作业记录");
      eq(rec.taskbookCheck, "skipped"); eq("taskbookFailed" in rec, false);
      if (/任务书检查/.test(r2.stderr || "")) throw new Error(`跳过时不该提醒:${r2.stderr}`);
    });
    try { fs.rmSync(lab, { recursive: true, force: true }); } catch { /* worker 可能还占着日志 */ }
  }

  // ── 批 305 乙包:发车前查任务书 / 出骨架 / 第二轮起提示先派方向复核 ─────────────────────────
  // 防的失败:任务书没写用途和完成标准、结论选项里没有「不用再审」⇒ 审查者越审越多(同一份稿子审五轮,
  //   第五轮报 27 条、逐条看 0 条要改)。改进办法写在备忘里到不了发车的人眼前,所以接在发车这个必经点上。
  //   检查只看形(有没有这几段、有多长),不判内容。
  {
    const S = selfMod;
    const need = (name) => { if (typeof S[name] === "undefined") throw new Error(`codex-run.mjs 没导出 ${name}`); return S[name]; };
    // 一份合格的设计类任务书(5 行有内容);over 里给 null 就去掉那一行,extra 是插在中间的行
    const TB = (over = {}) => {
      const p = { purpose: "用途:合并前确认安装器不会覆盖用户文件;我会拿结论当合并依据。", done: "完成标准:**照 README 走普通安装,不会丢掉目标仓里的东西。**",
        ask: "请读 diff,先回答一个是非题:**完成标准成立吗?**", last: "最后一行三选一:`可以合并,不用再审` / `有会翻转的,要改` / `判不了`。", extra: [], ...over };
      return ["# 审一个提交(只读)", "", p.purpose, "", p.done, "", p.ask, "", ...p.extra, "", p.last, ""].filter((l) => l != null).join("\n");
    };
    const failed = (res) => res.items.filter((i) => !i.ok).map((i) => i.key).join("");
    const chk = (text, o) => need("checkTaskbook")(text, o);

    t("305 任务书四条齐 ⇒ 过", () => { const r = chk(TB()); eq(r.ok, true, JSON.stringify(r.items)); eq(failed(r), ""); });
    t("305【反向】缺用途 ⇒ 不过,只缺 a", () => { const r = chk(TB({ purpose: null })); eq(r.ok, false); eq(failed(r), "a"); });
    t("305【反向】缺完成标准 ⇒ 不过,只缺 b", () => { const r = chk(TB({ done: null, ask: "请读 diff,判断有没有问题。" })); eq(r.ok, false); eq(failed(r), "b"); });
    t("305【反向】结论选项里没有「不用再审」⇒ 不过,只缺 c", () => {
      const r = chk(TB({ last: "最后一行三选一:`可以合并` / `要改` / `判不了`。" })); eq(r.ok, false); eq(failed(r), "c");
    });
    t("305【反向】「用途」「完成标准」只在句子中间出现、不是一段的开头 ⇒ 不算", () => {
      const r = chk(TB({ purpose: "这份稿子的用途以后再说。", done: "请判断完成标准成立吗。" }));
      eq(failed(r), "ab");
    });
    t("305 「用途」「完成标准」写成标题 / 加粗 / 列表项 ⇒ 认", () => {
      eq(chk(TB({ purpose: "## 用途\n拿结论当合并依据。", done: "**完成标准**:照 README 安装不丢文件。" })).ok, true);
      eq(chk(TB({ purpose: "- 用途:拿结论当合并依据。", done: "> 完成标准:照 README 安装不丢文件。" })).ok, true);
    });
    // 批 305 回修:编号问题只数以问号结尾的编号行 ⇒ 三种编号形态都写成问句(句末带问号)
    const qs = (n) => Array.from({ length: n }, (_, i) => [`${i + 1}. 第 ${i + 1} 处的顺序对吗?`, `(${"abcdefgh"[i]}) 第 ${i + 1} 节是否自洽?`, `${i + 1}) 这一步有没有漏掉条件?`][i % 3]);
    t("305 d:编号问题 5 个 ⇒ 过", () => { const r = chk(TB({ extra: qs(5) })); eq(r.ok, true, JSON.stringify(r.items)); eq(r.questions.length, 5); });
    t("305【反向】d:编号问题 6 个 ⇒ 不过,只缺 d,且报出是哪几行", () => {
      const r = chk(TB({ extra: qs(6) })); eq(failed(r), "d"); eq(r.questions.length, 6);
      const d = r.items.find((i) => i.key === "d");
      if (!/6 个/.test(d.detail) || !/第 \d+/.test(d.detail)) throw new Error(d.detail);
    });
    t("305 d:带编号但不是问题的行(已知差异、被审文件清单)不计入 ⇒ 7 条也过", () => {
      const known = Array.from({ length: 7 }, (_, i) => `${i + 1}. 第 ${i + 1} 处差异是有意的:夹具里的名字换成了中性写法。`);
      const r = chk(TB({ extra: ["已知差异(有意的,不用报):", ...known] })); eq(r.ok, true, JSON.stringify(r.items)); eq(r.questions.length, 0);
    });
    const filler = (n) => Array.from({ length: n }, (_, i) => `- 第 ${i + 1} 条已知的局限,不用报。`);
    t("305 d:有内容的行刚好到上限 ⇒ 过;空行不计", () => {
      const max = need("TASKBOOK_MAX_LINES");
      const r = chk(TB({ extra: filler(max - 5) })); eq(r.lines, max); eq(r.ok, true, JSON.stringify(r.items));
    });
    t("305【反向】d:有内容的行超上限 1 行 ⇒ 不过,只缺 d,报错里写明上限那个数", () => {
      const max = need("TASKBOOK_MAX_LINES");
      const r = chk(TB({ extra: filler(max - 4) })); eq(r.lines, max + 1); eq(failed(r), "d");
      if (!r.items.find((i) => i.key === "d").detail.includes(String(max))) throw new Error("报错里没写上限");
    });
    t("305 --fact-check:核事实类豁免 d(又长又多问也过)", () => {
      const long = TB({ extra: [...qs(8), ...filler(30)] });
      eq(failed(chk(long)), "d", "不带 --fact-check 应卡在 d");
      const r = chk(long, { factCheck: true }); eq(r.ok, true, JSON.stringify(r.items));
    });
    t("305【反向】--fact-check 不豁免 a、b、c", () => {
      eq(failed(chk(TB({ purpose: null, done: null, ask: "请比对两份文件。", last: "最后一行二选一:一致 / 不一致。" }), { factCheck: true })), "abc");
    });
    t("305 英文等价写法(Purpose / Done when / no further review needed)⇒ 过", () => {
      const en = ["# Review one commit (read-only)", "", "Purpose: decide whether this branch can be merged.", "", "Done when: a normal install never deletes files in the target repo.",
        "", "First answer one yes/no question: does the completion criterion hold?", "", "Last line, pick one: `mergeable, no further review needed` / `must change` / `cannot tell`.", ""].join("\n");
      eq(chk(en).ok, true, JSON.stringify(chk(en).items));
      eq(chk(en.replace("Done when:", "Completion criteria:")).ok, true);
      eq(failed(chk(en.replace(", no further review needed", ""))), "c");
    });
    t("305 CRLF 与 BOM 的任务书照常判", () => { eq(chk("﻿" + TB().replace(/\n/g, "\r\n")).ok, true); });
    t("305 新退出码 4,与现有退出码(0 / 1 / 2 / 3)不冲突", () => {
      eq(need("TASKBOOK_CHECK_EXIT"), 4);
      if ([0, 1, 2, S.POLL_EXPIRED_EXIT].includes(S.TASKBOOK_CHECK_EXIT)) throw new Error("撞了现有退出码");
    });

    // 骨架:开头几行稳定逐字;骨架自己必须能过检查
    const FIXED = ["用途:", "完成标准:", "先回答一个是非题:**完成标准成立吗?**", "- 成立:一句话说你怎么验的", "- 不成立:列出会让答案翻转的发现,**至多 5 条**",
      "只收会翻转答案的。", "两类错的代价:", "拿不准的报出来,并写明拿不准在哪。", "最后一行三选一:", "不用再审"];
    t("305 骨架 design:稳定句逐字在场,且自己能过设计类检查", () => {
      const sk = need("taskbookSkeleton")("design");
      for (const s of FIXED) if (!sk.includes(s)) throw new Error(`骨架缺「${s}」`);
      const r = chk(sk); eq(r.ok, true, JSON.stringify(r.items));
    });
    t("305 骨架 fact:稳定句逐字在场,带 --fact-check 能过", () => {
      const sk = need("taskbookSkeleton")("fact");
      for (const s of FIXED) if (!sk.includes(s)) throw new Error(`骨架缺「${s}」`);
      eq(chk(sk, { factCheck: true }).ok, true);
    });
    t("305 --skeleton:只打骨架到 stdout、退出 0、不发车(缺省 = design)", () => {
      const a = run(["--skeleton"]), b = run(["--skeleton", "design"]), c = run(["--skeleton", "fact"]);
      for (const r of [a, b, c]) { eq(r.status, 0); if (/CODEX_JOB=/.test(r.stdout)) throw new Error("出骨架不该发车"); }
      eq(a.stdout, b.stdout, "缺省应等于 design");
      eq(b.stdout, need("taskbookSkeleton")("design")); eq(c.stdout, S.taskbookSkeleton("fact"));
      if (b.stdout === c.stdout) throw new Error("两类骨架不该相同");
    });
    t("305【反向】--skeleton 给了不认识的类型 ⇒ 非零退出,不打骨架", () => {
      const r = run(["--skeleton", "essay"]);
      if (r.status === 0 || /用途/.test(r.stdout)) throw new Error(`应拒:${r.status} ${r.stdout}`);
      if (!/design \| fact/.test(r.stderr)) throw new Error(r.stderr);
    });

    // 子进程:只判不发的入口与真实发车那道检查
    const tbDir = fs.mkdtempSync(path.join(sandbox, "tb-"));
    const put = (name, text) => { const p = path.join(tbDir, name); fs.writeFileSync(p, text, "utf8"); return p; };
    const good = put("good-task.md", TB());
    const MARK = "SELFTEST-MARKER-7f3a";
    const bad = put("bad-task.md", `# 任务:找问题\n\n请仔细审这份稿子,漏报代价很高。${MARK}\n`);
    const longQ = put("long-task.md", TB({ extra: [...qs(8), ...filler(30)] }));
    t("305 --check-taskbook:合格 ⇒ 退出 0,四条逐条打出,不发车", () => {
      const r = run(["--check-taskbook", good]);
      eq(r.status, 0, r.stderr);
      for (const k of ["a ", "b ", "c ", "d "]) if (!new RegExp(`^\\s*${k}`, "m").test(r.stdout)) throw new Error(`没列 ${k}:${r.stdout}`);
      if (/CODEX_JOB=/.test(r.stdout)) throw new Error("只判不发");
    });
    t("305【反向】--check-taskbook:不合格 ⇒ 退出 4,逐条标出哪条不过", () => {
      const r = run(["--check-taskbook", bad]);
      eq(r.status, 4);
      if (!/a [^\n]*不过/.test(r.stdout) || !/b [^\n]*不过/.test(r.stdout) || !/c [^\n]*不过/.test(r.stdout)) throw new Error(r.stdout);
    });
    t("305 --check-taskbook --fact-check:长任务书 d 豁免 ⇒ 0;不带 ⇒ 4", () => {
      eq(run(["--check-taskbook", longQ, "--fact-check"]).status, 0);
      eq(run(["--check-taskbook", longQ]).status, 4);
    });
    t("305【反向】--check-taskbook 文件不存在 ⇒ 退出 1(不是 4)", () => { eq(run(["--check-taskbook", path.join(tbDir, "none.md")]).status, 1); });
    // 发车类用例一律带 CODEX_BIN 替身(node 本身,必失败)+ 短等待:检查哪怕退化成放行,也只会红在这里,不会真调 codex
    //   (本批先红阶段实撞:没带替身、检查还没接线时,这两条把占位任务书真发了出去)
    const runStub = (args) => spawnSync(process.execPath, [self, ...args, "--wait-ms", "20000"], { windowsHide: true, encoding: "utf8", env: { ...process.env, CODEX_BIN: process.execPath } });
    // 批 305 回修(用户裁定「误拦比漏放贵」):发车时只提醒、不拦。对照组 = 同一替身下过检的任务书
    const outBad = path.join(tbDir, "bad-out.md");
    const launchBad = runStub(["--task", bad, "--cwd", tbDir, "--out", outBad]);
    const launchGood = runStub(["--task", good, "--cwd", tbDir, "--out", path.join(tbDir, "good-out.md")]);
    const keysOf = (out) => String(out || "").split(/\r?\n/).map((l) => (/^(CODEX_[A-Z_]+)=/.exec(l) || [])[1]).filter(Boolean).join(",");
    const recOf = (out) => { const j = (/CODEX_JOB=(\S+)/.exec(out || "") || [])[1]; return j ? JSON.parse(fs.readFileSync(path.join(S.JOB_ROOT, `${j}.json`), "utf8")) : null; };
    t("305 回修 发车:任务书不过 ⇒ 照常发车(stdout 有 CODEX_JOB、结果件槽位照占)", () => {
      if (!/^CODEX_JOB=\S+/m.test(launchBad.stdout || "")) throw new Error(`没发车:${launchBad.stdout}${launchBad.stderr}`);
      if (!fs.existsSync(outBad)) throw new Error("结果件槽位没占(没发车)");
    });
    t("305 回修【反向】发车:任务书不过时退出码与过检时相同(从不是 4)、stdout 机器字段同形且不含提醒", () => {
      if (launchBad.status === S.TASKBOOK_CHECK_EXIT) throw new Error("发车不该用退出码 4");
      eq(launchBad.status, launchGood.status, "退出码应与过检时相同");
      eq(keysOf(launchBad.stdout), keysOf(launchGood.stdout), "stdout 机器字段键序列应与过检时相同");
      if (/任务书/.test(launchBad.stdout)) throw new Error("提醒不该进 stdout");
    });
    t("305 回修 发车提醒的 stderr:首行说明只提醒、已照常发车;写明缺哪条 + 四条要求原文 + 怎么补(骨架命令)", () => {
      const e = launchBad.stderr;
      const first = String(e || "").split(/\r?\n/)[0];
      if (!first.startsWith("任务书检查:有 3 条没过(只提醒,不拦;已照常发车)")) throw new Error(first);
      for (const s of ["缺 a", "缺 b", "缺 c"]) if (!e.includes(s)) throw new Error(`stderr 缺「${s}」:${e}`);
      if (/缺 d/.test(e)) throw new Error("这份不长,不该报 d");
      for (const req of need("TASKBOOK_REQUIREMENTS")) if (!e.includes(req)) throw new Error(`四条要求原文没打全:缺「${req.slice(0, 20)}…」`);
      eq(S.TASKBOOK_REQUIREMENTS.length, 4);
      if (!e.includes("--skeleton")) throw new Error("没告诉怎么补");
      if (/任务书检查/.test(launchGood.stderr || "")) throw new Error("过检时不该提醒");
    });
    t("305 回修【反向】提醒不被收尾闸认成参数错误:首行不以「拒绝入参」开头,收尾闸的 CODEX_ARG_ERROR 整段都不命中", () => {
      const first = String(launchBad.stderr || "").split(/\r?\n/)[0];
      if (/^拒绝入参/.test(first)) throw new Error(first);
      // 与收尾闸的 CODEX_ARG_ERROR 同一认法(那边改了这里要跟):车真的发了,不能被当成「不是发起」
      const hook = fs.readFileSync(new URL("./hook-stop-closure.mjs", import.meta.url), "utf8");
      const m = /const CODEX_ARG_ERROR = (\/.*\/);/.exec(hook);
      if (!m) throw new Error("收尾闸里找不到 CODEX_ARG_ERROR");
      const re = new Function(`return ${m[1]}`)();
      if (re.test(launchBad.stderr)) throw new Error("收尾闸的 CODEX_ARG_ERROR 把这次提醒认成了参数错误");
      for (const k of ["a", "b", "c", "d"]) {   // 每条单独没过的提醒文字也核一遍(d 的补法文字最长)
        const res = { ok: false, items: S.checkTaskbook(TB()).items.map((i) => ({ ...i, ok: i.key !== k })) };
        if (re.test(S.taskbookWarnText(res, "x.md"))) throw new Error(`缺 ${k} 的提醒命中了 CODEX_ARG_ERROR`);
      }
    });
    t("305 回修 台账:不过的发车记 taskbookCheck=warn + taskbookFailed=没过的条目", () => {
      const rec = recOf(launchBad.stdout); if (!rec) throw new Error("没拿到作业记录");
      eq(rec.taskbookCheck, "warn"); eq(JSON.stringify(rec.taskbookFailed), JSON.stringify(["a", "b", "c"]));
      const ok = recOf(launchGood.stdout); eq(ok && ok.taskbookCheck, "pass");
    });
    t("305 回修 结果件头部不因提醒加行(收尾闸按第 9 行认正文)", () => {
      const head = fs.readFileSync(outBad, "utf8");
      if (/任务书检查/.test(head.split("\n").slice(0, 8).join("\n"))) throw new Error(JSON.stringify(head.slice(0, 400)));
      eq(head.split("\n")[0], "---"); eq(head.split("\n")[7], "---", "第 8 行是头部收尾的 ---");
    });
    t("305【反向】提醒文字不劝人绕过(不提 --no-taskbook-check)、不回显任务书内容", () => {
      if (/--no-taskbook-check/.test(launchBad.stderr)) throw new Error("提醒里不该递绕过旗标");
      if ((launchBad.stderr + launchBad.stdout).includes(MARK)) throw new Error("回显了任务书内容");
    });
    t("305 回修 发车:设计类过长 ⇒ 照常发车、只提醒 d;提醒里指到 --fact-check;--fact-check 下不提醒、记 pass", () => {
      const r = runStub(["--task", longQ, "--cwd", tbDir, "--out", path.join(tbDir, "long-out.md")]);
      if (!/^CODEX_JOB=/m.test(r.stdout || "")) throw new Error("没发车");
      eq(r.status, launchGood.status);
      if (!/缺 d/.test(r.stderr) || /缺 [abc]/.test(r.stderr)) throw new Error(r.stderr);
      if (!r.stderr.includes("--fact-check")) throw new Error("没指到 --fact-check");
      eq(JSON.stringify(recOf(r.stdout).taskbookFailed), JSON.stringify(["d"]));
      const f = runStub(["--task", longQ, "--fact-check", "--cwd", tbDir, "--out", path.join(tbDir, "long-fact-out.md")]);
      if (/任务书检查/.test(f.stderr || "")) throw new Error(f.stderr);
      eq(recOf(f.stdout).taskbookCheck, "pass");
    });
    t("305 回修 taskbookLedger:pass / warn+没过的条目 / skipped;--resume 不记(与改前同形)", () => {
      const L = need("taskbookLedger");
      eq(JSON.stringify(L("check", S.checkTaskbook(TB()))), JSON.stringify({ taskbookCheck: "pass" }));
      eq(JSON.stringify(L("check", S.checkTaskbook(TB({ purpose: null })))), JSON.stringify({ taskbookCheck: "warn", taskbookFailed: ["a"] }));
      eq(JSON.stringify(L("skipped", null)), JSON.stringify({ taskbookCheck: "skipped" }));
      eq(JSON.stringify(L("resume", null)), "{}");
      eq(JSON.stringify(L("check", null)), "{}", "读不了任务书 ⇒ 不记、不拦");
    });
    t("305 哪些入口查任务书:只有不带 --resume、不带 --no-taskbook-check 的 --task 发车", () => {
      const mode = need("taskbookMode");
      eq(mode(S.parseArgs(["--task", "a.md"])), "check");
      eq(mode(S.parseArgs(["--task", "a.md", "--fact-check"])), "check");
      eq(mode(S.parseArgs(["--task", "a.md", "--resume", "tid"])), "resume");
      eq(mode(S.parseArgs(["--task", "a.md", "--no-taskbook-check"])), "skipped");
      eq(S.parseArgs(["--task", "a.md", "--fact-check"]).factCheck, true);
    });
    t("305 --poll 不受任务书检查影响(缺失作业照旧退出 1,不是 4)", () => { eq(run(["--poll", `selftest-305-${process.pid}`]).status, 1); });
    t("305(codex 305-int r1 第 1 条)结果件头部恒为 8 行:跳过检查与否都一样(收尾闸按第 9 行认正文)", () => {
      const skip = S.resultHeader({ codexVersion: "v", taskbookCheck: "skipped" }, "t");
      const dft = S.resultHeader({ codexVersion: "v" }, "t");
      eq(skip, dft, "跳过检查不改头部");
      eq(dft.split("\n").length, 9, "头部 8 行 + 收尾换行");
    });

    // 第二轮起:--poll 取到 done 时提示先派方向复核
    const files2 = { "/c/x-r1.md": "---\n---\n一轮\n", "/c/x-r2.md": "---\n---\n二轮\n", "/c/x-r12.md": "---\n---\n十二轮\n", "/c/l.log": "boom\n" };
    const rf2 = (p) => (p in files2 ? files2[p] : null);
    const hintOf = (n) => `这是同一份东西的第 ${n} 轮回件:分拣之前先派 \`_direction-judge\`,只给它用户原话、完成标准、现状、回件,不写你的倾向。`;
    t("305 第 2 轮 poll done ⇒ 提示放进 note(走 stderr);stdout 与第 1 轮同形、逐字不含提示", () => {
      const r = S.renderOutcome({ id: "J1", state: "done", result: "/c/x-r2.md" }, { kind: "poll", readFile: rf2 });
      eq(r.code, 0);
      eq(r.note, hintOf(2) + "\n");
      eq(r.out, "CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=/c/x-r2.md\nCODEX_END=J1\nCODEX_BODY_BEGIN=J1\n---\n---\n二轮\nCODEX_BODY_END=J1\ndone /c/x-r2.md\n", "stdout 不含提示");
      if (/^CODEX_/.test(hintOf(2))) throw new Error("提示行不能以 CODEX_ 开头(会被当成机器字段)");
    });
    t("305 轮次取文件名里的 n(r12 ⇒ 第 12 轮)", () => {
      const r = S.renderOutcome({ id: "J1", state: "done", result: "/c/x-r12.md" }, { kind: "poll", readFile: rf2 });
      eq(r.note, hintOf(12) + "\n");
    });
    t("305(codex r1 第 1 条)前台结束的第 2 轮:stdout 末行仍是 CODEX_BODY_END=<id>(`| tail -1` 取得到作业号)", () => {
      const r = S.renderOutcome({ id: "J1", state: "done", result: "x-r2.md" }, { kind: "launch", readFile: () => "x" });
      const ls = r.out.trimEnd().split("\n");
      eq(ls[ls.length - 1], "CODEX_BODY_END=J1");
      if (!r.note || !r.note.includes("_direction-judge")) throw new Error("提示要在 note 里");
    });
    t("305(codex r1 第 1 条)子进程:提示先于 stdout 写到 stderr,`2>&1` 合流后末行仍是原来那一行", () => {
      const src = fs.readFileSync(new URL("./codex-run.mjs", import.meta.url), "utf8");
      const body = src.slice(src.indexOf("function emit(r)"), src.indexOf("function emit(r)") + 600);
      const iNote = body.indexOf("r.note"), iOut = body.indexOf("process.stdout.write(r.out)");
      if (!(iNote > 0 && iOut > 0 && iNote < iOut)) throw new Error("emit 必须先写 note(stderr)再写 stdout");
    });
    t("305(codex r1 第 2 条)长单行不回溯:10 万个 * 在 1 秒内判完", () => {
      const t0 = Date.now();
      S.checkTaskbook("*".repeat(100000));
      S.checkTaskbook("用途:x\n" + "_".repeat(100000) + "\n");
      const ms = Date.now() - t0;
      if (ms > 1000) throw new Error(`耗时 ${ms}ms`);
    });
    t("305(codex r1 第 3 条)中文问号与全角括号:6 个「1. 如何实现?」⇒ 计 6 个问题、不过", () => {
      const base = "用途:x\n完成标准:x\n不用再审\n";
      const zh = S.checkTaskbook(base + Array.from({ length: 6 }, (_, i) => `${i + 1}. 如何实现？`).join("\n"));
      eq(zh.questions.length, 6); eq(zh.ok, false);
      const paren = S.checkTaskbook(base + Array.from({ length: 6 }, (_, i) => `（${i + 1}）这样对吗？`).join("\n"));
      eq(paren.questions.length, 6);
    });
    // 批 305 回修:三处已复现的认法
    t("305 回修 段首:中文数字序号「## 一、用途 / ## 二、完成标准」+「可以用,无需再审」⇒ 过", () => {
      const r = S.checkTaskbook("# 审一个提交\n\n## 一、用途\n合并前确认。\n\n## 二、完成标准\n照 README 安装不丢文件。\n\n最后一行:`可以用,无需再审` / `要改`。\n");
      eq(r.ok, true, JSON.stringify(r.items));
    });
    t("305 回修 段首:括号 / 圈号序号、【】、表格行都认", () => {
      const ok = (purpose, done) => S.checkTaskbook(`${purpose}\n${done}\n不用再审\n`).ok;
      eq(ok("(1) 用途:x", "(2) 完成标准:x"), true, "半角括号");
      eq(ok("（一）用途:x", "（二）完成标准:x"), true, "全角括号 + 中文数字");
      eq(ok("① 用途:x", "② 完成标准:x"), true, "圈号");
      eq(ok("【用途】x", "**【完成标准】**x"), true, "方头括号(含加粗)");
      eq(ok("| 用途 | 合并依据 |", "| **完成标准** | 不丢文件 |"), true, "表格行");
      eq(ok("十二、用途:x", "3、完成标准:x"), true, "十二、/ 3、");
    });
    t("305 回修【反向】段首:「用途」仍要在段首(序号后接正文、表格非首列、句中提到都不算)", () => {
      const fails = (line) => S.checkTaskbook(`${line}\n完成标准:x\n不用再审\n`).items.find((i) => i.key === "a").ok === false;
      eq(fails("一、本次用途:x"), true, "序号后不是用途开头");
      eq(fails("| 字段 | 用途 |"), true, "表格非首列");
      eq(fails("这份稿子的用途以后再说。"), true, "句中");
      eq(fails("一用途:x"), true, "中文数字后没有顿号");
    });
    t("305 回修 「不用再审」的同义:无需 / 不必 / 不需要再审 都认;「还要再审」不认", () => {
      for (const w of ["不用再审", "无需再审", "不必再审", "不需要再审"]) eq(S.checkTaskbook(`用途:x\n完成标准:x\n${w}\n`).ok, true, w);
      eq(S.checkTaskbook("用途:x\n完成标准:x\n还要再审\n").ok, false);
    });
    t("305 回修 编号问题只数以问号结尾的:带「是否 / 有没有」的编号陈述句不计;句末问号后跟加粗 / 代码 / 引号仍计", () => {
      const base = "用途:x\n完成标准:x\n不用再审\n";
      const stmts = ["1. 核对两份文件是否一致。", "2. 看有没有漏掉的条目", "3) 能否复现写进表里", "(a) 列出会不会翻转的", "4. 对不对得上都记下", "5. whether it holds, note it", "6. 结论写成「吗」字句也不算"];
      const r = S.checkTaskbook(base + stmts.join("\n"));
      eq(r.questions.length, 0, JSON.stringify(r.questions)); eq(r.ok, true);
      const q = S.checkTaskbook(base + ["1. **完成标准成立吗?**", "2. 这样对吗?`", "3. 「是否一致？」", "4. 漏了没有? ", "(b) 顺序对吗?)", "6) 还有吗?"].join("\n"));
      eq(q.questions.length, 6, JSON.stringify(q.questions)); eq(q.ok, false);
      eq(S.checkTaskbook(base + "1. 问号在中间? 后面还有话").questions.length, 0, "问号不在行尾不计");
    });
    t("305 回修 新认法不回溯:竖线 / 括号序号 / 方头括号 / 问号后长串 在 1 秒内判完", () => {
      const t0 = Date.now();
      S.checkTaskbook("| ".repeat(50000));
      S.checkTaskbook("(1)" + "*".repeat(100000));
      S.checkTaskbook("【".repeat(100000));
      S.checkTaskbook("1. " + "?*".repeat(50000) + "x");
      S.checkTaskbook("一" + "、".repeat(100000));
      const ms = Date.now() - t0;
      if (ms > 1000) throw new Error(`耗时 ${ms}ms`);
    });
    t("305【反向】第 1 轮 ⇒ 不加提示", () => {
      const r = S.renderOutcome({ id: "J1", state: "done", result: "/c/x-r1.md" }, { kind: "poll", readFile: rf2 });
      if (/_direction-judge/.test(r.out)) throw new Error(r.out);
      eq(r.out, "CODEX_JOB=J1\nCODEX_STATE=done\nCODEX_RESULT=/c/x-r1.md\nCODEX_END=J1\nCODEX_BODY_BEGIN=J1\n---\n---\n一轮\nCODEX_BODY_END=J1\ndone /c/x-r1.md\n", "第 1 轮输出与改前逐字相同");
    });
    t("305 前台立即结束的发起带结果、第 2 轮 ⇒ 同样提示(在 note 里)", () => {
      const r = S.renderOutcome({ id: "J1", state: "done", result: "/c/x-r2.md" }, { kind: "launch", readFile: rf2 });
      eq(r.note, hintOf(2) + "\n");
      if (r.out.includes("_direction-judge")) throw new Error("stdout 不该带提示");
    });
    t("305【反向】第 2 轮但还在跑 / 失败 / 结果件读不到 / 文件名不带 r<n> ⇒ 都不加提示", () => {
      const outs = [
        S.renderOutcome({ id: "J1", state: "running", result: "/c/x-r2.md" }, { kind: "poll", readFile: rf2 }),
        S.renderOutcome({ id: "J1", state: "failed", error: "x", log: "/c/l.log", result: "/c/x-r2.md" }, { kind: "poll", readFile: rf2 }),
        S.renderOutcome({ id: "J1", state: "done", result: "/c/gone-r2.md" }, { kind: "poll", readFile: rf2 }),
        S.renderOutcome({ id: "J1", state: "done", result: "/r.md" }, { kind: "poll", readFile: rf }),
      ];
      for (const o of outs) if (/_direction-judge/.test(o.out + (o.note || ""))) throw new Error(o.out);
    });
  }

  // ── 批 309 C-6:模型不可用 ⇒ 备用模型原样重发一次 ───────────────────────────────
  //   防的失败:后端报 model_not_found 时作业直接失败、人得改配置再发一次;以及反方向——codex 读到的文件里写着 model_not_found
  //   (item 事件)、或别的失败,被当成模型不可用而白重发。端到端用例的 codex 替身是 node 跑临时仓里一个叫 `exec` 的脚本,零 codex 调用。
  {
    const S = selfMod;
    t("309 C-6:classifyModelMissing 认 model_not_found 与「model … does not exist」;配置告警 / 限流 / 空串不认", () => {
      eq(S.classifyModelMissing('{"error":{"code":"model_not_found","message":"x"}}'), "model_not_found");
      eq(S.classifyModelMissing("The model `gpt-x` does not exist or you do not have access to it."), "model-unavailable");
      eq(S.classifyModelMissing("unrecognized configuration key model_not_found_hint"), null);
      eq(S.classifyModelMissing("429 Too Many Requests"), null);
      eq(S.classifyModelMissing(""), null);
    });
    t("309 C-6:扫描器只认顶层错误事件与 stderr 行;item 事件(codex 读到的文件)里的 model_not_found 不算", () => {
      const a = S.makeStreamScanner();
      a.out(JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "model_not_found" } }) + "\n");
      a.end();
      eq(a.modelMissing(), null, "item 事件");
      const b = S.makeStreamScanner();
      b.out(JSON.stringify({ type: "turn.failed", error: { message: "model_not_found: The model `bad` does not exist" } }) + "\n");
      b.end();
      eq(b.modelMissing() && b.modelMissing().reason, "model_not_found", "顶层事件");
      const c = S.makeStreamScanner();
      c.err("ERROR: unexpected status 404 Not Found: {\"error\":{\"code\":\"model_not_found\"}}\n");
      c.end();
      eq(c.modelMissing() && c.modelMissing().source, "stderr", "stderr 行");
    });
    t("309 C-6:备用模型取值——环境变量优先、其次 gate-install.json 的 codexFallbackModel;带空白 / 空串 / 读不了 ⇒ null", () => {
      const rf = (obj) => () => JSON.stringify(obj);
      eq(JSON.stringify(S.fallbackModelFrom({ env: { CODEX_RUN_FALLBACK_MODEL: "m-env" }, cwd: "/x", readFile: rf({ codexFallbackModel: "m-cfg" }) })), JSON.stringify({ model: "m-env", source: "env" }));
      eq(JSON.stringify(S.fallbackModelFrom({ env: {}, cwd: "/x", readFile: rf({ format: "gate-install/v1", codexFallbackModel: "m-cfg" }) })), JSON.stringify({ model: "m-cfg", source: "config" }));
      eq(S.fallbackModelFrom({ env: { CODEX_RUN_FALLBACK_MODEL: "a b" }, cwd: "/x", readFile: rf({}) }), null);
      eq(S.fallbackModelFrom({ env: {}, cwd: "/x", readFile: rf({ codexFallbackModel: "" }) }), null);
      eq(S.fallbackModelFrom({ env: {}, cwd: "/x", readFile: () => { throw new Error("ENOENT"); } }), null);
    });
    t("309 C-6:没配备用模型的提示写明两处配法", () => {
      const h = S.fallbackHint();
      if (!/CODEX_RUN_FALLBACK_MODEL/.test(h) || !/codexFallbackModel/.test(h)) throw new Error(h);
    });
    // 端到端:codex 替身 = node 跑 <临时仓>/exec(node 把 argv[0]=exec 当脚本、按 cwd 解析)。-m 以 bad 开头 ⇒ stderr 报 model_not_found 退出 1;
    //   否则写 -o 指的最终消息、stdout 打 thread_id、退出 0。每次被调在 calls.txt 记一行模型名。
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-309-"));
    const repo = path.join(lab, "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "exec"), [
      "const fs = require('fs'); const path = require('path');",
      "const a = process.argv.slice(2); const at = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };",
      "const m = at('-m') || '(default)'; fs.appendFileSync(path.join(process.cwd(), 'calls.txt'), m + '\\n');",
      "process.stdin.resume(); process.stdin.on('end', () => {",
      "  if (/^bad/.test(m)) { process.stderr.write('ERROR: unexpected status 404: {\"error\":{\"code\":\"model_not_found\",\"message\":\"The model ' + m + ' does not exist\"}}\\n'); process.exit(1); }",
      "  fs.writeFileSync(at('-o'), 'fake body from ' + m + '\\n'); process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread-309' }) + '\\n'); process.exit(0);",
      "});",
    ].join("\n"));
    fs.writeFileSync(path.join(repo, "task.md"), "x\n");
    const baseEnv = { ...process.env, CODEX_BIN: process.execPath, GIT_CEILING_DIRECTORIES: lab };
    delete baseEnv.CODEX_RUN_FALLBACK_MODEL;
    const launch = (model, extraEnv, out) => {
      try { fs.rmSync(path.join(repo, "calls.txt"), { force: true }); } catch { /* 无 */ }
      const r = spawnSync(process.execPath, [self, "--task", path.join(repo, "task.md"), "--no-taskbook-check", "--model", model, "--out", path.join(lab, out), "--cwd", repo, "--wait-ms", "60000"],
        { encoding: "utf8", windowsHide: true, env: { ...baseEnv, ...extraEnv }, cwd: repo });
      const J = (/CODEX_JOB=(\S+)/.exec(r.stdout || "") || [])[1];
      const rec = J ? JSON.parse(fs.readFileSync(path.join(S.JOB_ROOT, `${J}.json`), "utf8")) : null;
      const calls = fs.existsSync(path.join(repo, "calls.txt")) ? fs.readFileSync(path.join(repo, "calls.txt"), "utf8").trim().split(/\r?\n/) : [];
      return { r, rec, calls };
    };
    const ok = launch("bad-model", { CODEX_RUN_FALLBACK_MODEL: "good-model" }, "fb.md");
    t("309 C-6 端到端:模型不可用 + 配了备用 ⇒ 换备用模型重发一次、done;台账记 modelUsed / modelFallback;结果件是备用模型的正文", () => {
      if (!ok.rec) throw new Error(`没拿到作业记录:${(ok.r.stdout || "") + (ok.r.stderr || "")}`);
      eq(ok.rec.state, "done"); eq(ok.calls.join(","), "bad-model,good-model", "替身被调的模型序列");
      eq(ok.rec.modelUsed, "good-model"); eq(ok.rec.modelFallback && ok.rec.modelFallback.from, "bad-model");
      eq(ok.rec.modelFallback && ok.rec.modelFallback.reason, "model_not_found"); eq(ok.rec.modelFallback && ok.rec.modelFallback.source, "env");
      const body = fs.readFileSync(path.join(lab, "fb.md"), "utf8");
      if (!/fake body from good-model/.test(body) || !/备用模型/.test(body.split("\n")[2])) throw new Error(JSON.stringify(body.slice(0, 400)));
      eq(body.split("\n")[7], "---", "头部仍是 8 行");
    });
    const cfg = (() => { fs.writeFileSync(path.join(repo, "gate-install.json"), JSON.stringify({ format: "gate-install/v1", codexFallbackModel: "good-cfg" })); const x = launch("bad-model", {}, "cfg.md"); fs.rmSync(path.join(repo, "gate-install.json")); return x; })();
    t("309 C-6 端到端:备用模型从 gate-install.json 读(没设环境变量)", () => {
      eq(cfg.rec && cfg.rec.state, "done"); eq(cfg.calls.join(","), "bad-model,good-cfg"); eq(cfg.rec.modelFallback && cfg.rec.modelFallback.source, "config");
    });
    const none = launch("bad-model", {}, "none.md");
    t("309 C-6 端到端【反向】没配备用模型 ⇒ 只跑一次、failed,失败原因里写怎么配;台账没有 modelFallback", () => {
      eq(none.rec && none.rec.state, "failed"); eq(none.calls.join(","), "bad-model");
      if (!/CODEX_RUN_FALLBACK_MODEL/.test(String(none.rec.error))) throw new Error(String(none.rec.error));
      eq("modelFallback" in none.rec, false); eq(none.rec.modelUsed, "bad-model");
    });
    const twice = launch("bad-model", { CODEX_RUN_FALLBACK_MODEL: "bad-too" }, "twice.md");
    t("309 C-6 端到端【反向】备用模型也不可用 ⇒ 只重发一次(共两次)、照常 failed", () => {
      eq(twice.rec && twice.rec.state, "failed"); eq(twice.calls.join(","), "bad-model,bad-too");
      eq(twice.rec.modelUsed, "bad-too"); eq(twice.rec.modelFallback && twice.rec.modelFallback.to, "bad-too");
    });
    const fine = launch("good-first", { CODEX_RUN_FALLBACK_MODEL: "good-model" }, "fine.md");
    t("309 C-6 端到端【反向】模型可用 ⇒ 不重发;台账 modelUsed = 原模型、没有 modelFallback", () => {
      eq(fine.rec && fine.rec.state, "done"); eq(fine.calls.join(","), "good-first"); eq(fine.rec.modelUsed, "good-first"); eq("modelFallback" in fine.rec, false);
    });
    try { fs.rmSync(lab, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
  }

  fs.rmSync(sandbox, { recursive: true, force: true });

  process.stdout.write(`PASS ${pass} / FAIL ${fails.length}\n`);
  for (const f of fails) process.stdout.write(`  FAIL ${f}\n`);
  return fails.length === 0 ? 0 : 1;
}
