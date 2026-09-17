import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { NextRequest, NextResponse } from 'next/server';
import { serializeBigInt } from '@/lib/serializeBigInt';
import { requireSystemAdmin as requireAdmin } from '@/app/lib/system-admin';

export const runtime = 'nodejs';

type SqlLike = postgres.Sql | postgres.TransactionSql;

const DEFAULT_PREVIEW_LIMIT = 100;
const MAX_PREVIEW_LIMIT = 1000;
const TRANSFER_CHUNK_SIZE = 200;
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DATABASE_TIME_ZONE = process.env.DATABASE_TIME_ZONE ?? process.env.DB_TIMEZONE ?? 'UTC';

type DbRole = 'source' | 'backup';
type TransferMode = 'upsert' | 'replace';

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_generated: 'ALWAYS' | 'NEVER';
}

interface TableNameResult {
  table_name: string;
}

interface CountResult {
  count: bigint;
}

interface AccountScope {
  whereClause: string;
  values: unknown[];
}

interface BackupLogResult {
  id: number;
  tableName: string;
  createdAt: string;
}

interface LastBackupResult {
  tableName: string;
  createdAt: string;
}

interface EstimatedCountResult {
  estimate: bigint | null;
}

interface ForeignKeyColumnInfo {
  constraint_name: string;
  column_name: string;
  referenced_table: string;
  referenced_column: string;
  ordinal_position: number;
}

interface ForeignKeyReference {
  constraintName: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

interface ReferencingForeignKey {
  constraintName: string;
  childTable: string;
  childColumns: string[];
  referencedColumns: string[];
}

interface SyncedDependencyResult {
  tableName: string;
  rows: number;
}

interface SkippedRelatedRowResult {
  tableName: string;
  referencedTable: string;
  constraintName: string;
  key: string;
  rows: number;
  reason: string;
}

interface DependencySyncResult {
  dependencies: SyncedDependencyResult[];
  skippedRows: SkippedRelatedRowResult[];
  validRows: Record<string, unknown>[];
}

interface EnvDatabase {
  url: string;
  label: string;
}

const DIRECT_ACCOUNT_COLUMNS = ['account_id', 'accid', 'AccID', 'claccid'];

const ACCOUNT_SCOPE_WHERE_BY_TABLE: Record<string, string> = {
  tblaccount: 'WHERE t."id" = $1',
  tblcustomerkey: 'WHERE EXISTS (SELECT 1 FROM "tblcustomers" c WHERE c."customerid" = t."customerid" AND c."accid" = $1)',
  tblcar_checklist_session: 'WHERE EXISTS (SELECT 1 FROM "tblcar" c WHERE c."id" = t."car_id" AND c."accid" = $1)',
  tblcust_checklist_session: 'WHERE EXISTS (SELECT 1 FROM "tblcustomers" c WHERE c."customerid" = t."customer_id" AND c."accid" = $1)',
  tblchecklist_order: 'WHERE EXISTS (SELECT 1 FROM "tblcustomers" c WHERE c."customerid" = t."customer_id" AND c."accid" = $1)',
  tblchecklist_order_item: 'WHERE EXISTS (SELECT 1 FROM "tblchecklist_order" o JOIN "tblcustomers" c ON c."customerid" = o."customer_id" WHERE o."id" = t."order_id" AND c."accid" = $1)',
  tblpickup_order_item: 'WHERE EXISTS (SELECT 1 FROM "tblpickup_order" o WHERE o."id" = t."order_id" AND o."account_id" = $1)',
  tblpickup_order_session: 'WHERE EXISTS (SELECT 1 FROM "tblpickup_order" o WHERE o."id" = t."pickup_order_id" AND o."account_id" = $1)',
  tblreceipt_template_field: 'WHERE EXISTS (SELECT 1 FROM "tblreceipt_template" rt WHERE rt."id" = t."template_id" AND rt."account_id" = $1)',
  tbluser_checklist_session: 'WHERE EXISTS (SELECT 1 FROM "tblchecklisttemplate" ct WHERE ct."clid" = t."clid" AND ct."claccid" = $1)',
  tbluser_checklist_item: 'WHERE EXISTS (SELECT 1 FROM "tbluser_checklist_session" s JOIN "tblchecklisttemplate" ct ON ct."clid" = s."clid" WHERE s."sessionid" = t."sessionid" AND ct."claccid" = $1)',
  tblworklog: 'WHERE EXISTS (SELECT 1 FROM "tblworktemplate" wt WHERE wt."TemplateID" = t."WorkTemplateID" AND wt."AccID" = $1)',
};

function expandEnvValue(value: string, values: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, key) => {
    return values[key] ?? process.env[key] ?? match;
  });
}

