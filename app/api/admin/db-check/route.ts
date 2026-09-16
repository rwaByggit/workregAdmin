import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { NextRequest, NextResponse } from 'next/server';
import { serializeBigInt } from '@/lib/serializeBigInt';
import { requireSystemAdmin as requireAdmin } from '@/app/lib/system-admin';

export const runtime = 'nodejs';

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MIGRATION_FILE = 'supabase_migration.sql';
const PRISMA_SCHEMA_FILE = 'prisma/schema.prisma';
const SCRIPT_SCAN_EXCLUDED_DIRS = new Set(['.git', '.next', 'node_modules']);
const SCHEMA_DRIFT_IGNORED_TABLES = new Set(['_prisma_migrations']);
const KEEP_ALIVE_ROW_ID = 1;

type DbRole = 'source' | 'backup';

interface EnvDatabase {
  url: string;
  label: string;
}

interface KeepAliveStatus {
  role: DbRole;
  database: string;
  exists: boolean;
  alive_at: string | null;
  previous_alive_at?: string | null;
}

interface SupabaseProjectCheck {
  role: DbRole;
  status: 'ok' | 'mismatch' | 'unknown';
  supabaseUrlSource: string;
  supabaseUrlHost: string | null;
  databaseHost: string | null;
  supabaseProjectRef: string | null;
  databaseProjectRef: string | null;
  message: string;
}

interface DbColumn {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  is_not_nullable: boolean;
  column_default: string | null;
  attgenerated: string;
  attidentity: string;
  is_primary_key: boolean;
}

interface SchemaColumn {
  name: string;
  dataType: string;
}

interface MissingTable {
  tableName: string;
  scriptFile: string;
  scriptSql: string | null;
  scriptSource: 'sql-file' | 'prisma-schema' | 'missing';
  priority: 1 | 2;
  dependencies: string[];
  missingDependencies: string[];
}

interface ExtraTable {
  tableName: string;
}

interface TableScript {
  scriptFile: string;
  scriptSql: string;
  scriptSource: 'sql-file' | 'prisma-schema';
  dependencies: string[];
}

interface PrismaField {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  isId: boolean;
  defaultSql: string | null;
}

interface PrismaModel {
  modelName: string;
  tableName: string;
  fields: PrismaField[];
  idFields: string[];
  relationModelNames: string[];
  dependencies: string[];
}

type SchemaMap = Map<string, Map<string, SchemaColumn>>;
type DbSchemaMap = Map<string, Map<string, DbColumn>>;
type TableScriptMap = Map<string, TableScript>;

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

function createDb(config: EnvDatabase) {
  return postgres(config.url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

function normalizeDataType(definition: string) {
  let normalized = definition
    .replace(/\s+/g, ' ')
    .replace(/\bGENERATED\s+ALWAYS\s+AS\s*\(.+?\)\s+STORED\b/i, '')
    .replace(/\bDEFAULT\b[\s\S]*$/i, '')
    .replace(/\bNOT\s+NULL\b[\s\S]*$/i, '')
    .replace(/\bNULL\b[\s\S]*$/i, '')
    .replace(/\bPRIMARY\s+KEY\b[\s\S]*$/i, '')
    .replace(/\bUNIQUE\b[\s\S]*$/i, '')
    .replace(/\bREFERENCES\b[\s\S]*$/i, '')
    .trim()
    .toLowerCase();

  normalized = normalized
    .replace(/^bigserial\b/, 'bigint')
    .replace(/^serial\b/, 'integer')
    .replace(/^smallserial\b/, 'smallint')
    .replace(/^varchar\b/, 'character varying')
    .replace(/^decimal\b/, 'numeric')
    .replace(/^bool\b/, 'boolean')
    .replace(/^timestamptz(?:\((\d+)\))?$/, (_match, precision) =>
      precision ? `timestamp(${precision}) with time zone` : 'timestamp with time zone'
    )
    .replace(/^timestamp\((\d+)\)$/, 'timestamp($1) without time zone')
    .replace(/^timestamp$/, 'timestamp without time zone')
    .replace(/^time\((\d+)\)$/, 'time($1) without time zone')
    .replace(/^time$/, 'time without time zone')
    .replace(/^timestamp\(6\) without time zone$/, 'timestamp without time zone')
    .replace(/^timestamp\(6\) with time zone$/, 'timestamp with time zone')
    .replace(/^time\(6\) without time zone$/, 'time without time zone')
    .replace(/^time\(6\) with time zone$/, 'time with time zone');

  return normalized;
}

function addSchemaColumn(schema: SchemaMap, table: string, column: string, dataType: string) {
  assertIdentifier(table, 'table name');
  assertIdentifier(column, 'column name');

  if (!schema.has(table)) {
    schema.set(table, new Map());
  }

  schema.get(table)!.set(column, {
    name: column,
    dataType: normalizeDataType(dataType),
  });
}

function readSqlFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function readEnvFile(relativePath: string) {
  const envPath = path.join(process.cwd(), relativePath);
  return fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
}

function listSqlScriptFiles(directory = process.cwd()) {
  const files: string[] = [];

  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    if (SCRIPT_SCAN_EXCLUDED_DIRS.has(entry.name)) return;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSqlScriptFiles(absolutePath));
      return;
    }

    if (entry.isFile() && entry.name.endsWith('.sql')) {
      files.push(path.relative(process.cwd(), absolutePath));
    }
  });

  return files.sort((left, right) => {
    if (left === MIGRATION_FILE) return -1;
    if (right === MIGRATION_FILE) return 1;
    return left.localeCompare(right);
  });
}

