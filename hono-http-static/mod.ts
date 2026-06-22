import { Command } from "@publicdomainrelay/cli-args-env";
import {
  createStaticFilesApp,
  type StaticFileEvent,
} from "@publicdomainrelay/hono-factory-static-files-fs";
import { createLogger, getMinLogLevelFromEnv, createStructuredLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import { EventBus } from "@publicdomainrelay/event-bus";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig = null;
try {
  const mod = await import("./config.json", { with: { type: "json" } });
  runtimeConfig = mod.default;
} catch {
  /* optional */
}

const { options } = await new Command(
  "CONFIG_PATH_HONO_HTTP_STATIC",
  cliArgsEnv,
  runtimeConfig,
).resolve();

const servePath = options.servePath as string;
const port = options.port as number;
const logger = createStructuredLogger("http-static", getMinLogLevelFromEnv());
const bus = new EventBus<StaticFileEvent>();

bus.subscribe((event) => {
  if (event.type === "file-not-found") {
    logger.warn(`404 ${event.path}`);
  }
});

const app = createStaticFilesApp(servePath, logger, bus);

const serve = createServe({ logger, tcp: { port } });
serve.app.route("/", app as never);

function shutdown() {
  serve.shutdown();
  Deno.exit();
}
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
await serve.beginServe();
