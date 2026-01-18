/**
 * Chrome Launcher - Launches actual Google Chrome with isolated user data directories
 *
 * This module handles launching Chrome instances with:
 * - Separate user-data-dir per workspace (allows parallel instances)
 * - Named profiles within each workspace for cookie/session persistence
 * - Virtual display positioning for invisible automation (via BetterDisplay)
 * - Remote debugging ports for CDP connections
 *
 * NOTE: We use separate user-data-dirs (not Chrome's built-in profiles) because:
 * - Chrome only allows one instance per profile
 * - If user's Chrome is open with Default profile, we can't automate it
 * - Separate user-data-dirs allow parallel automation instances
 *
 * HIDING STRATEGY: Uses BetterDisplay virtual display on macOS.
 * - Create virtual display: betterdisplaycli create -type=VirtualScreen -virtualScreenName="DevBrowser" -connected=on
 * - Chrome windows position on the virtual display (not visible on real monitors)
 * - SSO/auth works normally (unlike headless mode which is detected by some sites)
 */

import { spawn, exec, type ChildProcess } from "node:child_process";
import { platform, homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import type { WorkspaceConfig, WorkspaceState } from "./types.js";

const execAsync = promisify(exec);

// Chrome executable paths by platform
const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
};

const DEFAULT_WINDOW_SIZE = { width: 1920, height: 1080 };

// Virtual display name for automation (created via BetterDisplay)
const VIRTUAL_DISPLAY_NAME = "DevBrowser";

// Base directory for workspace user data
const WORKSPACE_DATA_DIR = join(homedir(), ".dev-browser", "workspaces");

export interface ChromeLaunchOptions {
  /** Workspace name (used for user-data-dir) */
  workspaceName: string;
  /** Original profile directory name (for display purposes) */
  profileDirectory: string;
  port: number;
  /** Use headless mode (truly invisible) - some sites detect this */
  headless?: boolean;
  windowSize?: { width: number; height: number };
}

interface DisplayInfo {
  origin: { x: number; y: number };
  resolution: { width: number; height: number };
}

/**
 * Get the position of a virtual display using displayplacer
 * Returns null if no virtual display found (falls back to headless)
 */
async function getVirtualDisplayPosition(): Promise<DisplayInfo | null> {
  if (platform() !== "darwin") return null;

  try {
    const { stdout } = await execAsync("displayplacer list 2>/dev/null");

    // Parse displayplacer output to find screens
    // Look for screens that are NOT the MacBook built-in and NOT external monitors
    // Virtual displays appear as "external screen" type but have Origin beyond physical displays
    const screens: Array<{ type: string; origin: string; resolution: string }> = [];
    let currentScreen: { type?: string; origin?: string; resolution?: string } = {};

    for (const line of stdout.split("\n")) {
      if (line.startsWith("Type:")) {
        currentScreen.type = line.replace("Type:", "").trim();
      } else if (line.startsWith("Origin:")) {
        currentScreen.origin = line.replace("Origin:", "").trim().split(" ")[0]; // Get just the (x,y) part
      } else if (line.startsWith("Resolution:")) {
        currentScreen.resolution = line.replace("Resolution:", "").trim();
      } else if (line.startsWith("Persistent screen id:") && currentScreen.type) {
        if (currentScreen.type && currentScreen.origin && currentScreen.resolution) {
          screens.push({
            type: currentScreen.type,
            origin: currentScreen.origin,
            resolution: currentScreen.resolution,
          });
        }
        currentScreen = {};
      }
    }
    // Don't forget the last screen
    if (currentScreen.type && currentScreen.origin && currentScreen.resolution) {
      screens.push({
        type: currentScreen.type,
        origin: currentScreen.origin,
        resolution: currentScreen.resolution,
      });
    }

    // Find a virtual display (not the MacBook built-in, positioned beyond main display)
    // Virtual displays from BetterDisplay show up as external screens
    // We look for screens with origin.x > 0 (right of main) or origin.y < -1000 (way above)
    for (const screen of screens) {
      if (screen.type === "MacBook built in screen") continue;

      // Parse origin like "(1512,0)" or "(-196,-1200)"
      const originMatch = screen.origin.match(/\((-?\d+),(-?\d+)\)/);
      const resMatch = screen.resolution.match(/(\d+)x(\d+)/);

      if (originMatch && originMatch.length >= 3 && resMatch && resMatch.length >= 3) {
        const x = parseInt(originMatch[1]!, 10);
        const y = parseInt(originMatch[2]!, 10);
        const width = parseInt(resMatch[1]!, 10);
        const height = parseInt(resMatch[2]!, 10);

        // Use screens positioned to the right of main display (x > 0) as automation targets
        // This is where BetterDisplay virtual screens typically appear
        if (x > 0) {
          console.log(`Found virtual display at origin (${x},${y}) with resolution ${width}x${height}`);
          return {
            origin: { x, y },
            resolution: { width, height },
          };
        }
      }
    }

    console.log("No virtual display found, will use headless mode");
    return null;
  } catch {
    console.log("Could not query displays, will use headless mode");
    return null;
  }
}