function includeLeadingCommentBlock(sql: string, startIndex: number) {
  let lineStart = sql.lastIndexOf('\n', startIndex - 1) + 1;

  while (lineStart > 0) {
    const previousLineEnd = lineStart - 1;
    const previousLineStart = sql.lastIndexOf('\n', previousLineEnd - 1) + 1;
    const previousLine = sql.slice(previousLineStart, previousLineEnd).trim();

    if (previousLine && !previousLine.startsWith('--')) break;

    lineStart = previousLineStart;
  }

  return lineStart;
}

function findNextTableOrSectionStart(sql: string, fromIndex: number) {
  const nextCreateMatch = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\(/i.exec(
    sql.slice(fromIndex)
  );
  const nextSectionMatch = /\n-- ============================================================================/i.exec(sql.slice(fromIndex));
  const candidates = [nextCreateMatch, nextSectionMatch]
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => fromIndex + match.index);

  if (candidates.length === 0) return sql.length;

  return includeLeadingCommentBlock(sql, Math.min(...candidates));
}

function splitSqlStatements(sql: string) {
  const statements: Array<{ sql: string; start: number; end: number }> = [];
  let current = '';
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarQuote: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const nextTwo = sql.slice(index, index + 2);

    if (!current && char.trim()) {
      start = index;
    }

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        current += dollarQuote;
        index += dollarQuote.length - 1;
        dollarQuote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && nextTwo === '$$') {
      dollarQuote = '$$';
      current += nextTwo;
      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === '$') {
      const dollarMatch = sql.slice(index).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$/);
      if (dollarMatch) {
        dollarQuote = dollarMatch[0];
        current += dollarQuote;
        index += dollarQuote.length - 1;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote) {
      current += char;
      if (inSingleQuote && sql[index + 1] === "'") {
        current += sql[index + 1];
        index += 1;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    current += char;

    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      statements.push({ sql: current.trim(), start, end: index + 1 });
      current = '';
    }
  }

  if (current.trim()) {
    statements.push({ sql: current.trim(), start, end: sql.length });
  }

  return statements;
}

function statementReferencesTableAsIdentifier(statement: string, tableName: string) {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identifier = `"?${escapedTable}"?`;
  const patterns = [
    new RegExp(`\\bALTER\\s+TABLE\\s+${identifier}\\b`, 'i'),
    new RegExp(`\\bINSERT\\s+INTO\\s+${identifier}\\b`, 'i'),
    new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\b[\\s\\S]*?\\bON\\s+${identifier}\\b`, 'i'),
    new RegExp(`\\bCOMMENT\\s+ON\\s+TABLE\\s+${identifier}\\b`, 'i'),
    new RegExp(`\\bCOMMENT\\s+ON\\s+COLUMN\\s+${identifier}\\.`, 'i'),
  ];

  return patterns.some((pattern) => pattern.test(statement));
}

function extractReferencedTables(sql: string) {
  const referencedTables = new Set<string>();
  const referencesPattern = /\bREFERENCES\s+(?:(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?)"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi;
  let referenceMatch: RegExpExecArray | null;

  while ((referenceMatch = referencesPattern.exec(sql)) !== null) {
    referencedTables.add(referenceMatch[1]);
  }

  return [...referencedTables];
}

function addTableScriptsFromSql(
  scripts: TableScriptMap,
  sql: string,
  scriptFile: string,
  scriptSource: TableScript['scriptSource'],
  overwriteExisting = false
) {
  const statements = splitSqlStatements(sql);
  const createTablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi;
  let createMatch: RegExpExecArray | null;

  while ((createMatch = createTablePattern.exec(sql)) !== null) {
    const tableName = createMatch[1];
    if (!overwriteExisting && scripts.has(tableName)) continue;

    const sectionStart = includeLeadingCommentBlock(sql, createMatch.index);
    const sectionEnd = findNextTableOrSectionStart(sql, createMatch.index + createMatch[0].length);
    const section = sql.slice(sectionStart, sectionEnd).trim();
    const relatedStatements = statements
      .filter((statement) => statement.start < sectionStart || statement.end > sectionEnd)
      .filter((statement) => statementReferencesTableAsIdentifier(statement.sql, tableName))
      .map((statement) => statement.sql);
    const script = [section, ...relatedStatements].filter(Boolean).join('\n\n');

    scripts.set(tableName, {
      scriptFile,
      scriptSql: script,
      scriptSource,
      dependencies: extractReferencedTables(script).filter((dependency) => dependency !== tableName),
    });
  }
}

function buildPrismaColumnDefinition(field: PrismaField) {
  const pieces = [quoteIdentifier(field.columnName), field.dataType];

  if (field.defaultSql) {
    pieces.push(`DEFAULT ${field.defaultSql}`);
  }

  if (!field.isNullable) {
    pieces.push('NOT NULL');
  }

  return pieces.join(' ');
}

function buildPrismaCreateTableScript(model: PrismaModel) {
  const lines = model.fields.map((field) => `  ${buildPrismaColumnDefinition(field)}`);
  const idFields = model.idFields.length > 0
    ? model.idFields
    : model.fields.filter((field) => field.isId).map((field) => field.columnName);

  if (idFields.length > 0) {
    const primaryKeyColumns = idFields.map(quoteIdentifier).join(', ');
    lines.push(`  CONSTRAINT ${quoteIdentifier(`${model.tableName}_pkey`)} PRIMARY KEY (${primaryKeyColumns})`);
  }

  return [
    `-- Generated from ${PRISMA_SCHEMA_FILE}`,
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(model.tableName)} (`,
    lines.join(',\n'),
    ');',
  ].join('\n');
}

