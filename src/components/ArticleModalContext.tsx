"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

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

  function openArticle(url: string, title?: string) {
    setState({ url, title });
  }

  function close() {
    setState(null);
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
            <div className="flex items-center justify-between gap-4 border-b-2 border-ink px-4 py-2.5">
              <p className="truncate text-xs uppercase tracking-[0.2em] text-sepia">
                {state.title || state.url}
              </p>
              <div className="flex shrink-0 items-center gap-4 text-xs uppercase tracking-[0.2em]">
                <a
                  href={state.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  Ouvrir dans un nouvel onglet ↗
                </a>
                <button onClick={close} className="font-bold hover:underline" aria-label="Fermer">
                  ✕ Fermer
                </button>
              </div>
            </div>
            {/* Passe par notre proxy d'article (extraction Readability,
                façon Morss) plutôt que de charger le site source
                directement : beaucoup de sites (TechCrunch, Numerama, ...)
                refusent l'affichage en iframe via X-Frame-Options/CSP. Le
                contenu servi ici vient de notre propre domaine, donc
                jamais bloqué. */}
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
