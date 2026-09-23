/**
 * Audio plumbing for reels: word timestamps from whisper.cpp on a padded window,
 * precise clip extraction, and seamless stitching (DECISIONS V12, V21):
 * 30 ms fade in / 80 ms fade out per clip, 0.5 s of silence between clips (no
 * crossfades across different sentences), one denoise pass over the whole reel,
 * two-pass loudness normalization to −16 LUFS, AAC at 48 kHz for iPhone.
 */
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

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

/** Word timestamps (absolute ms in the source) for [fromMs, toMs] of an audio file. */
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

/** Stitch clips into one normalized m4a. Returns each clip's offset in the reel. */
export async function stitch(clips: StitchClip[], outPath: string): Promise<{ durationMs: number; offsets: number[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'sensei-reel-'));
  const GAP = 0.5;
  try {
    const parts: string[] = [];
    const offsets: number[] = [];
    let t = 0;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(GAP), join(dir, 'gap.wav')]);
    for (const [i, c] of clips.entries()) {
      const dur = (c.endMs - c.startMs) / 1000;
      const file = join(dir, `c${i}.wav`);
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(c.startMs / 1000), '-to', String(c.endMs / 1000), '-i', c.audioPath,
        '-ac', '1', '-ar', '48000', '-af', `afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, dur - 0.08).toFixed(3)}:d=0.08`, file,
      ]);
      if (i > 0) {
        parts.push(join(dir, 'gap.wav'));
        t += GAP;
      }
      offsets.push(Math.round(t * 1000));
      parts.push(file);
      t += dur;
    }
    await writeFile(join(dir, 'list.txt'), parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = join(dir, 'joined.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-af', 'afftdn=nf=-25', joined]);
    // Two-pass loudnorm: measure, then apply linearly (no pumping).
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', joined, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 });
    const m = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)) as Record<string, string>;
    const filter = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    const encoder = await run('ffmpeg', ['-hide_banner', '-encoders']).then((r) => (r.stdout.includes('aac_at') ? 'aac_at' : 'aac'), () => 'aac');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', joined, '-af', filter, '-ar', '48000', '-ac', '1', '-c:a', encoder, '-b:a', '96k', '-movflags', '+faststart', outPath]);
    return { durationMs: Math.round(t * 1000), offsets };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
