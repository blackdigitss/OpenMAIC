import { describe, expect, it } from 'vitest';

import { citePage, degarble, printedPage } from '@/lib/sensei/textbook';

describe('textbook repair', () => {
  it('fixes the extraction artifacts seen in Egan’s', () => {
    expect(degarble('CaO2 ¼ ð1:34 × Hb × SaO2Þ þ ð0:003 × PaO2Þ')).toBe('CaO2 = (1:34 × Hb × SaO2) + (0:003 × PaO2)');
    expect(degarble('VT of 6e8 mL/kg, pH 7.35e7.45')).toBe('VT of 6–8 mL/kg, pH 7.35–7.45');
    expect(degarble('the patient uses the device')).toBe('the patient uses the device');
  });

  it('reads the printed page from either footer style', () => {
    expect(printedPage('text…\n66 SECTION I Foundations of Respiratory Care')).toBe('66');
    expect(printedPage('text…\nCHAPTER 21 Review of Thoracic Imaging 437')).toBe('437');
    expect(printedPage('text…\nCHAPTER 52 Monitoring the Patient in the Intensive Care Unit 1179.e1')).toBe('1179.e1');
    expect(printedPage('no footer here')).toBeNull();
    expect(citePage('1179.e1', 1300)).toBe('p. 1179.e1 (online)');
    expect(citePage(null, 12)).toBe('PDF p. 12');
  });
});
