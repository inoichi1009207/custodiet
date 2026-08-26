# Changelog

## 0.1.1 — 2026-08-26

新增**外部锚** `ledger-anchor`:三链账的前缀指纹定期快照到 agent 仓外,`verify` 比对。

它补的是文件内前向链在结构上防不了的那半,但**限定词要一起读:只覆盖「最后一次快照点之前」**。
`verify` 的判据是「当前文件长度 ≥ 快照时长度,且前 N 字节哈希一致」——所以:

- 锚点**之前**的改写 / 插行 / 删行 / 截断 ⇒ 必红
- 锚点**之后**新追加的那一段被整段砍掉、长度正好退回快照值 ⇒ **verify 返回 OK,检不出**

也就是说,「当天写的台账行、当天被整段尾删」这个形态,**外部锚与 `ledger-chain` 两件都不覆盖**
(后者本就不防完整尾删,见 README)。上一版这里只写「补上完整尾删」,漏了限定词,已更正。

诚实边界(以头注为准,此处只是摘要,且**不省略会削弱上一句的那条**):
① 同机同用户是**软边界**——锚落在 `~/.custodiet/anchor/`,能以你的身份跑命令的进程也能改它,
   锚自身无认证无链;它提高伪造成本,不是硬隔离。
② 快照间隙内(默认每日)的「写了又擦」检不出。
③ **最新锚点之后的后缀不受任何约束**——即上面那条。
④ 看门狗(锚龄 > 48h 告警)**只在有人跑 `verify` 时才响**;本仓**没有替你接唤醒面**,
   拷走后须自行接一个(否则就是「闸在仓里但不在跑」)。
⑤ `install-task` 目前**只实现了 Windows**(`schtasks`);macOS/Linux 需自己写 cron/launchd。

关于先例:形状参照 Certificate Transparency 的「日志外比对树头」——RFC 6962 §7.3 写明日志可
「presenting two different, conflicting views of the Merkle Tree at different times and/or to
different parties」(内部 Merkle 自洽挡不住),且该违例「is detected by global gossiping」。
出处 <https://www.rfc-editor.org/rfc/rfc6962>,2026-08-26 取页逐字核过。
⚠️ **但反类比要一起读**:CT 那套成立的承重前提是树头由**另一方**持有、跨信任域比对;
本件的锚在同机同用户——先例里唯一让它成立的属性,本件没有。故 CT 只作**形状**参照,
不作强度背书。要那个强度,得把树头收到异机/CI 上。

## 0.1.0 — 2026-08-26

首个公开暂存版。Stop 闸本体(hook-stop-closure,`.claude/settings.json` 单点接线)、
引擎(结构化 ctx / 声明式规则 / 变异验收台)、台账完整性链
(ledger-chain:hash 链 + SIGN-CHECK 呈签尾标)、批级完成条件(batch-goal)、
建闸作业本、示例宪法、中英双 README。

自带的诚实声明:担保边界句以各件头注为准;战报数字为作者自述;
「未观测到同类」是观测陈述,不是不存在证明。
