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
    
    for (const file of files) {
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
