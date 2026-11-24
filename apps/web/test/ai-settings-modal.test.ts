import { describe, expect, it, vi } from 'vitest';
import { subscribeToEscapeKey } from '../src/components/AiSettingsModal';

function keydown(key: string): Event {
  return Object.assign(new Event('keydown'), { key });
}

describe('subscribeToEscapeKey', () => {
  it('closes on Escape, ignores other keys, and removes the listener', () => {
    const target = new EventTarget();
    const onClose = vi.fn();
    const unsubscribe = subscribeToEscapeKey(target, onClose);

    target.dispatchEvent(keydown('Enter'));
    expect(onClose).not.toHaveBeenCalled();

    target.dispatchEvent(keydown('Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);

    unsubscribe();
    target.dispatchEvent(keydown('Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
