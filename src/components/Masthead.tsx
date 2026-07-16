import Link from "next/link";

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

export function Masthead({ date }: { date: Date }) {
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);

  return (
    <header className="mb-10">
      {/* Bandeau supérieur */}
      <div className="flex items-center justify-between border-b border-ink py-1 text-[0.65rem] uppercase tracking-[0.25em] text-sepia">
        <span>Édition quotidienne personnelle</span>
        <span>Prix : ≈ 10 ¢</span>
      </div>

      {/* Masthead gothique centré */}
      <div className="relative py-6 text-center">
        <Link href="/" className="font-masthead text-5xl font-black uppercase tracking-tight md:text-7xl">
          DailySp
          <SpoonO />
          <SpoonO />n
        </Link>

        {/* Timbre "EN DIRECT" — même mécanique que les autres timbres du
            site (.stamp-button dans globals.css : contour pointillé décalé
            façon perforations de timbre-poste, ombre portée). Fond noir +
            texte clair comme les autres timbres (bordure rouge en accent).
            Poussé bien à droite, quasiment hors du bloc titre, pour ne
            jamais toucher le mot — et inclinaison prononcée (transform en
            style inline : la classe .stamp-button gère aussi une rotation,
            mais Tailwind top-1/2/-translate-y-1/2 se battait avec elle sur
            la même propriété "transform", d'où le chevauchement précédent ;
            tout est donc regroupé ici dans un seul transform explicite). */}
        <Link
          href="/direct"
          style={{ transform: "translateY(-50%) rotate(-9deg)" }}
          className="stamp-button absolute -right-3 top-1/2 border-2 border-journal bg-ink px-3 py-1 font-display text-[0.6rem] font-bold uppercase tracking-[0.25em] text-paper sm:-right-5 sm:px-4 sm:py-1.5 sm:text-xs"
        >
          En direct
        </Link>
      </div>

      {/* Ligne de date entre deux filets */}
      <div className="double-rule" />
      <div className="flex items-center justify-between py-1.5 text-xs uppercase tracking-[0.2em]">
        <span className="capitalize">{formatted}</span>
        <nav className="space-x-6">
          <Link href="/direct" className="text-journal hover:underline">
            En direct
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
        </nav>
      </div>
      <div className="double-rule rotate-180" />
    </header>
  );
}
