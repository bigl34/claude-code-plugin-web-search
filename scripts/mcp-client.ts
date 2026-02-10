/**
 * Brave Search MCP Client
 *
 * MCP wrapper client for web search via Brave Search API.
 * Connects to the Brave Search MCP server via stdio transport.
 *
 * Key features:
 * - Web search: General web search with pagination
 * - Local search: Business/location search (stricter rate limits)
 * - Retry logic: Exponential backoff for rate limit handling
 *
 * Rate limits: Local search is more constrained (~10s base delay).
 * Retries automatically on 429 errors with exponential backoff.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MCPConfig {
  mcpServer: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

export class BraveSearchMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  /** Establishes connection to the Brave Search MCP server. */
  async connect(): Promise<void> {
    if (this.connected) return;

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    this.transport = new StdioClientTransport({
      command: this.config.mcpServer.command,
      args: this.config.mcpServer.args,
      env: env as Record<string, string>,
    });

    this.client = new Client(
      { name: "brave-search-cli", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** Closes the MCP server connection. */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  /** Lists available search tools (web and local). */
  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  // ============================================
  // INTERNAL
  // ============================================

  /**
   * Calls an MCP tool with automatic retry on rate limits.
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @param maxRetries - Maximum retry attempts (default: 3)
   * @returns Tool result
   * @throws {Error} After max retries or on non-retryable errors
   */
  async callTool(name: string, args: Record<string, any>, maxRetries: number = 3): Promise<any> {
    await this.connect();

    let lastError: Error | null = null;
    // Local search is more rate-limited, use longer delays
    const baseDelay = name === 'brave_local_search' ? 10000 : 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.client!.callTool({ name, arguments: args });
        const content = result.content as Array<{ type: string; text?: string }>;

        if (result.isError) {
          const errorContent = content.find((c) => c.type === "text");
          const errorText = errorContent?.text || "Tool call failed";

          // Check if rate limited - retry with exponential backoff + jitter
          if (errorText.includes('429') || errorText.toLowerCase().includes('rate limit')) {
            const delay = Math.pow(2, attempt) * baseDelay + Math.random() * 2000;
            console.error(`Rate limited, retrying in ${Math.round(delay/1000)}s... (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }

          throw new Error(errorText);
        }

        const textContent = content.find((c) => c.type === "text");
        if (textContent?.text) {
          try {
            return JSON.parse(textContent.text);
          } catch {
            return textContent.text;
          }
        }

        return content;
      } catch (error: any) {
        lastError = error;

        // Check if rate limit error and should retry
        if (error.message?.includes('429') || error.message?.toLowerCase().includes('rate limit')) {
          const delay = Math.pow(2, attempt) * baseDelay + Math.random() * 2000;
          console.error(`Rate limited, retrying in ${Math.round(delay/1000)}s... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        throw error; // Non-retryable error
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  // ============================================
  // SEARCH OPERATIONS
  // ============================================

  /**
   * Performs a web search.
   *
   * @param query - Search query
   * @param options - Search options
   * @param options.count - Number of results (default: 10)
   * @param options.offset - Pagination offset
   * @returns Search results
   */
  async webSearch(query: string, options?: {
    count?: number;
    offset?: number;
  }): Promise<any> {
    const args: Record<string, any> = { query };
    if (options?.count) args.count = options.count;
    if (options?.offset) args.offset = options.offset;
    return this.callTool("brave_web_search", args);
  }

  /**
   * Performs a local business/location search.
   *
   * Note: More rate-limited than web search. Uses 10s base delay
   * with exponential backoff (~70s max timeout for 3 retries).
   *
   * @param query - Search query (e.g., "restaurants near London")
   * @param options - Search options
   * @param options.count - Number of results
   * @returns Local search results with business details
   */
  async localSearch(query: string, options?: {
    count?: number;
  }): Promise<any> {
    const args: Record<string, any> = { query };
    if (options?.count) args.count = options.count;
    return this.callTool("brave_local_search", args, 3);
  }
}

export default BraveSearchMCPClient;
