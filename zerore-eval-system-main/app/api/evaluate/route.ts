import { NextResponse } from "next/server";
import type { z } from "zod";
import { getZeroreRequestContext, getZevalDataScope } from "@/auth/context";
import { buildEvaluationProjection, persistEvaluationProjection } from "@/db/evaluation-projection";
import { createZeroreDatabase } from "@/db";
import { redactRawRows } from "@/pii/redaction";
import { runEvaluatePipeline } from "@/pipeline/evaluateRun";
import { enqueueLocalJob } from "@/queue";
import { persistEvaluateResult } from "@/persistence/evaluateResultStore";
import { evaluateRequestSchema } from "@/schemas/api";
import type { EvaluationProgressEvent } from "@/types/evaluation-progress";

/**
 * Execute MVP evaluation chain from raw rows.
 * @param request Next.js request object.
 * @returns Unified evaluate payload with enriched rows, metrics and charts.
 */
export async function POST(request: Request) {
  try {
    const context = getZeroreRequestContext(request);
    const dataScope = getZevalDataScope(context);
    const streamMode = new URL(request.url).searchParams.get("stream") === "1";
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
    const useLlm = body.useLlm ?? true;
    const judgeRequired = body.judgeRequired ?? true;
    if (judgeRequired && !useLlm) {
      return NextResponse.json({ error: "当前产品链路要求 LLM Judge 必须开启，不能以降级模式运行。" }, { status: 400 });
    }
    if (streamMode) {
      return streamEvaluateRun({
        context,
        rawRows,
        body,
        redactionReport: redaction.report,
        runId,
        useLlm,
        judgeRequired,
      });
    }
    if (body.asyncMode) {
      const job = await enqueueLocalJob({
        workspaceId: context.workspaceId,
        organizationId: context.organizationId,
        projectId: context.projectId,
        type: "evaluate",
        payload: {
          ...body,
          dataScope,
          rawRows,
          runId,
          useLlm,
          judgeRequired,
          piiRedaction: redaction.report,
        },
        maxAttempts: 2,
      });
      return NextResponse.json({ queued: true, job, runId }, { status: 202 });
    }

    console.info(`[EVALUATE] runId=${runId} START messages=${rawRows.length} useLlm=${useLlm}`);
    const response = await runEvaluatePipeline(rawRows, {
      useLlm,
      judgeRequired,
      runId,
      scenarioId: body.scenarioId,
      scenarioContext: body.scenarioContext
        ? {
            scenarioId: body.scenarioId,
            onboardingAnswers: body.scenarioContext.onboardingAnswers,
          }
        : undefined,
      structuredTaskMetrics: body.structuredTaskMetrics,
      trace: body.trace,
      persistArtifact: body.persistArtifact ?? Boolean(body.artifactBaseName),
      artifactBaseName: body.artifactBaseName,
      extendedInputs: body.extendedInputs,
    });
    response.meta.organizationId = context.organizationId;
    response.meta.projectId = context.projectId;
    response.meta.workspaceId = context.workspaceId;
    response.meta.piiRedaction = redaction.report;
    if (redaction.report.redactedFields > 0) {
      response.meta.warnings.push(
        `PII 脱敏已处理 ${redaction.report.redactedFields} 处：${redaction.report.categories.join(", ")}。`,
      );
      markEvaluateResponseDegraded(response);
    }
    await persistCompletedEvaluateResult(response);
    try {
      const projection = buildEvaluationProjection(response, {
        organizationId: context.organizationId,
        projectId: context.projectId,
        workspaceId: context.workspaceId,
        runId,
        useLlm,
      });
      const database = await createZeroreDatabase();
      await persistEvaluationProjection(database, projection);
      console.info(
        `[EVALUATE] runId=${runId} PROJECTION records=${projection.dbRecords.length} evidence=${projection.summary.evidenceSpans}`,
      );
    } catch (projectionError) {
      const projectionMessage =
        projectionError instanceof Error ? projectionError.message : "evaluation projection 未知错误";
      response.meta.warnings.push(`结构化质量信号写入失败：${projectionMessage}`);
      markEvaluateResponseDegraded(response);
      console.warn(`[EVALUATE] runId=${runId} PROJECTION_FAILED ${projectionMessage}`);
    }

    console.info(`[EVALUATE] runId=${runId} DONE warnings=${response.meta.warnings.length}`);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "evaluate 未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Stream a synchronous evaluation run as SSE stage events followed by result.
 *
 * @param input Evaluation inputs already validated by the route.
 * @returns SSE response.
 */
function streamEvaluateRun(input: {
  context: ReturnType<typeof getZeroreRequestContext>;
  rawRows: ReturnType<typeof redactRawRows>["rows"];
  body: z.infer<typeof evaluateRequestSchema>;
  redactionReport: ReturnType<typeof redactRawRows>["report"];
  runId: string;
  useLlm: boolean;
  judgeRequired: boolean;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const onProgress = (event: EvaluationProgressEvent) => send(event);
      try {
        console.info(
          `[EVALUATE] runId=${input.runId} STREAM_START messages=${input.rawRows.length} useLlm=${input.useLlm}`,
        );
        const response = await runEvaluatePipeline(input.rawRows, {
          useLlm: input.useLlm,
          judgeRequired: input.judgeRequired,
          runId: input.runId,
          scenarioId: input.body.scenarioId,
          scenarioContext: input.body.scenarioContext
            ? {
                scenarioId: input.body.scenarioId,
                onboardingAnswers: input.body.scenarioContext.onboardingAnswers,
              }
            : undefined,
          structuredTaskMetrics: input.body.structuredTaskMetrics,
          trace: input.body.trace,
          persistArtifact: input.body.persistArtifact ?? Boolean(input.body.artifactBaseName),
          artifactBaseName: input.body.artifactBaseName,
          extendedInputs: input.body.extendedInputs,
          onProgress,
        });
        response.meta.organizationId = input.context.organizationId;
        response.meta.projectId = input.context.projectId;
        response.meta.workspaceId = input.context.workspaceId;
        response.meta.piiRedaction = input.redactionReport;
        if (input.redactionReport.redactedFields > 0) {
          response.meta.warnings.push(
            `PII 脱敏已处理 ${input.redactionReport.redactedFields} 处：${input.redactionReport.categories.join(", ")}。`,
          );
          markEvaluateResponseDegraded(response);
        }
        await persistCompletedEvaluateResult(response);
        try {
          const projection = buildEvaluationProjection(response, {
            organizationId: input.context.organizationId,
            projectId: input.context.projectId,
            workspaceId: input.context.workspaceId,
            runId: input.runId,
            useLlm: input.useLlm,
          });
          const database = await createZeroreDatabase();
          await persistEvaluationProjection(database, projection);
          console.info(
            `[EVALUATE] runId=${input.runId} STREAM_PROJECTION records=${projection.dbRecords.length} evidence=${projection.summary.evidenceSpans}`,
          );
        } catch (projectionError) {
          const projectionMessage =
            projectionError instanceof Error ? projectionError.message : "evaluation projection 未知错误";
          response.meta.warnings.push(`结构化质量信号写入失败：${projectionMessage}`);
          markEvaluateResponseDegraded(response);
          console.warn(`[EVALUATE] runId=${input.runId} STREAM_PROJECTION_FAILED ${projectionMessage}`);
        }
        send({ type: "result", result: response });
      } catch (error) {
        const message = error instanceof Error ? error.message : "evaluate 未知错误";
        send({ type: "error", message });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * Persist a completed evaluate response and surface write failures as warnings.
 *
 * @param response Completed evaluate response.
 */
async function persistCompletedEvaluateResult(response: Awaited<ReturnType<typeof runEvaluatePipeline>>): Promise<void> {
  try {
    const savedPath = await persistEvaluateResult(response);
    console.info(`[EVALUATE] runId=${response.runId} SAVED path=${savedPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "评估结果保存失败";
    response.meta.warnings.push(`评估结果保存失败：${message}`);
    markEvaluateResponseDegraded(response);
    console.warn(`[EVALUATE] runId=${response.runId} SAVE_FAILED ${message}`);
  }
}

/**
 * Mark an otherwise completed response as degraded after non-blocking warnings.
 * @param response Completed evaluate response.
 */
function markEvaluateResponseDegraded(response: Awaited<ReturnType<typeof runEvaluatePipeline>>): void {
  if (response.meta.runState !== "failed") {
    response.meta.runState = "degraded";
  }
}
