// workers/tls.ts
// Installs a Chrome-120-like TLS fingerprint on all outbound fetch() calls
// by swapping Node's global undici dispatcher for one with the correct
// cipher-suite order, ALPN, and signature algorithms.
//
// Import this module once (side-effectful) before any fetch() is called.
// ES-module semantics guarantee it runs exactly once even if imported from
// multiple files.

import { setGlobalDispatcher, Agent } from "undici";

// Chrome 120 TLS 1.2 cipher preference order (TLS 1.3 suites are always
// negotiated by OpenSSL; listing them here keeps the order correct).
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

// Chrome 120 signature algorithms
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

setGlobalDispatcher(
  new Agent({
    connect: {
      ciphers          : CHROME_CIPHERS,
      honorCipherOrder : false,       // Chrome lets the server decide
      minVersion       : "TLSv1.2",
      sigalgs          : CHROME_SIGALGS,
      ALPNProtocols    : ["h2", "http/1.1"],
    },
    // Keep connections alive — Chrome does this by default
    keepAliveTimeout    : 4_000,
    keepAliveMaxTimeout : 600_000,
  })
);
