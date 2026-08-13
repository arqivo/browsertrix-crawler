import { Page } from "puppeteer-core";

import { PageState } from "../util/state.js";

/**
 * Per-site intervention after a page has loaded.
 *
 * The shipped implementation does nothing: per-site logic lives in the
 * crawl_scripts table and is injected per crawl, so this hook only earns its
 * place for the rare thing a page-context behavior cannot do. Stored variants
 * from before that split are kept in examples/actions/.
 */
export class PostLoad {
  // The parameters are the hook's contract, and a variant dropped in here uses
  // them; the shipped no-op does not. Naming them is worth more than silencing
  // the signature.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  static async run(
    _url: string,
    _page: Page,
    _logger: unknown,
    _logDetails: Record<string, unknown>,
    _crawler: unknown,
    _data: PageState,
  ): Promise<void> {}
  /* eslint-enable @typescript-eslint/no-unused-vars */
}
