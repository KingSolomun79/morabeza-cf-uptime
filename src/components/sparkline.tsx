/**
 * Minimal SVG sparkline (issue #22; PRD §27.3 response-time trend).
 * Hand-rolled instead of a charting dependency: the overview needs a tiny
 * non-interactive trend shape; Recharts lands with the #24 detail charts
 * (decision-gate compliant, permissively licensed).
 */
export interface SparklineProps {
  /** Numeric series in chronological order; non-finite values are skipped. */
  points: number[];
  /** Accessible name (the trend is decorative otherwise). */
  label: string;
  className?: string;
}

export function Sparkline({ points, label, className }: SparklineProps) {
  const series = points.filter((value) => Number.isFinite(value));
  if (series.length < 2) {
    return (
      <span role="img" aria-label={label} className={className}>
        Not enough data for a trend
      </span>
    );
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = 100 / (series.length - 1);
  const coordinates = series.map((value, index) => `${(index * step).toFixed(2)},${(28 - ((value - min) / span) * 26).toFixed(2)}`);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className={className ?? "h-12 w-full"}
    >
      <polyline
        points={coordinates.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
