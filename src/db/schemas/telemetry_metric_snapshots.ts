import { z } from 'zod';

export const telemetryMetricSnapshotRowSchema = z.object({
  snapshotAt:    z.string().datetime().optional(),
  metricName:    z.string(),
  metricValue:   z.number(),
  metricLabels:  z.record(z.unknown()).optional(),
});

export type TelemetryMetricSnapshotRow = z.infer<typeof telemetryMetricSnapshotRowSchema>;
