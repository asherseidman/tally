export interface TitleInput {
  course: string | null;
  title: string;
  isExam: boolean;
  part?: number;
  parts?: number;
}

/**
 * The title of a Planner Blocks event: "<COURSE>: <task title>". Exam tasks say "Prep" (their blocks are study
 * time, not the exam), unless the title already does. Part numbers go last: "EECS 183: Exam 2 Prep (1/4)".
 * Display only; stored task titles are never changed. `prep: false` is for the exam itself (the blocked window).
 */
export function eventTitle(t: TitleInput, opts: { prep?: boolean } = {}): string {
  const wantPrep = (opts.prep ?? true) && t.isExam;
  const base = t.title.trim();
  const named = wantPrep && !/\bprep\b/i.test(base) ? `${base} Prep` : base;
  const course = t.course?.trim();
  const full = course ? `${course}: ${named}` : named;
  return t.parts && t.parts > 1 ? `${full} (${t.part}/${t.parts})` : full;
}
