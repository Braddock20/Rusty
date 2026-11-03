# Source endpoint baseline

This catalog records endpoints supplied in the project discovery notes. Treat them as candidate
public read endpoints; verify each against real HTTP responses before relying on them.

## eAdriatic / LeagueRepublic

Base: `https://api.leaguerepublic.com/json`

- `getSeasonsForLeague/{leagueID}.json`
- `getFixtureGroupsForSeason/{seasonID}.json`
- `getStandingsForFixtureGroup/{fixtureTypeID}/{fixtureGroupIdentifier}.json`
- `getFixturesForSeason/{seasonID}.json`
- `getFixturesForFixtureGroup/{fixtureTypeID}/{fixtureGroupIdentifier}.json`
- `getFixturesForFixtureGroupIncludingOfficialAssignments/{fixtureTypeID}/{fixtureGroupIdentifier}.json`
- `getFixturesForTeam/{seasonID}/{teamID}.json`
- `getMatchHub/{seasonID}.json`
- `getMatchHub/{seasonID}/{yyyyMMdd}.json`
- `getFullFixtureDetails/{fixtureID}.json`
- `getTeamsForFixtureGroup/{fixtureTypeID}/{fixtureGroupIdentifier}.json`
- `getStatisticSummaryForTeam/{seasonID}/{teamID}.json`

Operational notes: cap EAL at ~30 requests/min based on the reported observed limit; respect
429 and Retry-After. LeagueRepublic can return `{ "error": ... }` inside HTTP 200. Match Hub
is the live/unapproved-results surface; other services generally expose approved results.
`road` means away. Scores are strings. `fixtureDate` local time and
`fixtureDateInMilliseconds` UTC epoch milliseconds.

## GT Sports League

Base: `https://api.gtleagues.com/api`

Candidate GET endpoints:
- `/sports`
- `/seasons`
- `/seasons?status=1`
- `/players?active=true`
- `/teams`
- `/fixtures`
- `/fixtures/results`
- `/fixtures/count`
- `/seasons/{seasonId}/standings`
- `/seasons/{seasonId}/participants`
- `/sports/{sportId}/players/standings`
- `/sports/{sportId}/players/{playerId}/forms`
- `/sports/{sportId}/players/{a}/head-to-head/{b}/stats`
- `/sports/{sportId}/players/{playerId}/fixtures/latest`
- `/sports/{sportId}/players/{playerId}/fixtures/upcoming`
- `/knockouts/matchups`
- `/knockouts/{id}/brackets`
- `/knockouts/{id}/participants`

Send ordinary site `Origin` and `Referer` headers. Assert HTTP 200 and parse only genuine
JSON. Reported page cap is 200 rows; advance offset by actual returned rows. Stop on empty
page. Stop on 401/403/451; do not attempt to evade access controls.

## Betika

Known public feed:
`https://api.betika.com/v1/uo/matches?page=1&limit=200&sport_id=105&period_id=-1`

Known fields include `match_id`, `game_id`, `home_team`, `away_team`, `start_time`,
`competition_name`, `competition_id`, `sport_id`, and `odds`. eSoccer sport_id is 105.
Known 1X2 market subtype is 1. This is not proof of a historical results endpoint.
