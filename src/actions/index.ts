import { Page } from "puppeteer-core";

import { PageState } from "../util/state.js";
import { PostLoad } from "./postLoad.js";

export class Actions {
  static async runPostLoad(
    url: string,
    page: Page,
    logger: unknown,
    logDetails: Record<string, unknown>,
    crawler: unknown,
    data: PageState,
  ): Promise<void> {
    return PostLoad.run(url, page, logger, logDetails, crawler, data);
  }
}
