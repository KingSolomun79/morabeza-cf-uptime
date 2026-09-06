import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class merger (conditional classes + Tailwind dedupe). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
