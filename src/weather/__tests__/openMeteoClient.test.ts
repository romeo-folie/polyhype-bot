import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { fetchOpenMeteoForecast, fetchEnsembleForecast, fetchHistoricalHigh } = await import(
  '../openMeteoClient.js'
);

// Helper to create a mock fetch function
function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// ---------------------------------------------------------------------------
// fetchOpenMeteoForecast
// ---------------------------------------------------------------------------

describe('fetchOpenMeteoForecast', () => {
  it('returns forecast for a valid response', async () => {
    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-14'],
        temperature_2m_max: [52.3],
        temperature_2m_min: [38.1],
        precipitation_probability_max: [20],
      },
    });

    const result = await fetchOpenMeteoForecast(
      41.88, -87.63, '2026-04-14', 'fahrenheit', fetchFn,
    );

    expect(result).not.toBeNull();
    expect(result!.highTemp).toBeCloseTo(52.3, 0);
    expect(result!.lowTemp).toBeCloseTo(38.1, 0);
    expect(result!.precipProbability).toBe(20);
    expect(result!.forecastDate).toBe('2026-04-14');
  });

  it('passes unit parameter to API', async () => {
    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-14'],
        temperature_2m_max: [11.5],
        temperature_2m_min: [3.4],
        precipitation_probability_max: [10],
      },
    });

    await fetchOpenMeteoForecast(51.51, -0.13, '2026-04-14', 'celsius', fetchFn);

    const calledUrl = fetchFn.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('temperature_unit=celsius');
  });

  it('returns null on API error', async () => {
    const fetchFn = mockFetch({}, 500);
    const result = await fetchOpenMeteoForecast(41.88, -87.63, '2026-04-14', 'fahrenheit', fetchFn);
    expect(result).toBeNull();
  });

  it('returns null when target date not in response', async () => {
    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-15'], // Different date
        temperature_2m_max: [52.3],
        temperature_2m_min: [38.1],
      },
    });

    const result = await fetchOpenMeteoForecast(41.88, -87.63, '2026-04-14', 'fahrenheit', fetchFn);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'));
    const result = await fetchOpenMeteoForecast(41.88, -87.63, '2026-04-14', 'fahrenheit', fetchFn);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchEnsembleForecast
// ---------------------------------------------------------------------------

describe('fetchEnsembleForecast', () => {
  it('computes stats from ensemble member keys', async () => {
    // Open-Meteo ensemble returns individual member keys
    const memberData: Record<string, number[]> = {};
    const values = [50, 52, 51, 53, 49, 54, 48, 55, 50, 51, 52, 53, 49, 50, 51,
      52, 53, 54, 50, 51, 52, 48, 49, 55, 50, 51, 52, 53, 54, 50, 51];
    for (let i = 0; i < values.length; i++) {
      memberData[`temperature_2m_max_member${i.toString().padStart(2, '0')}`] = [values[i]!];
    }

    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-14'],
        temperature_2m_max: [51.3], // Deterministic (ignored for ensemble)
        ...memberData,
      },
    });

    const result = await fetchEnsembleForecast(41.88, -87.63, '2026-04-14', 'fahrenheit', fetchFn);

    expect(result).not.toBeNull();
    expect(result!.memberCount).toBe(31);
    expect(result!.meanHigh).toBeCloseTo(51.2, 0);
    expect(result!.stddevHigh).toBeGreaterThan(1);
    expect(result!.stddevHigh).toBeLessThan(3);
  });

  it('returns null on API error', async () => {
    const fetchFn = mockFetch({}, 500);
    const result = await fetchEnsembleForecast(41.88, -87.63, '2026-04-14', 'fahrenheit', fetchFn);
    expect(result).toBeNull();
  });

  it('returns null when no member data available', async () => {
    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-14'],
      },
    });
    const result = await fetchEnsembleForecast(41.88, -87.63, '2026-04-14', 'fahrenheit', fetchFn);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchHistoricalHigh (archive API — ground-truth reconciler)
// ---------------------------------------------------------------------------

describe('fetchHistoricalHigh', () => {
  it('returns observed high for a valid archive response', async () => {
    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-10'],
        temperature_2m_max: [71.4],
      },
    });

    const result = await fetchHistoricalHigh(
      40.7128, -74.006, '2026-04-10', 'fahrenheit', fetchFn,
    );

    expect(result).not.toBeNull();
    expect(result!.observedHigh).toBeCloseTo(71.4, 1);
    expect(result!.targetDate).toBe('2026-04-10');
    expect(result!.unit).toBe('fahrenheit');
  });

  it('hits the archive endpoint', async () => {
    const fetchFn = mockFetch({
      daily: { time: ['2026-04-10'], temperature_2m_max: [22.5] },
    });
    await fetchHistoricalHigh(51.51, -0.13, '2026-04-10', 'celsius', fetchFn);
    const calledUrl = fetchFn.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('archive-api.open-meteo.com');
    expect(calledUrl).toContain('temperature_unit=celsius');
    expect(calledUrl).toContain('start_date=2026-04-10');
  });

  it('returns null on API error', async () => {
    const fetchFn = mockFetch({}, 500);
    const result = await fetchHistoricalHigh(
      40.7128, -74.006, '2026-04-10', 'fahrenheit', fetchFn,
    );
    expect(result).toBeNull();
  });

  it('returns null when the target date is missing from the response', async () => {
    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-11'],
        temperature_2m_max: [72.0],
      },
    });
    const result = await fetchHistoricalHigh(
      40.7128, -74.006, '2026-04-10', 'fahrenheit', fetchFn,
    );
    expect(result).toBeNull();
  });

  it('returns null when temperature_2m_max value is non-finite', async () => {
    const fetchFn = mockFetch({
      daily: {
        time: ['2026-04-10'],
        temperature_2m_max: [null as unknown as number],
      },
    });
    const result = await fetchHistoricalHigh(
      40.7128, -74.006, '2026-04-10', 'fahrenheit', fetchFn,
    );
    expect(result).toBeNull();
  });
});
