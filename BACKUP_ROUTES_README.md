# Backup and restore routes

Copied from `workregModern` on 2026-09-16.

## Routes

- `app/api/admin/db-backup/route.ts`
- `app/api/admin/db-restore/route.ts`
- `app/api/admin/db-check/route.ts`
- `app/api/admin/storage-backup/route.ts`

## Required packages

- `next`
- `postgres`
- `dotenv`
- `@supabase/supabase-js`

## Required environment variables

Database source values:

- `DATABASE_URL`, or `.env` with `DATABASE_URL`

Database backup values:

- `BACKUP_DATABASE_URL`, or `DATABASE_URL_BACKUP`, or `.env.backup` with `DATABASE_URL`

Storage source values:

- `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`

Storage backup values:

- `BACKUP_SUPABASE_URL` or `BACKUP_NEXT_PUBLIC_SUPABASE_URL`
- `BACKUP_SUPABASE_SECRET_KEY` or `BACKUP_SUPABASE_SERVICE_ROLE_KEY`

Authorization:

The copied routes still import `requireSystemAdmin` from the original project's `app/lib/system-admin` module. Connect that import to the new admin project's authentication and authorization implementation before exposing these routes.

The BigInt serializer has been made local at `lib/serializeBigInt.ts`, so the new module does not need to import the original project's large `app/lib/api.ts` helper.

## Login, auth, and modular menu

Copied into this project:

- `app/login/page.tsx` and `app/login/layout.tsx`
- `app/api/auth/[...nextauth]/route.ts`
- `app/api/auth/register/route.ts`
- `app/api/auth/verify-email/route.ts`
- `app/api/auth/verify-otp/route.ts`
- `app/api/debug/env/route.ts` and `app/api/debug/check-admin/route.ts`
- `app/api/password-reset/request/route.ts`
- `app/(default)/layout.tsx`
- `app/components/ModularMenu.tsx` and its direct UI dependencies
- `app/hooks`, `app/context`, `app/lib`, `lib/module-table-mapping.ts`, and `src/bc.ts` dependencies used by the menu

The login and auth routes still require the new project's authentication/database wiring, including `next-auth`, `@prisma/client`, Prisma initialization, `authOptions`, email delivery, and the registration/payment helpers. The modular menu expects the new project to provide its session provider, subscription access endpoint, account endpoints, and matching destination pages.

The copied menu uses `app/lib/history.ts` instead of the original app-wide `app/lib/api.ts` module.

## Important deployment note

These routes use filesystem reads to discover `.env` and `.env.backup`. In a serverless deployment, provide the database and Supabase values through deployment environment variables and consider replacing filesystem configuration reads. The original production build reported that `db-restore` caused the whole project to be traced because of dynamic filesystem access.
