import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { status } from "@/lib/stateSync/githubState";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Same gate as the other settings/test routes: open when login is disabled,
// otherwise a valid dashboard session cookie is required.
async function canAccess() {
  const settings = await getSettings().catch(() => ({}));
  if (settings?.requireLogin === false) return true;

  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  return verifyDashboardAuthToken(token);
}

export async function GET() {
  try {
    if (!(await canAccess())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(status(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to read state-sync status" }, { status: 500 });
  }
}