#!/usr/bin/env node
// tool-usage-census.mjs —— 工具使用计数(工具面退役章程 docs/tool-register.md 的观测仪器)。
//
// 治的病:插件装了两周,「有没有用过」全靠印象。2026-08-10 工具面测绘被三路对抗反驳
// 全判 refuted,核心理由之一就是「连『没用过』本身都没测」。没有计数就没有裁撤依据
// ——这与「入册必须填观测仪器,填不出的不得入册」是同一条道理。
//
// 判据(全部机器可判,零模型判断):
//   ① slash 调用   = 会话转录里的 <command-name>/xxx</command-name>
//   ② skill 调用   = tool_use 里的 "skill":"xxx"
//   ③ 子代理调用   = tool_use 里的 "subagent_type":"xxx"
//   ④ 脚本被执行   = tool_use 的 input 里出现该插件缓存目录下的脚本路径
// **只数真调用,不数提及**:skill 清单每会话注入一次,grep 插件名会命中几千次噪声,
// 那是「在场」不是「使用」——判据类型闸:看见设施在场 ≠ 该能力被用过。
//
// **UNKNOWN 出口(2026-08-11 增量审计 F4 修)**:本仪器的输出是**免签裁撤的唯一证据**,
// 所以「扫不到」与「真的零使用」必须在输出上分得开。原实现两者长得一模一样
// (readdir 抛错 → continue → 全零表 → exit 0),条件一那句「扫描的转录份数非零」
// 于是落在读表人的自觉上,而不是机器判据上。现在:取数失败 / 零转录 ⇒
// `VERDICT=UNKNOWN` 且 **exit 2**。这个方向的假阴性是危险方向——把在用的工具裁掉。
//
// **覆盖面(同 F4)**:原 `PROJECT_DIRS` 只写死 `example-project` 一个目录,于是 user 级工具
// (寄存器里 `claude-english-buddy` 明记「user 级」)、worktree 会话、换路径开的仓
// **在结构上就落在扫描面之外**,那个 0 是「仪器看不见」不是「观测到零」。
// 现在扫 `~/.claude/projects/` 的全部子目录,并在输出里显式声明扫了哪些、各几份。
//
// 用法:
//   node scripts/tool-usage-census.mjs                打印表格
//   node scripts/tool-usage-census.mjs --json         出 JSON
//   node scripts/tool-usage-census.mjs --since 2026-07-28
//   node scripts/tool-usage-census.mjs --batches 10   窗口按**写批**算(见下)
//   node scripts/tool-usage-census.mjs --by-shape     附子代理形状表(B9 并轨,2026-08-16)
//   node scripts/tool-usage-census.mjs --self-test    反向用例自测
//
// **--by-shape(B9,2026-08-16 048 签署)**:原 clipboard/045-ai-course/tools/agent-shape-census.mjs
// 与本仪器在同一份数据上各数各的、答案不同(它无回声闸,nlpm 一项它报 10 本仪器报 4)。
// 唯一实现原则:形状计数并入本仪器,复用同一套「只认 assistant 的 tool_use」回声闸;
// 旧仪器就地废弃(文件头已改指针)。
//
// **窗口截断自检(E2,同批)**:窗口起点早于**最老转录 mtime** ⇒ 窗口可能已被 30 天
// 静默扫除截断,报的 0 分不清「真没调用」与「转录已被删」⇒ VERDICT=UNKNOWN。
// 这是 claudepot 评估批(E 份第二节)登记的 fail-open,方向朝最坏(把在用的工具裁掉)。
//
// `--batches <n>`(2026-08-11 增量审计 F5 修):免签裁撤条件二的单位是「连续 n 个写批」,
// 而本仪器原来只有 `--since <日期>` ——**条件的单位与仪器的单位对不上**,中间那步过去
// 靠人手工折算。现在经 `constraint-events.mjs` 的 `writeBatchWindow()`(写批时钟唯一实现,
// 写批 = 落账产生 ≥1 commit 的批,2026-08-03 亲签)折算成起始时间戳,并把折算结果
// (起始时刻 / 批数 / 窗口内 commit)一并打印**供人复核折算对不对**。
// 折算不出(台账不可信 / 世代内写批不足 n 个)⇒ UNKNOWN,不得读作零使用。
//
// 不写任何文件。寄存器 docs/tool-register.md 由人按本工装输出更新(改的是事实不是规范)。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");

/** 被观测的工具:插件名 → 其命令/skill/agent 前缀。 */
const TOOLS = [
  { name: "cc-suite", prefix: "cc-suite" },
  { name: "nlpm", prefix: "nlpm" },
  { name: "grill", prefix: "grill" },
  { name: "xros", prefix: "xros" },
  { name: "mermaid-preview", prefix: "mermaid" },
  { name: "claude-english-buddy", prefix: "english-buddy" },
];

const RE_CMD = /<command-name>\s*\/?([A-Za-z0-9:._-]+)\s*<\/command-name>/g;
const RE_SKILL = /"skill"\s*:\s*"([A-Za-z0-9:._-]+)"/g;
const RE_AGENT = /"subagent_type"\s*:\s*"([A-Za-z0-9:._-]+)"/g;

function toolOf(id) {
  const head = String(id).split(":")[0].toLowerCase();
  const hit = TOOLS.find((t) => head === t.prefix || head.startsWith(t.prefix));
  return hit ? hit.name : null;
}

