"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type ArticleModalState = {
  url: string;
  title?: string;
} | null;

type ArticleModalContextValue = {
  openArticle: (url: string, title?: string) => void;
};

const ArticleModalContext = createContext<ArticleModalContextValue | null>(null);

export function useArticleModal(): ArticleModalContextValue {
  const ctx = useContext(ArticleModalContext);
  if (!ctx) {
    // Ne devrait pas arriver (ArticleModalProvider est monté dans le layout
    // racine) — filet de sécurité qui se rabat sur une navigation normale.
    return {
      openArticle: (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    };
  }
  return ctx;
}

/**
 * Fenêtre interne à l'app pour lire un article sans quitter DailySpoon ni
 * ouvrir un nouvel onglet. Charge l'article via /api/article-proxy (extrait
 * proprement côté serveur avec Readability, façon Morss) plutôt que le site
 * source directement — ce qui contourne le blocage iframe que beaucoup de
 * sites imposent (X-Frame-Options / CSP frame-ancestors). Le lien "Ouvrir
 * dans un nouvel onglet" reste un filet de secours si l'extraction échoue.
 */
export function ArticleModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ArticleModalState>(null);

  // Sans ça, ouvrir un article ne touchait jamais l'historique du
  // navigateur — le bouton/geste "retour" d'Android navigue alors tout
  // droit hors de la page (voire hors de l'app) plutôt que de simplement
  // refermer la fenêtre de lecture. On ajoute donc une entrée d'historique
  // factice (même URL, rien ne change à l'écran) à l'ouverture, uniquement
  // pour que le retour arrière ait quelque chose à "consommer" : il fait
  // alors reculer l'historique jusqu'à l'entrée d'avant l'ouverture — pile
  // là où on veut atterrir — et on se contente de refermer la fenêtre côté
  // React en réaction à cet événement, sans naviguer nous-mêmes.
  useEffect(() => {
    function handlePopState() {
      setState(null);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function openArticle(url: string, title?: string) {
    window.history.pushState({ articleModal: true }, "");
    setState({ url, title });
  }

  function close() {
    setState(null);
    // Fermeture via le bouton "Fermer" (pas via le retour arrière, qui a
    // déjà consommé cette entrée avant même d'appeler close) : on dépile
    // nous-mêmes l'entrée factice ajoutée à l'ouverture, sinon un prochain
    // retour arrière ne ferait que revenir dessus au lieu de vraiment
    // quitter la page.
    if (typeof window !== "undefined" && window.history.state?.articleModal) {
      window.history.back();
    }
  }

  // Requête de recherche pour le bouton "Chercher sur Google" — le titre de
  // la news si on l'a (cas normal), sinon le nom de domaine du lien source
  // en dernier recours plutôt qu'une exception (new URL() peut planter sur
  // une URL mal formée, jamais souhaitable en plein rendu).
  function googleSearchQuery(url: string, title?: string): string {
    if (title) return title;
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  return (
    <ArticleModalContext.Provider value={{ openArticle }}>
      {children}
      {state && (
        <div
          className="modal-backdrop-fade fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4 md:p-8"
          onClick={close}
        >
          <div
            key={state.url}
            className="page-turn flex h-full w-full max-w-4xl flex-col border-2 border-ink bg-paper shadow-[0_20px_80px_-20px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-end gap-4 border-b-2 border-ink px-4 py-2.5">
              <div className="flex shrink-0 items-center gap-4 text-xs uppercase tracking-[0.2em]">
                {
                  // Recherche Google sur le TITRE de la news (pas l'URL) —
                  // utile quand l'extraction de l'article a échoué (voir
                  // article-proxy) ou pour retrouver d'autres sources sur le
                  // même sujet. Repli sur le nom de domaine si jamais aucun
                  // titre n'a été transmis (ArticleLink, title optionnel).
                }
                <a
                  href={`https://www.google.com/search?q=${encodeURIComponent(googleSearchQuery(state.url, state.title))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  Chercher sur Google ↗
                </a>
                <button onClick={close} className="font-bold hover:underline" aria-label="Fermer">
                  ✕ Fermer
                </button>
              </div>
            </div>
            {
              // Passe par notre proxy d'article (extraction Readability,
              // façon Morss) plutôt que de charger le site source
              // directement : beaucoup de sites (TechCrunch, Numerama, ...)
              // refusent l'affichage en iframe via X-Frame-Options/CSP. Le
              // contenu servi ici vient de notre propre domaine, donc
              // jamais bloqué — y compris pour Reddit désormais (miroirs
              // Redlib + API JSON officielle + repli image/vidéo directe,
              // voir article-proxy/route.ts) : plus besoin du widget
              // d'embed officiel Reddit (carte compacte hors charte
              // graphique) qui servait ici en dernier recours auparavant.
            }
            <iframe
              src={`/api/article-proxy?url=${encodeURIComponent(state.url)}`}
              title={state.title || "Article"}
              className="h-full w-full flex-1 bg-paper"
            />
          </div>
        </div>
      )}
    </ArticleModalContext.Provider>
  );
}
