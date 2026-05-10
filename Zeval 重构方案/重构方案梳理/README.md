# Zeval 重构方案概述

本目录是 Zeval 项目的重构 PRD 集合。任何人在不阅读源码的前提下，只通过 `Zeval 重构方案/` 文件夹就能完整理解 Zeval 是什么、当前能力到哪、为什么要重构、目标态如何落地。

---

## 一、项目背景

### 1.1 一句话定位

Zeval 是一个面向 AI 对话产品的"评估 + 归因 + 调优"决策系统。把对话日志变成可解释的质量指标、证据片段、按能力维度组织的评测集与可执行优化建议，并把不达预期的会话沉淀成 badcase 与回归用例，最终告诉用户"该改模型还是改 harness 哪一层"，驱动 Agent 真正变好。

### 1.2 北极星闭环

```
上传对话日志 → 解析与补全 → 客观 + 主观评估 → 图表 / 证据 / 建议
            → baseline 沉淀 → 调优包 → Agent 执行 → 在线回放验证
```

闭环的每一步都必须保留可追溯的证据与指标，不允许出现“只有结论没有原因”的黑盒输出。

### 1.3 当前用户旅程

| 页面 / 入口 | 用户动作 | 当前实现 |
| --- | --- | --- |
| `/workbench` | 上传 CSV / JSON / TXT / MD，运行评估，查看图表与建议，保存 baseline | 基于 EvalConsole 组件，调用 `/api/ingest` 与 `/api/evaluate?stream=1` |
| `/online-eval` | 选择客户与 baseline，配置回复 API，进行回放评测并对比指标 | 调用 `/api/online-eval/replay`，使用工作台保存的 baseline |
| `/datasets` | 浏览 goodcase / badcase 案例池，标注误判 | 调用 `/api/eval-datasets/*` |
| `/remediation-packages` | 把 badcase 编译为 issue-brief / spec / acceptance-gate 等调优包 | 调用 `/api/remediation-packages/*` |
| `/synthesize` | LLM 合成评测样本 | 调用 `/api/eval-datasets/synthesize` |
| `/chat` | Chat agent 解释结果、触发评估与 baseline 技能 | 调用 `/api/copilot/chat` |

### 1.4 关键概念词典

| 术语 | 含义 |
| --- | --- |
| `RawChatlogRow` | 上传后的最小标准行：`sessionId / timestamp / role / content` |
| `NormalizedChatlogRow` | 排序、补 `turnIndex` 与时间字段后的行 |
| `EnrichedChatlogRow` | 加上主题、情绪、节奏、是否提问、是否断点等派生字段的行级中间层 |
| `TopicSegment` | session 内的主题片段，是主观评估的基本单元 |
| `ObjectiveMetrics` | 仅依赖规则与统计的客观指标聚合 |
| `SubjectiveMetrics` | 调用 LLM Judge（或规则降级）得到的主观结果，包括四维评审、情绪曲线、目标达成、恢复轨迹 |
| `ImplicitSignal` | 兴趣下降、理解障碍、情绪恢复失败等隐式风险，规则推断，作为 LLM 上下文与建议触发条件 |
| `EvidenceSpan` | 可定位到 turn / segment 的证据片段，绑定到指标与建议 |
| `Baseline` / `BaselineRun` | 客户基线快照，用于在线评测对比 |
| `OnlineEvalRun` | 一次基于 baseline 的回放评测运行 |
| `EvalCase` | goodcase / badcase 评测样本，含 `normalizedTranscriptHash` 去重 |
| `SampleBatch` | 分层抽样形成的评测批次，用于回归 |
| `JudgeRun` | 一次 LLM Judge 调用记录，含 stage / model / prompt version / status |
| `RemediationPackage` | 由 badcase 编译的调优包：issue-brief、remediation-spec、badcases、acceptance-gate |
| `CapabilityDimension` | 用户视角的 12 个能力维度白名单（见 [`15-能力维度评测与归因.md`](./15-能力维度评测与归因.md)），如 `multi_turn_coherence`、`tool_calling_correctness` |
| `HarnessLayer` | Canonical Agent Harness 的 9 层抽象（L0 Model / L1 Input / L2 Planning / L3 Memory / L4 Retrieval / L5 Tool Selection / L6 Tool Execution / L7 State / L8 Generation） |
| `CapabilityAttribution` | 一条 badcase 归因到具体 harness 层的决策记录，含置信度、方法、对照实验依据 |
| `ExperimentRoute` | 候选实验路由：在固定 capability 评测集上跑多个候选（model / prompt / tool schema 等）的对照矩阵 |

