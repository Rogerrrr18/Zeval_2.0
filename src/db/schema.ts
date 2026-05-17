/**
 * @fileoverview Relational schema constants and TypeScript record contracts.
 *
 * P1 重构：
 *  - 移除 DbTopicSegment / DbBusinessKpiSignal / topic_segments / business_kpi_signals
 *  - 移除 zerore_records / workspaces / users / workspace_members 旧兼容层
 *  - 新增 DbIntentSequence / DbIntentRunLog / DbIntentEvalMetrics / DbSuggestion
 *  - 新增 DbSession / DbMessageTurn（P1 落库）
 *  - 所有信号表不再使用 workspaceId 字段，改用 projectId（uuid string）
 *
 * P2 新增：
 *  - DbBaseline / DbBaselineRun / DbOnlineEvalRun / DbReplayTurn / DbRunComparison
 */

// ── Table name registry ──────────────────────────────────────────────────────

export const DB_TABLES = [
  // Org & Project
  "organizations",
  "projects",
  "project_members",
  "api_keys",
  "audit_logs",
  // Data ingestion
  "datasets",
  "dataset_imports",
  "sessions",
  "message_turns",
  "turn_enrichments",
  // Evaluation pipeline
  "evaluation_runs",
  "judge_runs",
  "intent_sequences",
  "intent_run_logs",
  "intent_eval_metrics",
  // Signal layer
  "objective_signals",
  "subjective_signals",
  "risk_tags",
  "evidence_spans",
  "suggestions",
  // Baseline & online eval
  "baselines",
  "baseline_runs",
  "online_eval_runs",
  "replay_turns",
  "run_comparisons",
  // Eval dataset & regression
  "eval_cases",
  "eval_case_baselines",
  "eval_case_candidates",
  "dataset_admission_rules",
  "sample_batches",
  "sample_batch_cases",
  "capability_attributions",
  "experiment_routes",
  "validation_runs",
  "validation_results",
  "validation_generalization_reports",
  // Synthesis
  "synthesis_templates",
  "synthesis_runs",
  "synthesized_samples",
  // Remediation
  "remediation_packages",
  "remediation_artifacts",
  // Async (Post-MVP)
  "agent_runs",
  "jobs",
] as const;

export type DbTableName = (typeof DB_TABLES)[number];

// ── Shared types ─────────────────────────────────────────────────────────────

export type DbEvalSource = "raw" | "rule" | "llm" | "inferred" | "fallback" | "human" | "system" | "import";

export type JsonObject = Record<string, unknown>;

/**
 * Base entity fields shared by all typed DB records.
 * Uses uuid strings for all IDs (matching new UUID primary key schema).
 */
export type DbBaseRecord = {
  id: string;
  projectId: string;
  createdAt: string;
};

// ── Data ingestion: sessions & message turns ─────────────────────────────────

/**
 * One conversation session (maps to `sessions` table).
 * `externalSessionId` is the caller-supplied sessionId from the raw chatlog.
 */
export type DbSession = DbBaseRecord & {
  table: "sessions";
  externalSessionId: string;
  datasetId?: string;
  normalizedTranscriptHash?: string;
  startedAt?: string;
  endedAt?: string;
  metadata?: JsonObject;
};

/**
 * One message turn within a session (maps to `message_turns` table).
 * `sessionId` references `DbSession.id` (not the external session id string).
 */
export type DbMessageTurn = DbBaseRecord & {
  table: "message_turns";
  sessionId: string;
  turnIndex: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  timestampRaw?: string;
  tokenCountEstimate?: number;
  metadata?: JsonObject;
};

// ── Evaluation runs ──────────────────────────────────────────────────────────

export type DbEvaluationRun = DbBaseRecord & {
  table: "evaluation_runs";
  runKey: string;
  scenarioId?: string;
  status: string;
  useLlm: boolean;
  dynamicReplayEnabled: boolean;
  sessionCount: number;
  messageCount: number;
  hasTimestamp: boolean;
  warnings: string[];
  reportPayload?: JsonObject;
  artifactUri?: string;
  generatedAt: string;
};

// ── LLM Judge ────────────────────────────────────────────────────────────────

export type DbJudgeRunStatus = "succeeded" | "parse_failed" | "http_failed" | "skipped";

export type DbJudgeRun = DbBaseRecord & {
  table: "judge_runs";
  evaluationRunId: string;
  stage: string;
  model: string;
  promptVersion?: string;
  inputRef?: JsonObject;
  outputJson?: JsonObject;
  status: DbJudgeRunStatus;
  latencyMs?: number;
  errorMessage?: string;
};

// ── Intent Pointer ────────────────────────────────────────────────────────────

export type DbIntentSequence = DbBaseRecord & {
  table: "intent_sequences";
  evaluationRunId: string;
  sessionId: string;
  schemaVersion: string;
  schemaLockRevision: number;
  intentSequence: JsonObject[];
  refillables: JsonObject[];
  lockStatus: "draft" | "locked";
  intentCount: number;
  refillableCount: number;
  extractJudgeRunId?: string;
  updatedAt: string;
};

export type DbIntentJudgeLabel =
  | "SATISFIED"
  | "NOT_SATISFIED"
  | "DEVIATION"
  | "FALLBACK_NOT_SATISFIED"
  | "SKIPPED_GEN_FAILURE";

export type DbIntentRunLog = DbBaseRecord & {
  table: "intent_run_logs";
  evaluationRunId: string;
  sessionId: string;
  intentSequenceId: string;
  intentIndex: number;
  turnCount: number;
  budget: number;
  userText: string;
  assistantText: string;
  judgeLabel: DbIntentJudgeLabel;
  rationale?: string;
  evidenceQuote?: string;
  events: string[];
  simuserJudgeRunId?: string;
  intentJudgeRunId?: string;
};

