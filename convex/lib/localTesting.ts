// Explicit opt-ins for the connected local test environment. Unset variables preserve normal behavior.
export function localTestOrigins(value: string | undefined) {
  const permitted = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => permitted.has(origin)),
    ),
  ];
}

export function trackingTestNumbers(value: string | undefined): Set<string> | null {
  if (value === undefined) return null;
  try {
    const numbers: unknown = JSON.parse(value);
    if (
      !Array.isArray(numbers) ||
      numbers.length > 5 ||
      numbers.some((number) => typeof number !== "string" || !number.trim() || number.length > 100)
    )
      return new Set();
    return new Set(numbers.map((number) => number.trim()));
  } catch {
    return new Set();
  }
}

export function permittedTestParcel(number: string, configuration: string | undefined) {
  const selection = trackingTestNumbers(configuration);
  return selection === null || selection.has(number);
}
