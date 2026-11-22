# 发车脚本 `scripts/batch-run.mjs`

## 做什么

把一句话交出去,让一批活自己跑到关账。脚本按顺序做这几件事:开批 → 拉起无头执行会话 → 重跑开批时登记的检查验收 → 不过就用同一个会话回修(至多三轮)→ 过了就并回基分支、关账。任何一步判不了,就停下,生成交接文件并写明卡在哪。

它只把已有的件接起来:开批、验收、关账、交接用 `batch-goal`,外审作业读 `codex-run` 的作业台账,私仓名单读 `gate-install.json`。它不改这些件的判决。

只用于本地、可逆的批(核对分级 T0 / T1)。会动线上内容的批不要用它发车。

## 命令行

```
node --no-warnings scripts/batch-run.mjs
  --batch <批号> --instruction "<用户原话>"
  --cond "<条件>" [--check "<命令>" [--expect "<子串>" | --expect-re "<正则>"]] [--cond …]
  [--finish-line "<终点线>"]
  [--max-turns N] [--max-budget-usd M] [--cap-usd T] [--deadline-min D]
  [--model <名>] [--judge-model <名>] [--no-merge] [--push <远端名>] [--handoff-out <路径>]

node --no-warnings scripts/batch-run.mjs --status [<批号>]
node --no-warnings scripts/batch-run.mjs --self-test
```

- `--cond` / `--check` / `--expect` / `--expect-re` 的写法和 `batch-goal --arm` 一样,原样透传。至少要有一条 `--check`:验收的硬门只认可执行检查,没有检查就拒绝发车。
- 上限的缺省值:`--max-turns 80`、`--max-budget-usd 8`(每次拉起)、`--cap-usd 20`(整批累计,含回修和方向复核)、`--deadline-min 90`(整批墙钟)。
- `--judge-model` 缺省 `opus`;`--model` 不给就不传,用 claude 的缺省模型。
- `--no-merge`:关账但不并回基分支,工作树和分支都留着。
- `--push <远端>`:并回之后推基分支。只有远端地址的仓名在 `gate-install.json` 的 `privateRepos` 名单里才推;不在名单里就不推,结果里记一行「未推送」,照常关账。
- 要在仓的主 checkout 根目录发车,HEAD 要在一个分支上(这个分支就是基分支)。

## 流程

1. **发车前检查**。任何一条不过就退出 2,什么都不留:当前目录是主 checkout 的根(不是 linked worktree);HEAD 在分支上;批号只含字母、数字、`_`、`.`、`-`;有 `--check`;找得到 Git Bash 和 claude;工作树目录、分支、这个批号的运行状态都还不存在;没有别的发车在跑。
2. **建工作树**。`git worktree add <主树>/.claude/worktrees/batch-<批号> -b batch-run/<批号>`,从当前 HEAD 起。收尾闸只认 `.claude/worktrees/` 下的工作树批状态,所以位置是固定的。
3. **开批**。先生成执行会话号,在工作树里调 `batch-goal --arm`,带上指令、终点线、整批花费上限、截止时间和全部条件。子进程的 `CLAUDE_CODE_SESSION_ID` 设成执行会话号,批状态的武装者因此是执行会话。发车方自己的会话号(本进程环境里原有的那个)记成指令所在的会话。
4. **拉起执行会话**。`claude -p --output-format stream-json --verbose --permission-mode auto --max-turns N --max-budget-usd <本次上限> --session-id <会话号>`,工作目录是工作树,提示词走 stdin。提示词写着用户原话、逐条条件和检查命令、终点线、约束(只做本批范围内的事;不放宽条件;不开批、不结清、不推送、不合并、不切分支)和收尾要求(全部提交、登记成果与决定、最后一条消息逐条写 `条件N:达成` / `条件N:未达成:<理由>` / `条件N:不适用:<理由>`)。不用 `--dangerously-skip-permissions`,无人值守时的围栏是 auto 模式的权限分类器。
5. **分类**。按最后一条 `result` 事件分:退出 0、`is_error` 假、`subtype` 是 `success` ⇒ 跑完了,去验收;`error_max_turns` / `error_max_budget_usd`,或到整批截止时间被杀 ⇒ 到上限;`is_error` 真而 `subtype` 是 `success`,文字像额度提示 ⇒ 等额度;同样形状但文字不像 ⇒ 失败;没有 `result` 事件或别的形状 ⇒ 判不了。后四种都停,不回修。
6. **验收**。四项都看,收集齐了再判:
   1. 工作树干净:没有已跟踪文件的改动,也没有未跟踪、未忽略的新文件(`.claude/` 下的不算)。
   2. 硬门:在工作树里跑 `batch-goal --dry-check`。全过才算过。
   3. 逐条裁决:从执行会话最后一条消息里取。每条都要有,而且是「达成」或带理由的「不适用」。
   4. 外审作业:本批在工作树里发起过 `codex-run` 作业才看。每个作业等到终态(最长等到整批截止),只认结果件最后一个非空行:含「不用再审」算过,含「要改」算不过;失败、超时、读不到、不是这两种结论都算判不了。同一个 slug 只看最新的一个。脚本自己不发起外审。

   任何一项判不了 ⇒ 停。有不过项 ⇒ 回修。
