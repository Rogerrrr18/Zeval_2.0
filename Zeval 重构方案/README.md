# Zeval 重构方案

本目录是 Zeval 项目的重构知识库。任何人或任何 Agent 在不阅读源码的前提下，只通过本目录就能理解项目背景、当前能力、重构口径与目标态。

## 子目录索引

| 目录 | 用途 | 读者 |
| --- | --- | --- |
| [`高可读文档/`](./高可读文档/) | 给人看的可视化导览：项目导览、指标 DAG | 新人、PM、设计、决策方 |
| [`重构方案梳理/`](./重构方案梳理/) | 重构 PRD：架构、指标、数据流、后端、API、LLM、前端、测试、迁移、路线 | 工程师、Agent 实施 |
| [`指标与DAG/`](./指标与DAG/) | 主客观指标依赖 XLSX 与 DAG Markdown | 工程师、算法、PM |
| [`可复用组件/`](./可复用组件/) | 环境模板、Supabase schema 草案、API CRUD 映射 | 工程师、运维 |
| [`原始prd参考/`](./原始prd参考/) | 历史 PRD 全文归档 + 索引 | 决策追溯 |

## 推荐阅读路径

### 新人入门（30 分钟）

1. 用浏览器打开 [`高可读文档/项目导览.html`](./高可读文档/项目导览.html)。
2. 用浏览器打开 [`高可读文档/指标计算DAG.html`](./高可读文档/指标计算DAG.html)，按层切换查看 LLM 介入点。

### 工程师 / Agent 实施（按顺序）

1. [`重构方案梳理/README.md`](./重构方案梳理/README.md) — 全局口径与文档索引。
2. [`重构方案梳理/1-项目架构.md`](./重构方案梳理/1-项目架构.md) — 模块边界与保留/替换清单。
3. [`重构方案梳理/4-数据流转.md`](./重构方案梳理/4-数据流转.md) — 端到端 DAG 与时序。
4. [`重构方案梳理/2-主客观指标说明.md`](./重构方案梳理/2-主客观指标说明.md) + [`3-隐式推断.md`](./重构方案梳理/3-隐式推断.md) — 指标体系。
5. [`重构方案梳理/5-后端方案-Supabase.md`](./重构方案梳理/5-后端方案-Supabase.md) + [`可复用组件/supabase-target-schema.sql`](./可复用组件/supabase-target-schema.sql) — 目标表结构。
6. [`重构方案梳理/7-API契约.md`](./重构方案梳理/7-API契约.md) + [`8-LLM调用与降级.md`](./重构方案梳理/8-LLM调用与降级.md) — 接口与模型契约。
7. [`重构方案梳理/9-数据迁移与历史产物处理.md`](./重构方案梳理/9-数据迁移与历史产物处理.md) — 旧产物迁移。
8. [`重构方案梳理/10-前端展示约束.md`](./重构方案梳理/10-前端展示约束.md) + [`11-测试与回归.md`](./重构方案梳理/11-测试与回归.md) — UI 与回归验收。
9. [`重构方案梳理/12-调优包-Skill化交付.md`](./重构方案梳理/12-调优包-Skill化交付.md) + [`13-案例池自动入池规则.md`](./重构方案梳理/13-案例池自动入池规则.md) + [`14-样本合成与长尾覆盖.md`](./重构方案梳理/14-样本合成与长尾覆盖.md) — 新规划能力。
10. [`重构方案梳理/15-能力维度评测与归因.md`](./重构方案梳理/15-能力维度评测与归因.md) — 评测集按能力维度切片，Canonical Harness 9 层抽象，能力↔层归因矩阵，Copilot 优化决策 skill。
11. [`重构方案梳理/6-重构实施路线.md`](./重构方案梳理/6-重构实施路线.md) — 阶段拆分 P0–P5。

## Agent 开发项目指南

> 适用于 AI Agent 在本仓库内执行重构任务时的基本约束。

### 1. 决策依据优先级

```
重构方案梳理/  >  可复用组件/  >  指标与DAG/  >  原始prd参考/  >  仓库源代码
```

- 当 PRD 与源码冲突时，以 `重构方案梳理/` 为准。
- 当历史 PRD 与本方案冲突时，以本方案为准；历史 PRD 仅作背景参考。
- 当 schema SQL 与表结构描述冲突时，以本方案 5 号文档为口径，更新 SQL 草案。

### 2. 不可越界的红线

