/** Half-open time range in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

export interface SchedTask {
  id: number;
  title: string;
  course: string | null;
  dueMs: number;
  /** minutes of work still to schedule (learned multiplier applied, tracked time subtracted) */
  minutes: number;
  weight: number | null;
  /** exam-type task: uses the exam prep rules when it is big enough to be spread over days */
  isExam?: boolean;
  /** the task may not start before this instant (start of its available_from local day) */
  availableMs?: number;
}

export interface PlanBlock {
  taskId: number;
  start: number;
  end: number;
  /** 1-based position among this task's blocks, and how many it has */
  part: number;
  parts: number;
  /** block is longer than the work needed because of the minimum block length */
  padded: boolean;
  /** early placement only: this block pushed its day past the soft daily work cap because the work would not fit otherwise */
  overCap?: boolean;
  /** a block you pinned by hand: fixed, never moved by the planner */
  pinned?: boolean;
  pinId?: number;
}

export interface PlanProblem {
  taskId: number;
  kind: 'partial' | 'unplaced';
  placedMinutes: number;
  neededMinutes: number;
  reason: string;
}

export interface PlanResult {
  blocks: PlanBlock[];
  problems: PlanProblem[];
}
