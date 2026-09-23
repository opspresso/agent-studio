export const DEFAULT_SERVICE_NAME = "Agent Studio";
export const DEFAULT_SERVICE_LOGO = "agent-studio";

/** Every selectable folder under public/brands supplies these assets. */
export const BRAND_ASSET_FILES = [
  "logo.png",
  "favicon.ico",
  "favicon-32.png",
  "icon-192.png",
  "apple-touch-icon.png",
] as const;

export interface Branding {
  name: string;
  logo: string;
  logoUrl: string;
  faviconUrl: string;
  favicon32Url: string;
  icon192Url: string;
  appleTouchUrl: string;
}

/** A deployment selects its display name and asset folder independently. */
export function resolveBranding(serviceName?: string, serviceLogo?: string): Branding {
  const name = serviceName?.trim() || DEFAULT_SERVICE_NAME;
  const logo = serviceLogo?.trim() || DEFAULT_SERVICE_LOGO;
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("SERVICE_NAME must be a single line of at most 80 characters");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(logo)) {
    throw new Error("SERVICE_LOGO must name a public/brands folder using lowercase letters, digits, and hyphens");
  }
  const base = `/brands/${logo}`;
  return {
    name,
    logo,
    logoUrl: `${base}/logo.png`,
    faviconUrl: `${base}/favicon.ico`,
    favicon32Url: `${base}/favicon-32.png`,
    icon192Url: `${base}/icon-192.png`,
    appleTouchUrl: `${base}/apple-touch-icon.png`,
  };
}
