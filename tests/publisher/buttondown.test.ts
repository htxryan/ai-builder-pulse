import { describe, it, expect } from "vitest";
import {
  publishToButtondown,
  PublishError,
} from "../../src/publisher/index.js";
import type { RenderedIssue } from "../../src/renderer/index.js";

const ISSUE: RenderedIssue = {
  subject: "AI Builder Pulse — 2026-04-18",
  body: "# Test\n\nBody.",
};

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  responses: Array<{ status: number; body?: string }>,
): {
  fetch: typeof fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("fakeFetch: no response programmed");
    return new Response(r.body ?? "", {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe("publishToButtondown", () => {
  it("POSTs JSON with Authorization: Token header", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: JSON.stringify({ id: "em_abc123" }) },
    ]);
    const out = await publishToButtondown(ISSUE, {
      apiKey: "secret-key",
      fetchImpl: fetch,
      retry: { sleep: noSleep },
    });
    expect(out.id).toBe("em_abc123");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.buttondown.com/v1/emails");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Token secret-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(call.init.body as string);
    expect(payload.subject).toBe(ISSUE.subject);
    expect(payload.body).toBe(ISSUE.body);
    expect(payload.status).toBe("about_to_send");
  });

  it("retries on 5xx and succeeds (E-04)", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 503 },
      { status: 502 },
      { status: 200, body: JSON.stringify({ id: "em_ok" }) },
    ]);
    const out = await publishToButtondown(ISSUE, {
      apiKey: "k",
      fetchImpl: fetch,
      retry: { sleep: noSleep },
    });
    expect(out.id).toBe("em_ok");
    expect(out.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("fails after 3 attempts on persistent 5xx (E-04 retry exhaustion)", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    await expect(
      publishToButtondown(ISSUE, {
        apiKey: "k",
        fetchImpl: fetch,
        retry: { sleep: noSleep, maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(calls).toHaveLength(3);
  });

  it("does NOT retry on 4xx (terminal)", async () => {
    const { fetch, calls } = fakeFetch([{ status: 401, body: "unauthorized" }]);
    await expect(
      publishToButtondown(ISSUE, {
        apiKey: "k",
        fetchImpl: fetch,
        retry: { sleep: noSleep },
      }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(calls).toHaveLength(1);
  });

  it("does NOT leak API key in error messages (U-07)", async () => {
    const { fetch } = fakeFetch([
      { status: 401, body: "forbidden for this account" },
    ]);
    const secret = "sk-very-secret-key-123";
    try {
      await publishToButtondown(ISSUE, {
        apiKey: secret,
        fetchImpl: fetch,
        retry: { sleep: noSleep },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PublishError);
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("rejects when apiKey is empty", async () => {
    await expect(
      publishToButtondown(ISSUE, { apiKey: "" }),
    ).rejects.toThrow(/BUTTONDOWN_API_KEY/);
  });

  it("rejects when response lacks id field", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: JSON.stringify({}) }]);
    await expect(
      publishToButtondown(ISSUE, {
        apiKey: "k",
        fetchImpl: fetch,
        retry: { sleep: noSleep },
      }),
    ).rejects.toThrow(/missing id/);
  });
});