### 1.5 核心数据契约（保留不变）

`POST /api/evaluate` 的统一响应结构：

```
meta + objectiveMetrics + subjectiveMetrics + charts + suggestions
+ topicSegments + summaryCards + badCaseAssets
```

`Suggestion` 必须遵循 “问题 → 影响 → 建议动作” 模式，并显式绑定触发指标 key。

主观评审输出必须是结构化 JSON：`score / reason / evidence / confidence`。

---

## 二、当前项目实现速览

仅供重构者了解“现在长什么样”，不作为目标态依据。目标态以本目录后续文档为准。

### 2.1 目录结构（节选）

```
app/
  api/                    Next.js API 路由（ingest / evaluate / online-eval / eval-datasets …）
  workbench/              工作台页面
  online-eval/            在线评测页面
  datasets/               案例池页面
  remediation-packages/   调优包页面
src/
  parsers/                CSV / JSON / TXT / MD 解析器
  pipeline/               normalize / segmenter / emotion / objective / subjective / signals / suggest / chartBuilder
  data-onboarding/        字段映射与 Data Mapping Plan
  pii/                    PII 脱敏
  eval-datasets/          case 池、sample batch、storage
  workbench/              baseline filesystem store
  online-eval/            replay assistant
  validation/             回归验证 runner
  remediation/            调优包 builder 与 store
  agent-runs/             agent 执行记录 store
  db/                     ZeroreDatabase 抽象（local-json / postgres）
  copilot/                chat skills 与 orchestrator
  components/             EvalConsole 等前端组件
mock-chatlog/             示例数据与 baseline 文件
supabase/                 旧 migration 与 README（参考用）
eval-system-概述/         历史 PRD（已全文复制到本方案的“原始prd参考”）
指标变量表.csv             指标全集字段表
```

### 2.2 现有 LLM 调用阶段

| Stage | 触发条件 | 输入粒度 |
| --- | --- | --- |
| `topic_continuity_review` | 长间隔且规则不确定 | 相邻主题上下文 |
| `segment_emotion_baseline` | `useLlm=true` 时按 segment 调用 | topic segment |
| `subjective_dimension_judge` | `useLlm=true` 时按 session 调用 | session transcript + 隐式信号 |
| `goal_completion_judge` | 规则结果 unclear 时调用 | session transcript |
| `recovery_trace_strategy` | 存在 completed 恢复轨迹时调用 | failure / recovery span |

### 2.3 现有存储分布（重构后大部分要替换为 Supabase）

| 数据 | 现状 | 目标态 |
| --- | --- | --- |
| 评估投影（runs / topic / signals / evidence） | `local-json` 或 `postgres`，部分写入 `zerore_records` 桥表 | 落入显式 Supabase 表 |
| baseline 快照 | `mock-chatlog/baselines/` 文件 | `baselines / baseline_runs` 表 |
| 评测集 case / sample batch | `src/eval-datasets/storage/file-system-dataset-store.ts` | `eval_cases / sample_batches / sample_batch_cases` |
| 调优包 | `src/remediation/file-system-package-store.ts` | `remediation_packages / remediation_artifacts` |
| validation runs | `src/validation/file-system-validation-run-store.ts` | `validation_runs / validation_results` |
| agent runs | `src/agent-runs/file-system-agent-run-store.ts` | `agent_runs` |
| jobs 队列 | 本地 JSON 文件 | `jobs` 表 |
| traces | 内存环缓冲 | 暂保留内存，按需后置入库 |

---

## 三、为什么要重构

1. 指标黑盒：用户难以追溯每个指标的输入、计算时机、依赖、降级行为和落点。
2. 存储分裂：filesystem store / local-json / `zerore_records` 桥表 / postgres 适配并存，难以演进。
3. 多套场景假设：历史 PRD 同时存在“B2B 客服优先”“培训陪练优先”“场景无关”三种判断，缺少单一现行口径。
4. 多套指标表并存：早期 PRD、`指标变量表.csv`、`chatlog 评估维度.md`、Scenario 框架、补充落地方案各自一份，易漂移。
5. 主观评估失败时降级行为不一致，前端会出现规则降级伪装成 LLM 结果的情况。
6. baseline / 在线评测 / 回归验证 链路依赖文件路径，难以多客户、多版本横向对比。

