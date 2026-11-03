import { gtParticipants, gtPlayerParticipants, isSoccerCompetition } from "./normalize";
import { neon } from "@neondatabase/serverless";
import { buildPredictions } from "./prediction";
import { classifyResultState, parseJsonBody, isRetryableStatus, safeInt } from "./guards";

interface Env { DATABASE_URL: string; ADMIN_TOKEN?: string; }
type Obj = Record<string, any>;
type SourceResult = { source: string; ok: boolean; records: number; error?: string };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"} });
const str = (v: unknown): string | null => v === null || v === undefined || v === "" ? null : String(v);
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const numberOrNull = (v:unknown):number|null => { if(v===null||v===undefined||v==="") return null; const n=Number(v); return Number.isFinite(n)?n:null; };
const pick = (o: Obj, ...keys: string[]) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null) return o[k]; return null; };
const timeout = (ms: number) => AbortSignal.timeout(ms);
const MAX_RUN_MS = 8 * 60 * 1000;
const HEARTBEAT_MS = 30000;

async function getJson(url: string, headers: Record<string,string> = {}, source="UPSTREAM"): Promise<any> {
  let last: unknown;
  for (let attempt=0; attempt<2; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: timeout(12000) });
    } catch (e) {
      last = new Error(`${source}_NETWORK_ERROR: ${e instanceof Error ? e.message : String(e)}`);
      if (attempt === 0) { await new Promise(r=>setTimeout(r,500)); continue; }
      break;
    }
    let body="";
    try { body = await response.text(); }
    catch (e) {
      last = new Error(`${source}_BODY_READ_ERROR: ${e instanceof Error ? e.message : String(e)}`);
      if (attempt === 0) { await new Promise(r=>setTimeout(r,500)); continue; }
      break;
    }
    if ([401,403,451].includes(response.status)) throw new Error(`${source}_ACCESS_RESTRICTED_${response.status}`);
    if (response.status === 429) {
      const retryHeader=response.headers.get("Retry-After");
      let retrySeconds=retryHeader&&/^\d+$/.test(retryHeader)?Number(retryHeader):retryHeader?Math.ceil((Date.parse(retryHeader)-Date.now())/1000):NaN;
      try { const parsed = JSON.parse(body); retrySeconds = Number(parsed?.retry_after_seconds ?? retrySeconds); } catch { /* provider error body need not be JSON */ }
      throw new Error(`RATE_LIMITED_429: retry after ${Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds : 60}s; ${body.slice(0,180)}`);
    }
    if (!response.ok) {
      const error = new Error(`${source}_HTTP_${response.status}: ${body.slice(0,180)}`);
      if (isRetryableStatus(response.status) && attempt === 0) { last=error; await new Promise(r=>setTimeout(r,700)); continue; }
      throw error;
    }
    let value:any;
    try { value = parseJsonBody(body, source); }
    catch(e) { if(attempt===0) { last=e; await new Promise(r=>setTimeout(r,500)); continue; } throw e; }
    if (value && (value.error || value.success === false || value.status === "error"))
      throw new Error(`${source}_UPSTREAM_ERROR: ${JSON.stringify(value).slice(0,250)}`);
    return value;
  }
  throw last instanceof Error ? last : new Error(String(last ?? `${source}_REQUEST_FAILED`));
}
async function raw(sql:any, runId:number, source:string, dataset:string, externalId:string|null, payload:any) {
  await sql`INSERT INTO raw_snapshots(run_id,source,dataset,external_id,payload) VALUES(${runId},${source},${dataset},${externalId},${JSON.stringify(payload)}::jsonb)`;
}
async function upsertFixture(sql:any, runId:number, source:string, id:string, comp:any, home:any, away:any, kickoff:any, status:any, hs:any, ascore:any, payload:any, homeTeamId:any=null, awayTeamId:any=null, competitionId:any=null) {
  const resultState=classifyResultState(source,status,payload);
  const prior = await sql`SELECT status_raw,home_score_raw,away_score_raw,result_state FROM fixtures WHERE source=${source} AND external_id=${id} LIMIT 1`;
  await sql`INSERT INTO fixtures(source,external_id,competition,home_name,away_name,kickoff_raw,status_raw,home_score_raw,away_score_raw,payload,result_state,home_team_external_id,away_team_external_id,competition_external_id,updated_at)
    VALUES(${source},${id},${str(comp)},${str(home)},${str(away)},${str(kickoff)},${str(status)},${str(hs)},${str(ascore)},${JSON.stringify(payload)}::jsonb,${resultState},${str(homeTeamId)},${str(awayTeamId)},${str(competitionId)},now())
    ON CONFLICT(source,external_id) DO UPDATE SET competition=EXCLUDED.competition,home_name=EXCLUDED.home_name,away_name=EXCLUDED.away_name,kickoff_raw=EXCLUDED.kickoff_raw,status_raw=EXCLUDED.status_raw,home_score_raw=EXCLUDED.home_score_raw,away_score_raw=EXCLUDED.away_score_raw,payload=EXCLUDED.payload,result_state=CASE WHEN EXCLUDED.result_state='unknown' THEN fixtures.result_state ELSE EXCLUDED.result_state END,home_team_external_id=COALESCE(EXCLUDED.home_team_external_id,fixtures.home_team_external_id),away_team_external_id=COALESCE(EXCLUDED.away_team_external_id,fixtures.away_team_external_id),competition_external_id=COALESCE(EXCLUDED.competition_external_id,fixtures.competition_external_id),updated_at=now()`;
  const changed = !prior.length || prior[0].status_raw!==str(status) || prior[0].home_score_raw!==str(hs) || prior[0].away_score_raw!==str(ascore) || prior[0].result_state!==resultState;
  if (changed && (hs!==null || ascore!==null || status!==null)) {
    await sql`INSERT INTO score_observations(source,external_id,status_raw,home_score_raw,away_score_raw,payload,result_state)
      VALUES(${source},${id},${str(status)},${str(hs)},${str(ascore)},${JSON.stringify(payload)}::jsonb,${resultState})`;
  }
}
function retryAfterSeconds(error:string):number|null {
  const match=error.match(/retry after (\d+)s/i);
  if(!match) return null;
  const seconds=Number(match[1]);
  return Number.isFinite(seconds)&&seconds>0?Math.min(seconds,86400):null;
}
async function updateHealth(sql:any, source:string, error?:string, records=0) {
  if (error) {
    const cooldown=retryAfterSeconds(error);
    const code=error.split(":")[0].slice(0,100);
    await sql`INSERT INTO source_health(source,last_attempt_at,last_error_at,last_error,consecutive_failures,cooldown_until,last_record_count,error_code)
      VALUES(${source},now(),now(),${error.slice(0,2000)},1,${cooldown===null?null: new Date(Date.now()+cooldown*1000).toISOString()},0,${code})
      ON CONFLICT(source) DO UPDATE SET last_attempt_at=now(),last_error_at=now(),last_error=EXCLUDED.last_error,
      consecutive_failures=source_health.consecutive_failures+1,
      cooldown_until=CASE WHEN EXCLUDED.cooldown_until IS NOT NULL THEN EXCLUDED.cooldown_until ELSE source_health.cooldown_until END,
      last_record_count=0,error_code=EXCLUDED.error_code`;
  } else await sql`INSERT INTO source_health(source,last_attempt_at,last_success_at,last_error,last_record_count,consecutive_failures,cooldown_until,error_code)
    VALUES(${source},now(),now(),NULL,${records},0,NULL,NULL)
    ON CONFLICT(source) DO UPDATE SET last_attempt_at=now(),last_success_at=now(),last_error=NULL,last_record_count=EXCLUDED.last_record_count,consecutive_failures=0,cooldown_until=NULL,error_code=NULL`;
}
async function sourceRun(sql:any, runId:number, source:string, fn:()=>Promise<number>, renew:()=>Promise<void>):Promise<SourceResult> {
  try {
    const paused=await sql`SELECT cooldown_until FROM source_health WHERE source=${source} AND cooldown_until>now() LIMIT 1`;
    if(paused.length) return {source,ok:false,records:0,error:`COOLDOWN_ACTIVE until ${paused[0].cooldown_until}`};
    await renew();
    await sql`INSERT INTO source_health(source,last_attempt_at) VALUES(${source},now()) ON CONFLICT(source) DO UPDATE SET last_attempt_at=now()`;
    const records=await fn();
    await renew();
    await updateHealth(sql,source,undefined,records);
    return {source,ok:true,records};
  } catch(e) {
    const error=e instanceof Error?e.message:String(e);
    // A superseded Worker must not overwrite health written by the new lease owner.
    const owner=await sql`SELECT 1 FROM collection_lock WHERE lock_name='scheduled' AND run_id=${runId} AND locked_until>now()`;
    const controlFailure=/^COLLECTION_(TIME_BUDGET_EXHAUSTED|LOCK_LOST|HEARTBEAT_FAILED)/.test(error);
    if(owner.length&&!controlFailure) await updateHealth(sql,source,error,0);
    return {source,ok:false,records:0,error};
  }
}
async function collectEal(sql:any, runId:number, renew:()=>Promise<void>):Promise<SourceResult> {
  return sourceRun(sql,runId,"eadriatic",async()=>{
    await renew();
    const seasons=(await sql`SELECT external_id_a AS external_id FROM entity_mappings WHERE entity_type='eal_season' AND source_a='eadriatic' AND verified=true ORDER BY external_id_a`).map((x:any)=>String(x.external_id));
    const ids=[...new Set(["656829288",...seasons])];
    const checkpoint=await sql`SELECT cursor FROM collection_checkpoints WHERE source='eadriatic' AND dataset='seasons' LIMIT 1`;
    const savedSeason=String(checkpoint[0]?.cursor??ids[0]);
    const startIndex=Math.max(0,ids.indexOf(savedSeason));
    const seasonBatch=Math.min(2,ids.length); let count=0;
    for(let batch=0;batch<seasonBatch;batch++) {
      const season=ids[(startIndex+batch)%ids.length];
      await renew();
      const v=await getJson(`https://api.leaguerepublic.com/json/getMatchHub/${encodeURIComponent(season)}.json`,{},"EADRIATIC");
      await renew();
      await raw(sql,runId,"eadriatic","match_hub",season,v);
      if(!Array.isArray(v?.fixtureGroupList)) throw new Error("EADRIATIC_INVALID_MATCH_HUB_SCHEMA: fixtureGroupList[] missing");
      const groups=arr(v.fixtureGroupList);
      for (const group of groups) {
        for (const f of arr(group.fixtures)) {
          await renew();
          const id=str(pick(f,"fixtureID","fixtureId")); if(!id) continue;
          const home=pick(f,"homeTeamName") ?? pick(f.homeTeam??{},"teamName","name");
          const away=pick(f,"roadTeamName") ?? pick(f.roadTeam??{},"teamName","name");
          await upsertFixture(sql,runId,"eadriatic",id,pick(group,"fixtureGroupName","name","description"),home,away,
            pick(f,"fixtureDate","fixtureDateInMilliseconds"),`${[str(pick(f,"fixtureStatusDesc","fixtureStatus")),str(pick(f,"fixtureDateStatusDesc"))].filter(Boolean).join(" / ")}${f.approved===undefined?"":` approved=${f.approved}`}`,
            pick(f,"homeScore"),pick(f,"roadScore","awayScore"),f,
            pick(f,"homeTeamID","homeTeamId")??pick(f.homeTeam??{},"teamID","teamId","id"),
            pick(f,"roadTeamID","awayTeamID","roadTeamId","awayTeamId")??pick(f.roadTeam??{},"teamID","teamId","id"),
            pick(group,"fixtureGroupIdentifier","fixtureTypeID")); count++;
        }
        for (const table of arr(group.standings)) for (const line of arr(table.standingsLines)) {
          await renew();
          const teamId=str(pick(line,"teamID")); if(!teamId) continue;
          await sql`INSERT INTO standings(source,competition,external_team_id,team_name,position,points,played,won,tied,lost,score_for,score_against,win_percentage,recent_form,payload,observed_at)
            VALUES('eadriatic',${str(pick(group,"fixtureGroupName","name"))},${teamId},${str(pick(line,"teamName"))},${numberOrNull(pick(line,"position"))},${numberOrNull(pick(line,"points"))},${numberOrNull(pick(line,"overallPlayed"))},${numberOrNull(pick(line,"overallWon"))},${numberOrNull(pick(line,"overallTied"))},${numberOrNull(pick(line,"overallLoss"))},${numberOrNull(pick(line,"overallScoreFor"))},${numberOrNull(pick(line,"overallScoreAgainst"))},${numberOrNull(pick(line,"overallWinPercentage"))},${str(pick(line,"recentForm"))},${JSON.stringify(line)}::jsonb,now())`;
        }
      }
      const nextSeason=ids[(startIndex+batch+1)%ids.length];
      const cycleComplete=(startIndex+batch+1)%ids.length===0;
      await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,last_complete_at,updated_at)
        VALUES('eadriatic','seasons',${nextSeason},${cycleComplete?new Date().toISOString():null},now())
        ON CONFLICT(source,dataset) DO UPDATE SET cursor=EXCLUDED.cursor,last_complete_at=COALESCE(EXCLUDED.last_complete_at,collection_checkpoints.last_complete_at),updated_at=now()`;
      if(batch+1<seasonBatch) await new Promise(r=>setTimeout(r,2200));
    }
    return count;
  },renew);
}
async function collectGt(sql:any, runId:number, renew:()=>Promise<void>):Promise<SourceResult> {
  return sourceRun(sql,runId,"gt",async()=>{
    const headers={"Origin":"https://www.gtleagues.com","Referer":"https://www.gtleagues.com/","Accept":"application/json, text/plain, */*"};
    await renew();
    const sports=await getJson("https://api.gtleagues.com/api/sports",headers,"GT"); await renew(); await raw(sql,runId,"gt","sports",null,sports);
    await renew();
    const seasons=await getJson("https://api.gtleagues.com/api/seasons?status=1",headers,"GT"); await renew(); await raw(sql,runId,"gt","active_seasons",null,seasons);
    const sportsText=JSON.stringify(sports).toLowerCase();
    if(!sportsText.includes("soccer")) throw new Error("GT sport discovery did not identify soccer; fixtures not ingested");
    const checkpoint=await sql`SELECT cursor FROM collection_checkpoints WHERE source='gt' AND dataset='fixtures' LIMIT 1`;
    const [savedOffset,savedRow]=String(checkpoint[0]?.cursor??"0:0").split(":");
    let offset=Math.max(0,Number(savedOffset)||0),resumeRow=Math.max(0,Number(savedRow)||0),count=0;
    for(let page=0;page<5;page++){
      await renew();
      const v=await getJson(`https://api.gtleagues.com/api/fixtures?offset=${offset}&limit=200&xtc=true`,headers,"GT");
      await renew();
      if(!Array.isArray(v)) throw new Error("GT fixtures response is not a top-level array");
      await raw(sql,runId,"gt","fixtures_page",String(offset),v);
      for(let rowIndex=resumeRow;rowIndex<v.length;rowIndex++){
        const f=v[rowIndex];
        await renew();
        if(!isSoccerCompetition(f)) { if((rowIndex+1)%10===0) await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,updated_at) VALUES('gt','fixtures',${`${offset}:${rowIndex+1}`},now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now()`; continue; }
        const participants=gtParticipants(f);
        const stats=f.result?.stats??{};
        const id=str(pick(f,"id")); if(!id) continue;
        await upsertFixture(sql,runId,"gt",id,f.season?.name,participants.home,participants.away,pick(f,"kickoff"),pick(f,"status"),
          pick(stats,"home_score"),pick(stats,"away_score"),f,participants.homeTeamId,participants.awayTeamId,pick(f.season??{},"id","season_id","seasonId")??pick(f,"season_id","seasonId"));
        // Preserve explicit player/team participation and starter metadata when GT actually supplies it.
        // Missing IDs or starter flags remain unknown; display names are never used as identity keys.
        for (const person of gtPlayerParticipants(f)) {
          await renew();
          await sql`INSERT INTO player_match_participation(source,fixture_external_id,player_external_id,player_name,team_external_id,team_name,side,is_starter,position,payload,observed_at)
            VALUES('gt',${id},${person.playerId},${person.playerName},${person.teamId},${person.teamName},${person.side},${person.isStarter},${person.position},${JSON.stringify(person.payload)}::jsonb,now())
            ON CONFLICT(source,fixture_external_id,player_external_id) DO UPDATE SET player_name=EXCLUDED.player_name,team_external_id=EXCLUDED.team_external_id,team_name=EXCLUDED.team_name,side=EXCLUDED.side,is_starter=COALESCE(EXCLUDED.is_starter,player_match_participation.is_starter),position=COALESCE(EXCLUDED.position,player_match_participation.position),payload=EXCLUDED.payload,observed_at=now()`;
          if(person.teamId) { await renew(); await sql`INSERT INTO player_team_history(source,player_external_id,team_external_id) VALUES('gt',${person.playerId},${person.teamId})
            ON CONFLICT(source,player_external_id,team_external_id) DO UPDATE SET last_seen_at=now(),appearances=(SELECT count(*)::int FROM player_match_participation WHERE source='gt' AND player_external_id=${person.playerId} AND team_external_id=${person.teamId})`; }
        }
        count++;
        if((rowIndex+1)%10===0) await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,updated_at) VALUES('gt','fixtures',${`${offset}:${rowIndex+1}`},now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now()`;
      }
      resumeRow=0;
      if(v.length<200){
        await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,last_complete_at,updated_at) VALUES('gt','fixtures','0:0',now(),now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor='0:0',last_complete_at=now(),updated_at=now()`;
        break;
      }
      offset+=v.length;
      await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,updated_at) VALUES('gt','fixtures',${`${offset}:0`},now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now()`;
      await new Promise(r=>setTimeout(r,1100));
    }
    return count;
  },renew);
}
async function collectBetika(sql:any,runId:number,renew:()=>Promise<void>):Promise<SourceResult>{
  return sourceRun(sql,runId,"betika",async()=>{
    const checkpoint=await sql`SELECT cursor FROM collection_checkpoints WHERE source='betika' AND dataset='matches' LIMIT 1`;
    const [savedPage,savedRow]=String(checkpoint[0]?.cursor??"1:0").split(":");
    const startPage=Math.max(1,Number(savedPage)||1); let resumeRow=Math.max(0,Number(savedRow)||0);
    let count=0;
    for(let page=startPage;page<startPage+3;page++){
      await renew();
      const v=await getJson(`https://api.betika.com/v1/uo/matches?page=${page}&limit=200&sport_id=105&period_id=-1`,{},"BETIKA");
      await renew();
      if(!Array.isArray(v?.data)) throw new Error("Betika response missing data[]");
      await raw(sql,runId,"betika","matches",String(page),v);
      for(let rowIndex=resumeRow;rowIndex<v.data.length;rowIndex++){
        const f=v.data[rowIndex];
        await renew();
        const id=str(pick(f,"match_id","game_id","id")); if(!id) { if((rowIndex+1)%10===0) await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,updated_at) VALUES('betika','matches',${`${page}:${rowIndex+1}`},now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now()`; continue; }
        const compId=str(pick(f,"competition_id","league_id","competitionId"));
        const comp=compId==="43822"?"eAdriatic":compId==="44877"?"GT Sports":str(pick(f,"competition_name","competition","category"));
        await upsertFixture(sql,runId,"betika",id,comp,pick(f,"home_team","homeTeam"),pick(f,"away_team","awayTeam"),
          pick(f,"start_time","match_time","date"),pick(f,"status"),pick(f,"home_score"),pick(f,"away_score"),f,
          pick(f,"home_team_id","homeTeamId"),pick(f,"away_team_id","awayTeamId"),compId);
        for(const market of arr(f.odds)){
          const marketName=str(pick(market,"name","sub_type_name","sub_type_id","market_name"))??"unknown";
          for(const selection of arr(market.odds)){
            await renew();
            const outcome=str(pick(selection,"odd_key","name","display","outcome_id"))??"unknown";
            const price=Number(pick(selection,"odd_value","value","odds"));
            if(!Number.isFinite(price)||price<=1) continue;
            await sql`INSERT INTO odds_observations(source,external_fixture_id,market,selection,odds_raw,payload)
              SELECT 'betika',${id},${marketName},${outcome},${String(price)},${JSON.stringify(selection)}::jsonb
              WHERE NOT EXISTS(SELECT 1 FROM odds_observations WHERE source='betika' AND external_fixture_id=${id} AND market=${marketName} AND selection=${outcome} AND odds_raw=${String(price)} AND observed_at>now()-interval '10 minutes')`;
          }
        }
        count++;
        if((rowIndex+1)%10===0) await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,updated_at) VALUES('betika','matches',${`${page}:${rowIndex+1}`},now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now()`;
      }
      resumeRow=0;
      if(v.data.length<200){
        await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,last_complete_at,updated_at) VALUES('betika','matches','1:0',now(),now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor='1:0',last_complete_at=now(),updated_at=now()`;
        break;
      }
      await sql`INSERT INTO collection_checkpoints(source,dataset,cursor,updated_at) VALUES('betika','matches',${`${page+1}:0`},now()) ON CONFLICT(source,dataset) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now()`;
      await new Promise(r=>setTimeout(r,700));
    }
    return count;
  },renew);
}
async function collect(env:Env):Promise<any>{
  const sql=neon(env.DATABASE_URL);
  const ownerToken=crypto.randomUUID();
  // Atomically acquire the lease AND create its run row. A scheduled invocation
  // cannot leave a lock without a corresponding run, or create a run without ownership.
  const acquired=await sql`WITH lease AS (
      INSERT INTO collection_lock(lock_name,locked_until,owner_token,run_id)
      VALUES('scheduled',now()+interval '3 minutes',${ownerToken},NULL)
      ON CONFLICT(lock_name) DO UPDATE SET locked_until=EXCLUDED.locked_until,owner_token=EXCLUDED.owner_token,run_id=NULL
      WHERE collection_lock.locked_until<=now()
      RETURNING lock_name
    ), created AS (
      INSERT INTO collection_runs(status,owner_token,heartbeat_at)
      SELECT 'running',${ownerToken},now() FROM lease RETURNING id
    )
    UPDATE collection_lock l SET run_id=c.id,locked_until=now()+interval '3 minutes'
    FROM created c WHERE l.lock_name='scheduled' AND l.owner_token=${ownerToken}
    RETURNING l.run_id`;
  if(!acquired.length) return {ok:false,skipped:true,reason:"collection already running"};
  const id=Number(acquired[0].run_id);
  const started=Date.now();
  let heartbeatStopped=false;
  const wakeHeartbeat:{current:(()=>void)|null}={current:null};
  let heartbeatError:unknown=null;
  let lastRenewal=Date.now();
  const renewLock=async()=>{
    const updated=await sql`WITH owned AS (
        UPDATE collection_lock SET locked_until=now()+interval '3 minutes'
        WHERE lock_name='scheduled' AND owner_token=${ownerToken} AND run_id=${id}
        RETURNING run_id
      ) UPDATE collection_runs r SET heartbeat_at=now()
        FROM owned WHERE r.id=owned.run_id AND r.status='running' AND r.owner_token=${ownerToken}
        RETURNING r.id`;
    if(!updated.length) throw new Error("COLLECTION_LOCK_LOST: run no longer owns the scheduled lease");
    lastRenewal=Date.now();
  };
  const heartbeat=(async()=>{
    while(!heartbeatStopped){
      await new Promise<void>(resolve=>{
        const timer=setTimeout(resolve,HEARTBEAT_MS);
        wakeHeartbeat.current=()=>{clearTimeout(timer);resolve();};
      });
      wakeHeartbeat.current=null;
      if(heartbeatStopped) break;
      try { await renewLock(); } catch(e) { heartbeatError=e; break; }
    }
  })();
  const renew=async()=>{
    if(Date.now()-started>MAX_RUN_MS) throw new Error("COLLECTION_TIME_BUDGET_EXHAUSTED: run stopped safely before Worker execution limit");
    if(heartbeatError) throw new Error(`COLLECTION_HEARTBEAT_FAILED: ${String(heartbeatError)}`);
    if(Date.now()-lastRenewal>=HEARTBEAT_MS) await renewLock();
    else {
      const owner=await sql`SELECT run_id FROM collection_lock WHERE lock_name='scheduled' AND owner_token=${ownerToken} AND run_id=${id} AND locked_until>now()`;
      if(!owner.length) throw new Error("COLLECTION_LOCK_LOST: ownership check failed at checkpoint");
    }
  };
  try {
    // Reconcile only old runs whose heartbeat is stale; never mark a recently
    // heartbeating run failed merely because its original start time is old.
    await sql`UPDATE collection_runs SET finished_at=now(),status='failed',
      summary='{"error":"stale run recovered after lease expiry","recovery":"heartbeat timeout"}'::jsonb
      WHERE status='running' AND id<>${id} AND owner_token IS DISTINCT FROM ${ownerToken}
      AND COALESCE(heartbeat_at,started_at)<now()-interval '3 minutes'`;
    const results:SourceResult[]=[];
    // Sequential providers avoid a single Promise.all rejection releasing the lock
    // while other collectors are still writing. Each source failure is isolated.
    results.push(await collectEal(sql,id,renew));
    results.push(await collectGt(sql,id,renew));
    results.push(await collectBetika(sql,id,renew));
    if(heartbeatError) throw new Error(`COLLECTION_HEARTBEAT_FAILED: ${String(heartbeatError)}`);
    if(!results.length) throw new Error("NO_SOURCES_CONFIGURED");
    const failures=results.filter(x=>!x.ok).length;
    const status=failures===0?"success":failures===results.length?"failed":"partial";
    await sql`UPDATE collection_runs SET finished_at=now(),status=${status},summary=${JSON.stringify(results)}::jsonb,heartbeat_at=now() WHERE id=${id} AND owner_token=${ownerToken} AND status='running'`;
    return {ok:failures===0,run_id:id,status,sources:results};
  } catch(e) {
    const message=e instanceof Error?e.message:String(e);
    await sql`UPDATE collection_runs SET finished_at=now(),status='failed',summary=${JSON.stringify({error:message})}::jsonb,heartbeat_at=now() WHERE id=${id} AND owner_token=${ownerToken} AND status='running'`;
    throw e;
  } finally {
    heartbeatStopped=true;
    wakeHeartbeat.current?.();
    await heartbeat;
    await sql`UPDATE collection_lock SET locked_until=now(),owner_token=NULL,run_id=NULL
      WHERE lock_name='scheduled' AND owner_token=${ownerToken} AND run_id=${id}`;
  }
}
async function route(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url), path=url.pathname, sql=neon(env.DATABASE_URL);
  if(path==="/health"||path==="/api/v1/health") {
    try { const r=await sql`SELECT now() AS database_time`; return json({ok:true,service:"rusty-esoccer",database:"connected",database_time:r[0].database_time});}
    catch(e){return json({ok:false,error:"database unavailable"},503);}
  }
  if(path==="/health/db") { try {const r=await sql`SELECT now() AS database_time,current_database() AS database_name`;return json({ok:true,database:"connected",details:r[0]});}catch{return json({ok:false,database:"connection_failed"},503);} }
  if(path==="/api/v1/sources"){
    // Return all configured providers, including those never contacted (NULL health fields).
    const rows=await sql`SELECT expected.source,health.last_success_at,health.last_error_at,
      health.last_error,COALESCE(health.consecutive_failures,0)::int AS consecutive_failures,
      health.cooldown_until,health.last_attempt_at,health.last_record_count,health.error_code
      FROM (VALUES ('eadriatic'),('gt'),('betika')) AS expected(source)
      LEFT JOIN source_health health ON health.source=expected.source
      ORDER BY expected.source`;
    return json({sources:rows});
  }
  if(path==="/api/v1/collection/status"){
    const lockRows=await sql`SELECT lock_name,locked_until,owner_token,run_id,
      (locked_until>now()) AS is_locked,now() AS database_time
      FROM collection_lock WHERE lock_name='scheduled'`;
    const recentRuns=await sql`SELECT id,status,started_at,heartbeat_at,finished_at,summary
      FROM collection_runs ORDER BY id DESC LIMIT 5`;
    const checkpoints=await sql`SELECT source,dataset,cursor,last_complete_at,updated_at FROM collection_checkpoints ORDER BY source,dataset`;
    return json({lock:lockRows[0]??null,recent_runs:recentRuns,checkpoints});
  }
  if(path==="/api/v1/predictions"||path==="/api/v1/predict"){
    const predictionLimit=safeInt(url.searchParams.get("limit"),30,1,100);
    const predictionSource=url.searchParams.get("source");
    return json(await buildPredictions(sql,predictionLimit,predictionSource));
  }
  if(path==="/api/v1/predictions/performance"||path==="/api/v1/predictions/accuracy"){
    // Settle only when the source explicitly marks a fixture as final; never score an in-play 0-0 as a result.
    await sql`UPDATE prediction_history p SET actual_outcome=NULL,settled_at=NULL
      FROM fixtures f WHERE p.source=f.source AND p.external_fixture_id=f.external_id AND p.settled_at IS NOT NULL
      AND (f.result_state<>'completed' OR f.home_score_raw IS NULL OR f.home_score_raw !~ '^[0-9]+$' OR f.away_score_raw IS NULL OR f.away_score_raw !~ '^[0-9]+$')`;
    await sql`UPDATE prediction_history p SET actual_outcome=CASE WHEN f.home_score_raw::numeric>f.away_score_raw::numeric THEN 'HOME' WHEN f.home_score_raw::numeric<f.away_score_raw::numeric THEN 'AWAY' ELSE 'DRAW' END, settled_at=now()
      FROM fixtures f WHERE p.source=f.source AND p.external_fixture_id=f.external_id AND (p.settled_at IS NULL OR p.actual_outcome IS DISTINCT FROM CASE WHEN f.home_score_raw::numeric>f.away_score_raw::numeric THEN 'HOME' WHEN f.home_score_raw::numeric<f.away_score_raw::numeric THEN 'AWAY' ELSE 'DRAW' END)
      AND f.result_state='completed'
      AND f.home_score_raw ~ '^[0-9]+$' AND f.away_score_raw ~ '^[0-9]+$'`;
    const rows=await sql`SELECT model_version,count(*)::int AS settled,
      count(*) FILTER (WHERE predicted_outcome=actual_outcome)::int AS correct,
      round(100.0*count(*) FILTER (WHERE predicted_outcome=actual_outcome)/NULLIF(count(*),0),2) AS accuracy_percent,
      round((avg((home_probability-CASE WHEN actual_outcome='HOME' THEN 1 ELSE 0 END)^2 + (draw_probability-CASE WHEN actual_outcome='DRAW' THEN 1 ELSE 0 END)^2 + (away_probability-CASE WHEN actual_outcome='AWAY' THEN 1 ELSE 0 END)^2))::numeric,5) AS brier_score,
      min(predicted_at) AS first_prediction,max(settled_at) AS latest_settlement
      FROM (SELECT DISTINCT ON(source,external_fixture_id,model_version) * FROM prediction_history WHERE settled_at IS NOT NULL ORDER BY source,external_fixture_id,model_version,predicted_at DESC) scored GROUP BY model_version ORDER BY model_version`;
    return json({performance:rows,note:"Accuracy is calculated only on settled, previously recorded forecasts. Probabilities are evaluated with the multiclass Brier score; no future result is used to create a past forecast."});
  }
  if(path==="/api/v1/runs"){
    const limit=safeInt(url.searchParams.get("limit"),25,1,100);
    const rows=await sql`SELECT * FROM collection_runs ORDER BY id DESC LIMIT ${limit}`; return json({runs:rows});
  }
  const limit=safeInt(url.searchParams.get("limit"),50,1,200);
  const offset=safeInt(url.searchParams.get("offset"),0,0,1000000);
  const source=url.searchParams.get("source");
  if(path==="/api/v1/fixtures"||path==="/api/v1/results"){
    // /fixtures is the full feed. /results is deliberately stricter: a numeric score
    // alone is not enough; the provider must explicitly mark the event as completed.
    const completedOnly=path==="/api/v1/results";
    const rows=source
      ? completedOnly
        ? await sql`SELECT * FROM fixtures WHERE source=${source}
            AND result_state='completed'
            AND home_score_raw ~ '^[0-9]+$' AND away_score_raw ~ '^[0-9]+$'
            ORDER BY kickoff_raw DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`
        : await sql`SELECT * FROM fixtures WHERE source=${source} ORDER BY kickoff_raw DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`
      : completedOnly
        ? await sql`SELECT * FROM fixtures
            WHERE result_state='completed'
            AND home_score_raw ~ '^[0-9]+$' AND away_score_raw ~ '^[0-9]+$'
            ORDER BY kickoff_raw DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`
        : await sql`SELECT * FROM fixtures ORDER BY kickoff_raw DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`;
    return json({count:rows.length,limit,offset,fixtures:rows,
      ...(completedOnly?{note:"Only fixtures with an explicit recognized terminal provider status and valid numeric scores are returned. Ambiguous historical statuses are intentionally excluded until verified."}:{})});
  }
  const one=path.match(/^\/api\/v1\/fixtures\/([^/]+)$/);
  if(one){let id:string; try{id=decodeURIComponent(one[1]);}catch{return json({error:"invalid_fixture_id"},400);} const rows=await sql`SELECT * FROM fixtures WHERE external_id=${id} ORDER BY id`;return rows.length?json({fixtures:rows}):json({error:"not_found"},404);}
  if(path==="/api/v1/standings"){const rows=await sql`SELECT DISTINCT ON(source,competition,external_team_id) * FROM standings ORDER BY source,competition,external_team_id,observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`;return json({standings:rows});}
  if(path==="/api/v1/odds"){const rows=await sql`SELECT DISTINCT ON(source,external_fixture_id,market,selection) * FROM odds_observations ORDER BY source,external_fixture_id,market,selection,observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`;return json({odds:rows});}
  if(path==="/api/v1/odds/history"){const id=url.searchParams.get("fixture_id");const rows=id?await sql`SELECT * FROM odds_observations WHERE external_fixture_id=${id} ORDER BY observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`:await sql`SELECT * FROM odds_observations ORDER BY observed_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`;return json({history:rows});}
  if(path==="/api/v1/intelligence/status"){
    const counts=await sql`SELECT (SELECT count(*)::int FROM fixtures) AS fixtures,(SELECT count(*)::int FROM player_match_participation) AS player_participations,(SELECT count(DISTINCT player_external_id)::int FROM player_match_participation) AS identified_players,(SELECT count(DISTINCT team_external_id)::int FROM player_match_participation WHERE team_external_id IS NOT NULL) AS identified_teams,(SELECT count(*)::int FROM prediction_history WHERE settled_at IS NOT NULL) AS settled_predictions,(SELECT count(*)::int FROM prediction_backtests) AS backtests`;
    const models=await sql`SELECT model_version,status,metrics,created_at,promoted_at FROM prediction_model_registry ORDER BY created_at DESC`;
    return json({intelligence:counts[0],models,odds_used_for_predictions:false,identity_policy:"Source-scoped IDs only; no name-based identity merging.",limitations:"Player/team features are available only when upstream feeds expose explicit player and team IDs. Starter status remains unknown unless explicitly supplied."});
  }
  if(path==="/api/v1/players"){const rows=await sql`SELECT source,player_external_id,MAX(player_name) AS player_name,COUNT(*)::int AS observed_fixtures,COUNT(DISTINCT team_external_id)::int AS observed_teams,MAX(observed_at) AS last_seen FROM player_match_participation GROUP BY source,player_external_id ORDER BY last_seen DESC LIMIT ${limit} OFFSET ${offset}`;return json({players:rows,note:"Only players with explicit upstream IDs are listed. Names are labels, not identity keys."});}
  if(path.startsWith("/api/v1/players/")){let playerId:string;try{playerId=decodeURIComponent(path.slice("/api/v1/players/".length));}catch{return json({error:"invalid_player_id"},400);} const source=url.searchParams.get("source")||"gt";const rows=await sql`SELECT source,player_external_id,MAX(player_name) AS player_name,COUNT(*)::int AS observed_fixtures,COUNT(*) FILTER(WHERE is_starter IS TRUE)::int AS starter_true_observations,COUNT(*) FILTER(WHERE is_starter IS FALSE)::int AS starter_false_observations,COUNT(*) FILTER(WHERE is_starter IS NULL)::int AS starter_status_unknown, jsonb_agg(DISTINCT jsonb_build_object('team_id',team_external_id,'team_name',team_name)) AS teams,MAX(observed_at) AS last_seen FROM player_match_participation WHERE source=${source} AND player_external_id=${playerId} GROUP BY source,player_external_id`;return rows.length?json({player:rows[0],note:"Counts are observed fixture records, not guaranteed minutes played. Starter flags are reported only when the feed explicitly provides them."}):json({error:"No verified player observations found for this source and ID."},404); }
  if(path==="/api/v1/head-to-head")return json({error:"Head-to-head requires verified player mappings; no name-only matching is performed."},501);
  if(path==="/api/v1/collection/run"&&request.method!=="POST") return json({error:"method_not_allowed",allowed:["POST"]},405);
  if(path==="/api/v1/collection/run"&&request.method==="POST"){
    if(!env.ADMIN_TOKEN||request.headers.get("authorization")!==`Bearer ${env.ADMIN_TOKEN}`)return json({error:"unauthorized"},401);
    return json(await collect(env));
  }
  if(path==="/") return json({service:"Esports Data Engine",status:"online",endpoints:["/api/v1/health","/api/v1/fixtures","/api/v1/results","/api/v1/standings","/api/v1/odds","/api/v1/odds/history","/api/v1/runs","/api/v1/sources","/api/v1/collection/status","/api/v1/predictions","/api/v1/predictions/performance","/api/v1/intelligence/status","/api/v1/players"]});
  return json({error:"not_found",path},404);
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{try{return await route(request,env);}catch(e){const requestId=crypto.randomUUID();console.error("RUSTY_API_ERROR",requestId,e);return json({ok:false,error:"internal_error",request_id:requestId},500);}},
  async scheduled(_event:ScheduledEvent,env:Env,ctx:ExecutionContext):Promise<void>{ctx.waitUntil(collect(env).catch(e=>{console.error("RUSTY_SCHEDULED_COLLECTION_ERROR",e);}));}
};
