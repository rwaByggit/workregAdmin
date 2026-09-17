'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, HardDrive, RefreshCw, X } from 'lucide-react';
import { FileText, Image as ImageIcon, Music, Video, File as FileIcon, Eye } from "lucide-react";

interface Notice {
  kind: 'success' | 'error';
  text: string;
}

type StorageSide = 'source' | 'backup';
type FileKind = "image" | "pdf" | "text" | "audio" | "video" | "other";

interface StoragePayload {
  sourceStorage: string;
  backupStorage: string;
  defaultBuckets: string[];
  sourceBuckets: string[];
  backupBuckets: string[];
  sourceConfigured: boolean;
  backupConfigured: boolean;
  configErrors: {
    source: string | null;
    backup: string | null;
  };
}

interface StorageObjectInfo {
  name: string;
  size: number | null;
  mimeType: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  lastAccessedAt: string | null;
}

interface StorageObjectsPayload {
  role: StorageSide;
  bucket: string;
  storage: string;
  objects: StorageObjectInfo[];
  objectCount: number;
  totalBytes: number;
}

interface BucketObjectCount {
  exists: boolean;
  objectCount: number | null;
  totalBytes: number | null;
  error: string | null;
}

interface StorageCountsPayload {
  bucket: string;
  source: BucketObjectCount;
  backup: BucketObjectCount;
}

