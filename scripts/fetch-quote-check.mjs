#!/usr/bin/env node
// fetch-quote-check.mjs —— 外部页面引语核实闸(取页适配器)
//
// 干什么:给定 URL + 一条或多条引文,取页、转纯文本、归一化后**逐条字面匹配**,
//        输出四档:命中 / 未命中 / 多处命中 / 取页失败。
//
// 为什么:`quote-check.mjs` 只接本仓本地文件与 stdin(2026-08-19 现场核实,零处 url/http/fetch),
//        于是「某外部页面里有没有这句话」这件**纯机械**的事一直由模型去做。
//        2026-08-19 委外复核点名:出处核实应拆成「精确字符串=脚本+取页适配器」
//        与「语义支持=受限 agent」两半——本文件补的就是缺失的那半。
//        机械那半归脚本的收益:退出码即结论、可复算、不吃模型上下文、不受提示注入影响。
//
// 天花板(CEILING,照抄进任何引用本闸的报告):
//   1. **只证「这串字符在取到的那份页面文本里出现/未出现」**,不证该页是权威版本、
//      不证引文支持任何结论(referential, not semantic)。
//   2. HTML→文本是**去标签近似**,不执行 JS;**SPA / 需登录 / 付费墙页面会取到空壳**
//      ——那种情况判「取页失败」而不是「未命中」,二者不得混淆。
//   3. 未命中 ≠ 捏造:可能是版本漂移、译文、或引自页面之外。判据类型闸要求写
//      「**未在该页文本中检出**」,不得写「捏造」。
//   4. 站点可能按 UA / 地区 / 时间返回不同内容,**本闸不做快照存证**。
//
// 用法:
//   node --no-warnings scripts/fetch-quote-check.mjs <url> "引文1" ["引文2" ...]
//   node --no-warnings scripts/fetch-quote-check.mjs --json <spec.json>   # [{url, quotes:[]}...]
//   node --no-warnings scripts/fetch-quote-check.mjs --self-test
// 退出码: 0=全部命中  1=有未命中或多处命中  2=用法错或取页失败

import fs from "node:fs";

const UA = "Mozilla/5.0 (compatible; quote-check/1.0)";
const TIMEOUT_MS = 20000;

// 归一化:与 quote-check.mjs 同向(折叠空白),外加外部页面特有的三类噪声——
// 弯引号/直引号互换、软连字符与换行断词、markdown 强调残留。
// 刻意**不**做大小写折叠:引文核实要的是逐字,大小写差异属真差异。
export const norm = (s) =>
  s
    .replace(/\*\*/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/­/g, "")               // 软连字符
    .replace(/-[ \t]*\r?\n[ \t]*/g, "")   // 跨行断词:连字符+换行 = 断词符,整个删掉
    .replace(/\s+/g, "");

// HTML → 纯文本(去标签近似;script/style 整块丢弃,块级标签留空白当分隔)
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

// 数一条引文在正文里出现几次(归一化后的字面匹配)
export function countOccurrences(bodyNorm, quote) {
  const q = norm(quote);
  if (!q) return 0;
  let n = 0, i = 0;
  for (;;) {
    const k = bodyNorm.indexOf(q, i);
    if (k < 0) break;
    n++; i = k + q.length;
  }
  return n;
}

