import {
  destroyPassiveMonitorDetail,
  initPassiveMonitorDetail,
} from './detailPanel.js';
import {
  startGoogleUsageMeter,
  stopGoogleUsageMeter,
} from './googleUsageMeter.js';

/**
 * Start the Victorian page tools: the Passive Monitor detail panel and the
 * Google usage readout. Mounted once from src/app/tools.js.
 * @returns {function(): void} Teardown, for the application's `defer`.
 */
export function installVicTools() {
  initPassiveMonitorDetail();
  startGoogleUsageMeter();
  return () => {
    stopGoogleUsageMeter();
    destroyPassiveMonitorDetail();
  };
}