export type DbIntentEvalMetrics = DbBaseRecord & {
  table: "intent_eval_metrics";
  evaluationRunId: string;
  sessionId: string;
  intentSequenceId: string;
  intentCompletionRate: number;
  clarificationEfficiency: number;
  deviationRate: number;
  turnEfficiency: number;
  intentCount: number;
  satisfiedCount: number;
  budgetFailedCount: number;
  totalReplayTurns: number;
  skippedReason?: string;
};

// ── Signal layer ─────────────────────────────────────────────────────────────

export type DbEvidenceSpan = DbBaseRecord & {
  table: "evidence_spans";
  evaluationRunId?: string;
  sessionId?: string;
  intentIndex?: number;
  evidenceKind: string;
  quote: string;
  startTurn?: number;
  endTurn?: number;
  source: DbEvalSource;
  metadata?: JsonObject;
};

export type DbObjectiveSignal = DbBaseRecord & {
  table: "objective_signals";
  evaluationRunId: string;
  sessionId?: string;
  metricKey: string;
  numericValue?: number;
  stringValue?: string;
  jsonValue?: unknown;
  source: DbEvalSource;
  confidence?: number;
  evidenceSpanId?: string;
};

export type DbSubjectiveSignal = DbBaseRecord & {
  table: "subjective_signals";
  evaluationRunId: string;
  sessionId?: string;
  intentIndex?: number;
  dimensionKey: string;
  dimensionLabel?: string;
  score: number;
  reason: string;
  source: DbEvalSource;
  confidence?: number;
  evidenceSpanId?: string;
  judgeRunId?: string;
};

export type DbRiskTag = DbBaseRecord & {
  table: "risk_tags";
  evaluationRunId: string;
  sessionId?: string;
  intentIndex?: number;
  tagKey: string;
  score?: number;
  severity?: string;
  reason?: string;
  triggeredRules?: JsonObject;
  source: DbEvalSource;
  confidence?: number;
  evidenceSpanId?: string;
};

export type DbSuggestion = DbBaseRecord & {
  table: "suggestions";
  evaluationRunId: string;
  title: string;
  problem: string;
  impact: string;
  action: string;
  triggerMetricKeys: string[];
  evidenceSpanId?: string;
  priority: number;
};

// ── P2: Baseline & Online Eval ───────────────────────────────────────────────

/**
 * One saved baseline group (maps to `baselines` table).
 * A baseline is a named anchor run per customer/project.
 */
export type DbBaseline = DbBaseRecord & {
  table: "baselines";
  customerId: string;
  name: string;
};

/**
 * One individual evaluation run that was saved under a baseline (maps to `baseline_runs` table).
 * `snapshotPayload` stores the full WorkbenchBaselineSnapshot JSON for offline lookup.
 */
export type DbBaselineRun = DbBaseRecord & {
  table: "baseline_runs";
  baselineId: string;
  sourceEvaluationRunId?: string;
  snapshotPayload?: JsonObject;
};

/**
 * One online evaluation run (maps to `online_eval_runs` table).
 * Created each time the user triggers a live replay against a baseline.
 */
export type DbOnlineEvalRun = DbBaseRecord & {
  table: "online_eval_runs";
  baselineRunId?: string;
  currentEvaluationRunId?: string;
  replyApiUrl: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

/**
 * One replayed turn captured during an online evaluation (maps to `replay_turns` table).
 */
export type DbReplayTurn = DbBaseRecord & {
  table: "replay_turns";
  onlineEvalRunId: string;
  sessionId?: string;
  turnIndex: number;
  role: "user" | "assistant";
  content: string;
  latencyMs?: number;
  status: "ok" | "timeout" | "error";
  errorMessage?: string;
};

/**
 * Per-metric comparison between baseline and current run (maps to `run_comparisons` table).
 */
export type DbRunComparison = DbBaseRecord & {
  table: "run_comparisons";
  onlineEvalRunId: string;
  baselineRunId: string;
  currentEvaluationRunId?: string;
  metricKey: string;
  baselineValue?: number;
  currentValue?: number;
  delta?: number;
  direction?: "better" | "worse" | "neutral" | "unknown";
  metadata?: JsonObject;
};

// ── Unions ────────────────────────────────────────────────────────────────────

export type DbQualitySignal =
  | DbObjectiveSignal
  | DbSubjectiveSignal
  | DbRiskTag;

export type DbEvaluationProjectionRecord =
  | DbSession
  | DbMessageTurn
  | DbEvaluationRun
  | DbJudgeRun
  | DbIntentSequence
  | DbIntentRunLog
  | DbIntentEvalMetrics
  | DbEvidenceSpan
  | DbQualitySignal
  | DbSuggestion;

export type DbBaselineProjectionRecord =
  | DbBaseline
  | DbBaselineRun;

export type DbOnlineEvalProjectionRecord =
  | DbOnlineEvalRun
  | DbReplayTurn
  | DbRunComparison;

export const EVALUATION_PROJECTION_TABLES = [
  "sessions",
  "message_turns",
  "evaluation_runs",
  "judge_runs",
  "intent_sequences",
  "intent_run_logs",
  "intent_eval_metrics",
  "objective_signals",
  "subjective_signals",
  "risk_tags",
  "evidence_spans",
  "suggestions",
] as const satisfies readonly DbTableName[];

export type EvaluationProjectionTableName = (typeof EVALUATION_PROJECTION_TABLES)[number];
