import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import { outcomeOf, register } from '../src/journeys/index.ts';
import type { Journey, JourneyResult, SurfaceAxis } from '../src/journeys/types.ts';

function result(over: Partial<JourneyResult> = {}): JourneyResult {
  return {
    name: 'x', actor: Actor.ADMINISTRATOR, surface: 'admin',
    entitiesCreated: 0, findings: [], ...over,
  };
}

describe('outcomeOf', () => {
  it('is pass when nothing was found and nothing was skipped', () => {
    expect(outcomeOf(result())).toBe('pass');
  });

  it('is fail when the sentinel found anything', () => {
    expect(outcomeOf(result({ findings: [{ kind: 'phplog', text: 'PHP Warning: boom' }] }))).toBe('fail');
  });

  it('is skip when the journey did not run', () => {
    expect(outcomeOf(result({ skipped: true, skipReason: 'plugin not active' }))).toBe('skip');
  });

  it('throws, rather than passing, when a skip reason arrives without skipped: true', () => {
    // A journey author who sets the reason on the gate path and forgets the flag has
    // half-declared a skip. Returning 'pass' here is exactly the skip-rendered-as-ok the
    // constraints forbid, so the ONE place that decides outcomes refuses the shape outright.
    expect(() => outcomeOf(result({ skipped: false, skipReason: 'plugin not active' })))
      .toThrow(/skipReason "plugin not active" without skipped: true/);
    expect(() => outcomeOf(result({ skipReason: 'plugin not active' })))
      .toThrow(/skipReason "plugin not active" without skipped: true/);
  });

  it('reports fail, not skip, when a skipped journey still hit a finding on the way to skipping', () => {
    // The gate probe itself 5xx-ing is a real failure of the CORE, not an absent plugin.
    expect(outcomeOf(result({
      skipped: true, skipReason: 'plugin not active',
      findings: [{ kind: 'response', status: 500, text: 'HTTP 500' }],
    }))).toBe('fail');
  });
});

function journey(name: string, actor: Actor = Actor.EDITOR, surface: SurfaceAxis = 'admin'): Journey {
  return { name, actor, surface, run: async () => result() };
}

describe('register', () => {
  it('keys journeys by name', () => {
    expect(Object.keys(register(journey('a', Actor.EDITOR, 'both')))).toEqual(['a']);
  });

  it('keeps registration order across several journeys', () => {
    const registry = register(journey('c'), journey('a'), journey('b'));
    expect(Object.keys(registry)).toEqual(['c', 'a', 'b']);
  });

  it('refuses two journeys with the same name rather than silently dropping one', () => {
    const a = journey('dup', Actor.EDITOR);
    const b = journey('dup', Actor.AUTHOR);
    expect(() => register(a, b)).toThrow(/duplicate journey name "dup"/);
  });

  it('accepts a journey whose name is a method inherited from Object.prototype', () => {
    // A plain `{}` accumulator would find `toString` already "present" and refuse it as a duplicate.
    const j = journey('toString');
    const registry = register(j);
    expect(Object.keys(registry)).toEqual(['toString']);
    expect(registry['toString']).toBe(j);
  });

  it('stores a journey named __proto__ as a real key rather than swapping the prototype', () => {
    // On a plain object `registry['__proto__'] = j` sets the prototype and the journey vanishes
    // from Object.keys — the silent drop the duplicate check exists to prevent.
    const j = journey('__proto__');
    const registry = register(j);
    expect(Object.keys(registry)).toEqual(['__proto__']);
    expect(registry['__proto__']).toBe(j);
  });
});
