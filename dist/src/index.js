"use strict";
const platform_1 = require("./platform");
module.exports = (api) => {
    api.registerPlatform('ChargePoint', platform_1.ChargePointPlatform);
};
