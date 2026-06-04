import { plugin } from "bun";

const webpPlugin = {
  name: "webp-loader",
  setup(build: any) {
    build.onLoad({ filter: /\.(webp|png|jpg|jpeg|gif)$/ }, () => {
      return {
        contents: "export default '';",
        loader: "js",
      };
    });
  },
};

plugin(webpPlugin);
(globalThis as any).webpPlugin = webpPlugin; // Force bundler to preserve the plugin and not tree-shake it

import { parseHTML } from 'linkedom';
import { join } from 'path';

// 1. Mock standard browser DOM globals for HakuNeko classes and decorators
const parsed = parseHTML("<!DOCTYPE html><html><body></body></html>");
const { window, document, customElements, HTMLElement, Event, DOMParser, HTMLAnchorElement, HTMLImageElement, HTMLMetaElement } = parsed;

// Patch HTMLAnchorElement prototype to support URL properties in Bun headless context
const urlProperties = ['pathname', 'search', 'hash', 'host', 'hostname', 'origin', 'protocol'];
for (const prop of urlProperties) {
    Object.defineProperty(HTMLAnchorElement.prototype, prop, {
        get() {
            const href = this.getAttribute('href') || '';
            try {
                const url = new URL(href, 'http://localhost');
                return url[prop];
            } catch {
                return href;
            }
        },
        configurable: true,
        enumerable: true
    });
}

const pendingPromises: Promise<any>[] = [];
(globalThis as any).pendingPromises = pendingPromises;

// Patch HTMLElement.prototype.dispatchEvent to support HTMX trigger/hx-get actions
const originalDispatchEvent = HTMLElement.prototype.dispatchEvent;
HTMLElement.prototype.dispatchEvent = function(event: any) {
    const hxGet = this.getAttribute('hx-get');
    const hxTrigger = this.getAttribute('hx-trigger');
    if (hxGet && hxTrigger && event.type === hxTrigger.trim()) {
        const url = hxGet.trim().replace(/&amp;/g, '&').replace(/&#038;/g, '&');
        const p = fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest'
            }
        })
        .then(res => res.text())
        .then(html => {
            const swap = this.getAttribute('hx-swap') || 'innerHTML';
            if (swap === 'outerHTML') {
                const parent = this.parentNode;
                if (parent) {
                    const temp = document.createElement('div');
                    temp.innerHTML = html.trim();
                    const newEl = Array.from(temp.childNodes).find((n: any) => n.nodeType === 1);
                    if (newEl) {
                        parent.replaceChild(newEl, this);
                    }
                }
            } else {
                this.innerHTML = html.trim();
            }
        })
        .catch(err => {
            console.error("HTMX hx-get dispatch fetch failed:", err);
        });
        pendingPromises.push(p);
    }
    return originalDispatchEvent.call(this, event);
};

// Patch globalThis.setTimeout to wait for pending HTMX fetches before running the callback
const originalSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = function(callback: any, delay: any, ...args: any[]) {
    if (pendingPromises.length > 0) {
        const promises = [...pendingPromises];
        pendingPromises.length = 0; // Clear it
        Promise.all(promises).then(() => {
            originalSetTimeout(callback, 50, ...args);
        }).catch(() => {
            originalSetTimeout(callback, 50, ...args);
        });
        return 999;
    }
    return originalSetTimeout(callback, delay, ...args);
} as any;

globalThis.window = window as any;
globalThis.document = document as any;
globalThis.customElements = customElements as any;
globalThis.HTMLElement = HTMLElement as any;
globalThis.Event = Event as any;
globalThis.DOMParser = DOMParser as any;
globalThis.HTMLAnchorElement = HTMLAnchorElement as any;
globalThis.HTMLImageElement = HTMLImageElement as any;
globalThis.HTMLMetaElement = HTMLMetaElement as any;
globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response = Response;

const args = Bun.argv.slice(2);
const command = args[0];

if (!command) {
    console.error("Missing command argument (validate | fetch_manga | fetch_chapters | fetch_pages | find_matching_script)");
    process.exit(1);
}

if (command === 'find_matching_script') {
    const websitesDir = args[1];
    const url = args[2];
    if (!websitesDir || !url) {
        console.error("Missing arguments for find_matching_script");
        process.exit(1);
    }
    
    // Find the engine directory
    const engineDir = join(websitesDir, '..');
    
    // Load RegExpSafe first
    await import(join(engineDir, 'RegExpSafe.ts'));
    // Load ArrayExtensions
    await import(join(engineDir, 'ArrayExtensions.ts'));
    // Load FetchProvider
    await import(join(engineDir, 'platform', 'FetchProvider.ts'));
    
    const fs = require('fs');
    const files = fs.readdirSync(websitesDir);
    let matchedScript: string | null = null;
    
    // Step 1: Pre-filter candidate files statically via fast text scanning (< 2ms)
    // to avoid compiling all 190+ scraper TS files sequentially which hangs the engine.
    const candidates: string[] = [];
    try {
        const parsedUrl = new URL(url);
        const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
        const domainParts = host.split('.');
        const domainName = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : host;

        for (const file of files) {
            if (file.endsWith('.ts') && !file.endsWith('_e2e.ts') && file !== 'haruneko_runner.ts' && file !== 'NatsuID.ts') {
                const fullPath = join(websitesDir, file);
                const content = fs.readFileSync(fullPath, 'utf8').toLowerCase();
                
                // Check if file mentions the host or the specific domain name
                if (content.includes(host) || content.includes(`'${domainName}'`) || content.includes(`"${domainName}"`)) {
                    candidates.push(file);
                }
            }
        }
    } catch (e) {
        // Fallback to all files if URL parse fails
    }

    const filesToSearch = candidates.length > 0 ? candidates : files;
    
    for (const file of filesToSearch) {
        if (file.endsWith('.ts') && !file.endsWith('_e2e.ts') && file !== 'haruneko_runner.ts') {
            try {
                const fullPath = join(websitesDir, file);
                const mod = await import(fullPath);
                const ScraperClass = mod.default;
                if (ScraperClass) {
                    const scraper = new ScraperClass();
                    if (scraper.ValidateMangaURL(url)) {
                        matchedScript = file;
                        break;
                    }
                }
            } catch (e) {
                // Ignore load errors for certain non-scraper utility files
            }
        }
    }
    
    console.log(JSON.stringify({ matchedScript }));
    process.exit(0);
}

