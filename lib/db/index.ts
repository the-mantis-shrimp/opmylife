/**
 * Postgres access. A single shared pool per process (web or worker). The DB is
 * the source of truth for the whole pipeline — see docs/data-model.md.
 *
 * `query` for one-off statements; `tx` for transactions (used by the charge
 * point, which must write the ledger + flip renders.charged atomically).
 */
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "../env";

let _pool: Pool | null = null;

export function pool(): Pool {
  if (_pool) return _pool;
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set — cannot open a Postgres pool.");
  }
  _pool = new Pool({
    connectionString: env.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool().query<T>(text, params as never[]);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction. Rolls back on throw. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
