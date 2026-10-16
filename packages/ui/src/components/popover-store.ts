// At most one popover is open: opening another closes the previous one.

interface Entry {
  id: string;
  close(): void;
}

let current: Entry | null = null;

export function claimPopover(id: string, close: () => void): void {
  if (current && current.id !== id) current.close();
  current = { id, close };
}

export function releasePopover(id: string): void {
  if (current?.id === id) current = null;
}
