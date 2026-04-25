# ZERORE Eval MVP

基于 `Next.js + TypeScript` 的 AI 对话质量工作台。当前版本已经跑通：

前端接收数据 -> 后端解析 -> 评估计算（客观 + 主观） -> 输出图表与建议 -> 保存基线 -> 在线回放对比。

下一阶段不再把目标定义为“更多图表”，而是升级为一条完整的质量闭环：

1. 发现问题
2. 提取证据
3. 生成调优包
4. 交给 agent 执行
5. 回放 / 沙箱验证

## 0. 当前进度

截至当前版本，项目状态分为三层：

- 已落地：
  - 四种格式 `CSV/JSON/TXT/MD` 的 ingest 解析
  - `Raw -> Enriched -> ChartPayload` 三层数据链路
  - `POST /api/ingest` 与 `POST /api/evaluate`
  - 一组可运行的客观指标聚合
  - `SiliconFlow + Qwen/Qwen3.5-27B` 主观评估接入
  - 规则优先、LLM 兜底的 topic segmentation
  - segment 级结构化 emotion scoring（`0-100` 分制，保留 `1` 位小数）
  - 隐式推断信号层
  - 前端上传、预览、执行状态、图表与建议展示
- 已验证：
  - LLM judge 已可通过环境变量调用
  - mock raw chatlog 可产出主观评分与证据片段
  - 指定 raw 数据可补全为 enriched CSV 并写入 `mock-chatlog/enriched-data`
- 下一阶段待增强：
  - 将“问题发现”升级为“问题 -> 证据 -> 调优包 -> 验证”的闭环
  - 把 bad case 自动沉淀成可复用案例资产与回归集
  - 让调优结果可直接编译成 `Claude Code / Codex` 可执行的任务包
  - 在真实回放之外补上沙箱 / 仿真验证层

## 0.1 当前产品定位

ZERORE 当前不追求做一个“大而全 eval 平台”，而是优先做：

- 一个能接入真实 `chatlog / trace` 的质量诊断工作台；
- 一个能把典型 bad case 沉淀为回归资产的质量资产层；
- 一个能输出 agent-readable 调优包并验证修复效果的质量操作层。

## 1. MVP 目标

在具体业务场景未最终确定前，先完成一个可复用的评估流水线框架，验证以下能力：

- 支持多格式输入：`CSV`、`JSON`、`TXT`、`MD`
- 对长对话按 `session/topic` 切分并结构化
- 计算客观指标（规则/算法）
- 计算主观指标（LLM Judge + 隐式推断）
- 生成可展示交付物（图表数据 + 优化建议）

## 1.1 下一阶段目标（五步闭环）

在现有 MVP 之上，下一阶段要补齐的是“调优与验证”，而不是单纯扩展指标数量。

- `Step 1 · 发现问题`
  - 在线 / 离线评测后定位失败会话、死亡轮次、风险聚类和关键 turning point。
- `Step 2 · 提取证据`
  - 为每个问题输出证据片段、触发指标、原因解释和置信度。
- `Step 3 · 生成调优包`
  - 将 bad case、修复目标、约束条件和验收门槛编译成 agent-readable 文档。
- `Step 4 · 交给 agent 执行`
  - 将调优包直接交给 `Claude Code / Codex` 等 coding agent 执行 prompt / policy / code 修改。
- `Step 5 · 回放 / 沙箱验证`
  - 用 baseline replay、固定 sample batch 和后续 sandbox 套件验证“是否真的变好”。

建议把新增交付物固定为以下几类：

- `issue-brief.md`：问题概述、影响、证据、优先级。
- `remediation-spec.yaml`：结构化调优目标、修改层、约束条件。
- `badcases.jsonl`：失败样本与期望行为。
- `acceptance-gate.yaml`：回放 / 离线 / 沙箱的验收阈值。

## 2. 一天内交付范围

