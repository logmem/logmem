// telemetry-state.js: measured sidebar snapshots, isolated by space and cleared on account changes.
import {onContextReset} from './core.js';
const snapshots=new Map();
onContextReset(()=>snapshots.clear());
export function observeTelemetry(space,values){if(!space)return;snapshots.set(space,{...snapshots.get(space),...Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{...value,at:Date.now()}]))});}
export const telemetryFor=space=>snapshots.get(space)||{};
