// Shared (client + server) session search scoring for the sidebar.
// Unquoted words match fuzzily and in any order (every word must match
// somewhere); keeping the typed order scores higher. "Quoted text" (straight
// or typographic quotes) must appear verbatim (case-insensitive). Field
// weights rank title matches far above transcript matches. Scripts written
// without spaces (CJK) form one word per run, so they match by substring only.

export const TITLE_WEIGHT = 100;
export const FIRST_MESSAGE_WEIGHT = 30;
export const CONTENT_WEIGHT = 1;

// \p{M}: combining marks belong to their word (Devanagari vowel signs, NFD accents).
const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;

function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

export interface SearchField {
  /** Lowercased, whitespace-collapsed text (phrase and order checks). */
  text: string;
  /** Unique lowercased words (term matching). */
  words: string[];
  weight: number;
}

export interface CompiledSearchQuery {
  terms: { text: string; quality: (word: string) => number }[];
  phrases: string[];
}

export function searchField(text: string, weight: number): SearchField {
  const normalized = normalize(text).replace(/\s+/g, " ").trim();
  return { text: normalized, words: [...new Set(normalized.match(WORD_RE) ?? [])], weight };
}

let prevRow = new Uint16Array(64);
let curRow = new Uint16Array(64);

function ensureScratchCapacity(needed: number): void {
  if (prevRow.length < needed) {
    let cap = prevRow.length;
    while (cap < needed) cap *= 2;
    prevRow = new Uint16Array(cap);
    curRow = new Uint16Array(cap);
  }
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  ensureScratchCapacity(b.length + 1);
  let prev = prevRow;
  let cur = curRow;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length];
}

/** Word-match quality ladder: exact > prefix > substring > 1 typo > 2 typos. */
function termQuality(term: string, word: string): number {
  if (word === term) return 1;
  if (word.startsWith(term)) return 0.8;
  if (word.includes(term)) return 0.6;
  const maxTypos = term.length >= 8 ? 2 : term.length >= 5 ? 1 : 0;
  if (maxTypos === 0) return 0;
  // The prefix comparison tolerates a typo in a word still being typed.
  const fullDistance = editDistance(term, word, maxTypos);
  const distance =
    word.length <= term.length || fullDistance <= 1
      ? fullDistance
      : Math.min(fullDistance, editDistance(term, word.slice(0, term.length), maxTypos));
  // editDistance reports "too far" as maxTypos + 1, which must not read as a typo count.
  if (distance > maxTypos) return 0;
  return distance === 1 ? 0.45 : 0.3;
}

export function compileSearchQuery(raw: string): CompiledSearchQuery | null {
  const terms: string[] = [];
  const phrases: string[] = [];
  // An unclosed quote is a phrase still being typed. Typographic quotes (“” „ «») count too.
  for (const match of normalize(raw).matchAll(/["“”„«»]([^"“”„«»]*)["“”„«»]?|[^\s"“”„«»]+/g)) {
    if (match[1] !== undefined) {
      const phrase = match[1].replace(/\s+/g, " ").trim();
      if (phrase) phrases.push(phrase);
    } else {
      terms.push(...(match[0].match(WORD_RE) ?? []));
    }
  }
  if (terms.length === 0 && phrases.length === 0) return null;
  return {
    phrases,
    terms: terms.map((text) => {
      // Memoized per query: the same vocabulary repeats across sessions.
      const memo = new Map<string, number>();
      return {
        text,
        quality: (word: string) => {
          let q = memo.get(word);
          if (q === undefined) memo.set(word, (q = termQuality(text, word)));
          return q;
        },
      };
    }),
  };
}

function inOrder(text: string, terms: string[]): boolean {
  let from = 0;
  for (const term of terms) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    from = at + term.length;
  }
  return true;
}

/** Score of a document split into weighted fields, or null when it does not match. */
export function scoreSearchFields(fields: SearchField[], query: CompiledSearchQuery): number | null {
  let score = 0;
  for (const phrase of query.phrases) {
    let best = 0;
    for (const field of fields) if (field.weight > best && field.text.includes(phrase)) best = field.weight;
    if (best === 0) return null;
    score += best;
  }
  for (const term of query.terms) {
    let best = 0;
    for (const field of fields) {
      if (field.weight <= best) continue;
      let quality = 0;
      for (const word of field.words) {
        quality = Math.max(quality, term.quality(word));
        if (quality === 1) break;
      }
      best = Math.max(best, quality * field.weight);
    }
    if (best === 0) return null;
    score += best;
  }
  if (query.terms.length > 1) {
    const texts = query.terms.map((term) => term.text);
    const adjacent = texts.join(" ");
    let bonus = 0;
    for (const field of fields) {
      if (field.text.includes(adjacent)) bonus = Math.max(bonus, field.weight);
      else if (inOrder(field.text, texts)) bonus = Math.max(bonus, field.weight / 2);
    }
    score += bonus;
  }
  return score;
}
