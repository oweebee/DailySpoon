import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Recherche live pour la page "En direct" : contrairement à la liste
// affichée (plafonnée aux ~1000 articles les plus récents), cette route
// interroge tout l'historique en base, quelle que soit son ancienneté —
// c'est justement le but : retrouver un article même s'il n'est plus dans
// la liste actuellement chargée à l'écran.
const MAX_RESULTS = 60;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  if (!q) return NextResponse.json({ articles: [] });

  const articles = await prisma.article.findMany({
    where: {
      processed: true,
      OR: [
        { headline: { contains: q, mode: "insensitive" } },
        { summary: { contains: q, mode: "insensitive" } },
        { sourceTitle: { contains: q, mode: "insensitive" } },
        { feedTitle: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } }
      ]
    },
    orderBy: { publishedAt: "desc" },
    take: MAX_RESULTS
  });

  return NextResponse.json({ articles });
}
