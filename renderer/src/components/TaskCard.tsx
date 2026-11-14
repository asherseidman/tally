import { api } from '../api';
import { errText, fmtMinutes, useApp } from '../ctx';
import { Icon, courseClass, shortDate } from '../ui';
import type { TaskDto, TimerStatus } from '../../../src/app/types';

/** One task in a view: done checkbox, title (opens the detail), course chip, due (marked when the time was assumed or it is overdue), estimate, weight, reason, timer. */
export function TaskCard({ task, reason, timers, onTimer }: { task: TaskDto; reason?: string; timers: TimerStatus[]; onTimer: (t: TimerStatus[]) => void }) {
  const { openTask, changed, toast } = useApp();
  const running = timers.some((t) => t.taskId === task.id);
  const overdue = !!task.due && task.status !== 'done' && Date.parse(task.due) < Date.now();
  const fail = (e: unknown) => toast(errText(e));
  return (
    <li className={`card ${task.status === 'done' ? 'done' : ''}`}>
      <input
        className="check" type="checkbox" aria-label={`Mark "${task.title}" done`} checked={task.status === 'done'}
        onChange={() => (task.status === 'done' ? api.undone(task.id) : api.done(task.id)).then(changed).catch(fail)}
      />
      <div className="card-body">
        <div className="card-title">
          <button className="link-title" onClick={() => openTask(task.id)}>{task.title}</button>
          {task.course && <span className={`chip ${courseClass(task.course)}`}>{task.course}</span>}
          {overdue && <span className="badge overdue">Overdue</span>}
        </div>
        <div className="card-meta">
          {task.due
            ? <span className={`meta ${overdue ? 'overdue' : ''}`} title={task.timeAssumed ? 'No time was given; the default time is assumed' : undefined}>{Icon.clock(13)}<time dateTime={task.due}>{shortDate(task.dueText)}{task.timeAssumed ? ' *' : ''}</time></span>
            : <span className="meta">no due date</span>}
          {task.estimate != null && <span className="meta" title="Estimated work">{Icon.hourglass(13)}{fmtMinutes(task.estimate)}</span>}
          {task.gradeWeight != null && <span className="meta" title="Share of the course grade">{Icon.weight(13)}{task.gradeWeight}%</span>}
        </div>
        {reason && <div className="reason">{reason}</div>}
      </div>
      <button
        className={`timer-btn ${running ? 'on' : ''}`} title={running ? 'Stop the timer' : 'Start a timer on this task'} aria-label={`${running ? 'Stop' : 'Start'} timer: ${task.title}`}
        onClick={() => (running ? api.timerStop().then((r) => { onTimer(r.timers); toast(`Logged ${r.stopped[0]?.minutes ?? 0} min`); changed(); }) : api.timerStart(task.id).then(onTimer)).catch(fail)}
      >{running ? Icon.stop() : Icon.play()}<span>{running ? 'Stop' : 'Start'}</span></button>
    </li>
  );
}
