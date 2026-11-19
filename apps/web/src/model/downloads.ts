export interface DownloadFile {
  fileName: string;
  blob: Blob;
}

/**
 * One anchor click per file. Browsers allow a short burst of downloads from a
 * user gesture; the small gap keeps the second and third from being treated as
 * a popup.
 */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(fileName: string, text: string, mime: string): void {
  downloadBlob(fileName, new Blob([text], { type: mime }));
}

export async function downloadMany(files: readonly DownloadFile[], gapMs = 180): Promise<void> {
  for (const [index, file] of files.entries()) {
    if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, gapMs));
    downloadBlob(file.fileName, file.blob);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
