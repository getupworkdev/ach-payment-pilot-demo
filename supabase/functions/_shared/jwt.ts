// Read a JWT's claims without verifying it. The client never trusts these for
// security - the provider verifies the signature - but it does use them to
// check a token is for the entity it asked for and to know when it expires.

export interface JwtClaims {
  sub?: string;
  exp?: number;
  [claim: string]: unknown;
}

export function decodeClaims(token: string): JwtClaims {
  const part = token.split(".")[1];
  if (!part) throw new Error("not a JWT");
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}
