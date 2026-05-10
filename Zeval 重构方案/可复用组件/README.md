# 可复用组件与配置

本目录整理重构时可以复用的配置、API 契约和服务连接方式。注意：`.env.local` 中包含真实密钥，不能把真实值复制到普通文档或提交路径；这里保留变量结构和用途。

## SiliconFlow / LLM Judge 配置

| 变量 | 用途 | 重构建议 |
| --- | --- | --- |
| `ZEVAL_JUDGE_API_KEY` / `SILICONFLOW_API_KEY` | LLM Judge API Key | 统一为 `ZEVAL_JUDGE_API_KEY`，旧变量只做迁移兼容 |
| `ZEVAL_JUDGE_BASE_URL` / `SILICONFLOW_BASE_URL` | OpenAI-compatible endpoint | 统一为 `ZEVAL_JUDGE_BASE_URL` |
| `ZEVAL_JUDGE_MODEL` / `SILICONFLOW_MODEL` | Judge 模型 | 统一为 `ZEVAL_JUDGE_MODEL`，默认 `Qwen/Qwen3.5-27B` |
| `ZEVAL_JUDGE_ENABLE_THINKING` | Zeval 侧 thinking 开关 | 必须固定 `false` |
| `SILICONFLOW_ENABLE_THINKING` | SiliconFlow 侧 thinking 开关 | 必须固定 `false`，与上一个开关一并关闭，否则思考模型只回 reasoning |
| `SILICONFLOW_CUSTOMER_API_URL` | 在线评测默认回复通道 | 保留为 demo/mock 通道变量 |

建议模板见 `siliconflow-env.template`。

## Supabase 配置

| 变量 | 用途 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | 前端 Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 前端 publishable key |
| `SUPABASE_PROJECT_REF` | Supabase project ref |
| `DATABASE_URL` | 服务端 Postgres 连接串 |
| `ZEVAL_DATABASE_ADAPTER` | 重构目标固定为 `postgres` |
| `ZEVAL_POSTGRES_SSL` | Supabase 目标为 `require` |
| `ZEVAL_POSTGRES_POOL_MAX` | 连接池大小 |

建议模板见 `supabase-env.template`。

## 可复用 API 契约

| API | 是否保留 | 重构重点 |
| --- | --- | --- |
| `POST /api/ingest` | 保留 | 写入 Supabase datasets/imports/sessions/message_turns |
| `POST /api/evaluate` | 保留 | 计算契约不变，persistence 改写为 Supabase |
| `POST /api/workbench-baselines` | 保留 | 替换 baseline 文件 store |
| `GET /api/workbench-baselines/[customerId]` | 保留 | 改为 Supabase 查询 |
| `POST /api/online-eval/replay` | 保留 | 写入 online_eval_runs/replay_turns/run_comparisons |
| `/api/eval-datasets/*` | 保留 | 替换 dataset filesystem store |
| `/api/remediation-packages/*` | 保留 | 替换 package filesystem store |
| `/api/validation-runs/*` | 保留 | 替换 validation filesystem store |
| `/api/jobs/*` | 保留 | 替换 JSON queue |

## 不再作为正式方案复用

- `local-json` 适配器。
- filesystem stores。
- `workspaceId` 作为正式领域概念。
- `zerore_records` 通用 JSONB 桥表。
