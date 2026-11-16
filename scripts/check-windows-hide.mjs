#!/usr/bin/env node
// check-windows-hide.mjs — 起子进程必带 windowsHide 的机器检查(2026-10-17 用户:「下次能不能要求加进程时都应该开windowshide」)。
//
// 为什么:Node 文档 child_process:`windowsHide`「Hide the subprocess console window that would normally be created on Windows
//   systems. Default: false」;`detached`「The child process will have its own console window」。用户 2026-10-17 报闪窗,
//   最可疑的是 detached 起的盲审链(batch-goal → fp-audit → codex-run)里不带 windowsHide 的子进程——**来源未证实**
//   (codex 262-final-r1 判「判不出」:当时并行进程多,修后无视觉复测)。调用方日后被谁、怎么起,写代码时看不到,
//   所以规则是一律带,不判会不会弹。
// 判据(语法树,@babel/parser,装在 scripts/gate-deps;worktree 里找不到时回退主 checkout):
//   全仓 git 追踪 ∪ 未追踪未忽略的 .js/.mjs/.cjs/.ts/.mts/.cts/.tsx/.jsx——
//   ① 解出 child_process 的本地绑定:import(命名含改名 / 默认 / 命名空间)、TS `import x = require()`、
//      `require()` / `import()` / 任何「唯一实参是 child_process 字面」的调用(createRequire、module.require)、`.default`、
//      解构(含改名、rest)、赋值与 `??=`,并沿 `const m = cp` / `const run = cp.spawnSync` 传播到不动点;
//   ② 这些绑定上的 spawn / spawnSync / exec / execSync / execFile / execFileSync / fork 调用,**选项槽位**
//      (exec 族第 2 个实参;其余第 2 个若是对象字面量就是它,否则第 3 个)须是就地对象字面量,
//      其中**最后一个** `windowsHide` 是字面量 `true`、之后没有展开;false、表达式、简写、注释 / 字符串 / 嵌套里的都不算;
//   ③ 绑定被间接使用(promisify、传参、计算属性 cp[k])、再导出 child_process、认不出用途的加载(`import().then`、
//      默认参数)⇒ 照报;TS 类型位置不算;④ 文件解析失败 ⇒ 照报(fail-closed)。
//   红队 a3a45e6c 打穿手写分词首版(正则字面量致盲等);test-e8(clipboard/262-redteam-windowshide.md)补出
//   绑定传播、延迟加载、再导出、选项槽位、worktree 缺解析器——各有夹具。
// 默认路径:①hook-guard 在 Edit / Write / MultiEdit 写 JS/TS 前拼出写后全文判一次,**新增**缺漏即拒(必然执行面);
//   ②gate:accept 链尾全量扫。天花板与老问题见 D162。
// 失效条件:不按作用域解析遮蔽;动态模块名不判;三方起进程库(execa 等)进仓 ⇒ 扩绑定源,复议。
// 用法:node --no-warnings scripts/check-windows-hide.mjs [--self-test]    退出码 0=干净,1=有缺漏(逐条列出),2=解析器缺席
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CP_MODULES = new Set(["child_process", "node:child_process"]);
const NAMES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
// 预筛:源码原文里出现 child + process 就送解析(codex 262-final-r1:`"node:child_process"` 是合法静态导入,
//   原先按 /child_process/ 预筛会整份跳过);宽一点只多花解析时间,窄了就是漏报
//   codex 262-closeout-r1 报 `\u0063hild_process`;红队 a6f92684 又报无意义转义 `c\hild`、续行、八进制 `\143`——逐个列举补不完,
//   且 60cc082 那版「有 \u / \x 就送解析」把注释里的 `C:\Users` 也送去解析,babel 解不了的完整语法(装饰器、.js 里的 JSX)
//   于是被写入面按「解析失败」拒(BP-3,本批引入)。改:**先还原转义,再判有没有 child…process**——
//   转义写法都还原成明文,不沾 child_process 的文件不送解析,也就不会因解析失败被拒。
// 续行:LF / CRLF / 单独 CR / U+2028 / U+2029(codex 263-prefilter-r1 A1)。后两个用字符码拼:正则字面量里不能直接放行终止符
const CONTINUATION_RE = new RegExp("\\\\(?:\\r\\n|[\\n\\r" + String.fromCharCode(8232, 8233) + "])", "g");
export function decodeEscapes(src) {
  return String(src)
    .replace(CONTINUATION_RE, "")
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, "$1");
}
const CP_TEXT = /child[\s\S]{0,12}process/i;
export const maySpawn = (src) => CP_TEXT.test(String(src)) || CP_TEXT.test(decodeEscapes(src));
const SRC_RE = /\.(?:m?js|cjs|m?ts|cts|tsx|jsx)$/i;   // 大小写与 hook-guard 写入面同口径(红队 a0cf1344 BP-10)

