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

/**
 * A slug whose path ends in `.php` is a core screen reachable at its own path, query string
 * and all (`edit.php?post_type=acme`); anything else is a plugin page hung off
 * `admin.php?page=`. Getting this wrong sends every plugin screen to a 404 — which is
 * caught ONLY because `classifyNavigation` (Task 9) treats a non-2xx main document as a
 * defect. The subresource policy would let it pass green.
 */
function urlFor(slug: string): string {
  const path = slug.split('?')[0] ?? slug;
  return path.endsWith('.php') ? `/wp-admin/${slug}` : `/wp-admin/admin.php?page=${slug}`;
}

export function projectSurface(raw: RawRegistries): Surface {
  const screens: AdminScreen[] = [];

  for (const row of raw.menu) {
    const parsed = readRow(row);
    if (!parsed) continue;
    screens.push({ ...parsed, url: urlFor(parsed.slug), parent: null });
    for (const child of raw.submenu[parsed.slug] ?? []) {
      const sub = readRow(child);
      // add_submenu_page() mirrors the parent into its own submenu as a link back to itself:
      // the same screen again, so projecting it would double every plugin's top-level page.
      if (!sub || sub.slug === parsed.slug) continue;
      screens.push({ ...sub, url: urlFor(sub.slug), parent: parsed.slug });
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
