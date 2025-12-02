import { chromium, type BrowserServer } from "playwright";

export interface ServeOptions {
  port?: number;
  headless?: boolean;
}

export interface DevBrowserServer {
  wsEndpoint: string;
  stop: () => Promise<void>;
}

export async function serve(
  options: ServeOptions = {}
): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const headless = options.headless ?? false;

  console.log("Launching browser server...");

  // Launch browser server - clients connect directly via WebSocket
  const browserServer: BrowserServer = await chromium.launchServer({
    headless,
    port,
  });

  const wsEndpoint = browserServer.wsEndpoint();
  console.log(`Browser server started at: ${wsEndpoint}`);

  return {
    wsEndpoint,
    async stop() {
      await browserServer.close();
    },
  };
}
