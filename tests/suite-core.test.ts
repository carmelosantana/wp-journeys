import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import { accessMatrix } from '../src/suite/admin-access-matrix.ts';
import type { Surface } from '../src/discovery/types.ts';

const delta: Surface = {
  screens: [
    { slug: 'acme', url: '/wp-admin/admin.php?page=acme', capability: 'manage_options', title: 'Acme', parent: null },
    { slug: 'acme-public', url: '/wp-admin/admin.php?page=acme-public', capability: 'read', title: 'Public', parent: 'acme' },
  ],
  blocks: [], shortcodes: [], restRoutes: [],
  caps: {
    administrator: ['manage_options', 'read', 'edit_posts'],
    editor: ['read', 'edit_posts'],
    subscriber: ['read'],
  },
};

describe('accessMatrix', () => {
  it('expects a denial for every actor lacking the screen’s capability', () => {
    const cases = accessMatrix(delta, [Actor.ADMINISTRATOR, Actor.EDITOR, Actor.SUBSCRIBER]);

    const acme = cases.filter((c) => c.screen.slug === 'acme');
    expect(acme.find((c) => c.actor === Actor.ADMINISTRATOR)?.denyExpected).toBe(false);
    expect(acme.find((c) => c.actor === Actor.EDITOR)?.denyExpected).toBe(true);
    expect(acme.find((c) => c.actor === Actor.SUBSCRIBER)?.denyExpected).toBe(true);
  });

  it('expects everyone with `read` to reach a `read` screen', () => {
    const cases = accessMatrix(delta, [Actor.ADMINISTRATOR, Actor.EDITOR, Actor.SUBSCRIBER]);
    for (const c of cases.filter((x) => x.screen.slug === 'acme-public')) {
      expect(c.denyExpected, `${c.actor}`).toBe(false);
    }
  });

  it('always expects a denial for anonymous, which holds no capabilities at all', () => {
    const cases = accessMatrix(delta, [Actor.ANONYMOUS]);
    expect(cases).toHaveLength(2);
    expect(cases.every((c) => c.denyExpected)).toBe(true);
  });

  it('produces one case per screen per actor', () => {
    expect(accessMatrix(delta, [Actor.ADMINISTRATOR, Actor.EDITOR])).toHaveLength(4);
  });

  it('is empty when the plugin added no admin screens', () => {
    expect(accessMatrix({ ...delta, screens: [] }, [Actor.ADMINISTRATOR])).toEqual([]);
  });

  it('expects a denial for a role the site does not define at all', () => {
    // A role absent from the capability map holds nothing. Reading a missing entry as
    // "unrestricted" would turn every screen into an expected 200 for that actor, and a real
    // permission hole would pass.
    const cases = accessMatrix(delta, [Actor.CONTRIBUTOR]);
    expect(cases.every((c) => c.denyExpected)).toBe(true);
  });
});
