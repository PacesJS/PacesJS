export type IconName =
  | 'logo'
  | 'back'
  | 'forward'
  | 'search'
  | 'close'
  | 'plus'
  | 'pin'
  | 'flag'
  | 'file'
  | 'collapse'
  | 'expand'
  | 'info'
  | 'clock'
  | 'chevron-down'
  | 'chevron-right'
  | 'alert'
  | 'dock-right'
  | 'dock-bottom'
  | 'wrap'
  | 'maximize'
  | 'click'
  | 'key'
  | 'scroll'
  | 'navigate'
  | 'submit'
  | 'eye'
  | 'more'
  | 'pause'
  | 'play';

const PATHS: Record<IconName, string[]> = {
  logo: ['M4 18c3 0 3-6 6-6s3 4 6 4 2-8 4-10'],
  back: ['M15 18l-6-6 6-6'],
  forward: ['M9 18l6-6-6-6'],
  search: ['M20 20l-3.5-3.5'],
  close: ['M6 6l12 12M18 6L6 18'],
  plus: ['M12 5v14M5 12h14'],
  pin: ['M9 4h6l-1 6 3 3H7l3-3-1-6z', 'M12 13v7'],
  flag: ['M6 21V4', 'M6 5h11l-2 4 2 4H6'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  collapse: ['M13 6l6 6-6 6', 'M5 6l6 6-6 6'],
  expand: ['M11 6l-6 6 6 6', 'M19 6l-6 6 6 6'],
  info: ['M12 11v5M12 8h.01'],
  clock: ['M12 7v5l3 2'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  alert: ['M12 8v5M12 16h.01'],
  'dock-right': ['M4 5h16v14H4z', 'M14 5v14'],
  'dock-bottom': ['M4 5h16v14H4z', 'M4 14h16'],
  wrap: ['M4 7h16', 'M4 12h13a3 3 0 0 1 0 6h-6', 'M13 15l-3 3 3 3'],
  maximize: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  click: ['M5 3l14 7-6 2-2 6z'],
  key: ['M3 7h18v10H3z', 'M7 11h.01', 'M11 11h.01', 'M15 11h.01', 'M7 14h10'],
  scroll: ['M12 4v16', 'M8 8l4-4 4 4', 'M8 16l4 4 4-4'],
  navigate: ['M5 12h14', 'M13 6l6 6-6 6'],
  submit: ['M5 12l5 5 9-10'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['M7 5l12 7-12 7z'],
};

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, strokeWidth = 1.75 }: IconProps) {
  const circle =
    name === 'search' ? (
      <circle cx="11" cy="11" r="7" />
    ) : name === 'info' || name === 'clock' || name === 'alert' ? (
      <circle cx="12" cy="12" r="9" />
    ) : name === 'eye' ? (
      <circle cx="12" cy="12" r="3" />
    ) : name === 'logo' ? (
      <>
        <circle cx="4" cy="18" r="1.6" />
        <circle cx="20" cy="6" r="1.6" />
      </>
    ) : null;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {circle}
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
