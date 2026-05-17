/**
 * @fileoverview Projection from EvaluateResponse into typed relational records.
 *
 * P1 重构：
 *  - 移除 DbTopicSegment / DbBusinessKpiSignal / workspaceId
 *  - 新增 intent_sequences / intent_run_logs / intent_eval_metrics 投影
 *  - 新增 suggestions 投影
 *  - 新增 sessions / message_turns 投影（P1 缺口补全）
 *  - 所有记录使用 projectId (uuid string)
 *  - 所有 ID 使用 stableUuid()（SHA-256 → UUID v5 format）以兼容 Postgres uuid 列
 *
 * P2 新增：
 *  - buildBaselineProjection() — 写入 baselines / baseline_runs
 *  - buildOnlineEvalProjection() — 写入 online_eval_runs / replay_turns / run_comparisons
 */

import { createHash } from "node:crypto";
import type { DbRecord, ZeroreDatabase } from "@/db";
import type {
  DbBaseline,
  DbBaselineRun,
  DbEvaluationProjectionRecord,
  DbEvaluationRun,
  DbEvidenceSpan,
  DbIntentEvalMetrics,
  DbIntentRunLog,
  DbIntentSequence,
  DbMessageTurn,
  DbObjectiveSignal,
  DbOnlineEvalRun,
  DbReplayTurn,
  DbRiskTag,
  DbRunComparison,
  DbSession,
  DbSubjectiveSignal,
  DbSuggestion,
} from "@/db/schema";
import type { EvaluateResponse, IntentRunLog, ObjectiveMetrics, RawChatlogRow } from "@/types/pipeline";
import type { WorkbenchBaselineSnapshot } from "@/workbench/types";

export type EvaluationProjectionOptions = {
  projectId: string;
  runId?: string;
  useLlm?: boolean;
  enableDynamicReplay?: boolean;
};

export type EvaluationProjection = {
  records: DbEvaluationProjectionRecord[];
  dbRecords: DbRecord[];
  summary: {
    sessions: number;
    messageTurns: number;
    evaluationRuns: number;
    intentSequences: number;
    intentRunLogs: number;
    intentEvalMetrics: number;
    objectiveSignals: number;
    subjectiveSignals: number;
    evidenceSpans: number;
    riskTags: number;
    suggestions: number;
  };
};

// ── P2 projection types ───────────────────────────────────────────────────────

export type BaselineProjection = {
  baseline: DbBaseline;
  baselineRun: DbBaselineRun;
};

export type OnlineEvalProjection = {
  onlineEvalRun: DbOnlineEvalRun;
  replayTurns: DbReplayTurn[];
  runComparisons: DbRunComparison[];
};

type EvidenceInput = {
  kind: string;
  quote: string;
  sessionId?: string;
  intentIndex?: number;
  startTurn?: number;
  endTurn?: number;
  source?: DbEvidenceSpan["source"];
};

/**
 * Project a completed evaluation response into normalized database records.
 *
 * @param response Completed evaluation response.
 * @param options Projection options.
 * @returns Projection records plus local database records.
 */