function buildTableScriptMap(prismaModels: PrismaModel[]): TableScriptMap {
  const scripts: TableScriptMap = new Map();

  listSqlScriptFiles().forEach((scriptFile) => {
    addTableScriptsFromSql(scripts, readSqlFile(scriptFile), scriptFile, 'sql-file');
  });

  prismaModels.forEach((model) => {
    const existingScript = scripts.get(model.tableName);
    if (existingScript) {
      return;
    }

    scripts.set(model.tableName, {
      scriptFile: PRISMA_SCHEMA_FILE,
      scriptSql: buildPrismaCreateTableScript(model),
      scriptSource: 'prisma-schema',
      dependencies: model.dependencies,
    });
  });

  return scripts;
}

function parsePrismaMap(attributes: string) {
  const mapMatch = attributes.match(/@map\("([^"]+)"\)/);
  return mapMatch?.[1] ?? null;
}

function parsePrismaDefault(attributes: string) {
  const defaultMatch = attributes.match(/@default\(([\s\S]*?)\)(?:\s|$)/);
  if (!defaultMatch) return null;

  const value = defaultMatch[1].trim();
  if (value === 'autoincrement()') return null;
  if (value === 'now()') return 'CURRENT_TIMESTAMP';
  if (value === 'true' || value === 'false') return value;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return value;

  const stringMatch = value.match(/^"([\s\S]*)"$/);
  if (stringMatch) {
    return `'${stringMatch[1].replace(/'/g, "''")}'`;
  }

  const dbGeneratedMatch = value.match(/^dbgenerated\("([\s\S]*)"\)$/);
  if (dbGeneratedMatch) {
    return dbGeneratedMatch[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"');
  }

  return null;
}

function parsePrismaDbType(attributes: string) {
  const dbMatch = attributes.match(/@db\.([A-Za-z]+)(?:\(([^)]*)\))?/);
  if (!dbMatch) return null;

  const name = dbMatch[1].toLowerCase();
  const args = dbMatch[2]?.replace(/\s+/g, '') ?? '';
  const withArgs = (type: string) => (args ? `${type}(${args})` : type);
  const map: Record<string, string> = {
    bigint: 'bigint',
    boolean: 'boolean',
    date: 'date',
    doubleprecision: 'double precision',
    integer: 'integer',
    int: 'integer',
    jsonb: 'jsonb',
    smallint: 'smallint',
    text: 'text',
  };

  if (name === 'varchar') return withArgs('varchar');
  if (name === 'char') return withArgs('char');
  if (name === 'decimal') return withArgs('decimal');
  if (name === 'timestamp') return withArgs('timestamp');
  if (name === 'timestamptz') return withArgs('timestamptz');
  if (name === 'time') return withArgs('time');

  return map[name] ?? null;
}