// 先找本 checkout 的 scripts/gate-deps;新开的 git worktree 不带 node_modules ⇒ 再找主 checkout
//   (红队 test-e8 BP-10 / aeddae61 BP-3:与 lib/write-effects.mjs 的 bashParser 同法)
export function loadParser() {
  const cands = [path.join(HERE, "gate-deps")];
  try {
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: HERE, encoding: "utf8", timeout: 5000, windowsHide: true });
    if (common.status === 0 && common.stdout.trim()) cands.push(path.join(path.dirname(common.stdout.trim()), "scripts", "gate-deps"));
  } catch { /* 不是 git 仓 */ }
  for (const dir of cands) {
    try { return createRequire(path.join(dir, "package.json"))("@babel/parser"); } catch { /* 下一个 */ }
  }
  return null;
}

const isNode = (x) => x && typeof x === "object" && typeof x.type === "string";
const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "range"]);
function walk(node, fn, stack = []) {
  if (!isNode(node)) return;
  fn(node, stack);
  stack.push(node);
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (isNode(c)) { c.__key = k; walk(c, fn, stack); } }
    else if (isNode(v)) { v.__key = k; walk(v, fn, stack); }
  }
  stack.pop();
}
const strVal = (n) => (n && (n.type === "StringLiteral" || (n.type === "Literal" && typeof n.value === "string")) ? n.value
  : n && n.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);
const unwrap = (n) => {
  while (n && ["TSAsExpression", "TSNonNullExpression", "ParenthesizedExpression", "TSSatisfiesExpression", "TSTypeAssertion", "AwaitExpression"].includes(n.type))
    n = n.type === "AwaitExpression" ? n.argument : n.expression;
  return n;
};
// 模块表达式:`require("child_process")`、`import("node:child_process")`,以及任何「唯一实参是 child_process 字面」的调用
//   (createRequire(…)("child_process")、module.require(…);红队 test-e8 BP-4)
function isModuleExpr(n) {
  n = unwrap(n);
  if (!n) return false;
  if (n.type === "ImportExpression") return CP_MODULES.has(strVal(n.source));
  if (n.type === "CallExpression" && n.arguments.length === 1) return CP_MODULES.has(strVal(n.arguments[0]));
  return false;
}
const propName = (m) => (m.computed ? strVal(m.property) : m.property && m.property.name);
const isMember = (n) => n && (n.type === "MemberExpression" || n.type === "OptionalMemberExpression");
const TYPE_CTX = new Set(["TSTypeAnnotation", "TSTypeQuery", "TSTypeReference", "TSTypeAliasDeclaration", "TSInterfaceDeclaration",
  "TSTypeParameterInstantiation", "TSQualifiedName", "TSExpressionWithTypeArguments"]);

