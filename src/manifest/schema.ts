/**
 * Parse and validate `wp-journeys.json`.
 *
 * Every failure throws, naming the file and the specific problem. A manifest that is
 * silently ignored is the worst failure mode this project has: the author believes their
 * journeys ran, the summary shows nothing wrong, and nothing was ever tested.
 *
 * The same rule applies one level down: an unknown key, an empty step list, or a screen that
 * never names the journey's own actor would each produce a journey that runs, asserts nothing
 * and reports pass. They are refused here, by name and by index, rather than interpreted.
 */
import { ALL_ACTORS, type Actor } from '../actors/roles.ts';
import type { SurfaceAxis } from '../journeys/index.ts';
import { isSitePath } from '../site-path.ts';

export interface ManifestScreen {
  url: string;
  allow: Actor[];
  deny: Actor[];
}

export interface ManifestSetting {
  /** The admin screen carrying the field. */
  url: string;
  /** A CSS selector for the input to write. */
  field: string;
  /**
   * What to write. The interpreter appends a per-write suffix (`wpj-<8 hex>`), so the field
   * must accept the value plus nine characters, and the read-back proves THIS run's write.
   */
  value: string;
  /** A frontend URL where the written value must be absent before, and visible after. */
  readBack: string;
  /**
   * A CSS selector for the control that submits the form, clicked ONCE. Absent means press
   * Enter in the field, which submits an `<input>` inside a `<form>` and nothing else — first
   * contact's one visible setting was a `<textarea>`, where Enter only adds a newline.
   */
  submit?: string;
}

export interface ManifestJourney {
  name: string;
  actor: Actor;
  surface: SurfaceAxis;
  screens?: ManifestScreen[];
  settings?: ManifestSetting[];
  shortcodes?: string[];
  /**
   * Path of a TypeScript module default-exporting a Journey, relative to the directory the
   * manifest is in (which need not be the plugin root), and confined inside it.
   */
  module?: string;
}

export interface Manifest {
  version: 1;
  plugin: string;
  /**
   * The admin screen that proves the plugin is live (R76): a plugin page slug (served at
   * `admin.php?page=<slug>`) or a URL starting with `/`. The administrator must be served it
   * before any authored journey runs; if not, every one fails. Absent means no precondition.
   */
  gate?: { screen: string };
  /**
   * Surface the plugin deprecates on purpose (R74). A tag listed here renders on its own row, and
   * core's deprecation notice naming it is discounted there — and said so — rather than failing.
   */
  deprecated?: { shortcodes: string[] };
  journeys: ManifestJourney[];
}

const SURFACES: readonly SurfaceAxis[] = ['admin', 'frontend', 'both'];

/*
 * The accepted keys, exported so the authoring skill can be checked against them
 * (tests/skills-content.test.ts): a key the skill never mentions is one an author cannot find.
 */
/** `$schema` is for editor completion and `description` stands in for the comments JSON lacks. */
export const MANIFEST_KEYS = ['$schema', 'description', 'version', 'plugin', 'gate', 'deprecated', 'journeys'] as const;
export const GATE_KEYS = ['screen'] as const;
export const DEPRECATED_KEYS = ['shortcodes'] as const;
export const JOURNEY_KEYS = ['name', 'actor', 'surface', 'screens', 'settings', 'shortcodes', 'module'] as const;
export const SCREEN_KEYS = ['url', 'allow', 'deny'] as const;
export const SETTING_KEYS = ['url', 'field', 'value', 'readBack'] as const;
export const OPTIONAL_SETTING_KEYS = ['submit'] as const;

type Fail = (message: string) => never;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isActor(value: unknown): value is Actor {
  return ALL_ACTORS.includes(value as Actor);
}

/** Refuse any key the schema does not name: a typo silently dropped is a step silently skipped. */
function refuseUnknownKeys(object: Record<string, unknown>, known: readonly string[], fail: Fail): void {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) fail(`unknown key "${key}"`);
  }
}

/**
 * A manifest URL must be a path on the target site (R86), refused HERE rather than at visit time:
 * the runner navigates a logged-in browser to it, and signs it when it opens a render door.
 */
