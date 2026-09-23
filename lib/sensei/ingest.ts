/**
 * Source ingestion: copy the original into the content-addressed library,
 * register it by sha256 (re-ingesting identical bytes is a no-op), link it to
 * a lecture, and split it into addressable units (slides/pages, transcript
 * segments). Originals are never modified or deleted.
 */
import { copyFile, mkdir, readFile, stat } from 'fs/promises';
import { basename, extname, join } from 'path';

import { senseiConfig } from './config';
import type { Db, SourceKind, SourceUnitInput } from './db/types';
import { ensureCourse, ensureLecture, insertUnits, linkLectureSource, loadUnits, registerSource, sha256 } from './store';

export async function pdfPages(data: Buffer): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((t) => t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
}

function parseClock(s: string): number {
  const parts = s.trim().replace(',', '.').split(':').map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return Math.round(secs * 1000);
}

/**
 * Transcript formats: WebVTT/SRT cues, or plain text lines like
 * "[12:34] text" / "12:34 - text". Untimed plain text becomes paragraph units.
 */
export function parseTranscript(raw: string): SourceUnitInput[] {
  const text = raw.replace(/\r/g, '');
  const cue = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  const units: SourceUnitInput[] = [];
  let m: RegExpExecArray | null;
  while ((m = cue.exec(text))) {
    const body = m[3].replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    units.push({ kind: 'segment', ordinal: units.length + 1, startMs: parseClock(m[1]), endMs: parseClock(m[2]), text: body });
  }
  if (units.length) return mergeShortSegments(units);

  const stamped = /^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–:]?\s*(.+)$/;
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length && lines.filter((l) => stamped.test(l)).length / lines.length > 0.6) {
    for (const line of lines) {
      const s = stamped.exec(line);
      if (s) units.push({ kind: 'segment', ordinal: units.length + 1, startMs: parseClock(s[1]), text: s[2].trim() });
      else if (units.length) units[units.length - 1].text += ' ' + line.trim();
    }
    units.forEach((u, i) => (u.endMs = units[i + 1]?.startMs ?? u.startMs));
    return mergeShortSegments(units);
  }
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i) => ({ kind: 'segment' as const, ordinal: i + 1, text: p }));
}

/** Caption cues are a few words long; group them into ~30 s segments so each unit holds a thought. */
function mergeShortSegments(units: SourceUnitInput[], targetMs = 30_000): SourceUnitInput[] {
  const out: SourceUnitInput[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last && last.startMs != null && u.endMs != null && u.endMs - last.startMs <= targetMs) {
      last.text += ' ' + u.text;
      last.endMs = u.endMs;
    } else {
      out.push({ ...u, ordinal: out.length + 1 });
    }
  }
  return out;
}

const AUDIO_EXT = new Set(['.m4a', '.mp3', '.wav', '.aac', '.caf', '.ogg', '.flac', '.mp4', '.mov', '.webm']);

export function detectKind(path: string): SourceKind {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return 'slides';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (['.vtt', '.srt', '.txt', '.md'].includes(ext)) return 'transcript';
  throw new Error(`Unsupported file type: ${basename(path)} (use PDF, audio, or a transcript .txt/.vtt/.srt)`);
}

export interface IngestInput {
  path: string;
  kind?: SourceKind;
  course: { code: string; title?: string };
  lecture: { date: string; title: string; slideFrom?: number | null; slideTo?: number | null; kind?: 'session' | 'deck' };
  /** Attach to this existing lecture instead of finding/creating one by (course, date, title). */
  lectureId?: string;
}

export interface IngestResult {
  lectureId: string;
  sourceId: string;
  kind: SourceKind;
  duplicate: boolean;
  units: number;
}

/**
 * A textbook or handbook: stored and indexed page by page for full-text search.
 * No model calls — it is consulted on demand, so a 1,000-page book costs nothing to add.
 */
export async function ingestReference(db: Db, path: string, config = senseiConfig()): Promise<{ sourceId: string; pages: number; duplicate: boolean }> {
  const data = await readFile(path);
  const hash = sha256(data);
  const storedPath = join(config.libraryDir, `${hash}${extname(path).toLowerCase()}`);
  await mkdir(config.libraryDir, { recursive: true });
  if (!(await stat(storedPath).then(() => true, () => false))) await copyFile(path, storedPath);
  const title = basename(path, extname(path)).replace(/[_-]+/g, ' ').replace(/^\d+\s+/, '').trim();
  const source = await registerSource(db, {
    sha256: hash, kind: 'textbook', courseId: null, title, originalName: basename(path), storedPath, metadata: { bytes: data.length },
  });
  let pages = (await loadUnits(db, source.id)).length;
  if (pages === 0) {
    const parsed = (await pdfPages(data)).map((text, i) => ({ kind: 'page' as const, ordinal: i + 1, pageNo: i + 1, text }));
    pages = (await insertUnits(db, source.id, parsed)).length;
  }
  return { sourceId: source.id, pages, duplicate: !source.created };
}

export async function ingestFile(db: Db, input: IngestInput, config = senseiConfig()): Promise<IngestResult> {
  const kind = input.kind ?? detectKind(input.path);
  const data = await readFile(input.path);
  const hash = sha256(data);
  const ext = extname(input.path).toLowerCase();
  const storedPath = join(config.libraryDir, `${hash}${ext}`);
  await mkdir(config.libraryDir, { recursive: true });
  const exists = await stat(storedPath).then(() => true, () => false);
  if (!exists) await copyFile(input.path, storedPath);

  const courseId = await ensureCourse(db, input.course.code, input.course.title ?? input.course.code);
  const lectureId = input.lectureId ?? (await ensureLecture(db, { courseId, ...input.lecture }));
  const source = await registerSource(db, {
    sha256: hash, kind, courseId, title: input.lecture.title, originalName: basename(input.path), storedPath,
    metadata: { bytes: data.length },
  });
  await linkLectureSource(db, lectureId, source.id);

  let units = (await loadUnits(db, source.id)).length;
  if (units === 0) {
    let parsed: SourceUnitInput[] = [];
    if (kind === 'slides' || kind === 'handout' || kind === 'textbook') {
      parsed = (await pdfPages(data)).map((text, i) => ({ kind: 'page' as const, ordinal: i + 1, pageNo: i + 1, text }));
    } else if (kind === 'transcript') {
      parsed = parseTranscript(data.toString('utf8'));
    }
    // Audio units are produced by transcription (a derived transcript source).
    units = (await insertUnits(db, source.id, parsed)).length;
  }
  return { lectureId, sourceId: source.id, kind, duplicate: !source.created, units };
}
