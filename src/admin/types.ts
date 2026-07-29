import type { WhitelistUserInput } from "../../scripts/whitelist-user.js";

export type AdminWhitelistUser = {
  id: string;
  name: string;
  phoneMasked: string;
  department: string | null;
  role: string;
  locale: "tr" | "en" | null;
  active: boolean;
  permissions: string[];
  createdAt: Date;
};

export type AdminUpsertResult = {
  created: boolean;
};

export interface WhitelistAdminStore {
  listUsers(): Promise<AdminWhitelistUser[]>;
  upsertUser(input: WhitelistUserInput): Promise<AdminUpsertResult>;
  setUserActive(userId: string, active: boolean): Promise<void>;
}
