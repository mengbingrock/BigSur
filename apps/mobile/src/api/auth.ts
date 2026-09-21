import { apiGet, apiSend, type Target } from "./client";

export interface User {
  email: string;
  isAdmin: boolean;
}

export const me = (t: Target) => apiGet<{ user: User | null }>(t, "/api/me");
export const login = (t: Target, email: string, password: string) =>
  apiSend<{ ok: true; email: string; isAdmin: boolean }>(t, "POST", "/api/auth/login", { email, password });
export const logout = (t: Target) => apiSend<{ ok: true }>(t, "POST", "/api/auth/logout");

export const providers = (t: Target) => apiGet<{ google: boolean }>(t, "/api/auth/providers");
