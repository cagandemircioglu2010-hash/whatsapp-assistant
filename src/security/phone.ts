import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export function normalizePhoneNumber(input: string, defaultCountry: CountryCode = "TR"): string | null {
  const compact = input.trim().replace(/[()\s-]/g, "");
  const phone = parsePhoneNumberFromString(compact, defaultCountry);

  if (!phone?.isValid()) return null;
  return phone.number;
}