function confineToSite(url: string, where: string, fail: Fail): void {
  if (!isSitePath(url)) {
    fail(`${where} ${JSON.stringify(url)} is not a path on the target site — start it with exactly one "/"`);
  }
}

function parseActorList(raw: unknown, where: string, fail: Fail): Actor[] {
  if (!Array.isArray(raw)) return fail(`${where} must be an array of actors`);
  return raw.map((actor) => (isActor(actor) ? actor : fail(`${where}: unknown actor "${String(actor)}"`)));
}

function parseScreen(raw: unknown, index: number, actor: Actor, fail: Fail): ManifestScreen {
  const where = `screens[${index}]`;
  if (!isObject(raw)) return fail(`${where} is not an object`);
  refuseUnknownKeys(raw, SCREEN_KEYS, (message) => fail(`${where}: ${message}`));
  if (!isNonEmptyString(raw.url)) fail(`${where}.url must be a non-empty string`);
  confineToSite(raw.url as string, `${where}.url`, fail);
  const allow = parseActorList(raw.allow, `${where}.allow`, fail);
  const deny = parseActorList(raw.deny, `${where}.deny`, fail);

  // The journey has ONE actor. A screen that names it in neither list makes no assertion for
  // this journey at all, and one that names it in both cannot be satisfied — either way the
  // author meant something the interpreter cannot guess.
  const allowed = allow.includes(actor);
  const denied = deny.includes(actor);
  if (allowed && denied) fail(`${where} lists its actor "${actor}" in both "allow" and "deny"`);
  if (!allowed && !denied) {
    fail(`${where} lists its actor "${actor}" in neither "allow" nor "deny" — it would assert nothing`);
  }
  return { url: raw.url as string, allow, deny };
}

function parseSetting(raw: unknown, index: number, fail: Fail): ManifestSetting {
  const where = `settings[${index}]`;
  if (!isObject(raw)) return fail(`${where} is not an object`);
  refuseUnknownKeys(raw, [...SETTING_KEYS, ...OPTIONAL_SETTING_KEYS], (message) => fail(`${where}: ${message}`));
  for (const key of SETTING_KEYS) {
    if (!isNonEmptyString(raw[key])) fail(`${where}.${key} must be a non-empty string`);
  }
  confineToSite(raw.url as string, `${where}.url`, fail);
  confineToSite(raw.readBack as string, `${where}.readBack`, fail);
  // Present-but-empty is refused, not read as "use Enter": the author wrote the key.
  if (raw.submit !== undefined && !(typeof raw.submit === 'string' && raw.submit.trim() !== '')) {
    fail(`${where}.submit must be a non-empty string`);
  }
  const setting: ManifestSetting = {
    url: raw.url as string, field: raw.field as string, value: raw.value as string, readBack: raw.readBack as string,
  };
  if (raw.submit !== undefined) setting.submit = raw.submit as string;
  return setting;
}

/** A step list is either absent or a NON-EMPTY array: `[]` declares nothing, and must say so. */
function parseSteps<T>(raw: unknown, key: string, parse: (item: unknown, index: number) => T, fail: Fail): T[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return fail(`"${key}" must be an array`);
  return raw.map(parse);
}