export function buildEvaluationProjection(
  response: EvaluateResponse,
  options: EvaluationProjectionOptions,
): EvaluationProjection {
  const { projectId } = options;
  const now = response.meta.generatedAt || new Date().toISOString();
  const runId = options.runId ?? response.runId;
  const evaluationRunId = stableUuid("eval-run", projectId, runId);
  const evidenceSpans: DbEvidenceSpan[] = [];

  // ── Evidence span builder ────────────────────────────────────────────────────

  const createEvidence = (input: EvidenceInput): string | undefined => {
    const quote = input.quote.trim();
    if (!quote) return undefined;
    const id = stableUuid(
      "evidence",
      projectId,
      runId,
      input.kind,
      input.sessionId ?? "run",
      input.startTurn ?? "na",
      quote,
    );
    if (!evidenceSpans.some((item) => item.id === id)) {
      evidenceSpans.push({
        table: "evidence_spans",
        id,
        projectId,
        evaluationRunId,
        sessionId: input.sessionId,
        intentIndex: input.intentIndex,
        evidenceKind: input.kind,
        quote,
        startTurn: input.startTurn,
        endTurn: input.endTurn,
        source: input.source ?? "rule",
        createdAt: now,
      });
    }
    return id;
  };

  // ── evaluation_runs ──────────────────────────────────────────────────────────

  // ── sessions & message_turns ──────────────────────────────────────────────────

  const sessionMap = new Map<string, DbSession>();
  const messageTurns: DbMessageTurn[] = [];

  for (const row of response.enrichedRows) {
    const sessionId = stableUuid("session", projectId, row.sessionId);
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, {
        table: "sessions",
        id: sessionId,
        projectId,
        externalSessionId: row.sessionId,
        createdAt: now,
      });
    }
    const session = sessionMap.get(sessionId)!;
    // Track start/end times from first/last turn timestamps
    if (row.timestamp) {
      if (!session.startedAt || row.timestamp < session.startedAt) {
        session.startedAt = row.timestamp;
      }
      if (!session.endedAt || row.timestamp > session.endedAt) {
        session.endedAt = row.timestamp;
      }
    }
    messageTurns.push({
      table: "message_turns",
      id: stableUuid("turn", projectId, row.sessionId, row.turnIndex),
      projectId,
      sessionId,
      turnIndex: row.turnIndex,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp || undefined,
      timestampRaw: row.timestamp || undefined,
      tokenCountEstimate: row.tokenCountEstimate,
      createdAt: now,
    });
  }

  const sessions = Array.from(sessionMap.values());

  // ── evaluation_runs ──────────────────────────────────────────────────────────

  const evaluationRun: DbEvaluationRun = {
    table: "evaluation_runs",
    id: evaluationRunId,
    projectId,
    runKey: runId,
    scenarioId: response.meta.scenarioContext?.scenarioId,
    status: "succeeded",
    useLlm: Boolean(options.useLlm),
    dynamicReplayEnabled: Boolean(options.enableDynamicReplay),
    sessionCount: response.meta.sessions,
    messageCount: response.meta.messages,
    hasTimestamp: response.meta.hasTimestamp,
    warnings: response.meta.warnings,
    artifactUri: response.artifactPath,
    generatedAt: response.meta.generatedAt,
    reportPayload: {
      summaryCards: response.summaryCards,
      piiRedaction: response.meta.piiRedaction,
      scenarioContext: response.meta.scenarioContext,
      dynamicReplayStatus: response.dynamicReplayStatus,
    },
    createdAt: now,
  };

  // ── objective_signals ─────────────────────────────────────────────────────────

  const objectiveSignals = buildObjectiveSignals(response.objectiveMetrics, {
    projectId,
    evaluationRunId,
    now,
  });

  // ── subjective_signals ────────────────────────────────────────────────────────

  const subjectiveSignals: DbSubjectiveSignal[] = response.subjectiveMetrics.dimensions.map(
    (dimension) => {
      const evidenceSpanId = createEvidence({
        kind: "subjective_dimension",
        quote: dimension.evidence,
        source: "llm",
      });
      return {
        table: "subjective_signals",
        id: stableUuid("subjective-signal", projectId, runId, dimension.dimension),
        projectId,
        evaluationRunId,
        dimensionKey: slugify(dimension.dimension),
        dimensionLabel: dimension.dimension,
        score: dimension.score,
        reason: dimension.reason,
        source: "llm",
        confidence: dimension.confidence,
        evidenceSpanId,
        createdAt: now,
      };
    },
  );

  // ── risk_tags ─────────────────────────────────────────────────────────────────

  const riskTags: DbRiskTag[] = [];

  for (const signal of response.subjectiveMetrics.signals) {
    const evidenceSpanId = createEvidence({
      kind: "implicit_signal",
      quote: signal.evidence,
      sessionId: parseEvidenceSessionId(signal.evidenceTurnRange),
      startTurn: parseEvidenceTurnRange(signal.evidenceTurnRange).startTurn,
      endTurn: parseEvidenceTurnRange(signal.evidenceTurnRange).endTurn,
      source: "inferred",
    });
    riskTags.push({
      table: "risk_tags",
      id: stableUuid("risk-tag", projectId, runId, signal.signalKey),
      projectId,
      evaluationRunId,
      sessionId: parseEvidenceSessionId(signal.evidenceTurnRange),
      tagKey: signal.signalKey,
      score: signal.score,
      severity: signal.severity,
      reason: signal.reason,
      evidenceSpanId,
      source: "inferred",
      createdAt: now,
    });
  }

  for (const badCase of response.badCaseAssets) {
    for (const tag of badCase.tags) {
      const quote = badCase.evidence
        .map((item) => `[turn ${item.turnIndex}] ${item.content}`)
        .join("\n");
      const evidenceSpanId = quote
        ? createEvidence({
            kind: "bad_case",
            quote,
            sessionId: badCase.sessionId,
            startTurn: badCase.evidence[0]?.turnIndex,
            endTurn: badCase.evidence[badCase.evidence.length - 1]?.turnIndex,
            source: "rule",
          })
        : undefined;
      riskTags.push({
        table: "risk_tags",
        id: stableUuid("risk-tag", projectId, runId, badCase.caseKey, tag),
        projectId,
        evaluationRunId,
        sessionId: badCase.sessionId,
        tagKey: tag,
        score: badCase.severityScore,
        reason: badCase.title,
        evidenceSpanId,
        source: "rule",
        createdAt: now,
      });
    }
  }

  // ── suggestions ───────────────────────────────────────────────────────────────

  const suggestions: DbSuggestion[] = response.suggestions.map((text, index) => ({
    table: "suggestions",
    id: stableUuid("suggestion", projectId, runId, String(index)),
    projectId,
    evaluationRunId,
    title: extractSuggestionTitle(text),
    problem: text,
    impact: "",
    action: text,
    triggerMetricKeys: [],
    priority: index + 1,
    createdAt: now,
  }));

  // ── intent_sequences / intent_run_logs / intent_eval_metrics ─────────────────

  const intentSequences: DbIntentSequence[] = [];
  const intentRunLogs: DbIntentRunLog[] = [];
  const intentEvalMetrics: DbIntentEvalMetrics[] = [];

  if (
    response.dynamicReplayStatus !== "skipped" &&
    response.intentSequences &&
    response.intentRunLogs
  ) {
    for (const seqDoc of response.intentSequences) {
      const intentSequenceId = stableUuid(
        "intent-seq",
        projectId,
        runId,
        seqDoc.sessionId,
      );
      intentSequences.push({
        table: "intent_sequences",
        id: intentSequenceId,
        projectId,
        evaluationRunId,
        sessionId: seqDoc.sessionId,
        schemaVersion: seqDoc.schemaVersion,
        schemaLockRevision: seqDoc.schemaLockRevision,
        intentSequence: seqDoc.intentSequence as unknown as Record<string, unknown>[],
        refillables: seqDoc.refillables as unknown as Record<string, unknown>[],
        lockStatus: seqDoc.lockStatus,
        intentCount: seqDoc.intentSequence.length,
        refillableCount: seqDoc.refillables.length,
        updatedAt: now,
        createdAt: now,
      });
    }

    const seqIdBySession = new Map<string, string>(
      response.intentSequences.map((seq) => [
        seq.sessionId,
        stableUuid("intent-seq", projectId, runId, seq.sessionId),
      ]),
    );

    for (const sessionLogs of response.intentRunLogs) {
      for (const log of sessionLogs) {
        const intentSequenceId = seqIdBySession.get(log.sessionId) ?? stableUuid("intent-seq", projectId, runId, log.sessionId);
        intentRunLogs.push({
          table: "intent_run_logs",
          id: stableUuid("intent-log", projectId, runId, log.sessionId, String(log.intentIndex), String(log.turnCount)),
          projectId,
          evaluationRunId,
          sessionId: log.sessionId,
          intentSequenceId,
          intentIndex: log.intentIndex,
          turnCount: log.turnCount,
          budget: log.budget,
          userText: log.userText,
          assistantText: log.assistantText,
          judgeLabel: log.judgeLabel,
          rationale: log.rationale,
          evidenceQuote: log.evidenceQuote,
          events: log.events,
          createdAt: now,
        });
      }
    }

    // Compute per-session intent eval metrics from run logs
    if (response.intentMetrics) {
      for (const sessionMetrics of response.intentMetrics.perSession) {
        const intentSequenceId = seqIdBySession.get(sessionMetrics.sessionId) ?? stableUuid("intent-seq", projectId, runId, sessionMetrics.sessionId);
        intentEvalMetrics.push({
          table: "intent_eval_metrics",
          id: stableUuid("intent-metrics", projectId, runId, sessionMetrics.sessionId),
          projectId,
          evaluationRunId,
          sessionId: sessionMetrics.sessionId,
          intentSequenceId,
          intentCompletionRate: sessionMetrics.intentCompletionRate,
          clarificationEfficiency: sessionMetrics.clarificationEfficiency,
          deviationRate: sessionMetrics.deviationRate,
          turnEfficiency: sessionMetrics.turnEfficiency,
          intentCount: sessionMetrics.intentCount,
          satisfiedCount: sessionMetrics.satisfiedCount,
          budgetFailedCount: sessionMetrics.budgetFailedCount,
          totalReplayTurns: sessionMetrics.totalReplayTurns,
          skippedReason: sessionMetrics.skippedReason,
          createdAt: now,
        });
      }
    }
  }

  // ── Assemble ──────────────────────────────────────────────────────────────────

  // Sessions must come before message_turns (FK dependency handled in supabase-typed-database.ts)
  const records: DbEvaluationProjectionRecord[] = [
    ...sessions,
    ...messageTurns,
    evaluationRun,
    ...intentSequences,
    ...intentRunLogs,
    ...intentEvalMetrics,
    ...objectiveSignals,
    ...subjectiveSignals,
    ...evidenceSpans,
    ...riskTags,
    ...suggestions,
  ];

  return {
    records,
    dbRecords: records.map(toDbRecord),
    summary: {
      sessions: sessions.length,
      messageTurns: messageTurns.length,
      evaluationRuns: 1,
      intentSequences: intentSequences.length,
      intentRunLogs: intentRunLogs.length,
      intentEvalMetrics: intentEvalMetrics.length,
      objectiveSignals: objectiveSignals.length,
      subjectiveSignals: subjectiveSignals.length,
      evidenceSpans: evidenceSpans.length,
      riskTags: riskTags.length,
      suggestions: suggestions.length,
    },
  };
}

