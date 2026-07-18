"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SpoonDivider } from "@/components/SpoonDivider";

// Bloc pliable/dépliable réutilisé pour CHAQUE grande section de la page
// admin (Statistiques, Impression IA, Catégories & flux, Flux personnalisés,
// Catégories personnalisées) — à ne pas confondre avec le pli PAR CATÉGORIE
// à l'intérieur de "Catégories & flux" (toggleExpanded/collapsed), qui reste
// indépendant. Ouvert par défaut à chaque chargement de page.
function CollapsibleSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-3 flex w-full items-center justify-center gap-2 border-y-2 border-ink py-1.5 font-display text-sm font-bold uppercase tracking-[0.3em] hover:bg-ink/5"
      >
        <span className="text-xs text-sepia">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && children}
    </div>
  );
}

type Category = {
  freshrssId: string;
  label: string;
  selected: boolean;
  order: number | null;
  frontPageEnabled: boolean;
  customFeedsEnabled: boolean;
};

type Feed = {
  freshrssId: string;
  title: string;
  categoryLabels: string[];
  included: boolean;
  medal: boolean;
};

type CustomFeedItem = {
  id: string;
  url: string;
  title: string;
  included: boolean;
  medal: boolean;
  lastFetchedAt: string | null;
  customCategoryId: string | null;
  freshrssCategoryId: string | null;
  freshrssCategoryLabel: string | null;
  categoryLabel: string;
  isFreshrssCategory: boolean;
};

type CustomCategoryItem = {
  id: string;
  label: string;
  selected: boolean;
  frontPageEnabled: boolean;
  feedCount: number;
};

// Valeur encodée dans le <select> de catégorie du formulaire d'ajout/édition
// de flux personnalisé : "fr:<freshrssId>" pour une vraie catégorie
// FreshRSS existante, "cu:<CustomCategory.id>" pour une catégorie
// personnalisée existante, "new" pour en créer une à la volée.
function categoryChoiceValue(feed: Pick<CustomFeedItem, "customCategoryId" | "freshrssCategoryId">): string {
  if (feed.customCategoryId) return `cu:${feed.customCategoryId}`;
  if (feed.freshrssCategoryId) return `fr:${feed.freshrssCategoryId}`;
  return "";
}

type Stats = {
  totalArticles: number;
  favoriteCount: number;
  publishedEditionCount: number;
  totalEditionCount: number;
  dbSizeBytes: number | null;
  dbSizePretty: string | null;
  nextAutoFetch: { mode: "auto" | "manual"; nextRunAt: string };
  lastEdition: {
    date: string;
    generatedAt: string;
    status: string;
    sourcePoolCount: number | null;
    snapshotCount: number;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
    estimatedCostEur: number | null;
  } | null;
  aiProvider: string;
  aiModel: string;
};