export function judge(bodyNorm, quotes) {
  return quotes.map((q) => {
    const n = countOccurrences(bodyNorm, q);
    return {
      quote: q,
      count: n,
      verdict: n === 0 ? "未命中" : n === 1 ? "命中" : "多处命中",
    };
  });
}

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") || "";
    const raw = await res.text();
    const text = /html|xml/i.test(ct) ? htmlToText(raw) : raw;
    // 取到空壳(SPA / 需登录 / 付费墙)——判取页失败,不判未命中
    if (norm(text).length < 200) return { ok: false, why: `页面文本过短(${norm(text).length} 字符,疑 SPA/需登录/付费墙)`, finalUrl: res.url };
    return { ok: true, text, finalUrl: res.url };
  } catch (e) {
    return { ok: false, why: e.name === "AbortError" ? `超时 ${TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function printCeiling() {
  console.log(
    "CEILING: 只证字符串在取到的页面文本里出现与否,不证该页权威、不证引文支持结论" +
    "(referential, not semantic);HTML→文本为去标签近似、不执行 JS,空壳页判取页失败非未命中;" +
    "未命中只可写「未在该页文本中检出」。CALIBRATED=false。"
  );
}

async function runOne(url, quotes) {
  const got = await fetchText(url);
  if (!got.ok) {
    console.log(`取页失败  ${url}\n  原因: ${got.why}`);
    return { fail: true, rows: [] };
  }
  const bodyNorm = norm(got.text);
  const rows = judge(bodyNorm, quotes);
  console.log(`页面: ${got.finalUrl || url}  (正文归一化后 ${bodyNorm.length} 字符)`);
  for (const r of rows) {
    const head = r.verdict === "命中" ? "✓ 命中   " : r.verdict === "未命中" ? "✗ 未命中 " : "⚠ 多处命中";
    console.log(`  ${head} [${r.count}] ${r.quote.slice(0, 70)}${r.quote.length > 70 ? "…" : ""}`);
  }
  return { fail: false, rows };
}

function selfTest() {
  const cases = [];
  const body = norm(htmlToText(
    "<html><body><p>Alpha <b>beta</b> gamma.</p><script>var x='delta';</script>" +
    "<p>She said “hello” and left.</p><p>super­cali frag-\nilistic</p></body></html>"
  ));
  const t = (name, quote, want) => {
    const got = judge(body, [quote])[0].verdict;
    const ok = got === want;
    cases.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  期待=${want} 实得=${got}`);
  };
  t("跨标签匹配", "beta gamma", "命中");
  t("script 内容不算正文", "delta", "未命中");
  t("弯引号归一", 'said "hello"', "命中");
  t("软连字符归一", "supercali", "命中");
  t("跨行断词归一", "fragilistic", "命中");
  t("真未命中", "epsilon", "未命中");
  t("空引文", "", "未命中");
  const body2 = norm("repeat repeat");
  const v = judge(body2, ["repeat"])[0];
  const ok = v.verdict === "多处命中" && v.count === 2;
  cases.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  多处命中计数  期待=多处命中/2 实得=${v.verdict}/${v.count}`);
  const pass = cases.filter(Boolean).length;
  console.log(`\n自测 ${pass}/${cases.length}`);
  return pass === cases.length ? 0 : 1;
}

// ── main
const argv = process.argv.slice(2);
if (argv.includes("--self-test")) process.exit(selfTest());

if (argv.length < 1) {
  console.error("用法: fetch-quote-check.mjs <url> \"引文\" [...]  |  --json <spec.json>  |  --self-test");
  process.exit(2);
}

let jobs = [];
if (argv[0] === "--json") {
  if (!argv[1] || !fs.existsSync(argv[1])) { console.error("spec 文件不存在"); process.exit(2); }
  jobs = JSON.parse(fs.readFileSync(argv[1], "utf8"));
} else {
  const [url, ...quotes] = argv;
  if (!quotes.length) { console.error("至少给一条引文"); process.exit(2); }
  jobs = [{ url, quotes }];
}

let anyFail = false, anyMiss = false;
for (const j of jobs) {
  const r = await runOne(j.url, j.quotes || []);
  if (r.fail) anyFail = true;
  if (r.rows.some((x) => x.verdict !== "命中")) anyMiss = true;
}
printCeiling();
// 用 exitCode 而非 process.exit():top-level await 后强制退出会在 Windows 上撞
// libuv 的 UV_HANDLE_CLOSING 断言(fetch 的句柄尚未关闭),那会污染退出码——
// 而本闸的整个契约就是「退出码即结论」。
process.exitCode = anyFail ? 2 : anyMiss ? 1 : 0;
