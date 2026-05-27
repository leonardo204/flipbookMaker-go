import { createContext, useContext, useState } from "react";

export interface AppSettings {
  claudePath: string;
  claudeVerified: boolean;
  outputPath: string;
  autoUpdate: boolean;
  // Confluence (API 토큰은 OS Keychain에서 별도 관리)
  // spaceKey는 별도 설정으로 두지 않고 업로드 시 부모 페이지 URL에서 자동 추출
  atlassianUrl: string;
  confluenceEmail: string;
  confluenceVerified: boolean;
  // Figma
  figmaToken: string;
  figmaVerified: boolean;
}

const defaultSettings: AppSettings = {
  claudePath: "",
  claudeVerified: false,
  outputPath: "",
  autoUpdate: true,
  atlassianUrl: "",
  confluenceEmail: "",
  confluenceVerified: false,
  figmaToken: "",
  figmaVerified: false,
};

const SettingsContext = createContext<{
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
}>({ settings: defaultSettings, updateSettings: () => {} });

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const stored = localStorage.getItem("flipbookmaker-settings");
      if (!stored) return defaultSettings;
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      // stale 필드 제거: defaultSettings의 키만 picking하여 알려진 필드만 유지.
      // parentPageUrl 등 이전 버전 필드가 localStorage에 남아 있어도 무시된다.
      const knownKeys = Object.keys(defaultSettings);
      const cleaned = Object.fromEntries(
        knownKeys.filter((k) => k in parsed).map((k) => [k, parsed[k]]),
      );
      return { ...defaultSettings, ...(cleaned as Partial<AppSettings>) };
    } catch {
      return defaultSettings;
    }
  });

  const updateSettings = (partial: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      localStorage.setItem("flipbookmaker-settings", JSON.stringify(next));
      return next;
    });
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
