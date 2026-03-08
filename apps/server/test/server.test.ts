import { describe, expect, it } from "vitest";

import { createServer } from "../src/index";

describe("server", () => {
  it("returns health status", async () => {
    const app = await createServer();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);

    await app.close();
  });

  it("rejects unauthenticated message fetch", async () => {
    const app = await createServer();
    const response = await app.inject({ method: "GET", url: "/messages?after=0" });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});