/**
 * Utility to filter out system admin user in all environments
 * System admin (defined in SYS_ADMIN_USER env var) is never visible
 */

const SYS_ADMIN_EMAIL =
  process.env.SYS_ADMIN_USER ||
  process.env.NEXT_PUBLIC_SYS_ADMIN_USER;

/**
 * Check if a user should be hidden (is system admin)
 */
export function isSystemAdminInProduction(email: string | null | undefined): boolean {
  if (!SYS_ADMIN_EMAIL || !email) return false;
  return email.toLowerCase() === SYS_ADMIN_EMAIL.toLowerCase();
}

/**
 * Filter out system admin from user list in production
 * Usage: users.filter(filterSystemAdmin)
 */
export function filterSystemAdmin<T extends { email?: string | null }>(user: T): boolean {
  return !isSystemAdminInProduction(user.email);
}

/**
 * Filter out system admin from tbluser list in production
 */
export function filterSystemAdminTblUser<T extends { tbluser?: { email?: string | null } | null }>(
  accountUser: T
): boolean {
  return !isSystemAdminInProduction(accountUser.tbluser?.email);
}

/**
 * Get system admin user ID for queries (to exclude)
 */
export async function getSystemAdminUserId(prisma: any): Promise<bigint | null> {
  if (!SYS_ADMIN_EMAIL) return null;

  const sysAdmin = await prisma.tbluser.findFirst({
    where: {
      email: {
        equals: SYS_ADMIN_EMAIL,
        mode: 'insensitive',
      },
    },
    select: { id: true }
  });

  return sysAdmin?.id || null;
}

/**
 * Add system admin exclusion to Prisma where clause
 */
export function excludeSystemAdminFromWhere(baseWhere: any = {}): any {
  if (!SYS_ADMIN_EMAIL) return baseWhere;

  return {
    ...baseWhere,
    email: {
      ...baseWhere.email,
      not: SYS_ADMIN_EMAIL
    }
  };
}
