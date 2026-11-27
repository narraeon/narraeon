import type { ContentTreeFile } from "../../protocol/v1.ts";
import { storyControlFiles } from "./story-controls.ts";

export const lostSignalEnglish: readonly ContentTreeFile[] = [
  {
    path: "opening.md",
    contents: `At the Last Light Relay, deep space usually comes in as numbers. Tonight a voice reads out the old call sign from the enamel plaque above your console. Morrow. The survey ship vanished twenty years ago. The plaque lists the eleven people who were aboard.

You are the duty operator. Your colleague Jun keys the return frequency. “Last Light listening.” Beyond the dish, a scatter of stars disappears behind a moving shape. The relay’s telescope brings up the silhouette of a hull and a stuttering amber lamp. The voice on the radio says she can see the relay’s three white approach lights too.

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
  summary: A radio caller is waiting for an answer from the watch desk.
  aliases: []
background:
  Time: 02:17 station time, twenty years after Morrow vanished
  Place: Last Light Relay, watch desk
Present:
  - { $ref: character.last-light-operator }
  - { $ref: character.last-light-jun }
Open channel:
  Speaker: { $ref: character.morrow-em }
  Contact: By radio. No one has crossed between the relay and the ship.
  Caller’s account: She identifies herself as Em Arlen on Morrow, says six hours have passed aboard, and reports seeing the station’s three approach lights.
  Reply so far: Jun identified the station as Last Light.
  Awaiting a response:
    - She wants to know where to start counting the approach lights.
    - She asks about a berth without a live data link and wants to agree to terms first. She can hold position meanwhile.
Station record: { $ref: location.last-light-relay }
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
Behavior: Makes concrete offers with conditions. Will leave the console to inspect a fitting or arrange an alternative if asked. If the conversation turns to checking each other’s accounts, she can suggest one observation each side can check for itself.
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
Actual identity: The same Em Arlen listed on the pre-loss crew plaque. Conversation or cooperation can gradually yield evidence of her identity.
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
Live station observations:
  Telescope: A craft is holding outside the approach lights. Its outline and a stuttering amber lamp are visible.
  Radio: The radio picked up the old call sign on the plaque.
  Visual check: The two sides have yet to exchange a fresh lamp signal.
  Hull comparison: The port radiator braces have yet to be compared with the old photographs.
  Identity and time: The relay has yet to verify the identity of the craft or anyone aboard, or the six hours reported by the caller.
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
  title: Morrow’s departure and loss of contact
  summary: Departure records, the truth of the ship’s return, and what its crew say they experienced.
  aliases: []
Public records: Morrow left the outer survey channel with eleven people, including pilot Em Arlen. Normal telemetry ended twenty years ago just after a programmed check on the Sedge Beacon. The search recovered no debris. The open catalog carries the old call sign and several exterior photographs, including a distinctive double brace on the port radiator.
Ground truth: The craft is Morrow, returning with its original eleven people. The ship’s navigation clocks record about six hours of elapsed time since the break.
Crew account: In a brief patch of space, expected beacon replies seemed to arrive out of order. The original log, the crew’s different perspectives, and independently sighted stars offer ways to check their account. The mechanism and whether anyone can follow the route are open.
Material condition: Morrow can use its own power to hold position and keep its air moving. It would benefit from a quiet berth and later from power for a better survey of the ship. It can trade observations and report how its lamp or radio responds to a fresh signal without committing to dock.
`,
  },
  ...storyControlFiles(
    "en",
    "last-light",
    `# Making contact at Last Light

Two crews are encountering the same sky from different experiences. Let each ask for something, offer something, and state what would make them comfortable agreeing. If a character naturally suggests a visual check, have the character explain in everyday words what each side could find out before the player chooses whether to try it. The station can make up a new pattern and ask the ship to say what it saw. The ship can flash back as agreed, and the station can watch through the telescope. Each side can learn whether the other can see its lights right now and make their own lights flash as agreed. Finding out who is aboard or how much time passed there takes different evidence. A radio answer, a hull feature, a public record, or a private recollection can each offer a different clue.

Keep what the relay actually sees, what signals it receives, and what its checks establish in Live station observations in @last-light only. Keep the points awaiting a reply and the caller’s reported account with the conversation in the current situation. For exact wording, refer back to what the characters have already said in the story. The departure records and clues in @morrow-crossing are there for comparison. Distinguish firsthand observations from crew accounts and guesses.

Em wants a conversation and a safe place to talk things over. A radio exchange, a dark berth, a dry tether, or other arrangements are viable by agreement. Let the players invent ways to share information with consent and agree on a release signal before physical contact. The waiting craft has time to deliberate. Use the shared power socket to make arrangements concrete when it is relevant. Record actual permissions, promises, and changes to the berth or the ship in their owners’ documents. The contact can grow into mutual aid, cautious separation, or a joint investigation. An explanation for the crossing can develop from later observations; no revelation or ending is required before anyone can talk.
`,
    ["em-arlen", "outer-berth", "morrow-crossing"],
  ),
];
