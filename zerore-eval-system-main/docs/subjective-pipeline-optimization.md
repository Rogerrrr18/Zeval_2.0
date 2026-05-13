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
7. `EvaluateResponse.meta.llmJudge` 增加运行时观测摘要，返回每个 LLM stage 的请求数、成功/失败、平均排队耗时、平均请求耗时、最大重试次数，以及最近 20 条请求的 session / segment / error metadata。

## 链路现状说明

| 阶段 | 代码入口 | LLM stage | 输入粒度 | 并发形态 | 失败行为 |
| --- | --- | --- | --- | --- | --- |
| normalize | `src/pipeline/enrich.ts` → `normalizeRawRows` | 无 | 全量 rows | 同步规则 | 不涉及 LLM |
| topic segment | `src/pipeline/segmenter.ts` → `buildTopicSegments` | `topic_continuity_review` | session 内长间隔相邻上下文 | session 顺序；LLM 请求进入全局池 | 当前为强调用；失败会让 parse stage 失败 |
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
ZEVAL_JUDGE_SEGMENT_CONCURRENCY=4
ZEVAL_JUDGE_SESSION_CONCURRENCY=4
ZEVAL_JUDGE_GOAL_CONCURRENCY=4
ZEVAL_JUDGE_RECOVERY_CONCURRENCY=4
ZEVAL_JUDGE_RETRY_ATTEMPTS=3
```

阶段级并发控制排队形态，全局并发控制供应商压力。实际发到模型网关的请求数不会超过全局上限。

## 降级语义

- `useLlm=false`：主观维度、goal、recovery 走规则路径，`subjectiveMetrics.status = degraded`。
- `judgeRequired=true` 且 `useLlm=false`：直接失败，避免用户误以为完成了强依赖 Judge。
- 单个 session 的 LLM 失败且 `judgeRequired=false`：该 session 回退规则结果，并在对应 `triggeredRules` 中记录 fallback 标记。
- 单个 session 的 LLM 失败且 `judgeRequired=true`：抛错，API 返回失败。

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
