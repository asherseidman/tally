import { Entry } from '@napi-rs/keyring';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k);
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

const SERVICE = 'todo-planner';

/** OS keychain (macOS Keychain, Windows Credential Manager, Secret Service). Tokens never touch the repo or a plain file. */
export class KeychainSecretStore implements SecretStore {
  constructor(private service = SERVICE) {}
  async get(key: string) {
    return new Entry(this.service, key).getPassword() ?? undefined;
  }
  async set(key: string, value: string) {
    new Entry(this.service, key).setPassword(value);
  }
  async delete(key: string) {
    try {
      new Entry(this.service, key).deletePassword();
    } catch {
      /* nothing stored */
    }
  }
}

/**
 * Remembers what it has read for the life of the process. macOS asks permission when an app first reads a Keychain item (once,
 * and never again if "Always Allow" is chosen); without this, every API call would read the Keychain again, so choosing plain
 * "Allow" would mean a prompt per read. With it, the worst case is ONE prompt per launch. Writes and deletes go straight through.
 * A change made by another process (e.g. the command line) is seen after the next launch.
 */
export class CachedSecretStore implements SecretStore {
  private cache = new Map<string, string | undefined>();
  reads = 0;
  constructor(private inner: SecretStore) {}
  async get(key: string) {
    if (this.cache.has(key)) return this.cache.get(key);
    this.reads++;
    const v = await this.inner.get(key);
    this.cache.set(key, v);
    return v;
  }
  async set(key: string, value: string) {
    await this.inner.set(key, value);
    this.cache.set(key, value);
  }
  async delete(key: string) {
    await this.inner.delete(key);
    this.cache.set(key, undefined);
  }
}
