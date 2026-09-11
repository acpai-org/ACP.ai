// Drizzle ORM driver for Node's built-in SQLite (node:sqlite, DatabaseSync).
//
// Why this file exists: drizzle-orm 0.45.x ships no `node:sqlite` driver, and
// the app is written entirely against the SYNCHRONOUS query surface
// (db.select().all()/.get()/.run()) that only better-sqlite3-style drivers
// provide. Node's built-in node:sqlite exposes the same synchronous surface
// (DatabaseSync.prepare().all()/.get()/.run()), so this driver is a faithful
// port of drizzle-orm's official better-sqlite3 session/driver
// (drizzle-orm/better-sqlite3/{session,driver}.js, v0.45.2), with exactly
// three behavioral adaptations:
//
//   1. `stmt.raw()` (better-sqlite3 positional/array row mode) is replaced by
//      `stmt.setReturnArrays(true/false)` (node:sqlite's equivalent), toggled
//      around each execution so the row shape is deterministic per call —
//      array rows for values()/get()-with-fields (what the base driver used
//      raw() for), object rows everywhere else.
//   2. `client.transaction(cb)` (better-sqlite3's JS transaction helper) is
//      replaced with plain `BEGIN/COMMIT/ROLLBACK` — identical SQLite
//      transaction semantics, including nested savepoints.
//   3. Run results are typed as { changes, lastInsertRowid } — the shape
//      node:sqlite's StatementSync.run() returns. `changes` is typed `number`
//      (matching @types/better-sqlite3's RunResult): this driver never calls
//      setReadBigInts(true), so node:sqlite always returns plain numbers.
//
// The app never calls db.transaction() today (verified by grep; kept correct
// here anyway) and applies its schema at runtime via ensureDb() rather than
// drizzle-kit migrations, so no migrator is provided.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { entityKind } from "drizzle-orm/entity";
import { DefaultLogger, type Logger, NoopLogger } from "drizzle-orm/logger";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type ExtractTablesWithRelations,
  type RelationalSchemaConfig,
  type TablesRelationalConfig,
} from "drizzle-orm/relations";
import { fillPlaceholders, sql, type Query } from "drizzle-orm/sql/sql";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import {
  SQLitePreparedQuery as PreparedQueryBase,
  SQLiteSession,
  type PreparedQueryConfig as PreparedQueryConfigBase,
  type SQLiteExecuteMethod,
  type SQLiteTransactionConfig,
} from "drizzle-orm/sqlite-core/session";
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types";
import { type DrizzleConfig } from "drizzle-orm/utils";
import { NoopCache, type Cache } from "drizzle-orm/cache/core";
import type { WithCacheConfig } from "drizzle-orm/cache/core/types";

// mapResultRow exists at runtime in drizzle-orm/utils (drizzle's own
// better-sqlite3 session uses it for every select) but is not part of the
// package's public .d.ts surface — reach it through a typed cast.
import * as drizzleUtils from "drizzle-orm/utils";
const mapResultRow = (drizzleUtils as unknown as {
  mapResultRow: (
    fields: SelectedFieldsOrdered,
    row: unknown[],
    joinsNotNullableMap: Record<string, boolean> | undefined,
  ) => Record<string, unknown>;
}).mapResultRow;

/** Shape returned by StatementSync.run() — matches better-sqlite3's RunResult. */
export type NodeSqliteRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

/** node:sqlite's accepted positional bind values (SQLInputValue). */
type SqlBindValue = null | number | bigint | string | NodeJS.ArrayBufferView;

export interface NodeSqliteSessionOptions {
  logger?: Logger;
  cache?: Cache;
}

type PreparedQueryConfig = Omit<PreparedQueryConfigBase, "statement" | "run">;

export class NodeSqliteSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteSession<"sync", NodeSqliteRunResult, TFullSchema, TSchema> {
  static readonly [entityKind]: string = "NodeSqliteSession";

  private client: DatabaseSync;
  private schema: RelationalSchemaConfig<TSchema> | undefined;
  private readonly nodeDialect: SQLiteSyncDialect;
  private logger: Logger;
  private cache: Cache;

  constructor(
    client: DatabaseSync,
    dialect: SQLiteSyncDialect,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    options: NodeSqliteSessionOptions = {},
  ) {
    super(dialect);
    this.client = client;
    this.schema = schema;
    this.nodeDialect = dialect;
    this.logger = options.logger ?? new NoopLogger();
    this.cache = options.cache ?? new NoopCache();
  }

  prepareQuery(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
    queryMetadata?: { type: "select" | "update" | "delete" | "insert"; tables: string[] },
    cacheConfig?: WithCacheConfig,
  ): NodeSqlitePreparedQuery<PreparedQueryConfig & { type: "sync" }> {
    const stmt = this.client.prepare(query.sql);
    return new NodeSqlitePreparedQuery(
      stmt,
      query,
      this.logger,
      this.cache,
      queryMetadata,
      cacheConfig,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  transaction<T>(
    transaction: (tx: NodeSqliteTransaction<TFullSchema, TSchema>) => T,
    config: SQLiteTransactionConfig = {},
  ): T {
    // BEGIN DEFERRED|IMMEDIATE|EXCLUSIVE — the same three behaviors the base
    // driver exposed via better-sqlite3's transaction.deferred()/… helpers.
    const behavior = config.behavior ?? "deferred";
    this.client.exec(`BEGIN ${behavior}`);
    const tx = new NodeSqliteTransaction<TFullSchema, TSchema>(this.nodeDialect, this, this.schema);
    try {
      const result = transaction(tx);
      this.client.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.client.exec("ROLLBACK");
      } catch {
        /* connection already rolled back / no active transaction */
      }
      throw err;
    }
  }
}

export class NodeSqliteTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<"sync", NodeSqliteRunResult, TFullSchema, TSchema> {
  static readonly [entityKind]: string = "NodeSqliteTransaction";

