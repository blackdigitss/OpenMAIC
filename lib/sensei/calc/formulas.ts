/**
 * Respiratory care calculations — answers come from this code, never from a model.
 * Constants verified against Egan's Fundamentals 13e (PDF pages noted) during the v2
 * plan review. Where sources legitimately differ, each accepted method is a variant:
 * an answer matching ANY variant is correct, and the student sees which one matched.
 */

export type Values = Record<string, number | string>;

export interface Input {
  key: string;
  label: string;
  unit?: string;
  /** Numeric range and step, or a fixed set of choices. */
  min?: number;
  max?: number;
  step?: number;
  choices?: (number | string)[];
}

export interface Variant {
  id: string;
  label: string;
  compute: (v: Values) => number;
}

export interface Formula {
  id: string;
  name: string;
  /** Taught concept names/aliases (normalized match) that unlock this formula. */
  concepts: string[];
  unit: string;
  decimals: number;
  inputs: Input[];
  variants: Variant[];
  /** Relative or absolute tolerance for accepting an answer. */
  tolerance: { rel?: number; abs?: number };
  question: (v: Values) => string;
  steps: (v: Values, variant: Variant) => string[];
  /** Optional constraint on generated values (return false to redraw). */
  valid?: (v: Values) => boolean;
  /** Where Egan's shows it (PDF page), for "see the textbook". */
  source?: string;
  /** NBRC RT Exam outline tasks this practices. */
  board: string[];
  /** Short interpretation shown after the answer. */
  interpret?: (answer: number, v: Values) => string | null;
}

const n = (v: Values, k: string) => Number(v[k]);
const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (x: number, d = 2) => String(r(x, d));

const CYLINDER_FACTORS: Record<string, number> = { D: 0.16, E: 0.28, G: 2.41, 'H/K': 3.14, M: 1.56 };
const ENTRAINMENT_CHART: Record<number, number> = { 24: 25, 28: 10, 30: 8, 35: 5, 40: 3, 45: 2, 50: 1.7, 60: 1 };
const entrainmentFormula = (fio2: number) => (100 - fio2) / (fio2 - 21);

function pao2(v: Values, mode: 'standard' | 'noR' | 'full'): number {
  const fio2 = n(v, 'fio2');
  const inspired = fio2 * (n(v, 'pb') - 47);
  const paco2 = n(v, 'paco2');
  if (mode === 'noR') return inspired - paco2 * (fio2 >= 0.6 ? 1 : 1 / 0.8);
  if (mode === 'full') return inspired - paco2 * (fio2 + (1 - fio2) / 0.8);
  return inspired - paco2 / 0.8;
}

