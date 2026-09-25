/**
 * Audio plumbing for reels: word timestamps from whisper.cpp on a padded window,
 * precise clip extraction, and seamless stitching (DECISIONS V12, V21):
 * 30 ms fade in / 80 ms fade out per clip, 0.5 s of silence between clips (no
 * crossfades across different sentences), one denoise pass over the whole reel,
 * two-pass loudness normalization to −16 LUFS, AAC at 48 kHz for iPhone.
 */
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import type { Db } from '../db/types';
import { senseiConfig } from '../config';
import { sha256 } from '../store';
import type { Word } from './boundaries';

const run = promisify(execFile);

export function whisperPaths(env: NodeJS.ProcessEnv = process.env) {
  const dir = env.SENSEI_WHISPER_DIR ?? join(homedir(), 'Documents', 'Claude MacOs', 'Sensei', 'Library', 'tools', 'whisper.cpp');
  return { bin: join(dir, 'build', 'bin', 'whisper-cli'), model: join(dir, 'models', 'ggml-base.en.bin') };
}

export async function whisperAvailable(): Promise<boolean> {
  const { bin, model } = whisperPaths();
  return (await stat(bin).then(() => true, () => false)) && (await stat(model).then(() => true, () => false));
}

/** Word times kept with the lecture's transcript (cloud transcription stores them), for a window. */
export async function storedWords(db: Db, audioSourceId: string, fromMs: number, toMs: number): Promise<Word[] | null> {
  const { rows } = await db.query<{ stored_path: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id FROM sensei_source WHERE derived_from = $1
       UNION ALL SELECT s.id FROM sensei_source s JOIN chain c ON s.derived_from = c.id)
     SELECT s.stored_path FROM sensei_source s JOIN chain c ON c.id = s.id
      WHERE s.kind = 'transcript' AND EXISTS (SELECT 1 FROM sensei_lecture_source ls WHERE ls.source_id = s.id)
      ORDER BY s.created_at DESC LIMIT 1`,
    [audioSourceId],
  );
  if (!rows[0]) return null;
  const saved = JSON.parse(await readFile(rows[0].stored_path, 'utf8').catch(() => '{}')) as { words?: Word[] };
  if (!saved.words?.length) return null;
  return saved.words.filter((w) => w.endMs >= fromMs && w.startMs <= toMs);
}

/**
 * Word times for a window, cheapest first: the stored transcript (free), then OpenAI
 * whisper-1 on just this window (a fraction of a cent), then this Mac's whisper only
 * if SENSEI_LOCAL_AUDIO=1.
 */
export async function wordsForWindow(db: Db, audioSourceId: string, audioPath: string, fromMs: number, toMs: number, vocabulary: string[] = []): Promise<Word[]> {
  const stored = await storedWords(db, audioSourceId, fromMs, toMs);
  if (stored?.length) return stored;
  const config = senseiConfig();
  if (config.openaiApiKey) {
    const { whisperApiTranscribe, recordTranscriptionUsage } = await import('../cloudTranscribe');
    const c = await whisperApiTranscribe(config.openaiApiKey, audioPath, { vocabulary, fromSec: fromMs / 1000, toSec: toMs / 1000 });
    await recordTranscriptionUsage(c.seconds, 'sensei:reels');
    return c.words;
  }
  if (process.env.SENSEI_LOCAL_AUDIO === '1' && (await whisperAvailable())) return wordsFor(audioPath, fromMs, toMs, vocabulary);
  throw new Error('No word timing for this recording (needs OpenAI credits, or SENSEI_LOCAL_AUDIO=1)');
}

/** Word timestamps (absolute ms in the source) for [fromMs, toMs] of an audio file, via whisper.cpp on this Mac. */
export async function wordsFor(audioPath: string, fromMs: number, toMs: number, vocabulary: string[] = []): Promise<Word[]> {
  const { bin, model } = whisperPaths();
  const dir = await mkdtemp(join(tmpdir(), 'sensei-whisper-'));
  try {
    const wav = join(dir, 'w.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(fromMs / 1000), '-to', String(toMs / 1000), '-i', audioPath, '-ar', '16000', '-ac', '1', wav]);
    const args = ['-ng', '-m', model, '-t', '6', '-ml', '1', '-sow', '-ojf', '-np', '-of', join(dir, 'out'), wav];
    // The lecture's own terms steer recognition of jargon (FiO2, PaCO2, drug names).
    if (vocabulary.length) args.push('--prompt', vocabulary.slice(0, 40).join(', '));
    await run(bin, args, { maxBuffer: 32 * 1024 * 1024 });
    const json = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')) as {
      transcription: { text: string; offsets: { from: number; to: number } }[];
    };
    return json.transcription
      .filter((s) => s.text.trim() && !/^\[.*\]$/.test(s.text.trim()))
      .map((s) => ({ text: s.text.trim(), startMs: fromMs + s.offsets.from, endMs: fromMs + s.offsets.to }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface StitchClip {
  audioPath: string;
  startMs: number;
  endMs: number;
}

/**
 * One finished clip, rendered once and kept: cut from the source, mono 48 kHz,
 * denoised, 30 ms fade in / 80 ms fade out, loudness-normalized to -16 LUFS (two
 * passes, linear). Named by source, start and end, so a reel rebuilt with new
 * clips only renders the new ones; the rest are reused as-is.
 */
export async function renderClip(c: StitchClip): Promise<string> {
  const dir = join(senseiConfig().home, 'reels', 'clips');
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${sha256(`v1\n${c.audioPath}\n${c.startMs}\n${c.endMs}`)}.wav`);
  if (await stat(out).then(() => true, () => false)) return out;
  const tmp = await mkdtemp(join(tmpdir(), 'sensei-clip-'));
  try {
    const dur = (c.endMs - c.startMs) / 1000;
    const cut = join(tmp, 'cut.wav');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(c.startMs / 1000), '-to', String(c.endMs / 1000), '-i', c.audioPath,
      '-ac', '1', '-ar', '48000', '-af', `afftdn=nf=-25,afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, dur - 0.08).toFixed(3)}:d=0.08`, cut,
    ]);
    // Two-pass loudnorm: measure, then apply linearly (no pumping).
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', cut, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 });
    const m = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)) as Record<string, string>;
    const filter = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    const part = join(tmp, 'norm.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', cut, '-af', filter, '-ar', '48000', '-ac', '1', part]);
    await rename(part, out).catch(async () => writeFile(out, await readFile(part)));
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Join rendered clips with 0.5 s of silence between them into one m4a. Returns each clip's offset. */
export async function stitch(clips: StitchClip[], outPath: string): Promise<{ durationMs: number; offsets: number[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'sensei-reel-'));
  const GAP = 0.5;
  try {
    const parts: string[] = [];
    const offsets: number[] = [];
    let t = 0;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(GAP), join(dir, 'gap.wav')]);
    for (const [i, c] of clips.entries()) {
      const file = await renderClip(c);
      if (i > 0) {
        parts.push(join(dir, 'gap.wav'));
        t += GAP;
      }
      offsets.push(Math.round(t * 1000));
      parts.push(file);
      t += (c.endMs - c.startMs) / 1000;
    }
    await writeFile(join(dir, 'list.txt'), parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const encoder = await run('ffmpeg', ['-hide_banner', '-encoders']).then((r) => (r.stdout.includes('aac_at') ? 'aac_at' : 'aac'), () => 'aac');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-ar', '48000', '-ac', '1', '-c:a', encoder, '-b:a', '96k', '-movflags', '+faststart', outPath]);
    return { durationMs: Math.round(t * 1000), offsets };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
