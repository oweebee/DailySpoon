"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Remplace les "o" de "Sp[o][o]n" dans le masthead par la même silhouette
 *  de cuillère (bol + manche) que le cul-de-lampe SpoonDivider en bas de
 *  page, plutôt qu'un simple ovale — dimensionnée en unités "em" pour
 *  suivre la taille de la police du titre (text-5xl / md:text-7xl) et
 *  rester à la même hauteur que les autres lettres. */
function SpoonO() {
  return (
    <svg
      viewBox="0 0 24 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="-mx-[0.04em] inline-block h-[1em] w-[0.48em] align-[-0.2em]"
    >
      <ellipse cx="12" cy="6.2" rx="5.1" ry="6.2" fill="currentColor" />
      <rect x="10.6" y="11.4" width="2.8" height="11.2" rx="1.4" fill="currentColor" />
    </svg>
  );
}

export function Masthead({
  date,
  compact = false,
  action,
  titleAside,
  navExtra,
}: {
  date: Date;
  /** Version resserrée verticalement, utilisée uniquement pour la copie
   *  dupliquée en haut de chaque page du carrousel mobile (voir
   *  MobilePagedSection) — répétée à chaque swipe, elle repoussait le début
   *  des articles à plus de la moitié de l'écran sur téléphone. Le Masthead
   *  "normal" (desktop, une seule copie fixe) n'est pas concerné. */
  compact?: boolean;
  /** Timbre d'action propre à la page, calé à DROITE sur la ligne du titre :
   *  "Lancer l'impression du journal" sur l'accueil, "Télégraphier les
   *  nouvelles" sur /direct. Auparavant en gros bloc centré au-dessus du
   *  bandeau, ce qui repoussait le début des articles très bas — surtout en
   *  mobile, où ce bandeau est en plus dupliqué à chaque colonne. */
  action?: ReactNode;
  /** Élément posé à DROITE du titre, sur la même ligne — uniquement en mode
   *  compact (PWA). Sert au compte d'articles de l'accueil, qui occupait
   *  sinon une ligne à lui seul juste au-dessus du bandeau. */
  titleAside?: ReactNode;
  /** Élément ajouté à DROITE du menu, sur la même ligne (champ de recherche
   *  de la page "En direct"). Passé en tant que nœud plutôt que rendu ici :
   *  son état vit chez l'appelant, qui en fait quelque chose (filtrer la
   *  liste d'articles). */
  navExtra?: ReactNode;
}) {
  // Sert à mettre en évidence l'entrée de menu correspondant à la page
  // courante. usePathname plutôt qu'une propriété à transmettre : ce bandeau
  // est rendu depuis une demi-douzaine d'endroits, dont certains composants
  // serveur, et il aurait fallu faire descendre l'information à travers
  // toute la chaîne du carrousel mobile juste pour colorer un lien.
  const pathname = usePathname();
  // Le Journal IA vit sur /journal depuis la V1 ; l'accueil ("/") est la page
  // "En direct".
  const isJournalPage = pathname === "/journal";

  const formatted = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);

  // Groupe des timbres (raccourci "En direct" + timbre d'action de la page),
  // extrait en variable parce qu'il se place à DEUX endroits différents selon
  // la largeur : à droite du titre en desktop, et sur une ligne à lui en
  // compact (PWA) — voir le rendu plus bas.
  //
  // "items-start" et non "items-center" : le timbre d'impression emporte sous
  // lui une mention d'avertissement (conso de tokens), ce qui rend son bloc
  // plus haut que le timbre "En direct" voisin. Centrés, les deux blocs
  // s'alignaient sur leur milieu — donc des bords hauts décalés, alors que ce
  // sont les BOUTONS eux-mêmes qu'on veut voir alignés.
  // Groupe du timbre d'action de la page — "Lancer l'impression" sur le
  // Journal IA, "Télégraphier les nouvelles" sur l'accueil "En direct".
  // UN SEUL timbre par page : le raccourci "En direct" qui l'accompagnait a
  // disparu avec la V1, "En direct" étant devenu l'accueil (le titre y ramène
  // déjà, et le menu propose "Journal IA" pour l'autre sens).
  //
  // Extrait en variable parce qu'il se place à DEUX endroits selon la
  // largeur : à droite du titre en desktop, sur une ligne à lui en compact.
  const stamps = (
    <div className={`stamp-row flex items-start gap-2 sm:gap-3 ${compact ? "w-full" : "shrink-0"}`}>
      {action}
    </div>
  );

  return (
    <header className={compact ? "mb-3" : "mb-10"}>
      {/* Bloc "tête de journal" : bandeau du haut, ligne du titre, double
          filet. Plus aucun positionnement absolu ici depuis que les timbres
          vivent dans la ligne du titre elle-même (voir plus bas). */}
      <div>
        {/* Filet supérieur seul : les mentions "Édition quotidienne
            personnelle" / "Prix : ≈ 10 ¢" qui l'accompagnaient ont été
            retirées (purement décoratives, elles coûtaient une ligne de
            hauteur sur chaque copie du bandeau — et le carrousel mobile en
            affiche une par colonne). Le trait, lui, reste : c'est lui qui
            ferme le haut de la tête de journal. */}
        <div className="border-b border-ink" />

        {/* Ligne du titre : nom du journal calé à GAUCHE, bouton d'action de
            la page calé à DROITE. Une seule et même disposition en mobile
            comme en desktop. "shrink-0" sur le groupe de droite pour que ce
            soit le titre qui cède de la place si l'écran est vraiment
            étroit, jamais le bouton. */}
        <div className={`flex items-center justify-between gap-3 ${compact ? "py-2" : "py-5"}`}>
          <Link
            href="/"
            // Titre en compact : agrandi de 25% (text-xl -> 1.5625rem) le
            // 2026-08-24, une fois les trois cuillères remontées sur la ligne
            // "En direct" de DirectView (elles ne partagent plus cette ligne
            // avec le titre, donc la place laissée par ce resserrement
            // profite au titre et au bouton d'action).
            className={`masthead-title font-masthead font-black uppercase leading-none tracking-tight ${
              compact ? "text-[1.5625rem]" : "text-4xl md:text-6xl"
            }`}
          >
            DailySp
            <SpoonO />
            <SpoonO />n
          </Link>

          {/* En COMPACT (PWA) : le titre partage sa ligne avec le compte
              d'articles, calé à droite — celui-ci occupait sinon une ligne
              entière juste au-dessus du bandeau. Les timbres, eux, descendent
              sur leur propre ligne (voir juste en dessous) où ils disposent
              de toute la largeur.
              En desktop : disposition inchangée, les timbres restent à droite
              du titre. */}
          {compact ? titleAside : stamps}
        </div>

        {/* Ligne de timbres en pleine largeur, réservée au mode compact : sur
            un écran de téléphone, titre ET timbres sur la même ligne ne
            laissaient à chacun qu'une place étriquée. */}
        {compact && <div className="pb-2">{stamps}</div>}

        <div className="double-rule" />
      </div>

      {/* Ligne de date entre deux filets — en mobile, la date et le menu ne
          tiennent pas côte à côte (la date se repliait sur 3 lignes serrées et
          le menu débordait hors de l'écran, "Admin" tronqué). On les empile
          donc, centrés, en dessous du seuil sm ; le menu passe à la ligne
          proprement (flex-wrap) au lieu de déborder. Au-delà de sm, on retrouve
          exactement l'ancienne disposition sur une seule ligne (date à gauche,
          menu à droite). En compact, tout est resserré (gap/texte plus
          petits) mais la structure empilée reste identique. */}
      <div
        className={`flex flex-col items-center uppercase sm:flex-row sm:justify-between sm:gap-0 ${
          compact ? "gap-0.5 py-0.5 text-[0.6rem] tracking-[0.15em]" : "gap-1.5 py-1.5 text-xs tracking-[0.2em]"
        }`}
      >
        <span className="capitalize">{formatted}</span>
        <nav
          className={`flex flex-wrap items-center justify-center sm:flex-nowrap sm:gap-y-0 ${
            compact ? "gap-x-3 gap-y-0.5 sm:gap-x-4" : "gap-x-5 gap-y-1 sm:gap-x-6"
          }`}
        >
          {/* "Journal IA" ne s'affiche en couleur que lorsqu'on EST sur cette
              page — c'est un repère de position, pas une décoration
              permanente. Ailleurs il se fond dans le menu comme les autres
              entrées. Pas d'entrée "En direct" : c'est l'accueil, et le titre
              DailySpoon y ramène déjà. */}
          <Link href="/journal" className={`${isJournalPage ? "text-journal" : ""} hover:underline`}>
            Journal IA
          </Link>
          <Link href="/archive" className="hover:underline">
            Archives
          </Link>
          <Link href="/favoris" className="hover:underline">
            Favoris
          </Link>
          <Link href="/admin/categories" className="text-sepia hover:underline">
            Admin
          </Link>
          {navExtra}
        </nav>
      </div>
      <div className="double-rule rotate-180" />
    </header>
  );
}
