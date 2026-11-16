#!/usr/bin/env node
// check-private-identifiers.mjs —— 公开树的常驻检查:已跟踪的文本文件里不得出现本机 / 私有标识。
//
// 两层模式:
//   ① 通用模式(写在本文件里,可以公开):真实用户目录、Claude 项目目录名、邮箱、不在允许清单里的站点、
//      私仓样式的 GitHub 引用。只收「形态本身就说明是本机 / 私有」的,拿不准会误伤的一律不收。
//   ② 本机清单(不入任何仓):环境变量 CUSTODIET_PRIVATE_DENYLIST 指向的文件,一行一条。
//      · `#` 开头是注释,空行跳过;
//      · `/正则/旗标` 形态按正则(旗标只认 i / u / s);
//      · 其余按字面量,不分大小写、子串匹配。
//      没设变量或文件不存在 ⇒ 只跑通用模式,并在输出里写明「没有加载本机清单」。
//      **具体的私有名字只许写在那份清单里,不许写进本仓**——把名字写进公开的黑名单本身就是泄漏。
//
// 用法:
//   node scripts/check-private-identifiers.mjs            扫整棵树(git ls-files;不在 git 仓里就走目录遍历)
//   node scripts/check-private-identifiers.mjs --root DIR 扫别的目录
//   node scripts/check-private-identifiers.mjs --verbose  命中行尾追加命中的原文(缺省不打:日志常被贴出去)
//   node scripts/check-private-identifiers.mjs --self-test
// 输出:每条命中一行 `文件:行号:模式名`(路径名本身命中记行号 0;本机清单的模式名是 `denylist:L<清单行号>`)。
// 退出码:0 无命中;1 有命中;2 用法或本机清单写坏了(正则编不过——坏清单不能当成「没有清单」放过去)。
//
// 被允许清单拦了一个确实公开的站点时:把它的主机名加进下面的 PUBLIC_HOSTS(这是本检查唯一需要人维护的面)。
// 失效条件:通用模式连续误伤(每次都靠加例外过)⇒ 那条模式判据太宽,删掉它而不是继续加例外。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 用户目录里的占位名:出现它们不算真实用户目录。比对不分大小写。 */
const PLACEHOLDER_USERS = new Set(["x", "u", "me", "you", "user", "username", "name", "someone", "somebody", "alice", "bob",
  "foo", "bar", "example", "test", "admin", "administrator", "public", "default", "runner", "runneradmin", "some", "john", "jane",
  "yourname", "your-name", "your_name", "youruser", "xxx"]);

/** GitHub 拥有者位置上的占位名。 */
const PLACEHOLDER_OWNERS = new Set(["x", "o", "me", "you", "owner", "org", "user", "example", "acme", "your-org", "your-name", "yourname"]);

/** Claude 项目目录名里「盘符--」之后允许的占位尾巴。 */
const PLACEHOLDER_SLUG_TAILS = new Set(["x", "m", "example", "example-project", "project", "repo"]);

/** 公共站点允许清单(后缀匹配:写 `github.com` 也放行它的子域)。只放「谁都能访问的公共站点」。 */
const PUBLIC_HOSTS = [
  // 代码托管与包管理
  "github.com", "github.io", "githubusercontent.com", "githubassets.com", "gitlab.com", "git-scm.com",
  "npmjs.com", "npmjs.org", "nodejs.org", "yarnpkg.com", "pnpm.io", "pypi.org", "python.org",
  // 厂商与规范
  "anthropic.com", "claude.com", "claude.ai", "openai.com", "microsoft.com", "google.com", "mozilla.org",
  "w3.org", "ietf.org", "rfc-editor.org", "json-schema.org", "semver.org", "keepachangelog.com", "spdx.org",
  "opensource.org", "creativecommons.org", "shields.io", "eslint.org", "typescriptlang.org", "odata.org",
  // 论文与百科
  "arxiv.org", "doi.org", "acm.org", "ieee.org", "usenix.org", "wikipedia.org", "stackoverflow.com", "osdev.org",
  // 本仓文档与注释里已引用的公共链接
  "openpolicyagent.org", "arcjet.com", "ccsafetynet.com", "grcopilot.app", "spacelift.io", "t2informatik.de",
  "kth.se", "jirka.org",
  // 学术与政府域整体放行
  "edu", "gov", "ac.uk",
];

/** 邮箱形态里被当成「顶级域」的常见文件扩展名(`icon@2x.png` 不是邮箱)。 */
const FILE_EXT_TLD = /^(?:png|jpe?g|gif|svg|webp|ico|md|mjs|cjs|js|jsx|ts|tsx|json|ya?ml|txt|html?|css|sh|ps1|py|lock|log)$/i;

