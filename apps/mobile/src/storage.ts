// Small key/value persistence: SecureStore for secrets on native, AsyncStorage
// for preferences, localStorage on web. Every access is guarded — storage can
// be unavailable (private mode, first launch) and the app must still work.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

let SecureStore: typeof import("expo-secure-store") | null = null;
if (Platform.OS !== "web") {
  try {
    SecureStore = require("expo-secure-store");
  } catch {
    SecureStore = null;
  }
}

export async function getPref(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") return localStorage.getItem(key);
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setPref(key: string, value: string | null): Promise<void> {
  try {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return;
    }
    if (value === null) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export async function getSecret(key: string): Promise<string | null> {
  try {
    if (SecureStore) return await SecureStore.getItemAsync(key);
  } catch {
    // fall through
  }
  return getPref(`secret:${key}`);
}

export async function setSecret(key: string, value: string | null): Promise<void> {
  try {
    if (SecureStore) {
      if (value === null) await SecureStore.deleteItemAsync(key);
      else await SecureStore.setItemAsync(key, value);
      return;
    }
  } catch {
    // fall through
  }
  await setPref(`secret:${key}`, value);
}
