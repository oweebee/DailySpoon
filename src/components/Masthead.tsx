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

        {/* Timbre "EN DIRECT" — classe ".stamp-live" autonome (voir
            globals.css), plus ".stamp-button" : les deux se disputaient la
            propriété "transform" (rotation vs centrage vertical Tailwind),
            ce qui empêchait la rotation de s'afficher. Centrage vertical ici
            via inset-y-0/my-auto (Tailwind), sans transform, donc plus de
            conflit possible avec la rotation de .stamp-live.
            Mobile : le timbre était tronqué en position absolue à droite du
            titre (pas assez de place) — en dessous de "md", il redevient un
            simple bloc centré sous le titre ; à partir de "md" seulement, il
            reprend sa position absolue à droite. */}
        <Link
          href="/direct"
          className="stamp-live relative mx-auto mt-4 block w-fit border-2 border-ink bg-ink px-4 py-1.5 font-display text-xs font-bold uppercase tracking-[0.25em] text-white md:absolute md:inset-y-0 md:-right-5 md:mx-0 md:mt-0 md:my-auto md:h-fit md:px-5 md:py-2 md:text-sm"
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
