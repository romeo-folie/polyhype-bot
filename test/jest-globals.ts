import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { MockedFunction } from 'vitest';

const jest = {
  fn: vi.fn,
  mock: vi.mock,
  spyOn: vi.spyOn,
  clearAllMocks: vi.clearAllMocks,
  resetAllMocks: vi.resetAllMocks,
  restoreAllMocks: vi.restoreAllMocks,
  unstable_mockModule: vi.mock,
};

export { jest, describe, it, expect, beforeEach, afterEach };

export namespace jest {
  export type MockedFunction<T extends (...args: any[]) => any> = MockedFunction<T>;
}
