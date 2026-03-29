/**
 * Shared tool and resource registration for the MCP server.
 * Used by both the local stdio server (index.ts) and the remote Worker (mcp-worker).
 *
 * This re-exports the server creation and registration so both entry points
 * can share the same tool definitions.
 */

export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { initSupabase } from './supabase.js';
export { initEmbeddings } from './embeddings.js';

/**
 * Create and configure a fully-registered MCP server instance.
 * All tools and resources are registered on the returned server.
 */
export async function createConfiguredServer(): Promise<import('@modelcontextprotocol/sdk/server/mcp.js').McpServer> {
  // Dynamic import to avoid circular dependencies and ensure
  // env vars are initialized before module-level code runs
  const mod = await import('./index.js');
  return mod.getServer();
}