---

## 四、重构核心口径（已与你确认）

- 场景策略：保持当前 AGENTS.md 口径，先做场景无关通用评估框架，Scenario 作为可插拔扩展。
- 后端策略：目标态只使用 Supabase，不再保留 `local-json`、filesystem store、`workspaceId` 兼容、`zerore_records` 通用桥表作为正式方案。
- API 策略：复用现有 CRUD 路由的请求与响应契约，但底层数据模型与持久化按本方案重写。
- 历史 PRD：全文归档到 `../原始prd参考/`，并在 README 中标记可用价值与冲突点。
- 配置项：`.env.local` 的真实 key 不进入文档，只保留变量结构与用途模板。

---

## 五、重构后保留与替换

| 保留 | 替换 / 删除 |
| --- | --- |
| 补全层（normalize / segmenter / emotion enrich） | filesystem stores 全部替换为 Supabase 表 |
| 客观指标算法 | `local-json` 适配器从正式路径删除 |
| 主观 LLM Judge 与降级机制 | `zerore_records` 通用 JSONB 桥表不作为目标主表 |
| 隐式推断信号 | `workspaceId` 作为正式领域概念替换为 `organization_id + project_id` |
| baseline / 在线评测 / 评测集 / 调优包 闭环 | 旧 supabase migration 中的兼容设计不直接继承 |
| `Suggestion` “问题 → 影响 → 行动” 契约 | 内部逻辑解释从用户页面移除 |
| `EvaluateResponse` 产品契约 | 评估结果不再仅以 JSON 报告呈现，而是落入可追溯的关系型信号仓库 |

---

## 六、文档索引

| 文档 | 用途 |
| --- | --- |
| [`1-项目架构.md`](./1-项目架构.md) | 目标分层、模块边界、保留/替换清单、模块关系图 |
| [`2-主客观指标说明.md`](./2-主客观指标说明.md) | 指标分层、客观/主观/LLM 调用点、透明化要求 |
| [`3-隐式推断.md`](./3-隐式推断.md) | 兴趣下降 / 理解障碍 / 情绪恢复失败 三类信号的输入、规则、目标存储 |
| [`4-数据流转.md`](./4-数据流转.md) | 端到端 DAG、阶段表、数据结构落库映射、LLM 介入时序 |
| [`5-后端方案-Supabase.md`](./5-后端方案-Supabase.md) | Supabase-only 表分组、CRUD 复用映射、迁移顺序 |
| [`6-重构实施路线.md`](./6-重构实施路线.md) | P0–P4 阶段、范围、验收、风险与非目标 |
| [`7-API契约.md`](./7-API契约.md) | 关键 API 的请求 / 响应字段、错误码、版本兼容 |
| [`8-LLM调用与降级.md`](./8-LLM调用与降级.md) | 5 个 Judge 阶段定义、Prompt 版本、降级行为、可观测性 |
| [`9-数据迁移与历史产物处理.md`](./9-数据迁移与历史产物处理.md) | 旧 filesystem / local-json / `zerore_records` 一次性迁移到 Supabase |
| [`10-前端展示约束.md`](./10-前端展示约束.md) | 页面级行为、文案口径、必须移除的 UI 元素 |
| [`11-测试与回归.md`](./11-测试与回归.md) | 单元 / 客观 snapshot / calibration / smoke / 投影回归约束 |
| [`12-调优包-Skill化交付.md`](./12-调优包-Skill化交付.md) | 调优包升级为 Skill 文件夹模板，便于客户在 Claude Code / Codex / Cursor 中触发执行 |
| [`13-案例池自动入池规则.md`](./13-案例池自动入池规则.md) | 隐式信号 + 客观指标的自动入池规则、阈值、去重与人工复审 |
| [`14-样本合成与长尾覆盖.md`](./14-样本合成与长尾覆盖.md) | 客户场景驱动的长尾样本合成、自校验、与评测集衔接 |
| [`15-能力维度评测与归因.md`](./15-能力维度评测与归因.md) | 评测集按能力维度切片、Canonical Harness 9 层、能力↔层归因矩阵、Copilot 优化决策 skill |