/** 返回缺漏 [{ line, name, why }];parser 由调用方给(自测、全量、hook-guard 写前检查共用)。 */
export function findMissing(src, { parser, file = "x.mjs" } = {}) {
  const ts = /\.(?:m?ts|cts|tsx)$/i.test(file);
  const jsx = /\.(?:tsx|jsx)$/i.test(file);
  const base = { sourceType: "unambiguous", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  const plugins = [...(ts ? ["typescript"] : []), ...(jsx ? ["jsx"] : [])];
  let ast;
  try {
    ast = parser.parse(src, { ...base, plugins });
  } catch (e) {
    // 批 285 D162(BP-1 / ⑪ 登记的误拒):按扩展名配的插件解不了时,补「配置不支持」那几样再解一次——
    //   非 TS 文件补 jsx(.js 里写 JSX 是常态),所有文件补 decorators-legacy。只在首解失败时才走,
    //   首解能过的文件结果一字不变;重解过了就照常判缺漏(有缺漏照报),重解也过不了才报「(解析)」,
    //   报的仍是首解的错因。.ts 不补 jsx:`<T>x` 类型断言与 JSX 冲突,补了反而把合法 TS 解歪。
    //   代价:真写坏的 .js 若恰好能按 JSX 解通(如 `a = <b>…`),会按 JSX 语义判而不报「(解析)」。
    const extra = [...(!ts && !jsx ? ["jsx"] : []), "decorators-legacy"];
    try {
      ast = parser.parse(src, { ...base, plugins: [...plugins, ...extra] });
    } catch {
      return [{ line: (e.loc && e.loc.line) || 1, name: "(解析)", why: "解析失败,无法判定:" + String(e.message).split("\n")[0] }];
    }
  }
  const out = [];
  const line = (n) => (n.loc ? n.loc.start.line : 1);
  const named = new Map();     // 本地名 → child_process 导出名
  const ns = new Set();        // 指向整个模块的本地名
  const bindingSites = new Set();
  const consumed = new Set();  // 已认出用途的模块表达式
  // 表达式 e 指向整个模块?(模块表达式、命名空间名、`.default`)
  const nsExpr = (e) => {
    e = unwrap(e);
    if (!e) return false;
    if (isModuleExpr(e)) return true;
    if (e.type === "Identifier") return ns.has(e.name);
    if (isMember(e) && propName(e) === "default") return nsExpr(e.object);
    return false;
  };
  // 表达式 e 指向 child_process 的某个函数?返回函数名或 null
  const fnExpr = (e) => {
    e = unwrap(e);
    if (!e) return null;
    if (e.type === "Identifier") return named.get(e.name) ?? null;
    if (isMember(e) && nsExpr(e.object)) { const p = propName(e); return p && NAMES.has(p) ? p : null; }
    return null;
  };
  const markConsumed = (e) => { e = unwrap(e); if (!e) return; if (isModuleExpr(e)) consumed.add(e); else if (isMember(e)) markConsumed(e.object); };
  // 把「目标 ← 值」登记成绑定(声明、赋值、??= 共用);认出则返回 true
  const boundValues = new Set();   // 已登记成绑定的「值」节点(其出现位置不算间接使用)
  const bind = (target, value) => {
    if (!target || !value) return false;
    if (nsExpr(value)) {
      markConsumed(value);
      boundValues.add(unwrap(value));
      if (target.type === "Identifier") { if (!ns.has(target.name)) { ns.add(target.name); grew = true; } bindingSites.add(target); return true; }
      if (target.type === "ObjectPattern") {
        for (const p of target.properties) {
          if (p.type === "RestElement" && p.argument.type === "Identifier") { if (!ns.has(p.argument.name)) { ns.add(p.argument.name); grew = true; } bindingSites.add(p.argument); continue; }
          if (p.type !== "ObjectProperty") continue;
          const k = p.computed ? strVal(p.key) : p.key.name ?? strVal(p.key);
          const v = p.value.type === "AssignmentPattern" ? p.value.left : p.value;
          if (k === "default" && v.type === "Identifier") { if (!ns.has(v.name)) { ns.add(v.name); grew = true; } bindingSites.add(v); continue; }
          if (NAMES.has(k) && v.type === "Identifier") { if (!named.has(v.name)) { named.set(v.name, k); grew = true; } bindingSites.add(v); }
        }
        return true;
      }
      return false;
    }
    const f = fnExpr(value);
    if (f && target.type === "Identifier") { markConsumed(value); boundValues.add(unwrap(value)); if (!named.has(target.name)) { named.set(target.name, f); grew = true; } bindingSites.add(target); return true; }
    return false;
  };
  // 绑定传播到不动点(`import * as cp` → `const { spawnSync } = cp` → `const run = spawnSync`;红队 test-e8 BP-2)
  let grew = true;
  for (let round = 0; grew && round < 8; round++) {
    grew = false;
    walk(ast.program, (n) => {
      if (n.type === "ImportDeclaration" && CP_MODULES.has(strVal(n.source)) && n.importKind !== "type") {
        for (const s of n.specifiers) {
          bindingSites.add(s.local);
          if (s.type === "ImportSpecifier") { const imp = s.imported.name ?? strVal(s.imported); if (NAMES.has(imp) && !named.has(s.local.name)) { named.set(s.local.name, imp); grew = true; } }
          else if (!ns.has(s.local.name)) { ns.add(s.local.name); grew = true; }
        }
      }
      // TS `import cp = require("child_process")`(红队 test-e8 BP-4)
      if (n.type === "TSImportEqualsDeclaration" && n.moduleReference && n.moduleReference.type === "TSExternalModuleReference" &&
          CP_MODULES.has(strVal(n.moduleReference.expression)) && !ns.has(n.id.name)) { ns.add(n.id.name); bindingSites.add(n.id); grew = true; }
      if (n.type === "VariableDeclarator") bind(n.id, n.init);
      if (n.type === "AssignmentExpression") bind(n.left, n.right);
    });
  }
  const callees = new Set();
  // 选项槽位:exec / execSync 是第 2 个实参;其余是「第 2 个若是对象字面量就是它,否则第 3 个」(红队 test-e8 BP-9:多余实参不算)
  const optionSlot = (name, args) => (/^exec(Sync)?$/.test(name) ? args[1] : (args[1] && unwrap(args[1]).type === "ObjectExpression" ? args[1] : args[2]));
  // 同名键取末值;末个 windowsHide 之后再有展开,值可能被盖掉 ⇒ 不算
  const hideTrue = (obj) => {
    obj = unwrap(obj);
    if (!obj || obj.type !== "ObjectExpression") return false;
    let idx = -1;
    obj.properties.forEach((p, i) => { if ((p.type === "ObjectProperty" || p.type === "Property") && !p.computed && (p.key.name ?? strVal(p.key)) === "windowsHide") idx = i; });
    if (idx < 0) return false;
    const p = obj.properties[idx];
    if (p.shorthand || !((p.value.type === "BooleanLiteral" || p.value.type === "Literal") && p.value.value === true)) return false;
    return !obj.properties.slice(idx + 1).some((q) => q.type === "SpreadElement");
  };
  walk(ast.program, (n) => {
    if (n.type !== "CallExpression" && n.type !== "OptionalCallExpression") return;
    const nm = fnExpr(n.callee);
    if (!nm) return;
    callees.add(unwrap(n.callee));
    markConsumed(n.callee);
    if (!hideTrue(optionSlot(nm, n.arguments))) out.push({ line: line(n), name: nm, why: "选项实参不是就地对象字面量带 `windowsHide: true`" });
  });
  walk(ast.program, (n, stack) => {
    const parent = stack[stack.length - 1];
    const key = n.__key;
    if (bindingSites.has(n) || boundValues.has(n) || stack.some((a) => TYPE_CTX.has(a.type))) return;
    if (parent?.type === "VariableDeclarator" && key === "id") return;   // `let cp;` 之类的声明处
    // 再导出 child_process 成员:调用方文件可能根本不含 child_process 字面(红队 test-e8 BP-5)
    if ((n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source && CP_MODULES.has(strVal(n.source)) && n.exportKind !== "type")
      out.push({ line: line(n), name: "(再导出)", why: "再导出 child_process,调用处看不到选项" });
    if (n.type === "Identifier" && (named.has(n.name) || ns.has(n.name))) {
      if (callees.has(n)) return;
      if (isMember(parent) && key === "property" && !parent.computed) return;
      if (isMember(parent) && key === "object" && ns.has(n.name)) return;   // cp.spawn —— 成员那一支另判
      if ((parent?.type === "ObjectProperty" || parent?.type === "Property") && key === "key" && !parent.computed) return;
      if (parent && /^(Import|Export)(Default|Namespace)?Specifier$/.test(parent.type)) return;
      if ((parent?.type === "FunctionDeclaration" || parent?.type === "ClassMethod" || parent?.type === "ObjectMethod") && key === "id") return;
      if (parent?.type === "VariableDeclarator" && key === "init" && bindingSites.has(parent.id)) return;   // 已传播的别名
      if (parent?.type === "AssignmentExpression" && key === "right" && bindingSites.has(parent.left)) return;
      out.push({ line: line(n), name: named.get(n.name) ?? "(模块)", why: "间接使用(传参 / promisify / 存进别处),看不到选项" });
      return;
    }
    if (isMember(n) && !callees.has(n) && nsExpr(n.object)) {
      const p = propName(n);
      if (p === "default") return;
      if (parent?.type === "VariableDeclarator" && key === "init" && bindingSites.has(parent.id)) return;
      if (parent?.type === "AssignmentExpression" && key === "right" && bindingSites.has(parent.left)) return;
      // 只有取到 child_process 函数(或取不清是哪个)才算认出了用途;`.then` 之类不算(红队 test-e8 BP-3)
      if ((p == null && n.computed) || NAMES.has(p)) markConsumed(n.object);
      if (p == null && n.computed) out.push({ line: line(n), name: "(计算属性)", why: "按计算属性取 child_process 成员,看不到是哪个函数" });
      else if (NAMES.has(p)) out.push({ line: line(n), name: p, why: "间接使用(传参 / promisify / 存进别处),看不到选项" });
    }
  });
  // 认不出用途的模块表达式一律照报(fail-closed;红队 test-e8 BP-3:import().then / 默认参数 / 惰性 ??= 之外的写法)
  walk(ast.program, (n) => {
    if ((n.type === "CallExpression" || n.type === "ImportExpression") && isModuleExpr(n) && !consumed.has(n))
      out.push({ line: line(n), name: "(加载)", why: "认不出的 child_process 加载方式,看不到之后怎么起进程" });
  });
  return out.sort((a, b) => a.line - b.line);
}

function selfTest(parser) {
  const H = "{ windowsHide: true }";
  const imp = 'import { spawnSync, execSync, execFileSync, execFile, spawn, exec, fork } from "node:child_process";\n';
  const cases = [
    ["缺选项", imp + "spawnSync('git', ['status'], { encoding: 'utf8' });", 1],
    ["带了", imp + "spawnSync('git', ['status'], { encoding: 'utf8', windowsHide: true });", 0],
    ["多行", imp + "const r = execFileSync(\n  'git',\n  ['log'],\n  " + H + ",\n);", 0],
    ["exec 只有命令", imp + "execSync('ls');", 1],
    ["字符串 / 注释里的调用不算", imp + "const s = \"spawnSync('git')\"; // spawn(x)", 0],
    ["正则 exec 不算", imp + "/re/.exec(str); const m = RE.exec(s);", 0],
    ["展开 + windowsHide", imp + "spawn(process.execPath, [s], { ...opts, windowsHide: true });", 0],
    ["fork", imp + "fork('child.mjs', [], {});", 1],
    // 红队 a3a45e6c BP-1:正则字面量里的引号 / `/*` / 反引号致盲
    ["BP-1 引号正则", imp + "const re = /[\"']/;\nspawnSync('git', []);", 1],
    ["BP-1 斜杠星正则", imp + "const p = s.replace(/\\/*$/, '');\nspawnSync('git', []);", 1],
    ["BP-1 反引号正则", imp + "const re = /`/;\nspawnSync('git', []);", 1],
    ["BP-2 模板插值里调用", imp + "console.log(`head=${execSync('git rev-parse HEAD')}`);", 1],
    ["BP-4 改名导入", 'import { spawnSync as run } from "node:child_process";\nrun("git", []);', 1],
    ["BP-4 require 链", 'require("child_process").spawn("git", []);', 1],
    ["BP-4 promisify", imp + "const p = promisify(execFile);\nawait p('git', []);", 1],
    ["BP-4 命名空间", 'import * as ch from "node:child_process";\nch.execFileSync("git", []);', 1],
    ["BP-4 可选调用", imp + "spawnSync?.('git', []);", 1],
    ["BP-4 解构改名", 'const { spawn: run } = require("child_process");\nrun("git", []);', 1],
    ["BP-4 计算属性", 'import cp from "child_process";\ncp[k]("git", []);', 1],
    ["BP-5 false 不算", imp + "spawnSync('git', [], { windowsHide: false });", 1],
    ["BP-5 注释不算", imp + "spawnSync('git', [], { /* windowsHide */ encoding: 'utf8' });", 1],
    ["BP-5 嵌套不算", imp + "spawnSync('git', [], { env: { windowsHide: true } });", 1],
    ["BP-6 不配对括号正则", imp + "execSync(s.replace(/\\(/g, ''));", 1],
    ["BP-7 同行 import.meta", imp + "if (a === fileURLToPath(import.meta.url)) spawnSync('git', []);", 1],
    ["BP-9 同名方法不算", "class R { exec(cmd) { return cmd; } }\nnew R().exec('x');", 0],
    ["BP-10 自定义 exec 不算", "const exec = (sql) => db.run(sql);\nexec('select 1');", 0],
    ["BP-11 mycp.exec 不算", "const mycp = /a/; mycp.exec('x');", 0],
    ["BP-12 右括号正则", imp + "spawnSync('git', [s.replace(/\\)/g, '')], { windowsHide: true });", 0],
    ["选项经变量传入照报", imp + "spawnSync('git', [], OPTS);", 1],
    // 红队 test-e8(批 262,clipboard/262-redteam-windowshide.md)
    ["e8 BP-2 命名空间再解构", 'import * as cp from "node:child_process";\nconst { spawnSync: s2 } = cp;\ns2("git", []);', 1],
    ["e8 BP-2 命名空间别名", 'import * as cp from "node:child_process";\nconst m = cp;\nm.spawnSync("git", []);', 1],
    ["e8 BP-2 别名后带了", 'import * as cp from "node:child_process";\nconst run = cp.spawnSync;\nrun("git", [], { windowsHide: true });', 0],
    ["e8 BP-3 import().then", 'import("node:child_process").then((m) => m.spawn("git", []));', 1],
    ["e8 BP-3 .default", 'const cp = (await import("node:child_process")).default;\ncp.spawnSync("git", []);', 1],
    ["e8 BP-3 惰性 ??=", 'let cp;\ncp ??= require("child_process");\ncp.execSync("ls");', 1],
    ["e8 BP-3 默认参数", 'function f(cp = require("child_process")) { return cp; }', 1],
    ["e8 BP-4 createRequire", 'const req = createRequire(import.meta.url);\nconst cp = req("child_process");\ncp.spawnSync("git", []);', 1],
    ["e8 BP-4 module.require", 'const cp = module.require("child_process");\ncp.spawnSync("git", []);', 1],
    ["e8 BP-4 TS import =", { file: "x.ts", src: 'import cp = require("child_process");\ncp.spawnSync("git", []);' }, 1],
    ["e8 BP-5 再导出", 'export { spawnSync as run } from "node:child_process";', 1],
    ["e8 BP-9 塞多余实参", imp + "spawnSync('git', [], {}, { windowsHide: true });", 1],
    ["e8 BP-9 重复键后置 false", imp + "spawnSync('git', [], { windowsHide: true, windowsHide: false });", 1],
    ["e8 BP-9 展开盖值", imp + "spawnSync('git', [], { windowsHide: true, ...o });", 1],
    ["e8 BP-11 TS typeof 不算", { file: "x.ts", src: 'import { spawnSync } from "node:child_process";\ntype R = ReturnType<typeof spawnSync>;' }, 0],
    ["e8 BP-11 type-only 导入不算", { file: "x.ts", src: 'import type { SpawnSyncReturns } from "node:child_process";\nlet r: SpawnSyncReturns<string>;' }, 0],
    ["exec 带回调", imp + "exec('ls', { windowsHide: true }, (e, out) => out);", 0],
    ["execFile 四参", imp + "execFile('git', ['log'], { windowsHide: true }, cb);", 0],
    ["TS 文件", { file: "x.ts", src: 'import { spawnSync } from "node:child_process";\nconst r: string = spawnSync("git", [], { encoding: "utf8" }).stdout as string;' }, 1],
    ["解析失败照报", "spawnSync(", 1],
    ["codex 262 转义模块名", 'import { spawnSync } from "node:child\\u005fprocess";\nspawnSync("git", [], {});', 1],
    ["codex 262 转义首字母", 'import { spawnSync } from "node:\\u0063hild_process";\nspawnSync("git", [], {});', 1],
    ["a0cf BP-10 大写扩展名按 TS 解析", { file: "X.TS", src: 'import { spawnSync } from "node:child_process";\nconst r: number = 1;\nspawnSync("git", [], { windowsHide: true });' }, 0],
    // 批 285 D162(BP-1 / ⑪):「配置不支持」与「语法不完整」分开——.js 里的 JSX、装饰器重解后照常判
    ["285 D162 .js 带 JSX、注释写 child process ⇒ 不报解析失败", { file: "x.js", src: "// spawns a child process later\nconst el = <div>hi</div>;" }, 0],
    ["285 D162 .js 带 JSX 且缺 windowsHide ⇒ 照报缺漏", { file: "x.js", src: imp + "const el = <div />;\nspawnSync('git', []);" }, 1],
    ["285 D162 .mjs 装饰器 ⇒ 不报解析失败", "// child process\n@dec class C {}", 0],
    ["285 D162 .ts 装饰器 ⇒ 不报解析失败", { file: "x.ts", src: "// child process\n@dec class C { m(): number { return 1; } }" }, 0],
    ["285 D162 重解也不过(真写坏)⇒ 照报解析", { file: "x.js", src: "const el = <div>;\nspawnSync(" }, 1],
  ];
  let pass = 0;
  for (const [name, c, want] of cases) {
    const { src, file } = typeof c === "string" ? { src: c, file: "x.mjs" } : c;
    const got = findMissing(src, { parser, file });
    if (got.length === want) pass++; else console.log(`FAIL ${name}:期望 ${want} 实得 ${got.length} ${JSON.stringify(got)}`);
  }
  // 预筛自测(codex 263-prefilter-r1:原自测只调 findMissing,不经 maySpawn,写入面断线也全绿)
  const BS = String.fromCharCode(92), CP = "process";
  const pre = [
    ["预筛:明文", 'require("child_' + CP + '")', true],
    ["预筛:\\u0063", 'require("' + BS + 'u0063hild_' + CP + '")', true],
    ["预筛:\\u{63}", 'require("' + BS + 'u{63}hild_' + CP + '")', true],
    ["预筛:\\x63", 'require("' + BS + 'x63hild_' + CP + '")', true],
    ["预筛:八进制 \\143", 'require("' + BS + '143hild_' + CP + '")', true],
    ["预筛:无意义转义 c\\hild", 'require("c' + BS + 'hild_' + CP + '")', true],
    ["预筛:LF 续行", 'require("c' + BS + '\nhild_' + CP + '")', true],
    ["预筛:单独 CR 续行", 'require("c' + BS + '\rhild_' + CP + '")', true],
    ["预筛:U+2028 续行", 'require("c' + BS + String.fromCharCode(8232) + 'hild_' + CP + '")', true],
    // 红队 a28be271 附节二②:CRLF 与 U+2029 续行代码支持、自测没钉住
    ["预筛:CRLF 续行", 'require("c' + BS + '\r\nhild_' + CP + '")', true],
    ["预筛:U+2029 续行", 'require("c' + BS + String.fromCharCode(8233) + 'hild_' + CP + '")', true],
    ["预筛:注释里 C:\\Users 不送解析", "// C:" + BS + "Users" + BS + "me\n@dec class C {}", false],
  ];
  let prePass = 0;
  for (const [name, src, want] of pre) { const got = maySpawn(src); if (got === want) prePass++; else console.log(`FAIL ${name}:期望 ${want} 实得 ${got}`); }
  console.log(`check-windows-hide 自测 ${pass}/${cases.length} · 预筛 ${prePass}/${pre.length}`);
  return pass === cases.length && prePass === pre.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parser = loadParser();
  if (!parser) { console.log("check-windows-hide:解析器缺席(npm --prefix scripts/gate-deps install)"); process.exit(2); }
  if (process.argv.includes("--self-test")) process.exit(selfTest(parser) ? 0 : 1);
  // 追踪的 ∪ 未追踪但未被忽略的(红队 test-e8 BP-6:「先验收再 add」的新文件原先不在扫描面)
  const ls = spawnSync("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true });
  if (ls.status !== 0) { console.log("check-windows-hide:git ls-files 失败"); process.exit(2); }
  const files = [...new Set(ls.stdout.split("\0"))].filter((f) => f && SRC_RE.test(f) && !/(?:^|\/)node_modules\//.test(f));
  const hits = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }   // 追踪了但工作树已删
    if (!maySpawn(src)) continue;
    for (const h of findMissing(src, { parser, file: f })) hits.push(`${f}:${h.line} ${h.name} —— ${h.why}`);
  }
  if (hits.length) { console.log(`缺 windowsHide ${hits.length} 处(起子进程一律带 windowsHide: true):`); for (const h of hits) console.log("  " + h); process.exit(1); }
  console.log(`windowsHide 检查:${files.length} 个源文件,0 处缺漏`);
}
