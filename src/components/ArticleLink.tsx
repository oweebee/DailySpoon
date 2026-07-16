"use client";

import type { MouseEvent, ReactNode } from "react";
import { useArticleModal } from "./ArticleModalContext";

/**
 * Lien vers un article source : un clic simple ouvre la fenêtre interne à
 * l'app (iframe) au lieu d'un nouvel onglet. Ctrl/Cmd/Shift-clic ou clic
 * molette laissent le comportement normal du navigateur (nouvel onglet,
 * nouvelle fenêtre) — on n'intercepte que le clic simple.
 */
export function ArticleLink({
  href,
  title,
  className,
  children
}: {
  href: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const { openArticle } = useArticleModal();

  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openArticle(href, title);
  }

  return (
    <a href={href} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}
