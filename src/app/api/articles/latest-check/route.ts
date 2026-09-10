import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const edition = await prisma.edition.findFirst({
    orderBy: [{ date: "desc" }, { generatedAt: "desc" }],
    select: { generatedAt: true }
  });
  return NextResponse.json({ syncedAt: edition?.generatedAt ?? null });
}
