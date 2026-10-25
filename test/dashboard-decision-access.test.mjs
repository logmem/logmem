import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canAnswerDecision} from '../public/app/dashboard-model.js';
test('decision controls require the current recipient and approval permission',()=>{
 assert.equal(canAnswerDecision({to:'human:other'},{person:'human:admin',canApprove:true}),false);
 assert.equal(canAnswerDecision({to:'human:admin'},{person:'human:admin',canApprove:false}),false);
 assert.equal(canAnswerDecision({},{person:null,canApprove:true}),false);
 assert.equal(canAnswerDecision({to:'human:admin'},{person:'human:admin',canApprove:true}),true);
 assert.equal(canAnswerDecision({},{person:'human:admin',canApprove:true}),true);
});
