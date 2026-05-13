# 主观评测链路优化说明

## 范围

本轮只处理上传后的评估主链路：

```text
rawRows
  -> normalize / topic segment / segment emotion
  -> objective metrics
  -> implicit signals / goal completion / recovery trace / subjective dimension judge
  -> charts / suggestions / response
```

不处理在线评测回放范式、调优包、中转站、非 Zeval 系统协作工具。

## 现状判断

当前输入是瘦日志：`sessionId / timestamp / role / content`，assistant 侧只含最终可见回复，不含工具调用、检索命中、执行反馈或推理块。因此主观评测必须基于 transcript、topic segment、客观派生指标和少量 LLM 分类结果，不应假装拥有完整 harness trace。

现有链路是顺序依赖的 fused pipeline：客观补全先产生中间层，主观指标再引用这些中间层。它不是“规则评估器”和“LLM 评估器”并行裁决同一个 case 的双轨架构，所以本轮不实现 `auto_disagreement` / 评估器冲突分类。该分类只有在后续明确保留规则轨与 LLM 轨并定义冲突阈值后才可落地。

## 本轮改动

1. 增加 `src/lib/concurrency.ts`，沉淀通用 `mapWithConcurrency` 和正整数环境变量解析。
2. `src/lib/siliconflow.ts` 增加进程内全局 LLM 并发池，所有 `requestSiliconFlowChatCompletion` 调用共享 `ZEVAL_JUDGE_GLOBAL_CONCURRENCY`，避免大文件上传时 segment / session 调用无界展开。
3. `src/pipeline/emotion.ts` 将 segment emotion 从 `Promise.all` 改为有界并发，默认 4，可用 `ZEVAL_JUDGE_SEGMENT_CONCURRENCY` 覆盖。
4. `src/pipeline/goalCompletion.ts` 将多 session goal completion LLM fallback 从串行改为有界并发，默认 4，可用 `ZEVAL_JUDGE_GOAL_CONCURRENCY` 覆盖。
5. `src/pipeline/recoveryTrace.ts` 将 completed recovery trace 的 LLM 总结从串行改为有界并发，默认 4，可用 `ZEVAL_JUDGE_RECOVERY_CONCURRENCY` 覆盖。
6. `src/pipeline/subjectiveMetrics.ts` 复用共享并发工具，并让 session dimension judge 的并发上限可回退到全局配置。
7. `src/pipeline/segmenter.ts` 将多 session topic continuity review 改为有界并发；单 session 内仍保持顺序，避免破坏 active segment 的依赖关系。
8. `src/pipeline/subjectiveMetrics.ts` 将四维 subjective dimension judge 与 goal completion → recovery trace 链并行启动；recovery 仍等待 goal completion，维持业务依赖。
9. `EvaluateResponse.meta.llmJudge` 增加运行时观测摘要，返回每个 LLM stage 的请求数、成功/失败、平均排队耗时、平均请求耗时、最大重试次数，以及最近 20 条请求的 session / segment / error metadata。
10. `EvaluateResponse.meta.runState / stageStatuses` 增加评估级状态机，区分 ready / degraded / failed，并把 warnings、LLM 降级、projection 写入失败统一反馈到响应 metadata。
11. `subjectiveMetrics.dimensionBreakdowns / aggregation` 增加 session 级四维 Judge 明细与聚合口径说明，保留现有 `dimensions` 全局摘要不破坏前端。
12. `src/lib/siliconflow.ts` 增加 stage-local 轻量熔断；连续 provider / timeout / network / rate limit 失败达到阈值后，该 stage 在冷却期内直接进入降级路径，避免无意义排队和请求风暴。

## 链路现状说明

