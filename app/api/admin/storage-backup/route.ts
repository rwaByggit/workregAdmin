import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { requireSystemAdmin as requireAdmin } from '@/app/lib/system-admin';

export const runtime = 'nodejs';

const DEFAULT_BUCKETS = ['avatars', 'WorkOrderContracts', 'Gallery'];
const PAGE_SIZE = 100;

type StorageRole = 'source' | 'backup';

interface StorageConfig {
  url: string;
  serviceRoleKey: string;
  label: string;
}

interface StorageConfigState {
  config: StorageConfig | null;
  error: string | null;
}

interface StorageObject {
  name: string;
  id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_accessed_at?: string | null;
  metadata?: {
    size?: number;
    mimetype?: string;
    [key: string]: unknown;
  } | null;
}

interface BucketCopyResult {
  bucket: string;
  copied: number;
  skipped: number;
  failed: Array<{ path: string; error: string }>;
}

interface BucketObjectCount {
  exists: boolean;
  objectCount: number | null;
  totalBytes: number | null;
  error: string | null;
}

type StorageCopyDirection = 'backup' | 'restore';

function formatStorageObject(object: StorageObject) {
  return {
    name: object.name,
    size: object.metadata?.size ?? null,
    mimeType: object.metadata?.mimetype ?? null,
    updatedAt: typeof object.updated_at === 'string' ? object.updated_at : null,
    createdAt: typeof object.created_at === 'string' ? object.created_at : null,
    lastAccessedAt: typeof object.last_accessed_at === 'string' ? object.last_accessed_at : null,
  };
}

function readEnvFile(role: 'source' | 'backup') {
  const envPath = role === 'source'
    ? path.join(process.cwd(), '.env')
    : path.join(process.cwd(), '.env.backup');
  return fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
}

