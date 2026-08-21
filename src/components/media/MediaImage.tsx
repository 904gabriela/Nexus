import { useEffect, useState } from 'react';
import type { ID } from '../../types';
import { acquireUrl, releaseUrl } from '../../media/mediaStore';

/**
 * Renders a blob-backed image by id, acquiring a ref-counted object URL and
 * releasing it on unmount so we never leak.
 */
export function useMediaUrl(mediaId: ID | null | undefined): {
  url: string | null;
  loading: boolean;
  missing: boolean;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!mediaId);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let acquired: ID | null = null;

    if (!mediaId) {
      setUrl(null);
      setLoading(false);
      setMissing(false);
      return;
    }

    setLoading(true);
    setMissing(false);
    acquireUrl(mediaId)
      .then((next) => {
        if (cancelled) {
          if (next) releaseUrl(mediaId);
          return;
        }
        if (next) {
          acquired = mediaId;
          setUrl(next);
        } else {
          setMissing(true);
          setUrl(null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMissing(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (acquired) releaseUrl(acquired);
    };
  }, [mediaId]);

  return { url, loading, missing };
}

interface AvatarProps {
  mediaId: ID | null;
  /** Fallback remote/data URL when no blob is stored. */
  fallbackUrl?: string;
  name: string;
  size?: number;
  square?: boolean;
  className?: string;
}

/** Avatar with graceful degradation to initials — never a broken image icon. */
export function Avatar({
  mediaId,
  fallbackUrl,
  name,
  size = 44,
  square,
  className = '',
}: AvatarProps) {
  const { url } = useMediaUrl(mediaId);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const src = url ?? (fallbackUrl && !remoteFailed ? fallbackUrl : null);

  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join('') || '?';

  if (!src) {
    return (
      <div
        className={`avatar-fallback${square ? ' avatar-square' : ''} ${className}`}
        style={{ width: size, height: size, fontSize: Math.max(11, size * 0.36) }}
        aria-hidden="true"
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      className={`avatar${square ? ' avatar-square' : ''} ${className}`}
      src={src}
      alt={name ? `${name} avatar` : 'Avatar'}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
      decoding="async"
      onError={() => setRemoteFailed(true)}
    />
  );
}

/** Full-bleed image for covers, backgrounds and gallery previews. */
export function MediaImage({
  mediaId,
  alt,
  className,
  style,
  onClick,
}: {
  mediaId: ID | null;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
}) {
  const { url, loading, missing } = useMediaUrl(mediaId);
  if (loading) return <div className={className} style={style} aria-busy="true" />;
  if (missing || !url) {
    return (
      <div className={className} style={style} role="img" aria-label={`${alt} (image unavailable)`} />
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      style={style}
      onClick={onClick}
      loading="lazy"
      decoding="async"
    />
  );
}
