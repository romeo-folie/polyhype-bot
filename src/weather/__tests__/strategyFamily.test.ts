import { describe, it, expect } from 'vitest';
import {
  classifyWeatherStrategyFamily,
  weatherSelectedBy,
  isWeatherModalDisagreement,
  type StrategyFamilyInput,
} from '../strategyFamily.js';

/** A native interior NO with no special provenance — the baseline case. */
function baseNo(overrides: Partial<StrategyFamilyInput> = {}): StrategyFamilyInput {
  return {
    tradeSide: 'NO',
    isTailBracket: false,
    noLadderKind: null,
    wouldHaveFallenBackToNo: false,
    liveObservationConfirmed: false,
    isResolutionDay: false,
    bracketLabel: '70-71°F',
    marketFavoriteBracket: '72-73°F',
    modelModalBracket: '70-71°F',
    calibrationLive: false,
    ...overrides,
  };
}

function baseYes(overrides: Partial<StrategyFamilyInput> = {}): StrategyFamilyInput {
  return { ...baseNo(), tradeSide: 'YES', ...overrides };
}

describe('classifyWeatherStrategyFamily', () => {
  it('exact/interior YES candidate -> interior_yes', () => {
    expect(classifyWeatherStrategyFamily(baseYes({ isTailBracket: false }))).toBe('interior_yes');
  });

  it('tail YES candidate -> tail_yes', () => {
    expect(classifyWeatherStrategyFamily(baseYes({ isTailBracket: true }))).toBe('tail_yes');
  });

  it('native NO candidate -> native_no', () => {
    expect(classifyWeatherStrategyFamily(baseNo())).toBe('native_no');
  });

  it('disabled YES-gate fallback path -> yes_gated_fallback_no', () => {
    expect(
      classifyWeatherStrategyFamily(baseNo({ wouldHaveFallenBackToNo: true })),
    ).toBe('yes_gated_fallback_no');
  });

  it('far ladder candidate -> far_no_ladder', () => {
    expect(classifyWeatherStrategyFamily(baseNo({ noLadderKind: 'far' }))).toBe('far_no_ladder');
  });

  it('adjacent ladder candidate -> adjacent_no_ladder', () => {
    expect(
      classifyWeatherStrategyFamily(baseNo({ noLadderKind: 'adjacent' })),
    ).toBe('adjacent_no_ladder');
  });

  it('live lock-in candidate -> resday_lockin_no', () => {
    expect(
      classifyWeatherStrategyFamily(
        baseNo({ isResolutionDay: true, liveObservationConfirmed: true }),
      ),
    ).toBe('resday_lockin_no');
  });

  it('NO on the market-favorite bracket -> market_favorite_fade', () => {
    expect(
      classifyWeatherStrategyFamily(
        baseNo({ bracketLabel: '72-73°F', marketFavoriteBracket: '72-73°F' }),
      ),
    ).toBe('market_favorite_fade');
  });

  it('returns none when there is no tradeable side', () => {
    // Defensive: candidates normally always carry a side.
    expect(
      classifyWeatherStrategyFamily({ tradeSide: undefined as never, isTailBracket: false }),
    ).toBe('none');
  });

  describe('precedence (mutual exclusivity)', () => {
    it('lock-in dominates a ladder and fallback when live-confirmed', () => {
      expect(
        classifyWeatherStrategyFamily(
          baseNo({
            liveObservationConfirmed: true,
            noLadderKind: 'far',
            wouldHaveFallenBackToNo: true,
          }),
        ),
      ).toBe('resday_lockin_no');
    });

    it('a ladder dominates the YES-gate fallback', () => {
      expect(
        classifyWeatherStrategyFamily(
          baseNo({ noLadderKind: 'far', wouldHaveFallenBackToNo: true }),
        ),
      ).toBe('far_no_ladder');
    });

    it('the YES-gate fallback dominates a market-favorite fade', () => {
      expect(
        classifyWeatherStrategyFamily(
          baseNo({
            wouldHaveFallenBackToNo: true,
            bracketLabel: '72-73°F',
            marketFavoriteBracket: '72-73°F',
          }),
        ),
      ).toBe('yes_gated_fallback_no');
    });

    it('YES side ignores NO-only provenance fields', () => {
      // A YES candidate should never be a ladder/fallback/fade family even if
      // those NO-only fields are spuriously set.
      expect(
        classifyWeatherStrategyFamily(
          baseYes({ noLadderKind: 'far', wouldHaveFallenBackToNo: true, liveObservationConfirmed: true }),
        ),
      ).toBe('interior_yes');
    });
  });

  it('does not classify a non-res-day fade as a fade when bracket != favorite', () => {
    expect(
      classifyWeatherStrategyFamily(
        baseNo({ bracketLabel: '70-71°F', marketFavoriteBracket: '72-73°F' }),
      ),
    ).toBe('native_no');
  });
});

describe('weatherSelectedBy', () => {
  it('lock-in NO -> lockin (dominates ladder/calibration)', () => {
    expect(
      weatherSelectedBy(baseNo({ liveObservationConfirmed: true, noLadderKind: 'far', calibrationLive: true })),
    ).toBe('lockin');
  });

  it('ladder NO -> ladder_bid (dominates calibration)', () => {
    expect(weatherSelectedBy(baseNo({ noLadderKind: 'adjacent', calibrationLive: true }))).toBe('ladder_bid');
  });

  it('calibration-live cohort -> calibrated_edge', () => {
    expect(weatherSelectedBy(baseNo({ calibrationLive: true }))).toBe('calibrated_edge');
  });

  it('plain candidate -> raw_edge', () => {
    expect(weatherSelectedBy(baseNo())).toBe('raw_edge');
    expect(weatherSelectedBy(baseYes())).toBe('raw_edge');
  });

  it('a YES is never selected by lock-in even if liveObservationConfirmed leaks true', () => {
    expect(weatherSelectedBy(baseYes({ liveObservationConfirmed: true }))).toBe('raw_edge');
  });
});

describe('isWeatherModalDisagreement', () => {
  it('true when model modal and market favorite differ', () => {
    expect(
      isWeatherModalDisagreement(baseNo({ modelModalBracket: '70-71°F', marketFavoriteBracket: '72-73°F' })),
    ).toBe(true);
  });

  it('false when they agree', () => {
    expect(
      isWeatherModalDisagreement(baseNo({ modelModalBracket: '72-73°F', marketFavoriteBracket: '72-73°F' })),
    ).toBe(false);
  });

  it('false when either label is missing', () => {
    expect(isWeatherModalDisagreement(baseNo({ modelModalBracket: null }))).toBe(false);
    expect(isWeatherModalDisagreement(baseNo({ marketFavoriteBracket: null }))).toBe(false);
  });
});
