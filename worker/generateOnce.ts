import { generateDailyEdition } from "../src/lib/generateEdition";

// One-shot script: `npm run generate:edition`. Useful for manual runs,
// testing, or wiring your own cron mechanism outside the worker container.
generateDailyEdition()
  .then((result) => {
    console.log("[generate:edition] Done:", result);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[generate:edition] Failed:", err);
    process.exit(1);
  });
