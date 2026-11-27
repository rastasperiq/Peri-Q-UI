import type { NextConfig } from "next";

// Only the restaurant's own Supabase photo bucket may be resized by the image
// optimiser. Any other host would turn the optimiser into an open proxy.
function menuImageHost(): string {
  const fallback = "nxzelriapklqaxcxmoys.supabase.co";
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return url ? new URL(url).hostname : fallback;
  } catch {
    return fallback;
  }
}

// Browser hardening (audit SA-013). The enforced policy only blocks framing,
// plugins, <base> hijacking and cross-site form posts, which the site never
// needs. The full script/connect policy is report-only until it has been
// watched in the browser console on TEST; then move it to the enforced header.
function securityHeaders() {
  const supabase = menuImageHost();
  const enforced = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";
  const reportOnly = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://${supabase}`,
    "font-src 'self' data:",
    `connect-src 'self' https://${supabase} wss://${supabase}`,
    "frame-src 'none'",
    enforced,
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: enforced },
    { key: "Content-Security-Policy-Report-Only", value: reportOnly },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ];
}

const nextConfig: NextConfig = {
  trailingSlash: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [390, 640, 828, 1080, 1440, 1920],
    imageSizes: [96, 160, 256, 384],
    minimumCacheTTL: 60 * 60 * 24 * 7,
    remotePatterns: [
      {
        protocol: "https",
        hostname: menuImageHost(),
        pathname: "/storage/v1/object/public/menu-images/**",
      },
    ],
  },
};

export default nextConfig;
