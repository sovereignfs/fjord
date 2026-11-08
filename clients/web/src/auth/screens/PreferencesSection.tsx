'use client';

import { useEffect, useState } from 'react';
import { SegmentedControl } from '@sovereignfs/ui';
import {
  type TextSize,
  type ThemeChoice,
  chooseTextSize,
  chooseTheme,
  readTextSize,
  readTheme,
} from '../../theme/preferences';
import styles from './AccountShell.module.css';

/**
 * Account, Preferences: how Fjord looks to this person, kept in this browser and applied at once (`theme/preferences.ts`): the theme (the system's, or light or dark) and the size
 * of text. What is chosen is read once the page is in the browser, so the server draws the defaults first.
 */
export function PreferencesSection() {
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const [size, setSize] = useState<TextSize>('default');
  useEffect(() => {
    try {
      setTheme(readTheme(window.localStorage));
      setSize(readTextSize(window.localStorage));
    } catch {
      // No storage: the defaults.
    }
  }, []);

  function storage(): Storage | undefined {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }

  return (
    <>
      <div className={styles.group}>
        <h2>Appearance</h2>
        <div className={styles.fit}>
          <SegmentedControl<ThemeChoice>
            aria-label="Theme"
            value={theme}
            onChange={(next) => {
              setTheme(next);
              chooseTheme(
                next,
                document.documentElement,
                window.matchMedia('(prefers-color-scheme: dark)').matches,
                storage(),
              );
            }}
            options={[
              { label: 'System', value: 'system' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
          />
        </div>
        <p className={styles.hint}>Applies immediately and to every session on this device.</p>
      </div>
      <div className={styles.group}>
        <h2>Text size</h2>
        <div className={styles.fit}>
          <SegmentedControl<TextSize>
            aria-label="Text size"
            value={size}
            onChange={(next) => {
              setSize(next);
              chooseTextSize(next, document.documentElement, storage());
            }}
            options={[
              { label: 'Default', value: 'default' },
              { label: 'Large', value: 'large' },
              { label: 'Larger', value: 'larger' },
            ]}
          />
        </div>
        <p className={styles.hint}>
          Enlarges text across the app. Applies immediately and to every session on this device.
        </p>
      </div>
    </>
  );
}
