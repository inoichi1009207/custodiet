// eslint.config.mjs —— **只为一件事**:抓 `X is not defined` 这类运行期引用错误
//
// 立此文件的理由(2026-08-20 实撞):
//   `gate-rules.mjs` 的 `touched()` 调用 `bashWriteTargets`,而 import 行里没这个名字。
//   后果:引擎的 RULE_I/RULE_J 一碰到 Bash 写路径就抛 `is not defined`;
//   而我同日刚把「阻断项抛错保持阻断」改对 ⇒ **崩溃以阻断的形式生效**,成了活的误拦。
//   在全语料上它伪装成「4 条未指名分歧」、方向一致(新有旧无)——
//   我差点把它们当成刻意分歧登记进白名单。
//
//   `node --check` 抓不到:它只查**语法**,而这是**运行期**的引用错误。
//   自测也抓不到:那几条路径要真实的 Bash 写命令才走得到,夹具里没有。
//   抓它的是 eslint 的 `no-undef` —— 而 eslint 我 2026-08-20 装了、**从没配过也没跑过**。
//
// 刻意**只开三条规则**:这不是代码风格检查,是一道判据闸。
//   开全套会产出几百条风格噪声,而噪声会让人不看输出——那等于没有闸。
// 失效条件:①若连续 20 次跑零命中 ⇒ 它没在防任何东西,复议;
//   ②redos-detector 已并入本文件(2026-08-25,批 102)——原注释指向的 `regex:lint`
//     **从未存在**:插件 2026-08-23 装进 package.json 后零配置零运行,用户一句
//     「redos-detector 真的在跑了吗」逮到。又一例「装了≠在跑」:锁文件会骗人,
//     只有 config 的 rules 面与命中输出才是「在跑」的证据。

import js from "@eslint/js";
import redos from "eslint-plugin-redos-detector";

export default [
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        globalThis: "readonly",
        // ⚠️ 这份清单**手写就会漏**——首跑报了两条 `clearTimeout is not defined`,
        //   而那是 Node 内建全局,是我漏填不是被测文件的 bug。
        //   把误报当战果是这类工具最常见的用法错误,故此处刻意记一笔。
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
    rules: {
      // 本文件存在的全部理由
      "no-undef": "error",
      // 同族:用了却没定义的反面——定义了却没用,常常是「改了一半」的痕迹
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      // 「写了却永远走不到」——与「判据从不生效」是同一类失败
      "no-unreachable": "error",
      // ⚠️ **第四条,2026-08-20 补,而它本该第一天就开**。
      //   当日实撞:我用 python heredoc 写 `\b`,而 python 里 `\b` 是**退格符**
      //   ⇒ 判据变成 `/…--(task|poll|resume)\x08/`,**永不匹配**
      //   ⇒ P 的跨模型通道恒为 0,连撞多轮、查了三轮才用 `cat -A` 逮到。
      //   实测对照(仓内探针,含真退格符):
      //     只开上面三条 ⇒ **零输出**;开本条 ⇒ `Unexpected control character(s): \x08`。
      //   **解药早就装在这台机器上,是我把它关着的**——装 eslint 那天我只挑了
      //   「刚好能解决眼前那个 bug」的三条,从没问过这个工具还能抓什么。
      //   与纪律 32 那次同形:**按「我要写的东西」选工具,不按「这类问题有哪些」选**。
      "no-control-regex": "error",
      // ⑤ ReDoS 静态扫(2026-08-25 接线):正则字面量的灾难性回溯在**装载期**逮,
      //   替代「跑 43 秒才知道」的动态计时——SCAN_CAP 那次事故的事前面。
      //   error 档:一条会爆的正则进了判据面,比风格问题重得多。
      "redos-detector/no-unsafe-regex": ["error", { maxScore: 25 }],
    },
    plugins: { "redos-detector": redos },
  },
];
