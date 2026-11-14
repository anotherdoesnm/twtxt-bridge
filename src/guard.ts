import { isIP } from "node:net";

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"];

/**
 * The bridge fetches URLs that strangers put in the path, so keep it from
 * becoming an SSRF proxy for the local network.
 */
export function assertPublicHost(host: string): void {
  const lower = host.toLowerCase();

  if (
    lower === "localhost" ||
    BLOCKED_SUFFIXES.some((s) => lower.endsWith(s)) ||
    lower.endsWith(".local")
  ) {
    throw new Error(`refusing to fetch ${host}`);
  }

  const ip = lower.startsWith("[") ? lower.slice(1, -1) : lower;
  if (isIP(ip)) {
    throw new Error(`refusing to fetch an IP literal: ${host}`);
  }
}
