let counter = 0;

/** Collision-resistant id that works without crypto.randomUUID (older iOS Safari). */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 0xffff;
  const rand =
    typeof crypto !== 'undefined' && 'getRandomValues' in crypto
      ? Array.from(crypto.getRandomValues(new Uint8Array(6)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      : Math.random().toString(16).slice(2, 14);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
