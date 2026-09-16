import { describe, expect, it } from 'vitest';

import { TOOLS, describeTools } from '../src/mcp/tools.ts';

describe('the MCP tool surface', () => {
  it('exposes exactly the seven tools the spec names', () => {
    expect(Object.keys(TOOLS).sort()).toEqual([
      'discover_surface', 'drain_sentinel', 'login_as', 'navigate',
      'read_page', 'run_journey', 'status',
    ]);
  });

  it('gives every tool a description and a JSON schema', () => {
    for (const [name, tool] of Object.entries(TOOLS)) {
      expect(tool.description, name).toBeTruthy();
      expect(tool.inputSchema.type, name).toBe('object');
    }
  });

  it('requires an actor for login_as and constrains it to the six', () => {
    expect(TOOLS.login_as?.inputSchema.required).toEqual(['actor']);
    expect(TOOLS.login_as?.inputSchema.properties.actor?.enum).toHaveLength(6);
  });

  it('renders a stable listing for the protocol handshake', () => {
    expect(describeTools()).toEqual(describeTools());
    expect(describeTools()[0]).toHaveProperty('name');
  });

  // R88 amends the brief: the core suite cannot be built without the plugin slug.
  it('requires a name AND a plugin for run_journey', () => {
    expect(TOOLS.run_journey?.inputSchema.required).toEqual(['name', 'plugin']);
    expect(TOOLS.run_journey?.inputSchema.properties.plugin?.type).toBe('string');
  });

  it('says out loud that run_journey deactivates and reactivates the plugin, and refuses lifecycle (R88)', () => {
    const description = TOOLS.run_journey?.description ?? '';
    expect(description).toMatch(/deactivates/);
    expect(description).toMatch(/reactivates/);
    expect(description).toMatch(/lifecycle/);
  });

  it('takes an optional boolean expect_denied on navigate (R86)', () => {
    expect(TOOLS.navigate?.inputSchema.required).toEqual(['path']);
    expect(TOOLS.navigate?.inputSchema.properties.expect_denied?.type).toBe('boolean');
  });
});
