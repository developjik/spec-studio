import { useState, type FormEvent } from 'react';
import type { RunRecord } from '@spec-studio/protocol';
import type { RunLogLineView } from '../model/daemon';
import {
  canAnswer,
  canCancel,
  canResume,
  eventSummary,
  questionOf,
  runLabel,
} from '../model/runview';

/**
 * The run surface (E3 W2 · AC-9): the project's runs, the active one's
 * streamed journal, and the three person commands. What the panel offers is
 * exactly what the run's state allows — the answer field renders only under
 * `needs_input` (A1), cancel only while the run lives, resume only behind a
 * restart flag. Buttons hide, they don't just disable: a gated-out control
 * is a lie about what the run accepts.
 */

interface RunPanelProps {
  runs: RunRecord[];
  activeId: string | null;
  /** The active run's journal — snapshot plus every streamed delta. */
  log: RunLogLineView[];
  /** Which provider/model a new turn would use; null until status arrives. */
  modelLabel: string | null;
  busy: boolean;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onAnswer: (runId: string, text: string) => void;
}

export function RunPanel(props: RunPanelProps) {
  const { runs, log, modelLabel, busy } = props;
  const active = runs.find((run) => run.id === props.activeId) ?? runs.at(-1) ?? null;
  const [answer, setAnswer] = useState('');

  const submitAnswer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (active === null || !canAnswer(active)) return; // A1, belt and braces
    const trimmed = answer.trim();
    if (trimmed === '') return;
    props.onAnswer(active.id, trimmed);
    setAnswer('');
  };

  const question = active !== null && active.state === 'needs_input' ? questionOf(log) : null;

  return (
    <section className="run-panel" aria-label="에이전트 런" data-testid="run-panel">
      <div className="panel-head">
        <span className="panel-title">
          <h2>에이전트 런</h2>
          <span className="panel-count">{runs.length}</span>
        </span>
        {modelLabel !== null && (
          <span className="run-model" title="다음 모델 호출이 쓰는 프로바이더·모델">
            {modelLabel}
          </span>
        )}
      </div>

      {runs.length > 1 && (
        <ul className="run-list">
          {[...runs].reverse().map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className={`run-row${run.id === active?.id ? ' is-active' : ''}`}
                onClick={() => props.onSelect(run.id)}
                data-testid="run-row"
                data-id={run.id}
              >
                <span className={`run-state run-state--${run.state}`}>
                  {runLabel(run)}
                </span>
                <span className="run-task">{run.taskId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {active === null ? (
        <p className="run-empty">아직 런이 없습니다. 인박스 아이디어에서 에이전트 런을 시작하세요.</p>
      ) : (
        <div className="run-detail" data-id={active.id}>
          <div className="run-statusline">
            <span
              className={`run-state run-state--${active.state}`}
              data-testid="run-state"
              data-state={active.state}
            >
              {runLabel(active)}
            </span>
            <span className="run-meta mono">
              {active.id} · {active.agent} · {active.taskId}
            </span>
            {active.interrupted && (
              <span className="run-flag" data-testid="run-interrupted">
                재시작됨 — run.resume 가능
              </span>
            )}
          </div>

          <div className="run-log" data-testid="run-log">
            {log.length === 0 ? (
              <p className="run-log-empty">런 저널이 아직 비어 있습니다.</p>
            ) : (
              log.map((entry, index) => {
                if (entry.stream === 'event') {
                  const summary = eventSummary(entry.line);
                  return summary === null ? null : (
                    <p key={index} className="run-log-event">
                      {summary}
                    </p>
                  );
                }
                return (
                  <p key={index} className={`run-log-line run-log-line--${entry.stream}`}>
                    {entry.line}
                  </p>
                );
              })
            )}
          </div>

          {active.state === 'review' && (
            <p className="run-hint" data-testid="run-review-hint">
              결정카드가 리서치 문서의 제안으로 올라와 있습니다. 채택·반려는 문서 패널에서 결정합니다.
            </p>
          )}

          {canAnswer(active) && (
            <form className="run-answer" onSubmit={submitAnswer} data-testid="run-answer">
              {question !== null && (
                <p className="run-question" data-testid="run-question">
                  {question}
                </p>
              )}
              <textarea
                className="textarea"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="런이 물은 것에 답하세요…"
                rows={2}
                data-testid="run-answer-input"
              />
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={busy || answer.trim() === ''}
                data-testid="run-answer-submit"
              >
                답변 보내기
              </button>
            </form>
          )}

          <div className="run-actions">
            {canCancel(active) && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy}
                onClick={() => props.onCancel(active.id)}
                data-testid="run-cancel"
              >
                즉시 중단
              </button>
            )}
            {canResume(active) && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy}
                onClick={() => props.onResume(active.id)}
                data-testid="run-resume"
              >
                재개
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
