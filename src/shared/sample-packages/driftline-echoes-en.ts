import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const driftlineEchoesEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `The airlock at Berth 3 of Gravel Port vents one last hiss of pressure as refueling wraps up beneath your deckplates. Outside the viewport, the hollowed-asteroid waystation turns slowly against the black, its outer rings crowded with weld-scarred salvage skiffs, tramp haulers, and quiet smugglers.

You captain the aging survey cutter Grey Swift. Three faint echo vectors glow on the chart table—automated beacons left ten years ago by the vanished deep-space survey team Farsight: Redshift-04, Icebelt-09, and Silent Haven-12. Tracing and piecing them together is the spine of this voyage.

Chief engineer Sol wipes grease from his knuckles and taps the fuel gauge beside the console. “Fusion core’s good for one outer-ring loop, barely. Honest yards are scarce out past the drift. Pick up a paying job or scare up a fresh filter coil along the way, and the back half of this run gets a whole lot safer.”

Navigator Lin Xi, tuning the open band with one headphone cocked, looks up and routes a burst of static to the bridge speaker—first a high-paying survey contract posted by Gravel Port control, followed immediately by half a clipped civilian distress call coming from the blank rubble belt just off the main beacon lanes.

Lin Xi pauses the playback and turns to you. “All three echo beacons are plotted, Captain. Do we pick a beacon vector and burn out now, check the station bar on that survey contract, or chase that half-distress call into the blank belt first?”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.driftline-echoes
  ref: current-situation
  title: Three echoes at Gravel Port
  summary: The Grey Swift has finished refueling as three beacon vectors and two off-route leads compete for the captain’s call.
  aliases: []
background:
  Time: Voyage Day 1, docked
  Place: Gravel Port Berth 3, bridge of the Grey Swift
Present:
  - { $ref: character.de-captain }
  - { $ref: character.de-sol }
  - { $ref: character.de-linxi }
Awaiting a response:
  Speaker: { $ref: character.de-linxi }
  Words: All three echo beacons are plotted, Captain. Do we pick a beacon vector and burn out now, check the station bar on that survey contract, or chase that half-distress call into the blank belt first?
  Scene: Redshift-04, Icebelt-09, and Silent Haven-12 glow on the chart table; the open band just caught a station survey contract and a broken distress call from the unmapped rubble belt.
`,
  },
  {
    path: "world/characters/captain.yaml",
    contents: `$document:
  id: character.de-captain
  ref: protagonist
  title: Captain of the Grey Swift
  summary: Captain of an aging frontier survey cutter; name, history, and code of conduct are open to the player.
  aliases: []
Role: Chooses flight routes, off-route signals, station contracts, new crew hires, and faction dealings.
Gear:
  - Encrypted captain’s chart key and multi-band hand scanner
  - Civilian vac-suit and emergency mag-tether
`,
  },
  {
    path: "world/characters/sol.yaml",
    contents: `$document:
  id: character.de-sol
  ref: sol
  title: Sol
  summary: Quiet, pragmatic chief engineer keeping the Grey Swift flying on salvaged parts.
  aliases: []
Motive: Keep the reactor steady, the hull sealed, and earn enough credits or salvage to replace the aging filter coils.
Behavior: Skeptical of reckless detours yet deeply dependable; given rare salvage or salvaged cores from side runs, he can refit real ship upgrades.
Knowledge:
  Knows: Gravel Port’s parts market sells almost anything at steep prices; the outer blank belt hides both salvage crews and unclaimed wreckage.
`,
  },
  {
    path: "world/characters/lin-xi.yaml",
    contents: `$document:
  id: character.de-linxi
  ref: lin-xi
  title: Lin Xi
  summary: Navigator and signal analyst obsessed with the ten-year-old Farsight survey echo bands.
  aliases: []
Motive: Recover all three beacon fragments to learn what the Farsight expedition actually found at the edge of the drift.
Behavior: Curious and sharp; eager to chase the main beacons yet open to answering distress calls or side contracts that yield chart data.
Knowledge:
  Knows: Redshift-04, Icebelt-09, and Silent Haven-12 currently broadcast only faint carrier pulses and require close-range scans to decode.
`,
  },
  {
    path: "world/locations/gravel-port.yaml",
    contents: `$document:
  id: location.de-gravel-port
  ref: gravel-port
  title: Gravel Port & the Grey Swift
  summary: Frontier asteroid waystation and the aging survey cutter serving as the crew’s moving hub.
  aliases: []
Fixed fittings:
  The Grey Swift: A compact three-berth survey cutter with a jump drive, deep-band sensor array, modular cargo hold, and two standard vac-suits.
  Gravel Port: A spinning asteroid waystation with civilian berths, a salvagers’ bar, a grey-market parts bay, and a traffic-control contract board.
`,
  },
  {
    path: "world/case/star-chart.yaml",
    contents: `$document:
  id: case.de-star-chart
  ref: star-chart
  title: Star chart & flight log
  summary: Tracks ship condition, unmapped beacon vectors, and active side signals or contracts.
  aliases: []
Ship & supplies: Hull sound; fusion fuel enough for one outer-ring loop; spare parts tight and filter coils aging.
Echo beacon vectors:
  Redshift-04: Edge of a hot dust cloud; clearest carrier pulse, rumored to attract salvage crews.
  Icebelt-09: Deep inside an icy asteroid ring; intermittent signal in an uncharted sector.
  Silent Haven-12: Far-rim derelict relay vector; almost no civilian ship reports in three years.
Side signals & contracts:
  - High-paying survey contract posted by Gravel Port control (details unchecked).
  - Clipped civilian distress call from the unmapped rubble belt outside Gravel Port.
`,
  },
  {
    path: "world/archives/lost-survey-core.yaml",
    contents: `$document:
  id: archive.de-lost-survey
  ref: lost-survey-core
  title: Farsight disappearance & beacon archive
  summary: Background record linking the ten-year-old Farsight survey route with the three echo beacon bands.
  aliases: []
Facts:
  Split coordinates: Ten years ago, the Farsight survey team discovered a rare low-energy natural jump corridor on the rim; fearing corporate seizure, they split the coordinates and logs into three encrypted echo fragments across Redshift-04, Icebelt-09, and Silent Haven-12 before vanishing.
  Unknown fate: The main expedition cut transponders and headed into deep space; decoding each beacon reveals part of the corridor chart and the dispute that split the crew.
`,
  },
  ...storyControlFiles(
    "en",
    "gravel-port",
    `# Driftline Echoes (Core Spine + Organic Frontier Growth)

This is an open-ended frontier space exploration sandbox. The core spine is flying the Grey Swift to track down and piece together Redshift-04, Icebelt-09, and Silent Haven-12, while the sectors, passing crews, black-market jobs, and frontier factions beyond Gravel Port are intentionally left unauthored so the universe can grow organically from this seed.

## Growing Sectors & Side Threads (world_create)

- All three beacon sectors, the blank rubble belt outside Gravel Port, contract brokers, salvage outfits, outpost holdouts, and potential new crewmates are intentionally undefined. Never railroad the player into a bare three-stop checklist just because an off-route lead is not pre-written.
- Whenever the player answers a distress call, takes a side job, explores an uncharted belt, meets a passing captain, or steps into a station dispute, invent grounded, lived-in frontier characters, stations, and side arcs on the spot. Whenever a new character, location, or shared event will matter going forward, persist it with world_create under world/locations/, world/characters/, or world/events/.
- Let side threads feed back into the main voyage: filter coils, salvaged upgrades, chart leads, new crew, or rivals earned off-route should materially shape how the beacon search unfolds.

## Information Discipline & State Tracking

- @lost-survey-core is an on-demand background archive; read it via context_read only after the player decodes a beacon fragment or uncovers Farsight records—never reveal the natural jump corridor early.
- Update @current-situation and @star-chart whenever fuel, hull, upgrades, beacon progress, or active contracts change; record ongoing commitments in @pending-matters and faction/character ties in @relationships.
`,
    ["star-chart"],
    undefined,
    {
      catalogDirectories: [{ directory: "archives", maxEntries: 4 }],
      extraViews: [
        {
          id: "ship-log",
          title: "Grey Swift log",
          items: [
            {
              id: "hull-fuel",
              label: "Ship & supplies",
              document: "star-chart",
              locator: ["Ship & supplies"],
            },
            {
              id: "beacon-vectors",
              label: "Echo beacon vectors",
              document: "star-chart",
              locator: ["Echo beacon vectors"],
            },
            {
              id: "contracts-signals",
              label: "Side signals & contracts",
              document: "star-chart",
              locator: ["Side signals & contracts"],
            },
          ],
        },
      ],
    },
  ),
];