const BINARY_EXT = /\.(?:png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|zip|gz|tgz|mp[34]|wav)$/i;

function hostAllowed(host) {
  const h = String(host).toLowerCase().replace(/[.-]+$/, "");
  if (!h.includes(".")) return true;                                        // 单标签(localhost、容器名)不是站点
  if (/(?:^|\.)(?:test|example|invalid|localhost)$/.test(h)) return true;   // RFC 2606 / 6761 保留域
  if (/(?:^|\.)example\.(?:com|net|org)$/.test(h)) return true;
  return PUBLIC_HOSTS.some((p) => h === p || h.endsWith("." + p));
}

/** IPv4 是否属于本机 / 内网 / 文档专用段(这些不算泄漏)。 */
function ipIsLocal(ip) {
  const p = ip.split(".").map(Number);
  if (p.some((n) => n > 255)) return true;                                  // 不是合法地址,不判
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

const userOk = (name) => PLACEHOLDER_USERS.has(String(name).toLowerCase().replace(/\.+$/, ""));

/** 通用模式。`ok(m)` 返回 true ⇒ 这次匹配放行。 */
export const GENERIC = [
  { name: "win-user-home",        // C:\Users\<真名>、c:/users/<真名>(含 JSON 里的双反斜杠)
    re: /(?<![A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9][A-Za-z0-9._-]*)/gi, ok: (m) => userOk(m[1]) },
  { name: "msys-user-home",       // /c/Users/<真名>、/mnt/c/Users/<真名>
    re: /(?<![A-Za-z0-9_.-])\/(?:mnt\/)?[A-Za-z]\/Users\/([A-Za-z0-9][A-Za-z0-9._-]*)/g, ok: (m) => userOk(m[1]) },
  { name: "unix-user-home",       // /Users/<真名>/…(macOS;要求后面还有路径,名字以字母开头)
    re: /(?<![A-Za-z0-9_.:~-])\/Users\/([A-Za-z][A-Za-z0-9._-]*)(?=\/)/g, ok: (m) => userOk(m[1]) },
  { name: "claude-project-home",  // 项目目录名里编码进去的用户目录:C--Users-<真名>-…
    re: /(?<![A-Za-z0-9])[A-Za-z]--Users-([A-Za-z0-9][A-Za-z0-9_.]*)/g, ok: (m) => userOk(m[1]) },
  { name: "claude-project-dir",   // .claude/projects/ 下的真实项目目录名(D--<名字> 或 -home-<…>)
    re: /\.claude[\\/]+projects[\\/]+((?:[A-Za-z]--|-)([A-Za-z0-9][A-Za-z0-9._-]*))/g, ok: (m) => PLACEHOLDER_SLUG_TAILS.has(m[2].toLowerCase()) },
  { name: "email",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))(?![A-Za-z0-9-])/g,
    ok: (m) => hostAllowed(m[1]) || FILE_EXT_TLD.test(m[2]) || /^\d+\.\d/.test(m[1]) },
  { name: "url-host",             // 带协议头的链接,主机不在允许清单里
    re: /\b(?:https?|wss?|ftp|ssh|git):\/\/(?:[^\s\/@"'`<>]*@)?([A-Za-z0-9.-]+)/g,
    ok: (m) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(m[1]) || hostAllowed(m[1]) },
  { name: "url-public-ip",        // 带协议头的链接直接写公网地址
    re: /\b(?:https?|wss?|ftp|ssh|git):\/\/(?:[^\s\/@"'`<>]*@)?(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g, ok: (m) => ipIsLocal(m[1]) },
  { name: "github-private-repo",  // github.com/<拥有者>/<…-private|…-internal>
    re: /github\.com[\/:]([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)/g,
    ok: (m) => !/[-_.](?:private|internal)$/i.test(m[2].replace(/\.git$/i, "")) || PLACEHOLDER_OWNERS.has(m[1].toLowerCase()) },
];

/** 解析本机清单文本 ⇒ { patterns: [{ name, re }], errors: [说明] }。 */
export function parseDenylist(text) {
  const patterns = [], errors = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const name = `denylist:L${i + 1}`;
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    try {
      if (m) {
        if (/[^ius]/.test(m[2])) throw new Error(`不认识的旗标 ${m[2]}`);
        patterns.push({ name, re: new RegExp(m[1], [...new Set(m[2] + "g")].join("")) });
      } else {
        patterns.push({ name, re: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") });
      }
    } catch (e) { errors.push(`第 ${i + 1} 行编不过:${e.message}`); }
  });
  return { patterns, errors };
}

/** 读环境变量指向的本机清单。没设 / 文件不在 ⇒ loaded:false。 */
export function loadDenylist(env = process.env) {
  const p = env.CUSTODIET_PRIVATE_DENYLIST;
  if (!p || !fs.existsSync(p)) return { loaded: false, patterns: [], errors: [] };
  return { loaded: true, ...parseDenylist(fs.readFileSync(p, "utf8")) };
}

/** 扫一段文本 ⇒ [{ line, name, text }];同一行同一模式只报一次。 */
export function scanText(text, extra = []) {
  const hits = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    for (const g of GENERIC) {
      g.re.lastIndex = 0;
      for (const m of line.matchAll(g.re)) if (!g.ok(m)) { hits.push({ line: i + 1, name: g.name, text: m[0] }); break; }
    }
    for (const d of extra) {
      d.re.lastIndex = 0;
      const m = d.re.exec(line);
      if (m && m[0] !== "") hits.push({ line: i + 1, name: d.name, text: m[0] });
    }
  });
  return hits;
}

function listFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const files = out.split("\0").filter(Boolean);
    if (files.length) return files;
  } catch { /* 不在 git 仓里 ⇒ 走目录遍历 */ }
  const acc = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (e.isFile()) acc.push(r);
    }
  };
  walk(root, "");
  return acc.sort();
}

