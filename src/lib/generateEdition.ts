import { createHash } from "crypto";
import { prisma } from "./prisma";
import { fetchNewItemsFromSelectedCategories, fetchOgImage, faviconFallback, type RawItem } from "./freshrss";
import { processArticles, fallbackProcess, curateFrontPage, type ProcessedArticle } from "./ai";
import { stripHtml, looksLikeHtml } from "./text";
import { todayRangeInTz, dayRangeInTz } from "./tz";
import { getSettings } from "./settings";

// Nombre max d'articles déjà en base pour lesquels on va chercher une
// og:image manquante à CHAQUE génération. Ça évite qu'une base avec des
// centaines d'articles sans image ne déclenche des centaines de requêtes
// réseau vers autant de sites différents d'un coup — le rattrapage se fait
// alors progressivement, sur plusieurs générations successives.
const MAX_OG_BACKFILL_PER_RUN = 25;

// Coût IA : au plus ce nombre d'articles inclus PAR CATÉGORIE FreshRSS (celles
// choisies dans /admin/categories, connues avant même de lancer l'IA) passent
// réellement par l'IA à chaque génération. Les articles inclus au-delà de ce
// plafond restent affichés (traitement brut fallbackProcess, catégorie
// FreshRSS d'origine, sans coût IA) plutôt que d'être exclus purement et
// simplement — ils ne disparaissent pas, ils ne sont juste pas réécrits/notés
// par l'IA ce jour-là.
const MAX_AI_ITEMS_PER_CATEGORY = 5;

// Exporté pour le worker (voir worker/index.ts) : sert à vérifier si une
// édition existe déjà pour aujourd'hui avant de déclencher une génération de
// secours à midi, avec exactement le même calcul de "date" que celui utilisé
// ici pour créer une nouvelle édition — pas de risque de décalage de fuseau
// entre les deux.
export function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Répartit les items inclus par catégorie FreshRSS (categoryLabel — connue
 * avant tout appel IA, indépendante de la rubrique que l'IA attribuera
 * ensuite) et ne garde que les `max` plus récents de chaque catégorie pour le
 * traitement IA ; le reste part dans overflowItems (traitement brut, sans
 * coût). Les items sans categoryLabel forment leur propre groupe ("Autre").
 */
function capPerCategory(items: RawItem[], max: number): { aiItems: RawItem[]; overflowItems: RawItem[] } {
  const byCategory = new Map<string, RawItem[]>();
  for (const item of items) {
    const key = item.categoryLabel || "Autre";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(item);
  }

  const aiItems: RawItem[] = [];
  const overflowItems: RawItem[] = [];

  for (const group of byCategory.values()) {
    const sorted = [...group].sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
    aiItems.push(...sorted.slice(0, max));
    overflowItems.push(...sorted.slice(max));
  }

  return { aiItems, overflowItems };
}

/**
 * Empreinte des champs figés dans une photo d'archive (ArticleSnapshotContent)
 * — deux articles (ou deux régénérations du même article) avec exactement les
 * mêmes valeurs ici partagent la même ligne de contenu au lieu d'en dupliquer
 * une copie. Volontairement simple (concaténation + sha256) : la stabilité
 * entre deux appels compte plus que la résistance aux collisions.
 */
