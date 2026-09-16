import { describe, expect, it } from 'vitest';

import { parseManifest } from '../src/manifest/schema.ts';

const valid = {
  version: 1,
  plugin: 'acme',
  gate: { screen: 'acme' },
  journeys: [
    {
      name: 'acme-settings-round-trip',
      actor: 'administrator',
      surface: 'both',
      settings: [
        { url: '/wp-admin/admin.php?page=acme', field: '#acme_title', value: 'Hello', readBack: '/' },
      ],
    },
    { name: 'acme-custom', actor: 'editor', surface: 'admin', module: 'tests/journeys/acme-custom.ts' },
  ],
};

/** `valid` with its first journey replaced by `journey`. */
function withJourney(journey: Record<string, unknown>) {
  return { ...valid, journeys: [journey] };
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest(valid, 'wp-journeys.json').plugin).toBe('acme');
  });

  it('names the file and the problem when the version is missing', () => {
    expect(() => parseManifest({ plugin: 'acme', journeys: [] }, 'acme/wp-journeys.json'))
      .toThrow(/acme\/wp-journeys\.json: "version" must be 1/);
  });

  it('rejects an unknown version rather than guessing', () => {
    expect(() => parseManifest({ ...valid, version: 2 }, 'f.json')).toThrow(/"version" must be 1/);
  });

  it('rejects an unknown actor by name', () => {
    const bad = { ...valid, journeys: [{ ...valid.journeys[0], actor: 'superadmin' }] };
    expect(() => parseManifest(bad, 'f.json')).toThrow(/unknown actor "superadmin"/);
  });

  it('rejects an unknown surface', () => {
    const bad = { ...valid, journeys: [{ ...valid.journeys[0], surface: 'sideways' }] };
    expect(() => parseManifest(bad, 'f.json')).toThrow(/unknown surface "sideways"/);
  });

  it('rejects a journey with neither steps nor a module — it would silently do nothing', () => {
    const bad = { ...valid, journeys: [{ name: 'empty', actor: 'editor', surface: 'admin' }] };
    expect(() => parseManifest(bad, 'f.json'))
      .toThrow(/journey "empty" declares no screens, settings, shortcodes or module/);
  });

  it('rejects duplicate journey names', () => {
    const bad = { ...valid, journeys: [valid.journeys[0], valid.journeys[0]] };
    expect(() => parseManifest(bad, 'f.json')).toThrow(/duplicate journey name/);
  });

  it('rejects a non-object entirely', () => {
    expect(() => parseManifest(null, 'f.json')).toThrow(/f\.json: not a JSON object/);
  });

  it('rejects an EMPTY step list as declaring nothing — [] is not work', () => {
    // `screens: []` is an array, so an "is it an array" check reads it as work. The journey
    // would then visit nothing, assert nothing and report pass.
    expect(() => parseManifest(withJourney({ name: 'empty', actor: 'editor', surface: 'admin', screens: [] }), 'f.json'))
      .toThrow(/journey "empty" declares no screens, settings, shortcodes or module/);
  });

  it('rejects a manifest with no journeys at all', () => {
    expect(() => parseManifest({ ...valid, journeys: [] }, 'f.json')).toThrow(/f\.json: "journeys" must be a non-empty array/);
  });

  it('rejects a module combined with steps — the module would silently replace them', () => {
    const bad = withJourney({ ...valid.journeys[0], module: 'x.ts' });
    expect(() => parseManifest(bad, 'f.json'))
      .toThrow(/journey "acme-settings-round-trip": "module" cannot be combined with screens, settings or shortcodes/);
  });

  describe('unknown keys are refused, naming the key and where it is', () => {
    // A typo — `readback` for `readBack`, `screen` for `screens` — must not be quietly dropped.
    it('at the top level', () => {
      expect(() => parseManifest({ ...valid, gates: {} }, 'f.json')).toThrow(/f\.json: unknown key "gates"/);
    });

    it('on a journey', () => {
      const bad = withJourney({ ...valid.journeys[0], shortcode: ['acme'] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "acme-settings-round-trip": unknown key "shortcode"/);
    });

    it('on a setting', () => {
      const setting = { url: '/wp-admin/admin.php?page=acme', field: '#t', value: 'v', readback: '/' };
      const bad = withJourney({ name: 's', actor: 'administrator', surface: 'both', settings: [setting] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": settings\[0\]: unknown key "readback"/);
    });

    it('on a screen', () => {
      const screen = { url: '/wp-admin/admin.php?page=acme', allow: ['editor'], deny: [], denied: [] };
      const bad = withJourney({ name: 's', actor: 'editor', surface: 'admin', screens: [screen] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": screens\[0\]: unknown key "denied"/);
    });
  });

  describe('screens', () => {
    const screen = (over: Record<string, unknown>) => withJourney({
      name: 's', actor: 'editor', surface: 'admin',
      screens: [{ url: '/wp-admin/admin.php?page=acme', allow: [], deny: ['editor'], ...over }],
    });

    it('accepts a screen that denies the journey actor', () => {
      expect(parseManifest(screen({}), 'f.json').journeys[0]?.screens?.[0]?.deny).toEqual(['editor']);
    });

    it('rejects a screen that names the journey actor in NEITHER list — it would assert nothing', () => {
      // A screen block naming only other actors makes no assertion for this journey, and a
      // journey whose every screen is like that visits nothing and passes.
      expect(() => parseManifest(screen({ deny: ['subscriber'] }), 'f.json'))
        .toThrow(/journey "s": screens\[0\] lists its actor "editor" in neither "allow" nor "deny" — it would assert nothing/);
    });

    it('rejects a screen that names the journey actor in BOTH lists', () => {
      expect(() => parseManifest(screen({ allow: ['editor'] }), 'f.json'))
        .toThrow(/journey "s": screens\[0\] lists its actor "editor" in both "allow" and "deny"/);
    });

    it('rejects an unknown actor inside allow or deny', () => {
      expect(() => parseManifest(screen({ allow: ['superadmin'] }), 'f.json'))
        .toThrow(/journey "s": screens\[0\]\.allow: unknown actor "superadmin"/);
    });

    it('rejects a screen without a url', () => {
      expect(() => parseManifest(screen({ url: '' }), 'f.json'))
        .toThrow(/journey "s": screens\[0\]\.url must be a non-empty string/);
    });

    it('rejects a screen whose allow is not an array', () => {
      expect(() => parseManifest(screen({ allow: 'editor' }), 'f.json'))
        .toThrow(/journey "s": screens\[0\]\.allow must be an array of actors/);
    });
  });

  describe('settings', () => {
    it('rejects a setting missing any of its four fields', () => {
      const bad = withJourney({
        name: 's', actor: 'administrator', surface: 'both',
        settings: [{ url: '/wp-admin/admin.php?page=acme', field: '#t', value: 'v' }],
      });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": settings\[0\]\.readBack must be a non-empty string/);
    });

    it('rejects a setting that is not an object', () => {
      const bad = withJourney({ name: 's', actor: 'administrator', surface: 'both', settings: ['x'] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": settings\[0\] is not an object/);
    });
  });

  describe('shortcodes', () => {
    it('rejects a shortcode that is not a non-empty string', () => {
      const bad = withJourney({ name: 's', actor: 'administrator', surface: 'both', shortcodes: ['acme', ''] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": shortcodes\[1\] must be a non-empty string/);
    });
  });

  describe('gate', () => {
    it('is optional', () => {
      const { gate: _gate, ...without } = valid;
      expect(parseManifest(without, 'f.json').gate).toBeUndefined();
    });

    it('must carry a non-empty screen slug when present', () => {
      expect(() => parseManifest({ ...valid, gate: { screen: '' } }, 'f.json'))
        .toThrow(/f\.json: "gate\.screen" must be a non-empty string/);
      expect(() => parseManifest({ ...valid, gate: 'acme' }, 'f.json'))
        .toThrow(/f\.json: "gate" must be an object/);
    });

    it('refuses an unknown key', () => {
      expect(() => parseManifest({ ...valid, gate: { screen: 'acme', slug: 'acme' } }, 'f.json'))
        .toThrow(/f\.json: "gate": unknown key "slug"/);
    });
  });

  it('rejects a journey that is not an object, by index', () => {
    expect(() => parseManifest({ ...valid, journeys: ['x'] }, 'f.json')).toThrow(/journeys\[0\] is not an object/);
  });

  it('rejects a journey with no name, by index', () => {
    expect(() => parseManifest(withJourney({ actor: 'editor', surface: 'admin', shortcodes: ['a'] }), 'f.json'))
      .toThrow(/journeys\[0\] has no "name"/);
  });

  it('rejects a non-string plugin', () => {
    expect(() => parseManifest({ ...valid, plugin: '' }, 'f.json')).toThrow(/"plugin" must be a non-empty string/);
  });

  it('rejects an empty module path', () => {
    expect(() => parseManifest(withJourney({ name: 'm', actor: 'editor', surface: 'admin', module: '' }), 'f.json'))
      .toThrow(/journey "m": "module" must be a non-empty string/);
  });
});