function readDatabaseConfig(role: DbRole): EnvDatabase {
  const envFile = role === 'source' ? '.env.prod' : '.env.backup';
  const envPath = path.join(process.cwd(), envFile);
  const parsed = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const rawUrl = role === 'source'
    ? parsed.DATABASE_URL ?? process.env.DATABASE_URL
    : parsed.DATABASE_URL
      ?? parsed.BACKUP_DATABASE_URL
      ?? process.env.BACKUP_DATABASE_URL
      ?? process.env.DATABASE_URL_BACKUP;

  if (!rawUrl) {
    throw new Error(role === 'source'
      ? 'DATABASE_URL was not found in .env.prod'
      : 'Backup database URL is not configured. Set BACKUP_DATABASE_URL, DATABASE_URL_BACKUP, or .env.backup DATABASE_URL.'
    );
  }

  const url = expandEnvValue(rawUrl, parsed);
  let label = `${envFile} database`;

  try {
    const parsedUrl = new URL(url);
    label = `${parsedUrl.host}${parsedUrl.pathname}`;
  } catch {
    label = envFile;
  }

  return { url, label };
}

function sanitizeDatabaseUrl(url: string) {
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.username && !parsedUrl.password) {
      return parsedUrl.toString();
    }

    const credentials = parsedUrl.password ? '***:***@' : '***@';
    return `${parsedUrl.protocol}//${credentials}${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return url
      .replace(/:\/\/.*?:.*?@/, '://***:***@')
      .replace(/;Password=.*?;/i, ';Password=***;')
      .replace(/(pwd=)([^;]+)/i, '$1***');
  }
}

function normalizeDatabaseUrlForComparison(url: string) {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.username = '';
    parsedUrl.password = '';
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

function assertDistinctDatabaseConfigs(sourceConfig: EnvDatabase, backupConfig: EnvDatabase) {
  if (normalizeDatabaseUrlForComparison(sourceConfig.url) === normalizeDatabaseUrlForComparison(backupConfig.url)) {
    throw new Error('Operational and backup database URLs point to the same database. Check .env.prod and .env.backup before clearing table data.');
  }
}

function getConnectionPayload() {
  const sourceConfig = readDatabaseConfig('source');

  return {
    sourceDatabase: sourceConfig.label,
    sourceDatabaseUrl: sanitizeDatabaseUrl(sourceConfig.url),
  };
}

function createDb(config: EnvDatabase) {
  return postgres(config.url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
    connection: {
      TimeZone: DATABASE_TIME_ZONE,
      DateStyle: 'ISO, MDY',
    },
  });
}

function assertIdentifier(identifier: string, label: string) {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Invalid ${label}`);
  }
}

function quoteIdentifier(identifier: string): string {
  assertIdentifier(identifier, 'identifier');
  return `"${identifier.replace(/"/g, '""')}"`;
}

function parseAccountId(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Invalid account filter');
  }
  return BigInt(trimmed);
}

function getAccountScope(table: string, columns: ColumnInfo[], accountId: bigint | null): AccountScope | null {
  if (accountId === null) return null;

  const directColumn = DIRECT_ACCOUNT_COLUMNS.find((column) =>
    columns.some((tableColumn) => tableColumn.column_name === column)
  );

  if (directColumn) {
    return {
      whereClause: `WHERE t.${quoteIdentifier(directColumn)} = $1`,
      values: [accountId],
    };
  }

  const whereClause = ACCOUNT_SCOPE_WHERE_BY_TABLE[table];
  return whereClause ? { whereClause, values: [accountId] } : null;
}

function hasKnownAccountScope(table: string, columns: ColumnInfo[]) {
  return Boolean(
    ACCOUNT_SCOPE_WHERE_BY_TABLE[table]
    || DIRECT_ACCOUNT_COLUMNS.some((column) => columns.some((tableColumn) => tableColumn.column_name === column))
  );
}

