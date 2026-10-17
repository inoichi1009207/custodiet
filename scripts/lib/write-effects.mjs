// write-effects.mjs — 一条 bash 命令会写哪些文件(写入效果分析;批 259 / D158)。
//
// 为什么有它:收尾闸 I / J / G / L 共用的 touched() 原先靠手写分词器 + 整串正则兜底判「写了哪些载体 / 法条」,
//   批 258 五轮红队每轮都打出新形态(`grep cp …` 的 cp 是参数、heredoc 正文是数据、`$(cp …)` 才执行、
//   `cd docs/laws; cp a collab.md` 的相对目录……)。codex 259-d158-design-r1 的结论:判定单位应是「一项写入效果」,
//   语法交给真解析器,整串兜底撤掉。外部先例(docs/external-precedents.md 2026-10-12):自写分词器
//   「quote-nesting, substitutions, and heredocs become ours to maintain forever」。
//
// 做什么:用 tree-sitter-bash(scripts/gate-deps/ 下单独装,与网站依赖隔开)把命令解析成语法树,
//   在**命令位**上认写命令(cp/mv/install/tee/sed -i/perl -i/touch/ln/dd/rsync/truncate/git mv),
//   独立认输出重定向,递归进 `bash -c`、喂给 shell 的 heredoc、命令替换、find -exec、包装器(sudo/env/xargs/timeout…);
//   解释器内联脚本(`node -e`、`python - <<EOF`)只扫**被执行的载荷**里的写 API(writeFileSync / open(…,'w') …),
//   提交信息、grep 模式等普通字符串不扫。顺序跟踪字面量 `cd`,相对目标按当时目录拼。
//   PowerShell / cmd 载荷不在本模块(调用方退回旧解析器)。
//
// 返回 { ok, effects:[{ path?, known, expr, suffix?, via }], incomplete:[] }:
//   known=true  ⇒ path 是归一后的路径(仓根以下转相对);
//   known=false ⇒ 目标含展开(`$ROOT/AGENTS.md`)解不出,expr 是原文,suffix 是去掉开头展开后的字面尾巴(`AGENTS.md`),
//                 调用方用 suffix 判「是否可能落在保护面」;解释器载荷 / 内层脚本解不出路径时另给 hint(载荷原文),
//                 调用方看载荷里有没有保护面路径;suffix 与 hint 都没有(`> "$OUT"`)⇒ 判不了落点,不算触及(天花板);
//   ok=false    ⇒ 解析器缺席或语法树有错(语料实测 0.4%),调用方退回旧判法(不静默放行)。
// 天花板:alias / 函数 / 变量的运行时值、脚本文件内部的副作用、git hook 都看不见(codex 259-d158-design-r1 C)。
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

let PARSER;   // undefined=未试;null=缺席
export function bashParser() {
  if (PARSER !== undefined) return PARSER;
  // 先找本 checkout 的 scripts/gate-deps;新开的 git worktree 不带 node_modules(只追踪 package.json / lock)⇒ 再找主 checkout
  //   (红队 a391d46c 疑似项:worktree 里静默退回旧判法)
  const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gate-deps");
  const cands = [here];
  try {
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path.dirname(here), encoding: "utf8", timeout: 5000 });
    if (common.status === 0 && common.stdout.trim()) cands.push(path.join(path.dirname(common.stdout.trim()), "scripts", "gate-deps"));
  } catch { /* 不是 git 仓 */ }
  PARSER = null;
  for (const dir of cands) {
    try {
      const req = createRequire(path.join(dir, "package.json"));
      const Parser = req("tree-sitter");
      const p = new Parser();
      p.setLanguage(req("tree-sitter-bash"));
      PARSER = p;
      break;
    } catch { /* 下一个 */ }
  }
  return PARSER;
}

