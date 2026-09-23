import { describe, expect, it } from 'vitest';

import { CASE_FAMILIES, classifyAbg } from '@/lib/sensei/cases/families';

describe('case families', () => {
  for (const family of CASE_FAMILIES) {
    it(`${family.id}: 300 generated items are well-formed and unambiguous`, () => {
      for (let seed = 1; seed <= 300; seed++) {
        const item = family.generate(seed);
        expect(item.options).toHaveLength(4);
        expect(new Set(item.options).size, `${family.id} seed ${seed} duplicate options`).toBe(4);
        expect(item.answer).toBeGreaterThanOrEqual(0);
        expect(item.answer).toBeLessThan(4);
        expect(item.stem).not.toMatch(/NaN|undefined|Infinity/);
        expect(item.rationale.join(' ')).not.toMatch(/NaN|undefined|Infinity/);
        expect(item.options.join(' ')).not.toMatch(/all of the above|none of the above/i);
      }
    });
  }

  it('transport key matches the arithmetic (500 psig reserve)', () => {
    const fam = CASE_FAMILIES.find((f) => f.id === 'transport-cylinder')!;
    for (let seed = 1; seed <= 300; seed++) {
      const item = fam.generate(seed);
      const [, flow] = /cannula at (\d+) L\/min/.exec(item.stem)!;
      const [, trip] = /about (\d+) minutes/.exec(item.stem)!;
      const [, psig] = /reads (\d+) psig/.exec(item.stem)!;
      const minutes = ((+psig - 500) * 0.28) / +flow;
      const key = item.options[item.answer];
      if (minutes >= 2 * +trip) expect(key).toBe('Proceed with the current cylinder');
      else {
        expect(minutes).toBeLessThan(+trip);
        expect(key).toMatch(/full E cylinder/);
      }
    }
  });

  it('ABG answer key agrees with an independent reading of the values', () => {
    const fam = CASE_FAMILIES.find((f) => f.id === 'abg-interpretation')!;
    for (let seed = 1; seed <= 300; seed++) {
      const item = fam.generate(seed);
      const [, ph, paco2, hco3] = /pH ([\d.]+), PaCO2 (\d+) mmHg, HCO3⁻ (\d+)/.exec(item.stem)!;
      const c = classifyAbg(+ph, +paco2, +hco3)!;
      expect(item.options[item.answer].toLowerCase()).toBe(`${c.comp} ${c.primary}`);
    }
  });

  it('classifier handles textbook examples', () => {
    expect(classifyAbg(7.25, 60, 24)).toEqual({ primary: 'respiratory acidosis', comp: 'uncompensated' });
    expect(classifyAbg(7.36, 60, 33)).toEqual({ primary: 'respiratory acidosis', comp: 'fully compensated' });
    expect(classifyAbg(7.3, 30, 14)).toEqual({ primary: 'metabolic acidosis', comp: 'partially compensated' });
    expect(classifyAbg(7.52, 40, 32)).toEqual({ primary: 'metabolic alkalosis', comp: 'uncompensated' });
  });
});
