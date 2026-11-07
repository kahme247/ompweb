// A separate module/global registry per web server, with real routes and host bootstrap.
import { startProduction } from "../../server/app";

const server = await startProduction({ port: 0, hostname: "127.0.0.1" });
console.log(`MULTI_SERVER_PORT=${server.port}`);
