'use client';

/**
 * Renders text with every known concept turned into a tappable term that opens
 * its explanation sheet — the "no need to go search the glossary" affordance.
 * Short abbreviations (FiO2, PEEP) match case-sensitively; full names match
 * case-insensitively. Each concept is linked once per block to keep text calm.
 */
import { Fragment, useMemo } from 'react';

import type { TermLink } from './api';
import { useSensei } from './store';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Matcher {
  re: RegExp;
  lookup: Map<string, string>;
  lookupCi: Map<string, string>;
}

const matcherCache = new WeakMap<TermLink[], Matcher | null>();

function buildMatcher(terms: TermLink[]): Matcher | null {
  if (matcherCache.has(terms)) return matcherCache.get(terms)!;
  if (terms.length === 0) {
    matcherCache.set(terms, null);
    return null;
  }
  const lookup = new Map<string, string>();
  const lookupCi = new Map<string, string>();
  const parts: string[] = [];
  for (const t of terms) {
    const short = t.term.replace(/\s/g, '').length <= 5;
    if (short) {
      if (lookup.has(t.term)) continue;
      lookup.set(t.term, t.conceptId);
      // FiO2 also matches FiO₂
      parts.push(escape(t.term).replace(/2/g, '[2₂]'));
    } else {
      const k = t.term.toLowerCase();
      if (lookupCi.has(k)) continue;
      lookupCi.set(k, t.conceptId);
      parts.push(`(?i:${escape(t.term)})`);
    }
  }
  let re: RegExp;
  try {
    re = new RegExp(`(?<![\\p{L}\\p{N}])(${parts.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  } catch {
    // Engines without inline (?i:) modifiers: fall back to case-insensitive for everything.
    re = new RegExp(`(?<![\\p{L}\\p{N}])(${parts.map((p) => p.replace(/^\(\?i:(.*)\)$/, '$1')).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  }
  const m = { re, lookup, lookupCi };
  matcherCache.set(terms, m);
  return m;
}

export function TermText({
  text,
  exclude,
  uncertain,
  className,
}: {
  text: string;
  /** Concept id not to link (e.g. the concept whose sheet this is). */
  exclude?: string;
  /** Words to mark as uncertain transcription. */
  uncertain?: string[];
  className?: string;
}) {
  const { terms, openConcept } = useSensei();
  const nodes = useMemo(() => {
    const m = buildMatcher(terms);
    if (!m || !text) return [text];
    const out: (string | { t: string; id: string })[] = [];
    const used = new Set<string>();
    let last = 0;
    m.re.lastIndex = 0;
    for (const match of text.matchAll(m.re)) {
      const t = match[0];
      const id = m.lookup.get(t.replace(/₂/g, '2')) ?? m.lookupCi.get(t.toLowerCase());
      if (!id || id === exclude || used.has(id)) continue;
      used.add(id);
      out.push(text.slice(last, match.index), { t, id });
      last = match.index! + t.length;
    }
    out.push(text.slice(last));
    return out;
  }, [terms, text, exclude]);

  const renderPlain = (s: string, key: number) => {
    if (!uncertain?.length) return <Fragment key={key}>{s}</Fragment>;
    const re = new RegExp(`(${uncertain.filter(Boolean).map(escape).join('|')})`, 'gi');
    return (
      <Fragment key={key}>
        {s.split(re).map((part, i) =>
          i % 2 ? (
            <span key={i} className="s-uncertain" title="Sensei wasn’t sure it heard this right">
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </Fragment>
    );
  };

  return (
    <span className={className}>
      {nodes.map((n, i) =>
        typeof n === 'string' ? (
          renderPlain(n, i)
        ) : (
          <span
            key={i}
            role="button"
            tabIndex={0}
            className="s-term"
            onClick={(e) => {
              e.stopPropagation();
              openConcept(n.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openConcept(n.id);
              }
            }}
          >
            {n.t}
          </span>
        ),
      )}
    </span>
  );
}
