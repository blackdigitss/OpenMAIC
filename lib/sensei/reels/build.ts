/**
 * Build "Hear it from your professor" reels: the exact moments the professor stressed
 * something, cut at word boundaries and stitched into one short audio track with
 * chapters. A clip whose words can't be found is dropped, never guessed.
 */
import { mkdir, stat } from 'fs/promises';
import { join } from 'path';

import { senseiConfig } from '../config';
import type { Db } from '../db/types';
import { sha256 } from '../store';
import { stitch, whisperAvailable, wordsFor } from './audio';
import { clipSpan, locateQuote } from './boundaries';

export interface Chapter {
  offsetMs: number;
  durationMs: number;
  text: string;
  conceptId: string;
  conceptName: string;
  lectureTitle: string;
}

interface Moment {
  record_id: string;
  unit_id: string;
  quote: string;
  start_ms: number;
  end_ms: number;
  audio_source_id: string;
  audio_path: string;
  concept_id: string;
  canonical_name: string;
  lecture_title: string;
  lecture_id: string;
}

const MOMENTS_SQL = `
  SELECT DISTINCT ON (r.id) r.id AS record_id, u.id AS unit_id, e.quote, u.start_ms, u.end_ms,
         a.id AS audio_source_id, a.stored_path AS audio_path, c.id AS concept_id, c.canonical_name,
         l.title AS lecture_title, l.id AS lecture_id, l.lecture_date, r.type
    FROM sensei_knowledge_record r
    JOIN sensei_concept c ON c.id = r.concept_id
    JOIN sensei_record_evidence e ON e.record_id = r.id AND e.superseded_at IS NULL
    JOIN sensei_source_unit u ON u.id = e.unit_id AND u.kind = 'segment' AND u.start_ms IS NOT NULL
    JOIN sensei_source t ON t.id = u.source_id
    JOIN sensei_source a ON a.id = (t.metadata->>'audioSourceId')::uuid AND a.kind = 'audio'
    JOIN sensei_lecture l ON l.id = e.lecture_id
   WHERE r.superseded_at IS NULL AND r.verification NOT IN ('rejected','flagged')`;

/** Which moments belong in a reel. Keys: lecture:<id>, module:<id>, weak. */
export async function momentsFor(db: Db, key: string): Promise<Moment[]> {
  const [kind, id] = key.split(':');
  let rows: Moment[] = [];
  if (kind === 'lecture') {
    rows = (await db.query<Moment>(`${MOMENTS_SQL} AND l.id = $1 AND r.type IN ('emphasis','exam_hint') ORDER BY r.id, u.start_ms`, [id])).rows;
    rows.sort((a, b) => a.start_ms - b.start_ms);
  } else if (kind === 'module') {
    rows = (
      await db.query<Moment & { lecture_date: Date; type: string }>(
        `SELECT * FROM (${MOMENTS_SQL} AND r.type IN ('emphasis','exam_hint')
            AND EXISTS (SELECT 1 FROM sensei_module m WHERE m.id = $1 AND m.course_id = l.course_id AND l.lecture_date BETWEEN m.start_date AND m.end_date)
          ORDER BY r.id, u.start_ms) x
          ORDER BY (x.type = 'exam_hint') DESC, x.lecture_date, x.start_ms LIMIT 20`,
        [id],
      )
    ).rows;
  } else if (kind === 'weak') {
    rows = (
      await db.query<Moment>(
        `SELECT * FROM (${MOMENTS_SQL} AND r.type IN ('emphasis','exam_hint','clinical','mechanism','definition')
            AND r.concept_id IN (SELECT concept_id FROM sensei_card GROUP BY concept_id HAVING sum(lapses) > 0)
          ORDER BY r.id, u.start_ms) x ORDER BY x.canonical_name LIMIT 12`,
      )
    ).rows;
  }
  return rows;
}