/**
 * Persist an evaluation projection through the active database adapter.
 *
 * @param database Database adapter.
 * @param projection Projection payload.
 */
export async function persistEvaluationProjection(
  database: ZeroreDatabase,
  projection: EvaluationProjection,
): Promise<void> {
  for (const record of projection.dbRecords) {
    await database.upsert(record);
  }
}

// ── P2: Baseline projection ────────────────────────────────────────────────────

/**
 * Build a baseline projection from a WorkbenchBaselineSnapshot.
 * Writes to `baselines` (one per customerId) and `baseline_runs` (one per runId).
 *
 * @param snapshot Workbench baseline snapshot.
 * @param projectId Project UUID.
 * @returns Baseline projection with baseline + baseline_run records.
 */
export function buildBaselineProjection(
  snapshot: WorkbenchBaselineSnapshot,
  projectId: string,
): BaselineProjection {
  const now = snapshot.createdAt;
  const baselineId = stableUuid("baseline", projectId, snapshot.customerId);
  const baselineRunId = stableUuid("baseline-run", projectId, snapshot.runId);
  const sourceEvaluationRunId = stableUuid("eval-run", projectId, snapshot.runId);

  const baseline: DbBaseline = {
    table: "baselines",
    id: baselineId,
    projectId,
    customerId: snapshot.customerId,
    name: snapshot.label ?? snapshot.customerId,
    createdAt: now,
  };

  const baselineRun: DbBaselineRun = {
    table: "baseline_runs",
    id: baselineRunId,
    projectId,
    baselineId,
    sourceEvaluationRunId,
    snapshotPayload: snapshot as unknown as Record<string, unknown>,
    createdAt: now,
  };

  return { baseline, baselineRun };
}

