/**
 * @fileoverview Relational schema constants and record contracts.
 *
 * These types mirror database/schema.sql and give the application a stable
 * vocabulary before the Postgres adapter is introduced.
 */

export const DB_TABLES = [
  "organizations",
  "projects",
  "workspaces",
  "users",
  "project_members",
  "workspace_members",
  "api_keys",
  "audit_logs",
  "zerore_records",
  "datasets",
  "dataset_imports",
  "sessions",
  "message_turns",
  "scenario_contexts",
  "evaluation_runs",
  "topic_segments",
  "objective_signals",
  "subjective_signals",
  "business_kpi_signals",
  "evidence_spans",
  "risk_tags",
  "gold_sets",
  "gold_cases",
  "gold_annotation_tasks",
  "gold_label_drafts",
  "gold_labels",
  "judge_runs",
  "judge_predictions",
  "judge_agreement_reports",
  "judge_drift_reports",
  "bad_cases",
  "bad_case_tags",
  "bad_case_clusters",
  "remediation_packages",
  "remediation_artifacts",
  "agent_runs",
  "validation_runs",
  "validation_results",
  "jobs",
] as const;

export type DbTableName = (typeof DB_TABLES)[number];

export type DbWorkspaceRole = "owner" | "admin" | "member" | "viewer";

export type DbJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type DbEvalSource = "raw" | "rule" | "llm" | "inferred" | "fallback" | "human" | "system" | "import";

export type DbReviewStatus = "draft" | "in_review" | "approved" | "rejected" | "needs_changes";

export type DbValidationRunStatus = "queued" | "running" | "passed" | "failed" | "errored" | "canceled";

export type JsonObject = Record<string, unknown>;

export type DbBaseEntity = {
  id: string;
  organizationId?: string;
  projectId?: string;
  workspaceId: string;
  createdAt: string;
};

export type DbEvaluationRun = DbBaseEntity & {
  table: "evaluation_runs";
  datasetId?: string;
  scenarioContextId?: string;
  runId: string;
  scenarioId?: string;
  status: string;
  useLlm: boolean;
  sessionCount: number;
  messageCount: number;
  hasTimestamp: boolean;
  warnings: string[];
  artifactUri?: string;
  rawResponse?: JsonObject;
  generatedAt: string;
};

export type DbTopicSegment = DbBaseEntity & {
  table: "topic_segments";
  evaluationRunId: string;
  sessionId: string;
  topicSegmentId: string;
  topicSegmentIndex: number;
  label: string;
  summary: string;
  source: DbEvalSource;
  confidence: number;
  startTurn: number;
  endTurn: number;
  messageCount: number;
  emotionPolarity?: string;
  emotionIntensity?: string;
  emotionScore?: number;
  metadata?: JsonObject;
};

export type DbEvidenceSpan = DbBaseEntity & {
  table: "evidence_spans";
  evaluationRunId?: string;
  sessionId?: string;
  turnId?: string;
  topicSegmentId?: string;
  evidenceKind: string;
  quote: string;
  startTurn?: number;
  endTurn?: number;
  source: DbEvalSource;
  metadata?: JsonObject;
};

export type DbObjectiveSignal = DbBaseEntity & {
  table: "objective_signals";
  evaluationRunId: string;
  sessionId?: string;
  topicSegmentId?: string;
  metricKey: string;
  metricLabel?: string;
  numericValue?: number;
  stringValue?: string;
  jsonValue?: unknown;
  reason?: string;
  source: DbEvalSource;
  confidence?: number;
  evidenceSpanId?: string;
};

export type DbSubjectiveSignal = DbBaseEntity & {
  table: "subjective_signals";
  evaluationRunId: string;
  sessionId?: string;
  topicSegmentId?: string;
  dimensionKey: string;
  dimensionLabel?: string;
  score: number;
  reason: string;
  source: DbEvalSource;
  confidence: number;
  evidenceSpanId?: string;
  judgeRunId?: string;
  promptVersion?: string;
};

export type DbBusinessKpiSignal = DbBaseEntity & {
  table: "business_kpi_signals";
  evaluationRunId: string;
  sessionId?: string;
  kpiKey: string;
  status?: string;
  score?: number;
  value: JsonObject;
  reason?: string;
  source: DbEvalSource;
  confidence?: number;
  evidenceSpanId?: string;
};

export type DbRiskTag = DbBaseEntity & {
  table: "risk_tags";
  evaluationRunId: string;
  sessionId?: string;
  topicSegmentId?: string;
  tagKey: string;
  severityScore?: number;
  reason?: string;
  evidenceSpanId?: string;
  source: DbEvalSource;
};

export type DbQualitySignal =
  | DbObjectiveSignal
  | DbSubjectiveSignal
  | DbBusinessKpiSignal
  | DbRiskTag;

export type DbEvaluationProjectionRecord =
  | DbEvaluationRun
  | DbTopicSegment
  | DbEvidenceSpan
  | DbQualitySignal;

export const EVALUATION_PROJECTION_TABLES = [
  "evaluation_runs",
  "topic_segments",
  "objective_signals",
  "subjective_signals",
  "business_kpi_signals",
  "evidence_spans",
  "risk_tags",
] as const satisfies readonly DbTableName[];

export type EvaluationProjectionTableName = (typeof EVALUATION_PROJECTION_TABLES)[number];
