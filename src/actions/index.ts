import { PostLoad } from "./postLoad.js";

export class Actions {

    constructor() {}

    static async runPostLoad(url:any, page:any, logger:any, logDetails: any){
        return PostLoad.run(url, page, logger, logDetails);
    }

}