# 7-API 契约

本文档约束重构后必须保留的 API 请求与响应契约，确保前端、SDK、回归脚本不需要重写。底层存储改为 Supabase，但路径、方法、字段名不得变更。除特别说明外，所有响应使用 `application/json`。

---

## 7.1 通用约定

- 所有路由位于 `app/api/*`，由 Next.js App Router 提供。
- 入参字段使用 camelCase，响应字段使用 camelCase。
- 时间字段使用 ISO 8601（`2026-05-08T11:00:00.000Z`）。
- 失败响应统一为 `{ "error": { "code": "string", "message": "string", "details": object|null } }`。
- 错误码示例：`INVALID_REQUEST` / `LLM_UNAVAILABLE` / `STORAGE_FAILURE` / `NOT_FOUND` / `RATE_LIMITED`。

---

## 7.2 上传 / 解析 `POST /api/ingest`

请求：

```json
{
  "format": "csv",
  "filename": "support-refund.csv",
  "content": "sessionId,timestamp,role,content\n...",
  "mappingPlanId": "optional-mapping-plan-id"
}
```

响应（节选）：

```json
{
  "rawRows": [
    { "sessionId": "s1", "timestamp": "2026-05-06T00:00:00.000Z", "role": "user", "content": "..." }
  ],
  "canonicalCsvPreview": "sessionId,timestamp,role,content\n...",
  "structuredTaskMetrics": { "...": "..." },
  "warnings": ["string"],
  "piiRedaction": { "applied": true, "stats": {} }
}
```

约束：

- 支持 `csv / json / txt / md` 四种 `format`。
- 当字段映射不确定时，调用 data-onboarding 生成 mapping plan，返回 `warnings` 让前端提示用户复核。
- `rawRows` 必须按 `(sessionId, timestamp ?? insertion order)` 排序。

---

## 7.3 评估 `POST /api/evaluate`

请求：

```json
{
  "useLlm": true,
  "judgeRequired": true,
  "scenarioId": null,
  "rawRows": [ /* RawChatlogRow[] */ ],
  "extendedInputs": null,
  "stream": false,
  "asyncMode": false,
  "workspaceId": "default-project",
  "runId": "optional-run-id"
}
```

响应（核心字段保持不变）：

```json
{
  "runId": "string",
  "meta": {
    "generatedAt": "2026-05-08T11:00:00.000Z",
    "sessions": 12,
    "messages": 240,
    "hasTimestamp": true,
    "warnings": ["string"],
    "piiRedaction": {},
    "scenarioContext": null,
    "subjectiveStatus": "ok"
  },
  "objectiveMetrics": { /* 见 2-主客观指标说明.md */ },
  "subjectiveMetrics": {
    "emotionCurve": [ { "sessionId": "s1", "turnIndex": 1, "emotionScore": 70 } ],
    "emotionTurningPoints": [],
    "dimensions": [
      { "dimension": "empathy", "score": 4, "reason": "...", "evidence": "...", "confidence": 0.82, "source": "llm", "judgeRunId": "..." }
    ],
    "signals": [
      { "signalKey": "interestDeclineRisk", "score": 0.62, "severity": "medium", "reason": "...", "evidence": "...", "evidenceTurnRange": "s1:8-12", "triggeredRules": ["..."], "source": "inferred" }
    ],
    "goalCompletions": [
      { "sessionId": "s1", "status": "achieved", "score": 4, "userIntent": "查询退款", "evidence": "..." }
    ],
    "recoveryTraces": []
  },
  "topicSegments": [],
  "charts": [
    { "id": "emotionCurve", "type": "line", "payload": { "x": [], "y": [] } }
  ],
  "summaryCards": [
    { "key": "avgResponseGap", "value": 18.4, "unit": "s", "label": "平均响应间隔" }
  ],
  "suggestions": [
    {
      "id": "string",
      "title": "尽早识别用户兴趣下降",
      "problem": "后段平均消息长度从 32 降到 9",
      "impact": "兴趣下降风险评分 0.62",
      "action": "在 4 轮内引入主动确认与价值复述",
      "triggerMetricKeys": ["interestDeclineRisk", "userMessageLengthTrend"],
      "evidenceSpanId": "string",
      "priority": 1
    }
  ],
  "badCaseAssets": [],
  "artifactPath": "optional-uri"
}
```

