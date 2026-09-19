import type { NextConfig } from "next";

// Single-origin standard: the browser only talks to this Next.js server.
// /api/* and /ws are rewritten to the observability API service, so no
// CORS, no cross-origin cookies, no OBS_ALLOWED_ORIGINS needed.
// Target defaults to local dev; compose sets TAURUSMQ_API_URL=http://api:4000.
const API_BASE = process.env.TAURUSMQ_API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_BASE}/api/:path*` },
      { source: "/ws", destination: `${API_BASE}/ws` },
    ];
  },
};

export default nextConfig;
