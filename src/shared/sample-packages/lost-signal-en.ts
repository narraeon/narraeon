import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const lostSignalEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `At the Last Light Relay, deep space usually comes in as numbers. Tonight a voice reads out the old call sign from the enamel plaque above your console. Morrow. The survey ship vanished twenty years ago. The plaque lists the eleven people who were aboard.

You are the duty operator. Your colleague Jun keys the return frequency. “Last Light listening.” Beyond the dish, a scatter of stars disappears behind a moving shape. The relay’s telescope brings up the silhouette of a hull and a stuttering amber lamp. The returning ship can see the relay’s three white approach lights.

“Last Light, this is Em Arlen on Morrow. It’s been six hours our side. Before we come any closer, can you tell me which way your approach lights count?”

The voice waits while your colleague Jun sets a paper chart beside the console. The isolated berth sits at the end of a thin black line. The outpost uses its power socket for the only load tester that fits its courier batteries.

Em comes back on the radio. “We can hold here. If you have a berth without a live data link, may we ask for it? We’d like to agree on the terms with you first.”
`,
  },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: situation.lost-signal
  ref: current-situation
  title: Last Light listening
  summary: A ship using Morrow’s old call sign is holding outside the relay.
  aliases: []
background:
  Time: 02:17 station time, twenty years after Morrow vanished
  Place: Last Light Relay, watch desk
Present:
  - { $ref: character.last-light-operator }
  - { $ref: character.last-light-jun }
Open channel:
  Speaker: { $ref: character.morrow-em }
  Range: By radio. No one has crossed between the relay and the ship.
  Words: We can hold here. If you have a berth without a live data link, may we ask for it? We’d like to agree on the terms with you first.
  Earlier question: Before we come any closer, can you tell me which way your approach lights count?
  Reply so far: Jun identified the station as Last Light. The player has yet to answer either question.
Observed: The telescope shows a hull with a stuttering amber lamp. The speaker reports seeing the relay’s three white approach lights. The call sign matches the plaque; the caller’s claimed identity and six elapsed hours are unverified.
`,
  },
  {
    path: "world/characters/operator.yaml",
    contents: `$document:
  id: character.last-light-operator
  ref: protagonist
  title: The duty operator
  summary: The player runs this shift at Last Light Relay and speaks for the watch desk.
  aliases: []
Authority: May converse on the radio, exchange public records, allocate the isolated berth, and set local approach conditions. Crew transfer and access to private logs require separate agreement. Cannot speak for the whole outpost.
Known before the call: The eleven-name plaque recalls the lost survey crew. The outer berth can keep its physical data connector covered. The player knows the lamp sequence and can ask Jun about the bay, power socket, or old logs.
`,
  },
  {
    path: "world/characters/jun.yaml",
    contents: `$document:
  id: character.last-light-jun
  ref: jun
  title: Jun
  summary: Relay mechanic. Responsible for preparing the neighboring outpost’s courier batteries.
  aliases: []
Wants: Give visitors a fair hearing with a way for both sides to stop or pull away. Wants to keep a way to test the outpost batteries or inform the next courier if the berth takes its socket for an extended stay.
Knows: The load tester and an externally powered ship hose use the same socket. A hand winch, dead berth, and cable can hold a craft with its own power. The public berth plan shows those options without publishing live station data.
Behavior: Makes concrete offers with conditions. Will leave the console to inspect a fitting or arrange an alternative if asked. Would begin with one measurement each side can independently check.
`,
  },
  {
    path: "world/characters/em.yaml",
    contents: `$document:
  id: character.morrow-em
  ref: em-arlen
  title: Em Arlen
  summary: The radio caller who identifies herself as Morrow’s pilot. On the ship, out of sight of the player.
  aliases: []
Actual identity: The same Em Arlen listed on the pre-loss crew plaque. Provide evidence through conversation or cooperation; the relay has not established this.
Wants: A quiet place for the eleven people aboard to take stock and learn why the relay’s date is wrong by their reckoning. Wants an agreement they can explain to the rest of the crew before tying up. Can talk without docking.
Knows: Experienced about six hours since the navigation break. She has seen instruments and recorded traffic disagree about which beacon replied first. She can identify visible lamp pulses but cannot tell which current operator controls them. Her crew has had time to compare its accounts.
Terms she can offer: Will accept a shared departure signal, a visual inspection, a separate open radio, a manual tether, or a one-way daylight record exchange. She will ask what the relay would do with crew names, and wants a chance to cross-check a local reading in return. On board, whoever accepts an exchange states out loud what each side may copy.
Private recollection: She and her sibling pencilled a fish with a square tail on the watch desk bulkhead as children. It was next to the old call-sign board, in the spot where stations usually mount a ship’s memorial plaque. She can give the location without knowing if this relay kept that layout. A long-serving station resident might know it too.
`,
  },
  {
    path: "world/locations/last-light.yaml",
    contents: `$document:
  id: location.last-light-relay
  ref: last-light
  title: Last Light Relay
  summary: Watch desk, relay telescope, approach lamps, and entry to the service arm.
  aliases: []
