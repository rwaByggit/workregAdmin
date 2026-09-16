import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/authOptions';
import { isSystemAdminEmail } from '@/app/lib/system-admin-email';

export async function requireSystemAdmin() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      userId: null,
    };
  }

  if (!isSystemAdminEmail(session.user.email)) {
    return {
      response: NextResponse.json({ error: 'Forbidden: System admin access required' }, { status: 403 }),
      userId: null,
    };
  }

  return {
    response: null,
    userId: session.user.id,
  };
}
