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

## 后续建议

1. 如果要上线 `auto_disagreement`，先设计双轨评估产物：规则轨结果、LLM 轨结果、冲突阈值、人工校准标签和入池状态。
2. 瘦日志下 `auto_fn` 应命名为 FN-proxy，只覆盖文本可见异常，如重复问、负向尾词、异常收尾。
3. 后续 Supabase 投影可把每次 LLM 调用的排队耗时、attempt、stage、sessionId、segmentId 落到 `judge_runs`，用于排查供应商限流和延迟峰值。