// ── P2: Online eval projection ────────────────────────────────────────────────

export type OnlineEvalProjectionOptions = {
  projectId: string;
  runId: string;
  replyApiUrl: string;
  baselineRunId?: string;
  currentEvaluationRunId?: string;
  replayedRows: RawChatlogRow[];
  baselineEvaluate?: EvaluateResponse;
  currentEvaluate?: EvaluateResponse;
};

/**
 * Build an online evaluation projection from a replay result.
 * Writes to `online_eval_runs`, `replay_turns`, and `run_comparisons`.
 *
 * @param options Online eval options.
 * @returns Online eval projection.
 */
export function buildOnlineEvalProjection(options: OnlineEvalProjectionOptions): OnlineEvalProjection {
  const {
    projectId,
    runId,
    replyApiUrl,
    baselineRunId,
    currentEvaluationRunId,
    replayedRows,
    baselineEvaluate,
    currentEvaluate,
  } = options;
  const now = new Date().toISOString();
  const onlineEvalRunId = stableUuid("online-eval-run", projectId, runId);

  const onlineEvalRun: DbOnlineEvalRun = {
    table: "online_eval_runs",
    id: onlineEvalRunId,
    projectId,
    baselineRunId,
    currentEvaluationRunId,
    replyApiUrl,
    status: "succeeded",
    createdAt: now,
  };

  // Replay turns — one per replayed assistant row
  const replayTurns: DbReplayTurn[] = replayedRows
    .filter((row) => row.role === "assistant")
    .map((row, idx) => ({
      table: "replay_turns",
      id: stableUuid("replay-turn", projectId, runId, row.sessionId, idx),
      projectId,
      onlineEvalRunId,
      sessionId: stableUuid("session", projectId, row.sessionId),
      turnIndex: idx,
      role: "assistant" as const,
      content: row.content,
      status: "ok" as const,
      createdAt: now,
    }));

  // Run comparisons — per-metric delta between baseline and current
  const runComparisons: DbRunComparison[] = [];
  if (baselineEvaluate && currentEvaluate && baselineRunId) {
    const baselineMetrics = flattenObjectiveMetrics(baselineEvaluate.objectiveMetrics);
    const currentMetrics = flattenObjectiveMetrics(currentEvaluate.objectiveMetrics);
    for (const [key, baselineValue] of Object.entries(baselineMetrics)) {
      const currentValue = currentMetrics[key];
      if (typeof baselineValue !== "number" || typeof currentValue !== "number") continue;
      const delta = currentValue - baselineValue;
      runComparisons.push({
        table: "run_comparisons",
        id: stableUuid("run-comparison", projectId, runId, key),
        projectId,
        onlineEvalRunId,
        baselineRunId,
        currentEvaluationRunId,
        metricKey: key,
        baselineValue,
        currentValue,
        delta,
        direction: delta > 0.001 ? "better" : delta < -0.001 ? "worse" : "neutral",
        createdAt: now,
      });
    }
  }

  return { onlineEvalRun, replayTurns, runComparisons };
}

