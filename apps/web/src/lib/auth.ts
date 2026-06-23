import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "./api";

export interface CurrentUser {
  email: string;
  isAdmin: boolean;
}

/** Current signed-in user (null when logged out). */
export function useCurrentUser() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiGet<{ user: CurrentUser | null }>("/api/me").then((r) => r.user),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (creds: { email: string; password: string }) =>
      apiSend<{ ok: boolean; email: string; isAdmin: boolean }>("POST", "/api/auth/login", creds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (creds: { email: string; password: string }) =>
      apiSend<{ ok: boolean; email: string; isAdmin: boolean }>("POST", "/api/auth/signup", creds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend<{ ok: boolean }>("POST", "/api/auth/logout"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}
