import { createFileRoute } from "@tanstack/react-router";
import { getToken } from "@/lib/auth-server";
import { maxTakeoutMessageBytes } from "@/lib/takeout-mbox";

export const Route = createFileRoute("/api/takeout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (request.headers.get("origin") !== url.origin)
          return new Response(null, { status: 403 });
        if (
          request.headers.get("content-type") !== "message/rfc822" ||
          Number(request.headers.get("content-length")) > maxTakeoutMessageBytes
        )
          return new Response(null, { status: 400 });
        const token = await getToken();
        if (!token) return new Response(null, { status: 401 });
        const raw = await request.blob();
        if (raw.size > maxTakeoutMessageBytes) return Response.json({ result: "skipped" });
        const endpoint = new URL("/takeout/message", import.meta.env.VITE_CONVEX_SITE_URL);
        endpoint.search = url.search;
        return fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "message/rfc822" },
          body: raw,
        });
      },
    },
  },
});
