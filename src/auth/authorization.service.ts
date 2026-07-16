import type { PermissionLookup } from "./permission.repository.js";
import type { PermissionAction } from "./types.js";

export class PermissionDeniedError extends Error {
  constructor(public readonly resource: string) {
    super("Bu bilgiye erişim yetkiniz bulunmuyor.");
    this.name = "PermissionDeniedError";
  }
}

export class AuthorizationService {
  constructor(private readonly permissions: PermissionLookup) {}

  async isAllowed(userId: string, resource: string, action: PermissionAction = "read"): Promise<boolean> {
    return this.permissions.has(userId, resource, action);
  }

  async require(userId: string, resource: string, action: PermissionAction = "read"): Promise<void> {
    if (!(await this.isAllowed(userId, resource, action))) {
      throw new PermissionDeniedError(resource);
    }
  }
}
