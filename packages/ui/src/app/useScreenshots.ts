import { useEffect, useRef, useState } from 'react';
import { useApp } from './context';

/**
 * Object URLs for filmstrip frames, loaded as they are asked for and revoked when the view goes
 * away. A frame that cannot be read is left out; the strip shows it as missing.
 */
export function useScreenshots(ids: readonly number[]): ReadonlyMap<number, string> {
  const { host } = useApp();
  const [urls, setUrls] = useState<ReadonlyMap<number, string>>(new Map());
  const held = useRef(new Map<number, string>());
  const key = ids.join(',');

  useEffect(() => {
    let cancelled = false;
    const wanted = key === '' ? [] : key.split(',').map(Number);
    for (const id of wanted) {
      if (held.current.has(id)) continue;
      host
        .readScreenshot(id)
        .then((bytes) => {
          if (cancelled || typeof URL.createObjectURL !== 'function') return;
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
          held.current.set(id, url);
          setUrls(new Map(held.current));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [host, key]);

  useEffect(() => {
    const store = held.current;
    return () => {
      for (const url of store.values()) URL.revokeObjectURL(url);
      store.clear();
    };
  }, []);

  return urls;
}
