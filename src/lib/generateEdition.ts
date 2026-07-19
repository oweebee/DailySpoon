import { createHash } from "crypto";
import { prisma } from "./prisma";
import { fetchNewItemsFromSelectedCategories, fetchOgImage, faviconFallback, type RawItem } from "./freshrss";
import {
  processArticles,
  fallbackProcess,
  curateFrontPage,
  resolveWritingStyle,
  type ProcessedArticle,
  type TokenUsage
} from "./ai";
import { stripHtml, looksLikeHtml, stripLeadingChrome } from "./text";
import { todayRangeInTz, dayRangeInTz, todayDateOnlyInTz } from "./tz";
import { getSettings } from "./settings";
import { estimateCostUsd } from "./aiPricing";
import { writeLog } from "./logger";

// Nombre max d'articles déjà en base pour lesquels on va chercher une
// og:image manquante à CHAQUE génération. Ça évite qu'une base avec des
// centaines d'articles sans image ne déclenche des centaines de requêtes
// réseau vers autant de sites différents d'un coup — le rattrapage se fait
// alors progressivement, sur plusieurs générations successives.
const MAX_OG_BACKFILL_PER_RUN = 25;

// Coût IA : au plus ce nombre d'articles inclus PAR CATÉGORIE FreshRSS (celles
// choisies dans /admin/categories) passent par l'IA à chaque génération.
// Workflow visé : UNE seule impression par jour (le soir), qui doit couvrir
// toute la journée — donc pas un petit plafond de curation type "top 5", mais
// un simple garde-fou de sécurité contre une journée pathologiquement
// chargée dans une seule catégorie (au-delà, le surplus reste affiché en
// traitement brut fallbackProcess, sans coût IA, plutôt que d'être exclu).
const MAX_AI_ITEMS_PER_CATEGORY = 200;

// Exporté pour le worker (voir worker/index.ts) : sert à vérifier si une
// édition existe déjà pour aujourd'hui avant de déclencher une génération de
// secours à midi, avec exactement le même calcul de "date" que celui utilisé
// ici pour créer une nouvelle édition — pas de risque de décalage de fuseau
// entre les deux. Jour calendaire en heure de Paris (comme todayRangeInTz
// utilisé pour scoper le CONTENU de l'édition) — PAS le jour UTC brut, qui
// affichait encore "hier" comme date d'édition entre 00h et 01h/02h heure de
// Paris alors que le contenu était déjà celui d'aujourd'hui.
export function todayDateOnly(): Date {
  return todayDateOnlyInTz("Europe/Paris");
}

/**
 * Condition Prisma réutilisable définissant quels articles sont éligibles à
 * l'impression IA — INDÉPENDANTE d'« En direct » (SelectedCategory /
 * Article.included) : l'IA travaille directement sur tout le vivier récupéré
 * depuis FreshRSS, qu'une catégorie soit cochée pour En direct ou non (voir
 * fetchNewItemsFromSelectedCategories, qui récupère déjà TOUS les items).
 * Seuls deux réglages restent respectés ici : la case "Impression IA" propre
 * à chaque catégorie (AiPrintCategory, absence de ligne = activée par
 * défaut), et les flux explicitement blacklistés (ExcludedFeed) — un flux
 * exclu reste exclu partout, y compris de l'impression IA.
 */
