import { describe, it, expect } from 'vitest';
import { eventTitle } from '../src/schedule/eventTitle';

const t = (o: any) => ({ course: 'EECS 183', title: 'Lab 8', isExam: false, ...o });
describe('eventTitle', () => {
  it('course, colon, task title', () => expect(eventTitle(t({ title: 'Lecture 22 zyBooks' }))).toBe('EECS 183: Lecture 22 zyBooks'));
  it('exam tasks say Prep, and the part numbering stays at the end', () => {
    expect(eventTitle(t({ title: 'Exam 2', isExam: true }))).toBe('EECS 183: Exam 2 Prep');
    expect(eventTitle(t({ title: 'Exam 2', isExam: true, part: 1, parts: 4 }))).toBe('EECS 183: Exam 2 Prep (1/4)');
    expect(eventTitle(t({ course: 'MATH 214', title: 'Midterm Exam 2', isExam: true, part: 2, parts: 2 }))).toBe('MATH 214: Midterm Exam 2 Prep (2/2)');
  });
  it('does not add Prep twice', () => {
    expect(eventTitle(t({ title: 'Exam 2 Prep', isExam: true }))).toBe('EECS 183: Exam 2 Prep');
    expect(eventTitle(t({ title: 'Exam 2 prep session', isExam: true, part: 1, parts: 2 }))).toBe('EECS 183: Exam 2 prep session (1/2)');
  });
  it('leaves non-exam tasks alone, even ones named like exams', () => {
    expect(eventTitle(t({ title: 'Exam 2 review sheet' }))).toBe('EECS 183: Exam 2 review sheet');
    expect(eventTitle(t({ title: 'Final Project Core Due', part: 3, parts: 5 }))).toBe('EECS 183: Final Project Core Due (3/5)');
  });
  it('a task with no course has no prefix', () => {
    expect(eventTitle(t({ course: null, title: 'Email advisor' }))).toBe('Email advisor');
    expect(eventTitle(t({ course: '  ', title: 'Exam', isExam: true }))).toBe('Exam Prep');
    expect(eventTitle(t({ course: null, title: 'Study', part: 1, parts: 2 }))).toBe('Study (1/2)');
  });
  it('the exam itself (blocked window) uses the same course rule without Prep', () => {
    expect(eventTitle(t({ title: 'Exam 2', isExam: true }), { prep: false })).toBe('EECS 183: Exam 2');
  });
});
