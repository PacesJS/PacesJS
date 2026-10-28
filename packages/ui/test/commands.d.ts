import 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    goldenWrite(): Promise<boolean>;
    writeGolden(name: string, text: string): Promise<void>;
  }
}
