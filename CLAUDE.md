# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

Always use Node.js/npm instead of Bun.

```bash
# Install dependencies (from skills/dev-browser/ directory)
cd skills/dev-browser && npm install

# Start the standard dev-browser server (single Chromium instance)
cd skills/dev-browser && npm run start-server

# Start the workspace server (multiple Chrome profiles)
cd skills/dev-browser && npm run start-workspaces

# Run dev mode with watch
cd skills/dev-browser && npm run dev

# Run tests (uses vitest)
cd skills/dev-browser && npm test

# Run TypeScript check
cd skills/dev-browser && npx tsc --noEmit
```

## Important: Before Completing Code Changes

**Always run these checks before considering a task complete:**

1. **TypeScript check**: `npx tsc --noEmit` - Ensure no type errors
2. **Tests**: `npm test` - Ensure all tests pass

Common TypeScript issues in this codebase:

- Use `import type { ... }` for type-only imports (required by `verbatimModuleSyntax`)
- Browser globals (`document`, `window`) in `page.evaluate()` callbacks need `declare const document: any;` since DOM lib is not included

## Project Architecture

### Overview

This is a browser automation tool designed for developers and AI agents. It solves the problem of maintaining browser state across multiple script executions - unlike Playwright scripts that start fresh each time, dev-browser keeps pages alive and reusable.

### Structure

All source code lives in `skills/dev-browser/`:

- `src/index.ts` - Server: launches persistent Chromium context, exposes HTTP API for page management
- `src/client.ts` - Client: connects to server, retrieves pages by name via CDP
- `src/types.ts` - Shared TypeScript types for API requests/responses
- `src/dom/` - DOM tree extraction utilities for LLM-friendly page inspection
- `scripts/start-server.ts` - Entry point to start the server
- `tmp/` - Directory for temporary automation scripts

### Path Aliases

The project uses `@/` as a path alias to `./src/`. This is configured in both `package.json` (via `imports`) and `tsconfig.json` (via `paths`).

```typescript
// Import from src/client.ts
import { connect } from "@/client.js";

// Import from src/index.ts
import { serve } from "@/index.js";
```

### How It Works

1. **Server** (`serve()` in `src/index.ts`):
   - Launches Chromium with `launchPersistentContext` (preserves cookies, localStorage)
   - Exposes HTTP API on port 9222 for page management
   - Exposes CDP WebSocket endpoint on port 9223
   - Pages are registered by name and persist until explicitly closed

2. **Client** (`connect()` in `src/client.ts`):
   - Connects to server's HTTP API
   - Uses CDP `targetId` to reliably find pages across reconnections
   - Returns standard Playwright `Page` objects for automation

3. **Key API Endpoints**:
   - `GET /` - Returns CDP WebSocket endpoint
   - `GET /pages` - Lists all named pages
   - `POST /pages` - Gets or creates a page by name (body: `{ name: string }`)
   - `DELETE /pages/:name` - Closes a page

### Usage Pattern

```typescript
import { connect } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("my-page"); // Gets existing or creates new
await page.goto("https://example.com");
// Page persists for future scripts
await client.disconnect(); // Disconnects CDP but page stays alive on server
```

## Workspace Mode (Chrome Profiles)

The workspace server allows running multiple isolated Chrome instances with separate user data directories. Each workspace has its own cookies, localStorage, and login sessions.

### Starting the Workspace Server

```bash
npm run start-workspaces
```

This starts the workspace server on port 9222, reading configuration from `~/.dev-browser/workspaces.json`.

### Configuration

Default configuration at `~/.dev-browser/workspaces.json`:

```json
{
  "workspaces": {
    "personal": {
      "profileDirectory": "Default",
      "port": 9230
    },
    "work": {
      "profileDirectory": "James-Work",
      "port": 9231
    }
  },
  "defaultWorkspace": "personal"
}
```

### Workspace API Endpoints

- `GET /workspaces` - List all workspaces and their states
- `GET /workspace/current` - Get current active workspace
- `POST /workspace/switch` - Switch to workspace (body: `{ "workspace": "name" }`)
- `POST /workspace/stop` - Stop a workspace (body: `{ "workspace": "name" }`)

Standard page endpoints (`GET/POST/DELETE /pages`) work with the current workspace.

### Client Usage with Workspaces

```typescript
import { connect } from "@/client.js";

const client = await connect("http://localhost:9222");

// Switch to work workspace
await client.switchWorkspace("work");

// Create a page in the work workspace
const page = await client.page("work-tasks");
await page.goto("https://jira.example.com");

// Switch to personal workspace (runs in parallel)
await client.switchWorkspace("personal");
const personalPage = await client.page("shopping");
await personalPage.goto("https://amazon.com");

// Both workspaces remain running with their own sessions
```

### How It Works

1. Each workspace launches a separate Chrome instance with `--user-data-dir`
2. Workspaces run on a BetterDisplay virtual display for invisible automation (macOS)
3. Sessions persist in `~/.dev-browser/workspaces/<name>/`
4. Multiple workspaces can run in parallel on different CDP ports

### Virtual Display Setup (macOS)

Chrome windows are positioned on a BetterDisplay virtual display so they don't appear on your screen. This is preferred over headless mode because some sites (like SharePoint) detect headless browsers.

**Requirements:**
- BetterDisplay app installed and running
- `betterdisplaycli` available in PATH (installed via Homebrew with BetterDisplay)
- `displayplacer` installed (`brew install displayplacer`)

**How it works:**
1. On first workspace launch, the server checks for a virtual display using `displayplacer list`
2. If no virtual display exists, it creates one using `betterdisplaycli create -type=VirtualScreen`
3. Chrome windows are positioned on the virtual display using `--window-position`
4. If no virtual display is available, falls back to headless mode

**Manual virtual display management:**
```bash
# Create virtual display
betterdisplaycli create -type=VirtualScreen -virtualScreenName="DevBrowser" -aspectWidth=1920 -aspectHeight=1080 -connected=on

# List displays (shows origin coordinates)
displayplacer list

# Discard virtual displays
betterdisplaycli discard -type=VirtualScreen
```

## Node.js Guidelines

- Use `npx tsx` for running TypeScript files
- Use `dotenv` or similar if you need to load `.env` files
- Use `node:fs` for file system operations