  private readonly nodeDialect: SQLiteSyncDialect;
  private readonly nodeSession: NodeSqliteSession<TFullSchema, TSchema>;

  constructor(
    dialect: SQLiteSyncDialect,
    session: NodeSqliteSession<TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex = 0,
  ) {
    super("sync", dialect, session, schema, nestedIndex);
    this.nodeDialect = dialect;
    this.nodeSession = session;
  }

  transaction<T>(transaction: (tx: NodeSqliteTransaction<TFullSchema, TSchema>) => T): T {
    const savepointName = `sp${this.nestedIndex}`;
    const tx = new NodeSqliteTransaction<TFullSchema, TSchema>(
      this.nodeDialect,
      this.nodeSession,
      this.schema,
      this.nestedIndex + 1,
    );
    this.nodeSession.run(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = transaction(tx);
      this.nodeSession.run(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (err) {
      this.nodeSession.run(sql.raw(`rollback to savepoint ${savepointName}`));
      throw err;
    }
  }
}

export class NodeSqlitePreparedQuery<
  T extends PreparedQueryConfig = PreparedQueryConfig,
> extends PreparedQueryBase<{
  type: "sync";
  run: NodeSqliteRunResult;
  all: T["all"];
  get: T["get"];
  values: T["values"];
  execute: T["execute"];
}> {
  static readonly [entityKind]: string = "NodeSqlitePreparedQuery";

  private stmt: StatementSync;
  private logger: Logger;
  private fields: SelectedFieldsOrdered | undefined;
  private _isResponseInArrayMode: boolean;
  private customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown;

  constructor(
    stmt: StatementSync,
    query: Query,
    logger: Logger,
    cache: Cache,
    queryMetadata: { type: "select" | "update" | "delete" | "insert"; tables: string[] } | undefined,
    cacheConfig: WithCacheConfig | undefined,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    _isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
  ) {
    super("sync", executeMethod, query, cache, queryMetadata, cacheConfig);
    this.stmt = stmt;
    this.logger = logger;
    this.fields = fields;
    this._isResponseInArrayMode = _isResponseInArrayMode;
    this.customResultMapper = customResultMapper;
  }

  run(placeholderValues?: Record<string, unknown>): NodeSqliteRunResult {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {}) as SqlBindValue[];
    this.logger.logQuery(this.query.sql, params);
    return this.stmt.run(...params) as NodeSqliteRunResult;
  }

  all(placeholderValues?: Record<string, unknown>): T["all"] {
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      const params = fillPlaceholders(this.query.params, placeholderValues ?? {}) as SqlBindValue[];
      this.logger.logQuery(this.query.sql, params);
      return this.stmt.all(...params) as T["all"];
    }
    const rows = this.values(placeholderValues) as unknown[][];
    if (customResultMapper) {
      return customResultMapper(rows) as T["all"];
    }
    return rows.map((row) => mapResultRow(fields as SelectedFieldsOrdered, row, undefined)) as T["all"];
  }

  get(placeholderValues?: Record<string, unknown>): T["get"] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {}) as SqlBindValue[];
    this.logger.logQuery(this.query.sql, params);
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      return this.stmt.get(...params) as T["get"];
    }
    // Mirror of the base driver's `stmt.raw().get(...)` — array-mode row:
    this.stmt.setReturnArrays(true);
    try {
      const row = this.stmt.get(...params) as unknown[] | undefined;
      if (!row) {
        return undefined as T["get"];
      }
      if (customResultMapper) {
        return customResultMapper([row]) as T["get"];
      }
      return mapResultRow(fields as SelectedFieldsOrdered, row, undefined) as T["get"];
    } finally {
      this.stmt.setReturnArrays(false);
    }
  }

  values(placeholderValues?: Record<string, unknown>): T["values"] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {}) as SqlBindValue[];
    this.logger.logQuery(this.query.sql, params);
    // Mirror of the base driver's `stmt.raw().all(...)` — array-mode rows:
    this.stmt.setReturnArrays(true);
    try {
      return this.stmt.all(...params) as T["values"];
    } finally {
      this.stmt.setReturnArrays(false);
    }
  }

  /** @internal */
  isResponseInArrayMode(): boolean {
    return this._isResponseInArrayMode;
  }
}

export class NodeSqliteDatabase<TSchema extends Record<string, unknown> = Record<string, never>> extends BaseSQLiteDatabase<
  "sync",
  NodeSqliteRunResult,
  TSchema
> {
  static readonly [entityKind]: string = "NodeSqliteDatabase";
}

/**
 * drizzle(client, config) — drop-in replacement for the better-sqlite3
 * `drizzle()` factory, accepting a node:sqlite DatabaseSync instance.
 */
export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: DatabaseSync,
  config: DrizzleConfig<TSchema> = {},
): NodeSqliteDatabase<TSchema> & { $client: DatabaseSync } {
  const dialect = new SQLiteSyncDialect({ casing: config.casing });
  let logger: Logger | undefined;
  if (config.logger === true) {
    logger = new DefaultLogger();
  } else if (config.logger !== false) {
    logger = config.logger;
  }
  let schema: RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig<ExtractTablesWithRelations<TSchema>>(
      config.schema,
      createTableRelationsHelpers,
    );
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }
  const session = new NodeSqliteSession<TSchema, ExtractTablesWithRelations<TSchema>>(client, dialect, schema, {
    logger,
  });
  const db = new NodeSqliteDatabase<TSchema>("sync", dialect, session, schema);
  (db as unknown as { $client: DatabaseSync }).$client = client;
  return db as NodeSqliteDatabase<TSchema> & { $client: DatabaseSync };
}