7. **回修**。用同一个会话续:`claude -p --resume <会话号> …`,提示词列出不过项的原文(检查命令和输出尾部、缺哪条裁决、没提交的路径、外审结论行、结清被拒的原文),写明「回修第 k 轮,共 3 轮」。至多三轮。第二次验收不过时(发第 2 轮回修之前)先拉一次方向复核:`claude -p --agent _direction-judge`,输入只有用户原话、完成标准、现状(只写事实)、两次验收的不过项。它判「偏了」或「该停」就停,交接里附它的全文;判「在路上」就继续;拉不起来或读不出判定,记一行,照常回修。
8. **关账**。验收全过才做:
   1. 并回:主 checkout 还在基分支上 ⇒ `git merge --ff-only batch-run/<批号>`。基分支前进过、不能快进 ⇒ 在工作树里 `git rebase <基分支>` 一次,冲突就 `git rebase --abort` 并停;成功就重跑验收的第 1、2 项,过了再快进。主树有本地改动导致 git 拒绝快进 ⇒ 停(脚本不 stash、不 reset、不 checkout 主树的东西)。
   2. 推送(给了 `--push` 且没给 `--no-merge`):仓名在私仓名单里才推,推完 `git ls-remote` 回读,要等于本地基分支。
   3. 欠账探针:这次真的推了、主 checkout 又有 `scripts/verify-prod.mjs` 时,跑 `--debt-only`,没过就停。
   4. 结清:在工作树里 `batch-goal --clear --verdict "N=达成" …`。被拒(`BATCH-GOAL-CLEAR-REFUSED`)当成一次验收不过,还有轮次就回修,没有就停。
   5. 清理:并回过的,`git worktree remove`(不带 `--force`)再 `git branch -d`。失败只记一行。

## 什么时候停

| 原因(`reasonCode`) | 什么情况 |
|---|---|
| `cap-turns` / `cap-budget` | 一次拉起撞了轮数或花费上限 |
| `cap-usd` / `cap-deadline` | 整批累计花费到了 `--cap-usd`,或到了整批截止时间(到点时执行会话会被连子进程一起杀掉) |
| `quota` | 撞账户额度;等额度恢复再接着干 |
| `failed` / `unknown` | 执行会话报错,或结局判不了 |
| `accept-unknown` | 验收有一项判不了(检查跑不起来、外审作业失败或超时、结论行认不出) |
| `repair-exhausted` | 三轮回修后验收仍不过 |
| `judge-off` / `judge-stop` | 方向复核判「偏了」/「该停」 |
| `rebase-conflict` / `merge-refused` / `main-moved` / `merge-unknown` | 并回基分支走不通 |
| `push-failed` / `push-mismatch` / `probe-failed` | 推送失败、回读不一致、欠账探针没过 |
| `clear-unknown` / `arm-failed` | `batch-goal --clear` / `--arm` 出了拒清以外的错 |

