import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { getSettings, updateSettings } from "@/lib/settings";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Returns the effective settings (DB value if set, env var fallback otherwise)
// so the admin form can show what's actually being used right now.
export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const settings = await getSettings();
  return NextResponse.json({ settings });
}

// Saves settings to the DB. Leave a field empty to fall back to the
// matching environment variable again.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  await updateSettings(body);

  return NextResponse.json({ ok: true });
}
