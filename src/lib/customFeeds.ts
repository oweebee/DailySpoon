import Parser from "rss-parser";
import { prisma } from "./prisma";
import { getSettings } from "./settings";
import { stripHtml, extractFirstImageSrc, stripLeadingChrome, isAlreadyMorssUrl } from "./text";
import { fetchOgMeta, faviconFallback, type RawItem } from "./freshrss";
import { ingestRawItems } from "./generateEdition";
import { writeLog } from "./logger";

/**
 * Flux RSS/Atom ajoutés à la main depuis /admin/categories (CustomFeed),
 * SANS passer par FreshRSS — utile pour un flux qu'on ne veut pas gérer
 * côté FreshRSS, ou en dépannage si FreshRSS est indisponible. Récupérés au
 * même intervalle GLOBAL pour tous (Settings.customFeedsIntervalMinutes),
 * et retraités exactement comme les items FreshRSS (même RawItem, même
 * fallbackProcess en aval, voir generateEdition.ts) — traités "au même
 * titre" partout dans l'app.
 *
 * Id synthétiques réutilisés directement comme freshrssId dans les tables
 * de réglages existantes (SelectedCategory/ExcludedFeed/MedalFeed/
 * AiPrintCategory), pour éviter toute logique parallèle en aval :
 *   - catégorie personnalisée -> "custom-cat:<CustomCategory.id>"
 *   - flux personnalisé       -> "custom-feed:<CustomFeed.id>"
 */
export function customCategoryFreshrssId(categoryId: string): string {
  return `custom-cat:${categoryId}`;
}
export function customFeedFreshrssId(feedId: string): string {
  return `custom-feed:${feedId}`;
}

/**
 * Résout l'id/le libellé de rubrique effectifs d'un flux personnalisé,
 * qu'il soit rattaché à une CustomCategory (customCategoryId) ou
 * directement à une vraie catégorie FreshRSS existante
 * (freshrssCategoryId/Label) — voir le commentaire sur CustomFeed dans
 * schema.prisma. Utilisé aussi bien par l'ingestion (fetchCustomFeedItems)
 * que par les routes admin (résolution d'affichage).
 */
export function resolveFeedCategory(feed: {
  customCategoryId: string | null;
  customCategory?: { id: string; label: string } | null;
  freshrssCategoryId: string | null;
  freshrssCategoryLabel: string | null;
}): { categoryFreshrssId: string; categoryLabel: string; isFreshrssCategory: boolean } {
  if (feed.customCategoryId) {
    return {
      categoryFreshrssId: customCategoryFreshrssId(feed.customCategoryId),
      categoryLabel: feed.customCategory?.label ?? "Catégorie personnalisée",
      isFreshrssCategory: false
    };
  }
  return {
    categoryFreshrssId: feed.freshrssCategoryId ?? "",
    categoryLabel: feed.freshrssCategoryLabel ?? "Sans catégorie",
    isFreshrssCategory: Boolean(feed.freshrssCategoryId)
  };
}

/**
 * Crée une nouvelle catégorie personnalisée et la rend visible immédiatement
 * (upsert SelectedCategory, comme si l'utilisateur venait de la cocher) —
 * factorisé ici car appelé à la fois par /api/admin/custom-categories
 * (création autonome) et /api/admin/custom-feeds (création "à la volée"
 * depuis le formulaire d'ajout de flux).
 */
export async function createCustomCategoryRecord(label: string) {
  const maxOrder = await prisma.customCategory.aggregate({ _max: { order: true } });
  const category = await prisma.customCategory.create({
    data: { label, order: (maxOrder._max.order ?? -1) + 1 }
  });

  const freshrssId = customCategoryFreshrssId(category.id);
  const maxSelectedOrder = await prisma.selectedCategory.aggregate({ _max: { order: true } });
  await prisma.selectedCategory.upsert({
    where: { freshrssId },
    update: { label },
    create: { freshrssId, label, order: (maxSelectedOrder._max.order ?? -1) + 1 }
  });

  return category;
}

