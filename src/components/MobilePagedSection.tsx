import type { ReactNode } from "react";
import { Masthead } from "./Masthead";

/**
 * Carrousel mobile « une page = une rubrique », swipe horizontal.
 *
 * ————————————————————————————————————————————————————————————————
 * REFONTE DU 2026-08-29 — lire ceci avant de toucher à quoi que ce soit
 * ————————————————————————————————————————————————————————————————
 *
 * Ce composant ne contient PLUS UNE SEULE LIGNE de JavaScript, et c'est le
 * cœur du sujet. Tout est fait par le navigateur, en CSS (voir
 * .carousel-track / .carousel-page dans globals.css).
 *
 * CE QU'IL Y AVAIT AVANT, et pourquoi ça ne pouvait pas marcher :
 *
 * Les colonnes partageaient UNE SEULE position de défilement, celle de la
 * fenêtre. Une seule valeur pour N colonnes, alors qu'il en faut N. Tout le
 * reste n'était que du rattrapage autour de ce défaut d'origine :
 *
 *   - mémoriser la position de chaque colonne à la main, à chaque événement
 *     de défilement, dans un objet ;
 *   - détecter la fin du swipe (minuteur de silence, puis « scrollend ») pour
 *     savoir QUAND restaurer ;
 *   - animer soi-même le défilement vertical de rattrapage après coup ;
 *   - forcer la hauteur du conteneur à celle de la colonne active, la
 *     remesurer en continu au ResizeObserver, et orchestrer l'ordre entre ce
 *     changement de hauteur et l'animation pour éviter que le navigateur ne
 *     recale « scrollY » de force en raccourcissant le document.
 *
 * Chacun de ces quatre mécanismes avait ses propres cas limites, et ils
 * interagissaient entre eux. D'où, en usage réel : des blocages en descendant,
 * des remontées sans raison, des colonnes qui ne repartaient pas de leur
 * sommet, des sauts. Une dizaine de correctifs successifs n'ont jamais fait
 * qu'en déplacer les symptômes — le problème n'était pas dans les détails, il
 * était dans le principe.
 *
 * CE QU'IL Y A MAINTENANT :
 *
 * Chaque page est SA PROPRE zone de défilement vertical (overflow-y: auto,
 * hauteur = celle du carrousel). Le navigateur conserve nativement une
 * position par zone, comme il le fait depuis toujours.
 *
 *   - une colonne jamais lue est à 0, donc elle s'affiche en haut. Sans code.
 *   - une colonne déjà parcourue retrouve exactement où on l'avait laissée.
 *     Sans code.
 *   - le swipe horizontal ne touche jamais au défilement vertical : ce sont
 *     deux axes, deux zones, sans rapport. Plus rien à rattraper, donc plus
 *     aucun rattrapage à déclencher au bon moment.
 *   - plus aucune hauteur à mesurer ni à imposer : la page fait la hauteur du
 *     carrousel, point. Le document ne change jamais de taille, le navigateur
 *     n'a donc jamais à recaler quoi que ce soit.
 *
 * Plus de "use client" non plus : sans état ni effet, ce composant se rend
 * côté serveur comme n'importe quel autre.
 *
 * CE QUE ÇA IMPOSE À LA PAGE QUI L'ACCUEILLE : le carrousel doit avoir une
 * hauteur bornée, sinon ses pages n'ont pas de hauteur à remplir et rien ne
 * défile. C'est le rôle des classes « shell-* » posées sur le <main> et sur
 * les conteneurs intermédiaires (voir globals.css). Ne pas les retirer.
 */
export function MobilePagedSection({
  date,
  pages,
  className = "",
  mastheadAction,
  titleAside,
  navExtra,
  showMasthead = true
}: {
  date: Date;
  pages: { key: string; content: ReactNode }[];
  className?: string;
  /** Bouton d'action affiché à droite du titre dans le bandeau (voir
   *  Masthead). Sans effet si showMasthead vaut false. */
  mastheadAction?: ReactNode;
  /** Posé à droite du titre en compact — voir Masthead. */
  titleAside?: ReactNode;
  /** Élément posé à droite du menu — voir Masthead. */
  navExtra?: ReactNode;
  /** Duplique le bandeau en haut de CHAQUE page (défaut) : il défile alors
   *  avec sa colonne, chacune gardant sa propre position. La page d'accueil
   *  le met à false et rend un bandeau unique au-dessus du carrousel, parce
   *  qu'il porte le champ de recherche — lequel doit rester monté en
   *  permanence (les résultats remplacent le carrousel dès la première lettre
   *  tapée, ce qui emporterait le champ, le focus et le clavier). */
  showMasthead?: boolean;
}) {
  return (
    <div className={`carousel-track ${className}`}>
      {pages.map((page) => (
        <section key={page.key} className="carousel-page">
          {showMasthead && (
            <Masthead date={date} compact action={mastheadAction} titleAside={titleAside} navExtra={navExtra} />
          )}
          {page.content}
        </section>
      ))}
    </div>
  );
}