async function listTables(sql: SqlLike) {
  return sql<TableNameResult[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;
}

async function tableExists(sql: SqlLike, table: string) {
  const rows = await sql<TableNameResult[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name = ${table};
  `;

  return rows.length > 0;
}

async function getColumns(sql: SqlLike, table: string) {
  return sql<ColumnInfo[]>`
    SELECT column_name, data_type, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
    ORDER BY ordinal_position;
  `;
}

function getTransferColumnNames(sourceColumns: ColumnInfo[], backupColumns: ColumnInfo[]) {
  const backupColumnByName = new Map(backupColumns.map((column) => [column.column_name, column]));

  return sourceColumns
    .filter((column) => column.is_generated !== 'ALWAYS')
    .filter((column) => backupColumnByName.get(column.column_name)?.is_generated !== 'ALWAYS')
    .map((column) => column.column_name);
}

function getMissingBackupColumnNames(sourceColumns: ColumnInfo[], backupColumns: ColumnInfo[]) {
  const backupColumnNames = new Set(backupColumns.map((column) => column.column_name));

  return sourceColumns
    .filter((column) => column.is_generated !== 'ALWAYS')
    .map((column) => column.column_name)
    .filter((column) => !backupColumnNames.has(column));
}

async function getPrimaryKeys(sql: SqlLike, table: string) {
  const rows = await sql<{ column_name: string }[]>`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = ${table}
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position;
  `;

  return rows.map((row) => row.column_name);
}

async function getForeignKeys(sql: SqlLike, table: string) {
  const rows = await sql<ForeignKeyColumnInfo[]>`
    SELECT
      con.conname AS constraint_name,
      child_att.attname AS column_name,
      parent.relname AS referenced_table,
      parent_att.attname AS referenced_column,
      keys.ordinality::integer AS ordinal_position
    FROM pg_constraint con
    JOIN pg_class child
      ON child.oid = con.conrelid
    JOIN pg_namespace child_ns
      ON child_ns.oid = child.relnamespace
    JOIN pg_class parent
      ON parent.oid = con.confrelid
    JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS keys(child_attnum, parent_attnum, ordinality)
      ON true
    JOIN pg_attribute child_att
      ON child_att.attrelid = child.oid
      AND child_att.attnum = keys.child_attnum
    JOIN pg_attribute parent_att
      ON parent_att.attrelid = parent.oid
      AND parent_att.attnum = keys.parent_attnum
    WHERE con.contype = 'f'
      AND child_ns.nspname = 'public'
      AND child.relname = ${table}
    ORDER BY con.conname, keys.ordinality;
  `;

  const foreignKeys = new Map<string, ForeignKeyReference>();
  rows.forEach((row) => {
    const existing = foreignKeys.get(row.constraint_name);

    if (existing) {
      existing.columns.push(row.column_name);
      existing.referencedColumns.push(row.referenced_column);
      return;
    }

    foreignKeys.set(row.constraint_name, {
      constraintName: row.constraint_name,
      columns: [row.column_name],
      referencedTable: row.referenced_table,
      referencedColumns: [row.referenced_column],
    });
  });

  return Array.from(foreignKeys.values());
}

async function getReferencingForeignKeys(sql: SqlLike, table: string) {
  const rows = await sql<(ForeignKeyColumnInfo & { child_table: string })[]>`
    SELECT
      con.conname AS constraint_name,
      child.relname AS child_table,
      child_att.attname AS column_name,
      parent.relname AS referenced_table,
      parent_att.attname AS referenced_column,
      keys.ordinality::integer AS ordinal_position
    FROM pg_constraint con
    JOIN pg_class child
      ON child.oid = con.conrelid
    JOIN pg_namespace child_ns
      ON child_ns.oid = child.relnamespace
    JOIN pg_class parent
      ON parent.oid = con.confrelid
    JOIN pg_namespace parent_ns
      ON parent_ns.oid = parent.relnamespace
    JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS keys(child_attnum, parent_attnum, ordinality)
      ON true
    JOIN pg_attribute child_att
      ON child_att.attrelid = child.oid
      AND child_att.attnum = keys.child_attnum
    JOIN pg_attribute parent_att
      ON parent_att.attrelid = parent.oid
      AND parent_att.attnum = keys.parent_attnum
    WHERE con.contype = 'f'
      AND child_ns.nspname = 'public'
      AND parent_ns.nspname = 'public'
      AND parent.relname = ${table}
    ORDER BY con.conname, keys.ordinality;
  `;

  const foreignKeys = new Map<string, ReferencingForeignKey>();
  rows.forEach((row) => {
    const existing = foreignKeys.get(row.constraint_name);

    if (existing) {
      existing.childColumns.push(row.column_name);
      existing.referencedColumns.push(row.referenced_column);
      return;
    }

    foreignKeys.set(row.constraint_name, {
      constraintName: row.constraint_name,
      childTable: row.child_table,
      childColumns: [row.column_name],
      referencedColumns: [row.referenced_column],
    });
  });

  return Array.from(foreignKeys.values());
}

async function countRows(sql: SqlLike, table: string, accountScope?: AccountScope | null) {
  const rows = await sql.unsafe<CountResult[]>(
    `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)} t ${accountScope?.whereClause ?? ''}`,
    (accountScope?.values ?? []) as never[]
  );
  return rows[0]?.count ?? BigInt(0);
}

async function clearRows(sql: SqlLike, table: string) {
  const rows = await sql.unsafe<CountResult[]>(
    `WITH deleted AS (DELETE FROM ${quoteIdentifier(table)} RETURNING 1) SELECT COUNT(*)::bigint AS count FROM deleted`
  );
  return rows[0]?.count ?? BigInt(0);
}

async function estimateRows(sql: SqlLike, table: string) {
  const rows = await sql<EstimatedCountResult[]>`
    SELECT GREATEST(c.reltuples, 0)::bigint AS estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ${table}
      AND c.relkind = 'r';
  `;

  return rows[0]?.estimate ?? null;
}

async function fetchRows(
  sql: SqlLike,
  table: string,
  limit: number,
  offset = 0,
  accountScope?: AccountScope | null
) {
  return sql.unsafe<Record<string, unknown>[]>(
    `SELECT * FROM ${quoteIdentifier(table)} t ${accountScope?.whereClause ?? ''} LIMIT $${(accountScope?.values.length ?? 0) + 1} OFFSET $${(accountScope?.values.length ?? 0) + 2}`,
    [...(accountScope?.values ?? []), limit, offset] as never[]
  );
}

function formatKeyValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

function serializeKey(values: unknown[]) {
  return values.map(formatKeyValue).join('\u001f');
}

function describeKey(columns: string[], values: unknown[]) {
  return columns.map((column, index) => `${column}=${formatKeyValue(values[index])}`).join(', ');
}

function buildDependencyKey(table: string, columns: string[], values: unknown[]) {
  return [
    table,
    columns.join('\u001f'),
    serializeKey(values),
  ].join('\u001e');
}

function buildSelectByKeysStatement(table: string, columns: string[], keys: unknown[][]) {
  const values: unknown[] = [];
  const quotedColumns = columns.map(quoteIdentifier);
  const predicates = keys.map((key) => {
    const placeholders = key.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });

    if (quotedColumns.length === 1) {
      return `${quotedColumns[0]} = ${placeholders[0]}`;
    }

    return `(${quotedColumns.join(', ')}) = (${placeholders.join(', ')})`;
  });

  return {
    query: `SELECT * FROM ${quoteIdentifier(table)} WHERE ${predicates.join(' OR ')}`,
    values,
  };
}

function buildDeleteByKeysStatement(table: string, columns: string[], keys: unknown[][]) {
  const deleteByKeys = buildSelectByKeysStatement(table, columns, keys);
  return {
    query: deleteByKeys.query.replace(/^SELECT \* FROM /, 'DELETE FROM '),
    values: deleteByKeys.values,
  };
}

async function fetchRowsByKeys(
  sql: SqlLike,
  table: string,
  columns: string[],
  keys: unknown[][]
) {
  if (keys.length === 0) return [];

  const select = buildSelectByKeysStatement(table, columns, keys);
  return sql.unsafe<Record<string, unknown>[]>(select.query, select.values as never[]);
}

async function removeReplaceStaleRows(
  source: SqlLike,
  backup: SqlLike,
  table: string,
  primaryKeys: string[],
  accountScope?: AccountScope | null
) {
  let deletedRows = 0;
  const skippedRows: SkippedRelatedRowResult[] = [];
  const keysToDelete: unknown[][] = [];
  const referencingForeignKeys = await getReferencingForeignKeys(backup, table);
  const backupRowCount = await countRows(backup, table, accountScope);

  for (let offset = 0; offset < Number(backupRowCount); offset += TRANSFER_CHUNK_SIZE) {
    const backupRows = await fetchRows(backup, table, TRANSFER_CHUNK_SIZE, offset, accountScope);
    if (backupRows.length === 0) break;

    const backupKeys = backupRows.map((row) => primaryKeys.map((column) => row[column] ?? null));
    const sourceRows = await fetchRowsByKeys(source, table, primaryKeys, backupKeys);
    const sourceKeys = new Set(
      sourceRows.map((row) => serializeKey(primaryKeys.map((column) => row[column] ?? null)))
    );
    let staleRows = backupRows.filter((row) => !sourceKeys.has(serializeKey(primaryKeys.map((column) => row[column] ?? null))));

    for (const foreignKey of referencingForeignKeys) {
      if (staleRows.length === 0) break;

      const childKeys = staleRows.map((row) => foreignKey.referencedColumns.map((column) => row[column] ?? null));
      const childRows = await fetchRowsByKeys(backup, foreignKey.childTable, foreignKey.childColumns, childKeys);
      const referencedKeys = new Set(
        childRows.map((row) => serializeKey(foreignKey.childColumns.map((column) => row[column] ?? null)))
      );

      const nextStaleRows: Record<string, unknown>[] = [];
      staleRows.forEach((row) => {
        const key = foreignKey.referencedColumns.map((column) => row[column] ?? null);
        if (!referencedKeys.has(serializeKey(key))) {
          nextStaleRows.push(row);
          return;
        }

        skippedRows.push({
          tableName: table,
          referencedTable: foreignKey.childTable,
          constraintName: foreignKey.constraintName,
          key: describeKey(foreignKey.referencedColumns, key),
          rows: 1,
          reason: `Stale backup row was not deleted because it is still referenced by "${foreignKey.childTable}".`,
        });
      });

      staleRows = nextStaleRows;
    }

    if (staleRows.length === 0) {
      continue;
    }

    keysToDelete.push(...staleRows.map((row) => primaryKeys.map((column) => row[column] ?? null)));
  }

  for (let offset = 0; offset < keysToDelete.length; offset += TRANSFER_CHUNK_SIZE) {
    const deleteStatement = buildDeleteByKeysStatement(table, primaryKeys, keysToDelete.slice(offset, offset + TRANSFER_CHUNK_SIZE));
    const deleted = await backup.unsafe<CountResult[]>(
      `${deleteStatement.query} RETURNING 1::bigint AS count`,
      deleteStatement.values as never[]
    );
    deletedRows += deleted.length;
  }

  return { deletedRows, skippedRows };
}

async function ensureBackupLogTable(sql: SqlLike) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "tblbackup_log" (
      "id" SERIAL NOT NULL,
      "tableName" VARCHAR(100) NOT NULL,
      "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "tblbackup_log_pkey" PRIMARY KEY ("id")
    )
  `);
}

