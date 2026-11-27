import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const canalEscortEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `Morning mist still clings to Qinghe Wharf as canal chop slaps against the cedar hull of the Fair Current. Red lock-lanterns swing at the end of the jetty. In fifteen days the northern reaches will freeze over, and your contract requires delivering a two-wax-sealed camphor chest to the Tongzhou granary before the ice closes the waterway.

You lead the escort. The camphor chest is locked inside the hidden compartment beneath the aft bunk; your patron gave you only half of a notched tally-board for handover and warned you to avoid trouble and keep the wax unbroken.

Old Tan, who has worked these canals for twenty years, squats at the bow coiling rope and squints north. “Fifteen days to Tongzhou is fair enough with clear locks, but one delay, one fogbank, or one local mess and we’ll be counting every hour. A salt barge coming south just said Willow Bend Lock is inspecting hulls hard.”

Young guard A-Yan hops aboard with two bundles of dry rations, bright-eyed on his first northern run. “Boss, back at the wharf teahouse I heard someone asking whether the Fair Current has spare deck room—offering double fare for passage to White Pagoda Market. Do we cast off for Willow Bend now, or walk over to the teahouse and size up this passenger first?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.canal-escort
  ref: current-situation
  title: Current situation on the canal escort
  summary: Current time, mooring, and immediate decision along the Fair Current’s northern run.
  aliases: []
background:
  Time: Day 1, early morning
  Place: Qinghe Wharf, deck of the Fair Current
Present:
  - { $ref: character.ce-leader }
  - { $ref: character.ce-tan }
  - { $ref: character.ce-ayan }
Immediate decision:
  Departure choice: A-Yan just reported a double-fare passenger rumor at the wharf teahouse for White Pagoda Market; the leader has not yet decided whether to cast off for Willow Bend Lock or check the teahouse first.
  Scene: Old Tan waits with the bow line in hand; the sealed camphor chest is stowed below; the wharf teahouse is a short walk away.
`,
  },
  {
    path: "world/characters/escort-leader.yaml",
    contents: `$document:
  id: character.ce-leader
  ref: protagonist
  title: The escort leader
  summary: Leader tasked with escorting the sealed camphor chest north to Tongzhou; name, skill, and past are open to the player.
  aliases: []
Role: Decides stops, side errands, passengers, and how to handle lock inspections or river trouble.
Carrying:
  - Half of the patron’s notched handover tally-board
  - Canal transit papers and escort manifest
  - Travel blade and oilskin cloak
`,
  },
  {
    path: "world/characters/boatman-tan.yaml",
    contents: `$document:
  id: character.ce-tan
  ref: boatman-tan
  title: Old Tan
  summary: Veteran canal skipper of the Fair Current, fluent in lock customs, shoals, and wharfside networks.
  aliases: [Skipper Tan]
Motive: Earn his northern charter cleanly and keep his boat from freezing in mid-route; loyal to an honest leader and willing to take calculated detours or call on old river friends.
Behavior: Grumbles about delays and costs, yet stays calm when real trouble hits.
Knowledge:
  Knows: Willow Bend Lock, White Pagoda Market, Salt Store Town, and Linqing Ferry each have their own customs and local bosses; side creeks bypass main locks at the cost of shallow water and time.
  Limits: Does not know what is inside the camphor chest, only that the patron paid unusually well.
`,
  },
  {
    path: "world/characters/ayan.yaml",
    contents: `$document:
  id: character.ce-ayan
  ref: ayan
  title: A-Yan
  summary: Quick-footed young escort guard on his first long northern run, keen on wharf gossip and watching the aft chest.
  aliases: []
Motive: Prove himself on his first major escort while taking in the towns and stories along the Grand Canal.
Behavior: Fast on errands and quick to pick up rumors; occasionally soft-hearted toward strangers, yet follows the leader’s word.
Knowledge:
  Heard: Overheard at the wharf teahouse that someone is offering double fare for passage to White Pagoda Market; has not met the traveler yet.
`,
  },
  {
    path: "world/locations/qinghe-wharf.yaml",
    contents: `$document:
  id: location.ce-qinghe-wharf
  ref: qinghe-wharf
  title: Qinghe Wharf & the Fair Current
  summary: Starting canal wharf and the flat-bottomed cargo boat serving as the party’s moving hub.
  aliases: []
Fixed fittings:
  The Fair Current: A twin-masted flat-bottomed canal boat with forward cargo space, a concealed latched locker beneath the aft bunk, and a small skiff towed astern.
  Qinghe Wharf: A busy jetty flanked by an early-opening teahouse, shipping warehouses, and the lock clerk’s office.
`,
  },
  {
    path: "world/case/escort-manifest.yaml",
    contents: `$document:
  id: case.ce-escort-manifest
  ref: escort-manifest
  title: Escort manifest & canal route
  summary: Tracks the core freeze deadline, boat condition, unmapped canal-town rumors, and active side threads.
  aliases: []
Deadline & boat status: 15 days until freeze; the Fair Current is sound, silver and rations suffice for two weeks, and the sealed chest rests in the aft locker.
Handover terms: Deliver to Tongzhou granary before freeze-over; verify handover with the half notched tally-board; keep the wax seal unbroken in transit.
Stops in Old Tan’s river notes:
  Willow Bend Lock: First major lock ahead; a southbound salt barge just reported strict hull inspections.
  White Pagoda Market: Mid-route trading town; A-Yan heard someone at Qinghe teahouse is offering double fare to ride there.
  Salt Store Town: Old salt-depot hub full of side channels (current conditions to be learned along the way).
  Linqing Ferry: Final major northern crossing, often used to switch to overland carts (ice conditions to be checked closer north).
Side threads & notes:
  - Rumor of a double-fare passenger at Qinghe Wharf teahouse; identity not yet checked.
`,
  },
  {
    path: "world/archives/sealed-crate-origin.yaml",
    contents: `$document:
  id: archive.ce-crate-origin
  ref: sealed-crate-origin
  title: Sealed camphor chest dossier
  summary: Background record for verifying the camphor chest’s commission and Tongzhou handover context.
  aliases: []
Facts:
  Contents: Behind the two-color wax seals lie real salt-tax ledgers stamped with an old copper seal and signed depositions exposing years of embezzlement across several canal tax stations.
  Handover: The receiving clerk at Tongzhou granary holds the matching half of the notched tally-board; broken wax triggers immediate suspicion and a demand to verify the ledgers.
  Interested parties: Compromised tax-station insiders may quietly probe or intercept the boat along the route, while wronged boatmen, local clerks, or wanderers may cross paths with the escort.
`,
  },
  ...storyControlFiles(
    "en",
    "qinghe-wharf",
    `# The Canal Escort (Core Spine + Organic World Growth)

This is an open-ended journey up the Grand Canal. The core spine is delivering the sealed camphor chest to Tongzhou granary within fifteen days before freeze-over, while the towns, strangers, and side troubles along the route are intentionally left unauthored so the world can grow naturally from this seed.

## Growing the World & Side Threads (world_create)

- Willow Bend Lock, White Pagoda Market, Salt Store Town, Linqing Ferry, and any teahouse, side creek, passing boat, or passenger the player investigates are intentionally undefined. Never force the player back onto a bare linear rush just because a place or person is not pre-written.
- Whenever the player stops to investigate, takes on a passenger or side job, helps a stranger, or stumbles into local trouble, invent grounded, historically textured characters, locations, and side arcs on the spot. Persist enduring new characters or locations with world_create under world/characters/ or world/locations/, and record shared events or side-thread outcomes in the existing @important-events document (do not attempt to create world/events/).
- Let side threads feed back into the core spine: favors earned from boatmen, transit passes, extra silver, allies, or new rivals should genuinely shape later lock checks, ambushes, or winter detours.

## Information Discipline & State Tracking

- @sealed-crate-origin is an on-demand background record; read it via context_read only when the player probes the chest’s origin, confronts someone who knows, or breaks the seal—never reveal the chest’s true contents early.
- Track the freeze countdown only in @escort-manifest under Deadline & boat status rather than duplicating it in @current-situation. Update @current-situation (keeping only what is still undecided right now, clearing settled choices, and splitting partially completed steps such as papers checked vs. hold inspection still pending) and @escort-manifest whenever days pass, stops change, silver/boat condition shifts, or side threads open; record ongoing promises in @pending-matters and lasting ties in @relationships.
`,
    ["escort-manifest"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "escort-board",
          title: "Escort status",
          items: [
            {
              id: "deadline-ship",
              label: "Deadline & boat status",
              document: "escort-manifest",
              locator: ["Deadline & boat status"],
            },
            {
              id: "handover-terms",
              label: "Handover terms",
              document: "escort-manifest",
              locator: ["Handover terms"],
            },
            {
              id: "route-rumors",
              label: "Stops in Old Tan’s river notes",
              document: "escort-manifest",
              locator: ["Stops in Old Tan’s river notes"],
            },
            {
              id: "side-threads",
              label: "Side threads & notes",
              document: "escort-manifest",
              locator: ["Side threads & notes"],
            },
          ],
        },
      ],
    },
  ),
];
