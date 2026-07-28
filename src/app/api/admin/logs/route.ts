import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Journal technique (/admin/logs) — voir schema.prisma (LogEntry) et
// src/lib/logger.ts pour le pourquoi. Liste les événements les plus récents
// d'abord, avec filtre optionnel par niveau ("info"/"warn"/"error") et par
// source (ex. "custom-feeds", "freshrss", "edition", "ai", "worker").
// Plafonné à 300 lignes par appel : /admin/logs se recharge périodiquement,
// pas la peine de tout charger d'un coup.
const MAX_LIMIT = 300;

export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const level = searchParams.get("level");
  const source = searchParams.get("source");
  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : MAX_LIMIT;

  const where: Record<string, unknown> = {};
  if (level && level !== "all") where.level = level;
  if (source && source !== "all") where.source = source;

  try {
    const [logs, sources] = await Promise.all([
      prisma.logEntry.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
      // Liste des sources distinctes déjà vues, pour peupler le filtre côté
      // client sans avoir à connaître à l'avance toutes les valeurs
      // possibles (ex. si un nouveau "source" apparaît plus tard côté code).
      prisma.logEntry.findMany({ distinct: ["source"], select: { source: true }, orderBy: { source: "asc" } })
    ]);

    return NextResponse.json({
      logs,
      sources: sources.map((s) => s.source)
    });
  } catch (err: any) {
    // Cause la plus probable : migration 20260718190000_log_entry pas encore
    // appliquée (table LogEntry manquante).
    console.error("[admin/logs] GET failed:", err);
    return NextResponse.json(
      { error: err?.message || "Impossible de charger le journal (migration appliquée ?)" },
      { status: 500 }
    );
  }
}

// Vide le journal manuellement (bouton "Vider le journal" dans /admin/logs)
// — n'affecte que LogEntry, aucune autre donnée de l'app.
export async function DELETE(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    await prisma.logEntry.deleteMany({});
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[admin/logs] DELETE failed:", err);
    return NextResponse.json({ error: err?.message || "Échec du vidage du journal" }, { status: 500 });
  }
}
