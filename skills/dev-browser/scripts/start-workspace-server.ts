#!/usr/bin/env npx tsx
/**
 * Start the workspace server with Chrome profile support
 *
 * Usage:
 *   npx tsx scripts/start-workspace-server.ts
 *   npx tsx scripts/start-workspace-server.ts --config /path/to/workspaces.json
 */

import { serveWorkspaces } from "../src/workspace-server.js";
import { join } from "node:path";
import { homedir } from "node:os";

// Parse command line args
const args = process.argv.slice(2);
let configPath: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) {
    configPath = args[i + 1];
    i++;
  }
}

// Default config path
if (!configPath) {
  configPath = join(homedir(), ".dev-browser", "workspaces.json");
}

console.log("=".repeat(60));
console.log("Dev Browser - Workspace Mode (Chrome Profiles)");
console.log("=".repeat(60));
console.log("");
console.log("This mode uses your actual Chrome browser profiles.");
console.log("Workspaces launch off-screen Chrome windows for automation.");
console.log("");

async function main() {
  try {
    const server = await serveWorkspaces({
      port: 9222,
      configPath,
    });

    console.log("");
    console.log("Server ready!");
    console.log(`  HTTP API: http://127.0.0.1:${server.port}`);
    console.log("");
    console.log("Quick start:");
    console.log("  1. Switch workspace: curl -X POST http://localhost:9222/workspace/switch -H 'Content-Type: application/json' -d '{\"workspace\":\"personal\"}'");
    console.log("  2. Create page: curl -X POST http://localhost:9222/pages -H 'Content-Type: application/json' -d '{\"name\":\"test\"}'");
    console.log("");
    console.log("Press Ctrl+C to stop.");

  } catch (err) {
    console.error("Failed to start workspace server:", err);
    process.exit(1);
  }
}

main();
