export type JsonObject = Record<string, any>;
export const asArray = (v: unknown): any[] => Array.isArray(v) ? v : [];
export const asText = (v: unknown): string | null => v === null || v === undefined || v === "" ? null : String(v);
export function ealFixtures(payload: JsonObject): JsonObject[] {
  return asArray(payload.fixtureGroupList).flatMap((g:any)=>asArray(g?.fixtures));
}
/** LeagueRepublic returns a fixture group's `standings` as a single object
 *  {standingsDesc, standingsLines}; some payloads use an array of those objects. */
export function ealStandingsTables(group: JsonObject): JsonObject[] {
  const raw = group?.standings;
  if (Array.isArray(raw)) return raw;
  return raw ? [raw] : [];
}
export function ealStandings(payload: JsonObject): Array<{competition:string|null;line:JsonObject}> {
  return asArray(payload.fixtureGroupList).flatMap((g:any)=>
    ealStandingsTables(g).flatMap((s:any)=>asArray(s?.standingsLines).map((line:any)=>({
      competition: asText(g?.fixtureGroupDesc ?? g?.fixtureGroupName ?? g?.name),
      line
    }))));
}
/**
 * LeagueRepublic carries the participant id as a scalar `homeTeam`/`roadTeam`
 * value (928278216), not as a nested object, so the id was previously never read.
 */
export function ealTeamId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    const id = asText((value as JsonObject).teamID ?? (value as JsonObject).teamId ?? (value as JsonObject).id);
    return id;
  }
  return asText(value);
}
export function gtParticipants(fixture:JsonObject) {
  const ps=asArray(fixture.participants);
  const home=ps.find((p:any)=>String(p?.side).toLowerCase()==="home");
  const away=ps.find((p:any)=>String(p?.side).toLowerCase()==="away");
  const name=(p:any)=>asText(p?.participant?.player?.nickname ?? p?.participant?.team?.name);
  const teamId=(p:any)=>asText(p?.participant?.team?.id ?? p?.participant?.team?.team_id ?? p?.participant?.team?.teamId);
  return {home:name(home),away:name(away),homeTeamId:teamId(home),awayTeamId:teamId(away)};
}
export function betikaSelections(fixture:JsonObject) {
  return asArray(fixture.odds).flatMap((market:any)=>asArray(market?.odds).map((selection:any)=>({
    market:asText(market?.name ?? market?.sub_type_name ?? market?.sub_type_id ?? market?.market_name) ?? "unknown",
    selection:asText(selection?.odd_key ?? selection?.name ?? selection?.display ?? selection?.outcome_id) ?? "unknown",
    price:Number(selection?.odd_value ?? selection?.value ?? selection?.odds),
    payload:selection
  })));
}
/**
 * GT identifies eSoccer competitions by the sport's `tagId` ("soccer" vs "basketball"),
 * not by the sport name — football sports are named FIFA20/FIFA21/FIFA22/FIFA23/FC25.
 * The fixture payload only carries `sport.id` and `sport.name`, so the authoritative
 * tagId lookup from /api/sports must be supplied as `allowedSportIds`.
 */
export function isSoccerCompetition(fixture:JsonObject, allowedSportIds?: Set<string>|null):boolean {
  const category = fixture?.season?.tournament?.category ?? {};
  const sport = category.sport ?? {};
  const sportId = asText(sport.id ?? sport.sport_id ?? sport.sportId);
  if (allowedSportIds && allowedSportIds.size && sportId) {
    if (allowedSportIds.has(sportId)) return true;
    // An explicit, known non-soccer sport is rejected even if the name looks similar.
    return false;
  }
  const tagId = asText(sport.tagId ?? sport.tag_id ?? sport.tag);
  if (tagId) return /^(soccer|football)$/i.test(tagId);
  const sportName = asText(sport.name);
  if (sportName) {
    if (/nba|basketball/i.test(sportName)) return false;
    return /e.?soccer|fifa|^fc\s?\d/i.test(sportName);
  }
  const categoryName = asText(category.name);
  if (categoryName) return /e[- ]?sports/i.test(categoryName);
  return false;
}
/** Sport ids whose upstream `tagId` marks them as football/eSoccer. */
export function soccerSportIds(sports: unknown): Set<string> {
  const ids = new Set<string>();
  for (const sport of asArray(sports)) {
    const tagId = asText((sport as JsonObject)?.tagId ?? (sport as JsonObject)?.tag_id);
    const name = asText((sport as JsonObject)?.name) ?? "";
    const isSoccer = tagId ? /^(soccer|football)$/i.test(tagId)
      : !/nba|basketball/i.test(name) && /e.?soccer|fifa|^fc\s?\d/i.test(name);
    if (!isSoccer) continue;
    const id = asText((sport as JsonObject)?.id ?? (sport as JsonObject)?.sport_id);
    if (id) ids.add(id);
  }
  return ids;
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
