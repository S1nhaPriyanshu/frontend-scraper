import { NextResponse } from 'next/server';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import {
  validatePublicUrl,
  isRateLimited,
  safeErrorMessage,
} from '@/lib/security';

// ─── Browser path detection ───────────────────────────────────────────────────
function getExecutablePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not find Chrome or Edge. Please install one of them.');
}

// ─── Rate limit config ────────────────────────────────────────────────────────
// 10 scrape requests per IP per minute
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ─── POST /api/scrape ─────────────────────────────────────────────────────────
export async function POST(req: Request) {
  let browser;
  try {
    // ── 1. Rate limiting ─────────────────────────────────────────────────────
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('x-real-ip') ??
      'unknown';

    if (isRateLimited(ip, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a moment and try again.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }

    // ── 2. Parse & validate URL (SSRF prevention) ─────────────────────────────
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rawUrl = (body as Record<string, unknown>)?.url;
    const urlValidation = validatePublicUrl(rawUrl);

    if (!urlValidation.valid) {
      return NextResponse.json({ error: urlValidation.reason }, { status: 400 });
    }

    const targetUrl = urlValidation.url.href;

    // ── 3. Launch browser ─────────────────────────────────────────────────────
    browser = await puppeteer.launch({
      executablePath: getExecutablePath(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-plugins',
        '--disable-default-apps',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // ── 4. Block navigation to private addresses (redirect-based SSRF) ────────
    await page.setRequestInterception(true);
    page.on('request', (interceptedReq) => {
      // Only validate main-frame navigation (not sub-resources from the real site)
      if (
        interceptedReq.isNavigationRequest() &&
        interceptedReq.frame() === page.mainFrame()
      ) {
        const check = validatePublicUrl(interceptedReq.url());
        if (!check.valid) {
          console.warn(`[security] Blocked redirect to: ${interceptedReq.url()}`);
          interceptedReq.abort('addressunreachable');
          return;
        }
      }
      interceptedReq.continue();
    });

    // ── 5. Navigate ───────────────────────────────────────────────────────────
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

    // ── 6. Extract design data ────────────────────────────────────────────────
    const designData = await page.evaluate((pageUrl: string) => {
      const elements = document.querySelectorAll('*');

      const colors = new Set<string>();
      const bgColors = new Set<string>();
      const fonts = new Set<string>();
      const images: string[] = [];
      const animations = new Set<string>();

      elements.forEach(el => {
        const style = window.getComputedStyle(el);

        if (style.fontFamily && style.fontFamily !== 'serif' && style.fontFamily !== 'sans-serif') {
          fonts.add(style.fontFamily.replace(/['"]/g, ''));
        }
        if (style.color && style.color !== 'rgba(0, 0, 0, 0)') {
          colors.add(style.color);
        }
        if (
          style.backgroundColor &&
          style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          style.backgroundColor !== 'transparent'
        ) {
          bgColors.add(style.backgroundColor);
        }
        if (style.transition && style.transition !== 'all 0s ease 0s' && style.transition !== 'none 0s ease 0s') {
          animations.add(style.transition);
        }
        if (style.animationName && style.animationName !== 'none') {
          animations.add(style.animationName);
        }
        if (el.tagName === 'IMG') {
          const src = (el as HTMLImageElement).src;
          // Only absolute http(s) image URLs — no data: URIs
          if (src && /^https?:\/\//i.test(src)) images.push(src);
        }
      });

      // External stylesheet URLs (absolute http/https only)
      const cssFiles: string[] = [];
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
        const href = (link as HTMLLinkElement).href;
        if (href && /^https?:\/\//i.test(href)) cssFiles.push(href);
      });

      // Inline <style> blocks
      const inlineStyles: string[] = [];
      document.querySelectorAll('style').forEach(style => {
        if (style.textContent?.trim()) inlineStyles.push(style.textContent);
      });

      return {
        typography: Array.from(fonts).slice(0, 10),
        colors: {
          text: Array.from(colors).slice(0, 15),
          background: Array.from(bgColors).slice(0, 15),
        },
        animations: Array.from(animations).slice(0, 15),
        images: images.slice(0, 20),
        cssFiles: cssFiles.slice(0, 20),   // cap to prevent abuse
        inlineStyles: inlineStyles.slice(0, 30),
        fullHTML: document.documentElement.outerHTML,
        pageUrl,
      };
    }, targetUrl);

    await browser.close();
    browser = undefined;

    return NextResponse.json(designData);

  } catch (error: unknown) {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    console.error('[scrape] error:', error);
    return NextResponse.json(
      { error: 'Failed to scrape the URL', details: safeErrorMessage(error) },
      { status: 500 }
    );
  }
}
