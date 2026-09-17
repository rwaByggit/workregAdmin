'use client';

import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Database, DatabaseBackup, LogOut, RefreshCw } from 'lucide-react';
import {
  RestoreContainer,
  type ColumnComparison,
  type ColumnInfo,
  type DetailPayload,
  type Notice,
  type PreviewTab,
  type RowDiffResult,
  type TableInfo,
  type TablePayload,
  type TransferMode,
} from '@/components/ui/restoreContainer';
import { StorageBackupPanel } from '@/components/ui/storageBackupPanel';
import { WorkspaceTabs, type TableWorkspaceTab, type WorkspaceTab } from '@/components/ui/workspaceTabs';

type Row = Record<string, unknown>;

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

function compareColumns(sourceColumns: ColumnInfo[], backupColumns: ColumnInfo[]): ColumnComparison[] {
  const sourceByName = new Map(sourceColumns.map((column) => [column.name, column.type]));
  const backupByName = new Map(backupColumns.map((column) => [column.name, column.type]));
  const names = Array.from(new Set([...sourceByName.keys(), ...backupByName.keys()]))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right));

  return names.map((name) => {
    const sourceType = sourceByName.get(name) ?? null;
    const backupType = backupByName.get(name) ?? null;
    const status = sourceType === null
      ? 'onlyBackup'
      : backupType === null
        ? 'onlySource'
        : sourceType === backupType
          ? 'match'
          : 'typeMismatch';

    return { name, sourceType, backupType, status };
  });
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
  const [columnsExpanded, setColumnsExpanded] = useState(false);

  const loadDetail = useCallback(async (table: string, tab: TableWorkspaceTab) => {
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

  const loadTables = useCallback(async (tab: TableWorkspaceTab, currentSelection = '') => {
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
    if (status === 'authenticated' && activeTab !== 'storage') void loadTables(activeTab);
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
  const columnComparison = useMemo(
    () => detail ? compareColumns(detail.columns, detail.backupColumns) : [],
    [detail]
  );
  const columnDifferenceCount = columnComparison.filter((column) => column.status !== 'match').length;
  const shouldShowColumnTable = columnsExpanded;
  const rowDiff = useMemo(() => {
    if (!detail) return null;
    return diffTableRows(detail.backupData, detail.data, detail.primaryKeys);
  }, [detail]);
  const canRun = Boolean(
    activeTab !== 'storage' && selectedTable && detail && counterpartExists
    && (activeTab === 'backup' || detail.primaryKeys.length > 0)
  );

  useEffect(() => {
    setColumnsExpanded(columnDifferenceCount > 0);
  }, [selectedTable, activeTab, columnDifferenceCount]);

  const selectTable = (table: string) => {
    if (activeTab === 'storage') return;
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
    setConfirmOpen(false);
  };

  const runTransfer = async () => {
    if (activeTab === 'storage' || !selectedTable) return;
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
      if (activeTab === 'backup' && result.backupLog?.createdAt) {
        setTables((currentTables) => currentTables.map((table) => table.tableName === selectedTable
          ? { ...table, lastBackupAt: result.backupLog.createdAt }
          : table
        ));
        setTablePayload((currentPayload) => currentPayload
          ? {
              ...currentPayload,
              tables: currentPayload.tables.map((table) => table.tableName === selectedTable
                ? { ...table, lastBackupAt: result.backupLog.createdAt }
                : table
              ),
            }
          : currentPayload
        );
      }
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

      <WorkspaceTabs activeTab={activeTab} onChange={changeWorkspace} />

      {activeTab === 'storage' ? (
        <StorageBackupPanel />
      ) : (
        <RestoreContainer
          activeTab={activeTab}
          tables={tables}
          filteredTables={filteredTables}
          selectedTable={selectedTable}
          search={search}
          tablePayload={tablePayload}
          detail={detail}
          loadingTables={loadingTables}
          loadingDetail={loadingDetail}
          runningAction={runningAction}
          transferMode={transferMode}
          notice={notice}
          previewTab={previewTab}
          selectedInfo={selectedInfo}
          counterpartExists={counterpartExists}
          activeColumns={activeColumns}
          activeRows={activeRows}
          columnComparison={columnComparison}
          columnDifferenceCount={columnDifferenceCount}
          shouldShowColumnTable={shouldShowColumnTable}
          rowDiff={rowDiff}
          canRun={canRun}
          onRefreshTables={() => void loadTables(activeTab, selectedTable)}
          onSearchChange={setSearch}
          onSelectTable={selectTable}
          onTransferModeChange={setTransferMode}
          onOpenConfirm={() => setConfirmOpen(true)}
          onDismissNotice={() => setNotice(null)}
          onToggleColumns={() => setColumnsExpanded((expanded) => !expanded)}
          onPreviewTabChange={setPreviewTab}
          onReloadDetail={() => void loadDetail(selectedTable, activeTab)}
        />
      )}

      {confirmOpen && activeTab !== 'storage' ? (
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

function FullPageStatus({ label }: { label: string }) {
  return <main className="flex min-h-screen items-center justify-center bg-gray-100 text-sm text-gray-600"><RefreshCw className="mr-3 h-5 w-5 animate-spin text-blue-700" />{label}</main>;
}