约束：

- `useLlm=false` 时返回客观指标完整、主观字段标记 `source: "fallback"`，`subjectiveStatus` 为 `degraded`。
- 流式（`?stream=1`）按 SSE 事件输出阶段进度，最终事件输出完整 JSON。
- 异步模式（`asyncMode=true`）返回 `{ "jobId": "..." }`，结果通过 `/api/jobs/[jobId]` 查询。

---

## 7.4 Data Onboarding `POST /api/data-onboarding`

请求：

```json
{ "format": "csv", "sample": "..." }
```

响应：

```json
{
  "mappingPlan": {
    "rules": [{ "from": "user_id", "to": "sessionId" }],
    "warnings": []
  },
  "review": { "status": "ok", "agentReviewed": false }
}
```

---

## 7.5 Workbench Baseline

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/workbench-baselines` | POST | 创建 baseline 快照 |
| `/api/workbench-baselines/[customerId]` | GET | 列出某客户 baseline |
| `/api/workbench-baselines/[customerId]/[runId]` | GET | 读取 baseline 详细数据 |
| `/api/workbench-baselines/[customerId]/trend` | GET | baseline 趋势聚合 |

POST 请求：

```json
{
  "customerId": "acme-support",
  "name": "v1 baseline",
  "sourceEvaluationRunId": "evr_xxx",
  "rawRows": [ /* 可选保存原始 rawRows */ ],
  "snapshot": { /* EvaluateResponse 关键字段 */ }
}
```

POST 响应：

```json
{ "baselineId": "bl_xxx", "baselineRunId": "blr_xxx", "createdAt": "..." }
```

GET 列表响应：

```json
{
  "baselines": [
    {
      "baselineRunId": "blr_xxx",
      "customerId": "acme-support",
      "name": "v1 baseline",
      "createdAt": "...",
      "summaryCards": [],
      "sourceEvaluationRunId": "evr_xxx"
    }
  ]
}
```

---

## 7.6 在线评测 `POST /api/online-eval/replay`

请求：

```json
{
  "baselineRunId": "blr_xxx",
  "replyApi": {
    "url": "https://customer.example.com/reply",
    "auth": { "type": "none|bearer|custom", "token": "optional" },
    "timeoutMs": 8000
  },
  "useLlm": true
}
```

响应：

```json
{
  "onlineEvalRunId": "oer_xxx",
  "currentEvaluationRunId": "evr_yyy",
  "comparison": {
    "objective": { "avgResponseGapSec": { "baseline": 18, "current": 12, "delta": -6 } },
    "subjective": { "empathy": { "baseline": 3, "current": 4, "delta": 1 } },
    "risk": { "interestDeclineRisk": { "baseline": 0.7, "current": 0.42, "delta": -0.28 } }
  },
  "warnings": []
}
```

约束：

- 回放过程必须保留 user 行原始内容，仅 assistant 行通过外部 API 重新生成。
- 当外部 API 超时或非 2xx，记录为 `replay_turns.status="failed"`，整次 run 仍要返回部分对比结果。

---

## 7.7 评测集 `eval-datasets`

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/eval-datasets/cases` | GET / POST | 列出 / 创建 case；GET 支持 `source`（8 类，详见 13 号文档）/ `capability` / `failureLayer` / `caseSetType` 过滤 |
| `/api/eval-datasets/cases/[caseId]` | GET / PATCH | 读取 / 更新 case；PATCH 支持 `metadata.false_positive` |
| `/api/eval-datasets/candidates` | GET / PATCH | 列出自动入池候选；PATCH `decision` 接受 / 拒绝候选 |
| `/api/eval-datasets/admission-rules` | GET / POST | 列出 / 创建自动入池规则 |
| `/api/eval-datasets/admission-rules/[id]` | GET / PATCH / DELETE | 单规则维护 |
| `/api/eval-datasets/sample-batches` | GET / POST | 列出 / 创建 sample batch；POST 支持 `includeSynthesized` 控制是否纳入合成样本 |
| `/api/eval-datasets/sample-batches/[id]` | GET | 读取 batch |
| `/api/eval-datasets/harvest-badcases` | POST | 跑自动入池规则；返回 `accepted / skippedDuplicates / skippedFalsePositive / pendingReview` 计数 |
| `/api/eval-datasets/clusters` | GET | 簇 / 聚合 |
| `/api/eval-datasets/synthesize` | POST | 长尾样本合成入口（详见 `14-样本合成与长尾覆盖.md`） |
| `/api/eval-datasets/synthesis-runs` | GET | 列出最近合成运行 |
| `/api/eval-datasets/synthesis-runs/[id]` | GET | 查询合成详情与样本 |
| `/api/eval-datasets/synthesis-templates` | GET / POST | 管理合成模板 |
| `/api/eval-datasets/synthesis-templates/[id]` | GET / PATCH / DELETE | 单模板维护 |

