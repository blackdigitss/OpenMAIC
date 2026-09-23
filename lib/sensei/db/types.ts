/** Minimal query surface shared by node-postgres (Pool/PoolClient) and PGlite. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const CONCEPT_KINDS = [
  'term', 'disease', 'drug', 'device', 'formula', 'procedure', 'anatomy', 'physiology',
  'lab_value', 'theme',
] as const;
export type ConceptKind = (typeof CONCEPT_KINDS)[number];

export const RECORD_TYPES = [
  'definition', 'mechanism', 'clinical', 'formula', 'calculation', 'relationship', 'anecdote',
  'emphasis', 'exam_hint', 'misconception', 'analogy', 'backref', 'foreshadow', 'detail',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const RELATION_TYPES = [
  'prerequisite_of', 'related_to', 'causes', 'affects', 'measured_by', 'applied_in',
  'extends', 'contradicts', 'confused_with',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number] | 'possible_duplicate';

export type SourceKind = 'slides' | 'audio' | 'transcript' | 'handout' | 'textbook';

export interface SourceUnitInput {
  kind: 'page' | 'segment';
  ordinal: number;
  pageNo?: number | null;
  startMs?: number | null;
  endMs?: number | null;
  speaker?: string | null;
  slideNo?: number | null;
  text: string;
  uncertainTerms?: string[];
}

export interface SourceUnit extends SourceUnitInput {
  id: string;
  sourceId: string;
}