function parseJourney(raw: unknown, index: number, fail: Fail, deprecated: readonly string[]): ManifestJourney {
  if (!isObject(raw)) return fail(`journeys[${index}] is not an object`);
  const name = raw.name;
  if (!isNonEmptyString(name)) return fail(`journeys[${index}] has no "name"`);

  const failNamed: Fail = (message) => fail(`journey "${name}": ${message}`);
  refuseUnknownKeys(raw, JOURNEY_KEYS, failNamed);

  const actor = raw.actor;
  if (!isActor(actor)) return failNamed(`unknown actor "${String(actor)}"`);
  const surface = raw.surface;
  if (!SURFACES.includes(surface as SurfaceAxis)) return failNamed(`unknown surface "${String(surface)}"`);

  const screens = parseSteps(raw.screens, 'screens', (item, i) => parseScreen(item, i, actor, failNamed), failNamed);
  const settings = parseSteps(raw.settings, 'settings', (item, i) => parseSetting(item, i, failNamed), failNamed);
  const shortcodes = parseSteps(raw.shortcodes, 'shortcodes', (item, i) => {
    if (!isNonEmptyString(item)) return failNamed(`shortcodes[${i}] must be a non-empty string`);
    // A declared tag's discount applies on its OWN row only (R80); rendered here, among other
    // steps, its notice could not be attributed and would fail this journey instead.
    if (deprecated.includes(item)) {
      return failNamed(`shortcodes[${i}] "${item}" is declared deprecated — the core suite renders it on its own row`);
    }
    return item;
  }, failNamed);
  const module = raw.module;
  if (module !== undefined && !isNonEmptyString(module)) failNamed('"module" must be a non-empty string');

  const steps = (screens?.length ?? 0) + (settings?.length ?? 0) + (shortcodes?.length ?? 0);
  const declaresSteps = screens !== undefined || settings !== undefined || shortcodes !== undefined;
  if (declaresSteps && module !== undefined) {
    // The module REPLACES the interpreted steps. Accepting both would run the module and drop
    // the steps without a word — an EMPTY list included: the author wrote the key.
    failNamed('"module" cannot be combined with screens, settings or shortcodes — the module replaces them');
  }
  if (steps === 0 && module === undefined) {
    // Reached by an absent list AND by an empty one: `screens: []` is not work either.
    fail(`journey "${name}" declares no screens, settings, shortcodes or module — it would do nothing`);
  }

  const journey: ManifestJourney = { name, actor, surface: surface as SurfaceAxis };
  if (screens) journey.screens = screens;
  if (settings) journey.settings = settings;
  if (shortcodes) journey.shortcodes = shortcodes;
  if (module !== undefined) journey.module = module as string;
  return journey;
}

export function parseManifest(raw: unknown, file: string): Manifest {
  const fail: Fail = (message) => {
    throw new Error(`${file}: ${message}`);
  };

  if (!isObject(raw)) return fail('not a JSON object');
  refuseUnknownKeys(raw, MANIFEST_KEYS, fail);

  if (raw.version !== 1) fail('"version" must be 1');
  if (!isNonEmptyString(raw.plugin)) fail('"plugin" must be a non-empty string');
  if (!Array.isArray(raw.journeys) || raw.journeys.length === 0) fail('"journeys" must be a non-empty array');

  let gate: Manifest['gate'];
  if (raw.gate !== undefined) {
    if (!isObject(raw.gate)) return fail('"gate" must be an object');
    refuseUnknownKeys(raw.gate, GATE_KEYS, (message) => fail(`"gate": ${message}`));
    if (!isNonEmptyString(raw.gate.screen)) return fail('"gate.screen" must be a non-empty string');
    gate = { screen: raw.gate.screen };
  }

  let deprecated: Manifest['deprecated'];
  if (raw.deprecated !== undefined) {
    if (!isObject(raw.deprecated)) return fail('"deprecated" must be an object');
    refuseUnknownKeys(raw.deprecated, DEPRECATED_KEYS, (message) => fail(`"deprecated": ${message}`));
    const tags = raw.deprecated.shortcodes;
    if (!Array.isArray(tags) || tags.length === 0) return fail('"deprecated.shortcodes" must be a non-empty array');
    const listed = new Set<string>();
    tags.forEach((tag, i) => {
      if (!isNonEmptyString(tag)) fail(`"deprecated.shortcodes[${i}]" must be a non-empty string`);
      if (listed.has(tag as string)) fail(`"deprecated.shortcodes" lists "${String(tag)}" twice`);
      listed.add(tag as string);
    });
    deprecated = { shortcodes: [...listed] };
  }

  const seen = new Set<string>();
  const journeys = (raw.journeys as unknown[]).map((entry, index) => {
    const journey = parseJourney(entry, index, fail, deprecated?.shortcodes ?? []);
    if (seen.has(journey.name)) fail(`duplicate journey name "${journey.name}"`);
    seen.add(journey.name);
    return journey;
  });

  const manifest: Manifest = { version: 1, plugin: raw.plugin as string, journeys };
  if (gate) manifest.gate = gate;
  if (deprecated) manifest.deprecated = deprecated;
  return manifest;
}
