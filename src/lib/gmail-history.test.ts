import { afterEach, expect, test, vi } from "vitest";
import { importGmailHistory } from "./gmail-history";

afterEach(() => vi.unstubAllGlobals());

test("imports each thread in chronological order, paginates, and keeps Google's token off HandleFast", async () => {
  const requests = vi.fn(async (path: string | URL, init?: RequestInit) => {
    const url = new URL(path, "https://handlefast.example");
    if (url.origin === "https://handlefast.example") {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(url.searchParams.get("source")).toBe("gmail");
      return Response.json({
        result: url.searchParams.get("date") === "1" ? "duplicate" : "imported",
      });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    if (url.pathname.endsWith("/threads")) {
      expect(url.searchParams.get("q")).toContain('to:"sav@example.com"');
      return Response.json(
        url.searchParams.has("pageToken")
          ? {}
          : { threads: [{ id: "thread-a" }], nextPageToken: "next" },
      );
    }
    if (url.pathname.endsWith("/threads/thread-a"))
      return Response.json({
        messages: [
          { id: "reply", internalDate: "2" },
          { id: "customer", internalDate: "1" },
          { id: "draft", internalDate: "3", labelIds: ["DRAFT"] },
        ],
      });
    return Response.json({ raw: btoa("MIME message") });
  });
  vi.stubGlobal("fetch", requests);
  const report = vi.fn();
  expect(
    await importGmailHistory({
      token: "synthetic-token",
      address: "sav@example.com",
      shopId: "shop",
      signal: new AbortController().signal,
      report,
    }),
  ).toEqual({ imported: 1, duplicate: 1, skipped: 1 });
  const urls = requests.mock.calls.map(([path]) => String(path));
  expect(urls[2]).toContain("/messages/customer");
  expect(urls[4]).toContain("/messages/reply");
  expect(urls[6]).toContain("pageToken=next");
  expect(report).toHaveBeenCalledTimes(3);
});