- 打通单链路 API：上传数据 -> 返回评估结果 JSON
- 前端展示：
  - 上传入口与解析状态
  - 基础图表（先用 3-5 张核心图）
  - 优化建议文本区
- 后端能力：
  - 统一数据模型转换
  - 客观指标计算模块
  - 主观指标评估模块（先接 1 个 LLM Provider）
  - 报告组装模块

不包含：

- 生产级登录权限系统（当前已有 header/dev fallback 的本地 auth/workspace 基础层）
- 生产级多租户完整隔离系统（当前已有 workspace-aware path / local DB 抽象）
- 生产级任务队列与复杂异步编排（当前已有本地 file queue 合约）

## 3.1 基础设施进展

当前为了从 MVP 过渡到可商用架构，已经先落了一层可替换基础设施：

- `src/auth/context.ts`：本地 auth/workspace context，支持 `x-zerore-user-id`、`x-zerore-workspace-id`、`x-zerore-role`。
- `src/pii/redaction.ts`：默认开启的 PII 脱敏，已接入 ingest / evaluate；可用 `PII_REDACTION_ENABLED=false` 关闭。
- `src/db/*`：workspace 分区的 local JSON database adapter，后续替换 Postgres/Supabase 时保持接口不变。
- `src/queue/index.ts` 与 `/api/jobs`：本地异步任务队列合约，后续可替换 Redis/BullMQ/Temporal。
- `calibration/scripts/expand-gold-from-fixtures.mts`：从 fixture chatlog 扩充 gold set draft，当前 `v2` 已扩到 12 条。

## 3. 技术选型（固定）

- 框架：`Next.js`（App Router）
- 语言：`TypeScript`
- 前端：`React` + `Chart.js`（或 `Recharts`）
- 后端：Next.js Route Handlers（`/api/*`）
- 校验：`zod`
- LLM 接入：OpenAI 兼容接口（可替换）
- 存储：MVP 先用本地文件 + 存储抽象（`DatasetStore`），后续可热插拔迁移到 `PostgreSQL / Supabase / 其他 BaaS`

## 4. 当前目录结构（关键）

