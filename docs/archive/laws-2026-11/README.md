# 归档的旧示例规矩(2026-11)

这里的文件**不是现行规矩**。现行的示例规矩是根目录的 `AGENTS.md`(仓规矩)和 `docs/gate/AGENTS.md`(闸规矩)。

| 文件 | 原位置 |
|---|---|
| `constitution-2026-11-04.md` | 换结构之前根目录的 `AGENTS.md`(示例宪法) |
| `collab.md`、`reporting.md`、`production.md` | `docs/laws/`(三份示例法典,`git mv` 迁来,历史可用 `git log --follow` 追) |

留着它们的原因:一部分闸规则的 `law:` 字段仍指向 `constitution-2026-11-04.md`、`collab.md`、`reporting.md` 里的章节,自测会核这些指针能不能解析,所以文件得在场。这部分规则多数已经降为只记账,计划在回放确认后删除。

改这些规则时,以 `AGENTS.md` 与 `docs/gate/AGENTS.md` 为准,不以本目录为准。
