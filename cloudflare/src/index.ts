import { ealFixtures, ealStandings, gtParticipants, isSoccerCompetition, betikaSelections, validOdds } from "./normalize";
import { neon } from "@neondatabase/serverless";

interface Env { DATABASE_URL: string; ADMIN_TOKEN?: string; }
type Obj = Record<string, any>;
type SourceResult = { source: string; ok: boolean; records: number; error?: string };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const str = (v: unknown): string | null => v === null || v === undefined || v === "" ? null : String(v);
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const pick = (o: Obj, ...keys: string[]) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null) return o[k]; return null; };
const timeout = (ms: number) => AbortSignal.timeout(ms);

async function getJson(url: string, headers: Record<string,string> = {}): Promise<any> {
  let last: unknown;
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: timeout(18000) });
      const body = await r.text();
      if ([401,403,451].includes(r.status)) throw new Error(`ACCESS_RESTRICTED_${r.status}`);
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP_${r.status}: ${body.slice(0,180)}`);
      if (!r.ok) throw new Error(`HTTP_${r.status}: ${body.slice(0,180)}`);
      const value = JSON.parse(body);
      if (value && (value.error || value.success === false || value.status === "error"))
        throw new Error(`UPSTREAM_ERROR: ${JSON.stringify(value).slice(0,250)}`);
      return value;
    } catch (e) {
      last=e;
      if (String(e).includes("ACCESS_RESTRICTED")) throw e;
      if (attempt<2) await new Promise(r=>setTimeout(r, 400 * (2 ** attempt)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
async function raw(sql:any, runId:number, source:string, dataset:string, externalId:string|null, payload:any) {
  await sql`INSERT INTO raw_snapshots(run_id,source,dataset,external_id,payload) VALUES(${runId},${source},${dataset},${externalId},${JSON.stringify(payload)}::jsonb)`;
}
async function upsertFixture(sql:any, runId:number, source:string, id:string, comp:any, home:any, away:any, kickoff:any, status:any, hs:any, ascore:any, payload:any) {
  const prior = await sql`SELECT status_raw,home_score_raw,away_score_raw FROM fixtures WHERE source=${source} AND external_id=${id} LIMIT 1`;
  await sql`INSERT INTO fixtures(source,external_id,competition,home_name,away_name,kickoff_raw,status_raw,home_score_raw,away_score_raw,payload,updated_at)
    VALUES(${source},${id},${str(comp)},${str(home)},${str(away)},${str(kickoff)},${str(status)},${str(hs)},${str(ascore)},${JSON.stringify(payload)}::jsonb,now())
    ON CONFLICT(source,external_id) DO UPDATE SET competition=EXCLUDED.competition,home_name=EXCLUDED.home_name,away_name=EXCLUDED.away_name,kickoff_raw=EXCLUDED.kickoff_raw,status_raw=EXCLUDED.status_raw,home_score_raw=EXCLUDED.home_score_raw,away_score_raw=EXCLUDED.away_score_raw,payload=EXCLUDED.payload,updated_at=now()`;
  const changed = !prior.length || prior[0].status_raw!==str(status) || prior[0].home_score_raw!==str(hs) || prior[0].away_score_raw!==str(ascore);
  if (changed && (hs!==null || ascore!==null || status!==null)) {
    await sql`INSERT INTO score_observations(source,external_id,status_raw,home_score_raw,away_score_raw,payload)
      VALUES(${source},${id},${str(status)},${str(hs)},${str(ascore)},${JSON.stringify(payload)}::jsonb)`;
  }
}
async function updateHealth(sql:any, source:string, error?:string) {
  if (error) await sql`INSERT INTO source_health(source,last_error_at,last_error,consecutive_failures) VALUES(${source},now(),${error.slice(0,2000)},1)
    ON CONFLICT(source) DO UPDATE SET last_error_at=now(),last_error=EXCLUDED.last_error,consecutive_failures=source_health.consecutive_failures+1`;
  else await sql`INSERT INTO source_health(source,last_success_at,last_error,consecutive_failures) VALUES(${source},now(),NULL,0)
    ON CONFLICT(source) DO UPDATE SET last_success_at=now(),last_error=NULL,consecutive_failures=0`;
}
async function sourceRun(sql:any, runId:number, source:string, fn:()=>Promise<number>):Promise<SourceResult> {
  try { const records=await fn(); await updateHealth(sql,source); return {source,ok:true,records}; }
  catch(e) { const error=e instanceof Error?e.message:String(e); await updateHealth(sql,source,error); return {source,ok:false,records:0,error}; }
}
async function collectEal(sql:any, runId:number):Promise<SourceResult> {
  return sourceRun(sql,runId,"eadriatic",async()=>{
    const seasons=(await sql`SELECT external_id FROM entity_mappings WHERE entity_type='eal_season' AND source_a='eadriatic' AND verified=true`).map((x:any)=>String(x.external_id));
    const ids=[...new Set(["656829288",...seasons])]; let count=0;
    for (const season of ids) {
      const v=await getJson(`https://api.leaguerepublic.com/json/getMatchHub/${encodeURIComponent(season)}.json`);
      await raw(sql,runId,"eadriatic","match_hub",season,v);
      const groups=arr(v.fixtureGroupList);
      for (const group of groups) {
        for (const f of arr(group.fixtures)) {
          const id=str(pick(f,"fixtureID","fixtureId")); if(!id) continue;
          const home=pick(f,"homeTeamName") ?? pick(f.homeTeam??{},"teamName","name");
          const away=pick(f,"roadTeamName") ?? pick(f.roadTeam??{},"teamName","name");
          await upsertFixture(sql,runId,"eadriatic",id,pick(group,"fixtureGroupName","name","description"),home,away,
            pick(f,"fixtureDate","fixtureDateInMilliseconds"),`${str(pick(f,"fixtureStatusDesc","fixtureStatus"))??""}${f.approved===undefined?"":` approved=${f.approved}`}`,
            pick(f,"homeScore"),pick(f,"roadScore","awayScore"),f); count++;
        }
        for (const table of arr(group.standings)) for (const line of arr(table.standingsLines)) {
          const teamId=str(pick(line,"teamID")); if(!teamId) continue;
          await sql`INSERT INTO standings(source,competition,external_team_id,team_name,position,points,played,won,tied,lost,score_for,score_against,win_percentage,recent_form,payload,observed_at)
            VALUES('eadriatic',${str(pick(group,"fixtureGroupName","name"))},${teamId},${str(pick(line,"teamName"))},${Number(pick(line,"position"))||null},${Number(pick(line,"points"))||null},${Number(pick(line,"overallPlayed"))||null},${Number(pick(line,"overallWon"))||null},${Number(pick(line,"overallTied"))||null},${Number(pick(line,"overallLoss"))||null},${Number(pick(line,"overallScoreFor"))||null},${Number(pick(line,"overallScoreAgainst"))||null},${Number(pick(line,"overallWinPercentage"))||null},${str(pick(line,"recentForm"))},${JSON.stringify(line)}::jsonb,now())`;
        }
      }
      await new Promise(r=>setTimeout(r,2200));
    }
    return count;
  });
}
async function collectGt(sql:any, runId:number):Promise<SourceResult> {
  return sourceRun(sql,runId,"gt",async()=>{
    const headers={"Origin":"https://www.gtleagues.com","Referer":"https://www.gtleagues.com/","Accept":"application/json, text/plain, */*"};
    const sports=await getJson("https://api.gtleagues.com/api/sports",headers); await raw(sql,runId,"gt","sports",null,sports);
    const seasons=await getJson("https://api.gtleagues.com/api/seasons?status=1",headers); await raw(sql,runId,"gt","active_seasons",null,seasons);
    const sportsText=JSON.stringify(sports).toLowerCase();
    if(!sportsText.includes("soccer")) throw new Error("GT sport discovery did not identify soccer; fixtures not ingested");
    let offset=0,count=0;
    for(let page=0;page<5;page++){
      const v=await getJson(`https://api.gtleagues.com/api/fixtures?offset=${offset}&limit=200&xtc=true`,headers);
      if(!Array.isArray(v)) throw new Error("GT fixtures response is not a top-level array");
      await raw(sql,runId,"gt","fixtures_page",String(offset),v);
      for(const f of v){
        if(!isSoccerCompetition(f)) continue;
        const participants=gtParticipants(f);
        const stats=f.result?.stats??{};
        const id=str(pick(f,"id")); if(!id) continue;
        await upsertFixture(sql,runId,"gt",id,f.season?.name,participants.home,participants.away,pick(f,"kickoff"),pick(f,"status"),
          pick(stats,"home_score"),pick(stats,"away_score"),f); count++;
      }
      if(v.length<200) break;
      offset+=v.length; await new Promise(r=>setTimeout(r,1100));
    }
    return count;
  });
}
async function collectBetika(sql:any,runId:number):Promise<SourceResult>{
  return sourceRun(sql,runId,"betika",async()=>{
    let count=0;
    for(let page=1;page<=3;page++){
      const v=await getJson(`https://api.betika.com/v1/uo/matches?page=${page}&limit=200&sport_id=105&period_id=-1`);
      if(!Array.isArray(v?.data)) throw new Error("Betika response missing data[]");
      await raw(sql,runId,"betika","matches",String(page),v);
      for(const f of v.data){
        const id=str(pick(f,"match_id","game_id","id")); if(!id) continue;
        const compId=str(pick(f,"competition_id","league_id","competitionId"));
        const comp=compId==="43822"?"eAdriatic":compId==="44877"?"GT Sports":str(pick(f,"competition_name","competition","category"));
        await upsertFixture(sql,runId,"betika",id,comp,pick(f,"home_team","homeTeam"),pick(f,"away_team","awayTeam"),
          pick(f,"start_time","match_time","date"),pick(f,"status"),pick(f,"home_score"),pick(f,"away_score"),f);
        for(const market of arr(f.odds)){
          const marketName=str(pick(market,"name","sub_type_name","sub_type_id","market_name"))??"unknown";
          for(const selection of arr(market.odds)){
            const outcome=str(pick(selection,"odd_key","name","display","outcome_id"))??"unknown";
            const price=Number(pick(selection,"odd_value","value","odds"));
            if(!Number.isFinite(price)||price<=1) continue;
            await sql`INSERT INTO odds_observations(source,external_fixture_id,market,selection,odds_raw,payload)
              SELECT 'betika',${id},${marketName},${outcome},${String(price)},${JSON.stringify(selection)}::jsonb
              WHERE NOT EXISTS(SELECT 1 FROM odds_observations WHERE source='betika' AND external_fixture_id=${id} AND market=${marketName} AND selection=${outcome} AND odds_raw=${String(price)} AND observed_at>now()-interval '10 minutes')`;
          }
        }
        count++;
      }
      if(v.data.length<200) break;
      await new Promise(r=>setTimeout(r,700));
    }
    return count;
  });
}
async function collect(env:Env):Promise<any>{
  const sql=neon(env.DATABASE_URL);
  const lock=await sql`INSERT INTO collection_lock(lock_name,locked_until) VALUES('scheduled',now()+interval '10 minutes')
    ON CONFLICT(lock_name) DO UPDATE SET locked_until=EXCLUDED.locked_until
    WHERE collection_lock.locked_until<now() RETURNING lock_name`;
  if(!lock.length) return {ok:false,skipped:true,reason:"collection already running"};
  const run=await sql`INSERT INTO collection_runs(status) VALUES('running') RETURNING id`;
  const id=Number(run[0].id);
  const results=await Promise.all([collectEal(sql,id),collectGt(sql,id),collectBetika(sql,id)]);
  const failures=results.filter(x=>!x.ok).length;
  const status=failures===0?"success":failures===results.length?"failed":"partial";
  await sql`UPDATE collection_runs SET finished_at=now(),status=${status},summary=${JSON.stringify(results)}::jsonb WHERE id=${id}`;
  await sql`UPDATE collection_lock SET locked_until=now() WHERE lock_name='scheduled'`;
  return {ok:failures===0,run_id:id,status,sources:results};
}
async function route(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url), path=url.pathname, sql=neon(env.DATABASE_URL);
  if(path==="/health"||path==="/api/v1/health") {
    try { const r=await sql`SELECT now() AS database_time`; return json({ok:true,service:"rusty-esoccer",database:"connected",database_time:r[0].database_time});}
    catch(e){return json({ok:false,error:"database unavailable"},503);}
  }
  if(path==="/health/db") { try {const r=await sql`SELECT now() AS database_time,current_database() AS database_name`;return json({ok:true,database:"connected",details:r[0]});}catch{return json({ok:false,database:"connection_failed"},503);} }
  if(path==="/api/v1/collection/status"||path==="/api/v1/sources"){
    const rows=await sql`SELECT * FROM source_health ORDER BY source`; return json({sources:rows});
  }
  if(path==="/api/v1/runs"){
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||25)));
    const rows=await sql`SELECT * FROM collection_runs ORDER BY id DESC LIMIT ${limit}`; return json({runs:rows});
  }
  const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit")||50)));
  const offset=Math.max(0,Number(url.searchParams.get("offset")||0));
  const source=url.searchParams.get("source");
  if(path==="/api/v1/fixtures"||path==="/api/v1/results"){
    const rows=source?await sql`SELECT * FROM fixtures WHERE source=${source} ORDER BY kickoff_raw DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`:
      await sql`SELECT * FROM fixtures ORDER BY kickoff_raw DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`;
    return json({count:rows.length,limit,offset,fixtures:rows});
  }
  const one=path.match(/^\/api\/v1\/fixtures\/([^/]+)$/);
  if(one){const id=decodeURIComponent(one[1]);const rows=await sql`SELECT * FROM fixtures WHERE external_id=${id} ORDER BY id`;return rows.length?json({fixtures:rows}):json({error:"not_found"},404);}
  if(path==="/api/v1/standings"){const rows=await sql`SELECT DISTINCT ON(source,competition,external_team_id) * FROM standings ORDER BY source,competition,external_team_id,observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`;return json({standings:rows});}
  if(path==="/api/v1/odds"){const rows=await sql`SELECT DISTINCT ON(source,external_fixture_id,market,selection) * FROM odds_observations ORDER BY source,external_fixture_id,market,selection,observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`;return json({odds:rows});}
  if(path==="/api/v1/odds/history"){const id=url.searchParams.get("fixture_id");const rows=id?await sql`SELECT * FROM odds_observations WHERE external_fixture_id=${id} ORDER BY observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`:await sql`SELECT * FROM odds_observations ORDER BY observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`;return json({history:rows});}
  if(path==="/api/v1/players"){const rows=await sql`SELECT DISTINCT source,external_id,home_name,away_name,competition FROM fixtures WHERE home_name IS NOT NULL OR away_name IS NOT NULL ORDER BY source,external_id LIMIT ${limit} OFFSET ${offset}`;return json({players:rows,note:"Player identity is source-scoped; verified mappings are not inferred from names."});}
  if(path.startsWith("/api/v1/players/"))return json({error:"player profile endpoint requires source-specific player IDs; no unverified cross-source identity is inferred."},501);
  if(path==="/api/v1/head-to-head")return json({error:"Head-to-head requires verified player mappings; no name-only matching is performed."},501);
  if(path==="/api/v1/collection/run"&&request.method==="POST"){
    if(!env.ADMIN_TOKEN||request.headers.get("authorization")!==`Bearer ${env.ADMIN_TOKEN}`)return json({error:"unauthorized"},401);
    return json(await collect(env));
  }
  return json({service:"Esports Data Engine",status:"online",endpoints:["/api/v1/health","/api/v1/fixtures","/api/v1/results","/api/v1/standings","/api/v1/odds","/api/v1/odds/history","/api/v1/runs","/api/v1/sources","/api/v1/collection/status"]});
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{try{return await route(request,env);}catch(e){return json({ok:false,error:e instanceof Error?e.message:"internal error"},500);}},
  async scheduled(_event:ScheduledEvent,env:Env,ctx:ExecutionContext):Promise<void>{ctx.waitUntil(collect(env));}
};