/**
 * 递归收集一个项目目录下的全部 `.jsonl`。
 *
 * **必须递归**(2026-08-11 独立复核实撞):转录不只躺在项目目录直属层——
 * 每个会话另有 `<session-uuid>/subagents/*.jsonl`。本机实测 **505 份在深层、122 份在直属层**,
 * 只扫第一层等于**漏掉 80% 的扫描面**,而**子代理恰恰是 skill / 脚本被调用最密集的地方**。
 * 这与 F4 本身是同一个错型:那个 0 是「仪器看不见」而不是「观测到零」。
 *
 * 读不到的目录一律进 problems(⇒ UNKNOWN),**不静默跳过**:漏算是危险方向。
 * 返回 null 表示本目录取数失败。
 */
function collectJsonl(dir, problems, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    problems.push(`目录读不到:${dir}(${e.message})`);
    return null;
  }
  const out = [];
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (depth >= 8) {
        problems.push(`目录层级超过 8 层,停止下探(疑似环):${p}`);
        continue;
      }
      const sub = collectJsonl(p, problems, depth + 1);
      if (sub) out.push(...sub);
    } else if (d.name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

/** 枚举扫描面:`~/.claude/projects/` 的全部子目录。根目录读不到 ⇒ ok:false ⇒ UNKNOWN。 */
export function projectDirs(root = path.join(os.homedir(), ".claude", "projects")) {
  try {
    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
    return { ok: true, root, dirs, problem: null };
  } catch (e) {
    return { ok: false, root, dirs: [], problem: `转录根目录读不到:${root}(${e.message})` };
  }
}

/**
 * 跑一次计数。**取数失败一律进 problems,由调用方判 UNKNOWN**——本函数不替调用方
 * 把「读不到」翻译成「零」。
 *
 * @returns { files, coverage: [{dir, files}], rows, problems }
 */
export function runCensus({ dirs, sinceTs = null, collectShapes = false }) {
  const stat = new Map(TOOLS.map((t) => [t.name, { n: 0, last: "", kinds: new Set() }]));
  const problems = [];
  const coverage = [];
  let files = 0;
  let oldestMtimeMs = null; // E2:全扫描面里最老转录的 mtime,窗口截断自检用
  const shapes = new Map(); // --by-shape:subagent_type → { n, descs:Set }

  const bump = (tool, kind, ts) => {
    const s = stat.get(tool);
    if (!s) return;
    s.n += 1;
    s.kinds.add(kind);
    if (ts && ts > s.last) s.last = ts;
  };

  for (const dir of dirs) {
    // fail-closed:读不到的目录里可能正躺着这个工具的使用记录。
    const found = collectJsonl(dir, problems);
    if (found === null) {
      coverage.push({ dir, files: null });
      continue;
    }
    coverage.push({ dir, files: found.length });
    for (const full of found) {
      files += 1;
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
        const mt = fs.statSync(full).mtimeMs;
        if (Number.isFinite(mt) && (oldestMtimeMs === null || mt < oldestMtimeMs)) oldestMtimeMs = mt;
      } catch (e) {
        problems.push(`转录读不到:${full}(${e.message})`);
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const hasCmd = line.includes("<command-name>");
        const hasSkill = line.includes('"skill"');
        const hasAgent = line.includes('"subagent_type"');
        const hasScript = line.includes('"tool_use"') && /plugins[\\/]cache[\\/]/.test(line);
        // 形状计数须多认一类行:缺省 subagent_type 的 Agent/Task 调用没有 "subagent_type" 字段,
        // 只靠 hasAgent 会整类漏掉(那正是最常见的形状)。
        const hasSpawn = collectShapes && (line.includes('"name":"Agent"') || line.includes('"name":"Task"'));
        if (!hasCmd && !hasSkill && !hasAgent && !hasScript && !hasSpawn) continue;

        const tm = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
        const ts = tm ? tm[1].slice(0, 10) : "";
        // 时间戳缺失的行**不过滤**(宁可多算一次使用):漏算才是危险方向。
        if (sinceTs !== null && tm) {
          const lineTs = Date.parse(tm[1]);
          if (Number.isFinite(lineTs) && lineTs < sinceTs) continue;
        }

        // **行的角色判据**(2026-08-11 实撞后补,同「只数真调用不数提及」那条闸):
        // 同一段标记出现在三种位置——用户真发起的那一条、assistant 的 tool_use 载荷、
        // 以及 tool_result 里被回显的文本。**后两者是回声不是调用。**
        // 实撞:本文件的自测夹具里写了一行字面 `<command-name>` 标记,经 Write 落进本会话
        // 转录后,判据①把它记成了 3 次 `/xros:run`——**仪器把自己的源码读成了使用记录**。
        // 全库实测:129 份转录里 `<command-name>` 命中 129 行,其中 120 行是
        // `type=user` 且 `message.content` 为**字符串**(真调用),另 9 行分别落在
        // tool_use(10)/tool_result(12)/system(2)——形态干净可分。
        // 解析不出的行**退回宽松计数**:漏算才是危险方向(零使用是免签裁撤的唯一证据)。
        let obj = null;
        try { obj = JSON.parse(line); } catch {}
        const role = obj?.type ?? null;

        // ① slash:只认用户发起的那一条(content 是字符串;tool_result 的 content 是数组)。
        if (hasCmd && (role === null || (role === "user" && typeof obj?.message?.content === "string"))) {
          RE_CMD.lastIndex = 0;
          let m;
          while ((m = RE_CMD.exec(line))) {
            const t = toolOf(m[1]);
            if (t) bump(t, "slash", ts);
          }
        }
        // 形状计数(--by-shape):**只认 assistant 消息里真实的 tool_use 内容块**——
        // 与②③同一道回声闸,但更严:必须结构化解析到 content 数组里的
        // { type:"tool_use", name:"Agent"|"Task" },tool_result 回显与正文提及天然不命中。
        if (collectShapes && obj?.type === "assistant") {
          const items = Array.isArray(obj?.message?.content) ? obj.message.content : [];
          for (const it of items) {
            if (it?.type !== "tool_use" || (it?.name !== "Agent" && it?.name !== "Task")) continue;
            const st = String(it?.input?.subagent_type ?? "(缺省)");
            const s = shapes.get(st) ?? { n: 0, descs: new Set() };
            s.n += 1;
            if (it?.input?.description) s.descs.add(String(it.input.description));
            shapes.set(st, s);
          }
        }
        // ②③ skill / 子代理:只认 assistant 的 tool_use 载荷。
        if (role === null || role === "assistant") {
          for (const [re, kind, present] of [[RE_SKILL, "skill", hasSkill], [RE_AGENT, "agent", hasAgent]]) {
            if (!present) continue;
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(line))) {
              const t = toolOf(m[1]);
              if (t) bump(t, kind, ts);
            }
          }
        }
        // ④ 插件自带脚本**被执行**。判据只认 Bash/PowerShell 的 `"command"` 字段,
        //    **不认** Read 的 `"file_path"`——2026-08-11 首跑即实撞:我为做工具面测绘
        //    读了 xros/mermaid/english-buddy 的源码,原判据把这三次「读」记成了「用」。
        //    「路径出现在 tool_use 里」≠「脚本被执行」,判据类型闸。
        if (hasScript && (role === null || role === "assistant")) {
          const cmds = line.match(/"command"\s*:\s*"(?:[^"\\]|\\.)*"/g) || [];
          if (cmds.length) {
            const blob = cmds.join(" ");
            for (const t of TOOLS) {
              const re = new RegExp(`plugins[\\\\/]+cache[\\\\/]+[^"]*${t.prefix}[^"]*scripts[\\\\/]+`, "i");
              if (re.test(blob)) bump(t.name, "script", ts);
            }
          }
        }
      }
    }
  }

  const rows = TOOLS.map((t) => {
    const s = stat.get(t.name);
    return {
      tool: t.name,
      uses: s.n,
      last_used: s.last || null,
      kinds: [...s.kinds].sort(),
      verdict: s.n === 0 ? "未观测到使用" : "在用",
    };
  });
  const shapeRows = [...shapes.entries()]
    .map(([subagent_type, s]) => ({ subagent_type, uses: s.n, distinct_descriptions: s.descs.size }))
    .sort((a, b) => b.uses - a.uses);
  return { files, coverage, rows, problems, oldestMtimeMs, shapes: shapeRows };
}

