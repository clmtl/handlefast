import { expect, test } from "vitest";
import { indexTakeout, takeoutOriginal } from "./takeout-mbox";

test("indexes a mailbox across chunk boundaries and restores escaped body lines", async () => {
  const delimiter = "From x@example.com Thu Nov 26 11:00:00 2026\r\n";
  const headers = "Date: Thu, 26 Nov 2026 11:00:03 +0000\r\nSubject: Exemple\r\n\r\n";
  const greeting = "Bonjour 👋\r\n";
  const original =
    headers + greeting + "x".repeat(1024 * 1024) + "\r\nFrom quelqu’un\r\n>From précédent\r\n";
  const file = new Blob([
    delimiter,
    original
      .replace("\r\nFrom ", "\r\n>From ")
      .replace("\r\n>From précédent", "\r\n>>From précédent"),
    delimiter,
    headers,
    "Suite\r\n",
  ]);
  const indexed = await indexTakeout(file);
  expect(indexed).toHaveLength(2);
  expect(indexed[0].date).toBe(Date.parse("2026-11-26T11:00:03Z"));
  expect(await (await takeoutOriginal(indexed[0])).text()).toBe(original);
  expect(await (await takeoutOriginal(indexed[1])).text()).toBe(headers + "Suite\r\n");
});
