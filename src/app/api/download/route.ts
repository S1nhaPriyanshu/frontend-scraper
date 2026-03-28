import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import {
  validatePublicUrl,
  filterPublicUrls,
  safeErrorMessage,
  safeFilename,
  fetchBoundedText,
  fetchBoundedBuffer,
} from '@/lib/security';

// ─── Per-download limits ──────────────────────────────────────────────────────
const MAX_CSS_FILES   = 20;
const MAX_IMAGES      = 30;
const MAX_CSS_BYTES   = 5  * 1024 * 1024;  // 5 MB per CSS file
const MAX_ASSET_BYTES = 10 * 1024 * 1024;  // 10 MB per image/font
const MAX_HTML_BYTES  = 15 * 1024 * 1024;  // 15 MB HTML body cap

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(url: string, base: string): string {
  try { return new URL(url, base).href; } catch { return url; }
}

/** Extract @font-face src URLs from CSS text */
function extractFontUrls(css: string, cssOrigin: string): string[] {
  const urls: string[] = [];
  // Match url() references to font file extensions
  const re = /url\(\s*['"]?([^'")\s]+\.(?:woff2?|ttf|eot|otf|svg))['"]?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const resolved = resolveUrl(m[1], cssOrigin);
    // Only include public URLs
    if (validatePublicUrl(resolved).valid) urls.push(resolved);
  }
  return urls;
}

function extFromUrl(url: string, fallback = 'bin'): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.split('?')[0] ?? '';
    return ext.length > 0 && ext.length <= 5 ? ext.toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

// ─── POST /api/download ───────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // ── 1. Validate the page URL (SSRF prevention) ────────────────────────────
    const pageUrlValidation = validatePublicUrl(body.url);
    if (!pageUrlValidation.valid) {
      return NextResponse.json({ error: pageUrlValidation.reason }, { status: 400 });
    }
    const pageUrl = pageUrlValidation.url.href;

    // ── 2. Sanitise and cap client-supplied URL arrays (SSRF prevention) ──────
    const rawCSSFiles    = Array.isArray(body.cssFiles)    ? body.cssFiles    : [];
    const rawImages      = Array.isArray(body.images)      ? body.images      : [];
    const rawInlineStyles: string[] = Array.isArray(body.inlineStyles)
      ? (body.inlineStyles as unknown[]).filter(s => typeof s === 'string').slice(0, 50)
      : [];

    // Filter to safe public URLs, then cap count
    const cssFiles = filterPublicUrls(rawCSSFiles).slice(0, MAX_CSS_FILES);
    const images   = filterPublicUrls(rawImages).slice(0, MAX_IMAGES);

    // Cap fullHTML
    let fullHTML = typeof body.fullHTML === 'string' ? body.fullHTML : '';
    if (fullHTML.length > MAX_HTML_BYTES) {
      fullHTML = fullHTML.slice(0, MAX_HTML_BYTES);
    }

    // ── 3. Build ZIP structure ────────────────────────────────────────────────
    const zip          = new JSZip();
    const assetsFolder = zip.folder('assets')!;
    const cssFolder    = assetsFolder.folder('css')!;
    const imagesFolder = assetsFolder.folder('images')!;
    const fontsFolder  = assetsFolder.folder('fonts')!;

    // ── 4. Fetch external CSS (with content-size cap) ─────────────────────────
    const rawCSSParts: string[] = [...rawInlineStyles];
    const fontUrlSet = new Set<string>();

    await Promise.all(
      cssFiles.map(async (cssUrl) => {
        const text = await fetchBoundedText(cssUrl, { maxBytes: MAX_CSS_BYTES });
        if (!text) return;
        rawCSSParts.push(`/* Source: ${cssUrl} */\n${text}`);
        extractFontUrls(text, cssUrl).forEach(f => fontUrlSet.add(f));
      })
    );

    // ── 5. Download fonts (with content-size cap) ─────────────────────────────
    const fontMap = new Map<string, string>();
    let fontIndex = 0;

    await Promise.all(
      Array.from(fontUrlSet).map(async (fontUrl) => {
        const buf = await fetchBoundedBuffer(fontUrl, { maxBytes: MAX_ASSET_BYTES });
        if (!buf) return;
        const idx = ++fontIndex;
        const ext = extFromUrl(fontUrl, 'woff2');
        const filename = safeFilename(`font-${idx}.${ext}`);
        fontsFolder.file(filename, buf);
        fontMap.set(fontUrl, `../fonts/${filename}`);
      })
    );

    // ── 6. Build styles.css — rewrite absolute font URLs to local paths ───────
    let combinedCSS = rawCSSParts.join('\n\n');
    for (const [original, local] of fontMap) {
      combinedCSS = combinedCSS.split(original).join(local);
    }
    cssFolder.file('styles.css', combinedCSS);

    // ── 7. Download images (with content-size cap) ────────────────────────────
    const imageMap = new Map<string, string>();

    await Promise.all(
      images.map(async (imgUrl, i) => {
        const buf = await fetchBoundedBuffer(imgUrl, { maxBytes: MAX_ASSET_BYTES });
        if (!buf) return;
        const ext = extFromUrl(imgUrl, 'jpg');
        const filename = safeFilename(`image-${i + 1}.${ext}`);
        imagesFolder.file(filename, buf);
        imageMap.set(imgUrl, `assets/images/${filename}`);
      })
    );

    // ── 8. Build index.html ───────────────────────────────────────────────────
    let html = fullHTML || '<!DOCTYPE html><html><head></head><body></body></html>';

    // Strip <script> tags — they break in local context and are a security risk
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script\b[^>]*\/>/gi, '');

    // Strip all existing <link rel="stylesheet"> tags
    html = html.replace(/<link[^>]*rel=["']stylesheet["'][^>]*\/?>/gi, '');

    // Rewrite <img src> to local copies
    for (const [original, local] of imageMap) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(escaped, 'g'), local);
    }

    // Inject local stylesheet before </head>
    const injection = `\n  <!-- Extracted from: ${pageUrl} on ${new Date().toISOString()} -->\n  <link rel="stylesheet" href="assets/css/styles.css">`;
    html = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, `${injection}\n</head>`)
      : injection + '\n' + html;

    zip.file('index.html', html);

    // ── 9. README ─────────────────────────────────────────────────────────────
    zip.file('README.md', [
      '# Site Extract',
      '',
      `**Source:** ${pageUrl}`,
      `**Extracted:** ${new Date().toISOString()}`,
      '',
      '## How to use',
      '',
      '1. Open `index.html` in your browser to preview.',
      '2. Edit `assets/css/styles.css` to change colors, fonts, spacing.',
      '3. Swap files in `assets/images/` with your own.',
      '4. Scripts were stripped — add your own JS as needed.',
      '',
      '## Stats',
      '',
      `- Stylesheets fetched: ${cssFiles.length}`,
      `- Inline style blocks: ${rawInlineStyles.length}`,
      `- Images downloaded: ${imageMap.size} / ${images.length}`,
      `- Fonts downloaded: ${fontMap.size}`,
    ].join('\n'));

    // ── 10. Generate ZIP ──────────────────────────────────────────────────────
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const hostname = pageUrlValidation.url.hostname.replace(/\./g, '-');

    return new NextResponse(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${hostname}-extract.zip"`,
        'Content-Length': zipBuffer.length.toString(),
      },
    });

  } catch (error: unknown) {
    console.error('[download] error:', error);
    return NextResponse.json(
      { error: 'Failed to build ZIP', details: safeErrorMessage(error) },
      { status: 500 }
    );
  }
}
