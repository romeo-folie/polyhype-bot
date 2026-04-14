/**
 * Dispatch table for the writer.
 *
 * Each handler takes (sql, payloads[]) and is responsible for ALL bulk-insert
 * semantics for its table — Zod validation, ON CONFLICT, etc. The writer loop
 * calls them grouped by `table` so each handler sees a single batch per
 * iteration of XREADGROUP.
 *
 * Adding a new table = (1) write a handler module, (2) register it here, (3)
 * write the migration. The writer code itself does not change.
 */

import type { Sql } from 'postgres';
import { handleHealthPings } from './health_pings.js';
import { handleSignalDecisions } from './signal_decisions.js';
import { handleExecutionEvents } from './execution_events.js';
import { handleShadowObservations } from './shadow_observations.js';
import { handleOutcomes } from './outcomes.js';
import { handlePositions } from './positions.js';
import { handleHedgeEvents } from './hedge_events.js';
import { handleCalibrationStats } from './calibration_stats.js';
import { handleTelemetryMetricSnapshots } from './telemetry_metric_snapshots.js';
import { handleMakerTelemetry } from './maker_telemetry.js';
import { handleArbLatencySamples } from './arb_latency_samples.js';
import { handleMarketCatalog } from './market_catalog.js';
import { handleTradeMemory } from './trade_memory.js';
import { handleWeatherGroundTruth } from './weather_ground_truth.js';

export type WriterHandler = (sql: Sql, payloads: unknown[]) => Promise<void>;

export const handlers: Record<string, WriterHandler> = {
  health_pings:                handleHealthPings,
  signal_decisions:            handleSignalDecisions,
  execution_events:            handleExecutionEvents,
  shadow_observations:         handleShadowObservations,
  outcomes:                    handleOutcomes,
  positions:                   handlePositions,
  hedge_events:                handleHedgeEvents,
  calibration_stats:           handleCalibrationStats,
  telemetry_metric_snapshots:  handleTelemetryMetricSnapshots,
  maker_telemetry:             handleMakerTelemetry,
  arb_latency_samples:         handleArbLatencySamples,
  market_catalog:              handleMarketCatalog,
  trade_memory:                handleTradeMemory,
  weather_ground_truth:        handleWeatherGroundTruth,
};
