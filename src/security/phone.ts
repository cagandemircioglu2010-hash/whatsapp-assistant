import { createHmac } from "node:crypto";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export function normalizePhoneNumber(input: string, defaultCountry: CountryCode = "TR"): string | null {
  const compact = input.trim().replace(/[()\s-]/g, "");
  const phone = parsePhoneNumberFromString(compact, defaultCountry);

  if (!phone?.isValid()) return null;
  return phone.number;
}

export function hashPhoneIdentifier(phone: string, secret: string): string {
  return createHmac("sha256", secret).update(phone).digest("hex");
}

export function phoneLastFour(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "*");
}
