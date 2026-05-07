import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // onnxruntime-web is WASM-based, no native bindings. Externalize so Next doesn't
  // try to bundle the WASM helper modules — we point ORT at jsDelivr in lib/expert.ts.
  serverExternalPackages: ["onnxruntime-web"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
