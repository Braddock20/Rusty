import test from "node:test";
import assert from "node:assert/strict";
import { ealFixtures, ealStandings, gtParticipants, gtPlayerParticipants, betikaSelections, isSoccerCompetition, validOdds } from "../src/normalize.ts";

test("eAdriatic flattens overlapping fixture groups using actual fixture IDs",()=>{
  const x={fixtureGroupList:[{fixtures:[{fixtureID:"m1"}],standings:[{standingsLines:[{teamID:"t1"}]}]},{fixtures:[{fixtureID:"m1"},{fixtureID:"m2"}]}]};
  const ids=ealFixtures(x).map(f=>f.fixtureID);
  assert.deepEqual(ids,["m1","m1","m2"]);
  assert.equal(ealStandings(x).length,1);
});
test("GT reads participants by side and nested nickname/team",()=>{
  assert.deepEqual(gtParticipants({participants:[
    {side:"home",participant:{player:{nickname:"Alpha"}}},
    {side:"away",participant:{team:{name:"Beta"}}}
  ]}),{home:"Alpha",away:"Beta",homeTeamId:null,awayTeamId:null});
  assert.deepEqual(gtParticipants({participants:[
    {side:"home",participant:{player:{nickname:"Alpha"},team:{id:41}}},
    {side:"away",participant:{team:{name:"Beta",id:42}}}
  ]}),{home:"Alpha",away:"Beta",homeTeamId:"41",awayTeamId:"42"});
});
test("Betika traverses markets then nested selections",()=>{
  const rows=betikaSelections({odds:[{sub_type_id:1,odds:[{display:"1",odd_key:"Home",odd_value:"1.93"},{display:"X",odd_key:"Draw",odd_value:"3.2"}]}]});
  assert.equal(rows.length,2); assert.equal(rows[0].market,"1"); assert.equal(rows[0].selection,"Home"); assert.equal(rows[0].price,1.93);
});
test("GT filter accepts eSoccer and rejects unrelated football labels",()=>{
  assert.equal(isSoccerCompetition({season:{tournament:{category:{sport:{name:"eSoccer"}}}}}),true);
  assert.equal(isSoccerCompetition({season:{tournament:{category:{sport:{name:"Basketball"}}}}}),false);
});
test("invalid odds are rejected",()=>{assert.equal(validOdds(1.93),true);assert.equal(validOdds(1),false);assert.equal(validOdds(NaN),false);});

test("GT player/team identity requires explicit IDs and preserves unknown starter status",()=>{
  const got=gtPlayerParticipants({participants:[
    {side:"home",participant:{player:{id:17,nickname:"Alpha"},team:{id:4,name:"Team Red"}}},
    {side:"away",participant:{player:{nickname:"No ID"},team:{id:5,name:"Team Blue"}}}
  ]});
  assert.equal(got.length,1); assert.equal(got[0].playerId,"17"); assert.equal(got[0].teamId,"4"); assert.equal(got[0].isStarter,null);
});
