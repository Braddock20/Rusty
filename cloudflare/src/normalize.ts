export type JsonObject = Record<string, any>;
export const asArray = (v: unknown): any[] => Array.isArray(v) ? v : [];
export const asText = (v: unknown): string | null => v === null || v === undefined || v === "" ? null : String(v);
export function ealFixtures(payload: JsonObject): JsonObject[] {
  return asArray(payload.fixtureGroupList).flatMap((g:any)=>asArray(g?.fixtures));
}
export function ealStandings(payload: JsonObject): Array<{competition:string|null;line:JsonObject}> {
  return asArray(payload.fixtureGroupList).flatMap((g:any)=>
    asArray(g?.standings).flatMap((s:any)=>asArray(s?.standingsLines).map((line:any)=>({
      competition:asText(g?.fixtureGroupName ?? g?.name), line
    }))));
}
export function gtParticipants(fixture:JsonObject) {
  const ps=asArray(fixture.participants);
  const home=ps.find((p:any)=>String(p?.side).toLowerCase()==="home");
  const away=ps.find((p:any)=>String(p?.side).toLowerCase()==="away");
  const name=(p:any)=>asText(p?.participant?.player?.nickname ?? p?.participant?.team?.name);
  return {home:name(home),away:name(away)};
}
export function betikaSelections(fixture:JsonObject) {
  return asArray(fixture.odds).flatMap((market:any)=>asArray(market?.odds).map((selection:any)=>({
    market:asText(market?.name ?? market?.sub_type_name ?? market?.sub_type_id ?? market?.market_name) ?? "unknown",
    selection:asText(selection?.odd_key ?? selection?.name ?? selection?.display ?? selection?.outcome_id) ?? "unknown",
    price:Number(selection?.odd_value ?? selection?.value ?? selection?.odds),
    payload:selection
  })));
}
export function isSoccerCompetition(fixture:JsonObject):boolean {
  const sport=fixture.season?.tournament?.category?.sport;
  const label=typeof sport==="string"?sport:sport?.name;
  return /e.?soccer/i.test(String(label ?? fixture.season?.tournament?.category?.name ?? ""));
}
export function validOdds(value:number):boolean { return Number.isFinite(value) && value > 1; }

/** Extract only explicit GT player/team identifiers; never infer identity from display names. */
export function gtPlayerParticipants(fixture:JsonObject) {
  return asArray(fixture.participants).flatMap((entry:any)=>{
    const participant=entry?.participant??{};
    const player=participant?.player;
    if(!player || typeof player!=="object") return [];
    const playerId=asText(player.id ?? player.player_id ?? player.playerId);
    if(!playerId) return [];
    const team=participant?.team ?? {};
    const teamId=asText(team.id ?? team.team_id ?? team.teamId);
    const side=String(entry?.side??"").toLowerCase();
    return [{playerId,playerName:asText(player.nickname ?? player.name),teamId,teamName:asText(team.name ?? team.nickname),side,
      isStarter:typeof (entry?.is_starter ?? entry?.isStarting ?? player?.is_starter)==="boolean" ? (entry?.is_starter ?? entry?.isStarting ?? player?.is_starter) : null,
      position:asText(entry?.position ?? player?.position),payload:entry}];
  });
}
