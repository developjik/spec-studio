import { useEffect, useRef, useState } from 'react';
import type { Anchor, Command, Pin, Project } from '@spec-studio/protocol';
import type { PinFilter } from '@spec-studio/core';
import type { PinDraftInput } from '../components/PinComposer';
import type { PinEditInput } from '../components/PinEditor';
import type { ApplyResult } from '../model/appUtils';

/**
 * 캔버스/핀 영역: selection, the draft anchor a click drops, the drag veil,
 * and every pin command the stage and panel fire — plus the paste/drop
 * listeners that turn an image file into the screen's attach flow (the App
 * hands the real handler in through `fileHandler` each render).
 */
export function useCanvasPins({
  project,
  applyCommand,
}: {
  project: Project | null;
  applyCommand: (command: Command) => Promise<ApplyResult | null>;
}) {
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PinFilter>('all');
  const [draftAnchor, setDraftAnchor] = useState<Anchor | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileHandler = useRef<(file: File) => void>(() => undefined);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file !== null) {
            event.preventDefault();
            fileHandler.current(file);
          }
          return;
        }
      }
    };

    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files') === true) {
        event.preventDefault();
        setDragging(true);
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file !== undefined) fileHandler.current(file);
    };

    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const savePin = async (input: PinDraftInput) => {
    const screen = project?.screen ?? null;
    if (screen === null || draftAnchor === null) return;
    const result = await applyCommand({
      type: 'pin.create',
      screenId: screen.id,
      pinType: input.pinType,
      title: input.title,
      body: input.body,
      anchor: draftAnchor,
    });
    if (result === null) return;
    const created = result.events.find((event) => event.type === 'pin.created');
    if (created !== undefined && created.type === 'pin.created') {
      setSelectedPinId(created.pin.id);
    }
    setDraftAnchor(null);
    setFilter('all');
  };

  const deletePin = async (pin: Pin) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    const result = await applyCommand({ type: 'pin.delete', screenId: screen.id, pinId: pin.id });
    if (result !== null && selectedPinId === pin.id) setSelectedPinId(null);
  };

  /** Editing a pin's type, title or body — the number is not in the command. */
  const updatePin = (pinId: string, input: PinEditInput) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    void applyCommand({
      type: 'pin.update',
      screenId: screen.id,
      pinId,
      pinType: input.pinType,
      title: input.title,
      body: input.body,
    });
  };

  /** A drag on the image: same command, only the anchor changes. */
  const movePin = (pinId: string, anchor: Anchor) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    void applyCommand({ type: 'pin.update', screenId: screen.id, pinId, anchor });
  };

  const saveFigmaUrl = (url: string | null) => {
    const screen = project?.screen ?? null;
    if (screen === null) return;
    void applyCommand({ type: 'screen.update', screenId: screen.id, figmaUrl: url });
  };

  return {
    selectedPinId,
    setSelectedPinId,
    filter,
    setFilter,
    draftAnchor,
    setDraftAnchor,
    dragging,
    fileHandler,
    savePin,
    deletePin,
    updatePin,
    movePin,
    saveFigmaUrl,
  };
}
