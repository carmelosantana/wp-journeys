/**
 * Turn WordPress's raw registries into a Surface the runner can drive, and diff two
 * Surfaces so only what a plugin ADDED is ever attributed to it.
 *
 * Pure: no I/O, no browser, no clock. Every decision the runner makes about what to visit
 * is made here, which is why this is the file the unit tests lean on hardest.
 */

import type { AdminScreen, RawRegistries, RestRoute, Surface } from './types.ts';

/**
 * A `$menu`/`$submenu` row is positional; read it defensively — hosts do ship odd rows.
 * A separator is a row too, marked by the `wp-menu-separator` class in [4] (the test core
 * itself uses); it is not a screen.
 */
function readRow(row: unknown[]): { title: string; capability: string; slug: string } | null {
  const title = typeof row[0] === 'string' ? row[0] : '';
  const capability = typeof row[1] === 'string' ? row[1] : '';
  const slug = typeof row[2] === 'string' ? row[2] : '';
  if (slug === '') return null;
  if (typeof row[4] === 'string' && row[4].includes('wp-menu-separator')) return null;
  return { title, capability, slug };
}

/** Whether a menu slug names a `.php` file (`options-general.php`, `edit.php?post_type=x`). */
function isPhpFile(slug: string): boolean {
  return (slug.split('?')[0] ?? slug).endsWith('.php');
}

/**
 * Where WordPress serves a screen. "Is this a plugin page?" is decided by WordPress's own
 * registry (`pluginPages`), never by a `.php` suffix: a plugin page registered with `__FILE__`
 * as its slug is `myplugin/myplugin.php`, which ends in `.php` yet is served by `?page=`.
 * - A top-level plugin page is `/wp-admin/admin.php?page=<slug>`. Any other top-level slug is
 *   a core screen at its own path, query string and all (`edit.php?post_type=x`).
 * - A submenu plugin page whose parent is a core file (a `.php` parent that is not itself a
 *   plugin page) is `/wp-admin/<parent>?page=<slug>`, or `&page=` when the parent carries a
 *   query: the URL WordPress's own menu links it at. Under any other parent it is
 *   `/wp-admin/admin.php?page=<slug>`.
 * - A submenu slug that is not a plugin page is a core screen at its own path.
 * A wrong URL here sends a screen to a 404, caught ONLY because `classifyNavigation` (Task 9)
 * treats a non-2xx main document as a defect.
 */
function urlFor(slug: string, parent: string | null, pluginPages: ReadonlySet<string>): string {
  if (!pluginPages.has(slug)) return `/wp-admin/${slug}`;
  if (parent !== null && !pluginPages.has(parent) && isPhpFile(parent)) {
    return `/wp-admin/${parent}${parent.includes('?') ? '&' : '?'}page=${slug}`;
  }
  return `/wp-admin/admin.php?page=${slug}`;
}

export function projectSurface(raw: RawRegistries): Surface {
  const screens: AdminScreen[] = [];
  const pluginPages = new Set(raw.pluginPages);

  for (const row of raw.menu) {
    const parsed = readRow(row);
    if (!parsed) continue;
    screens.push({ ...parsed, url: urlFor(parsed.slug, null, pluginPages), parent: null });
    for (const child of raw.submenu[parsed.slug] ?? []) {
      const sub = readRow(child);
      // add_submenu_page() mirrors the parent into its own submenu as a link back to itself:
      // the same screen again, so projecting it would double every plugin's top-level page.
      if (!sub || sub.slug === parsed.slug) continue;
      screens.push({ ...sub, url: urlFor(sub.slug, parsed.slug, pluginPages), parent: parsed.slug });
    }
  }

  const restRoutes: RestRoute[] = Object.entries(raw.routes).map(([route, meta]) => ({
    route,
    methods: meta.methods,
    guarded: meta.guarded,
  }));

  return {
    screens,
    blocks: [...raw.blocks],
    shortcodes: [...raw.shortcodes],
    restRoutes,
    caps: Object.fromEntries(Object.entries(raw.roles).map(([role, caps]) => [role, [...caps]])),
  };
}

/**
 * What `after` has that `before` did not. This is the ONLY thing attributable to the plugin
 * under test: a site's other plugins and its theme register screens, blocks and routes too,
 * and blaming those on the plugin being tested is a false finding.
 */
export function surfaceDelta(before: Surface, after: Surface): Surface {
  const hadScreen = new Set(before.screens.map((s) => s.slug));
  const hadRoute = new Set(before.restRoutes.map((r) => r.route));
  const hadBlock = new Set(before.blocks);
  const hadShortcode = new Set(before.shortcodes);

  const caps: Record<string, string[]> = {};
  for (const [role, list] of Object.entries(after.caps)) {
    const had = new Set(before.caps[role] ?? []);
    const added = list.filter((c) => !had.has(c));
    if (added.length > 0) caps[role] = added;
  }

  return {
    screens: after.screens.filter((s) => !hadScreen.has(s.slug)),
    blocks: after.blocks.filter((b) => !hadBlock.has(b)),
    shortcodes: after.shortcodes.filter((s) => !hadShortcode.has(s)),
    restRoutes: after.restRoutes.filter((r) => !hadRoute.has(r.route)),
    caps,
  };
}
