"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditionView, SourceLine, formatStamp, directTitle, directText, directHref, type ArticleLike, type CategoryOrderEntry } from "./EditionView";
import { ArticleImage } from "./ArticleImage";
import { ArticleLink } from "./ArticleLink";
import { SpoonDivider } from "./SpoonDivider";

export function DirectView({
  initialArticles,
  categoryOrder = [],
  date,
  mastheadAction
}: {
  initialArticles: ArticleLike[];
  categoryOrder?: CategoryOrderEntry[];
  /** Dupliquée en haut de chaque page du carrousel mobile — voir
   *  EditionView/CategoryGrid/MobilePagedSection. */
  date: Date;
  /** Timbre "Télégraphier les nouvelles", relayé jusqu'au Masthead du
   *  carrousel mobile. Le timbre "En direct" y est toujours masqué : on est
   *  déjà sur cette page. */
  mastheadAction?: ReactNode;
}) {
  // Recherche live : interroge /api/articles/search (tout l'historique en
  // base, pas seulement les ~1000 articles chargés dans initialArticles),
  // avec un léger debounce pour ne pas déclencher une requête à chaque
  // frappe.
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ArticleLike[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/articles/search?q=${encodeURIComponent(q)}`);
        const body = await res.json().catch(() => ({}));
        setSearchResults(body.articles || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const isSearching = query.trim().length > 0;

  return (
    <div>
      {/* Le timbre "Télégraphier les nouvelles" ne vit plus ici : il est
          désormais calé à droite du titre dans le bandeau du haut (voir
          TelegraphButton, passé en "action" au Masthead depuis
          app/direct/page.tsx). Ne restent donc que l'intitulé de la page et
          le champ de recherche, désormais sur UNE SEULE ligne (avant :
          empilés, plus un gros filet noir en dessous — beaucoup de hauteur
          perdue avant le premier article).

          Grille à 3 colonnes (et non un simple flex justify-between) : la
          colonne de gauche et celle de la recherche à droite se
          partagent l'espace restant à parts égales (1fr), ce qui laisse
          "✦ En direct ✦" VRAIMENT centré sur la ligne — un
          justify-between l'aurait collé à gauche, et un centrage flex l'aurait
          décalé de la moitié de la largeur du champ de recherche.

          Colonne de gauche : les trois cuillères (mobile uniquement, voir
          SpoonDivider) — auparavant sur leur propre ligne, juste au-dessus du
          Masthead compact du carrousel (EditionView), ce qui creusait un
          espace vide entre cette ligne et le titre. Remontées ici, sur la
          même ligne que "En direct", pas de vide en plus, pas de ligne en
          moins. Vide sur desktop (span vide, comme avant) : ce bandeau y est
          juste au-dessus du Masthead desktop qui a déjà ses propres
          cuillères en fin de page (cul-de-lampe). */}
      <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:mb-6 sm:gap-3">
        <SpoonDivider className="text-left text-sepia md:hidden" />
        <p className="text-center text-xs uppercase tracking-[0.35em] text-journal">✦ En direct ✦</p>

        <div className="flex justify-end">
          <label className="flex items-center gap-2 border-b border-ink/40 pb-1 focus-within:border-journal">
            <WesternMagnifier className="h-4 w-4 shrink-0 text-ink/70" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher…"
              // Champ volontairement étroit sous sm : sur la même ligne que
              // l'intitulé, un champ large repousserait ce dernier hors de son
              // centrage (voire hors écran) sur un téléphone.
              className="w-28 bg-transparent text-sm italic text-ink placeholder:text-sepia/70 focus:outline-none sm:w-64"
            />
          </label>
        </div>
      </div>

      {isSearching ? (
        <SearchResults results={searchResults} searching={searching} />
      ) : initialArticles.length === 0 ? (
        <p className="py-24 text-center italic text-sepia">
          Rien pour l’instant — clique sur « Télégraphier les news » pour aller chercher les
          derniers articles.
        </p>
      ) : (
        <EditionView
          articles={initialArticles}
          categoryOrder={categoryOrder}
          clampSummary
          date={date}
          mastheadAction={mastheadAction}
          hideLiveStamp
        />
      )}
    </div>
  );
}

function SearchResults({ results, searching }: { results: ArticleLike[] | null; searching: boolean }) {
  if (searching && !results) {
    return <p className="py-16 text-center italic text-sepia">Recherche…</p>;
  }
  if (!results || results.length === 0) {
    return (
      <p className="py-16 text-center italic text-sepia">Aucun article ne correspond à cette recherche.</p>
    );
  }
  return (
    // Même grille et mêmes filets verticaux (calculés par position réelle
    // dans la rangée, pas "divide-x") que les colonnes de rubriques en "En
    // direct" — ici chaque carte est un article, pas une rubrique entière,
    // mais le rendu (photo, titre, texte plafonné à 10 lignes, source) est
    // identique.
    <div className="grid gap-x-0 gap-y-8 md:grid-cols-2 lg:grid-cols-4">
      {results.map((article) => (
        <article
          key={article.id}
          className="border-t border-ink/20 py-4 first:border-t-0 md:border-t-0 md:border-l md:border-ink/30 md:px-6 md:[&:nth-child(2n+1)]:border-l-0 md:[&:nth-child(2n+1)]:pl-0 md:[&:nth-child(2n)]:pr-0 lg:[&:nth-child(4n+3)]:border-l lg:[&:nth-child(4n+3)]:pl-6 lg:[&:nth-child(4n+2)]:pr-6"
        >
          {article.imageUrl && (
            <ArticleLink
              href={directHref(article)}
              title={directTitle(article)}
              className="mb-2 block aspect-[16/9] w-full"
            >
              <ArticleImage
                src={article.imageUrl}
                alt={directTitle(article)}
                dateLabel={formatStamp(article.publishedAt)}
                medal={article.medal}
                className="h-full w-full"
              />
            </ArticleLink>
          )}
          <h3 className="font-display text-base font-bold leading-snug">{directTitle(article)}</h3>
          <p className="newsprint mt-1 line-clamp-[10] text-[0.8rem] leading-snug text-neutral-700">
            {directText(article)}
          </p>
          <SourceLine article={article} showDate={!article.imageUrl} />
        </article>
      ))}
    </div>
  );
}

/** Loupe façon "chercheur d'or"/western : manche façon corde tressée
 *  (hachures obliques) plutôt qu'un simple trait plein. */
function WesternMagnifier({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="10" cy="10" r="6.5" />
      <line x1="14.6" y1="14.6" x2="21" y2="21" strokeWidth="2.2" />
      <line x1="15.3" y1="15.9" x2="16.4" y2="14.8" strokeWidth="0.9" />
      <line x1="16.8" y1="17.4" x2="17.9" y2="16.3" strokeWidth="0.9" />
      <line x1="18.3" y1="18.9" x2="19.4" y2="17.8" strokeWidth="0.9" />
    </svg>
  );
}
