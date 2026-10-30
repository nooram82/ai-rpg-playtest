/**
 * Repetition scan: phrases the game keeps reusing across separate replies. Catchphrases,
 * stock openers and closers ("the air hangs heavy", "only time will tell") are the most common
 * complaint about AI storytellers, and players notice them long before anyone measures them.
 *
 * Counts 3-8 word phrases that appear in several DIFFERENT replies. A three-word phrase needs
 * two content words, so "in the square" is not a tic but "first things first" is. Longer
 * phrases swallow the shorter ones inside them.
 */

const STOP = new Set(
  (
    'a an the and or but of to in on at by for from with as is are was were be been it its this that ' +
    'he she they them his her their him you your i me my we our us not no so if then than there here ' +
    'into onto over under up down out off one two s t d ll re ve m'
  ).split(' '),
);

export interface RepeatedPhrase {
  phrase: string;
  /** Number of different replies it appears in. */
  count: number;
  /** Indexes (or turn numbers, if given) of those replies. */
  where: number[];
}

function clauses(text: string): string[][] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[.!?;:,،؛؟。！？、—–"“”«»()*_]+/)
    .map((c) =>
      c
        .split(/[^\p{L}\p{M}\p{N}']+/u)
        .map((w) => w.replace(/^'+|'+$/g, ''))
        .filter(Boolean),
    )
    .filter((c) => c.length >= 3);
}

/**
 * Words the texts write capitalised mid-sentence more often than not: names of people and places
 * ("the Dappled Ox"). A place coming up again is the story, not a tic.
 */
export function properNames(texts: string[]): Set<string> {
  const cap = new Map<string, number>();
  const low = new Map<string, number>();
  for (const text of texts) {
    for (const m of text.matchAll(/[\p{L}][\p{L}\p{M}\p{N}']*/gu)) {
      const word = m[0];
      const before = text.slice(0, m.index).replace(/[\s*_"“”‘'(]+$/u, '');
      const sentenceStart = before === '' || /[.!?:\n—–-]$/.test(before);
      const key = word.toLowerCase().replace(/'s$/, '');
      if (word[0] !== word[0].toLowerCase()) {
        if (!sentenceStart) cap.set(key, (cap.get(key) ?? 0) + 1);
      } else low.set(key, (low.get(key) ?? 0) + 1);
    }
  }
  return new Set([...cap.entries()].filter(([w, c]) => c >= 2 && c > (low.get(w) ?? 0)).map(([w]) => w));
}

export function repeatedPhrases(texts: string[], opts: { minCount?: number; max?: number; labels?: number[]; keepNames?: boolean } = {}): RepeatedPhrase[] {
  const minCount = opts.minCount ?? 3;
  const names = opts.keepNames ? new Set<string>() : properNames(texts);
  const where = new Map<string, number[]>();
  texts.forEach((text, i) => {
    const seen = new Set<string>();
    for (const words of clauses(text)) {
      for (let n = 3; n <= 8; n++) {
        for (let j = 0; j + n <= words.length; j++) {
          const gram = words.slice(j, j + n);
          const content = gram.filter((w) => !STOP.has(w)).length;
          if (content < 2) continue;
          if (gram.some((w) => names.has(w.replace(/'s$/, '')))) continue;
          seen.add(gram.join(' '));
        }
      }
    }
    for (const g of seen) {
      const list = where.get(g) ?? [];
      list.push(opts.labels?.[i] ?? i);
      where.set(g, list);
    }
  });
  const repeated = [...where.entries()]
    .filter(([, w]) => w.length >= minCount)
    .sort((a, b) => b[1].length - a[1].length || b[0].split(' ').length - a[0].split(' ').length);
  const kept: RepeatedPhrase[] = [];
  for (const [phrase, w] of repeated) {
    // Drop a phrase inside a kept one when it adds almost no replies of its own.
    const parent = kept.find((k) => ` ${k.phrase} `.includes(` ${phrase} `) || ` ${phrase} `.includes(` ${k.phrase} `));
    if (parent && w.length <= parent.count + 1) continue;
    kept.push({ phrase, count: w.length, where: w });
    if (kept.length >= (opts.max ?? 25)) break;
  }
  return kept;
}

/** Share of replies that open, or close, on the same first/last few words as another reply. */
export function stockEdges(texts: string[], words = 4): { openers: RepeatedPhrase[]; closers: RepeatedPhrase[] } {
  const edge = (t: string, fromEnd: boolean) => {
    const w = t.toLowerCase().replace(/[’‘]/g, "'").split(/[^\p{L}\p{M}\p{N}']+/u).filter(Boolean);
    return (fromEnd ? w.slice(-words) : w.slice(0, words)).join(' ');
  };
  const group = (fromEnd: boolean) => {
    const m = new Map<string, number[]>();
    texts.forEach((t, i) => {
      const e = edge(t, fromEnd);
      if (e.split(' ').length < words) return;
      m.set(e, [...(m.get(e) ?? []), i]);
    });
    return [...m.entries()].filter(([, w]) => w.length >= 2).map(([phrase, where]) => ({ phrase, count: where.length, where })).sort((a, b) => b.count - a.count);
  };
  return { openers: group(false), closers: group(true) };
}
