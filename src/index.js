import { createTimeHandler } from "./time.js";

const port = Number(Bun.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  routes: {
    "/": () => Response.json({ message: "Hello via Bun!" }),
    "/health": () => Response.json({ status: "ok" }),
    "/time": createTimeHandler(),
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server läuft auf http://localhost:${server.port}`);
