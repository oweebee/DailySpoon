import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Recherche live pour la page "En direct" (et réutilisée telle quelle par
// ArchiveSearch) : contrairement à la liste affichée (plafonnée aux ~1000
// articles les plus récents), cette route interroge tout l'historique en
// base, quelle que soit son ancienneté — c'est justement le but : retrouver
// un article même s'il n'est plus dans la liste actuellement chargée à
// l'écran.
const MAX_RESULTS = 60;

const MONTHS: Record<string, number> = {
  janvier: 0,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Reconnaît une recherche du style "15 juillet" ou "15 juillet 2026" (accents
 * et casse ignorés, "1er" toléré) et la convertit en plage [début, fin[ du
 * jour visé — année courante par défaut si omise (l'appli est encore jeune,
 * pas besoin de deviner entre plusieurs années possibles). Renvoie null si la
 * recherche ne ressemble pas à une date, ou si la date n'existe pas
 * (ex. "31 avril").
 */
function parseFrenchDateQuery(raw: string): { start: Date; end: Date } | null {
  const q = stripAccents(raw.trim().toLowerCase());
  const match = q.match(/^(\d{1,2})(?:er)?\s+([a-z]+)\s*(\d{4})?$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  if (month === undefined || day < 1 || day > 31) return null;

  const year = match[3] ? Number(match[3]) : new Date().getUTCFullYear();
  const start = new Date(Date.UTC(year, month, day));
  if (start.getUTCMonth() !== month || start.getUTCDate() !== day) return null; // ex. "31 avril"

  const end = new Date(Date.UTC(year, month, day + 1));
  return { start, end };
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  if (!q) return NextResponse.json({ articles: [] });

  const dateRange = parseFrenchDateQuery(q);

  const articles = await prisma.article.findMany({
    where: {
      processed: true,
      OR: [
        { headline: { contains: q, mode: "insensitive" } },
        { summary: { contains: q, mode: "insensitive" } },
        { sourceTitle: { contains: q, mode: "insensitive" } },
        { feedTitle: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
        // "15 juillet" / "15 juillet 2026" : recherche par date de
        // publication plutôt que texte, en plus des conditions ci-dessus.
        ...(dateRange ? [{ publishedAt: { gte: dateRange.start, lt: dateRange.end } }] : [])
      ]
    },
    orderBy: { publishedAt: "desc" },
    take: MAX_RESULTS,
    // L'édition (et sa date) est incluse pour /archive : la recherche y sert
    // à retrouver quel JOUR archivé contient les mots recherchés, pas
    // seulement l'article en lui-même — champ ignoré sans effet ailleurs
    // (En direct affiche déjà les articles individuellement).
    include: { edition: { select: { date: true } } }
  });

  return NextResponse.json({ articles });
}
