/** Local icon slugs are lowercase; model maker and serving IDs retain their declared spelling. */
export function makerLogoPath(maker: string): string {
  return `/icons/brands/${encodeURIComponent(maker.trim().toLowerCase())}.svg`;
}
