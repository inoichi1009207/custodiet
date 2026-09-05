// gate-cmd.mjs —— 命令串的**参数面 / 文本面**分离:唯一实现
//
// 立此模块的理由(2026-08-20):同一族错误已在本仓发生**五次**,每次都在正则的作用域上:
//   ① L 项 `/ls\s+[^"]*scripts/` —— `[^"]*` 横跨整条序列化命令 ⇒ 假阳;
//      同一个 `[^"]*` 又跨不过引号 ⇒ 假阴。**一个字符类同时造出两个方向的错。**
//   ② M 项 `sed -i` 的 `[^\s]+` 吃不下含空格的 sed 脚本 ⇒ 捕获到脚本内部的变量名,
//      于是要求回读一个**不存在的文件**。
//   ③ E0 的 `[^"]*` 跨不过**转义**引号。
//   ④ `ranClear` 的 `[\s\S]*` 横跨整条命令 ⇒ `--cond "K 的 --clear 阻断…"` 被判成跑过结清
//      (写完当天被自己武装批次时写的条件文本绊倒)。
//   ⑤ ④ 的修法 `/"[^"]*"|'[^']*'/g` 在**转义引号**上再破:`--cond "他说 \"跑 --clear\" 就行"`。
//
// 前四次每次都留了注、都写着「正则的作用域比我以为的宽」,第五次照样犯
// ⇒ **结论:这一族靠注释防不住,只能靠唯一实现。**
//
// 外部先例(2026-08-20 WebSearch,已取页):业界不拿正则做这件事,用真词法器——
//   `shell-quote` / `node-shlex`(Python shlex 的 JS 移植)。搜索结果原话点名了⑤:
//   「The biggest catch with regex approaches is that the regex **doesn't handle escaped
//    quotes**—if you have "stuff \"what\"", it won't give you what you want.」
// 不引依赖的理由(**不是**「自己写更好」):本文件服务于**每回合必跑**的 Stop hook,
//   加一条 npm 依赖等于给闸引入启动开销与供应链面,而这里只需要词法器的一小块。
//   ⇒ 手写,但**只手写一次**,并把外部先例逐条钉成用例。
// CEILING:这不是 shell 解析器。它**不做**变量展开、不认 `$'…'` ANSI-C 串、
//   不处理 here-doc、不理解 `2>/dev/null` 这类算子。要那些请换真词法器。
//
// ── 工具面已扫(纪律 32 三层,2026-08-20)──────────────────────────────────────
// ① `docs/tool-register.md`:**无命中**——在册件里没有做 shell 词法/切段的。
// ② 已在册市场(claude-plugins-official / my-pinned / xiaolai):**无命中**,
//    没有可直接装、能给 hook 内部用的词法器。
// ③ 本项目已有封装:**命中,且比预想的重**——
//    · `tplan-gate.mjs` 的 `shellMetachar` 是**探测器**(命中即 FAIL)不是切段器,
//      头注明写「刻意不抽」,与本模块不重复;
//    · 但仓里**已有四份朴素切段**,全都不认引号:
//        `gate-rules.mjs:292`(L 的 `ls` 清点)、`ranProbe` 的 node 段、
//        `bashWriteTargets` 的 cp/mv 段、`properClose` 的 clear/write 段。
//      `gate-rules.mjs:640` 自己写着「切段这件事今天已经是第四次……
//      **凡是「A 和 B 是否属于同一条命令」的判断,都必须先切段**」
//      ——**又一条写在注释里的规则**,写了没人执行。
//
// 【欠账,已登记未做】把那四处迁到 `segments()`。不当批做的理由:
//   L/M 的分歧条目是按**现行行为**校准的(EXPECTED_DIVERGENCE 里逐条写着成因),
//   换切法会同时改动它们在全语料上的读数,该单独立批并重跑影子比对。
//   `properClose` 与 `ranClear` 已迁(本批)。

/** 把命令串里被引号包住的内容替换成空格,**正确处理反斜杠转义**。
 *  返回的串里只剩「参数面」——用它做匹配,文本面的内容不会冒充成参数。 */
export function stripQuoted(cmd) {
  const s = String(cmd || "");
  let out = "";
  let quote = null;          // null / '"' / "'"
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // ⚠️ 反斜杠**在单引号内不是转义符**(POSIX)。第一版一视同仁,于是
    //   `a 'b\'c' d` 的掩码长度对不上(10 → 11),下标全线错位。
    //   同一处还漏了 `i++`:引号内遇到 `\"` 时吐了两个空格却只吃了一个字符,
    //   于是那个被转义的引号又被当成闭合引号——⑤ 号用例正是死在这里。
    //   两个 bug 同一根:**转义分支必须与「吃掉几个字符」严格对应**。
    if (c === "\\" && i + 1 < s.length && quote !== "'") {
      if (quote) { out += "  "; i++; }        // 引号内:整体算文本,吃两个吐两个
      else out += c + s[++i];                  // 引号外:保留(`\;` 这类在参数面上有意义)
      continue;
    }
    if (quote) {
      if (c === quote) { quote = null; out += " "; }
      else out += " ";       // 引号内一律抹成空格,长度保持不变以免行列错位
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += " "; continue; }
    out += c;
  }
  return out;
}

