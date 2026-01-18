/**
 * Workspace Server - HTTP API server for Chrome profile workspaces
 *
 * This server manages multiple Chrome instances with different profiles,
 * providing workspace switching and page management APIs.
 */

import express, { type Express, type Request, type Response } from "express";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Socket } from "node:net";
import {
  WorkspaceManager,
  type ChromeInstance,
} from "./chrome-launcher.js";
import type {
  WorkspacesConfig,
  ListWorkspacesResponse,
  SwitchWorkspaceRequest,
  SwitchWorkspaceResponse,
  CurrentWorkspaceResponse,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ViewportSize,
} from "./types.js";

export interface WorkspaceServerOptions {
  port?: number;
  configPath?: string;
}

export interface WorkspaceServer {
  port: number;
  stop: () => Promise<void>;
}

// Default workspaces config
const DEFAULT_CONFIG: WorkspacesConfig = {
  workspaces: {
    personal: {
      profileDirectory: "Default",
      port: 9230,
    },
    work: {
      profileDirectory: "James-Work",
      port: 9231,
    },
  },
  defaultWorkspace: "personal",
};

// Default config path
const DEFAULT_CONFIG_PATH = join(homedir(), ".dev-browser", "workspaces.json");

/**
 * Load or create workspaces config
 */
function loadConfig(configPath: string): WorkspacesConfig {
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content) as WorkspacesConfig;
  }

  // Create default config
  const configDir = join(configPath, "..");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
  console.log(`Created default workspaces config at: ${configPath}`);

  return DEFAULT_CONFIG;
}

/**
 * Page registry entry
 */
interface PageEntry {
  page: Page;
  targetId: string;
  workspace: string;
}

/**
 * Start the workspace server
 */
