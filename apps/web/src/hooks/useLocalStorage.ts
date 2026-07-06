// Minimal JSON-backed localStorage helpers (no Effect dependency).
// Originally schema-validated in the source app; Labee stores simple
// JSON-serialisable values, so plain parse/stringify is sufficient.

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (key: string) => store.get(key) ?? null,
          key: (index: number) => Array.from(store.keys()).at(index) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (key: string) => store.delete(key),
          setItem: (key: string, value: string) => {
            store.set(key, value);
          },
        } satisfies Storage;
      })();

export const getLocalStorageItem = <T>(key: string): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  if (item === null) return null;
  try {
    return JSON.parse(item) as T;
  } catch {
    return null;
  }
};

export const setLocalStorageItem = <T>(key: string, value: T): void => {
  isomorphicLocalStorage.setItem(key, JSON.stringify(value));
};

export const removeLocalStorageItem = (key: string): void => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "labee:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

import { useCallback, useEffect, useRef, useState } from "react";

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((val: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = getLocalStorageItem<T>(key);
      return item ?? initialValue;
    } catch (error) {
      console.error("[LOCALSTORAGE] Error:", error);
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        setStoredValue((prev) => {
          const valueToStore = typeof value === "function" ? (value as (val: T) => T)(prev) : value;
          if (valueToStore === null) {
            removeLocalStorageItem(key);
          } else {
            setLocalStorageItem(key, valueToStore);
          }
          queueMicrotask(() => dispatchLocalStorageChange(key));
          return valueToStore;
        });
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    },
    [key],
  );

  const prevKeyRef = useRef(key);

  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      try {
        const newValue = getLocalStorageItem<T>(key);
        setStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    }
  }, [key, initialValue]);

  useEffect(() => {
    const syncFromStorage = () => {
      try {
        const newValue = getLocalStorageItem<T>(key);
        setStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key) syncFromStorage();
    };
    const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key) syncFromStorage();
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    };
  }, [key, initialValue]);

  return [storedValue, setValue];
}
