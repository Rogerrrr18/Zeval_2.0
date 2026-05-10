# API CRUD 复用映射

| 现有路由 | 方法 | 现有职责 | Supabase 目标表 |
| --- | --- | --- | --- |
| `/api/ingest` | POST | 文件解析与 canonical rawRows | `datasets`、`dataset_imports`、`sessions`、`message_turns` |
| `/api/evaluate` | POST | 运行评估 pipeline | `evaluation_runs`、`topic_segments`、`objective_signals`、`subjective_signals`、`risk_tags`、`evidence_spans` |
| `/api/data-onboarding` | POST | 字段映射计划 | `dataset_imports`、`mapping_plans` |
| `/api/workbench-baselines` | POST | 保存 baseline | `baselines`、`baseline_runs` |
| `/api/workbench-baselines/[customerId]` | GET | 查询客户 baseline | `baselines`、`baseline_runs` |
| `/api/workbench-baselines/[customerId]/[runId]` | GET | 查询 baseline 快照 | `baseline_runs` |
| `/api/workbench-baselines/[customerId]/trend` | GET | baseline 趋势 | `run_comparisons` 或 `evaluation_runs` 聚合 |
| `/api/online-eval/replay` | POST | 在线回放评估 | `online_eval_runs`、`replay_turns`、`run_comparisons` |
| `/api/eval-datasets/cases` | GET/POST | case 列表与创建 | `eval_cases`、`eval_case_baselines` |
| `/api/eval-datasets/cases/[caseId]` | GET/PATCH | case 读取与更新 | `eval_cases` |
| `/api/eval-datasets/sample-batches` | GET/POST | sample batch 列表与创建 | `sample_batches`、`sample_batch_cases` |
| `/api/eval-datasets/sample-batches/[sampleBatchId]` | GET | sample batch 读取 | `sample_batches`、`sample_batch_cases` |
| `/api/eval-datasets/harvest-badcases` | POST | 从评估收获 badcase | `eval_cases`、`risk_tags` |
| `/api/remediation-packages` | GET/POST | 调优包列表与创建 | `remediation_packages`、`remediation_artifacts` |
| `/api/remediation-packages/[packageId]` | GET/PATCH | 调优包读取与更新 | `remediation_packages` |
| `/api/validation-runs` | GET/POST | 验证运行 | `validation_runs`、`validation_results` |
| `/api/agent-runs` | GET/POST | Agent 执行记录 | `agent_runs` |
| `/api/jobs` | GET/POST | 任务队列 | `jobs` |

## 复用原则

- 复用路由路径和请求/响应契约，减少前端改造成本。
- 不复用 filesystem/local-json 存储实现。
- 如果现有 API 契约与目标表结构冲突，优先保证目标表结构清晰，再在 route 层做兼容转换。