```txt
.
├─ app/
│  ├─ page.tsx                                  # 产品 landing page
│  ├─ workbench/page.tsx                        # 评估工作台
│  ├─ online-eval/page.tsx                      # 交互效果在线评测页
│  └─ api/
│     ├─ ingest/route.ts                        # 数据接收与格式识别
│     ├─ evaluate/route.ts                      # 评估入口
│     ├─ online-eval/replay/route.ts            # 在线回放评测
│     ├─ workbench-baselines/route.ts           # 保存工作台基线
│     ├─ workbench-baselines/[customerId]/route.ts
│     ├─ workbench-baselines/[customerId]/[runId]/route.ts
│     └─ eval-datasets/
│        ├─ cases/route.ts                      # 评测案例创建/列表
│        ├─ cases/[caseId]/route.ts             # 单案例查询
│        ├─ sample-batches/route.ts             # 临时评测集抽样
│        └─ sample-batches/[sampleBatchId]/route.ts
├─ src/
│  ├─ schemas/
│  │  ├─ api.ts                                # ingest/evaluate 校验
│  │  ├─ eval-datasets.ts                      # 评测集 API 校验
│  │  ├─ online-eval.ts                        # 在线评测 API 校验
│  │  └─ workbench.ts                          # 基线 API 校验
│  ├─ parsers/
│  │  ├─ csvParser.ts
│  │  ├─ jsonParser.ts
│  │  ├─ textParser.ts
│  │  └─ index.ts
│  ├─ pipeline/
│  │  ├─ enrich.ts                             # Enriched 中间层生成
│  │  ├─ objectiveMetrics.ts                   # 客观指标
│  │  ├─ subjectiveMetrics.ts                  # 主观指标（LLM Judge）
│  │  ├─ chartBuilder.ts                       # 图表载荷构建
│  │  ├─ suggest.ts                            # 优化建议生成
│  │  ├─ summary.ts                            # 概览卡片组装
│  │  └─ evaluateRun.ts                        # 可复用评估流水线
│  ├─ eval-datasets/
│  │  ├─ storage/
│  │  │  ├─ dataset-store.ts                   # 存储接口（热插拔入口）
│  │  │  ├─ file-system-dataset-store.ts       # 文件系统实现
│  │  │  └─ types.ts
│  │  ├─ sample-batch.ts                       # 分层抽样逻辑
│  │  └─ case-transcript-hash.ts               # 去重 hash 逻辑
│  ├─ workbench/
│  │  ├─ baseline-store.ts                     # 工作台基线存储接口
│  │  ├─ baseline-file-store.ts                # 文件系统实现
│  │  └─ index.ts                              # store factory
│  ├─ online-eval/
│  │  └─ replayAssistant.ts                    # 在线回放替换 assistant
│  ├─ components/
│  │  ├─ home/                                 # 首页控制台
│  │  └─ online-eval/                          # 在线评测 UI
│  ├─ types/
│  │  └─ pipeline.ts                           # 三层数据契约
│  └─ lib/
│     └─ siliconflow.ts                        # LLM 调用封装
├─ eval-datasets/                               # 评测集文件结构与索引
├─ mock-chatlog/
│  ├─ raw-data/                                # mock 原始对话
│  ├─ enriched-data/                           # 评估中间产物
│  └─ baselines/                               # 工作台基线快照
├─ eval-system-概述/
│  ├─ 1-评测集构建.md
│  ├─ 2-基线构建与在线评测联动.md
│  ├─ 3-评测集构建与在线评测实现路径（业务版）.md
│  └─ 4-五步质量闭环与工程落地.md
└─ 执行规划.md
```

## 4.1 需求与方案文档索引（`eval-system-概述`）

- `1-评测集构建.md`：评测集目标、入库口径、去重、抽样、baseline 与 success 指标定义。
- `2-基线构建与在线评测联动.md`：首页保存基线、在线回放对比、customerId + runId 的联动规则。
- `3-评测集构建与在线评测实现路径（业务版）.md`：面向非技术成员的阶段路径、协同分工与验收口径。
- `4-五步质量闭环与工程落地.md`：五步闭环、PRD 到开发拆解、数据库与存储接入方案。
- `5-SEAR数据哲学与下一阶段架构.md`：SEAR 启发下的关系型质量信号仓库、数据库迁移顺序与下一阶段开发策略。

## 4.2 存储热插拔策略（后续数据库迁移）

当前实现已将评测集存储能力抽象为 `DatasetStore`，业务逻辑只依赖接口，不依赖具体存储介质：

- 现阶段：`FileSystemDatasetStore`（本地文件）用于 MVP 快速落地与可视化调试。
- 后续阶段：可新增并切换到数据库/BaaS 实现（例如 `PostgreSQL`、`Supabase`）。
- 数据库目标结构见 `database/schema.sql`，其核心原则是把评测输出拆成 `evaluation_runs / topic_segments / objective_signals / subjective_signals / business_kpi_signals / evidence_spans / risk_tags` 等可 join 的质量信号表。

建议迁移路径：

1. 保持 `DatasetStore` 接口稳定（`create/list/checkDuplicate/saveSampleBatch` 等）。
2. 为工作台基线新增与 `DatasetStore` 平级的 `WorkbenchBaselineStore` 抽象，避免继续直接写文件。
3. 先实现 evaluate projection layer，将现有 `EvaluateResponse` 投影到关系型质量信号记录。
4. 新增 `PostgresDatasetStore` / `PostgresWorkbenchBaselineStore` / `PostgresDatabaseAdapter` 并完成等价实现。
5. 在工厂函数中通过环境变量切换存储实现，保留文件系统 fallback。
6. 先双写校验，再切主读，最后下线文件系统主路径。

