import test from 'node:test';
import assert from 'node:assert/strict';
import {observeTelemetry,telemetryFor} from '../public/app/telemetry-state.js';
import {clearCustomerContext} from '../public/app/core.js';
test('telemetry snapshots do not cross spaces and account reset removes them',()=>{
 observeTelemetry('one',{inbox:{value:8}});observeTelemetry('two',{activity:{value:5}});
 assert.equal(telemetryFor('one').inbox.value,8);assert.equal(telemetryFor('two').inbox,undefined);assert.equal(telemetryFor('unknown').activity,undefined);
 assert.ok(telemetryFor('one').inbox.at>0);clearCustomerContext();assert.deepEqual(telemetryFor('one'),{});
});