export async function serveWorkspaces(
  options: WorkspaceServerOptions = {}
): Promise<WorkspaceServer> {
  const port = options.port ?? 9222;
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Load config
  const config = loadConfig(configPath);
  console.log(`Loaded workspaces config from: ${configPath}`);
  console.log(`Available workspaces: ${Object.keys(config.workspaces).join(", ")}`);

  // Initialize workspace manager
  const workspaceManager = new WorkspaceManager(config.workspaces);

  // Page registry: name -> PageEntry
  const pageRegistry = new Map<string, PageEntry>();

  // Browser connections: workspace -> Browser
  const browserConnections = new Map<string, Browser>();

  // Express server
  const app: Express = express();
  app.use(express.json());

  // ==========================================================================
  // Workspace Endpoints
  // ==========================================================================

  // GET /workspaces - List all workspaces and their states
  app.get("/workspaces", (_req: Request, res: Response) => {
    const response: ListWorkspacesResponse = {
      workspaces: workspaceManager.getWorkspaceStates(),
      current: workspaceManager.getCurrentWorkspace(),
    };
    res.json(response);
  });

  // GET /workspace/current - Get current workspace
  app.get("/workspace/current", (_req: Request, res: Response) => {
    const current = workspaceManager.getCurrentWorkspace();
    const instance = workspaceManager.getCurrentInstance();

    const response: CurrentWorkspaceResponse = {
      workspace: current,
      wsEndpoint: instance?.wsEndpoint || null,
    };
    res.json(response);
  });

  // POST /workspace/switch - Switch to a workspace
  app.post("/workspace/switch", async (req: Request, res: Response) => {
    const body = req.body as SwitchWorkspaceRequest;
    const { workspace } = body;

    if (!workspace || typeof workspace !== "string") {
      res.status(400).json({ error: "workspace is required and must be a string" });
      return;
    }

    if (!workspaceManager.hasWorkspace(workspace)) {
      res.status(404).json({
        error: `Unknown workspace: ${workspace}`,
        available: workspaceManager.getWorkspaceStates().map((w) => w.name),
      });
      return;
    }

    try {
      console.log(`Switching to workspace: ${workspace}`);
      const instance = await workspaceManager.switchWorkspace(workspace);

      // Connect Playwright to this Chrome instance if not already connected
      if (!browserConnections.has(workspace) && instance.wsEndpoint) {
        console.log(`Connecting Playwright to ${workspace}...`);
        const browser = await chromium.connectOverCDP(instance.wsEndpoint);
        browserConnections.set(workspace, browser);
      }

      const response: SwitchWorkspaceResponse = {
        workspace,
        wsEndpoint: instance.wsEndpoint!,
        status: "running",
      };
      res.json(response);
    } catch (err) {
      console.error(`Failed to switch workspace:`, err);
      res.status(500).json({
        error: `Failed to switch workspace: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // POST /workspace/stop - Stop a workspace
  app.post("/workspace/stop", (req: Request, res: Response) => {
    const { workspace } = req.body as { workspace: string };

    if (!workspace) {
      res.status(400).json({ error: "workspace is required" });
      return;
    }

    // Close all pages for this workspace
    for (const [name, entry] of pageRegistry.entries()) {
      if (entry.workspace === workspace) {
        entry.page.close().catch(() => {});
        pageRegistry.delete(name);
      }
    }

    // Disconnect browser
    const browser = browserConnections.get(workspace);
    if (browser) {
      browser.close().catch(() => {});
      browserConnections.delete(workspace);
    }

    // Stop the Chrome instance
    workspaceManager.stopWorkspace(workspace);

    res.json({ success: true, workspace });
  });

  // ==========================================================================
  // Page Endpoints (workspace-aware)
  // ==========================================================================

  // Helper to get current browser
  async function getCurrentBrowser(): Promise<Browser> {
    const current = workspaceManager.getCurrentWorkspace();

    if (!current) {
      // Auto-switch to default workspace
      const defaultWs = config.defaultWorkspace;
      console.log(`No workspace active, switching to default: ${defaultWs}`);
      const instance = await workspaceManager.switchWorkspace(defaultWs);

      if (instance.wsEndpoint && !browserConnections.has(defaultWs)) {
        const browser = await chromium.connectOverCDP(instance.wsEndpoint);
        browserConnections.set(defaultWs, browser);
      }

      return browserConnections.get(defaultWs)!;
    }

    const browser = browserConnections.get(current);
    if (!browser) {
      throw new Error(`No browser connection for workspace: ${current}`);
    }

    return browser;
  }

  // GET / - Server info
  app.get("/", async (_req: Request, res: Response) => {
    const instance = workspaceManager.getCurrentInstance();
    res.json({
      wsEndpoint: instance?.wsEndpoint || null,
      workspace: workspaceManager.getCurrentWorkspace(),
      mode: "workspaces",
    });
  });

  // GET /pages - List all pages
  app.get("/pages", (_req: Request, res: Response) => {
    const response: ListPagesResponse = {
      pages: Array.from(pageRegistry.keys()),
    };
    res.json(response);
  });

  // POST /pages - Get or create page
  app.post("/pages", async (req: Request, res: Response) => {
    const body = req.body as GetPageRequest;
    const { name, viewport } = body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required and must be a string" });
      return;
    }

    try {
      // Check if page already exists
      let entry = pageRegistry.get(name);

      if (!entry) {
        const browser = await getCurrentBrowser();
        const context = browser.contexts()[0];

        if (!context) {
          res.status(500).json({ error: "No browser context available" });
          return;
        }

        // Create new page
        const page = await context.newPage();

        // Apply viewport if provided
        if (viewport) {
          await page.setViewportSize(viewport);
        }

        // Get target ID via CDP
        const cdpSession = await context.newCDPSession(page);
        const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
        await cdpSession.detach();

        const currentWorkspace = workspaceManager.getCurrentWorkspace()!;

        entry = {
          page,
          targetId: targetInfo.targetId,
          workspace: currentWorkspace,
        };
        pageRegistry.set(name, entry);

        // Clean up on page close
        page.on("close", () => {
          pageRegistry.delete(name);
        });
      }

      const instance = workspaceManager.getCurrentInstance();

      const response: GetPageResponse = {
        wsEndpoint: instance?.wsEndpoint || "",
        name,
        targetId: entry.targetId,
      };
      res.json(response);
    } catch (err) {
      console.error(`Failed to create page:`, err);
      res.status(500).json({
        error: `Failed to create page: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // DELETE /pages/:name - Close a page
  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = pageRegistry.get(name);

    if (entry) {
      await entry.page.close();
      pageRegistry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(404).json({ error: "page not found" });
  });

  // ==========================================================================
  // Server Lifecycle
  // ==========================================================================

  const server = app.listen(port, () => {
    console.log(`Workspace server running on port ${port}`);
    console.log(`Default workspace: ${config.defaultWorkspace}`);
  });

  // Track connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  let cleaningUp = false;

  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down workspace server...");

    // Close all connections
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();

    // Close all pages
    for (const entry of pageRegistry.values()) {
      try {
        await entry.page.close();
      } catch {}
    }
    pageRegistry.clear();

    // Disconnect all browsers
    for (const browser of browserConnections.values()) {
      try {
        await browser.close();
      } catch {}
    }
    browserConnections.clear();

    // Stop all workspaces
    workspaceManager.stopAll();

    server.close();
    console.log("Workspace server stopped.");
  };

  // Signal handlers
  const signalHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  process.on("SIGHUP", signalHandler);

  return {
    port,
    async stop() {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
      process.off("SIGHUP", signalHandler);
      await cleanup();
    },
  };
}
