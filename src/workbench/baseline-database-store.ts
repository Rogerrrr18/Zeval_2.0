/**
 * @fileoverview ZeroreDatabase-backed workbench baseline store.
 *
 * P2 升级：除了写入 JSONB 桥接表（向后兼容）以外，
 * 当 postgres 适配器可用时同时写入 typed Supabase 表
 * （baselines + baseline_runs），以满足 P2 验收标准。
 */

import { createZeroreDatabase, type ZeroreDatabase } from "@/db";
import { buildBaselineProjection } from "@/db/evaluation-projection";
import { createSupabaseTypedDatabase } from "@/db/supabase-typed-database";
import type { SupabaseTypedDatabase } from "@/db/supabase-typed-database";
import type { WorkbenchBaselineStore } from "@/workbench/baseline-store";
import { sanitizeRunIdForFile } from "@/workbench/baseline-file-store";
import type { WorkbenchBaselineIndexRow, WorkbenchBaselineLookup, WorkbenchBaselineSnapshot } from "@/workbench/types";

const WORKBENCH_BASELINE_TYPE = "workbench_baselines";

/**
 * WorkbenchBaselineStore implementation backed by the active ZeroreDatabase adapter.
 *
 * Dual-write strategy (P2):
 *  1. Always writes to the JSONB bridge (ZeroreDatabase) for local-dev + backwards compat.
 *  2. When DATABASE_URL is configured, also writes to typed `baselines` / `baseline_runs` tables.
 *     Typed write failures are logged as warnings and do NOT block the save operation.
 */
export class DatabaseWorkbenchBaselineStore implements WorkbenchBaselineStore {
  private readonly workspaceId: string;
  private database: Promise<ZeroreDatabase> | null = null;
  private typedDb: SupabaseTypedDatabase | null | undefined = undefined; // undefined = not yet resolved

  constructor(workspaceId?: string) {
    this.workspaceId = workspaceId ?? "default";
  }

  async save(snapshot: WorkbenchBaselineSnapshot): Promise<void> {
    // 1. JSONB bridge (always)
    await (await this.getDatabase()).upsert({
      id: baselineRecordId(snapshot.customerId, snapshot.runId),
      projectId: this.workspaceId,
      type: WORKBENCH_BASELINE_TYPE,
      payload: snapshot,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt,
    });

    // 2. Typed tables (P2 — best-effort, non-blocking)
    const typedDb = this.getTypedDb();
    if (typedDb) {
      try {
        const projection = buildBaselineProjection(snapshot, this.workspaceId);
        await typedDb.writeBaselineProjection(projection);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[BaselineStore] typed-table write failed (non-blocking): ${msg}`);
      }
    }
  }

  async list(customerId: string): Promise<WorkbenchBaselineIndexRow[]> {
    const records = await (await this.getDatabase()).list(this.workspaceId, WORKBENCH_BASELINE_TYPE);
    return records
      .map((record) => record.payload as WorkbenchBaselineSnapshot)
      .filter((snapshot) => snapshot.customerId === customerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((snapshot) => ({
        runId: snapshot.runId,
        createdAt: snapshot.createdAt,
        label: snapshot.label,
        sourceFileName: snapshot.sourceFileName,
        fileName: `${sanitizeRunIdForFile(snapshot.runId)}.json`,
      }));
  }

  async read(customerId: string, runId: string): Promise<WorkbenchBaselineSnapshot | null> {
    const record = await (await this.getDatabase()).get(
      this.workspaceId,
      WORKBENCH_BASELINE_TYPE,
      baselineRecordId(customerId, runId),
    );
    return record?.payload ? (record.payload as WorkbenchBaselineSnapshot) : null;
  }

  async findByRunId(runId: string): Promise<WorkbenchBaselineLookup | null> {
    const records = await (await this.getDatabase()).list(this.workspaceId, WORKBENCH_BASELINE_TYPE);
    const snapshot = records.map((record) => record.payload as WorkbenchBaselineSnapshot).find((item) => item.runId === runId);
    return snapshot
      ? {
          customerId: snapshot.customerId,
          snapshot,
        }
      : null;
  }

  private getDatabase(): Promise<ZeroreDatabase> {
    this.database ??= createZeroreDatabase();
    return this.database;
  }

  /** Returns a SupabaseTypedDatabase when DATABASE_URL is configured, null otherwise. */
  private getTypedDb(): SupabaseTypedDatabase | null {
    if (this.typedDb === undefined) {
      try {
        this.typedDb = createSupabaseTypedDatabase();
      } catch {
        this.typedDb = null;
      }
    }
    return this.typedDb;
  }
}

function baselineRecordId(customerId: string, runId: string): string {
  return `${safeId(customerId)}_${safeId(runId)}`;
}

function safeId(value: string): string {
  return (
    value
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 160) || "unknown"
  );
}
