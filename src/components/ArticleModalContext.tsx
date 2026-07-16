"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type ArticleModalState = {
  url: string;
  title?: string;
} | null;

// Reddit bloque les requêtes serveur-à-serveur (voir /api/article-proxy) —
// y compris l'API JSON officielle et les miroirs de secours essayés. Seule
// solution qui reste : le widget d'embed officiel de Reddit
// (embed.redditmedia.com), chargé et exécuté par le NAVIGATEUR du
// visiteur — donc avec son IP, jamais bloquée. Contrepartie : ça affiche
// une carte compacte (façon embed de tweet), pas le texte intégral du post.
const REDDIT_POST_RE = /reddit\.com\/r\/[^/]+\/comments\//i;

function isRedditPostUrl(url: string): boolean {
  return REDDIT_POST_RE.test(url);
}

function redditSubreddit(url: string): string | null {
  const m = /reddit\.com\/r\/([^/]+)/i.exec(url);
  return m ? m[1] : null;
}

function RedditEmbed({ url, title }: { url: string; title?: string }) {
  useEffect(() => {
    const w = window as unknown as { rembeddit?: { watch: () => void } };
    if (w.rembeddit?.watch) {
      w.rembeddit.watch();
      return;
    }
    if (document.getElementById("reddit-embed-platform-script")) return;
    const script = document.createElement("script");
    script.id = "reddit-embed-platform-script";
    script.src = "https://embed.redditmedia.com/widgets/platform.js";
    script.async = true;
    document.body.appendChild(script);
  }, [url]);

  const sub = redditSubreddit(url);

  return (
    <div className="h-full w-full overflow-auto bg-paper p-6">
      <blockquote className="reddit-embed-bq" data-embed-height="500">
        <a href={url}>{title || url}</a>
        {sub && (
          <>
            {" "}
            dans <a href={`https://www.reddit.com/r/${sub}/`}>r/{sub}</a>
          </>
        )}
      </blockquote>
      <p className="mt-4 text-center text-xs italic text-sepia">
        Aperçu Reddit — chargé directement par ton navigateur (le serveur de DailySpoon est
        bloqué par Reddit). Pour le texte intégral, utilise « Ouvrir dans un nouvel onglet ».
      </p>
    </div>
  );
}

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
            <div className="flex items-center justify-end gap-4 border-b-2 border-ink px-4 py-2.5">
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
            {isRedditPostUrl(state.url) ? (
              // Reddit bloque notre proxy serveur (voir /api/article-proxy) —
              // on bascule sur son widget d'embed officiel, chargé côté
              // navigateur avec l'IP du visiteur plutôt que celle du serveur.
              <RedditEmbed url={state.url} title={state.title} />
            ) : (
              // Passe par notre proxy d'article (extraction Readability,
              // façon Morss) plutôt que de charger le site source
              // directement : beaucoup de sites (TechCrunch, Numerama, ...)
              // refusent l'affichage en iframe via X-Frame-Options/CSP. Le
              // contenu servi ici vient de notre propre domaine, donc
              // jamais bloqué.
              <iframe
                src={`/api/article-proxy?url=${encodeURIComponent(state.url)}`}
                title={state.title || "Article"}
                className="h-full w-full flex-1 bg-paper"
              />
            )}
          </div>
        </div>
      )}
    </ArticleModalContext.Provider>
  );
}
