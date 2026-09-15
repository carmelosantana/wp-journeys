import { describe, expect, it } from 'vitest';

import { projectSurface, surfaceDelta } from '../src/discovery/surface.ts';
import type { RawRegistries } from '../src/discovery/types.ts';

const raw: RawRegistries = {
  // WordPress's $menu rows are positional: [0]=title, [1]=capability, [2]=slug.
  menu: [
    ['Dashboard', 'read', 'index.php'],
    ['Acme', 'manage_options', 'acme'],
  ],
  submenu: {
    acme: [['Settings', 'manage_options', 'acme-settings']],
  },
  blocks: ['acme/hero', 'core/paragraph'],
  shortcodes: ['acme_list', 'gallery'],
  routes: {
    '/acme/v1/items': { methods: ['GET', 'POST'], guarded: true },
    '/acme/v1/open': { methods: ['GET'], guarded: false },
  },
  roles: { administrator: ['manage_options', 'read'], subscriber: ['read'] },
};

describe('projectSurface', () => {
  it('projects top-level menus, submenus, and their capabilities', () => {
    const surface = projectSurface(raw);

    expect(surface.screens).toEqual([
      { slug: 'index.php', url: '/wp-admin/index.php', capability: 'read', title: 'Dashboard', parent: null },
      { slug: 'acme', url: '/wp-admin/admin.php?page=acme', capability: 'manage_options', title: 'Acme', parent: null },
      { slug: 'acme-settings', url: '/wp-admin/admin.php?page=acme-settings', capability: 'manage_options', title: 'Settings', parent: 'acme' },
    ]);
  });

  it('keeps a core .php screen as a direct path but a page slug as a query arg', () => {
    const surface = projectSurface(raw);
    expect(surface.screens[0]?.url).toBe('/wp-admin/index.php');
    expect(surface.screens[1]?.url).toBe('/wp-admin/admin.php?page=acme');
  });

  it('carries blocks, shortcodes, routes and caps through', () => {
    const surface = projectSurface(raw);
    expect(surface.blocks).toEqual(['acme/hero', 'core/paragraph']);
    expect(surface.shortcodes).toEqual(['acme_list', 'gallery']);
    expect(surface.restRoutes).toEqual([
      { route: '/acme/v1/items', methods: ['GET', 'POST'], guarded: true },
      { route: '/acme/v1/open', methods: ['GET'], guarded: false },
    ]);
    expect(surface.caps.administrator).toEqual(['manage_options', 'read']);
  });

  it('drops the row WordPress mirrors into a submenu to link back to its own parent', () => {
    // add_submenu_page() copies the parent into $submenu as its first row. That row is the
    // parent screen again, same slug and URL, not a second screen.
    const surface = projectSurface({
      ...raw,
      submenu: { acme: [['Acme', 'manage_options', 'acme'], ['Settings', 'manage_options', 'acme-settings']] },
    });

    expect(surface.screens.map((s) => [s.slug, s.parent])).toEqual([
      ['index.php', null],
      ['acme', null],
      ['acme-settings', 'acme'],
    ]);
  });

  it('keeps a .php screen that carries a query string as a direct path', () => {
    // A custom post type's screens are `edit.php?post_type=acme` and
    // `post-new.php?post_type=acme`; hanging them off admin.php?page= is a 404.
    const surface = projectSurface({
      ...raw,
      menu: [['Acme Items', 'edit_posts', 'edit.php?post_type=acme']],
      submenu: { 'edit.php?post_type=acme': [['Add New', 'edit_posts', 'post-new.php?post_type=acme']] },
    });

    expect(surface.screens.map((s) => s.url)).toEqual([
      '/wp-admin/edit.php?post_type=acme',
      '/wp-admin/post-new.php?post_type=acme',
    ]);
  });

  it('skips menu separators, which are not screens', () => {
    // WordPress keeps or drops a trailing separator depending on what sorts after it, so a
    // separator projected as a screen flips in and out of the delta with the plugin.
    const surface = projectSurface({
      ...raw,
      menu: [
        ['Dashboard', 'read', 'index.php', '', 'menu-top menu-icon-dashboard'],
        ['', 'read', 'separator-last', '', 'wp-menu-separator'],
      ],
    });

    expect(surface.screens.map((s) => s.slug)).toEqual(['index.php']);
  });

  it('tolerates a registry the host shipped empty rather than throwing', () => {
    const surface = projectSurface({
      menu: [], submenu: {}, blocks: [], shortcodes: [], routes: {}, roles: {},
    });
    expect(surface.screens).toEqual([]);
    expect(surface.blocks).toEqual([]);
  });
});

describe('surfaceDelta', () => {
  it('returns only what the plugin added, never what the site already had', () => {
    const before = projectSurface({
      menu: [['Dashboard', 'read', 'index.php']],
      submenu: {},
      blocks: ['core/paragraph'],
      shortcodes: ['gallery'],
      routes: { '/wp/v2/posts': { methods: ['GET'], guarded: false } },
      roles: { administrator: ['manage_options', 'read'], subscriber: ['read'] },
    });
    const after = projectSurface(raw);

    const delta = surfaceDelta(before, after);

    expect(delta.screens.map((s) => s.slug)).toEqual(['acme', 'acme-settings']);
    expect(delta.blocks).toEqual(['acme/hero']);
    expect(delta.shortcodes).toEqual(['acme_list']);
    expect(delta.restRoutes.map((r) => r.route)).toEqual(['/acme/v1/items', '/acme/v1/open']);
  });

  it('reports capabilities the plugin added to an existing role', () => {
    const before = projectSurface({ ...raw, roles: { administrator: ['read'], subscriber: ['read'] } });
    const after = projectSurface({ ...raw, roles: { administrator: ['read', 'manage_acme'], subscriber: ['read'] } });

    expect(surfaceDelta(before, after).caps).toEqual({ administrator: ['manage_acme'] });
  });

  it('is empty when the plugin added nothing at all', () => {
    const delta = surfaceDelta(projectSurface(raw), projectSurface(raw));
    expect(delta.screens).toEqual([]);
    expect(delta.blocks).toEqual([]);
    expect(delta.caps).toEqual({});
  });
});
