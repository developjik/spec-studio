import { contextBridge, ipcRenderer } from 'electron';

/**
 * The whole desktop surface: one synchronous read at boot (where the daemon
 * listens, the token that opens it — null in browser-fallback mode) plus the
 * F2 quick-capture ping. The renderer optional-chains every member, so a null
 * daemon answer still leaves the chord working.
 */

export interface DaemonInfo {
  daemonUrl: string;
  daemonToken: string;
  desktopVersion: string;
}

const info = ipcRenderer.sendSync('specstudio:info') as DaemonInfo | null;

contextBridge.exposeInMainWorld('specstudio', {
  getDaemonInfo: (): DaemonInfo | null => info,
  /** Main fires this on the global shortcut; the callback opens the modal. */
  onQuickCapture: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on('specstudio:quick-capture', listener);
    return () => {
      ipcRenderer.removeListener('specstudio:quick-capture', listener);
    };
  },
});
