export type IconName =
  | 'logo'
  | 'back'
  | 'forward'
  | 'search'
  | 'close'
  | 'plus'
  | 'pin'
  | 'file'
  | 'collapse'
  | 'expand'
  | 'info'
  | 'clock'
  | 'chevron-down'
  | 'chevron-right'
  | 'alert';

const PATHS: Record<IconName, string[]> = {
  logo: ['M4 18c3 0 3-6 6-6s3 4 6 4 2-8 4-10'],
  back: ['M15 18l-6-6 6-6'],
  forward: ['M9 18l6-6-6-6'],
  search: ['M20 20l-3.5-3.5'],
  close: ['M6 6l12 12M18 6L6 18'],
  plus: ['M12 5v14M5 12h14'],
  pin: ['M9 4h6l-1 6 3 3H7l3-3-1-6z', 'M12 13v7'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  collapse: ['M13 6l6 6-6 6', 'M5 6l6 6-6 6'],
  expand: ['M11 6l-6 6 6 6', 'M19 6l-6 6 6 6'],
  info: ['M12 11v5M12 8h.01'],
  clock: ['M12 7v5l3 2'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  alert: ['M12 8v5M12 16h.01'],
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