## 5. 统一数据模型

原始输入只保留最小 chatlog 结构：

```ts
type RawChatMessage = {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
};
```

关键约束：

- 若缺失 `sessionId`，按文件或时间窗口兜底生成
- `Raw` 层不要求携带 `topic/turnIndex`
- `topic`、情绪、行为信号都在 `Enriched` 层补齐
- 若缺失 `timestamp`，降级禁用时序相关指标并在报告中标注

## 5.1 三层数据契约（新增）

为降低前后端耦合，MVP 统一采用三层产物：

- `Raw Layer`：原始日志，仅包含 `sessionId/timestamp/role/content`
- `Enriched Layer`：预处理补全后的中间 CSV（用于指标和图表）
- `Chart Payload Layer`：按模板填充参数后的图表渲染载荷

对应实现文件：

- 类型契约：`src/types/pipeline.ts`
- 图表模板：`src/config/chartTemplates.ts`
- 图表载荷 Schema：`src/schemas/chart-payload.schema.json`
- Enriched 示例：`mock-chatlog/enriched-data/long-dialog-emotional-rp.enriched.csv`

Enriched 层建议关键字段：

- 当前已落地字段：
  - `turnIndex`
  - `topic`
  - `topicSource`
  - `topicConfidence`
  - `emotionPolarity`
  - `emotionIntensity`
  - `emotionLabel`
  - `emotionBaseScore`
  - `emotionScore`
  - `emotionEvidence`
  - `emotionSource`
  - `emotionConfidence`
  - `emotionValenceWeight`
  - `emotionLengthWeight`
  - `emotionStyleWeight`
  - `emotionGapWeight`
  - `emotionRecoveryWeight`
  - `emotionRiskPenalty`
  - `responseGapSec`
  - `isDropoffTurn`
  - `isQuestion`
  - `isTopicSwitch`
  - `activeHour`
  - `tokenCountEstimate`
- 当前已落地的 segment 字段：
  - `topicSegmentId`
  - `topicSegmentIndex`
  - `topicSummary`
  - `topicStartTurn`
  - `topicEndTurn`

说明：

- 当前代码中的 `topic` 已升级为 `session` 内的 topic segment 回填结果
- 情绪分不再是简单标签，而是“LLM 基准分 + 本地评分函数校正”的 segment 级结构化分数

## 5.2 第一阶段 P0 指标白名单

### 客观指标

- `sessionDepthDistribution`
- `dropoffTurnDistribution`
- `avgResponseGapSec`
- `activeHourDistribution`
- `topicSwitchRate`
- `userQuestionRate`
- `userMessageLengthTrend`
- `avgAssistantMessageLength`

### 主观指标

- `emotionCurve`
- `emotionTurningPoints`
- `emotionRecovery`
- `empathyScore`
- `offTopicOrIgnoreRisk`
- `preachinessRisk`

### 隐式推断信号

- `interestDeclineRisk`
- `understandingBarrierRisk`
- `emotionRecoveryFailureRisk`

原则：

- 客观指标允许依赖 AI 补全后的 `Enriched` 字段，但一旦进入计算层，聚合逻辑必须是确定性的
- 主观指标必须返回 `score + reason + evidence + confidence`
- 隐式推断信号采用“规则触发 + LLM 解释”的混合方案，避免只靠 prompt 漂移
- 情绪分采用 `100` 分制，保留 `1` 位小数
- LLM 只负责情绪倾向、强度与基准分判断；本地评分函数负责结构化校正

## 5.3 指标计算方式与公式

本节记录当前项目中已经落地的指标口径、计算方式和公式，默认以 `Enriched` 层为唯一输入。

### 5.3.1 客观指标

#### `sessionDepthDistribution`

含义：

- 统计每个 `session` 的最大轮次，再按深度桶聚合

公式：

