import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { detectSilences, planChunks, probeDurationSec, validateChunk } from '@/lib/sensei/transcribe';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('planChunks', () => {
  it('cuts at the silence nearest 8 minutes, within 6–10 minute bounds', () => {
    const chunks = planChunks(1500, [100, 470, 500, 990, 1100]);
    expect(chunks).toEqual([[0, 470], [470, 990], [990, 1500]]);
  });

  it('falls back to a fixed cut when there is no silence in range', () => {
    expect(planChunks(1300, [])).toEqual([[0, 480], [480, 960], [960, 1300]]);
  });

  it('keeps a short recording whole', () => {
    expect(planChunks(300, [120])).toEqual([[0, 300]]);
  });
});

describe('validateChunk', () => {
  const seg = (start: string, end: string, text: string) => ({
    start, end, speaker: 'instructor' as const, text, slide_no: null, uncertain_terms: [],
  });

  it('offsets, clamps and orders timestamps', () => {
    const r = validateChunk(
      { segments: [seg('0:05', '0:20', 'Compliance is volume over pressure.'), seg('0:03', '9:99', 'Resistance is pressure over flow.')] },
      600_000,
      120_000,
    );
    expect(r.ok).toBe(true);
    expect(r.units[0].startMs).toBe(605_000);
    expect(r.units[1].startMs).toBe(605_000); // non-monotonic start clamped forward
    expect(r.units[1].endMs).toBe(720_000); // clamped to chunk end
  });

  it('rejects repetition loops', () => {
    const loop = 'the patient was placed on high flow nasal cannula at forty liters';
    const r = validateChunk({ segments: Array.from({ length: 6 }, (_, i) => seg(`0:${10 + i}`, `0:${11 + i}`, loop)) }, 0, 300_000);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/repetition/);
  });

  it('rejects implausible speech density (invented text)', () => {
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ');
    const r = validateChunk({ segments: [seg('0:00', '1:59', words)] }, 0, 120_000);
    expect(r.ok).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)('ffmpeg helpers', () => {
  it('reads duration and finds a silence between two tones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sensei-tone-'));
    const path = join(dir, 'tone.m4a');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', path,
    ]);
    expect(await probeDurationSec(path)).toBeCloseTo(8, 0);
    const silences = await detectSilences(path);
    expect(silences.some((s) => s > 3 && s < 5)).toBe(true);
  });
});
