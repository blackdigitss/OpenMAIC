/**
 * Clinical-judgment practice in the style of the new NBRC RT Exam (single best answer,
 * "what should the RT do/recommend next"). Fully templated: numbers are generated and
 * the answer key is computed by code — no model is involved, so no invented clinical
 * facts and no wrong keys. Values near a decision boundary are never generated, so
 * exactly one option is defensible. Rules checked against Egan's 13e (pages noted).
 */
import { rng } from '../calc/formulas';

export interface CaseItem {
  family: string;
  stem: string;
  options: string[];
  answer: number;
  rationale: string[];
  /** NBRC tagging: Portion B condition, judgment type, setting; Portion A task. */
  condition: string;
  judgment: 'gather' | 'decide';
  setting: 'hospital' | 'outside';
  task: string;
}

export interface CaseFamily {
  id: string;
  name: string;
  /** Unlocked by these calculation formulas and/or taught concept keywords. */
  unlockFormulas?: string[];
  unlockConcepts?: string[];
  generate: (seed: number) => CaseItem;
}

const pick = <T,>(rand: () => number, xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const between = (rand: () => number, lo: number, hi: number, step = 1) => lo + Math.floor(rand() * (Math.round((hi - lo) / step) + 1)) * step;

/** Shuffle options deterministically; returns the new index of the correct one. */
function arrange(rand: () => number, correct: string, distractors: string[]): { options: string[]; answer: number } {
  const all = [correct, ...distractors.slice(0, 3)];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return { options: all, answer: all.indexOf(correct) };
}

const AGES = [34, 47, 52, 58, 63, 71, 76];

// ---------------------------------------------------------------------------

const transportCylinder: CaseFamily = {
  id: 'transport-cylinder',
  name: 'Oxygen for a transport',
  unlockFormulas: ['cylinder-duration'],
  generate(seed) {
    const rand = rng(seed);
    const flow = pick(rand, [2, 3, 4, 5, 6]);
    const trip = pick(rand, [30, 45, 60, 90]);
    // Only clearly sufficient (≥ 2× the trip, keeping a 500 psig reserve) or clearly not (< trip).
    // Pressures are computed from those thresholds, so the case is always unambiguous.
    const enoughAt = Math.ceil((500 + (2 * trip * flow) / 0.28) / 50) * 50; // lowest psig that is clearly enough
    const shortBelow = Math.floor((500 + (trip * flow) / 0.28) / 50) * 50; // psig below this runs out
    const enough = enoughAt <= 2200 && (shortBelow <= 700 || rand() < 0.5);
    const psig = enough ? between(rand, enoughAt, 2200, 50) : between(rand, 600, Math.min(2200, shortBelow - 50), 50);
    const minutes = Math.round(((psig - 500) * 0.28) / flow);
    const age = pick(rand, AGES);
    const stem = `A ${age}-year-old with COPD on a nasal cannula at ${flow} L/min needs to go to radiology. The trip, including waiting, should take about ${trip} minutes. The E cylinder on the stretcher reads ${psig} psig. What should the respiratory therapist do?`;
    const correct = enough ? 'Proceed with the current cylinder' : 'Replace it with a full E cylinder before leaving';
    const distractors = enough
      ? ['Lower the flow to 1 L/min to conserve oxygen', 'Transport the patient on room air', 'Replace it with a full E cylinder before leaving']
      : ['Proceed and lower the flow if the gauge drops', 'Transport the patient on room air', 'Proceed with the current cylinder'];
    const { options, answer } = arrange(rand, correct, distractors);
    return {
      family: this.id,
      stem,
      options,
      answer,
      rationale: [
        `Usable time, keeping a 500 psig reserve: (${psig} − 500) × 0.28 ÷ ${flow} ≈ ${minutes} minutes.`,
        enough ? `That is well over the ${trip}-minute trip, so the current cylinder is safe.` : `That is less than the ${trip}-minute trip, so the patient would run out: get a full cylinder first.`,
        'Never change the prescribed oxygen to stretch a cylinder, and never transport a patient who needs oxygen on room air.',
      ],
      condition: 'B.A.A',
      judgment: 'decide',
      setting: 'hospital',
      task: 'II.A',
    };
  },
};

const entrainmentDemand: CaseFamily = {
  id: 'entrainment-demand',
  name: 'Is the mask flow enough?',
  unlockFormulas: ['entrainment-total-flow'],
  generate(seed) {
    const rand = rng(seed);
    const ratios: Record<number, number> = { 28: 10, 35: 5, 40: 3, 50: 1.7 };
    const fio2 = pick(rand, [28, 35, 40, 50]);
    const adequate = rand() < 0.5;
    // Peak inspiratory flow ≈ 3 × VE; O2 flow is computed to sit clearly on one side (±20%).
    const parts = 1 + ratios[fio2];
    const ve = between(rand, 8, 16, 1);
    const minAdequate = Math.ceil((3 * ve * 1.2) / parts);
    const maxInadequate = Math.floor((3 * ve * 0.8) / parts);
    const canAdequate = minAdequate <= 15;
    const canInadequate = maxInadequate >= 2;
    const isAdequate = canAdequate && (!canInadequate || adequate);
    const o2 = isAdequate ? between(rand, minAdequate, 15) : between(rand, 2, maxInadequate);
    const total = o2 * parts;
    const age = pick(rand, AGES);
    const stem = `A ${age}-year-old with pneumonia is on a ${fio2}% air-entrainment mask running ${o2} L/min of oxygen. Respiratory rate is ${between(rand, 20, 30)}/min and minute ventilation is ${ve} L/min. What should the respiratory therapist do?`;
    const correct = isAdequate ? 'Continue the current settings' : 'Increase the oxygen flow to raise the total flow';
    const distractors = isAdequate
      ? ['Increase the oxygen flow to raise the total flow', `Increase the FiO2 setting above ${fio2}%`, 'Change to a simple mask at 5 L/min']
      : ['Continue the current settings', 'Decrease the oxygen flow', 'Change to a nasal cannula at 6 L/min'];
    const { options, answer } = arrange(rand, correct, distractors);
    return {
      family: this.id,
      stem,
      options,
      answer,
      rationale: [
        `At ${fio2}% the air:O2 ratio is about ${ratios[fio2]}:1, so total flow ≈ ${o2} × ${ratios[fio2] + 1} = ${Math.round(total)} L/min.`,
        `Estimated peak inspiratory demand ≈ 3 × VE = ${3 * ve} L/min.`,
        isAdequate ? 'Total flow exceeds demand, so the delivered FiO2 is stable. No change needed.' : 'Total flow is below demand, so the patient entrains room air and gets less than the set FiO2. Raise the oxygen flow (total flow rises with it).',
      ],
      condition: 'B.A.E',
      judgment: 'decide',
      setting: 'hospital',
      task: 'III.C',
    };
  },
};

const pfSeverity: CaseFamily = {
  id: 'pf-severity',
  name: 'ARDS severity from the P/F ratio',
  unlockFormulas: ['pf-ratio'],
  generate(seed) {
    const rand = rng(seed);
    // Berlin definition (Egan's PDF p. 665): mild 200–300, moderate 100–200, severe ≤100, with PEEP ≥5.
    const band = pick(rand, ['mild', 'moderate', 'severe', 'none'] as const);
    const target = { mild: [215, 285], moderate: [115, 185], severe: [50, 85], none: [320, 420] }[band];
    const fio2 = pick(rand, [0.4, 0.5, 0.6, 0.8, 1.0]);
    // PaO2 is derived from a P/F chosen well inside the band (≥15 from any cut-off).
    const pao2 = Math.round(between(rand, target[0], target[1]) * fio2);
    const pf = pao2 / fio2;
    const peep = pick(rand, [6, 8, 10, 12]);
    const stem = `An intubated adult has bilateral infiltrates on chest x-ray that are not explained by heart failure. On PEEP ${peep} cmH2O and FiO2 ${fio2}, the PaO2 is ${pao2} mmHg. How should this oxygenation be classified?`;
    const labels = { mild: 'Mild ARDS', moderate: 'Moderate ARDS', severe: 'Severe ARDS', none: 'Does not meet the ARDS oxygenation criterion' };
    const correct = labels[band];
    const { options, answer } = arrange(rand, correct, Object.values(labels).filter((l) => l !== correct));
    return {
      family: this.id,
      stem,
      options,
      answer,
      rationale: [
        `P/F = ${pao2} ÷ ${fio2} = ${Math.round(pf)}.`,
        'Berlin definition (with PEEP ≥ 5): mild 200–300, moderate 100–200, severe ≤ 100.',
        `So this is: ${correct.toLowerCase()}.`,
      ],
      condition: 'B.A.E',
      judgment: 'gather',
      setting: 'hospital',
      task: 'I.D',
    };
  },
};

const rsbiLiberation: CaseFamily = {
  id: 'rsbi-liberation',
  name: 'Ready to come off the ventilator?',
  unlockFormulas: ['rsbi'],
  generate(seed) {
    const rand = rng(seed);
    const good = rand() < 0.5;
    // Choose VT, then a rate that puts RSBI clearly below 80 or above 130.
    const vt = good ? between(rand, 350, 600, 10) : between(rand, 200, 300, 10);
    const f = good ? between(rand, 12, Math.floor((79 * vt) / 1000)) : between(rand, Math.ceil((131 * vt) / 1000), 42);
    const rsbi = Math.round(f / (vt / 1000));
    const stem = `During a spontaneous breathing trial, an adult recovering from pneumonia breathes ${f} times per minute with a tidal volume of ${vt} mL. SpO2 and hemodynamics are stable. What should the respiratory therapist recommend?`;
    const correct = good ? 'Proceed with evaluating the patient for extubation' : 'End the trial and return to the previous ventilator support';
    const distractors = good
      ? ['End the trial and return to the previous ventilator support', 'Increase the pressure support by 10 cmH2O', 'Obtain a chest radiograph before deciding']
      : ['Proceed with evaluating the patient for extubation', 'Extubate to a high-flow nasal cannula now', 'Continue the trial for another two hours'];
    const { options, answer } = arrange(rand, correct, distractors);
    return {
      family: this.id,
      stem,
      options,
      answer,
      rationale: [
        `RSBI = f ÷ VT (L) = ${f} ÷ ${vt / 1000} ≈ ${rsbi}.`,
        good ? 'Well under 105: rapid shallow breathing is not present, which predicts successful liberation.' : 'Well over 105: rapid shallow breathing predicts failure. Rest the patient and look for the cause.',
      ],
      condition: 'B.A.E',
      judgment: 'decide',
      setting: 'hospital',
      task: 'III.C',
    };
  },
};

// --- ABG interpretation (Egan's PDF p. 342: stepwise; pH 7.35–7.45, PaCO2 35–45, HCO3 22–26) ---

export type AbgPrimary = 'respiratory acidosis' | 'respiratory alkalosis' | 'metabolic acidosis' | 'metabolic alkalosis';
export type AbgComp = 'uncompensated' | 'partially compensated' | 'fully compensated';

/** Deterministic classifier used for the answer key (and tested against the generator). */
export function classifyAbg(ph: number, paco2: number, hco3: number): { primary: AbgPrimary; comp: AbgComp } | null {
  const acidSide = ph < 7.4;
  const resp = paco2 > 45 ? 'acid' : paco2 < 35 ? 'base' : 'normal';
  const met = hco3 < 22 ? 'acid' : hco3 > 26 ? 'base' : 'normal';
  const want = acidSide ? 'acid' : 'base';
  let primary: AbgPrimary | null = null;
  if (resp === want && met !== want) primary = acidSide ? 'respiratory acidosis' : 'respiratory alkalosis';
  else if (met === want && resp !== want) primary = acidSide ? 'metabolic acidosis' : 'metabolic alkalosis';
  if (!primary) return null; // mixed or normal: not generated
  const other = primary.startsWith('respiratory') ? met : resp;
  const inRange = ph >= 7.35 && ph <= 7.45;
  const comp: AbgComp = other === 'normal' ? 'uncompensated' : inRange ? 'fully compensated' : 'partially compensated';
  if (other !== 'normal' && other === want) return null;
  if (inRange && other === 'normal') return null;
  return { primary, comp };
}

const hh = (hco3: number, paco2: number) => 6.1 + Math.log10(hco3 / (0.03 * paco2));

const abgInterpretation: CaseFamily = {
  id: 'abg-interpretation',
  name: 'ABG interpretation',
  unlockConcepts: ['arterial blood gas', 'abg', 'acid base', 'acid base balance', 'respiratory acidosis', 'metabolic acidosis'],
  generate(seed) {
    const rand = rng(seed);
    const primary = pick(rand, ['respiratory acidosis', 'respiratory alkalosis', 'metabolic acidosis', 'metabolic alkalosis'] as AbgPrimary[]);
    const comp = pick(rand, ['uncompensated', 'partially compensated', 'fully compensated'] as AbgComp[]);
    let ph = 7.4;
    let paco2 = 40;
    let hco3 = 24;
    let found = false;
    for (let tries = 0; tries < 400; tries++) {
      const resp = primary.startsWith('respiratory');
      const acid = primary.endsWith('acidosis');
      // Primary component clearly abnormal; the other normal (uncompensated) or clearly compensating.
      if (resp) {
        paco2 = acid ? between(rand, 50, 75) : between(rand, 22, 31);
        hco3 = comp === 'uncompensated' ? between(rand, 23, 25) : acid ? between(rand, 28, 38) : between(rand, 14, 20);
      } else {
        hco3 = acid ? between(rand, 10, 19) : between(rand, 30, 42);
        paco2 = comp === 'uncompensated' ? between(rand, 37, 43) : acid ? between(rand, 20, 32) : between(rand, 48, 58);
      }
      ph = Math.round(hh(hco3, paco2) * 100) / 100;
      const inRange = ph >= 7.36 && ph <= 7.44;
      const clearlyOut = ph <= 7.32 || ph >= 7.48;
      if (comp === 'fully compensated' ? !inRange || ph === 7.4 : !clearlyOut) continue;
      const c = classifyAbg(ph, paco2, hco3);
      if (c && c.primary === primary && c.comp === comp) {
        found = true;
        break;
      }
    }
    if (!found) return this.generate(seed + 7919); // extremely rare: try a different seed
    const pao2 = between(rand, 70, 95);
    const correct = `${comp[0].toUpperCase()}${comp.slice(1)} ${primary}`;
    const label = (c: AbgComp, p: AbgPrimary) => `${c[0].toUpperCase()}${c.slice(1)} ${p}`;
    const counterpart = (primary.startsWith('respiratory') ? primary.replace('respiratory', 'metabolic') : primary.replace('metabolic', 'respiratory')) as AbgPrimary;
    // Near misses: the same disorder with the other two compensation states, and the other system.
    const distractors = [
      ...(['uncompensated', 'partially compensated', 'fully compensated'] as AbgComp[]).filter((c) => c !== comp).map((c) => label(c, primary)),
      label(comp, counterpart),
    ];
    const { options, answer } = arrange(rand, correct, distractors);
    return {
      family: this.id,
      stem: `An adult's arterial blood gas on room air: pH ${ph.toFixed(2)}, PaCO2 ${paco2} mmHg, HCO3⁻ ${hco3} mEq/L, PaO2 ${pao2} mmHg. How should this be interpreted?`,
      options,
      answer,
      rationale: [
        `pH ${ph.toFixed(2)}: ${ph < 7.35 ? 'acidemia' : ph > 7.45 ? 'alkalemia' : `within 7.35–7.45, on the ${ph < 7.4 ? 'acid' : 'alkaline'} side`}.`,
        `PaCO2 ${paco2} (35–45) and HCO3⁻ ${hco3} (22–26): the ${primary.startsWith('respiratory') ? 'PaCO2' : 'HCO3⁻'} explains the pH, so it's a ${primary}.`,
        comp === 'uncompensated' ? 'The other value is normal: uncompensated.' : comp === 'partially compensated' ? 'The other value moved to oppose it, but the pH is still abnormal: partially compensated.' : 'The other value opposes it and the pH is back in range: fully compensated.',
      ],
      condition: 'B.A.E',
      judgment: 'gather',
      setting: 'hospital',
      task: 'I.D',
    };
  },
};

export const CASE_FAMILIES: CaseFamily[] = [transportCylinder, entrainmentDemand, pfSeverity, rsbiLiberation, abgInterpretation];

export function familyById(id: string): CaseFamily | undefined {
  return CASE_FAMILIES.find((f) => f.id === id);
}