## 七、配套产物索引

| 产物 | 路径 | 用途 |
| --- | --- | --- |
| 主客观指标 XLSX | [`../指标与DAG/主客观指标依赖表.xlsx`](../指标与DAG/主客观指标依赖表.xlsx) | 指标全集、计算时机、LLM 介入、目标表 |
| 指标计算 DAG（Markdown） | [`../指标与DAG/指标计算DAG.md`](../指标与DAG/指标计算DAG.md) | Mermaid 版总览与 LLM 介入图 |
| 指标计算 DAG（HTML） | [`../指标与DAG/指标计算DAG.html`](../指标与DAG/指标计算DAG.html) | 中文交互可视化，按 L0–L8 + LLM + 输出层独立显隐 |
| 历史 PRD 全文归档 | [`../原始prd参考/`](../原始prd参考/) | 12 份原始文档 + 索引 README |
| Supabase 目标 schema 草案 | [`../可复用组件/supabase-target-schema.sql`](../可复用组件/supabase-target-schema.sql) | 目标表 DDL 草案 |
| Supabase 环境变量模板 | [`../可复用组件/supabase-env.template`](../可复用组件/supabase-env.template) | 不含真实 key |
| LLM Judge 环境变量模板 | [`../可复用组件/siliconflow-env.template`](../可复用组件/siliconflow-env.template) | 不含真实 key |
| API CRUD 复用映射 | [`../可复用组件/api-crud-reuse-map.md`](../可复用组件/api-crud-reuse-map.md) | 现有路由对应目标表 |

## 八、阅读建议

1. 先读本 README，理解项目背景与现行口径。
2. 读 `1-项目架构.md` 与 `4-数据流转.md`，建立目标分层和数据流的整体地图。
3. 读 `2-主客观指标说明.md` 与 `3-隐式推断.md`，结合 `指标与DAG/` 的 XLSX 与 HTML 理解每个指标。
4. 读 `5-后端方案-Supabase.md` 与 `../可复用组件/supabase-target-schema.sql`，明确目标表与 CRUD 映射。
5. 读 `7-API契约.md` 与 `8-LLM调用与降级.md`，落实接口与模型层契约。
6. 读 `9-数据迁移与历史产物处理.md`，把旧文件 / 旧适配器迁到 Supabase。
7. 读 `10-前端展示约束.md` 与 `11-测试与回归.md`，确保用户体验不退化、改动可验证。
8. 读 `12-调优包-Skill化交付.md`、`13-案例池自动入池规则.md`、`14-样本合成与长尾覆盖.md`，掌握三块新规划能力。
9. 读 `15-能力维度评测与归因.md`，掌握"评测集按能力切 + Harness 9 层归因 + Copilot 优化决策"的整体定位。
10. 读 `6-重构实施路线.md`，确定从哪一阶段开始落地。
11. 历史决策与对外叙事按需查阅 `../原始prd参考/`。

## 九、重构验收标准

1. 任一指标都能回答：来自哪里、何时计算、依赖哪些中间变量、是否调用 LLM、失败如何降级、最终落到哪张表与哪个页面。
2. 任一 `eval_case` 都能回答：属于哪个 `capabilityDimension`、badcase 失败在哪个 `HarnessLayer`、归因依据来自哪条对照实验或哪条规则（详见 [`15-能力维度评测与归因.md`](./15-能力维度评测与归因.md)）。
3. 任一 API 都能回答：读写哪些 Supabase 表、是否保留请求/响应契约、是否需要迁移旧文件产物。
4. 任一评估运行都能从 `evaluation_runs` 追溯到 `sessions / message_turns / topic_segments / objective_signals / subjective_signals / risk_tags / evidence_spans / suggestions`。
5. 任一主观分数都能追溯到 `judge_runs`：stage / model / prompt version / status / latency。
6. 任一建议都能绑定触发指标 key 与证据片段。
7. LLM 不可用时仍产出客观指标，并明确标记主观指标不可用或规则降级，不允许伪装成 LLM 结果。
8. 前端不暴露内部实现细节；内部逻辑只进文档或运维侧。
