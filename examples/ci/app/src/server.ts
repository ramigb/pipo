import app from "./app";

const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: app.fetch });
console.log(`shop-api on http://localhost:${server.port}`);
