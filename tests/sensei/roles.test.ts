import { writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@/lib/sensei/db/types';
import { EXTRACT_SYSTEM, type Extraction } from '@/lib/sensei/extract';
import type { StructuredCall, StructuredLlm } from '@/lib/sensei/llm';

import { rec, refFor, testConfig, testDb, writeFixture } from './helpers';

/** Minimal valid PDF with one text line per page (for pdf.js / unpdf). */
function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const lines = (text.replace(/[()\\]/g, '').match(/.{1,70}(\s|$)/g) ?? []).map((l) => `(${l.trim()}) Tj T*`).join(' ');
    const stream = `BT /F1 12 Tf 14 TL 40 700 Td ${lines} ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let db: Db & { close(): Promise<void> };
let home: string;

vi.mock('@/lib/sensei/config', async (orig) => {
  const mod = await orig<typeof import('@/lib/sensei/config')>();
  return { ...mod, senseiConfig: () => ({ ...mod.senseiConfig({ SENSEI_HOME: home } as unknown as NodeJS.ProcessEnv), googleApiKey: undefined }) };
});

beforeEach(async () => {
  db = await testDb();
  home = (await testConfig()).home;
});
afterEach(async () => {
  await db.close();
});

/** Routes calls by prompt type: extraction via `extract`, titles and cards canned. */
function routedLlm(extract: (prompt: string) => Extraction): StructuredLlm & { extractPrompts: string[] } {
  const extractPrompts: string[] = [];
  return {
    extractPrompts,
    modelName: () => 'fake',
    async call<T>(req: StructuredCall<T>): Promise<T> {
      if (req.system === EXTRACT_SYSTEM) {
        extractPrompts.push(req.prompt);
        return req.schema.parse(extract(req.prompt));
      }
      if (/title and summarize/.test(req.system)) return req.schema.parse({ title: 'Oxygen Delivery', summary: 'Covered cannulas.' });
      return req.schema.parse({ durability: 'core', durability_reason: 'test', board_tasks: [], cards: [] });
    },
  };
}

async function file(name: string, data: Buffer | string) {
  const p = await writeFixture(name, '');
  await writeFile(p, data);
  return p;
}

describe('sources by role', () => {
  it('indexes a textbook for search with no model calls and no lecture', async () => {
    const { enqueueLecture, claimJob, runJob } = await import('@/lib/sensei/jobs');
    const { textbookPassages } = await import('@/lib/sensei/queries');
    const path = await file('Egan Fundamentals.pdf', makePdf(['Oxygen toxicity occurs with prolonged high FiO2 exposure. '.repeat(5), 'Compliance is volume over pressure']));
    const llm = routedLlm(() => {
      throw new Error('no model calls expected');
    });
    await enqueueLecture(db, { files: [path], roles: { [path]: 'textbook' }, bookOnly: true });
    await runJob({ db, llm }, (await claimJob(db))!);
    const hits = await textbookPassages(db, ['oxygen toxicity'], 3);
    expect(hits[0]).toMatchObject({ book: 'Egan Fundamentals', page: 1 });
    const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM sensei_lecture');
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a deck is studied once; a later class session cites only its transcript and counts separately', async () => {
    const { enqueueLecture, claimJob, runJob } = await import('@/lib/sensei/jobs');
    const deckPath = await file('Week 4 Oxygen.pdf', makePdf(['Nasal cannula delivers 24 to 44 percent oxygen', 'Nonrebreather mask']));
    await enqueueLecture(db, { files: [deckPath], roles: { [deckPath]: 'slides' }, courseCode: 'RESP 110', date: '2026-09-21' });
    const deckLlm = routedLlm(() => ({
      records: [
        rec({
          concept_name: 'Nasal cannula',
          concept_kind: 'device',
          statement: 'A nasal cannula delivers 24-44% oxygen.',
          evidence: [{ unit_ref: 'U1', quote: 'Nasal cannula delivers 24 to 44 percent oxygen' }],
        }),
      ],
      relations: [],
    }));
    await runJob({ db, llm: deckLlm }, (await claimJob(db))!);

    const vtt = await file(
      'Class Monday.vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:30.000\nOn the nasal cannula slide: never above 6 liters, it dries the nose. That is exam material.\n',
    );
    await enqueueLecture(db, { files: [vtt], courseCode: 'RESP 110', date: '2026-09-22' });
    const sessionLlm = routedLlm((prompt) => ({
      records: [
        rec({
          concept_ref: refFor(prompt, 'Nasal cannula'),
          concept_name: 'Nasal cannula',
          type: 'exam_hint',
          statement: 'Never run a nasal cannula above 6 L/min; it dries the nose.',
          evidence: [{ unit_ref: 'U1', quote: 'never above 6 liters, it dries the nose' }],
        }),
      ],
      relations: [],
    }));
    await runJob({ db, llm: sessionLlm }, (await claimJob(db))!);

    // The session prompt carried the deck as context, and cited only transcript units.
    expect(sessionLlm.extractPrompts[0]).toContain('<slides_context>');
    const { rows: ev } = await db.query<{ kind: string; lecture_kind: string }>(
      `SELECT u.kind, l.kind AS lecture_kind FROM sensei_record_evidence e
         JOIN sensei_source_unit u ON u.id = e.unit_id JOIN sensei_lecture l ON l.id = e.lecture_id
        WHERE e.superseded_at IS NULL ORDER BY l.lecture_date`,
    );
    expect(ev).toEqual([
      { kind: 'page', lecture_kind: 'deck' },
      { kind: 'segment', lecture_kind: 'session' },
    ]);
    const { rows: sig } = await db.query<{ session_count: string; deck_count: string }>(
      `SELECT s.session_count, s.deck_count FROM sensei_concept_signals s JOIN sensei_concept c ON c.id = s.concept_id
        WHERE c.canonical_name = 'Nasal cannula'`,
    );
    expect([Number(sig[0].session_count), Number(sig[0].deck_count)]).toEqual([1, 1]);
  });
});