/**
 * Recalcule et applique immédiatement le flag `included` de TOUS les
 * articles déjà en base pour les flux perso rattachés à cette catégorie
 * FreshRSS précise — appelé après avoir basculé
 * DisabledCustomFeedsCategory pour cette catégorie (voir
 * /api/admin/categories, POST customFeedsEnabled). Recalcule proprement à
 * partir des TROIS conditions réelles (catégorie sélectionnée, flux non
 * exclu individuellement, bascule groupée) plutôt que d'écraser
 * aveuglément à true/false — un flux individuellement exclu (ExcludedFeed)
 * reste exclu même si on réactive la bascule groupée.
 */
export async function recomputeIncludedForFreshrssCategory(freshrssCategoryId: string): Promise<void> {
  const [selected, excludedFeeds, disabled, feeds] = await Promise.all([
    prisma.selectedCategory.findMany({ select: { freshrssId: true } }),
    prisma.excludedFeed.findMany({ select: { freshrssId: true } }),
    prisma.disabledCustomFeedsCategory.findUnique({ where: { freshrssCategoryId } }),
    prisma.customFeed.findMany({ where: { freshrssCategoryId } })
  ]);
  const selectedIds = new Set(selected.map((s) => s.freshrssId));
  const excludedIds = new Set(excludedFeeds.map((e) => e.freshrssId));
  const categoryOk = selectedIds.has(freshrssCategoryId) && !disabled;

  for (const feed of feeds) {
    const feedFreshrssId = customFeedFreshrssId(feed.id);
    const included = categoryOk && !excludedIds.has(feedFreshrssId);
    await prisma.article.updateMany({ where: { feedId: feedFreshrssId }, data: { included } });
  }
}

/**
 * Passe d'auto-correction GLOBALE, appelée à chaque tick du worker (voir
 * syncCustomFeeds ci-dessous) — recalcule `included` pour TOUS les articles
 * déjà en base issus de flux personnalisés, à partir des trois conditions
 * réelles actuelles (catégorie sélectionnée, flux non exclu, bascule
 * groupée), pour les DEUX types de rattachement (CustomCategory ET vraie
 * catégorie FreshRSS confondus, via resolveFeedCategory).
 *
 * Nécessaire en complément de recomputeIncludedForFreshrssCategory
 * (déclenchée ponctuellement sur certaines actions admin précises) : si un
 * article a été ingéré une fois avec included=false à cause d'un état
 * transitoire (catégorie pas encore cochée, migration pas encore appliquée,
 * bug corrigé depuis...), `ingestRawItems` ne le retouche plus jamais après
 * coup (upsert en `update: {}` pour ne pas écraser le travail éditorial —
 * voir generateEdition.ts) : sans cette passe, l'article restait caché pour
 * toujours même une fois la config redevenue correcte. Coût négligeable :
 * uniquement des requêtes DB indexées, aucun appel réseau, un seul passage
 * par flux personnalisé existant (généralement une poignée).
 */
export async function recomputeAllCustomFeedIncluded(): Promise<void> {
  const [selected, excludedFeeds, disabledCategories, feeds] = await Promise.all([
    prisma.selectedCategory.findMany({ select: { freshrssId: true } }),
    prisma.excludedFeed.findMany({ select: { freshrssId: true } }),
    prisma.disabledCustomFeedsCategory.findMany({ select: { freshrssCategoryId: true } }),
    prisma.customFeed.findMany({ include: { customCategory: true } })
  ]);
  if (feeds.length === 0) return;

  const selectedIds = new Set(selected.map((s) => s.freshrssId));
  const excludedIds = new Set(excludedFeeds.map((e) => e.freshrssId));
  const disabledCategoryIds = new Set(disabledCategories.map((d) => d.freshrssCategoryId));

  for (const feed of feeds) {
    const feedFreshrssId = customFeedFreshrssId(feed.id);
    const { categoryFreshrssId } = resolveFeedCategory(feed);
    const groupDisabled = Boolean(feed.freshrssCategoryId) && disabledCategoryIds.has(feed.freshrssCategoryId!);
    const included = selectedIds.has(categoryFreshrssId) && !excludedIds.has(feedFreshrssId) && !groupDisabled;
    // "included: { not: included }" : n'écrit rien si déjà cohérent, pour ne
    // pas faire une passe UPDATE coûteuse à vide sur chaque tick.
    await prisma.article.updateMany({
      where: { feedId: feedFreshrssId, included: { not: included } },
      data: { included }
    });
  }
}