/** Exact bounds for one moment (cached). Pads ±30 s around the transcript segment, then ±60 s. */
export async function clipFor(db: Db, m: Moment, vocabulary: string[]) {
  const { rows } = await db.query<{ status: string; start_ms: number; end_ms: number; text: string }>(
    'SELECT status, start_ms, end_ms, text FROM sensei_clip WHERE record_id = $1 AND unit_id = $2',
    [m.record_id, m.unit_id],
  );
  if (rows[0]) return rows[0].status === 'ok' ? rows[0] : null;
  let found: { start_ms: number; end_ms: number; text: string } | null = null;
  for (const pad of [30_000, 60_000]) {
    const from = Math.max(0, m.start_ms - pad);
    const words = await wordsFor(m.audio_path, from, m.end_ms + pad, vocabulary);
    const span = locateQuote(words, m.quote);
    if (!span) continue;
    const c = clipSpan(words, span);
    found = { start_ms: c.startMs, end_ms: c.endMs, text: c.text };
    break;
  }
  await db.query(
    `INSERT INTO sensei_clip (record_id, unit_id, audio_source_id, status, start_ms, end_ms, text, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
    [m.record_id, m.unit_id, m.audio_source_id, found ? 'ok' : 'dropped', found?.start_ms ?? null, found?.end_ms ?? null, found?.text ?? null, found ? null : 'quote not found in the audio'],
  );
  return found;
}

export async function requestReel(db: Db, key: string, title: string): Promise<void> {
  await db.query(
    `INSERT INTO sensei_reel (key, title) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title, status = CASE WHEN sensei_reel.status = 'building' THEN 'building' ELSE 'queued' END, updated_at = now()`,
    [key, title],
  );
}

export async function buildNextReel(db: Db, log: (m: string) => void = () => undefined): Promise<boolean> {
  const { rows } = await db.query<{ id: string; key: string; clip_hash: string | null; file: string | null }>(
    `UPDATE sensei_reel SET status = 'building', updated_at = now()
      WHERE id = (SELECT id FROM sensei_reel WHERE status = 'queued' ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, key, clip_hash, file`,
  );
  const reel = rows[0];
  if (!reel) return false;
  try {
    if (!(await whisperAvailable())) throw new Error('whisper.cpp is not installed (run ops/install-whisper.sh)');
    const moments = await momentsFor(db, reel.key);
    const { rows: vocab } = await db.query<{ canonical_name: string }>(
      `SELECT DISTINCT c.canonical_name FROM sensei_concept c WHERE c.id = ANY($1::uuid[])`,
      [moments.map((m) => m.concept_id)],
    );
    const vocabulary = vocab.map((v) => v.canonical_name);
    const clips: (Moment & { start: number; end: number; text: string })[] = [];
    let dropped = 0;
    for (const m of moments) {
      const c = await clipFor(db, m, vocabulary);
      if (c) clips.push({ ...m, start: c.start_ms, end: c.end_ms, text: c.text });
      else dropped++;
    }
    if (dropped) log(`reel ${reel.key}: dropped ${dropped} of ${moments.length} moments (quote not found in audio)`);
    const hash = sha256(clips.map((c) => `${c.record_id}:${c.start}-${c.end}`).join('|'));
    if (!clips.length) {
      await db.query(`UPDATE sensei_reel SET status = 'empty', total = $2, dropped = $3, updated_at = now() WHERE id = $1`, [reel.id, moments.length, dropped]);
      return true;
    }
    const exists = reel.file && (await stat(reel.file).then(() => true, () => false));
    if (hash === reel.clip_hash && exists) {
      await db.query(`UPDATE sensei_reel SET status = 'ready', updated_at = now() WHERE id = $1`, [reel.id]);
      return true;
    }
    const dir = join(senseiConfig().home, 'reels');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${reel.id}-${hash.slice(0, 8)}.m4a`);
    const { durationMs, offsets } = await stitch(clips.map((c) => ({ audioPath: c.audio_path, startMs: c.start, endMs: c.end })), file);
    const chapters: Chapter[] = clips.map((c, i) => ({
      offsetMs: offsets[i],
      durationMs: c.end - c.start,
      text: c.text,
      conceptId: c.concept_id,
      conceptName: c.canonical_name,
      lectureTitle: c.lecture_title,
    }));
    await db.query(
      `UPDATE sensei_reel SET status = 'ready', file = $2, duration_ms = $3, chapters = $4, clip_hash = $5, total = $6, dropped = $7, error = NULL, updated_at = now() WHERE id = $1`,
      [reel.id, file, durationMs, JSON.stringify(chapters), hash, moments.length, dropped],
    );
    log(`reel ${reel.key}: ${clips.length} clips, ${Math.round(durationMs / 1000)} s`);
  } catch (e) {
    await db.query(`UPDATE sensei_reel SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [reel.id, (e as Error).message]);
    log(`reel ${reel.key} failed: ${(e as Error).message}`);
  }
  return true;
}
