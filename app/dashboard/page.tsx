'use client';

import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArchiveRestore, Check, ChevronRight, Database,
  DatabaseBackup, LogOut, RefreshCw, Search, Table2, X,
} from 'lucide-react';

type WorkspaceTab = 'backup' | 'restore';
type PreviewTab = 'source' | 'backup';
type TransferMode = 'upsert' | 'replace';

interface TableInfo {
  tableName: string;
  existsInBackup?: boolean;
  existsInSource?: boolean;
  accountFilterSupported: boolean;
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface TablePayload {
  sourceDatabase: string;
  backupDatabase: string;
  tables: TableInfo[];
}

interface DetailPayload {
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

interface Notice {
  kind: 'success' | 'error';
  text: string;
}

type Row = Record<string, unknown>;

interface RowDiffResult {
  matchedRows: number;
  changedRows: number;
  onlyInBackup: number;
  onlyInSource: number;
  diffCount: number;
  rowStatus: Map<string, 'unchanged' | 'changed' | 'onlyBackup' | 'onlySource'>;
}

async function readJson(response: Response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : 'The request failed.');
  }
  return result;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

function buildRowKey(row: Row, primaryKeys: string[]) {
  if (primaryKeys.length === 0) return stableStringify(row);
  return primaryKeys.map((key) => `${key}:${stableStringify(row[key])}`).join('|');
}

function rowsAreEqual(left: Row, right: Row) {
  return stableStringify(left) === stableStringify(right);
}

function diffTableRows(
  backupRows: Row[],
  sourceRows: Row[],
  primaryKeys: string[]
): RowDiffResult {
  const sourceByKey = new Map<string, Row>();
  sourceRows.forEach((row) => sourceByKey.set(buildRowKey(row, primaryKeys), row));

  const rowStatus = new Map<string, 'unchanged' | 'changed' | 'onlyBackup' | 'onlySource'>();
  let matchedRows = 0;
  let changedRows = 0;
  let onlyInBackup = 0;
  const seenKeys = new Set<string>();

  for (const backupRow of backupRows) {
    const key = buildRowKey(backupRow, primaryKeys);
    seenKeys.add(key);
    const sourceRow = sourceByKey.get(key);

    if (!sourceRow) {
      rowStatus.set(key, 'onlyBackup');
      onlyInBackup++;
    } else if (rowsAreEqual(backupRow, sourceRow)) {
      rowStatus.set(key, 'unchanged');
      matchedRows++;
    } else {
      rowStatus.set(key, 'changed');
      changedRows++;
    }
  }

  let onlyInSource = 0;
  for (const sourceRow of sourceRows) {
    const key = buildRowKey(sourceRow, primaryKeys);
    if (!seenKeys.has(key)) {
      rowStatus.set(key, 'onlySource');
      onlyInSource++;
    }
  }

  return {
    matchedRows,
    changedRows,
    onlyInBackup,
    onlyInSource,
    diffCount: changedRows + onlyInBackup + onlyInSource,
    rowStatus,
  };
}
function displayValue(value: unknown) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('backup');
  const [previewTab, setPreviewTab] = useState<PreviewTab>('source');
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState('');
  const [search, setSearch] = useState('');
  const [tablePayload, setTablePayload] = useState<TablePayload | null>(null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [runningAction, setRunningAction] = useState(false);
  const [transferMode, setTransferMode] = useState<TransferMode>('upsert');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const loadDetail = useCallback(async (table: string, tab: WorkspaceTab) => {
    if (!table) return;
    setLoadingDetail(true);
    setDetail(null);
    setNotice(null);
    try {
      const route = tab === 'backup' ? 'db-backup' : 'db-restore';
      const params = new URLSearchParams({ action: 'data', table });
      const result = await readJson(await fetch(`/api/admin/${route}?${params}`));
      setDetail(result as DetailPayload);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load table details.' });
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const loadTables = useCallback(async (tab: WorkspaceTab, currentSelection = '') => {
    setLoadingTables(true);
    setNotice(null);
    try {
      const route = tab === 'backup' ? 'db-backup' : 'db-restore';
      const result = await readJson(await fetch(`/api/admin/${route}?action=tables`)) as TablePayload;
      const nextTables = result.tables ?? [];
      setTables(nextTables);
      setTablePayload(result);
      const nextSelection = nextTables.some((item) => item.tableName === currentSelection)
        ? currentSelection
        : nextTables[0]?.tableName ?? '';
      setSelectedTable(nextSelection);
      setPreviewTab(tab === 'backup' ? 'source' : 'backup');
      if (nextSelection) await loadDetail(nextSelection, tab);
      else setDetail(null);
    } catch (error) {
      setTables([]);
      setTablePayload(null);
      setDetail(null);
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load database tables.' });
    } finally {
      setLoadingTables(false);
    }
  }, [loadDetail]);

  useEffect(() => {
    if (status === 'authenticated') void loadTables(activeTab);
  }, [status, activeTab, loadTables]);

  const filteredTables = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? tables.filter((table) => table.tableName.toLowerCase().includes(query)) : tables;
  }, [search, tables]);

  const selectedInfo = tables.find((table) => table.tableName === selectedTable);
  const counterpartExists = activeTab === 'backup'
    ? selectedInfo?.existsInBackup !== false
    : selectedInfo?.existsInSource !== false;
  const activeColumns = previewTab === 'source' ? detail?.columns ?? [] : detail?.backupColumns ?? [];
  const activeRows = previewTab === 'source' ? detail?.data ?? [] : detail?.backupData ?? [];
  const rowDiff = useMemo(() => {
    if (!detail) return null;
    return diffTableRows(detail.backupData, detail.data, detail.primaryKeys);
  }, [detail]);
  const canRun = Boolean(
    selectedTable && detail && counterpartExists
    && (activeTab === 'backup' || detail.primaryKeys.length > 0)
  );

  const selectTable = (table: string) => {
    setSelectedTable(table);
    setPreviewTab(activeTab === 'backup' ? 'source' : 'backup');
    void loadDetail(table, activeTab);
  };

  const changeWorkspace = (tab: WorkspaceTab) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setSearch('');
    setSelectedTable('');
    setDetail(null);
    setNotice(null);
  };

  const runTransfer = async () => {
    if (!selectedTable) return;
    setConfirmOpen(false);
    setRunningAction(true);
    setNotice(null);
    try {
      const route = activeTab === 'backup' ? 'db-backup' : 'db-restore';
      const body = activeTab === 'backup'
        ? { table: selectedTable, mode: transferMode, accountId: null }
        : { table: selectedTable, accountId: null };
      const result = await readJson(await fetch(`/api/admin/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      const count = activeTab === 'backup' ? result.transferred : result.restoredRows;
      await loadDetail(selectedTable, activeTab);
      setNotice({
        kind: 'success',
        text: `${activeTab === 'backup' ? 'Backed up' : 'Restored'} ${count ?? 0} row(s) for ${selectedTable}.`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'The operation failed.' });
    } finally {
      setRunningAction(false);
    }
  };

  if (status === 'loading') return <FullPageStatus label="Loading admin session..." />;

  if (status !== 'authenticated') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-100 p-6">
        <section className="w-full max-w-md border border-gray-200 bg-white p-8 text-center shadow-sm">
          <Database className="mx-auto h-9 w-9 text-blue-700" />
          <h1 className="mt-4 text-xl font-semibold text-gray-950">Authentication required</h1>
          <p className="mt-2 text-sm text-gray-600">Sign in to manage database backups and restores.</p>
          <Link href="/login" className="mt-6 inline-flex bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">Go to login</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 text-gray-900">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-blue-700 text-white"><Database className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">Database Administration</h1>
              <p className="truncate text-xs text-gray-500">{session.user?.email ?? 'System administrator'}</p>
            </div>
          </div>
          <button type="button" title="Sign out" onClick={() => signOut({ callbackUrl: '/login' })} className="flex h-9 w-9 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-950">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-[1500px] px-4 sm:px-6" role="tablist" aria-label="Database operations">
          <WorkspaceTabButton active={activeTab === 'backup'} icon={DatabaseBackup} label="Backup tables" onClick={() => changeWorkspace('backup')} />
          <WorkspaceTabButton active={activeTab === 'restore'} icon={ArchiveRestore} label="Restore tables" onClick={() => changeWorkspace('restore')} />
        </div>
      </div>

      <div className="mx-auto flex max-w-[1500px] gap-6 px-4 py-4 sm:px-6 md:items-start">
        <aside className="w-full shrink-0 rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:w-1/4 md:sticky md:top-4">
          <div className="mb-4">
            <div className="flex items-center justify-between gap-3">
              <div><h2 className="text-lg font-semibold">Select table</h2><p className="mt-0.5 text-xs text-gray-500">{tables.length} available</p></div>
              <button type="button" title="Refresh table list" disabled={loadingTables} onClick={() => void loadTables(activeTab, selectedTable)} className="flex h-8 w-8 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${loadingTables ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <label className="relative mt-3 block">
              <span className="sr-only">Search tables</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a table..." className="h-9 w-full border border-gray-300 bg-white pl-9 pr-8 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600" />
              {search ? <button type="button" title="Clear search" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"><X className="h-4 w-4" /></button> : null}
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
                <button type="button" key={table.tableName} onClick={() => selectTable(table.tableName)} className={`flex w-full items-center gap-2 rounded-lg border p-2 text-left text-sm ${active ? 'border-blue-300 bg-blue-100 text-blue-900' : 'border-gray-200 hover:bg-yellow-50'}`}>
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
              <p className="mt-2 text-sm text-gray-600">{activeTab === 'backup' ? 'Copy this table from the operational database into the backup database.' : 'Recover this table from backup into the operational database.'}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {activeTab === 'backup' ? (
                <div className="flex border border-gray-300 p-0.5" aria-label="Backup mode">
                  {(['upsert', 'replace'] as TransferMode[]).map((mode) => (
                    <button type="button" key={mode} onClick={() => setTransferMode(mode)} className={`px-3 py-1.5 text-xs font-medium capitalize ${transferMode === mode ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>{mode}</button>
                  ))}
                </div>
              ) : null}
              <button type="button" disabled={!canRun || loadingDetail || runningAction} onClick={() => setConfirmOpen(true)} className={`inline-flex h-9 items-center gap-2 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-400 ${activeTab === 'backup' ? 'bg-blue-700 hover:bg-blue-800' : 'bg-emerald-700 hover:bg-emerald-800'}`}>
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
              <button type="button" title="Dismiss" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button>
            </div>
          ) : null}

          {loadingDetail ? (
            <div className="flex min-h-[420px] items-center justify-center gap-3 text-sm text-gray-500"><RefreshCw className="h-5 w-5 animate-spin" /> Loading table details...</div>
          ) : detail ? (
            <>
              <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">Columns of {selectedTable}</h2>
                  <span className="text-xs text-gray-500">{activeColumns.length} columns</span>
                </div>
                {activeColumns.length === 0 ? (
                  <p className="text-sm text-gray-500">No columns found.</p>
                ) : (
                  <ul className="grid max-h-[150px] gap-2 overflow-y-auto sm:grid-cols-2">
                    {activeColumns.map((column) => (
                      <li key={column.name} className="rounded-lg border border-gray-200 p-2 text-sm">
                        <span className="font-medium">{column.name}</span>: <span className="text-gray-600">{column.type}</span>
                      </li>
                    ))}
                  </ul>
                )}
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
                    <button type="button" title="Reload preview" onClick={() => void loadDetail(selectedTable, activeTab)} className="flex h-8 w-8 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50"><RefreshCw className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="mb-3 flex border-b border-gray-200" role="tablist" aria-label="Data preview">
                <PreviewTabButton active={previewTab === 'source'} label="Operational" count={detail.sourceRowCount} disabled={detail.existsInSource === false} onClick={() => setPreviewTab('source')} />
                <PreviewTabButton active={previewTab === 'backup'} label="Backup" count={detail.backupRowCount} disabled={detail.existsInBackup === false} onClick={() => setPreviewTab('backup')} />
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

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="presentation" onMouseDown={() => setConfirmOpen(false)}>
          <div className="w-full max-w-md border border-gray-200 bg-white p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center ${activeTab === 'restore' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                {activeTab === 'restore' ? <AlertTriangle className="h-5 w-5" /> : <DatabaseBackup className="h-5 w-5" />}
              </div>
              <div>
                <h2 id="confirm-title" className="font-semibold">Confirm {activeTab}</h2>
                <p className="mt-2 text-sm leading-6 text-gray-600">
                  {activeTab === 'backup'
                    ? `Copy all rows from ${selectedTable} to the backup database using ${transferMode} mode?`
                    : `Restore all available rows for ${selectedTable} into the operational database? Existing rows with matching keys may be updated.`}
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={() => void runTransfer()} className={`px-4 py-2 text-sm font-medium text-white ${activeTab === 'backup' ? 'bg-blue-700 hover:bg-blue-800' : 'bg-emerald-700 hover:bg-emerald-800'}`}>Confirm {activeTab}</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function WorkspaceTabButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof DatabaseBackup; label: string; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`flex h-12 items-center gap-2 border-b-2 px-4 text-sm font-medium ${active ? 'border-blue-700 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-950'}`}><Icon className="h-4 w-4" />{label}</button>;
}

function PreviewTabButton({ active, label, count, disabled, onClick }: { active: boolean; label: string; count: string | null; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} disabled={disabled} onClick={onClick} className={`border-b-2 px-4 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-gray-300 ${active ? 'border-blue-700 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-950'}`}>{label}<span className="ml-2 bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">{count ?? '0'}</span></button>;
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

function DataPreview({ columns, rows }: { columns: ColumnInfo[]; rows: Record<string, unknown>[] }) {
  if (columns.length === 0) return <div className="border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">No table data is available on this side.</div>;
  if (rows.length === 0) return <div className="border border-gray-200 p-8 text-center text-sm text-gray-500">This table has no rows.</div>;
  return (
    <div className="max-h-[480px] overflow-auto border border-gray-200">
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

function FullPageStatus({ label }: { label: string }) {
  return <main className="flex min-h-screen items-center justify-center bg-gray-100 text-sm text-gray-600"><RefreshCw className="mr-3 h-5 w-5 animate-spin text-blue-700" />{label}</main>;
}