```text
sessionDepth(session) = max(turnIndex in session)

bucket(sessionDepth) =
  1-3, if sessionDepth <= 3
  4-8, if 4 <= sessionDepth <= 8
  9+,  if sessionDepth >= 9

sessionDepthDistribution[bucket] = count(session in bucket)
```

当前代码口径：

- 每个 `session` 只记一次
- 使用 `max(turnIndex)` 作为该 session 的深度

#### `dropoffTurnDistribution`

含义：

- 统计断点发生在哪一轮

公式：

```text
dropoffTurnDistribution[turnIndex] =
  count(row where isDropoffTurn = true and row.turnIndex = turnIndex)
```

当前代码口径：

- 当前 `isDropoffTurn` 的定义是：
  - `row.turnIndex` 为当前 `session` 最后一轮
  - 且该行 `role = assistant`

#### `avgResponseGapSec`

含义：

- 统计相邻消息之间的平均时间间隔

公式：

```text
responseGapSec(i) = timestamp(i) - timestamp(i-1)

avgResponseGapSec =
  sum(all valid responseGapSec) / count(all valid responseGapSec)
```

当前代码口径：

- 仅在当前行与前一行都能解析出时间戳时计算
- 单位为秒
- 最终保留 `2` 位小数

#### `activeHourDistribution`

含义：

- 统计消息按小时分布

公式：

```text
activeHour = hour(timestamp)

activeHourDistribution[activeHour] =
  count(row where row.activeHour = activeHour)
```

当前代码口径：

- 若时间戳无法解析，归入 `unknown`

#### `topicSwitchRate`

含义：

- 统计每个 `session` 的平均 topic segment 切换次数

公式：

```text
topicSwitchCount(session) = unique(topicSegmentId in session) - 1

topicSwitchRate =
  sum(max(0, topicSwitchCount(session))) / count(session)
```

当前代码口径：

- 这是“每个 session 的平均切换次数”
- 不是按消息行占比计算

#### `userQuestionRate`

含义：

- 统计用户消息中问句的占比

公式：

```text
isQuestion = content contains "?" or "？"

userQuestionRate =
  count(user row where isQuestion = true) / count(all user row)
```

当前代码口径：

- 只看 `role = user`
- 最终保留 `4` 位小数

#### `avgUserMessageLength`

含义：

- 用户消息平均长度

公式：

```text
avgUserMessageLength =
  sum(length(content) for user rows) / count(user rows)
```

#### `avgAssistantMessageLength`

含义：

- AI 消息平均长度

公式：

```text
avgAssistantMessageLength =
  sum(length(content) for assistant rows) / count(assistant rows)
```

#### `userMessageLengthTrend`

含义：

- 用户消息长度趋势斜率，用于判断回复是否越来越短

公式：

```text
x = message index within user rows
y = message length

slope =
  sum((x - xMean) * (y - yMean)) / sum((x - xMean)^2)
```

解释：

- `slope < 0`：用户回复逐步变短
- `slope > 0`：用户回复逐步变长
- `slope ≈ 0`：长度基本稳定

### 5.3.2 Topic Segment 切分

#### 规则优先切分

当前切分逻辑：

- 先为每条消息生成 `rule topic candidate`
- 对相邻消息判断是否需要切段

核心规则：

```text
if previous.domain == current.domain:
  不切

if previous.domain 与 current.domain 属于兼容域:
  不切

if user 行命中强切词（扮演/练习/模拟/剧情/模板/...）:
  切

if current.domain == casual:
  不切

if assistant 行且未命中收尾强信号:
  不切

否则当 currentCandidate.confidence >= 0.84:
  切
```

#### 长间隔 LLM 介入

仅在以下条件满足时调用 LLM：

```text
gapSec >= 180
and useLlm = true
and 当前消息不命中显式 continuation 词
```

LLM 只判断：

```text
isContinuation = true / false
```

