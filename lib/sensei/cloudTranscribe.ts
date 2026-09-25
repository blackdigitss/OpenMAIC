/**
 * Class audio → timestamped words and segments with OpenAI's whisper-1
 * ($0.006/minute), so the Mac only cuts and compresses audio (seconds of work)
 * instead of running a speech model for hours. whisper-1 decodes every second it is
 * given (no skipped stretches) and returns word-level times, which the professor
 * reels reuse, so clips never need a second transcription.
 */
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import type { RawSegment } from './localTranscribe';
import type { Word } from './reels/boundaries';

const run = promisify(execFile);

export interface CloudTranscript {
  segments: RawSegment[];
  words: Word[];
  seconds: number;
}

interface VerboseJson {
  duration?: number;
  segments?: { start: number; end: number; text: string }[];
  words?: { word: string; start: number; end: number }[];
}

/** One request: a compressed piece of audio (under the 25 MB upload limit). */
async function transcribePiece(apiKey: string, file: Buffer, prompt: string): Promise<VerboseJson> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', 'en');
  form.append('temperature', '0');
  if (prompt) form.append('prompt', prompt);
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    }).catch((e) => e as Error);
    if (res instanceof Error) {
      last = res;
    } else if (res.ok) {
      return (await res.json()) as VerboseJson;
    } else {
      const body = await res.text();
      // No credits or a bad key won't fix itself: report it so the next route is used.
      if (res.status === 401 || res.status === 403 || /insufficient_quota|billing/i.test(body)) {
        throw Object.assign(new Error(`OpenAI transcription: ${body.slice(0, 200)}`), { statusCode: res.status === 429 ? 429 : res.status, message: `no credits: ${body.slice(0, 200)}` });
      }
      last = new Error(`OpenAI transcription ${res.status}: ${body.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw last;
}

/**
 * whisper-1's word list has no punctuation, but reels cut on sentence ends. Walk the
 * punctuated segment text alongside the words and copy each token's punctuation.
 */
export function punctuate(out: VerboseJson): { word: string; start: number; end: number }[] {
  const words = (out.words ?? []).map((w) => ({ ...w, word: w.word.trim() }));
  const tokens = (out.segments ?? []).flatMap((s) => s.text.trim().split(/\s+/)).filter(Boolean);
  const bare = (t: string) => t.toLowerCase().replace(/[^a-z0-9%]/g, '');
  let j = 0;
  for (const w of words) {
    // Find this word among the next few tokens (tolerates small mismatches).
    for (let k = j; k < Math.min(tokens.length, j + 4); k++) {
      if (bare(tokens[k]) === bare(w.word)) {
        w.word = tokens[k];
        j = k + 1;
        break;
      }
    }
  }
  return words;
}

/** Split long audio at quiet moments into ~20-minute pieces (each well under 25 MB compressed). */
export function planPieces(durationSec: number, silences: number[], target = 1200, max = 1400): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (durationSec - start > max) {
    const ideal = start + target;
    const cut = silences.filter((s) => s > start + 600 && s < start + max).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0] ?? ideal;
    out.push([start, cut]);
    start = cut;
  }
  out.push([start, durationSec]);
  return out;
}

export async function whisperApiTranscribe(
  apiKey: string,
  audioPath: string,
  opts: { vocabulary?: string[]; fromSec?: number; toSec?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<CloudTranscript> {
  const { probeDurationSec, detectSilences } = await import('./transcribe');
  const from = opts.fromSec ?? 0;
  const to = opts.toSec ?? (await probeDurationSec(audioPath));
  const pieces =
    opts.fromSec != null || to - from <= 1400
      ? ([[from, to]] as [number, number][])
      : planPieces(to - from, await detectSilences(audioPath)).map(([a, b]) => [a + from, b + from] as [number, number]);
  const prompt = opts.vocabulary?.length ? `Respiratory therapy class. ${opts.vocabulary.slice(0, 60).join(', ')}.`.slice(0, 800) : '';
  const dir = await mkdtemp(join(tmpdir(), 'sensei-cloud-'));
  const segments: RawSegment[] = [];
  const words: Word[] = [];
  try {
    for (const [i, [a, b]] of pieces.entries()) {
      const mp3 = join(dir, `p${i}.mp3`);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(a), '-to', String(b), '-i', audioPath, '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
      const out = await transcribePiece(apiKey, await readFile(mp3), prompt);
      const off = a * 1000;
      for (const s of out.segments ?? []) segments.push({ startMs: Math.round(off + s.start * 1000), endMs: Math.round(off + s.end * 1000), text: s.text.trim() });
      for (const w of punctuate(out)) words.push({ text: w.word, startMs: Math.round(off + w.start * 1000), endMs: Math.round(off + w.end * 1000) });
      opts.onProgress?.(i + 1, pieces.length);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { segments, words, seconds: to - from };
}

/** Log transcription minutes so they show in the budget. */
export async function recordTranscriptionUsage(seconds: number, source: string): Promise<void> {
  const { recordUsage } = await import('@/lib/server/usage-storage');
  await recordUsage({ kind: 'asr', source, providerId: 'openai', modelId: 'whisper-1', modelString: 'openai:whisper-1', quantity: Math.round(seconds), unit: 'second' }).catch(() => undefined);
}
