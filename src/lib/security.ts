/**
 * security.ts — shared security utilities for the scraper API routes
 *
 * Covers:
 *  1. SSRF prevention  — block private / internal / metadata IP ranges
 *  2. Protocol allow-list — only http: and https:
 *  3. Rate limiting    — simple in-memory per-IP window counter
 *  4. Safe error msgs  — strip file paths / stack traces before sending to client
 *  5. Filename sanitisation — prevent path-traversal inside ZIP entries
 *  6. Bounded fetch    — cap response body size to prevent memory exhaustion
 */

// ─── 1. SSRF / URL validation ────────────────────────────────────────────────

/** Hostname patterns that must never be contacted server-side */
const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  // Loopback
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  // RFC-1918 private ranges
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  // Link-local / cloud metadata
  /^169\.254\./,
  // Carrier-grade NAT (CGNAT) — sometimes abused
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  // IPv6 special addresses
  /^::1$/,          // loopback
  /^\[::1\]$/,
  /^fc[0-9a-f]{2}:/i,  // unique local
  /^fd[0-9a-f]{2}:/i,  // unique local
  /^fe80:/i,            // link-local
  // Cloud metadata endpoints (by hostname)
  /^metadata\.google\.internal$/i,
  /^169\.254\.169\.254$/,
];

export type UrlValidation =
  | { valid: true; url: URL }
  | { valid: false; reason: string };

/**
 * Validate that a URL is safe to fetch server-side:
 *  - Non-empty string
 *  - Max 2048 chars
 *  - Protocol is http or https only
 *  - No embedded credentials
 *  - Hostname is not a private/internal address
 */
export function validatePublicUrl(rawUrl: unknown): UrlValidation {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { valid: false, reason: 'URL must be a non-empty string' };
  }
  if (rawUrl.length > 2048) {
    return { valid: false, reason: 'URL exceeds maximum length' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol allow-list
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      valid: false,
      reason: `Protocol "${parsed.protocol}" is not permitted. Only http and https are supported.`,
    };
  }

  // Block embedded credentials (http://user:pass@host)
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return {
        valid: false,
        reason: 'Requests to private, loopback, or cloud-metadata addresses are not permitted',
      };
    }
  }

  return { valid: true, url: parsed };
}

/**
 * Filter an array of URLs, keeping only the ones that pass validatePublicUrl.
 * Logs a warning for each rejected URL.
 */
export function filterPublicUrls(urls: unknown[]): string[] {
  if (!Array.isArray(urls)) return [];
  const safe: string[] = [];
  for (const u of urls) {
    const result = validatePublicUrl(u);
    if (result.valid) {
      safe.push(result.url.href);
    } else {
      console.warn(`[security] Blocked URL "${u}": ${result.reason}`);
    }
  }
  return safe;
}

// ─── 2. Rate limiting ─────────────────────────────────────────────────────────

/** IP → array of request timestamps (ms) */
const rateLimitStore = new Map<string, number[]>();

/**
 * Returns true if the request is within the allowed rate.
 * @param key       Identifier (e.g. client IP)
 * @param max       Max requests allowed in the window
 * @param windowMs  Rolling window in milliseconds
 */
export function isRateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = (rateLimitStore.get(key) ?? []).filter(t => now - t < windowMs);
  if (timestamps.length >= max) {
    rateLimitStore.set(key, timestamps);
    return true; // blocked
  }
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);
  return false; // allowed
}

// ─── 3. Safe error messages ───────────────────────────────────────────────────

/**
 * Sanitise an error before sending its message to the client.
 * Strips Windows/Unix file paths and stack-trace fragments.
 */
export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'An unexpected error occurred';

  const cleaned = error.message
    .replace(/[A-Za-z]:\\[^\s,;]*/g, '[path]')   // Windows paths
    .replace(/\/[^\s,;]{8,}/g, '[path]')           // Unix paths
    .replace(/\s+at\s+\S+:\d+:\d+/g, '')           // stack trace fragments
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 300) : 'An unexpected error occurred';
}

// ─── 4. Filename sanitisation ─────────────────────────────────────────────────

/**
 * Produce a safe filename for use inside a ZIP archive.
 * Prevents path traversal (e.g. ../../etc/passwd).
 */
export function safeFilename(raw: string, fallback = 'file'): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]/g, '_')   // only safe characters
    .replace(/\.{2,}/g, '_')             // no double-dots
    .replace(/^[._-]+/, '');             // no leading dot/dash/underscore
  return (cleaned.slice(0, 80) || fallback);
}

// ─── 5. Bounded fetch ─────────────────────────────────────────────────────────

/**
 * Fetch a URL with a timeout AND a max-body-size guard.
 * Returns null on any failure (timeout, too large, non-200, network error).
 */
export async function boundedFetch(
  url: string,
  { timeoutMs = 10_000, maxBytes = 10 * 1024 * 1024 } = {}
): Promise<Response | null> {
  const validation = validatePublicUrl(url);
  if (!validation.valid) {
    console.warn(`[security] boundedFetch blocked "${url}": ${validation.reason}`);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrontendScraper/1.0)' },
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    // Enforce Content-Length if provided
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > maxBytes) {
      console.warn(`[security] Skipping "${url}": Content-Length ${contentLength} > ${maxBytes}`);
      return null;
    }

    return res;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetch and return the body as an ArrayBuffer, capping at maxBytes.
 * Returns null if the body exceeds the cap or the request fails.
 */
export async function fetchBoundedBuffer(
  url: string,
  { timeoutMs = 10_000, maxBytes = 10 * 1024 * 1024 } = {}
): Promise<ArrayBuffer | null> {
  const res = await boundedFetch(url, { timeoutMs, maxBytes });
  if (!res) return null;

  // Stream and cap
  const reader = res.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        console.warn(`[security] Streaming body from "${url}" exceeded ${maxBytes} bytes — skipped`);
        return null;
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

/**
 * Fetch and return body as text, capping at maxBytes.
 */
export async function fetchBoundedText(
  url: string,
  { timeoutMs = 10_000, maxBytes = 5 * 1024 * 1024 } = {}
): Promise<string | null> {
  const buf = await fetchBoundedBuffer(url, { timeoutMs, maxBytes });
  if (!buf) return null;
  return new TextDecoder().decode(buf);
}
