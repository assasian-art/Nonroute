import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { flush, status } from "@/lib/stateSync/githubState";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function canAccess() {
  const settings = await getSettings().catch(() => ({}));
  if (settings?.requireLogin === false) return true;

  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  return verifyDashboardAuthToken(token);
}

// Manual "Sync now" trigger from the Storage card.
export async function POST() {
  try {
    if (!(await canAccess())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await flush("manual");
    return NextResponse.json({ ...status(), result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "State sync failed" }, { status: 500 });
  }
}