export const FORMULAS: Formula[] = [
  {
    id: 'cylinder-duration',
    name: 'Cylinder duration',
    concepts: ['cylinder duration', 'e cylinder', 'oxygen cylinder', 'cylinder factor', 'medical gas cylinder', 'compressed gas cylinder'],
    unit: 'min',
    decimals: 0,
    inputs: [
      { key: 'size', label: 'Cylinder', choices: ['D', 'E', 'G', 'H/K', 'M'] },
      { key: 'psig', label: 'Gauge pressure', unit: 'psig', min: 600, max: 2200, step: 50 },
      { key: 'flow', label: 'Flow', unit: 'L/min', min: 1, max: 15, step: 0.5 },
    ],
    variants: [
      { id: 'empty', label: 'To empty (Egan’s)', compute: (v) => (n(v, 'psig') * CYLINDER_FACTORS[String(v.size)]) / n(v, 'flow') },
      { id: 'reserve500', label: 'Keeping a 500 psig reserve', compute: (v) => ((n(v, 'psig') - 500) * CYLINDER_FACTORS[String(v.size)]) / n(v, 'flow') },
      { id: 'reserve200', label: 'Keeping a 200 psig reserve', compute: (v) => ((n(v, 'psig') - 200) * CYLINDER_FACTORS[String(v.size)]) / n(v, 'flow') },
    ],
    tolerance: { rel: 0.02, abs: 1 },
    question: (v) => `An ${v.size} cylinder reads ${v.psig} psig. Your patient is on ${v.flow} L/min. How many minutes will it last?`,
    steps: (v, variant) => {
      const f = CYLINDER_FACTORS[String(v.size)];
      const p = variant.id === 'empty' ? n(v, 'psig') : n(v, 'psig') - (variant.id === 'reserve500' ? 500 : 200);
      return [
        `Duration (min) = pressure (psig) × cylinder factor ÷ flow (L/min)`,
        `${v.size} cylinder factor = ${f} L/psig${variant.id === 'empty' ? '' : `; usable pressure = ${v.psig} − ${variant.id === 'reserve500' ? 500 : 200} = ${p} psig`}`,
        `${p} × ${f} ÷ ${v.flow} = ${fmt((p * f) / n(v, 'flow'), 0)} min (${fmt((p * f) / n(v, 'flow') / 60, 1)} h)`,
      ];
    },
    source: 'Egan’s PDF p. 986–987',
    board: ['II.A'],
  },
  {
    id: 'liquid-o2-duration',
    name: 'Liquid oxygen duration',
    concepts: ['liquid oxygen', 'liquid o2', 'portable liquid oxygen'],
    unit: 'min',
    decimals: 0,
    inputs: [
      { key: 'lbs', label: 'Liquid O2 remaining', unit: 'lb', min: 1, max: 40, step: 0.5 },
      { key: 'flow', label: 'Flow', unit: 'L/min', min: 0.5, max: 6, step: 0.5 },
    ],
    variants: [{ id: 'standard', label: '1 lb liquid O2 = 344 L gas', compute: (v) => (n(v, 'lbs') * 344) / n(v, 'flow') }],
    tolerance: { rel: 0.02, abs: 1 },
    question: (v) => `A portable liquid O2 unit holds ${v.lbs} lb. At ${v.flow} L/min, how many minutes will it last?`,
    steps: (v) => [
      `Gaseous O2 (L) = liquid weight (lb) × 344 L/lb`,
      `${v.lbs} × 344 = ${fmt(n(v, 'lbs') * 344, 0)} L`,
      `${fmt(n(v, 'lbs') * 344, 0)} ÷ ${v.flow} L/min = ${fmt((n(v, 'lbs') * 344) / n(v, 'flow'), 0)} min`,
    ],
    source: 'Egan’s PDF p. 987',
    board: ['II.A'],
  },
  {
    id: 'nasal-cannula-fio2',
    name: 'Nasal cannula FiO2 (estimate)',
    concepts: ['nasal cannula'],
    unit: '%',
    decimals: 0,
    inputs: [{ key: 'flow', label: 'Flow', unit: 'L/min', min: 1, max: 6, step: 1 }],
    variants: [{ id: 'rule', label: '21% + 4% per L/min (estimate)', compute: (v) => 21 + 4 * n(v, 'flow') }],
    tolerance: { abs: 1 },
    question: (v) => `Estimate the FiO2 for a patient on a nasal cannula at ${v.flow} L/min.`,
    steps: (v) => [`Rule of thumb: FiO2 ≈ 21% + 4% for each L/min`, `21 + 4 × ${v.flow} = ${21 + 4 * n(v, 'flow')}%`, `Only an estimate: real FiO2 varies with breathing pattern.`],
    board: ['III.C'],
  },
  {
    id: 'entrainment-ratio',
    name: 'Air-entrainment ratio',
    concepts: ['air entrainment', 'venturi mask', 'air entrainment mask', 'entrainment ratio', 'air to oxygen ratio'],
    unit: ':1 (air:O2)',
    decimals: 1,
    inputs: [{ key: 'fio2', label: 'Set FiO2', unit: '%', choices: [24, 28, 30, 35, 40, 50, 60] }],
    variants: [
      { id: 'formula', label: 'Formula (100 − FiO2) ÷ (FiO2 − 21)', compute: (v) => entrainmentFormula(n(v, 'fio2')) },
      { id: 'chart', label: 'Memorized chart value', compute: (v) => ENTRAINMENT_CHART[n(v, 'fio2')] },
    ],
    tolerance: { rel: 0.03, abs: 0.1 },
    question: (v) => `What air-to-oxygen entrainment ratio delivers ${v.fio2}% O2? (answer the air part of x:1)`,
    steps: (v, variant) =>
      variant.id === 'chart'
        ? [`Chart value for ${v.fio2}%: ${ENTRAINMENT_CHART[n(v, 'fio2')]}:1`]
        : [
            `Air:O2 = (100 − FiO2) ÷ (FiO2 − 21)`,
            `(100 − ${v.fio2}) ÷ (${v.fio2} − 21) = ${100 - n(v, 'fio2')} ÷ ${n(v, 'fio2') - 21} = ${fmt(entrainmentFormula(n(v, 'fio2')), 1)}:1`,
            `Chart value: ${ENTRAINMENT_CHART[n(v, 'fio2')]}:1 (also accepted)`,
          ],
    source: 'Egan’s Box 42.1',
    board: ['III.C'],
  },
  {
    id: 'entrainment-total-flow',
    name: 'Air-entrainment total flow',
    concepts: ['air entrainment', 'venturi mask', 'air entrainment mask', 'total flow'],
    unit: 'L/min',
    decimals: 0,
    inputs: [
      { key: 'fio2', label: 'Set FiO2', unit: '%', choices: [24, 28, 30, 35, 40, 50, 60] },
      { key: 'o2', label: 'Oxygen flow', unit: 'L/min', min: 2, max: 15, step: 1 },
    ],
    variants: [
      { id: 'formula', label: 'Formula ratio', compute: (v) => n(v, 'o2') * (1 + entrainmentFormula(n(v, 'fio2'))) },
      { id: 'chart', label: 'Chart ratio', compute: (v) => n(v, 'o2') * (1 + ENTRAINMENT_CHART[n(v, 'fio2')]) },
    ],
    tolerance: { rel: 0.03, abs: 1 },
    question: (v) => `An air-entrainment mask is set to ${v.fio2}% with ${v.o2} L/min of O2. What is the total flow?`,
    steps: (v, variant) => {
      const ratio = variant.id === 'chart' ? ENTRAINMENT_CHART[n(v, 'fio2')] : entrainmentFormula(n(v, 'fio2'));
      return [
        `Total flow = O2 flow × (air parts + O2 parts)`,
        `Ratio at ${v.fio2}% ≈ ${fmt(ratio, 1)}:1, so ${fmt(ratio, 1)} + 1 = ${fmt(ratio + 1, 1)} total parts`,
        `${v.o2} × ${fmt(ratio + 1, 1)} = ${fmt(n(v, 'o2') * (ratio + 1), 0)} L/min`,
      ];
    },
    interpret: (a) => (a >= 40 ? 'Meets a typical adult inspiratory demand (about 40 L/min or more).' : 'Below a typical adult inspiratory flow (~40 L/min): the patient may entrain room air, so FiO2 is lower than set.'),
    board: ['III.C'],
  },
  {
    id: 'pao2-alveolar',
    name: 'Alveolar oxygen (PAO2)',
    concepts: ['alveolar air equation', 'alveolar oxygen', 'pao2 alveolar', 'alveolar partial pressure of oxygen', 'alveolar gas equation'],
    unit: 'mmHg',
    decimals: 0,
    inputs: [
      { key: 'fio2', label: 'FiO2', choices: [0.21, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0] },
      { key: 'pb', label: 'Barometric pressure', unit: 'mmHg', choices: [760, 747, 740] },
      { key: 'paco2', label: 'PaCO2', unit: 'mmHg', min: 30, max: 60, step: 1 },
    ],
    variants: [
      { id: 'standard', label: 'PaCO2 ÷ 0.8 (Egan’s)', compute: (v) => pao2(v, 'standard') },
      { id: 'noR', label: 'Drop the 0.8 at FiO2 ≥ 0.6', compute: (v) => pao2(v, 'noR') },
      { id: 'full', label: 'Full equation with FiO2 correction', compute: (v) => pao2(v, 'full') },
    ],
    tolerance: { abs: 3 },
    question: (v) => `Calculate PAO2: FiO2 ${v.fio2}, barometric pressure ${v.pb} mmHg, PaCO2 ${v.paco2} mmHg.`,
    steps: (v, variant) => [
      `PAO2 = FiO2 × (PB − 47) − PaCO2 ${variant.id === 'standard' ? '÷ 0.8' : variant.id === 'full' ? '× [FiO2 + (1 − FiO2) ÷ 0.8]' : '(÷ 0.8 below FiO2 0.6)'}`,
      `${v.fio2} × (${v.pb} − 47) = ${fmt(n(v, 'fio2') * (n(v, 'pb') - 47), 1)}`,
      `= ${fmt(variant.compute(v), 0)} mmHg`,
    ],
    source: 'Egan’s PDF p. 290–291',
    board: ['I.C'],
  },
  {
    id: 'a-a-gradient',
    name: 'A–a gradient',
    concepts: ['a a gradient', 'alveolar arterial gradient', 'p a a o2', 'alveolar arterial oxygen tension gradient', 'a a difference'],
    unit: 'mmHg',
    decimals: 0,
    inputs: [
      { key: 'fio2', label: 'FiO2', choices: [0.21, 0.3, 0.4, 0.5, 0.6, 1.0] },
      { key: 'pb', label: 'Barometric pressure', unit: 'mmHg', choices: [760] },
      { key: 'paco2', label: 'PaCO2', unit: 'mmHg', min: 30, max: 60, step: 1 },
      { key: 'pao2', label: 'PaO2', unit: 'mmHg', min: 45, max: 110, step: 1 },
    ],
    variants: [
      { id: 'standard', label: 'PaCO2 ÷ 0.8 (Egan’s)', compute: (v) => pao2(v, 'standard') - n(v, 'pao2') },
      { id: 'noR', label: 'Drop the 0.8 at FiO2 ≥ 0.6', compute: (v) => pao2(v, 'noR') - n(v, 'pao2') },
    ],
    tolerance: { abs: 3 },
    valid: (v) => pao2(v, 'standard') > n(v, 'pao2'),
    question: (v) => `FiO2 ${v.fio2}, PB ${v.pb}, PaCO2 ${v.paco2}, PaO2 ${v.pao2} mmHg. What is the P(A−a)O2?`,
    steps: (v, variant) => {
      const pA = variant.id === 'noR' ? pao2(v, 'noR') : pao2(v, 'standard');
      return [`First PAO2 = ${v.fio2} × (${v.pb} − 47) − ${v.paco2}${variant.id === 'noR' && n(v, 'fio2') >= 0.6 ? '' : ' ÷ 0.8'} = ${fmt(pA, 0)}`, `P(A−a)O2 = ${fmt(pA, 0)} − ${v.pao2} = ${fmt(pA - n(v, 'pao2'), 0)} mmHg`];
    },
    interpret: (a, v) => (n(v, 'fio2') <= 0.21 ? (a <= 15 ? 'Normal on room air (young adult ~5–15 mmHg).' : 'Widened on room air: suggests V/Q mismatch, shunt, or a diffusion problem.') : null),
    board: ['I.C', 'I.D'],
  },
  {
    id: 'pf-ratio',
    name: 'P/F ratio',
    concepts: ['p f ratio', 'pao2 fio2 ratio', 'p f', 'oxygenation ratio'],
    unit: '',
    decimals: 0,
    inputs: [
      { key: 'pao2', label: 'PaO2', unit: 'mmHg', min: 50, max: 150, step: 1 },
      { key: 'fio2', label: 'FiO2', choices: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0] },
    ],
    variants: [{ id: 'standard', label: 'PaO2 ÷ FiO2 (as a decimal)', compute: (v) => n(v, 'pao2') / n(v, 'fio2') }],
    tolerance: { rel: 0.01, abs: 1 },
    question: (v) => `PaO2 is ${v.pao2} mmHg on FiO2 ${v.fio2}. What is the P/F ratio?`,
    steps: (v) => [`P/F = PaO2 ÷ FiO2 (decimal)`, `${v.pao2} ÷ ${v.fio2} = ${fmt(n(v, 'pao2') / n(v, 'fio2'), 0)}`],
    interpret: (a) => (a < 100 ? 'Under 100: severe hypoxemia (Berlin ARDS range, if other criteria are met).' : a < 200 ? '100–200: moderate.' : a < 300 ? '200–300: mild.' : 'Above 300.'),
    board: ['I.C', 'I.D'],
  },
  {
    id: 'cao2',
    name: 'Arterial O2 content (CaO2)',
    concepts: ['oxygen content', 'arterial oxygen content', 'cao2', 'o2 content'],
    unit: 'mL/dL',
    decimals: 1,
    inputs: [
      { key: 'hb', label: 'Hemoglobin', unit: 'g/dL', min: 8, max: 18, step: 0.5 },
      { key: 'sao2', label: 'SaO2', unit: '%', min: 80, max: 100, step: 1 },
      { key: 'pao2', label: 'PaO2', unit: 'mmHg', min: 50, max: 110, step: 1 },
    ],
    variants: [
      { id: '1.34', label: '1.34 mL O2/g Hb (Egan’s)', compute: (v) => 1.34 * n(v, 'hb') * (n(v, 'sao2') / 100) + 0.003 * n(v, 'pao2') },
      { id: '1.36', label: '1.36 mL O2/g Hb', compute: (v) => 1.36 * n(v, 'hb') * (n(v, 'sao2') / 100) + 0.003 * n(v, 'pao2') },
      { id: '1.39', label: '1.39 mL O2/g Hb', compute: (v) => 1.39 * n(v, 'hb') * (n(v, 'sao2') / 100) + 0.003 * n(v, 'pao2') },
    ],
    tolerance: { abs: 0.15 },
    question: (v) => `Hb ${v.hb} g/dL, SaO2 ${v.sao2}%, PaO2 ${v.pao2} mmHg. What is the CaO2?`,
    steps: (v, variant) => {
      const k = Number(variant.id);
      const bound = k * n(v, 'hb') * (n(v, 'sao2') / 100);
      const dissolved = 0.003 * n(v, 'pao2');
      return [`CaO2 = (${k} × Hb × SaO2) + (0.003 × PaO2)`, `Bound: ${k} × ${v.hb} × ${n(v, 'sao2') / 100} = ${fmt(bound, 2)}`, `Dissolved: 0.003 × ${v.pao2} = ${fmt(dissolved, 2)}`, `CaO2 = ${fmt(bound + dissolved, 1)} mL/dL`];
    },
    source: 'Egan’s PDF p. 297',
    board: ['I.C'],
  },
  {
    id: 'static-compliance',
    name: 'Static compliance',
    concepts: ['static compliance', 'compliance', 'lung compliance', 'respiratory system compliance'],
    unit: 'mL/cmH2O',
    decimals: 0,
    inputs: [
      { key: 'vt', label: 'Tidal volume', unit: 'mL', min: 300, max: 700, step: 10 },
      { key: 'pplat', label: 'Plateau pressure', unit: 'cmH2O', min: 12, max: 35, step: 1 },
      { key: 'peep', label: 'PEEP', unit: 'cmH2O', min: 0, max: 15, step: 1 },
    ],
    variants: [{ id: 'standard', label: 'VT ÷ (Pplat − PEEP)', compute: (v) => n(v, 'vt') / (n(v, 'pplat') - n(v, 'peep')) }],
    tolerance: { rel: 0.02, abs: 1 },
    valid: (v) => n(v, 'pplat') - n(v, 'peep') >= 5,
    question: (v) => `VT ${v.vt} mL, plateau ${v.pplat} cmH2O, PEEP ${v.peep} cmH2O. What is the static compliance?`,
    steps: (v) => [`Cstat = VT ÷ (Pplat − PEEP)`, `${v.vt} ÷ (${v.pplat} − ${v.peep}) = ${v.vt} ÷ ${n(v, 'pplat') - n(v, 'peep')} = ${fmt(n(v, 'vt') / (n(v, 'pplat') - n(v, 'peep')), 0)} mL/cmH2O`],
    board: ['I.C', 'I.D'],
  },
  {
    id: 'dynamic-compliance',
    name: 'Dynamic compliance',
    concepts: ['dynamic compliance', 'compliance'],
    unit: 'mL/cmH2O',
    decimals: 0,
    inputs: [
      { key: 'vt', label: 'Tidal volume', unit: 'mL', min: 300, max: 700, step: 10 },
      { key: 'pip', label: 'Peak pressure', unit: 'cmH2O', min: 15, max: 45, step: 1 },
      { key: 'peep', label: 'PEEP', unit: 'cmH2O', min: 0, max: 15, step: 1 },
    ],
    variants: [{ id: 'standard', label: 'VT ÷ (PIP − PEEP)', compute: (v) => n(v, 'vt') / (n(v, 'pip') - n(v, 'peep')) }],
    tolerance: { rel: 0.02, abs: 1 },
    valid: (v) => n(v, 'pip') - n(v, 'peep') >= 8,
    question: (v) => `VT ${v.vt} mL, peak pressure ${v.pip} cmH2O, PEEP ${v.peep} cmH2O. What is the dynamic compliance?`,
    steps: (v) => [`Cdyn = VT ÷ (PIP − PEEP)`, `${v.vt} ÷ ${n(v, 'pip') - n(v, 'peep')} = ${fmt(n(v, 'vt') / (n(v, 'pip') - n(v, 'peep')), 0)} mL/cmH2O`],
    board: ['I.C'],
  },
  {
    id: 'airway-resistance',
    name: 'Airway resistance',
    concepts: ['airway resistance', 'raw', 'resistance'],
    unit: 'cmH2O/L/s',
    decimals: 1,
    inputs: [
      { key: 'pip', label: 'Peak pressure', unit: 'cmH2O', min: 20, max: 45, step: 1 },
      { key: 'pplat', label: 'Plateau pressure', unit: 'cmH2O', min: 12, max: 30, step: 1 },
      { key: 'flow', label: 'Inspiratory flow', unit: 'L/min', choices: [30, 40, 50, 60, 80] },
    ],
    variants: [{ id: 'standard', label: '(PIP − Pplat) ÷ flow in L/s', compute: (v) => (n(v, 'pip') - n(v, 'pplat')) / (n(v, 'flow') / 60) }],
    tolerance: { rel: 0.03, abs: 0.2 },
    valid: (v) => n(v, 'pip') > n(v, 'pplat') + 2,
    question: (v) => `PIP ${v.pip}, plateau ${v.pplat} cmH2O, constant flow ${v.flow} L/min. What is the airway resistance?`,
    steps: (v) => [`Raw = (PIP − Pplat) ÷ flow (L/s)`, `Flow: ${v.flow} L/min ÷ 60 = ${fmt(n(v, 'flow') / 60, 2)} L/s`, `(${v.pip} − ${v.pplat}) ÷ ${fmt(n(v, 'flow') / 60, 2)} = ${fmt((n(v, 'pip') - n(v, 'pplat')) / (n(v, 'flow') / 60), 1)} cmH2O/L/s`],
    board: ['I.C'],
  },
  {
    id: 'minute-ventilation',
    name: 'Minute ventilation',
    concepts: ['minute ventilation', 've'],
    unit: 'L/min',
    decimals: 1,
    inputs: [
      { key: 'vt', label: 'Tidal volume', unit: 'mL', min: 300, max: 700, step: 10 },
      { key: 'f', label: 'Rate', unit: '/min', min: 8, max: 30, step: 1 },
    ],
    variants: [{ id: 'standard', label: 'VT (L) × rate', compute: (v) => (n(v, 'vt') / 1000) * n(v, 'f') }],
    tolerance: { rel: 0.02, abs: 0.1 },
    question: (v) => `VT ${v.vt} mL at a rate of ${v.f}/min. What is the minute ventilation?`,
    steps: (v) => [`VE = VT (L) × f`, `${n(v, 'vt') / 1000} × ${v.f} = ${fmt((n(v, 'vt') / 1000) * n(v, 'f'), 1)} L/min`],
    board: ['I.C'],
  },
  {
    id: 'alveolar-ventilation',
    name: 'Alveolar ventilation',
    concepts: ['alveolar ventilation', 'dead space', 'va'],
    unit: 'L/min',
    decimals: 1,
    inputs: [
      { key: 'vt', label: 'Tidal volume', unit: 'mL', min: 300, max: 700, step: 10 },
      { key: 'vd', label: 'Dead space', unit: 'mL', min: 100, max: 250, step: 10 },
      { key: 'f', label: 'Rate', unit: '/min', min: 8, max: 30, step: 1 },
    ],
    variants: [{ id: 'standard', label: '(VT − VD) × rate', compute: (v) => ((n(v, 'vt') - n(v, 'vd')) / 1000) * n(v, 'f') }],
    tolerance: { rel: 0.02, abs: 0.1 },
    valid: (v) => n(v, 'vt') > n(v, 'vd') + 100,
    question: (v) => `VT ${v.vt} mL, dead space ${v.vd} mL, rate ${v.f}/min. What is the alveolar ventilation?`,
    steps: (v) => [`VA = (VT − VD) × f`, `(${v.vt} − ${v.vd}) = ${n(v, 'vt') - n(v, 'vd')} mL = ${(n(v, 'vt') - n(v, 'vd')) / 1000} L`, `× ${v.f} = ${fmt(((n(v, 'vt') - n(v, 'vd')) / 1000) * n(v, 'f'), 1)} L/min`],
    board: ['I.C'],
  },
  {
    id: 'pbw',
    name: 'Predicted body weight',
    concepts: ['predicted body weight', 'ideal body weight', 'pbw', 'ibw'],
    unit: 'kg',
    decimals: 1,
    inputs: [
      { key: 'sex', label: 'Sex', choices: ['male', 'female'] },
      { key: 'inches', label: 'Height', unit: 'in', min: 60, max: 78, step: 1 },
    ],
    variants: [{ id: 'standard', label: 'ARDSNet PBW', compute: (v) => (v.sex === 'male' ? 50 : 45.5) + 2.3 * (n(v, 'inches') - 60) }],
    tolerance: { abs: 0.3 },
    question: (v) => `What is the predicted body weight of a ${v.sex} patient who is ${Math.floor(n(v, 'inches') / 12)} ft ${n(v, 'inches') % 12} in (${v.inches} in)?`,
    steps: (v) => [`PBW = ${v.sex === 'male' ? '50' : '45.5'} + 2.3 × (height in inches − 60)`, `${v.sex === 'male' ? '50' : '45.5'} + 2.3 × ${n(v, 'inches') - 60} = ${fmt((v.sex === 'male' ? 50 : 45.5) + 2.3 * (n(v, 'inches') - 60), 1)} kg`],
    source: 'Egan’s PDF p. 1194',
    board: ['III.C'],
  },
  {
    id: 'ie-ratio',
    name: 'I:E ratio',
    concepts: ['i e ratio', 'inspiratory time', 'expiratory time', 'total cycle time'],
    unit: '(1:x)',
    decimals: 1,
    inputs: [
      { key: 'f', label: 'Rate', unit: '/min', min: 10, max: 30, step: 2 },
      { key: 'ti', label: 'Inspiratory time', unit: 's', choices: [0.6, 0.8, 0.9, 1.0, 1.2] },
    ],
    variants: [{ id: 'standard', label: 'TE ÷ TI', compute: (v) => (60 / n(v, 'f') - n(v, 'ti')) / n(v, 'ti') }],
    tolerance: { abs: 0.1 },
    valid: (v) => 60 / n(v, 'f') > n(v, 'ti') * 1.5,
    question: (v) => `Rate ${v.f}/min with an inspiratory time of ${v.ti} s. What is the I:E ratio? (answer x in 1:x)`,
    steps: (v) => [`Total cycle time = 60 ÷ ${v.f} = ${fmt(60 / n(v, 'f'), 2)} s`, `TE = ${fmt(60 / n(v, 'f'), 2)} − ${v.ti} = ${fmt(60 / n(v, 'f') - n(v, 'ti'), 2)} s`, `I:E = 1 : ${fmt((60 / n(v, 'f') - n(v, 'ti')) / n(v, 'ti'), 1)}`],
    board: ['III.C'],
  },
  {
    id: 'rsbi',
    name: 'Rapid shallow breathing index',
    concepts: ['rapid shallow breathing index', 'rsbi', 'weaning'],
    unit: 'breaths/min/L',
    decimals: 0,
    inputs: [
      { key: 'f', label: 'Rate', unit: '/min', min: 12, max: 40, step: 1 },
      { key: 'vt', label: 'Spontaneous VT', unit: 'mL', min: 200, max: 600, step: 10 },
    ],
    variants: [{ id: 'standard', label: 'f ÷ VT (in liters)', compute: (v) => n(v, 'f') / (n(v, 'vt') / 1000) }],
    tolerance: { rel: 0.02, abs: 1 },
    question: (v) => `During a spontaneous breathing trial the rate is ${v.f}/min and VT is ${v.vt} mL. What is the RSBI?`,
    steps: (v) => [`RSBI = f ÷ VT (L)`, `${v.f} ÷ ${n(v, 'vt') / 1000} = ${fmt(n(v, 'f') / (n(v, 'vt') / 1000), 0)}`],
    interpret: (a) => (a < 105 ? 'Under 105: favors successful liberation.' : '105 or more: predicts failure of liberation.'),
    source: 'Egan’s PDF p. 1308',
    board: ['I.C', 'III.C'],
  },
  {
    id: 'heliox-flow',
    name: 'Heliox flow correction',
    concepts: ['heliox', 'helium oxygen'],
    unit: 'L/min',
    decimals: 1,
    inputs: [
      { key: 'mix', label: 'Mixture', choices: ['80/20', '70/30'] },
      { key: 'reading', label: 'O2 flowmeter reading', unit: 'L/min', min: 5, max: 15, step: 1 },
    ],
    variants: [{ id: 'standard', label: '80/20 × 1.8, 70/30 × 1.6', compute: (v) => n(v, 'reading') * (v.mix === '80/20' ? 1.8 : 1.6) }],
    tolerance: { rel: 0.02, abs: 0.2 },
    question: (v) => `${v.mix} heliox runs through an oxygen flowmeter reading ${v.reading} L/min. What is the actual flow?`,
    steps: (v) => [`Factor: ${v.mix === '80/20' ? '1.8 for 80/20' : '1.6 for 70/30'}`, `${v.reading} × ${v.mix === '80/20' ? 1.8 : 1.6} = ${fmt(n(v, 'reading') * (v.mix === '80/20' ? 1.8 : 1.6), 1)} L/min`],
    source: 'Egan’s PDF p. 1030',
    board: ['II.A', 'III.D'],
  },
  {
    id: 'anion-gap',
    name: 'Anion gap',
    concepts: ['anion gap', 'metabolic acidosis'],
    unit: 'mEq/L',
    decimals: 0,
    inputs: [
      { key: 'na', label: 'Na⁺', unit: 'mEq/L', min: 128, max: 148, step: 1 },
      { key: 'k', label: 'K⁺', unit: 'mEq/L', min: 3, max: 5.5, step: 0.1 },
      { key: 'cl', label: 'Cl⁻', unit: 'mEq/L', min: 92, max: 112, step: 1 },
      { key: 'hco3', label: 'HCO3⁻', unit: 'mEq/L', min: 10, max: 30, step: 1 },
    ],
    variants: [
      { id: 'noK', label: 'Na − (Cl + HCO3) (Egan’s; normal 4–12)', compute: (v) => n(v, 'na') - (n(v, 'cl') + n(v, 'hco3')) },
      { id: 'withK', label: '(Na + K) − (Cl + HCO3) (normal ~10–20)', compute: (v) => n(v, 'na') + n(v, 'k') - (n(v, 'cl') + n(v, 'hco3')) },
    ],
    tolerance: { abs: 0.6 },
    question: (v) => `Na⁺ ${v.na}, K⁺ ${v.k}, Cl⁻ ${v.cl}, HCO3⁻ ${v.hco3} mEq/L. What is the anion gap?`,
    steps: (v, variant) =>
      variant.id === 'withK'
        ? [`AG = (Na + K) − (Cl + HCO3)`, `(${v.na} + ${v.k}) − (${v.cl} + ${v.hco3}) = ${fmt(variant.compute(v), 1)} mEq/L (normal ~10–20)`]
        : [`AG = Na − (Cl + HCO3)`, `${v.na} − (${v.cl} + ${v.hco3}) = ${fmt(variant.compute(v), 0)} mEq/L (normal 4–12)`],
    source: 'Egan’s PDF p. 397',
    board: ['I.D'],
  },
  {
    id: 'oxygenation-index',
    name: 'Oxygenation index',
    concepts: ['oxygenation index', 'mean airway pressure'],
    unit: '',
    decimals: 1,
    inputs: [
      { key: 'mpaw', label: 'Mean airway pressure', unit: 'cmH2O', min: 8, max: 30, step: 1 },
      { key: 'fio2', label: 'FiO2', choices: [0.4, 0.5, 0.6, 0.8, 1.0] },
      { key: 'pao2', label: 'PaO2', unit: 'mmHg', min: 45, max: 120, step: 1 },
    ],
    variants: [{ id: 'standard', label: '(mean airway pressure × FiO2 × 100) ÷ PaO2', compute: (v) => (n(v, 'mpaw') * n(v, 'fio2') * 100) / n(v, 'pao2') }],
    tolerance: { rel: 0.02, abs: 0.2 },
    question: (v) => `Mean airway pressure ${v.mpaw} cmH2O, FiO2 ${v.fio2}, PaO2 ${v.pao2} mmHg. What is the oxygenation index?`,
    steps: (v) => [`OI = (mean airway pressure × FiO2 × 100) ÷ PaO2`, `(${v.mpaw} × ${v.fio2} × 100) ÷ ${v.pao2} = ${fmt(((n(v, 'mpaw') * n(v, 'fio2') * 100) / n(v, 'pao2')), 1)}`],
    board: ['I.C'],
  },
  {
    id: 'mean-arterial-pressure',
    name: 'Mean arterial pressure',
    concepts: ['mean arterial pressure', 'blood pressure', 'vital signs'],
    unit: 'mmHg',
    decimals: 0,
    inputs: [
      { key: 'sbp', label: 'Systolic', unit: 'mmHg', min: 90, max: 180, step: 2 },
      { key: 'dbp', label: 'Diastolic', unit: 'mmHg', min: 50, max: 100, step: 2 },
    ],
    variants: [{ id: 'standard', label: '(SBP + 2 × DBP) ÷ 3', compute: (v) => (n(v, 'sbp') + 2 * n(v, 'dbp')) / 3 }],
    tolerance: { abs: 1 },
    valid: (v) => n(v, 'sbp') - n(v, 'dbp') >= 20,
    question: (v) => `Blood pressure is ${v.sbp}/${v.dbp} mmHg. What is the mean arterial pressure?`,
    steps: (v) => [`MAP = (SBP + 2 × DBP) ÷ 3`, `(${v.sbp} + 2 × ${v.dbp}) ÷ 3 = ${fmt((n(v, 'sbp') + 2 * n(v, 'dbp')) / 3, 0)} mmHg`],
    interpret: (a) => (a < 65 ? 'Below 65: inadequate organ perfusion is likely.' : null),
    board: ['I.A', 'I.B'],
  },
];

