---
name: workreg-supabase-admin
description: "Use when developing, reviewing, or debugging this Workreg Next.js administration app, especially Supabase database or storage administration, backups, restores, migrations, Vercel deployment limits, or routes copied from the primary Workreg app. Treat ./workregModern as the source application; in this workspace the directory is currently ./.workregModern."
---

# Workreg Supabase Administration

This repository is the administration app for the primary Workreg application. The primary application is the source of truth for database schema, Supabase usage, authentication contracts, table names, storage buckets, and user-facing behavior.

## Source-of-truth path

- Intended source path: `./workregModern`
- Current path in this workspace: `./.workregModern`
- Resolve the path before searching. If both paths exist, prefer `./workregModern` and confirm whether they are distinct checkouts before editing either one.
- do not change anything in the source app as this is done in own environment and got separate github workspace. The source app is the source of truth for database schema, Supabase usage, authentication contracts, table names, storage buckets, and user-facing behavior.
- this admin app is for administrating the databases used by the source app's users and for managing the source app's storage buckets. It is not a replacement for the source app's own user-facing functionality.

Useful source locations include:

- `./.workregModern/app/api/**` for the live API contracts and server-side Supabase access
- `./.workregModern/app/lib/**` and `./.workregModern/lib/**` for shared clients, authorization, serialization, and database helpers
- `./.workregModern/prisma/**`, `./.workregModern/migrations/**`, and `./.workregModern/supabase_migration.sql` for schema and migration history
- `./.workregModern/app/api/admin/db-backup/route.ts`
- `./.workregModern/app/api/admin/db-check/route.ts`
- `./.workregModern/app/api/admin/db-restore/route.ts`
- `./.workregModern/app/api/admin/storage-backup/route.ts`

## Working workflow

1. Read the corresponding source-app implementation and its nearby client/helper code before changing an admin route.
2. Compare schema, table relationships, storage buckets, and environment-variable names against the source app.
3. Keep the admin app's authentication and system-admin authorization explicit. Never expose service-role credentials to browser code.
4. Prefer Supabase APIs and Postgres-safe, parameterized queries. Preserve RLS and use service-role access only in trusted server routes that require it.
5. Keep backup and restore operations observable, bounded, resumable, and safe to retry. Do not silently delete or overwrite production data.
6. Treat Vercel serverless execution limits as a first-class constraint. Avoid pulling large backup/restore work into a single request or forcing the whole deployment bundle to trace filesystem/database tooling.
7. Prefer a queued, chunked, or externally executed operation for heavy work. Keep request handlers focused on authorization, validation, job creation/status, and bounded chunks.
8. Do not read `.env*` files at runtime in deployed serverless code when deployment environment variables can be used. Never print or commit credentials.
9. After changes, run the narrowest relevant type-check/lint/test first, then the repository's broader checks when practical.

## Backup and restore guardrails

- Confirm source and backup database identities before a transfer; do not rely only on labels.
- Validate table and column identifiers against known metadata before interpolating identifiers into SQL. Values must remain parameterized.
- Preserve foreign-key ordering and account/user scoping when copying related data.
- Make restore previews and dry runs available where the existing route supports them.
- Report counts, skipped rows, failures, and partial completion clearly. A timeout must not be presented as success.
- Storage copies must preserve bucket/object paths and handle pagination, retries, and partial failures.
- Keep destructive operations behind system-admin authorization and an explicit confirmation step.

## Validation checklist

For a change that affects Supabase administration, check the relevant source route and then verify:

- TypeScript compiles with `npm run type-check`.
- ESLint passes for touched files or with `npm run lint`.
- Source and backup configuration errors are actionable without revealing secrets.
- Authentication rejects unauthorised requests.
- Large operations do not depend on an unbounded Vercel request.
- Database and storage operations remain compatible with the source app's current schema and bucket layout.
