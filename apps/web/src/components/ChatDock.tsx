import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { RunRecord } from '@spec-studio/protocol';
import type { RunLogLineView } from '../model/daemon';
import { surfaceProps } from '../model/surfaces';
import { RunPanel } from './RunPanel';

/**
 * The F2 input layer (E4 §3 F2 · U-2 점진 재배치): "올리고, 대화로 시작"
 * sits above the unchanged easy-mode workshop. The dock is an input layer
 * only (DG-2) — the text box issues `idea.capture` + `run.start` through the
 * same command path the inbox uses, the upload routes to the same screen
 * attach, and the run's needs_input answer field below is the chat skeleton
 * the conversation continues through. Nothing typed here is a write until
 * the person sends it.
 */
interface ChatDockProps {
  sqliteMode: boolean;
  busy: boolean;
  runs: RunRecord[];
  activeId: string | null;
  log: RunLogLineView[];
  modelLabel: string | null;
  onSubmit: (text: string) => void;
  onUpload: (file: File) => void;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onAnswer: (runId: string, text: string) => void;
}

export function ChatDock(props: ChatDockProps) {
  const { sqliteMode, busy, runs } = props;
  const [text, setText] = useState('');

  const send = () => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    props.onSubmit(trimmed);
    setText('');
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  /** Chat convention: Enter sends, Shift+Enter keeps the line break. */
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    <section
      className="chat-dock"
      aria-label="대화로 시작"
      data-testid="chat-dock"
      {...surfaceProps('chatDock')}
    >
      <form className="chat-form" onSubmit={submit} data-testid="chat-form">
        <label
          className="btn chat-upload"
          title="스크린샷 이미지를 올려 이 화면으로 등록합니다"
          data-testid="chat-upload"
        >
          올리기
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onUpload(file);
              event.target.value = '';
            }}
          />
        </label>
        <textarea
          className="chat-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={sendOnEnter}
          placeholder="무엇을 기획할지 한 문장으로 적어 보세요 — 저장하면 대화가 시작됩니다"
          rows={1}
          disabled={busy}
          data-testid="chat-input"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || text.trim() === ''}
          data-testid="chat-submit"
        >
          대화 시작
        </button>
      </form>
      {!sqliteMode && (
        <p className="chat-note" data-testid="chat-offline-note">
          입력한 문장은 아이디어로 저장됩니다 — 대화로 이어지려면 이 컴퓨터 저장소(로컬 데몬)
          연결이 필요합니다.
        </p>
      )}
      {sqliteMode && runs.length > 0 && (
        <RunPanel
          runs={runs}
          activeId={props.activeId}
          log={props.log}
          modelLabel={props.modelLabel}
          busy={busy}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
          onResume={props.onResume}
          onAnswer={props.onAnswer}
        />
      )}
    </section>
  );
}
