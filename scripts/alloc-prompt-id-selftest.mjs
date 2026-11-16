// 载体编号原子分配的**并发**自测(023 批 C1–C3;载体 clipboard/prompts/023-prompt-id-atomic-alloc.md)。
//
// 为什么单独成文件:`scripts/lib/alloc-prompt-id.mjs` 是生产模块,只该有分配逻辑;
// 本文件除自测外还要**故意实现一份坏分配器**(反向用例),不该混进生产模块。
//
// ── 为什么必须是两个真进程 ──
//
//   竞态发生在「扫 max」与「建文件」之间。同一进程里串行跑两遍,这两步永不交错,
//   **坏实现也会全绿** —— 那样的自测证不了任何事(023 批 S6:不得串行冒充并发)。
//   故:parent fork 两个 worker 子进程,子进程在 `--go` 文件出现后同时起跑。
//
// ── 反向用例(C3,自测有效性的证明)──
//
//   mode=bad 走「扫 max → 直接 O_EXCL 创建 NNN-<tag>.md」。两个 worker 的 tag 不同,
//   于是同一个号下文件名不同,两个 O_EXCL **都会成功** ⇒ 预期出现重号。
//   **跑不出重号 = 这个测法压不出竞态**,则它对好实现的通过没有信息量,
//   按 C3 须报「自测有效性未证实」并停条。
//
// ── 用法 ──
//
//   node --no-warnings scripts/alloc-prompt-id-selftest.mjs          # 跑 good + bad 两轮
//   node --no-warnings scripts/alloc-prompt-id-selftest.mjs --keep   # 保留临时目录供人工查看
//   (内部)--worker --mode good|bad --dir <d> --tag <t> --count <n> --go <f> --out <f>
//
//   临时目录落 clipboard/scratch/alloc-selftest-*(clipboard/ 整目录 gitignore,不入仓)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { allocatePromptId, scanMaxNum } from "./lib/alloc-prompt-id.mjs";

const SELF = fileURLToPath(import.meta.url);
const COUNT = 10; // 每 worker 申请几个号(C1:两进程各 10)
const WORKERS = ["A", "B"];

// 自测起跑前先种进目录的既有文件:用来同时验「起点正确」与「audit 件不参与取号」。
//   非 audit 最大号 = 010(来自 010-exec.log,不限扩展名的扫描口径)
//   013-orphan-audit-r1.md 是 audit 件,**不该**把起点顶到 014
const SEED = [
  "005-alpha.md",
  "007-beta.md",
  "007-beta-audit-r1.md",
  "010-exec.log",
  "013-orphan-audit-r1.md",
];
const EXPECTED_START = 11; // = max(005,007,010) + 1;audit 的 013 被排除

// ---------------- worker ----------------

/** 坏分配器(反向用例专用):独占的键含 slug ⇒ 不同 slug 的同号文件名不同 ⇒ 挡不住重号。 */
function allocateBad(dir, tag) {
  for (let n = scanMaxNum(dir) + 1; n <= 999; n++) {
    const target = path.join(dir, `${String(n).padStart(3, "0")}-${tag}.md`);
    try {
      fs.closeSync(fs.openSync(target, "wx"));
      return { id: String(n).padStart(3, "0"), num: n, path: target };
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("allocateBad: 号段耗尽");
}

function runWorker(argv) {
  const flag = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const mode = flag("--mode");
  const dir = flag("--dir");
  const tag = flag("--tag");
  const count = Number(flag("--count"));
  const goFile = flag("--go");
  const outFile = flag("--out");

  // 起跑线:自旋等 parent 落 go 文件,让两个 worker 尽量同刻进入循环。
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error("worker: 等 go 文件超时");
  }

  const got = [];
  const errors = [];
  for (let i = 0; i < count; i++) {
    try {
      const r = mode === "bad" ? allocateBad(dir, `${tag}${i}`) : allocatePromptId({ dir, slug: `${tag}${i}` });
      got.push({ num: r.num, path: path.basename(r.path) });
    } catch (err) {
      errors.push(String(err && err.message ? err.message : err));
    }
  }
  fs.writeFileSync(outFile, JSON.stringify({ tag, mode, got, errors }), "utf8");
}

// ---------------- parent ----------------

function seedDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of SEED) fs.writeFileSync(path.join(dir, name), "", "utf8");
}

