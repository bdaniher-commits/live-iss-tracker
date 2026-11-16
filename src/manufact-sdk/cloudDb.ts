/**
 * App Cloud database (bridge 1.8): the app's shared Postgres schema, reached
 * as `cloud.db`. Needs `permissions.cloud.db`.
 *
 * One statement per call: SELECT / INSERT / UPDATE / DELETE (WITH, ON
 * CONFLICT and RETURNING allowed). Bind values with `?` (or `$1…`) params,
 * never concatenate them into the SQL. Row-level security runs as the current
 * user: a row a policy hides is simply not there, and a write a policy
 * refuses fails with CLOUD_SQL_ERROR (`details.sqlstate` "42501").
 */
import { request } from "./index";

export interface CloudStatement {
  sql: string;
  params?: unknown[];
}

export interface CloudQueryResult {
  columns: string[];
  /** Postgres type names of the columns, when the server sends them. */
  columnTypes?: string[];
  /** Row values: timestamptz as ISO 8601 strings, bytea as base64. */
  rows: unknown[][];
  /** Rows returned, or rows changed by a write without RETURNING. */
  rowCount: number;
  /** More than 1,000 rows (or 2 MB): page with LIMIT / OFFSET. */
  truncated: boolean;
}

/** A result as objects keyed by column name. */
export type CloudQueryRows<T = Record<string, unknown>> = T[];

/** Read (SELECT, or a write with RETURNING you want rows from). */
export function query(sql: string, params: unknown[] = []) {
  return request<CloudQueryResult>("cloud.db.query", { sql, params });
}

/** Write (INSERT / UPDATE / DELETE); `rowCount` says how many rows changed. */
export function exec(sql: string, params: unknown[] = []) {
  return request<CloudQueryResult>("cloud.db.exec", { sql, params });
}

/** Up to 20 statements in one transaction: all succeed or none does. */
export function batch(statements: CloudStatement[]) {
  return request<{ results: CloudQueryResult[] }>("cloud.db.batch", {
    statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
  });
}

/** Turn a result into objects: `rows(await cloud.db.query(…))`. */
export function rows<T = Record<string, unknown>>(r: CloudQueryResult): CloudQueryRows<T> {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])) as T);
}
