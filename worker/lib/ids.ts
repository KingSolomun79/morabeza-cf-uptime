/** Text identifiers for entities (PRD §17 preamble: UUID/ULID-style text ids). */

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