function spawnWorkers(dir, mode, goFile, outDir) {
  return WORKERS.map((tag) => {
    const out = path.join(outDir, `result-${mode}-${tag}.json`);
    const child = spawn(
      process.execPath,
      ["--no-warnings", SELF, "--worker", "--mode", mode, "--dir", dir,
       "--tag", tag, "--count", String(COUNT), "--go", goFile, "--out", out],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    return new Promise((resolve) => {
      child.on("exit", (code) => resolve({ tag, out, code, stderr }));
    });
  });
}

async function runRound(root, mode) {
  const dir = path.join(root, mode);
  seedDir(dir);
  const goFile = path.join(root, `go-${mode}`);
  const pending = spawnWorkers(dir, mode, goFile, root);
  // 两个子进程都已 spawn,落起跑线
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(goFile, "go", "utf8");
  const finished = await Promise.all(pending);

  const results = [];
  for (const f of finished) {
    if (f.code !== 0) {
      throw new Error(`worker ${f.tag} 退出码 ${f.code}\n${f.stderr}`);
    }
    results.push(JSON.parse(fs.readFileSync(f.out, "utf8")));
  }
  const nums = results.flatMap((r) => r.got.map((g) => g.num)).sort((a, b) => a - b);
  const errors = results.flatMap((r) => r.errors);
  return { dir, nums, errors, results };
}

function dupes(nums) {
  const seen = new Set();
  const dup = new Set();
  for (const n of nums) (seen.has(n) ? dup : seen).add(n);
  return [...dup].sort((a, b) => a - b);
}

function contiguous(nums) {
  if (nums.length === 0) return false;
  return nums.every((n, i) => n === nums[0] + i);
}

async function main() {
  const keep = process.argv.includes("--keep");
  const root = path.resolve("clipboard/scratch", `alloc-selftest-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const fmt = (ns) => `[${ns.map((n) => String(n).padStart(3, "0")).join(",")}]`;
  let failed = false;

  console.log(`SELFTEST root=${root}`);
  console.log(`SEED=${SEED.join(" ")}  (预期起点 ${String(EXPECTED_START).padStart(3, "0")};013 是 audit 件不参与取号)`);
  console.log(`并发形态:2 进程 × ${COUNT} 号,共 ${2 * COUNT} 号,起跑线由 go 文件对齐`);

  // ---- 正向:好分配器 ----
  console.log("\n=== ROUND good(生产模块 scripts/lib/alloc-prompt-id.mjs)===");
  const good = await runRound(root, "good");
  console.log(`GOT n=${good.nums.length} ${fmt(good.nums)}`);
  if (good.errors.length) console.log(`WORKER-ERRORS ${JSON.stringify(good.errors)}`);

  const gDup = dupes(good.nums);
  const a1 = gDup.length === 0 && good.nums.length === 2 * COUNT;
  console.log(`ASSERT-1 零重号            : ${a1 ? "PASS" : "FAIL"}  (${good.nums.length}/${2 * COUNT} 个号,重号 ${fmt(gDup)})`);

  const a2 = contiguous(good.nums);
  console.log(`ASSERT-2 零跳号            : ${a2 ? "PASS" : "FAIL"}  (期望 [${fmt([good.nums[0]])}..] 连续 ${good.nums.length} 个,实测 ${a2 ? "连续" : "有空洞"})`);

  const a3 = good.nums[0] === EXPECTED_START;
  console.log(`ASSERT-3 起点正确          : ${a3 ? "PASS" : "FAIL"}  (期望 ${String(EXPECTED_START).padStart(3, "0")},实测 ${String(good.nums[0]).padStart(3, "0")})`);

  const a4 = good.nums[good.nums.length - 1] === EXPECTED_START + 2 * COUNT - 1;
  console.log(`ASSERT-4 号段吻合          : ${a4 ? "PASS" : "FAIL"}  (期望 [${String(EXPECTED_START).padStart(3, "0")},${String(EXPECTED_START + 2 * COUNT - 1).padStart(3, "0")}])`);
  if (!(a1 && a2 && a3 && a4 && good.errors.length === 0)) failed = true;

  // ---- 反向:坏分配器(证明这个测法压得出竞态)----
  console.log("\n=== ROUND bad(反向用例:独占键含 slug,预期重号)===");
  const bad = await runRound(root, "bad");
  console.log(`GOT n=${bad.nums.length} ${fmt(bad.nums)}`);
  const bDup = dupes(bad.nums);
  const a5 = bDup.length > 0;
  console.log(`ASSERT-5 反向出重号        : ${a5 ? "PASS" : "FAIL"}  (重号 ${fmt(bDup)})`);
  if (!a5) {
    console.log("           ⚠ 拿不到重号 ⇒ 本自测压不出竞态 ⇒ **自测有效性未证实**(023 批 C3),停该条");
    failed = true;
  }

  console.log(`\nSELFTEST=${failed ? "FAIL" : "PASS"}`);
  if (!keep) {
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`临时目录已清理:${root}`);
  } else {
    console.log(`临时目录保留:${root}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--worker")) {
  runWorker(process.argv.slice(2));
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
