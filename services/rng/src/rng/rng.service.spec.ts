import { RngService } from './rng.service';

describe('RngService', () => {
  const service = new RngService();

  it('always returns an integer within [0, outcomeSpace)', () => {
    for (let i = 0; i < 1000; i++) {
      const result = service.roll(37);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(37);
    }
  });

  it('produces a roughly uniform distribution over a large sample', () => {
    const outcomeSpace = 37;
    const samples = 100_000;
    const counts = new Array(outcomeSpace).fill(0);

    for (let i = 0; i < samples; i++) {
      counts[service.roll(outcomeSpace)]++;
    }

    const expected = samples / outcomeSpace;
    const tolerance = expected * 0.15; // loose bound — sanity check, not a strict statistical test

    for (const count of counts) {
      expect(count).toBeGreaterThan(expected - tolerance);
      expect(count).toBeLessThan(expected + tolerance);
    }
  });
});