function cleanEnvironmentValue(value: string | undefined) {
  return value?.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function firstConfiguredValue(values: Array<string | undefined>) {
  for (const value of values) {
    const cleaned = cleanEnvironmentValue(value);
    if (cleaned) return cleaned;
  }

  return undefined;
}

function supabaseUrlFromDatabaseUrl(value: string | undefined) {
  const cleaned = cleanEnvironmentValue(value);
  if (!cleaned) return undefined;

  try {
    const databaseUrl = new URL(cleaned);
    const usernameMatch = databaseUrl.username.match(/^(?:postgres|supabase_admin)\.([a-z0-9-]+)$/i);
    const directHostMatch = databaseUrl.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
    const projectRef = usernameMatch?.[1] ?? directHostMatch?.[1];

    return projectRef ? `https://${projectRef}.supabase.co` : undefined;
  } catch {
    return undefined;
  }
}

function readStorageConfig(role: StorageRole): StorageConfig {
  const env = readEnvFile('source');
  const backupEnv = readEnvFile('backup');
  const url = role === 'source'
    ? firstConfiguredValue([
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_URL,
        process.env.SOURCE_SUPABASE_URL,
        process.env.PROD_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.SUPABASE_URL,
        env.SOURCE_SUPABASE_URL,
        env.PROD_SUPABASE_URL,
        supabaseUrlFromDatabaseUrl(process.env.DATABASE_URL),
        supabaseUrlFromDatabaseUrl(env.DATABASE_URL),
      ])
    : firstConfiguredValue([
        process.env.BACKUP_SUPABASE_URL,
        process.env.BACKUP_NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_BACKUP_SUPABASE_URL,
        env.BACKUP_SUPABASE_URL,
        env.BACKUP_NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_BACKUP_SUPABASE_URL,
        backupEnv.NEXT_PUBLIC_SUPABASE_URL,
        backupEnv.SUPABASE_URL,
        supabaseUrlFromDatabaseUrl(process.env.BACKUP_DATABASE_URL),
        supabaseUrlFromDatabaseUrl(process.env.DATABASE_URL_BACKUP),
        supabaseUrlFromDatabaseUrl(env.BACKUP_DATABASE_URL),
        supabaseUrlFromDatabaseUrl(env.DATABASE_URL_BACKUP),
        supabaseUrlFromDatabaseUrl(backupEnv.DATABASE_URL),
      ]);
  const serviceRoleKey = role === 'source'
    ? firstConfiguredValue([
        process.env.SUPABASE_SECRET_KEY,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        process.env.SOURCE_SUPABASE_SECRET_KEY,
        process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY,
        process.env.PROD_SUPABASE_SECRET_KEY,
        process.env.PROD_SUPABASE_SERVICE_ROLE_KEY,
        env.SUPABASE_SECRET_KEY,
        env.SUPABASE_SERVICE_ROLE_KEY,
        env.SOURCE_SUPABASE_SECRET_KEY,
        env.SOURCE_SUPABASE_SERVICE_ROLE_KEY,
        env.PROD_SUPABASE_SECRET_KEY,
        env.PROD_SUPABASE_SERVICE_ROLE_KEY,
      ])
    : firstConfiguredValue([
        process.env.BACKUP_SUPABASE_SECRET_KEY,
        process.env.BACKUP_SUPABASE_SERVICE_ROLE_KEY,
        process.env.SUPABASE_BACKUP_SECRET_KEY,
        process.env.SUPABASE_BACKUP_SERVICE_ROLE_KEY,
        env.BACKUP_SUPABASE_SECRET_KEY,
        env.BACKUP_SUPABASE_SERVICE_ROLE_KEY,
        env.SUPABASE_BACKUP_SECRET_KEY,
        env.SUPABASE_BACKUP_SERVICE_ROLE_KEY,
        backupEnv.SUPABASE_SECRET_KEY,
        backupEnv.SUPABASE_SERVICE_ROLE_KEY,
      ]);

  if (!url) {
    throw new Error(role === 'source'
      ? 'Source Supabase URL is not configured. Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL, SOURCE_SUPABASE_URL, or PROD_SUPABASE_URL.'
      : 'Backup Supabase URL is not configured. Set BACKUP_SUPABASE_URL, BACKUP_NEXT_PUBLIC_SUPABASE_URL, or NEXT_PUBLIC_BACKUP_SUPABASE_URL.'
    );
  }

  if (!serviceRoleKey) {
    throw new Error(role === 'source'
      ? 'Source Supabase secret key is not configured. Set SUPABASE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY, SOURCE_SUPABASE_SECRET_KEY, or PROD_SUPABASE_SECRET_KEY.'
      : 'Backup Supabase secret key is not configured. Set BACKUP_SUPABASE_SECRET_KEY, BACKUP_SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BACKUP_SECRET_KEY, or SUPABASE_BACKUP_SERVICE_ROLE_KEY.'
    );
  }

  return {
    url,
    serviceRoleKey,
    label: new URL(url).host,
  };
}

function getStorageConfigState(role: StorageRole): StorageConfigState {
  try {
    return {
      config: readStorageConfig(role),
      error: null,
    };
  } catch (error) {
    return {
      config: null,
      error: error instanceof Error ? error.message : `Could not read ${role} storage configuration.`,
    };
  }
}

function createAdminClient(config: StorageConfig) {
  return createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function normalizeBucketList(value: unknown) {
  if (!Array.isArray(value)) return DEFAULT_BUCKETS;
  const buckets = value
    .filter((bucket): bucket is string => typeof bucket === 'string')
    .map((bucket) => bucket.trim())
    .filter(Boolean);

  return buckets.length > 0 ? [...new Set(buckets)] : DEFAULT_BUCKETS;
}

function isFolder(object: StorageObject) {
  return !object.id && object.metadata?.size === undefined;
}

async function ensureDestinationBucket(
  from: SupabaseClient,
  to: SupabaseClient,
  bucket: string,
  fromLabel: string,
  toLabel: string,
) {
  const [{ data: fromBucket, error: fromError }, { data: toBucket, error: toError }] = await Promise.all([
    from.storage.getBucket(bucket),
    to.storage.getBucket(bucket),
  ]);

  if (fromError || !fromBucket) {
    throw new Error(`${fromLabel} bucket "${bucket}" was not found.`);
  }

  if (!toError && toBucket) {
    return;
  }

  const { error: createError } = await to.storage.createBucket(bucket, {
    public: fromBucket.public,
    fileSizeLimit: fromBucket.file_size_limit ?? undefined,
    allowedMimeTypes: fromBucket.allowed_mime_types ?? undefined,
  });

  if (createError) {
    throw new Error(`Could not create ${toLabel} bucket "${bucket}": ${createError.message}`);
  }
}

async function listBucketObjects(client: SupabaseClient, bucket: string, prefix = ''): Promise<StorageObject[]> {
  const objects: StorageObject[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.storage
      .from(bucket)
      .list(prefix, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });

    if (error) {
      throw new Error(`Could not list "${bucket}/${prefix}": ${error.message}`);
    }

    const page = (data ?? []) as StorageObject[];
    for (const object of page) {
      const objectPath = prefix ? `${prefix}/${object.name}` : object.name;
      if (isFolder(object)) {
        objects.push(...await listBucketObjects(client, bucket, objectPath));
      } else {
        objects.push({ ...object, name: objectPath });
      }
    }

    if (page.length < PAGE_SIZE) break;
  }

  return objects;
}

async function copyBucket(
  from: SupabaseClient,
  to: SupabaseClient,
  bucket: string,
  fromLabel: string,
  toLabel: string,
): Promise<BucketCopyResult> {
  await ensureDestinationBucket(from, to, bucket, fromLabel, toLabel);
  const objects = await listBucketObjects(from, bucket);
  const result: BucketCopyResult = { bucket, copied: 0, skipped: 0, failed: [] };

  for (const object of objects) {
    const { data, error: downloadError } = await from.storage.from(bucket).download(object.name);
    if (downloadError || !data) {
      result.failed.push({ path: object.name, error: downloadError?.message ?? 'Download returned no data.' });
      continue;
    }

    const { error: uploadError } = await to.storage.from(bucket).upload(object.name, data, {
      upsert: true,
      contentType: data.type || object.metadata?.mimetype,
    });

    if (uploadError) {
      result.failed.push({ path: object.name, error: uploadError.message });
      continue;
    }

    result.copied += 1;
  }

  return result;
}

async function getBucketObjectCount(
  client: SupabaseClient | null,
  bucket: string,
  configError: string | null,
): Promise<BucketObjectCount> {
  if (!client) {
    return {
      exists: false,
      objectCount: null,
      totalBytes: null,
      error: configError ?? 'Storage is not configured.',
    };
  }

  const { data: bucketInfo, error: bucketError } = await client.storage.getBucket(bucket);
  if (bucketError || !bucketInfo) {
    return {
      exists: false,
      objectCount: null,
      totalBytes: null,
      error: bucketError?.message ?? null,
    };
  }

  const objects = await listBucketObjects(client, bucket);
  return {
    exists: true,
    objectCount: objects.length,
    totalBytes: objects.reduce((total, object) => total + (object.metadata?.size ?? 0), 0),
    error: null,
  };
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    const action = request.nextUrl.searchParams.get('action');

    if (action === 'preview') {
      const role = request.nextUrl.searchParams.get('role') === 'backup' ? 'backup' : 'source';
      const bucket = request.nextUrl.searchParams.get('bucket')?.trim();
      const objectPath = request.nextUrl.searchParams.get('path')?.trim();
      if (!bucket || !objectPath) {
        return NextResponse.json({ error: 'Missing bucket or path parameter' }, { status: 400 });
      }

      const client = createAdminClient(readStorageConfig(role));
      const { data, error } = await client.storage.from(bucket).createSignedUrl(objectPath, 300);
      if (error || !data?.signedUrl) {
        return NextResponse.json(
          { error: error?.message ?? `Could not create a preview URL for "${bucket}/${objectPath}".` },
          { status: 404 },
        );
      }

      return NextResponse.json({ url: data.signedUrl });
    }

    if (action === 'objects') {
      const role = request.nextUrl.searchParams.get('role') === 'backup' ? 'backup' : 'source';
      const bucket = request.nextUrl.searchParams.get('bucket')?.trim();
      if (!bucket) {
        return NextResponse.json({ error: 'Missing bucket parameter' }, { status: 400 });
      }

      const config = readStorageConfig(role);
      const client = createAdminClient(config);
      const objects = await listBucketObjects(client, bucket);
      return NextResponse.json({
        role,
        bucket,
        storage: config.label,
        objects: objects.map(formatStorageObject),
        objectCount: objects.length,
        totalBytes: objects.reduce((total, object) => total + (object.metadata?.size ?? 0), 0),
      });
    }

    const sourceConfigState = getStorageConfigState('source');
    const backupConfigState = getStorageConfigState('backup');
    const source = sourceConfigState.config ? createAdminClient(sourceConfigState.config) : null;
    const backup = backupConfigState.config ? createAdminClient(backupConfigState.config) : null;

    if (action === 'counts') {
      const bucket = request.nextUrl.searchParams.get('bucket')?.trim();
      if (!bucket) {
        return NextResponse.json({ error: 'Missing bucket parameter' }, { status: 400 });
      }

      const [sourceCount, backupCount] = await Promise.all([
        getBucketObjectCount(source, bucket, sourceConfigState.error),
        getBucketObjectCount(backup, bucket, backupConfigState.error),
      ]);

      return NextResponse.json({
        bucket,
        source: sourceCount,
        backup: backupCount,
      });
    }

    const [sourceBucketResult, backupBucketResult] = await Promise.all([
      source
        ? source.storage.listBuckets()
        : Promise.resolve({ data: null, error: null }),
      backup
        ? backup.storage.listBuckets()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (sourceBucketResult.error) throw sourceBucketResult.error;
    if (backupBucketResult.error) throw backupBucketResult.error;

    return NextResponse.json({
      sourceStorage: sourceConfigState.config?.label ?? 'Not configured',
      backupStorage: backupConfigState.config?.label ?? 'Not configured',
      defaultBuckets: DEFAULT_BUCKETS,
      sourceBuckets: sourceBucketResult.data?.map((bucket) => bucket.name) ?? [],
      backupBuckets: backupBucketResult.data?.map((bucket) => bucket.name) ?? [],
      sourceConfigured: Boolean(sourceConfigState.config),
      backupConfigured: Boolean(backupConfigState.config),
      configErrors: {
        source: sourceConfigState.error,
        backup: backupConfigState.error,
      },
    });
  } catch (error) {
    console.error('Error in storage backup GET:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load storage backup data' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (admin.response) return admin.response;

  try {
    const body = await request.json().catch(() => ({}));
    const buckets = normalizeBucketList(body.buckets);
    const direction: StorageCopyDirection = body.action === 'restore' ? 'restore' : 'backup';
    const source = createAdminClient(readStorageConfig('source'));
    const backup = createAdminClient(readStorageConfig('backup'));
    const from = direction === 'restore' ? backup : source;
    const to = direction === 'restore' ? source : backup;
    const fromLabel = direction === 'restore' ? 'Backup' : 'Source';
    const toLabel = direction === 'restore' ? 'source' : 'backup';
    const results: BucketCopyResult[] = [];

    for (const bucket of buckets) {
      results.push(await copyBucket(from, to, bucket, fromLabel, toLabel));
    }

    return NextResponse.json({
      action: direction,
      buckets,
      results,
      copied: results.reduce((total, result) => total + result.copied, 0),
      failed: results.reduce((total, result) => total + result.failed.length, 0),
    });
  } catch (error) {
    console.error('Error in storage backup POST:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to back up storage buckets' },
      { status: 500 }
    );
  }
}
