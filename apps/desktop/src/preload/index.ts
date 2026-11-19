import { contextBridge, ipcRenderer } from 'electron';

/**
 * The whole desktop surface, kept to one synchronous read at boot: where the
 * daemon listens and the token that opens it. The renderer treats absence of
 * `window.specstudio` as "running in a plain browser" and changes nothing else.
 */

export interface DaemonInfo {
  daemonUrl: string;
  daemonToken: string;
  desktopVersion: string;
}

const info = ipcRenderer.sendSync('specstudio:info') as DaemonInfo | null;

if (info !== null) {
  contextBridge.exposeInMainWorld('specstudio', {
    getDaemonInfo: (): DaemonInfo => info,
  });
}
