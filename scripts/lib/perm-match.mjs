// 权限模式匹配器 —— **唯一实现**(026 批 S1,2026-07-31)。
//
// 本模块是「一条命令是否命中权限档案 allow / deny 条目」的**唯一实现**:
// `tplan-gate.mjs` 的验5(发车前命令面预检)与 `hook-tplan-permission.mjs`
// (无头权限处理器)**共用本模块,不得各自再写一份**。
// —— 立此规矩的直接教训:021 批刚归一过「判活逻辑住两个工装、对同一 pid 给出
// 相反结论」;权限匹配若各写一份,发车前预检说「在册」、跑起来处理器说「不在册」,
// 是同一个坑的重演。
//
// ── 两条不对称规则(逐字保留自 tplan-gate.mjs,不得放宽)────────────────
//   allow 侧**严**:只承认「全字面」与「唯一 `*` 在末尾的前缀通配」两种可判形态;
//                   中间通配 / 前导通配一律**不予承认**(算未命中)。
//                   本匹配器与 CLI 真实匹配器**不保证等价**,故只允许在「清楚命中」时放行。
//   deny  侧**宽**:`*` → `.*` 全串正则,宁可多报,不可漏报。
// 两侧不对称是刻意的 —— 两个方向都指向 fail-closed。
//
// ── 刻意**不**收本模块的东西 ────────────────────────────────────────────
// `shellMetachar`(shell 元字符探测)**留在 tplan-gate.mjs,不抽进来**:
// 它是**闸的 fail-closed 策略**,不是匹配语义,且已实证**比 CLI 实际更严**
// ——019 批在本机对 CLI 2.1.220 实测:CLI 会拆解复合命令逐段判权限,
// `;` / `&&` / 管道 / 命令替换 / 重定向均获放行。处理器若照搬这条会**误拒**
// 一批 CLI 本会放行的命令。详见 tplan-gate.mjs 头注的实测更正段。
//
// 本模块为纯函数,不读文件、不碰进程、不写任何东西。

/** 权限条目 `Tool(pattern)` / 裸 `Tool` 的解析。解析不出 = 返回 null(调用方按不承认处理)。 */
export function parsePermEntry(entry) {
  const m = String(entry).match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s);
  if (m) return { tool: m[1], pattern: m[2] };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(entry).trim())) return { tool: String(entry).trim(), pattern: null };
  return null;
}

/**
 * allow 侧的**严格**匹配:只承认两种形态 ——
 *   ① 全字面(模式串无 `*`)⇒ 整条相等;
 *   ② 前缀 + 尾部通配(唯一的 `*` 在末尾)⇒ 前缀匹配。
 * 中间带 `*`、以 `*` 开头、或裸工具名以外的任何其他形态,一律**不予承认**(返回 null)。
 * 这是「只在清楚命中时 PASS」的落实点,不得放宽成通用 glob。
 */
export function matchAllow(cmd, tool, allowList) {
  for (const raw of allowList) {
    const e = parsePermEntry(raw);
    if (!e || e.tool !== tool) continue;
    if (e.pattern === null) return raw; // 裸工具名 = 整个工具放行
    const stars = (e.pattern.match(/\*/g) || []).length;
    if (stars === 0) {
      if (cmd === e.pattern) return raw;
    } else if (stars === 1 && e.pattern.endsWith("*")) {
      const prefix = e.pattern.slice(0, -1);
      if (prefix && cmd.startsWith(prefix)) return raw;
    }
    // 其余形态(中间通配 / 前导通配)= 不承认,继续找下一条
  }
  return null;
}

/** deny 侧的**宽松**匹配:`*` → `.*` 全串正则。宁可多报,不可漏报。 */
export function matchDeny(cmd, tool, denyList) {
  for (const raw of denyList) {
    const e = parsePermEntry(raw);
    if (!e || e.tool !== tool) continue;
    if (e.pattern === null) return raw;
    const re = new RegExp("^" + e.pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
    if (re.test(cmd)) return raw;
  }
  return null;
}
