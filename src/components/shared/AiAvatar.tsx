import { useSettingsStore } from '../../stores/settingsStore';

/** Default app icon — uses the courteousCode logo PNG */
function DefaultIcon() {
  return (
    <img src="/app-logo.png" alt="courteousCode" className="w-full h-full object-cover" />
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
  const bgClass = 'bg-transparent';

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
