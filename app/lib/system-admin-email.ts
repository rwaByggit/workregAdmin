export function getConfiguredSystemAdminEmail() {
  return (
    process.env.SYS_ADMIN_USER ||
    process.env.NEXT_PUBLIC_SYS_ADMIN_USER ||
    ''
  ).trim().toLowerCase();
}

export function isSystemAdminEmail(email: string | null | undefined) {
  const systemAdminEmail = getConfiguredSystemAdminEmail();
  return Boolean(
    systemAdminEmail &&
    typeof email === 'string' &&
    email.trim().toLowerCase() === systemAdminEmail
  );
}