若 `isContinuation = false`，则在该点切新 segment。

### 5.3.3 Segment Emotion Scoring

情绪分为两段式：`LLM 基准分 + 本地评分函数修正`

#### 第一步：LLM 输出基准情绪

LLM 只输出：

- `emotionPolarity ∈ {positive, neutral, negative, mixed}`
- `emotionIntensity ∈ {low, medium, high}`
- `emotionBaseScore ∈ [0, 100]`
- `emotionEvidence`
- `emotionConfidence`

#### 第二步：本地评分函数校正

最终情绪分公式：

```text
emotionScore =
  emotionBaseScore
  + emotionValenceWeight
  + emotionLengthWeight
  + emotionStyleWeight
  + emotionGapWeight
  + emotionRecoveryWeight
  - emotionRiskPenalty
```

最终结果：

```text
emotionScore ∈ [0, 100]
保留 1 位小数
```

#### `emotionValenceWeight`

含义：

- 基于 segment 内正负向表达密度做校正

公式：

```text
emotionValenceWeight =
  clamp(
    ((positiveCount - negativeCount) / totalRows) * 12,
    -8,
    8
  )
```

#### `emotionLengthWeight`

含义：

- 基于用户/AI 语句长度结构做校正

当前规则：

```text
if avgUserLength >= 14: +2.5
if avgUserLength <= 7:  -2.5

if avgAssistantLength >= 28: -1.5
if avgAssistantLength <= 10: -1.0
else: +0.8

emotionLengthWeight = clamp(userPart + assistantPart, -8, 8)
```

#### `emotionStyleWeight`

含义：

- 基于共情表达和说教表达做风格校正

公式：

```text
emotionStyleWeight =
  clamp(empathyCount * 1.5 - preachyCount * 3, -8, 8)
```

#### `emotionGapWeight`

含义：

- 基于 segment 内平均响应间隔做节奏校正

当前规则：

```text
if avgGapSec > 90:  -5
else if avgGapSec > 45: -2
else if 0 < avgGapSec < 20: +1.5
else: 0
```

#### `emotionRecoveryWeight`

含义：

- 基于同一 segment 内是否出现恢复迹象做修正

当前规则：

```text
if firstUser is negative and lastUser is positive:
  +6
else if firstUser is negative and assistant has empathy:
  +3.5
else if polarity == negative and no supportive assistant:
  -3
else:
  0
```

#### `emotionRiskPenalty`

含义：

- 对高风险 segment 做扣分

当前规则：

```text
riskPenalty =
  1.2 if last row role == assistant
  + 2.8 if polarity == negative and intensity == high
  + 1.5 if avgUserLength <= 6 and polarity == negative

riskPenalty = clamp(riskPenalty, 0, 8)
```

#### 分数分段解释

```text
0-20   : 强负向，明显失衡
20-40  : 负向，高压/低落
40-60  : 中性偏压抑
60-80  : 稳定/缓和
80-100 : 明显正向/恢复良好
```

### 5.3.4 主观维度分

主观维度当前统一输出 `1-5` 分。

#### `empathyScore`

规则降级公式：

```text
empathyHitRate =
  count(assistant row contains empathy words) / count(assistant rows)

empathyScore = round(clamp(empathyHitRate * 5, 1, 5))
```

当前命中词示例：

- `理解`
- `明白`
- `支持`
- `陪你`
- `辛苦`
- `正常`

#### `offTopicOrIgnoreRisk`

规则降级公式：

```text
topicSwitchRowRate =
  count(row where isTopicSwitch = true) / count(all rows)

offTopicScore =
  round(clamp(5 - topicSwitchRowRate * 8 - understandingBarrierRisk * 2, 1, 5))
```

解释：

- 越高越好
- 受 topic 切换和理解障碍信号共同影响

#### `preachinessRisk`

规则降级公式：

