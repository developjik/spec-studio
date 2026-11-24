import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export function SubscriptionNotice() {
  const [mountPoint, setMountPoint] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const syncMountPoint = () => {
      const modal = document.querySelector<HTMLElement>('.ai-modal');
      const tabs = modal?.querySelector<HTMLElement>('.modal-tabs--2');
      if (modal === null || tabs === null || tabs === undefined) {
        setMountPoint(null);
        return;
      }

      let mount = modal.querySelector<HTMLElement>('[data-testid="ai-subscription-note-root"]');
      if (mount === null) {
        mount = document.createElement('div');
        mount.dataset.testid = 'ai-subscription-note-root';
        tabs.insertAdjacentElement('afterend', mount);
      }
      setMountPoint(mount);
    };

    const observer = new MutationObserver(syncMountPoint);
    observer.observe(document.body, { childList: true, subtree: true });
    syncMountPoint();

    return () => {
      observer.disconnect();
      document
        .querySelectorAll('[data-testid="ai-subscription-note-root"]')
        .forEach((node) => node.remove());
    };
  }, []);

  if (mountPoint === null) return null;

  return createPortal(
    <p className="ai-note" data-testid="ai-subscription-note" role="note">
      구독(관리형 AI)은 준비 중입니다. 이용 가능해지기 전까지 직접 발급한 API 키나 로컬 서버를 이용하세요.
    </p>,
    mountPoint,
  );
}
