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