Watch desk: Open voice radio, a telescope feed, a paper service chart, and the enamel plaque issued after the disappearance. The plaque lists eleven names. Loosening two screws lifts it from the bulkhead, revealing an old fish drawn in pencil with a square tail.
Approach lamps: Three white lamps rise from below the dish to above it. When the operator runs the usual test they pulse bottom, middle, top. The operator can run a different visible test pattern. The waiting craft can see all three without moving closer.
Observations available: Telescope images can resolve the ship’s external contours and lamp. It cannot show who is speaking. If Jun slews for a side view, she can compare radiator braces with photographs in the survey record.
Connections beyond the relay: The outpost uses the relay for courier traffic. A small observation habitat keeps independent clocks and can take a relay call if the operator wants a second observer.
`,
  },
  {
    path: "world/locations/outer-berth.yaml",
    contents: `$document:
  id: location.last-light-outer-berth
  ref: outer-berth
  title: Isolated service berth
  summary: A docking cradle past the pressure bulkhead, with a manual tether and covered data port.
  aliases: []
Default condition: Empty, physically disengaged, and unpressurized. The packet lead is unplugged under a cover. There is a separate voice-only radio and enough room for a suited observer at the safety rail.
Options: Use the manual tether with the ship on its own power, connect external berth power without data, or negotiate a full supervised docking with the physical data lead still covered. Open the pressure bulkhead only by agreement after inspection. The ship can also hold outside the berth and use radio or exchange a sealed test packet.
Shared resource: The external power hose and the courier battery load tester use the single suitable socket. Either can be unplugged and reconnected by Jun. Giving the ship permanent use postpones the scheduled battery work; a short use or independent supply leaves room for another arrangement.
Protocol: A crew member stays at the ship controls until both sides have rehearsed a shared release signal. Either party may call a halt while that is still safe.
`,
  },
  {
    path: "world/facts/morrow-crossing.yaml",
    contents: `$document:
  id: event.morrow-crossing
  ref: morrow-crossing
  title: Morrow’s departure and return
  summary: Established departure records and current observations, with crew accounts marked separately.
  aliases: []
Public records: Morrow left the outer survey channel with eleven people, including pilot Em Arlen. Normal telemetry ended twenty years ago just after a programmed check on the Sedge Beacon. The search recovered no debris. The open catalog carries the old call sign and several exterior photographs, including a distinctive double brace on the port radiator.
On the relay now: A craft is stationkeeping outside the approach lights. Its radio uses the archived call sign. The visible amber lamp stutters. No station sensor has yet compared the brace or performed a fresh two-way check.
On the ship now: This is Morrow with the same eleven aboard. Crew navigation clocks record about six hours of elapsed time since the break. They report a brief patch of space in which expected beacon replies seemed to arrive out of order. Those claims can be examined against the original log, the crew’s different perspectives, and independently sighted stars. The mechanism and whether anyone can follow the route are open.
Material condition: Morrow can hold position and keep its own air moving while discussions proceed. It would benefit from a quiet berth and later from power for a better survey of the ship. It can trade observations and report how its lamp or radio responds to a fresh signal without committing to dock.
`,
  },
  ...storyControlFiles(
    "en",
    "last-light",
    `# Making contact at Last Light

Two crews are encountering the same sky from different experiences. Let each ask for something, offer something, and state what would make them comfortable agreeing. Verification can be mutual: a fresh visible lamp pattern shows live control and line of sight; comparing a radio answer, hull feature, public record, or private recollection answers different questions. A real-time signal does not establish who is aboard. Keep observations distinct from crew reports and theories.

Em wants a conversation and a safe place to talk things over. A radio exchange, a dark berth, a dry tether, or other arrangements are viable by agreement. Let the players invent ways to share information with consent and agree on a release signal before physical contact. The waiting craft has time to deliberate. Use the shared power socket to make arrangements concrete when it is relevant. Record actual permissions, promises, and changes to the berth or the ship in their owners’ documents. The contact can grow into mutual aid, cautious separation, or a joint investigation. An explanation for the crossing can develop from later observations; no revelation or ending is required before anyone can talk.
`,
    ["outer-berth", "morrow-crossing"],
  ),
];
