import { z } from 'zod';

const UNIT = ['fahrenheit', 'celsius'] as const;

export const weatherGroundTruthRowSchema = z.object({
  /** Canonical city key (matches CITY_COORDINATES keys in noaaClient.ts). */
  city:          z.string().min(1),
  /** Market target date, YYYY-MM-DD. */
  targetDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unit:          z.enum(UNIT),
  /**
   * Observed daily high in the requested unit (Open-Meteo archive at
   * forecast coords). Required for INSERT payloads; omitted for
   * `backfillOnly: true` payloads, which issue a bare UPDATE of the
   * resolution columns and never touch `observed_high`.
   */
  observedHigh:  z.number().finite().optional(),
  /** Source slug — defaults to 'open-meteo-archive'. */
  source:        z.string().min(1).default('open-meteo-archive'),
  /** Daily high from the exact Polymarket resolution source (WU/METAR/HKO). */
  resolutionHigh:   z.number().finite().optional(),
  /** Which fetcher produced resolutionHigh. */
  resolutionSource: z.enum(['wu', 'metar', 'hko']).optional(),
  /** Optional override for the fetch timestamp (defaults to now() in SQL). */
  observedAt:    z.string().datetime().optional(),
  /**
   * When true the writer issues an UPDATE (resolution columns only) instead of
   * INSERT … ON CONFLICT, preventing a zero sentinel from being stored as
   * observed_high if the row is somehow absent.
   */
  backfillOnly:  z.boolean().optional(),
}).superRefine((d, ctx) => {
  const hasHigh = d.resolutionHigh !== undefined;
  const hasSrc  = d.resolutionSource !== undefined;
  if (hasHigh !== hasSrc) {
    // Point the issue at whichever half of the pair is missing, so the
    // writer's rejection log identifies the actual absent field.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'resolutionHigh and resolutionSource must both be present or both absent',
      path: [hasHigh ? 'resolutionSource' : 'resolutionHigh'],
    });
  }
  // `observedHigh` is only optional for the backfillOnly (UPDATE-resolution)
  // path. Inserts must always include it — a missing value here would land as
  // NULL in `observed_high` and silently break cityBias calibration, which
  // reads observed_high as the empirical reference when resolution_high is
  // absent.
  if (d.backfillOnly !== true && d.observedHigh === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'observedHigh is required unless backfillOnly is true',
      path: ['observedHigh'],
    });
  }
  // backfillOnly payloads must carry BOTH resolution columns. Emit a separate
  // issue per missing field so each absent field is individually identifiable
  // in the writer's rejection log.
  if (d.backfillOnly === true) {
    if (d.resolutionHigh === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backfillOnly payloads must include resolutionHigh',
        path: ['resolutionHigh'],
      });
    }
    if (d.resolutionSource === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backfillOnly payloads must include resolutionSource',
        path: ['resolutionSource'],
      });
    }
  }
});

export type WeatherGroundTruthRow = z.infer<typeof weatherGroundTruthRowSchema>;
