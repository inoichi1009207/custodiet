# custodiet

> **Quis custodiet ipsos custodes?——谁来看守看守者?**
>
> [English version →](README.en.md)

**custodiet** 是给 Claude Code 的「收尾闸 + 宪法法典制」治理系统:agent 每次说「做完了」时,Stop hook 对本轮的工具调用记录跑确定性判据,说过的事没在记录里发生就拦;每条阻断规则都要指向一条人签过的法条。
**lanes** 是它的配套界面:把闸的提示、工具调用、改过的文件从输出框里分出去,各进一道。

本仓同时是一个 Claude Code 插件市场(`.claude-plugin/marketplace.json`)。

| 组件 | 当前形态 | 怎么装 |
|---|---|---|
| custodiet | 闸脚本 + 示例宪法/法典 + 红队 agent + 拷贝模式安装器。**还不是插件** | `node scripts/custodiet-init.mjs --target <仓> --mode copy` |
| lanes | Claude Code 插件(mod:带 hooks 模块),在 `plugins/lanes/` | `/plugin install lanes --marketplace inoichi1009207/custodiet` |

## 安装

### custodiet(拷贝模式)

前提:node ≥ 20;目标是一个 **git 仓的根目录**(脚本不会替你 `git init`)。

```bash
git clone https://github.com/inoichi1009207/custodiet
node custodiet/scripts/custodiet-init.mjs --target <你的仓根> --mode copy
```

它做的事:

- 把闸件(`scripts/hook-stop-closure.mjs`、`scripts/batch-goal.mjs`、`scripts/lib/` 下的引擎件)、示例宪法 `AGENTS.md`、示例法典 `docs/laws/collab.md` 与 `docs/laws/reporting.md`、`docs/noun-diary.md`、红队 agent `.claude/agents/_gate-bypass-hunter.md` 拷进目标仓,并生成 `CLAUDE.md`(内容为 `@AGENTS.md`)。
- 把 `Stop` 与 `SubagentStop` 两个 hook 合并进目标的 `.claude/settings.json`(按命令去重)。
- 把闸的运行时台账路径追加进目标的 `.gitignore`。
- **已存在的文件一律不覆盖**:内容不同时写旁件 `<名>.custodiet<扩展名>`,stdout 末行的 JSON 清单逐个报出。不提交、不联网、不碰 `~/.claude/`。

装完以后:

1. 在目标仓里自检:`node --no-warnings scripts/hook-stop-closure.mjs --self-test`。
   已知:有 2 条 I 类用例读的是目标仓**真实的 git 历史**,装闸件还没提交、或装闸那次提交正好是 HEAD 时会红;之后再有一次提交即转绿。
2. **装完新开会话再提交。** 新写入的红队 agent 能否在同一会话里被调起没有实测;而装闸的提交会触发 P 项,P 在闸引擎文件上只认这个 agent。新开会话可以绕开这个没测过的情形。

目前的限制:

- 文本类规则的判据是中文句式,目前只适用于用中文协作的仓。英文仓里这些规则不会误拦,但也不会响。
- 插件安装方式还没做:`/plugin install custodiet` 现在**装不了**,`--mode plugin` 会以退出码 5 拒绝。
- 不随安装器拷出的开发件:`scripts/coverage-check.mjs`、`scripts/gate-migrate-check.mjs`、`scripts/lib/ledger-anchor.mjs`。它们只在本仓里能用。

### lanes(插件市场)

在 Claude Code 会话里(需要 Claude Code v2.1.275 或更高):

```text
/plugin install lanes --marketplace inoichi1009207/custodiet
```

在终端里(需要 v2.1.292 或更高):

```bash
claude plugin install lanes --marketplace inoichi1009207/custodiet
```

也可以分两步:先 `/plugin marketplace add inoichi1009207/custodiet`,再 `/plugin install lanes@custodiet`。
第三方市场默认不自动更新,更新用 `claude plugin update lanes@custodiet`。
lanes 的界面文字目前是中文;本仓在 Claude Code 2.1.295 上跑过它的测试(`claude plugin test plugins/lanes`)。

