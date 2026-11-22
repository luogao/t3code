import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const LEGACY_CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v2";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  return (
    getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema) ?? {
      ...(getLocalStorageItem(LEGACY_CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema) ??
        DEFAULT_CLIENT_SETTINGS),
      boringSidebarEnabled: true,
    }
  );
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

/** Storage events fire only for other tabs' writes; a null key means storage was cleared. */
export function subscribeBrowserClientSettingsWrites(onChange: () => void): () => void {
  if (!hasWindow()) {
    return () => undefined;
  }
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === CLIENT_SETTINGS_STORAGE_KEY ||
      event.key === LEGACY_CLIENT_SETTINGS_STORAGE_KEY ||
      event.key === null
    ) {
      onChange();
    }
  };
  const target = window;
  target.addEventListener("storage", handleStorage);
  return () => target.removeEventListener("storage", handleStorage);
}