```text
preachyRate =
  count(assistant row contains preachy words) / count(assistant rows)

preachinessScore =
  round(clamp(5 - preachyRate * 10, 1, 5))
```

当前命中词示例：

- `应该`
- `必须`
- `你要`
- `一定要`

#### `emotionRecovery`

规则降级公式：

```text
lowEmotionCount = count(row where emotionScore <= 40)
positiveCount   = count(row where emotionScore >= 65)
recoveryFailureRisk = signal(emotionRecoveryFailureRisk).score

if lowEmotionCount == 0:
  emotionRecovery = round(clamp(4 - recoveryFailureRisk, 1, 5))
else:
  emotionRecovery =
    round(clamp((positiveCount / lowEmotionCount) * 2.5 + (1 - recoveryFailureRisk), 1, 5))
```

#### `emotionTurningPoints`

含义：

- 检测情绪曲线中的显著跳变点

公式：

```text
scoreDelta = current.emotionScore - previous.emotionScore

if abs(scoreDelta) >= 12:
  记为 turning point
```

输出字段：

- `turnIndex`
- `direction = up / down`
- `scoreDelta`
- `evidence`

### 5.3.5 隐式推断信号

信号层统一输出 `score ∈ [0,1]`

#### `interestDeclineRisk`

公式：

```text
score = 0.22

if lateAvgLength < earlyAvgLength * 0.78:
  score += 0.26

if lateAvgGap > max(30, earlyAvgGap * 1.4):
  score += 0.28

if lateQuestionRate < earlyQuestionRate and earlyQuestionRate > 0:
  score += 0.18
```

#### `understandingBarrierRisk`

公式：

```text
score = 0.20

if confusionRows > 0:
  score += 0.30

if any normalizedQuestion count >= 2:
  score += 0.28

if user asked question and next assistant row isTopicSwitch:
  score += 0.18
```

#### `emotionRecoveryFailureRisk`

公式：

```text
score = 0.22

if exists low emotion row and no recovery within next 4 turns:
  score += 0.34

if dropoff occurs and previous row emotionScore <= 40:
  score += 0.22
```

#### 信号分级

统一分级规则：

```text
high   : score >= 0.70
medium : 0.40 <= score < 0.70
low    : score < 0.40
```

## 6. Pipeline 分层

### M1 数据接收与标准化

- 识别格式并解析
- 字段映射与类型校验
- 生成 `ChatMessage[]`

### M2 会话切分与主题切分

- 按 `sessionId` 分组
- 当前：会话内逐条消息 topic 推断
- P0 下一阶段：会话内按 `时间间隔 + 语义突变 + LLM Judge` 做主题切段
- 输出 Enriched 中间产物（CSV），作为后续唯一计算入口

### M3 客观指标计算

- 当前已落地：
  - 轮次分布
  - topic 切换频率
  - 用户活跃时段
  - 断点轮次分布
  - 响应间隔
  - 用户提问率
  - 用户与 AI 平均消息长度
- 下一阶段修正：
  - 将“轮次分布”统一为 `session` 级深度分布
  - 增加用户输入长度趋势而不是只保留平均值

### M4 主观指标计算

- 当前已落地：
  - `SiliconFlow` LLM judge
  - segment 级 emotion scoring
  - 共情程度
  - 答非所问风险
  - 说教感
  - 情绪恢复能力
  - 基于 `Enriched` 的 `100` 分制情绪曲线
- 下一阶段 P0：
  - 让情绪评分函数参数可配置
  - 输出更细的恢复区间与原因归因
  - 将“答非所问风险”继续沉淀为更稳定的证据模板

### M4.1 Segment Emotion Scoring

当前实现采用两段式：

- `LLM` 判断：
  - `emotionPolarity`
  - `emotionIntensity`
  - `emotionBaseScore`
  - `emotionEvidence`
  - `emotionConfidence`