async function getAiPrintEligibilityWhere() {
  const [disabled, excludedFeeds] = await Promise.all([
    prisma.aiPrintCategory.findMany({ where: { enabled: false }, select: { label: true } }),
    prisma.excludedFeed.findMany({ select: { freshrssId: true, label: true } })
  ]);
  const disabledLabels = disabled.map((c) => c.label);
  const excludedFeedIds = excludedFeeds.map((f) => f.freshrssId);
  const excludedFeedLabels = excludedFeeds.map((f) => f.label);

  const clauses: Record<string, unknown>[] = [];
  if (disabledLabels.length > 0) {
    clauses.push({ NOT: { categoryLabel: { in: disabledLabels } } });
  }
  if (excludedFeedIds.length > 0 || excludedFeedLabels.length > 0) {
    clauses.push({
      NOT: {
        OR: [
          { feedId: { in: excludedFeedIds } },
          { feedId: null, feedTitle: { in: excludedFeedLabels } }
        ]
      }
    });
  }
  return clauses.length > 0 ? { AND: clauses } : {};
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
 * Stocke une liste de RawItem en traitement brut (fallbackProcess, aucun
 * coût IA), dédupliqué par freshrssItemId — extrait de generateDailyEdition
 * pour être réutilisable par un balayage indépendant qui n'a pas besoin
 * d'une Edition à proprement parler (voir syncCustomFeeds dans
 * customFeeds.ts, appelé par le worker sur son propre intervalle, plus
 * fréquent que le cycle normal d'impression). editionId reste optionnel
 * (Article.editionId est nullable) : un balayage de fond n'a pas besoin de
 * créer une ligne Edition juste pour rattacher ses articles — ils restent
 * "aiRewritten: false" et seront de toute façon repris par la prochaine
 * vraie impression (IA ou pas), qui les rattachera à SA propre édition en
 * les réécrivant.
 */
export async function ingestRawItems(rawItems: RawItem[], editionId: string | null): Promise<void> {
  if (rawItems.length === 0) return;

  // Dates assainies AVANT insertion : une date illisible ("Invalid Date")
  // rejetée par Prisma faisait planter l'insertion — on la remplace par null
  // plutôt que de perdre l'article (même logique que safePublishedAt côté
  // flux perso, appliquée ici en dernier filet quel que soit le chemin
  // d'ingestion).
  const rows = rawItems.map((raw) => {
    const fallback = fallbackProcess(raw);
    const publishedAt =
      raw.publishedAt && !isNaN(new Date(raw.publishedAt).getTime()) ? raw.publishedAt : null;
    return {
      freshrssItemId: raw.freshrssItemId,
      feedId: raw.feedId,
      feedTitle: raw.feedTitle,
      categoryLabel: raw.categoryLabel,
      sourceUrl: raw.sourceUrl,
      sourceTitle: raw.sourceTitle,
      sourceExcerpt: raw.sourceExcerpt,
      imageUrl: raw.imageUrl,
      publishedAt,
      processed: true,
      included: raw.included,
      headline: fallback.headline,
      summary: fallback.summary,
      category: fallback.category,
      priorityScore: fallback.priorityScore,
      aiRewritten: false,
      editionId: editionId ?? undefined
    };
  });

  // UNE requête pour tout le lot au lieu d'un upsert PAR article (des
  // centaines de requêtes séquentielles sur une grosse journée) :
  // createMany + skipDuplicates est strictement équivalent à l'ancien
  // upsert `update: {}` (les articles déjà en base ne sont jamais retouchés,
  // pour ne pas écraser le travail éditorial — voir le commentaire au-dessus).
  try {
    await prisma.article.createMany({ data: rows, skipDuplicates: true });
  } catch (batchErr) {
    // Repli : si le lot ENTIER est rejeté (un item malformé passé entre les
    // mailles de l'assainissement ci-dessus), on réinsère item par item pour
    // ne perdre QUE le coupable — même garantie qu'avant, le coût par item
    // n'est payé que dans ce cas rare.
    await writeLog(
      "warn",
      "edition",
      `Insertion groupée rejetée (${rows.length} article(s)) — repli item par item.`,
      (batchErr as Error)?.message
    );
    for (const row of rows) {
      try {
        await prisma.article.createMany({ data: [row], skipDuplicates: true });
      } catch (err) {
        await writeLog(
          "error",
          "edition",
          `Article ignoré : "${row.sourceTitle}"`,
          `${row.freshrssItemId} — ${(err as Error)?.message}`
        );
      }
    }
  }
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

  // Tokens réellement consommés par CETTE génération (tous appels IA
  // confondus) — figé sur l'Edition à la fin, affiché dans les statistiques
  // admin. Reste à 0 en mode "Aspirer les news" (forceNoAi) ou sans clé IA.
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  // Réglages IA lus UNE SEULE FOIS pour toute cette génération. En particulier
  // le style d'écriture : si /admin/settings est réglé sur "random", le style
  // réel est tiré au hasard ICI et réutilisé pour TOUS les appels IA de cette
  // impression (réécriture par lots + curation de la une) — sans ça, chaque
  // lot tirerait son propre style et l'impression du jour changerait de ton
  // d'un article à l'autre. Figé aussi sur l'Edition (voir plus bas) pour que
  // les archives montrent le style RÉELLEMENT utilisé, jamais "random" tel quel.
  const genSettings = await getSettings();
  const genProvider = genSettings.aiProvider === "gemini" ? "gemini" : "anthropic";
  const effectiveWritingStyle = options.forceNoAi ? null : resolveWritingStyle(genSettings.writingStyle);

  const edition = await prisma.edition.create({
    data: { date, status: "draft" }
  });

  await cleanExistingHtmlArtifacts();
  await pruneOldArticles();

  let rawItems: RawItem[];
  try {
    rawItems = await fetchNewItemsFromSelectedCategories();
    await writeLog("info", "freshrss", `${rawItems.length} nouvel(aux) item(s) récupéré(s) depuis FreshRSS.`);
  } catch (err) {
    // Rethrow préservé tel quel (comportement inchangé, voir worker/index.ts
    // qui logue déjà l'échec en console) — writeLog en plus pour que ce même
    // échec soit aussi visible dans /admin/logs, pas seulement Coolify.
    await writeLog(
      "error",
      "freshrss",
      "Échec de récupération FreshRSS (auth/connexion)",
      (err as Error)?.message
    );
    throw err;
  }

  // Contenu à afficher : les articles publiés AUJOURD'HUI (Paris) s'il y en
  // a — sinon on retombe sur le jour le plus récent qui en a, plutôt que de
  // laisser la une figée indéfiniment sur un jour périmé (rien publié
  // depuis hier sur les flux sélectionnés). Sans ce repli, un "Lancer
  // l'impression" manuel un jour calme ne rafraîchissait RIEN à l'écran —
  // pas même une image corrigée entre-temps par cleanExistingHtmlArtifacts
  // ci-dessus, puisque cette correction ne peut atteindre l'affichage qu'à
  // travers une NOUVELLE photo figée (EditionArticle).
  const aiPrintWhere = await getAiPrintEligibilityWhere();

  let contentRange = todayRange;
  const hasToday = await prisma.article.count({ where: { publishedAt: todayRange, ...aiPrintWhere } });
  if (hasToday === 0) {
    const mostRecent = await prisma.article.findFirst({
      where: { publishedAt: { not: null }, ...aiPrintWhere },
      orderBy: { publishedAt: "desc" },
      select: { publishedAt: true }
    });
    if (mostRecent?.publishedAt) {
      contentRange = dayRangeInTz(mostRecent.publishedAt, PARIS_TZ);
    }
  }

  if (rawItems.length === 0) {
    const existingForContent = await prisma.article.count({ where: { publishedAt: contentRange, ...aiPrintWhere } });
    if (existingForContent === 0) {
      await writeLog(
        "info",
        "edition",
        "Vérifié : aucun nouvel item et rien à afficher pour l'instant — édition laissée en brouillon."
      );
      return { editionId: edition.id, articleCount: 0 };
    }
  }

  // Stockage initial de TOUS les items tout juste récupérés, systématiquement
  // en traitement brut (fallbackProcess, aucun coût IA ici) — la sélection IA
  // proprement dite se fait juste après, séparément, sur TOUT le vivier du
  // jour pas encore réécrit (voir plus bas) : un article aspiré plus tôt
  // dans la journée par la veille sans IA (toutes les 3h) doit pouvoir être
  // choisi par l'IA lors d'une impression complète plus tard, pas seulement
  // les items tout juste récupérés par CET appel précis.
  await ingestRawItems(rawItems, edition.id);

  await syncMedalFlags();

  // Sélection IA : TOUT le vivier "included" du jour PAS ENCORE réécrit par
  // l'IA (aiRewritten: false) — pas seulement les items tout juste récupérés
  // ci-dessus, pour qu'une impression du soir couvre la journée complète
  // (y compris les articles déjà stockés en brut par l'aspiration de secours
  // toutes les 3h). MAX_AI_ITEMS_PER_CATEGORY n'est qu'un garde-fou de
  // sécurité par catégorie, pas une curation — jamais en mode "Aspirer les
  // news" (forceNoAi).
  if (!options.forceNoAi) {
    const pending = await prisma.article.findMany({
      where: { publishedAt: contentRange, aiRewritten: false, ...aiPrintWhere },
      orderBy: { publishedAt: "desc" }
    });

    const pendingAsRawItems: RawItem[] = pending.map((a) => ({
      freshrssItemId: a.freshrssItemId,
      feedId: a.feedId,
      feedTitle: a.feedTitle,
      categoryLabel: a.categoryLabel,
      sourceUrl: a.sourceUrl,
      sourceTitle: a.sourceTitle,
      sourceExcerpt: a.sourceExcerpt,
      imageUrl: a.imageUrl,
      publishedAt: a.publishedAt,
      included: a.included
    }));

    const { aiItems } = capPerCategory(pendingAsRawItems, MAX_AI_ITEMS_PER_CATEGORY);

    if (aiItems.length > 0) {
      const processedAi: ProcessedArticle[] = await processArticles(
        aiItems,
        options,
        usage,
        effectiveWritingStyle ?? undefined
      );
      const idByFreshrssId = new Map(pending.map((a) => [a.freshrssItemId, a.id]));

      await Promise.all(
        aiItems.map((item, i) => {
          const articleId = idByFreshrssId.get(item.freshrssItemId);
          if (!articleId) return Promise.resolve();
          const ai = processedAi[i];
          return prisma.article.update({
            where: { id: articleId },
            data: {
              headline: ai.headline,
              summary: ai.summary,
              category: ai.category,
              priorityScore: ai.priorityScore,
              aiRewritten: ai.aiRewritten
            }
          });
        })
      );

      await writeLog(
        "info",
        "ai",
        `${aiItems.length} article(s) réécrits par l'IA ce passage ` +
          `(plafond ${MAX_AI_ITEMS_PER_CATEGORY}/catégorie, sur ${pending.length} en attente).`
      );
    } else {
      await writeLog("info", "ai", "Vérifié : aucun article en attente de réécriture IA ce passage.");
    }
  }

  // Une passe IA dédiée, une seule fois par génération (jamais en mode
  // "Aspirer les news" sans IA) : recalcule priorityScore sur TOUS les
  // articles inclus de l'édition en les comparant vraiment entre eux,
  // plutôt que par lots isolés de 12 comme processArticles — c'est ce score
  // qui détermine ensuite les articles "à la une" sur la page d'accueil.
  if (!options.forceNoAi) {
    await curateFrontPageScores(contentRange, usage, effectiveWritingStyle ?? undefined);
  }

  const heroArticle = await prisma.article.findFirst({
    where: { publishedAt: contentRange, ...aiPrintWhere },
    orderBy: { priorityScore: "desc" }
  });

  const articleCount = await prisma.article.count({ where: { publishedAt: contentRange, ...aiPrintWhere } });

  // Photo figée (EditionArticle) de la une IA telle qu'elle est À CET
  // INSTANT précis — mêmes critères de qualification que la page d'accueil
  // et /archive (aiRewritten + éligibilité impression IA, voir
  // getAiPrintEligibilityWhere). Copiée une fois pour toutes ici : contrairement
  // à Article, ces lignes ne seront plus jamais modifiées ni réattribuées à
  // une autre édition, donc cette génération reste consultable telle quelle
  // dans les archives même après d'autres régénérations le même jour.
  //
  // JAMAIS en mode "Aspirer les news" (forceNoAi) : aiRewritten vit sur
  // l'ARTICLE, pas sur l'édition — un article déjà réécrit par l'IA plus tôt
  // dans la journée reste "aiRewritten: true" indéfiniment, donc CHAQUE passage
  // sans IA (toutes les quelques minutes/heures selon l'intervalle réglé)
  // retrouvait les mêmes articles déjà qualifiés et photographiait une
  // NOUVELLE édition "published" identique à la précédente — vu en usage réel :
  // /archive se remplissait de dizaines d'entrées dupliquées à "0 tokens", une
  // par passage, sans aucun contenu réellement nouveau. Un passage sans IA ne
  // doit qu'ingérer les articles bruts (déjà fait plus haut), jamais réimprimer
  // une édition.
  const qualifyingArticles = options.forceNoAi
    ? []
    : await prisma.article.findMany({
        where: {
          publishedAt: contentRange,
          processed: true,
          aiRewritten: true,
          ...aiPrintWhere
        }
      });

  // Second verrou anti-doublon (voir celui sur forceNoAi juste au-dessus) :
  // même en génération IA normale, si le jeu d'articles qualifiés est
  // EXACTEMENT le même (mêmes empreintes de contenu, voir
  // ArticleSnapshotContent.contentHash) que la dernière édition déjà publiée
  // CE JOUR-LÀ, on ne republie pas un doublon strictement identique — un
  // déclenchement répété ("Lancer l'impression" cliqué plusieurs fois, ou un
  // planning trop rapproché) sans rien de nouveau entre les deux ne doit pas
  // non plus empiler des entrées identiques dans /archive.
  let isDuplicateOfLastPublished = false;
  if (qualifyingArticles.length > 0) {
    const newHashes = qualifyingArticles.map((a) => snapshotContentHash(a)).sort();
    const lastPublished = await prisma.edition.findFirst({
      where: { date, status: "published", id: { not: edition.id } },
      orderBy: { generatedAt: "desc" },
      include: { snapshot: { include: { content: true } } }
    });
    if (lastPublished) {
      const oldHashes = lastPublished.snapshot.map((s) => s.content.contentHash).sort();
      isDuplicateOfLastPublished =
        oldHashes.length === newHashes.length && oldHashes.every((h, i) => h === newHashes[i]);
    }
  }

  // "published" exige au moins un article RÉELLEMENT réécrit par l'IA (donc
  // au moins une ligne EditionArticle créée juste après), ET que ce ne soit
  // pas un doublon strict de la dernière édition publiée (voir ci-dessus).
  // Sans le premier garde-fou, un passage où TOUS les appels IA échouent
  // (mauvais modèle Gemini, clé invalide, panne...) marquait quand même
  // l'édition "published" (des articles bruts existent bien pour le jour),
  // avec une photo figée totalement VIDE : la page d'accueil affiche alors
  // "Aucune édition générée", ou pire, une édition précédente non vide
  // disparaît de la une au profit de cette coquille vide qui devient la plus
  // récente "published".
  const status = qualifyingArticles.length > 0 && !isDuplicateOfLastPublished ? "published" : "draft";

  // Coût estimé à partir des tokens réellement consommés (usage, rempli au
  // fil des appels IA ci-dessus) et du modèle réglé pour CETTE génération —
  // voir aiPricing.ts. 0/0/0 en mode "Aspirer les news" ou sans clé IA.
  // Réutilise genSettings/genProvider lus une seule fois en tête de fonction
  // (voir plus haut), plutôt qu'un second appel getSettings() qui pourrait en
  // théorie lire un réglage changé entre-temps en pleine génération.
  const provider = genProvider;
  const aiModelUsed = provider === "gemini" ? genSettings.geminiModel : genSettings.anthropicModel;
  const estimatedCostUsd = estimateCostUsd(provider, aiModelUsed, usage.inputTokens, usage.outputTokens);

  await prisma.edition.update({
    where: { id: edition.id },
    data: {
      headline: heroArticle?.headline ?? edition.headline,
      status,
      // Vivier total (avant plafond IA par catégorie) — voir schema.prisma,
      // affiché à côté du compte final retenu sur la une (snapshot.length).
      sourcePoolCount: articleCount,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd,
      // Métadonnées IA figées pour CETTE génération précise, affichées dans
      // /archive à côté de la date — null en mode "Aspirer les news"
      // (forceNoAi) puisqu'aucune IA n'est alors intervenue (afficher un
      // fournisseur/modèle ici serait trompeur, laisserait croire qu'une IA a
      // tourné). writingStyle est la valeur RÉSOLUE (jamais "random" tel
      // quel) — voir resolveWritingStyle en tête de fonction.
      aiProvider: options.forceNoAi ? null : provider,
      aiModel: options.forceNoAi ? null : aiModelUsed,
      writingStyle: options.forceNoAi ? null : effectiveWritingStyle
    }
  });

  await writeLog(
    status === "published" ? "info" : isDuplicateOfLastPublished ? "info" : "warn",
    "edition",
    `Génération terminée — statut "${status}", ${qualifyingArticles.length} article(s) sur la une` +
      (options.forceNoAi
        ? " (mode Télégraphier les news, sans IA)."
        : isDuplicateOfLastPublished
          ? " (identique à la dernière édition publiée — non republiée, pas de doublon dans les archives)."
          : ` (${usage.inputTokens + usage.outputTokens} tokens).`)
  );

  // Le contenu réel (texte, image, score...) est stocké une seule fois par
  // combinaison distincte dans ArticleSnapshotContent (déduplication par
  // empreinte) — EditionArticle ne fait plus que lier une édition à ce
  // contenu. Si un article n'a strictement pas changé depuis la dernière
  // régénération du jour (même score IA, même résumé, même médaille...), sa
  // nouvelle ligne EditionArticle réutilise le contenu déjà existant au lieu
  // d'en dupliquer une copie complète.
  for (const a of isDuplicateOfLastPublished ? [] : qualifyingArticles) {
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
  // TOUJOURS purger les brouillons VIDES (aucune photo figée) de plus de 2
  // jours, indépendamment du réglage de rétention : chaque passage
  // d'aspiration sans IA (potentiellement toutes les heures en mode manuel)
  // crée sa propre ligne Edition "draft" — sans cette purge, des dizaines de
  // coquilles vides s'accumulaient chaque jour pour toujours. Les brouillons
  // récents (< 2 jours) sont conservés : le plus frais sert encore de
  // référence de date au masthead de /direct.
  const draftCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const { count: emptyDraftCount } = await prisma.edition.deleteMany({
    where: { status: "draft", generatedAt: { lt: draftCutoff }, snapshot: { none: {} } }
  });
  if (emptyDraftCount > 0) {
    await writeLog("info", "edition", `${emptyDraftCount} brouillon(s) vide(s) purgé(s).`);
  }

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
    await writeLog("info", "edition", `Rétention (${retentionDays} j) : ${count} article(s) purgé(s).`);
  }

  // Les ÉDITIONS aussi suivent la rétention : chaque génération crée sa
  // propre ligne Edition (voir generateDailyEdition), donc sans purge la
  // table grossit indéfiniment — y compris les brouillons vides d'un passage
  // sans nouveauté. La cascade EditionArticle suit automatiquement ;
  // Article.editionId passe à null (SET NULL) sans toucher à l'article.
  const { count: editionCount } = await prisma.edition.deleteMany({
    where: { date: { lt: cutoff } }
  });
  if (editionCount > 0) {
    await writeLog("info", "edition", `Rétention (${retentionDays} j) : ${editionCount} édition(s) purgée(s).`);
  }

  await pruneOrphanSnapshotContents();
}

/**
 * Supprime les contenus figés (ArticleSnapshotContent) que plus AUCUNE
 * EditionArticle ne référence — ils deviennent orphelins quand la dernière
 * édition qui pointait dessus est supprimée (purge de rétention ci-dessus, ou
 * suppression manuelle dans /archive), et restaient sinon en base pour
 * toujours puisqu'aucune FK ne les rattache à rien d'autre.
 */
export async function pruneOrphanSnapshotContents(): Promise<void> {
  try {
    const { count } = await prisma.articleSnapshotContent.deleteMany({
      where: { editionArticles: { none: {} } }
    });
    if (count > 0) {
      await writeLog("info", "edition", `${count} contenu(s) d'archive orphelin(s) purgé(s).`);
    }
  } catch (err) {
    // Best-effort : un raté ici ne doit jamais bloquer l'opération appelante.
    console.error("[edition] Échec de la purge des contenus orphelins :", (err as Error)?.message);
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
async function curateFrontPageScores(
  todayRange: { gte: Date; lt: Date },
  usage?: TokenUsage,
  writingStyleOverride?: string
): Promise<void> {
  // Carte "Impression IA" de /admin/categories (AiPrintCategory, indépendante
  // d'En Direct) : les catégories décochées là ne doivent même pas être
  // soumises à cette passe (ni affichées sur la une, ni comparées aux
  // autres) — inutile de dépenser des tokens dessus.
  const aiPrintWhere = await getAiPrintEligibilityWhere();

  const todaysArticles = await prisma.article.findMany({
    where: {
      publishedAt: todayRange,
      processed: true,
      // La une doit être une vraie "impression IA" : les articles tombés en
      // fallback (plafond par catégorie, pas de clé IA...) ne sont ni notés
      // ni affichés sur la une, même s'ils restent visibles ailleurs.
      aiRewritten: true,
      ...aiPrintWhere
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
    })),
    usage,
    writingStyleOverride
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
  await writeLog("info", "ai", `Une du jour recalculée par l'IA pour ${scores.size} article(s).`);
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
  // Ne charge plus TOUTE la table (texte complet de chaque article transféré
  // vers Node à chaque génération — de plus en plus coûteux à mesure que la
  // base grossit) : seuls les articles susceptibles d'avoir quelque chose à
  // corriger sont remontés. Trois familles de candidats :
  //   1. image manquante ou favicon de repli (rattrapage og:image) —
  //      détectable en SQL directement ;
  //   2. HTML résiduel (looksLikeHtml cherche "<balise" ou "&lt;") —
  //      préfiltré en SQL par un simple "contient < ou &lt;" (léger
  //      sur-ensemble, le test JS précis retranche ensuite) ;
  //   3. chrome de tête (stripLeadingChrome, pur JS, non exprimable en SQL) —
  //      couvert par une fenêtre récente sur fetchedAt : ce nettoyage tourne
  //      à chaque génération (au moins quotidienne), donc tout article plus
  //      vieux que la fenêtre est déjà passé plusieurs fois par ici et est
  //      forcément propre.
  const RECENT_WINDOW_DAYS = 14;
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await prisma.article.findMany({
    where: {
      OR: [
        { imageUrl: null },
        { imageUrl: { contains: "google.com/s2/favicons" } },
        { sourceTitle: { contains: "<" } },
        { sourceExcerpt: { contains: "<" } },
        { headline: { contains: "<" } },
        { summary: { contains: "<" } },
        { sourceTitle: { contains: "&lt;" } },
        { sourceExcerpt: { contains: "&lt;" } },
        { headline: { contains: "&lt;" } },
        { summary: { contains: "&lt;" } },
        { fetchedAt: { gte: recentCutoff } }
      ]
    },
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

    // Rattrapage rétroactif pour les articles déjà en base AVANT l'ajout de
    // stripLeadingChrome (ex. Korben) : leur sourceExcerpt/summary n'a pas
    // de HTML résiduel (looksLikeHtml=false, déjà passé par stripHtml au
    // fetch), mais commence quand même par du chrome de page (pub, byline,
    // tags, "Écouter cet article"...) — retesté à chaque génération jusqu'à
    // ce que ce soit propre.
    const chromeDirty =
      (!!article.sourceExcerpt && stripLeadingChrome(article.sourceExcerpt) !== article.sourceExcerpt) ||
      (!!article.summary && stripLeadingChrome(article.summary) !== article.summary);

    let backfilledImage: string | null = ogImageById.get(article.id) ?? null;

    // Toujours rien — favicon du site en dernier recours (pas de requête
    // réseau de notre côté, juste une URL construite), seulement si
    // l'article n'a vraiment aucune image (ne pas remplacer une image déjà
    // correcte, ni reposer un favicon déjà en place).
    if (!article.imageUrl && !backfilledImage && article.sourceUrl) {
      backfilledImage = faviconFallback(article.sourceUrl);
    }

    if (!dirty && !chromeDirty && !backfilledImage) continue;

    await prisma.article.update({
      where: { id: article.id },
      data: {
        sourceTitle: article.sourceTitle ? stripHtml(article.sourceTitle) : article.sourceTitle,
        sourceExcerpt: article.sourceExcerpt ? stripLeadingChrome(stripHtml(article.sourceExcerpt)) : article.sourceExcerpt,
        headline: article.headline ? stripHtml(article.headline) : article.headline,
        summary: article.summary ? stripLeadingChrome(stripHtml(article.summary)) : article.summary,
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
