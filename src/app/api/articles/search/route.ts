import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { localMidnightUtc } from "@/lib/tz";

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

// Même fuseau que celui utilisé PARTOUT ailleurs dans l'appli pour afficher
// les dates (voir DISPLAY_TZ dans EditionView.tsx) — indispensable ici aussi
// : sinon "14 juillet" était compris comme le jour calendaire UTC alors que
// les heures affichées à l'écran sont en Europe/Paris (UTC+1/+2). Un article
// publié le 14 juillet à 23h30 UTC s'affiche "15 juillet, 01h30" à l'écran
// mais matchait "14 juillet" côté recherche — d'où le décalage observé.
const SEARCH_TZ = "Europe/Paris";

/**
 * Reconnaît une recherche du style "15 juillet" ou "15 juillet 2026" (accents
 * et casse ignorés, "1er" toléré) et la convertit en plage [début, fin[ du
 * jour visé en heure d'Europe/Paris — année courante par défaut si omise
 * (l'appli est encore jeune, pas besoin de deviner entre plusieurs années
 * possibles). Renvoie null si la recherche ne ressemble pas à une date, ou si
 * la date n'existe pas (ex. "31 avril").
 */
function parseFrenchDateQuery(raw: string): { start: Date; end: Date } | null {
  const q = stripAccents(raw.trim().toLowerCase());
  const match = q.match(/^(\d{1,2})(?:er)?\s+([a-z]+)\s*(\d{4})?$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  if (month === undefined || day < 1 || day > 31) return null;

  const year = match[3] ? Number(match[3]) : new Date().getUTCFullYear();
  const checkDay = new Date(Date.UTC(year, month, day));
  if (checkDay.getUTCMonth() !== month || checkDay.getUTCDate() !== day) return null; // ex. "31 avril"

  const start = localMidnightUtc(year, month, day, SEARCH_TZ);
  const end = localMidnightUtc(year, month, day + 1, SEARCH_TZ);
  return { start, end };
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  if (!q) return NextResponse.json({ articles: [] });

  const dateRange = parseFrenchDateQuery(q);

  // Une recherche reconnue comme une date ("15 juillet"...) filtre UNIQUEMENT
  // par date de publication — pas en plus de la recherche texte, sinon un
  // article qui mentionne juste "juillet" quelque part dans son résumé (très
  // courant dans un article d'actualité) remontait aussi, avec sa vraie date
  // de publication qui n'a rien à voir avec celle recherchée.
  const where = dateRange
    ? { processed: true, publishedAt: { gte: dateRange.start, lt: dateRange.end } }
    : {
        processed: true,
        OR: [
          { headline: { contains: q, mode: "insensitive" as const } },
          { summary: { contains: q, mode: "insensitive" as const } },
          { sourceTitle: { contains: q, mode: "insensitive" as const } },
          { feedTitle: { contains: q, mode: "insensitive" as const } },
          { category: { contains: q, mode: "insensitive" as const } }
        ]
      };

  const articles = await prisma.article.findMany({
    where,
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