/** 扫一棵树 ⇒ { files: 扫过的文本文件数, hits: [{ file, line, name, text }] }。 */
export function scanTree(root, extra = []) {
  const hits = [];
  let files = 0;
  for (const f of listFiles(root)) {
    for (const h of scanText(f, extra)) hits.push({ file: f, ...h, line: 0 });          // 路径名本身
    if (BINARY_EXT.test(f)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(root, f)); } catch { continue; }               // 已跟踪但工作树里删了
    if (buf.subarray(0, 8192).includes(0)) continue;                                     // 二进制
    files++;
    for (const h of scanText(buf.toString("utf8"), extra)) hits.push({ file: f, ...h });
  }
  return { files, hits };
}

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
  };
  const j = (...p) => p.join("");                        // 样例一律拼接:本文件自己也在被扫的范围里
  const names = (s, extra) => scanText(s, extra).map((h) => h.name);
  const who = j("zq", "wex");                            // 造出来的「真名」,不是任何人的
  const U = j("Us", "ers");

  // —— 正例:该命中 ——
  t("盘符用户目录(正斜杠)", names(j("C:/", U, "/", who, "/x.md")), ["win-user-home"]);
  t("盘符用户目录(反斜杠)", names(j("D:\\", U, "\\", who, "\\x")), ["win-user-home"]);
  t("盘符用户目录(JSON 双反斜杠、小写)", names(j("c:\\\\", U.toLowerCase(), "\\\\", who)), ["win-user-home"]);
  t("Git Bash 形态", names(j("cd /c/", U, "/", who, "/repo")), ["msys-user-home"]);
  t("WSL 形态", names(j("/mnt/c/", U, "/", who)), ["msys-user-home"]);
  t("macOS 用户目录", names(j("open /", U, "/", who, "/Library")), ["unix-user-home"]);
  t("项目目录名里的用户目录", names(j("C--", U, "-", who, "-proj")), ["claude-project-home"]);
  t("真实项目目录名(盘符形)", names(j("~/.claude/proj", "ects/D--", who, "/a.jsonl")), ["claude-project-dir"]);
  t("真实项目目录名(Unix 形)", names(j("~/.claude/proj", "ects/-home-", who, "-app/a.jsonl")), ["claude-project-dir"]);
  t("邮箱", names(j("联系 ", who, "@", who, ".dev")), ["email"]);
  t("不在清单里的站点", names(j("curl https:", "//", who, ".dev/api")), ["url-host"]);
  t("链接里带口令 ⇒ 站点与邮箱形态都报", names(j("https:", "//u:p@", who, ".dev/x")).sort(), ["email", "url-host"]);
  t("ssh 协议头的私有主机(用户名@主机 同时是邮箱形态)", names(j("ssh:", "//git@git.", who, ".dev/r.git")).sort(), ["email", "url-host"]);
  t("ssh 协议头、不带用户名", names(j("ssh:", "//git.", who, ".dev/r.git")), ["url-host"]);
  t("链接里的公网地址", names(j("http:", "//8.8.", "8.8:8080/s")), ["url-public-ip"]);
  t("私仓样式的 GitHub 引用", names(j("git@github.com:", who, "/app-priv", "ate.git")), ["github-private-repo"]);
  t("私仓样式(-internal)", names(j("https://github.com/", who, "/tools-inter", "nal")), ["github-private-repo"]);
  t("行号从 1 起、每行各报", scanText(j("ok\n", "C:/", U, "/", who, "\nok\n/c/", U, "/", who)).map((h) => `${h.line}:${h.name}`), ["2:win-user-home", "4:msys-user-home"]);

  // —— 反例:不该命中 ——
  for (const s of [
    "C:/Users/x/.claude/projects/example-project/memory/y.md", "C:/Users/u/AppData/Local/Temp/a.log", "C:/Users/me/repo",
    "C:/Users/someone/AppData/x", "c:/Users/", "/^[A-Za-z]:\\/Users\\/[^/]+/", "/c/Users/x/repo", "/Users/alice/Library",
    "https://api.x.test/Users/42/orders", "~/.claude/projects/<项目名>/*.jsonl", ".claude/projects/*/memory/x.md",
    "~/.claude/projects/E--m/a.jsonl", "path.join(H, \".claude\", \"projects\", s)",
    "t@example.invalid", "a@b.c", "noreply@anthropic.com", "x@users.noreply.github.com", "icon@2x.png", "eslint@9.1.0", "lanes@custodiet",
    "@babel/parser", "https://registry.npmjs.org/@babel/parser/-/parser-8.0.7.tgz",
    "https://x.test/a?id=1", "https://example.org/", "https://sub.example.com/x", "http://127.0.0.1:3000/auth", "http://192.168.1.20:8080/status",
    "http://localhost:39279/callback", "https://…/$id", "https://${host}/x", "https://github.com/anthropics/claude-code/issues/1",
    "https://www2.cs.arizona.edu/~rts/pubs/VLDB04.pdf", "https://srg.doc.ic.ac.uk/files/x.pdf", "https://arxiv.org/abs/2607.02599",
    "https://github.com/x/app-private.git", "https://github.com/someorg/private-gpt", "git@github.com:nizos/tdd-guard.git",
    "re.test(s) && /a/.test(b)", "d--; n--clear", "v1.2.3.4 与 10.0.0.1", "E:/work/docs/noun-diary.md", "/repo/scripts/lib/x.mjs",
  ]) t(`反例:${s}`, names(s), []);

  // —— 本机清单 ——
  const lit = j("pr", "oj", "zeta");                     // 造出来的项目名
  const dl = parseDenylist(["# 注释", "", lit, `/D--${lit}\\b/`, `/${who}(?!\\d)/i`].join("\n"));
  t("清单:注释与空行跳过、行号保留", dl.patterns.map((p) => p.name), ["denylist:L3", "denylist:L4", "denylist:L5"]);
  t("清单:字面量不分大小写", names(`cd E:/${lit.toUpperCase()} && ls`, dl.patterns), ["denylist:L3"]);
  t("清单:正则形态照正则走(区分大小写)", names(`D--${lit}`, dl.patterns), ["denylist:L3", "denylist:L4"]);
  t("清单:正则带 i 旗标 + 否定前瞻", [names(who.toUpperCase(), dl.patterns), names(`${who}42`, dl.patterns)], [["denylist:L5"], []]);
  t("清单:字面量里的正则元字符不当正则", names("a+b", parseDenylist("a.b").patterns), []);
  t("清单:正则编不过 ⇒ 报错不吞", parseDenylist("/(/").errors.length, 1);
  t("清单:不认识的旗标 ⇒ 报错", parseDenylist("/a/x").errors.length, 1);
  t("清单:没设变量 ⇒ 未加载", loadDenylist({}).loaded, false);
  t("清单:文件不存在 ⇒ 未加载", loadDenylist({ CUSTODIET_PRIVATE_DENYLIST: path.join(path.sep, "no-such-dir-check-private", "x.txt") }).loaded, false);

  // —— 本文件自己不带样例字面量(通用模式扫自己 0 命中)——
  t("本文件自己过通用模式", scanText(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")).map((h) => `${h.line}:${h.name}`), []);

  console.log(`check-private-identifiers 自测 ${pass}/${pass + fail}`);
  return fail ? 1 : 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { if (!argv[i + 1]) { console.error("--root 缺目录"); return 2; } root = path.resolve(argv[++i]); }
    else if (argv[i] === "--verbose") verbose = true;
    else { console.error(`不认识的参数:${argv[i]}`); return 2; }
  }
  if (!fs.existsSync(root)) { console.error("要扫的目录不存在"); return 2; }
  const dl = loadDenylist();
  if (dl.errors.length) { for (const e of dl.errors) console.error(`本机清单${e}`); return 2; }
  const { files, hits } = scanTree(root, dl.patterns);
  for (const h of hits) console.log(`${h.file}:${h.line}:${h.name}${verbose ? `  ${h.text}` : ""}`);
  const src = dl.loaded ? `本机清单 ${dl.patterns.length} 条` : "没有加载本机清单(CUSTODIET_PRIVATE_DENYLIST 没设或文件不存在),只跑通用模式";
  console.log(`check-private-identifiers:扫了 ${files} 个文本文件;通用模式 ${GENERIC.length} 条;${src};命中 ${hits.length}`);
  return hits.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
