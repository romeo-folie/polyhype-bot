import { z } from 'zod';

const UNIT = ['fahrenheit', 'celsius'] as const;

export const weatherGroundTruthRowSchema = z.object({
  /** Canonical city key (matches CITY_COORDINATES keys in noaaClient.ts). */
  city:          z.string().min(1),
  /** Market target date, YYYY-MM-DD. */
  targetDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unit:          z.enum(UNIT),
  /** Observed daily high in the requested unit (Open-Meteo archive at forecast coords). */
  observedHigh:  z.number().finite(),
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
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'resolutionHigh and resolutionSource must both be present or both absent',
    });
  }
});

export type WeatherGroundTruthRow = z.infer<typeof weatherGroundTruthRowSchema>;
