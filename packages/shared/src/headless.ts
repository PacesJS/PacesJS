type Env = Record<string, string | undefined>;

/** True when there is no display to open a window on, or we are inside an SSH session. */
export function isHeadless(env: Env = process.env, platform: string = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  if (platform === 'linux') return !env.DISPLAY && !env.WAYLAND_DISPLAY;
  return false;
}
