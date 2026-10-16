import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Phones on the LAN load the dev server via its IP (see scripts/dev-https.sh).
  allowedDevOrigins: (process.env.DEV_ORIGINS ?? "").split(",").filter(Boolean),
  serverExternalPackages: ["sharp", "postgres"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  outputFileTracingExcludes: { "*": ["./storage/**", "./.pgdata/**", "./assets/**"] },
  webpack(config) {
    // Spark inlines its WASM sorter as `new URL("data:application/wasm;base64,...", import.meta.url)`.
    // Webpack would try to emit that as an asset module; leave it to the browser instead.
    config.module.rules.push({ test: /@sparkjsdev[\\/]spark[\\/]dist[\\/].*\.js$/, parser: { url: false } });
    return config;
  },
  async headers() {
    return [
      {
        source: "/((?!embed/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=()" },
        ],
      },
      {
        // Embeds are framed by customers' sites; frame-ancestors is set per tour in middleware.
        source: "/embed/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "fullscreen=*, gyroscope=*, accelerometer=*, xr-spatial-tracking=*" },
        ],
      },
      { source: "/sdk/:path*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "Cache-Control", value: "public, max-age=300" }] },
    ];
  },
};

export default nextConfig;