/**
 * E2 · 窗口截断自检(纯函数,便于反向用例):窗口起点早于最老转录 mtime ⇒
 * 起点到最老转录之间的时段**可能已被 30 天静默扫除吃掉**,窗口内计数分不清
 * 「真没调用」与「转录已被删」⇒ 必须 UNKNOWN。oldest 取不到(null/非数)同判截断
 * ——fail-closed,方向与全仪器一致(假阴性会裁掉在用的工具)。
 */
export function windowTruncated(sinceTs, oldestMtimeMs) {
  if (!Number.isFinite(sinceTs)) return false; // 无窗口 = 全历史口径,由调用方另行声明天花板
  if (!Number.isFinite(oldestMtimeMs)) return true;
  return sinceTs < oldestMtimeMs;
}

// ---------- --self-test ----------
// 反向用例的立法依据(施工单四·纪律):A1 那三条反向用例全是「第一句就是裸打印」的形态,
// 测的是**想到的那个绕法**而不是绕法本身,反序一换就漏(F1)。故本组用例逐条写明
// **它覆盖的是哪个绕法**,并且每条都把「顺序/位置/数量」倒过来问了一遍。
// 夹具全落系统临时目录,用完即清;**不读真实 ~/.claude/projects,不写任何仓库文件**。
if (process.argv.includes("--self-test")) {
  let pass = 0;
  let fail = 0;
  const t = (name, ok, detail = "") => {
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}\n`);
    ok ? pass++ : fail++;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "census-selftest-"));
  const mkdir = (n) => {
    const d = path.join(tmp, n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const line = (obj) => JSON.stringify(obj);
  // 标记**拼出来,不写字面量**:本文件一旦在源码里出现完整的 `<command-name>` 标记,
  // 经 Write 落进会话转录后就会被本仪器自己的判据①记成一次真调用
  // ——2026-08-11 实撞,3 次幻影 `/xros:run` 就是这么来的。夹具不得污染被测面。
  const CMD = (id) => "<command-" + `name>/${id}</command-` + "name>";
  const userCmd = (ts, id) => line({ timestamp: ts, type: "user", message: { role: "user", content: CMD(id) } });

  // 夹具:一个**非** example-project 的项目目录,里面有一次真实的 xros 使用。
  const other = mkdir("E--somewhere-else");
  fs.writeFileSync(
    path.join(other, "s1.jsonl"),
    [
      userCmd("2026-08-05T10:00:00.000Z", "xros:run"),
      line({ timestamp: "2026-08-05T10:01:00.000Z", type: "assistant", message: { content: "ok" } }),
    ].join("\n") + "\n",
    "utf8",
  );
  const empty = mkdir("E--empty");

  // 用例 1:**覆盖面绕法**——使用发生在 example-project 以外的目录。
  // 反问「倒过来还成立吗」:把目录名换成任何别的、把使用形态从 slash 换成 skill/agent,
  // 判据都不依赖目录名,只依赖「这个目录在不在扫描面里」⇒ 成立。
  const r1 = runCensus({ dirs: [other] });
  t("覆盖面:非 example-project 目录里的 /xros:run 被计入", r1.rows.find((r) => r.tool === "xros").uses === 1,
    `xros=${r1.rows.find((r) => r.tool === "xros").uses}`);

  // 用例 1b:**深度绕法**——转录躺在 `<session>/subagents/` 里,不在项目目录直属层。
  // 这条是「把位置倒过来」的第二层:用例 1 换的是**横向**位置(哪个项目目录),
  // 这条换的是**纵向**位置(第几层)。2026-08-11 独立复核实撞:本机 505 份在深层、
  // 122 份在直属层,只扫第一层等于漏掉 80% 的面,**而子代理正是 skill 调用最密集处**。
  const deep = mkdir("E--deep");
  const nested = path.join(deep, "0af1b2c3-dead-beef-cafe-000000000001", "subagents");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "sub1.jsonl"),
    line({ timestamp: "2026-08-05T10:00:00.000Z", type: "assistant",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "mermaid-preview:x" } }] } }) + "\n", "utf8");
  const r1b = runCensus({ dirs: [deep] });
  t("覆盖面:`<session>/subagents/` 深层转录被计入(不是只扫第一层)",
    r1b.files === 1 && r1b.rows.find((r) => r.tool === "mermaid-preview").uses === 1,
    `files=${r1b.files} mermaid=${r1b.rows.find((r) => r.tool === "mermaid-preview").uses}`);

  // 用例 2:**UNKNOWN 绕法之一**——目录读不到时,不得输出一张与「真零使用」同形的全零表。
  // 反问:目录不存在 vs 权限不足 vs 路径打错,三者都走同一个 catch ⇒ 同判 problems,成立。
  const r2 = runCensus({ dirs: [path.join(tmp, "does-not-exist")] });
  t("UNKNOWN:目录读不到 ⇒ problems 非空(不得静默算零)", r2.problems.length > 0 && r2.files === 0,
    `problems=${r2.problems.length} files=${r2.files}`);

  // 用例 3:**UNKNOWN 绕法之二**——目录读得到但**零份转录**。
  // 这一条与用例 2 的区别正是 F4 点名的那个盲区:两者原来输出一模一样。
  const r3 = runCensus({ dirs: [empty] });
  t("UNKNOWN:目录可读但零转录 ⇒ files=0(由主流程判 UNKNOWN)", r3.problems.length === 0 && r3.files === 0,
    `problems=${r3.problems.length} files=${r3.files}`);

  // 用例 4:**「零使用」必须仍能与 UNKNOWN 分开**——有转录、可读、但该工具确实没被调用。
  // 若少了这条,把一切都判 UNKNOWN 也能让上面三条全绿(退化解),仪器就废了。
  const clean = mkdir("E--clean");
  fs.writeFileSync(path.join(clean, "s2.jsonl"),
    line({ timestamp: "2026-08-05T10:00:00.000Z", type: "user", content: "普通对话,没有任何工具调用" }) + "\n", "utf8");
  const r4 = runCensus({ dirs: [clean] });
  t("非退化:可读且有转录时,零调用仍判「观测到零」而非 UNKNOWN",
    r4.problems.length === 0 && r4.files === 1 && r4.rows.every((r) => r.uses === 0),
    `files=${r4.files} problems=${r4.problems.length}`);

  // 用例 5:**只数真调用不数提及**——插件名出现在正文里不算使用。
  // 反问:把提及放在行首/行尾/出现十次,判据都不认 ⇒ 成立。
  const mention = mkdir("E--mention");
  fs.writeFileSync(path.join(mention, "s3.jsonl"),
    line({ timestamp: "2026-08-05T10:00:00.000Z", type: "assistant", message: { content: "xros xros xros 我提了三次 xros:run 但没调用" } }) + "\n", "utf8");
  const r5 = runCensus({ dirs: [mention] });
  t("只数真调用:纯提及不计使用", r5.rows.find((r) => r.tool === "xros").uses === 0);

  // 用例 5b:**回声绕法**(2026-08-11 实撞的那一个)——**同一段标记**分别放进
  // ① 用户真发起的那一条、② assistant 的 tool_use 载荷、③ tool_result 的回显。
  // 只有 ① 该计数。这条正是「把位置倒过来还成立吗」问出来的:用例 5 测的是
  // 「提及写成散文」,而真正咬人的形态是**提及写成一模一样的标记、只是位置不同**。
  const echo = mkdir("E--echo");
  fs.writeFileSync(path.join(echo, "s4.jsonl"), [
    userCmd("2026-08-05T10:00:00.000Z", "xros:run"),                       // ① 真调用
    line({                                                                  // ② tool_use 载荷里的字面量
      timestamp: "2026-08-05T10:01:00.000Z", type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: { content: CMD("xros:run") } }] },
    }),
    line({                                                                  // ③ tool_result 回显
      timestamp: "2026-08-05T10:02:00.000Z", type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: CMD("xros:run") }] },
    }),
  ].join("\n") + "\n", "utf8");
  const r5b = runCensus({ dirs: [echo] });
  t("回声:同一标记在 tool_use / tool_result 里不计,只认用户发起的那一条",
    r5b.rows.find((r) => r.tool === "xros").uses === 1,
    `实测=${r5b.rows.find((r) => r.tool === "xros").uses}(应为 1)`);

  // 用例 5c:**②③ 的同族回声**——`"skill"` / `"subagent_type"` 出现在 tool_result 里
  // (例如我 cat 了一份别人的转录)不得计数;出现在 assistant 的 tool_use 里才算。
  const echo2 = mkdir("E--echo2");
  fs.writeFileSync(path.join(echo2, "s5.jsonl"), [
    line({ timestamp: "2026-08-05T10:00:00.000Z", type: "assistant",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "grill:roast" } }] } }),
    line({ timestamp: "2026-08-05T10:01:00.000Z", type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: '{"skill":"nlpm:score"}' }] } }),
  ].join("\n") + "\n", "utf8");
  const r5c = runCensus({ dirs: [echo2] });
  t("回声:skill 判据同样只认 assistant 的 tool_use",
    r5c.rows.find((r) => r.tool === "grill").uses === 1 && r5c.rows.find((r) => r.tool === "nlpm").uses === 0,
    `grill=${r5c.rows.find((r) => r.tool === "grill").uses} nlpm=${r5c.rows.find((r) => r.tool === "nlpm").uses}`);

  // 用例 6:**窗口绕法**——`--since` 早于/晚于使用时刻,计数必须跟着变。
  // 反问:边界那一刻(等于)算不算?判据是 `lineTs < sinceTs` 才丢 ⇒ 等于时保留,
  // 即窗口**含起点**,方向是「宁可多算一次使用」(漏算才会误裁)。
  const r6a = runCensus({ dirs: [other], sinceTs: Date.parse("2026-08-05T10:00:00.000Z") });
  const r6b = runCensus({ dirs: [other], sinceTs: Date.parse("2026-08-06T00:00:00.000Z") });
  t("窗口:起点当刻计入、起点之后不计入",
    r6a.rows.find((r) => r.tool === "xros").uses === 1 && r6b.rows.find((r) => r.tool === "xros").uses === 0,
    `含起点=${r6a.rows.find((r) => r.tool === "xros").uses} 窗口外=${r6b.rows.find((r) => r.tool === "xros").uses}`);

  // 用例 7:**写批折算绕法**——要一个不可能积满的窗口,必须判 UNKNOWN 而不是回一个时间戳。
  // 这是 F5 与 F4 交界处最危险的一格:折算不出却回了个「很早的时间戳」,
  // 会让窗口看起来很宽、使用数看起来很足,方向上骗人骗得最舒服。
  // 反问:n 取 0 / 负数 / 非整数,是不是也都不该回时间戳?——见下一条。
  const { writeBatchWindow } = await import("./constraint-events.mjs");
  const w7 = writeBatchWindow({ n: 1_000_000 });
  t("写批折算:窗口凑不满 ⇒ ok:false(不得回时间戳)", w7.ok === false, w7.note ?? "");

  // 用例 8:**参数面反向用例**——n 非正整数一律 ok:false。数量倒过来(0 / 负 / 小数)全测。
  const bad = [0, -3, 2.5, "abc", undefined].map((n) => writeBatchWindow({ n }).ok);
  t("写批折算:n 为 0/负/小数/非数/缺省 一律 ok:false", bad.every((ok) => ok === false), `实测=${JSON.stringify(bad)}`);

  // 用例 9:**真实链路可跑通**——n=1 在本仓应折算得出(否则说明台账或 git 面出了问题)。
  // 它是上面两条否定用例的正向对照:少了它,`writeBatchWindow` 恒返回 false 也能全绿。
  const w9 = writeBatchWindow({ n: 1 });
  if (!w9.ok && /台账文件不存在/.test(String(w9.note))) console.log("  SKIP 写批折算:n=1(本仓还没有约束事件台账;有台账的仓里照核)");
  else t("写批折算:n=1 在本仓折算得出起始时间戳", w9.ok === true && Number.isFinite(w9.sinceTs),
    w9.ok ? new Date(w9.sinceTs).toISOString() : w9.note);

  // 用例 10:**世代起点损坏 ⇒ 必须 UNKNOWN,不得退回全历史**(2026-08-11 独立复核实撞)。
  // 这是本组里最阴的一格:坏掉时窗口不是变窄而是**变宽**,使用数看起来更足、
  // 更像「有人在用」——错得很安静。反问「倒过来」:genesis 缺失(readLedger 已管)与
  // genesis 在但 ts 坏(readLedger **不管**)是两条路,后者过去无人把关。
  const badLedger = path.join(tmp, "bad-genesis.jsonl");
  fs.writeFileSync(badLedger, [
    line({ layer: "genesis", seq: 1, ts: "not-a-timestamp", generation: "gTEST" }),
    line({ layer: "raw", seq: 2, kind: "heartbeat", ts: "2026-08-01T00:00:00.000Z", source: "selftest" }),
  ].join("\n") + "\n", "utf8");
  const w10 = writeBatchWindow({ n: 1, file: badLedger });
  t("写批折算:genesis 时间戳坏 ⇒ ok:false(不得 fail-open 退回全历史)",
    w10.ok === false && /genesis/.test(w10.note ?? ""), w10.note ?? "(无 note)");

  // 用例 11:**E2 截断自检(纯函数,三向反问)**——起点早于最老 mtime ⇒ 截断;
  // 起点晚于 ⇒ 不截断;最老 mtime 取不到 ⇒ fail-closed 判截断;无窗口 ⇒ 不判。
  t("E2:起点早于最老转录 ⇒ 截断", windowTruncated(1000, 2000) === true);
  t("E2:起点晚于最老转录 ⇒ 不截断", windowTruncated(3000, 2000) === false);
  t("E2:最老 mtime 取不到 ⇒ fail-closed 判截断", windowTruncated(1000, null) === true);
  t("E2:无窗口(sinceTs null)⇒ 不判", windowTruncated(null, 2000) === false);

  // 用例 12:**形状计数的回声闸**(B9 并轨的存在理由)——同一个 Agent 调用 JSON
  // 分别放进 ① assistant 的 tool_use 内容块、② tool_result 回显文本。只有 ① 计数。
  // 反问「倒过来」:缺省 subagent_type(无 "subagent_type" 字段)的调用也必须被数到
  // ——那正是旧仪器与行过滤都容易漏的一类。
  const shapeDir = mkdir("E--shapes");
  fs.writeFileSync(path.join(shapeDir, "s6.jsonl"), [
    line({ timestamp: "2026-08-05T10:00:00.000Z", type: "assistant",
      message: { content: [{ type: "tool_use", name: "Agent",
        input: { subagent_type: "Explore", description: "scan A" } }] } }),
    line({ timestamp: "2026-08-05T10:01:00.000Z", type: "assistant",
      message: { content: [{ type: "tool_use", name: "Task",
        input: { description: "default-type spawn" } }] } }), // 缺省型
    line({ timestamp: "2026-08-05T10:02:00.000Z", type: "user",
      message: { role: "user", content: [{ type: "tool_result",
        content: '{"type":"tool_use","name":"Agent","input":{"subagent_type":"Explore","description":"echo"}}' }] } }),
  ].join("\n") + "\n", "utf8");
  const r12 = runCensus({ dirs: [shapeDir], collectShapes: true });
  const exploreRow = r12.shapes.find((s) => s.subagent_type === "Explore");
  const defaultRow = r12.shapes.find((s) => s.subagent_type === "(缺省)");
  t("形状:assistant tool_use 计数、tool_result 回显不计、缺省型也数到",
    exploreRow?.uses === 1 && defaultRow?.uses === 1 && r12.shapes.length === 2,
    `Explore=${exploreRow?.uses} 缺省=${defaultRow?.uses} 种数=${r12.shapes.length}`);

  // 用例 12b:**不开 collectShapes 时形状面零开销零输出**(默认路径不变形)。
  const r12b = runCensus({ dirs: [shapeDir] });
  t("形状:未开 --by-shape 时 shapes 为空表", Array.isArray(r12b.shapes) && r12b.shapes.length === 0);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.stdout.write(`\nPASS=${pass} FAIL=${fail}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

// ---------- 常态入口 ----------

const args = process.argv.slice(2);
// ── `--index-drift`:倒排索引漂移自测(2026-08-22 用户亲签「倒排索引做掉吧」随批加)──
//   docs/tool-index.md 按「问题→工具」倒排;它是枚举清单,枚举清单的病是**每长一个新件就漏一次**
//   (CODEOWNERS 教训,tool-register 头注同款)。本模式机械核:
//   ① tool-register 每个在册件名 ② .claude/{commands,skills,agents} 每个已装封装名
//   —— 都必须被 tool-index.md 提及;缺谁点谁名,断线即红(退出码 1)。
//   天花板:只核「名字被提及」,核不了「归到的问题行对不对」——后者是编辑判断,归人。
if (args.includes("--index-drift")) {
  const idx = fs.readFileSync(path.join(REPO_ROOT, "docs/tool-index.md"), "utf8");
  const missing = [];
  // ① 在册件
  const reg = fs.readFileSync(path.join(REPO_ROOT, "docs/tool-register.md"), "utf8");
  for (const m of reg.matchAll(/^\| `([^`]+)`/gm)) {
    const name = m[1].replace(/\.mjs$/, "").replace(/^lib\//, "");
    if (!idx.includes(name)) missing.push(`在册件:${m[1]}`);
  }
  // ② 已装封装(命令/技能/agent 目录名)
  for (const sub of ["commands", "skills", "agents"]) {
    const dir = path.join(REPO_ROOT, ".claude", sub);
    let names = [];
    try { names = fs.readdirSync(dir).map((n) => n.replace(/\.md$/, "")); } catch { continue; }
    for (const n of names) if (!idx.includes(n)) missing.push(`${sub}:${n}`);
  }
  if (missing.length) {
    console.log(`✗ 倒排索引漂移:${missing.length} 个名字不在 docs/tool-index.md ——\n  ` + missing.join("\n  "));
    process.exit(1);
  }
  console.log("✓ 倒排索引无漂移(在册件+已装封装全部被提及)");
  process.exit(0);
}
// ── `--playbook-drift`:playbook 引用漂移机器核(D50 结账,2026-08-23)──
//   clipboard/gate-playbook.md 自称「照抄可用」,而复审两次逮到它写错自己产物的文件名/flag
//   (gate-acceptance.mjs 不存在、--check 应为 --migrate-check;外部评审 08-23 再证此病)。机械核:
//   ① 文中反引号里的 scripts/*.mjs 与 lib/*.mjs 引用 ⇒ fs 找得到(lib/ 映射 scripts/lib/);
//   ② 同一行「路径 + --flag」共现 ⇒ 该 flag 字面量真在那个文件里(--no-warnings 属 node 不计)。
//   天花板:只核名与 flag 存在,核不了语义描述对错(归外审);裸文件名(无前缀)不计——
//   反引号+前缀才是「照抄」承诺面,概念性占位不背这个约。默认路径=动 playbook 的批收尾跑一次。
if (args.includes("--playbook-drift") || args.includes("--doc-drift")) {
  // 098 按用户扩面:不止 playbook——docs/**/*.md 全体同规核;--playbook-drift 留作别名。
  const targets = [];
  const pb = path.join(REPO_ROOT, "clipboard/gate-playbook.md");
  if (fs.existsSync(pb)) targets.push(pb);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) targets.push(p);
    }
  };
  try { walk(path.join(REPO_ROOT, "docs")); } catch {}
  const bad = [];
  let nPaths = 0;
  const resolve = (p) => {
    const cands = [p, p.replace(/^lib\//, "scripts/lib/"), `scripts/${p}`];
    return cands.find((c) => fs.existsSync(path.join(REPO_ROOT, c))) || null;
  };
  for (const t of targets) {
    const md = fs.readFileSync(t, "utf8");
    const rel = path.relative(REPO_ROOT, t).replace(/\\/g, "/");
    const seen = new Set();
    for (const m of md.matchAll(/`((?:scripts\/|lib\/)[\w./-]+\.mjs)`/g)) seen.add(m[1]);
    nPaths += seen.size;
    const real = new Map();
    for (const p of seen) {
      const r = resolve(p);
      if (!r) bad.push(`${rel} → 文件不存在:${p}`);
      else real.set(p, r);
    }
    for (const line of md.split("\n")) {
      // flag 只对**最近的前一个路径**负责——同行多路径×多 flag 叉乘全配对会误报
      // (098 首扫实撞:一行三路径两 flag 红出 4 处假账)。
      const toks = [];
      for (const m of line.matchAll(/(?:scripts\/|lib\/)[\w./-]+\.mjs/g))
        if (real.has(m[0])) toks.push({ i: m.index, kind: "p", v: m[0] });
      for (const m of line.matchAll(/--[a-z][\w-]+/g))
        if (m[0] !== "--no-warnings") toks.push({ i: m.index, kind: "f", v: m[0] });
      // 2026-11-12:归属在分句处断开(分号、句号、表格竖线)。债表的长行里,一个路径后面隔着几个分句的 flag 往往是别的脚本的
      //   (实撞:D204 / D201 两行 11 处假报——`--arm --force` 被算给同一行更早出现的 lib/gate-carriers.mjs,
      //   每个写过 docs 的会话收尾都响一次)。代价:路径与 flag 隔着分句的真漂移不再报(本项只是提示级绊线,接受)。
      for (const m of line.matchAll(/[;;。|]/g)) toks.push({ i: m.index, kind: "s" });
      toks.sort((a, b) => a.i - b.i);
      let cur = null;
      for (const t of toks) {
        if (t.kind === "s") { cur = null; continue; }
        if (t.kind === "p") { cur = t.v; continue; }
        if (!cur) continue;
        const body = fs.readFileSync(path.join(REPO_ROOT, real.get(cur)), "utf8");
        if (!body.includes(t.v)) bad.push(`${rel} → flag 不在产物里:${cur} ${t.v}(行首:${line.slice(0, 40)}…)`);
      }
    }
  }
  if (bad.length) {
    console.log(`✗ 文档引用漂移 ${bad.length} 处(扫 ${targets.length} 文件)——\n  ` + bad.join("\n  "));
    process.exit(1);
  }
  console.log(`✓ 文档引用无漂移(扫 ${targets.length} 文件、反引号路径 ${nPaths} 个、同行 flag 共现均核过)`);
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write(
    [
      "tool-usage-census.mjs —— 工具使用计数(工具面退役章程观测仪器)",
      "",
      "  --json            出 JSON",
      "  --playbook-drift  playbook 引用漂移机器核(D50;动 playbook 的批收尾跑)",
      "  --since <日期>    窗口按日期算(ISO,如 2026-07-28)",
      "  --batches <n>     窗口按**写批**算,经 constraint-events.writeBatchWindow() 折算",
      "  --self-test       反向用例自测",
      "",
      "退出码:0 = 结论可用;2 = VERDICT=UNKNOWN(取数失败/零转录/折算不出)。",
      "**UNKNOWN 不得读作零使用**——零使用是免签裁撤的唯一证据,假阴性会裁掉在用的工具。",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

const asJson = args.includes("--json");
const byShape = args.includes("--by-shape");
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const batchesIdx = args.indexOf("--batches");
const batchesArg = batchesIdx >= 0 ? args[batchesIdx + 1] : null;

const problems = [];
let sinceTs = null;
let window = null;

if (since !== null && batchesArg !== null) {
  problems.push("--since 与 --batches 同时给出:窗口口径二义,拒绝出结论");
} else if (batchesArg !== null) {
  const { writeBatchWindow } = await import("./constraint-events.mjs");
  const w = writeBatchWindow({ n: Number(batchesArg) });
  if (!w.ok) {
    problems.push(`写批折算失败:${w.note}`);
  } else {
    sinceTs = w.sinceTs;
    window = {
      unit: "写批",
      batches: w.batches,
      total_batches_in_generation: w.total,
      since_ts: new Date(w.sinceTs).toISOString(),
      commits: w.commits,
      generation: w.generation,
    };
  }
} else if (since !== null) {
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(since)) ? `${since}T00:00:00Z` : String(since));
  if (!Number.isFinite(parsed)) problems.push(`--since 不是合法日期:「${since}」`);
  else {
    sinceTs = parsed;
    window = { unit: "日期", since_ts: new Date(parsed).toISOString() };
  }
}

const scan = projectDirs();
if (!scan.ok) problems.push(scan.problem);

const { files, coverage, rows, problems: censusProblems, oldestMtimeMs, shapes } =
  scan.ok && problems.length === 0
    ? runCensus({ dirs: scan.dirs, sinceTs, collectShapes: byShape })
    : { files: 0, coverage: [], rows: [], problems: [], oldestMtimeMs: null, shapes: [] };
problems.push(...censusProblems);

// UNKNOWN 判据(fail-closed):取数失败 / 零转录 / 折算不出,任一命中即 UNKNOWN。
if (problems.length === 0 && files === 0) problems.push("扫描到 0 份转录 —— 覆盖面为空,结论不可用");
// E2 · 窗口截断:窗口起点早于最老转录 mtime ⇒ 30 天扫除可能已吃掉窗口头部 ⇒ UNKNOWN。
if (problems.length === 0 && windowTruncated(sinceTs, oldestMtimeMs)) {
  problems.push(
    `窗口起点(${new Date(sinceTs).toISOString()})早于最老转录 mtime` +
      `(${oldestMtimeMs === null ? "取不到" : new Date(oldestMtimeMs).toISOString()})` +
      `——窗口头部可能已被 30 天静默扫除截断,窗口内计数分不清「真没调用」与「转录已删」`,
  );
}
const unknown = problems.length > 0;

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        verdict: unknown ? "UNKNOWN" : "OK",
        scanned_files: files,
        scan_root: scan.root,
        coverage,
        window,
        since: since || null,
        problems,
        rows: unknown ? [] : rows,
        shapes: unknown || !byShape ? undefined : shapes,
      },
      null,
      2,
    ) + "\n",
  );
} else if (unknown) {
  process.stdout.write("VERDICT=UNKNOWN —— 取数没跑成,**这不是「零使用」**。\n\n");
  for (const p of problems) process.stdout.write(`  · ${p}\n`);
  process.stdout.write(
    "\n零使用是免签裁撤的**唯一**证据,故本仪器在取不到数时不出表:" +
      "一张全零表与一次取数失败长得一模一样,而后者会把在用的工具裁掉(判据类型闸)。\n",
  );
} else {
  process.stdout.write(`扫描会话转录 ${files} 份,覆盖 ${coverage.length} 个项目目录(根:${scan.root})\n`);
  for (const c of coverage) process.stdout.write(`  · ${path.basename(c.dir)}:${c.files} 份\n`);
  if (window) {
    process.stdout.write(
      window.unit === "写批"
        ? `\n窗口 = 最近 ${window.batches} 个写批(世代内共 ${window.total_batches_in_generation} 个)` +
            `,折算起点 ${window.since_ts};窗口内 commit ${window.commits.length} 个:${window.commits.join(" ")}\n`
        : `\n窗口 = ${window.since_ts} 起\n`,
    );
  }
  process.stdout.write("\n" + "工具".padEnd(24) + "调用数".padEnd(8) + "最近".padEnd(12) + "形态\n");
  for (const r of rows) {
    process.stdout.write(
      r.tool.padEnd(24) + String(r.uses).padEnd(8) + String(r.last_used ?? "—").padEnd(12) +
        (r.kinds.join(",") || r.verdict) + "\n",
    );
  }
  if (byShape) {
    process.stdout.write("\n子代理形状(--by-shape;同一回声闸,只认 assistant 的 tool_use):\n");
    process.stdout.write("subagent_type".padEnd(28) + "调用数".padEnd(8) + "不同描述数\n");
    for (const s of shapes) {
      process.stdout.write(s.subagent_type.padEnd(28) + String(s.uses).padEnd(8) + String(s.distinct_descriptions) + "\n");
    }
    if (!shapes.length) process.stdout.write("(未观测到 Agent/Task 调用)\n");
  }
  process.stdout.write(
    "\n注:0 只能读作「**未观测到使用**」,不得读作「无用」——可能只是没遇到场合(判据类型闸)。\n",
  );
}

process.exit(unknown ? 2 : 0);
