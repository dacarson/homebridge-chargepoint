import type { API } from 'homebridge';
import { ChargePointPlatform } from './platform';

export = (api: API): void => {
  api.registerPlatform('ChargePoint', ChargePointPlatform);
};
