/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // apps/web only ever calls the API gateway (ARCH-006), never a service
  // directly -- see @dd/api-client's GATEWAY_URL.
};

export default nextConfig;