- 后端只用 Supabase / Postgres，不再为 `local-json`、filesystem store、`zerore_records` 桥表新增正式路径。
- API 的请求/响应字段名、路径、HTTP 方法保持向前兼容，不允许重命名。
- LLM 主观评估失败必须显式降级（`source = fallback / rule / unavailable`），禁止伪装为 LLM 输出。
- LLM 默认模型 `Qwen/Qwen3.5-27B`，`ZEVAL_JUDGE_ENABLE_THINKING` 与 `SILICONFLOW_ENABLE_THINKING` 必须同时置为 `false`，否则思考模型只回 reasoning，会导致全链路 JSON 解析失败。
- 前端不展示模块名、stage 名、prompt 版本号、`workspaceId` 字面值；用户面文案使用中文业务语义。
- 真实 API key 与数据库密码不进入文档目录；环境模板只保留变量名与占位符。
- 调优包必须以 Skill 文件夹形式交付（含 `SKILL.md` 与 `metadata.json`），不仅是 4 件套文档。
- 案例池的所有 case 必须显式 `source` 字段；自动入池命中 `false_positive` 的旧记录必须跳过。
- 案例池的所有 case 必须显式 `capabilityDimension`（12 个白名单值之一）；badcase 还必须显式 `failureLayer`（L0–L8 之一），否则不允许写入 `eval_cases`。
- Copilot 给出的优化建议必须能追溯到对照实验或归因规则，不允许"凭感觉"输出。
- 合成样本默认不进入 baseline 与在线评测的统计基线，必须区别于真实数据。

### 3. 实施节奏

- 按 [`重构方案梳理/6-重构实施路线.md`](./重构方案梳理/6-重构实施路线.md) 的 P0 → P4 串行推进。
- 每完成一个阶段，先跑通 `tsc --noEmit` + `lint` + 对应 smoke 脚本（参考 [`11-测试与回归.md`](./重构方案梳理/11-测试与回归.md)）。
- 不允许在同一 PR 内混合多个阶段的破坏性改动。

### 4. 写代码前必查

- 指标新增或修改：先查 [`指标与DAG/主客观指标依赖表.xlsx`](./指标与DAG/主客观指标依赖表.xlsx)，并同步更新该表与 [`高可读文档/指标计算DAG.html`](./高可读文档/指标计算DAG.html) 的 NODES 列表。
- 表结构改动：先改 [`可复用组件/supabase-target-schema.sql`](./可复用组件/supabase-target-schema.sql)，再写 migration。
- API 变更：先改 [`重构方案梳理/7-API契约.md`](./重构方案梳理/7-API契约.md)，再改路由实现。
- LLM 改动：先改 [`重构方案梳理/8-LLM调用与降级.md`](./重构方案梳理/8-LLM调用与降级.md)，并升 `prompt_version`。
- 调优包 / Skill 改动：先改 [`重构方案梳理/12-调优包-Skill化交付.md`](./重构方案梳理/12-调优包-Skill化交付.md)，再改打包逻辑与 artifact 写入。
- 自动入池规则 / 阈值：先改 [`重构方案梳理/13-案例池自动入池规则.md`](./重构方案梳理/13-案例池自动入池规则.md)，再调整 `dataset_admission_rules`。
- 合成能力：先改 [`重构方案梳理/14-样本合成与长尾覆盖.md`](./重构方案梳理/14-样本合成与长尾覆盖.md)，再调整 `synthesis_*` 表与 prompt。
- 能力维度白名单 / Harness 层定义 / 归因矩阵 / Copilot 决策 skill：先改 [`重构方案梳理/15-能力维度评测与归因.md`](./重构方案梳理/15-能力维度评测与归因.md)，再改 `eval_cases` 字段、`capability_attributions` 表与 Copilot skill 实现。

### 5. 输出与可追溯性

- 任一评估运行必须能从 `evaluation_runs` 追溯到 `sessions / message_turns / topic_segments / objective_signals / subjective_signals / risk_tags / evidence_spans / suggestions`。
- 任一主观分数必须能在 `judge_runs` 中看到 stage / model / prompt_version / status / latency。
- 任一建议必须绑定触发指标 key 与 `evidence_span_id`。
- 任一指标都能回答：来自哪里、何时计算、是否 LLM、失败如何降级、最终落到哪张表与哪个页面。

### 6. 与本仓库 AGENTS.md 的关系

- 仓库根目录的 [`AGENTS.md`](../AGENTS.md) 是 MVP 阶段的总通则（保留 MVP 边界、不做大平台化、JSDoc、最小改动等）。
- 本目录是面向"具体重构任务"的工程指南，是 `AGENTS.md` 在重构语境下的细化。
- 当两者口径冲突时，按本目录约束执行；遇到无法消解的冲突，应在 PR 描述中显式说明。

## 状态

- 方案版本：v1（2026-05-08 起）。
- 后续若指标、API、表结构发生重大变更，请同步更新对应文档，并在本 README 中标注新版本号。
