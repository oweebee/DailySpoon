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
  notify: boolean;
  articleCount: number;
  visibleArticleCount: number;
};

type CustomFeedItem = {
  id: string;
  url: string;
  title: string;
  included: boolean;
  medal: boolean;
  notify: boolean;
  lastFetchedAt: string | null;
  lastFetchError: string | null;
  articleCount: number;
  visibleArticleCount: number;
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
  // Même source (SelectedCategory.order) que Category.order ci-dessus — sert
  // à fusionner catégories FreshRSS et perso dans UNE SEULE liste triée de
  // façon cohérente (voir combinedCategoryRows plus bas).
  order: number | null;
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
  const [forcingSync, setForcingSync] = useState(false);
  const [forceSyncMessage, setForceSyncMessage] = useState<string | null>(null);

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

  // Renommage inline d'une catégorie (perso OU FreshRSS, si activé) — un
  // seul champ actif à la fois par type, sur le même principe que
  // editingFeedId ci-dessus.
  const [freshrssEnabled, setFreshrssEnabled] = useState(false);
  const [renameCustomId, setRenameCustomId] = useState<string | null>(null);
  const [renameCustomValue, setRenameCustomValue] = useState("");
  const [renameFreshrssId, setRenameFreshrssId] = useState<string | null>(null);
  const [renameFreshrssValue, setRenameFreshrssValue] = useState("");
  const [renaming, setRenaming] = useState(false);

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

  // Bouton "Forcer la récupération maintenant" — contourne l'intervalle
  // global (voir /api/admin/custom-feeds/sync) pour tester immédiatement au
  // lieu d'attendre le prochain tick du worker, puis recharge les compteurs
  // d'articles ci-dessous pour voir tout de suite le résultat.
  async function forceSyncCustomFeeds() {
    setForcingSync(true);
    setForceSyncMessage(null);
    const res = await fetch("/api/admin/custom-feeds/sync", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setForceSyncMessage(
        body.fetched > 0
          ? `${body.fetched} nouvel(aux) article(s) récupéré(s).`
          : "Terminé — aucun nouvel article (voir le détail par flux ci-dessous)."
      );
      await loadCustomFeeds();
    } else {
      setForceSyncMessage(body.error || "Échec de la synchronisation forcée.");
    }
    setForcingSync(false);
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

  async function toggleCustomFeedNotify(feed: CustomFeedItem) {
    setCustomFeeds((prev) => prev.map((f) => (f.id === feed.id ? { ...f, notify: !f.notify } : f)));
    await fetch("/api/admin/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: `custom-feed:${feed.id}`, title: feed.title, notify: !feed.notify })
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
    // Uniquement pour savoir si le renommage des catégories FreshRSS doit
    // être proposé (voir freshrssEnabled ci-dessous) — le reste des réglages
    // n'est pas utilisé ici.
    fetch("/api/admin/settings")
      .then((res) => res.json())
      .then((body) => setFreshrssEnabled(body.settings?.freshrssEnabled === true))
      .catch(() => {});
  }, []);

  async function renameCustomCategory(cat: CustomCategoryItem) {
    const label = renameCustomValue.trim();
    if (!label || label === cat.label) {
      setRenameCustomId(null);
      return;
    }
    setRenaming(true);
    const res = await fetch("/api/admin/custom-categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cat.id, label })
    });
    setRenaming(false);
    if (res.ok) {
      setRenameCustomId(null);
      await Promise.all([loadCustomCategories(), loadCustomFeeds()]);
    } else {
      const body = await res.json().catch(() => ({}));
      window.alert(body.error || "Échec du renommage.");
    }
  }

  async function renameFreshrssCategory(cat: Category) {
    const label = renameFreshrssValue.trim();
    if (!label || label === cat.label) {
      setRenameFreshrssId(null);
      return;
    }
    setRenaming(true);
    const res = await fetch("/api/admin/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: cat.freshrssId, newLabel: label, oldLabel: cat.label })
    });
    setRenaming(false);
    if (res.ok) {
      setRenameFreshrssId(null);
      await Promise.all([loadCategories(), loadFeeds()]);
    } else {
      const body = await res.json().catch(() => ({}));
      window.alert(body.error || "Échec du renommage.");
    }
  }

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

  async function toggleNotify(feed: Feed) {
    setFeeds((prev) =>
      prev.map((f) => (f.freshrssId === feed.freshrssId ? { ...f, notify: !f.notify } : f))
    );
    await fetch("/api/admin/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: feed.freshrssId, title: feed.title, notify: !feed.notify })
    });
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  // Ligne d'un flux personnalisé (vue OU édition inline) — partagée entre
  // l'arborescence "Catégories & flux" (flux perso rattachés à une vraie
  // catégorie FreshRSS) et l'arborescence "Catégories & flux personnalisés"
  // (flux perso rattachés à une catégorie perso) : chaque flux n'a
  // désormais QU'UN SEUL endroit où s'afficher (celui qui correspond à sa
  // catégorie), plus de liste à plat dupliquant l'arborescence. Le badge
  // "TEST · PERSO" reste affiché sur chaque ligne pour se repérer
  // visuellement d'un coup d'œil, même niché dans l'arbre.
  // showPersoBadge : true seulement dans l'arborescence "Catégories & flux"
  // (vraie catégorie FreshRSS pouvant mélanger flux réels ET flux perso) —
  // là, la mention doit se lire À CÔTÉ DU FLUX précis, pas sur l'en-tête de
  // catégorie (qui induirait en erreur : la catégorie elle-même n'est pas
  // perso). Dans l'arborescence "Catégories & flux personnalisés" (catégorie
  // perso pure), le badge reste sur la catégorie — inutile de le répéter sur
  // chaque flux puisque TOUTE la catégorie y est déjà perso.
  function renderCustomFeedRow(feed: CustomFeedItem, showPersoBadge = false) {
    if (editingFeedId === feed.id) {
      return (
        <li key={feed.id} className="rounded-sm bg-ink/5 p-3">
          <div className="space-y-2">
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
        </li>
      );
    }

    return (
      <li
        key={feed.id}
        className="flex flex-wrap items-center justify-between gap-3 rounded-sm py-1.5 px-2 -mx-2 transition-colors hover:bg-ink/5"
      >
        <span className="text-sm">
          {feed.title}{" "}
          {showPersoBadge && (
            <span className="rounded-sm bg-ink px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-paper">
              perso
            </span>
          )}
          {/* Compte réel des articles déjà en base pour ce flux (total /
              visibles en direct) — seul moyen fiable de distinguer "le flux
              n'a jamais rien remonté" (0 articles, feed vide ou items sans
              guid/link/titre exploitable) de "des articles existent mais
              restent cachés" (visibles < total). */}
          <span className="mt-0.5 block text-xs italic text-sepia">
            {feed.articleCount === 0
              ? "0 article récupéré pour l'instant"
              : `${feed.articleCount} article${feed.articleCount > 1 ? "s" : ""} récupéré${feed.articleCount > 1 ? "s" : ""}, ${feed.visibleArticleCount} visible${feed.visibleArticleCount > 1 ? "s" : ""} en direct`}
            {feed.lastFetchedAt && ` · dernière récupération ${new Date(feed.lastFetchedAt).toLocaleString("fr-FR")}`}
          </span>
          {/* Dernier échec de récupération (parsing RSS impossible, hôte
              injoignable...) — sans ça, un flux qui échoue en boucle côté
              worker n'affiche jamais rien nulle part, sans aucune explication
              visible depuis l'admin (voir customFeeds.ts, lastFetchError). */}
          {feed.lastFetchError && (
            <span className="mt-0.5 block text-xs italic text-red-700" title={feed.lastFetchError}>
              Échec de récupération : {feed.lastFetchError}
            </span>
          )}
        </span>
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
              checked={feed.notify}
              onChange={() => toggleCustomFeedNotify(feed)}
              className="accent-journal"
            />
            notification
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
      </li>
    );
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
          <a href="/admin/logs" className="hover:underline">
            Journal
          </a>
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

      {/* PAS de "!error" ici : une erreur FreshRSS (ex. FreshRSS désactivé
          dans /admin/settings) ne doit pas cacher les catégories perso, qui
          se chargent via une route complètement indépendante
          (/api/admin/custom-categories) — categories vaut simplement [] dans
          ce cas, ce qui suffit déjà à ne montrer que les perso. */}
      {!loading && (categories.length > 0 || customCategories.length > 0) && (
        <CollapsibleSection title="Impression IA">
          <p className="newsprint mb-4 text-sm text-neutral-700">
            L’impression IA (la une générée sur la page d’accueil, uniquement les news du jour) est
            indépendante d’« En direct » : elle liste ici TOUTES les catégories, FreshRSS ET
            personnalisées, cochées ou non pour En direct, et travaille directement sur les news
            récupérées à la source. Décocher une catégorie ci-dessous la retire uniquement de
            l’impression IA — elle reste inchangée partout ailleurs (En direct, recherche, archive).
            Un flux explicitement exclu (ci-dessous) reste exclu même ici.
          </p>
          <ul className="mb-10 border-t-2 border-ink">
            {(() => {
              // Même fusion/tri que la liste "Catégories & flux" plus bas
              // (SelectedCategory.order partagé) — sur demande explicite : les
              // catégories perso doivent apparaître ICI AUSSI, pas seulement
              // dans l'arborescence générale, chacune avec son tag pour rester
              // identifiable au premier coup d'œil.
              type Row = { kind: "freshrss"; cat: Category } | { kind: "custom"; cat: CustomCategoryItem };
              const rows: Row[] = [
                ...categories.map((cat) => ({ kind: "freshrss" as const, cat })),
                ...customCategories.map((cat) => ({ kind: "custom" as const, cat }))
              ].sort((a, b) => {
                const oa = a.cat.order;
                const ob = b.cat.order;
                if (oa !== null && ob !== null) return oa - ob;
                if (oa !== null) return -1;
                if (ob !== null) return 1;
                return a.cat.label.localeCompare(b.cat.label);
              });

              return rows.map((row) => (
                <li
                  key={row.kind === "custom" ? `custom-${row.cat.id}` : row.cat.freshrssId}
                  className="flex items-center justify-between gap-4 border-b border-ink/30 py-3"
                >
                  <span className="font-display font-bold">
                    {row.cat.label}{" "}
                    {row.kind === "custom" ? (
                      <span className="rounded-sm bg-ink px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-paper">
                        perso
                      </span>
                    ) : (
                      <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                        freshrss
                      </span>
                    )}
                  </span>
                  <label className="flex shrink-0 items-center gap-2 text-xs italic text-sepia">
                    <input
                      type="checkbox"
                      checked={row.cat.frontPageEnabled}
                      onChange={() =>
                        row.kind === "custom" ? toggleCustomCategoryFrontPage(row.cat) : toggleFrontPage(row.cat)
                      }
                      className="accent-ink"
                    />
                    inclure dans l’impression IA
                  </label>
                </li>
              ));
            })()}
          </ul>
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Catégories & flux personnalisés">
      <p className="newsprint mb-6 text-sm text-neutral-700">
        Crée d’abord une catégorie personnalisée si besoin, ajoute ensuite un flux RSS/Atom (sans
        passer par FreshRSS) en choisissant où le ranger — une catégorie FreshRSS existante (le flux
        est alors traité en tout point comme un flux FreshRSS de cette catégorie, affichage En direct
        et génération IA compris), une catégorie personnalisée déjà créée, ou une toute nouvelle
        catégorie créée à la volée. Mêmes cases qu’un flux FreshRSS (inclure, médaille), même
        filtrage/mise en forme, récupérés à l’intervalle global réglable dans{" "}
        <a href="/admin/settings" className="underline">
          /admin/settings
        </a>
        . Gestion et affichage entièrement centralisés dans « Catégories & flux » ci-dessus : la
        catégorie perso que tu crées ici y apparaît immédiatement, mêlée aux catégories FreshRSS,
        chacune identifiée par un tag (« FreshRSS » ou « Perso ») — plus de liste séparée en double
        ici, uniquement la création.
      </p>

      <div className="mb-6 flex flex-wrap items-center gap-3 border-b-2 border-ink pb-4">
        <button
          type="button"
          onClick={forceSyncCustomFeeds}
          disabled={forcingSync}
          className="border border-ink px-3 py-2 text-xs uppercase tracking-[0.2em] hover:bg-ink hover:text-paper disabled:opacity-50"
        >
          {forcingSync ? "Récupération en cours..." : "Forcer la récupération maintenant"}
        </button>
        {forceSyncMessage && <p className="text-sm italic text-sepia">{forceSyncMessage}</p>}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-ink/30 pb-4">
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
      {customCategoriesError && <p className="mb-3 text-sm text-journal">{customCategoriesError}</p>}
      {(customFeedsLoading || customCategoriesLoading) && (
        <p className="italic text-sepia">Chargement...</p>
      )}
      </CollapsibleSection>

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
      ) : (
        <>
          {/* Erreur FreshRSS affichée en simple NOTE, plus en blocage total :
              tes catégories/flux personnalisés se chargent indépendamment et
              doivent rester visibles même si FreshRSS est désactivé ou
              injoignable (voir le commentaire sur "Impression IA" ci-dessus).
              Un seul encadré (feedsError) plutôt que deux messages quasi
              identiques l'un sous l'autre (error + feedsError renvoient la
              même cause côté serveur). */}
          {feedsError && (
            <div className="mb-4 border border-journal/40 bg-journal/5 p-3 text-sm text-journal">
              {feedsError}
            </div>
          )}
          {feedsLoading && (
            <p className="mb-3 italic text-sepia">Chargement des flux depuis FreshRSS...</p>
          )}

          <ul className="border-t-2 border-ink">
            {(() => {
              // Fusion des catégories FreshRSS et perso dans UNE SEULE liste
              // triée (même source d'ordre pour les deux : SelectedCategory.
              // order, voir Category.order / CustomCategoryItem.order) — sur
              // demande explicite : "monter les categories persos avec les
              // categories fresh rss" plutôt que deux arborescences séparées.
              // Chaque ligne garde un tag ("FRESHRSS" / "PERSO") pour rester
              // identifiable au premier coup d'œil.
              type Row = { kind: "freshrss"; cat: Category } | { kind: "custom"; cat: CustomCategoryItem };
              const rows: Row[] = [
                ...categories.map((cat) => ({ kind: "freshrss" as const, cat })),
                ...customCategories.map((cat) => ({ kind: "custom" as const, cat }))
              ].sort((a, b) => {
                const oa = a.cat.order;
                const ob = b.cat.order;
                if (oa !== null && ob !== null) return oa - ob;
                if (oa !== null) return -1;
                if (ob !== null) return 1;
                return a.cat.label.localeCompare(b.cat.label);
              });

              // Flux perso rattachés à une catégorie FreshRSS qui n'apparaît
              // plus dans `categories` (FreshRSS désactivé dans
              // /admin/settings, ou catégorie disparue côté FreshRSS) — sans
              // ça, ces flux restent en base et continuent de fonctionner
              // (leur freshrssCategoryLabel est un instantané, pas une
              // jointure live, voir resolveFeedCategory dans customFeeds.ts)
              // mais deviennent invisibles/ingérables ici, faute de ligne de
              // catégorie à laquelle les rattacher dans l'arborescence.
              // Regroupés dans une catégorie fantôme "Sans catégorie" le
              // temps de leur réassigner une vraie catégorie perso via
              // "Modifier".
              const orphanedCustomFeeds = customFeeds.filter(
                (f) =>
                  f.isFreshrssCategory &&
                  f.freshrssCategoryId &&
                  !categories.some((c) => c.freshrssId === f.freshrssCategoryId)
              );

              if (rows.length === 0 && orphanedCustomFeeds.length === 0) {
                return (
                  <p className="py-6 text-center italic text-sepia">
                    Aucune catégorie disponible pour l’instant (FreshRSS et personnalisées).
                  </p>
                );
              }

              return (
                <>
                  {orphanedCustomFeeds.length > 0 && (
                    <li className="border-b border-dashed border-journal/50 bg-journal/5">
                      <div className="flex flex-wrap items-center gap-3 py-2.5">
                        <span className="flex items-center gap-2 font-display font-bold">
                          <span className="inline-block w-3 text-xs text-journal">▾</span>
                          Sans catégorie
                          <span className="text-xs font-normal italic text-sepia">
                            ({orphanedCustomFeeds.length})
                          </span>
                          <span className="rounded-sm bg-journal px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-paper">
                            fantôme
                          </span>
                        </span>
                        <span className="text-xs italic text-sepia">
                          Catégorie FreshRSS introuvable (désactivé ou supprimé) — réassigne une
                          catégorie perso via « Modifier » sur chaque flux.
                        </span>
                      </div>
                      <ul className="ml-2 border-l border-dashed border-ink/40 pb-3 pl-5">
                        {orphanedCustomFeeds.map((feed) => renderCustomFeedRow(feed, true))}
                      </ul>
                    </li>
                  )}
                  {rows.map((row) => {
                if (row.kind === "custom") {
                  const cat = row.cat;
                  const catFeeds = customFeeds.filter((f) => f.customCategoryId === cat.id);
                  const isCollapsed = customCollapsed.has(cat.id);
                  return (
                    <li key={`custom-${cat.id}`} className="border-b border-ink/30">
                      <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                        {renameCustomId === cat.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={renameCustomValue}
                              onChange={(e) => setRenameCustomValue(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && renameCustomCategory(cat)}
                              autoFocus
                              className="border border-ink/40 bg-transparent px-2 py-1 text-sm"
                            />
                            <button
                              type="button"
                              onClick={() => renameCustomCategory(cat)}
                              disabled={renaming}
                              className="text-xs uppercase tracking-[0.2em] hover:underline disabled:opacity-50"
                            >
                              OK
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenameCustomId(null)}
                              className="text-xs uppercase tracking-[0.2em] text-sepia hover:underline"
                            >
                              Annuler
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => toggleCustomExpanded(cat.id)}
                            className="flex items-center gap-2 text-left font-display font-bold hover:underline"
                          >
                            <span className="inline-block w-3 text-xs text-sepia">
                              {isCollapsed ? "▸" : "▾"}
                            </span>
                            {cat.label}
                            <span className="text-xs font-normal italic text-sepia">({catFeeds.length})</span>
                            <span className="rounded-sm bg-ink px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-paper">
                              perso
                            </span>
                          </button>
                        )}
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
                          {renameCustomId !== cat.id && (
                            <button
                              type="button"
                              onClick={() => {
                                setRenameCustomId(cat.id);
                                setRenameCustomValue(cat.label);
                              }}
                              className="text-xs uppercase tracking-[0.2em] hover:underline"
                            >
                              Renommer
                            </button>
                          )}
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
                          {catFeeds.map((feed) => renderCustomFeedRow(feed))}
                          {catFeeds.length === 0 && (
                            <p className="py-1.5 text-xs italic text-sepia">Aucun flux dans cette catégorie.</p>
                          )}
                        </ul>
                      )}
                    </li>
                  );
                }

                const cat = row.cat;
                const childFeeds = feeds.filter((f) => f.categoryLabels.includes(cat.label));
                // Flux personnalisés rattachés directement à CETTE catégorie
                // FreshRSS (voir /admin/categories, formulaire "Flux
                // personnalisés") — affichés ici, mêlés aux vrais flux
                // FreshRSS, pour une arborescence fidèle à leur traitement en
                // aval (même catégorie = mêmes réglages En direct/Impression
                // IA).
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
                      <div className="flex items-center gap-2">
                        {/* Poignée de glissé séparée du bouton de dépliage : un
                            seul élément à la fois draggable ET cliquable fait
                            que le navigateur interprète parfois un simple clic
                            comme un début de glissé (surtout au 2e clic), ce
                            qui bloquait le repli. */}
                        <span
                          draggable
                          onDragStart={() => setDraggedId(cat.freshrssId)}
                          onDragEnd={() => setDraggedId(null)}
                          title="Glisser pour réordonner"
                          className="cursor-grab select-none px-1 text-sepia active:cursor-grabbing"
                        >
                          ⠿
                        </span>
                        {renameFreshrssId === cat.freshrssId ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={renameFreshrssValue}
                              onChange={(e) => setRenameFreshrssValue(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && renameFreshrssCategory(cat)}
                              autoFocus
                              className="border border-ink/40 bg-transparent px-2 py-1 text-sm"
                            />
                            <button
                              type="button"
                              onClick={() => renameFreshrssCategory(cat)}
                              disabled={renaming}
                              className="text-xs uppercase tracking-[0.2em] hover:underline disabled:opacity-50"
                            >
                              OK
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenameFreshrssId(null)}
                              className="text-xs uppercase tracking-[0.2em] text-sepia hover:underline"
                            >
                              Annuler
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(cat.freshrssId)}
                            className="flex items-center gap-2 text-left font-display font-bold hover:underline"
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
                            <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                              freshrss
                            </span>
                          </button>
                        )}
                      </div>
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
                        {/* Renommer une catégorie FreshRSS écrit RÉELLEMENT
                            dans FreshRSS (voir renameCategory,
                            src/lib/freshrss.ts) — proposé seulement quand
                            l'intégration est activée, sinon l'appel
                            échouerait de toute façon (config() lève). */}
                        {freshrssEnabled && renameFreshrssId !== cat.freshrssId && (
                          <button
                            type="button"
                            onClick={() => {
                              setRenameFreshrssId(cat.freshrssId);
                              setRenameFreshrssValue(cat.label);
                            }}
                            className="text-xs uppercase tracking-[0.2em] hover:underline"
                          >
                            Renommer
                          </button>
                        )}
                      </div>
                    </div>

                    {!isCollapsed && !feedsLoading && (
                      <ul className="ml-2 border-l border-dashed border-ink/40 pb-3 pl-5">
                        {childFeeds.map((feed) => (
                          <li
                            key={feed.freshrssId}
                            className="flex items-center justify-between gap-4 rounded-sm py-1.5 px-2 -mx-2 transition-colors hover:bg-ink/5"
                          >
                            <span className="text-sm">
                              {feed.title}{" "}
                              <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                                freshrss
                              </span>
                              <span className="mt-0.5 block text-xs italic text-sepia">
                                {feed.articleCount === 0
                                  ? "0 article récupéré pour l'instant"
                                  : `${feed.articleCount} article${feed.articleCount > 1 ? "s" : ""} récupéré${feed.articleCount > 1 ? "s" : ""}, ${feed.visibleArticleCount} visible${feed.visibleArticleCount > 1 ? "s" : ""} en direct`}
                              </span>
                            </span>
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
                                  checked={feed.notify}
                                  onChange={() => toggleNotify(feed)}
                                  className="accent-journal"
                                />
                                notification
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
                        {childCustomFeeds.map((feed) => renderCustomFeedRow(feed, true))}
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
                </>
              );
            })()}
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
                              checked={feed.notify}
                              onChange={() => toggleNotify(feed)}
                              className="accent-journal"
                            />
                            notification
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