import {
  AI_ENV_KEYS,
  type AiRemoteProvider,
  type CredentialPort,
  type CredentialSource,
} from '@spec-studio/protocol';

/**
 * The credential chain (§6.1): ask each port in order and take the first
 * non-null key — the request body first (the person just typed it), then the
 * OS keychain (the desktop app), then the daemon's environment.
 *
 * A port that throws is treated as unavailable, not as a failure: a broken
 * safeStorage must not take the local-rule fallback down with it, so the
 * chain skips the port and keeps going instead of surfacing the error.
 */

/** The key sitting in the request body, if any. */
export class RequestCredentialPort implements CredentialPort {
  readonly source = 'request' as const;
  readonly #key: string | null | undefined;

  constructor(requestKey: string | null | undefined) {
    this.#key = requestKey;
  }

  async resolve(_provider: AiRemoteProvider, _presetId: string): Promise<string | null> {
    const trimmed = (this.#key ?? '').trim();
    return trimmed === '' ? null : trimmed;
  }
}

/** The daemon's environment — one key per provider, so the preset id is ignored. */
export class EnvCredentialPort implements CredentialPort {
  readonly source = 'env' as const;
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined>) {
    this.#env = env;
  }

  async resolve(provider: AiRemoteProvider, _presetId: string): Promise<string | null> {
    const fromEnv = (this.#env[AI_ENV_KEYS[provider]] ?? '').trim();
    return fromEnv === '' ? null : fromEnv;
  }
}

export async function resolveCredentials(
  ports: readonly CredentialPort[],
  provider: AiRemoteProvider,
  presetId: string | undefined,
): Promise<{ key: string | null; source: CredentialSource | null }> {
  for (const port of ports) {
    // Unavailable ≠ broken request: skip the port, keep the chain alive.
    let key: string | null = null;
    try {
      key = await port.resolve(provider, presetId ?? '');
    } catch {
      continue;
    }
    if (key !== null && key !== '') return { key, source: port.source };
  }
  return { key: null, source: null };
}
