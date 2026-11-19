/**
 * Boundary rules, enforced at lint time rather than by review.
 * The dependency direction is one-way: apps → daemon → packages → protocol.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'renderer-never-touches-store',
      severity: 'error',
      comment:
        'The renderer sends commands to the daemon. It never opens the schema, the MCP client or the publisher.',
      from: { path: '^apps/web' },
      to: { path: '^packages/(store|daemon|mcp|publish|ai)' },
    },
    {
      name: 'ai-is-a-service-not-a-layer',
      severity: 'error',
      comment:
        'The model side talks to HTTP APIs and the protocol. It reads no database, runs no domain command, and is called only by the daemon (or the eval runner).',
      from: { path: '^packages/ai' },
      to: { path: '^packages/(store|publish|core|mcp)' },
    },
    {
      name: 'core-is-pure',
      severity: 'error',
      comment:
        'Core has no Node built-ins: no fs, no http, no clock. Time and ids arrive as arguments.',
      from: { path: '^packages/core/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'mcp-knows-no-schema',
      severity: 'error',
      comment: 'MCP results are data. The MCP layer must not reach into the store.',
      from: { path: '^packages/mcp' },
      to: { path: '^packages/store' },
    },
    {
      name: 'publish-knows-no-schema',
      severity: 'error',
      comment:
        'The publisher copies a spec; it never reads the store. The daemon passes it records through a port.',
      from: { path: '^packages/publish' },
      to: { path: '^packages/store' },
    },
    {
      name: 'protocol-has-no-deps',
      severity: 'error',
      comment: 'Protocol depends on zod and nothing else — not even on our own packages.',
      from: { path: '^packages/protocol/src' },
      to: { pathNot: '^packages/protocol|^zod$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)node_modules/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
