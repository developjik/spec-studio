import { useState } from 'react';
import { bootUiMode, saveUiMode, type UiMode } from '../model/settings';

/**
 * 모드 영역 (E4 F1): the easy/pro preference, persisted as a local setting —
 * switching writes `spec-studio.settings.v1` and nothing else. No command, no
 * op_log row: the mode is presentation state, not graph state (DG-2, A2).
 */
export function useUiMode() {
  const [mode, setMode] = useState<UiMode>(() => bootUiMode());

  const switchMode = (next: UiMode) => {
    if (next === mode) return;
    saveUiMode(next);
    setMode(next);
  };

  /** The one-click switch in the top bar (U-3). */
  const toggleMode = () => switchMode(mode === 'easy' ? 'pro' : 'easy');

  return { mode, switchMode, toggleMode };
}