const SHELLS = /^(?:bash|sh|zsh|dash)$/;
const INTERP = /^(?:node|nodejs|deno|bun|python|python3|py|ruby|perl)$/;
const NON_SHELL_INTERP = /^(?:powershell|pwsh|cmd)$/i;
const WRAPPERS = {
  sudo: { s: "ugpCDrRtTU" }, doas: { s: "uC" }, env: { s: "uCS" }, xargs: { s: "IdEaLnPs" },
  nice: { s: "n" }, ionice: { s: "cnp" }, nohup: {}, command: {}, busybox: {}, builtin: {}, exec: { s: "a" },
  time: { s: "fo" }, stdbuf: { s: "ioe" }, timeout: { s: "sk", pos: 1 },
};
// 写 API(只扫被执行的解释器载荷)。与 hook-stop-closure 的 API_WRITE_RES 同口径。
const API_WRITE_RES = [
  /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*(['"`])([^'"`]+)\1/g,
  // 复制 / 改名类写的是**第二个**参数(codex 259-final-r1 附节 2:原先统一取首参,把源文件当成写目标)。
  //   名字须是 fs 的(`*Sync` 专名,或 `fs.` / `fsp.` / `promises.` 前缀的 copyFile / rename / cp)——
  //   裸 `cp(` / `rename(` 可能是自定义函数(codex 259-final2-r1 B1)
  new RegExp(String.raw`(?:\b(?:copyFileSync|renameSync|cpSync)|\b(?:fs|fsp|fsPromises|promises)\s*\.\s*(?:copyFile|rename|cp))\s*\(\s*(?:['"\x60][^'"\x60]*['"\x60]|[\w.$]+)\s*,\s*(['"\x60])([^'"\x60]+)\1`, "g"),
  /\bopen\s*\(\s*[rRbBuU]?(['"])([^'"]+)\1\s*,\s*(?:mode\s*=\s*)?[rRbBuU]?['"][^'"]*[wax+][^'"]*['"]/g,
  /\bPath\s*\(\s*[rR]?(['"])([^'"]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|open\s*\(\s*['"][^'"]*[wax+])/g,
];
const API_ANY = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|copyFileSync|renameSync|cpSync)\s*\(|\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|\.write_text\s*\(|\.write_bytes\s*\(/;
// 写调用的落点参数不是字面量(变量、path.join、模板串带插值……):写类看第一参,复制 / 改名类看第二参(codex 259-final2-r1 附节 2)
const NONLIT_API = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*(?!['"][^'"]*['"]\s*[,)])|(?:\b(?:copyFileSync|renameSync|cpSync)|\b(?:fs|fsp|fsPromises|promises)\s*\.\s*(?:copyFile|rename|cp))\s*\(\s*(?:['"][^'"]*['"]|[\w.$]+)\s*,\s*(?!['"][^'"]*['"]\s*[,)])|\bopen\s*\(\s*(?!['"])[^,)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|\.write_text\s*\(|\.write_bytes\s*\(/;
// 改名 / 移动类的源路径被移走(op=delete;codex 259-final2-r1 附节 1:只认第二参后丢了这一效果)
const RENAME_SRC_RE = /(?:\brenameSync|\b(?:fs|fsp|fsPromises|promises)\s*\.\s*rename|\bos\s*\.\s*(?:rename|replace)|\bshutil\s*\.\s*move)\s*\(\s*(['"])([^'"]+)\1/g;
const NULL_SINK = /^(?:\/dev\/(?:null|stdout|stderr|tty)|\$null|nul)$/i;
// 未知命令退路用:参数里出现这些名字 ⇒ 从那里当一条命令再分析;这些命令的参数本身不是命令(`grep cp …` 的 cp 是参数)
const WRITE_CMDS = /^(?:cp|mv|install|ln|rsync|tee|touch|truncate|dd|sed|perl|rm|bash|sh|zsh|dash|node|python|python3|eval)$/;
// 含常见的检索类(findstr / zgrep / pgrep / fd …;红队 a391d46c BP-6:检索词恰好是 cp 时被当成包装器)
const READ_ONLY_CMDS = /^(?:grep|egrep|fgrep|zgrep|zegrep|xzgrep|bzgrep|zcat|findstr|pgrep|pkill|fd|locate|tldr|rg|ag|ack|echo|printf|cat|less|more|head|tail|wc|sort|uniq|cut|tr|ls|dir|stat|file|diff|cmp|awk|gawk|jq|which|type|command|man|help|test|\[|true|false|basename|dirname|realpath|readlink|date|sleep|seq|column|fold|nl|od|hexdump|xxd|base64|sha256sum|md5sum|git|gh|curl|wget|npm|pnpm|npx|claude|codex|ssh|scp|code|start|explorer)$/;
const baseName = (v) => path.basename(String(v).replace(/\\/g, "/")).replace(/\.exe$/i, "");
/** 跳过包装器自己的选项(带值的连值跳)与 env 的 VAR=…、timeout 的时长,返回内层命令名所在下标。 */
function skipWrapperOpts(name, ws) {
  const spec = WRAPPERS[name] || {};
  let k = 0;
  while (k < ws.length && ws[k].v != null && /^-./.test(ws[k].v)) {
    if (ws[k].v === "--") { k++; break; }
    const takes = (spec.s && /^-[A-Za-z]$/.test(ws[k].v) && spec.s.includes(ws[k].v[1])) || (name === "env" && /^--(?:unset|chdir|split-string)$/.test(ws[k].v));
    k += takes ? 2 : 1;
  }
  if (name === "env") while (k < ws.length && ws[k].v != null && /^[A-Za-z_]\w*=/.test(ws[k].v)) k++;
  return k + (spec.pos || 0);
}

/** 一个参数节点的字面值;含展开 ⇒ null(另给 raw 原文)。 */
function literal(n) {
  switch (n.type) {
    case "word": return n.text.replace(/\\(.)/g, "$1");
    case "string_content": return n.text;
    case "raw_string": return n.text.slice(1, -1);
    // `$'…'`:去掉 `$'` 与 `'`,常见转义按字面(路径里本不该有;红队 259 BP-6)
    case "ansi_c_string": return n.text.slice(2, -1).replace(/\\(['"\\])/g, "$1");
    case "number": return n.text;
    case "string": {
      let s = "";
      for (let i = 0; i < n.namedChildCount; i++) {
        const k = n.namedChild(i);
        if (k.type !== "string_content") return null;
        s += k.text;
      }
      return s;
    }
    case "concatenation": {
      let s = "";
      for (let i = 0; i < n.namedChildCount; i++) { const v = literal(n.namedChild(i)); if (v == null) return null; s += v; }
      return s;
    }
    default: return null;
  }
}
/** 含展开的参数:去掉开头的展开后剩下的字面尾巴(`"$ROOT/AGENTS.md"` ⇒ `AGENTS.md`)。没有字面尾巴 ⇒ ""。 */
function literalSuffix(n) {
  const kids = [];
  const flat = (x) => {
    if (x.type === "string" || x.type === "concatenation") { for (let i = 0; i < x.namedChildCount; i++) flat(x.namedChild(i)); }
    else kids.push(x);
  };
  flat(n);
  let i = kids.length;
  let s = "";
  while (i > 0) {
    const k = kids[i - 1];
    const v = k.type === "string_content" || k.type === "word" || k.type === "raw_string" ? literal(k) : null;
    if (v == null) break;
    s = v + s; i--;
  }
  return s.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** 含展开的参数整串转「形状」:字面照抄,展开换成 `X`(`.claude/skills/$N/SKILL.md` ⇒ `.claude/skills/X/SKILL.md`)。
 *  红队 259 BP-1:只看字面尾巴时,变量夹在路径中段(批量造件的常见写法)尾巴只剩 `SKILL.md`,整条效果被丢掉。 */
function shapeOf(n) {
  const v = literal(n);
  if (v != null) return v;
  if (n.type === "string" || n.type === "concatenation") {
    let s = "";
    for (let i = 0; i < n.namedChildCount; i++) s += shapeOf(n.namedChild(i));
    return s;
  }
  return "X";
}
const GLOB = /[*?[]/;

function joinCwd(cwd, p) {
  let s = String(p).replace(/\\/g, "/");
  s = s.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~");
  const abs = /^(?:[A-Za-z]:\/|\/|~)/.test(s);
  if (!abs && cwd) s = cwd + "/" + s;
  return s;
}
function normalize(p, root) {
  let s = String(p).replace(/\\/g, "/");
  const parts = [];
  const lead = (s.match(/^(?:[A-Za-z]:\/|\/|~\/?)/) || [""])[0];
  for (const seg of s.slice(lead.length).split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  s = lead + parts.join("/");
  if (root) {
    for (const r of rootForms(root)) if (s.toLowerCase().startsWith(r)) { s = s.slice(r.length); break; }
  }
  return s;
}
function rootForms(root) {
  const r = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  const forms = [r];
  const m = r.match(/^([A-Za-z]):\/(.*)$/);
  if (m) forms.push(`/${m[1].toLowerCase()}/${m[2]}`, `/mnt/${m[1].toLowerCase()}/${m[2]}`);
  return forms.map((f) => f.toLowerCase() + "/");
}

/** 主入口。opts.root = 仓根(用于把仓内绝对路径转相对);opts.cwd = 起始相对目录(缺省仓根)。 */
export function analyzeBash(cmd, opts = {}) {
  const parser = bashParser();
  const res = { ok: false, effects: [], incomplete: [] };
  if (!parser) { res.incomplete.push("解析器缺席(scripts/gate-deps 未装)"); return res; }
  let tree;
  try { tree = parser.parse(String(cmd)); } catch (e) { res.incomplete.push("解析异常:" + String(e && e.message || e)); return res; }
  if (tree.rootNode.hasError) { res.incomplete.push("语法树有错"); return res; }
  res.ok = true;
  const root = opts.root ?? process.cwd();
  // op:"write"(可能新建的落点)/"modify"(只改既有文件,如 sed -i,不会新建)/"delete"(rm、mv 的源)。
  //   调用方判「新建」时只看 write(红队 a391d46c BP-8:`sed -i … "scripts/$name.mjs"` 改既有脚本被 I 判新建)
  const isAbs = (s) => /^(?:[A-Za-z]:[\\/]|\/|~)/.test(s);
  const pushLit = (s, cwd, via, op, expr) => {
    if (!s || NULL_SINK.test(s)) return;
    // 花括号展开 `docs/laws/{a,b}.md`(红队 a391d46c (b))
    const br = s.match(/^([^{}]*)\{([^{}]*,[^{}]*)\}(.*)$/);
    if (br) { for (const alt of br[2].split(",")) pushLit(br[1] + alt + br[3], cwd, via, op, expr); return; }
    // 目录未知(cd -、cd "$D")时的相对目标:落点不知道,按 `X/目标` 形状判(红队 a391d46c BP-2;原先把未知目录当仓根)
    if (cwd === null && !isAbs(s)) { res.effects.push({ known: false, expr, suffix: "", pattern: "X/" + s.replace(/\\/g, "/"), via, op }); return; }
    const p = normalize(joinCwd(cwd, s), root);
    // 通配路径(`cp /tmp/*.mjs scripts/`、`sed -i … docs/laws/*.md`):落点不确定,按形状判(红队 259 BP-7)
    if (GLOB.test(s)) res.effects.push({ known: false, expr, suffix: "", pattern: p.replace(/[*?]|\[[^\]]*\]/g, "X"), via, op });
    else res.effects.push({ known: true, path: p, expr, via, op });
  };
  const add = (n, cwd, via, op = "write") => {
    const v = literal(n);
    if (v != null) return pushLit(v, cwd, via, op, n.text);
    res.effects.push({ known: false, expr: n.text, suffix: literalSuffix(n), pattern: normalize(joinCwd(cwd ?? "X", shapeOf(n)), root), via, op });
  };
  const addLit = (s, cwd, via, op = "write") => pushLit(s, cwd, via, op, s);
  // 落点是磁盘上已有的目录(`cp x.md docs/laws`、`mv a.mjs scripts`,不带尾斜杠):落点 = 目录 + 源文件名(红队 a391d46c (b),最常见的漏放)
  const isDirOnDisk = (s, cwd) => {
    if (cwd === null || /[$*?{]/.test(s)) return false;
    try { return fs.statSync(path.resolve(root, joinCwd(cwd, s).replace(/^~(?=\/|$)/, os.homedir()))).isDirectory(); } catch { return false; }
  };
  const scanPayload = (text, cwd, via) => {
    const T = String(text);
    for (const re of API_WRITE_RES) { re.lastIndex = 0; for (const m of T.matchAll(re)) addLit(m[2], cwd, via); }
    RENAME_SRC_RE.lastIndex = 0;
    for (const m of T.matchAll(RENAME_SRC_RE)) addLit(m[2], cwd, via + "(改名源)", "delete");
    // 写调用的路径不是字面量(`writeFileSync(f, …)`、`path.join(root, 'AGENTS.md')`):载荷里出现的文件名字面量都当「可能被写」的候选,
    //   逐个给出——调用方据此逐路径判新旧(改既有文件不算新建);一个都没有 ⇒ 未知效果 + 载荷原文作 hint。
    //   (2026-10-12 整会话回放:不这样做时 54 条「node 脚本改既有闸文件」被 I 当成新建载体)
    //   红队 259 BP-9:原先只要有一处字面路径命中就不再看非字面的写调用;候选也须带分隔符,`'AGENTS.md'` 漏掉——两处都改。
    if (!NONLIT_API.test(T)) return;
    // 候选(红队 a391d46c BP-1 / BP-3 后收紧):
    //   ① 带分隔符、末段带扩展名的路径字面量(`'scripts/lib/x.mjs'`);
    //   ② 裸文件名(`'AGENTS.md'`)只在路径构造调用的实参里才算(path.join / resolve / Path(…) / open(…))——
    //      替换文本、断言字符串里提到的 `AGENTS.md` 不是落点(BP-3 语料实撞 3 条);
    //   ③ 带插值的路径(f'{root}/docs/laws/x.md'、`${root}/AGENTS.md`):插值换 X,按形状判(BP-1)。
    //   有非字面写调用时 hint 照给(只供不问新旧的调用方用,见 touched)。
    const seen = new Set();
    for (const m of T.matchAll(/(['"`])((?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])?[\w.@~-]+(?:[\\/][\w.@~-]+)+)\1/g))
      if (/[\\/][\w@~-][\w.@~-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(m[2])) seen.add(m[2]);
    for (const m of T.matchAll(/\b(?:join|resolve|Path|open|PurePath)\s*\(((?:[^()]|\([^()]*\))*)\)/g))
      for (const q of m[1].matchAll(/(['"])([\w@~-][\w.@~-]*\.[A-Za-z][A-Za-z0-9]{0,7})\1/g)) seen.add(q[2]);
    for (const c of seen) addLit(c, cwd, via + "(载荷里的路径,可能被写)");
    for (const m of T.matchAll(/(?:\bf|\$)?(['"`])([^'"`\n]*(?:\{[^}\n]*\})[^'"`\n]*)\1/g)) {
      const shape = m[2].replace(/\$?\{[^}]*\}/g, "X").replace(/\\/g, "/");
      if (/\//.test(shape) && /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(shape)) res.effects.push({ known: false, expr: m[0], suffix: "", pattern: shape, via: via + "(插值路径)", op: "write" });
    }
    res.effects.push({ known: false, expr: via + " 载荷里的写调用(路径非字面量)", suffix: "", hint: T, via, op: "write", hintOnly: true });
  };
  const nested = (script, cwd, depth, via) => {
    if (depth > 4) { res.incomplete.push("嵌套过深"); return; }
    const sub = analyzeBash(script, { root, cwd });
    if (!sub.ok) { res.incomplete.push(`${via} 内层解析失败`); res.effects.push({ known: false, expr: via + " 内层脚本", suffix: "", hint: String(script), via }); return; }
    for (const e of sub.effects) res.effects.push({ ...e, via: via + "→" + e.via });
  };

  // 走树。state.cwd 在同一序列里被字面量 cd 改写;子壳 / 管道各段拿副本。
  const visit = (n, state, depth) => {
    switch (n.type) {
      case "subshell": {
        // 子壳里的 cd 在子壳内顺序生效、不传出:整个子壳共用一份副本(codex 259-final-r1 附节 2:原先每个子节点各复制一次)
        const inner = { ...state };
        for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), inner, depth);
        return;
      }
      case "pipeline": {
        const segs = [];
        for (let i = 0; i < n.namedChildCount; i++) segs.push(n.namedChild(i));
        segs.forEach((s, i) => {
          visit(s, { ...state }, depth);
          // 下游是从 stdin 读程序的 shell(`cat <<'EOF' | bash`、`echo "cp …" | sh`):上游吐出的字面文本就是被执行的脚本(红队 259 BP-8)
          if (i === 0) return;
          const down = effCmd(s);
          if (!down || !SHELLS.test(down.name) || down.rest.some((w) => w.v == null || !/^-/.test(w.v))) return;
          const text = emittedText(segs[i - 1]);
          if (text != null) nested(text, state.cwd, depth + 1, `${down.name} ← 管道`);
          else res.effects.push({ known: false, expr: `${down.name} 从管道读的脚本`, suffix: "", hint: segs[i - 1].text, via: down.name, op: "write" });
        });
        return;
      }
      case "redirected_statement": {
        const body0 = n.childForFieldName("body");
        // 只有重定向、没有命令(`> AGENTS.md`、`: > x`以外的裸截断):全部子节点都是重定向(codex 259-final-r1 附节 2)
        if (!body0) {
          const redirs = [];
          for (let i = 0; i < n.namedChildCount; i++) redirs.push(n.namedChild(i));
          handleRedirects(redirs, null, state, depth);
          return;
        }
        const body = body0;
        const redirs = [], extra = [];
        for (let i = 0; i < n.namedChildCount; i++) {
          const k = n.namedChild(i);
          if (k === body || k.id === body.id) continue;
          redirs.push(k);
          // `cp > /dev/null a b`:tree-sitter 把重定向后的词全挂成 destination,第一个之后的是命令参数(红队 259 BP-2)
          if (k.type === "file_redirect") {
            const dests = [];
            for (let j = 0; j < k.namedChildCount; j++) if (k.namedChild(j).type !== "file_descriptor") dests.push(k.namedChild(j));
            extra.push(...dests.slice(1));
          }
        }
        handleRedirects(redirs, body, state, depth);
        if (body.type === "command") command(body, state, depth, extra);
        else visit(body, state, depth);
        return;
      }
      case "command": return command(n, state, depth);
      default:
        for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), state, depth);
    }
  };
  // 命令的「实际命令名」:剥掉包装器(`sudo bash <<EOF` 的程序接收者是 bash,红队 259 BP-8)。返回 {name, rest} 或 null
  const effCmd = (node) => {
    if (node && node.type === "redirected_statement") node = node.childForFieldName("body") || node.namedChild(0);
    if (!node || node.type !== "command") return null;
    const nm = node.childForFieldName("name");
    const v = nm ? literal(nm.namedChild(0) || nm) : null;
    if (v == null) return null;
    const args = [];
    let seen = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const k = node.namedChild(i);
      if (k.type === "command_name") { seen = true; continue; }
      if (seen && !/redirect$/.test(k.type)) args.push({ node: k, v: literal(k) });
    }
    let name = baseName(v), ws = args;
    for (let guard = 0; guard < 4 && Object.hasOwn(WRAPPERS, name); guard++) {
      const k = skipWrapperOpts(name, ws);
      if (k >= ws.length || ws[k].v == null) return { name, rest: [] };
      name = baseName(ws[k].v); ws = ws.slice(k + 1);
    }
    return { name, rest: ws };
  };
  // 管道上游吐出的字面文本:heredoc 正文、echo / printf 的字面参数;取不到 ⇒ null
  const emittedText = (node) => {
    const body = node && node.type === "redirected_statement" ? (node.childForFieldName("body") || node.namedChild(0)) : node;
    const c = effCmd(body);
    if (node && node.type === "redirected_statement") {
      for (let i = 0; i < node.namedChildCount; i++) {
        const r = node.namedChild(i);
        if (r.type === "heredoc_redirect") for (let j = 0; j < r.namedChildCount; j++) if (r.namedChild(j).type === "heredoc_body") return r.namedChild(j).text;
      }
    }
    if (c && /^(?:echo|printf)$/.test(c.name)) {
      const parts = c.rest.filter((w) => !(w.v != null && /^-[neE]+$/.test(w.v)));
      if (parts.every((w) => w.v != null)) return parts.map((w) => w.v).join(" ");
    }
    return null;
  };
  const cmdNameOf = (node) => { const c = effCmd(node); return c ? c.name : ""; };
  const handleRedirects = (redirs, body, state, depth) => {
    for (const r of redirs) {
      if (r.type === "file_redirect") {
        const op = r.text;
        const dest = r.childForFieldName("destination") || r.namedChild(r.namedChildCount - 1);
        if (!dest || dest.type === "file_descriptor") continue;
        if (/^\s*(?:\d+)?</.test(op) && !/>/.test(op)) continue;         // 输入重定向
        if (/>&\s*\d+\s*$|>&-/.test(op)) continue;                        // fd 复制 / 关闭
        add(dest, state.cwd, "重定向");
      } else if (r.type === "heredoc_redirect") {
        // `cat <<'EOF' | bash`:tree-sitter 把 heredoc 挂在整条管道上;下游末段是从 stdin 读程序的 shell ⇒ 正文就是被执行的脚本
        //   (红队 a391d46c 附节二①:原先解析成功、效果为空,静默放行)
        let name = cmdNameOf(body);
        if (body && body.type === "pipeline" && body.namedChildCount > 1) {
          const last = effCmd(body.namedChild(body.namedChildCount - 1));
          if (last && SHELLS.test(last.name) && !last.rest.some((w) => w.v == null || !/^-/.test(w.v)) && !last.rest.some((w) => w.v === "-n")) name = last.name;
        }
        const bodyNode = (() => { for (let i = 0; i < r.namedChildCount; i++) if (r.namedChild(i).type === "heredoc_body") return r.namedChild(i); return null; })();
        const text = bodyNode ? bodyNode.text : "";
        if (SHELLS.test(name)) nested(text, state.cwd, depth + 1, `${name} heredoc`);
        else if (INTERP.test(name)) scanPayload(text, state.cwd, `${name} heredoc`);
        else if (NON_SHELL_INTERP.test(name)) res.effects.push({ known: false, expr: `${name} heredoc(本模块不解 PowerShell/cmd)`, suffix: "", via: name });
        // 其余命令(cat 等)吃的是数据;未引用定界符里的命令替换由下面的通用遍历照常进
        if (bodyNode) for (let i = 0; i < bodyNode.namedChildCount; i++) visit(bodyNode.namedChild(i), { ...state }, depth);
        // heredoc 后同行的 `> 文件`(`cat <<'EOF' > x`)在 heredoc_redirect 里作子节点
        for (let i = 0; i < r.namedChildCount; i++) { const k = r.namedChild(i); if (k.type === "file_redirect") handleRedirects([k], body, state, depth); }
        // heredoc 起头那行后面接的管道 / `&&` 命令,tree-sitter 也挂在 heredoc_redirect 底下(D160①:原先不遍历 ⇒ 解析成功、效果为空、静默放行)。
        //   `cat <<'EOF' | bash`:管道下游第一段是从 stdin 读程序的 shell ⇒ 正文就是被执行的脚本;`| tee AGENTS.md`、`&& cp …` 照常分析
        for (let i = 0; i < r.namedChildCount; i++) {
          const k = r.namedChild(i);
          if (/^(?:heredoc_start|heredoc_body|heredoc_end|file_redirect)$/.test(k.type)) continue;
          if (k.type === "pipeline" && k.namedChildCount > 0) {
            const down = effCmd(k.namedChild(0));
            // 只认「真从 stdin 执行程序」的下游(批 260 红队 a700dedc BP-1~3):
            //   有脚本参数(含动态的 `"$F"`)⇒ 正文是喂给脚本的数据;shell 的 -n(含选项簇 -nv / -en)、node 的 --check / -c 只做语法检查
            const hasScriptArg = (ws) => ws.some((w) => w.v == null || (!/^-/.test(w.v) && w.v !== "-"));
            const shellNoexec = (ws) => ws.some((w) => w.v != null && /^-[A-Za-z]*n[A-Za-z]*$/.test(w.v) && !/^--/.test(w.v));
            const interpCheckOnly = (ws) => ws.some((w) => w.v != null && /^(?:--check|-c)$/.test(w.v));
            if (down && SHELLS.test(down.name) && !hasScriptArg(down.rest) && !shellNoexec(down.rest)) nested(text, state.cwd, depth + 1, `${down.name} ← heredoc 管道`);
            else if (down && /^(?:node|nodejs|deno|bun)$/.test(down.name) && !hasScriptArg(down.rest) && !interpCheckOnly(down.rest)) scanPayload(text, state.cwd, `${down.name} ← heredoc 管道`);
            else if (down && INTERP.test(down.name) && !/^(?:node|nodejs|deno|bun)$/.test(down.name) && !hasScriptArg(down.rest)
              && !down.rest.some((w) => w.v === "-c")) scanPayload(text, state.cwd, `${down.name} ← heredoc 管道`);
          }
          visit(k, state, depth);
        }
      } else if (r.type === "herestring_redirect") {
        // `bash <<< "…"`、`node <<< "…"`:与 heredoc 同一条「程序 vs 数据」分派(红队 259 BP-3 / BP-8)
        const name = cmdNameOf(body);
        const val = r.namedChild(r.namedChildCount - 1);
        const text = val ? literal(val) : null;
        for (let i = 0; i < r.namedChildCount; i++) visit(r.namedChild(i), { ...state }, depth);
        if (SHELLS.test(name)) {
          if (text != null) nested(text, state.cwd, depth + 1, `${name} <<<`);
          else res.effects.push({ known: false, expr: `${name} <<< 动态脚本`, suffix: "", hint: r.text, via: name, op: "write" });
        } else if (INTERP.test(name)) scanPayload(text ?? r.text, state.cwd, `${name} <<<`);
      }
    }
  };
  const command = (n, state, depth, extraArgs = []) => {
    // 先遍历参数里的命令替换 / 进程替换(它们会执行)
    const args = [], redirs = [];
    let nameNode = null;
    for (let i = 0; i < n.namedChildCount; i++) {
      const k = n.namedChild(i);
      if (k.type === "command_name") nameNode = k;
      else if (k.type === "variable_assignment") { for (let j = 0; j < k.namedChildCount; j++) visit(k.namedChild(j), { ...state }, depth); }
      else if (k.type === "file_redirect" || k.type === "heredoc_redirect" || k.type === "herestring_redirect") {
        redirs.push(k);
        // tree-sitter-bash 把重定向后面的词全挂成 destination(`cp > /dev/null a b`):第一个之后的都是命令参数(红队 259 BP-2)
        if (k.type === "file_redirect") {
          const dests = [];
          for (let j = 0; j < k.namedChildCount; j++) if (k.namedChild(j).type !== "file_descriptor") dests.push(k.namedChild(j));
          if (nameNode) args.push(...dests.slice(1));
        }
      }
      else if (nameNode) args.push(k);
    }
    args.push(...extraArgs);
    for (const a of args) visit(a, { ...state }, depth);   // 参数里的 $(…) 照常分析
    if (nameNode) for (let j = 0; j < nameNode.namedChildCount; j++) visit(nameNode.namedChild(j), { ...state }, depth);
    handleRedirects(redirs, n, state, depth);
    if (!nameNode) return;
    const nmLit = literal(nameNode.namedChild(0) || nameNode);
    if (nmLit == null) { res.incomplete.push("动态命令名:" + nameNode.text); return; }
    dispatch(path.basename(nmLit.replace(/\\/g, "/")).replace(/\.exe$/i, ""), args, state, depth, n);
  };
  const lits = (args) => args.map((a) => ({ node: a, v: literal(a) }));
  const nonOpt = (ws) => ws.filter((w) => !(w.v != null && /^-/.test(w.v) && w.v !== "-"));
  const dispatch = (name, args, state, depth, cmdNode) => {
    const ws = lits(args);
    if (Object.hasOwn(WRAPPERS, name)) {
      // env -C DIR / --chdir=DIR:内层命令在 DIR 里跑(红队 259 BP-10)
      if (name === "env") {
        const ci = ws.findIndex((w) => w.v != null && /^(?:-C|--chdir)(?:=|$)/.test(w.v));
        if (ci >= 0) {
          const d = ws[ci].v.includes("=") ? ws[ci].v.split("=").slice(1).join("=") : (ws[ci + 1] && ws[ci + 1].v);
          state = { ...state, cwd: d == null ? null : normalize(joinCwd(state.cwd, d), root) };
        }
      }
      const k = skipWrapperOpts(name, ws);
      if (k >= ws.length) return;
      const inner = ws[k].v;
      if (inner == null) { res.incomplete.push(`${name} 后的动态命令`); return; }
      return dispatch(baseName(inner), args.slice(k + 1), state, depth, cmdNode);
    }
    const files = () => nonOpt(ws);
    const addW = (w, via, op) => add(w.node, state.cwd, via, op);
    const chdir = (t) => {
      // `cd -`、`cd ~user`、`cd $OLDPWD` 这类静态得不到的目标 ⇒ 目录未知(红队 259 BP-5:原先拼成 `clipboard/-`)
      if (!t) { state.cwd = ""; return; }
      if (t.v == null || t.v === "-" || /^~[^/]/.test(t.v)) { state.cwd = null; return; }
      if (state.cwd === null && !/^(?:[A-Za-z]:[\\/]|\/|~)/.test(t.v)) return;
      state.cwd = normalize(joinCwd(state.cwd, t.v), root);
    };
    switch (name) {
      case "cd": case "pushd": return chdir(files()[0]);
      case "popd": state.cwd = null; return;
      case "eval": {
        // eval 把参数拼成脚本再执行(红队 259 BP-8)
        if (ws.every((w) => w.v != null)) nested(ws.map((w) => w.v).join(" "), state.cwd, depth + 1, "eval");
        else res.effects.push({ known: false, expr: "eval 动态脚本", suffix: "", hint: cmdNode.text, via: "eval", op: "write" });
        return;
      }
      case "rm": case "unlink": case "rmdir": {
        // 删除改了那条路径(J 管改法条,删也算);新建判定会跳过 op=delete(红队 259 BP-11)
        for (const w of files()) addW(w, name, "delete");
        return;
      }
      case "cp": case "mv": case "install": case "ln": case "rsync": {
        // 落进目录:落点 = 目录 + 各源文件名;源名不是字面量 ⇒ 目录里的未知文件(形状 `目录/X`)
        const intoDir = (dirV, srcs) => {
          const d = dirV.replace(/[\\/]+$/, "") + "/";
          for (const s of srcs) {
            if (s.v != null && s.v !== "{}") addLit(d + path.basename(s.v.replace(/\\/g, "/")), state.cwd, name);
            else res.effects.push({ known: false, expr: `${d}<${s.node.text}>`, suffix: "", pattern: normalize(joinCwd(state.cwd ?? "X", d), root) + "/X.md", via: name, op: "write" });
          }
        };
        const ti = ws.findIndex((w) => w.v != null && /^(?:-t|--target-directory)(?:=|$)|^-t./.test(w.v));
        if (ti >= 0) {
          const w = ws[ti];
          const takesNext = w.v === "-t" || w.v === "--target-directory";
          const dirW = takesNext ? ws[ti + 1] : { v: w.v.replace(/^(?:--target-directory=|-t)/, ""), node: w.node };
          const srcs = files().filter((x) => x !== ws[ti + 1]);
          // `cp -t . /tmp/AGENTS.md`:落点是 `./AGENTS.md`(红队 a391d46c (b):原先只记目录本身)
          if (dirW && dirW.v != null) intoDir(dirW.v, srcs); else if (dirW) addW(dirW, name);
          if (name === "mv") for (const s of srcs) addW(s, "mv 源", "delete");
          return;
        }
        const f = files();
        if (f.length < 2) return;
        if (name === "mv") for (const s of f.slice(0, -1)) addW(s, "mv 源", "delete");
        const dest = f[f.length - 1];
        // 目的地是目录:显式以 / 结尾,或磁盘上就是个已有目录(`cp x.md docs/laws`)
        if (dest.v != null && (/[\\/]$/.test(dest.v) || dest.v === "." || isDirOnDisk(dest.v, state.cwd))) { intoDir(dest.v, f.slice(0, -1)); return; }
        addW(dest, name);
        return;
      }
      case "tee": case "touch": case "truncate": {
        // 带值选项的值不是目标(`touch -r AGENTS.md /tmp/x`、`truncate -s 0 f`;红队 259 BP-13)
        const VALOPT = /^(?:-[rdtsS]|--(?:reference|date|size))$/;
        for (let i = 0; i < ws.length; i++) {
          const w = ws[i];
          if (w.v != null && VALOPT.test(w.v)) { i++; continue; }
          if (w.v != null && /^-/.test(w.v) && w.v !== "-") continue;
          addW(w, name);
        }
        return;
      }
      case "dd": {
        for (const w of ws) if (w.v != null && /^of=/.test(w.v)) addLit(w.v.slice(3), state.cwd, "dd");
        return;
      }
      case "sed": case "perl": {
        let inPlace = false, hasScript = false, endOpts = false;
        const rest = [];
        for (let i = 0; i < ws.length; i++) {
          const w = ws[i];
          if (!endOpts && w.v === "--") { endOpts = true; continue; }
          if (!endOpts && w.v != null && /^-/.test(w.v) && w.v.length > 1) {
            if ((/^-[A-Za-z]*i/.test(w.v) && !/^--/.test(w.v)) || /^--in-place\b/.test(w.v)) inPlace = true;
            if (/^-[A-Za-z]*e$/.test(w.v) && name === "perl") { hasScript = true; i++; continue; }
            if (w.v === "-e" || w.v === "-f" || w.v === "--expression" || w.v === "--file") { hasScript = true; i++; }
            else if (/^--(?:expression|file)=/.test(w.v)) hasScript = true;
            continue;
          }
          rest.push(w);
        }
        if (!inPlace) return;
        // 原地改:只改既有文件,不会新建(op=modify;红队 a391d46c BP-8)
        for (const w of hasScript ? rest : rest.slice(1)) addW(w, name + " -i", "modify");
        return;
      }
      case "curl": case "wget": case "sort": case "scp": {
        // 只读表里混着会写文件的命令(红队 a391d46c (b)):curl -o / --output、wget -O / --output-document、sort -o、scp 本地落点、uniq 第二个文件
        for (let i = 0; i < ws.length; i++) {
          const w = ws[i];
          if (w.v == null) continue;
          const eq = w.v.match(/^--(?:output|output-document)=(.+)$/);
          if (eq) addLit(eq[1], state.cwd, name);
          else if (((name === "curl" && /^(?:-o|--output)$/.test(w.v)) || (name === "wget" && /^(?:-O|--output-document)$/.test(w.v)) || (name === "sort" && w.v === "-o")) && ws[i + 1]) { addW(ws[i + 1], name); i++; }
        }
        if (name === "scp") { const f = files(); const d = f[f.length - 1]; if (f.length >= 2 && d.v != null && !/^[^/\\]*:/.test(d.v)) addW(d, "scp"); }
        // (uniq 的第二文件撤回:`uniq -f 1 AGENTS.md` 把选项值当成第一个文件,红队收口轮 BP-9)
        return;
      }
      case "git": {
        let j = 0;
        // `git -C DIR …`:路径相对 DIR(红队 a391d46c (b))
        let gs = state;
        while (j < ws.length && ws[j].v != null && /^-/.test(ws[j].v)) {
          if (ws[j].v === "-C" && ws[j + 1]) gs = { ...gs, cwd: ws[j + 1].v == null ? null : normalize(joinCwd(gs.cwd, ws[j + 1].v), root) };
          if (/^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(ws[j].v)) j++;
          j++;
        }
        const gAdd = (w, via, op) => add(w.node, gs.cwd, via, op);
        const sub = ws[j] && ws[j].v;
        const rest = ws.slice(j + 1);
        if (sub === "mv") { const f = nonOpt(rest); if (f.length >= 2) { for (const s of f.slice(0, -1)) gAdd(s, "git mv 源", "delete"); gAdd(f[f.length - 1], "git mv"); } }
        // `git rm --cached` 只动索引,与 `restore --staged` 同口径不算(红队收口轮 BP-11)
        else if (sub === "rm") { if (!rest.some((w) => w.v === "--cached")) for (const w of nonOpt(rest)) gAdd(w, "git rm", "delete"); }
        // checkout / restore 把工作树里的路径改成别的版本(红队 259 BP-12):`git checkout <rev> -- 路径`、`git restore 路径`。
        //   `git restore --staged` 不带 --worktree 只动暂存区,不写工作树(红队 a391d46c BP-4)。
        //   目录参数(`-- docs/laws/`)落点是目录里的文件,按 `目录/X.md` 形状判
        else if (sub === "checkout" || sub === "restore") {
          const flags = rest.filter((w) => w.v != null && /^-/.test(w.v)).map((w) => w.v);
          if (sub === "restore" && flags.some((f) => /^(?:--staged|-S)$/.test(f)) && !flags.some((f) => /^(?:--worktree|-W)$/.test(f))) return;
          const dd = rest.findIndex((w) => w.v === "--");
          const paths = dd >= 0 ? rest.slice(dd + 1) : sub === "restore" ? nonOpt(rest) : [];
          for (const w of paths) {
            if (w.v != null && /^-/.test(w.v)) continue;
            if (w.v != null && (/[\\/]$/.test(w.v) || isDirOnDisk(w.v, gs.cwd))) res.effects.push({ known: false, expr: w.v, suffix: "", pattern: normalize(joinCwd(gs.cwd ?? "X", w.v.replace(/[\\/]+$/, "")), root) + "/X.md", via: `git ${sub}`, op: "modify" });
            // op=write:checkout / restore 对工作树里不存在的路径会新建(从别的分支拣回新脚本),新旧交 isNew 判(红队收口轮 BP-3)
            else gAdd(w, `git ${sub}`, "write");
          }
        }
        return;
      }
      case "find": {
        for (let i = 0; i < ws.length; i++) {
          if (ws[i].v != null && /^-(?:exec|execdir|ok|okdir)$/.test(ws[i].v)) {
            let e = i + 1;
            while (e < ws.length && !(ws[e].v != null && /^(?:;|\+)$/.test(ws[e].v))) e++;
            const inner = ws[i + 1];
            if (inner && inner.v != null) dispatch(path.basename(inner.v), args.slice(i + 2, e), { ...state }, depth, cmdNode);
            i = e;
          }
        }
        return;
      }
      default: break;
    }
    if (SHELLS.test(name)) {
      const ci = ws.findIndex((w) => w.v != null && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.v));
      if (ci >= 0 && ws[ci + 1]) {
        if (ws[ci + 1].v != null) nested(ws[ci + 1].v, state.cwd, depth + 1, `${name} -c`);
        else res.effects.push({ known: false, expr: `${name} -c 动态脚本`, suffix: "", via: name });
      }
      return;
    }
    if (INTERP.test(name)) {
      // 内联程序:`-e` / `-p` / `-c`(含短选项簇 `-pe`)取下一个参数,`--eval=…` / `--print=…` 取等号后(红队 259 BP-3)
      const flag = name === "python" || name === "python3" || name === "py" ? "c" : "ep";
      for (let i = 0; i < ws.length; i++) {
        const w = ws[i];
        if (w.v == null) continue;
        const eq = w.v.match(/^--(?:eval|print|command)=([\s\S]*)$/);
        if (eq) { scanPayload(eq[1], state.cwd, `${name} ${w.v.split("=")[0]}`); continue; }
        if ((/^--(?:eval|print)$/.test(w.v) || new RegExp(`^-[A-Za-z]*[${flag}][A-Za-z]*$`).test(w.v)) && ws[i + 1]) {
          if (ws[i + 1].v != null) scanPayload(ws[i + 1].v, state.cwd, `${name} ${w.v}`);
          else if (API_ANY.test(ws[i + 1].node.text)) res.effects.push({ known: false, expr: `${name} 动态载荷`, suffix: "", hint: ws[i + 1].node.text, via: name, op: "write" });
          i++;
        }
      }
      return;
    }
    if (NON_SHELL_INTERP.test(name)) {
      // PowerShell / cmd 载荷不在本模块:交调用方旧解析器(标出来,不吞)
      res.incomplete.push(`${name} 载荷交旧解析器`);
      return;
    }
    // 不认识的命令:可能是包装器(flock / parallel / watch / strace …,红队 259 BP-4)。已知只读命令之外,
    //   参数里出现写命令名就从那里当一条命令再分析一次——撤掉整串兜底之后的结构性退路,不加包装器词表。
    if (!READ_ONLY_CMDS.test(name)) {
      const k = ws.findIndex((w) => w.v != null && WRITE_CMDS.test(baseName(w.v)));
      if (k >= 0) dispatch(baseName(ws[k].v), args.slice(k + 1), { ...state }, depth, cmdNode);
    }
  };
  visit(tree.rootNode, { cwd: opts.cwd ?? "" }, 0);
  return res;
}

export const _test = { literalSuffix, normalize, rootForms, joinCwd };
