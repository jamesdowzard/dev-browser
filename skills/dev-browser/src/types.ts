// API request/response types - shared between client and server

// ============================================================================
// Workspace Types (Chrome Profile Support)
// ============================================================================

export interface WorkspaceConfig {
  /** Chrome profile directory name (e.g., "Default", "James-Work") */
  profileDirectory: string;
  /** CDP port for this workspace */
  port: number;
}

export interface WorkspacesConfig {
  workspaces: Record<string, WorkspaceConfig>;
  defaultWorkspace: string;
}

export interface WorkspaceState {
  name: string;
  profileDirectory: string;
  port: number;
  status: "stopped" | "starting" | "running";
  wsEndpoint?: string;
  pid?: number;
}

export interface ListWorkspacesResponse {
  workspaces: WorkspaceState[];
  current: string | null;
}

export interface SwitchWorkspaceRequest {
  workspace: string;
}

export interface SwitchWorkspaceResponse {
  workspace: string;
  wsEndpoint: string;
  status: "running";
}

export interface CurrentWorkspaceResponse {
  workspace: string | null;
  wsEndpoint: string | null;
}

// ============================================================================
// Server Options
// ============================================================================

export interface ServeOptions {
  port?: number;
  headless?: boolean;
  cdpPort?: number;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
  /** Enable Chrome profile workspace mode (uses actual Chrome instead of Chromium) */
  useWorkspaces?: boolean;
  /** Path to workspaces config file */
  workspacesConfigPath?: string;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface GetPageRequest {
  name: string;
  /** Optional viewport size for new pages */
  viewport?: ViewportSize;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
}
