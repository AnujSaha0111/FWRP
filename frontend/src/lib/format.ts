// Display formatting. All times come from the API as ISO UTC strings and are
// shown in the user's local time zone.

const dateTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

const dateOnly = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateTime.format(new Date(value));
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateOnly.format(new Date(value));
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "in 3 hours", "5 minutes ago". */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const diffMs = new Date(value).getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return relative.format(Math.round(diffMs / ms), unit);
  }
  return 'just now';
}

export function formatQuantity(quantity: number, unit: string): string {
  const n = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(1);
  return `${n} ${unit}`;
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(value: string | Date): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
