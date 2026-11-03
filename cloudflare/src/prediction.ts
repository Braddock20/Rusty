import { gtPlayerParticipants } from "./normalize";
/** Odds-free eSoccer forecasting. Uses completed historical scores only. */
type Row = Record<string, any>;
const clamp = (x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
const num = (v:any):number|null => { if(v===null||v===undefined||v==='') return null; const n=Number(v); return Number.isFinite(n)&&n>=0?n:null; };
const dateOf = (v:any):number|null => { if(v===null||v===undefined) return null; const s=String(v); let n=Date.parse(s); if(!Number.isFinite(n) && /^\d{10,13}$/.test(s)) { const x=Number(s); n=x<1e12?x*1000:x; } return Number.isFinite(n)?n:null; };
const poisson = (lambda:number,k:number) => { let p=Math.exp(-lambda); for(let i=1;i<=k;i++) p*=lambda/i; return p; };
const outcome = (p:[number,number,number]) => p[0]>=p[1]&&p[0]>=p[2]?'HOME':p[1]>=p[2]?'DRAW':'AWAY';
const norm = (p:number[]) => { const s=p.reduce((a,b)=>a+b,0)||1; return p.map(x=>x/s) as [number,number,number]; };

export async function buildPredictions(sql:any, limit=50, source:string|null=null) {
  const upcoming = source
    ? await sql`SELECT source,external_id,competition,home_name,away_name,kickoff_raw,status_raw,payload FROM fixtures WHERE source=${source} AND home_name IS NOT NULL AND away_name IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT 2000`
    : await sql`SELECT source,external_id,competition,home_name,away_name,kickoff_raw,status_raw FROM fixtures WHERE home_name IS NOT NULL AND away_name IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT 4000`;
  const now=Date.now();
  const targets=upcoming.filter((f:Row)=>{ const t=dateOf(f.kickoff_raw); const s=String(f.status_raw??'').toLowerCase(); return t!==null&&t>now&& !/(cancel|abandon|finished|complete|played|result)/.test(s); }).slice(0,limit);
  if(!targets.length) return {model:'rusty-ensemble-v1',generated_at:new Date().toISOString(),count:0,predictions:[],note:'No future fixtures with parseable kickoff times were found. No predictions were fabricated.'};
  const sources=[...new Set(targets.map((f:Row)=>f.source))];
  const histories=await sql`SELECT source,external_id,competition,home_name,away_name,kickoff_raw,home_score_raw,away_score_raw,status_raw FROM fixtures WHERE source = ANY(${sources}) AND home_name IS NOT NULL AND away_name IS NOT NULL AND home_score_raw ~ '^[0-9]+(\\.[0-9]+)?$' AND away_score_raw ~ '^[0-9]+(\\.[0-9]+)?$' ORDER BY kickoff_raw DESC LIMIT 30000`;
  const groups=new Map<string,Row[]>();
  for(const h of histories){const t=dateOf(h.kickoff_raw); const hs=num(h.home_score_raw),as=num(h.away_score_raw); const st=String(h.status_raw??'').toLowerCase(); if(t===null||t>=now||hs===null||as===null||/(scheduled|upcoming|cancel|postpon)/.test(st))continue; const key=`${h.source}|${h.competition??''}`; if(!groups.has(key))groups.set(key,[]); groups.get(key)!.push({...h,_time:t,_hs:hs,_as:as});}
  const output=[];
  for(const f of targets){
    const key=`${f.source}|${f.competition??''}`; const hist=(groups.get(key)??[]).sort((a,b)=>a._time-b._time); const home=String(f.home_name),away=String(f.away_name); const teamMatches=hist.filter(h=>h.home_name===home||h.away_name===home||h.home_name===away||h.away_name===away);
    const ratings=new Map<string,number>(); const stats=new Map<string,{gf:number;ga:number;n:number;recent:{gf:number;ga:number;w:number}[]}>();
    const get=(team:string)=>{if(!stats.has(team))stats.set(team,{gf:0,ga:0,n:0,recent:[]});return stats.get(team)!;};
    let leagueHome=0,leagueAway=0,leagueN=0;
    for(const h of hist){const ht=String(h.home_name),at=String(h.away_name),hs=h._hs,as=h._as; const ageDays=Math.max(0,(now-h._time)/86400000); const w=Math.exp(-ageDays/45); const hr=ratings.get(ht)??1500,ar=ratings.get(at)??1500; const expected=1/(1+Math.pow(10,((ar-hr)-35)/400)); const actual=hs>as?1:hs<as?0:0.5; const margin=Math.min(2.2,Math.log1p(Math.abs(hs-as))); const k=24*(0.65+0.35*w)*Math.max(0.7,margin); ratings.set(ht,hr+k*(actual-expected)); ratings.set(at,ar-k*((1-actual)-(1-expected)));
      const a=get(ht),b=get(at); a.gf+=hs*w;a.ga+=as*w;a.n+=w;a.recent.push({gf:hs,ga:as,w}); b.gf+=as*w;b.ga+=hs*w;b.n+=w;b.recent.push({gf:as,ga:hs,w}); leagueHome+=hs*w;leagueAway+=as*w;leagueN+=w; }
    const hs=get(home),as=get(away),sample=teamMatches.length; const avgH=leagueN?leagueHome/leagueN:1.5,avgA=leagueN?leagueAway/leagueN:1.3;
    const h2h=hist.filter(h=>(String(h.home_name)===home&&String(h.away_name)===away)||(String(h.home_name)===away&&String(h.away_name)===home));
    const recentFor=(team:string)=>hist.filter(h=>h.home_name===team||h.away_name===team).slice(-10).map(h=>{const isHome=h.home_name===team;const gf=isHome?h._hs:h._as,ga=isHome?h._as:h._hs;return {gf,ga,result:gf>ga?'W':gf<ga?'L':'D'};});
    const homeRecent=recentFor(home),awayRecent=recentFor(away);
    const form=(xs:any[])=>({matches:xs.length,wins:xs.filter(x=>x.result==='W').length,draws:xs.filter(x=>x.result==='D').length,losses:xs.filter(x=>x.result==='L').length,goals_for:+xs.reduce((a,x)=>a+x.gf,0).toFixed(1),goals_against:+xs.reduce((a,x)=>a+x.ga,0).toFixed(1)});
    const h2hRecord={matches:h2h.length,home_side_wins:h2h.filter(h=>(h.home_name===home&&h._hs>h._as)||(h.away_name===home&&h._as>h._hs)).length,draws:h2h.filter(h=>h._hs===h._as).length,away_side_wins:h2h.filter(h=>(h.home_name===away&&h._hs>h._as)||(h.away_name===away&&h._as>h._hs)).length};
    const shrink=(value:number,n:number,base:number)=> (value+base*8)/(n+8);
    const homeAttack=shrink(hs.gf,hs.n,avgH),homeDef=shrink(hs.ga,hs.n,avgA); const awayAttack=shrink(as.gf,as.n,avgA),awayDef=shrink(as.ga,as.n,avgH);
    const rateH=clamp(avgH*(homeAttack/Math.max(.2,avgH))*(awayDef/Math.max(.2,avgH)),.15,5.5);
    const rateA=clamp(avgA*(awayAttack/Math.max(.2,avgA))*(homeDef/Math.max(.2,avgA)),.15,5.5);
    const eH=ratings.get(home)??1500,eA=ratings.get(away)??1500; const eloHome=1/(1+Math.pow(10,((eA-eH)-35)/400));
    let ph=0,pd=0,pa=0; for(let i=0;i<=8;i++)for(let j=0;j<=8;j++){const p=poisson(rateH,i)*poisson(rateA,j); if(i>j)ph+=p;else if(i===j)pd+=p;else pa+=p;}
    const poissonP=norm([ph,pd,pa]); const eloP=norm([eloHome*.92,.16,(1-eloHome)*.92]);
    // Fixed ensemble weights are conservative defaults; walk-forward tests will determine whether to change them.
    const probs=norm([.55*poissonP[0]+.45*eloP[0],.55*poissonP[1]+.45*eloP[1],.55*poissonP[2]+.45*eloP[2]]);
    const pick=outcome(probs),top=Math.max(...probs); const support=Math.min(1,sample/40); const disagreement=Math.abs(poissonP.indexOf(Math.max(...poissonP))-eloP.indexOf(Math.max(...eloP)))>0?1:0;
    const quality=sample<8?'LOW':sample<20?'LIMITED':sample<40?'MODERATE':'ESTABLISHED'; const action=sample<12?'PASS_INSUFFICIENT_HISTORY':disagreement?'PASS_MODEL_DISAGREEMENT':'SHADOW_ONLY_UNVALIDATED';
    const evidenceStrength=clamp(100*(.25+.75*support)*(disagreement?.85:1),0,100);
    let playerTeamEvidence:any={available:false,reason:"No explicit player/team IDs supplied by this fixture source."};
    if(f.source==="gt") {
      const participants=gtPlayerParticipants(f.payload??{});
      const playerIds=[...new Set(participants.map((x:any)=>x.playerId))],teamIds=[...new Set(participants.map((x:any)=>x.teamId).filter(Boolean))];
      if(playerIds.length&&teamIds.length){
        const pairRows=await sql`SELECT p.player_external_id,MAX(p.player_name) AS player_name,p.team_external_id,MAX(p.team_name) AS team_name,COUNT(*)::int AS appearances,COUNT(*) FILTER(WHERE (lower(p.side)='home' AND f.home_score_raw::numeric>f.away_score_raw::numeric) OR (lower(p.side)='away' AND f.away_score_raw::numeric>f.home_score_raw::numeric))::int AS wins,COUNT(*) FILTER(WHERE f.home_score_raw::numeric=f.away_score_raw::numeric)::int AS draws,COUNT(*) FILTER(WHERE (lower(p.side)='home' AND f.home_score_raw::numeric<f.away_score_raw::numeric) OR (lower(p.side)='away' AND f.away_score_raw::numeric<f.home_score_raw::numeric))::int AS losses,COUNT(*) FILTER(WHERE p.is_starter IS TRUE)::int AS confirmed_starts,COUNT(*) FILTER(WHERE p.is_starter IS NULL)::int AS unknown_start_status FROM player_match_participation p JOIN fixtures f ON f.source=p.source AND f.external_id=p.fixture_external_id WHERE p.source='gt' AND p.player_external_id=ANY(${playerIds}) AND p.team_external_id=ANY(${teamIds}) AND f.home_score_raw ~ '^[0-9]+(\.[0-9]+)?$' AND f.away_score_raw ~ '^[0-9]+(\.[0-9]+)?$' AND lower(coalesce(f.status_raw,'')) ~ '(finished|complete|final|played|result)' GROUP BY p.player_external_id,p.team_external_id`;
        playerTeamEvidence={available:true,current_participants:participants.map((x:any)=>({player_id:x.playerId,player_name:x.playerName,team_id:x.teamId,team_name:x.teamName,side:x.side,confirmed_starter:x.isStarter,position:x.position})),historical_player_team_records:pairRows.map((x:any)=>({...x,win_rate:x.appearances?+(100*x.wins/x.appearances).toFixed(1):null})),note:"Player/team pairing evidence is descriptive only until enough independent history exists for validated model inclusion."};
      }
    }
    const prediction={source:f.source,fixture_id:f.external_id,competition:f.competition,home,away,kickoff:f.kickoff_raw,prediction:sample>=12?pick:null,action,probabilities:sample>=12?{home_win:+(probs[0]*100).toFixed(2),draw:+(probs[1]*100).toFixed(2),away_win:+(probs[2]*100).toFixed(2)}:null,evidence_strength_score:+evidenceStrength.toFixed(2),evidence:{historical_matches_in_competition:hist.length,team_related_matches:sample,home_rating:+eH.toFixed(1),away_rating:+eA.toFixed(1),home_expected_goals:+rateH.toFixed(2),away_expected_goals:+rateA.toFixed(2),elo_home_probability:+(eloP[0]*100).toFixed(2),score_model_probabilities:{home:+(poissonP[0]*100).toFixed(2),draw:+(poissonP[1]*100).toFixed(2),away:+(poissonP[2]*100).toFixed(2)},data_quality:quality,model_agreement:!disagreement,head_to_head:h2hRecord,home_recent_form:form(homeRecent),away_recent_form:form(awayRecent),player_team:playerTeamEvidence,odds_used:false},warning:'Experimental shadow forecast only. This version has not yet passed a walk-forward validation on this eSoccer dataset; it is not a proven accuracy rate or betting recommendation.'};
    output.push(prediction);
    if(sample>=12) await sql`INSERT INTO prediction_history(source,external_fixture_id,model_version,predicted_at,predicted_outcome,home_probability,draw_probability,away_probability,evidence_strength_score,evidence,feature_snapshot)
      SELECT ${f.source},${String(f.external_id)},'rusty-ensemble-v1',now(),${pick},${probs[0]},${probs[1]},${probs[2]},${evidenceStrength},${JSON.stringify(prediction.evidence)}::jsonb,${JSON.stringify(prediction.evidence)}::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM prediction_history WHERE source=${f.source} AND external_fixture_id=${String(f.external_id)} AND model_version='rusty-ensemble-v1' AND predicted_at>now()-interval '20 minutes')`;
  }
  return {model:'rusty-ensemble-v1',generated_at:new Date().toISOString(),count:output.length,odds_used:false,probability_note:'Experimental model probabilities are not accuracy percentages. evidence_strength_score measures data support only. Forecasts are shadow-only until walk-forward backtesting and calibration pass on this dataset.',predictions:output};
}
