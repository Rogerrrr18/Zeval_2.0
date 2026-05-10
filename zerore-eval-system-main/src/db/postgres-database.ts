/**
 * @fileoverview PostgreSQL adapter for the generic ZeroreDatabase contract.
 */

import { Pool } from "pg";
import type { PoolConfig } from "pg";
import type { DbDataScope, DbRecord, ZeroreDatabase } from "@/db";

type ZeroreRecordRow = {
  id: string;
  organization_id?: string;
  project_id?: string;
  workspace_id: string;
  type: string;
  payload: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

/**
 * JSONB-backed Postgres adapter used as the first production database bridge.
 *
 * The long-term target is typed relational tables. This bridge intentionally
 * keeps the current `ZeroreDatabase` contract stable while projection writes
 * are moved out of the filesystem.
 */
export class PostgresDatabase implements ZeroreDatabase {
  private readonly pool: Pool;
  private ready: Promise<void> | null = null;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
  }

  async upsert(record: DbRecord): Promise<void> {
    await runWithTransientDatabaseRetry(
      `upsert zerore_record ${record.workspaceId}/${record.type}/${record.id}`,
      async () => {
        await this.ensureReady();
        const organizationId = resolveOrganizationId(record.organizationId);
        const projectId = resolveProjectId(record.projectId, record.workspaceId);
        await this.pool.query(
          `
            insert into zerore_records (
              organization_id,
              project_id,
              workspace_id,
              type,
              id,
              payload,
              created_at,
              updated_at
            )
            values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
            on conflict (workspace_id, type, id)
            do update set
              organization_id = excluded.organization_id,
              project_id = excluded.project_id,
              payload = excluded.payload,
              updated_at = excluded.updated_at
          `,
          [
            organizationId,
            projectId,
            record.workspaceId,
            record.type,
            record.id,
            JSON.stringify(record.payload),
            record.createdAt,
            record.updatedAt,
          ],
        );
      },
    );
  }

  async get(workspaceId: string, type: string, id: string, scope: DbDataScope = {}): Promise<DbRecord | null> {
    const result = await runWithTransientDatabaseRetry(
      `get zerore_record ${workspaceId}/${type}/${id}`,
      async () => {
        await this.ensureReady();
        const organizationId = resolveOrganizationId(scope.organizationId);
        const projectId = resolveProjectId(scope.projectId, workspaceId);
        return this.pool.query<ZeroreRecordRow>(
          `
            select id, organization_id, project_id, workspace_id, type, payload, created_at, updated_at
            from zerore_records
            where workspace_id = $1 and type = $2 and id = $3
              and organization_id = $4
              and project_id = $5
            limit 1
          `,
          [workspaceId, type, id, organizationId, projectId],
        );
      },
    );
    return result.rows[0] ? rowToDbRecord(result.rows[0]) : null;
  }

  async list(workspaceId: string, type: string, scope: DbDataScope = {}): Promise<DbRecord[]> {
    const result = await runWithTransientDatabaseRetry(
      `list zerore_records ${workspaceId}/${type}`,
      async () => {
        await this.ensureReady();
        const organizationId = resolveOrganizationId(scope.organizationId);
        const projectId = resolveProjectId(scope.projectId, workspaceId);
        return this.pool.query<ZeroreRecordRow>(
          `
            select id, organization_id, project_id, workspace_id, type, payload, created_at, updated_at
            from zerore_records
            where workspace_id = $1 and type = $2
              and organization_id = $3
              and project_id = $4
            order by updated_at desc
          `,
          [workspaceId, type, organizationId, projectId],
        );
      },
    );
    return result.rows.map(rowToDbRecord);
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.pool.query(BRIDGE_TABLE_SQL).then(() => undefined);
    this.ready = this.ready.catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }
}

/**
 * Create a Postgres database adapter from environment variables.
 *
 * @returns Postgres database adapter.
 */
export function createPostgresDatabaseFromEnv(): PostgresDatabase {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required when ZEVAL_DATABASE_ADAPTER=postgres.");
  }
  return new PostgresDatabase({
    connectionString,
    ssl: resolveSslConfig(connectionString),
    max: Number(process.env.ZEVAL_POSTGRES_POOL_MAX ?? process.env.ZERORE_POSTGRES_POOL_MAX ?? 5),
  });
}

function rowToDbRecord(row: ZeroreRecordRow): DbRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    type: row.type,
    payload: row.payload,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function resolveOrganizationId(value: string | undefined): string {
  return value?.trim() || process.env.ZEVAL_DEFAULT_ORGANIZATION_ID || "default-org";
}

function resolveProjectId(value: string | undefined, workspaceId: string): string {
  return value?.trim() || workspaceId;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function resolveSslConfig(connectionString: string): PoolConfig["ssl"] {
  const sslMode = process.env.ZEVAL_POSTGRES_SSL ?? process.env.ZERORE_POSTGRES_SSL ?? "auto";
  if (sslMode === "disable") {
    return false;
  }
  if (sslMode === "require" || /supabase|neon|render|railway/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

/**
 * Retry one database operation when the connection fails transiently.
 * @param label Operation label used in warnings.
 * @param operation Database operation to execute.
 * @returns Operation result.
 */
async function runWithTransientDatabaseRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const maxAttempts = Number(
    process.env.ZEVAL_POSTGRES_RETRY_ATTEMPTS ?? process.env.ZERORE_POSTGRES_RETRY_ATTEMPTS ?? 3,
  );
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientDatabaseError(error)) {
        throw error;
      }
      const delayMs = 150 * attempt;
      console.warn(
        `[DB] transient postgres error during ${label}; retrying ${attempt}/${maxAttempts - 1} in ${delayMs}ms: ${getErrorMessage(error)}`,
      );
      await delay(delayMs);
    }
  }

  throw lastError;
}

/**
 * Detect connection-level database errors worth retrying.
 * @param error Unknown thrown value from pg.
 * @returns Whether retrying is likely to help.
 */
function isTransientDatabaseError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = getErrorMessage(error);
  return (
    [
      "08000",
      "08003",
      "08006",
      "57P01",
      "57P02",
      "53300",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(code) ||
    /Connection terminated unexpectedly|Connection terminated|timeout|socket hang up/i.test(message)
  );
}

/**
 * Extract a stable error message for logging.
 * @param error Unknown thrown value.
 * @returns Human-readable message.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait for a short backoff interval.
 * @param ms Milliseconds to wait.
 * @returns Promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const BRIDGE_TABLE_SQL = `
  create table if not exists zerore_records (
    organization_id text not null default 'default-org',
    project_id text not null default 'default',
    workspace_id text not null,
    type text not null,
    id text not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (workspace_id, type, id)
  );

  alter table zerore_records
    add column if not exists organization_id text not null default 'default-org';

  alter table zerore_records
    add column if not exists project_id text;

  update zerore_records
    set project_id = workspace_id
    where project_id is null;

  alter table zerore_records
    alter column project_id set not null;

  create index if not exists idx_zerore_records_workspace_type_updated
    on zerore_records(workspace_id, type, updated_at desc);

  create index if not exists idx_zerore_records_org_project_type_updated
    on zerore_records(organization_id, project_id, type, updated_at desc);
`;
