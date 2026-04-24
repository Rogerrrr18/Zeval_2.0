import { NextResponse } from "next/server";
import { getZeroreRequestContext } from "@/auth/context";
import { redactRawRows } from "@/pii/redaction";
import { runEvaluatePipeline } from "@/pipeline/evaluateRun";
import { enqueueLocalJob } from "@/queue";
import { evaluateRequestSchema } from "@/schemas/api";

/**
 * Execute MVP evaluation chain from raw rows.
 * @param request Next.js request object.
 * @returns Unified evaluate payload with enriched rows, metrics and charts.
 */
export async function POST(request: Request) {
  try {
    const context = getZeroreRequestContext(request);
    const parsedBody = evaluateRequestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "请求体不合法，请先完成 ingest 并传入 rawRows。" },
        { status: 400 },
      );
    }
    const body = parsedBody.data;
    const redaction = redactRawRows(body.rawRows);
    const rawRows = redaction.rows;
    const runId = body.runId ?? `run_${Date.now()}`;
    const useLlm = Boolean(body.useLlm);
    if (body.asyncMode) {
      const job = await enqueueLocalJob({
        workspaceId: context.workspaceId,
        type: "evaluate",
        payload: {
          ...body,
          rawRows,
          runId,
          piiRedaction: redaction.report,
        },
      });
      return NextResponse.json({ queued: true, job, runId }, { status: 202 });
    }

    console.info(`[EVALUATE] runId=${runId} START messages=${rawRows.length} useLlm=${useLlm}`);
    const response = await runEvaluatePipeline(rawRows, {
      useLlm,
      runId,
      scenarioId: body.scenarioId,
      scenarioContext: body.scenarioContext
        ? {
            scenarioId: body.scenarioId,
            onboardingAnswers: body.scenarioContext.onboardingAnswers,
          }
        : undefined,
      persistArtifact: body.persistArtifact ?? Boolean(body.artifactBaseName),
      artifactBaseName: body.artifactBaseName,
    });
    response.meta.workspaceId = context.workspaceId;
    response.meta.piiRedaction = redaction.report;
    if (redaction.report.redactedFields > 0) {
      response.meta.warnings.push(
        `PII 脱敏已处理 ${redaction.report.redactedFields} 处：${redaction.report.categories.join(", ")}。`,
      );
    }

    console.info(`[EVALUATE] runId=${runId} DONE warnings=${response.meta.warnings.length}`);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "evaluate 未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
