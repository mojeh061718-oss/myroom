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
}

export const useSettings = create<SettingsState>((set, get) => {
  const persist = () => {
    const { tutorialSeen, displayUnit, theme, quality } = get();
    void putSettings({ tutorialSeen, displayUnit, theme, quality });
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
      persist();
    },
    setTutorialSeen: (tutorialSeen) => {
      set({ tutorialSeen });
      persist();
    },
    setQuality: (quality) => {
      set({ quality });
      persist();
    },
    setTheme: (theme) => {
      set({ theme });
      document.documentElement.dataset.theme = theme;
      persist();
    },
  };
});
