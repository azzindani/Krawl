// workers/tls.ts
// Installs a Chrome-120-like TLS fingerprint on all outbound fetch() calls
// by swapping Node's global undici dispatcher for one with the correct
// cipher-suite order, ALPN, and signature algorithms.
//
// Uses dynamic import + try/catch so a version mismatch between undici and
// the host Node.js never crashes the process — the engine just falls back to
// default TLS silently.

const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const CHROME_SIGALGS = [
  "ecdsa_secp256r1_sha256",
  "rsa_pss_rsae_sha256",
  "rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha384",
  "rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha512",
].join(":");

// Top-level await — safe in Node 18+ ESM modules.
// Dynamic import ensures the undici module-load error is catchable.
try {
  const { setGlobalDispatcher, Agent } = await import("undici");
  setGlobalDispatcher(
    new Agent({
      connect: {
        ciphers         : CHROME_CIPHERS,
        honorCipherOrder: false,
        minVersion      : "TLSv1.2",
        sigalgs         : CHROME_SIGALGS,
        ALPNProtocols   : ["h2", "http/1.1"],
      },
      keepAliveTimeout    : 4_000,
      keepAliveMaxTimeout : 600_000,
    })
  );
} catch {
  // Degraded mode: default Node.js TLS used instead of Chrome fingerprint.
}

export {};  // mark as ESM module so top-level await is valid