/**
 * Ensure BetterDisplay virtual screen exists and is connected
 */
async function ensureVirtualDisplay(): Promise<DisplayInfo | null> {
  if (platform() !== "darwin") return null;

  // First check if virtual display already exists
  let display = await getVirtualDisplayPosition();
  if (display) return display;

  // Try to create and connect the virtual display
  try {
    console.log("Creating BetterDisplay virtual screen...");
    await execAsync(
      `betterdisplaycli create -type=VirtualScreen -virtualScreenName="${VIRTUAL_DISPLAY_NAME}" -aspectWidth=1920 -aspectHeight=1080 -connected=on 2>/dev/null`
    );

    // Wait a moment for display to initialize
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Try to get position again
    display = await getVirtualDisplayPosition();
    if (display) {
      console.log("Virtual display created successfully");
      return display;
    }
  } catch {
    console.log("Could not create virtual display");
  }

  return null;
}

export interface ChromeInstance {
  process: ChildProcess;
  port: number;
  profileDirectory: string;
  wsEndpoint?: string;
}

/**
 * Find the Chrome executable for the current platform
 */
export function findChromeExecutable(): string | null {
  const currentPlatform = platform();
  const paths = CHROME_PATHS[currentPlatform] || [];

  // For now, just return the first path for macOS
  // In production, we'd check if the file exists
  if (currentPlatform === "darwin") {
    return paths[0] || null;
  }

  return paths[0] || null;
}

interface BuildChromeArgsOptions extends ChromeLaunchOptions {
  windowPosition?: { x: number; y: number };
}

/**
 * Build Chrome launch arguments
 */
function buildChromeArgs(options: BuildChromeArgsOptions): string[] {
  const {
    workspaceName,
    port,
    headless = false,
    windowSize = DEFAULT_WINDOW_SIZE,
    windowPosition,
  } = options;

  // Create workspace-specific user data directory
  const userDataDir = join(WORKSPACE_DATA_DIR, workspaceName);
  mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--window-size=${windowSize.width},${windowSize.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];

  // Position window on virtual display if available
  if (windowPosition) {
    args.push(`--window-position=${windowPosition.x},${windowPosition.y}`);
  }

  if (headless) {
    // Use Chrome's new headless mode - fully featured and truly invisible
    // Note: Some sites detect headless mode, prefer virtual display positioning
    args.push("--headless=new");
  }

  // Start with about:blank to minimize initial load
  args.push("about:blank");

  return args;
}

// Cached virtual display info to avoid re-querying for each workspace
let cachedVirtualDisplay: DisplayInfo | null | undefined = undefined;

/**
 * Wait for Chrome's CDP endpoint to be available
 */
async function waitForCDP(port: number, maxRetries = 30, delayMs = 500): Promise<string> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const data = await response.json() as { webSocketDebuggerUrl: string };
        return data.webSocketDebuggerUrl;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`Chrome CDP not available after ${maxRetries} retries: ${lastError?.message}`);
}

/**
 * Launch a Chrome instance with the specified workspace
 */
