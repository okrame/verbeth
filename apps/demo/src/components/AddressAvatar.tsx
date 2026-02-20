import { useMemo } from 'react';

export function AddressAvatar({ address, size = 28 }: { address: string; size?: number }) {
  const gradient = useMemo(() => {
    const hex = address.toLowerCase().replace('0x', '');
    const h1 = parseInt(hex.slice(0, 4), 16) % 360;
    const h2 = parseInt(hex.slice(4, 8), 16) % 360;
    const angle = parseInt(hex.slice(8, 12), 16) % 360;
    return `linear-gradient(${angle}deg, hsl(${h1},70%,50%), hsl(${h2},70%,50%))`;
  }, [address]);

  return (
    <div
      className="rounded-full shrink-0"
      style={{ width: size, height: size, background: gradient }}
    />
  );
}
