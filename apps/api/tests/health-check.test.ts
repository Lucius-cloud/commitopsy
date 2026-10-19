
import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import * as https from "node:https";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { checkEndpointHealth } from "../src/health-check/check-endpoint.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn()
}));

vi.mock("node:https", () => ({
  request: vi.fn()
}));

const mockedLookup = vi.mocked(lookup);
const mockedRequest = vi.mocked(https.request);

type TestDnsAddress = {
  address: string;
  family: 4 | 6;
};

function mockDnsAddresses(addresses: TestDnsAddress[]): void {
  // Isolate the workaround for Node's overloaded lookup() types.
  mockedLookup.mockResolvedValue(addresses as never);
}

function mockHttpsStatus(statusCode: number): void {
  mockedRequest.mockImplementation(((...args: unknown[]) => {
    const callback = args[1] as
      | ((response: unknown) => void)
      | undefined;

    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };

    request.end = vi.fn(() => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        destroy: () => void;
      };

      response.statusCode = statusCode;
      response.destroy = vi.fn();

      callback?.(response);
    });

    request.destroy = vi.fn();

    return request;
  }) as typeof https.request);
}

function mockDnsFailure(error: Error): void {
  mockedLookup.mockRejectedValue(error as never);
}

function mockHttpsError(code: string): void {
  mockedRequest.mockImplementation(((..._args: unknown[]) => {
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };

    request.end = vi.fn(() => {
      const error = Object.assign(
        new Error("simulated network failure"),
        { code }
      );

      request.emit("error", error);
    });

    request.destroy = vi.fn();

    return request;
  }) as typeof https.request);
}

describe("checkEndpointHealth", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockDnsAddresses([
      { address: "8.8.8.8", family: 4 }
    ]);

    mockHttpsStatus(200);
  });

  it("rejects malformed URLs without making network requests", async () => {
    const result = await checkEndpointHealth("not-a-url");

    expect(result.outcome).toBe("unhealthy");
    expect(result.failureCode).toBe("invalid_url");
    expect(result.httpStatus).toBeNull();
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("rejects HTTP URLs because only HTTPS is allowed", async () => {
    const result = await checkEndpointHealth("http://example.com");

    expect(result.failureCode).toBe("invalid_url");
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("rejects URLs containing embedded credentials", async () => {
    const result = await checkEndpointHealth(
      "https://user:password@example.com"
    );

    expect(result.failureCode).toBe("invalid_url");
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("blocks localhost and private IP addresses", async () => {
    const urls = [
      "https://localhost",
      "https://127.0.0.1",
      "https://10.0.0.1",
      "https://192.168.1.1",
      "https://[::1]"
    ];

    for (const url of urls) {
      const result = await checkEndpointHealth(url);

      expect(result.outcome).toBe("unhealthy");
      expect(result.failureCode).toBe("blocked_address");
    }

    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("rejects DNS results containing a private address", async () => {
    mockDnsAddresses([
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.10", family: 4 }
    ]);

    const result = await checkEndpointHealth(
      "https://example.com/health"
    );

    expect(result.outcome).toBe("unhealthy");
    expect(result.failureCode).toBe("blocked_address");
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("classifies a successful 2xx response as healthy", async () => {
    mockHttpsStatus(204);

    const result = await checkEndpointHealth(
      "https://example.com/health"
    );

    expect(result).toMatchObject({
      outcome: "healthy",
      httpStatus: 204,
      failureCode: null
    });

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("classifies a 5xx response as unhealthy", async () => {
    mockHttpsStatus(503);

    const result = await checkEndpointHealth(
      "https://example.com/health"
    );

    expect(result).toMatchObject({
      outcome: "unhealthy",
      httpStatus: 503,
      failureCode: "http_error"
    });
  });

  it("does not follow redirects", async () => {
    mockHttpsStatus(302);

    const result = await checkEndpointHealth(
      "https://example.com/health"
    );

    expect(result).toMatchObject({
      outcome: "unhealthy",
      httpStatus: 302,
      failureCode: "redirect_not_followed"
    });

    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("pins the HTTPS connection to the validated DNS address", async () => {
    await checkEndpointHealth("https://example.com/health");

    const options = mockedRequest.mock.calls[0]?.[0] as {
      lookup?: (
        hostname: string,
        options: unknown,
        callback: (...args: unknown[]) => void
      ) => void;
    };

    expect(options.lookup).toBeTypeOf("function");

    let callbackArgs: unknown[] = [];

    options.lookup!(
      "example.com",
      {},
      (...args: unknown[]) => {
        callbackArgs = args;
      }
    );

    expect(callbackArgs).toEqual([null, "8.8.8.8", 4]);
  });

  it("returns a stable failure code when DNS resolution fails", async () => {
    mockDnsFailure(new Error("simulated DNS failure"));

    const result = await checkEndpointHealth(
      "https://example.com/health"
    );

    expect(result).toMatchObject({
      outcome: "unhealthy",
      httpStatus: null,
      failureCode: "dns_resolution_failed"
    });

    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("classifies connection failures without exposing internal errors", async () => {
    mockHttpsError("ECONNREFUSED");

    const result = await checkEndpointHealth(
      "https://example.com/health"
    );

    expect(result).toMatchObject({
      outcome: "unhealthy",
      httpStatus: null,
      failureCode: "connection_failed"
    });

    expect(JSON.stringify(result)).not.toContain(
      "simulated network failure"
    );
  });

  it("classifies TLS failures separately", async () => {
    mockHttpsError("CERT_HAS_EXPIRED");

    const result = await checkEndpointHealth(
      "https://example.com/health"
    );

    expect(result).toMatchObject({
      outcome: "unhealthy",
      httpStatus: null,
      failureCode: "tls_error"
    });
  });
});