async function createBackupLog(sql: SqlLike, table: string) {
  await sql.unsafe(`
    SELECT setval(
      pg_get_serial_sequence('"tblbackup_log"', 'id'),
      COALESCE((SELECT MAX("id") FROM "tblbackup_log"), 0) + 1,
      false
    )
  `);

  const rows = await sql.unsafe<BackupLogResult[]>(
    `INSERT INTO "tblbackup_log" ("tableName")
     VALUES ($1)
     RETURNING "id", "tableName", "createdAt"::text AS "createdAt"`,
    [table]
  );

  return rows[0] ?? null;
}

async function getLastBackupTimes(sql: SqlLike) {
  const logTable = await tableExists(sql, 'tblbackup_log');
  if (!logTable) return new Map<string, string>();

  const rows = await sql.unsafe<LastBackupResult[]>(`
    SELECT DISTINCT ON ("tableName")
      "tableName",
      "createdAt"::text AS "createdAt"
    FROM "tblbackup_log"
    ORDER BY "tableName", "createdAt" DESC, "id" DESC
  `);

  return new Map(rows.map((row) => [row.tableName, row.createdAt]));
}

async function getTablePayload() {
  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const [sourceTables, backupTables] = await Promise.all([
      listTables(source),
      listTables(backup),
    ]);
    const backupTableSet = new Set(backupTables.map((table) => table.table_name));
    const lastBackupTimes = await getLastBackupTimes(source);

    return {
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      tables: await Promise.all(sourceTables.map(async (table) => {
        const columns = await getColumns(source, table.table_name);
        return {
          tableName: table.table_name,
          existsInBackup: backupTableSet.has(table.table_name),
          accountFilterSupported: hasKnownAccountScope(table.table_name, columns),
          lastBackupAt: lastBackupTimes.get(table.table_name) ?? null,
        };
      })),
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function getDataPayload(request: NextRequest) {
  const table = request.nextUrl.searchParams.get('table')?.trim();
  const accountId = parseAccountId(request.nextUrl.searchParams.get('accountId'));
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_PREVIEW_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_PREVIEW_LIMIT)
    : MAX_PREVIEW_LIMIT;

  if (!table) {
    return NextResponse.json({ error: 'Missing table parameter' }, { status: 400 });
  }
  assertIdentifier(table, 'table name');

  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    if (!(await tableExists(source, table))) {
      return NextResponse.json({ error: 'Source table not found' }, { status: 404 });
    }

    const backupHasTable = await tableExists(backup, table);
    const [columns, primaryKeys, backupColumns] = await Promise.all([
      getColumns(source, table),
      getPrimaryKeys(source, table),
      backupHasTable ? getColumns(backup, table) : Promise.resolve([]),
    ]);
    const sourceAccountScope = getAccountScope(table, columns, accountId);
    const backupAccountScope = backupHasTable ? getAccountScope(table, backupColumns, accountId) : null;

    if (accountId !== null && !sourceAccountScope) {
      return NextResponse.json(
        { error: 'This table has no safe account filter.' },
        { status: 400 }
      );
    }

    if (accountId !== null && backupHasTable && !backupAccountScope) {
      return NextResponse.json(
        { error: 'The backup table has no safe account filter.' },
        { status: 400 }
      );
    }

    const [sourceRows, sourceEstimate, backupEstimate, backupRows] = await Promise.all([
      fetchRows(source, table, limit + 1, 0, sourceAccountScope),
      estimateRows(source, table),
      backupHasTable
        ? estimateRows(backup, table)
        : Promise.resolve(null),
      backupHasTable ? fetchRows(backup, table, limit + 1, 0, backupAccountScope) : Promise.resolve([]),
    ]);
    const data = sourceRows.slice(0, limit);
    const backupData = backupRows.slice(0, limit);
    const sourceRowCount = sourceRows.length <= limit ? BigInt(sourceRows.length) : sourceEstimate;
    const backupRowCount = backupHasTable
      ? backupRows.length <= limit ? BigInt(backupRows.length) : backupEstimate
      : null;

    return NextResponse.json(serializeBigInt({
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      tableName: table,
      accountId: accountId?.toString() ?? null,
      columns: columns.map((column) => ({ name: column.column_name, type: column.data_type })),
      backupColumns: backupColumns.map((column) => ({ name: column.column_name, type: column.data_type })),
      primaryKeys,
      data,
      backupData,
      sourceRowCount,
      backupRowCount,
      existsInBackup: backupHasTable,
      accountFilterSupported: hasKnownAccountScope(table, columns),
      previewLimit: limit,
    }));
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

function buildInsertStatement(
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  primaryKeys: string[],
  mode: TransferMode
) {
  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const values: unknown[] = [];
  const rowPlaceholders = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  let conflictClause = '';
  if (mode === 'upsert' && primaryKeys.length > 0) {
    const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
    const quotedPrimaryKeys = primaryKeys.map(quoteIdentifier).join(', ');
    conflictClause = updateColumns.length > 0
      ? ` ON CONFLICT (${quotedPrimaryKeys}) DO UPDATE SET ${updateColumns
          .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
          .join(', ')}`
      : ` ON CONFLICT (${quotedPrimaryKeys}) DO NOTHING`;
  }

  return {
    query: `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${rowPlaceholders.join(', ')}${conflictClause}`,
    values,
  };
}

async function syncForeignKeyParents(
  source: SqlLike,
  backup: SqlLike,
  table: string,
  rows: Record<string, unknown>[],
  activeTables = new Set<string>(),
  syncedParentKeys = new Set<string>()
): Promise<DependencySyncResult> {
  if (rows.length === 0 || activeTables.has(table)) {
    return { dependencies: [], skippedRows: [], validRows: rows };
  }

  activeTables.add(table);

  try {
    const dependencies: SyncedDependencyResult[] = [];
    const skippedRows: SkippedRelatedRowResult[] = [];
    let validRows = rows;
    const foreignKeys = await getForeignKeys(backup, table);

    for (const foreignKey of foreignKeys) {
      if (foreignKey.referencedTable === table) {
        continue;
      }

      const keyedRows = new Map<string, { key: unknown[]; rows: Record<string, unknown>[] }>();
      validRows.forEach((row) => {
        const key = foreignKey.columns.map((column) => row[column] ?? null);
        if (key.some((value) => value === null)) {
          return;
        }

        const dependencyKey = buildDependencyKey(foreignKey.referencedTable, foreignKey.referencedColumns, key);
        if (syncedParentKeys.has(dependencyKey)) {
          return;
        }

        const existing = keyedRows.get(dependencyKey);
        if (existing) {
          existing.rows.push(row);
          return;
        }

        keyedRows.set(dependencyKey, { key, rows: [row] });
      });

      const keys = Array.from(keyedRows.values()).map((entry) => entry.key);
      if (keys.length === 0) {
        continue;
      }

      const backupHasParentTable = await tableExists(backup, foreignKey.referencedTable);
      if (!backupHasParentTable) {
        throw new Error(`Backup parent table "${foreignKey.referencedTable}" was not found. Create it before transferring "${table}".`);
      }

      const backupParentRows = await fetchRowsByKeys(backup, foreignKey.referencedTable, foreignKey.referencedColumns, keys);
      const backupParentKeys = new Set(
        backupParentRows.map((parentRow) => serializeKey(foreignKey.referencedColumns.map((column) => parentRow[column] ?? null)))
      );
      const keysToSync = keys.filter((key) => !backupParentKeys.has(serializeKey(key)));

      if (keysToSync.length === 0) {
        keys.forEach((key) => syncedParentKeys.add(buildDependencyKey(foreignKey.referencedTable, foreignKey.referencedColumns, key)));
        continue;
      }

      const sourceHasParentTable = await tableExists(source, foreignKey.referencedTable);
      if (!sourceHasParentTable) {
        throw new Error(`Source parent table "${foreignKey.referencedTable}" was not found.`);
      }

      const [parentRows, parentSourceColumns, parentBackupColumns, parentPrimaryKeys] = await Promise.all([
        fetchRowsByKeys(source, foreignKey.referencedTable, foreignKey.referencedColumns, keysToSync),
        getColumns(source, foreignKey.referencedTable),
        getColumns(backup, foreignKey.referencedTable),
        getPrimaryKeys(source, foreignKey.referencedTable),
      ]);

      const foundKeys = new Set(
        parentRows.map((parentRow) => serializeKey(foreignKey.referencedColumns.map((column) => parentRow[column] ?? null)))
      );
      const missingKeys = keysToSync.filter((key) => !foundKeys.has(serializeKey(key)));

      if (missingKeys.length > 0) {
        const missingKeyValues = new Set(missingKeys.map(serializeKey));
        missingKeys.forEach((missingKey) => {
          const dependencyKey = buildDependencyKey(foreignKey.referencedTable, foreignKey.referencedColumns, missingKey);
          skippedRows.push({
            tableName: table,
            referencedTable: foreignKey.referencedTable,
            constraintName: foreignKey.constraintName,
            key: describeKey(foreignKey.referencedColumns, missingKey),
            rows: keyedRows.get(dependencyKey)?.rows.length ?? 0,
            reason: 'Referenced parent row was not found in source or backup.',
          });
        });

        validRows = validRows.filter((row) => {
          const rowKey = foreignKey.columns.map((column) => row[column] ?? null);
          return !missingKeyValues.has(serializeKey(rowKey));
        });
      }

      if (parentRows.length === 0) {
        continue;
      }

      if (parentPrimaryKeys.length === 0) {
        throw new Error(`Parent table "${foreignKey.referencedTable}" has no primary key, so it cannot be synced automatically.`);
      }

      const parentTransferColumnNames = getTransferColumnNames(parentSourceColumns, parentBackupColumns);
      const missingParentBackupColumns = getMissingBackupColumnNames(parentSourceColumns, parentBackupColumns);

      if (missingParentBackupColumns.length > 0) {
        throw new Error(
          `Backup parent table "${foreignKey.referencedTable}" is missing columns from the source table: ${missingParentBackupColumns.join(', ')}`
        );
      }

      const parentSync = await syncForeignKeyParents(source, backup, foreignKey.referencedTable, parentRows, activeTables, syncedParentKeys);
      dependencies.push(...parentSync.dependencies);
      skippedRows.push(...parentSync.skippedRows);

      const validParentRows = parentSync.validRows;
      const validParentKeys = new Set(
        validParentRows.map((parentRow) => serializeKey(foreignKey.referencedColumns.map((column) => parentRow[column] ?? null)))
      );
      const blockedKeys = keysToSync.filter((key) => foundKeys.has(serializeKey(key)) && !validParentKeys.has(serializeKey(key)));

      if (blockedKeys.length > 0) {
        const blockedKeyValues = new Set(blockedKeys.map(serializeKey));
        blockedKeys.forEach((blockedKey) => {
          const dependencyKey = buildDependencyKey(foreignKey.referencedTable, foreignKey.referencedColumns, blockedKey);
          skippedRows.push({
            tableName: table,
            referencedTable: foreignKey.referencedTable,
            constraintName: foreignKey.constraintName,
            key: describeKey(foreignKey.referencedColumns, blockedKey),
            rows: keyedRows.get(dependencyKey)?.rows.length ?? 0,
            reason: 'Referenced parent row could not be synced because one of its own dependencies is missing.',
          });
        });

        validRows = validRows.filter((row) => {
          const rowKey = foreignKey.columns.map((column) => row[column] ?? null);
          return !blockedKeyValues.has(serializeKey(rowKey));
        });
      }

      if (validParentRows.length === 0) {
        continue;
      }

      const insert = buildInsertStatement(
        foreignKey.referencedTable,
        parentTransferColumnNames,
        validParentRows,
        parentPrimaryKeys,
        'upsert'
      );
      await backup.unsafe(insert.query, insert.values as never[]);
      validParentRows.forEach((parentRow) => {
        const key = foreignKey.referencedColumns.map((column) => parentRow[column] ?? null);
        syncedParentKeys.add(buildDependencyKey(foreignKey.referencedTable, foreignKey.referencedColumns, key));
      });
      dependencies.push({ tableName: foreignKey.referencedTable, rows: validParentRows.length });
    }

    return { dependencies, skippedRows, validRows };
  } finally {
    activeTables.delete(table);
  }
}

async function transferTable(body: Record<string, unknown>) {
  const table = typeof body.table === 'string' ? body.table.trim() : '';
  const mode: TransferMode = body.mode === 'replace' ? 'replace' : 'upsert';
  const accountId = parseAccountId(body.accountId);

  if (!table) {
    return NextResponse.json({ error: 'Missing table' }, { status: 400 });
  }
  assertIdentifier(table, 'table name');

  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const [sourceHasTable, backupHasTable] = await Promise.all([
      tableExists(source, table),
      tableExists(backup, table),
    ]);

    if (!sourceHasTable) {
      return NextResponse.json({ error: 'Source table not found' }, { status: 404 });
    }

    if (!backupHasTable) {
      return NextResponse.json(
        { error: 'Backup table not found. Create the table in the backup database first.' },
        { status: 400 }
      );
    }

    const [sourceColumns, backupColumns, primaryKeys] = await Promise.all([
      getColumns(source, table),
      getColumns(backup, table),
      getPrimaryKeys(source, table),
    ]);
    const sourceAccountScope = getAccountScope(table, sourceColumns, accountId);
    const backupAccountScope = getAccountScope(table, backupColumns, accountId);

    if (accountId !== null && !sourceAccountScope) {
      return NextResponse.json(
        { error: 'This table has no safe account filter.' },
        { status: 400 }
      );
    }

    if (accountId !== null && !backupAccountScope) {
      return NextResponse.json(
        { error: 'The backup table has no safe account filter.' },
        { status: 400 }
      );
    }

    const sourceRowCount = await countRows(source, table, sourceAccountScope);
    const transferColumnNames = getTransferColumnNames(sourceColumns, backupColumns);
    const missingBackupColumns = getMissingBackupColumnNames(sourceColumns, backupColumns);

    if (missingBackupColumns.length > 0) {
      return NextResponse.json(
        {
          error: 'Backup table is missing columns from the source table',
          missingColumns: missingBackupColumns,
        },
        { status: 400 }
      );
    }

    if (mode === 'upsert' && primaryKeys.length === 0) {
      return NextResponse.json(
        { error: 'This table has no primary key. Use replace mode to transfer it.' },
        { status: 400 }
      );
    }

    let transferred = 0;
    let backupLog: BackupLogResult | null = null;
    let deletedStaleRows = 0;
    const syncedDependencies = new Map<string, number>();
    const skippedRows: SkippedRelatedRowResult[] = [];
    const syncedParentKeys = new Set<string>();
    const insertMode: TransferMode = mode === 'replace' && primaryKeys.length > 0 ? 'upsert' : mode;

    await backup.begin(async (transaction) => {
      if (mode === 'replace' && primaryKeys.length === 0) {
        await transaction.unsafe(
          `DELETE FROM ${quoteIdentifier(table)} t ${backupAccountScope?.whereClause ?? ''}`,
          (backupAccountScope?.values ?? []) as never[]
        );
      }

      for (let offset = 0; offset < Number(sourceRowCount); offset += TRANSFER_CHUNK_SIZE) {
        const rows = await fetchRows(source, table, TRANSFER_CHUNK_SIZE, offset, sourceAccountScope);
        if (rows.length === 0) break;

        const dependencySync = await syncForeignKeyParents(source, transaction, table, rows, new Set<string>(), syncedParentKeys);
        dependencySync.dependencies.forEach((dependency) => {
          syncedDependencies.set(
            dependency.tableName,
            (syncedDependencies.get(dependency.tableName) ?? 0) + dependency.rows
          );
        });
        skippedRows.push(...dependencySync.skippedRows);

        if (dependencySync.validRows.length === 0) {
          continue;
        }

        const insert = buildInsertStatement(table, transferColumnNames, dependencySync.validRows, primaryKeys, insertMode);
        await transaction.unsafe(insert.query, insert.values as never[]);
        transferred += dependencySync.validRows.length;
      }

      if (mode === 'replace' && primaryKeys.length > 0) {
        const staleCleanup = await removeReplaceStaleRows(source, transaction, table, primaryKeys, backupAccountScope);
        deletedStaleRows = staleCleanup.deletedRows;
        skippedRows.push(...staleCleanup.skippedRows);
      }
    });

    await ensureBackupLogTable(source);
    backupLog = await createBackupLog(source, table);

    const backupRowCount = await countRows(backup, table, backupAccountScope);

    return NextResponse.json(serializeBigInt({
      tableName: table,
      mode,
      accountId: accountId?.toString() ?? null,
      transferred,
      sourceRowCount,
      backupRowCount,
      primaryKeys,
      deletedStaleRows,
      syncedDependencies: Array.from(syncedDependencies.entries()).map(([tableName, rows]) => ({ tableName, rows })),
      skippedRows,
      backupLog,
    }));
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

function parseClearRole(value: unknown): DbRole {
  if (value === 'source' || value === 'backup') return value;
  throw new Error('Invalid database role');
}

async function clearTableData(body: Record<string, unknown>) {
  const table = typeof body.table === 'string' ? body.table.trim() : '';
  const role = parseClearRole(body.role);

  if (!table) {
    return NextResponse.json({ error: 'Missing table name' }, { status: 400 });
  }
  assertIdentifier(table, 'table name');

  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  assertDistinctDatabaseConfigs(sourceConfig, backupConfig);

  const sql = createDb(role === 'source' ? sourceConfig : backupConfig);

  try {
    if (!(await tableExists(sql, table))) {
      return NextResponse.json({ error: `Table "${table}" was not found.` }, { status: 404 });
    }

    const deletedRows = await clearRows(sql, table);
    return NextResponse.json(serializeBigInt({
      tableName: table,
      role,
      deletedRows,
    }));
  } finally {
    await sql.end();
  }
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    const action = request.nextUrl.searchParams.get('action') ?? 'tables';

    if (action === 'config') {
      return NextResponse.json(getConnectionPayload());
    }

    if (action === 'data') {
      return await getDataPayload(request);
    }

    return NextResponse.json(serializeBigInt(await getTablePayload()));
  } catch (error) {
    console.error('Error in DB backup GET:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load DB backup data' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    const body = await request.json();
    return await transferTable(body);
  } catch (error) {
    console.error('Error in DB backup POST:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to transfer table data' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    const body = await request.json();
    return await clearTableData(body);
  } catch (error) {
    console.error('Error in DB backup DELETE:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear table data' },
      { status: 500 }
    );
  }
}