## 能力与命令

### custodiet

| 能力 | 一句话 | 命令 |
|---|---|---|
| 收尾闸 | Stop 时对本轮的工具调用记录跑 26 条引擎规则 + 2 条内建规则,命中阻断规则就不让本轮结束 | `node --no-warnings scripts/hook-stop-closure.mjs --self-test` |
| 批级完成条件 | 开工先立可核的验收条件,条件可带机器判据;`--clear` 时自己跑判据,不过即拒清 | `node --no-warnings scripts/batch-goal.mjs --arm 001 --cond "成片已出" --check "ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4" --expect-re "^218\."` |
| 规则验收 | 每条规则的正反例 + 变异验收,变异杀不死的用例不许上线(在本仓里跑) | `npm run gate:accept` |
| 台账完整性链 | 报警分母、误报账、批目标史三份台账带行级 hash 链,改写/插行/删中间行会红 | `node --no-warnings scripts/lib/ledger-chain.mjs verify <file.jsonl>` |
| 外部锚(本仓内) | 把台账的前缀指纹快照到 `~/.custodiet/`,锚点之前的改写/截断会红;担保边界见下文 | `node scripts/lib/ledger-anchor.mjs snapshot` |
| 逃生口 | 每条阻断规则可单独关(P 项刻意没有) | `STOP_CLOSURE_BLOCK_<id>=0` |
| 红队 agent | 改了闸引擎文件后,用它找「怎样不被这条规则拦住」,每条绕法带最小夹具 | 会话里调用子代理 `_gate-bypass-hunter` |

批级完成条件的次序:武装 → 干活 → 逐条写「条件N: 达成/未达成/不适用」→ **提交** → 最后才 `node --no-warnings scripts/batch-goal.mjs --clear`。先 `--clear` 再提交会被 K0 拦。

### lanes

| 能力 | 一句话 | 命令 |
|---|---|---|
| 面板 | 本轮的闸提示、改过的文件、工具调用各一道,子代理的另记一桶;再敲一次关闭 | `/lanes` |
| 汇总行 | 本轮有动静时,输入框上方一行:闸几次(阻断几次)· 改文件几个 · 工具几次 · 子代理几个 | 无需命令 |
| 输出框只留正文 | 默认不在对话里画工具调用行,闸的反馈缩成一行灰字;要看原样就切回 | `/lanes-show` |
| 闸转投(实验,默认关) | 闸的拦截与提示改由插件转给模型,输出框只留一行;连撞 5 轮交回引擎。与 custodiet 收尾闸同用是否安全**未验证** | `/lanes-relay` |

## 为什么需要它

