/**
 * Page Fetcher — fetches web pages via Jina Reader and returns clean markdown.
 *
 * Uses https://r.jina.ai/ as a rendering proxy that handles:
 * - Anti-bot measures (Cloudflare, rate limiting)
 * - JavaScript rendering (SPAs, dynamic content)
 * - HTML-to-markdown conversion
 *
 * Free tier: 100 RPM, no API key required.
 */

const JINA_BASE = "https://r.jina.ai/";
const DEFAULT_MAX_LENGTH = 20_000;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

export interface FetchPageOptions {
  maxLength?: number;
  selector?: string;
  stripImages?: boolean;
}

export interface FetchPageResult {
  url: string;
  title: string;
  content: string;
  contentLength: number;
  truncated: boolean;
}

/**
 * Clean up markdown content: remove navigation cruft, collapse whitespace.
 */
function cleanContent(text: string, stripImages?: boolean): string {
  let cleaned = text
    // Remove Wikipedia [edit] links
    .replace(/\[edit\]/g, "")
    // Remove "Jump to" navigation links
    .replace(/Jump to:?\s*\[?navigation\]?,?\s*\[?search\]?\n*/gi, "")
    // Remove empty link references like [](#foo)
    .replace(/\[]\(#[^)]*\)/g, "")
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (stripImages) {
    // Remove linked images: [![alt](img-url)](link-url) — common in Wikipedia
    cleaned = cleaned.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "");
    // Remove standalone images: ![alt](url) and ![alt](url "title")
    cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    // Remove empty links left after image stripping: [](url)
    cleaned = cleaned.replace(/\[\]\([^)]*\)/g, "");
    // Collapse blank lines again after image removal
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  }

  return cleaned;
}

/**
 * Truncate content at a paragraph boundary near maxLength.
 * Keeps at least 70% of maxLength, appends truncation marker.
 */
function truncateContent(
  text: string,
  maxLength: number
): { content: string; truncated: boolean } {
  if (maxLength <= 0 || text.length <= maxLength) {
    return { content: text, truncated: false };
  }

  const minLength = Math.floor(maxLength * 0.7);
  // Find last paragraph break within maxLength
  const lastBreak = text.lastIndexOf("\n\n", maxLength);

  let cutPoint: number;
  if (lastBreak >= minLength) {
    cutPoint = lastBreak;
  } else {
    // No good paragraph break — cut at maxLength
    cutPoint = maxLength;
  }

  return {
    content: text.slice(0, cutPoint).trimEnd() + "\n\n... [truncated]",
    truncated: true,
  };
}

/**
 * Determine whether an error is retryable (5xx or network error).
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network errors
    if (
      msg.includes("fetch failed") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound") ||
      msg.includes("etimedout") ||
      msg.includes("econnrefused")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Fetch a web page via Jina Reader and return clean markdown.
 */
export async function fetchPage(
  url: string,
  options: FetchPageOptions = {}
): Promise<FetchPageResult> {
  const { maxLength = DEFAULT_MAX_LENGTH, selector, stripImages } = options;

  // Guard against double-prefixing
  const jinaUrl = url.startsWith(JINA_BASE)
    ? url
    : JINA_BASE + url.trim();

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (selector) {
    headers["X-Target-Selector"] = selector;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(jinaUrl, {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const status = response.status;
        // 4xx: don't retry
        if (status >= 400 && status < 500) {
          return {
            url,
            title: "",
            content: `Error: HTTP ${status} — ${response.statusText}`,
            contentLength: 0,
            truncated: false,
          };
        }
        // 5xx: retry
        lastError = new Error(`HTTP ${status}: ${response.statusText}`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      let title = "";
      let rawContent = "";

      if (contentType.includes("application/json")) {
        const json = (await response.json()) as {
          data?: { url?: string; title?: string; content?: string };
          url?: string;
          title?: string;
          content?: string;
        };
        // Jina wraps response in { data: { ... } }
        const data = json.data || json;
        title = data.title || "";
        rawContent = data.content || "";
      } else {
        // Fallback: plain text response
        rawContent = await response.text();
      }

      const cleaned = cleanContent(rawContent, stripImages);
      const { content, truncated } = truncateContent(cleaned, maxLength);

      return {
        url,
        title,
        content,
        contentLength: cleaned.length,
        truncated,
      };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        lastError = new Error(`Timeout after ${TIMEOUT_MS / 1000}s`);
        // Don't retry on timeout — it's likely the page is genuinely slow
        break;
      }
      if (isRetryable(err)) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      // Non-retryable error
      lastError = err instanceof Error ? err : new Error(String(err));
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  // All attempts exhausted
  return {
    url,
    title: "",
    content: `Error: ${lastError?.message || "Unknown error"}`,
    contentLength: 0,
    truncated: false,
  };
}
