import { NextResponse } from "next/server";
import { getZeroreRequestContext } from "@/auth/context";
import { runEvaluatePipeline } from "@/pipeline/evaluateRun";
import { replayAssistantRowsWithHttpApi, resolveReplyEndpoint } from "@/online-eval/replayAssistant";
import { createWorkbenchBaselineStore } from "@/workbench";
import { onlineReplayEvaluateBodySchema } from "@/schemas/online-eval";
import type { EvaluateResponse } from "@/types/pipeline";

/**
 * Replay assistant lines via HTTP reply API, then run the full evaluate pipeline.
 * @param request JSON body with baselineRef or rawRows and optional replyApiBaseUrl.
 */
export async function POST(request: Request) {
  try {
    const parsed = onlineReplayEvaluateBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "请求体不合法。", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;
    const context = getZeroreRequestContext(request);

    let rawRows = body.rawRows;
    let baselineEvaluate: EvaluateResponse | undefined;
    if (body.baselineRef) {
      const store = createWorkbenchBaselineStore({ workspaceId: context.workspaceId });
      const snapshot = await store.read(body.baselineRef.customerId, body.baselineRef.runId);
      if (!snapshot) {
        return NextResponse.json({ error: "未找到基线快照，请检查 customerId 与 runId。" }, { status: 404 });
      }
      rawRows = snapshot.rawRows;
      baselineEvaluate = snapshot.evaluate;
    }

    if (!rawRows?.length) {
      return NextResponse.json({ error: "rawRows 为空。" }, { status: 400 });
    }

    const baseUrl =
      body.replyApiBaseUrl?.trim() ||
      process.env.SILICONFLOW_CUSTOMER_API_URL?.trim() ||
      "http://127.0.0.1:4200";
    const replyEndpoint = resolveReplyEndpoint(baseUrl);

    const replayedRows = await replayAssistantRowsWithHttpApi(rawRows, replyEndpoint, {
      timeoutMs: body.replyTimeoutMs,
    });

    const runId = body.runId ?? `online_${Date.now()}`;
    const scenarioId = body.scenarioId ?? baselineEvaluate?.scenarioEvaluation?.scenarioId;
    const evaluate = await runEvaluatePipeline(replayedRows, {
      useLlm: body.useLlm ?? true,
      runId,
      scenarioId,
    });
    evaluate.meta.workspaceId = context.workspaceId;

    return NextResponse.json({
      runId: evaluate.runId,
      replyEndpoint,
      replayedRowCount: replayedRows.length,
      baselineRunId: body.baselineRef?.runId,
      baselineEvaluate,
      evaluate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "在线回放评估失败。", detail: message }, { status: 500 });
  }
}
