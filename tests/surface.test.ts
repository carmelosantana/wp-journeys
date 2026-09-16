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
    // add_submenu_page() links the parent back to itself as the FIRST submenu row, so every
    // real $submenu carries one. These fixtures carry it too, or they would model a shape
    // WordPress does not actually produce.
    acme: [['Acme', 'manage_options', 'acme'], ['Settings', 'manage_options', 'acme-settings']],
  },
  blocks: ['acme/hero', 'core/paragraph'],
  shortcodes: ['acme_list', 'gallery'],
  routes: {
    '/acme/v1/items': { methods: ['GET', 'POST'], guarded: true },
    '/acme/v1/open': { methods: ['GET'], guarded: false },
  },
  roles: { administrator: ['manage_options', 'read'], subscriber: ['read'] },
  // WordPress's plugin-page registry ($_parent_pages): which slugs are served by ?page=.
  pluginPages: ['acme', 'acme-settings'],
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
      submenu: {
        'edit.php?post_type=acme': [
          ['All Items', 'edit_posts', 'edit.php?post_type=acme'],
          ['Add New', 'edit_posts', 'post-new.php?post_type=acme'],
        ],
      },
    });

    expect(surface.screens.map((s) => s.url)).toEqual([
      '/wp-admin/edit.php?post_type=acme',
      '/wp-admin/post-new.php?post_type=acme',
    ]);
  });

  it('hangs a plugin page under a core parent off the parent file, not admin.php', () => {
    // add_options_page() pages are linked by WordPress's own menu at options-general.php?page=.
    const surface = projectSurface({
      ...raw,
      pluginPages: ['acme-options'],
      menu: [['Settings', 'manage_options', 'options-general.php']],
      submenu: {
        'options-general.php': [
          ['General', 'manage_options', 'options-general.php'],
          ['Acme Options', 'manage_options', 'acme-options'],
          ['Writing', 'manage_options', 'options-writing.php'],
        ],
      },
    });

    expect(surface.screens.map((s) => s.url)).toEqual([
      '/wp-admin/options-general.php',
      '/wp-admin/options-general.php?page=acme-options',
      '/wp-admin/options-writing.php',
    ]);
  });

  it('joins page= with & when the core parent already carries a query', () => {
    const surface = projectSurface({
      ...raw,
      menu: [['Acme Items', 'edit_posts', 'edit.php?post_type=acme']],
      submenu: {
        'edit.php?post_type=acme': [
          ['All Items', 'edit_posts', 'edit.php?post_type=acme'],
          ['Report', 'edit_posts', 'acme-report'],
        ],
      },
      pluginPages: ['acme-report'],
    });

    expect(surface.screens.map((s) => s.url)).toEqual([
      '/wp-admin/edit.php?post_type=acme',
      '/wp-admin/edit.php?post_type=acme&page=acme-report',
    ]);
  });

  it('keeps a page under a plugin top-level menu on admin.php?page=', () => {
    const surface = projectSurface(raw);
    expect(surface.screens.find((s) => s.slug === 'acme-settings')?.url).toBe(
      '/wp-admin/admin.php?page=acme-settings',
    );
  });

  describe('decides "plugin page?" by WordPress\'s registry, not by a .php suffix', () => {
    // A __FILE__ slug: add_menu_page() runs plugin_basename() on it, so it ends in .php yet is
    // a plugin page. Only pluginPages ($_parent_pages) can tell it from a core screen.
    const registry: RawRegistries = {
      ...raw,
      menu: [
        ['File Plugin', 'manage_options', 'myplugin/myplugin.php'],
        ['Acme', 'manage_options', 'acme'],
        ['Settings', 'manage_options', 'options-general.php'],
        ['Acme Items', 'edit_posts', 'edit.php?post_type=acme'],
      ],
      submenu: {
        'myplugin/myplugin.php': [
          ['File Plugin', 'manage_options', 'myplugin/myplugin.php'],
          ['Child', 'manage_options', 'myplugin-child'],
        ],
        acme: [
          ['Reports', 'manage_options', 'acme/reports.php'],
          ['Items', 'edit_posts', 'edit.php?post_type=acme_item'],
        ],
        'options-general.php': [
          ['Acme Options', 'manage_options', 'acme/options.php'],
          ['Writing', 'manage_options', 'options-writing.php'],
        ],
      },
      pluginPages: ['myplugin/myplugin.php', 'myplugin-child', 'acme', 'acme/reports.php', 'acme/options.php'],
    };
    const urlOf = (slug: string) => projectSurface(registry).screens.find((s) => s.slug === slug)?.url;

    it('a __FILE__-style top-level plugin page goes to admin.php?page=', () => {
      expect(urlOf('myplugin/myplugin.php')).toBe('/wp-admin/admin.php?page=myplugin/myplugin.php');
    });
    it('a child of a __FILE__-style plugin page goes to admin.php?page=', () => {
      expect(urlOf('myplugin-child')).toBe('/wp-admin/admin.php?page=myplugin-child');
    });
    it('a plugin page under a plugin top-level goes to admin.php?page=, even with a .php slug', () => {
      expect(urlOf('acme/reports.php')).toBe('/wp-admin/admin.php?page=acme/reports.php');
    });
    it('a plugin page under a core parent goes under the parent file, even with a .php slug', () => {
      expect(urlOf('acme/options.php')).toBe('/wp-admin/options-general.php?page=acme/options.php');
    });
    it('a core submenu is its own path, even under a plugin top-level', () => {
      expect(urlOf('options-writing.php')).toBe('/wp-admin/options-writing.php');
      expect(urlOf('edit.php?post_type=acme_item')).toBe('/wp-admin/edit.php?post_type=acme_item');
    });
    it('a core screen with a query is its own path', () => {
      expect(urlOf('edit.php?post_type=acme')).toBe('/wp-admin/edit.php?post_type=acme');
    });
  });

  describe('a container menu takes its first submenu’s URL (R28)', () => {
    // A "container" is a top-level menu registered with no callback of its own. Nothing serves
    // /wp-admin/<slug> for it, so projecting it there reports a 404 against the plugin under
    // test. WordPress promotes such a menu to its first submenu when that submenu carries a
    // DIFFERENT slug — wp-admin/includes/menu.php's `$new_parent !== $old_parent` — and its
    // rendered menu links the item there. Verified live on WP 7.1: the admin menu links the
    // fixture's container at admin.php?page=wpj-fixture-container-home, which answers 200,
    // while /wp-admin/wpj-fixture-container answers 404.
    const container: RawRegistries = {
      ...raw,
      menu: [['Acme', 'manage_options', 'acme-container']],
      submenu: { 'acme-container': [['Home', 'manage_options', 'acme-home']] },
      pluginPages: ['acme-home'],
    };

    it('sends the container to its first submenu, not to its own unserved slug', () => {
      expect(projectSurface(container).screens[0]?.url).toBe('/wp-admin/admin.php?page=acme-home');
    });

    it('keeps the container’s own slug, capability and title — only the URL moves', () => {
      expect(projectSurface(container).screens[0]).toEqual({
        slug: 'acme-container', url: '/wp-admin/admin.php?page=acme-home',
        capability: 'manage_options', title: 'Acme', parent: null,
      });
    });

    it('leaves a top-level item with no submenus at its own URL', () => {
      const alone = projectSurface({ ...container, submenu: {} });
      expect(alone.screens[0]?.url).toBe('/wp-admin/acme-container');
    });

    it('leaves a top-level item whose first submenu links back to itself', () => {
      // The mirror row add_submenu_page() creates. Core promotes nothing here, because the
      // first submenu's slug IS the parent's, and neither does the projection.
      expect(projectSurface(raw).screens.find((s) => s.slug === 'acme')?.url)
        .toBe('/wp-admin/admin.php?page=acme');
    });
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
      menu: [], submenu: {}, blocks: [], shortcodes: [], routes: {}, roles: {}, pluginPages: [],
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
      pluginPages: [],
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
