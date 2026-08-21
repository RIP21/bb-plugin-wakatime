/**
 * Formatting for the sidebar accessory, which the host clips to a single line
 * about four characters wide. `wakatime-cli --today` prints human text like
 * "1 hr 2 mins", so it has to be squeezed before it fits.
 */

/** Pulls hours and minutes out of wakatime-cli's `--today` output. */
export function parseTodayText(text: string): { hours: number; minutes: number } | null {
  const hours = /(\d+)\s*hrs?\b/i.exec(text);
  const minutes = /(\d+)\s*mins?\b/i.exec(text);
  const seconds = /(\d+)\s*secs?\b/i.exec(text);
  if (!hours && !minutes && !seconds) return null;
  return {
    hours: hours ? Number.parseInt(hours[1]!, 10) : 0,
    minutes: minutes ? Number.parseInt(minutes[1]!, 10) : 0,
  };
}

/**
 * Squeezes a `--today` string into something that fits the sidebar accessory:
 * "1 hr 2 mins" becomes "1h 2m", "28 mins" becomes "28m", "0 secs" becomes
 * "0m". Returns null when the text cannot be read, so the caller can decide
 * what to show instead of printing something misleading.
 */
export function compactDuration(text: string | null): string | null {
  if (!text) return null;
  const parsed = parseTodayText(text);
  if (!parsed) return null;
  const { hours, minutes } = parsed;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}
