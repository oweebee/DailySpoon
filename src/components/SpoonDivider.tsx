// Cul-de-lampe de fin de page, façon fleuron d'imprimerie — trois cuillères
// (clin d'œil au nom "DailySpoon") plutôt que le symbole "❦ ❦ ❦" d'origine,
// inclinées façon couverts posés en éventail plutôt que debout au garde-à-vous.
// Même silhouette que le colophon SVG servi par /api/article-proxy (route.ts),
// pour une cohérence visuelle totale entre la page d'article et le reste de
// l'appli — dupliquée ici en JSX puisque l'article-proxy sert du HTML brut
// (pas de composant React partageable entre les deux contextes de rendu).
function Spoon({ rotate }: { rotate: number }) {
  return (
    // Boîte plus étroite que haute + preserveAspectRatio="none" : étire le
    // bol verticalement (moins rond, on ne veut pas un effet "maracas") —
    // même technique que les "o" du masthead (Masthead.tsx).
    <svg
      viewBox="0 0 24 24"
      preserveAspectRatio="none"
      width="13"
      height="19"
      className="inline-block"
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <ellipse cx="12" cy="6.2" rx="5.1" ry="6.2" fill="currentColor" />
      <rect x="10.6" y="11.4" width="2.8" height="11.2" rx="1.4" fill="currentColor" />
    </svg>
  );
}

export function SpoonDivider({ className = "mt-14 text-center text-sepia" }: { className?: string }) {
  return (
    <p className={className}>
      <span className="inline-flex items-center gap-4">
        <Spoon rotate={-18} />
        <Spoon rotate={14} />
        <Spoon rotate={-18} />
      </span>
    </p>
  );
}