export async function launchChrome(options: ChromeLaunchOptions): Promise<ChromeInstance> {
  const chromePath = findChromeExecutable();

  if (!chromePath) {
    throw new Error(`Chrome executable not found for platform: ${platform()}`);
  }

  // Try to get virtual display for invisible automation (macOS only)
  // Use cached value if already queried, otherwise query once
  if (cachedVirtualDisplay === undefined) {
    cachedVirtualDisplay = await ensureVirtualDisplay();
  }

  const windowPosition = cachedVirtualDisplay?.origin;
  const useHeadless = !windowPosition && !options.headless; // Fall back to headless if no virtual display

  const args = buildChromeArgs({
    ...options,
    headless: useHeadless ? true : options.headless,
    windowPosition,
  });

  console.log(`Launching Chrome for workspace: ${options.workspaceName} (profile: ${options.profileDirectory})`);
  console.log(`User data dir: ${join(WORKSPACE_DATA_DIR, options.workspaceName)}`);
  console.log(`CDP port: ${options.port}`);
  if (windowPosition) {
    console.log(`Window position: (${windowPosition.x}, ${windowPosition.y}) on virtual display`);
  } else if (useHeadless) {
    console.log("Using headless mode (no virtual display available)");
  }

  const chromeProcess = spawn(chromePath, args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Log Chrome stderr for debugging
  chromeProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes("DevTools listening")) {
      console.error(`[Chrome ${options.profileDirectory}] ${msg}`);
    }
  });

  chromeProcess.on("error", (err) => {
    console.error(`Chrome process error (${options.profileDirectory}):`, err);
  });

  chromeProcess.on("exit", (code, signal) => {
    console.log(`Chrome process exited (${options.profileDirectory}): code=${code}, signal=${signal}`);
  });

  // Wait for CDP to be available
  const wsEndpoint = await waitForCDP(options.port);

  console.log(`Chrome ready: ${options.profileDirectory} @ ${wsEndpoint}`);

  return {
    process: chromeProcess,
    port: options.port,
    profileDirectory: options.profileDirectory,
    wsEndpoint,
  };
}

/**
 * Kill a Chrome instance
 */
export function killChrome(instance: ChromeInstance): void {
  if (instance.process && !instance.process.killed) {
    console.log(`Killing Chrome (${instance.profileDirectory})...`);
    instance.process.kill("SIGTERM");

    // Force kill after timeout
    setTimeout(() => {
      if (!instance.process.killed) {
        console.log(`Force killing Chrome (${instance.profileDirectory})...`);
        instance.process.kill("SIGKILL");
      }
    }, 3000);
  }
}

/**
 * Workspace Manager - Manages multiple Chrome profile workspaces
 */
export class WorkspaceManager {
  private workspaces: Map<string, ChromeInstance> = new Map();
  private currentWorkspace: string | null = null;
  private config: Map<string, WorkspaceConfig> = new Map();

  constructor(workspacesConfig: Record<string, WorkspaceConfig>) {
    for (const [name, config] of Object.entries(workspacesConfig)) {
      this.config.set(name, config);
    }
  }

  /**
   * Get the current workspace name
   */
  getCurrentWorkspace(): string | null {
    return this.currentWorkspace;
  }

  /**
   * Get all workspace states
   */
  getWorkspaceStates(): WorkspaceState[] {
    const states: WorkspaceState[] = [];

    for (const [name, config] of this.config.entries()) {
      const instance = this.workspaces.get(name);

      states.push({
        name,
        profileDirectory: config.profileDirectory,
        port: config.port,
        status: instance ? "running" : "stopped",
        wsEndpoint: instance?.wsEndpoint,
        pid: instance?.process.pid,
      });
    }

    return states;
  }

  /**
   * Switch to a workspace, launching Chrome if needed
   */
  async switchWorkspace(name: string): Promise<ChromeInstance> {
    const config = this.config.get(name);

    if (!config) {
      throw new Error(`Unknown workspace: ${name}. Available: ${[...this.config.keys()].join(", ")}`);
    }

    // Check if already running
    let instance = this.workspaces.get(name);

    if (!instance) {
      // Launch Chrome for this workspace
      // Will automatically use virtual display if available, or fall back to headless
      instance = await launchChrome({
        workspaceName: name,
        profileDirectory: config.profileDirectory,
        port: config.port,
        headless: false,
      });

      this.workspaces.set(name, instance);
    }

    this.currentWorkspace = name;
    return instance;
  }

  /**
   * Get the current workspace's Chrome instance
   */
  getCurrentInstance(): ChromeInstance | null {
    if (!this.currentWorkspace) return null;
    return this.workspaces.get(this.currentWorkspace) || null;
  }

  /**
   * Stop a specific workspace
   */
  stopWorkspace(name: string): void {
    const instance = this.workspaces.get(name);

    if (instance) {
      killChrome(instance);
      this.workspaces.delete(name);

      if (this.currentWorkspace === name) {
        this.currentWorkspace = null;
      }
    }
  }

  /**
   * Stop all workspaces
   */
  stopAll(): void {
    for (const [name, instance] of this.workspaces.entries()) {
      killChrome(instance);
    }
    this.workspaces.clear();
    this.currentWorkspace = null;
  }

  /**
   * Check if a workspace is available in config
   */
  hasWorkspace(name: string): boolean {
    return this.config.has(name);
  }

  /**
   * Get workspace config
   */
  getConfig(name: string): WorkspaceConfig | undefined {
    return this.config.get(name);
  }
}
