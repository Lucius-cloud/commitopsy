import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import type {
  HealthCheckExecutionRepository,
  SavedHealthCheckResult,
  MonitoredEndpointForHealthCheck
} from "../src/db/health-check-repository.js";

import {
  executeHealthCheck,
  HealthCheckExecutionError
} from "../src/health-check/execute-health-check.js";

import type {
  HealthCheckResult
} from "../src/health-check/check-endpoint.js";

const endpoint: MonitoredEndpointForHealthCheck = {
  id: 7,
  url: "https://example.com/health",
  enabled: true
};

const healthyObservation: HealthCheckResult = {
  outcome: "healthy",
  httpStatus: 204,
  latencyMs: 25,
  failureCode: null
};

const unhealthyObservation: HealthCheckResult = {
  outcome: "unhealthy",
  httpStatus: 500,
  latencyMs: 80,
  failureCode: "http_error"
};

const savedHealthyResult: SavedHealthCheckResult = {
  id: 101,
  endpointId: 7,
  checkedAt: new Date("2026-10-19T10:00:00.000Z"),
  outcome: "healthy",
  httpStatus: 204,
  latencyMs: 25,
  failureCode: null
};

const savedUnhealthyResult: SavedHealthCheckResult = {
  id: 102,
  endpointId: 7,
  checkedAt: new Date("2026-10-19T10:01:00.000Z"),
  outcome: "unhealthy",
  httpStatus: 500,
  latencyMs: 80,
  failureCode: "http_error"
};

const findEndpointById =
  vi.fn<HealthCheckExecutionRepository["findEndpointById"]>();

const saveResult =
  vi.fn<HealthCheckExecutionRepository["saveResult"]>();

const checkEndpoint =
  vi.fn<(url: string) => Promise<HealthCheckResult>>();

const repository: HealthCheckExecutionRepository = {
  findEndpointById,
  saveResult
};

const dependencies = {
  repository,
  checkEndpoint
};

describe("executeHealthCheck", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    findEndpointById.mockResolvedValue(endpoint);
    saveResult.mockResolvedValue(savedHealthyResult);
    checkEndpoint.mockResolvedValue(healthyObservation);
  });

  it("rejects invalid endpoint IDs before accessing dependencies", async () => {
    await expect(
      executeHealthCheck(0, dependencies)
    ).rejects.toMatchObject({
      name: "HealthCheckExecutionError",
      code: "invalid_endpoint_id"
    });

    expect(findEndpointById).not.toHaveBeenCalled();
    expect(checkEndpoint).not.toHaveBeenCalled();
    expect(saveResult).not.toHaveBeenCalled();
  });

  it("rejects missing endpoints without making a network request", async () => {
    findEndpointById.mockResolvedValue(null);

    await expect(
      executeHealthCheck(7, dependencies)
    ).rejects.toMatchObject({
      name: "HealthCheckExecutionError",
      code: "endpoint_not_found"
    });

    expect(checkEndpoint).not.toHaveBeenCalled();
    expect(saveResult).not.toHaveBeenCalled();
  });

  it("rejects disabled endpoints without making a network request", async () => {
    findEndpointById.mockResolvedValue({
      ...endpoint,
      enabled: false
    });

    await expect(
      executeHealthCheck(7, dependencies)
    ).rejects.toMatchObject({
      name: "HealthCheckExecutionError",
      code: "endpoint_disabled"
    });

    expect(checkEndpoint).not.toHaveBeenCalled();
    expect(saveResult).not.toHaveBeenCalled();
  });

  it("checks and persists a healthy endpoint", async () => {
    const result = await executeHealthCheck(7, dependencies);

    expect(findEndpointById).toHaveBeenCalledWith(7);
    expect(checkEndpoint).toHaveBeenCalledWith(endpoint.url);

    expect(saveResult).toHaveBeenCalledWith({
      endpointId: 7,
      outcome: "healthy",
      httpStatus: 204,
      latencyMs: 25,
      failureCode: null
    });

    expect(result).toBe(savedHealthyResult);
    expect(result.id).toBe(101);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("persists an unhealthy HTTP response as a completed check", async () => {
    checkEndpoint.mockResolvedValue(unhealthyObservation);
    saveResult.mockResolvedValue(savedUnhealthyResult);

    const result = await executeHealthCheck(7, dependencies);

    expect(saveResult).toHaveBeenCalledWith({
      endpointId: 7,
      outcome: "unhealthy",
      httpStatus: 500,
      latencyMs: 80,
      failureCode: "http_error"
    });

    expect(result).toBe(savedUnhealthyResult);
    expect(result.outcome).toBe("unhealthy");
    expect(result.httpStatus).toBe(500);
  });

  it("propagates persistence failures without reporting success", async () => {
    const databaseError = new Error("simulated database write failure");

    saveResult.mockRejectedValue(databaseError);

    await expect(
      executeHealthCheck(7, dependencies)
    ).rejects.toBe(databaseError);

    expect(checkEndpoint).toHaveBeenCalledWith(endpoint.url);
    expect(saveResult).toHaveBeenCalledTimes(1);
  });
});