| 阶段 | 代码入口 | LLM stage | 输入粒度 | 并发形态 | 失败行为 |
| --- | --- | --- | --- | --- | --- |
| normalize | `src/pipeline/enrich.ts` → `normalizeRawRows` | 无 | 全量 rows | 同步规则 | 不涉及 LLM |
| topic segment | `src/pipeline/segmenter.ts` → `buildTopicSegments` | `topic_continuity_review` | session 内长间隔相邻上下文 | `ZEVAL_JUDGE_TOPIC_CONCURRENCY` 跨 session 并发；单 session 内顺序；LLM 请求进入全局池 | 当前为强调用；失败会让 parse stage 失败 |
| segment emotion | `src/pipeline/emotion.ts` → `scoreTopicSegmentEmotions` | `segment_emotion_baseline` | topic segment | `ZEVAL_JUDGE_SEGMENT_CONCURRENCY` + 全局池 | 单 segment LLM 失败回退规则情绪基线 |
| objective metrics | `src/pipeline/objectiveMetrics.ts` | 无 | enriched rows | 本地规则 | 不涉及 LLM |
| implicit signals | `src/pipeline/signals.ts` | 无 | enriched rows | 本地规则 | 不涉及 LLM |
| goal completion | `src/pipeline/goalCompletion.ts` | `goal_completion_judge` | session | `ZEVAL_JUDGE_GOAL_CONCURRENCY` + 全局池；仅 unclear 升级 LLM | `judgeRequired=false` 回退规则；`true` 抛错 |
| recovery trace | `src/pipeline/recoveryTrace.ts` | `recovery_trace_strategy` | completed recovery span | `ZEVAL_JUDGE_RECOVERY_CONCURRENCY` + 全局池 | `judgeRequired=false` 保留规则 trace；`true` 抛错 |
| subjective dimensions | `src/pipeline/subjectiveMetrics.ts` | `subjective_dimension_judge` | session transcript，含多个 topic segment | `ZEVAL_JUDGE_SESSION_CONCURRENCY` + 全局池 | `judgeRequired=false` 回退规则维度；`true` 抛错 |
| aggregation | `aggregateDimensionReviews` | 无 | 多 session dimension reviews | 本地聚合 | 按 session 行数加权；reason/evidence 为近似合并 |

## 并发配置

```text
ZEVAL_JUDGE_GLOBAL_CONCURRENCY=4
ZEVAL_JUDGE_TOPIC_CONCURRENCY=4
ZEVAL_JUDGE_SEGMENT_CONCURRENCY=4
ZEVAL_JUDGE_SESSION_CONCURRENCY=4
ZEVAL_JUDGE_GOAL_CONCURRENCY=4
ZEVAL_JUDGE_RECOVERY_CONCURRENCY=4
ZEVAL_JUDGE_RETRY_ATTEMPTS=3
ZEVAL_JUDGE_CIRCUIT_BREAKER_FAILURES=5
ZEVAL_JUDGE_CIRCUIT_BREAKER_COOLDOWN_MS=60000
```

阶段级并发控制排队形态，全局并发控制供应商压力。实际发到模型网关的请求数不会超过全局上限。

## 设计问题对齐

### 4.1 并发与队列

**分段情绪 LLM 与 session 级主观 Judge 是否共享全局并发池？**

结论：共享全局池，同时保留阶段级 limit。

理由：

- 供应商限流和成本发生在模型网关层，不发生在单个 pipeline stage 层；只做阶段级 limit 时，多个阶段叠加仍可能超过 key / provider 的承载能力。
- 阶段级 limit 仍有价值，用来控制某一类任务的排队形态。例如 segment emotion 可能数量很多，不应完全挤占 session dimension judge。
- 当前实现采用“两层阀门”：`ZEVAL_JUDGE_TOPIC_CONCURRENCY / ZEVAL_JUDGE_SEGMENT_CONCURRENCY / ZEVAL_JUDGE_GOAL_CONCURRENCY / ZEVAL_JUDGE_RECOVERY_CONCURRENCY / ZEVAL_JUDGE_SESSION_CONCURRENCY` 控制阶段内并发，`ZEVAL_JUDGE_GLOBAL_CONCURRENCY` 控制真正发往模型网关的总并发。

**哪些阶段适合异步化，哪些必须阻塞在单次评估响应内？**

结论：MVP 中，生成用户当次评估结果所必需的阶段继续阻塞；可复算、可后补、可投影的阶段异步化。

| 阶段 | MVP 响应内阻塞 | 适合 async/job | 理由 |
| --- | --- | --- | --- |
| normalize / topic segment | 是 | 否 | 后续所有指标依赖 enriched rows 和 topic segment |
| segment emotion | 是 | 部分可后置 | 情绪曲线、恢复判断和主观维度依赖情绪基线；后续可做“先规则后 LLM 修正” |
| objective metrics | 是 | 否 | 本地规则，成本低，是主观输入和图表基础 |
| implicit signals | 是 | 否 | 主观 Judge 上下文和建议触发依赖这些风险信号 |
| goal completion | 是 | 部分可后置 | 当前摘要、badcase、suggestion 依赖目标达成；只有大批量离线场景适合后置 |
| recovery trace | 是 | 部分可后置 | 当前报告展示依赖；LLM repair strategy 文本可后补 |
| subjective dimension judge | 是 | 大批量可 job | 工作台需要当次返回主观维度；批量评测可以 async |
| evaluation projection / result persistence | 否 | 是 | 失败已进入 warnings，不阻断主响应 |
| badcase harvest / dataset admission | 否 | 是 | 候选入池可异步重试，避免拖慢用户响应 |

SLA 建议：