async function readJson(response: Response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : 'The request failed.');
  }
  return result;
}

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return 'Unknown';
  if (value === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatObjectDate(value: string | null) {
  if (!value) return '';

  const objectDate = new Date(value);
  if (Number.isNaN(objectDate.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(objectDate);
}

export function StorageBackupPanel() {
  const [payload, setPayload] = useState<StoragePayload | null>(null);
  const [selectedBucket, setSelectedBucket] = useState('');
  const [side, setSide] = useState<StorageSide>('source');
  const [objectsPayload, setObjectsPayload] = useState<StorageObjectsPayload | null>(null);
  const [counts, setCounts] = useState<StorageCountsPayload | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [runningStorageAction, setRunningStorageAction] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const buckets = useMemo(() => {
    if (!payload) return [];

    const bucketSet = new Set([
      ...payload.defaultBuckets,
      ...payload.sourceBuckets,
      ...payload.backupBuckets,
    ]);

    return Array.from(bucketSet).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right));
  }, [payload]);

  const loadObjects = useCallback(async (bucket: string, role: StorageSide) => {
    if (!bucket) return;

    setLoadingObjects(true);
    setObjectsPayload(null);
    setNotice(null);
    try {
      const params = new URLSearchParams({ action: 'objects', bucket, role });
      const result = await readJson(await fetch(`/api/admin/storage-backup?${params}`));
      setObjectsPayload(result as StorageObjectsPayload);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load storage objects.' });
    } finally {
      setLoadingObjects(false);
    }
  }, []);

  const loadCounts = useCallback(async (bucket: string) => {
    if (!bucket) return;

    try {
      const params = new URLSearchParams({ action: 'counts', bucket });
      const result = await readJson(await fetch(`/api/admin/storage-backup?${params}`));
      setCounts(result as StorageCountsPayload);
    } catch (error) {
      setCounts(null);
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load storage counts.' });
    }
  }, []);

  const loadStorage = useCallback(async (currentSelection = '') => {
    setLoadingStorage(true);
    setNotice(null);
    try {
      const result = await readJson(await fetch('/api/admin/storage-backup')) as StoragePayload;
      const bucketSet = new Set([
        ...result.defaultBuckets,
        ...result.sourceBuckets,
        ...result.backupBuckets,
      ]);
      const nextBuckets = Array.from(bucketSet).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right));
      const nextSelection = nextBuckets.includes(currentSelection) ? currentSelection : nextBuckets[0] ?? '';

      setPayload(result);
      setSelectedBucket(nextSelection);
      if (nextSelection) {
        await Promise.all([
          loadCounts(nextSelection),
          loadObjects(nextSelection, side),
        ]);
      } else {
        setCounts(null);
        setObjectsPayload(null);
      }
    } catch (error) {
      setPayload(null);
      setCounts(null);
      setObjectsPayload(null);
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load storage buckets.' });
    } finally {
      setLoadingStorage(false);
    }
  }, [loadCounts, loadObjects, side]);

  useEffect(() => {
    void loadStorage();
  }, [loadStorage]);

  const chooseBucket = (bucket: string) => {
    setSelectedBucket(bucket);
    void Promise.all([
      loadCounts(bucket),
      loadObjects(bucket, side),
    ]);
  };

  const chooseSide = (nextSide: StorageSide) => {
    setSide(nextSide);
    if (selectedBucket) void loadObjects(selectedBucket, nextSide);
  };

  const runStorageCopy = async (action: 'backup' | 'restore', targetBuckets: string[]) => {
    if (targetBuckets.length === 0) return;

    setRunningStorageAction(true);
    setNotice(null);
    try {
      const result = await readJson(await fetch('/api/admin/storage-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, buckets: targetBuckets }),
      }));
      await Promise.all([
        loadStorage(selectedBucket),
        selectedBucket ? loadCounts(selectedBucket) : Promise.resolve(),
        selectedBucket ? loadObjects(selectedBucket, side) : Promise.resolve(),
      ]);
      setNotice({
        kind: 'success',
        text: `${action === 'backup' ? 'Backed up' : 'Restored'} ${result.copied ?? 0} object(s) across ${targetBuckets.length} bucket(s).${result.failed ? ` ${result.failed} failed.` : ''}`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'The storage operation failed.' });
    } finally {
      setRunningStorageAction(false);
    }
  };

  const sourceCount = counts?.source;
  const backupCount = counts?.backup;
  const defaultBuckets = payload?.defaultBuckets ?? [];
  const objectSideLabel = side === 'source' ? 'Source' : 'Backup';

  return (
    <div className="mx-auto grid max-w-[1500px] gap-6 px-4 py-4 sm:px-6 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm lg:sticky lg:top-4 lg:self-start">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Storage containers</h2>
            <p className="mt-1 text-xs text-gray-500">{buckets.length} bucket(s) available</p>
          </div>
          <button type="button" title="Refresh storage buckets" disabled={loadingStorage} onClick={() => void loadStorage(selectedBucket)} className="flex h-8 w-8 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loadingStorage ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="grid gap-3 text-sm">
          <StorageLabel label="Source" value={payload?.sourceStorage ?? 'Loading...'} />
          <StorageLabel label="Backup" value={payload?.backupStorage ?? 'Loading...'} />
        </div>

        {payload?.configErrors.source || payload?.configErrors.backup ? (
          <div className="mt-4 space-y-2 border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {payload.configErrors.source ? <p>Source: {payload.configErrors.source}</p> : null}
            {payload.configErrors.backup ? <p>Backup: {payload.configErrors.backup}</p> : null}
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <SideButton active={side === 'source'} label="Source" onClick={() => chooseSide('source')} />
          <SideButton active={side === 'backup'} label="Backup" onClick={() => chooseSide('backup')} />
        </div>

        <label className="mt-4 block text-sm">
          <span className="font-medium text-gray-700">Container</span>
          <select value={selectedBucket} onChange={(event) => chooseBucket(event.target.value)} className="mt-2 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600">
            {buckets.length === 0 ? <option value="">No buckets found</option> : null}
            {buckets.map((bucket) => <option key={bucket} value={bucket}>{bucket}</option>)}
          </select>
        </label>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-2">
          <StorageMetric label="Source objects" count={sourceCount?.objectCount} bytes={sourceCount?.totalBytes} error={sourceCount?.error} />
          <StorageMetric label="Backup objects" count={backupCount?.objectCount} bytes={backupCount?.totalBytes} error={backupCount?.error} />
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <button type="button" disabled={!selectedBucket || runningStorageAction || !payload?.sourceConfigured || !payload?.backupConfigured} onClick={() => void runStorageCopy('backup', [selectedBucket])} className="min-h-20 rounded-md bg-emerald-700 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-gray-400">
            {runningStorageAction ? 'Working...' : 'Backup selected container'}
          </button>
          <button type="button" disabled={!selectedBucket || runningStorageAction || !payload?.sourceConfigured || !payload?.backupConfigured} onClick={() => void runStorageCopy('restore', [selectedBucket])} className="min-h-20 rounded-md bg-amber-600 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-gray-400">
            {runningStorageAction ? 'Working...' : 'Restore selected container'}
          </button>
        </div>

        <button type="button" disabled={defaultBuckets.length === 0 || runningStorageAction || !payload?.sourceConfigured || !payload?.backupConfigured} onClick={() => void runStorageCopy('backup', defaultBuckets)} className="mt-4 flex min-h-10 w-full items-center justify-center rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-gray-400">
          Backup default containers
        </button>
      </aside>

      <section className="min-w-0 space-y-4">
        {notice ? (
          <div className={`flex items-start gap-3 border p-3 text-sm ${notice.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
            {notice.kind === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="flex-1">{notice.text}</span>
            <button type="button" title="Dismiss" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button>
          </div>
        ) : null}

        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase text-blue-700">{objectSideLabel} content</p>
              <h2 className="mt-1 text-lg font-semibold">{selectedBucket || 'Select a container'}</h2>
              <p className="mt-1 text-sm text-gray-500">
                {objectsPayload ? `${objectsPayload.objectCount} object(s), ${formatBytes(objectsPayload.totalBytes)} in ${objectsPayload.storage}` : 'Object list will appear here.'}
              </p>
            </div>
            <button type="button" title="Reload objects" disabled={!selectedBucket || loadingObjects} onClick={() => void loadObjects(selectedBucket, side)} className="flex h-8 w-8 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loadingObjects ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {loadingObjects ? (
            <div className="flex min-h-[420px] items-center justify-center gap-3 text-sm text-gray-500"><RefreshCw className="h-5 w-5 animate-spin" /> Loading storage objects...</div>
          ) : objectsPayload ? (
            <StorageObjectTable objects={objectsPayload.objects} bucket={objectsPayload.bucket} role={objectsPayload.role} />
          ) : (
            <div className="flex min-h-[420px] flex-col items-center justify-center p-8 text-center text-gray-500"><HardDrive className="h-8 w-8" /><p className="mt-3 text-sm">Choose a storage container to view its content.</p></div>
          )}
        </div>
      </section>
    </div>
  );
}

function StorageLabel({ label, value }: { label: string; value: string }) {
  return <div><p className="font-medium text-gray-700">{label}:</p><p className="truncate font-mono text-xs text-gray-600" title={value}>{value}</p></div>;
}

function SideButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`h-10 rounded-md border px-3 text-sm font-medium ${active ? 'border-blue-700 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>{label}</button>;
}

function StorageMetric({ label, count, bytes, error }: { label: string; count?: number | null; bytes?: number | null; error?: string | null }) {
  return (
    <div className="min-w-0 rounded-md border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${error ? 'text-amber-700' : 'text-gray-900'}`}>{error ? 'Missing' : `${count ?? 0}`}</p>
      <p className="mt-1 truncate text-xs text-gray-500" title={error ?? formatBytes(bytes)}>{error ?? formatBytes(bytes)}</p>
    </div>
  );
}
function getFileKind(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["txt", "md", "csv", "log"].includes(ext)) return "text";
  if (["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "avi"].includes(ext)) return "video";
  return "other";
}

const FILE_ICONS: Record<FileKind, React.ComponentType<{ className?: string }>> = {
  image: ImageIcon,
  pdf: FileText,
  text: FileText,
  audio: Music,
  video: Video,
  other: FileIcon,
};

function PreviewCell({ path, bucket, role }: { path: string; bucket: string; role: StorageSide }) {
  const [loading, setLoading] = useState(false);
  const kind = getFileKind(path);
  const Icon = FILE_ICONS[kind];

  const openPreview = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ action: 'preview', bucket, role, path });
      const response = await fetch(`/api/admin/storage-backup?${params}`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.url !== 'string') {
        throw new Error(typeof result.error === 'string' ? result.error : 'Could not create a preview URL.');
      }

      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not open the preview.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <td className="whitespace-nowrap px-3 py-2 text-gray-700">
      <button
        type="button"
        onClick={() => void openPreview()}
        disabled={loading}
        title="Open preview"
        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 disabled:opacity-50"
      >
        <Icon className="h-4 w-4" />
        {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
      </button>
    </td>
  );
}

function StorageObjectTable({ objects, bucket, role }: { objects: StorageObjectInfo[]; bucket: string; role: StorageSide }) {
  if (objects.length === 0) return <div className="border border-gray-200 p-8 text-center text-sm text-gray-500">This storage container has no objects.</div>;

  return (
    <div className="max-h-[640px] overflow-auto border border-gray-200">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
          <tr>
            <th className="whitespace-nowrap border-b border-r border-gray-200 px-3 py-2.5 font-semibold">Path</th>
            <th className="whitespace-nowrap border-b border-r border-gray-200 px-3 py-2.5 font-semibold">Size</th>
            <th className="whitespace-nowrap border-b border-r border-gray-200 px-3 py-2.5 font-semibold">Type</th>
            <th className="whitespace-nowrap border-b border-gray-200 px-3 py-2.5 font-semibold">Updated</th>
            <th className="whitespace-nowrap border-b border-gray-200 px-3 py-2.5 font-semibold">Preview</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {objects.map((object) => (
            <tr key={object.name} className="hover:bg-blue-50/50">
              <td className="max-w-[520px] truncate border-r border-gray-100 px-3 py-2 font-mono text-gray-900" title={object.name}>{object.name}</td>
              <td className="whitespace-nowrap border-r border-gray-100 px-3 py-2 text-gray-700">{formatBytes(object.size)}</td>
              <td className="max-w-48 truncate border-r border-gray-100 px-3 py-2 text-gray-700" title={object.mimeType ?? ''}>{object.mimeType ?? ''}</td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-700">{formatObjectDate(object.updatedAt ?? object.createdAt)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                <PreviewCell path={object.name} bucket={bucket} role={role} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
