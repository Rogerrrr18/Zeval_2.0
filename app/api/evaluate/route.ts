import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildChartPayloads } from "@/pipeline/chartBuilder";
import { enrichRows, toEnrichedCsv } from "@/pipeline/enrich";
import { buildObjectiveMetrics } from "@/pipeline/objectiveMetrics";
import { buildSubjectiveMetrics } from "@/pipeline/subjectiveMetrics";
import { buildSuggestions } from "@/pipeline/suggest";
import { buildSummaryCards } from "@/pipeline/summary";
import { evaluateRequestSchema } from "@/schemas/api";
import type { EvaluateResponse } from "@/types/pipeline";

/**
 * Execute MVP evaluation chain from raw rows.
 * @param request Next.js request object.
 * @returns Unified evaluate payload with enriched rows, metrics and charts.
 */
export async function POST(request: Request) {
  try {
    const parsedBody = evaluateRequestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "请求体不合法，请先完成 ingest 并传入 rawRows。" },
        { status: 400 },
      );
    }
    const body = parsedBody.data;
    const rawRows = body.rawRows;
    const runId = body.runId ?? `run_${Date.now()}`;
    const useLlm = Boolean(body.useLlm);

    const warnings: string[] = [];
    if (!rawRows.every((row) => Boolean(row.timestamp))) {
      warnings.push("检测到缺失 timestamp，部分时序指标已降级。");
    }

    console.info(`[EVALUATE] runId=${runId} START messages=${rawRows.length} useLlm=${useLlm}`);
    console.info(`[EVALUATE] runId=${runId} STAGE=enrich_rows START`);
    const { enrichedRows, topicSegments } = await enrichRows(rawRows, useLlm, runId);
    console.info(
      `[EVALUATE] runId=${runId} STAGE=enrich_rows DONE enrichedRows=${enrichedRows.length} topicSegments=${topicSegments.length}`,
    );
    const enrichedCsv = toEnrichedCsv(enrichedRows);
    const objectiveMetrics = buildObjectiveMetrics(enrichedRows);
    console.info(`[EVALUATE] runId=${runId} STAGE=subjective_metrics START`);
    const subjectiveMetrics = await buildSubjectiveMetrics(enrichedRows, useLlm, runId);
    console.info(`[EVALUATE] runId=${runId} STAGE=subjective_metrics DONE status=${subjectiveMetrics.status}`);
    const charts = buildChartPayloads(enrichedRows);
    const suggestions = buildSuggestions(enrichedRows, objectiveMetrics, subjectiveMetrics);
    const summaryCards = buildSummaryCards(
      objectiveMetrics,
      subjectiveMetrics,
      new Set(rawRows.map((row) => row.sessionId)).size,
      rawRows.length,
    );

    if (subjectiveMetrics.status !== "ready") {
      warnings.push("主观评估当前为降级模式（LLM judge 调用失败或未启用）。");
    }

    let artifactPath: string | undefined;
    if (body.persistArtifact ?? Boolean(body.artifactBaseName)) {
      const artifactBaseName = sanitizeArtifactBaseName(body.artifactBaseName ?? runId);
      const artifactDirectory = path.join(process.cwd(), "mock-chatlog", "enriched-data");
      artifactPath = path.join(artifactDirectory, `${artifactBaseName}.enriched.csv`);
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(artifactPath, enrichedCsv, "utf8");
    }

    const response: EvaluateResponse = {
      runId,
      meta: {
        sessions: new Set(rawRows.map((row) => row.sessionId)).size,
        messages: rawRows.length,
        hasTimestamp: rawRows.every((row) => Boolean(row.timestamp)),
        generatedAt: new Date().toISOString(),
        warnings,
      },
      summaryCards,
      topicSegments,
      enrichedRows,
      enrichedCsv,
      artifactPath,
      objectiveMetrics,
      subjectiveMetrics,
      charts,
      suggestions,
    };

    console.info(`[EVALUATE] runId=${runId} DONE warnings=${warnings.length}`);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "evaluate 未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Sanitize a file base name for artifact persistence.
 * @param value Requested artifact base name.
 * @returns Safe file base name.
 */
function sanitizeArtifactBaseName(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "enriched-artifact";
}
