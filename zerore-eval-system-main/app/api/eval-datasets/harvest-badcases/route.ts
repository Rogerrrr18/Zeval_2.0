import { NextResponse } from "next/server";
import { getZeroreRequestContext } from "@/auth/context";
import { harvestBadCasesToDataset } from "@/eval-datasets/harvest-badcases";
import { createDatasetStore } from "@/eval-datasets/storage";
import { evalDatasetHarvestBadcasesBodySchema } from "@/schemas/eval-datasets";
import type { EvaluateResponse } from "@/types/pipeline";

/**
 * Persist extracted bad case assets from one evaluate response into eval-datasets.
 * @param request Incoming HTTP request.
 */
export async function POST(request: Request) {
  try {
    const parsedBody = evalDatasetHarvestBadcasesBodySchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json({ error: "请求体不合法。", details: parsedBody.error.flatten() }, { status: 400 });
    }

    const context = getZeroreRequestContext(request);
    const store = createDatasetStore({ workspaceId: context.workspaceId });
    const result = await harvestBadCasesToDataset({
      store,
      evaluate: parsedBody.data.evaluate as unknown as EvaluateResponse,
      baselineVersion: parsedBody.data.baselineVersion,
      allowNearDuplicate: parsedBody.data.allowNearDuplicate,
    });

    return NextResponse.json({
      savedCount: result.savedCaseIds.length,
      savedCaseIds: result.savedCaseIds,
      skippedCount: result.skipped.length,
      skipped: result.skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "沉淀 bad case 失败。", detail: message }, { status: 500 });
  }
}
