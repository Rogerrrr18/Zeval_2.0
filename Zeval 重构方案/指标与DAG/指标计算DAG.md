# 指标计算 DAG

> 推荐配套查看交互可视化版本：[`指标计算DAG.html`](./指标计算DAG.html)。该 HTML 用 Cytoscape + dagre 自动布局，节点全中文、按层着色，可切换 LLM 节点显隐与查看节点详情，渲染效果优于 Mermaid。

## 总览

```mermaid
flowchart TD
  RAW[RawChatlogRow<br/>sessionId timestamp role content]
  NORM[NormalizedChatlogRow<br/>turnIndex timestampMs activeHour]
  SEG[Topic Segments<br/>topicSegmentId summary confidence]
  EMO[Segment Emotion<br/>baseScore + local weights]
  ROW[Row Enrichment<br/>gap question dropoff switch token]
  ENR[EnrichedChatlogRow]

  OBJ[Objective Metrics]
  SIG[Implicit Signals]
  DIM[Subjective Dimension Judge]
  GOAL[Goal Completion]
  REC[Recovery Trace]
  SUBJ[Subjective Metrics]
  CHART[Charts]
  SUG[Suggestions]
  SUM[Summary Cards]
  DB[Supabase Signals + Evidence]

  RAW --> NORM --> SEG --> EMO --> ROW --> ENR
  ENR --> OBJ
  ENR --> SIG
  ENR --> DIM
  SIG --> DIM
  ENR --> GOAL
  GOAL --> REC
  DIM --> SUBJ
  GOAL --> SUBJ
  REC --> SUBJ
  OBJ --> CHART
  ENR --> CHART
  OBJ --> SUG
  SIG --> SUG
  SUBJ --> SUG
  OBJ --> SUM
  SUBJ --> SUM
  ENR --> DB
  OBJ --> DB
  SIG --> DB
  SUBJ --> DB
  SUG --> DB
```

## LLM 介入 DAG

```mermaid
flowchart TD
  SEG_RULE[规则 topic 切分] --> GAP{长间隔且不确定?}
  GAP -->|是| LLM_TOPIC[LLM: topic_continuity_review]
  GAP -->|否| SEG_OUT[TopicSegment]
  LLM_TOPIC --> SEG_OUT

  SEG_OUT --> EMO_NEED{useLlm?}
  EMO_NEED -->|是| LLM_EMO[LLM: segment_emotion_baseline]
  EMO_NEED -->|否| RULE_EMO[规则情绪基准]
  LLM_EMO --> EMO_WEIGHT[本地情绪权重修正]
  RULE_EMO --> EMO_WEIGHT

  EMO_WEIGHT --> ENR[EnrichedRows]
  ENR --> RULE_SIG[规则隐式信号]
  ENR --> LLM_DIM[LLM: subjective_dimension_judge]
  RULE_SIG --> LLM_DIM
  ENR --> GOAL_RULE[规则 goal completion]
  GOAL_RULE --> UNCLEAR{规则不清晰?}
  UNCLEAR -->|是| LLM_GOAL[LLM: goal_completion_judge]
  UNCLEAR -->|否| GOAL_OUT[GoalCompletion]
  LLM_GOAL --> GOAL_OUT
  GOAL_OUT --> REC_RULE[规则 recovery trace]
  REC_RULE --> COMPLETED{存在恢复轨迹?}
  COMPLETED -->|是| LLM_REC[LLM: recovery_trace_strategy]
  COMPLETED -->|否| REC_OUT[RecoveryTrace]
  LLM_REC --> REC_OUT
```

## 输出落点

| 输出 | 目标 Supabase 表 |
| --- | --- |
| 评估运行元数据 | `evaluation_runs` |
| 对话消息 | `sessions`、`message_turns` |
| 主题片段 | `topic_segments` |
| 客观指标 | `objective_signals` |
| 隐式推断 | `risk_tags` |
| 主观指标 | `subjective_signals` |
| LLM 调用记录 | `judge_runs` |
| 证据片段 | `evidence_spans` |
| 优化建议 | `suggestions` |
| 图表与报告 | `report_artifacts` 或 `evaluation_runs.report_payload` |
