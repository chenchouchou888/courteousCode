import { useSettingsStore } from '../../stores/settingsStore';

/** Default "C" icon SVG — matches the courteousCode app icon */
function DefaultIcon() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 171 171" fill="none">
      <rect width="171" height="171" rx="38.5" className="fill-accent" />
      <path
        d="M85.5 48C63.5 48 48 63.5 48 85.5S63.5 123 85.5 123c13 0 24.5-5 33-13l-12-14c-5.5 5-12.8 8-21 8-16 0-28-12-28-28s12-28 28-28c8.2 0 15.5 3 21 8l12-14c-8.5-8-20-13-33-13z"
        className="fill-white dark:fill-black"
      />
    </svg>
  );
}

interface AiAvatarProps {
  /** Tailwind size class for the container, e.g. "w-8 h-8", "w-16 h-16", "w-20 h-20" */
  size: string;
  /** Tailwind border-radius class, e.g. "rounded-[10px]", "rounded-2xl", "rounded-3xl" */
  rounded?: string;
  /** Extra classes for the container */
  className?: string;
}

/**
 * AI avatar that shows a user-customized image if set, otherwise the default </> icon.
 * The custom image is stored as a data URL in settingsStore.aiAvatarUrl.
 */
export function AiAvatar({ size, rounded = 'rounded-[10px]', className = '' }: AiAvatarProps) {
  const avatarUrl = useSettingsStore((s) => s.aiAvatarUrl);

  // When custom image is set, use transparent bg to avoid black border bleed on rounded corners
  const bgClass = avatarUrl ? 'bg-transparent' : 'bg-black dark:bg-white';

  return (
    <div className={`${size} ${rounded} ${bgClass}
      flex items-center justify-center flex-shrink-0 shadow-md overflow-hidden ${className}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="AI" className="w-full h-full object-cover" />
      ) : (
        <DefaultIcon />
      )}
    </div>
  );
}
