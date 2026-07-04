import "dotenv/config";
import { dbConnect } from "./config/mongo";
import { createApp } from "./app";
import { env } from "./config/env";
import { startScheduler } from "./services/scheduler.service";

const port = env.PORT;

async function main() {
  await dbConnect();
  startScheduler();

  const { app, server } = createApp();

  server.timeout = 10 * 60 * 1000;

  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

main();