// Locate RegExpSafe and FetchProvider using the script_path's parent directories
const scriptPath = args[1];
if (!scriptPath) {
    console.error("Missing script_path argument");
    process.exit(1);
}

// Find the engine directory from the website script path
// e.g. C:\Users\...\haruneko_repo\web\src\engine\websites\MangaDex.ts -> F:\...\haruneko_repo\web\src\engine\
const engineDir = join(scriptPath, '..', '..');

// Load RegExpSafe first
await import(join(engineDir, 'RegExpSafe.ts'));
// Load ArrayExtensions
await import(join(engineDir, 'ArrayExtensions.ts'));
// Load FetchProvider
await import(join(engineDir, 'platform', 'FetchProvider.ts'));

// Load the target website scraper script
const connectorModule = await import(scriptPath);
const ScraperClass = connectorModule.default;
const scraper = new ScraperClass();

if (command === 'validate') {
    const url = args[2];
    if (!url) {
        console.error("Missing url argument");
        process.exit(1);
    }
    const isValid = scraper.ValidateMangaURL(url);
    console.log(JSON.stringify({ isValid }));
    process.exit(0);
}

if (command === 'fetch_manga') {
    const url = args[2];
    if (!url) {
        console.error("Missing url");
        process.exit(1);
    }
    const manga = await scraper.FetchManga(null, url);
    console.log(JSON.stringify({ id: manga.Identifier, title: manga.Title }));
    process.exit(0);
}

if (command === 'fetch_chapters') {
    const { Manga } = await import(join(engineDir, 'providers', 'MangaPlugin.ts'));
    const mangaId = args[2];
    const mangaTitle = args[3] || "Manga";
    if (!mangaId) {
        console.error("Missing mangaId");
        process.exit(1);
    }
    
    const manga = new Manga(scraper, null, mangaId, mangaTitle);
    const chapters = await scraper.FetchChapters(manga);
    const result = chapters.map(ch => ({
        id: ch.Identifier,
        name: ch.Title,
    }));
    console.log(JSON.stringify(result));
    process.exit(0);
}

if (command === 'fetch_pages') {
    const { Manga, Chapter } = await import(join(engineDir, 'providers', 'MangaPlugin.ts'));
    const chapterId = args[2];
    const chapterTitle = args[3] || "Chapter";
    const mangaId = args[4] || "manga";
    const mangaTitle = args[5] || "Manga";
    
    if (!chapterId) {
        console.error("Missing chapterId");
        process.exit(1);
    }
    
    const manga = new Manga(scraper, null, mangaId, mangaTitle);
    const chapter = new Chapter(scraper, manga, chapterId, chapterTitle);
    const pages = await scraper.FetchPages(chapter);
    const result = pages.map(p => ({
        url: p.Link?.href || "",
        referer: p.Parameters?.Referer || p.Link?.origin || "",
    }));
    console.log(JSON.stringify(result));
    process.exit(0);
}

if (command === 'download_pages') {
    const { Manga, Chapter } = await import(join(engineDir, 'providers', 'MangaPlugin.ts'));
    const chapterId = args[2];
    const chapterTitle = args[3] || "Chapter";
    const mangaId = args[4] || "manga";
    const mangaTitle = args[5] || "Manga";
    const destDir = args[6];
    
    if (!chapterId || !destDir) {
        console.error("Missing chapterId or destDir");
        process.exit(1);
    }
    
    const manga = new Manga(scraper, null, mangaId, mangaTitle);
    const chapter = new Chapter(scraper, manga, chapterId, chapterTitle);
    const pages = await scraper.FetchPages(chapter);
    
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }
    
    const result: any[] = [];
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const idx = i + 1;
        const filename = `page_${String(idx).padStart(3, '0')}.png`;
        const filepath = path.join(destDir, filename);
        
        try {
            const blob = await scraper.FetchImage(page, 0, new AbortController().signal);
            const buffer = Buffer.from(await blob.arrayBuffer());
            fs.writeFileSync(filepath, buffer);
            result.push({
                filename,
                success: true
            });
        } catch (err: any) {
            console.error(`Failed to download/decrypt page ${idx}:`, err.message || err);
            result.push({
                filename,
                success: false,
                error: err.message || String(err)
            });
        }
    }
    
    console.log(JSON.stringify(result));
    process.exit(0);
}
