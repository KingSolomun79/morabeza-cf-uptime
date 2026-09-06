import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class merger (conditional classes + Tailwind dedupe). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Client-form convenience (#29 owner request): derive the slug from the name
 * as the user types — lowercase, non-alphanumerics collapsed to single
 * dashes, no leading/trailing dashes. Output always satisfies the client
 * SLUG_PATTERN; the form only auto-fills while the slug field is untouched.
 */
export function slugifyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
