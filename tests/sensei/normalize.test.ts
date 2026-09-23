import { describe, expect, it } from 'vitest';

import {
  aliasCanAutoAttach,
  checkNumericFidelity,
  extractQuantities,
  isNeverMergePair,
  normalizeTerm,
  numericSignature,
  quoteAppearsIn,
} from '@/lib/sensei/normalize';

describe('normalizeTerm', () => {
  it('folds subscripts and case', () => {
    expect(normalizeTerm('FiO₂')).toBe('fio2');
    expect(normalizeTerm('Auto-PEEP')).toBe('auto peep');
  });
});

describe('alias policy', () => {
  it('never auto-attaches short or ambiguous abbreviations', () => {
    expect(aliasCanAutoAttach('PE')).toBe(false);
    expect(aliasCanAutoAttach('CO')).toBe(false);
    expect(aliasCanAutoAttach('ABG')).toBe(false);
    expect(aliasCanAutoAttach('PEEP')).toBe(true);
    expect(aliasCanAutoAttach('FiO₂')).toBe(true);
    expect(aliasCanAutoAttach('positive end-expiratory pressure')).toBe(true);
  });

  it('keeps FiO2 / PaO2 / SpO2 distinct', () => {
    expect(isNeverMergePair('FiO₂', 'PaO2')).toBe(true);
    expect(isNeverMergePair('SpO2', 'PaO₂')).toBe(true);
    expect(isNeverMergePair('Pulmonary embolism', 'Pleural effusion')).toBe(true);
    expect(isNeverMergePair('PEEP', 'Positive end-expiratory pressure')).toBe(false);
  });
});

describe('numeric fidelity gate', () => {
  it('rejects a wrong number that fuzzy matching would accept', () => {
    const r = checkNumericFidelity('Start PEEP at 15 cmH2O.', 'we usually start PEEP at 5 cm H2O');
    expect(r.ok).toBe(false);
  });

  it('accepts spoken numbers in the transcript', () => {
    expect(checkNumericFidelity('Start PEEP at 5 cmH2O.', 'we start PEEP at five centimeters of water').ok).toBe(true);
    expect(checkNumericFidelity('Room air FiO2 is 0.21.', 'room air is point two one').ok).toBe(true);
  });

  it('catches unit mismatches (mL/kg vs L/kg, mmHg vs cmH2O)', () => {
    expect(checkNumericFidelity('Tidal volume 6 to 8 mL/kg.', 'tidal volume of 6 to 8 L per minute').ok).toBe(false);
    expect(checkNumericFidelity('Keep plateau below 30 mmHg.', 'keep plateau below 30 cmH2O').ok).toBe(false);
    expect(checkNumericFidelity('Keep plateau below 30 cmH2O.', 'keep your plateau under thirty centimeters of water').ok).toBe(true);
  });

  it('flags a changed range endpoint', () => {
    expect(checkNumericFidelity('Tidal volume 8-10 mL/kg.', 'set tidal volume at 6 to 8 mls per kilo').ok).toBe(false);
    expect(checkNumericFidelity('Tidal volume 6-8 mL/kg.', 'set tidal volume at 6 to 8 mls per kilo').ok).toBe(true);
  });

  it('ignores digits inside terms like FiO2 and CO2', () => {
    expect(extractQuantities('FiO2 and PaCO2 rise')).toEqual([]);
  });

  it('does not treat the word "one" in a statement as a numeric claim', () => {
    expect(checkNumericFidelity('This is one of the most tested concepts.', 'this shows up on every exam').ok).toBe(true);
  });

  it('numeric signatures differ when values change', () => {
    expect(numericSignature('Normal PaO2 is 80-100 mmHg')).not.toBe(numericSignature('Normal PaO2 is 75-100 mmHg'));
    expect(numericSignature('Normal PaO2 is 80-100 mmHg')).toBe(numericSignature('PaO2 normal range 80 to 100'));
  });
});

describe('quoteAppearsIn', () => {
  it('matches a lightly-edited quote and rejects an invented one', () => {
    const unit = 'So remember, compliance is the change in volume over the change in pressure.';
    expect(quoteAppearsIn('compliance is the change in volume over the change in pressure', unit)).toBe(true);
    expect(quoteAppearsIn('resistance equals pressure over flow', unit)).toBe(false);
  });
});
