import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import type { Db } from '@/lib/sensei/db/types';
import type { StructuredCall, StructuredLlm } from '@/lib/sensei/llm';
import { readPicturePages } from '@/lib/sensei/ocr';
import { insertUnits, registerSource, sha256 } from '@/lib/sensei/store';

import { testDb } from './helpers';

let db: Db & { close(): Promise<void> };
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

describe('slides saved as pictures', () => {
  it('sends only the picture pages, as a small PDF, and stores the transcription as page text', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText('Oxygen protocol overview with enough words to count', { x: 40, y: 700, font, size: 12 });
    doc.addPage(); // picture: no text layer
    const path = join(await mkdtemp(join(tmpdir(), 'sensei-ocr-')), 'tdp.pdf');
    await writeFile(path, await doc.save());
    const src = await registerSource(db, { sha256: sha256('tdp'), kind: 'slides', courseId: null, title: 'TDP', originalName: 'tdp.pdf', storedPath: path });
    await insertUnits(db, src.id, [
      { kind: 'page', ordinal: 1, pageNo: 1, text: 'Oxygen protocol overview with enough words to count' },
      { kind: 'page', ordinal: 2, pageNo: 2, text: '' },
    ]);
    const seen: { pages: number; type: string }[] = [];
    const llm: StructuredLlm = {
      modelName: () => 'fake',
      async call<T>(req: StructuredCall<T>): Promise<T> {
        const sent = await PDFDocument.load(req.file!.data);
        seen.push({ pages: sent.getPageCount(), type: req.file!.mediaType });
        return req.schema.parse({ pages: [{ page: 1, text: 'Assess SpO2 → If < 92% → start O2 at 2 L/min' }] });
      },
    };
    expect(await readPicturePages(db, llm, src.id, path)).toBe(1);
    expect(seen).toEqual([{ pages: 1, type: 'application/pdf' }]);
    const { rows } = await db.query<{ text: string }>('SELECT text FROM sensei_source_unit WHERE source_id = $1 ORDER BY ordinal', [src.id]);
    expect(rows.map((r) => r.text)).toEqual(['Oxygen protocol overview with enough words to count', 'Assess SpO2 → If < 92% → start O2 at 2 L/min']);
    expect(await readPicturePages(db, llm, src.id, path)).toBe(0); // nothing left to read
  });
});
