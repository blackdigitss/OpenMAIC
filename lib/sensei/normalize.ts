/**
 * Deterministic text rules for knowledge integrity: term normalization, alias
 * auto-attach policy, and the numeric/unit fidelity gate (DECISIONS A2, A4, A5).
 */

const SUBSCRIPTS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
};

/** Lowercase, fold subscripts/diacritics, collapse punctuation. "FiO₂" → "fio2". */
export function normalizeTerm(term: string): string {
  return term
    .replace(/[₀-₉]/g, (c) => SUBSCRIPTS[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

/**
 * Abbreviations with more than one common meaning in respiratory care. These
 * never auto-attach to a concept by string match — the extraction model must
 * resolve them from context (A4).
 */
export const AMBIGUOUS_ABBREVIATIONS = new Set(
  [
    'pe', 'co', 'mv', 'rr', 'pa', 'ic', 'cf', 'ms', 'ra', 'cp', 'ct', 'ed', 'er',
    'hr', 'ps', 'pc', 'vc', 'ac', 'av', 'bp', 'ci', 'dl', 'ie', 'ip', 'lv', 'rv',
    'pt', 'pp', 'sv', 'tv', 'va', 'vt', 'ef', 'af', 'mi', 'abg', 'cvp', 'map', 'ett',
  ].map(normalizeTerm),
);

/** Distinct concepts that are easy to conflate; never merge across a pair. */
export const NEVER_MERGE: [string, string][] = [
  ['fio2', 'pao2'], ['fio2', 'spo2'], ['pao2', 'spo2'], ['pao2', 'sao2'], ['sao2', 'spo2'],
  ['pao2', 'pao2 alveolar'], ['paco2', 'etco2'], ['peep', 'auto peep'],
  ['static compliance', 'dynamic compliance'], ['tidal volume', 'minute ventilation'],
  ['hypoxemia', 'hypoxia'], ['hypoventilation', 'hypoxemia'],
  ['pulmonary embolism', 'pleural effusion'], ['cardiac output', 'carbon monoxide'],
  ['minute ventilation', 'mechanical ventilation'], ['obstructive', 'restrictive'],
  ['respiratory acidosis', 'metabolic acidosis'], ['respiratory alkalosis', 'metabolic alkalosis'],
].map(([a, b]) => [normalizeTerm(a), normalizeTerm(b)]);

export function isNeverMergePair(a: string, b: string): boolean {
  const na = normalizeTerm(a);
  const nb = normalizeTerm(b);
  return NEVER_MERGE.some(([x, y]) => (x === na && y === nb) || (x === nb && y === na));
}

/**
 * An alias may attach to an existing concept by string match alone only if it is
 * not a known ambiguous abbreviation and is longer than 3 characters (2–3 letter
 * abbreviations are where collisions live: PE, CO, MV). FiO2/PEEP/SpO2 qualify.
 */
export function aliasCanAutoAttach(alias: string): boolean {
  const n = normalizeTerm(alias);
  return n.replace(/\s/g, '').length > 3 && !AMBIGUOUS_ABBREVIATIONS.has(n);
}

// ---------------------------------------------------------------------------
// Numeric / unit fidelity gate
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/** Spoken-number forms in transcripts → digits ("twenty one" → "21", "point two one" → ".21"). */
function digitizeWords(text: string): string {
  let out = text.toLowerCase();
  out = out.replace(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_, tens: string, ones: string) => String(WORD_NUMBERS[tens] + WORD_NUMBERS[ones]),
  );
  out = out.replace(/\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred\b/g, (_, n: string) =>
    String(WORD_NUMBERS[n] * 100),
  );
  out = out.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/g,
    (w) => String(WORD_NUMBERS[w]),
  );
  out = out.replace(/\bpoint\s+(\d)(?:\s+(\d))?(?:\s+(\d))?/g, (_, a, b, c) => `.${a}${b ?? ''}${c ?? ''}`);
  out = out.replace(/(\d)\s+\.(\d)/g, '$1.$2');
  out = out.replace(/(\d)\s+percent\b/g, '$1%');
  return out;
}

const UNIT_PATTERNS: [RegExp, string][] = [
  [/^(cm\s*h\s*2\s*o|centimeters? of water)/, 'cmh2o'],
  [/^(mm\s*hg|millimeters? of mercury|torr)/, 'mmhg'],
  [/^(ml\s*\/\s*kg|mls? per kilo(gram)?s?|milliliters? per kilo(gram)?s?)/, 'ml/kg'],
  [/^(l\s*\/\s*min|lpm|liters? per minute)/, 'l/min'],
  [/^(ml\s*\/\s*min|milliliters? per minute)/, 'ml/min'],
  [/^(meq\s*\/\s*l|milliequivalents? per liter)/, 'meq/l'],
  [/^(breaths?\s*\/\s*min|breaths? per minute|bpm)/, 'breaths/min'],
  [/^(ml|mls|milliliters?|cc)\b/, 'ml'],
  [/^(mg|milligrams?)\b/, 'mg'],
  [/^(mcg|micrograms?|µg)\b/, 'mcg'],
  [/^(kg|kilograms?|kilos?)\b/, 'kg'],
  [/^(cm|centimeters?)\b/, 'cm'],
  [/^(l|liters?)\b/, 'l'],
  [/^(seconds?|secs?|s)\b/, 's'],
  [/^%/, '%'],
];

export interface Quantity {
  value: string;
  unit: string | null;
}

function normalizeNumber(raw: string): string {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : raw;
}

/** Extract numbers with the unit that immediately follows them (if any). Ranges yield both ends. */
export function extractQuantities(text: string, opts: { spokenWords?: boolean } = {}): Quantity[] {
  const lowered = text.replace(/₂/g, '2');
  const src = opts.spokenWords === false ? lowered.toLowerCase() : digitizeWords(lowered);
  const out: Quantity[] = [];
  const re = /(?<![a-z0-9.])(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Skip digits that are part of a term like "FiO2", "H2O", "CO2".
    const before = src.slice(Math.max(0, m.index - 1), m.index);
    if (/[a-z]/.test(before)) continue;
    const rest = src.slice(m.index + m[0].length).replace(/^\s*(?:-|–|to)\s*\d+(?:\.\d+)?/, '').trimStart();
    let unit: string | null = null;
    for (const [pattern, name] of UNIT_PATTERNS) {
      if (pattern.test(rest)) {
        unit = name;
        break;
      }
    }
    out.push({ value: normalizeNumber(m[0]), unit });
  }
  // Propagate a range's unit back to its first end ("6 to 8 mL/kg" → 6 mL/kg).
  const rangeRe = /(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/g;
  while ((m = rangeRe.exec(src))) {
    const first = out.find((q) => q.value === normalizeNumber(m![1]) && q.unit === null);
    const second = out.find((q) => q.value === normalizeNumber(m![2]));
    if (first && second?.unit) first.unit = second.unit;
  }
  return out;
}

/**
 * Units a lecturer routinely drops when speaking: "2 liters" of oxygen means 2 L/min,
 * "PEEP of 5 centimeters" means cmH2O. Written-unit → spoken forms it may match.
 */
const SPOKEN_SHORTHAND: Record<string, string[]> = {
  'l/min': ['l'],
  'ml/min': ['ml'],
  cmh2o: ['cm'],
};

function unitsCompatible(claimed: string, source: string): boolean {
  return claimed === source || (SPOKEN_SHORTHAND[claimed] ?? []).includes(source);
}

export interface NumericCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Every number in `statement` must appear in `evidence`; where both sides carry
 * a unit for that number, the units must match. Catches "PEEP of 15" vs "PEEP
 * of 5" and "mL/kg" vs "L/kg" — the errors fuzzy quote matching misses (A2).
 */
export function checkNumericFidelity(statement: string, evidence: string): NumericCheck {
  // Written statements: only literal digits count as claims ("one of the most…" is not a number).
  const claimed = extractQuantities(statement, { spokenWords: false });
  const available = extractQuantities(evidence);
  const problems: string[] = [];
  for (const q of claimed) {
    const matches = available.filter((a) => a.value === q.value);
    if (matches.length === 0) {
      problems.push(`number ${q.value}${q.unit ? ' ' + q.unit : ''} not found in source`);
      continue;
    }
    if (q.unit && matches.every((a) => a.unit !== null && !unitsCompatible(q.unit!, a.unit))) {
      problems.push(`unit mismatch for ${q.value}: statement says ${q.unit}, source says ${matches.map((a) => a.unit).join('/')}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Sorted numeric token set, for "is this really a duplicate?" checks (A5). */
export function numericSignature(text: string): string {
  return [...new Set(extractQuantities(text).map((q) => q.value))].sort().join('|');
}

/** Normalize a statement for content-keying (whitespace/case/punctuation-insensitive). */
export function normalizeStatement(statement: string): string {
  return digitizeWords(statement).replace(/[^a-z0-9%./]+/g, ' ').trim();
}

/** Loose check that a quote actually occurs in the unit text (token overlap ≥ 0.8). */
export function quoteAppearsIn(quote: string, text: string): boolean {
  const toks = (s: string) => normalizeStatement(s).split(' ').filter((t) => t.length > 1);
  const q = toks(quote);
  if (q.length === 0) return false;
  const bag = new Set(toks(text));
  return q.filter((t) => bag.has(t)).length / q.length >= 0.8;
}
