"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditionView, SourceLine, formatStamp, directTitle, directText, directHref, type ArticleLike, type CategoryOrderEntry } from "./EditionView";
import { ArticleImage } from "./ArticleImage";
import { ArticleLink } from "./ArticleLink";
import { WesternMagnifier } from "./WesternMagnifier";
import { Masthead } from "./Masthead";

export function DirectView({
  initialArticles,
  categoryOrder = [],
  date,
  syncedAt,
  mastheadAction
}: {
  initialArticles: ArticleLike[];
  categoryOrder?: CategoryOrderEntry[];
  /** Dupliquée en haut de chaque page du carrousel mobile — voir
   *  EditionView/CategoryGrid/MobilePagedSection. */
  date: Date;
  /** Heure de la dernière récupération de flux, affichée à côté de la date —
   *  voir Masthead. */
  syncedAt?: Date | string | null;
  /** Timbre "Télégraphier les nouvelles" — SEUL timbre d'action de cette
   *  page (le Journal IA a le sien, "Lancer l'impression"). Relayé jusqu'au
   *  Masthead du carrousel mobile. */
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

  // Champ de recherche transmis au Masthead pour être posé À DROITE du menu,
  // après "Admin" — et non plus sur une ligne à lui juste en dessous. Son
  // état reste ici : c'est DirectView qui s'en sert pour remplacer la liste
  // d'articles par les résultats. Le Masthead ne fait que l'afficher.
  const searchField = (
    <label className="ml-auto flex shrink-0 items-center gap-2 border-b border-ink/40 pb-0.5 focus-within:border-journal">
      <WesternMagnifier className="h-3.5 w-3.5 shrink-0 text-ink/70" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Rechercher…"
        // Étroit, et normalisé (ni majuscules ni interlettrage) : il hérite
        // sinon du style du menu qui l'entoure, ce qui donne un champ de
        // saisie tout en capitales espacées.
        className="w-24 bg-transparent text-xs normal-case italic tracking-normal text-ink placeholder:text-sepia/70 focus:outline-none sm:w-40"
      />
    </label>
  );

  return (
    // "shell-fill" : maillon de la chaîne de hauteur qui descend du <main>
    // jusqu'au carrousel (voir globals.css). Un maillon manquant et le
    // carrousel se retrouve sans hauteur.
    <div className="shell-fill">
      {/* Bandeau desktop rendu ICI et non dans la page : le champ de
          recherche ci-dessus doit y être injecté, or son état vit dans ce
          composant client. Le laisser dans la page (composant serveur)
          rendait impossible de l'y faire descendre. */}
      <div className="hidden md:block">
        <Masthead date={date} syncedAt={syncedAt} action={mastheadAction} navExtra={searchField} />
      </div>

      {/* Bandeau MOBILE, rendu ici et une seule fois — le carrousel n'en pose
          plus par colonne sur cette page (showMasthead={false} plus bas).
          C'est indispensable pour la recherche : le champ vit dans ce bandeau
          (calé à droite du titre, voir titleAside), or dès la première lettre
          tapée les résultats remplacent le carrousel. Une copie par colonne
          disparaîtrait donc du DOM au moment précis où on écrit dedans,
          emportant le focus et le clavier — et la page semblait se vider. */}
      {/* "shrink-0" : dans la coquille plein écran (voir globals.css), ce
          bandeau garde sa hauteur naturelle — c'est le carrousel en dessous
          qui absorbe toute la place restante, pas lui qui se comprime. */}
      <div className="shrink-0 md:hidden">
        <Masthead
          date={date}
          syncedAt={syncedAt}
          compact
          action={mastheadAction}
          titleAside={searchField}
        />
      </div>

      {isSearching ? (
        // Les résultats remplacent le carrousel : ils reprennent donc son
        // rôle d'élément extensible, et défilent eux-mêmes.
        <div className="shell-scroll">
          <SearchResults results={searchResults} searching={searching} />
        </div>
      ) : initialArticles.length === 0 ? (
        <p className="shell-scroll py-24 text-center italic text-sepia">
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
          showMasthead={false}
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
          <p className="mt-1 line-clamp-[10] text-[0.8rem] leading-snug text-neutral-700">
            {directText(article)}
          </p>
          <SourceLine article={article} showDate={!article.imageUrl} />
        </article>
      ))}
    </div>
  );
}