- 同步工作台评估：小样本目标 30–60 秒内返回；超过阈值建议使用 `asyncMode`。
- SSE 模式：每个 stage 必须有 running / done / failed 事件，避免用户误以为卡死。
- async job：必须暴露 job status、attempt、lastError、warnings、startedAt、finishedAt。

可观测字段：

- stage 级：`stage / status / durationMs / warningCount / degradedReason`
- LLM 请求级：`stage / queuedMs / durationMs / attempts / errorClass / promptVersion / model / sessionId / segmentId`
- job 级：`jobId / status / attempts / queuedAt / startedAt / finishedAt / lastError`

**是否把四维 Judge 拆成 segment 级？**

结论：MVP 保留 session 级单次调用，不拆 segment 级。

权衡：

| 方案 | 优点 | 风险 |
| --- | --- | --- |
| session 级 Judge（当前） | 保留多轮上下文；调用次数低；聚合逻辑简单；API 契约稳定 | 单个 session 很长时 token 较高；失败粒度较粗 |
| segment 级 Judge | 失败粒度更细；可局部重试；可按 topic 展示维度 | 调用数显著增加；跨 topic 上下文丢失；多 segment 聚合语义更复杂 |

推荐路径：短期保持 session 级；只有当出现长会话 token 超限、或产品需要“每个 topic 的四维评分”时，再引入 segment 级 Judge，并新增字段承载 segment dimension reviews，避免改变现有 `subjectiveMetrics.dimensions` 的聚合语义。

### 4.2 数据汇总与语义

**多 session、多 segment 的四维聚合是否满足可解释性？**

当前策略可作为 MVP 近似，但不应被解释为严格统计结论。

现状：

- score：按 session 行数加权平均后四舍五入。
- confidence：按 session 行数加权平均。
- evidence：只合并前两个可用片段。
- reason：取第一个可用 reason。

优点是 API 稳定、前端简单、能快速给出全局维度摘要；缺点是长 session 会拥有更高权重，少数高风险 session 的证据可能被截断，reason 不能完整解释所有 session 差异。

已落地的兼容改进：

1. 保留现有 `subjectiveMetrics.dimensions` 作为全局摘要，不破坏前端。
2. 追加 `dimensionBreakdowns`，按 session 记录原始四维 review、source、succeeded、weight 和关联 topicSegmentIds。
3. 前端默认展示全局摘要，需要展开时展示 session 级证据。
4. 聚合说明写入 `subjectiveMetrics.aggregation`，固定声明 `method=session_row_weighted_average`、`weightBasis=session_row_count`、`reasonStrategy=first_available`。

**隐式信号、客观指标与主观 Judge 的因果顺序是否需要显式化？**

结论：需要。本 PR 已在链路说明文档中显式列出阶段顺序，并通过 `meta.stageStatuses` 和 `meta.llmJudge` 暴露 stage / LLM metadata。

当前因果顺序：

```text
rawRows
  -> normalize
  -> topic segment
  -> segment emotion
  -> objective metrics
  -> implicit signals
  -> goal completion / recovery trace / subjective dimension judge
  -> aggregate / suggestions / charts
```

本 PR 已在响应中暴露运行态 metadata。后续如接入更完整的数据仓库，可把以下字段进一步落库：

- 指标依赖：metricKey、inputStage、sourceFields。
- Judge 依赖：stage、promptVersion、model、sessionId、segmentId。
- 降级原因：degradedReason、errorClass、fallbackSource。

### 4.3 报错、降级与产品一致性

**当前降级路径对用户可见字段的影响**

| 场景 | HTTP / Job 行为 | 用户可见字段 |
| --- | --- | --- |
| `useLlm=false, judgeRequired=false` | 评估成功 | `subjectiveMetrics.status=degraded`；`meta.llmJudge.enabled=false`；warnings 包含主观降级提示 |
| `useLlm=false, judgeRequired=true` | route 400；pipeline 也会保护性抛错 | 返回 error，不产出评估结果 |
| `useLlm=true, judgeRequired=false` 且单 session LLM 失败 | 评估成功 | 对应 session 回退规则结果；`subjectiveMetrics.status=degraded`；`meta.llmJudge.failedRequests > 0`；triggeredRules 带 fallback 标记 |
| `useLlm=true, judgeRequired=true` 且 LLM 失败 | 评估失败 | 同步 JSON 500；SSE `type=error`；async job failed |
| projection / result persistence 失败 | 主评估成功 | `meta.warnings` / job result warnings 追加失败原因，不阻断响应 |

**是否需要比 200 / 500 更细的状态机？**

结论：需要，但 MVP 可以先用向后兼容字段表达，不改 HTTP 契约。

本 PR 已在响应 JSON 中扩展：

