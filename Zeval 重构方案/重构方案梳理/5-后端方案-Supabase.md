# 5-后端方案-Supabase

重构后后端只考虑 Supabase/Postgres。现有 local-json、filesystem store、workspace 兼容表可作为迁移输入或历史参考，不作为目标态设计。

## 后端原则

1. Supabase 是唯一业务数据源。
2. 所有 CRUD API 复用现有路由契约，但底层表结构按本方案重写。
3. 评估输出不是一份 report JSON，而是一组可追溯质量信号。
4. 大文本、原始导入、报告快照可放 Supabase Storage，表中保存 URI 与摘要。
5. MVP 不做复杂多租户 UI，但表结构保留 `organization_id` 与 `project_id`。

## 目标表分组

### 组织与项目

| 表 | 用途 |
| --- | --- |
| `organizations` | 组织 |
| `projects` | 项目/客户空间 |
| `project_members` | 成员关系，可后置实现 UI |
| `api_keys` | API 调用凭证 |
| `audit_logs` | 关键写操作审计 |

### 数据接入

| 表 | 用途 |
| --- | --- |
| `datasets` | 一批上传或导入数据 |
| `dataset_imports` | 单次导入记录、格式、脱敏、artifact |
| `sessions` | 对话 session |
| `message_turns` | 单条消息 |
| `turn_enrichments` | 行级补全字段，如 gap、question、topic、emotion |

### 评估运行

| 表 | 用途 |
| --- | --- |
| `evaluation_runs` | 单次评估运行 |
| `topic_segments` | 主题片段 |
| `objective_signals` | 客观指标 |
| `subjective_signals` | 主观指标 |
| `risk_tags` | 隐式推断和 badcase 风险 |
| `evidence_spans` | 证据片段 |
| `suggestions` | 优化建议 |
| `report_artifacts` | 图表、摘要、导出文件 |

### LLM Judge

| 表 | 用途 |
| --- | --- |
| `judge_runs` | 每次 LLM 调用 |
| `judge_outputs` | 解析后结构化输出 |
| `judge_failures` | 调用失败、解析失败、降级原因 |

### Baseline 与在线评测

| 表 | 用途 |
| --- | --- |
| `baselines` | 客户基线 |
| `baseline_runs` | 具体 baseline 快照 |
| `online_eval_runs` | 在线评测运行 |
| `replay_turns` | 回放生成的消息 |
| `run_comparisons` | baseline vs current 对比结果 |

### 评测集与回归

| 表 | 用途 |
| --- | --- |
| `eval_cases` | goodcase / badcase（含 `source` 8 类、`capability_dimension`、`failure_layer`、`attribution_confidence`、`attribution_method` 字段，详见 `13-案例池自动入池规则.md` 与 `15-能力维度评测与归因.md`） |
| `eval_case_baselines` | case 对应期望结果 |
| `eval_case_candidates` | 自动入池候选（同步携带 `capability_dimension` / `failure_layer`，待人工复审） |
| `dataset_admission_rules` | 自动入池规则配置（详见 `13-案例池自动入池规则.md`） |
| `capability_attributions` | 一条 badcase 归因到具体 harness 层的决策记录，含来源对照实验（详见 `15-能力维度评测与归因.md`） |
| `experiment_routes` | 候选实验路由：在固定 capability 评测集上跑多个候选（model / prompt / tool schema 等）的对照矩阵（详见 `15-能力维度评测与归因.md`） |
| `sample_batches` | 抽样批次 |
| `sample_batch_cases` | 批次与 case 关系 |
| `validation_runs` | 回归验证运行 |
| `validation_results` | 单 case 验证结果 |

### 长尾样本合成

| 表 | 用途 |
| --- | --- |
| `synthesis_templates` | 客户复用的场景模板 |
| `synthesis_runs` | 合成运行记录 |
| `synthesized_samples` | 合成样本 + 自校验结果（详见 `14-样本合成与长尾覆盖.md`） |

### 调优包（Skill 化）与 Agent

| 表 | 用途 |
| --- | --- |
| `remediation_packages` | 调优包，含 `skill_version / skill_artifact_uri / skill_metadata`（详见 `12-调优包-Skill化交付.md`） |
| `remediation_artifacts` | issue brief、spec、badcases、gate、SKILL.md、metadata.json、prompt 与 script 片段 |
| `agent_runs` | Agent 执行记录 |
| `jobs` | 异步任务 |

## CRUD 复用映射

| 现有 API | 目标表 | 处理策略 |
| --- | --- | --- |
| `POST /api/ingest` | `datasets`、`dataset_imports`、`sessions`、`message_turns` | 保留响应契约，新增 Supabase 写入 |
| `POST /api/evaluate` | `evaluation_runs`、signals、evidence、suggestions | 保留计算入口，重写 persistence |
| `POST /api/workbench-baselines` | `baselines`、`baseline_runs` | 替代文件 baseline store |
| `GET /api/workbench-baselines/[customerId]` | `baselines`、`baseline_runs` | 按客户与时间查询 |
| `POST /api/online-eval/replay` | `online_eval_runs`、`replay_turns`、`run_comparisons` | 保留回复 API 契约 |
| `/api/eval-datasets/*` | `eval_cases`、`eval_case_candidates`、`sample_batches`、`dataset_admission_rules` | 保留去重和抽样逻辑，替换存储；新增自动入池规则与候选 |
| `/api/eval-datasets/synthesize`、`/api/eval-datasets/synthesis-*` | `synthesis_templates`、`synthesis_runs`、`synthesized_samples` | 长尾样本合成入口 |
| `/api/remediation-packages/*` | `remediation_packages`、`remediation_artifacts` | 替代 filesystem package store；新增 Skill 打包与下载子路由 |
| `/api/validation-runs/*` | `validation_runs`、`validation_results` | 替代本地 validation store |
| `/api/jobs/*` | `jobs` | 替代 JSON 队列 |

## 目标迁移顺序

1. 新建 Supabase schema，不再扩展 `zerore_records`。
2. 先迁移 evaluation projection：`evaluation_runs`、`topic_segments`、`objective_signals`、`subjective_signals`、`risk_tags`、`evidence_spans`。
3. 迁移 baseline 与 online eval，保证在线对比闭环。
4. 迁移 eval-datasets 和 sample batch，保证回归验证闭环。
5. 迁移 remediation packages、validation runs、agent runs、jobs。
6. 删除或冻结 local-json/filesystem store，只保留一次性迁移脚本。

## Supabase 连接配置

目标环境变量：

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_PROJECT_REF=...
DATABASE_URL=postgresql://postgres:YOUR_DB_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
ZEVAL_DATABASE_ADAPTER=postgres
ZEVAL_POSTGRES_SSL=require
ZEVAL_POSTGRES_POOL_MAX=5
```

`publishable key` 只能用于前端或匿名能力，不能替代服务端 `DATABASE_URL`。真实密钥不应进入重构方案文档或普通 Markdown。

## 表结构草案

详细 SQL 建议放入 `../可复用组件/supabase-target-schema.sql`。该 SQL 应以本文件表分组为准，不直接继承旧 migration 中的 `workspaces` 与 `zerore_records` 兼容设计。
