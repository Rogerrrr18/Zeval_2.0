/**
 * @fileoverview Shared progress event types for streamed evaluation runs.
 */

export type EvaluationStageKey =
  | "parse"
  | "objective"
  | "subjective"
  | "extended"
  | "badcase"
  | "complete";

export type EvaluationStageStatus = "pending" | "running" | "done" | "failed";

export type EvaluationProgressEvent = {
  type: "stage";
  stage: EvaluationStageKey;
  status: EvaluationStageStatus;
  message?: string;
  detail?: string;
};

/**
 * Final per-stage status snapshot returned in the evaluate response body.
 *
 * Lets the frontend programmatically detect which stage degraded or failed
 * (e.g. `subjective` → "failed") instead of parsing free-text warning strings.
 */
export type EvaluationStageReport = {
  stage: EvaluationStageKey;
  status: EvaluationStageStatus;
  message?: string;
  detail?: string;
};