- 本地评分函数修正：
  - `emotionValenceWeight`
  - `emotionLengthWeight`
  - `emotionStyleWeight`
  - `emotionGapWeight`
  - `emotionRecoveryWeight`
  - `emotionRiskPenalty`

最终输出：

- `emotionScore = emotionBaseScore + 各项修正 - riskPenalty`
- 分数区间为 `0-100`
- 保留 `1` 位小数

### M4.5 隐式推断信号层

信号层位于 `Enriched` 与 `subjectiveEvaluator` 之间，负责把弱结构化行为模式转换成稳定风险信号。

- `interestDeclineRisk`
  - 触发信号：连续短回复、回复间隔拉长、提问率下降
  - 业务意义：用户兴趣衰减、接近流失
- `understandingBarrierRisk`
  - 触发信号：重复提问、澄清表达、困惑词频升高
  - 业务意义：AI 表达不清晰或未理解用户
- `emotionRecoveryFailureRisk`
  - 触发信号：负向情绪持续多轮且未见回升
  - 业务意义：安抚无效、高流失风险

实现原则：

- 先规则触发，再由 LLM 生成解释和证据
- 信号层输出必须可追溯到具体 turn 范围或消息片段
- 信号层本身不直接出最终建议，而是作为 `suggest` 模块的输入

### M5 建议生成与报告组装

- 汇总高风险指标与优势指标
- 输出图表数据结构 + 优化建议清单
- 图表使用预定义模板，仅替换参数名和参数值

## 7. API 约定（MVP）

- `POST /api/ingest`
  - 输入：文件或文本 + `format`
  - 输出：标准化后的 `ChatMessage[]` 与基础统计

- `POST /api/evaluate`
  - 输入：`ChatMessage[]` + 可选配置（是否启用 LLM）
  - 输出：`objectiveMetrics`、`subjectiveMetrics`、`charts`、`suggestions`

## 8. 今天的建议排期

- 第 1-2 小时：脚手架 + 类型 + 四种格式 parser
- 第 3-4 小时：normalize + objective metrics
- 第 5-6 小时：LLM Judge 接入 + subjective metrics
- 第 7 小时：报告结构 + 前端图表展示
- 第 8 小时：联调、修复、验收演示数据

## 9. 验收标准（今天）

满足以下即视为 MVP 第一版打通：

- 能上传四种格式中的任意一种 mock 长对话数据
- 后端成功返回客观指标与主观指标
- 前端至少渲染 3 张图并展示 5 条可执行优化建议
- 对缺失字段（如 timestamp/topic）有可解释降级策略

## 9.1 当前版本与 P0 差距

当前版本已经完成重新定义后的第一阶段 P0 主体能力：

- 已满足：
  - 原始 chatlog 解析
  - enriched 中间层生成
  - 一版客观指标
  - 一版主观指标
  - LLM provider 接入
  - topic segment 切分
  - segment 级结构化 emotion scoring
  - 隐式推断信号层
  - enriched artifact 落盘
- 待补齐：
  - 更细的 signal 触发器
  - 更多跨业务场景的指标模板

## 9.2 当前验收结果

以 `mock-chatlog/raw-data/long-dialog-emotional-rp.csv` 为测试样本，当前版本已验证：

- `POST /api/evaluate` 可返回 `topicSegments`
- `topicSegments` 已包含 segment 级 `emotionBaseScore/emotionScore/polarity/intensity`
- 可返回 `subjectiveMetrics.signals`
- 可返回 `subjectiveMetrics.emotionTurningPoints`
- 可返回 `dimensions + evidence + confidence`
- 可将 enriched CSV 写入 `mock-chatlog/enriched-data/long-dialog-emotional-rp.enriched.csv`

## 10. 下一步

- 补 AI topic segmentation，并把 topic 从“逐条标签”升级为“主题段”
- 落隐式推断信号层，作为建议生成输入
- 修正 session 级客观指标口径
- 再考虑数据库、任务队列、导出与人工复核能力
