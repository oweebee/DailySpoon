import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { localTimeUtc } from "@/lib/tz";
import { usdToEur } from "@/lib/aiPricing";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Même intervalle que le repli "Aspirer les news" du worker (voir
// worker/index.ts, FALLBACK_INTERVAL_HOURS) — dupliqué ici plutôt
// qu'importé : le worker tourne dans un process séparé (pas de bundle
// partagé simple avec Next.js), et cette constante ne change jamais sans
// toucher aussi au worker.
const FALLBACK_INTERVAL_HOURS = 3;

function datePartsInTz(at: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute") };
}

/**
 * Prochain déclenchement automatique affiché dans les statistiques admin —
 * reproduit la logique de worker/index.ts (tick) sans la dupliquer
 * exactement au tick près : suffisant pour un affichage informatif, pas pour
 * déclencher quoi que ce soit ici.
 *
 * - Planning auto actif (editionScheduleEnabled) : prochaine génération
 *   complète (impression IA) à editionHour:editionMinute, aujourd'hui si pas
 *   encore passé, sinon demain.
 * - Mode manuel : prochaine aspiration RSS de secours (sans IA), au
 *   prochain créneau de FALLBACK_INTERVAL_HOURS heures (0h, 3h, 6h...).
 */
function computeNextAutoFetch(settings: Awaited<ReturnType<typeof getSettings>>): {
  mode: "auto" | "manual";
  nextRunAt: string;
} {
  const tz = settings.editionTz;
  const now = new Date();
  const { year, month, day, hour, minute } = datePartsInTz(now, tz);

  if (settings.editionScheduleEnabled) {
    let target = localTimeUtc(year, month, day, settings.editionHour, settings.editionMinute, tz);
    if (target.getTime() <= now.getTime()) {
      target = localTimeUtc(year, month, day + 1, settings.editionHour, settings.editionMinute, tz);
    }
    return { mode: "auto", nextRunAt: target.toISOString() };
  }

  const currentSlot = Math.floor(hour / FALLBACK_INTERVAL_HOURS);
  let nextSlotHour = (currentSlot + 1) * FALLBACK_INTERVAL_HOURS;
  // Si on est pile à la minute 0 d'un créneau, ce créneau vient tout juste
  // de tourner (ou est en train de tourner) — le "prochain" est bien celui
  // d'après, déjà couvert par currentSlot+1 ci-dessus. Aucun cas particulier
  // à gérer en plus ici.
  let nextDay = day;
  if (nextSlotHour >= 24) {
    nextSlotHour -= 24;
    nextDay += 1;
  }
  const target = localTimeUtc(year, month, nextDay, nextSlotHour, 0, tz);
  return { mode: "manual", nextRunAt: target.toISOString() };
}

export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const [
      totalArticles,
      favoriteCount,
      publishedEditionCount,
      totalEditionCount,
      lastEdition,
      dbSizeRows,
      settings
    ] = await Promise.all([
      prisma.article.count(),
      prisma.article.count({ where: { favorite: true } }),
      prisma.edition.count({ where: { status: "published" } }),
      prisma.edition.count(),
      prisma.edition.findFirst({
        // "published" seulement : une aspiration de secours sans IA
        // (forceNoAi, toutes les 3h en mode manuel) crée aussi une ligne
        // Edition (status "draft", 0 token/0€) pour simplement suivre le
        // vivier d'articles — ce n'est PAS une impression, elle ne doit pas
        // apparaître comme "Dernière impression" dans les statistiques.
        where: { status: "published" },
        orderBy: [{ date: "desc" }, { generatedAt: "desc" }],
        select: {
          date: true,
          generatedAt: true,
          status: true,
          sourcePoolCount: true,
          inputTokens: true,
          outputTokens: true,
          estimatedCostUsd: true,
          _count: { select: { snapshot: true } }
        }
      }),
      // Taille totale de la base Postgres (toutes tables confondues) — le
      // moyen le plus simple/fiable d'avoir "la taille utilisée", plutôt que
      // de sommer table par table (et cette base est dédiée à DailySpoon de
      // toute façon).
      prisma.$queryRaw<{ bytes: bigint; pretty: string }[]>`
        SELECT pg_database_size(current_database()) AS bytes,
               pg_size_pretty(pg_database_size(current_database())) AS pretty
      `,
      getSettings()
    ]);

    const nextAutoFetch = computeNextAutoFetch(settings);
    const dbSize = dbSizeRows[0];

    const lastEditionCostUsd = lastEdition?.estimatedCostUsd ?? null;

    return NextResponse.json({
      totalArticles,
      favoriteCount,
      publishedEditionCount,
      totalEditionCount,
      dbSizeBytes: dbSize ? Number(dbSize.bytes) : null,
      dbSizePretty: dbSize?.pretty ?? null,
      nextAutoFetch,
      lastEdition: lastEdition
        ? {
            date: lastEdition.date,
            generatedAt: lastEdition.generatedAt,
            status: lastEdition.status,
            sourcePoolCount: lastEdition.sourcePoolCount,
            snapshotCount: lastEdition._count.snapshot,
            inputTokens: lastEdition.inputTokens,
            outputTokens: lastEdition.outputTokens,
            estimatedCostUsd: lastEditionCostUsd,
            estimatedCostEur: lastEditionCostUsd !== null ? usdToEur(lastEditionCostUsd) : null
          }
        : null,
      aiProvider: settings.aiProvider,
      aiModel: settings.aiProvider === "gemini" ? settings.geminiModel : settings.anthropicModel
    });
  } catch (err: any) {
    console.error("[admin/stats] failed:", err);
    return NextResponse.json({ error: err?.message || "Impossible de calculer les statistiques" }, { status: 500 });
  }
}