编码代理会产出 **false success**:环境状态根本不支持,它照样断言「任务完成」。学术侧已量化:AppWorld 自评编码代理轨迹中带显式完成声明的失败里 **75.8%** 属此类;用 LLM 当裁判判不出来——五种裁判五种提示词,tau2-bench 上 AUROC 不超过 **0.65**,轻量**确定性检测器**反而达到 0.83–0.95,还快 3300 倍([arXiv 2606.09863](https://arxiv.org/abs/2606.09863),论文结论原句:生产监控应把轻量、领域校准的检测器当**分诊信号**(triage signals),而非拿 LLM 裁判当 false success 的主监控)。

上游:「agent 忽略失败测试、伪造成功报告」的 issue 被官方标为 **closed as not planned**([anthropics/claude-code#2969](https://github.com/anthropics/claude-code/issues/2969))。

<p>
<img src="assets/catch-saying-not-doing.jpg" alt="闸逮住 agent 在描述工作而不是做工作" width="640">
</p>

## 不是提示词,是判据

| 路线 | 执法方式 | 什么时候失效 |
|---|---|---|
| CLAUDE.md 写规矩 | 无——模型可以无视 | 迟早 |
| 让另一个 LLM 审 | 又一个模型的意见 | 这类任务上裁判 AUROC ≤ 0.65 |
| **本仓** | **对工具调用记录跑确定性谓词** | 只在各规则明写的天花板处 |

引擎的 26 条规则读的是**结构化上下文**:只取 assistant 文本块与 `tool_use` **入参**——工具**输出**进不了它们的证据窗,所以「读到一个提到 `git commit` 的文件」不可能被算成「提交过」(这个攻击形态本身就是一条回归用例)。仅存两条未迁入引擎的内建规则(A 委派闭环、R 完成时陈述)仍扫含工具输出的全文,这条天花板登记在它们的头注里。

## 宪法法典制

- 每条规则都带一个 `law:` 锚点,指回一份人签过的规范条款(如 J 项 → `AGENTS.md#承重规则的载体门槛`);引擎在装载期与自测里核锚点可解析。没有法源的规则是无主判据,谁都可以删。
- 示例宪法 `AGENTS.md` 放每会话默认动作、决策边界、永久红线这类短句,并标明它是哪条规则的法源;细则住示例法典 `docs/laws/collab.md`、`docs/laws/reporting.md`。
- 安装器拷过去的这三份是**示例**:你的仓要换成你自己签过的条款,锚点跟着改。

## 它逮什么(28 条规则选摘:26 条引擎 + 2 条内建;以 `gate:accept` 输出为准,手写计数会漂)

- **B / R——承诺 vs 行动**:「我这就去改 X」/「已修 X」而本轮动作面上没有 X ⇒ 拦。将来时的承诺与完成时的陈述分开两条规则。
- **A / U——委派必须闭环**:发起了后台任务再没取回读过,那是欠账不是进度。
- **K / K0——批级完成条件**:开工先立机器可核的验收条件(`batch-goal --arm`);没逐条裁决就提交,拦。
- **M——写了必须回读**:`node -e`/`sed -i`/重定向失败时静默成功,只有真回读(Read/Grep/diff 指向同一路径)算数。
- **I——造之前先搜**:新建工具/脚本而没有「扫过现成实现」(本地在册面**和**联网)的动作痕迹 ⇒ 拦。
- **P——承重提交欠三道独立复核**:跨模型审、只读子代理、外部先例——只认工具动作,**说**自己跑过一次都不算。提交触及闸引擎文件时,独立视角那一道只认随包的红队 agent `_gate-bypass-hunter`。
- **E0/E1/E2——因果断言要么带机械判据要么过独立复核**,光说「根因是 X」出不了门。

0.4.2 起不再带 CW(收尾时点复查并发写会话)——并发写改由 git worktree/分支隔离,见 [CHANGELOG](CHANGELOG.md)。

完整巡览与建造顺序:[`docs/playbook.md`](docs/playbook.md)(建闸作业本,写给 agent 照着做:每个建造步带产物形状、可执行检查点和当初的事故记录)。

## 闸自己也被闸

以下组合在本次调研里**未观测到**同类(是「未观测到」,不是「不存在」):

- **规则要过变异验收**:每条规则须自带 ≥2 个「拧断判据」的变异,且夹具能证明逮得住(`gate-migrate-check.mjs`)。这套验收上线前,我们量过 97 个变异里 40 个在全绿套件下存活。
- **装载期不变量**:阻断规则必须引一条人签过的法条锚点、必须带正反例,且在**生产 hook 里**跑校验,不只在 CI。
- **误报与漏报台账**:每次报警自动进分母台账;认领的误报带理由入账;报表永远打印 `RECALL=UNKNOWN`——没人抱怨不等于没有漏报。
- **债务带失效期**:每条已知缺陷是台账里带批次失效期的一行,到期自动回活(`batch-goal --arm` 的到期腿)。机制随仓;我们自己的债表留在源项目。
- **台账完整性链**:见上表。定性是完整性告警,担保边界见 `ledger-chain.mjs` 头注——不防蓄意改写与完整尾删。
- **外部锚**(`ledger-anchor.mjs`,`snapshot | verify | install-task`)。**担保边界**:
  「外部」只到**同机同用户的家目录**(`~/.custodiet/`)——不是另一台机器、不是另一个信任域;
  能以你的身份跑命令的进程同样能改锚,锚自身无认证无链。这是**软边界**,提高伪造成本,不是隔离。
  它只覆盖到**最后一次快照点之前**,且以「锚文件未被同身份进程改写 + `verify` 确实被运行」为前提。
  锚点之后追加的内容被删、而当前长度仍 ≥ 快照长度 ⇒ 锚与链**都检不出**。
  本仓**没有替你接唤醒面**,`install-task` 目前只实现 Windows(`schtasks`)。详见 CHANGELOG 0.1.1 段与该文件头注。
- **Fail-closed**:规则拿不到必需输入通道 ⇒ 报 UNKNOWN 并拦。
- **逃生口有对账**:逃生口与阻断表之间有自测,一个打不开的逃生口会被测出来。P 项刻意无逃生口,这是签署过的设计。

<p>
<img src="assets/same-shape-errors.jpg" alt="今天犯的每一个错都是同一形状的第 N 次" width="640">
<img src="assets/catch-lost-delegation.jpg" alt="等一份从未取回过的复核回件——被逮住" width="640">
</p>

## 与邻居的关系

- [guardrails-ai](https://github.com/guardrails-ai/guardrails) / [NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) 校验**模型说出来的内容**;我们审计**它说做过的事有没有真的发生**。
- [tdd-guard](https://github.com/nizos/tdd-guard) / [probity](https://github.com/nizos/probity) 闸**每次写入**的流程合规(probity 也读 transcript);我们在 Stop 时刻闸**整轮的言行**。可以同时跑。
- Claude Code 官方自带 `/goal`(目标追踪)——它是**内建 slash command,模型自己调不了,只有用户能敲**(2026-08-19 实测),收尾评估走 LLM 裁判(session 级 prompt hook)。`batch-goal --arm/--clear` 是仓内等价物:立条件是 agent 的开工动作,对照是 Stop 闸的机器动作。
- [unlazy](https://github.com/Leonxlnx/unlazy)(2026-09 调研,经跨模型逐句取页复核)同样用 Stop hook 当墙,治的是**用力不足**(Depth Tree 按请求深度逐层拆任务;gates 文件用 `CHECK:` 命令 + `EXPECT:` 词元验收);我们治**宣称不实**。它有两处值得学:「连续 6 次无进展阻断即放行」的防死循环阀,和 `ABANDON: <id> <non-empty reason>` 的失败式交接——本仓的等价物是连撞上限自动降级与「⏸ 需要你确认 + 三类理由」。
- 按本次调研(2026-08-25,2026-09-02 复核),「承诺-行动比对 + 变异测试验收 + 到期债台账」的组合在开源里**未观测到**同类——这是观测陈述,不是不存在证明。

## FAQ

**误报怎么办?** 进台账:认领误报带理由,对着自动报警分母量占比(上次量是 9.7%);好几条规则就是靠这个环收窄的。

**开销多大?** 零依赖。21k 条 transcript 实测:每次 Stop 330–600ms,其中读 transcript 约 40ms(耗时打点进心跳台账)。

**会死循环吗?** hook 查 `stop_hook_active`,引擎记自己的连续阻断计数并带泄压阀(`STOP_CLOSURE_BLOCK_CAP`),压力大时降级为提示——降级会被记成降级,不会伪装成通过。

**怎么加一条自己的规则?** 在 `scripts/lib/gate-rules.mjs` 里照抄任意一条的**五件套**——
`detect`(纯函数,只读结构化 ctx,不自读磁盘)、`law`(指向你自己签过的规范条款锚点)、
`blocking`、正反例 `cases`、≥2 个 `mutations`——加进文件末尾的 `RULES` 数组,在本仓里跑 `npm run gate:accept`。
装载期不变量拒收没有法源锚点、没有正反例的规则;验收台拒收变异杀不死的用例。改完再用 `_gate-bypass-hunter` 红队一遍。
完整教程在 [`docs/playbook.md`](docs/playbook.md) 第 3–4 步。

**战报数字审计过吗?** 是作者自己的台账(git log、报警台账、债务表)。作业本里明确标注「作者自述」,请按读事后复盘的方式读。

## License

MIT