function formatCost(n: number): string {
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(true);
  const [feedsError, setFeedsError] = useState<string | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // Catégories repliées dans l'arborescence (par défaut tout est déplié).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggleExpanded(freshrssId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(freshrssId)) next.delete(freshrssId);
      else next.add(freshrssId);
      return next;
    });
  }

  function expandAllCategories() {
    setCollapsed(new Set());
  }

  function collapseAllCategories() {
    setCollapsed(new Set(categories.map((c) => c.freshrssId)));
  }

  // Flux personnalisés (hors FreshRSS) — section PRIMAIRE de l'admin
  // "catégories personnalisées" : ajouter un flux est le point d'entrée
  // principal, la création de catégorie personnalisée n'étant qu'une option
  // secondaire (à la volée depuis ce même formulaire, ou séparément plus
  // bas). Id synthétiques "custom-cat:<id>"/"custom-feed:<id>" réutilisés
  // directement dans les MÊMES routes que les catégories/flux FreshRSS
  // (/api/admin/categories, /api/admin/feeds) pour le réglage
  // selected/frontPageEnabled/included/medal — traitées "au même titre",
  // aucune logique de bascule dupliquée ici.
  const [customFeeds, setCustomFeeds] = useState<CustomFeedItem[]>([]);
  const [customFeedsLoading, setCustomFeedsLoading] = useState(true);
  const [customFeedsError, setCustomFeedsError] = useState<string | null>(null);

  const [customCategories, setCustomCategories] = useState<CustomCategoryItem[]>([]);
  const [customCategoriesLoading, setCustomCategoriesLoading] = useState(true);
  const [customCategoriesError, setCustomCategoriesError] = useState<string | null>(null);

  const EMPTY_FEED_FORM = { url: "", title: "", categoryChoice: "", newCategoryLabel: "" };
  const [feedForm, setFeedForm] = useState(EMPTY_FEED_FORM);
  const [addingFeed, setAddingFeed] = useState(false);

  const [editingFeedId, setEditingFeedId] = useState<string | null>(null);
  const [editFeedForm, setEditFeedForm] = useState(EMPTY_FEED_FORM);
  const [savingFeedEdit, setSavingFeedEdit] = useState(false);

  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);

  // Pli/dépli par catégorie perso dans "Catégories personnalisées" — même
  // pattern que "Catégories & flux" (collapsed/toggleExpanded), déplié par
  // défaut.
  const [customCollapsed, setCustomCollapsed] = useState<Set<string>>(new Set());

  function toggleCustomExpanded(id: string) {
    setCustomCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function loadCustomFeeds() {
    setCustomFeedsLoading(true);
    setCustomFeedsError(null);
    const res = await fetch("/api/admin/custom-feeds");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCustomFeedsError(body.error || "Impossible de charger les flux personnalisés");
      setCustomFeeds([]);
    } else {
      setCustomFeeds(body.feeds || []);
    }
    setCustomFeedsLoading(false);
  }

  async function loadCustomCategories() {
    setCustomCategoriesLoading(true);
    setCustomCategoriesError(null);
    const res = await fetch("/api/admin/custom-categories");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCustomCategoriesError(body.error || "Impossible de charger les catégories personnalisées");
      setCustomCategories([]);
    } else {
      setCustomCategories(body.categories || []);
    }
    setCustomCategoriesLoading(false);
  }

  // Traduit la valeur du <select> catégorie ("fr:<freshrssId>" / "cu:<id>" /
  // "new") en corps de requête pour /api/admin/custom-feeds (POST ou PATCH).
  function categoryChoiceToPayload(choice: string, newLabel: string) {
    if (choice === "new") return { newCategoryLabel: newLabel.trim() };
    if (choice.startsWith("fr:")) {
      const freshrssCategoryId = choice.slice(3);
      const label = categories.find((c) => c.freshrssId === freshrssCategoryId)?.label || "";
      return { freshrssCategoryId, freshrssCategoryLabel: label };
    }
    if (choice.startsWith("cu:")) return { customCategoryId: choice.slice(3) };
    return {};
  }

  async function createCustomCategory() {
    const label = newCategoryLabel.trim();
    if (!label) return;
    setCreatingCategory(true);
    try {
      const res = await fetch("/api/admin/custom-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label })
      });
      if (res.ok) {
        setNewCategoryLabel("");
        await loadCustomCategories();
      } else {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Échec de la création de la catégorie");
      }
    } finally {
      setCreatingCategory(false);
    }
  }

  async function deleteCustomCategory(cat: CustomCategoryItem) {
    if (!window.confirm(`Supprimer « ${cat.label} » et ses ${cat.feedCount} flux ?`)) return;
    await fetch("/api/admin/custom-categories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cat.id })
    });
    await Promise.all([loadCustomCategories(), loadCustomFeeds()]);
  }

  async function addCustomFeed() {
    const url = feedForm.url.trim();
    if (!url || !feedForm.categoryChoice) return;
    setAddingFeed(true);
    try {
      const res = await fetch("/api/admin/custom-feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          title: feedForm.title.trim(),
          ...categoryChoiceToPayload(feedForm.categoryChoice, feedForm.newCategoryLabel)
        })
      });
      if (res.ok) {
        setFeedForm(EMPTY_FEED_FORM);
        await Promise.all([loadCustomFeeds(), loadCustomCategories()]);
      } else {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Échec de l'ajout du flux");
      }
    } finally {
      setAddingFeed(false);
    }
  }

  function startEditFeed(feed: CustomFeedItem) {
    setEditingFeedId(feed.id);
    setEditFeedForm({
      url: feed.url,
      title: feed.title,
      categoryChoice: categoryChoiceValue(feed),
      newCategoryLabel: ""
    });
  }

  // Depuis l'arborescence "Catégories & flux" (où un flux perso rattaché à
  // une catégorie FreshRSS est aussi affiché), le formulaire d'édition reste
  // dans "Flux personnalisés" plus bas — on y scrolle pour ne pas laisser
  // le clic sans effet visible.
  function startEditFeedFromTree(feed: CustomFeedItem) {
    startEditFeed(feed);
    document.getElementById(`custom-feed-${feed.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function cancelEditFeed() {
    setEditingFeedId(null);
    setEditFeedForm(EMPTY_FEED_FORM);
  }

  async function saveEditFeed(feed: CustomFeedItem) {
    setSavingFeedEdit(true);
    try {
      const res = await fetch("/api/admin/custom-feeds", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: feed.id,
          url: editFeedForm.url.trim(),
          title: editFeedForm.title.trim(),
          ...categoryChoiceToPayload(editFeedForm.categoryChoice, editFeedForm.newCategoryLabel)
        })
      });
      if (res.ok) {
        cancelEditFeed();
        await Promise.all([loadCustomFeeds(), loadCustomCategories()]);
      } else {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Échec de la modification du flux");
      }
    } finally {
      setSavingFeedEdit(false);
    }
  }

  async function deleteCustomFeed(feed: CustomFeedItem) {
    if (!window.confirm(`Supprimer le flux « ${feed.title} » ?`)) return;
    await fetch("/api/admin/custom-feeds", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: feed.id })
    });
    await loadCustomFeeds();
  }

  async function toggleCustomCategorySelected(cat: CustomCategoryItem) {
    setCustomCategories((prev) => prev.map((c) => (c.id === cat.id ? { ...c, selected: !c.selected } : c)));
    await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: `custom-cat:${cat.id}`, label: cat.label, selected: !cat.selected })
    });
  }

  async function toggleCustomCategoryFrontPage(cat: CustomCategoryItem) {
    setCustomCategories((prev) =>
      prev.map((c) => (c.id === cat.id ? { ...c, frontPageEnabled: !c.frontPageEnabled } : c))
    );
    await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freshrssId: `custom-cat:${cat.id}`,
        label: cat.label,
        frontPageEnabled: !cat.frontPageEnabled
      })
    });
  }

  async function toggleCustomFeedIncluded(feed: CustomFeedItem) {
    setCustomFeeds((prev) => prev.map((f) => (f.id === feed.id ? { ...f, included: !f.included } : f)));
    await fetch("/api/admin/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: `custom-feed:${feed.id}`, title: feed.title, included: !feed.included })
    });
  }

  async function toggleCustomFeedMedal(feed: CustomFeedItem) {
    setCustomFeeds((prev) => prev.map((f) => (f.id === feed.id ? { ...f, medal: !f.medal } : f)));
    await fetch("/api/admin/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: `custom-feed:${feed.id}`, title: feed.title, medal: !feed.medal })
    });
  }

  async function loadCategories() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/admin/categories");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || "Impossible de charger les catégories FreshRSS");
      setCategories([]);
    } else {
      setCategories(body.categories || []);
    }
    setLoading(false);
  }

  async function loadFeeds() {
    setFeedsLoading(true);
    setFeedsError(null);
    const res = await fetch("/api/admin/feeds");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFeedsError(body.error || "Impossible de charger les flux FreshRSS");
      setFeeds([]);
    } else {
      setFeeds(body.feeds || []);
    }
    setFeedsLoading(false);
  }

  async function loadStats() {
    setStatsLoading(true);
    const res = await fetch("/api/admin/stats");
    const body = await res.json().catch(() => ({}));
    setStats(res.ok ? body : null);
    setStatsLoading(false);
  }

  useEffect(() => {
    loadCategories();
    loadFeeds();
    loadStats();
    loadCustomCategories();
    loadCustomFeeds();
  }, []);

  async function toggle(cat: Category) {
    setCategories((prev) =>
      prev.map((c) => (c.freshrssId === cat.freshrssId ? { ...c, selected: !c.selected } : c))
    );
    await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: cat.freshrssId, label: cat.label, selected: !cat.selected })
    });
  }

  // Carte "Impression IA" : bascule indépendante de "selected", ne touche
  // qu'au flag qui détermine si cette catégorie participe à la génération
  // (et à l'affichage) de la une IA de la page d'accueil.
  async function toggleFrontPage(cat: Category) {
    setCategories((prev) =>
      prev.map((c) => (c.freshrssId === cat.freshrssId ? { ...c, frontPageEnabled: !c.frontPageEnabled } : c))
    );
    await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freshrssId: cat.freshrssId,
        label: cat.label,
        frontPageEnabled: !cat.frontPageEnabled
      })
    });
  }

  // Bascule GROUPÉE : masque/réaffiche tous les flux personnalisés
  // rattachés à cette catégorie FreshRSS d'un coup, sans toucher à leurs
  // cases individuelles "inclure le flux" ni aux vrais flux FreshRSS de la
  // catégorie (voir DisabledCustomFeedsCategory).
  async function toggleCustomFeedsEnabled(cat: Category) {
    setCategories((prev) =>
      prev.map((c) => (c.freshrssId === cat.freshrssId ? { ...c, customFeedsEnabled: !c.customFeedsEnabled } : c))
    );
    await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freshrssId: cat.freshrssId,
        label: cat.label,
        customFeedsEnabled: !cat.customFeedsEnabled
      })
    });
    await loadCustomFeeds();
  }

  // Réorganisation par glisser-déposer : on saisit le titre d'une
  // catégorie et on la dépose ailleurs dans la liste, sans bouton ni
  // poignée visible. Le nouvel ordre est persisté en base immédiatement
  // (comme tous les autres réglages) — effectif dans l'édition et "En
  // direct", et conservé après redémarrage/redéploiement.
  const [draggedId, setDraggedId] = useState<string | null>(null);

  async function persistOrder(reordered: Category[]) {
    setCategories(reordered);
    await fetch("/api/admin/categories/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssIds: reordered.map((c) => c.freshrssId) })
    });
  }

  function handleDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const fromIndex = categories.findIndex((c) => c.freshrssId === draggedId);
    const toIndex = categories.findIndex((c) => c.freshrssId === targetId);
    if (fromIndex === -1 || toIndex === -1) return;

    const reordered = [...categories];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    persistOrder(reordered);
    setDraggedId(null);
  }

  async function toggleFeed(feed: Feed) {
    setFeeds((prev) =>
      prev.map((f) => (f.freshrssId === feed.freshrssId ? { ...f, included: !f.included } : f))
    );
    await fetch("/api/admin/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: feed.freshrssId, title: feed.title, included: !feed.included })
    });
  }

  async function toggleMedal(feed: Feed) {
    setFeeds((prev) =>
      prev.map((f) => (f.freshrssId === feed.freshrssId ? { ...f, medal: !f.medal } : f))
    );
    await fetch("/api/admin/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: feed.freshrssId, title: feed.title, medal: !feed.medal })
    });
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  return (
    <main className="paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      {/* Masthead miniature */}
      <div className="mb-8 text-center">
        <a href="/" className="font-masthead text-4xl font-black uppercase tracking-tight">
          DailySpoon
        </a>
        <div className="double-rule mt-3" />
        <div className="flex items-center justify-between py-1.5 text-[0.65rem] uppercase tracking-[0.3em] text-sepia">
          <a href="/admin/settings" className="hover:underline">
            Réglages →
          </a>
          <button onClick={logout} className="uppercase tracking-[0.3em] hover:underline">
            Se déconnecter
          </button>
        </div>
        <div className="double-rule rotate-180" />
      </div>

      {/* Statistiques de l'app — vue d'ensemble rapide en haut du menu admin.
          Chargé à part (loadStats) : ne bloque jamais l'affichage des
          catégories/flux si /api/admin/stats est lent ou en erreur. */}
      <CollapsibleSection title="Statistiques">
      {statsLoading ? (
        <p className="mb-10 text-center italic text-sepia">Calcul en cours...</p>
      ) : !stats ? (
        <p className="mb-10 text-center italic text-sepia">Statistiques indisponibles.</p>
      ) : (
        <div className="mb-10 grid grid-cols-2 gap-3 md:grid-cols-3">
          <div className="border border-ink/30 p-3 text-center">
            <div className="font-display text-2xl font-black">{stats.totalArticles.toLocaleString("fr-FR")}</div>
            <div className="text-[0.65rem] uppercase tracking-[0.2em] text-sepia">Articles en base</div>
            <div className="mt-1 text-xs italic text-neutral-600">{stats.favoriteCount} favori(s)</div>
          </div>

          <div className="border border-ink/30 p-3 text-center">
            <div className="font-display text-2xl font-black">{stats.publishedEditionCount}</div>
            <div className="text-[0.65rem] uppercase tracking-[0.2em] text-sepia">Impressions réussies</div>
            <div className="mt-1 text-xs italic text-neutral-600">{stats.totalEditionCount} tentative(s) au total</div>
          </div>

          <div className="border border-ink/30 p-3 text-center">
            <div className="font-display text-2xl font-black">{stats.dbSizePretty ?? "—"}</div>
            <div className="text-[0.65rem] uppercase tracking-[0.2em] text-sepia">Taille de la base</div>
          </div>

          <div className="border border-ink/30 p-3 text-center">
            <div className="font-display text-lg font-black">{formatDateTime(stats.nextAutoFetch.nextRunAt)}</div>
            <div className="text-[0.65rem] uppercase tracking-[0.2em] text-sepia">Prochaine aspiration auto</div>
            <div className="mt-1 text-xs italic text-neutral-600">
              {stats.nextAutoFetch.mode === "auto"
                ? "impression IA complète (planning actif)"
                : "aspiration RSS de secours, sans IA (mode manuel)"}
            </div>
          </div>

          <div className="col-span-2 border border-ink/30 p-3 text-center md:col-span-1">
            {stats.lastEdition ? (
              <>
                <div className="font-display text-lg font-black">
                  {stats.lastEdition.inputTokens !== null && stats.lastEdition.outputTokens !== null ? (
                    <>
                      {(stats.lastEdition.inputTokens + stats.lastEdition.outputTokens).toLocaleString("fr-FR")}{" "}
                      tokens
                    </>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="text-[0.65rem] uppercase tracking-[0.2em] text-sepia">Dernière impression</div>
                <div className="mt-1 text-xs italic text-neutral-600">
                  {stats.lastEdition.estimatedCostUsd !== null && stats.lastEdition.estimatedCostEur !== null
                    ? `≈ ${formatCost(stats.lastEdition.estimatedCostUsd)} $ (~${formatCost(
                        stats.lastEdition.estimatedCostEur
                      )} €)`
                    : "aucune conso IA enregistrée"}
                  {" · "}
                  {formatDateTime(stats.lastEdition.generatedAt)}
                </div>
              </>
            ) : (
              <div className="text-xs italic text-neutral-600">Aucune impression pour l’instant.</div>
            )}
          </div>
        </div>
      )}
      </CollapsibleSection>

      <h1 className="mb-6 text-center font-display text-2xl font-black uppercase tracking-[0.15em]">
        Catégories & flux FreshRSS
      </h1>

      <p className="newsprint mb-6 text-sm text-neutral-700">
        La gestion des flux (ajout, suppression, organisation) se fait directement dans FreshRSS.
        Ici, tu choisis quelles catégories — et quels flux précis, regroupés dessous — DailySpoon
        doit inclure. Décocher une catégorie ou un flux le retire immédiatement de l’édition
        (partout, articles déjà récupérés compris), pas seulement des futures récupérations.
      </p>

      {!loading && !error && categories.length > 0 && (
        <CollapsibleSection title="Impression IA">
          <p className="newsprint mb-4 text-sm text-neutral-700">
            L’impression IA (la une générée sur la page d’accueil, uniquement les news du jour) est
            indépendante d’« En direct » : elle liste ici TOUTES les catégories FreshRSS, cochées ou
            non pour En direct, et travaille directement sur les news récupérées à la source. Décocher
            une catégorie ci-dessous la retire uniquement de l’impression IA — elle reste inchangée
            partout ailleurs (En direct, recherche, archive). Un flux explicitement exclu (ci-dessous)
            reste exclu même ici.
          </p>
          <ul className="mb-10 border-t-2 border-ink">
            {categories.map((cat) => (
              <li
                key={cat.freshrssId}
                className="flex items-center justify-between gap-4 border-b border-ink/30 py-3"
              >
                <span className="font-display font-bold">{cat.label}</span>
                <label className="flex shrink-0 items-center gap-2 text-xs italic text-sepia">
                  <input
                    type="checkbox"
                    checked={cat.frontPageEnabled}
                    onChange={() => toggleFrontPage(cat)}
                    className="accent-ink"
                  />
                  inclure dans l’impression IA
                </label>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Catégories & flux">
      {!loading && !error && categories.length > 0 && (
        <div className="mb-3 flex justify-end gap-3 text-xs uppercase tracking-[0.2em] text-sepia">
          <button type="button" onClick={expandAllCategories} className="hover:underline">
            Tout déplier
          </button>
          <span>·</span>
          <button type="button" onClick={collapseAllCategories} className="hover:underline">
            Tout replier
          </button>
        </div>
      )}

      {loading ? (
        <p className="italic text-sepia">Chargement depuis FreshRSS...</p>
      ) : error ? (
        <div className="space-y-2 text-sm text-journal">
          <p>{error}</p>
          <p className="text-neutral-700">
            Vérifie l’URL, l’identifiant et le mot de passe API FreshRSS dans{" "}
            <a href="/admin/settings" className="underline">
              /admin/settings
            </a>{" "}
            (ou les variables d’environnement FRESHRSS_BASE_URL / FRESHRSS_USERNAME /
            FRESHRSS_API_PASSWORD).
          </p>
        </div>
      ) : (
        <>
          {feedsError && <p className="mb-3 text-sm text-journal">{feedsError}</p>}
          {feedsLoading && (
            <p className="mb-3 italic text-sepia">Chargement des flux depuis FreshRSS...</p>
          )}

          <ul className="border-t-2 border-ink">
            {categories.map((cat) => {
              const childFeeds = feeds.filter((f) => f.categoryLabels.includes(cat.label));
              // Flux personnalisés rattachés directement à CETTE catégorie
              // FreshRSS (voir /admin/categories, formulaire "Flux
              // personnalisés") — affichés ici, mêlés aux vrais flux
              // FreshRSS, pour une arborescence fidèle à leur traitement en
              // aval (même catégorie = mêmes réglages En direct/Impression
              // IA). Toujours listés aussi dans "Flux personnalisés" plus
              // bas, qui reste le point d'entrée pour les modifier/supprimer.
              const childCustomFeeds = customFeeds.filter((f) => f.freshrssCategoryId === cat.freshrssId);
              const isCollapsed = collapsed.has(cat.freshrssId);
              return (
                <li
                  key={cat.freshrssId}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(cat.freshrssId);
                  }}
                  className={`border-b border-ink/30 transition-colors hover:bg-ink/5 ${draggedId === cat.freshrssId ? "opacity-40" : ""}`}
                >
                  <div className="flex items-center justify-between gap-4 py-3">
                    <button
                      type="button"
                      draggable
                      onDragStart={() => setDraggedId(cat.freshrssId)}
                      onDragEnd={() => setDraggedId(null)}
                      onClick={() => toggleExpanded(cat.freshrssId)}
                      className="flex cursor-grab items-center gap-2 text-left font-display font-bold hover:underline active:cursor-grabbing"
                    >
                      <span className="inline-block w-3 text-xs text-sepia">
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                      {cat.label}
                      {!feedsLoading && (
                        <span className="text-xs font-normal italic text-sepia">
                          ({childFeeds.length + childCustomFeeds.length})
                        </span>
                      )}
                    </button>
                    <div className="flex shrink-0 flex-wrap items-center gap-4">
                      {childCustomFeeds.length > 0 && (
                        <label className="flex items-center gap-2 text-xs italic text-sepia">
                          <input
                            type="checkbox"
                            checked={cat.customFeedsEnabled}
                            onChange={() => toggleCustomFeedsEnabled(cat)}
                            className="accent-ink"
                          />
                          activer les flux perso importés
                        </label>
                      )}
                      <label className="flex items-center gap-2 text-xs italic text-sepia">
                        <input
                          type="checkbox"
                          checked={cat.selected}
                          onChange={() => toggle(cat)}
                          className="accent-ink"
                        />
                        inclure la catégorie
                      </label>
                    </div>
                  </div>

                  {!isCollapsed && !feedsLoading && (
                    <ul className="ml-2 border-l border-dashed border-ink/40 pb-3 pl-5">
                      {childFeeds.map((feed) => (
                        <li
                          key={feed.freshrssId}
                          className="flex items-center justify-between gap-4 rounded-sm py-1.5 px-2 -mx-2 transition-colors hover:bg-ink/5"
                        >
                          <span className="text-sm">{feed.title}</span>
                          <div className="flex shrink-0 items-center gap-4">
                            <label className="flex items-center gap-2 text-xs italic text-sepia">
                              <input
                                type="checkbox"
                                checked={feed.medal}
                                onChange={() => toggleMedal(feed)}
                                className="accent-journal"
                              />
                              médaille
                            </label>
                            <label className="flex items-center gap-2 text-xs italic text-sepia">
                              <input
                                type="checkbox"
                                checked={feed.included}
                                onChange={() => toggleFeed(feed)}
                                className="accent-ink"
                              />
                              inclure le flux
                            </label>
                          </div>
                        </li>
                      ))}
                      {childCustomFeeds.map((feed) => (
                        <li
                          key={feed.id}
                          className="flex items-center justify-between gap-4 rounded-sm py-1.5 px-2 -mx-2 transition-colors hover:bg-ink/5"
                        >
                          <span className="text-sm">
                            {feed.title}{" "}
                            <span className="rounded-sm border border-ink/30 px-1 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                              perso
                            </span>
                          </span>
                          <div className="flex shrink-0 items-center gap-4">
                            <label className="flex items-center gap-2 text-xs italic text-sepia">
                              <input
                                type="checkbox"
                                checked={feed.medal}
                                onChange={() => toggleCustomFeedMedal(feed)}
                                className="accent-journal"
                              />
                              médaille
                            </label>
                            <label className="flex items-center gap-2 text-xs italic text-sepia">
                              <input
                                type="checkbox"
                                checked={feed.included}
                                onChange={() => toggleCustomFeedIncluded(feed)}
                                className="accent-ink"
                              />
                              inclure le flux
                            </label>
                            <button
                              type="button"
                              onClick={() => startEditFeedFromTree(feed)}
                              className="text-xs uppercase tracking-[0.2em] hover:underline"
                            >
                              Modifier
                            </button>
                          </div>
                        </li>
                      ))}
                      {childFeeds.length === 0 && childCustomFeeds.length === 0 && (
                        <p className="py-1.5 text-xs italic text-sepia">
                          Aucun flux trouvé pour cette catégorie.
                        </p>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
            {categories.length === 0 && (
              <p className="py-6 text-center italic text-sepia">
                Aucune catégorie trouvée dans FreshRSS.
              </p>
            )}
          </ul>

          {!feedsLoading &&
            (() => {
              const knownLabels = new Set(categories.map((c) => c.label));
              const orphanFeeds = feeds.filter(
                (f) => f.categoryLabels.length === 0 || f.categoryLabels.every((l) => !knownLabels.has(l))
              );
              if (orphanFeeds.length === 0) return null;
              return (
                <div className="mt-2 border-b border-ink/30 pb-3">
                  <div className="flex items-center gap-2 py-3 font-display font-bold">
                    <span className="inline-block w-3 text-xs text-sepia">▾</span>
                    Sans catégorie
                    <span className="text-xs font-normal italic text-sepia">
                      ({orphanFeeds.length})
                    </span>
                  </div>
                  <ul className="ml-2 border-l border-dashed border-ink/40 pl-5">
                    {orphanFeeds.map((feed) => (
                      <li
                        key={feed.freshrssId}
                        className="flex items-center justify-between gap-4 rounded-sm py-1.5 px-2 -mx-2 transition-colors hover:bg-ink/5"
                      >
                        <span className="text-sm">{feed.title}</span>
                        <div className="flex shrink-0 items-center gap-4">
                          <label className="flex items-center gap-2 text-xs italic text-sepia">
                            <input
                              type="checkbox"
                              checked={feed.medal}
                              onChange={() => toggleMedal(feed)}
                              className="accent-journal"
                            />
                            médaille
                          </label>
                          <label className="flex items-center gap-2 text-xs italic text-sepia">
                            <input
                              type="checkbox"
                              checked={feed.included}
                              onChange={() => toggleFeed(feed)}
                              className="accent-ink"
                            />
                            inclure le flux
                          </label>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
        </>
      )}
      </CollapsibleSection>

      <CollapsibleSection title="Flux personnalisés">
      <p className="newsprint mb-6 text-sm text-neutral-700">
        Ajoute directement une URL de flux RSS/Atom, sans passer par FreshRSS. À la création, choisis
        où le ranger : dans une catégorie FreshRSS existante (il est alors traité en tout point comme
        un flux FreshRSS de cette catégorie — affichage En direct, génération IA), dans une catégorie
        personnalisée déjà créée, ou dans une toute nouvelle catégorie personnalisée créée à la volée.
        Mêmes cases qu’un flux FreshRSS (inclure, médaille), même filtrage/mise en forme. Récupéré à
        l’intervalle global réglable dans{" "}
        <a href="/admin/settings" className="underline">
          /admin/settings
        </a>
        .
      </p>

      <div className="mb-6 space-y-2 border-b-2 border-ink pb-4">
        <div className="flex flex-wrap gap-2">
          <input
            type="url"
            value={feedForm.url}
            onChange={(e) => setFeedForm((prev) => ({ ...prev, url: e.target.value }))}
            placeholder="URL du flux RSS/Atom"
            className="min-w-[220px] flex-1 border border-ink/40 bg-transparent px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={feedForm.title}
            onChange={(e) => setFeedForm((prev) => ({ ...prev, title: e.target.value }))}
            placeholder="Nom personnalisé (optionnel)"
            className="w-48 border border-ink/40 bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CategorySelectField
            value={feedForm.categoryChoice}
            onChange={(v) => setFeedForm((prev) => ({ ...prev, categoryChoice: v }))}
            newLabel={feedForm.newCategoryLabel}
            onNewLabelChange={(v) => setFeedForm((prev) => ({ ...prev, newCategoryLabel: v }))}
            freshrssCategories={categories}
            customCats={customCategories}
          />
          <button
            type="button"
            onClick={addCustomFeed}
            disabled={
              addingFeed ||
              !feedForm.url.trim() ||
              !feedForm.categoryChoice ||
              (feedForm.categoryChoice === "new" && !feedForm.newCategoryLabel.trim())
            }
            className="stamp-button stamp-bg-md inline-flex items-center justify-center px-4 font-display text-xs uppercase tracking-[0.2em] text-paper disabled:opacity-50"
          >
            {addingFeed ? "Ajout..." : "Ajouter le flux"}
          </button>
        </div>
      </div>

      {customFeedsError && <p className="mb-3 text-sm text-journal">{customFeedsError}</p>}
      {customFeedsLoading ? (
        <p className="italic text-sepia">Chargement...</p>
      ) : customFeeds.length === 0 ? (
        <p className="py-4 text-center italic text-sepia">Aucun flux personnalisé pour l’instant.</p>
      ) : (
        <ul className="mb-10 border-t-2 border-ink">
          {customFeeds.map((feed) => (
            <li key={feed.id} id={`custom-feed-${feed.id}`} className="border-b border-ink/30 py-3">
              {editingFeedId === feed.id ? (
                <div className="space-y-2 rounded-sm bg-ink/5 p-3">
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="url"
                      value={editFeedForm.url}
                      onChange={(e) => setEditFeedForm((prev) => ({ ...prev, url: e.target.value }))}
                      placeholder="URL du flux"
                      className="min-w-[220px] flex-1 border border-ink/40 bg-transparent px-3 py-1.5 text-sm"
                    />
                    <input
                      type="text"
                      value={editFeedForm.title}
                      onChange={(e) => setEditFeedForm((prev) => ({ ...prev, title: e.target.value }))}
                      placeholder="Nom personnalisé"
                      className="w-48 border border-ink/40 bg-transparent px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <CategorySelectField
                      value={editFeedForm.categoryChoice}
                      onChange={(v) => setEditFeedForm((prev) => ({ ...prev, categoryChoice: v }))}
                      newLabel={editFeedForm.newCategoryLabel}
                      onNewLabelChange={(v) => setEditFeedForm((prev) => ({ ...prev, newCategoryLabel: v }))}
                      freshrssCategories={categories}
                      customCats={customCategories}
                    />
                  </div>
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => saveEditFeed(feed)}
                      disabled={
                        savingFeedEdit ||
                        !editFeedForm.url.trim() ||
                        !editFeedForm.categoryChoice ||
                        (editFeedForm.categoryChoice === "new" && !editFeedForm.newCategoryLabel.trim())
                      }
                      className="stamp-button stamp-bg-md inline-flex items-center justify-center px-3 font-display text-xs uppercase tracking-[0.2em] text-paper disabled:opacity-50"
                    >
                      {savingFeedEdit ? "Enregistrement..." : "Enregistrer"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditFeed}
                      className="text-xs uppercase tracking-[0.2em] text-sepia hover:underline"
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold">{feed.title}</span>
                      <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.6rem] uppercase tracking-[0.15em] text-sepia">
                        {feed.categoryLabel} · {feed.isFreshrssCategory ? "FreshRSS" : "perso"}
                      </span>
                    </div>
                    <div className="truncate text-xs italic text-sepia">{feed.url}</div>
                    <div className="text-xs italic text-sepia">
                      {feed.lastFetchedAt
                        ? `récupéré ${formatDateTime(feed.lastFetchedAt)}`
                        : "pas encore récupéré"}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-xs italic text-sepia">
                      <input
                        type="checkbox"
                        checked={feed.medal}
                        onChange={() => toggleCustomFeedMedal(feed)}
                        className="accent-journal"
                      />
                      médaille
                    </label>
                    <label className="flex items-center gap-2 text-xs italic text-sepia">
                      <input
                        type="checkbox"
                        checked={feed.included}
                        onChange={() => toggleCustomFeedIncluded(feed)}
                        className="accent-ink"
                      />
                      inclure le flux
                    </label>
                    <button
                      type="button"
                      onClick={() => startEditFeed(feed)}
                      className="text-xs uppercase tracking-[0.2em] hover:underline"
                    >
                      Modifier
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteCustomFeed(feed)}
                      className="text-xs uppercase tracking-[0.2em] text-journal hover:underline"
                    >
                      Supprimer
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      </CollapsibleSection>

      <CollapsibleSection title="Catégories personnalisées">
      <p className="newsprint mb-4 text-xs italic text-neutral-600">
        Gestion des catégories elles-mêmes, secondaire par rapport à l’ajout de flux ci-dessus — la
        créer ici revient au même que choisir « + Créer une nouvelle catégorie » dans son formulaire.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={newCategoryLabel}
          onChange={(e) => setNewCategoryLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createCustomCategory()}
          placeholder="Nom de la nouvelle catégorie"
          className="min-w-[220px] flex-1 border border-ink/40 bg-transparent px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={createCustomCategory}
          disabled={creatingCategory || !newCategoryLabel.trim()}
          className="border border-ink px-3 py-2 text-xs uppercase tracking-[0.2em] hover:bg-ink hover:text-paper disabled:opacity-50"
        >
          {creatingCategory ? "Création..." : "Créer la catégorie"}
        </button>
      </div>

      {customCategoriesError && <p className="mb-3 text-sm text-journal">{customCategoriesError}</p>}
      {customCategoriesLoading ? (
        <p className="italic text-sepia">Chargement...</p>
      ) : customCategories.length === 0 ? (
        <p className="py-4 text-center italic text-sepia">Aucune catégorie personnalisée pour l’instant.</p>
      ) : (
        <ul className="border-t-2 border-ink">
          {customCategories.map((cat) => {
            const catFeeds = customFeeds.filter((f) => f.customCategoryId === cat.id);
            const isCollapsed = customCollapsed.has(cat.id);
            return (
              <li key={cat.id} className="border-b border-ink/30">
                <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleCustomExpanded(cat.id)}
                    className="flex items-center gap-2 text-left font-display font-bold hover:underline"
                  >
                    <span className="inline-block w-3 text-xs text-sepia">{isCollapsed ? "▸" : "▾"}</span>
                    {cat.label}
                    <span className="text-xs font-normal italic text-sepia">({catFeeds.length})</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-xs italic text-sepia">
                      <input
                        type="checkbox"
                        checked={cat.frontPageEnabled}
                        onChange={() => toggleCustomCategoryFrontPage(cat)}
                        className="accent-ink"
                      />
                      impression IA
                    </label>
                    <label className="flex items-center gap-2 text-xs italic text-sepia">
                      <input
                        type="checkbox"
                        checked={cat.selected}
                        onChange={() => toggleCustomCategorySelected(cat)}
                        className="accent-ink"
                      />
                      inclure la catégorie
                    </label>
                    <button
                      type="button"
                      onClick={() => deleteCustomCategory(cat)}
                      className="text-xs uppercase tracking-[0.2em] text-journal hover:underline"
                    >
                      Supprimer
                    </button>
                  </div>
                </div>

                {!isCollapsed && (
                  <ul className="ml-2 border-l border-dashed border-ink/40 pb-3 pl-5">
                    {catFeeds.map((feed) => (
                      <li
                        key={feed.id}
                        className="flex items-center justify-between gap-4 rounded-sm py-1.5 px-2 -mx-2 transition-colors hover:bg-ink/5"
                      >
                        <span className="text-sm">{feed.title}</span>
                        <div className="flex shrink-0 items-center gap-4">
                          <label className="flex items-center gap-2 text-xs italic text-sepia">
                            <input
                              type="checkbox"
                              checked={feed.medal}
                              onChange={() => toggleCustomFeedMedal(feed)}
                              className="accent-journal"
                            />
                            médaille
                          </label>
                          <label className="flex items-center gap-2 text-xs italic text-sepia">
                            <input
                              type="checkbox"
                              checked={feed.included}
                              onChange={() => toggleCustomFeedIncluded(feed)}
                              className="accent-ink"
                            />
                            inclure le flux
                          </label>
                          <button
                            type="button"
                            onClick={() => startEditFeedFromTree(feed)}
                            className="text-xs uppercase tracking-[0.2em] hover:underline"
                          >
                            Modifier
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteCustomFeed(feed)}
                            className="text-xs uppercase tracking-[0.2em] text-journal hover:underline"
                          >
                            Supprimer
                          </button>
                        </div>
                      </li>
                    ))}
                    {catFeeds.length === 0 && (
                      <p className="py-1.5 text-xs italic text-sepia">Aucun flux dans cette catégorie.</p>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      </CollapsibleSection>

      <SpoonDivider />
    </main>
  );
}

// <select> catégorie partagé entre le formulaire d'ajout et le formulaire
// d'édition d'un flux personnalisé — valeur encodée "fr:<freshrssId>" /
// "cu:<CustomCategory.id>" / "new" (voir categoryChoiceValue/
// categoryChoiceToPayload ci-dessus). Affiche un champ texte supplémentaire
// quand "new" est choisi, pour nommer la catégorie créée à la volée.
function CategorySelectField({
  value,
  onChange,
  newLabel,
  onNewLabelChange,
  freshrssCategories,
  customCats
}: {
  value: string;
  onChange: (v: string) => void;
  newLabel: string;
  onNewLabelChange: (v: string) => void;
  freshrssCategories: Category[];
  customCats: CustomCategoryItem[];
}) {
  return (
    <>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-[220px] flex-1 border border-ink/40 bg-paper px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ink"
      >
        <option value="" disabled>
          Choisir une catégorie...
        </option>
        {freshrssCategories.length > 0 && (
          <optgroup label="Catégories FreshRSS">
            {freshrssCategories.map((c) => (
              <option key={c.freshrssId} value={`fr:${c.freshrssId}`}>
                {c.label}
              </option>
            ))}
          </optgroup>
        )}
        {customCats.length > 0 && (
          <optgroup label="Catégories personnalisées">
            {customCats.map((c) => (
              <option key={c.id} value={`cu:${c.id}`}>
                {c.label}
              </option>
            ))}
          </optgroup>
        )}
        <option value="new">+ Créer une nouvelle catégorie personnalisée…</option>
      </select>
      {value === "new" && (
        <input
          type="text"
          value={newLabel}
          onChange={(e) => onNewLabelChange(e.target.value)}
          placeholder="Nom de la nouvelle catégorie"
          className="min-w-[200px] flex-1 border border-ink/40 bg-transparent px-3 py-2 text-sm"
        />
      )}
    </>
  );
}
