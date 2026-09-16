import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

export async function GET() {

  const dbUrl = process.env.DATABASE_URL || '';
  const appVer = process.env.NEXT_PUBLIC_APP_VER || '0.0';

  // SANITIZE CREDENTIALS
  const sanitized = dbUrl
    .replace(/:\/\/.*?:.*?@/, '://***:***@') // hides username + password
    .replace(/;Password=.*?;/i, ';Password=***;') // SQL Server URL format safeguard
    .replace(/(pwd=)([^;]+)/i, '$1***'); // fallback pattern

  return NextResponse.json({
    DATABASE_URL: sanitized, appVer
  });
}
