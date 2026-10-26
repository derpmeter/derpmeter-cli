// Network helper for the CLI and MCP server: retries transient failures and
// turns undici's bare "fetch failed" into an actionable message.
// Every request we send is safe to repeat: reads, and writes with an
// idempotency key (the server replays the original receipt).
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The service URL is never shown to users.
export function describeNetworkError(_url, error) {
  const cause = error?.cause ?? error;
  const code = cause?.code || cause?.name || "";
  const reason =
    code === "ENOTFOUND" || code === "EAI_AGAIN"
      ? "the address could not be resolved"
      : code === "ECONNREFUSED"
        ? "the connection was refused"
        : code === "ECONNRESET" || code === "UND_ERR_SOCKET"
          ? "the connection was reset"
          : code === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT"
            ? "the request timed out"
            : /redirect/i.test(cause?.message || "")
              ? "the server answered with a redirect (refused for safety)"
              : cause?.message || "network error";
  return new Error(
    `Could not reach DerpMeter: ${reason}${code && !reason.includes(code) ? ` (${code})` : ""}. ` +
      "The service may be restarting or you may be offline; try again in a moment.",
  );
}

// fetch-compatible wrapper: up to `attempts` tries with backoff on thrown
// network errors and 502/503/504. Never follows redirects.
export function withRetry(
  fetcher = fetch,
  { attempts = 4, baseDelay = 500 } = {},
) {
  return async function robustFetch(url, init = {}) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(baseDelay * 2 ** (i - 1));
      try {
        const response = await fetcher(url, { redirect: "error", ...init });
        if (TRANSIENT_STATUS.has(response.status) && i < attempts - 1) continue;
        return response;
      } catch (e) {
        lastError = e;
        // The caller's own deadline expired: do not keep retrying.
        if (init.signal?.aborted) break;
      }
    }
    throw describeNetworkError(url, lastError);
  };
}

export const robustFetch = withRetry(fetch);

// JSON body or a readable stand-in (e.g. an HTML error page from a proxy).
export async function readBody(response) {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: `Unexpected response from the service (HTTP ${response.status})`,
    };
  }
}
