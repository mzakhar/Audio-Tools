import { describe, it, expect } from 'vitest';
import { padPattern, ledOn, ledFrame, ledDiff, budget } from '../src/renderer/js/pads/led-patterns.js';

const base = { hasSound: true, muted: false, wipeArmed: false, target: false };

describe('padPattern', () => {
  it('precedence', () => {
    expect(padPattern({ ...base, hasSound: false, muted: true, target: true })).toBe('dark');
    expect(padPattern({ ...base, muted: true, wipeArmed: true, target: true })).toBe('blink-fast');
    expect(padPattern({ ...base, wipeArmed: true })).toBe('blink-slow');
    expect(padPattern({ ...base, target: true })).toBe('blink-slow');
    expect(padPattern(base)).toBe('solid');
  });
});

describe('ledOn', () => {
  it('dark and solid', () => {
    expect(ledOn('dark', 0)).toBe(false);
    expect(ledOn('solid', 999)).toBe(true);
  });
  it('slow 1 Hz', () => {
    expect(ledOn('blink-slow', 0)).toBe(true);
    expect(ledOn('blink-slow', 499)).toBe(true);
    expect(ledOn('blink-slow', 500)).toBe(false);
    expect(ledOn('blink-slow', 999)).toBe(false);
    expect(ledOn('blink-slow', 1000)).toBe(true);
  });
  it('fast 4 Hz', () => {
    expect(ledOn('blink-fast', 0)).toBe(true);
    expect(ledOn('blink-fast', 124)).toBe(true);
    expect(ledOn('blink-fast', 125)).toBe(false);
    expect(ledOn('blink-fast', 249)).toBe(false);
    expect(ledOn('blink-fast', 250)).toBe(true);
  });
});

describe('ledFrame', () => {
  const pink = [255, 0, 128];
  const pads = Array.from({ length: 16 }, () => base);
  const colours = Array.from({ length: 16 }, () => pink);
  it('null colour is off, off phase is [0,0,0]', () => {
    const c = colours.slice(); c[3] = null;
    const p = pads.slice(); p[5] = { ...base, muted: true }; p[6] = { ...base, hasSound: false };
    const f = ledFrame(p, c, 200);
    expect(f).toHaveLength(16);
    expect(f[0]).toEqual(pink);
    expect(f[3]).toEqual([0, 0, 0]);
    expect(f[5]).toEqual([0, 0, 0]);
    expect(f[6]).toEqual([0, 0, 0]);
    expect(ledFrame(p, c, 0)[5]).toEqual(pink);
  });
});

describe('ledDiff', () => {
  it('only changed pads', () => {
    const a = Array.from({ length: 16 }, () => [0, 0, 0]);
    const b = a.map((x) => x.slice()); b[2] = [1, 2, 3]; b[9] = [4, 5, 6];
    expect(ledDiff(a, b)).toEqual([{ pad: 2, rgb: [1, 2, 3] }, { pad: 9, rgb: [4, 5, 6] }]);
    expect(ledDiff(b, b)).toEqual([]);
  });
  it('no previous frame -> all', () => {
    expect(ledDiff(null, [[1, 1, 1], [2, 2, 2]])).toHaveLength(2);
  });
});

describe('budget', () => {
  const diffs = Array.from({ length: 6 }, (_, i) => ({ pad: i, rgb: [i, 0, 0] }));
  it('caps and passes through under cap', () => {
    expect(budget(diffs, 4).map((d) => d.pad)).toEqual([0, 1, 2, 3]);
    expect(budget(diffs, 10)).toBe(diffs);
  });
  it('rotation covers every pad', () => {
    const seen = new Set();
    let offset = 0;
    for (let tick = 0; tick < 3; tick++) {
      const sent = budget(diffs, 2, offset);
      expect(sent).toHaveLength(2);
      sent.forEach((d) => seen.add(d.pad));
      offset += sent.length;
    }
    expect(seen.size).toBe(6);
  });
  it('negative/large offset is safe', () => {
    expect(budget(diffs, 2, -1).map((d) => d.pad)).toEqual([5, 0]);
    expect(budget(diffs, 2, 13).map((d) => d.pad)).toEqual([1, 2]);
  });
});