function flattenObjectiveMetrics(metrics: EvaluateResponse["objectiveMetrics"]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number") {
      result[key] = value;
    }
  }
  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildObjectiveSignals(
  metrics: ObjectiveMetrics,
  context: {
    projectId: string;
    evaluationRunId: string;
    now: string;
  },
): DbObjectiveSignal[] {
  return Object.entries(metrics).map(([metricKey, value]) => ({
    table: "objective_signals",
    id: stableUuid("objective-signal", context.projectId, context.evaluationRunId, metricKey),
    projectId: context.projectId,
    evaluationRunId: context.evaluationRunId,
    metricKey,
    numericValue: typeof value === "number" ? value : undefined,
    jsonValue: typeof value === "number" ? undefined : value,
    source: "rule",
    confidence: 1,
    createdAt: context.now,
  }));
}

function toDbRecord(record: DbEvaluationProjectionRecord): DbRecord {
  const base = record as DbEvaluationProjectionRecord & { createdAt?: string };
  return {
    id: record.id,
    projectId: record.projectId,
    type: record.table,
    payload: record,
    createdAt: base.createdAt ?? new Date().toISOString(),
    updatedAt: base.createdAt ?? new Date().toISOString(),
  };
}

function extractSuggestionTitle(text: string): string {
  // Extract priority label (P0/P1/P2) and first clause as title
  const match = /^(P\d)[:：](.{0,40})/.exec(text);
  if (match) return `${match[1]} ${match[2].trim()}`.slice(0, 60);
  return text.slice(0, 60);
}

function parseEvidenceSessionId(value: string): string | undefined {
  const match = /^([^:]+):/.exec(value);
  return match?.[1];
}

function parseEvidenceTurnRange(value: string): { startTurn?: number; endTurn?: number } {
  const match = /:(\d+)-(\d+)/.exec(value);
  if (!match) return {};
  return { startTurn: Number(match[1]), endTurn: Number(match[2]) };
}

/**
 * Generate a deterministic UUID (v5-format) from a set of input parts.
 * Uses SHA-256 hash formatted as a valid UUID string.
 * This ensures IDs are compatible with Postgres `uuid` column types.
 */
function stableUuid(...parts: Array<string | number>): string {
  const hex = createHash("sha256").update(parts.join("\x00")).digest("hex");
  // Format as UUID: 8-4-4-4-12 (32 hex chars used)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "unknown"
  );
}
