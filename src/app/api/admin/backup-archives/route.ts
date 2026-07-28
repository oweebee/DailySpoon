import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Export/import des ARCHIVES (éditions déjà générées, voir /archive) —
// volontairement séparé de /api/admin/backup, qui exclut explicitement les
// articles/éditions pour rester un fichier de config léger. Celui-ci fait
// l'inverse : uniquement les éditions et leur contenu IA figé (aucun
// réglage, catégorie ou flux), pour sauvegarder/restaurer l'historique de
// lecture sans dépendre d'un dump Postgres complet.
//
// Le contenu réellement exporté est le SNAPSHOT figé (EditionArticle ->
// ArticleSnapshotContent), pas la table Article "vivante" — c'est
// exactement ce que /archive affiche, fidèle à l'impression du jour même si
// l'article vivant correspondant a depuis changé ou été purgé (voir le
// commentaire du modèle EditionArticle dans prisma/schema.prisma).
const VERSION = 1;

export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const editions = await prisma.edition.findMany({
      orderBy: [{ date: "desc" }, { generatedAt: "desc" }],
      include: {
        snapshot: { include: { content: true } }
      }
    });

    const payload = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      editions: editions.map((ed) => ({
        id: ed.id,
        date: ed.date,
        headline: ed.headline,
        status: ed.status,
        generatedAt: ed.generatedAt,
        sourcePoolCount: ed.sourcePoolCount,
        inputTokens: ed.inputTokens,
        outputTokens: ed.outputTokens,
        estimatedCostUsd: ed.estimatedCostUsd,
        aiProvider: ed.aiProvider,
        aiModel: ed.aiModel,
        writingStyle: ed.writingStyle,
        // Contenu dénormalisé (le hachage sert de clé de dédoublonnage à la
        // réimportation, voir POST plus bas) — pas besoin de préserver la
        // déduplication interne de la base dans le fichier exporté lui-même.
        snapshot: ed.snapshot.map((sa) => ({
          articleId: sa.articleId,
          content: {
            contentHash: sa.content.contentHash,
            headline: sa.content.headline,
            summary: sa.content.summary,
            frontPageSummary: sa.content.frontPageSummary,
            category: sa.content.category,
            priorityScore: sa.content.priorityScore,
            imageUrl: sa.content.imageUrl,
            sourceUrl: sa.content.sourceUrl,
            sourceTitle: sa.content.sourceTitle,
            feedTitle: sa.content.feedTitle,
            categoryLabel: sa.content.categoryLabel,
            publishedAt: sa.content.publishedAt,
            medal: sa.content.medal
          }
        }))
      }))
    };

    return NextResponse.json(payload);
  } catch (err: any) {
    console.error("[admin/backup-archives] export failed:", err);
    return NextResponse.json({ error: err?.message || "Échec de l'export" }, { status: 500 });
  }
}

// Réimporte un export produit par GET ci-dessus. Comme /api/admin/backup :
// jamais destructeur, une édition dont l'id existe déjà en base est
// simplement ignorée (déjà présente, ni écrasée ni dupliquée) plutôt que de
// risquer d'effacer une version plus récente. Le contenu (ArticleSnapshot-
// Content) est dédoublonné par contentHash, exactement comme à la
// génération normale — si cette instance a déjà exactement le même contenu
// (même hachage), la ligne existante est réutilisée au lieu d'en recréer
// une copie.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || !Array.isArray(body.editions)) {
      return NextResponse.json({ error: "Fichier de sauvegarde invalide" }, { status: 400 });
    }

    let importedEditions = 0;
    let skippedEditions = 0;
    let importedArticles = 0;

    for (const ed of body.editions as any[]) {
      if (!ed?.id || !ed?.date) continue;

      const existing = await prisma.edition.findUnique({ where: { id: ed.id }, select: { id: true } });
      if (existing) {
        skippedEditions++;
        continue;
      }

      await prisma.edition.create({
        data: {
          id: ed.id,
          date: new Date(ed.date),
          headline: ed.headline ?? null,
          status: ed.status ?? "published",
          generatedAt: ed.generatedAt ? new Date(ed.generatedAt) : new Date(),
          sourcePoolCount: ed.sourcePoolCount ?? null,
          inputTokens: ed.inputTokens ?? null,
          outputTokens: ed.outputTokens ?? null,
          estimatedCostUsd: ed.estimatedCostUsd ?? null,
          aiProvider: ed.aiProvider ?? null,
          aiModel: ed.aiModel ?? null,
          writingStyle: ed.writingStyle ?? null
        }
      });
      importedEditions++;

      for (const sa of Array.isArray(ed.snapshot) ? ed.snapshot : []) {
        const c = sa?.content;
        if (!c?.contentHash || !c?.sourceUrl || !c?.sourceTitle || !c?.feedTitle) continue;

        const content = await prisma.articleSnapshotContent.upsert({
          where: { contentHash: c.contentHash },
          update: {},
          create: {
            contentHash: c.contentHash,
            headline: c.headline ?? null,
            summary: c.summary ?? null,
            frontPageSummary: c.frontPageSummary ?? null,
            category: c.category ?? null,
            priorityScore: c.priorityScore ?? null,
            imageUrl: c.imageUrl ?? null,
            sourceUrl: c.sourceUrl,
            sourceTitle: c.sourceTitle,
            feedTitle: c.feedTitle,
            categoryLabel: c.categoryLabel ?? null,
            publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
            medal: Boolean(c.medal)
          }
        });

        await prisma.editionArticle.create({
          data: {
            editionId: ed.id,
            articleId: sa.articleId ?? "",
            contentId: content.id
          }
        });
        importedArticles++;
      }
    }

    return NextResponse.json({ ok: true, importedEditions, skippedEditions, importedArticles });
  } catch (err: any) {
    console.error("[admin/backup-archives] import failed:", err);
    return NextResponse.json({ error: err?.message || "Échec de l'import" }, { status: 500 });
  }
}