function prismaScalarToSqlType(type: string, attributes: string) {
  if (attributes.includes('@default(autoincrement())')) {
    if (type === 'BigInt') return 'bigserial';
    if (type === 'Int') return 'serial';
  }

  const dbType = parsePrismaDbType(attributes);
  if (dbType) return dbType;

  const map: Record<string, string> = {
    BigInt: 'bigint',
    Boolean: 'boolean',
    DateTime: 'timestamp',
    Decimal: 'decimal',
    Float: 'double precision',
    Int: 'integer',
    Json: 'jsonb',
    String: 'text',
  };

  return map[type] ?? null;
}

function parsePrismaIdFields(line: string) {
  const idMatch = line.match(/@@id\(\[([^\]]+)\]/);
  if (!idMatch) return [];

  return idMatch[1]
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}

function parsePrismaModels() {
  const schema = readSqlFile(PRISMA_SCHEMA_FILE);
  const models: PrismaModel[] = [];
  const modelPattern = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{([\s\S]*?)\n\}/g;
  let modelMatch: RegExpExecArray | null;

  while ((modelMatch = modelPattern.exec(schema)) !== null) {
    const modelName = modelMatch[1];
    const body = modelMatch[2];
    const fields: PrismaField[] = [];
    const fieldColumnByName = new Map<string, string>();
    const relationModelNames: string[] = [];
    let tableName = modelName;
    let idFieldNames: string[] = [];

    body.split('\n').forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) return;

      const tableMapMatch = line.match(/^@@map\("([^"]+)"\)/);
      if (tableMapMatch) {
        tableName = tableMapMatch[1];
        return;
      }

      if (line.startsWith('@@id')) {
        idFieldNames = parsePrismaIdFields(line);
        return;
      }

      if (line.startsWith('@@')) return;

      const fieldMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\??|\[\])\s*([\s\S]*)$/);
      if (!fieldMatch) return;

      const fieldName = fieldMatch[1];
      const type = fieldMatch[2];
      const typeModifier = fieldMatch[3];
      const attributes = fieldMatch[4] ?? '';
      const dataType = prismaScalarToSqlType(type, attributes);
      if (!dataType) {
        if (attributes.includes('@relation') && attributes.includes('fields:')) {
          relationModelNames.push(type);
        }
        return;
      }

      const columnName = parsePrismaMap(attributes) ?? fieldName;
      fieldColumnByName.set(fieldName, columnName);
      fields.push({
        columnName,
        dataType,
        isNullable: typeModifier === '?',
        isId: attributes.includes('@id'),
        defaultSql: parsePrismaDefault(attributes),
      });
    });

    const idFields = idFieldNames.map((field) => fieldColumnByName.get(field) ?? field);
    models.push({ modelName, tableName, fields, idFields, relationModelNames, dependencies: [] });
  }

  const tableNameByModel = new Map(models.map((model) => [model.modelName, model.tableName]));
  models.forEach((model) => {
    model.dependencies = [...new Set(
      model.relationModelNames
        .map((relationModelName) => tableNameByModel.get(relationModelName))
        .filter((tableName): tableName is string => Boolean(tableName) && tableName !== model.tableName)
    )].sort((left, right) => left.localeCompare(right));
  });

  return models;
}

function buildPrismaSchemaMap(models: PrismaModel[]) {
  const schema: SchemaMap = new Map();

  models.forEach((model) => {
    model.fields.forEach((field) => {
      addSchemaColumn(schema, model.tableName, field.columnName, field.dataType);
    });
  });

  return schema;
}

function buildMissingTable(tableName: string, migrationScripts: TableScriptMap): MissingTable {
  const script = migrationScripts.get(tableName);
  if (script) {
    return {
      tableName,
      scriptFile: script.scriptFile,
      scriptSql: script.scriptSql,
      scriptSource: script.scriptSource,
      priority: 1,
      dependencies: script.dependencies,
      missingDependencies: [],
    };
  }

  return {
    tableName,
    scriptFile: PRISMA_SCHEMA_FILE,
    scriptSql: null,
    scriptSource: 'missing',
    priority: 1,
    dependencies: [],
    missingDependencies: [],
  };
}