case 创建请求：

```json
{
  "caseSetType": "badcase",
  "title": "用户被 AI 反复劝退",
  "transcript": [
    { "role": "user", "content": "...", "timestamp": "..." }
  ],
  "labels": { "scenarioId": null, "tags": ["off_topic"] },
  "sourceEvaluationRunId": "evr_xxx",
  "allowNearDuplicate": false
}
```

case 创建响应：

```json
{
  "caseId": "case_xxx",
  "normalizedTranscriptHash": "sha256:...",
  "duplicate": { "exact": false, "near": [] }
}
```

sample batch 创建请求：

```json
{
  "name": "regression-202605",
  "targetGoodcaseCount": 10,
  "targetBadcaseCount": 10,
  "seed": "20260508",
  "filter": { "tags": [], "scenarioId": null }
}
```

sample batch 响应：

```json
{
  "sampleBatchId": "sb_xxx",
  "actualGoodcaseCount": 10,
  "actualBadcaseCount": 8,
  "warnings": ["badcase 不足，仅命中 8 条"],
  "cases": [{ "caseId": "case_xxx", "strata": "badcase", "position": 0 }]
}
```

---

## 7.8 调优包 `remediation-packages`

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/remediation-packages` | GET / POST | 列出 / 创建 |
| `/api/remediation-packages/[id]` | GET / PATCH | 读取 / 更新 |
| `/api/remediation-packages/[id]/agent-task` | GET | 关联 agent 任务视图 |
| `/api/remediation-packages/[id]/task-flow` | GET | 任务流只读视图 |
| `/api/remediation-packages/[id]/skill` | GET | Skill 元数据 + 下载 URL（详见 `12-调优包-Skill化交付.md`） |
| `/api/remediation-packages/[id]/skill/download` | GET | 下载 Skill zip（`Content-Disposition: attachment`） |
| `/api/remediation-packages/[id]/skill/regenerate` | POST | 重新打包 Skill |

POST 请求关键字段：

```json
{
  "name": "退款流程优化包",
  "scopeBadCaseIds": ["case_xxx"],
  "evaluationRunIds": ["evr_xxx"],
  "triggerMetricKeys": ["interestDeclineRisk", "empathyScore"],
  "metadata": {}
}
```

响应包含 artifact 列表（按文件名）：`SKILL.md`、`metadata.json`、`issue-brief.md`、`remediation-spec.yaml`、`badcases.jsonl`、`acceptance-gate.yaml`、`prompts/*`、`scripts/*`。`skill_version` 与 `skill_artifact_uri` 必填。

---

## 7.9 验证 / Agent / Jobs

- `/api/validation-runs`：POST 触发回归，GET 查询。请求体含 `sampleBatchId`、`evaluationStrategy`、`compareBaselineRunId`。
- `/api/agent-runs`：POST 创建 agent 执行记录，GET / PATCH 跟踪状态。
- `/api/jobs`：POST 入队，GET 查询 job 状态，PATCH 取消，POST `/run` 触发 worker。

---

## 7.10 Copilot Chat `POST /api/copilot/chat`

请求：

```json
{
  "messages": [{ "role": "user", "content": "解释下当前 baseline" }],
  "skillIds": ["explain_baseline"],
  "context": { "evaluationRunId": "evr_xxx" }
}
```

响应：

```json
{
  "reply": "...",
  "citations": [{ "metricKey": "empathyScore", "evidenceSpanId": "ev_xxx" }],
  "skillTrace": []
}
```

---

## 7.11 能力维度评测与归因（详见 [`15-能力维度评测与归因.md`](./15-能力维度评测与归因.md)）

### 7.11.1 列表 / 详情过滤参数扩展

- `GET /api/eval-datasets/cases` 增加：
  - `capability`：12 个能力维度白名单值之一
  - `failureLayer`：L0–L8 之一
  - `source`：8 类来源之一（已在 13 号文档定义）
- `GET /api/eval-datasets/candidates` 同上参数。

### 7.11.2 `POST /api/copilot/diagnose-capability`

请求：

```json
{
  "userPainPoint": "我感觉 agent 多轮对话不太行",
  "context": { "projectId": "proj_xxx", "evaluationRunId": "evr_xxx" }
}
```

响应：

```json
{
  "candidates": [
    { "capabilityDimension": "multi_turn_coherence", "confidence": 0.82 },
    { "capabilityDimension": "long_context_reasoning", "confidence": 0.34 }
  ],
  "clarificationQuestion": "你是指上下文丢失，还是改变话题后无法回到主线？"
}
```

### 7.11.3 `POST /api/copilot/attribute-failure`

请求：

```json
{
  "evalCaseIds": ["case_xxx"],
  "method": "rule | llm_classifier | experiment | auto"
}
```

响应：

```json
{
  "attributions": [
    {
      "evalCaseId": "case_xxx",
      "failureLayer": "L5_tool_selection",
      "confidence": 0.78,
      "method": "llm_classifier",
      "evidence": [],
      "layerProbability": {},
      "experimentSuggestion": {}
    }
  ]
}
```

### 7.11.4 `POST /api/copilot/suggest-optimization-path`

请求：

```json
{
  "capabilityDimension": "multi_turn_coherence",
  "attributionSummary": { "L3_memory": 0.73, "L0_model": 0.18 },
  "candidateMatrix": null
}
```

响应：

```json
{
  "rankedActions": [
    { "action": "L3_memory:enable_summarization", "expectedLift": 0.15, "cost": "low", "rationale": "..." },
    { "action": "L0_model:switch_to_long_context_model", "expectedLift": 0.05, "cost": "high", "rationale": "..." }
  ]
}
```

### 7.11.5 `/api/experiments` 与 `/api/experiments/[id]`

- `POST /api/experiments`：创建实验路由。请求体含 `name / targetCapability / targetLayer / axis / candidates / evalDatasetId`。
- `GET /api/experiments`：列表，支持 `capability` 过滤。
- `GET /api/experiments/[id]`：详情含 `resultSummary` 与候选指标矩阵。
- `PATCH /api/experiments/[id]`：更新 `status` 与 `resultSummary`。

### 7.11.6 错误码

- `CAPABILITY_REQUIRED`：写入 case 时未提供 `capabilityDimension`。
- `FAILURE_LAYER_REQUIRED`：badcase 写入时未提供 `failureLayer`。
- `INVALID_CAPABILITY`：值不在白名单。
- `INVALID_LAYER`：值不在 L0–L8。
- `EXPERIMENT_AXIS_INVALID`：实验自变量未落到 9 层 harness。

---

## 7.12 兼容与版本

- 旧 `workspaceId` 字段允许在请求中保留，服务端按 `workspaceId === projectId` 处理。
- 不允许引入 `workspace_id` 作为长期字段；所有新字段以 `projectId` / `organizationId` 为准。
- 重构期间保持响应字段超集兼容：可以新增字段，但不能删除现有字段名。
