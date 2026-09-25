/**
 * Slides that are pictures (scanned handouts, flowcharts exported as images) have no
 * text layer, so there is nothing to extract facts from. Those pages are cut into a
 * small PDF and read by the strong model, which transcribes what is on each slide.
 * The transcription then stands in as the page's text, so the usual extraction and
 * number checks apply to it.
 */
import { readFile } from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';

import type { Db } from './db/types';
import type { StructuredLlm } from './llm';

/** Pages with (almost) no text layer count as pictures; a short title-only slide does not. */
const MIN_CHARS = 8;
const BATCH = 8;

const PagesSchema = z.object({
  pages: z.array(z.object({ page: z.number().int(), text: z.string() })),
});

const SYSTEM = `You transcribe respiratory therapy lecture slides that were saved as images.
For each page, write out everything on the slide exactly as shown: title, bullets, table cells (one row per line, cells separated by " | "), labels and text inside diagrams and flowcharts (write arrows as "A → B", and decision branches as "If X → Y").
Keep every number, unit and abbreviation exactly as printed. Do not add explanations or anything that is not on the slide.
If a page has no words at all, describe the picture in one short sentence in [square brackets].`;

export async function readPicturePages(db: Db, llm: StructuredLlm, sourceId: string, pdfPath: string, lectureId?: string): Promise<number> {
  const { rows } = await db.query<{ id: string; page_no: number; text: string }>(
    `SELECT id, page_no, text FROM sensei_source_unit WHERE source_id = $1 AND kind = 'page' ORDER BY ordinal`,
    [sourceId],
  );
  const pictures = rows.filter((u) => u.text.replace(/\s+/g, '').length < MIN_CHARS);
  if (!pictures.length) return 0;
  const src = await PDFDocument.load(await readFile(pdfPath), { ignoreEncryption: true });
  let read = 0;
  for (let i = 0; i < pictures.length; i += BATCH) {
    const batch = pictures.slice(i, i + BATCH).filter((u) => u.page_no >= 1 && u.page_no <= src.getPageCount());
    if (!batch.length) continue;
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(src, batch.map((u) => u.page_no - 1))) out.addPage(page);
    const res = await llm.call({
      schema: PagesSchema,
      system: SYSTEM,
      prompt: `This PDF has ${batch.length} slide page(s), numbered 1 to ${batch.length} in order. Transcribe each one.`,
      tier: 'strong',
      file: { data: Buffer.from(await out.save()), mediaType: 'application/pdf' },
      purpose: 'read-slides',
      lectureId,
    });
    for (const p of res.pages) {
      const unit = batch[p.page - 1];
      if (!unit || !p.text.trim()) continue;
      await db.query('UPDATE sensei_source_unit SET text = $2 WHERE id = $1', [unit.id, p.text.trim()]);
      read++;
    }
  }
  return read;
}