function snapshotContentHash(a: {
  headline: string | null;
  summary: string | null;
  frontPageSummary: string | null;
  category: string | null;
  priorityScore: number | null;
  imageUrl: string | null;
  sourceUrl: string;
  sourceTitle: string;
  feedTitle: string;
  categoryLabel: string | null;
  publishedAt: Date | null;
  medal: boolean;
}): string {
  const parts = [
    a.headline ?? "",
    a.summary ?? "",
    a.frontPageSummary ?? "",
    a.category ?? "",
    a.priorityScore?.toString() ?? "",
    a.imageUrl ?? "",
    a.sourceUrl,
    a.sourceTitle,
    a.feedTitle,
    a.categoryLabel ?? "",
    a.publishedAt?.toISOString() ?? "",
    String(a.medal)
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Full daily pipeline: pull new items from the FreshRSS categories the user
 * selected, process them with AI (rewrite + categorize + prioritize), and
 * assemble today's edition. Safe to re-run the same day: chaque appel crée
 * désormais sa PROPRE édition (plus d'upsert par date) — voir
 * EditionArticle dans schema.prisma pour le pourquoi : Article.editionId
 * n'est qu'un pointeur vers la DERNIÈRE édition, réattribué à chaque
 * régénération, donc insuffisant pour garder un historique fidèle de
 * chaque impression du jour.
 */
export async function generateDailyEdition(options: { forceNoAi?: boolean } = {}) {
  const date = todayDateOnly();
  // Bornes du jour calendaire en cours, en heure d'Europe/Paris (comme
  // l'affichage et la recherche par date — voir DISPLAY_TZ dans
  // EditionView.tsx et SEARCH_TZ dans api/articles/search) — PAS le jour UTC
  // brut, qui décale de 1-2h par rapport à ce que l'utilisateur voit à
  // l'écran. Scope désormais sur publishedAt (date de publication réelle de
  // l'article), pas fetchedAt (date de récupération en base) : un article
  // publié hier mais seulement découvert aujourd'hui par un flux lent ne
  // doit pas compter comme "de l'édition du jour". Sert à regrouper TOUS les
  // articles du jour (à travers plusieurs régénérations), pas seulement ceux
  // touchés par CETTE régénération précise — sans ça, une régénération qui
  // ne trouve que 1-2 items vraiment nouveaux depuis la dernière fois se
  // retrouverait avec une une quasi vide, perdant tout le reste des articles
  // du jour déjà récupérés.
  const PARIS_TZ = "Europe/Paris";
  const todayRange = todayRangeInTz(PARIS_TZ);

  const edition = await prisma.edition.create({
    data: { date, status: "draft" }
  });

  await cleanExistingHtmlArtifacts();
  await pruneOldArticles();

  const rawItems = await fetchNewItemsFromSelectedCategories();
  console.log(`[edition] Fetched ${rawItems.length} new items from FreshRSS.`);

  // Contenu à afficher : les articles publiés AUJOURD'HUI (Paris) s'il y en
  // a — sinon on retombe sur le jour le plus récent qui en a, plutôt que de
  // laisser la une figée indéfiniment sur un jour périmé (rien publié
  // depuis hier sur les flux sélectionnés). Sans ce repli, un "Lancer
  // l'impression" manuel un jour calme ne rafraîchissait RIEN à l'écran —
  // pas même une image corrigée entre-temps par cleanExistingHtmlArtifacts
  // ci-dessus, puisque cette correction ne peut atteindre l'affichage qu'à
  // travers une NOUVELLE photo figée (EditionArticle).
  let contentRange = todayRange;
  const hasToday = await prisma.article.count({ where: { publishedAt: todayRange, included: true } });
  if (hasToday === 0) {
    const mostRecent = await prisma.article.findFirst({
      where: { included: true, publishedAt: { not: null } },
      orderBy: { publishedAt: "desc" },
      select: { publishedAt: true }
    });
    if (mostRecent?.publishedAt) {
      contentRange = dayRangeInTz(mostRecent.publishedAt, PARIS_TZ);
    }
  }

  if (rawItems.length === 0) {
    const existingForContent = await prisma.article.count({ where: { publishedAt: contentRange, included: true } });
    if (existingForContent === 0) {
      console.log("[edition] No new items and nothing to show yet — leaving edition as draft.");
      return { editionId: edition.id, articleCount: 0 };
    }
  }

  // Seuls les articles "included" (flux non exclu, catégorie sélectionnée)
  // passent par l'IA (ou l'heuristique gratuite si pas de clé) — les autres
  // sont stockés avec un traitement brut systématique, sans jamais
  // consommer l'API payante, puisqu'ils ne sont de toute façon pas destinés
  // à être affichés dans l'édition normale (juste trouvables en recherche).
  const includedItems = rawItems.filter((r) => r.included);
  const hiddenItems = rawItems.filter((r) => !r.included);

  // Plafond de coût par catégorie : seuls les MAX_AI_ITEMS_PER_CATEGORY items
  // les plus récents de chaque catégorie FreshRSS partent réellement à l'IA ;
  // le reste (overflowItems) est quand même stocké et affiché, juste sans
  // réécriture IA (fallbackProcess), comme les articles non "included".
  const { aiItems, overflowItems } = capPerCategory(includedItems, MAX_AI_ITEMS_PER_CATEGORY);

  const processedAi = aiItems.length > 0 ? await processArticles(aiItems, options) : [];

  const resultByItemId = new Map<string, ProcessedArticle>();
  aiItems.forEach((raw, i) => resultByItemId.set(raw.freshrssItemId, processedAi[i]));
  overflowItems.forEach((raw) => resultByItemId.set(raw.freshrssItemId, fallbackProcess(raw)));
  hiddenItems.forEach((raw) => resultByItemId.set(raw.freshrssItemId, fallbackProcess(raw)));

  for (const raw of rawItems) {
    const ai = resultByItemId.get(raw.freshrssItemId)!;

    await prisma.article.upsert({
      where: { freshrssItemId: raw.freshrssItemId },
      update: {},
      create: {
        freshrssItemId: raw.freshrssItemId,
        feedId: raw.feedId,
        feedTitle: raw.feedTitle,
        categoryLabel: raw.categoryLabel,
        sourceUrl: raw.sourceUrl,
        sourceTitle: raw.sourceTitle,
        sourceExcerpt: raw.sourceExcerpt,
        imageUrl: raw.imageUrl,
        publishedAt: raw.publishedAt,
        processed: true,
        included: raw.included,
        headline: ai.headline,
        summary: ai.summary,
        category: ai.category,
        priorityScore: ai.priorityScore,
        aiRewritten: ai.aiRewritten,
        editionId: edition.id
      }
    });
  }

  await syncMedalFlags();

  // Une passe IA dédiée, une seule fois par génération (jamais en mode
  // "Aspirer les news" sans IA) : recalcule priorityScore sur TOUS les
  // articles inclus de l'édition en les comparant vraiment entre eux,
  // plutôt que par lots isolés de 12 comme processArticles — c'est ce score
  // qui détermine ensuite les articles "à la une" sur la page d'accueil.
  if (!options.forceNoAi) {
    await curateFrontPageScores(contentRange);
  }

  const heroArticle = await prisma.article.findFirst({
    where: { publishedAt: contentRange, included: true },
    orderBy: { priorityScore: "desc" }
  });

  const articleCount = await prisma.article.count({ where: { publishedAt: contentRange, included: true } });

  await prisma.edition.update({
    where: { id: edition.id },
    data: {
      headline: heroArticle?.headline ?? edition.headline,
      status: articleCount > 0 ? "published" : "draft"
    }
  });

  // Photo figée (EditionArticle) de la une IA telle qu'elle est À CET
  // INSTANT précis — mêmes critères de qualification que la page d'accueil
  // et /archive (included + aiRewritten + catégorie toujours activée pour
  // "Impression IA"). Copiée une fois pour toutes ici : contrairement à
  // Article, ces lignes ne seront plus jamais modifiées ni réattribuées à
  // une autre édition, donc cette génération reste consultable telle quelle
  // dans les archives même après d'autres régénérations le même jour.
  const disabledCategories = await prisma.selectedCategory.findMany({
    where: { frontPageEnabled: false },
    select: { label: true }
  });
  const disabledLabels = disabledCategories.map((c) => c.label);

  const qualifyingArticles = await prisma.article.findMany({
    where: {
      publishedAt: contentRange,
      processed: true,
      included: true,
      aiRewritten: true,
      ...(disabledLabels.length > 0 ? { NOT: { categoryLabel: { in: disabledLabels } } } : {})
    }
  });

  // Le contenu réel (texte, image, score...) est stocké une seule fois par
  // combinaison distincte dans ArticleSnapshotContent (déduplication par
  // empreinte) — EditionArticle ne fait plus que lier une édition à ce
  // contenu. Si un article n'a strictement pas changé depuis la dernière
  // régénération du jour (même score IA, même résumé, même médaille...), sa
  // nouvelle ligne EditionArticle réutilise le contenu déjà existant au lieu
  // d'en dupliquer une copie complète.
  for (const a of qualifyingArticles) {
    const hash = snapshotContentHash(a);
    const content = await prisma.articleSnapshotContent.upsert({
      where: { contentHash: hash },
      update: {},
      create: {
        contentHash: hash,
        headline: a.headline,
        summary: a.summary,
        frontPageSummary: a.frontPageSummary,
        category: a.category,
        priorityScore: a.priorityScore,
        imageUrl: a.imageUrl,
        sourceUrl: a.sourceUrl,
        sourceTitle: a.sourceTitle,
        feedTitle: a.feedTitle,
        categoryLabel: a.categoryLabel,
        publishedAt: a.publishedAt,
        medal: a.medal
      }
    });
    await prisma.editionArticle.create({
      data: { editionId: edition.id, articleId: a.id, contentId: content.id }
    });
  }

  console.log(
    `[edition] Edition ${date.toISOString().slice(0, 10)} ready with ${articleCount} articles ` +
      `(${qualifyingArticles.length} figés dans les archives).`
  );

  return { editionId: edition.id, articleCount };
}

/**
 * Purge les articles plus vieux que la rétention réglée dans
 * /admin/settings (6 mois à 5 ans, par défaut 2 ans ; 0 = illimité, aucune
 * purge), sur la date de publication d'origine (ou de récupération si elle
 * est inconnue). Les articles marqués favoris sont exclus de la purge, quel
 * que soit leur âge — un favori mis de côté ne doit jamais disparaître tout
 * seul.
 */
async function pruneOldArticles(): Promise<void> {
  const { retentionDays } = await getSettings();
  if (!retentionDays || retentionDays <= 0) return; // illimité

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.article.deleteMany({
    where: {
      favorite: false,
      OR: [{ publishedAt: { lt: cutoff } }, { publishedAt: null, fetchedAt: { lt: cutoff } }]
    }
  });
  if (count > 0) {
    console.log(`[edition] Rétention (${retentionDays} j) : ${count} article(s) purgé(s).`);
  }
}

/**
 * Réconcilie Article.medal avec la liste des flux "médaillés" réglée dans
 * /admin/categories. Recalculé à chaque génération (pas seulement au moment
 * du toggle admin, qui le fait déjà pour les articles déjà en base) pour
 * couvrir aussi les articles insérés juste avant dans cette même run.
 *
 * Le rapprochement se fait par feedId, mais certains articles plus anciens
 * n'en ont pas (champ ajouté après coup, ou absent de la réponse FreshRSS
 * pour ce flux) — on les rattrape par titre de flux, comme pour l'exclusion
 * de flux (ExcludedFeed) qui a le même souci.
 */
async function syncMedalFlags(): Promise<void> {
  const medalFeeds = await prisma.medalFeed.findMany({ select: { freshrssId: true, label: true } });
  const medalFeedIds = medalFeeds.map((f) => f.freshrssId);
  const medalTitles = medalFeeds.map((f) => f.label);

  const matchCondition = {
    OR: [{ feedId: { in: medalFeedIds } }, { feedId: null, feedTitle: { in: medalTitles } }]
  };

  await prisma.article.updateMany({
    where: { AND: [matchCondition, { medal: false }] },
    data: { medal: true }
  });
  await prisma.article.updateMany({
    where: { medal: true, NOT: matchCondition },
    data: { medal: false }
  });
}

/**
 * Demande à l'IA de définir les news marquantes de la journée : relit tous
 * les articles inclus récupérés AUJOURD'HUI (déjà réécrits, toutes
 * régénérations confondues — pas seulement ceux de cette run précise) EN UNE
 * FOIS et leur attribue un score d'importance cohérent sur l'ensemble du
 * jour, plutôt que le score par lot de 12 posé par processArticles. Silencieux et sans effet
 * si aucune clé IA n'est configurée pour le fournisseur choisi (curateFrontPage
 * renvoie alors une Map vide) — les scores existants restent tels quels.
 */
async function curateFrontPageScores(todayRange: { gte: Date; lt: Date }): Promise<void> {
  // Carte "Impression IA" de /admin/categories : les catégories décochées là
  // ne doivent même pas être soumises à cette passe (ni affichées sur la une,
  // ni comparées aux autres) — inutile de dépenser des tokens dessus.
  const disabledCategories = await prisma.selectedCategory.findMany({
    where: { frontPageEnabled: false },
    select: { label: true }
  });
  const disabledLabels = disabledCategories.map((c) => c.label);

  const todaysArticles = await prisma.article.findMany({
    where: {
      publishedAt: todayRange,
      included: true,
      processed: true,
      // La une doit être une vraie "impression IA" : les articles tombés en
      // fallback (plafond par catégorie, pas de clé IA...) ne sont ni notés
      // ni affichés sur la une, même s'ils restent visibles ailleurs.
      aiRewritten: true,
      ...(disabledLabels.length > 0 ? { NOT: { categoryLabel: { in: disabledLabels } } } : {})
    },
    select: { id: true, headline: true, summary: true, category: true, feedTitle: true }
  });
  if (todaysArticles.length === 0) return;

  const scores = await curateFrontPage(
    todaysArticles.map((a) => ({
      id: a.id,
      headline: a.headline || "",
      summary: a.summary || "",
      category: a.category || "Autre",
      source: a.feedTitle || ""
    }))
  );
  if (scores.size === 0) return;

  await prisma.$transaction(
    [...scores.entries()].map(([id, result]) =>
      prisma.article.update({
        where: { id },
        data: { priorityScore: result.priorityScore, frontPageSummary: result.frontPageSummary }
      })
    )
  );
  console.log(`[edition] Une du jour recalculée par l'IA pour ${scores.size} article(s).`);
}

/**
 * One-off retroactive fix: articles fetched before stripHtml() existed still
 * have raw HTML (tables, <img>, tracking links) sitting in their text
 * fields. Clean them in place on every generation run instead of requiring
 * a manual wipe-and-refetch. Checked across every article in the DB (not
 * just the edition being generated today) since the site now shows recent
 * articles across all editions, not just today's.
 *
 * Sert aussi de rattrapage pour l'illustration : les articles dont
 * l'image manque encore, OU qui n'ont qu'un favicon posé en dernier
 * recours (voir isFaviconFallback ci-dessous — ex. un og:image qui avait
 * échoué/timeout au tout premier passage), sont retentés via og:image sur
 * la page source (plafonné par MAX_OG_BACKFILL_PER_RUN pour ne pas
 * déclencher une rafale de requêtes). Sans ce second essai, un simple
 * échec réseau ponctuel au premier fetch condamnait l'article à garder son
 * favicon générique pour toujours, alors que la vraie image existe bel et
 * bien sur la page (og:image fonctionne, juste pas retenté une fois posé).
 *
 * Les lookups og:image retenus sont lancés EN PARALLÈLE (Promise.all), pas
 * en série : à 5s de timeout chacun, MAX_OG_BACKFILL_PER_RUN requêtes en
 * série pouvaient approcher les 2 minutes, au-delà du timeout du proxy
 * (Coolify) — la requête HTTP du bouton "Lancer l'impression" échouait
 * alors silencieusement côté navigateur (aucun message affiché) alors que
 * la génération continuait tranquillement côté serveur.
 */
function isFaviconFallback(url: string | null): boolean {
  return !!url && url.includes("google.com/s2/favicons");
}

async function cleanExistingHtmlArtifacts(): Promise<void> {
  const candidates = await prisma.article.findMany({
    select: {
      id: true,
      sourceTitle: true,
      sourceExcerpt: true,
      sourceUrl: true,
      headline: true,
      summary: true,
      imageUrl: true
    }
  });

  // Pas d'image du tout, ou juste un favicon posé en dernier recours à un
  // run précédent (voir isFaviconFallback) : dans les deux cas, on retente
  // d'obtenir la vraie illustration — plafonné, puis lancé d'un coup.
  const needingImage = candidates.filter(
    (a) => a.sourceUrl && (!a.imageUrl || isFaviconFallback(a.imageUrl))
  );
  const toBackfill = needingImage.slice(0, MAX_OG_BACKFILL_PER_RUN);
  const ogResults = await Promise.all(toBackfill.map((a) => fetchOgImage(a.sourceUrl!)));
  const ogImageById = new Map(toBackfill.map((a, i) => [a.id, ogResults[i]]));

  for (const article of candidates) {
    const dirty =
      looksLikeHtml(article.sourceTitle) ||
      looksLikeHtml(article.sourceExcerpt) ||
      looksLikeHtml(article.headline) ||
      looksLikeHtml(article.summary);

    let backfilledImage: string | null = ogImageById.get(article.id) ?? null;

    // Toujours rien — favicon du site en dernier recours (pas de requête
    // réseau de notre côté, juste une URL construite), seulement si
    // l'article n'a vraiment aucune image (ne pas remplacer une image déjà
    // correcte, ni reposer un favicon déjà en place).
    if (!article.imageUrl && !backfilledImage && article.sourceUrl) {
      backfilledImage = faviconFallback(article.sourceUrl);
    }

    if (!dirty && !backfilledImage) continue;

    await prisma.article.update({
      where: { id: article.id },
      data: {
        sourceTitle: article.sourceTitle ? stripHtml(article.sourceTitle) : article.sourceTitle,
        sourceExcerpt: article.sourceExcerpt ? stripHtml(article.sourceExcerpt) : article.sourceExcerpt,
        headline: article.headline ? stripHtml(article.headline) : article.headline,
        summary: article.summary ? stripHtml(article.summary) : article.summary,
        // backfilledImage prime sur l'ancienne valeur : c'est justement ce
        // qui permet de remplacer un favicon générique par la vraie image
        // une fois qu'on l'a enfin obtenue.
        imageUrl: backfilledImage ?? article.imageUrl ?? undefined
      }
    });
  }

  if (candidates.length > 0) {
    console.log(
      `[edition] Checked ${candidates.length} existing article(s) for leftover HTML` +
        (toBackfill.length > 0 ? ` (${toBackfill.length} og:image lookup(s) attempted in parallel).` : ".")
    );
  }
}
