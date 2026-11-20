import type { AiRemoteProvider, CredentialPort } from '@spec-studio/protocol';

/**
 * The keychain reach of a daemon running as the desktop shell's utility
 * process: `process.parentPort` is the Electron message port back to the main
 * process, which owns safeStorage. A standalone daemon (`pnpm daemon`) and
 * the web dev server have no parent — the port is absent and the credential
 * chain stays request key + environment, exactly as before.
 */

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

declare global {
  namespace NodeJS {
    interface Process {
      /** Present only inside an Electron utility process. */
      parentPort?: ParentPortLike;
    }
  }
}

const REQUEST_TYPE = 'specstudio:keychain';
const REPLY_TYPE = 'specstudio:keychain:result';
const CALL_TIMEOUT_MS = 5_000;

interface KeychainReply {
  ok: boolean;
  key?: string;
  error?: string;
}

/**
 * Builds the keychain port over the utility-process IPC, or `null` when there
 * is no parent to ask. Replies are correlated by id; messages that are not
 * keychain results are ignored — the port may carry other traffic someday.
 */
export function createIpcKeychainPort(): CredentialPort | null {
  const parent = process.parentPort;
  if (parent === undefined) return null;

  let nextId = 0;
  const waiters = new Map<number, (reply: KeychainReply) => void>();

  parent.on('message', (event) => {
    const message = event.data;
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    if (record['type'] !== REPLY_TYPE) return;
    const id = Number(record['id']);
    const waiter = waiters.get(id);
    if (waiter === undefined) return;
    waiters.delete(id);
    waiter({
      ok: record['ok'] === true,
      ...(typeof record['key'] === 'string' ? { key: record['key'] } : {}),
      ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
    });
  });

  // `null` means no answer within the timeout — the main process is gone or
  // busy, so the keychain counts as unavailable instead of hanging a request.
  const call = (
    op: 'resolve' | 'store' | 'erase',
    provider: AiRemoteProvider,
    presetId: string,
    key?: string,
  ): Promise<KeychainReply | null> =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        waiters.delete(id);
        resolve(null);
      }, CALL_TIMEOUT_MS);
      waiters.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      parent.postMessage({
        type: REQUEST_TYPE,
        id,
        op,
        provider,
        presetId,
        ...(key === undefined ? {} : { key }),
      });
    });

  return {
    source: 'keychain',
    // An unavailable or failing keychain reads as "no key here" so the chain
    // can fall through to env and the local-rule fallback.
    async resolve(provider, presetId) {
      const reply = await call('resolve', provider, presetId);
      if (reply === null || !reply.ok || reply.key === undefined || reply.key === '') return null;
      return reply.key;
    },
    async store(provider, presetId, key) {
      const reply = await call('store', provider, presetId, key);
      if (reply === null) throw new Error('keychain_unavailable');
      if (!reply.ok) throw new Error(reply.error ?? 'keychain_unavailable');
    },
    async erase(provider, presetId) {
      const reply = await call('erase', provider, presetId);
      if (reply === null) throw new Error('keychain_unavailable');
      if (!reply.ok) throw new Error(reply.error ?? 'keychain_unavailable');
    },
  };
}
