// gate-slice.mjs —— 把一份 transcript 切成「闸当时真正看到的那些窗口」的**唯一实现**
//
// 为什么单独成一个模块(2026-08-20):
//   ① 它必须能被**复现探针**直接 import。原先我把它导出在 `gate-migrate-check.mjs` 里,
//      而那个文件是**脚本不是模块**——一 import 就把整台 6614 片的验收跑起来。
//      这是本仓 main-guard 缺失的第三次(前两次:hook-stop-closure.mjs、batch-goal.mjs)。
//   ② 外部先例(2026-08-20 WebSearch)给了这类问题的名字:**harness-induced divergence**
//      ——分歧来自比对台本身而非被测系统;对策是「deterministic representation makes
//      comparisons repeatable」。本仓已在 `lastTurn` 上吃过一次(两边输入面不同,
//      比出 25/122 假分歧),而**切边界这一段一直是各写各的**。
//      今天那条查不清的 M 分歧(a891142e#186:验收台报旧=[M],探针跑同一片得旧=[])
//      就是这么来的:探针与台子不是同一个切法,于是「同一片」根本不是同一片。
//
// 纪律:任何要复现验收台结果的脚本,**必须 import 这一个**,不许自己再写一遍边界计算。

/**
 * @param {string[]} lines 一份 transcript 的非空行
 * @returns {number[]} 递增的切片边界(末项 = lines.length)
 */
export function sliceBoundaries(lines) {
  const sys = [];
  lines.forEach((l, idx) => {
    if (/"type"\s*:\s*"system"/.test(l) && /hookCount|收尾闸|收尾闭环闸/.test(l)) sys.push(idx);
  });
  // ⚠️ 有 ≥2 个 hook 观察点就用它们;否则**整体换成** user 边界——不是混着用。
  //   原实现在 `bounds.length < 2` 时把 user 边界**追加**进已有数组而不重置 ⇒
  //   数组变成 `[系统点, user点1, user点2…]`,**未排序**,
  //   于是 `slice(bounds[bi], bounds[bi+1])` 可能切出反向或空片。
  const base = sys.length >= 2 ? sys : (() => {
    const u = [];
    lines.forEach((l, idx) => { if (/"type"\s*:\s*"user"/.test(l)) u.push(idx); });
    return u;
  })();
  // ⚠️ **必须补 0**(2026-08-20 codex 复核逮到,是我改「追加→互斥」时引入的回归):
  //   互斥写法下,「恰有一个系统点、且没有任何 user 行」会得到 `base=[]` ⇒ 返回 `[N]`,
  //   **只有一个元素、没有任何相邻对** ⇒ 调用方一片都切不出来,**整段转录静默消失**。
  //   旧的追加写法在这种输入上反而是对的(`[0,2]`)。同理:首个 user 出现得很晚时,
  //   它**之前**的内容全部落在第一个边界之外、被丢掉。
  //   补 0 让第一片总是从文件开头起,两种缺陷一并消灭;去重保证仍然严格递增。
  const all = base[0] === 0 ? base : [0, ...base];
  return [...new Set(all), lines.length].sort((a, b) => a - b);
}

export function selfTest() {
  const t = [];
  const chk = (n, got, want) => t.push([JSON.stringify(got) === JSON.stringify(want) ? "PASS" : "FAIL", n, `实得 ${JSON.stringify(got)}`]);
  const SYS = (n) => `{"type":"system","content":"hookCount ${n} 收尾闸"}`;
  const U = () => `{"type":"user","message":{}}`;
  const A = () => `{"type":"assistant","message":{}}`;

  chk("两个以上观察点 ⇒ 用观察点",
    sliceBoundaries([SYS(1), A(), SYS(2), A()]), [0, 2, 4]);

  // ⚠️ 回归守卫:**只有一个观察点**时的旧 bug —— 追加而不重置 ⇒ 乱序。
  //   旧写法在这份输入上会得到 [1, 0, 2](系统点 1 排在 user 点 0 前面),
  //   而 `slice(1, 0)` 是空片 ⇒ 该片静默消失,且不同调用方的切法会不一致。
  const mixed = [U(), SYS(1), U(), A()];
  const got = sliceBoundaries(mixed);
  chk("只有一个观察点 ⇒ 整体换 user 边界(不混用)", got, [0, 2, 4]);
  chk("结果必须递增(乱序即回归)", got.every((v, i) => i === 0 || got[i - 1] <= v), true);

  // ⚠️ 回归守卫:codex 2026-08-20 复核逮到的、我改「追加→互斥」时引入的回归。
  //   「恰有一个系统点 + 没有任何 user 行」在补 0 之前会得到 `[2]` —— 只有一个元素、
  //   没有任何相邻对 ⇒ 一片都切不出来,**整段转录静默消失**。
  chk("一个观察点 + 无 user ⇒ 仍切得出一片(整段消失的回归)",
    sliceBoundaries([SYS(1), A()]), [0, 2]);
  chk("首个 user 出现得晚 ⇒ 它之前的内容不被丢掉",
    sliceBoundaries([A(), A(), U(), A()]), [0, 2, 4]);
  chk("没有任何边界 ⇒ 仍是一整片", sliceBoundaries([A(), A()]), [0, 2]);

  {
    const b = sliceBoundaries([U(), SYS(1), U(), A(), U()]);
    chk("永远严格递增且无重复", b.every((v, i) => i === 0 || b[i - 1] < v), true);
  }

  let pass = 0;
  for (const [r, n, extra] of t) { console.log(`  ${r}  ${n}${r === "FAIL" ? "  ← " + extra : ""}`); if (r === "PASS") pass++; }
  console.log(`\n切片自测 ${pass}/${t.length}`);
  return pass === t.length;
}

// ⚠️ **必须判是不是主模块**(2026-08-20,同一个 bug 今天第四次)。
// 原写法只看 argv:被 `import` 时,`--self-test` 是**导入方**的参数,
// 于是本模块在被导入的瞬间就跑自测并 `process.exit` —— 把导入方的自测整个劫持掉
// (实撞:`hook-stop-closure --self-test` 打印的是本文件的计数)。
// 前三次:hook-stop-closure.mjs、batch-goal.mjs、gate-migrate-check.mjs(导出 sliceBoundaries 时)。
const IS_MAIN = !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
if (IS_MAIN && process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