/** 按 shell 的**语句分隔符**切段(`&&` / `||` / `;` / `|` / 换行),
 *  且**只在引号外**切——引号里的 `;` 不是分隔符。
 *  L 项那个「一条 `ls` 横跨整条序列化命令」的假阳,根因就是没有这一步。 */
export function segments(cmd) {
  const raw = String(cmd || "");
  const masked = stripQuoted(raw);          // 与 raw 等长,可用同一组下标
  const cuts = [];
  for (let i = 0; i < masked.length; i++) {
    // ⚠️ **转义的分隔符不是分隔符**(2026-08-20 codex 发现,「你没问到的」那节)。
    //   `echo a\;b` 原本被切成两段,而本文件自己的注释写着「引号外的 `\;` 有意义」
    //   ——注释说一套、代码做另一套,又一次。`stripQuoted` 在引号外**保留**了 `\x`,
    //   所以这里必须自己跳过被转义的那个字符。
    if (masked[i] === "\\") { i++; continue; }
    const two = masked.slice(i, i + 2);
    if (two === "&&" || two === "||") { cuts.push([i, i + 2]); i++; continue; }
    const c = masked[i];
    if (c === ";" || c === "|" || c === "\n") cuts.push([i, i + 1]);
  }
  const out = [];
  let at = 0;
  for (const [a, b] of cuts) { out.push(raw.slice(at, a)); at = b; }
  out.push(raw.slice(at));
  return out.map((s) => s.trim()).filter(Boolean);
}

// ── 自测 ────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith("gate-cmd.mjs") && process.argv.includes("--self-test")) {
  let pass = 0, total = 0;
  const chk = (name, got, want) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `  ← 期待 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`));
    if (ok) pass++;
  };
  const has = (cmd, re) => re.test(stripQuoted(cmd));
  const CLEAR = /batch-goal\.mjs[^"']*--clear\b/;

  // 五次实撞逐条钉死
  chk("④ --cond 文本里的 --clear 不算参数",
    has('node scripts/batch-goal.mjs --arm 072 --cond "K 的 --clear 阻断"', CLEAR), false);
  chk("⑤ **转义引号**内的 --clear 也不算(前一版在此破)",
    has('node scripts/batch-goal.mjs --arm 1 --cond "他说 \\"跑 --clear\\" 就行"', CLEAR), false);
  chk("单引号内嵌双引号", has("node scripts/batch-goal.mjs --arm 1 --cond '说 \"--clear\"'", CLEAR), false);
  chk("真结清仍认得", has("node scripts/batch-goal.mjs --clear", CLEAR), true);
  chk("结清带管道仍认得", has("node scripts/batch-goal.mjs --clear | tail -1", CLEAR), true);
  chk("别的脚本的 --clear 不认", has("node scripts/other.mjs --clear", CLEAR), false);
  chk("grep 到该命令串不认", has('grep -n "batch-goal.mjs --clear" docs/laws/collab.md', CLEAR), false);

  // 掩码必须**等长**——否则拿它的下标去切 raw 会错位
  for (const c of ['a "bc" d', "a 'b\\'c' d", 'x \\"y', "空", ""]) {
    chk(`掩码等长:${JSON.stringify(c)}`, stripQuoted(c).length, c.length);
  }

  // 分段:引号内的分隔符不算
  chk("① 引号外才切段", segments('ls clipboard/; node -e "a;b" && echo x'),
    ["ls clipboard/", 'node -e "a;b"', "echo x"]);
  chk("换行也是分隔符", segments("a\nb"), ["a", "b"]);
  chk("单段原样", segments("ls -la"), ["ls -la"]);
  // ⚠️ **转义的分隔符不是分隔符**(codex「你没问到的」)。注意用真反斜杠构造:
  //   JS 源码里写 `'echo a\;b'` 的 `\;` 会被吃成 `;`,那样测的是另一件事
  //   ——我第一次验就栽在这儿,差点据此宣布 codex 报错了。
  const ESC = String.fromCharCode(101, 99, 104, 111, 32, 97, 92, 59, 98);  // echo a\;b
  chk("转义分隔符不切段", segments(ESC), [ESC]);
  chk("未转义照切(对照组,证明上一条不是恒不切)", segments("echo a;b"), ["echo a", "b"]);
  chk("空串给空数组", segments(""), []);

  console.log(`gate-cmd 自测 ${pass}/${total}`);
  process.exit(pass === total ? 0 : 1);
}