// ---------------------------------------------------------------------------

/** Deterministic PRNG so a problem can be re-created from its seed. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function generate(formula: Formula, seed: number): Values {
  const rand = rng(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    const v: Values = {};
    for (const input of formula.inputs) {
      if (input.choices) v[input.key] = input.choices[Math.floor(rand() * input.choices.length)];
      else {
        const steps = Math.round((input.max! - input.min!) / input.step!);
        v[input.key] = r(input.min! + Math.floor(rand() * (steps + 1)) * input.step!, 3);
      }
    }
    if (!formula.valid || formula.valid(v)) return v;
  }
  throw new Error(`Could not generate a valid problem for ${formula.id}`);
}

export interface Graded {
  correct: boolean;
  expected: number;
  matched: Variant | null;
  primary: Variant;
}

/** Correct if the answer matches ANY accepted method within tolerance. */
export function grade(formula: Formula, v: Values, answer: number): Graded {
  const primary = formula.variants[0];
  for (const variant of formula.variants) {
    const expected = variant.compute(v);
    const tol = Math.max(formula.tolerance.abs ?? 0, Math.abs(expected) * (formula.tolerance.rel ?? 0));
    if (Math.abs(answer - expected) <= tol + 1e-9) return { correct: true, expected: r(expected, formula.decimals), matched: variant, primary };
  }
  return { correct: false, expected: r(primary.compute(v), formula.decimals), matched: null, primary };
}

export function formulaById(id: string): Formula | undefined {
  return FORMULAS.find((f) => f.id === id);
}
