import { Store } from "@tanstack/react-store";

export const appStore = new Store({
  launchMode: "quiet" as "quiet" | "fast",
});
