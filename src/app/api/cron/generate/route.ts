import { NextRequest, NextResponse } from "next/server";
import { generateDailyEdition } from "@/lib/generateEdition";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

// Triggered either by:
// 1. The self-hosted worker/cron script, authenticated with CRON_SECRET
// 2. A logged-in admin clicking "Régénérer maintenant" in /admin/feeds
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const hasValidCronSecret = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const sessionToken = req.cookies.get(SESSION_COOKIE)?.value;
  const hasValidAdminSession = await isValidSessionToken(sessionToken);

  if (!hasValidCronSecret && !hasValidAdminSession) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await generateDailyEdition();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/generate] failed:", err);
    return NextResponse.json({ error: "generation failed" }, { status: 500 });
  }
}
