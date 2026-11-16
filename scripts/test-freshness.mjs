#!/usr/bin/env node
// test-freshness.mjs —— 测试新鲜度指纹:证明「这个绿是这一版代码的绿」
//
// 存在理由(2026-08-19 实撞):当日我反复报「自测 47/47」,而**没有任何东西**证明
// 那个绿是当前这一版代码跑出来的。已知两次翻车:
//   · 改坏文件之后、重跑之前就报了绿;
//   · 「44/44」是并发互撞下的单次采样(自测临时文件当时是固定名)。
// codex 对 tdd-guardian 的只读测绘把这件事命名为「**测试 pass 是否新鲜**」,
// 并指出它与本仓快车道解决的「要不要 build/restart」**不是同一件事**——我们至今没有前者。
//
// 外部先例(2026-08-19 WebSearch):dbt 的 source freshness 用**非零退出码闸住流水线**,
// 并把新鲜度状态持久化到 `target/source.json` 供回读。本件照搬这个形状:
// 通过时落指纹,提交时比对,陈绿即非零退出。
//
// 用法:
//   node --no-warnings scripts/test-freshness.mjs --record <套件名> --cmd "<跑测试的命令>" <文件...>
//   node --no-warnings scripts/test-freshness.mjs --check  <套件名>
//   node --no-warnings scripts/test-freshness.mjs --self-test
// 退出码: 0=新鲜  1=本件自身出错(UNKNOWN)  2=陈绿(判据说不过)  3=用法错
//
// CEILING: 指纹只证「被测文件自记录以来未变」。它证不了那次测试**真的跑过**、
//   也证不了测试本身有鉴别力(那是 gate-migrate-check 的变异验收管的)。CALIBRATED=false。

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

const STORE = ".claude/.test-freshness.json";

function fingerprint(files) {
  const h = crypto.createHash("sha256");
  const missing = [];
  for (const f of files.slice().sort()) {
    try { h.update(f); h.update(fs.readFileSync(f)); }
    catch { missing.push(f); }
  }
  return { hash: h.digest("hex").slice(0, 16), missing };
}

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}

