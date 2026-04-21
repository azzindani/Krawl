// workers/fingerprint.ts
// Consistent browser identity profiles — matches UA, viewport, TZ, locale,
// platform, screen, hardware, and WebGL as a coherent set so fingerprint
// scanners see a believable combination instead of mismatched values.

export interface BrowserProfile {
  userAgent          : string;
  viewport           : { width: number; height: number };
  locale             : string;
  timezone           : string;
  platform           : string;
  screenWidth        : number;
  screenHeight       : number;
  colorDepth         : number;
  hardwareConcurrency: number;
  deviceMemory       : number;
  maxTouchPoints     : number;
  canvasNoise        : number;   // tiny float added to pixel values
  webglVendor        : string;
  webglRenderer      : string;
  secChuaFull        : string;
  acceptLanguage     : string;
}

const PROFILES: BrowserProfile[] = [
  // ── Chrome 120, Windows 10, 1920×1080 desktop ───────────────────────────
  {
    userAgent          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport           : { width: 1920, height: 1040 },
    locale             : "en-US",
    timezone           : "America/New_York",
    platform           : "Win32",
    screenWidth        : 1920,
    screenHeight       : 1080,
    colorDepth         : 24,
    hardwareConcurrency: 8,
    deviceMemory       : 8,
    maxTouchPoints     : 0,
    canvasNoise        : 0.000012,
    webglVendor        : "Google Inc. (Intel)",
    webglRenderer      : "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    secChuaFull        : '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    acceptLanguage     : "en-US,en;q=0.9",
  },

  // ── Chrome 120, macOS 14, 1440×900 laptop ───────────────────────────────
  {
    userAgent          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport           : { width: 1440, height: 860 },
    locale             : "en-US",
    timezone           : "America/Los_Angeles",
    platform           : "MacIntel",
    screenWidth        : 1440,
    screenHeight       : 900,
    colorDepth         : 30,
    hardwareConcurrency: 10,
    deviceMemory       : 8,
    maxTouchPoints     : 0,
    canvasNoise        : 0.000021,
    webglVendor        : "Google Inc. (Apple)",
    webglRenderer      : "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1 Metal - 88)",
    secChuaFull        : '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    acceptLanguage     : "en-US,en;q=0.9",
  },

  // ── Chrome 120, Windows 11, 1366×768 budget laptop ──────────────────────
  {
    userAgent          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport           : { width: 1366, height: 728 },
    locale             : "en-US",
    timezone           : "Europe/London",
    platform           : "Win32",
    screenWidth        : 1366,
    screenHeight       : 768,
    colorDepth         : 24,
    hardwareConcurrency: 4,
    deviceMemory       : 4,
    maxTouchPoints     : 0,
    canvasNoise        : 0.000008,
    webglVendor        : "Google Inc. (Intel)",
    webglRenderer      : "ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    secChuaFull        : '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    acceptLanguage     : "en-GB,en;q=0.9,en-US;q=0.8",
  },
];

// Indonesian-locale profile used when locale starts with "id"
const ID_PROFILE: BrowserProfile = {
  userAgent          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport           : { width: 1280, height: 800 },
  locale             : "id-ID",
  timezone           : "Asia/Jakarta",
  platform           : "Win32",
  screenWidth        : 1280,
  screenHeight       : 800,
  colorDepth         : 24,
  hardwareConcurrency: 4,
  deviceMemory       : 4,
  maxTouchPoints     : 0,
  canvasNoise        : 0.000015,
  webglVendor        : "Google Inc. (Intel)",
  webglRenderer      : "ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  secChuaFull        : '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  acceptLanguage     : "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
};

export function pickProfile(locale?: string): BrowserProfile {
  if (locale?.startsWith("id")) return ID_PROFILE;
  return PROFILES[Math.floor(Math.random() * PROFILES.length)];
}
