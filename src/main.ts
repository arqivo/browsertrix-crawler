#!/usr/bin/env -S node --experimental-global-webcrypto

import { logger } from "./util/logger.js";
import { setExitOnRedisError } from "./util/redis.js";
import { Crawler } from "./crawler.js";
import { ReplayCrawler } from "./replaycrawler.js";
import fs from "node:fs";
import { ExitCodes, InterruptReason } from "./util/constants.js";

let crawler: Crawler | null = null;

let lastSigInt = 0;
let forceTerm = false;

// min time between subsequent signals to exit immediately
const MIN_SIG_INT_MS = 1000;

async function handleTerminate(signame: string) {
  logger.info(`${signame} received...`);
  if (!crawler || !crawler.crawlState) {
    logger.error("error: no crawler running, exiting");
    process.exit(ExitCodes.GenericError);
  }

  if (crawler.done) {
    logger.info("success: crawler done, exiting");
    process.exit(ExitCodes.Success);
  }

  setExitOnRedisError();

  try {
    await crawler.checkCanceled();

    if (!crawler.interruptReason) {
      logger.info("SIGNAL: interrupt request received...");
      crawler.gracefulFinishOnInterrupt(InterruptReason.SignalInterrupted);
    } else if (
      forceTerm ||
      (lastSigInt && Date.now() - lastSigInt > MIN_SIG_INT_MS)
    ) {
      logger.info("SIGNAL: stopping crawl now...");
      if (!(await crawler.serializeAndExit())) {
        logger.info(
          "SIGNAL: crawler already in post-processing, waiting for graceful exit",
        );
      }
    }
    lastSigInt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    logger.error("Error stopping crawl after receiving termination signal", e);
  }
}

// undici's HTTP/1 parser can fail internal assertions (e.g. assert(!this.paused)
// in Parser.finish) when a server ends the socket mid-parse. The AssertionError
// escapes as an uncaughtException from a socket event and would kill the whole
// crawl for one broken connection; undici opens a fresh connection on the next
// request, so logging and continuing is safe. Anything else stays fatal.
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  if (
    anyErr?.code === "ERR_ASSERTION" &&
    typeof anyErr?.stack === "string" &&
    anyErr.stack.includes("undici")
  ) {
    logger.error("Ignoring undici internal assertion failure", {
      message: anyErr.message,
    });
    return;
  }
  logger.fatal("Uncaught exception", {
    message: anyErr?.message,
    stack: anyErr?.stack,
  });
});

process.on("SIGINT", () => handleTerminate("SIGINT"));

process.on("SIGTERM", () => handleTerminate("SIGTERM"));

process.on("SIGABRT", async () => {
  logger.info("SIGABRT received, will force immediate exit on SIGTERM/SIGINT");
  forceTerm = true;
});

if (process.argv[1].endsWith("qa")) {
  crawler = new ReplayCrawler();
} else {
  crawler = new Crawler();
}

// remove any core dumps which could be taking up space in the working dir
try {
  fs.unlinkSync("./core");
} catch (e) {
  //ignore
}

await crawler.run();
