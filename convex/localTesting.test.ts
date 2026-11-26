import { expect, test } from "vitest";
import { localTestOrigins } from "./lib/localTesting";

test("local auth permits only exact loopback origins when explicitly configured", () => {
  expect(localTestOrigins(undefined)).toEqual([]);
  expect(localTestOrigins("http://localhost:3000,http://127.0.0.1:3000")).toEqual([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);
  expect(
    localTestOrigins(
      "https://evil.example,*,http://localhost:3000.evil.example,http://localhost:3001,null",
    ),
  ).toEqual([]);
});
