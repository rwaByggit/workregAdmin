'use client';

import {
  AlertTriangle,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  DatabaseBackup,
  RefreshCw,
  Search,
  Table2,
  X,
} from 'lucide-react';
import type { TableWorkspaceTab } from './workspaceTabs';

export type PreviewTab = 'source' | 'backup';
export type TransferMode = 'upsert' | 'replace';

export interface TableInfo {
  tableName: string;
  existsInBackup?: boolean;
  existsInSource?: boolean;
  accountFilterSupported: boolean;
  lastBackupAt?: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TablePayload {
  sourceDatabase: string;
  backupDatabase: string;
  tables: TableInfo[];
}

export interface DetailPayload {
  sourceDatabase: string;
  backupDatabase: string;
  tableName: string;
  columns: ColumnInfo[];
  backupColumns: ColumnInfo[];
  primaryKeys: string[];
  data: Record<string, unknown>[];
  backupData: Record<string, unknown>[];
  sourceRowCount: string | null;
  backupRowCount: string | null;
  existsInBackup?: boolean;
  existsInSource?: boolean;
  previewLimit: number;
}

export interface Notice {
  kind: 'success' | 'error';
  text: string;
}

export interface RowDiffResult {
  matchedRows: number;
  changedRows: number;
  onlyInBackup: number;
  onlyInSource: number;
  diffCount: number;
  rowStatus: Map<string, 'unchanged' | 'changed' | 'onlyBackup' | 'onlySource'>;
}

export interface ColumnComparison {
  name: string;
  sourceType: string | null;
  backupType: string | null;
  status: 'match' | 'typeMismatch' | 'onlySource' | 'onlyBackup';
}

interface RestoreContainerProps {
  activeTab: TableWorkspaceTab;
  tables: TableInfo[];
  filteredTables: TableInfo[];
  selectedTable: string;
  search: string;
  tablePayload: TablePayload | null;
  detail: DetailPayload | null;
  loadingTables: boolean;
  loadingDetail: boolean;
  runningAction: boolean;
  transferMode: TransferMode;
  notice: Notice | null;
  previewTab: PreviewTab;
  selectedInfo?: TableInfo;
  counterpartExists: boolean;
  activeColumns: ColumnInfo[];
  activeRows: Record<string, unknown>[];
  columnComparison: ColumnComparison[];
  columnDifferenceCount: number;
  shouldShowColumnTable: boolean;
  rowDiff: RowDiffResult | null;
  canRun: boolean;
  onRefreshTables: () => void;
  onSearchChange: (search: string) => void;
  onSelectTable: (table: string) => void;
  onTransferModeChange: (mode: TransferMode) => void;
  onOpenConfirm: () => void;
  onDismissNotice: () => void;
  onToggleColumns: () => void;
  onPreviewTabChange: (tab: PreviewTab) => void;
  onReloadDetail: () => void;
}

function displayValue(value: unknown) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function lastBackupTime(table?: TableInfo) {
  if (!table?.lastBackupAt) return 'Never';

  const backupDate = new Date(table.lastBackupAt);
  if (Number.isNaN(backupDate.getTime())) return table.lastBackupAt;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(backupDate);
}

export function RestoreContainer({
  activeTab,
  tables,
  filteredTables,
  selectedTable,
  search,
  tablePayload,
  detail,
  loadingTables,
  loadingDetail,
  runningAction,
  transferMode,
  notice,
  previewTab,
  selectedInfo,
  counterpartExists,
  activeColumns,
  activeRows,
  columnComparison,
  columnDifferenceCount,
  shouldShowColumnTable,
  rowDiff,
  canRun,
  onRefreshTables,
  onSearchChange,
  onSelectTable,
  onTransferModeChange,
  onOpenConfirm,
  onDismissNotice,
  onToggleColumns,
  onPreviewTabChange,
  onReloadDetail,
}: RestoreContainerProps) {
  return (
    <div className="mx-auto flex max-w-[1500px] gap-6 px-4 py-4 sm:px-6 md:items-start">
      <aside className="w-full shrink-0 rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:w-1/4 md:sticky md:top-4">
        <div className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Select table</h2><p className="mt-0.5 text-xs text-gray-500">{tables.length} available</p></div>
            <button type="button" title="Refresh table list" disabled={loadingTables} onClick={onRefreshTables} className="flex h-8 w-8 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loadingTables ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <label className="relative mt-3 block">
            <span className="sr-only">Search tables</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Find a table..." className="h-9 w-full border border-gray-300 bg-white pl-9 pr-8 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600" />
            {search ? <button type="button" title="Clear search" onClick={() => onSearchChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"><X className="h-4 w-4" /></button> : null}
          </label>
        </div>

        <div className="max-h-[500px] overflow-y-auto">
          {loadingTables && tables.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-sm text-gray-500"><RefreshCw className="h-4 w-4 animate-spin" /> Loading tables...</div>
          ) : filteredTables.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">No tables match your search.</p>
          ) : filteredTables.map((table) => {
            const exists = activeTab === 'backup' ? table.existsInBackup !== false : table.existsInSource !== false;
            const active = table.tableName === selectedTable;
            return (
              <button type="button" key={table.tableName} onClick={() => onSelectTable(table.tableName)} className={`flex w-full items-center gap-2 rounded-lg border p-2 text-left text-sm ${active ? 'border-blue-300 bg-blue-100 text-blue-900' : 'border-gray-200 hover:bg-yellow-50'}`}>
                <Table2 className={`h-4 w-4 shrink-0 ${active ? 'text-blue-700' : 'text-gray-400'}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{table.tableName}</span>
                {!exists ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-label="Counterpart table missing" /> : null}
                <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-blue-600' : 'text-gray-300'}`} />
              </button>
            );
          })}
        </div>
      </aside>

      <section className="w-full min-w-0 space-y-4 md:w-2/3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase text-blue-700">{activeTab === 'backup' ? 'Operational to backup' : 'Backup to operational'}</p>
              <h2 className="mt-1 truncate text-lg font-semibold">{selectedTable ? `Columns of ${selectedTable}` : 'Select a table'}</h2>
              <p className="mt-2 text-sm text-gray-600">Last backup: {lastBackupTime(selectedInfo)}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {activeTab === 'backup' ? (
                <div className="flex border border-gray-300 p-0.5" aria-label="Backup mode">
                  {(['upsert', 'replace'] as TransferMode[]).map((mode) => (
                    <button type="button" key={mode} onClick={() => onTransferModeChange(mode)} className={`px-3 py-1.5 text-xs font-medium capitalize ${transferMode === mode ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>{mode}</button>
                  ))}
                </div>
              ) : null}
              <button type="button" disabled={!canRun || loadingDetail || runningAction} onClick={onOpenConfirm} className={`inline-flex h-9 items-center gap-2 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-400 ${activeTab === 'backup' ? 'bg-blue-700 hover:bg-blue-800' : 'bg-emerald-700 hover:bg-emerald-800'}`}>
                {runningAction ? <RefreshCw className="h-4 w-4 animate-spin" /> : activeTab === 'backup' ? <DatabaseBackup className="h-4 w-4" /> : <ArchiveRestore className="h-4 w-4" />}
                {runningAction ? 'Working...' : activeTab === 'backup' ? 'Back up table' : 'Restore table'}
              </button>
            </div>
          </div>
        </div>

        {notice ? (
          <div className={`m-5 flex items-start gap-3 border p-3 text-sm ${notice.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
            {notice.kind === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="flex-1">{notice.text}</span>
            <button type="button" title="Dismiss" onClick={onDismissNotice}><X className="h-4 w-4" /></button>
          </div>
        ) : null}

        {loadingDetail ? (
          <div className="flex min-h-[420px] items-center justify-center gap-3 text-sm text-gray-500"><RefreshCw className="h-5 w-5 animate-spin" /> Loading table details...</div>
        ) : detail ? (
          <>
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Columns of {selectedTable}</h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <div className="flex flex-wrap items-center gap-3">
                    <span>Operational: {detail.columns.length}</span>
                    <span>Backup: {detail.backupColumns.length}</span>
                    <span className={columnDifferenceCount > 0 ? 'font-semibold text-amber-700' : 'font-semibold text-emerald-700'}>
                      {columnDifferenceCount === 0 ? 'Schemas match' : `${columnDifferenceCount} difference(s)`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={onToggleColumns}
                    className="inline-flex h-8 items-center gap-1 border border-gray-300 px-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    aria-expanded={shouldShowColumnTable}
                    aria-controls="column-comparison-table"
                  >
                    {shouldShowColumnTable ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {shouldShowColumnTable ? 'Hide columns' : 'Show columns'}
                  </button>
                </div>
              </div>
              {shouldShowColumnTable ? (
                columnComparison.length === 0 ? (
                  <p id="column-comparison-table" className="text-sm text-gray-500">No columns found.</p>
                ) : (
                  <ColumnComparisonTable columns={columnComparison} />
                )
              ) : null}
            </div>

            <div className="grid rounded-lg border border-gray-200 bg-white shadow-sm sm:grid-cols-3">
              <Metric label="Operational rows" value={detail.sourceRowCount ?? (detail.existsInSource === false ? 'Missing' : '0')} />
              <Metric label="Backup rows" value={detail.backupRowCount ?? (detail.existsInBackup === false ? 'Missing' : '0')} />
              <Metric label="Primary key" value={detail.primaryKeys.length ? detail.primaryKeys.join(', ') : 'None'} mono />
            </div>

            {rowDiff ? (
              <div className="border-b border-gray-200 bg-gray-50 px-5 py-4">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">Prod vs backup report</h3>
                    <p className="mt-0.5 text-xs text-gray-500">Based on the loaded preview rows, up to {detail.previewLimit} from each side.</p>
                  </div>
                  <span className={`text-xs font-semibold ${rowDiff.diffCount === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {rowDiff.diffCount === 0 ? 'No differences in preview' : `${rowDiff.diffCount} difference(s) in preview`}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <DiffMetric label="Unchanged" value={rowDiff.matchedRows} tone="good" />
                  <DiffMetric label="Changed" value={rowDiff.changedRows} tone="warn" />
                  <DiffMetric label="Only backup" value={rowDiff.onlyInBackup} tone="info" />
                  <DiffMetric label="Only operational" value={rowDiff.onlyInSource} tone="info" />
                </div>
              </div>
            ) : null}

            {!counterpartExists ? (
              <div className="m-5 flex gap-3 border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <div><p className="font-medium">Destination table is missing</p><p className="mt-1 text-amber-800">Create or repair the matching table before running this operation.</p></div>
              </div>
            ) : null}

            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" role="region" aria-label="Table data">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">Data of {selectedTable}</h3>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{activeRows.length} rows</span>
                  <button type="button" title="Reload preview" onClick={onReloadDetail} className="flex h-8 w-8 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50"><RefreshCw className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="mb-3 flex border-b border-gray-200" role="tablist" aria-label="Data preview">
                <PreviewTabButton active={previewTab === 'source'} label="Operational" disabled={detail.existsInSource === false} onClick={() => onPreviewTabChange('source')} />
                <PreviewTabButton active={previewTab === 'backup'} label="Backup" disabled={detail.existsInBackup === false} onClick={() => onPreviewTabChange('backup')} />
              </div>

              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-gray-500">{activeColumns.length} columns, showing up to {detail.previewLimit} rows</p>
                </div>
                <DataPreview columns={activeColumns} rows={activeRows} />
              </div>
            </div>

            <div className="grid gap-px border-t border-gray-200 bg-gray-200 text-xs sm:grid-cols-2">
              <DatabaseLabel label="Operational database" value={tablePayload?.sourceDatabase ?? detail.sourceDatabase} />
              <DatabaseLabel label="Backup database" value={tablePayload?.backupDatabase ?? detail.backupDatabase} />
            </div>
          </>
        ) : (
          <div className="flex min-h-[420px] flex-col items-center justify-center p-8 text-center text-gray-500"><Table2 className="h-8 w-8" /><p className="mt-3 text-sm">Choose a table to view its backup status.</p></div>
        )}
      </section>
    </div>
  );
}

function PreviewTabButton({ active, label, disabled, onClick }: { active: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} disabled={disabled} onClick={onClick} className={`border-b-2 px-4 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-gray-300 ${active ? 'border-blue-700 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-950'}`}>{label}</button>;
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="border-b border-gray-200 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><p className="text-xs text-gray-500">{label}</p><p className={`mt-1 truncate text-sm font-semibold ${mono ? 'font-mono text-xs' : ''}`}>{value}</p></div>;
}

function DiffMetric({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'info' }) {
  const toneClass = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-blue-700';
  return <div className="border border-gray-200 bg-white px-3 py-2"><p className="text-xs text-gray-500">{label}</p><p className={`mt-1 text-base font-semibold ${toneClass}`}>{value}</p></div>;
}

function DatabaseLabel({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-gray-50 p-4"><p className="font-medium text-gray-500">{label}</p><p className="mt-1 truncate font-mono text-gray-700" title={value}>{value}</p></div>;
}

function ColumnComparisonTable({ columns }: { columns: ColumnComparison[] }) {
  return (
    <div id="column-comparison-table" className="max-h-[320px] overflow-auto border border-gray-200">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
          <tr>
            <th className="border-b border-r border-gray-200 px-3 py-2.5 font-semibold">Column</th>
            <th className="border-b border-r border-gray-200 px-3 py-2.5 font-semibold">Operational</th>
            <th className="border-b border-r border-gray-200 px-3 py-2.5 font-semibold">Backup</th>
            <th className="border-b border-gray-200 px-3 py-2.5 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {columns.map((column) => {
            const differs = column.status !== 'match';
            const statusLabel = column.status === 'match'
              ? 'Match'
              : column.status === 'typeMismatch'
                ? 'Type differs'
                : column.status === 'onlySource'
                  ? 'Operational only'
                  : 'Backup only';

            return (
              <tr key={column.name} className={differs ? 'bg-amber-50' : undefined}>
                <td className="whitespace-nowrap border-r border-gray-100 px-3 py-2 font-mono font-semibold text-gray-900">{column.name}</td>
                <td className={`whitespace-nowrap border-r border-gray-100 px-3 py-2 ${column.sourceType ? 'text-gray-700' : 'font-medium text-gray-500'}`}>{column.sourceType ?? 'Not present'}</td>
                <td className={`whitespace-nowrap border-r border-gray-100 px-3 py-2 ${column.backupType ? 'text-gray-700' : 'font-medium text-gray-500'}`}>{column.backupType ?? 'Not present'}</td>
                <td className={`whitespace-nowrap px-3 py-2 font-medium ${differs ? 'text-amber-800' : 'text-emerald-700'}`}>{statusLabel}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DataPreview({ columns, rows }: { columns: ColumnInfo[]; rows: Record<string, unknown>[] }) {
  if (columns.length === 0) return <div className="border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">No table data is available on this side.</div>;
  if (rows.length === 0) return <div className="border border-gray-200 p-8 text-center text-sm text-gray-500">This table has no rows.</div>;
  return (
    <div className="max-h-[580px] overflow-auto border border-gray-200">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600"><tr>{columns.map((column) => <th key={column.name} className="whitespace-nowrap border-b border-r border-gray-200 px-3 py-2.5 font-semibold last:border-r-0" title={column.type}>{column.name}</th>)}</tr></thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {rows.map((row, index) => (
            <tr key={index} className="hover:bg-blue-50/50">
              {columns.map((column) => {
                const value = displayValue(row[column.name]);
                return <td key={column.name} className={`max-w-64 truncate border-r border-gray-100 px-3 py-2 last:border-r-0 ${row[column.name] === null ? 'italic text-gray-400' : 'text-gray-700'}`} title={value}>{value}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
