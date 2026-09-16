import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { NextRequest, NextResponse } from 'next/server';
import { serializeBigInt } from '@/lib/serializeBigInt';
import { requireSystemAdmin as requireAdmin } from '@/app/lib/system-admin';

export const runtime = 'nodejs';

type SqlLike = postgres.Sql | postgres.TransactionSql;

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_PREVIEW_LIMIT = 100;
const MAX_PREVIEW_LIMIT = 1000;
const RESTORE_CHUNK_SIZE = 200;
const EXACT_COMPARISON_COUNT_LIMIT = BigInt(50000);

type DbRole = 'source' | 'backup';
type RestoreAreaId = 'work' | 'checklist' | 'car' | 'customer' | 'rental' | 'user';

interface EnvDatabase {
  url: string;
  label: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_generated: 'ALWAYS' | 'NEVER';
}

interface CountResult {
  count: bigint;
}

interface EstimatedCountResult {
  estimate: bigint;
}

interface TableNameResult {
  table_name: string;
}

interface AccountScope {
  whereClause: string;
  values: unknown[];
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

interface RelatedChildRestoreDefinition {
  tableName: string;
  parentColumns: string[];
  childTable: string;
  childColumns: string[];
}

interface AreaDefinition {
  id: RestoreAreaId;
  name: string;
  description: string;
  tables: string[];
}

interface RestoredTableResult {
  tableName: string;
  restored: number;
  backupRowCount: bigint;
  sourceRowCount: bigint;
  syncedDependencies: SyncedDependencyResult[];
  syncedRelatedRows: SyncedDependencyResult[];
  skippedRows: SkippedRelatedRowResult[];
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

const RESTORE_AREAS: AreaDefinition[] = [
  {
    id: 'work',
    name: 'Work',
    description: 'Pickup/work orders, order items, account-specific workorder setup, and linked customers/employees.',
    tables: [
      'tblaccount',
      'tblcustomers',
      'tblemployee',
      'tblreceipt_template',
      'tblreceipt_template_field',
      'tblchecklisttemplate',
      'tblchecklisttemplateitem',
      'tblworkorder_goods_type',
      'tblworkorder_goods_size',
      'tblworkorder_order_type',
      'tblpickup_order',
      'tblpickup_order_item',
      'tbluser_checklist_session',
      'tbluser_checklist_item',
      'tblpickup_order_session',
      'tblscanned_receipt',
    ],
  },
  {
    id: 'checklist',
    name: 'Checklist',
    description: 'Checklist templates, items, sessions, item answers, receipt templates, and customer/car/order links.',
    tables: [
      'tblaccount',
      'tblemployee',
      'tblcustomers',
      'tblcar',
      'tblreceipt_template',
      'tblreceipt_template_field',
      'tblchecklisttemplate',
      'tblchecklisttemplateitem',
      'tbluser_checklist_session',
      'tbluser_checklist_item',
      'tblcar_checklist_session',
      'tblcust_checklist_session',
      'tblchecklist_order',
      'tblchecklist_order_item',
      'tblscanned_receipt',
    ],
  },
  {
    id: 'car',
    name: 'Car',
    description: 'Fleet cars and checklist session links needed for car-based inspections.',
    tables: [
      'tblaccount',
      'tblemployee',
      'tblcar',
      'tblchecklisttemplate',
      'tblchecklisttemplateitem',
      'tbluser_checklist_session',
      'tbluser_checklist_item',
      'tblcar_checklist_session',
    ],
  },
  {
    id: 'customer',
    name: 'Customer',
    description: 'Customers, keys, customer/checklist links, checklist orders, and pickup orders tied to customers.',
    tables: [
      'tblaccount',
      'tblcustomers',
      'tblkey',
      'tblcustomerkey',
      'tblemployee',
      'tblchecklisttemplate',
      'tblchecklisttemplateitem',
      'tbluser_checklist_session',
      'tbluser_checklist_item',
      'tblcust_checklist_session',
      'tblchecklist_order',
      'tblpickup_order',
      'tblpickup_order_item',
    ],
  },
  {
    id: 'rental',
    name: 'Rental Order',
    description: 'Rental orders, linked customers/cars/checklist sessions, rental events, contracts, and acceptance audit trails.',
    tables: [
      'tblaccount',
      'tblemployee',
      'tblcustomers',
      'tblcar',
      'tblchecklisttemplate',
      'tblchecklisttemplateitem',
      'tbluser_checklist_session',
      'tbluser_checklist_item',
      'tblcar_checklist_session',
      'tblcust_checklist_session',
      'tblrental_order',
      'tblrental_order_event',
      'tblrental_order_contract',
      'tblrental_order_contract_acceptance',
    ],
  },
  {
    id: 'user',
    name: 'User',
    description: 'Login users, accounts, account memberships, employees, invitations, and message links.',
    tables: [
      'tbluser',
      'tblaccount',
      'tblaccountuser',
      'tblemployee',
      'tblinvitation',
      'tblmessagetemplate',
      'tblmessagedelivery',
      'tbl_password_reset_token',
    ],
  },
];

const RELATED_CHILD_RESTORE_DEFINITIONS: RelatedChildRestoreDefinition[] = [
  {
    tableName: 'tblchecklisttemplate',
    parentColumns: ['clid'],
    childTable: 'tblchecklisttemplateitem',
    childColumns: ['clid'],
  },
  {
    tableName: 'tblchecklisttemplate',
    parentColumns: ['clid'],
    childTable: 'tbluser_checklist_session',
    childColumns: ['clid'],
  },
  {
    tableName: 'tbluser_checklist_session',
    parentColumns: ['sessionid'],
    childTable: 'tbluser_checklist_item',
    childColumns: ['sessionid'],
  },
  {
    tableName: 'tbluser_checklist_session',
    parentColumns: ['sessionid'],
    childTable: 'tblcar_checklist_session',
    childColumns: ['session_id'],
  },
  {
    tableName: 'tbluser_checklist_session',
    parentColumns: ['sessionid'],
    childTable: 'tblcust_checklist_session',
    childColumns: ['session_id'],
  },
  {
    tableName: 'tbluser_checklist_session',
    parentColumns: ['sessionid'],
    childTable: 'tblpickup_order_session',
    childColumns: ['session_id'],
  },
  {
    tableName: 'tbluser_checklist_session',
    parentColumns: ['sessionid'],
    childTable: 'tblchecklist_order',
    childColumns: ['session_id'],
  },
  {
    tableName: 'tblchecklist_order',
    parentColumns: ['id'],
    childTable: 'tblchecklist_order_item',
    childColumns: ['order_id'],
  },
  {
    tableName: 'tblcar',
    parentColumns: ['id'],
    childTable: 'tblcar_checklist_session',
    childColumns: ['car_id'],
  },
  {
    tableName: 'tblcar_checklist_session',
    parentColumns: ['session_id'],
    childTable: 'tbluser_checklist_item',
    childColumns: ['sessionid'],
  },
  {
    tableName: 'tblcustomers',
    parentColumns: ['customerid'],
    childTable: 'tblcust_checklist_session',
    childColumns: ['customer_id'],
  },
  {
    tableName: 'tblcust_checklist_session',
    parentColumns: ['session_id'],
    childTable: 'tbluser_checklist_item',
    childColumns: ['sessionid'],
  },
  {
    tableName: 'tblpickup_order',
    parentColumns: ['id'],
    childTable: 'tblpickup_order_session',
    childColumns: ['pickup_order_id'],
  },
  {
    tableName: 'tblpickup_order_session',
    parentColumns: ['session_id'],
    childTable: 'tbluser_checklist_item',
    childColumns: ['sessionid'],
  },
  {
    tableName: 'tblrental_order',
    parentColumns: ['id'],
    childTable: 'tblrental_order_event',
    childColumns: ['rental_order_id'],
  },
  {
    tableName: 'tblrental_order',
    parentColumns: ['id'],
    childTable: 'tblrental_order_contract',
    childColumns: ['rental_order_id'],
  },
  {
    tableName: 'tblrental_order',
    parentColumns: ['checklist_session_id'],
    childTable: 'tbluser_checklist_item',
    childColumns: ['sessionid'],
  },
  {
    tableName: 'tblrental_order',
    parentColumns: ['checklist_session_id'],
    childTable: 'tblcar_checklist_session',
    childColumns: ['session_id'],
  },
  {
    tableName: 'tblrental_order',
    parentColumns: ['checklist_session_id'],
    childTable: 'tblcust_checklist_session',
    childColumns: ['session_id'],
  },
  {
    tableName: 'tblrental_order_contract',
    parentColumns: ['id'],
    childTable: 'tblrental_order_contract_acceptance',
    childColumns: ['contract_id'],
  },
];

function expandEnvValue(value: string, values: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, key) => {
    return values[key] ?? process.env[key] ?? match;
  });
}