const parser = new Parser({
  // Certaines URL de flux perso pointent DIRECTEMENT vers une instance morss
  // (voir /admin/categories, champ URL du flux) plutôt que vers la source
  // d'origine — morss scrape/reformate le contenu à la volée avant de
  // répondre, donc nettement plus lent qu'un flux RSS brut. 10s puis 20s se
  // sont révélés trop courts en usage réel ("Libération" via morss :
  // "Request timed out"). 45s laisse la marge nécessaire à morss sans
  // bloquer indéfiniment un flux réellement injoignable, et reste sous le
  // timeout par défaut d'un reverse proxy typique (60s).
  timeout: 45000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    // Vu en usage réel sur un flux passant par une instance morss : le
    // serveur logue bien "200" avec tout le contenu envoyé quasi
    // instantanément, mais le client restait bloqué jusqu'au timeout —
    // symptôme classique d'une connexion keep-alive/chunked mal terminée
    // côté serveur (le client attend une fin de flux qui ne vient jamais
    // alors que les données utiles sont déjà toutes arrivées). Demander
    // explicitement la fermeture de la connexion évite de rester bloqué sur
    // ce genre de socket qui ne se referme pas proprement.
    Connection: "close"
  }
});

/** Meilleur contenu disponible dans un item rss-parser : content:encoded
 *  (texte complet, souvent absent des flux minimalistes) sinon content
 *  (mappé depuis <description> par rss-parser) sinon summary. */
function bestRawContent(item: Parser.Item): string {
  const withEncoded = item as unknown as { "content:encoded"?: string };
  return withEncoded["content:encoded"] || item.content || item.summary || "";
}

/** Titre de secours pour un item sans <title> exploitable (dépêches AFP
 *  redistribuées, vu en usage réel) : première phrase de l'extrait, coupée
 *  à un mot entier si trop longue — pas de troncature en plein mot. Renvoie
 *  "" si l'extrait lui-même est vide (rien à en tirer). */
function deriveTitleFromExcerpt(excerpt: string): string {
  if (!excerpt) return "";
  const MAX_LEN = 100;
  const sentenceEnd = excerpt.search(/[.!?](?:\s|$)/);
  let candidate = sentenceEnd > 0 && sentenceEnd < MAX_LEN ? excerpt.slice(0, sentenceEnd + 1) : excerpt;
  if (candidate.length > MAX_LEN) {
    candidate = candidate.slice(0, MAX_LEN).replace(/\s+\S*$/, "") + "…";
  }
  return candidate.trim();
}

/** Certains flux (balisage Atom/RSS non standard, titre en CDATA imbriqué...)
 *  font remonter un `item.title` qui n'est PAS une chaîne malgré le typage
 *  de rss-parser (objet, tableau...) — appeler `.trim()` dessus plante alors
 *  ("title?.trim is not a function", vu en usage réel sur un flux réel).
 *  Convertit explicitement en chaîne avant de nettoyer, quel que soit le
 *  type réellement reçu. */
/** Convertit `item.isoDate`/`item.pubDate` en Date valide, ou null si le
 *  flux fournit une date illisible (vu en usage réel : `new Date(...)`
 *  produisait un "Invalid Date" passé tel quel à Prisma, qui rejette
 *  l'upsert ENTIER avec "Provided Date object is invalid" — et donc, avant
 *  le fix de résilience sur ingestRawItems, bloquait aussi tous les autres
 *  articles du même lot). */
