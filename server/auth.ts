import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Single-workspace demo capability, not production auth: a random token kept in a
 * gitignored local file and in the demo browser's localStorage.
 */
export function loadWorkspaceToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}
