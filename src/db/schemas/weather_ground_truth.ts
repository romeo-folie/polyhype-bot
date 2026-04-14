import { z } from 'zod';

const UNIT = ['fahrenheit', 'celsius'] as const;

export const weatherGroundTruthRowSchema = z.object({
  /** Canonical city key (matches CITY_COORDINATES keys in noaaClient.ts). */
  city:          z.string().min(1),
  /** Market target date, YYYY-MM-DD. */
  targetDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unit:          z.enum(UNIT),
  /** Observed daily high in the requested unit. */
  observedHigh:  z.number().finite(),
  /** Source slug — defaults to 'open-meteo-archive'. */
  source:        z.string().min(1).default('open-meteo-archive'),
  /** Optional override for the fetch timestamp (defaults to now() in SQL). */
  observedAt:    z.string().datetime().optional(),
});

export type WeatherGroundTruthRow = z.infer<typeof weatherGroundTruthRowSchema>;
