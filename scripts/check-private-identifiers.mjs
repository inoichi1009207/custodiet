#!/usr/bin/env node
// check-private-identifiers.mjs —— 公开树的常驻检查:已跟踪的文本文件里不得出现本机 / 私有标识。
//
// 两层模式:
//   ① 通用模式(写在本文件里,可以公开):真实用户目录、Claude 项目目录名、邮箱、不在允许清单里的站点、
//      公网地址、私仓样式的 GitHub 引用。
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
//   没扫内容的文件逐个列出来(二进制扩展名、已跟踪但工作区里没有的);扫不了的文件逐个列出来并算失败。
// 退出码:0 无命中;1 有命中;2 没法下结论——用法错、本机清单写坏了(正则编不过)、有文件读不了或解不成文本。
//
// 扫的是**工作区**里的内容,不是提交里的。已跟踪文件有未提交改动时会打一行提示(退出码不变):
//   推送前请在干净的工作区重跑,否则「命中 0」证明不了待推的提交是干净的。
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

/** 确属二进制的扩展名:内容不扫(路径名照扫),但每次都在输出里列出来。 */
const BINARY_EXT = /\.(?:png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|zip|gz|tgz|mp[34]|wav)$/i;

function hostAllowed(host) {
  const h = String(host).toLowerCase().replace(/[.-]+$/, "");
  if (!h.includes(".")) return true;                                        // 单标签(localhost、容器名)不是站点
  if (/(?:^|\.)(?:test|example|invalid|localhost)$/.test(h)) return true;   // RFC 2606 / 6761 保留域
  if (/(?:^|\.)example\.(?:com|net|org)$/.test(h)) return true;
  return PUBLIC_HOSTS.some((p) => h === p || h.endsWith("." + p));
}

/** IPv4 是否放行:回环、私网、链路本地、文档保留段、全零、广播。写不成合法地址的(某段大于 255)不判。
 *  别的一律拦——组播、子网掩码、运营商级 NAT 段也在拦的那边(拿不准的地址形态按泄漏算)。 */
