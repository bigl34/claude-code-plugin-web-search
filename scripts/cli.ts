#!/usr/bin/env npx tsx
/**
 * Brave Search MCP CLI
 *
 * Zod-validated CLI for web and local search.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { BraveSearchMCPClient } from "./mcp-client.js";
import { fetchPage } from "./page-fetcher.js";

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: BraveSearchMCPClient) => {
      const tools = await client.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available MCP tools"
  ),

  "web-search": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      count: cliTypes.int(1, 20).optional().describe("Number of results (default: 10, max: 20)"),
      offset: cliTypes.int(0, 9).optional().describe("Pagination offset (max: 9)"),
    }),
    async (args, client: BraveSearchMCPClient) => {
      const { query, count, offset } = args as { query: string; count?: number; offset?: number };
      // Clamp offset to API max
      const clampedOffset = offset !== undefined && offset > 9 ? 9 : offset;
      if (offset !== undefined && offset > 9) {
        console.error("Warning: --offset max is 9, clamping value");
      }
      return client.webSearch(query, { count, offset: clampedOffset });
    },
    "Search the web"
  ),

  "local-search": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      count: cliTypes.int(1, 20).optional().describe("Number of results (default: 10, max: 20)"),
    }),
    async (args, client: BraveSearchMCPClient) => {
      const { query, count } = args as { query: string; count?: number };
      return client.localSearch(query, { count });
    },
    "Search for local businesses/places"
  ),

  "fetch-page": createCommand(
    z.object({
      url: z.string().url().describe("URL to fetch"),
      maxLength: cliTypes.int(0).optional().describe("Max content length (default: 20000, 0 = unlimited)"),
      selector: z.string().optional().describe("CSS selector to target specific content"),
      stripImages: cliTypes.bool().optional().describe("Strip image references from output"),
    }),
    async (args) => {
      const { url, maxLength, selector, stripImages } = args as {
        url: string; maxLength?: number; selector?: string; stripImages?: boolean;
      };
      return fetchPage(url, { maxLength, selector, stripImages });
    },
    "Fetch a web page and return clean markdown content"
  ),
};

// Run CLI with cleanup
runCli(commands, BraveSearchMCPClient, {
  programName: "brave-search-cli",
  description: "Brave Search web and local search, page fetching",
  cleanup: async (client: BraveSearchMCPClient) => client.disconnect(),
});
