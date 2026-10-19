
import { lookup } from "node:dns/promises";
import * as https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type HealthCheckFailureCode =
  | "invalid_url"
  | "blocked_address"
  | "dns_timeout"
  | "dns_resolution_failed"
  | "connection_timeout"
  | "tls_error"
  | "connection_failed"
  | "invalid_response"
  | "redirect_not_followed"
  | "http_error";

export interface HealthCheckResult {
  outcome: "healthy" | "unhealthy";
  httpStatus: number | null;
  latencyMs: number;
  failureCode: HealthCheckFailureCode | null;
}

interface ResolvedAddress {
  address: string;
  family: number;
}

const DNS_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_HEADER_SIZE_BYTES = 8 * 1024;

class HealthCheckSetupError extends Error {
  constructor(
    readonly failureCode: "invalid_url" | "blocked_address"
  ) {
    super(failureCode);
  }
}

class HealthCheckTimeoutError extends Error {}

function getLatency(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function unhealthy(
  failureCode: HealthCheckFailureCode,
  startedAt: number,
  httpStatus: number | null = null
): HealthCheckResult {
  return {
    outcome: "unhealthy",
    httpStatus,
    latencyMs: getLatency(startedAt),
    failureCode
  };
}

function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);

    // Fail closed for private, loopback, link-local, reserved,
    // mapped, multicast, and other non-unicast address ranges.
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

function parseTarget(rawUrl: string): {
  url: URL;
  hostname: string;
} {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new HealthCheckSetupError("invalid_url");
  }

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0
  ) {
    throw new HealthCheckSetupError("invalid_url");
  }

  // URL.hostname can include brackets around an IPv6 literal.
  const hostname = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase()
    .replace(/\.$/, "");

  // Reject local-use hostnames even if a DNS resolver gives them
  // an unexpected public address.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new HealthCheckSetupError("blocked_address");
  }

  // URL fragments are client-side only and are never sent.
  url.hash = "";

  return { url, hostname };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HealthCheckTimeoutError());
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function isTlsFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code ?? "";

  return (
    code.includes("TLS") ||
    code.includes("CERT") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("UNABLE_TO_VERIFY_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  );
}

async function resolvePublicAddresses(
  hostname: string
): Promise<ResolvedAddress[]> {
  const literalFamily = isIP(hostname);

  const addresses: ResolvedAddress[] =
    literalFamily !== 0
      ? [{ address: hostname, family: literalFamily }]
      : await withTimeout(
          lookup(hostname, { all: true, verbatim: true }),
          DNS_TIMEOUT_MS
        );

  if (addresses.length === 0) {
    throw new Error("dns_resolution_failed");
  }

  // Reject the entire hostname if ANY answer is unsafe. Do not
  // silently discard private answers and use the remaining ones.
  for (const address of addresses) {
    if (
      isIP(address.address) !== address.family ||
      !isPublicAddress(address.address)
    ) {
      throw new HealthCheckSetupError("blocked_address");
    }
  }

  return addresses;
}

function executeHttpsRequest(
  url: URL,
  hostname: string,
  selectedAddress: ResolvedAddress,
  startedAt: number
): Promise<HealthCheckResult> {
  return new Promise<HealthCheckResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: HealthCheckResult) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      resolve(result);
    };

    const requestOptions: https.RequestOptions = {
      protocol: "https:",
      hostname,
      port: url.port.length > 0 ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      maxHeaderSize: MAX_HEADER_SIZE_BYTES,
      headers: {
        host: url.host,
        accept: "*/*",
        "user-agent": "Commitopsy-HealthChecker/1.0",
        connection: "close"
      },

      // The socket connects to the already-validated IP rather
      // than resolving the hostname again.
      lookup: (_hostname, _options, callback) => {
        callback(
          null,
          selectedAddress.address,
          selectedAddress.family
        );
      },

      // Preserve normal certificate verification against a DNS
      // hostname; do not send DNS SNI when the URL uses an IP.
      ...(isIP(hostname) === 0 ? { servername: hostname } : {})
    };

    const request = https.request(requestOptions, (response) => {
      const status = response.statusCode;

      if (typeof status !== "number") {
        finish(unhealthy("invalid_response", startedAt));
      } else if (status >= 200 && status < 300) {
        finish({
          outcome: "healthy",
          httpStatus: status,
          latencyMs: getLatency(startedAt),
          failureCode: null
        });
      } else if (status >= 300 && status < 400) {
        // Redirects deliberately remain un-followed.
        finish(
          unhealthy("redirect_not_followed", startedAt, status)
        );
      } else {
        finish(unhealthy("http_error", startedAt, status));
      }

      // The response body is irrelevant to a status-based check.
      // Do not collect or store it.
      response.destroy();
    });

    request.on("error", (error: Error) => {
      finish(
        unhealthy(
          isTlsFailure(error) ? "tls_error" : "connection_failed",
          startedAt
        )
      );
    });

    // This timer covers connection establishment and waiting for
    // response headers—not just socket inactivity.
    timer = setTimeout(() => {
      finish(unhealthy("connection_timeout", startedAt));
      request.destroy();
    }, REQUEST_TIMEOUT_MS);

    request.end();
  });
}

/**
 * Perform exactly one HTTPS health check.
 *
 * This function does not persist results or schedule recurring
 * checks. Those responsibilities will be added separately.
 */
export async function checkEndpointHealth(
  rawUrl: string
): Promise<HealthCheckResult> {
  const startedAt = Date.now();

  let target: ReturnType<typeof parseTarget>;

  try {
    target = parseTarget(rawUrl);
  } catch (error: unknown) {
    if (error instanceof HealthCheckSetupError) {
      return unhealthy(error.failureCode, startedAt);
    }

    return unhealthy("invalid_url", startedAt);
  }

  let addresses: ResolvedAddress[];

  try {
    addresses = await resolvePublicAddresses(target.hostname);
  } catch (error: unknown) {
    if (error instanceof HealthCheckSetupError) {
      return unhealthy(error.failureCode, startedAt);
    }

    return unhealthy(
      error instanceof HealthCheckTimeoutError
        ? "dns_timeout"
        : "dns_resolution_failed",
      startedAt
    );
  }

  const selectedAddress = addresses[0];

  if (selectedAddress === undefined) {
    return unhealthy("dns_resolution_failed", startedAt);
  }

  return executeHttpsRequest(
    target.url,
    target.hostname,
    selectedAddress,
    startedAt
  );
}
