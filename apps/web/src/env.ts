/** True when running inside the Electron desktop shell. */
export const isElectron =
  typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent);
