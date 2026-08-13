// @ts-nocheck
export class PostLoad {
    constructor() {}
  
    static async run(url, page, logger, logDetails, crawler, data) {
      
      // Find all visible pagination buttons
      let pageButtons = await page.$$(
        "::-p-xpath(//a[starts-with(@href,'#page_')])"
      )

      let totalPages = 0;
      if (pageButtons && pageButtons.length > 0) {
        // Get the last button's href to find the actual total pages
        const lastButton = pageButtons[pageButtons.length - 1];
        const lastHref = await page.evaluate(
          // @ts-ignore: Unreachable code error
          (buttonHandle) => buttonHandle.getAttribute("href"),
          lastButton
        );
        
        logger.debug(
          "CUSTOM ACTION: Last pagination button href: " + lastHref,
          logDetails,
          "general"
        );
        
        // Extract page number from href like "#page_15" 
        const pageMatch = lastHref.match(/#page_(\d+)/);
        if (pageMatch) {
          totalPages = parseInt(pageMatch[1]);
        } else {
          // Fallback to counting visible buttons if we can't parse the href
          totalPages = pageButtons.length;
        }
      }

      if (totalPages > 0) {
        logger.debug(
          "CUSTOM ACTION: Found " + totalPages + " total pages on " + url,
          logDetails,
          "general"
        )

        let currentPage = 0;
        
        // Navigate through pages by always looking for the next available button
        while (currentPage <= totalPages) {
          try {
            logger.debug(
              "CUSTOM ACTION: Starting iteration - currentPage: " + currentPage + ", totalPages: " + totalPages,
              logDetails,
              "general"
            );
            
            // Wait before each action
            await new Promise(resolve => setTimeout(resolve, 500))
            
            logger.debug(
              "CUSTOM ACTION: About to search for pagination buttons...",
              logDetails,
              "general"
            );
            
            // Re-scan for available pagination buttons after each click
            // This handles dynamic pagination where buttons appear/disappear
            let availableButtons = null;
            try {
              // Add a timeout to prevent hanging on DOM queries
              availableButtons = await Promise.race([
                page.$$("::-p-xpath(//a[starts-with(@href,'#page_')])"),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Pagination button search timeout')), 10000)
                )
              ]);
              
              logger.debug(
                "CUSTOM ACTION: Successfully found pagination buttons",
                logDetails,
                "general"
              );
            } catch (timeoutError) {
              logger.debug(
                "CUSTOM ACTION: Pagination button search timed out or failed: " + String(timeoutError),
                logDetails,
                "general"
              );
              
                             // Try alternative approach - check if page is still responsive
               try {
                 logger.debug(
                   "CUSTOM ACTION: Checking if page is still responsive...",
                   logDetails,
                   "general"
                 );
                 
                 await Promise.race([
                   page.evaluate(() => document.title),
                   new Promise((_, reject) => 
                     setTimeout(() => reject(new Error('Page responsiveness check timeout')), 5000)
                   )
                 ]);
                 
                 logger.debug(
                   "CUSTOM ACTION: Page is responsive, trying alternative pagination search",
                   logDetails,
                   "general"
                 );
                 
                 // Try a simpler selector with timeout
                 availableButtons = await Promise.race([
                   page.$$("a[href*='#page_']"),
                   new Promise((_, reject) => 
                     setTimeout(() => reject(new Error('Alternative search timeout')), 5000)
                   )
                 ]);
                 
                 logger.debug(
                   "CUSTOM ACTION: Alternative search found " + (availableButtons ? availableButtons.length : 0) + " buttons",
                   logDetails,
                   "general"
                 );
               } catch (pageError) {
                 logger.debug(
                   "CUSTOM ACTION: Page appears unresponsive: " + String(pageError),
                   logDetails,
                   "general"
                 );
                 
                 // Try to reload the page as a last resort
                 logger.debug(
                   "CUSTOM ACTION: Attempting to reload the page...",
                   logDetails,
                   "general"
                 );
                 
                 try {
                   await Promise.race([
                     page.reload({ waitUntil: 'networkidle2' }),
                     new Promise((_, reject) => 
                       setTimeout(() => reject(new Error('Page reload timeout')), 15000)
                     )
                   ]);
                   
                   logger.debug(
                     "CUSTOM ACTION: Page reloaded successfully, ending pagination",
                     logDetails,
                     "general"
                   );
                 } catch (reloadError) {
                   logger.debug(
                     "CUSTOM ACTION: Page reload failed: " + String(reloadError),
                     logDetails,
                     "general"
                   );
                 }
                 
                 break;
               }
            }
            
            logger.debug(
              "CUSTOM ACTION: Found " + (availableButtons ? availableButtons.length : 0) + " pagination buttons",
              logDetails,
              "general"
            );
            
            if (!availableButtons || availableButtons.length === 0) {
              logger.debug(
                "CUSTOM ACTION: No pagination buttons found, stopping",
                logDetails,
                "general"
              );
              break;
            }
            
            // Get all available page numbers
            const availablePages = [];
            for (const button of availableButtons) {
              const href = await page.evaluate(
                // @ts-ignore: Unreachable code error
                (buttonHandle) => buttonHandle.getAttribute("href"),
                button
              );
              const pageMatch = href.match(/#page_(\d+)/);
              if (pageMatch) {
                availablePages.push({
                  pageNum: parseInt(pageMatch[1]),
                  button: button,
                  href: href
                });
              }
            }
            
            // Sort available pages
            availablePages.sort((a, b) => a.pageNum - b.pageNum);
            
            logger.debug(
              "CUSTOM ACTION: Available pages: [" + availablePages.map(p => p.pageNum).join(", ") + "]",
              logDetails,
              "general"
            );
            
            // Find the next page to click
            let nextPageToClick = null;
            for (const pageInfo of availablePages) {
              if (pageInfo.pageNum > currentPage) {
                nextPageToClick = pageInfo;
                break;
              }
            }
            
            logger.debug(
              "CUSTOM ACTION: Next page from sequential search: " + (nextPageToClick ? nextPageToClick.pageNum : "none"),
              logDetails,
              "general"
            );
            
            if (!nextPageToClick) {
              // Try to find the highest available page that we haven't clicked yet
              const highestPage = availablePages[availablePages.length - 1];
              if (highestPage && highestPage.pageNum > currentPage) {
                nextPageToClick = highestPage;
                logger.debug(
                  "CUSTOM ACTION: Using highest available page: " + highestPage.pageNum,
                  logDetails,
                  "general"
                );
              }
            }
            
            if (nextPageToClick) {
              logger.debug(
                "CUSTOM ACTION: Clicking page " + nextPageToClick.pageNum + " (href: " + nextPageToClick.href + ")",
                logDetails,
                "general"
              );
              
              // Click the page button
              await nextPageToClick.button.click();
              
              logger.debug(
                "CUSTOM ACTION: Finished clicking page " + nextPageToClick.pageNum,
                logDetails,
                "general"
              );
              
              // Wait for page to load
              await new Promise(resolve => setTimeout(resolve, 5000));
              
              logger.debug(
                "CUSTOM ACTION: Finished waiting for page " + nextPageToClick.pageNum,
                logDetails,
                "general"
              );
              
              currentPage = nextPageToClick.pageNum;
              
              logger.debug(
                "CUSTOM ACTION: Updated currentPage to: " + currentPage + ", continuing loop...",
                logDetails,
                "general"
              );
            } else {
              logger.debug(
                "CUSTOM ACTION: No more pages to click, current page: " + currentPage + ", totalPages: " + totalPages,
                logDetails,
                "general"
              );
              
              // Check if we've actually reached all pages
              if (currentPage >= totalPages) {
                logger.debug(
                  "CUSTOM ACTION: Reached total pages, breaking loop",
                  logDetails,
                  "general"
                );
              } else {
                logger.debug(
                  "CUSTOM ACTION: Haven't reached total pages but no buttons available, breaking loop",
                  logDetails,
                  "general"
                );
              }
              break;
            }
            
          } catch (error) {
            logger.debug(
              "CUSTOM ACTION: Error during pagination: " + String(error),
              logDetails,
              "general"
            );
            // Continue trying with next iteration
            currentPage++;
            logger.debug(
              "CUSTOM ACTION: Incremented currentPage to " + currentPage + " due to error, totalPages: " + totalPages,
              logDetails,
              "general"
            );
            if (currentPage > totalPages) {
              logger.debug(
                "CUSTOM ACTION: currentPage > totalPages, breaking loop",
                logDetails,
                "general"
              );
              break;
            }
          }
          
          logger.debug(
            "CUSTOM ACTION: End of iteration - currentPage: " + currentPage + ", totalPages: " + totalPages + ", continuing: " + (currentPage <= totalPages),
            logDetails,
            "general"
          );
        }
        
        logger.debug(
          "CUSTOM ACTION: Exited pagination loop - final currentPage: " + currentPage + ", totalPages: " + totalPages,
          logDetails,
          "general"
        );

        logger.debug(
          "CUSTOM ACTION: Finished custom action for " + url,
          logDetails,
          "general"
        )
      }
    }
  }
  