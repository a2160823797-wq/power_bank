'use client';

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';

export type Language = 'en' | 'zh';

const LANGUAGE_KEY = 'powerbank.language';
const listeners = new Set<() => void>();
let cur_language: Language | undefined;

function getLanguage() {
  if (cur_language) return cur_language;
  try {
    const savedLanguage = localStorage.getItem(LANGUAGE_KEY);
    cur_language = savedLanguage === 'zh' ? 'zh' : 'en';
  } catch {
    cur_language = 'en';
  }
  return cur_language;
}

function setLanguage(language: Language) {
  cur_language = language;
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {}
  for (const listener of listeners) listener();
}

function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getDefaultLanguage = (): Language => 'en';
const LanguageContext = createContext({
  language: 'en' as Language,
  setLanguage,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const language = useSyncExternalStore(
    subscribeLanguage,
    getLanguage,
    getDefaultLanguage,
  );

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  return (
    <LanguageContext value={{ language, setLanguage }}>
      {children}
    </LanguageContext>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
