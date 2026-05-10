# 原始 PRD 参考索引

本目录保留 `eval-system-概述` 下的历史 PRD 与方案文档全文副本，用于追溯产品判断、指标来源和历史架构假设。重构实施时，以 `../重构方案梳理` 为准；本目录是参考资料，不是当前唯一规格。

## 文档索引

| 文件 | 参考价值 | 使用方式 |
| --- | --- | --- |
| `1-评测集构建.md` | 评测集、goodcase/badcase、baseline、抽样与验收 | 吸收 topic 片段、去重、sample batch 思路 |
| `2-基线构建与在线评测联动.md` | baseline 与在线评测联动 | 吸收到 Supabase baseline/online eval 表设计 |
| `3-评测集构建与在线评测实现路径（业务版）.md` | 业务语言里程碑 | 用于实施路线和验收叙事 |
| `4-五步质量闭环与工程落地.md` | 发现、证据、调优包、Agent、回放闭环 | 用于 remediation 与 validation 表设计 |
| `5-SEAR数据哲学与下一阶段架构.md` | 关系型质量信号仓库原则 | 吸收可追溯、证据与分离、gold set 原则 |
| `6-Scenario技能化评估框架.md` | Scenario Skill、指标分层、Judge 分工 | 作为可插拔 Scenario 扩展参考 |
| `AI-effect-clinic-PRD.md` | 早期产品 PRD 与指标全集 | 仅作历史参考，名称与技术栈已过时 |
| `Zeval · 业务介绍.md` | 对外叙事、产品定位 | 用于品牌与价值表达 |
| `Brainstorm.md` | 战略问答和场景思考 | 用于边界和非目标讨论 |
| `产品纪要与ToDo.md` | 会议纪要、阶段 TODO | 用于追溯历史决策 |
| `chatlog 评估维度.md` | 早期指标维度表 | 与 `指标变量表.csv` 合并参考 |
| `补充落地方案.md` | P0/P1/P2 缺口与验收 | 用于重构 backlog |

## 已确认的现行口径

- 场景：优先通用评估框架，不固化首场景。
- 后端：以 Supabase 为唯一正式后端。
- 历史文档：全文保留，但实施时按重构方案重新裁剪。

## 过时或冲突点

- `AI-effect-clinic-PRD.md` 中的 AffectBench 名称、早期部署与后端设想，不作为当前技术路线。
- 历史文档中对首场景存在不同判断，本轮不收敛到某个具体行业。
- 多套指标表并存，重构后以主客观指标 XLSX 与 metric registry 为准。
- 历史文档里的 local/file store、兼容适配器描述，不作为目标后端方案。