function readDatabaseConfig(role: DbRole): EnvDatabase {
  const envFile = role === 'source' ? '.env' : '.env.backup';
  const envPath = path.join(process.cwd(), envFile);
  const parsed = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const rawUrl = role === 'source'
    ? parsed.DATABASE_URL ?? process.env.DATABASE_URL
    : process.env.BACKUP_DATABASE_URL
      ?? process.env.DATABASE_URL_BACKUP
      ?? parsed.BACKUP_DATABASE_URL
      ?? parsed.DATABASE_URL;

  if (!rawUrl) {
    throw new Error(role === 'source'
      ? 'DATABASE_URL was not found in .env'
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
    throw new Error('Operational and backup database URLs point to the same database. Check .env and .env.backup before running Restore Verification.');
  }
}

function createDb(config: EnvDatabase) {
  return postgres(config.url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
}

function assertIdentifier(identifier: string, label: string) {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Invalid ${label}: ${identifier}`);
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

async function listTables(sql: SqlLike) {
  return sql<TableNameResult[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;
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

async function countRows(sql: SqlLike, table: string, accountScope?: AccountScope | null) {
  const rows = await sql.unsafe<CountResult[]>(
    `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)} t ${accountScope?.whereClause ?? ''}`,
    (accountScope?.values ?? []) as never[]
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

async function getComparisonRowCount(sql: SqlLike, table: string) {
  const estimatedRowCount = await estimateRows(sql, table);

  if (estimatedRowCount !== null && estimatedRowCount > EXACT_COMPARISON_COUNT_LIMIT) {
    return {
      rowCount: estimatedRowCount,
      isEstimate: true,
    };
  }

  return {
    rowCount: await countRows(sql, table),
    isEstimate: false,
  };
}

async function fetchRows(
  sql: SqlLike,
  table: string,
  limit: number,
  offset: number,
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

function getTransferColumnNames(backupColumns: ColumnInfo[], sourceColumns: ColumnInfo[]) {
  const sourceColumnByName = new Map(sourceColumns.map((column) => [column.column_name, column]));

  return backupColumns
    .filter((column) => column.is_generated !== 'ALWAYS')
    .filter((column) => sourceColumnByName.get(column.column_name)?.is_generated !== 'ALWAYS')
    .map((column) => column.column_name);
}

function getMissingSourceColumnNames(backupColumns: ColumnInfo[], sourceColumns: ColumnInfo[]) {
  const sourceColumnNames = new Set(sourceColumns.map((column) => column.column_name));

  return backupColumns
    .filter((column) => column.is_generated !== 'ALWAYS')
    .map((column) => column.column_name)
    .filter((column) => !sourceColumnNames.has(column));
}

function buildInsertStatement(
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  primaryKeys: string[]
) {
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const values: unknown[] = [];
  const rowPlaceholders = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const conflictClause = updateColumns.length > 0
    ? ` ON CONFLICT (${primaryKeys.map(quoteIdentifier).join(', ')}) DO UPDATE SET ${updateColumns
        .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
        .join(', ')}`
    : ` ON CONFLICT (${primaryKeys.map(quoteIdentifier).join(', ')}) DO NOTHING`;

  return {
    query: `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES ${rowPlaceholders.join(', ')}${conflictClause}`,
    values,
  };
}

async function syncForeignKeyParents(
  backup: SqlLike,
  source: SqlLike,
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
    const foreignKeys = await getForeignKeys(source, table);

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

      const [sourceHasParentTable, backupHasParentTable] = await Promise.all([
        tableExists(source, foreignKey.referencedTable),
        tableExists(backup, foreignKey.referencedTable),
      ]);

      if (!sourceHasParentTable) {
        throw new Error(`Operational parent table "${foreignKey.referencedTable}" was not found.`);
      }

      if (!backupHasParentTable) {
        throw new Error(`Backup parent table "${foreignKey.referencedTable}" was not found.`);
      }

      const sourceParentRows = await fetchRowsByKeys(source, foreignKey.referencedTable, foreignKey.referencedColumns, keys);
      const sourceParentKeys = new Set(
        sourceParentRows.map((parentRow) => serializeKey(foreignKey.referencedColumns.map((column) => parentRow[column] ?? null)))
      );
      const keysToSync = keys.filter((key) => !sourceParentKeys.has(serializeKey(key)));

      if (keysToSync.length === 0) {
        keys.forEach((key) => syncedParentKeys.add(buildDependencyKey(foreignKey.referencedTable, foreignKey.referencedColumns, key)));
        continue;
      }

      const [parentRows, parentBackupColumns, parentSourceColumns, parentPrimaryKeys] = await Promise.all([
        fetchRowsByKeys(backup, foreignKey.referencedTable, foreignKey.referencedColumns, keysToSync),
        getColumns(backup, foreignKey.referencedTable),
        getColumns(source, foreignKey.referencedTable),
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
            reason: 'Referenced parent row was not found in backup.',
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
        throw new Error(`Parent table "${foreignKey.referencedTable}" has no primary key, so it cannot be restored automatically.`);
      }

      const missingSourceColumns = getMissingSourceColumnNames(parentBackupColumns, parentSourceColumns);
      if (missingSourceColumns.length > 0) {
        throw new Error(`Operational parent table "${foreignKey.referencedTable}" is missing columns: ${missingSourceColumns.join(', ')}`);
      }

      const parentSync = await syncForeignKeyParents(backup, source, foreignKey.referencedTable, parentRows, activeTables, syncedParentKeys);
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
            reason: 'Referenced parent row could not be restored because one of its own dependencies is missing.',
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

      const parentTransferColumnNames = getTransferColumnNames(parentBackupColumns, parentSourceColumns);
      const insert = buildInsertStatement(
        foreignKey.referencedTable,
        parentTransferColumnNames,
        validParentRows,
        parentPrimaryKeys
      );
      await source.unsafe(insert.query, insert.values as never[]);
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

function collectRelatedChildKeys(
  relatedChild: RelatedChildRestoreDefinition,
  parentRows: Record<string, unknown>[],
  syncedRelatedKeys: Set<string>
) {
  const keys = new Map<string, unknown[]>();

  parentRows.forEach((row) => {
    const key = relatedChild.parentColumns.map((column) => row[column] ?? null);
    if (key.some((value) => value === null)) {
      return;
    }

    const dependencyKey = buildDependencyKey(relatedChild.childTable, relatedChild.childColumns, key);
    if (syncedRelatedKeys.has(dependencyKey)) {
      return;
    }

    keys.set(dependencyKey, key);
  });

  return Array.from(keys.entries()).map(([dependencyKey, key]) => ({ dependencyKey, key }));
}

async function restoreRelatedChildRows(
  backup: SqlLike,
  source: SqlLike,
  table: string,
  parentRows: Record<string, unknown>[],
  syncedRelatedKeys: Set<string>
) {
  const restoredRelatedRows = new Map<string, number>();
  const skippedRows: SkippedRelatedRowResult[] = [];
  const relatedChildren = RELATED_CHILD_RESTORE_DEFINITIONS.filter((relatedChild) => relatedChild.tableName === table);

  for (const relatedChild of relatedChildren) {
    const relatedKeys = collectRelatedChildKeys(relatedChild, parentRows, syncedRelatedKeys);
    if (relatedKeys.length === 0) {
      continue;
    }

    const [sourceHasChildTable, backupHasChildTable] = await Promise.all([
      tableExists(source, relatedChild.childTable),
      tableExists(backup, relatedChild.childTable),
    ]);

    if (!sourceHasChildTable) {
      throw new Error(`Operational related table "${relatedChild.childTable}" was not found.`);
    }

    if (!backupHasChildTable) {
      throw new Error(`Backup related table "${relatedChild.childTable}" was not found.`);
    }

    const [childRows, childBackupColumns, childSourceColumns, childPrimaryKeys] = await Promise.all([
      fetchRowsByKeys(backup, relatedChild.childTable, relatedChild.childColumns, relatedKeys.map((entry) => entry.key)),
      getColumns(backup, relatedChild.childTable),
      getColumns(source, relatedChild.childTable),
      getPrimaryKeys(source, relatedChild.childTable),
    ]);

    relatedKeys.forEach((entry) => syncedRelatedKeys.add(entry.dependencyKey));

    if (childRows.length === 0) {
      continue;
    }

    const missingSourceColumns = getMissingSourceColumnNames(childBackupColumns, childSourceColumns);
    if (missingSourceColumns.length > 0) {
      throw new Error(`Operational related table "${relatedChild.childTable}" is missing columns: ${missingSourceColumns.join(', ')}`);
    }

    if (childPrimaryKeys.length === 0) {
      throw new Error(`Operational related table "${relatedChild.childTable}" has no primary key, so it cannot be restored automatically.`);
    }

    const dependencySync = await syncForeignKeyParents(backup, source, relatedChild.childTable, childRows);
    skippedRows.push(...dependencySync.skippedRows);

    if (dependencySync.validRows.length === 0) {
      continue;
    }

    const childTransferColumnNames = getTransferColumnNames(childBackupColumns, childSourceColumns);
    for (let offset = 0; offset < dependencySync.validRows.length; offset += RESTORE_CHUNK_SIZE) {
      const childRowsChunk = dependencySync.validRows.slice(offset, offset + RESTORE_CHUNK_SIZE);
      const insert = buildInsertStatement(
        relatedChild.childTable,
        childTransferColumnNames,
        childRowsChunk,
        childPrimaryKeys
      );
      await source.unsafe(insert.query, insert.values as never[]);
    }

    restoredRelatedRows.set(
      relatedChild.childTable,
      (restoredRelatedRows.get(relatedChild.childTable) ?? 0) + dependencySync.validRows.length
    );

    const nestedRelatedChildSync = await restoreRelatedChildRows(
      backup,
      source,
      relatedChild.childTable,
      dependencySync.validRows,
      syncedRelatedKeys
    );
    nestedRelatedChildSync.restoredRelatedRows.forEach((nestedRelatedRow) => {
      restoredRelatedRows.set(
        nestedRelatedRow.tableName,
        (restoredRelatedRows.get(nestedRelatedRow.tableName) ?? 0) + nestedRelatedRow.rows
      );
    });
    skippedRows.push(...nestedRelatedChildSync.skippedRows);
  }

  return {
    restoredRelatedRows: Array.from(restoredRelatedRows.entries()).map(([tableName, rows]) => ({ tableName, rows })),
    skippedRows,
  };
}

async function compareTable(source: SqlLike, backup: SqlLike, table: string) {
  assertIdentifier(table, 'table name');

  const [sourceExists, backupExists] = await Promise.all([
    tableExists(source, table),
    tableExists(backup, table),
  ]);

  if (!sourceExists || !backupExists) {
    return {
      tableName: table,
      sourceExists,
      backupExists,
      sourceRowCount: null,
      backupRowCount: null,
      sourceChecksum: null,
      backupChecksum: null,
      status: !backupExists ? 'missing-backup' : 'missing-source',
    };
  }

  const [sourceCount, backupCount] = await Promise.all([
    getComparisonRowCount(source, table),
    getComparisonRowCount(backup, table),
  ]);
  const countMatches = sourceCount.rowCount === backupCount.rowCount;
  const countsAreEstimated = sourceCount.isEstimate || backupCount.isEstimate;

  return {
    tableName: table,
    sourceExists,
    backupExists,
    sourceRowCount: sourceCount.rowCount,
    backupRowCount: backupCount.rowCount,
    sourceRowCountIsEstimate: sourceCount.isEstimate,
    backupRowCountIsEstimate: backupCount.isEstimate,
    sourceChecksum: null,
    backupChecksum: null,
    status: countMatches
      ? countsAreEstimated ? 'estimate-matches' : 'count-matches'
      : countsAreEstimated ? 'estimate-differs' : 'count-differs',
  };
}

async function buildRestorePayload() {
  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  assertDistinctDatabaseConfigs(sourceConfig, backupConfig);

  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const comparedTables = new Set<string>();
    const allTables = RESTORE_AREAS.flatMap((area) => area.tables);
    const tableComparisons = await Promise.all(
      allTables
        .filter((table) => {
          if (comparedTables.has(table)) return false;
          comparedTables.add(table);
          return true;
        })
        .map((table) => compareTable(source, backup, table))
    );
    const comparisonByTable = new Map(tableComparisons.map((comparison) => [comparison.tableName, comparison]));

    return {
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      areas: RESTORE_AREAS.map((area) => {
        const tables = area.tables.map((tableName) => comparisonByTable.get(tableName)!);
        return {
          ...area,
          tables,
          issueCount: tables.filter((table) => !['count-matches', 'estimate-matches'].includes(table.status)).length,
        };
      }),
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function buildTableRestorePayload() {
  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  assertDistinctDatabaseConfigs(sourceConfig, backupConfig);

  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const [sourceTables, backupTables] = await Promise.all([
      listTables(source),
      listTables(backup),
    ]);
    const sourceTableSet = new Set(sourceTables.map((table) => table.table_name));

    const tables = await Promise.all(backupTables.map(async (table) => {
      const columns = await getColumns(backup, table.table_name);

      return {
        tableName: table.table_name,
        existsInSource: sourceTableSet.has(table.table_name),
        accountFilterSupported: hasKnownAccountScope(table.table_name, columns),
      };
    }));

    return {
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      tables,
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function getTableRestoreDataPayload(request: NextRequest) {
  const table = request.nextUrl.searchParams.get('table')?.trim();
  const accountId = parseAccountId(request.nextUrl.searchParams.get('accountId'));
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_PREVIEW_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_PREVIEW_LIMIT)
    : DEFAULT_PREVIEW_LIMIT;

  if (!table) {
    return NextResponse.json({ error: 'Missing table parameter' }, { status: 400 });
  }
  assertIdentifier(table, 'table name');

  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  assertDistinctDatabaseConfigs(sourceConfig, backupConfig);

  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const [sourceHasTable, backupHasTable] = await Promise.all([
      tableExists(source, table),
      tableExists(backup, table),
    ]);

    if (!backupHasTable) {
      return NextResponse.json({ error: 'Backup table not found' }, { status: 404 });
    }

    const [backupColumns, sourceColumns] = await Promise.all([
      getColumns(backup, table),
      sourceHasTable ? getColumns(source, table) : Promise.resolve([]),
    ]);
    const backupAccountScope = getAccountScope(table, backupColumns, accountId);
    const sourceAccountScope = getAccountScope(table, sourceColumns, accountId);

    if (accountId !== null && !backupAccountScope) {
      return NextResponse.json(
        { error: `Table "${table}" cannot be filtered by account safely.` },
        { status: 400 }
      );
    }

    const [primaryKeys, backupData, backupRowCount, sourceData, sourceRowCount] = await Promise.all([
      sourceHasTable ? getPrimaryKeys(source, table) : Promise.resolve([]),
      fetchRows(backup, table, limit, 0, backupAccountScope),
      countRows(backup, table, backupAccountScope),
      sourceHasTable ? fetchRows(source, table, limit, 0, sourceAccountScope) : Promise.resolve([]),
      sourceHasTable ? countRows(source, table, sourceAccountScope) : Promise.resolve(null),
    ]);

    return NextResponse.json(serializeBigInt({
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      tableName: table,
      accountId: accountId?.toString() ?? null,
      columns: sourceColumns.map((column) => ({ name: column.column_name, type: column.data_type })),
      backupColumns: backupColumns.map((column) => ({ name: column.column_name, type: column.data_type })),
      primaryKeys,
      data: sourceData,
      backupData,
      sourceRowCount,
      backupRowCount,
      existsInSource: sourceHasTable,
      accountFilterSupported: hasKnownAccountScope(table, backupColumns),
      previewLimit: limit,
    }));
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function restoreTable(
  backup: SqlLike,
  source: SqlLike,
  table: string,
  accountId: bigint | null = null,
  restoreRelatedChildren = true
) {
  assertIdentifier(table, 'table name');

  const [sourceExists, backupExists] = await Promise.all([
    tableExists(source, table),
    tableExists(backup, table),
  ]);

  if (!backupExists) {
    throw new Error(`Backup table "${table}" was not found.`);
  }

  if (!sourceExists) {
    throw new Error(`Operational table "${table}" was not found. Run DB Check table repair before restoring data.`);
  }

  const [backupColumns, sourceColumns, primaryKeys] = await Promise.all([
    getColumns(backup, table),
    getColumns(source, table),
    getPrimaryKeys(source, table),
  ]);
  const backupAccountScope = getAccountScope(table, backupColumns, accountId);
  const sourceAccountScope = getAccountScope(table, sourceColumns, accountId);

  if (accountId !== null && !backupAccountScope) {
    throw new Error(`Table "${table}" cannot be filtered by account safely.`);
  }

  if (accountId !== null && !sourceAccountScope) {
    throw new Error(`Operational table "${table}" cannot be filtered by account safely.`);
  }

  const backupRowCount = await countRows(backup, table, backupAccountScope);
  const missingSourceColumns = getMissingSourceColumnNames(backupColumns, sourceColumns);

  if (missingSourceColumns.length > 0) {
    throw new Error(`Operational table "${table}" is missing columns: ${missingSourceColumns.join(', ')}`);
  }

  if (primaryKeys.length === 0) {
    throw new Error(`Operational table "${table}" has no primary key, so it cannot be restored by upsert.`);
  }

  const transferColumnNames = getTransferColumnNames(backupColumns, sourceColumns);
  let restored = 0;
  const syncedDependencies = new Map<string, number>();
  const syncedRelatedRows = new Map<string, number>();
  const skippedRows: SkippedRelatedRowResult[] = [];
  const syncedParentKeys = new Set<string>();
  const syncedRelatedKeys = new Set<string>();

  for (let offset = 0; offset < Number(backupRowCount); offset += RESTORE_CHUNK_SIZE) {
    const rows = await fetchRows(backup, table, RESTORE_CHUNK_SIZE, offset, backupAccountScope);
    if (rows.length === 0) break;

    const dependencySync = await syncForeignKeyParents(backup, source, table, rows, new Set<string>(), syncedParentKeys);
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

    const insert = buildInsertStatement(table, transferColumnNames, dependencySync.validRows, primaryKeys);
    await source.unsafe(insert.query, insert.values as never[]);
    restored += dependencySync.validRows.length;

    if (restoreRelatedChildren) {
      const relatedChildSync = await restoreRelatedChildRows(
        backup,
        source,
        table,
        dependencySync.validRows,
        syncedRelatedKeys
      );
      relatedChildSync.restoredRelatedRows.forEach((relatedRow) => {
        syncedRelatedRows.set(
          relatedRow.tableName,
          (syncedRelatedRows.get(relatedRow.tableName) ?? 0) + relatedRow.rows
        );
      });
      skippedRows.push(...relatedChildSync.skippedRows);
    }
  }

  return {
    tableName: table,
    restored,
    backupRowCount,
    sourceRowCount: await countRows(source, table, sourceAccountScope),
    syncedDependencies: Array.from(syncedDependencies.entries()).map(([tableName, rows]) => ({ tableName, rows })),
    syncedRelatedRows: Array.from(syncedRelatedRows.entries()).map(([tableName, rows]) => ({ tableName, rows })),
    skippedRows,
  };
}

function findArea(areaId: string) {
  const area = RESTORE_AREAS.find((item) => item.id === areaId);
  if (!area) {
    throw new Error(`Unknown restore area: ${areaId}`);
  }

  return area;
}

async function runRestore(body: Record<string, unknown>) {
  const areaId = typeof body.area === 'string' ? body.area : '';
  const tableName = typeof body.table === 'string' ? body.table : '';
  const area = findArea(areaId);
  const tables = tableName ? [tableName] : area.tables;

  tables.forEach((table) => {
    if (!area.tables.includes(table)) {
      throw new Error(`${table} does not belong to the ${area.name} restore area.`);
    }
  });

  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  assertDistinctDatabaseConfigs(sourceConfig, backupConfig);

  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const restoredTables: RestoredTableResult[] = [];

    await source.begin(async (transaction) => {
      for (const table of tables) {
        restoredTables.push(await restoreTable(backup, transaction, table, null, Boolean(tableName)));
      }
    });

    return {
      area: area.id,
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      restoredTables,
      restoredRows: restoredTables.reduce((total, table) => total + table.restored, 0),
      restoredRelatedRows: restoredTables.reduce((total, table) => {
        return total + table.syncedRelatedRows.reduce((relatedTotal, relatedRow) => relatedTotal + relatedRow.rows, 0);
      }, 0),
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function runTableRestore(body: Record<string, unknown>) {
  const table = typeof body.table === 'string' ? body.table.trim() : '';
  const accountId = parseAccountId(body.accountId);

  if (!table) {
    throw new Error('Missing table');
  }
  assertIdentifier(table, 'table name');

  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  assertDistinctDatabaseConfigs(sourceConfig, backupConfig);

  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const restoredTables: RestoredTableResult[] = [];

    await source.begin(async (transaction) => {
      restoredTables.push(await restoreTable(backup, transaction, table, accountId));
    });
    const restoredTable = restoredTables[0];

    return {
      tableName: table,
      accountId: accountId?.toString() ?? null,
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      restoredTables,
      restoredRows: restoredTable?.restored ?? 0,
      restoredRelatedRows: restoredTable?.syncedRelatedRows.reduce((total, relatedRow) => total + relatedRow.rows, 0) ?? 0,
      backupRowCount: restoredTable?.backupRowCount ?? BigInt(0),
      sourceRowCount: restoredTable?.sourceRowCount ?? BigInt(0),
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function buildAreaPayload(area: AreaDefinition) {
  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  assertDistinctDatabaseConfigs(sourceConfig, backupConfig);

  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const uniqueTables = [...new Set(area.tables)];
    const tableComparisons = await Promise.all(
      uniqueTables.map((table) => compareTable(source, backup, table))
    );
    const comparisonByTable = new Map(tableComparisons.map((c) => [c.tableName, c]));
    const tables = area.tables.map((tableName) => comparisonByTable.get(tableName)!);

    return {
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      area: {
        ...area,
        tables,
        issueCount: tables.filter((t) => !['count-matches', 'estimate-matches'].includes(t.status)).length,
      },
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  const { searchParams } = new URL(request.url);
  const areaParam = searchParams.get('area');

  try {
    const action = searchParams.get('action');

    if (action === 'tables') {
      return NextResponse.json(serializeBigInt(await buildTableRestorePayload()));
    }

    if (action === 'data') {
      return await getTableRestoreDataPayload(request);
    }

    if (areaParam) {
      const area = RESTORE_AREAS.find((item) => item.id === areaParam);
      if (!area) {
        return NextResponse.json({ error: `Unknown restore area: ${areaParam}` }, { status: 400 });
      }
      return NextResponse.json(serializeBigInt(await buildAreaPayload(area)));
    }
    return NextResponse.json(serializeBigInt(await buildRestorePayload()));
  } catch (error) {
    console.error('Error in DB restore GET:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load DB restore data' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    const body = await request.json();

    if (typeof body.table === 'string' && typeof body.area !== 'string') {
      return NextResponse.json(serializeBigInt(await runTableRestore(body)));
    }

    return NextResponse.json(serializeBigInt(await runRestore(body)));
  } catch (error) {
    console.error('Error in DB restore POST:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to restore data' },
      { status: 500 }
    );
  }
}
