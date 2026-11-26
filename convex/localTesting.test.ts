import { expect, test } from "vitest";
import { localTestOrigins, permittedTestParcel, trackingTestNumbers } from "./lib/localTesting";

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

test("tracking has no test restriction unless configured; malformed or oversized restrictions fail closed", () => {
  expect(trackingTestNumbers(undefined)).toBeNull();
  expect(permittedTestParcel("any-number", undefined)).toBe(true);
  for (const value of [
    "",
    "not-json",
    "{}",
    "null",
    "[1]",
    '[""]',
    '["1","2","3","4","5","6"]',
    "[]",
  ])
    expect(permittedTestParcel("1", value)).toBe(false);
});

test("a configured test environment can contact only the five exact selected parcel numbers", () => {
  const value = JSON.stringify(["QA1", "QA2", "QA3", "QA4", "QA5"]);
  expect(trackingTestNumbers(value)?.size).toBe(5);
  for (const number of ["QA1", "QA2", "QA3", "QA4", "QA5"])
    expect(permittedTestParcel(number, value)).toBe(true);
  expect(permittedTestParcel("QA6", value)).toBe(false);
  expect(permittedTestParcel("qa1", value)).toBe(false);
});
