type ClassValue = string | false | null | undefined;

/** Minimal class-name joiner — no runtime dependency, order preserved. */
export function cn(...values: ClassValue[]): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
