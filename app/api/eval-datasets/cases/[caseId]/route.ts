import { NextResponse } from "next/server";
import { getZeroreRequestContext } from "@/auth/context";
import { createDatasetStore } from "@/eval-datasets/storage";
import { evalDatasetUpdateCaseBodySchema } from "@/schemas/eval-datasets";

type RouteContext = {
  params: Promise<{ caseId: string }>;
};

/**
 * Read one dataset case and optional baseline snapshot.
 * @param _request Incoming HTTP request.
 * @param context Dynamic route params.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const requestContext = getZeroreRequestContext(request);
    const { caseId } = await context.params;
    const store = createDatasetStore({ workspaceId: requestContext.workspaceId });
    const datasetCase = await store.getCaseById(caseId);
    if (!datasetCase) {
      return NextResponse.json({ error: `未找到案例: ${caseId}` }, { status: 404 });
    }
    const baseline = await store.getBaseline(caseId);
    return NextResponse.json({ case: datasetCase, baseline });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "读取评测案例失败。", detail: message }, { status: 500 });
  }
}

/**
 * Update lightweight human review fields for one dataset case.
 * @param request Incoming HTTP request.
 * @param context Dynamic route params.
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const parsedBody = evalDatasetUpdateCaseBodySchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json({ error: "请求体不合法。", details: parsedBody.error.flatten() }, { status: 400 });
    }

    const requestContext = getZeroreRequestContext(request);
    const { caseId } = await context.params;
    const store = createDatasetStore({ workspaceId: requestContext.workspaceId });
    const datasetCase = await store.getCaseById(caseId);
    if (!datasetCase) {
      return NextResponse.json({ error: `未找到案例: ${caseId}` }, { status: 404 });
    }

    const now = new Date().toISOString();
    const nextCase = {
      ...datasetCase,
      ...parsedBody.data,
      reviewStatus: parsedBody.data.reviewStatus ?? inferReviewStatus(parsedBody.data.humanVerdict, datasetCase.reviewStatus),
      reviewedAt: parsedBody.data.humanVerdict ? now : datasetCase.reviewedAt,
      updatedAt: now,
    };
    await store.updateCase(nextCase);
    return NextResponse.json({ case: nextCase });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "更新评测案例失败。", detail: message }, { status: 500 });
  }
}

/**
 * Infer review lifecycle status from a human verdict patch.
 * @param verdict Optional human verdict.
 * @param currentStatus Current case review status.
 * @returns Review lifecycle status.
 */
function inferReviewStatus(
  verdict?: string,
  currentStatus?: "auto_captured" | "human_reviewed" | "gold_candidate" | "gold" | "regression_active",
): "auto_captured" | "human_reviewed" | "gold_candidate" | "gold" | "regression_active" {
  return verdict ? "human_reviewed" : currentStatus ?? "auto_captured";
}