function safePublishedAt(item: Parser.Item): Date | null {
  const raw = item.isoDate || item.pubDate;
  if (!raw) return null;
  const date = new Date(raw);
  return isNaN(date.getTime()) ? null : date;
}

export function safeTitle(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  if (typeof value === "object") {
    // Forme typique produite par le parseur XML sous-jacent pour un élément
    // à contenu mixte (ex. balise avec attributs ET texte) : { _: "texte",
    // $: {...attributs} } — tenter cette clé avant toute conversion.
    const obj = value as Record<string, unknown>;
    const inner = obj["_"] ?? obj["#text"];
    if (typeof inner === "string") return inner.trim();
    // Repli défensif : un objet sans prototype exploitable (ex.
    // Object.create(null), certains nœuds XML mal formés) fait planter
    // String() avec "Cannot convert object to primitive value" — vu en
    // usage réel sur un flux réel. On abandonne proprement plutôt que de
    // faire échouer tout le flux pour un seul titre illisible.
    try {
      return String(value).trim();
    } catch {
      return "";
    }
  }
  return String(value).trim();
}

function bestImageUrl(item: Parser.Item, rawContent: string): string | null {
  const enclosureUrl = item.enclosure?.url;
  if (enclosureUrl && (!item.enclosure?.type || item.enclosure.type.startsWith("image/"))) {
    return enclosureUrl;
  }
  return extractFirstImageSrc(rawContent);
}

/**
 * Récupère TOUS les nouveaux items de TOUS les flux personnalisés, avec le
 * même filtrage/formatage que côté FreshRSS (stripHtml, stripLeadingChrome,
 * repli og:image puis favicon). Auto-gaté par l'intervalle global : ne fait
 * réellement une requête réseau que si Settings.customFeedsLastFetchedAt +
 * customFeedsIntervalMinutes est dépassé — sinon retourne [] immédiatement.
 * Peut donc être appelé souvent (chaque tick du worker) sans surcharger les
 * flux sources.
 */
