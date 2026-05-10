/**
 * @fileoverview Persist extracted bad case assets into eval-datasets storage.
 */

import { randomBytes } from "node:crypto";
import { buildBadCaseFeatureSnapshot } from "@/badcase/feature";
import { findBadCaseDuplicate } from "@/badcase/dedupe";
import type { DatasetStore } from "@/eval-datasets/storage/dataset-store";
import type { DatasetBaselineRecord, DatasetCaseRecord, DatasetCaseSource } from "@/eval-datasets/storage/types";
import type { EvaluateResponse } from "@/types/pipeline";

/**
 * Harvest bad case assets from one evaluate response into the dataset store.
 *
 * @param params Harvest parameters.
 * @returns Saved and skipped case ids with duplicate diagnostics.
 */
export async function harvestBadCasesToDataset(params: {
  store: DatasetStore;
  evaluate: EvaluateResponse;
  baselineVersion?: string;
  allowNearDuplicate?: boolean;
  /** Admission channel override. Defaults to `"auto_tp"` for rule-harvested bad cases. */
  source?: DatasetCaseSource;
}): Promise<{
  savedCaseIds: string[];
  skipped: Array<{
    caseKey: string;
    reason: "exact_hash" | "near_duplicate";
    matchedCaseId?: string;
  }>;
}> {
  const savedCaseIds: string[] = [];
  const skipped: Array<{
    caseKey: string;
    reason: "exact_hash" | "near_duplicate";
    matchedCaseId?: string;
  }> = [];

  const baselineVersion = params.baselineVersion ?? params.evaluate.runId;
  const existingCases = await params.store.listCases("badcase");

  for (const [assetIndex, asset] of params.evaluate.badCaseAssets.entries()) {
    const baselineCaseScore = roundScore(1 - asset.severityScore);
    const featureSnapshot = buildBadCaseFeatureSnapshot(params.evaluate, assetIndex);
    const duplicate = findBadCaseDuplicate(
      {
        normalizedTranscriptHash: asset.normalizedTranscriptHash,
        featureSnapshot,
      },
      existingCases,
    );

    if (duplicate.isDuplicate && duplicate.layer === "l1_exact_hash") {
      skipped.push({
        caseKey: asset.caseKey,
        reason: "exact_hash",
        matchedCaseId: duplicate.matchedCaseId,
      });
      continue;
    }

    if (duplicate.isDuplicate && duplicate.layer !== "l1_exact_hash" && !(params.allowNearDuplicate ?? true)) {
      skipped.push({
        caseKey: asset.caseKey,
        reason: "near_duplicate",
        matchedCaseId: duplicate.matchedCaseId,
      });
      continue;
    }

    const caseId = allocateCaseId();
    const now = new Date().toISOString();
    const caseRecord: DatasetCaseRecord = {
      caseId,
      caseSetType: "badcase",
      source: params.source ?? "auto_tp",
      sessionId: asset.sessionId,
      topicSegmentId: asset.topicSegmentId,
      topicIndex: asset.topicIndex,
      topicRange: asset.topicRange,
      topicLabel: asset.topicLabel,
      topicSummary: asset.topicSummary,
      normalizedTranscriptHash: asset.normalizedTranscriptHash,
      duplicateGroupKey: asset.duplicateGroupKey,
      baselineVersion,
      baselineCaseScore,
      tags: asset.tags,
      title: asset.title,
      transcript: asset.transcript,
      suggestedAction: asset.suggestedAction,
      scenarioId: params.evaluate.scenarioEvaluation?.scenarioId,
      sourceRunId: asset.sourceRunId,
      harvestedAt: now,
      failureSeverityScore: asset.severityScore,
      featureSnapshot,
      autoSignals: asset.autoSignals,
      reviewStatus: "auto_captured",
      createdAt: now,
      updatedAt: now,
    };
    await params.store.createCase(caseRecord);

    const baselineRecord: DatasetBaselineRecord = buildBaselineRecord(caseId, asset, params.evaluate);
    await params.store.saveBaseline(baselineRecord);
    savedCaseIds.push(caseId);
    existingCases.push(caseRecord);
  }

  return { savedCaseIds, skipped };
}

/**
 * Build one baseline snapshot from a bad case asset and evaluate metadata.
 *
 * @param caseId Dataset case id.
 * @param asset Bad case asset.
 * @param evaluate Evaluate response.
 * @returns Dataset baseline record.
 */
function buildBaselineRecord(
  caseId: string,
  asset: EvaluateResponse["badCaseAssets"][number],
  evaluate: EvaluateResponse,
): DatasetBaselineRecord {
  const objectivePenalty = [
    asset.tags.includes("question_repeat") ? 0.2 : 0,
    asset.tags.includes("escalation_keyword") ? 0.24 : 0,
    asset.tags.includes("off_topic_shift") ? 0.18 : 0,
    asset.tags.includes("long_response_gap") ? 0.12 : 0,
  ].reduce((sum, item) => sum + item, 0);
  const subjectivePenalty = [
    asset.tags.includes("goal_failed") ? 0.34 : 0,
    asset.tags.includes("goal_partial") ? 0.18 : 0,
    asset.tags.includes("goal_unclear") ? 0.1 : 0,
    asset.tags.includes("recovery_failed") ? 0.24 : 0,
    asset.tags.includes("understanding_barrier") ? 0.16 : 0,
    asset.tags.includes("emotion_drop") ? 0.14 : 0,
  ].reduce((sum, item) => sum + item, 0);
  const baselineObjectiveScore = roundScore(1 - Math.min(1, objectivePenalty));
  const baselineSubjectiveScore = roundScore(1 - Math.min(1, subjectivePenalty));
  const relatedSignals = evaluate.subjectiveMetrics.signals
    .filter((item) => item.evidenceTurnRange.startsWith(`${asset.sessionId}:`))
    .map((item) => ({
      signalKey: item.signalKey,
      score: item.score,
      severity: item.severity,
    }));

  return {
    caseId,
    baselineCaseScore: roundScore((baselineObjectiveScore + baselineSubjectiveScore) / 2),
    baselineObjectiveScore,
    baselineSubjectiveScore,
    baselineRiskPenaltyScore: asset.severityScore,
    baselineSignals: relatedSignals,
    baselineGeneratedAt: new Date().toISOString(),
    baselineProductVersion: evaluate.runId,
  };
}

/**
 * Allocate one new badcase id.
 *
 * @returns Dataset case id.
 */
function allocateCaseId(): string {
  return `bc_${Date.now()}_${randomBytes(3).toString("hex")}`;
}

/**
 * Round one normalized score.
 *
 * @param value Raw value.
 * @returns Rounded score.
 */
function roundScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}
