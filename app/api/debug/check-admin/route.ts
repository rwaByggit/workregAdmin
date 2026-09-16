import { NextResponse } from "next/server";
import { requireSystemAdmin } from "@/app/lib/system-admin";

export async function POST() {
  const admin = await requireSystemAdmin();
  if (admin.response) return admin.response;

  return NextResponse.json({
    isAdmin: true,
  });
}
