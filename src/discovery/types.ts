/** One reachable wp-admin screen, with the capability WordPress gates it behind. */
export interface AdminScreen {
  slug: string;
  url: string;
  capability: string;
  title: string;
  /** The parent menu slug for a submenu item; `null` for a top-level menu. */
  parent: string | null;
}

/** One registered REST route. `guarded` is false when its permission callback is `__return_true`. */
export interface RestRoute {
  route: string;
  methods: string[];
  guarded: boolean;
}

/** Everything the runner knows how to drive, derived from WordPress's own registries. */
export interface Surface {
  screens: AdminScreen[];
  blocks: string[];
  shortcodes: string[];
  restRoutes: RestRoute[];
  /** role name -> capability names. */
  caps: Record<string, string[]>;
}

/** The raw registry dump the agent's `discover` action returns, before projection. */
export interface RawRegistries {
  /** WordPress `$menu`: positional rows where [0]=title, [1]=capability, [2]=slug. */
  menu: unknown[][];
  /** WordPress `$submenu`: parent slug -> rows in the same positional shape. */
  submenu: Record<string, unknown[][]>;
  blocks: string[];
  shortcodes: string[];
  routes: Record<string, { methods: string[]; guarded: boolean }>;
  roles: Record<string, string[]>;
  /**
   * WordPress's plugin-page registry: the `$_parent_pages` slugs WordPress serves by `?page=`
   * (the ones its own menu links that way). Decides "plugin page or core screen?" — a `.php`
   * suffix cannot, since a page registered with `__FILE__` is `myplugin/myplugin.php`.
   */
  pluginPages: string[];
}