function sortMissingTablesForCreation(missingTables: MissingTable[], actualSchema: DbSchemaMap) {
  const missingNames = new Set(missingTables.map((table) => table.tableName));
  const tableByName = new Map(missingTables.map((table) => [table.tableName, table]));
  const sortedByDependency: MissingTable[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (tableName: string) => {
    if (visited.has(tableName)) return;
    const table = tableByName.get(tableName);
    if (!table) return;

    if (visiting.has(tableName)) {
      return;
    }

    visiting.add(tableName);
    table.dependencies
      .filter((dependency) => missingNames.has(dependency))
      .sort((left, right) => left.localeCompare(right))
      .forEach(visit);
    visiting.delete(tableName);
    visited.add(tableName);
    sortedByDependency.push(table);
  };

  missingTables
    .map((table) => table.tableName)
    .sort((left, right) => left.localeCompare(right))
    .forEach(visit);

  const dependencyOrder = new Map(sortedByDependency.map((table, index) => [table.tableName, index]));

  return sortedByDependency
    .map((table) => {
      const missingDependencies = table.dependencies.filter((dependency) => !actualSchema.has(dependency));

      return {
        ...table,
        priority: (missingDependencies.length === 0 ? 1 : 2) as 1 | 2,
        missingDependencies,
      };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return (dependencyOrder.get(left.tableName) ?? 0) - (dependencyOrder.get(right.tableName) ?? 0);
    });
}

async function getDbSchema(sql: ReturnType<typeof postgres>) {
  const rows = await sql<DbColumn[]>`
    SELECT
      cls.relname AS table_name,
      attr.attname AS column_name,
      attr.attnum::integer AS ordinal_position,
      pg_catalog.format_type(attr.atttypid, attr.atttypmod) AS data_type,
      attr.attnotnull AS is_not_nullable,
      pg_get_expr(def.adbin, def.adrelid) AS column_default,
      attr.attgenerated,
      attr.attidentity,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index idx
        WHERE idx.indrelid = cls.oid
          AND idx.indisprimary
          AND attr.attnum = ANY(idx.indkey)
      ) AS is_primary_key
    FROM pg_catalog.pg_attribute attr
    JOIN pg_catalog.pg_class cls ON cls.oid = attr.attrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef def
      ON def.adrelid = attr.attrelid
      AND def.adnum = attr.attnum
    WHERE ns.nspname = 'public'
      AND cls.relkind IN ('r', 'p')
      AND attr.attnum > 0
      AND NOT attr.attisdropped
    ORDER BY cls.relname, attr.attnum;
  `;

  const schema: DbSchemaMap = new Map();
  rows.forEach((row) => {
    if (!schema.has(row.table_name)) {
      schema.set(row.table_name, new Map());
    }
    schema.get(row.table_name)!.set(row.column_name, row);
  });

  return schema;
}

function compareExpectedToDb(expected: SchemaMap, actual: DbSchemaMap, migrationScripts: TableScriptMap) {
  const missingTables: MissingTable[] = [];
  const extraTables: ExtraTable[] = [];
  const missingColumns: Array<{ tableName: string; columnName: string; expectedType: string }> = [];
  const typeMismatches: Array<{ tableName: string; columnName: string; expectedType: string; actualType: string }> = [];
  const expectedTableNames = new Set(expected.keys());

  expected.forEach((expectedColumns, tableName) => {
    const actualColumns = actual.get(tableName);
    if (!actualColumns) {
      missingTables.push(buildMissingTable(tableName, migrationScripts));
      return;
    }

    expectedColumns.forEach((expectedColumn, columnName) => {
      const actualColumn = actualColumns.get(columnName);
      if (!actualColumn) {
        missingColumns.push({
          tableName,
          columnName,
          expectedType: expectedColumn.dataType,
        });
        return;
      }

      if (expectedColumn.dataType && normalizeDataType(actualColumn.data_type) !== expectedColumn.dataType) {
        typeMismatches.push({
          tableName,
          columnName,
          expectedType: expectedColumn.dataType,
          actualType: actualColumn.data_type,
        });
      }
    });
  });

  actual.forEach((_actualColumns, tableName) => {
    if (!expectedTableNames.has(tableName) && !SCHEMA_DRIFT_IGNORED_TABLES.has(tableName)) {
      extraTables.push({ tableName });
    }
  });

  return {
    checkedTables: expected.size,
    missingTables: sortMissingTablesForCreation(missingTables, actual),
    extraTables: extraTables.sort((left, right) => left.tableName.localeCompare(right.tableName)),
    missingColumns,
    typeMismatches,
    issueCount: missingTables.length + extraTables.length + missingColumns.length + typeMismatches.length,
  };
}

function compareDbToDb(source: DbSchemaMap, backup: DbSchemaMap, migrationScripts: TableScriptMap) {
  const missingTables: MissingTable[] = [];
  const extraTables: ExtraTable[] = [];
  const missingColumns: Array<{ tableName: string; columnName: string; sourceType: string; repairSql: string }> = [];
  const typeMismatches: Array<{ tableName: string; columnName: string; sourceType: string; backupType: string }> = [];
  const sourceTableNames = new Set(source.keys());

  source.forEach((sourceColumns, tableName) => {
    const backupColumns = backup.get(tableName);
    if (!backupColumns) {
      missingTables.push(buildMissingTable(tableName, migrationScripts));
      return;
    }

    sourceColumns.forEach((sourceColumn, columnName) => {
      const backupColumn = backupColumns.get(columnName);
      if (!backupColumn) {
        missingColumns.push({
          tableName,
          columnName,
          sourceType: sourceColumn.data_type,
          repairSql: buildAddColumnStatement(tableName, sourceColumn),
        });
        return;
      }

      if (normalizeDataType(backupColumn.data_type) !== normalizeDataType(sourceColumn.data_type)) {
        typeMismatches.push({
          tableName,
          columnName,
          sourceType: sourceColumn.data_type,
          backupType: backupColumn.data_type,
        });
      }
    });
  });

  backup.forEach((_backupColumns, tableName) => {
    if (!sourceTableNames.has(tableName) && !SCHEMA_DRIFT_IGNORED_TABLES.has(tableName)) {
      extraTables.push({ tableName });
    }
  });

  return {
    checkedTables: source.size,
    missingTables: sortMissingTablesForCreation(missingTables, backup),
    extraTables: extraTables.sort((left, right) => left.tableName.localeCompare(right.tableName)),
    missingColumns,
    typeMismatches,
    issueCount: missingTables.length + extraTables.length + missingColumns.length + typeMismatches.length,
  };
}

function filterDbSchemaToExpectedTables(schema: DbSchemaMap, expected: SchemaMap) {
  const filtered: DbSchemaMap = new Map();

  expected.forEach((_expectedColumns, tableName) => {
    const columns = schema.get(tableName);
    if (columns) {
      filtered.set(tableName, columns);
    }
  });

  return filtered;
}

function countSchemaTables(schema: DbSchemaMap) {
  let count = 0;

  schema.forEach((_columns, tableName) => {
    if (!SCHEMA_DRIFT_IGNORED_TABLES.has(tableName)) {
      count += 1;
    }
  });

  return count;
}

function buildColumnDefinition(column: DbColumn) {
  const pieces = [quoteIdentifier(column.column_name), column.data_type];

  if (column.attidentity) {
    pieces.push(column.attidentity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY');
  } else if (column.attgenerated === 's' && column.column_default) {
    pieces.push(`GENERATED ALWAYS AS (${column.column_default}) STORED`);
  } else if (column.column_default) {
    pieces.push(`DEFAULT ${column.column_default}`);
  }

  if (column.is_not_nullable) {
    pieces.push('NOT NULL');
  }

  return pieces.join(' ');
}

function buildAddColumnStatement(tableName: string, column: DbColumn) {
  return `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN IF NOT EXISTS ${buildColumnDefinition(column)};`;
}

function parseUrl(value: string | null | undefined) {
  if (!value) return null;

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractSupabaseProjectRefFromSupabaseUrl(value: string | null | undefined) {
  const parsed = parseUrl(value);
  const host = parsed?.hostname ?? '';
  const match = host.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  return match?.[1] ?? null;
}

function extractSupabaseProjectRefFromDatabaseUrl(value: string) {
  const parsed = parseUrl(value);
  if (!parsed) return null;

  const usernameMatch = parsed.username.match(/^(?:postgres|supabase_admin)\.([a-z0-9-]+)$/i);
  if (usernameMatch?.[1]) {
    return usernameMatch[1];
  }

  const directHostMatch = parsed.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
  if (directHostMatch?.[1]) {
    return directHostMatch[1];
  }

  return null;
}

function readSupabaseUrlConfig(role: DbRole) {
  const env = readEnvFile('.env');
  const backupEnv = role === 'backup' ? readEnvFile('.env.backup') : {};

  const candidates = role === 'source'
    ? [
        ['NEXT_PUBLIC_SUPABASE_URL (.env)', process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL],
        ['SUPABASE_URL (.env)', process.env.SUPABASE_URL ?? env.SUPABASE_URL],
      ]
    : [
        ['BACKUP_NEXT_PUBLIC_SUPABASE_URL', process.env.BACKUP_NEXT_PUBLIC_SUPABASE_URL],
        ['BACKUP_DATABASE_URL', process.env.BACKUP_DATABASE_URL],
        ['NEXT_PUBLIC_BACKUP_SUPABASE_URL', process.env.NEXT_PUBLIC_BACKUP_SUPABASE_URL],
        ['BACKUP_NEXT_PUBLIC_SUPABASE_URL (.env)', env.BACKUP_NEXT_PUBLIC_SUPABASE_URL],
        ['BACKUP_DATABASE_URL (.env)', env.BACKUP_DATABASE_URL],
        ['NEXT_PUBLIC_BACKUP_SUPABASE_URL (.env)', env.NEXT_PUBLIC_BACKUP_SUPABASE_URL],
        ['NEXT_PUBLIC_SUPABASE_URL (.env.backup)', backupEnv.NEXT_PUBLIC_SUPABASE_URL],
        ['SUPABASE_URL (.env.backup)', backupEnv.SUPABASE_URL],
      ];

  const candidate = candidates.find(([, value]) => Boolean(value));
  return {
    source: candidate?.[0] ?? 'not configured',
    url: candidate?.[1] ?? null,
  };
}

function buildSupabaseProjectCheck(role: DbRole, config: EnvDatabase): SupabaseProjectCheck {
  const supabaseUrlConfig = readSupabaseUrlConfig(role);
  const supabaseUrl = supabaseUrlConfig.url;
  const supabaseProjectRef = extractSupabaseProjectRefFromSupabaseUrl(supabaseUrl);
  const databaseProjectRef = extractSupabaseProjectRefFromDatabaseUrl(config.url);
  const supabaseUrlHost = parseUrl(supabaseUrl)?.hostname ?? null;
  const databaseHost = parseUrl(config.url)?.hostname ?? null;

  if (!supabaseProjectRef || !databaseProjectRef) {
    return {
      role,
      status: 'unknown',
      supabaseUrlSource: supabaseUrlConfig.source,
      supabaseUrlHost,
      databaseHost,
      supabaseProjectRef,
      databaseProjectRef,
      message: !supabaseProjectRef
        ? role === 'backup'
          ? 'No backup Supabase URL project ref could be read. On Vercel, set BACKUP_SUPABASE_URL or BACKUP_NEXT_PUBLIC_SUPABASE_URL in Production, Preview, or Development.'
          : 'No source Supabase URL project ref could be read.'
        : 'The database URL does not expose a Supabase project ref in the username or direct DB host.',
    };
  }

  const matches = supabaseProjectRef === databaseProjectRef;
  return {
    role,
    status: matches ? 'ok' : 'mismatch',
    supabaseUrlSource: supabaseUrlConfig.source,
    supabaseUrlHost,
    databaseHost,
    supabaseProjectRef,
    databaseProjectRef,
    message: matches
      ? 'Supabase URL and database URL point to the same project ref.'
      : 'Supabase URL and database URL point to different project refs.',
  };
}

async function getKeepAliveStatus(
  sql: ReturnType<typeof postgres>,
  config: EnvDatabase,
  role: DbRole
): Promise<KeepAliveStatus> {
  const tableRows = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('public.tbl_keep_alive') IS NOT NULL AS exists
  `;
  const exists = tableRows[0]?.exists ?? false;

  if (!exists) {
    return {
      role,
      database: config.label,
      exists: false,
      alive_at: null,
    };
  }

  const rows = await sql<{ alive_at: Date }[]>`
    SELECT alive_at
    FROM tbl_keep_alive
    WHERE id = ${KEEP_ALIVE_ROW_ID}
    LIMIT 1
  `;

  return {
    role,
    database: config.label,
    exists: true,
    alive_at: toIsoString(rows[0]?.alive_at),
  };
}

async function touchKeepAlive(
  sql: ReturnType<typeof postgres>,
  config: EnvDatabase,
  role: DbRole
): Promise<KeepAliveStatus> {
  await sql`
    CREATE TABLE IF NOT EXISTS tbl_keep_alive (
      id BIGSERIAL PRIMARY KEY,
      alive_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    ALTER TABLE tbl_keep_alive
    ADD COLUMN IF NOT EXISTS alive_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
  `;

  const previousRows = await sql<{ alive_at: Date }[]>`
    SELECT alive_at
    FROM tbl_keep_alive
    WHERE id = ${KEEP_ALIVE_ROW_ID}
    LIMIT 1
  `;
  const rows = await sql<{ alive_at: Date }[]>`
    INSERT INTO tbl_keep_alive (id, alive_at)
    VALUES (${KEEP_ALIVE_ROW_ID}, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET alive_at = EXCLUDED.alive_at
    RETURNING alive_at
  `;

  return {
    role,
    database: config.label,
    exists: true,
    alive_at: toIsoString(rows[0]?.alive_at),
    previous_alive_at: toIsoString(previousRows[0]?.alive_at),
  };
}

async function buildCheckPayload() {
  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const prismaModels = parsePrismaModels();
    const expectedSchema = buildPrismaSchemaMap(prismaModels);
    const migrationScripts = buildTableScriptMap(prismaModels);
    const [sourceSchema, backupSchema] = await Promise.all([
      getDbSchema(source),
      getDbSchema(backup),
    ]);
    const [sourceKeepAlive, backupKeepAlive] = await Promise.all([
      getKeepAliveStatus(source, sourceConfig, 'source'),
      getKeepAliveStatus(backup, backupConfig, 'backup'),
    ]);
    const sourceVsMigration = compareExpectedToDb(expectedSchema, sourceSchema, migrationScripts);
    const backupVsSource = compareDbToDb(
      filterDbSchemaToExpectedTables(sourceSchema, expectedSchema),
      backupSchema,
      migrationScripts
    );

    return {
      migrationFile: PRISMA_SCHEMA_FILE,
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      supabaseProjectChecks: [
        buildSupabaseProjectCheck('source', sourceConfig),
        buildSupabaseProjectCheck('backup', backupConfig),
      ],
      keepAlive: {
        source: sourceKeepAlive,
        backup: backupKeepAlive,
      },
      sourceVsMigration,
      backupVsSource,
      summary: {
        sourceTables: countSchemaTables(sourceSchema),
        backupTables: countSchemaTables(backupSchema),
        expectedTables: expectedSchema.size,
        issueCount: sourceVsMigration.issueCount + backupVsSource.issueCount,
      },
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function applyBackupColumnFixes(body: Record<string, unknown>) {
  const onlyTables = Array.isArray(body.tables)
    ? new Set(body.tables.filter((table): table is string => typeof table === 'string'))
    : null;
  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const [sourceSchema, backupSchema] = await Promise.all([
      getDbSchema(source),
      getDbSchema(backup),
    ]);
    const expectedSchema = buildPrismaSchemaMap(parsePrismaModels());
    const comparison = compareDbToDb(filterDbSchemaToExpectedTables(sourceSchema, expectedSchema), backupSchema, new Map());
    const missingColumns = onlyTables
      ? comparison.missingColumns.filter((column) => onlyTables.has(column.tableName))
      : comparison.missingColumns;

    const applied: Array<{ tableName: string; columnName: string; sql: string }> = [];

    await backup.begin(async (transaction) => {
      for (const missingColumn of missingColumns) {
        const sourceColumn = sourceSchema.get(missingColumn.tableName)?.get(missingColumn.columnName);
        if (!sourceColumn) continue;

        const statement = buildAddColumnStatement(missingColumn.tableName, sourceColumn);
        await transaction.unsafe(statement);
        applied.push({
          tableName: missingColumn.tableName,
          columnName: missingColumn.columnName,
          sql: statement,
        });
      }
    });

    return {
      sourceDatabase: sourceConfig.label,
      backupDatabase: backupConfig.label,
      applied,
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

async function runMissingTableScript(body: Record<string, unknown>) {
  const tableName = typeof body.tableName === 'string' ? body.tableName : '';
  const target = body.target === 'source' || body.target === 'backup' ? body.target : null;

  assertIdentifier(tableName, 'table name');
  if (!target) {
    throw new Error('Invalid target database');
  }

  const prismaModels = parsePrismaModels();
  const script = buildTableScriptMap(prismaModels).get(tableName);
  if (!script?.scriptSql) {
    throw new Error(`No script found for ${tableName}`);
  }

  const targetConfig = readDatabaseConfig(target);
  const db = createDb(targetConfig);

  try {
    const schema = await getDbSchema(db);
    if (schema.has(tableName)) {
      throw new Error(`${tableName} already exists in ${targetConfig.label}`);
    }

    const missingDependencies = script.dependencies.filter((dependency) => !schema.has(dependency));
    if (missingDependencies.length > 0) {
      throw new Error(
        `Create required table(s) before ${tableName}: ${missingDependencies
          .sort((left, right) => left.localeCompare(right))
          .join(', ')}`
      );
    }

    const statements = splitSqlStatements(script.scriptSql).map((statement) => statement.sql);
    await db.begin(async (transaction) => {
      for (const statement of statements) {
        await transaction.unsafe(statement);
      }
    });

    return {
      tableName,
      targetDatabase: targetConfig.label,
      scriptFile: script.scriptFile,
      statementCount: statements.length,
    };
  } finally {
    await db.end();
  }
}

async function refreshKeepAlive() {
  const sourceConfig = readDatabaseConfig('source');
  const backupConfig = readDatabaseConfig('backup');
  const source = createDb(sourceConfig);
  const backup = createDb(backupConfig);

  try {
    const [sourceKeepAlive, backupKeepAlive] = await Promise.all([
      touchKeepAlive(source, sourceConfig, 'source'),
      touchKeepAlive(backup, backupConfig, 'backup'),
    ]);

    return {
      keepAlive: {
        source: sourceKeepAlive,
        backup: backupKeepAlive,
      },
    };
  } finally {
    await Promise.all([source.end(), backup.end()]);
  }
}

export async function GET() {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    return NextResponse.json(serializeBigInt(await buildCheckPayload()));
  } catch (error) {
    console.error('Error in DB check GET:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to run DB check' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    const body = await request.json();
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'apply-backup-columns') {
      return NextResponse.json(serializeBigInt(await applyBackupColumnFixes(body)));
    }

    if (action === 'run-missing-table-script') {
      return NextResponse.json(serializeBigInt(await runMissingTableScript(body)));
    }

    if (action === 'refresh-keep-alive') {
      return NextResponse.json(serializeBigInt(await refreshKeepAlive()));
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error) {
    console.error('Error in DB check POST:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to apply DB check fixes' },
      { status: 500 }
    );
  }
}
