import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The desktop side of the keychain (F1). The daemon — a utility process with
 * no Electron APIs — asks this service over `process.parentPort`; only the
 * main process can touch `safeStorage`.
 *
 * One file under userData holds base64 ciphertext per preset id. The file is
 * not a secret: the key string itself never lands on disk — safeStorage's
 * encrypted blob is all that is written, so AC-6's "no key string anywhere"
 * holds even inside `keychain.json`.
 */

const REQUEST_TYPE = 'specstudio:keychain';
const REPLY_TYPE = 'specstudio:keychain:result';

interface KeychainRequest {
  type?: unknown;
  id?: unknown;
  op?: unknown;
  provider?: unknown;
  presetId?: unknown;
  key?: unknown;
}

interface KeychainFile {
  version: number;
  entries: Record<string, string>;
}

export class KeychainService {
  readonly #file: string;

  constructor(userDataDir: string) {
    this.#file = join(userDataDir, 'keychain.json');
  }

  #read(): KeychainFile {
    if (!existsSync(this.#file)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as KeychainFile;
      return { version: 1, entries: parsed.entries ?? {} };
    } catch {
      // A corrupt file reads as empty — better than trusting half-JSON.
      return { version: 1, entries: {} };
    }
  }

  #write(entries: Record<string, string>): void {
    writeFileSync(this.#file, JSON.stringify({ version: 1, entries }), 'utf8');
  }

  resolve(presetId: string): string | null {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encoded = this.#read().entries[presetId];
    if (encoded === undefined) return null;
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch {
      return null;
    }
  }

  store(presetId: string, key: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('encryption_unavailable');
    }
    const file = this.#read();
    file.entries[presetId] = safeStorage.encryptString(key).toString('base64');
    this.#write(file.entries);
  }

  erase(presetId: string): void {
    const file = this.#read();
    delete file.entries[presetId];
    this.#write(file.entries);
  }

  /**
   * Answers one `specstudio:keychain` request from the daemon child. The key
   * a resolve replies with travels parent→child in-process only; store and
   * erase replies carry nothing but ok/error.
   */
  handle(message: unknown, reply: (answer: unknown) => void): void {
    const request = message as KeychainRequest | null;
    if (
      request === null ||
      typeof request !== 'object' ||
      request.type !== REQUEST_TYPE ||
      typeof request.id !== 'number' ||
      typeof request.presetId !== 'string'
    ) {
      return;
    }
    const { id, op, presetId } = request as { id: number; op: string; presetId: string };
    try {
      if (op === 'resolve') {
        const key = this.resolve(presetId);
        reply({ type: REPLY_TYPE, id, ok: true, ...(key === null ? {} : { key }) });
        return;
      }
      if (op === 'store') {
        const key = request.key;
        if (typeof key !== 'string' || key === '') {
          reply({ type: REPLY_TYPE, id, ok: false, error: 'key_missing' });
          return;
        }
        this.store(presetId, key);
        reply({ type: REPLY_TYPE, id, ok: true });
        return;
      }
      if (op === 'erase') {
        this.erase(presetId);
        reply({ type: REPLY_TYPE, id, ok: true });
        return;
      }
      reply({ type: REPLY_TYPE, id, ok: false, error: 'op_unknown' });
    } catch (error) {
      reply({
        type: REPLY_TYPE,
        id,
        ok: false,
        error: error instanceof Error ? error.message : 'keychain_error',
      });
    }
  }
}
