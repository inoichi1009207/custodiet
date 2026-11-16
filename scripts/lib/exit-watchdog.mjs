// exit-watchdog.mjs — CDP 类入口脚本的「一定会退出」兜底(038 批,2026-08-09)。
//
// 立此模块的动机(复盘 3.3 + 本批 codex 只读审计的改判):
//   底座 scripts/cdp.mjs 是**库**,库里 process.exit 会连带杀掉调用方 ⇒ 加固必须落**入口脚本**。
//   而入口脚本历史上收尾用的是 `process.exitCode = n`——它只是**声明**退出码,
//   事件循环里只要还有被引用的句柄(websocket / 子进程),进程就**不会退**。
//   更要命的是 cdp.close() 里 `await send("Browser.close")` **无超时**:CDP 请求若永不回应,
//   执行根本到不了后面的 ws.close() 与杀进程兜底。⇒ 单靠显式 exit 不够,必须再加一道总闸。
//
// **兜底值不许拍脑袋**:复盘里的 60s 是黑客松小探针的合适值。读者红线工装实测基线
//   **306 秒**(2026-08-09 现场量,example.org),60s 会把绿批打成假红。
//   故默认取「基线 ×3 向上取整到分钟」,并允许环境变量覆盖。
//   新写的小探针脚本仍按 60s 起步——那是它们的量级,不是这里的。
//
// 唯一实现:改语义只改这一个文件。

/**
 * 装一道总闸,并返回一个「按退出码显式退出」的收尾函数。
 *
 * @param {object} o
 * @param {number} o.ms            兜底毫秒数(到点即以非零码退出)
 * @param {string} [o.envVar]      允许覆盖 ms 的环境变量名
 * @param {() => string} [o.stage] 回一句「现在挂在哪一步」,进兜底文案
 * @param {number} [o.timeoutCode] 兜底触发时的退出码,缺省 2(工装故障)
 * @returns {{ finish: (code?: number) => never, cancel: () => void, ms: number }}
 */
export function installExitWatchdog({ ms, envVar, stage, timeoutCode = 2 }) {
  const override = envVar && process.env[envVar] ? Number(process.env[envVar]) : NaN;
  const limit = Number.isFinite(override) && override > 0 ? override : ms;

  // 刻意**不** unref():兜底闸必须自己把进程钉住,否则它连触发的机会都没有。
  const timer = setTimeout(() => {
    const where = (() => {
      try {
        return stage ? stage() : "unknown";
      } catch {
        return "unknown";
      }
    })();
    console.error(
      `WATCHDOG 兜底超时 ${limit}ms —— 挂在阶段:${where}\n` +
        `  这不是断言红,是工装没能自己退出(见 scripts/lib/exit-watchdog.mjs 头注)。` +
        (envVar ? `\n  需要更长时限时设 ${envVar}=<毫秒>。` : ""),
    );
    process.exit(timeoutCode);
  }, limit);

  return {
    ms: limit,
    cancel: () => clearTimeout(timer),
    /** 显式退出:清闸 + process.exit(code)。绝不用 process.exitCode 收尾。 */
    finish: (code = 0) => {
      clearTimeout(timer);
      process.exit(code);
    },
  };
}
