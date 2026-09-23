/**
 * Textbook text as extracted from Egan's PDF is garbled in consistent ways
 * (DECISIONS V14): "=" → "¼", "+" → "þ", "(" / ")" → "ð" / "Þ", an en dash between
 * numbers → "e" ("6e8 mL/kg" means 6–8), and PDF page ≠ printed page. These helpers
 * repair the text before it reaches a model, the number check, or the screen.
 */

/** Repair extraction artifacts. Leaves real words alone ("e" only between digits). */
export function degarble(text: string): string {
  return text
    .replace(/¼/g, '=')
    .replace(/þ/g, '+')
    .replace(/ð/g, '(')
    .replace(/Þ/g, ')')
    .replace(/(\d)\s?e\s?(\d)/g, '$1–$2')
    .replace(/[ \t]+\n/g, '\n');
}

/**
 * The printed page number, from the running footer on the page's last line:
 * "66 SECTION I Foundations…" (even pages) or "CHAPTER 21 Review… 437" (odd pages);
 * online-only pages look like "1179.e1".
 */
export function printedPage(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of [...lines.slice(-2).reverse(), ...lines.slice(0, 2)]) {
    let m = /^(\d{1,4}(?:\.e\d{1,2})?)\s+(SECTION|CHAPTER|APPENDIX|PART)\b/.exec(line);
    if (m) return m[1];
    m = /\b(SECTION|CHAPTER|APPENDIX|PART)\b.*\s(\d{1,4}(?:\.e\d{1,2})?)$/.exec(line);
    if (m) return m[2];
  }
  return null;
}

/** "p. 886", or "p. 1179.e1 (online)" for online-only pages; falls back to the PDF page. */
export function citePage(printed: string | null, pdfPage: number): string {
  if (!printed) return `PDF p. ${pdfPage}`;
  return printed.includes('.e') ? `p. ${printed} (online)` : `p. ${printed}`;
}
