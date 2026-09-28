// Common NACHA return reason codes. Not exhaustive.
// "unauthorized" returns (R05, R07, R10, R29, ...) mean the account holder
// disputes the debit - these must not be re-presented and count toward the
// unauthorized-return threshold, so staff need to see them first.

interface ReturnCodeInfo {
  description: string;
  unauthorized: boolean;
}

const RETURN_CODES: Record<string, ReturnCodeInfo> = {
  R01: { description: "Insufficient funds", unauthorized: false },
  R02: { description: "Account closed", unauthorized: false },
  R03: { description: "No account / unable to locate account", unauthorized: false },
  R04: { description: "Invalid account number", unauthorized: false },
  R05: { description: "Unauthorized debit to consumer account", unauthorized: true },
  R07: { description: "Authorization revoked by customer", unauthorized: true },
  R08: { description: "Payment stopped", unauthorized: false },
  R09: { description: "Uncollected funds", unauthorized: false },
  R10: { description: "Customer advises not authorized", unauthorized: true },
  R11: { description: "Customer advises entry not in accordance with terms", unauthorized: true },
  R16: { description: "Account frozen", unauthorized: false },
  R20: { description: "Non-transaction account", unauthorized: false },
  R29: { description: "Corporate customer advises not authorized", unauthorized: true },
};

export function describeReturn(code: string): ReturnCodeInfo {
  return RETURN_CODES[code] ?? { description: "Unrecognised return code", unauthorized: false };
}

export function staffReviewReason(code: string): string {
  const info = describeReturn(code);
  const suffix = info.unauthorized ? " - unauthorized return, do not re-present" : "";
  return `ACH return ${code}: ${info.description}${suffix}`;
}
