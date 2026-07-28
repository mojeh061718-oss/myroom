import { create } from "zustand";
import type { DisplayUnit } from "@myroom/geometry";
import { DEFAULT_SETTINGS, getSettings, putSettings, type Settings } from "../lib/db.js";

interface SettingsState extends Settings {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDisplayUnit: (unit: DisplayUnit) => void;
  setTutorialSeen: (seen: boolean) => void;
  setTheme: (theme: "dark" | "light") => void;
  setQuality: (quality: Settings["quality"]) => void;
  /** Awaits the write: a Save the user can act on must be on disk before it returns. */
  setService: (url: string, token: string) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => {
  const persist = () => {
    const { tutorialSeen, displayUnit, theme, quality, serviceUrl, serviceToken } = get();
    return putSettings({ tutorialSeen, displayUnit, theme, quality, serviceUrl, serviceToken });
  };
  return {
    ...DEFAULT_SETTINGS,
    hydrated: false,
    hydrate: async () => {
      const stored = await getSettings();
      set({ ...stored, hydrated: true });
      document.documentElement.dataset.theme = stored.theme;
    },
    setDisplayUnit: (displayUnit) => {
      set({ displayUnit });
      void persist();
    },
    setTutorialSeen: (tutorialSeen) => {
      set({ tutorialSeen });
      void persist();
    },
    setQuality: (quality) => {
      set({ quality });
      void persist();
    },
    setService: (serviceUrl, serviceToken) => {
      set({ serviceUrl: serviceUrl.trim().replace(/\/$/, ""), serviceToken: serviceToken.trim() });
      // Returned, not fired and forgotten: closing the app right after tapping
      // Save must not lose the address that was just typed in.
      return persist();
    },
    setTheme: (theme) => {
      set({ theme });
      document.documentElement.dataset.theme = theme;
      void persist();
    },
  };
});
