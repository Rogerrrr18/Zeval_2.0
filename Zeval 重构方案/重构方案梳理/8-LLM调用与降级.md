# 8-LLM 调用与降级

本文档约束 Zeval 中所有 LLM Judge 调用的输入、输出、降级和可观测性。所有 LLM 调用必须落到 `judge_runs` 表（详见 `5-后端方案-Supabase.md` 与 `../可复用组件/supabase-target-schema.sql`）。

## 8.1 LLM Provider 与配置

- 默认 Provider：SiliconFlow（OpenAI 兼容协议）。
- 默认模型：`Qwen/Qwen3.5-27B`（思考型模型，必须显式关闭 thinking）。
- 环境变量：见 `../可复用组件/siliconflow-env.template`。
- 必须显式关闭思考输出，**两个开关都要置为 false**，缺一不可：
  - `ZEVAL_JUDGE_ENABLE_THINKING=false`
  - `SILICONFLOW_ENABLE_THINKING=false`
  否则 Qwen3.5-27B 等思考模型会只输出 `reasoning_content` 而 `content` 为空，导致 `subjective_dimension_judge` / `goal_completion_judge` 等阶段的 JSON 解析失败，触发整段降级。
- Provider 必须可替换：通过 `ZEVAL_JUDGE_BASE_URL` + `ZEVAL_JUDGE_MODEL` 切换其它 OpenAI-compatible gateway；切换非思考模型时仍需保留两个开关为 false，避免误用思考模型。
- 服务启动时建议在 `judge_runs` 写入第一条 `stage = "boot_check"` 的探针记录，确认连通性与 thinking 关闭状态。

## 8.2 LLM Judge 阶段定义

| Stage | 触发条件 | 输入粒度 | 期望输出 |
| --- | --- | --- | --- |
| `topic_continuity_review` | 长间隔（≥180s）且规则切分置信度低，且 `useLlm=true` | 相邻主题上下文片段 | `{ "isContinuation": boolean, "reason": string, "confidence": number }` |
| `segment_emotion_baseline` | `useLlm=true` 时按 topic segment 调用 | topic segment 内对话 + 上文情绪 | `{ "polarity": "positive|neutral|negative|complex", "intensity": "low|medium|high", "baseScore": number, "evidence": string, "confidence": number }` |
| `subjective_dimension_judge` | `useLlm=true` 时按 session 调用 | session transcript + 隐式信号摘要 | `{ "dimensions": [ { "dimension": string, "score": number, "reason": string, "evidence": string, "confidence": number } ] }` |
| `goal_completion_judge` | 规则结果 `unclear` 且 `useLlm=true` | session transcript | `{ "status": "achieved|partial|failed|unclear", "score": number, "userIntent": string, "evidence": string, "confidence": number }` |
| `recovery_trace_strategy` | 已有规则 `completed` 恢复轨迹，且 `useLlm=true` | failure / recovery span | `{ "strategy": string, "qualityScore": number, "evidence": string, "confidence": number }` |
| `sample_synthesize` | 客户主动调用合成接口 | scenarioBrief + longTailHints + personas | `{ "transcript": [...], "expectedFailures": [...], "tags": [...] }` |
| `sample_synthesize_review` | 合成后自校验 | 合成 transcript + 期望模式 | `{ "alignmentScore": number, "redundancy": number, "issues": [...] }` |

## 8.3 Prompt 版本与变量

- 每个 stage 的 system prompt 必须带版本号，如 `topic_continuity_review.v1.0.0`。
- 版本号写入 `judge_runs.prompt_version`。
- prompt 变量必须可序列化为 JSON，且不直接拼接用户输入到指令区。
- 用户内容区使用结构化 schema：`{ "role": "user", "content": "...", "turnIndex": 0 }`。

## 8.4 输出解析与失败处理

- 所有响应必须是 JSON。模型未给出 JSON 时进入解析失败路径。
- 解析步骤：`JSON.parse` → schema 校验（zod）→ 入库。
- 任意一步失败：
  1. 记录 `judge_runs.status = "parse_failed"`，保留原始响应到 `judge_runs.error_message`。
  2. 不抛硬错误，让上游决定是否走降级。
- LLM HTTP 失败（超时、5xx、限流）：记录 `judge_runs.status = "http_failed"`，自动重试至多 1 次（指数退避 1s/2s）。

## 8.5 各阶段降级行为

| Stage | LLM 失败时的行为 |
| --- | --- |
| `topic_continuity_review` | 退回规则切分结果，`topicSource = "rule"`，`topicConfidence` 按规则给出 |
| `segment_emotion_baseline` | 用规则情绪基准（正负向词、长度、节奏权重）替代，`emotionSource = "rule"` |
| `subjective_dimension_judge` | 当 `judgeRequired = true` 时，整个 run 标记 `subjectiveStatus = "unavailable"`，仅返回客观指标；当 `judgeRequired = false` 时，使用规则维度并标记 `source = "fallback"` |
| `goal_completion_judge` | 保持规则状态 `unclear`，并显式给出 `source = "rule"` |
| `recovery_trace_strategy` | 仅返回规则轨迹，不附策略与质量分 |

## 8.6 必须保留的可观测性字段

`judge_runs`：

| 字段 | 含义 |
| --- | --- |
| `id` | 调用 ID |
| `evaluation_run_id` | 关联评估运行 |
| `stage` | 上述 5 个 stage 之一 |
| `model` | 实际调用模型 |
| `prompt_version` | system prompt 版本号 |
| `input_ref` | 输入摘要（不需要存全量），含 sessionId、segmentId 等 |
| `output_json` | 解析后结构化输出（成功时） |
| `status` | `succeeded / parse_failed / http_failed / skipped` |
| `latency_ms` | 端到端耗时 |
| `error_message` | 失败时保存原始响应或错误 |

## 8.7 主观指标必须保留来源

所有 `subjective_signals` 行必须显式记录 `source` 字段，取值范围：

- `llm`：LLM 调用成功并解析。
- `rule`：规则方法直接计算。
- `fallback`：原本应由 LLM 给出，因 LLM 失败而临时使用规则。
- `inferred`：仅适用于隐式信号，本字段在 `risk_tags` 中使用。

禁止在前端把 `fallback` 显示为 `llm` 来源。

## 8.8 速率与成本

- 评估单次 run 的 LLM 调用次数应可在 `evaluation_runs.metadata` 中估算（segment 数 + session 数 + goal/recovery 触发数）。
- 系统应支持设置全局 QPS / 并发上限，避免突发批量评估打爆 Provider。
- 异步评估优先入 `jobs`，避免长事务阻塞 web 进程。

## 8.9 Prompt 改动流程

1. 修改 prompt 时必须升版（语义变化升 minor，结构变化升 major）。
2. 改动需要通过 calibration 集合跑一次回归（详见 `11-测试与回归.md`），输出与上一版本的一致率。
3. 如果一致率低于阈值（建议 0.85），prompt 改动需要附带验证报告再合入。
