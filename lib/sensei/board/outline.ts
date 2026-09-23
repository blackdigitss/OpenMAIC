/**
 * NBRC Respiratory Therapy (RT) Examination — Detailed Content Outline, effective
 * January 2027 (replaces TMC + CSE). Source:
 * https://www.nbrc.org/wp-content/uploads/2025/10/NBRC-RT-Detailed-Content-Outline-January-2027.pdf
 * 160 scored items: Portion A "Breadth of Knowledge" (100) + Portion B "Depth of
 * Clinical Judgment" (60, all application/analysis). Item counts are per exam form.
 */

export interface BoardTask {
  code: string; // e.g. "I.C"
  section: 'I' | 'II' | 'III';
  title: string;
  items: number;
  /** What belongs here — guidance for tagging. */
  covers: string;
}

export const OUTLINE_SOURCE = {
  name: 'NBRC RT Examination Detailed Content Outline (effective January 2027)',
  url: 'https://www.nbrc.org/wp-content/uploads/2025/10/NBRC-RT-Detailed-Content-Outline-January-2027.pdf',
};

export const SECTIONS: { code: 'I' | 'II' | 'III'; title: string; items: number }[] = [
  { code: 'I', title: 'Patient Data', items: 25 },
  { code: 'II', title: 'Devices and Patient Safety', items: 25 },
  { code: 'III', title: 'Initiating and Modifying Interventions', items: 50 },
];

export const TASKS: BoardTask[] = [
  { code: 'I.A', section: 'I', title: 'Evaluate data in the patient record', items: 3, covers: 'history, labs, PFT, imaging/ECG results, perinatal history, sleep studies, trends in vitals, hemodynamics, fluid balance, ventilator liberation parameters, pulmonary mechanics, noninvasive monitoring' },
  { code: 'I.B', section: 'I', title: 'Perform clinical assessment', items: 6, covers: 'interview and inspection (appearance, mental status, pain, dyspnea, sputum, vaping, occupational exposure, airway/Mallampati, neonatal findings, skin), palpation, auscultation, chest radiograph interpretation, social determinants of health, learning needs' },
  { code: 'I.C', section: 'I', title: 'Perform procedures to gather clinical information', items: 5, covers: 'ECG, pulse oximetry and other noninvasive monitoring, spontaneous mechanics, ABG/CO-oximetry, calculations (A–a gradient, VD/VT, P/F, OI, SpO2/FiO2), compliance/resistance, plateau pressure, auto-PEEP, SBT, oxygen titration, spirometry, DLCO, lung volumes, MIP/MEP, 6-minute walk, sputum induction' },
  { code: 'I.D', section: 'I', title: 'Evaluate procedure results', items: 7, covers: 'interpreting the results of the procedures above: ABGs, oximetry, spirometry and PFTs, mechanics, peak flow, hemodynamic values, sputum characteristics' },
  { code: 'I.E', section: 'I', title: 'Recommend diagnostic procedures', items: 4, covers: 'recommending TB testing, labs, imaging, bronchoscopy/BAL, PFTs, ABGs, ECG, exhaled gas analysis, hemodynamic monitoring, sleep studies, thoracentesis' },
  { code: 'II.A', section: 'II', title: 'Troubleshoot devices during and after assembly', items: 19, covers: 'oxygen administration devices and gas delivery systems (cylinders, regulators, flowmeters, liquid oxygen, concentrators, blenders), heated high-flow, CPAP/NIV, humidifiers, nebulizers and inhalers, resuscitation devices, ventilators and circuits, artificial airways, suction, blood gas analyzers, hyperinflation and secretion clearance devices, heliox/iNO delivery, spirometers, chest drainage, monitors, bronchoscopes, hemodynamic transducers' },
  { code: 'II.B', section: 'II', title: 'Infection prevention, safety, and quality', items: 6, covers: 'infection control and isolation, disinfection and sterilization, biohazards, patient and equipment safety, gas safety, quality control of analyzers and equipment, ventilator-associated event prevention' },
  { code: 'III.A', section: 'III', title: 'Maintain a patent airway and care for artificial airways', items: 6, covers: 'airway positioning, adjuncts, intubation and extubation, tube position and cuff care, tracheostomy care, humidification of the airway' },
  { code: 'III.B', section: 'III', title: 'Airway clearance and lung expansion', items: 4, covers: 'secretion clearance techniques, suctioning, incentive spirometry, hyperinflation therapy, PEP devices, chest physiotherapy' },
  { code: 'III.C', section: 'III', title: 'Support oxygenation and ventilation', items: 10, covers: 'oxygen therapy and device selection, FiO2 titration, heated high-flow, CPAP, invasive and noninvasive ventilation settings, high-frequency ventilation, alarms, dyssynchrony, ventilator graphics, recruitment, liberation from ventilation' },
  { code: 'III.D', section: 'III', title: 'Administer medications and specialty gases', items: 3, covers: 'aerosolized and inhaled medications, delivery devices, heliox, inhaled nitric oxide, other specialty gases' },
  { code: 'III.E', section: 'III', title: 'Make or recommend changes to the care plan', items: 10, covers: 'recommending changes to therapy and ventilator settings based on patient response, pharmacology (bronchodilators, steroids, biologics, CFTR modulators, antimicrobials), treatment termination and escalation' },
  { code: 'III.F', section: 'III', title: 'Use evidence-based practice', items: 3, covers: 'protocols, disease severity classification, clinical practice guidelines (ARDS, asthma, COPD, CF, brain death)' },
  { code: 'III.G', section: 'III', title: 'Care in high-risk situations', items: 5, covers: 'emergencies other than CPR, neonatal resuscitation, disasters, rapid response/medical emergency team, closed-loop communication, patient transport, debriefing' },
  { code: 'III.H', section: 'III', title: 'Assist a provider with procedures', items: 4, covers: 'intubation, bronchoscopy, thoracentesis, chest tube insertion, tracheostomy, cardioversion, arterial and central line placement' },
  { code: 'III.I', section: 'III', title: 'Interact with the team, patients, and families', items: 5, covers: 'handoffs, escalating concerns, communication, trauma-informed and culturally aware care, patient and family education, ethics, pulmonary rehabilitation, disease management' },
];

export const TASK_CODES = TASKS.map((t) => t.code) as [string, ...string[]];

/** Portion B — clinical judgment scenarios, by patient condition (items per form). */
export const CONDITIONS: { code: string; group: 'Adults' | 'Children'; title: string; items: number }[] = [
  { code: 'B.A.A', group: 'Adults', title: 'Chronic lung disease', items: 17 },
  { code: 'B.A.B', group: 'Adults', title: 'Trauma', items: 4 },
  { code: 'B.A.C', group: 'Adults', title: 'Cardiovascular', items: 5 },
  { code: 'B.A.D', group: 'Adults', title: 'Neurological or neuromuscular', items: 4 },
  { code: 'B.A.E', group: 'Adults', title: 'Medical (infection, ARDS, other)', items: 15 },
  { code: 'B.A.F', group: 'Adults', title: 'Pre- and post-operative care', items: 5 },
  { code: 'B.C.A', group: 'Children', title: 'Pediatric', items: 4 },
  { code: 'B.C.B', group: 'Children', title: 'Neonatal', items: 6 },
];
