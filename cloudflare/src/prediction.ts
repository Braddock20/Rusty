import { gtPlayerParticipants } from "./normalize.ts";
import { parseTimestamp, validScore } from "./guards.ts";
/** Odds-free, source-scoped shadow forecasting. Never infers team identity from names. */
type Row = Record<string, any>;
const MODEL_VERSION = "rusty-shadow-v2";
const MIN_TEAM_MATCHES = 12;
const clamp = (x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
const num = (v:any):number|null => { if(v===null||v===undefined||v==='') return null; const n=Number(v); return Number.isFinite(n)&&n>=0&&Number.isInteger(n)&&n<=99?n:null; };
const poisson = (lambda:number,k:number) => { let p=Math.exp(-lambda); for(let i=1;i<=k;i++) p*=lambda/i; return p; };
const outcome = (p:[number,number,number]) => p[0]>=p[1]&&p[0]>=p[2]?'HOME':p[1]>=p[2]?'DRAW':'AWAY';
const norm = (p:number[]) => { const s=p.reduce((a,b)=>a+b,0)||1; return p.map(x=>x/s) as [number,number,number]; };
const teamKey = (v:any):string|null => v===null||v===undefined||String(v).trim()===""?null:String(v);

export async function buildPredictions(sql:any, limit=50, source:string|null=null) {
  // Load a generous bounded candidate set; parse timestamps in code because provider
  // kickoff formats differ. Ambiguous local-time strings are deliberately rejected.
  const upcoming = source
    ? await sql`SELECT source,external_id,competition,competition_external_id,home_name,away_name,home_team_external_id,away_team_external_id,kickoff_raw,status_raw,payload,result_state FROM fixtures WHERE source=${source} AND home_name IS NOT NULL AND away_name IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT 10000`
    : await sql`SELECT source,external_id,competition,competition_external_id,home_name,away_name,home_team_external_id,away_team_external_id,kickoff_raw,status_raw,payload,result_state FROM fixtures WHERE home_name IS NOT NULL AND away_name IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT 20000`;
  const now=Date.now();
  const targets=upcoming.map((f:Row)=>({...f,_kickoff:parseTimestamp(f.kickoff_raw)}))
    .filter((f:Row)=>f._kickoff!==null&&f._kickoff>now&& !["cancelled","postponed","live","completed"].includes(String(f.result_state??"unknown")) && !/(cancel|abandon|postpon|finished|complete|played|full[ -]?time)/i.test(String(f.status_raw??"")))
    .sort((a:Row,b:Row)=>a._kickoff-b._kickoff).slice(0,limit);
  if(!targets.length) return {model:MODEL_VERSION,generated_at:new Date().toISOString(),count:0,odds_used:false,predictions:[],note:"No future fixtures with unambiguous ISO/epoch kickoff timestamps were found. No predictions were fabricated."};
  const sources=[...new Set(targets.map((f:Row)=>f.source))];
  const histories=await sql`SELECT source,external_id,competition,competition_external_id,home_name,away_name,home_team_external_id,away_team_external_id,kickoff_raw,home_score_raw,away_score_raw,result_state FROM fixtures WHERE source = ANY(${sources}) AND result_state='completed' AND home_name IS NOT NULL AND away_name IS NOT NULL AND home_score_raw ~ '^[0-9]+$' AND away_score_raw ~ '^[0-9]+$' ORDER BY kickoff_raw DESC LIMIT 50000`;
  const groups=new Map<string,Row[]>();
  for(const h of histories){
    const t=parseTimestamp(h.kickoff_raw),hs=num(h.home_score_raw),as=num(h.away_score_raw);
    if(t===null||t>=now||hs===null||as===null||!validScore(hs)||!validScore(as)) continue;
    if(!h.competition_external_id) continue;
    const key=`${h.source}|${h.competition_external_id}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key)!.push({...h,_time:t,_hs:hs,_as:as});
  }
  await sql`INSERT INTO prediction_model_registry(model_version,status,feature_spec,metrics)
    VALUES(${MODEL_VERSION},'shadow','{"features":["source_competition_id_completed_scores","verified_source_team_ids"],"odds_used":false,"validation":"not_yet_passed"}'::jsonb,'{}'::jsonb)
    ON CONFLICT(model_version) DO NOTHING`;
  const output=[];
  for(const f of targets){
    const existing=await sql`SELECT predicted_at,predicted_outcome,home_probability,draw_probability,away_probability,evidence_strength_score,evidence,feature_snapshot,prediction_status FROM prediction_history WHERE source=${f.source} AND external_fixture_id=${String(f.external_id)} AND model_version=${MODEL_VERSION} ORDER BY predicted_at ASC LIMIT 1`;
    if(existing.length){
      const saved=existing[0];
      output.push({source:f.source,fixture_id:f.external_id,competition:f.competition,competition_id:f.competition_external_id,home:f.home_name,away:f.away_name,kickoff:f.kickoff_raw,prediction:saved.predicted_outcome,action:"SHADOW_FORECAST_RECORDED_IMMUTABLE",probabilities:{home_win:+(Number(saved.home_probability)*100).toFixed(2),draw:+(Number(saved.draw_probability)*100).toFixed(2),away_win:+(Number(saved.away_probability)*100).toFixed(2)},evidence_strength_score:Number(saved.evidence_strength_score),evidence:saved.feature_snapshot??saved.evidence,forecast_recorded_at:saved.predicted_at,immutable_forecast:true,odds_used:false,warning:"Previously recorded pre-match shadow forecast. The original forecast and feature snapshot are immutable."});
      continue;
    }
    const key=`${f.source}|${f.competition_external_id??''}`;
    const hist=(f.competition_external_id?(groups.get(key)??[]):[]).filter(h=>h._time<f._kickoff).sort((a,b)=>a._time-b._time);
    const homeId=teamKey(f.home_team_external_id),awayId=teamKey(f.away_team_external_id);
    // Identity is source-scoped and ID-based. Display-name similarity is never used.
    const teamMatches=homeId&&awayId?hist.filter(h=>[h.home_team_external_id,h.away_team_external_id].some((id:any)=>String(id??"")===homeId||String(id??"")===awayId)):[];
    const homeSample=homeId?hist.filter(h=>String(h.home_team_external_id??"")===homeId||String(h.away_team_external_id??"")===homeId).length:0;
    const awaySample=awayId?hist.filter(h=>String(h.home_team_external_id??"")===awayId||String(h.away_team_external_id??"")===awayId).length:0;
    const sufficient=homeSample>=MIN_TEAM_MATCHES&&awaySample>=MIN_TEAM_MATCHES;
    const effectiveSample=Math.min(homeSample,awaySample);
    const ratings=new Map<string,number>();
    const stats=new Map<string,{gf:number;ga:number;n:number}>();
    const get=(id:string|null)=>{if(!id)return {gf:0,ga:0,n:0};if(!stats.has(id))stats.set(id,{gf:0,ga:0,n:0});return stats.get(id)!;};
    let leagueHome=0,leagueAway=0,leagueN=0;
    for(const h of hist){
      const ht=teamKey(h.home_team_external_id),at=teamKey(h.away_team_external_id),hs=h._hs,as=h._as;
      const ageDays=Math.max(0,(now-h._time)/86400000),w=Math.exp(-ageDays/45);
      if(ht&&at){
        const hr=ratings.get(ht)??1500,ar=ratings.get(at)??1500;
        const expected=1/(1+Math.pow(10,((ar-hr)-35)/400));
        const actual=hs>as?1:hs<as?0:0.5;
        const margin=Math.min(2.2,Math.log1p(Math.abs(hs-as))),k=24*(0.65+0.35*w)*Math.max(0.7,margin);
        ratings.set(ht,hr+k*(actual-expected));
        // The away rating must move against the home rating. The previous sign made
        // both teams gain Elo points when the home team won.
        ratings.set(at,ar+k*((1-actual)-(1-expected)));
        const a=get(ht),b=get(at);a.gf+=hs*w;a.ga+=as*w;a.n+=w;b.gf+=as*w;b.ga+=hs*w;b.n+=w;
      }
      leagueHome+=hs*w;leagueAway+=as*w;leagueN+=w;
    }
    const hs=get(homeId),as=get(awayId),sample=teamMatches.length;
    const avgH=leagueN?leagueHome/leagueN:1.5,avgA=leagueN?leagueAway/leagueN:1.3;
    const h2h=homeId&&awayId?hist.filter(h=>(String(h.home_team_external_id??"")===homeId&&String(h.away_team_external_id??"")===awayId)||(String(h.home_team_external_id??"")===awayId&&String(h.away_team_external_id??"")===homeId)):[];
    const recentFor=(id:string|null)=>id?hist.filter(h=>String(h.home_team_external_id??"")===id||String(h.away_team_external_id??"")===id).sort((a,b)=>b._time-a._time).slice(0,10).reverse().map(h=>{const isHome=String(h.home_team_external_id)===id,gf=isHome?h._hs:h._as,ga=isHome?h._as:h._hs;return {gf,ga,result:gf>ga?'W':gf<ga?'L':'D'};}):[];
    const homeRecent=recentFor(homeId),awayRecent=recentFor(awayId);
    const form=(xs:any[])=>({matches:xs.length,wins:xs.filter(x=>x.result==='W').length,draws:xs.filter(x=>x.result==='D').length,losses:xs.filter(x=>x.result==='L').length,goals_for:+xs.reduce((a,x)=>a+x.gf,0).toFixed(1),goals_against:+xs.reduce((a,x)=>a+x.ga,0).toFixed(1)});
    const h2hRecord={matches:h2h.length,home_side_wins:h2h.filter(h=>(String(h.home_team_external_id)===homeId&&h._hs>h._as)||(String(h.away_team_external_id)===homeId&&h._as>h._hs)).length,draws:h2h.filter(h=>h._hs===h._as).length,away_side_wins:h2h.filter(h=>(String(h.home_team_external_id)===awayId&&h._hs>h._as)||(String(h.away_team_external_id)===awayId&&h._as>h._hs)).length};
    const shrink=(value:number,n:number,base:number)=>(value+base*8)/(n+8);
    const homeAttack=shrink(hs.gf,hs.n,avgH),homeDef=shrink(hs.ga,hs.n,avgA),awayAttack=shrink(as.gf,as.n,avgA),awayDef=shrink(as.ga,as.n,avgH);
    const rateH=clamp(avgH*(homeAttack/Math.max(.2,avgH))*(awayDef/Math.max(.2,avgH)),.15,5.5);
    const rateA=clamp(avgA*(awayAttack/Math.max(.2,avgA))*(homeDef/Math.max(.2,avgA)),.15,5.5);
    const eH=homeId?(ratings.get(homeId)??1500):1500,eA=awayId?(ratings.get(awayId)??1500):1500;
    const eloHome=1/(1+Math.pow(10,((eA-eH)-35)/400));
    let ph=0,pd=0,pa=0;for(let i=0;i<=8;i++)for(let j=0;j<=8;j++){const p=poisson(rateH,i)*poisson(rateA,j);if(i>j)ph+=p;else if(i===j)pd+=p;else pa+=p;}
    const poissonP=norm([ph,pd,pa]),eloP=norm([eloHome*.92,.16,(1-eloHome)*.92]);
    const probs=norm([.55*poissonP[0]+.45*eloP[0],.55*poissonP[1]+.45*eloP[1],.55*poissonP[2]+.45*eloP[2]]);
    const pick=outcome(probs),disagreement=poissonP.indexOf(Math.max(...poissonP))!==eloP.indexOf(Math.max(...eloP));
    const quality=effectiveSample<8?'LOW':effectiveSample<12?'LIMITED':effectiveSample<24?'MODERATE':'ESTABLISHED';
    const action=!sufficient?'PASS_INSUFFICIENT_VERIFIED_HISTORY':disagreement?'PASS_MODEL_DISAGREEMENT':'SHADOW_ONLY_UNVALIDATED';
    const evidenceStrength=clamp(100*Math.min(1,effectiveSample/40)*(disagreement?.85:1),0,100);
    let playerTeamEvidence:any={available:false,reason:"No explicit player/team IDs supplied by this fixture source."};
    if(f.source==="gt"){
      const participants=gtPlayerParticipants(f.payload??{}),playerIds=[...new Set(participants.map((x:any)=>x.playerId))],teamIds=[...new Set(participants.map((x:any)=>x.teamId).filter(Boolean))];
      if(playerIds.length&&teamIds.length){
        const pairRows=await sql`SELECT p.player_external_id,MAX(p.player_name) AS player_name,p.team_external_id,MAX(p.team_name) AS team_name,COUNT(*)::int AS completed_fixture_observations,COUNT(*) FILTER(WHERE (lower(p.side)='home' AND f.home_score_raw::numeric>f.away_score_raw::numeric) OR (lower(p.side)='away' AND f.away_score_raw::numeric>f.home_score_raw::numeric))::int AS wins,COUNT(*) FILTER(WHERE f.home_score_raw::numeric=f.away_score_raw::numeric)::int AS draws,COUNT(*) FILTER(WHERE (lower(p.side)='home' AND f.home_score_raw::numeric<f.away_score_raw::numeric) OR (lower(p.side)='away' AND f.away_score_raw::numeric<f.home_score_raw::numeric))::int AS losses,COUNT(*) FILTER(WHERE p.is_starter IS TRUE)::int AS confirmed_starts,COUNT(*) FILTER(WHERE p.is_starter IS NULL)::int AS unknown_start_status FROM player_match_participation p JOIN fixtures f ON f.source=p.source AND f.external_id=p.fixture_external_id WHERE p.source='gt' AND p.player_external_id=ANY(${playerIds}) AND p.team_external_id=ANY(${teamIds}) AND f.result_state='completed' AND f.home_score_raw ~ '^[0-9]+$' AND f.away_score_raw ~ '^[0-9]+$' GROUP BY p.player_external_id,p.team_external_id`;
        playerTeamEvidence={available:true,current_participants:participants.map((x:any)=>({player_id:x.playerId,player_name:x.playerName,team_id:x.teamId,team_name:x.teamName,side:x.side,confirmed_starter:x.isStarter,position:x.position})),historical_player_team_records:pairRows.map((x:any)=>({...x,win_rate:x.completed_fixture_observations?+(100*x.wins/x.completed_fixture_observations).toFixed(1):null})),note:"Player/team pairing evidence is descriptive only until enough independent history exists for validated model inclusion."};
      }
    }
    const prediction={source:f.source,fixture_id:f.external_id,competition:f.competition,competition_id:f.competition_external_id,home:f.home_name,away:f.away_name,kickoff:f.kickoff_raw,prediction:sufficient?pick:null,action,probabilities:sufficient?{home_win:+(probs[0]*100).toFixed(2),draw:+(probs[1]*100).toFixed(2),away_win:+(probs[2]*100).toFixed(2)}:null,evidence_strength_score:+evidenceStrength.toFixed(2),evidence:{historical_matches_in_competition:hist.length,team_related_matches:sample,home_team_completed_matches:homeSample,away_team_completed_matches:awaySample,minimum_required_per_team:MIN_TEAM_MATCHES,competition_id:f.competition_external_id??null,home_team_id:homeId,away_team_id:awayId,home_rating:sufficient?+eH.toFixed(1):null,away_rating:sufficient?+eA.toFixed(1):null,home_expected_goals:sufficient?+rateH.toFixed(2):null,away_expected_goals:sufficient?+rateA.toFixed(2):null,elo_home_probability:sufficient?+(eloP[0]*100).toFixed(2):null,score_model_probabilities:sufficient?{home:+(poissonP[0]*100).toFixed(2),draw:+(poissonP[1]*100).toFixed(2),away:+(poissonP[2]*100).toFixed(2)}:null,data_quality:quality,model_agreement:sufficient?!disagreement:null,head_to_head:h2hRecord,home_recent_form:form(homeRecent),away_recent_form:form(awayRecent),player_team:playerTeamEvidence,odds_used:false},warning:"Experimental shadow forecast only. Not walk-forward validated or calibrated; not a betting recommendation."};
    // Store the first pre-match forecast only. Later polling cannot overwrite it or
    // manufacture a new historical forecast after a result becomes known.
    if(sufficient) await sql`WITH claimed AS (
        INSERT INTO prediction_forecast_keys(source,external_fixture_id,model_version)
        VALUES(${f.source},${String(f.external_id)},${MODEL_VERSION})
        ON CONFLICT(source,external_fixture_id,model_version) DO NOTHING
        RETURNING source,external_fixture_id,model_version
      ) INSERT INTO prediction_history(source,external_fixture_id,model_version,predicted_at,predicted_outcome,home_probability,draw_probability,away_probability,evidence_strength_score,evidence,feature_snapshot,prediction_status)
        SELECT claimed.source,claimed.external_fixture_id,claimed.model_version,now(),${pick},${probs[0]},${probs[1]},${probs[2]},${evidenceStrength},${JSON.stringify(prediction.evidence)}::jsonb,${JSON.stringify(prediction.evidence)}::jsonb,'shadow' FROM claimed`;
    if(sufficient){
      const savedRows=await sql`SELECT predicted_at,predicted_outcome,home_probability,draw_probability,away_probability,evidence_strength_score,evidence,feature_snapshot FROM prediction_history WHERE source=${f.source} AND external_fixture_id=${String(f.external_id)} AND model_version=${MODEL_VERSION} ORDER BY predicted_at ASC LIMIT 1`;
      if(savedRows.length){
        const saved=savedRows[0];
        output.push({...prediction,prediction:saved.predicted_outcome,action:"SHADOW_FORECAST_RECORDED_IMMUTABLE",probabilities:{home_win:+(Number(saved.home_probability)*100).toFixed(2),draw:+(Number(saved.draw_probability)*100).toFixed(2),away_win:+(Number(saved.away_probability)*100).toFixed(2)},evidence_strength_score:Number(saved.evidence_strength_score),evidence:saved.feature_snapshot??saved.evidence,forecast_recorded_at:saved.predicted_at,immutable_forecast:true});
      } else output.push({...prediction,prediction:null,probabilities:null,action:"PASS_FORECAST_CLAIM_UNAVAILABLE"});
    } else output.push(prediction);
  }
  return {model:MODEL_VERSION,generated_at:new Date().toISOString(),count:output.length,odds_used:false,probability_note:"Shadow-only probabilities; not a validated accuracy estimate. Team-specific features require explicit source-scoped team IDs and completed historical fixtures.",predictions:output};
}