export async function fetchCustomFeedItems(force = false): Promise<RawItem[]> {
  const settings = await getSettings();
  const settingsRow = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const lastFetchedAt = settingsRow?.customFeedsLastFetchedAt ?? null;
  const intervalMs = settings.customFeedsIntervalMinutes * 60_000;

  // "force" (voir /api/admin/custom-feeds/sync, bouton "Forcer maintenant"
  // dans l'admin) contourne UNIQUEMENT ce gate d'intervalle global — sert à
  // diagnostiquer/tester immédiatement sans attendre, plutôt que de deviner
  // si le blocage vient de l'intervalle ou d'autre chose.
  if (!force && lastFetchedAt && Date.now() - lastFetchedAt.getTime() < intervalMs) {
    return []; // pas encore l'heure
  }

  const feeds = await prisma.customFeed.findMany({ include: { customCategory: true } });
  if (feeds.length === 0) {
    // Rien à faire — surtout NE PAS marquer le passage ici : le vérifier
    // coûte une seule requête DB (pas de réseau), donc autant réessayer à
    // chaque tick. Marquer customFeedsLastFetchedAt à "maintenant" alors
    // qu'aucun flux n'existe encore piégeait le TOUT PREMIER flux jamais créé
    // : l'horodatage restait "frais" (rafraîchi chaque minute par le worker
    // tant qu'il n'y avait aucun flux), donc dès qu'un flux apparaissait,
    // l'intervalle semblait déjà écoulé... alors qu'aucune récupération
    // réelle n'avait jamais eu lieu — le premier flux ajouté attendait alors
    // bêtement un intervalle complet avant sa toute première récupération.
    return [];
  }

  const [selected, excludedFeeds, disabledCategories] = await Promise.all([
    prisma.selectedCategory.findMany({ select: { freshrssId: true } }),
    prisma.excludedFeed.findMany({ select: { freshrssId: true } }),
    prisma.disabledCustomFeedsCategory.findMany({ select: { freshrssCategoryId: true } })
  ]);
  const selectedIds = new Set(selected.map((c) => c.freshrssId));
  const excludedFeedIds = new Set(excludedFeeds.map((f) => f.freshrssId));
  const disabledCategoryIds = new Set(disabledCategories.map((d) => d.freshrssCategoryId));

  const items: RawItem[] = [];

  for (const feed of feeds) {
    const feedFreshrssId = customFeedFreshrssId(feed.id);
    const { categoryFreshrssId, categoryLabel } = resolveFeedCategory(feed);
    // Bascule groupée (DisabledCustomFeedsCategory) : masque tous les flux
    // perso d'une catégorie FreshRSS d'un coup, sans toucher à ExcludedFeed
    // — ne s'applique qu'aux flux rattachés à une VRAIE catégorie FreshRSS
    // (freshrssCategoryId), une catégorie perso pure a déjà son propre
    // interrupteur dédié ("inclure la catégorie" sur la CustomCategory).
    const groupDisabled = Boolean(feed.freshrssCategoryId) && disabledCategoryIds.has(feed.freshrssCategoryId!);
    const included = selectedIds.has(categoryFreshrssId) && !excludedFeedIds.has(feedFreshrssId) && !groupDisabled;

    try {
      let parsed;
      try {
        parsed = await parser.parseURL(feed.url);
      } catch (directErr) {
        // Repli via morss (réglé dans /admin/settings), même mécanisme que
        // pour le fetch d'un article individuel (voir article-proxy) — utile
        // seulement pour un flux dont l'URL n'est PAS déjà elle-même une URL
        // morss : si le flux passe déjà PAR morss, l'échec vient de morss
        // lui-même (voir le timeout déjà augmenté ci-dessus pour ce cas), et
        // le relayer une seconde fois via morss ne ferait que refaire
        // exactement la même requête qui vient d'échouer — inutile, et ça
        // fait juste attendre un second timeout pour rien. Ne fait rien non
        // plus si ce réglage est vide.
        if (!settings.morssBaseUrl || isAlreadyMorssUrl(feed.url, settings.morssBaseUrl)) throw directErr;
        const strippedUrl = feed.url.replace(/^https?:\/\//, "");
        parsed = await parser.parseURL(`${settings.morssBaseUrl}/${strippedUrl}`);
      }

      let newForThisFeed = 0;
      for (const item of parsed.items) {
        const guid = item.guid || item.link || safeTitle(item.title);
        if (!guid) continue;
        const freshrssItemId = `${feedFreshrssId}:${guid}`;

        const exists = await prisma.article.findUnique({ where: { freshrssItemId }, select: { id: true } });
        if (exists) continue;

        const rawContent = bestRawContent(item);
        let excerpt = rawContent ? stripHtml(rawContent).trim() : (item.contentSnippet || "").trim();
        if (excerpt) excerpt = stripLeadingChrome(excerpt);

        const canonicalUrl = item.link || "";
        let imageUrl = bestImageUrl(item, rawContent);
        const rawTitle = safeTitle(item.title);

        // Un seul aller-retour réseau (fetchOgMeta) couvre TROIS besoins à la
        // fois : l'image manquante, le titre manquant (voir plus bas) ET
        // l'extrait manquant — évite de fetcher deux fois la même page.
        // Demandé pour les flux comme les dépêches AFP redistribuées
        // (fonction-publique.gouv.fr) qui n'ont AUCUN <title> par item : on
        // veut alors EXACTEMENT le même titre que celui affiché en ouvrant
        // l'article en grand (qui vient de ce même scraping de page), pas une
        // phrase devinée dans l'extrait. Un flux "lien seul" (aucun
        // content:encoded/summary/contentSnippet réel — ex. agrégateurs de
        // liens type "Self-Hosted Alternatives...") tombait sinon
        // systématiquement sur le texte générique "Aucun aperçu fourni par le
        // flux" alors que la page source a presque toujours une vraie meta
        // description exploitable.
        let ogTitle: string | null = null;
        if ((!imageUrl || !rawTitle || !excerpt) && canonicalUrl && included) {
          const meta = await fetchOgMeta(canonicalUrl);
          if (!imageUrl) imageUrl = meta.imageUrl;
          ogTitle = meta.title;
          if (!excerpt && meta.description) excerpt = meta.description;
        }
        if (!imageUrl && canonicalUrl) imageUrl = faviconFallback(canonicalUrl);

        items.push({
          freshrssItemId,
          feedId: feedFreshrssId,
          feedTitle: feed.title,
          categoryLabel,
          sourceUrl: canonicalUrl,
          sourceTitle: rawTitle || ogTitle || deriveTitleFromExcerpt(excerpt) || "(sans titre)",
          sourceExcerpt: excerpt || null,
          imageUrl,
          publishedAt: safePublishedAt(item),
          included
        });
        newForThisFeed++;
      }

      // Loggué même à 0 nouvel article (pas seulement en cas de nouveauté) —
      // sur demande explicite : voir la vérification tourner et réussir est
      // aussi une information utile ("tout va bien"), pas seulement les
      // échecs ou les nouveautés.
      await writeLog(
        "info",
        "custom-feeds",
        newForThisFeed > 0
          ? `"${feed.title}" : ${newForThisFeed} nouvel(aux) article(s) récupéré(s).`
          : `"${feed.title}" : vérifié, aucun nouvel article.`
      );

      await prisma.customFeed.update({
        where: { id: feed.id },
        data: { lastFetchedAt: new Date(), lastFetchError: null }
      });
    } catch (err) {
      const message = (err as Error)?.message || "Échec inconnu";
      // Remonté aussi dans /admin/categories (GET /api/admin/custom-feeds)
      // via lastFetchError — sans ça, un flux qui échoue ici en boucle
      // semblait juste "ne jamais apparaître en En direct", sans aucune
      // explication visible pour l'utilisateur (le seul indice restait un
      // log serveur Coolify). writeLog() couvre maintenant aussi /admin/logs.
      await writeLog("error", "custom-feeds", `Échec pour "${feed.title}"`, `${feed.url} — ${message}`);
      await prisma.customFeed
        .update({ where: { id: feed.id }, data: { lastFetchError: message } })
        .catch(() => {});
    }
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { customFeedsLastFetchedAt: new Date() },
    create: { id: "singleton", customFeedsLastFetchedAt: new Date() }
  });

  return items;
}

/**
 * Point d'entrée appelé périodiquement par le worker (voir worker/index.ts)
 * — récupère (si l'intervalle global est écoulé, sinon no-op immédiat) puis
 * stocke directement les nouveaux items en traitement brut, SANS créer de
 * ligne Edition (voir ingestRawItems) : ce balayage tourne sur son propre
 * intervalle, potentiellement bien plus fréquent que le cycle normal
 * d'impression (IA ou aspiration de secours), zéro coût IA dans tous les cas.
 */
export async function syncCustomFeeds(force = false): Promise<{ fetched: number }> {
  const items = await fetchCustomFeedItems(force);
  if (items.length > 0) await ingestRawItems(items, null);
  // Passe d'auto-correction à CHAQUE appel (donc chaque tick du worker, ~1x/
  // minute), indépendamment du gating réseau ci-dessus — coût DB seul, voir
  // le commentaire de recomputeAllCustomFeedIncluded.
  await recomputeAllCustomFeedIncluded().catch(async (err) => {
    await writeLog("error", "custom-feeds", "recomputeAllCustomFeedIncluded a échoué", (err as Error)?.message);
  });
  return { fetched: items.length };
}