停下时,脚本在工作树里跑 `batch-goal --handoff --out <路径>`,再往文件末尾追加一节「卡在哪(发车脚本写)」:停在哪一站、原因、每次拉起的分类与花费、最后一次验收的不过项、累计花费与上限、执行会话号、工作树和分支、怎么接着干。批不结清,工作树和分支都留着。接着干:进工作树,`claude --resume <会话号>`。

## 退出码与结果行

- 0:已关账;10:停下了(交接已写);2:拒绝发车(什么都没起);1:内部错误(尽量也写交接)。
- stdout 最后一行恒为 `BATCH_RUN_RESULT=<JSON>`。键:`batch`、`status`(`closed` / `stopped` / `refused` / `error`)、`reason`、`reasonCode`、`stage`、`rounds`(执行加回修的拉起次数,不含方向复核)、`acceptRounds`、`costUsd`、`sessionId`、`worktree`、`branch`、`handoff`、`ruler`(`--clear` 打出的主尺那一行)、`pushed`、`notes`。发车的会话只读这一行就够。进度信息都写 stderr。

## 落盘的文件

都在 `<主树>/.claude/.batch-run/` 下(已加进 `.gitignore`):

- `<批号>.json`:运行状态,原子写。记状态(`running` / `closed` / `stopped` / `error`)、本进程与当前子进程的进程号、会话号、工作树、分支、基分支与基点、上限、每次拉起的记录。`status: running` 且进程号还活着,就是锁:同时只跑一个发车。
- `<批号>-r<k>.log`:第 k 次拉起的 stdout / stderr;`<批号>-judge.log`:方向复核。
- `<批号>-handoff.md`:交接(`--handoff-out` 可改位置)。
- `runs.jsonl`:每次运行结束追加一行:时刻、批号、状态、原因、每次拉起(分类、轮数、花费、耗时)、验收次数、方向复核结果、累计花费、模型、会话号、主尺、总耗时。

`--status [<批号>]` 只读地打印这些。

## 已知限制

- 还没在真的 claude 上跑过整条线。自测用的是按剧本行事的假 claude(真 git 仓、真 `batch-goal`),证明的是这条线的控制流,不证明真会话在 auto 模式下能把活干完。
- `--permission-mode auto` 在 auto 模式用不了的环境里会退回会先问的模式,无头会话里没人回答,动作会被拒;这时执行会话多半以失败或判不了收场,脚本会停下,不会误关账。
- 花费怎么记:续接会话(`--resume`)时 CLI 报的 `total_cost_usd` 是这个会话的累计值,而 `--max-budget-usd` 按本次拉起单独比(2026-11-22 在 claude 2.1.327 上实测:同一会话续接四次,读数单调增;累计读数已超过上限值时续接照常跑完)。所以脚本对回修轮按「本次读数减上一次读数」记账。将来 CLI 要是改成按次报,读数比上一次小时脚本会整笔记;读数恰好一次比一次大就会少算,这时兜底的是每次拉起的 `--max-budget-usd`。花费上限本身是 CLI 每轮结束才比的估算,会超一点。
- 「额度提示」的认法是一组词(`usage limit`、`quota`、`额度` 等),撞额度时的确切文字只实测过一次。认不出时按「失败」停,同样不回修。
- 外审作业的判活只看作业台账的状态字段;worker 进程死了而台账还写着 `running` 时,脚本会一直等到整批截止再按判不了停。
- `--clear` 在并回(和推送)之后才跑。它要是被拒、回修轮次又用完了,基分支上已经有这一批的提交,批却没结清;交接里会写明「已并回基分支」。
- `batch-goal --clear` 结束时会在后台发起一次误报盲审,它在工作树里写 `clipboard/codex/fp-audit-last.log`。目标仓没有忽略 `clipboard/` 时,这个文件会让 `git worktree remove`(不带 `--force`)失败,工作树会留下来(只记一行,不影响关账)。
- 执行会话里的收尾闸照常生效。闸拦下会让会话多走几轮,算在轮数和花费上限里。
