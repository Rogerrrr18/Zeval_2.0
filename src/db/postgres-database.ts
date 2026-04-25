/**
 * @fileoverview PostgreSQL adapter for the generic ZeroreDatabase contract.
 */

import { Pool } from "pg";
import type { PoolConfig } from "pg";
import type { DbRecord, ZeroreDatabase } from "@/db";

type ZeroreRecordRow = {
  id: string;
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
    await this.ensureReady();
    await this.pool.query(
      `
        insert into zerore_records (workspace_id, type, id, payload, created_at, updated_at)
        values ($1, $2, $3, $4::jsonb, $5, $6)
        on conflict (workspace_id, type, id)
        do update set
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `,
      [
        record.workspaceId,
        record.type,
        record.id,
        JSON.stringify(record.payload),
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(workspaceId: string, type: string, id: string): Promise<DbRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<ZeroreRecordRow>(
      `
        select id, workspace_id, type, payload, created_at, updated_at
        from zerore_records
        where workspace_id = $1 and type = $2 and id = $3
        limit 1
      `,
      [workspaceId, type, id],
    );
    return result.rows[0] ? rowToDbRecord(result.rows[0]) : null;
  }

  async list(workspaceId: string, type: string): Promise<DbRecord[]> {
    await this.ensureReady();
    const result = await this.pool.query<ZeroreRecordRow>(
      `
        select id, workspace_id, type, payload, created_at, updated_at
        from zerore_records
        where workspace_id = $1 and type = $2
        order by updated_at desc
      `,
      [workspaceId, type],
    );
    return result.rows.map(rowToDbRecord);
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.pool.query(BRIDGE_TABLE_SQL).then(() => undefined);
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
    throw new Error("DATABASE_URL is required when ZERORE_DATABASE_ADAPTER=postgres.");
  }
  return new PostgresDatabase({
    connectionString,
    ssl: resolveSslConfig(connectionString),
    max: Number(process.env.ZERORE_POSTGRES_POOL_MAX ?? 5),
  });
}

function rowToDbRecord(row: ZeroreRecordRow): DbRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    payload: row.payload,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function resolveSslConfig(connectionString: string): PoolConfig["ssl"] {
  const sslMode = process.env.ZERORE_POSTGRES_SSL ?? "auto";
  if (sslMode === "disable") {
    return false;
  }
  if (sslMode === "require" || /supabase|neon|render|railway/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

const BRIDGE_TABLE_SQL = `
  create table if not exists zerore_records (
    workspace_id text not null,
    type text not null,
    id text not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (workspace_id, type, id)
  );

  create index if not exists idx_zerore_records_workspace_type_updated
    on zerore_records(workspace_id, type, updated_at desc);
`;