```json
{
  "meta": {
    "runState": "ready | degraded | failed",
    "stageStatuses": [
      {
        "stage": "subjective",
        "status": "ready | degraded | failed",
        "durationMs": 1234,
        "degradedReason": "llm_fallback_failed"
      }
    ]
  }
}
```

`meta.llmJudge` 用于表达 LLM 层的成功/失败与耗时；`meta.runState / stageStatuses` 用于前端和 API 消费方区分完整成功、部分降级和硬失败。

**429、超时、JSON 解析失败的重试、熔断、退避策略**

当前实现：

- `ZEVAL_JUDGE_RETRY_ATTEMPTS` 控制最大重试次数，默认 3。
- 408 / 409 / 425 / 429 / 5xx / timeout / network 会重试。
- 重试延迟使用指数退避 + jitter。
- JSON 解析失败、无有效内容等非瞬态错误不重试，直接进入失败 / 降级路径。
- 所有失败会记录 `errorClass`，包括 `rate_limited / timeout / provider_4xx / provider_5xx / invalid_response / network / unknown`。
- stage-local 轻量熔断已落地：`ZEVAL_JUDGE_CIRCUIT_BREAKER_FAILURES` 控制连续失败阈值，`ZEVAL_JUDGE_CIRCUIT_BREAKER_COOLDOWN_MS` 控制冷却期；熔断命中会记录 `errorClass=circuit_open` 并走原有降级 / 抛错策略。

MVP 边界：

- 做重试、退避、全局并发池、错误分类、进程内 stage-local 轻量熔断。
- 暂不做持久化熔断状态，不把单进程熔断同步到多实例或跨部署环境。
- 暂不做供应商多活切换。
- 后续如接入 `judge_runs`，可把熔断状态升级为滑动窗口统计，而不是仅按当前进程内连续失败计数。

## 降级语义

| useLlm | judgeRequired | 入口行为 | LLM 调用失败时 | 用户可见结果 |
| --- | --- | --- | --- | --- |
| `true` | `true`（默认） | 正常进入评估 | 任一强依赖 Judge 失败会抛错 | 同步 JSON 返回 500；SSE 返回 `type=error`；async job 标记失败 |
| `true` | `false` | 正常进入评估 | session 级回退规则结果，记录 fallback rule / `meta.llmJudge.failedRequests` | 返回 200 / SSE result / job success，`subjectiveMetrics.status=degraded` |
| `false` | `false` | 正常进入规则模式 | 不调用 LLM | 返回 200 / SSE result / job success，`subjectiveMetrics.status=degraded`，`meta.llmJudge.enabled=false` |
| `false` | `true` | route 层拒绝；pipeline 层也有保护 | 不进入评估 | 同步 / SSE / async 入队前返回 400，错误文案为“当前产品链路要求 LLM Judge 必须开启...” |

持久化与投影失败不属于主评估链路失败：

- 同步 JSON：`persistEvaluateResult` 或 evaluation projection 写入失败会追加到 `meta.warnings`，不阻断 200 响应。
- `stream=1` SSE：同样追加到 `result.meta.warnings`，继续发送 `type=result`。
- `asyncMode`：queued job 现在同样把保存 / projection 失败写入 `warnings`，job 仍可成功返回评估摘要。

## 运行时观测

每次 `requestSiliconFlowChatCompletion` 都会记录不含 prompt / transcript 的元数据：

```json
{
  "stage": "segment_emotion_baseline",
  "status": "success",
  "queuedMs": 12,
  "durationMs": 1840,
  "attempts": 1,
  "model": "Qwen/Qwen3.5-27B",
  "promptVersion": "segment-emotion-baseline-v1.0.0",
  "sessionId": "s1",
  "segmentId": "s1_topic_1"
}
```

失败请求会额外携带：

```json
{
  "errorClass": "rate_limited",
  "degradedReason": "SiliconFlow 请求失败: 429"
}
```

评估响应会在 `meta.llmJudge` 中返回聚合结果：

- `totalRequests / succeededRequests / failedRequests`
- `stages[].avgQueuedMs / avgDurationMs / maxAttempts`
- `recentRequests[]` 最近 20 条请求级 metadata

这些字段用于排查限流、超时、JSON 解析失败和队列堆积，不进入用户侧解释结论。

## 后续建议

1. 如果要上线 `auto_disagreement`，先设计双轨评估产物：规则轨结果、LLM 轨结果、冲突阈值、人工校准标签和入池状态。
2. 瘦日志下 `auto_fn` 应命名为 FN-proxy，只覆盖文本可见异常，如重复问、负向尾词、异常收尾。
3. 后续 Supabase 投影可把 `meta.llmJudge.recentRequests` 中的排队耗时、attempt、stage、sessionId、segmentId、errorClass 落到 `judge_runs`，用于跨 run 排查供应商限流和延迟峰值。
