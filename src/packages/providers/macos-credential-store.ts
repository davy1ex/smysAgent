import type { CredentialStore } from "../application/ports";

const SERVICE_NAME = "smys-agent.providers";

export class CredentialVaultError extends Error {
  constructor(message = "macOS Keychain is unavailable or denied access.", options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialVaultError";
  }
}

export class MacOSCredentialStore implements CredentialStore {
  async save(reference: string, secret: string): Promise<void> {
    const entry = await this.entry(reference);
    try {
      await entry.setPassword(secret);
      const saved = await entry.getPassword();
      if (saved !== secret) {
        await entry.deletePassword().catch(() => false);
        throw new CredentialVaultError("The credential could not be verified in macOS Keychain.");
      }
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError(undefined, { cause: error });
    }
  }

  async get(reference: string): Promise<string | null> {
    const entry = await this.entry(reference);
    try {
      return await entry.getPassword();
    } catch (error) {
      throw new CredentialVaultError(undefined, { cause: error });
    }
  }

  async delete(reference: string): Promise<void> {
    const entry = await this.entry(reference);
    try {
      await entry.deletePassword();
    } catch (error) {
      throw new CredentialVaultError(undefined, { cause: error });
    }
  }

  private async entry(reference: string): Promise<import("@napi-rs/keyring").AsyncEntry> {
    if (process.platform !== "darwin") {
      throw new CredentialVaultError("Secure API-key storage is currently supported only on macOS.");
    }
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(SERVICE_NAME, reference);
    } catch (error) {
      throw new CredentialVaultError(undefined, { cause: error });
    }
  }
}
