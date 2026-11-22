import { useEffect, useState } from 'react';
import type { Notice } from '../model/appUtils';

/**
 * 알림/오버레이 영역: the toast and the entry-gate error. Everything else in
 * the app reports through these two channels.
 */
export function useNotices() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return { notice, setNotice, gateError, setGateError };
}
