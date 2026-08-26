# custodiet

> **Quis custodiet ipsos custodes?——谁来看守看守者?**\
> 给 Claude Code 编码代理装的机器问责闸:逮住那些**从未发生过的「已完成」**。
> 而且,闸自己也被闸。
>
> [English version →](README.en.md)

**最快的用法:把本仓直接丢给你的 agent 读。**「读完 custodiet,给我们仓也建一套」——
作业本([`docs/playbook.md`](docs/playbook.md))本来就是写给 agent 照抄的,每个建造步带产物形状、
可执行检查点和当初踩坑的事故记录;人只需要做一件事:签下你自己的验收规则。

<p>
<img src="assets/catch-saying-not-doing.jpg" alt="闸逮住 agent 在描述工作而不是做工作" width="640">
</p>

## 为什么需要它

编码代理会产出 **false success**:环境状态根本不支持,它照样断言「任务完成」。学术侧已量化:AppWorld 自评编码代理轨迹中带显式完成声明的失败里 **75.8%** 属此类;而用 LLM 当裁判判不出来——五种裁判五种提示词,tau2-bench 上 AUROC 不超过 **0.65**,轻量**确定性检测器**反而达到 0.83–0.95,还快 3300 倍([arXiv 2606.09863](https://arxiv.org/abs/2606.09863),论文结论原句:生产监控应把轻量、领域校准的检测器当**分诊信号**(triage signals),而非拿 LLM 裁判当 false success 的主监控)。

上游呢?「agent 忽略失败测试、伪造成功报告」的 issue 被官方标为 **closed as not planned**([anthropics/claude-code#2969](https://github.com/anthropics/claude-code/issues/2969))。平台不修,闸只能装在你这边。

## 不是提示词,是判据

| 路线 | 执法方式 | 什么时候失效 |
|---|---|---|
| CLAUDE.md 写规矩 | 无——模型可以无视 | 迟早 |
| 让另一个 LLM 审 | 又一个模型的意见 | 这类任务上裁判 AUROC ≤ 0.65 |
| **本仓** | **对工具调用记录跑确定性谓词** | 只在各规则明写的天花板处 |

引擎的 23 条规则读的是**结构化上下文**:只取 assistant 文本块与 `tool_use` **入参**——工具**输出**进不了它们的证据窗,所以「读到一个提到 `git commit` 的文件」不可能被算成「提交过」(这个攻击形态本身就是一条回归用例)。诚实声明:仅存两条未迁入引擎的内建规则(A 委派闭环、R 完成时陈述)仍扫含工具输出的全文,这条天花板登记在它们的头注里——别信我们没写的担保。

## 它逮什么(25 条规则选摘:23 条引擎 + 2 条内建;以 `gate:self-test` 输出为准,手写计数会漂)

- **B / R——承诺 vs 行动**:「我这就去改 X」/「已修 X」而本轮动作面上没有 X ⇒ 拦。将来时的空头支票与完成时的伪造记录,分开两条规则。
- **A / U——委派必须闭环**:发起了后台任务再没取回读过,那是欠账不是进度。
- **K / K0——批级完成条件**:开工先立机器可核的验收条件(`batch-goal --arm`);没逐条裁决就提交,拦。
- **M——写了必须回读**:`node -e`/`sed -i`/重定向失败时静默成功,只有真回读(Read/Grep/diff 指向同一路径)算数。
- **I——造之前先搜**:新建工具/脚本而没有「扫过现成实现」(本地在册面**和**联网)的动作痕迹 ⇒ 拦。
- **P——承重提交欠三道独立复核**:跨模型审、只读子代理、外部先例——只认工具动作,**说**自己跑过一次都不算。
- **E0/E1/E2——因果断言要么带机械判据要么过独立复核**,光说「根因是 X」出不了门。

完整巡览与建造顺序:[`docs/playbook.md`](docs/playbook.md)(实战蒸馏的建闸作业本)。

## 闸自己也被闸

这是本次调研里**未观测到**同类的部分(是「未观测到」,不是「不存在」):

- **规则要过变异验收**:每条规则须自带 ≥2 个「拧断判据」的变异,且夹具能证明逮得住(`gate-migrate-check.mjs`)。「用例通过」≠「用例有鉴别力」——这套验收上线前,我们量过 97 个变异里 40 个在全绿套件下存活。
- **装载期不变量**:阻断规则必须引一条人签过的法条锚点(仓内附示例宪法 `AGENTS.md`)、必须带正反例、且在**生产 hook 里**跑校验,不只在 CI。
- **误报与漏报台账**:每次报警自动进分母台账;认领的误报带理由入账;报表永远打印 `RECALL=UNKNOWN`——没人抱怨不等于没有漏报。
- **债务带失效期**:每条已知缺陷是台账里带批次失效期的一行,到期自动回活(`batch-goal --arm` 的到期腿)。*「不写失效期的例外,是无声的政策变更。」* 机制随仓;我们自己的债表本体按取舍留在源项目,你的债表从第一行开始记你自己的。
- **台账自身有完整性链**:三份台账(报警分母/误报账/批目标史)加行级 hash 链,改写/插行/删中间行必红(`ledger-chain.mjs`;定性=完整性告警,担保边界见其头注——不防蓄意与完整尾删,我们不说做不到的话)。
  完整尾删那半由 0.1.1 的**外部锚** `ledger-anchor.mjs` 补,**但只补到「最后一次快照点之前」**:
  快照之后新追加的一段若被整段砍掉,两件都检不出。且外部锚**本仓未接唤醒面**,拷走后须自己接
  (`install-task` 目前只实现 Windows)。详见 CHANGELOG 的 0.1.1 段与该文件头注。
- **Fail-closed**:规则拿不到必需输入通道 ⇒ 报 UNKNOWN 并拦。被静默跳过的闸,比没有闸更坏。

<p>
<img src="assets/same-shape-errors.jpg" alt="今天犯的每一个错都是同一形状的第 N 次" width="640">
<img src="assets/catch-lost-delegation.jpg" alt="等一份从未取回过的复核回件——被逮住" width="640">
</p>

## 快速上手

```bash
# 1. 把 scripts/ 与 .claude/settings.json 拷进你的项目
# 2. 那份 settings.json 就是全部接线:一个 Stop hook
# 3. 体检
npm run gate:self-test     # 引擎+输入面+零件,全部夹具
npm run gate:accept        # 外加每规则正反例 + 变异验收
# 4. 用批级完成条件干活
node --no-warnings scripts/batch-goal.mjs --arm 001 --cond "什么算完成,写成可核的"
# ……干活……
# 收尾:逐条写「条件N: 达成/未达成/不适用」,然后
node --no-warnings scripts/batch-goal.mjs --clear
```

阻断规则各带逃生口(`STOP_CLOSURE_BLOCK_<id>=0`),且逃生口与阻断表之间有对账自测——一个打不开的逃生口是我们会测出来的 bug。唯一例外:P 项(三通道复核义务)**刻意无逃生口**,这是签署过的设计,不是疏漏。

## 与邻居的关系

- [guardrails-ai](https://github.com/guardrails-ai/guardrails) / [NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) 校验**模型说出来的内容**;我们审计**它说做过的事有没有真的发生**。内容闸 vs 言行一致闸。
- [tdd-guard](https://github.com/nizos/tdd-guard) / [probity](https://github.com/nizos/probity) 闸**每次写入**的流程合规(probity 也读 transcript);我们在 Stop 时刻闸**整轮的言行**。互补,可以同时跑。
- Claude Code 官方自带 `/goal`(目标追踪)——但它是**内建 slash command,模型自己调不了,只有用户能敲**(2026-08-19 实测)。这意味着官方目标机制无法进入 agent 的自我闭环:agent 没法自己立验收条件;而它的收尾评估走的是 LLM 裁判(session 级 prompt hook)——正是上文 AUROC ≤0.65 的那类,不是机器判据。`batch-goal --arm/--clear` 就是为此存在的仓内等价物——立条件是 agent 的开工动作,对照是 Stop 闸的机器动作,人只在想看的时候看。
- 按本次调研(2026-08-25),「承诺-行动比对 + 变异测试验收 + 到期债台账」的组合在开源里**未观测到**同类——这是观测陈述,不是不存在证明。

## FAQ

**误报怎么办?** 进台账:认领误报带理由,对着自动报警分母量占比(上次量是 9.7%);好几条规则就是靠这个环收窄的——台账是调音器,不是道歉信。

**开销多大?** 零依赖。21k 条 transcript 实测:每次 Stop 330–600ms,其中读 transcript 约 40ms(耗时打点进心跳台账——性能预算自己也是一条被跟踪的债)。

**会死循环吗?** hook 查 `stop_hook_active`,引擎记自己的连续阻断计数并带泄压阀(`STOP_CLOSURE_BLOCK_CAP`),压力大时降级为提示——且降级会被记成降级,永不伪装成通过。

**怎么加一条自己的规则?** 最短路径:在 `scripts/lib/gate-rules.mjs` 里照抄任意一条的**五件套**——
`detect`(纯函数,只读结构化 ctx,永不自读磁盘)、`law`(指向你自己签过的规范条款锚点)、
`blocking`、正反例 `cases`、≥2 个 `mutations`(写出「把自己判据拧断」的方式)——加进文件末尾的
`RULES` 数组,跑 `npm run gate:accept`。两道闸挡偷工减料:**装载期不变量**拒收没有法源锚点、
没有正反例的规则;**验收台**拒收变异杀不死的用例——想上线,先证明你的用例有鉴别力。完整教程在
[`docs/playbook.md`](docs/playbook.md) 第 3–4 步,每一步都附着当初踩过的坑。

**战报数字审计过吗?** 是作者自己的台账(git log、报警台账、债务表)。作业本里明确标注「作者自述」,请按读事后复盘的方式读。

## License

MIT
