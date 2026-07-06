// Typed access to the Electron preload bridge (window.labeeDesktop). Returns
// undefined in the browser / hosted web build, so callers fall back gracefully.

export interface LabeeDesktopBridge {
  isDesktop?: boolean;
  platform?: string;
  signInWithGoogle?: (next?: string) => Promise<void>;
  pickFolder?: (defaultPath?: string) => Promise<string | null>;
}

export function desktopBridge(): LabeeDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { labeeDesktop?: LabeeDesktopBridge }).labeeDesktop;
}

/** True when running inside the Labee desktop app. */
export function isDesktop(): boolean {
  return desktopBridge()?.isDesktop === true;
}