function save(db) {
  // 原子写:先写临时文件再改名。理由——grill:error-handling 实测同目录的
  // `.batch-goal.json` 用裸 writeFileSync,并发时读者会看到**被截断的空文件**并误判「未武装」。
  // ⚠️ 临时文件名带 pid(2026-08-20 grill:architecture §4.4):原写死 `STORE + ".tmp"`,
  //   两个进程并发 --record 会互踩同一个 tmp ——**这正是当初在 batch-goal 里修掉的那个 bug,
  //   复发在修它的这个文件里**(那次 16 路竞争有 10 个报成功而盘上只剩一个的条件)。
  const tmp = `${STORE}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n");
    fs.renameSync(tmp, STORE);
  } finally { try { fs.unlinkSync(tmp); } catch { /* 已改名成功即无此文件 */ } }
}

/**
 * 记录一次**通过**的指纹。
 *
 * ⚠️ `cmd` 是 2026-08-20 加的,而且是**必填**。此前的签名是 `record(suite, files)`——
 *   全部输入只有套件名与文件清单,唯一的检查是「文件读不到吗」。
 *   **「测试通过」这件事在整个代码路径里从未被观测过一次**,它被假设了:假设人只在绿的时候敲。
 *   实测(2026-08-20,反向探针):造一个从未被测过的文件,直接 `--record`,
 *   得到「已记录 假套件 的通过指纹 …」,随后 `--check` 报「新鲜」、退出 0。
 *   **零测试,一张绿收据。**
 *
 *   讽刺之处在于第 21–22 行的 CEILING 注释**早就写明**「它证不了那次测试真的跑过」——
 *   缺陷被作者写进了注释,却没有被写进判据。这不是不知道,是知道但没关。
 *   同一处自知,tdd-guardian 的处置是把 receipt 降权成 opt-in 且永不阻断
 *   (「A heuristic that blocks converts a signal into noise」),而本件把它留在注释里、
 *   `--check` 照旧 exit 2 当闸用。
 *
 *   正解一行来自同一个插件的 `lanes.js:306`:`const recordAsFresh = result.ok || bootstrap;`
 *   ——写入「通过」的前提是**它自己刚跑完那条命令并拿到了 ok**。这就是本件缺的那半句。
 *   故:本件自己 spawn,判据 = **本进程亲眼见到的退出码 0**,不再接受调用者的断言。
 *   刻意**不**提供 `--exit-code 0` 之类的入口——那只是把自签往外挪一格。
 */
export function record(suite, files, cmd) {
  if (!cmd || !String(cmd).trim()) {
    return { ok: false, why: "缺 --cmd:收据必须绑定到一次真实执行,不接受「我跑过了」的断言" };
  }
  const r = spawnSync(String(cmd), { windowsHide: true, shell: true, stdio: "inherit" });
  if (r.error) return { ok: false, why: `命令起不来:${r.error.message}——不落指纹` };
  if (r.status !== 0) return { ok: false, why: `测试未通过(退出码 ${r.status})——不落指纹` };
  const { hash, missing } = fingerprint(files);
  if (missing.length) return { ok: false, why: `被测文件读不到:${missing.join(", ")}` };
  const db = load();
  // 收据上写明**凭什么签**:命令与退出码。回读时才分得清新旧格式。
  db[suite] = { hash, files: files.slice().sort(), at: new Date().toISOString(), cmd: String(cmd), exitCode: 0 };
  save(db);
  return { ok: true, hash };
}

export function check(suite) {
  const db = load();
  const rec = db[suite];
  if (!rec) return { fresh: false, why: `套件 ${suite} **从未记录过通过**——「没有绿」不等于「绿是新鲜的」` };
  const { hash, missing } = fingerprint(rec.files);
  if (missing.length) return { fresh: false, why: `被测文件读不到:${missing.join(", ")}` };
  if (hash !== rec.hash) {
    return { fresh: false, why: `**陈绿**:记录于 ${rec.at} 的通过对应指纹 ${rec.hash},当前代码指纹 ${hash}——被测文件自那次通过以来已改动` };
  }
  return { fresh: true, at: rec.at, hash };
}

// ── 自测:核心是**鉴别力**——改一个被测文件后必须判陈绿 ────────────────────
function selfTest() {
  const os = globalThis.require ? globalThis.require("node:os") : null;
  const tmpdir = fs.mkdtempSync((os ? os.tmpdir() : ".") + path.sep + "tf-");
  const a = path.join(tmpdir, "a.txt"), b = path.join(tmpdir, "b.txt");
  fs.writeFileSync(a, "one"); fs.writeFileSync(b, "two");
  const t = [];
  const chk = (n, got, want) => t.push([got === want ? "PASS" : "FAIL", n, `实得 ${got}`]);

  const origStore = STORE;
  // 用真 STORE 会污染仓库,故在临时 cwd 下跑
  const cwd0 = process.cwd();
  process.chdir(tmpdir);
  try {
    const OK = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const BAD = process.platform === "win32" ? "cmd /c exit 7" : "exit 7";

    chk("未记录过 ⇒ 不新鲜", check("s").fresh, false);

    // ⚠️ 三条**签发条件**的用例(2026-08-20 新增)。此前 record 无条件落账,
    //   而当日的反向探针证明:零测试也能拿到绿收据。这三条就是那个洞的回归守卫。
    chk("缺 --cmd ⇒ 拒签(不接受「我跑过了」)", record("s", [a, b], null).ok, false);
    chk("命令非零退出 ⇒ 拒签", record("s", [a, b], BAD).ok, false);
    chk("拒签后确实没落账(不是只报错却照写)", check("s").fresh, false);

    chk("命令退出 0 ⇒ 签", record("s", [a, b], OK).ok, true);
    chk("刚记录 ⇒ 新鲜", check("s").fresh, true);
    fs.writeFileSync(a, "one-changed");
    chk("改了被测文件 ⇒ 陈绿(鉴别力)", check("s").fresh, false);
    fs.writeFileSync(a, "one");
    chk("改回去 ⇒ 又新鲜(指纹按内容不按时间)", check("s").fresh, true);
    fs.unlinkSync(b);
    chk("被测文件消失 ⇒ 不新鲜", check("s").fresh, false);
    chk("原子写:写完 STORE 存在", fs.existsSync(origStore), true);
    // tmp 名带 pid,故按 pid 查残骸;顺便证明**不再是固定名**(并发互踩的那个 bug)
    chk("原子写:不留 .tmp 残骸", fs.existsSync(`${origStore}.${process.pid}.tmp`), false);
    chk("原子写:tmp 不是固定名(并发互踩回归守卫)", fs.existsSync(origStore + ".tmp"), false);
  } finally { process.chdir(cwd0); }

  let pass = 0;
  for (const [r, n, extra] of t) { console.log(`  ${r}  ${n}${r === "FAIL" ? "  ← " + extra : ""}`); if (r === "PASS") pass++; }
  console.log(`\n新鲜度自测 ${pass}/${t.length}`);
  return pass === t.length;
}

const argv = process.argv.slice(2);
if (argv[0] === "--self-test") {
  const { createRequire } = await import("node:module");
  globalThis.require = createRequire(import.meta.url);
  process.exit(selfTest() ? 0 : 1);
} else if (argv[0] === "--record") {
  // ⚠️ `--cmd` **必填,且不留旧入口**(2026-08-20)。留一个「不带 cmd 也能记」的路径,
  //   等于洞没堵——自签会自动流向那条路。缺 --cmd 直接 exit 3。
  const rest = argv.slice(1);
  const ci = rest.indexOf("--cmd");
  const cmd = ci >= 0 ? rest[ci + 1] : null;
  const positional = ci >= 0 ? [...rest.slice(0, ci), ...rest.slice(ci + 2)] : rest;
  const [suite, ...files] = positional;
  if (!suite || !files.length || !cmd) {
    console.error('用法: --record <套件名> --cmd "<跑测试的命令>" <被测文件...>');
    console.error('  --cmd 必填:收据只在本件亲自跑完该命令、且退出码为 0 时才落盘。');
    process.exit(3);
  }
  const r = record(suite, files, cmd);
  if (!r.ok) { console.error("记录失败: " + r.why); process.exit(1); }
  console.log(`已记录 ${suite} 的通过指纹 ${r.hash}(${files.length} 个被测文件,凭据:\`${cmd}\` exit 0)`);
} else if (argv[0] === "--check") {
  const suite = argv[1];
  if (!suite) { console.error("用法: --check <套件名>"); process.exit(3); }
  const r = check(suite);
  if (r.fresh) { console.log(`${suite}: 新鲜(记录于 ${r.at},指纹 ${r.hash})`); process.exit(0); }
  console.log(`${suite}: ${r.why}`);
  process.exit(2);
} else {
  console.error("用法: --record <套件> <文件...> | --check <套件> | --self-test");
  process.exit(3);
}
