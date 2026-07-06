import "dotenv/config";
import { dbConnect } from "./config/mongo";
import { createApp } from "./app";
import { env } from "./config/env";

const { app, server } = createApp();

server.timeout = 10 * 60 * 1000;

if (!process.env.VERCEL) {
  import("./services/scheduler.service").then(({ startScheduler }) => {
    dbConnect().then(() => {
      startScheduler();
      server.listen(env.PORT, () => {
        console.log(`Server running on port ${env.PORT}`);
      });
    });
  });
}

export default app;
