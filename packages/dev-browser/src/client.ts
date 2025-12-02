import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface DevBrowserClient {
  page: (name: string) => Promise<Page>;
  list: () => Promise<string[]>;
  close: (name: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

export async function connect(wsEndpoint: string): Promise<DevBrowserClient> {
  // Connect directly to the browser server
  const browser: Browser = await chromium.connect(wsEndpoint);

  // Local registry: name -> BrowserContext
  const registry = new Map<string, BrowserContext>();

  // Find existing pages from browser (in case of reconnection)
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      try {
        const pageName = await page.evaluate(() => (globalThis as any).__devBrowserPageName);
        if (pageName && typeof pageName === "string") {
          registry.set(pageName, context);
        }
      } catch {
        // Page might be closed or navigating
      }
    }
  }

  async function findPage(name: string): Promise<Page | null> {
    const context = registry.get(name);
    if (!context) return null;

    for (const page of context.pages()) {
      try {
        const pageName = await page.evaluate(() => (globalThis as any).__devBrowserPageName);
        if (pageName === name) {
          return page;
        }
      } catch {
        // Page might be closed or navigating
      }
    }
    return null;
  }

  return {
    async page(name: string): Promise<Page> {
      // Check if page already exists
      const existing = await findPage(name);
      if (existing) {
        return existing;
      }

      // Create new context with init script
      const context = await browser.newContext();
      await context.addInitScript((pageName: string) => {
        (globalThis as any).__devBrowserPageName = pageName;
      }, name);
      const page = await context.newPage();
      registry.set(name, context);

      return page;
    },

    async list(): Promise<string[]> {
      return Array.from(registry.keys());
    },

    async close(name: string): Promise<void> {
      const context = registry.get(name);
      if (context) {
        await context.close();
        registry.delete(name);
      }
    },

    async disconnect(): Promise<void> {
      // Just disconnect - don't close the browser server
      browser.close();
    },
  };
}
