export class PostLoad {

    constructor() {}

    static async run(url:any, page:any, logger:any, logDetails: any, crawler: any, data: any){

        // @ts-ignore: Unreachable code error
        let numButtons = 0;
        let pageButtonsNum = await page.$$("::-p-xpath(//a[starts-with(@href,'#page_')])");

        if(pageButtonsNum && pageButtonsNum.length){
            numButtons = pageButtonsNum.length;
        }

        if(numButtons > 0){

            logger.debug(
                "CUSTOM ACTION: Found " + numButtons + " pagination buttons on " + url,
                logDetails,
                "general",
            );

            let loopIndex = 0;
            let pageButtons = null;

            for (let currentIndex = 0; currentIndex < numButtons; currentIndex++) {


                pageButtons = await page.$$("::-p-xpath(//a[starts-with(@href,'#page_')])");

                loopIndex = 0;
                for (const button of pageButtons) {

                    if(loopIndex == currentIndex){

                        // Wait
                        await new Promise((resolve) => setTimeout(resolve, 500));

                        let href = await page.evaluate((buttonHandle:any) => buttonHandle.getAttribute('href'), button);

                        logger.debug(
                            "CUSTOM ACTION: Clicking button with href: " + href,
                            logDetails,
                            "general",
                        );

                        // Click button
                        await button.click();

                        logger.debug(
                            "CUSTOM ACTION: Finished clicking button with href: " + href,
                            logDetails,
                            "general",
                        );

                        // // Wait until idle
                        // await page.waitForNetworkIdle();

                        await new Promise((resolve) => setTimeout(resolve, 10000));


                        logger.debug(
                            "CUSTOM ACTION: Finished waiting for " + href,
                            logDetails,
                            "general",
                        );

                        break;

                    }

                    loopIndex++;

                }

            }

            logger.debug(
                "CUSTOM ACTION: Finished custom action for " + url,
                logDetails,
                "general",
            );

        }

    }

}