function ipAllowed(ip) {
  const p = ip.split(".").map(Number);
  if (p.some((n) => n > 255)) return true;
  const [a, b, c] = p;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || p.every((n) => n === 0) || p.every((n) => n === 255);
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
  { name: "url-host",             // 带协议头的链接(协议头不分大小写),主机不在允许清单里;主机是 IPv4 的归 public-ipv4 判
    re: /\b(?:https?|wss?|ftp|ssh|git):\/\/(?:[^\s\/@"'`<>]*@)?([A-Za-z0-9.-]+)/gi,
    ok: (m) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(m[1]) || hostAllowed(m[1]) },
  { name: "public-ipv4",          // 公网 IPv4,带不带协议头都算;前面紧挨字母数字或点、后面还接着「.数字」的不是地址(v1.2.3.4、五段数字)
    re: /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?!\w|\.\d)/g, ok: (m) => ipAllowed(m[1]) },
  { name: "url-ipv6",             // 链接里带方括号的 IPv6 字面量;只放行回环 ::1
    re: /\b(?:https?|wss?|ftp|ssh|git):\/\/(?:[^\s\/@"'`<>]*@)?\[([0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?)\]/gi, ok: (m) => m[1] === "::1" },
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

/** 文件内容 ⇒ 要扫的文本(一份或两份);解不成 ⇒ null。
 *  · 没有 NUL 字节:按 UTF-8。
 *  · 有 NUL 字节:① 按 UTF-16LE 解得通(UTF-16 存的文本)就扫这一份;
 *    ② 同时是严格合法的 UTF-8(源码里夹着零星字面 NUL)就再扫一份去掉 NUL 的——大端 UTF-16 存的 ASCII 内容也落在这一份里。
 *    两份都不成立 ⇒ null:由调用方记成失败,不当二进制悄悄放过去。 */
export function decodeTexts(buf) {
  if (!buf.includes(0)) return [buf.toString("utf8")];
  const out = [];
  const le = utf16le(buf);
  if (le !== null) out.push(le);
  try { out.push(new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/\0/g, "")); } catch { /* 不是合法 UTF-8 */ }
  return out.length ? out : null;
}

/** 按 UTF-16LE 解;解不成 ⇒ null:字节数为奇数、是大端(FE FF 开头,或 NUL 多落在偶数位)、有落单的代理项、解完还有 NUL。 */
function utf16le(buf) {
  if (buf.length % 2) return null;
  if (buf[0] === 0xfe && buf[1] === 0xff) return null;
  let even = 0, odd = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { if (i % 2) odd++; else even++; }
  if (even > odd) return null;
  const s = buf.toString("utf16le").replace(/^\uFEFF/, "");
  if (/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) return null;
  return s;
}

/** 要扫的文件清单 ⇒ { files, git }。git:true 表示清单来自 git ls-files(已跟踪的文件)。 */
function listFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const files = out.split("\0").filter(Boolean);
    if (files.length) return { files, git: true };
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
  return { files: acc.sort(), git: false };
}

/** 已跟踪文件相对提交有几条未提交的改动(暂存的也算);git 跑不了 ⇒ null。 */
function dirtyCount(root) {
  try {
    const out = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no", "--", "."],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return out.split("\n").filter(Boolean).length;
  } catch { return null; }
}

/** 扫一棵树 ⇒ { files: 扫过内容的文件数, hits, skipped: [{ file, why }], failed: [{ file, why }], dirty }。
 *  `io` 只给自测注入用:list(root) / read(绝对路径) / dirty(root)。 */
export function scanTree(root, extra = [], io = {}) {
  const { files: all, git } = (io.list || listFiles)(root);
  const read = io.read || ((p) => fs.readFileSync(p));
  const hits = [], skipped = [], failed = [];
  let files = 0;
  for (const f of all) {
    for (const h of scanText(f, extra)) hits.push({ file: f, ...h, line: 0 });          // 路径名本身
    if (BINARY_EXT.test(f)) { skipped.push({ file: f, why: "二进制扩展名" }); continue; }
    let buf;
    try { buf = read(path.join(root, f)); } catch (e) {
      // 已跟踪但工作区里没有 = 一条未提交的删除:归「工作区与提交不一致」那行提示管,列出来、不算失败。别的读失败都算失败。
      if (git && e && e.code === "ENOENT") skipped.push({ file: f, why: "已跟踪但工作区里没有(未提交的删除)" });
      else failed.push({ file: f, why: `读不了(${(e && e.code) || "未知错误"})` });
      continue;
    }
    const texts = decodeTexts(buf);
    if (texts === null) { failed.push({ file: f, why: "含 NUL 字节,既解不成 UTF-16LE 也不是合法 UTF-8(确属二进制的话,把扩展名加进 BINARY_EXT)" }); continue; }
    files++;
    const seen = new Set();                                                              // 两份文本扫到同一处只报一次
    for (const text of texts) for (const h of scanText(text, extra)) {
      const k = `${h.line}:${h.name}`;
      if (!seen.has(k)) { seen.add(k); hits.push({ file: f, ...h }); }
    }
  }
  const dirty = io.dirty ? io.dirty(root) : git ? dirtyCount(root) : null;
  return { files, hits, skipped, failed, dirty };
}

/** 扫描结果 ⇒ { out: 要打印的行, code: 退出码 }。 */
export function summarize(res, dl, verbose = false) {
  const out = [];
  for (const h of res.hits) out.push(`${h.file}:${h.line}:${h.name}${verbose ? `  ${h.text}` : ""}`);
  for (const f of res.failed) out.push(`扫不了:${f.file}  ${f.why}`);
  if (res.skipped.length) {
    out.push(`跳过 ${res.skipped.length} 个文件(没扫内容,路径名照扫):`);
    for (const s of res.skipped) out.push(`  ${s.file}  (${s.why})`);
  }
  if (res.dirty) out.push(`提示:工作区与提交不一致(${res.dirty} 个已跟踪文件有未提交改动),扫的是工作区;推送前请在干净的工作区重跑。`);
  const src = dl.loaded ? `本机清单 ${dl.patterns.length} 条` : "没有加载本机清单(CUSTODIET_PRIVATE_DENYLIST 没设或文件不存在),只跑通用模式";
  out.push(`check-private-identifiers:扫了 ${res.files} 个文本文件,跳过 ${res.skipped.length} 个,扫不了 ${res.failed.length} 个;通用模式 ${GENERIC.length} 条;${src};命中 ${res.hits.length}`);
  return { out, code: res.failed.length ? 2 : res.hits.length ? 1 : 0 };
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
  const pub4 = j("8.8", ".8.8");                         // 公网地址样例(公共 DNS)
  const pub6 = j("2606:4700:", "4700::1111");

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
  t("私仓样式的 GitHub 引用", names(j("git@github.com:", who, "/app-priv", "ate.git")), ["github-private-repo"]);
  t("私仓样式(-internal)", names(j("https://github.com/", who, "/tools-inter", "nal")), ["github-private-repo"]);
  t("行号从 1 起、每行各报", scanText(j("ok\n", "C:/", U, "/", who, "\nok\n/c/", U, "/", who)).map((h) => `${h.line}:${h.name}`), ["2:win-user-home", "4:msys-user-home"]);

  // —— 回修 1:公网地址,带不带协议头都拦 ——
  t("回修1:不带协议头的公网 IPv4", names(j("server = \"", pub4, "\"")), ["public-ipv4"]);
  t("回修1:带协议头的公网 IPv4(只报一次)", names(j("http:", "//", pub4, ":8080/s")), ["public-ipv4"]);
  t("回修1:用户名@公网 IPv4", names(j("ssh root@", pub4)), ["public-ipv4"]);
  t("回修1:公网网段写法", names(j("allow ", pub4.replace(/\d+$/, "0"), "/24")), ["public-ipv4"]);
  t("回修1:组播与子网掩码不在放行段里 ⇒ 拦", [names(j("224.0", ".0.1")), names(j("mask 255.255", ".255.0"))], [["public-ipv4"], ["public-ipv4"]]);
  t("回修1:IPv6 字面量链接", names(j("http:", "//[", pub6, "]/")), ["url-ipv6"]);
  t("回修1:IPv6 字面量链接带端口与用户名", names(j("https:", "//u@[", pub6, "]:8443/x")), ["url-ipv6"]);
  for (const s of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "172.31.255.1", "192.168.1.20", "169.254.1.1", "192.0.2.7", "198.51.100.7", "203.0.113.7",
    "0.0.0.0", "255.255.255.255", "bind 0.0.0.0:8080", "http://[::1]:3000/", "v1.2.3.4", "pkg 1.2.3.4.5", "999.1.1.1", "1.2.3", "arr[1:2]"])
    t(`回修1 反例:${s}`, names(s), []);

  // —— 回修 2:协议头不分大小写 ——
  t("回修2:大写协议头 + 公网 IPv4", names(j("HTTP:", "//", pub4, "/")), ["public-ipv4"]);
  t("回修2:大写协议头 + 不在清单里的站点", names(j("HTTPS:", "//", who, ".dev/x")), ["url-host"]);
  t("回修2:大小写混写的协议头 + IPv6 字面量", names(j("Http:", "//[", pub6, "]/")), ["url-ipv6"]);
  t("回修2 反例:大写协议头 + 保留域", names("HTTPS://X.TEST/a"), []);

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

  // —— 回修 3 / 4 / 5:扫一棵树(文件清单、读文件、改动条数都注入,不碰磁盘)——
  const R = path.resolve(path.sep, "virtual-root");
  const tree = (files, opt = {}) => scanTree(R, dl.patterns, {
    list: () => ({ files: Object.keys(files), git: opt.git !== false }),
    read: (p) => { const v = files[path.relative(R, p).replace(/\\/g, "/")]; if (v instanceof Error) throw v; return v; },
    dirty: () => opt.dirty ?? 0,
  });
  const err = (code) => Object.assign(new Error(code), { code });
  const view = (r) => [r.files, r.hits.map((h) => `${h.file}:${h.line}:${h.name}`), r.skipped.map((s) => s.file), r.failed.map((f) => f.file)];
  const loaded = { loaded: true, patterns: dl.patterns };
  const u16 = (s, bom = true) => Buffer.from((bom ? "\ufeff" : "") + s, "utf16le");
  const u16be = (s) => { const b = Buffer.from("\ufeff" + s, "utf16le"); b.swap16(); return b; };

  t("回修3:UTF-16LE 存的文本(带 BOM)照常扫、行号对", view(tree({ "note.txt": u16(`ok\r\ncd E:/${lit}\r\n`) })), [1, ["note.txt:2:denylist:L3"], [], []]);
  t("回修3:UTF-16LE 不带 BOM 也照常扫", view(tree({ "note.md": u16(`cd E:/${lit}\n`, false) })), [1, ["note.md:1:denylist:L3"], [], []]);
  t("回修3:UTF-16LE 里的通用模式也照常扫", view(tree({ "a.txt": u16(j("server = ", pub4, "\n")) })), [1, ["a.txt:1:public-ipv4"], [], []]);
  t("回修3:二进制扩展名不扫内容,但列进跳过清单", view(tree({ "doc/a.pdf": Buffer.from(lit), "img/b.jpg": Buffer.from([0xff, 0xd8, 0, 1]) })), [0, [], ["doc/a.pdf", "img/b.jpg"], []]);
  t("回修3:二进制扩展名的路径名照扫", view(tree({ [`img/${lit}.png`]: Buffer.from([1]) })), [0, [`img/${lit}.png:0:denylist:L3`], [`img/${lit}.png`], []]);
  t("回修3:UTF-16LE 不带 BOM 的 ASCII 内容两份文本都解得通 ⇒ 同一处只报一次", view(tree({ "two.txt": u16(`ok\ncd E:/${lit}\n`, false) })), [1, ["two.txt:2:denylist:L3"], [], []]);
  t("回修3:UTF-8 源码里夹一个字面 NUL ⇒ 照 UTF-8 扫,不算失败", view(tree({ "src.mjs": Buffer.concat([Buffer.from("const sep = \""), Buffer.from([0]), Buffer.from(`";\ncd E:/${lit}\n`)]) })), [1, ["src.mjs:2:denylist:L3"], [], []]);
  t("回修3:含 NUL、既解不成 UTF-16LE 也不是合法 UTF-8 ⇒ 失败", view(tree({ "x.dat": Buffer.from([0xff, 0, 0x62]) })), [0, [], [], ["x.dat"]]);
  t("回修3:大端 UTF-16(带 BOM)⇒ 失败,不当成文本乱扫", view(tree({ "be.txt": u16be(lit) })), [0, [], [], ["be.txt"]]);
  t("回修3:大端 UTF-16(不带 BOM)的 ASCII 内容 ⇒ 去掉 NUL 那一份照样拦得到", view(tree({ "be2.txt": u16be(lit).subarray(2) })), [1, ["be2.txt:1:denylist:L3"], [], []]);
  t("回修3:大端 UTF-16(不带 BOM)的非 ASCII 内容 ⇒ 失败", view(tree({ "be3.txt": u16be(j("这", "是\n")).subarray(2) })), [0, [], [], ["be3.txt"]]);
  t("回修3:落单的代理项 ⇒ 失败", view(tree({ "s.txt": Buffer.from([0x61, 0, 0x00, 0xd8, 0x62, 0]) })), [0, [], [], ["s.txt"]]);
  {
    const s = summarize(tree({ "ok.md": Buffer.from("ok\n"), "img/b.jpg": Buffer.from([0]), "x.dat": Buffer.from([0xff, 0, 0x62]) }), loaded);
    t("回修3:输出里写明跳过了几个、各是什么;解不成 ⇒ 退出 2", [s.code, s.out.filter((l) => /跳过 1 个文件|^ {2}img\/b\.jpg {2}\(二进制扩展名\)|^扫不了:x\.dat/.test(l)).length, /扫了 1 个文本文件,跳过 1 个,扫不了 1 个/.test(s.out.at(-1))], [2, 3, true]);
  }

  t("回修4:读文件失败(EACCES)⇒ 记失败、不当成安全跳过", view(tree({ "note.md": err("EACCES"), "ok.md": Buffer.from("ok\n") })), [1, [], [], ["note.md"]]);
  {
    const s = summarize(tree({ "note.md": err("EACCES") }), loaded);
    t("回修4:读文件失败 ⇒ 打印路径、退出 2", [s.code, s.out.some((l) => l === "扫不了:note.md  读不了(EACCES)")], [2, true]);
    const both = summarize(tree({ "note.md": err("EIO"), "hit.md": Buffer.from(lit) }), loaded);
    t("回修4:失败与命中并存 ⇒ 命中照打、退出 2", [both.code, both.out.includes("hit.md:1:denylist:L3")], [2, true]);
  }
  t("回修4:目录遍历模式下文件不见了 ⇒ 也算失败", view(tree({ "gone.md": err("ENOENT") }, { git: false })), [0, [], [], ["gone.md"]]);

  {
    const dirtyRun = tree({ "ok.md": Buffer.from("ok\n") }, { dirty: 3 });
    const s = summarize(dirtyRun, loaded);
    t("回修5:已跟踪文件有未提交改动 ⇒ 打一行提示、退出码不变", [s.code, s.out.filter((l) => /^提示:工作区与提交不一致\(3 个已跟踪文件有未提交改动\),扫的是工作区;推送前请在干净的工作区重跑。$/.test(l)).length], [0, 1]);
    const hitRun = summarize(tree({ "hit.md": Buffer.from(lit) }, { dirty: 1 }), loaded);
    t("回修5:有改动又有命中 ⇒ 提示照打、退出码仍是 1", [hitRun.code, hitRun.out.some((l) => l.startsWith("提示:工作区与提交不一致"))], [1, true]);
    const clean = summarize(tree({ "ok.md": Buffer.from("ok\n") }), loaded);
    t("回修5 反例:工作区干净 ⇒ 不打提示", clean.out.some((l) => l.startsWith("提示:")), false);
    const gone = tree({ "gone.md": err("ENOENT"), "ok.md": Buffer.from("ok\n") }, { dirty: 1 });
    t("回修5:已跟踪但工作区里删了 ⇒ 列进跳过清单、不算失败、提示照打", [view(gone), summarize(gone, loaded).code, summarize(gone, loaded).out.some((l) => l.startsWith("提示:"))], [[1, [], ["gone.md"], []], 0, true]);
  }

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
  const { out, code } = summarize(scanTree(root, dl.patterns), dl, verbose);
  for (const l of out) console.log(l);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
