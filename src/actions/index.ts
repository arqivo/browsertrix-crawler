import { PostLoad } from "./postLoad.js";

export class Actions {

    constructor() {}

    static async runPostLoad(url:any, page:any, logger:any, logDetails: any, crawler: any, data: any){
        return PostLoad.run(url, page, logger, logDetails, crawler, data);
    }

}